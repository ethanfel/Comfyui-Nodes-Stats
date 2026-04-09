# ComfyUI Node Usage Stats

<p align="center">
  <img src="docs/logo.svg" width="120" alt="Node Stats logo">
</p>

A ComfyUI custom node package that silently tracks which nodes, packages, and model files you actually use. Helps identify unused packages and models that are safe to remove — keeping your ComfyUI install lean.

## Features

- **Silent tracking** — hooks into every prompt submission, zero config needed
- **Node & model tracking** — tracks custom node packages and model files (checkpoints, VAEs, ControlNets, etc.) separately
- **Per-package classification** — packages are sorted into tiers based on usage recency
- **Per-model classification** — models grouped by type (checkpoints, vae, …) with the same recency tiers
- **Smart aging** — items gradually move from "recently unused" to "safe to remove" over time
- **Uninstall detection** — removed packages/models are flagged separately, historical data preserved
- **Expandable detail** — click any package to see individual node-level stats
- **Non-blocking** — DB writes happen in a background thread, no impact on workflow execution

## Package Classification

Packages are classified into tiers based on when they were last used:

<table>
<tr>
<td><img src="docs/status_used.svg" width="18"> <b>Used</b></td>
<td>Actively used within the last month</td>
</tr>
<tr>
<td><img src="docs/status_unused_new.svg" width="18"> <b>Recently Unused</b></td>
<td>Not used yet, but tracking started less than a month ago — too early to judge</td>
</tr>
<tr>
<td><img src="docs/status_consider.svg" width="18"> <b>Consider Removing</b></td>
<td>Unused for 1–2 months — worth reviewing</td>
</tr>
<tr>
<td><img src="docs/status_safe.svg" width="18"> <b>Safe to Remove</b></td>
<td>Unused for 2+ months — confident removal candidate</td>
</tr>
<tr>
<td><img src="docs/status_uninstalled.svg" width="18"> <b>Uninstalled</b></td>
<td>Previously tracked but no longer installed — shown for reference</td>
</tr>
</table>

## Installation

```bash
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/ethanfel/Comfyui-Nodes-Stats.git
```

Restart ComfyUI. Tracking starts immediately and silently.

## Usage

### UI

Click the **Node Stats** button (bar chart icon) in the ComfyUI top menu bar. A dialog opens with two tabs:

**Nodes tab**
- Summary bar with counts for each classification tier
- Sections for each tier, sorted from most actionable to least
- Expandable rows — click any package to see per-node execution counts and timestamps

**Models tab**
- Summary bar with counts for each tier across all model types
- Sections per model type (checkpoints, vae, controlnet, …)
- Per-model table showing execution count, last used date, and status

### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/nodes-stats/packages` | GET | Per-package aggregated stats with classification |
| `/nodes-stats/usage` | GET | Raw per-node usage data |
| `/nodes-stats/models` | GET | Per-type model stats with classification |
| `/nodes-stats/reset` | POST | Clear all tracked data |

```bash
curl http://localhost:8188/nodes-stats/packages | python3 -m json.tool
```

<details>
<summary>Example response</summary>

```json
[
  {
    "package": "ComfyUI-Impact-Pack",
    "total_executions": 42,
    "used_nodes": 5,
    "total_nodes": 30,
    "last_seen": "2026-02-22T12:00:00+00:00",
    "installed": true,
    "status": "used",
    "nodes": [
      {
        "class_type": "SAMDetectorCombined",
        "package": "ComfyUI-Impact-Pack",
        "count": 20,
        "first_seen": "2026-01-01T00:00:00+00:00",
        "last_seen": "2026-02-22T12:00:00+00:00"
      }
    ]
  },
  {
    "package": "ComfyUI-Unused-Nodes",
    "total_executions": 0,
    "used_nodes": 0,
    "total_nodes": 12,
    "last_seen": null,
    "installed": true,
    "status": "safe_to_remove",
    "nodes": []
  }
]
```

</details>

## How It Works

```
Queue Prompt ──> Prompt Handler ──> Extract class_types + prompt ──> Background Thread
                                                                              │
                                              ┌───────────────────────────────┘
                                              ▼
                                         SQLite DB
                                        usage_stats.db
                                         ┌─────────────┐
                                         │ node_usage  │  per-node counts & timestamps
                                         │ prompt_log  │  full node list per prompt
                                         │ model_usage │  per-model counts & timestamps
                                         └─────────────┘
                                              │
          GET /nodes-stats/packages ◄─────────┤
          GET /nodes-stats/models   ◄─────────┘
                    │
                    ▼
          Merge DB data with installed
          nodes/models, classify by recency
                    │
                    ▼
          JSON response ──> UI Dialog (Nodes tab / Models tab)
```

1. Registers a prompt handler via `PromptServer.instance.add_on_prompt_handler()`
2. On every prompt submission, extracts `class_type` from each node and the full prompt dict
3. Offloads recording to a background thread (non-blocking)
4. Maps each class_type to its source package using `RELATIVE_PYTHON_MODULE`
5. Detects model file selections by introspecting each node's `INPUT_TYPES()` for folder-dropdown inputs, then resolves filenames via `folder_paths`
6. Upserts per-node and per-model counts and timestamps into SQLite
7. On stats request, merges DB data with current node registry / installed models and classifies by recency

## Data Storage

All data is stored in `<ComfyUI user dir>/nodes_stats/usage_stats.db` (survives extension reinstalls).

| Table | Contents |
|-------|----------|
| `node_usage` | Per-node: class_type, package, execution count, first/last seen |
| `prompt_log` | Per-prompt: timestamp, JSON array of all class_types used |
| `model_usage` | Per-model: filename, type, execution count, first/last seen |

Use `POST /nodes-stats/reset` to clear all data and start fresh.

## File Structure

```
__init__.py        Entry point: prompt handler, API routes
mapper.py          class_type → package mapping; model filename → type mapping
tracker.py         SQLite persistence and stats aggregation
js/nodes_stats.js  Frontend: menu button + stats dialog (Nodes/Models tabs)
pyproject.toml     Package metadata
tests/             Unit tests for tracker and mapper
```
