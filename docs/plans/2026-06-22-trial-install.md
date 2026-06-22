# 7-Day Trial-Install for Missing Nodes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the Workflow tab really install a workflow's missing (not-installed) packs — either permanently or on the existing 7-day rolling trial that auto-disables unused packs.

**Architecture:** Frontend-only (`js/nodes_stats.js`). Resolve a missing pack's install spec from its not-installed `getlist` entry, install via ComfyUI Manager's queue (reusing `runManagerEnable`, which posts to `/manager/queue/install`), discover the resulting directory name by re-reading `getlist`, and register a trial via the existing `/nodes-stats/trials/start`. Expiry (auto-disable) is already handled by `processExpiredTrials()` — no new expiry code. On any failure, fall back to the current open-Manager behavior.

**Tech Stack:** Vanilla JS ComfyUI extension; ComfyUI Manager HTTP endpoints; the trial machinery already shipped in v1.6.0.

**Design doc:** `docs/plans/2026-06-22-trial-install-design.md`

**Testing note:** No JS test harness. After every edit run:
`cp js/nodes_stats.js /tmp/c.mjs && node --check /tmp/c.mjs && echo OK && rm /tmp/c.mjs`
Behavior is verified manually in ComfyUI (hard-refresh after each change).

**Confirmed reuse points (v1.6.0, real line numbers):** `classifyUnresolved` (≈624, builds `missing[]`), `buildWorkflowTabContent` Missing section (≈410-422), `wireWorkflowButtons` (≈698), `handleInstall` (≈1155, open-Manager fallback), `runManagerEnable` (≈701, install-queue helper), `processExpiredTrials` (≈1192), `setWorkflowButtonsBusy` (≈1172), `managerIsBusy`, `showRestartBanner`, `notify`, `escapeHtml`, `escapeAttr`.

---

### Task 1: Shared `normKey` + install-resolution helpers

**Files:** Modify `js/nodes_stats.js` (add helpers near `classifyUnresolved`, ~line 620).

**Step 1: Add a module-level `normKey`** (and point `classifyUnresolved`'s local `norm` at it for DRY):

```js
// Normalize an identifier (dir name, registry id, or repo URL) for matching.
function normKey(s) {
  return String(s).trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}
```

In `classifyUnresolved`, replace the local
`const norm = (s) => String(s).trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();`
with `const norm = normKey;`.

**Step 2: Add the resolver, payload builder, and dir finder:**

```js
// Find the not-installed getlist entry for a missing pack key (from getmappings).
// Returns { key, id?, version, files, repository, ... } or null.
async function resolveInstallTarget(packKey) {
  let packs;
  try {
    const r = await fetch("/customnode/getlist?mode=local&skip_update=true");
    if (!r.ok) return null;
    packs = (await r.json()).node_packs;
  } catch { return null; }
  if (!packs) return null;
  const want = normKey(packKey);
  for (const [key, v] of Object.entries(packs)) {
    if (!v || v.state !== "not-installed") continue;
    const ids = [key, v.id, v.repository, ...(v.files || [])].filter(Boolean).map(normKey);
    if (ids.includes(want)) return { key, ...v };
  }
  return null;
}

// Build the /manager/queue/install payload, mirroring Manager's installNodes.
function installPayload(entry, packKey) {
  const unknown = !entry.version || entry.version === "unknown";
  const id = entry.id || packKey;
  return {
    id, version: entry.version || "unknown", files: entry.files,
    channel: "default", mode: "cache",
    selected_version: unknown ? "unknown" : "latest",
    skip_post_install: false, ui_id: id,
  };
}

// After install, find the now-installed directory name (the trial key) by
// re-reading getlist and matching the entry; fall back to the repo basename.
async function findInstalledDir(entry) {
  let packs = null;
  try {
    const r = await fetch("/customnode/getlist?mode=local&skip_update=true");
    if (r.ok) packs = (await r.json()).node_packs;
  } catch { /* fall through to basename */ }
  if (packs) {
    const want = [entry.id, entry.repository, ...(entry.files || [])].filter(Boolean).map(normKey);
    for (const [key, v] of Object.entries(packs)) {
      if (!v || v.state === "not-installed") continue;
      const cand = [key, v.id, v.repository, ...(v.files || [])].filter(Boolean).map(normKey);
      if (cand.some((c) => want.includes(c))) return key; // key = directory name
    }
  }
  const url = (entry.files && entry.files[0]) || entry.repository || "";
  return url.replace(/\/+$/, "").replace(/\.git$/i, "").split("/").pop() || null;
}
```

**Step 3: Verify syntax** — run the `node --check` line. Expected `OK`.

**Step 4: Verify resolver (browser console, after hard-refresh)** — pick a known not-installed pack key from `await (await fetch('/customnode/getlist?mode=local&skip_update=true')).json()` and confirm `resolveInstallTarget(key)` returns it. Expected: the entry with `files`/`version`.

**Step 5: Commit**

```bash
git add js/nodes_stats.js
git commit -m "feat(install): install-target resolution helpers for missing packs"
```

---

### Task 2: `handleTrialInstall` orchestrator

**Files:** Modify `js/nodes_stats.js` (add next to `handleInstall`, ~line 1155).

**Step 1: Add the orchestrator** (keep `handleInstall` as the fallback):

```js
// Real install of a missing pack, optionally on a 7-day trial. Resolves the
// install spec, installs via Manager, discovers the resulting directory, and
// (for a trial) registers it. Falls back to opening Manager on any failure.
async function handleTrialInstall(pkg, dialog, temporary) {
  if (await managerIsBusy()) {
    notify("ComfyUI Manager is busy. Please try again in a moment.", "warn");
    return;
  }
  const target = await resolveInstallTarget(pkg);
  if (!target) { await handleInstall(pkg, dialog); return; }

  setWorkflowButtonsBusy(dialog, true);
  try {
    await runManagerEnable(installPayload(target, pkg)); // shared /manager/queue/install flow
    const dir = temporary ? await findInstalledDir(target) : null;
    if (temporary && dir) {
      await fetch("/nodes-stats/trials/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package: dir }),
      });
    }
    showRestartBanner(dialog);
    if (temporary && !dir) {
      notify(`Installed ${pkg}, but couldn't register the trial — manage it manually. Restart to load.`, "warn");
    } else {
      notify(`Installed ${pkg}${temporary ? " for a 7-day trial" : ""}. Restart ComfyUI to load it.`, "success");
    }
  } catch (e) {
    notify("Install failed: " + e.message + " — opening ComfyUI Manager.", "warn");
    await handleInstall(pkg, dialog);
  } finally {
    setWorkflowButtonsBusy(dialog, false);
  }
}
```

**Step 2: Verify syntax** — `node --check`. Expected `OK`.

**Step 3: Commit**

```bash
git add js/nodes_stats.js
git commit -m "feat(install): handleTrialInstall orchestrator with Manager fallback"
```

---

### Task 3: Missing rows — `Install 7d` + `Install` buttons

**Files:** Modify `js/nodes_stats.js` — `buildWorkflowTabContent` Missing section (~410-422).

**Step 1: Update the subtitle and the action cell.** Replace the section header subtitle "Not installed — install via ComfyUI Manager" with "Not installed — install, optionally on a 7-day trial", and replace the single-button cell:

```js
        <td style="padding:6px 8px;text-align:right;white-space:nowrap;">
          ${m.pkg
            ? `<button class="ns-btn ns-install-temp-btn" data-pkg="${escapeAttr(m.pkg)}">Install 7d</button>
               <button class="ns-btn ns-install-perm-btn" data-pkg="${escapeAttr(m.pkg)}" style="margin-left:6px;">Install</button>`
            : "&mdash;"}
        </td>
```

**Step 2: Verify syntax** — `node --check`. Expected `OK`.

**Step 3: Commit**

```bash
git add js/nodes_stats.js
git commit -m "feat(install): Missing rows offer Install 7d + Install"
```

---

### Task 4: Wire the new buttons + busy state

**Files:** Modify `js/nodes_stats.js` — `wireWorkflowButtons` (~698) and `setWorkflowButtonsBusy` (~1172).

**Step 1:** In `wireWorkflowButtons`, replace the `.ns-install-btn` wiring with:

```js
  dialog.querySelectorAll(".ns-install-temp-btn").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); handleTrialInstall(b.dataset.pkg, dialog, true); }));
  dialog.querySelectorAll(".ns-install-perm-btn").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); handleTrialInstall(b.dataset.pkg, dialog, false); }));
```

**Step 2:** In `setWorkflowButtonsBusy`, update the selector to the new classes:

```js
  dialog.querySelectorAll(".ns-enable-temp-btn, .ns-enable-perm-btn, .ns-install-temp-btn, .ns-install-perm-btn").forEach((b) => {
    b.disabled = busy;
  });
```

**Step 3: Verify syntax** — `node --check`. Expected `OK`.

**Step 4: Verify (manual)** — hard-refresh; load a workflow that needs a not-installed **CNR** pack (small one, e.g. a simple utility pack). Click **Install 7d** → it installs, restart banner appears, and `await (await fetch('/nodes-stats/trials')).json()` lists the installed dir. Click **Install** on another → installs, no trial row. Try a pack that fails / git-url-blocked → falls back to opening Manager with a toast.

**Step 5: Commit**

```bash
git add js/nodes_stats.js
git commit -m "feat(install): wire Install 7d / Install buttons"
```

---

### Task 5: Docs + version bump

**Files:** Modify `README.md`, `pyproject.toml`.

**Step 1:** In the README's Workflow-tab section, document that Missing nodes can now be installed permanently or on a 7-day trial (auto-disables if unused, takes effect after restart, falls back to ComfyUI Manager on failure). Update any feature bullet.

**Step 2:** Bump `version` in `pyproject.toml` from `1.6.0` to `1.7.0`.

**Step 3: Verify** — `python -m pytest -q` (unchanged, green) and the `node --check` line (`OK`).

**Step 4: Commit**

```bash
git add README.md pyproject.toml
git commit -m "docs: document 7-day trial-install for missing nodes; bump to 1.7.0"
```

---

## Done criteria

- Workflow tab Missing rows show **Install 7d** and **Install**.
- Install 7d really installs the pack (CNR via registry; git-url where Manager allows) and registers a trial keyed by the installed directory; Install does the same without a trial.
- Unused trial-installed packs auto-disable on a later UI load via the existing `processExpiredTrials` (no new expiry code); using one resets its 7-day counter.
- Failures (unresolvable spec, HTTP error, git-url blocked, Manager absent) fall back to opening ComfyUI Manager — no crash.
- `python -m pytest -q` green; `node --check` clean.
```
