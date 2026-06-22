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
- **One-click disable** — disable unused packages straight from the dialog via ComfyUI Manager (per-package or in bulk), reversible at any time
- **Workflow tab** — on loading a workflow, splits unresolved nodes into *Missing* (install permanently or on a trial) and *Disabled* (enable permanently or on a trial), with a rolling **7-day trial** that auto-disables packages left unused
- **Mirror search** — a standalone palette (⌕ button / `Ctrl/Cmd+Shift+D`) that searches nodes belonging to currently-disabled packages, draws an imitation node box (real inputs/widgets/outputs, parsed from source), and re-enables the pack on the spot
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

Click the **Node Stats** button (bar chart icon) in the ComfyUI top menu bar. A dialog opens with three tabs:

**Nodes tab**
- Summary bar with counts for each classification tier
- Sections for each tier, sorted from most actionable to least
- Expandable rows — click any package to see per-node execution counts and timestamps
- **Disable** buttons on the "Safe to Remove" and "Consider Removing" tiers (see below)

### Disabling unused packages

When [ComfyUI Manager](https://github.com/ltdrdata/ComfyUI-Manager) is installed, the
"Safe to Remove" and "Consider Removing" sections show a **Disable** button on each
package, plus a **Disable all** button per section. Disabling:

- Hands off to ComfyUI Manager, which moves the package into `custom_nodes/.disabled/`
- Is fully reversible — re-enable any package from ComfyUI Manager whenever you like
- Requires a ComfyUI restart to unload the package from the running session (a banner
  with a **Restart ComfyUI** button appears after disabling)

If ComfyUI Manager is not installed, the disable buttons are hidden and stats work as before.

### Workflow tab & temporary enable

Whenever you load a workflow, the extension scans for node types the running
ComfyUI can't resolve and, if any are found, opens the dialog on the **Workflow**
tab. Unresolved nodes are split into two groups:

- **Missing** — the owning package isn't installed. Each row offers:
  - **Install 7d** — really install the package (via
    [ComfyUI Manager](https://github.com/ltdrdata/ComfyUI-Manager)) and start a
    *temporary trial*, so trying out someone else's workflow stays
    non-committal — anything you don't actually use auto-disables.
  - **Install** — install permanently (no trial).

  Both take effect after a ComfyUI restart. If the install can't be resolved or
  Manager refuses it (e.g. a blocked git URL), the buttons fall back to opening
  Manager's Custom Nodes Manager (use its *Missing* filter).
- **Disabled** — the package is installed but currently disabled. Each row offers:
  - **Enable 7d** — re-enable the package and start a *temporary trial*.
  - **Enable** — re-enable permanently (no trial).

**The temporary trial** (started by either *Install 7d* or *Enable 7d*) is a
rolling budget of **7 distinct boot-days**. A
"boot-day" is counted at most once per calendar day, the first time ComfyUI
starts that day — so the clock measures days you actually run ComfyUI, not wall
time. **Any execution that uses the package resets the counter to zero.** If a
trial package goes its full budget of distinct boot-days without being used, it
is **auto-disabled on the next UI load** (handed to ComfyUI Manager exactly like
a manual disable) and the trial is cleared. As with any disable, a ComfyUI
restart is required to fully unload it.

Re-enabling and auto-disabling both go through ComfyUI Manager, so the whole
Workflow tab is inert when Manager is not installed (the backend still tracks
trial state, but no enable/disable actions are offered).

### Mirror search (disabled-pack nodes)

Sometimes you know the node you want exists in a package you've disabled, but you
don't want to dig through ComfyUI Manager to find it. The **mirror search**
palette searches across the `class_type` names of *every currently-disabled
package* and lets you re-enable the owning package right from the results.

- Open it with the **⌕** button in the top menu bar, or press
  **`Ctrl/Cmd+Shift+D`** (ignored while typing in an input).
- Type to filter — results are ranked (node-name prefix first, then word-start,
  substring, finally pack-name matches) and show the `class_type` and its pack.
- Hover a result (or use ↑/↓) to open a **preview panel** on the right with the
  owning package's title, author, description, repo link, and the full list of
  sibling nodes in that pack — the active node highlighted.
- **Click a node's name** (or *Draw this node*) to render an **imitation node
  box** — the real input sockets, widget defaults, and output sockets, drawn from
  a static parse of the disabled pack's source. Since the pack isn't loaded,
  there's no live definition to render; the backend AST-parses the pack on disk
  (read-only, never executed) to recover the schema. Works for most packs (~90%);
  packs that build their node list dynamically fall back to a placeholder box.
- Each result offers **Enable 7d** (re-enable under a 7-day trial) and **Enable**
  (re-enable permanently) — in the row and in the preview panel — the same enable
  path as the Workflow tab.
- Enabling takes effect after a ComfyUI restart; enabled rows mark
  *"✓ enabled · restart"*.

The catalog is built once per session by joining ComfyUI Manager's node→pack
mappings with the disabled packs (matched across dir name, registry id, and repo
URL), and cached; use the **↻** button to rebuild it. The palette is inert (with
a clear message) when ComfyUI Manager is absent or there are no disabled packages.

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
| `/nodes-stats/node-schema` | GET | Parsed input/output schema for one disabled-pack node — query `class_type`, `pack` (read-only AST parse) |
| `/nodes-stats/reset` | POST | Clear all tracked data |
| `/nodes-stats/trials` | GET | Active temporary-enable trials with `days_remaining`/`expired` |
| `/nodes-stats/trials/start` | POST | Begin/restart a trial — body `{"package": "<dir-name>"}` |
| `/nodes-stats/trials/stop` | POST | End a trial (made permanent or disabled) — body `{"package": "<dir-name>"}` |

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
| `trial_packages` | Per temporary-enable trial: package, enable date, unused-boot-day counter, budget |

Use `POST /nodes-stats/reset` to clear all data and start fresh.

## Slow ComfyUI boot? Diagnose the model-folder scan

If ComfyUI is slow to start at the "scanning model folders" / "Building node
definitions" stage, the cause is almost always model folders on a slow (often
network) filesystem: ComfyUI walks every registered model folder on each boot,
and that cache is in-memory only (lost on restart).

`tools/diagnose_model_scan.py` measures this the same way ComfyUI does and ranks
the folders by scan cost, flags network mounts and their `actimeo`/`cache`
options, and points at the worst offender. It is read-only.

```bash
cd /path/to/ComfyUI
python tools/diagnose_model_scan.py            # 30s cap per folder
python tools/diagnose_model_scan.py --timeout 600 --warm   # full timing + warm pass
```

Typical fix for network-mounted model folders (CIFS): raise the attribute-cache
timeout so the kernel keeps the listing warm across restarts, e.g.
`actimeo=3600,acdirmax=3600,acregmax=3600,cache=loose`.

## File Structure

```
__init__.py                     Entry point: prompt handler, API routes
mapper.py                       class_type → package mapping; model filename → type mapping
tracker.py                      SQLite persistence and stats aggregation
node_introspect.py              Read-only AST parse of disabled packs → node input/output schema
js/nodes_stats.js               Frontend: menu button + stats dialog (Nodes/Models/Workflow tabs) + mirror search
tools/diagnose_model_scan.py    Standalone: diagnose slow model-folder scans at boot
pyproject.toml                  Package metadata
tests/                          Unit tests for tracker and mapper
```
