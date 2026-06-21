#!/usr/bin/env python3
"""Diagnose ComfyUI's boot-time model-folder scan (the "scanning model folders" step).

ComfyUI builds its node definitions on every boot. Model-loader nodes enumerate
their dropdowns via ``folder_paths.get_filename_list()``, which does a recursive
walk (``os.walk`` + ``getmtime`` per directory) of every registered model folder.
That cache is in-memory only, so it happens cold on every restart — and when the
model folders live on a network share (CIFS/NFS), each directory stat is a round
trip and the walk can take minutes.

This script measures that cost the same way ComfyUI does, per folder, and shows:
  - which model folders are slow (ranked),
  - which sit on network filesystems and with what mount options (actimeo/cache),
  - file/dir counts, throughput, and a warm-cache comparison.

It is READ-ONLY and changes nothing. Run it from your ComfyUI root, or pass
``--comfy-root``:

    python tools/diagnose_model_scan.py
    python tools/diagnose_model_scan.py --comfy-root /media/p5/Comfyui --timeout 30 --warm
"""

import argparse
import os
import sys
import time


NETWORK_FS = {"cifs", "smb3", "smbfs", "nfs", "nfs4", "fuse.sshfs", "fuse.glusterfs"}


# --------------------------------------------------------------------------- #
# Environment discovery
# --------------------------------------------------------------------------- #

def find_comfy_root(explicit):
    """Locate the ComfyUI root (the dir containing folder_paths.py)."""
    candidates = []
    if explicit:
        candidates.append(explicit)
    candidates.append(os.getcwd())
    # Walk up from cwd.
    d = os.getcwd()
    for _ in range(6):
        candidates.append(d)
        d = os.path.dirname(d)
    for c in candidates:
        if c and os.path.isfile(os.path.join(c, "folder_paths.py")):
            return os.path.abspath(c)
    return None


def load_folder_paths(root, extra_configs):
    """Import ComfyUI's folder_paths and apply extra_model_paths.yaml.

    Returns (folder_paths_module_or_None, list_of_notes).
    """
    notes = []
    if root and root not in sys.path:
        sys.path.insert(0, root)
    # folder_paths imports comfy.cli_args, which parses sys.argv at import time.
    # Hide our own flags so it sees ComfyUI defaults instead of erroring out.
    saved_argv = sys.argv
    sys.argv = [saved_argv[0]]
    try:
        import folder_paths  # type: ignore
    except Exception as e:  # noqa: BLE001
        notes.append(f"could not import folder_paths ({e}); falling back to <root>/models/*")
        return None, notes
    finally:
        sys.argv = saved_argv

    # Mirror main.py: load extra_model_paths.yaml + any explicit configs.
    yaml_paths = []
    default_yaml = os.path.join(root, "extra_model_paths.yaml")
    if os.path.isfile(default_yaml):
        yaml_paths.append(default_yaml)
    yaml_paths.extend(extra_configs or [])

    if yaml_paths:
        try:
            from utils.extra_config import load_extra_path_config  # type: ignore
            for yp in yaml_paths:
                load_extra_path_config(yp)
                notes.append(f"loaded extra paths: {yp}")
        except Exception as e:  # noqa: BLE001
            notes.append(f"could not load extra_model_paths.yaml ({e}); NAS folders may be missing")

    return folder_paths, notes


def folder_targets(folder_paths, root):
    """Return [(folder_type, [paths], extensions_set_or_None), ...]."""
    if folder_paths is not None and getattr(folder_paths, "folder_names_and_paths", None):
        out = []
        for ftype, value in folder_paths.folder_names_and_paths.items():
            paths, exts = value[0], value[1]
            exts = {e.lower() for e in exts} if exts else None
            out.append((ftype, list(paths), exts))
        return out
    # Fallback: scan <root>/models/* with no extension filter.
    models = os.path.join(root or os.getcwd(), "models")
    out = []
    if os.path.isdir(models):
        for name in sorted(os.listdir(models)):
            p = os.path.join(models, name)
            if os.path.isdir(p):
                out.append((name, [p], None))
    return out


# --------------------------------------------------------------------------- #
# Mount analysis
# --------------------------------------------------------------------------- #

def parse_mounts():
    """Return list of (mountpoint, fstype, options) longest-first."""
    mounts = []
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 4:
                    # device, mountpoint, fstype, options
                    mp = parts[1].replace("\\040", " ")
                    mounts.append((mp, parts[2], parts[3]))
    except OSError:
        pass
    mounts.sort(key=lambda m: len(m[0]), reverse=True)
    return mounts


def mount_for(real_path, mounts):
    for mp, fstype, opts in mounts:
        if real_path == mp or real_path.startswith(mp.rstrip("/") + "/"):
            return mp, fstype, opts
    return None


def opt_value(opts, key):
    for o in opts.split(","):
        if o == key:
            return ""
        if o.startswith(key + "="):
            return o.split("=", 1)[1]
    return None


# --------------------------------------------------------------------------- #
# Timed walk (mirrors folder_paths.recursive_search cost)
# --------------------------------------------------------------------------- #

def timed_walk(path, exts, timeout):
    """Walk like recursive_search: readdir + getmtime per directory.

    Returns dict with files, matched, dirs, elapsed, timed_out, missing.
    """
    if not os.path.isdir(path):
        return {"missing": True}
    start = time.perf_counter()
    files = matched = dirs = 0
    timed_out = False
    try:
        os.path.getmtime(path)
    except OSError:
        pass
    for dirpath, subdirs, filenames in os.walk(path, followlinks=True, topdown=True):
        subdirs[:] = [d for d in subdirs if d != ".git"]
        dirs += 1
        for fn in filenames:
            files += 1
            if exts is None or os.path.splitext(fn)[1].lower() in exts:
                matched += 1
        # recursive_search stats every subdirectory — replicate that round-trip cost.
        for d in subdirs:
            try:
                os.path.getmtime(os.path.join(dirpath, d))
            except OSError:
                pass
        if time.perf_counter() - start > timeout:
            timed_out = True
            break
    return {
        "missing": False,
        "files": files,
        "matched": matched,
        "dirs": dirs,
        "elapsed": time.perf_counter() - start,
        "timed_out": timed_out,
    }


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #

def human(n):
    return f"{n:,}"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Diagnose ComfyUI model-folder scan cost.")
    ap.add_argument("--comfy-root", help="Path to ComfyUI root (default: auto-detect).")
    ap.add_argument("--extra-model-paths-config", action="append", default=[],
                    help="Additional extra_model_paths.yaml to load (repeatable).")
    ap.add_argument("--timeout", type=float, default=30.0,
                    help="Per-folder walk timeout in seconds (default: 30).")
    ap.add_argument("--warm", action="store_true",
                    help="Do a second pass per folder to show warm-cache speedup.")
    args = ap.parse_args(argv)

    root = find_comfy_root(args.comfy_root)
    print("ComfyUI model-scan diagnostic")
    print("=" * 60)
    if not root:
        print("! Could not find ComfyUI root (no folder_paths.py).")
        print("  Run from the ComfyUI directory or pass --comfy-root.")
        return 2
    print(f"ComfyUI root : {root}")

    folder_paths, notes = load_folder_paths(root, args.extra_model_paths_config)
    for n in notes:
        print(f"  - {n}")
    if folder_paths is not None:
        cache = getattr(folder_paths, "filename_list_cache", {})
        print(f"filename_list_cache : {len(cache)} entries (in this process; "
              f"empty here is normal — it's per-process and wiped on every boot)")

    targets = folder_targets(folder_paths, root)
    print(f"Model folder types  : {len(targets)}")
    print(f"Per-folder timeout  : {args.timeout:g}s")
    print()

    mounts = parse_mounts()

    # Memoize by realpath so shared dirs aren't walked twice.
    walk_cache = {}
    rows = []
    used_mounts = {}

    for ftype, paths, exts in targets:
        for p in paths:
            rp = os.path.realpath(p)
            m = mount_for(rp, mounts)
            if m:
                used_mounts[m[0]] = m
            if rp in walk_cache:
                res = walk_cache[rp]
            else:
                res = timed_walk(rp, exts, args.timeout)
                if args.warm and not res.get("missing") and not res.get("timed_out"):
                    res["warm"] = timed_walk(rp, exts, args.timeout)["elapsed"]
                walk_cache[rp] = res
            rows.append((ftype, p, rp, m, res))

    # Rank slowest first (timed-out treated as the worst).
    def sortkey(row):
        res = row[4]
        if res.get("missing"):
            return -1.0
        return (args.timeout + 1) if res.get("timed_out") else res["elapsed"]

    rows.sort(key=sortkey, reverse=True)

    print("Per-folder scan cost (slowest first)")
    print("-" * 60)
    hdr = f"{'TIME':>9}  {'NET':>3}  {'FILES':>8}  {'DIRS':>6}  TYPE / PATH"
    print(hdr)
    total = 0.0
    any_timeout = False
    for ftype, p, rp, m, res in rows:
        if res.get("missing"):
            print(f"{'missing':>9}  {'-':>3}  {'-':>8}  {'-':>6}  {ftype}  {p}")
            continue
        net = "yes" if (m and m[1] in NETWORK_FS) else "no"
        t = res["elapsed"]
        total += t
        tstr = f">{args.timeout:g}s" if res["timed_out"] else f"{t:.2f}s"
        if res["timed_out"]:
            any_timeout = True
        warm = f"  (warm {res['warm']:.2f}s)" if "warm" in res else ""
        loc = rp if rp == p else f"{p} -> {rp}"
        print(f"{tstr:>9}  {net:>3}  {human(res['matched']):>8}  {human(res['dirs']):>6}  {ftype}{warm}")
        print(f"{'':>9}  {'':>3}  {'':>8}  {'':>6}  {loc}")
    print("-" * 60)
    approx = "+ (timed-out folders not fully counted)" if any_timeout else ""
    print(f"Measured walk total: {total:.1f}s {approx}")
    print()

    # Mount summary.
    if used_mounts:
        print("Mounts hosting model folders")
        print("-" * 60)
        for mp, (mp2, fstype, opts) in sorted(used_mounts.items()):
            net = fstype in NETWORK_FS
            tag = "NETWORK" if net else "local"
            line = f"  {mp}  [{fstype}, {tag}]"
            if net:
                actimeo = opt_value(opts, "actimeo")
                acdir = opt_value(opts, "acdirmax")
                cache = opt_value(opts, "cache")
                bits = []
                bits.append(f"actimeo={actimeo if actimeo is not None else '1 (default)'}")
                if acdir is not None:
                    bits.append(f"acdirmax={acdir}")
                bits.append(f"cache={cache if cache is not None else 'default'}")
                line += "  " + ", ".join(bits)
            print(line)
        print()

    # Findings + recommendations.
    print("Findings & recommendations")
    print("-" * 60)
    slow_net = []
    for mp, (mp2, fstype, opts) in used_mounts.items():
        if fstype in NETWORK_FS:
            actimeo = opt_value(opts, "actimeo")
            low = actimeo is None or _as_float(actimeo) is not None and _as_float(actimeo) <= 5
            slow_net.append((mp, actimeo, low))

    if not slow_net:
        print("  + No model folders on network filesystems. Boot scan cost is local I/O;")
        print("    if it's still slow, reduce the number of files/custom-node model types.")
    else:
        print(f"  ! {len(slow_net)} model mount(s) are on the network — these dominate boot.")
        if any(low for _, _, low in slow_net):
            print("  ! Low/absent actimeo: the metadata cache expires every ~1s, so a multi-")
            print("    minute walk constantly re-fetches attributes it just read.")
            print("    Fix: raise it on the model/lora mounts, e.g.")
            print("        actimeo=3600,acdirmax=3600,acregmax=3600,cache=loose")
            print("    The CIFS cache lives in the kernel, so once warm, ComfyUI *restarts*")
            print("    within the window reuse it and boot fast.")
    timed = [(ftype, rp, res) for ftype, p, rp, m, res in rows
             if not res.get("missing") and res.get("timed_out")]
    if timed:
        print(f"  ! Primary suspects — folders that didn't finish within {args.timeout:g}s:")
        for ftype, rp, res in timed:
            print(f"      {ftype}: {rp}  ({human(res['dirs'])}+ dirs, {human(res['matched'])}+ files)")
        print("    Re-run with a larger --timeout to measure their full cost.")
    print("  + filename_list_cache is per-process and lost on restart; a persistent")
    print("    snapshot served at boot (trust-cache + background refresh) eliminates the")
    print("    network walk entirely.")
    print("  + Fewer custom-node packages = fewer model folder types to scan + smaller")
    print("    /object_info build.")
    return 0


def _as_float(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


if __name__ == "__main__":
    raise SystemExit(main())
