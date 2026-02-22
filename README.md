# ComfyUI Node Usage Stats

A ComfyUI custom node package that silently tracks which nodes and packages you actually use. Helps identify never-used packages that are safe to remove.

## Features

- Tracks every node used in every workflow execution
- Maps each node to its source package
- SQLite storage for efficient querying
- Per-package aggregated stats (total nodes, used/unused, execution counts)
- Frontend dialog with never-used packages highlighted for removal
- Expandable rows to see individual node-level stats within each package

## Installation

```bash
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/ethanfel/Comfyui-Nodes-Stats.git
```

Restart ComfyUI. Tracking starts immediately and silently.

## Usage

### UI

Click the **"Node Stats"** button in the ComfyUI menu. A dialog shows:

- Summary: how many packages are never-used vs used
- **Never Used** section (highlighted) — safe to remove
- **Used** section sorted by least-to-most executions
- Click any row to expand and see individual node stats

### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/nodes-stats/packages` | GET | Per-package aggregated stats |
| `/nodes-stats/usage` | GET | Raw per-node usage data |
| `/nodes-stats/reset` | POST | Clear all tracked data |

Example:

```bash
curl http://localhost:8188/nodes-stats/packages | python3 -m json.tool
```

### Package stats response format

```json
[
  {
    "package": "ComfyUI-Impact-Pack",
    "total_executions": 42,
    "used_nodes": 5,
    "total_nodes": 30,
    "never_used": false,
    "last_seen": "2026-02-22T12:00:00+00:00",
    "nodes": [
      {
        "class_type": "SAMDetectorCombined",
        "package": "ComfyUI-Impact-Pack",
        "count": 20,
        "first_seen": "2026-01-01T00:00:00+00:00",
        "last_seen": "2026-02-22T12:00:00+00:00"
      }
    ]
  }
]
```

## File Structure

```
__init__.py      # Entry point: prompt handler, API routes
mapper.py        # class_type -> package name mapping
tracker.py       # SQLite persistence and stats aggregation
js/
  nodes_stats.js # Frontend: menu button + stats dialog
pyproject.toml   # Package metadata
```

## How It Works

1. Registers a prompt handler via `PromptServer.instance.add_on_prompt_handler()`
2. On every prompt submission, extracts `class_type` from each node
3. Maps each class_type to its source package using `RELATIVE_PYTHON_MODULE`
4. Stores per-node counts and timestamps in SQLite (`usage_stats.db`)
5. Also logs the full set of nodes per prompt for future trend analysis

## Data Storage

All data is stored in `usage_stats.db` in the package directory. Two tables:

- **node_usage**: per-node counts, first/last seen timestamps
- **prompt_log**: JSON array of nodes used per prompt, with timestamp

Use `POST /nodes-stats/reset` to clear all data.
