# Model Usage Tracking — Design

**Date:** 2026-04-08
**Status:** Approved

## Goal

Extend ComfyUI Node Stats to also track which model files are used across prompts, and surface models that are never used — making it easy to identify files that can be safely deleted.

**Scope:** All model folder types registered in `folder_paths` except LoRAs (and non-model folders: `configs`, `custom_nodes`, `temp`, `output`, `input`). Discovered dynamically so custom-node-added types are picked up automatically.

## Design Decisions

- **Tracked per filename globally** — `dreamshaper.safetensors` is one entry regardless of which node loads it. `model_type` is stored for display grouping only.
- **Detection via node introspection (Approach A)** — At prompt time, for each node look up its `INPUT_TYPES()`, find inputs whose type is a list (ComfyUI folder dropdown pattern), cross-reference with `folder_paths` to identify the folder type, extract the selected value.
- **UI: new tab** in the existing dialog alongside the current "Nodes" tab.
- **Same tier classification** as packages: `used`, `unused_new`, `consider_removing`, `safe_to_remove`, `uninstalled`.
- **Existing node stats are unaffected** — additive only.

## Data Collection

In `on_prompt_handler` (`__init__.py`), after extracting `class_types`, also extract model references:

1. For each node in the prompt, look up its class in `nodes.NODE_CLASS_MAPPINGS`
2. Call `INPUT_TYPES()` and find inputs whose declared type is a `list`
3. Map that list back to its `folder_paths` folder type (via reverse lookup built at startup)
4. Extract the actual selected value from the prompt's `inputs` dict
5. Record `(model_name, model_type)` via background thread

A `ModelMapper` class (in `mapper.py` or new file) handles the reverse lookup: `folder_type → set of filenames`, cached and invalidated on reset.

Excluded folder types (not model files):
```python
EXCLUDED_FOLDER_TYPES = {"loras", "configs", "custom_nodes", "temp", "output", "input", "upscale_models"}
```
> Note: `upscale_models` may be included/excluded per preference; default include.

## Storage

New table in existing `usage_stats.db`:

```sql
CREATE TABLE IF NOT EXISTS model_usage (
    model_name TEXT PRIMARY KEY,
    model_type TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_usage_type ON model_usage(model_type);
```

Same upsert pattern as `node_usage`. `reset` clears this table too.

## API

New endpoint:

```
GET /nodes-stats/models
```

Returns a list of model types, each containing classified models:

```json
[
  {
    "model_type": "checkpoints",
    "models": [
      {
        "model_name": "dreamshaper.safetensors",
        "count": 42,
        "first_seen": "2026-01-01T00:00:00+00:00",
        "last_seen": "2026-03-01T00:00:00+00:00",
        "installed": true,
        "status": "used"
      },
      {
        "model_name": "old_model.ckpt",
        "count": 0,
        "first_seen": null,
        "last_seen": null,
        "installed": true,
        "status": "safe_to_remove"
      }
    ]
  }
]
```

"All installed models" sourced from `folder_paths.get_filename_list(type)` for each tracked type. Models on disk but never seen appear with `count: 0`.

Existing endpoints unchanged:
- `GET /nodes-stats/packages`
- `GET /nodes-stats/usage`
- `POST /nodes-stats/reset` — extended to also clear `model_usage`

## UI

Two tabs at top of dialog: **Nodes** (existing content, untouched) | **Models** (new).

Models tab layout:
- Summary badge bar: counts per status tier across all model types
- One section per model type (only types with ≥1 model shown), titled e.g. "Checkpoints", "VAE", "ControlNet"
- Within each section: models sorted by status tier (safe_to_remove → consider_removing → unused_new → used), then alphabetically
- Each row: model name | execution count | last used date | status color
- No expandable rows (models are leaves)
- Uninstalled models: collapsed section at the bottom, same pattern as node packages

## File Changes

| File | Change |
|------|--------|
| `tracker.py` | Add `model_usage` table to schema; add `record_model_usage()`, `get_model_stats()` methods; extend `reset()` |
| `mapper.py` | Add `ModelMapper` class with folder-type reverse lookup and model filename introspection |
| `__init__.py` | Extend `on_prompt_handler` to extract and record model usage; add `GET /nodes-stats/models` endpoint |
| `js/nodes_stats.js` | Add tab switcher UI; add Models tab rendering (summary badges + per-type sections) |
