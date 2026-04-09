# Model Usage Tracking — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Track which model files ComfyUI uses in prompts and surface never-used models so the user can delete them.

**Architecture:** Extend the existing SQLite DB with a `model_usage` table. At prompt time, inspect each node's `INPUT_TYPES()` to find folder-dropdown inputs, look up the selected filename in a `folder_paths` reverse map, and record usage. A new API endpoint returns per-type grouped stats. The existing dialog gets two tabs: Nodes (unchanged) and Models (new).

**Tech Stack:** Python, SQLite (via `sqlite3`), ComfyUI's `folder_paths` + `nodes` modules, vanilla JS.

---

### Task 0: Create test infrastructure

**Files:**
- Create: `tests/conftest.py`

`folder_paths` and `nodes` are ComfyUI modules unavailable outside a running ComfyUI process. Without stubbing them upfront, any `patch()` call against them raises `ModuleNotFoundError` before the test runs.

**Step 1: Create conftest.py**

```python
# tests/conftest.py
import sys
import os
from unittest.mock import MagicMock

# Put the project root on sys.path so tests can import tracker, mapper directly
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Stub ComfyUI-only modules before any test file imports project code
for mod in ("folder_paths", "nodes", "server", "folder_paths.folder_names_and_paths"):
    if mod not in sys.modules:
        sys.modules[mod] = MagicMock()
```

**Step 2: Commit**

```bash
git add tests/conftest.py
git commit -m "test: add conftest with ComfyUI module stubs"
```

---

### Task 1: Extend tracker.py — model_usage schema + methods

**Files:**
- Modify: `tracker.py`
- Create: `tests/test_model_tracker.py`

**Step 1: Add model_usage to SCHEMA**

In `tracker.py`, extend the `SCHEMA` string — append after the existing `CREATE INDEX` lines:

```python
SCHEMA = """
CREATE TABLE IF NOT EXISTS node_usage (
    class_type TEXT PRIMARY KEY,
    package TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    class_types TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_usage (
    model_name TEXT PRIMARY KEY,
    model_type TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_node_usage_package ON node_usage(package);
CREATE INDEX IF NOT EXISTS idx_prompt_log_timestamp ON prompt_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_model_usage_type ON model_usage(model_type);
"""
```

**Step 2: Write failing test**

Create `tests/test_model_tracker.py`:

```python
import pytest
import tempfile
import os
from tracker import UsageTracker


@pytest.fixture
def tracker(tmp_path):
    return UsageTracker(db_path=str(tmp_path / "test.db"))


def test_record_and_retrieve_model_usage(tracker):
    tracker.record_model_usage([("dreamshaper.safetensors", "checkpoints")])
    tracker.record_model_usage([("dreamshaper.safetensors", "checkpoints")])

    raw = tracker.get_raw_model_stats()
    assert len(raw) == 1
    assert raw[0]["model_name"] == "dreamshaper.safetensors"
    assert raw[0]["model_type"] == "checkpoints"
    assert raw[0]["count"] == 2


def test_record_multiple_models(tracker):
    tracker.record_model_usage([
        ("dreamshaper.safetensors", "checkpoints"),
        ("vae.safetensors", "vae"),
    ])
    raw = tracker.get_raw_model_stats()
    assert len(raw) == 2


def test_reset_clears_model_usage(tracker):
    tracker.record_model_usage([("model.safetensors", "checkpoints")])
    tracker.reset()
    assert tracker.get_raw_model_stats() == []


def test_empty_models_returns_empty(tracker):
    assert tracker.get_raw_model_stats() == []
```

**Step 3: Run test to confirm it fails**

```bash
cd /media/p5/Comfyui_nodes_stats
python -m pytest tests/test_model_tracker.py -v
```

Expected: `AttributeError: 'UsageTracker' object has no attribute 'record_model_usage'`

**Step 4: Add methods to UsageTracker**

In `tracker.py`, add after `record_usage()`:

```python
def record_model_usage(self, models):
    """Record usage of model files from a single prompt.

    models: list of (model_name, model_type) tuples
    """
    if not models:
        return
    now = datetime.now(timezone.utc).isoformat()
    with self._lock:
        self._ensure_db()
        conn = self._connect()
        try:
            for model_name, model_type in models:
                conn.execute(
                    """INSERT INTO model_usage (model_name, model_type, count, first_seen, last_seen)
                       VALUES (?, ?, 1, ?, ?)
                       ON CONFLICT(model_name) DO UPDATE SET
                           count = count + 1,
                           last_seen = excluded.last_seen""",
                    (model_name, model_type, now, now),
                )
            conn.commit()
        finally:
            conn.close()

def get_raw_model_stats(self):
    """Return raw per-model usage rows from DB."""
    with self._lock:
        self._ensure_db()
        conn = self._connect()
        try:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT model_name, model_type, count, first_seen, last_seen "
                "FROM model_usage ORDER BY count DESC"
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
```

In `reset()`, add before `conn.commit()`:

```python
conn.execute("DELETE FROM model_usage")
```

**Step 5: Add get_model_stats() method**

This method merges DB data with installed models (passed in from caller, so it stays testable):

```python
def get_model_stats(self, installed_by_type):
    """Return per-type grouped model stats with tier classification.

    installed_by_type: {model_type: [model_name, ...]} from ModelMapper
    """
    db_rows = self.get_raw_model_stats()
    db_models = {r["model_name"]: r for r in db_rows}

    now = datetime.now(timezone.utc)
    one_month_ago = (now - timedelta(days=30)).isoformat()
    two_months_ago = (now - timedelta(days=60)).isoformat()
    tracking_start = self._get_first_prompt_time()

    STATUS_ORDER = {
        "safe_to_remove": 0,
        "consider_removing": 1,
        "unused_new": 2,
        "used": 3,
        "uninstalled": 4,
    }

    result_by_type = {}

    # Process installed models
    for model_type, filenames in installed_by_type.items():
        entries = []
        for model_name in filenames:
            if model_name in db_models:
                row = db_models[model_name]
                last_seen = row["last_seen"]
                if last_seen < two_months_ago:
                    status = "safe_to_remove"
                elif last_seen < one_month_ago:
                    status = "consider_removing"
                else:
                    status = "used"
                entry = {
                    "model_name": model_name,
                    "model_type": model_type,
                    "count": row["count"],
                    "first_seen": row["first_seen"],
                    "last_seen": last_seen,
                    "installed": True,
                    "status": status,
                }
            else:
                if tracking_start is None:
                    status = "unused_new"
                elif tracking_start < two_months_ago:
                    status = "safe_to_remove"
                elif tracking_start < one_month_ago:
                    status = "consider_removing"
                else:
                    status = "unused_new"
                entry = {
                    "model_name": model_name,
                    "model_type": model_type,
                    "count": 0,
                    "first_seen": None,
                    "last_seen": None,
                    "installed": True,
                    "status": status,
                }
            entries.append(entry)
        result_by_type[model_type] = entries

    # Add uninstalled (in DB but not on disk)
    installed_names = {
        name for names in installed_by_type.values() for name in names
    }
    for model_name, row in db_models.items():
        if model_name not in installed_names:
            model_type = row["model_type"]
            result_by_type.setdefault(model_type, []).append({
                "model_name": model_name,
                "model_type": model_type,
                "count": row["count"],
                "first_seen": row["first_seen"],
                "last_seen": row["last_seen"],
                "installed": False,
                "status": "uninstalled",
            })

    # Sort each type's models by status tier then name
    result = []
    for model_type in sorted(result_by_type):
        models = result_by_type[model_type]
        models.sort(key=lambda m: (STATUS_ORDER.get(m["status"], 5), m["model_name"]))
        result.append({"model_type": model_type, "models": models})

    return result
```

**Step 6: Add tests for get_model_stats()**

Append to `tests/test_model_tracker.py`:

```python
from datetime import datetime, timezone, timedelta
from unittest.mock import patch


def test_get_model_stats_used(tracker):
    tracker.record_model_usage([("model.safetensors", "checkpoints")])
    installed = {"checkpoints": ["model.safetensors"]}
    result = tracker.get_model_stats(installed)
    assert len(result) == 1
    assert result[0]["model_type"] == "checkpoints"
    assert result[0]["models"][0]["status"] == "used"
    assert result[0]["models"][0]["count"] == 1


def test_get_model_stats_never_used_new(tracker):
    installed = {"checkpoints": ["unused.safetensors"]}
    result = tracker.get_model_stats(installed)
    assert result[0]["models"][0]["status"] == "unused_new"
    assert result[0]["models"][0]["count"] == 0


def test_get_model_stats_uninstalled(tracker):
    tracker.record_model_usage([("gone.safetensors", "checkpoints")])
    installed = {}  # no longer on disk
    result = tracker.get_model_stats(installed)
    assert result[0]["models"][0]["status"] == "uninstalled"
    assert result[0]["models"][0]["installed"] is False


def test_get_model_stats_sorted_by_status(tracker):
    tracker.record_model_usage([("active.safetensors", "checkpoints")])
    installed = {"checkpoints": ["active.safetensors", "unused.safetensors"]}
    result = tracker.get_model_stats(installed)
    models = result[0]["models"]
    statuses = [m["status"] for m in models]
    # unused_new (2) comes before used (3) in STATUS_ORDER
    assert statuses.index("unused_new") < statuses.index("used")
```

**Step 7: Run all tests**

```bash
python -m pytest tests/test_model_tracker.py -v
```

Expected: all PASS

**Step 8: Commit**

```bash
git add tracker.py tests/test_model_tracker.py
git commit -m "feat: add model_usage table and tracker methods"
```

---

### Task 2: Add ModelMapper to mapper.py

**Files:**
- Modify: `mapper.py`
- Create: `tests/test_model_mapper.py`

**Step 1: Write failing test**

Create `tests/test_model_mapper.py`:

```python
import pytest
from unittest.mock import patch, MagicMock
from mapper import ModelMapper


FAKE_FOLDER_NAMES = {
    "checkpoints": ([], {}),
    "vae": ([], {}),
    "loras": ([], {}),
    "configs": ([], {}),
}

FAKE_FILES = {
    "checkpoints": ["dream.safetensors", "v15.ckpt"],
    "vae": ["vae.safetensors"],
    "loras": ["style.safetensors"],
}


def _make_mapper():
    # conftest.py already put a MagicMock in sys.modules["folder_paths"],
    # so we can configure it directly here.
    import folder_paths as fp
    fp.folder_names_and_paths = FAKE_FOLDER_NAMES
    fp.get_filename_list.side_effect = lambda t: FAKE_FILES.get(t, [])
    m = ModelMapper()
    m._build()
    return m


def test_get_model_type_known(monkeypatch):
    m = _make_mapper()
    assert m.get_model_type("dream.safetensors") == "checkpoints"
    assert m.get_model_type("vae.safetensors") == "vae"


def test_loras_excluded(monkeypatch):
    m = _make_mapper()
    assert m.get_model_type("style.safetensors") is None


def test_get_all_models(monkeypatch):
    m = _make_mapper()
    all_models = m.get_all_models()
    assert "checkpoints" in all_models
    assert "vae" in all_models
    assert "loras" not in all_models
    assert "dream.safetensors" in all_models["checkpoints"]


def test_unknown_filename_returns_none():
    m = _make_mapper()
    assert m.get_model_type("nonexistent.ckpt") is None
```

**Step 2: Run test to confirm it fails**

```bash
python -m pytest tests/test_model_mapper.py -v
```

Expected: `ImportError: cannot import name 'ModelMapper' from 'mapper'`

**Step 3: Add ModelMapper to mapper.py**

Append to `mapper.py` after the existing `NodePackageMapper` class:

```python
# Folder types that are not model files and should not be tracked
EXCLUDED_FOLDER_TYPES = {
    "loras",
    "configs",
    "custom_nodes",
    "temp",
    "output",
    "input",
    "annotators",
    "assets",
}


class ModelMapper:
    """Tracks which folder_paths model types exist and resolves filenames to types."""

    def __init__(self):
        self._folder_files = None   # {folder_type: frozenset(filenames)}
        self._reverse = None        # {filename: folder_type}

    def _build(self):
        try:
            import folder_paths

            self._folder_files = {}
            for folder_type in folder_paths.folder_names_and_paths:
                if folder_type in EXCLUDED_FOLDER_TYPES:
                    continue
                try:
                    files = folder_paths.get_filename_list(folder_type)
                except Exception:
                    files = []
                if files:
                    self._folder_files[folder_type] = frozenset(files)

            # Reverse map: filename -> folder_type (last write wins on collision)
            self._reverse = {}
            for folder_type, files in self._folder_files.items():
                for f in files:
                    self._reverse[f] = folder_type

        except Exception:
            logger.warning("ModelMapper: failed to build model map", exc_info=True)
            self._folder_files = {}
            self._reverse = {}

    def _ensure(self):
        if self._folder_files is None:
            self._build()

    def get_model_type(self, filename):
        """Return the folder type for a filename, or None if not tracked."""
        self._ensure()
        return self._reverse.get(filename)

    def get_all_models(self):
        """Return {folder_type: [filename, ...]} for all tracked types."""
        self._ensure()
        return {k: sorted(v) for k, v in self._folder_files.items()}

    def extract_models_from_prompt(self, prompt):
        """Scan a prompt dict and return (model_name, model_type) pairs.

        For each node, inspects INPUT_TYPES() to find list-type (folder dropdown)
        inputs, then resolves the selected value against the folder_paths reverse map.
        """
        self._ensure()
        try:
            import nodes as comfy_nodes
        except ImportError:
            return []

        seen = set()
        results = []

        for node_data in prompt.values():
            class_type = node_data.get("class_type")
            node_inputs = node_data.get("inputs", {})
            if not class_type or not node_inputs:
                continue

            node_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(class_type)
            if node_cls is None:
                continue

            try:
                input_types = node_cls.INPUT_TYPES()
            except Exception:
                continue

            for category in ("required", "optional"):
                for input_name, input_def in input_types.get(category, {}).items():
                    if not isinstance(input_def, (list, tuple)) or not input_def:
                        continue
                    # ComfyUI folder dropdowns have a list as their type
                    if not isinstance(input_def[0], list):
                        continue
                    value = node_inputs.get(input_name)
                    if not isinstance(value, str) or value in seen:
                        continue
                    model_type = self.get_model_type(value)
                    if model_type:
                        seen.add(value)
                        results.append((value, model_type))

        return results

    def invalidate(self):
        """Force rebuild on next access."""
        self._folder_files = None
        self._reverse = None
```

**Step 4: Add extract_models_from_prompt test**

Append to `tests/test_model_mapper.py`:

```python
def test_extract_models_from_prompt():
    m = _make_mapper()

    fake_node_cls = MagicMock()
    fake_node_cls.INPUT_TYPES.return_value = {
        "required": {
            "ckpt_name": (["dream.safetensors", "v15.ckpt"],),
            "steps": ("INT", {"default": 20}),
        }
    }

    fake_prompt = {
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": "dream.safetensors", "steps": 20},
        }
    }

    import nodes as comfy_nodes
    comfy_nodes.NODE_CLASS_MAPPINGS = {"CheckpointLoaderSimple": fake_node_cls}
    results = m.extract_models_from_prompt(fake_prompt)

    assert ("dream.safetensors", "checkpoints") in results


def test_extract_models_skips_non_list_inputs():
    m = _make_mapper()

    fake_node_cls = MagicMock()
    fake_node_cls.INPUT_TYPES.return_value = {
        "required": {
            "text": ("STRING", {}),
        }
    }
    fake_prompt = {"1": {"class_type": "CLIPTextEncode", "inputs": {"text": "hello"}}}

    import nodes as comfy_nodes
    comfy_nodes.NODE_CLASS_MAPPINGS = {"CLIPTextEncode": fake_node_cls}
    results = m.extract_models_from_prompt(fake_prompt)

    assert results == []
```

**Step 5: Run all tests**

```bash
python -m pytest tests/test_model_mapper.py -v
```

Expected: all PASS

**Step 6: Commit**

```bash
git add mapper.py tests/test_model_mapper.py
git commit -m "feat: add ModelMapper with folder_paths introspection"
```

---

### Task 3: Extend __init__.py — prompt handler + API endpoint

**Files:**
- Modify: `__init__.py`

No automated tests here (requires live ComfyUI server). Test manually after Task 4.

**Step 1: Import ModelMapper and create instance**

At the top of `__init__.py`, after existing imports:

```python
from .mapper import NodePackageMapper, ModelMapper
```

After `tracker = UsageTracker()`, add:

```python
model_mapper = ModelMapper()
```

**Step 2: Extend on_prompt_handler to extract models**

Replace the existing `on_prompt_handler` function:

```python
def on_prompt_handler(json_data):
    """Called on every prompt submission. Extracts class_types and queues recording."""
    try:
        prompt = json_data.get("prompt", {})
        class_types = set()
        for node_id, node_data in prompt.items():
            ct = node_data.get("class_type")
            if ct:
                class_types.add(ct)
        if class_types:
            # Pass the full prompt to the thread — model extraction (which calls
            # INPUT_TYPES() on every node) happens off the main request thread.
            threading.Thread(
                target=_record_prompt,
                args=(class_types, prompt),
                daemon=True,
            ).start()
    except Exception:
        logger.warning("nodes-stats: error recording usage", exc_info=True)
    return json_data


def _record_prompt(class_types, prompt):
    tracker.record_usage(class_types, mapper)
    models = model_mapper.extract_models_from_prompt(prompt)
    if models:
        tracker.record_model_usage(models)
```

**Step 3: Extend reset endpoint to invalidate model_mapper**

In the `reset_stats` route handler, add `model_mapper.invalidate()` after `mapper.invalidate()`:

```python
@routes.post("/nodes-stats/reset")
async def reset_stats(request):
    try:
        tracker.reset()
        mapper.invalidate()
        model_mapper.invalidate()
        return web.json_response({"status": "ok"})
    except Exception:
        logger.error("nodes-stats: error resetting stats", exc_info=True)
        return web.json_response({"error": "internal error"}, status=500)
```

**Step 4: Add /nodes-stats/models endpoint**

After the existing `/nodes-stats/usage` route:

```python
@routes.get("/nodes-stats/models")
async def get_model_stats(request):
    try:
        installed_by_type = model_mapper.get_all_models()
        stats = tracker.get_model_stats(installed_by_type)
        return web.json_response(stats)
    except Exception:
        logger.error("nodes-stats: error getting model stats", exc_info=True)
        return web.json_response({"error": "internal error"}, status=500)
```

**Step 5: Commit**

```bash
git add __init__.py
git commit -m "feat: extend prompt handler and add /nodes-stats/models endpoint"
```

---

### Task 4: Frontend — tab switcher + Models tab

**Files:**
- Modify: `js/nodes_stats.js`

**Step 1: Update showStatsDialog to fetch models data**

Replace the fetch at the top of `showStatsDialog()`:

```javascript
async function showStatsDialog() {
  let data, modelData;
  try {
    const [pkgResp, modelResp] = await Promise.all([
      fetch("/nodes-stats/packages"),
      fetch("/nodes-stats/models"),
    ]);
    if (!pkgResp.ok) { alert("Failed to load node stats: HTTP " + pkgResp.status); return; }
    if (!modelResp.ok) { alert("Failed to load model stats: HTTP " + modelResp.status); return; }
    data = await pkgResp.json();
    modelData = await modelResp.json();
    if (!Array.isArray(data) || !Array.isArray(modelData)) {
      alert("Failed to load stats: unexpected response format");
      return;
    }
  } catch (e) {
    alert("Failed to load stats: " + e.message);
    return;
  }
  // ... rest of function
```

**Step 2: Replace dialog html construction with tabbed layout**

After the existing `let html = ...` header block (the title + close button), replace the rest of the dialog HTML building with:

```javascript
  // Tab switcher — no onclick attributes, wired via addEventListener after insertion
  html += `
  <div style="display:flex;gap:0;margin-bottom:20px;border-bottom:1px solid #333;">
    <button id="ns-tab-nodes"
      style="background:none;border:none;border-bottom:2px solid #4a4;color:#4a4;padding:8px 18px;cursor:pointer;font-family:monospace;font-size:13px;font-weight:bold;">
      Nodes
    </button>
    <button id="ns-tab-models"
      style="background:none;border:none;border-bottom:2px solid transparent;color:#888;padding:8px 18px;cursor:pointer;font-family:monospace;font-size:13px;">
      Models
    </button>
  </div>`;

  // Nodes tab content (existing content, wrapped)
  html += `<div id="ns-content-nodes">`;
  html += buildNodesTabContent(custom);
  html += `</div>`;

  // Models tab content
  html += `<div id="ns-content-models" style="display:none;">`;
  html += buildModelsTabContent(modelData);
  html += `</div>`;

  dialog.innerHTML = html;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Tab switch — local function, no window pollution
  function switchTab(tab) {
    dialog.querySelector("#ns-content-nodes").style.display = tab === "nodes" ? "" : "none";
    dialog.querySelector("#ns-content-models").style.display = tab === "models" ? "" : "none";
    const nodeBtn = dialog.querySelector("#ns-tab-nodes");
    const modelBtn = dialog.querySelector("#ns-tab-models");
    nodeBtn.style.borderBottomColor = tab === "nodes" ? "#4a4" : "transparent";
    nodeBtn.style.color = tab === "nodes" ? "#4a4" : "#888";
    nodeBtn.style.fontWeight = tab === "nodes" ? "bold" : "normal";
    modelBtn.style.borderBottomColor = tab === "models" ? "#4a4" : "transparent";
    modelBtn.style.color = tab === "models" ? "#4a4" : "#888";
    modelBtn.style.fontWeight = tab === "models" ? "bold" : "normal";
  }
  dialog.querySelector("#ns-tab-nodes").addEventListener("click", () => switchTab("nodes"));
  dialog.querySelector("#ns-tab-models").addEventListener("click", () => switchTab("models"));
```

**Step 3: Extract existing content into buildNodesTabContent()**

Move the existing badge bar + section rendering into a new function. Extract the block that builds the summary badges and sections (everything from the `<div style="display:flex;gap:10px...">` badges to the end of the section tables) into:

```javascript
function buildNodesTabContent(custom) {
  const safeToRemove    = custom.filter((p) => p.status === "safe_to_remove");
  const considerRemoving = custom.filter((p) => p.status === "consider_removing");
  const unusedNew       = custom.filter((p) => p.status === "unused_new");
  const used            = custom.filter((p) => p.status === "used");
  const uninstalled     = custom.filter((p) => p.status === "uninstalled");

  let html = `<div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
    <div style="background:#3a1a1a;padding:8px 14px;border-radius:4px;border-left:3px solid #e44;">
      <span style="font-size:20px;font-weight:bold;color:#e44;">${safeToRemove.length}</span>
      <span style="color:#c99;margin-left:6px;">safe to remove</span>
    </div>
    <div style="background:#2a2215;padding:8px 14px;border-radius:4px;border-left:3px solid #e90;">
      <span style="font-size:20px;font-weight:bold;color:#e90;">${considerRemoving.length}</span>
      <span style="color:#ca8;margin-left:6px;">consider removing</span>
    </div>
    <div style="background:#1a1a2a;padding:8px 14px;border-radius:4px;border-left:3px solid #68f;">
      <span style="font-size:20px;font-weight:bold;color:#68f;">${unusedNew.length}</span>
      <span style="color:#99b;margin-left:6px;">unused &lt;1 month</span>
    </div>
    <div id="nodes-stats-used-badge" style="background:#1a2a1a;padding:8px 14px;border-radius:4px;border-left:3px solid #4a4;cursor:default;user-select:none;">
      <span style="font-size:20px;font-weight:bold;color:#4a4;">${used.length}</span>
      <span style="color:#9c9;margin-left:6px;">used</span>
    </div>
  </div>`;

  if (safeToRemove.length > 0)    html += sectionHeader("Safe to Remove", "Unused for 2+ months", "#e44")    + buildTable(safeToRemove, "safe_to_remove");
  if (considerRemoving.length > 0) html += sectionHeader("Consider Removing", "Unused for 1-2 months", "#e90") + buildTable(considerRemoving, "consider_removing");
  if (unusedNew.length > 0)        html += sectionHeader("Recently Unused", "Unused for less than 1 month", "#68f") + buildTable(unusedNew, "unused_new");
  if (used.length > 0)             html += sectionHeader("Used", "", "#4a4")                                   + buildTable(used, "used");
  if (uninstalled.length > 0)      html += sectionHeader("Uninstalled", "Previously tracked, no longer installed", "#555") + buildTable(uninstalled, "uninstalled");

  return html;
}
```

**Step 4: Write buildModelsTabContent()**

Add this new function:

```javascript
function buildModelsTabContent(modelData) {
  // Flatten for summary counts
  const allModels = modelData.flatMap((g) => g.models);
  const safeCount      = allModels.filter((m) => m.status === "safe_to_remove").length;
  const considerCount  = allModels.filter((m) => m.status === "consider_removing").length;
  const unusedNewCount = allModels.filter((m) => m.status === "unused_new").length;
  const usedCount      = allModels.filter((m) => m.status === "used").length;

  let html = `<div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
    <div style="background:#3a1a1a;padding:8px 14px;border-radius:4px;border-left:3px solid #e44;">
      <span style="font-size:20px;font-weight:bold;color:#e44;">${safeCount}</span>
      <span style="color:#c99;margin-left:6px;">safe to remove</span>
    </div>
    <div style="background:#2a2215;padding:8px 14px;border-radius:4px;border-left:3px solid #e90;">
      <span style="font-size:20px;font-weight:bold;color:#e90;">${considerCount}</span>
      <span style="color:#ca8;margin-left:6px;">consider removing</span>
    </div>
    <div style="background:#1a1a2a;padding:8px 14px;border-radius:4px;border-left:3px solid #68f;">
      <span style="font-size:20px;font-weight:bold;color:#68f;">${unusedNewCount}</span>
      <span style="color:#99b;margin-left:6px;">unused &lt;1 month</span>
    </div>
    <div style="background:#1a2a1a;padding:8px 14px;border-radius:4px;border-left:3px solid #4a4;">
      <span style="font-size:20px;font-weight:bold;color:#4a4;">${usedCount}</span>
      <span style="color:#9c9;margin-left:6px;">used</span>
    </div>
  </div>`;

  if (allModels.length === 0) {
    html += `<p style="color:#666;">No models tracked yet. Run a workflow to start.</p>`;
    return html;
  }

  for (const group of modelData) {
    if (group.models.length === 0) continue;
    const title = group.model_type.charAt(0).toUpperCase() + group.model_type.slice(1).replace(/_/g, " ");
    html += sectionHeader(title, `${group.models.length} model${group.models.length !== 1 ? "s" : ""}`, "#4a4");
    html += buildModelTable(group.models);
  }

  return html;
}

function buildModelTable(models) {
  let html = `<table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
    <thead><tr style="color:#888;text-align:left;border-bottom:1px solid #333;">
      <th style="padding:6px 8px;">Model</th>
      <th style="padding:6px 8px;text-align:right;">Executions</th>
      <th style="padding:6px 8px;">Last Used</th>
      <th style="padding:6px 8px;">Status</th>
    </tr></thead><tbody>`;

  for (const m of models) {
    const { bg, hover } = STATUS_COLORS[m.status] || STATUS_COLORS.used;
    const lastSeen = m.last_seen ? new Date(m.last_seen).toLocaleDateString() : "—";
    const statusLabel = {
      safe_to_remove:    { text: "safe to remove",    color: "#e44" },
      consider_removing: { text: "consider removing", color: "#e90" },
      unused_new:        { text: "unused <1mo",       color: "#68f" },
      used:              { text: "used",               color: "#4a4" },
      uninstalled:       { text: "uninstalled",        color: "#555" },
    }[m.status] || { text: m.status, color: "#888" };

    html += `<tr style="background:${bg};border-bottom:1px solid #222;"
      onmouseover="this.style.background='${hover}'" onmouseout="this.style.background='${bg}'">
      <td style="padding:6px 8px;color:#fff;">${escapeHtml(m.model_name)}</td>
      <td style="padding:6px 8px;text-align:right;">${m.count}</td>
      <td style="padding:6px 8px;color:#888;">${lastSeen}</td>
      <td style="padding:6px 8px;"><span style="color:${statusLabel.color};font-size:11px;">${statusLabel.text}</span></td>
    </tr>`;
  }

  html += `</tbody></table>`;
  return html;
}
```

**Step 5: Remove duplicated variable declarations**

The variables `safeToRemove`, `considerRemoving`, `unusedNew`, `used`, `uninstalled` that were at the top of `showStatsDialog` are now inside `buildNodesTabContent` — remove them from `showStatsDialog`.

Also remove the easter egg badge wiring from after `dialog.innerHTML = html` since it's now inside the nodes tab. Move it after the `nsShowTab` assignment, but target the badge which is inside `ns-content-nodes`:

```javascript
  // Easter egg: click "used" badge 5 times to show podium
  let eggClicks = 0;
  let eggTimer = null;
  const usedBadge = document.getElementById("nodes-stats-used-badge");
  if (usedBadge) {
    usedBadge.addEventListener("click", () => {
      eggClicks++;
      clearTimeout(eggTimer);
      eggTimer = setTimeout(() => (eggClicks = 0), 1500);
      if (eggClicks >= 5) {
        eggClicks = 0;
        const allNodes = custom
          .flatMap((p) => p.nodes.map((n) => ({ ...n, pkg: p.package })))
          .sort((a, b) => b.count - a.count);
        showPodium(allNodes.slice(0, 3), overlay);
      }
    });
  }
```

Note: `custom` needs to be accessible here — declare it at the top of `showStatsDialog` before the html building:

```javascript
  const custom = data.filter((p) => p.package !== "__builtin__");
```

**Step 6: Wire close button and pkg-row toggles**

These are already present; make sure they remain after the new `dialog.innerHTML = html` assignment:

```javascript
  document.getElementById("nodes-stats-close").addEventListener("click", () => overlay.remove());

  dialog.querySelectorAll(".pkg-row").forEach((row) => {
    row.addEventListener("click", () => {
      const detail = row.nextElementSibling;
      if (detail && detail.classList.contains("pkg-detail")) {
        detail.style.display = detail.style.display === "none" ? "table-row" : "none";
        const arrow = row.querySelector(".arrow");
        if (arrow) arrow.textContent = detail.style.display === "none" ? "▶" : "▼";
      }
    });
  });
```

**Step 7: Manual test**

1. Restart ComfyUI
2. Open a workflow that uses a checkpoint (e.g. CheckpointLoaderSimple)
3. Queue a prompt
4. Click the Node Stats button → should see "Nodes" and "Models" tabs
5. Switch to Models tab → checkpoint should appear under "Checkpoints" with count ≥ 1
6. Other installed checkpoints with no usage should show as `unused_new` (or `safe_to_remove` if tracking has been running >2mo)

**Step 8: Commit**

```bash
git add js/nodes_stats.js
git commit -m "feat: add Models tab with per-type usage stats"
```

---

### Task 5: Final check and cleanup

**Step 1: Run full test suite**

```bash
python -m pytest tests/ -v
```

Expected: all PASS

**Step 2: Verify reset clears model data**

```bash
curl -X POST http://localhost:8188/nodes-stats/reset
curl http://localhost:8188/nodes-stats/models | python3 -m json.tool
# Expect: models with count=0 and status=unused_new (none tracked yet)
```

**Step 3: Commit if any cleanup needed**

```bash
git add -p
git commit -m "chore: cleanup after model tracking implementation"
```
