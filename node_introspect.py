"""Static (no-execution) introspection of disabled custom-node packages.

The mirror-search palette previews nodes that belong to *disabled* packs. Those
packs aren't imported by ComfyUI, so their INPUT_TYPES / RETURN_TYPES are not in
/object_info. To draw a faithful node box we parse the pack's Python source with
``ast`` — we never import or execute it (importing a disabled pack could have
side effects, pull heavy deps, or fail). This yields real inputs/outputs for the
~75% of packs that declare a literal ``NODE_CLASS_MAPPINGS``; packs that build
their mappings dynamically simply report ``parseable: False`` and the frontend
falls back to a placeholder box.
"""

import ast
import logging
import os
import warnings

logger = logging.getLogger(__name__)

# Input "types" that ComfyUI renders as in-node widgets rather than sockets.
_WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "BOOL"}

# Cache parsed pack indexes for the session, keyed by source path. Disabled
# packs don't change while ComfyUI runs, so we never invalidate.
_INDEX_CACHE = {}


def _const_str(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _parse_file(path):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            src = fh.read()
        # Third-party sources often contain unescaped regex strings; ast.parse
        # emits SyntaxWarning for those. Suppress to keep server logs clean.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return ast.parse(src)
    except Exception:
        return None


def _iter_py_files(root, limit=500):
    """Yield up to ``limit`` .py files under a pack dir (or the file itself)."""
    if os.path.isfile(root):
        if root.endswith(".py"):
            yield root
        return
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            d for d in dirnames
            if not d.startswith(".") and d not in ("__pycache__", "node_modules", "js", "web", "dist")
        ]
        for fn in filenames:
            if fn.endswith(".py"):
                yield os.path.join(dirpath, fn)
                count += 1
                if count >= limit:
                    return


def _string_tuple(node):
    """A RETURN_TYPES / RETURN_NAMES value -> list of strings ("*" for non-literal)."""
    if isinstance(node, (ast.Tuple, ast.List)):
        out = []
        for e in node.elts:
            s = _const_str(e)
            out.append(s if s is not None else "*")
        return out
    s = _const_str(node)
    return [s] if s is not None else None


def _extract_input_def(name, val):
    """One INPUT_TYPES entry -> {name, type, widget, default, options}."""
    d = {"name": name, "type": "*", "widget": False, "default": None, "options": None}
    type_node, opts_node = None, None
    if isinstance(val, (ast.Tuple, ast.List)) and val.elts:
        type_node = val.elts[0]
        if len(val.elts) > 1:
            opts_node = val.elts[1]
    else:
        type_node = val

    s = _const_str(type_node)
    if s is not None:
        d["type"] = s
        if s.upper() in _WIDGET_TYPES:
            d["widget"] = True
    elif isinstance(type_node, (ast.List, ast.Tuple)):
        # Inline combo box: ["a", "b", ...]
        opts = [_const_str(e) for e in type_node.elts]
        opts = [o for o in opts if o is not None]
        d["type"] = "COMBO"
        d["widget"] = True
        d["options"] = opts or None
    elif isinstance(type_node, ast.Call):
        # Dynamic list, e.g. folder_paths.get_filename_list(...) -> dropdown widget.
        d["type"] = "COMBO"
        d["widget"] = True
    # else: a Name/Attribute (custom or wildcard socket type) -> keep "*", socket.

    if isinstance(opts_node, ast.Dict):
        for ok, ov in zip(opts_node.keys, opts_node.values):
            if _const_str(ok) == "default":
                try:
                    d["default"] = ast.literal_eval(ov)
                except Exception:
                    d["default"] = _const_str(ov)
    return d


def _extract_input_types(fn):
    """The INPUT_TYPES classmethod -> {"required": [...], "optional": [...]} or None."""
    ret = None
    for n in ast.walk(fn):
        if isinstance(n, ast.Return) and isinstance(n.value, ast.Dict):
            ret = n.value
            break
    if ret is None:
        return None
    result = {"required": [], "optional": []}
    for cat_key, cat_val in zip(ret.keys, ret.values):
        cat = _const_str(cat_key)
        if cat not in ("required", "optional") or not isinstance(cat_val, ast.Dict):
            continue
        for nk, nv in zip(cat_val.keys, cat_val.values):
            name = _const_str(nk)
            if name is not None:
                result[cat].append(_extract_input_def(name, nv))
    return result


def _extract_class(cls):
    info = {"input_types": None, "return_types": None, "return_names": None,
            "category": None, "output_node": False}
    for b in cls.body:
        if isinstance(b, (ast.FunctionDef, ast.AsyncFunctionDef)) and b.name == "INPUT_TYPES":
            info["input_types"] = _extract_input_types(b)
        elif isinstance(b, ast.Assign):
            for t in b.targets:
                tn = getattr(t, "id", None)
                if tn == "RETURN_TYPES":
                    info["return_types"] = _string_tuple(b.value)
                elif tn == "RETURN_NAMES":
                    info["return_names"] = _string_tuple(b.value)
                elif tn == "CATEGORY":
                    info["category"] = _const_str(b.value)
                elif tn == "OUTPUT_NODE" and isinstance(b.value, ast.Constant):
                    info["output_node"] = bool(b.value.value)
    return info


def _merge_mapping(out, dictnode):
    if not isinstance(dictnode, ast.Dict):
        return
    for k, v in zip(dictnode.keys, dictnode.values):
        key = _const_str(k)
        if key is None:
            continue
        if isinstance(v, ast.Name):
            out[key] = v.id
        elif isinstance(v, ast.Call) and isinstance(v.func, ast.Name):
            out[key] = v.func.id


def _merge_display(out, dictnode):
    if not isinstance(dictnode, ast.Dict):
        return
    for k, v in zip(dictnode.keys, dictnode.values):
        key, val = _const_str(k), _const_str(v)
        if key is not None and val is not None:
            out[key] = val


def build_pack_index(pack_path):
    """Parse a pack -> (classes, mappings, display).

    classes:  { ClassName: {input_types, return_types, return_names, category, output_node} }
    mappings: { node_key: ClassName }    (from literal NODE_CLASS_MAPPINGS / .update)
    display:  { node_key: "Pretty Name" }
    """
    cached = _INDEX_CACHE.get(pack_path)
    if cached is not None:
        return cached

    classes, mappings, display = {}, {}, {}
    for f in _iter_py_files(pack_path):
        tree = _parse_file(f)
        if tree is None:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                classes.setdefault(node.name, _extract_class(node))
            elif isinstance(node, ast.Assign):
                for t in node.targets:
                    name = getattr(t, "id", None)
                    if name == "NODE_CLASS_MAPPINGS":
                        _merge_mapping(mappings, node.value)
                    elif name == "NODE_DISPLAY_NAME_MAPPINGS":
                        _merge_display(display, node.value)
            elif isinstance(node, ast.Call):
                fn = node.func
                if (isinstance(fn, ast.Attribute) and fn.attr == "update"
                        and isinstance(fn.value, ast.Name) and node.args
                        and isinstance(node.args[0], ast.Dict)):
                    if fn.value.id == "NODE_CLASS_MAPPINGS":
                        _merge_mapping(mappings, node.args[0])
                    elif fn.value.id == "NODE_DISPLAY_NAME_MAPPINGS":
                        _merge_display(display, node.args[0])

    result = (classes, mappings, display)
    _INDEX_CACHE[pack_path] = result
    return result


def get_node_schema(class_type, pack_path):
    """Return a render-ready schema for one node, or {parseable: False, reason}."""
    classes, mappings, display = build_pack_index(pack_path)

    cls_name = mappings.get(class_type)
    if cls_name is None and class_type in classes:
        cls_name = class_type  # fall back: class_type IS the class name
    if cls_name is None or cls_name not in classes:
        return {"parseable": False, "reason": "dynamic_mapping" if mappings else "no_mapping"}

    info = classes[cls_name]
    inputs = []
    it = info["input_types"]
    if it:
        for cat in ("required", "optional"):
            for d in it[cat]:
                inputs.append({**d, "required": cat == "required"})

    rt = info["return_types"] or []
    rn = info["return_names"] or []
    outputs = []
    for i, t in enumerate(rt):
        nm = rn[i] if i < len(rn) and rn[i] else t
        outputs.append({"name": nm or t, "type": t})

    return {
        "parseable": True,
        "class_type": class_type,
        "display_name": display.get(class_type) or class_type,
        "category": info["category"],
        "output_node": info["output_node"],
        "inputs": inputs,
        "outputs": outputs,
    }


def find_disabled_pack_path(pack_name):
    """Locate a disabled pack's source under any custom_nodes/.disabled/ dir.

    Matches case-insensitively and ignores any ``@version`` suffix that ComfyUI
    Manager appends on disk (e.g. ``ComfyMath@nightly`` for pack ``comfymath``).
    Returns an absolute path (dir or .py file) or None. Rejects path-y input.
    """
    if not pack_name or any(c in pack_name for c in ("/", "\\")) or ".." in pack_name:
        return None
    try:
        import folder_paths
        roots = folder_paths.get_folder_paths("custom_nodes")
    except Exception:
        roots = []

    target = pack_name.lower()
    for root in roots:
        ddir = os.path.join(root, ".disabled")
        if not os.path.isdir(ddir):
            continue
        try:
            entries = os.listdir(ddir)
        except Exception:
            continue
        for e in entries:
            base = e.split("@", 1)[0]
            stem = base[:-3] if base.endswith(".py") else base
            if target in (stem.lower(), base.lower()):
                return os.path.join(ddir, e)
    return None
