# Design: Workflow tab + temporary trial-enable for disabled packages

Date: 2026-06-21
Status: Approved

## Summary

When a loaded workflow references node types that aren't currently resolvable,
Node Stats shows a **Workflow** tab that splits them into:

- **Missing** — the owning package is not installed (or unknown). Handled by
  ComfyUI Manager as usual (install).
- **Disabled** — the owning package is installed but disabled (in
  `custom_nodes/.disabled`). Offers two actions:
  - **Enable temporarily** — re-enable the package under a rolling 7-day trial.
  - **Enable permanently** — normal re-enable, never auto-disabled.

A temporarily-enabled package auto-disables again if it goes **7 distinct
boot-days without being used** in an executed prompt. Any execution use resets
the counter back to 7 (rolling window), so a package stays enabled as long as it
keeps getting used.

## Decisions (from brainstorming)

- **Graduation model:** rolling. Each execution use resets the counter to the
  full budget (7). 7 distinct boot-days unused → auto-disable. No permanent
  "graduation"; a trial package stays trial-managed, kept alive by use.
- **"Used" means:** the package's node appears in an *executed/queued* prompt.
  Reuses the existing usage tracking. Loading a workflow does not count.
- **Granularity:** the tab lists individual node types ("list by node"), but
  every action resolves to and operates on the owning *package* (Manager works
  per package). Trial state is tracked per package.
- **Surfacing:** on workflow load, if any node is disabled/missing, auto-open
  the Node Stats dialog to the Workflow tab.
- **Disabled actions:** both "Enable temporarily" (trial) and "Enable
  permanently".
- **Missing:** defer to ComfyUI Manager (install), as usual.
- **Orchestration (Approach A):** the Python backend only tracks trial state,
  counts boot-days, resets on use, and flags expiry. The frontend performs all
  ComfyUI-Manager enable/disable mutations (server is up, reuses the proven
  disable code, no coupling to Manager internals). Day-counting stays accurate
  across headless restarts; the actual auto-disable executes the next time the
  web UI loads.

## Data model

New SQLite table `trial_packages` in the existing DB:

| column | meaning |
|---|---|
| `package` (PK) | directory name (matches our package keys) |
| `enabled_at` | ISO timestamp the trial started |
| `last_use_day` | `YYYY-MM-DD` of last execution use (init = enable day) |
| `last_boot_day` | `YYYY-MM-DD` of last boot-day counted |
| `unused_boot_days` | counter, 0..budget |
| `budget` | distinct boot-days allowed unused (default 7) |

### Lifecycle

- **Start trial** (after frontend temp-enable): upsert with
  `unused_boot_days=0`, `last_boot_day=today`, `last_use_day=today`,
  `enabled_at=now`. The enable day never counts toward expiry ("not the same
  day").
- **Boot tick** (`tracker.tick_boot_days()`, called once at `__init__` import):
  for each trial row, if `last_boot_day != today`: `unused_boot_days += 1`,
  `last_boot_day = today`.
- **Expiry:** computed, not stored — `expired = unused_boot_days >= budget`.
- **Use reset** (`reset_trials_for(packages)`, called from `_record_prompt`
  after `record_usage`): for each used package on trial, set
  `unused_boot_days = 0`, `last_use_day = today`.
- **Stop trial** (`stop_trial(package)`): delete the row. Called after permanent
  enable, after the frontend disables an expired pack, or if re-disabled.

Disabling an already-disabled package via Manager is a no-op, so a stale trial
row (e.g. package disabled out-of-band) resolves cleanly on next expiry pass.

## Backend (Python)

- `tracker.py`: add table to `SCHEMA`; methods `start_trial`, `stop_trial`,
  `tick_boot_days`, `reset_trials_for(packages)`, `get_trials`.
- `__init__.py`:
  - At import: `tracker.tick_boot_days()` wrapped in try/except (never blocks
    extension load).
  - In `_record_prompt`: after `record_usage`, map used class_types → packages
    and call `tracker.reset_trials_for(packages)`.
  - Routes:
    - `GET /nodes-stats/trials` → `[{package, unused_boot_days, budget,
      days_remaining, expired, enabled_at, last_use_day}, ...]`
    - `POST /nodes-stats/trials/start` `{package}` → upsert trial
    - `POST /nodes-stats/trials/stop` `{package}` → delete trial

The backend never calls ComfyUI Manager.

## Frontend (JS)

- **WF-load hook:** wrap `app.loadGraphData` (and/or graph-changed event);
  collect node types present in the graph but not in
  `LiteGraph.registered_node_types` (unresolved).
- **Classify** unresolved types using:
  - `/customnode/getmappings?mode=local` → class_type → pack key
  - `/customnode/getlist?mode=local&skip_update=true` → pack install state
  - pack state `disabled` → Disabled bucket; `not-installed`/unmappable →
    Missing bucket. (Reconcile the getmappings pack key against getlist entries
    by id/cnr_id/aux_id — verify field names during implementation.)
- **Workflow tab**, auto-opened when ≥1 unresolved node:
  - Disabled rows (by node): `[Enable 7d]` (temp → Manager enable, then
    `trials/start`), `[Enable]` (permanent → Manager enable, then `trials/stop`
    if previously on trial). Show "on trial — N day-boots left" when applicable.
  - Missing rows (by node): `[Install]` → defer to Manager install.
  - Actions resolve to the owning package and dedupe.
- **Expiry execution:** on app load / dialog open, `GET /nodes-stats/trials`;
  for `expired` packs, disable via Manager (reuse existing disable code) →
  `trials/stop` → toast "auto-disabled N unused trial package(s)".
- Enable/disable need a restart to apply in the running session → reuse the
  existing restart banner.

## Error handling

- ComfyUI Manager absent → feature inert (no classification, no actions), same
  as the existing disable feature.
- HTTP/DB failures → toast + log; never corrupt trial state. Failed expiry
  disable keeps the row for a later session (retry).
- Package disabled out-of-band → expiry disable no-ops; row cleaned on stop.

## Testing

- `tests/test_trials.py` (pure logic, mocked dates like existing tests):
  - start_trial initializes counters; enable day not counted
  - tick_boot_days increments only on a new calendar day (same-day reboots = 1)
  - reset_trials_for zeroes the counter
  - expiry triggers at `unused_boot_days >= budget`
  - start/stop/get round-trips
- Frontend verified manually (graph load → tab → enable/disable → expiry).

## Known implementation risk

The **enable** payload (`/manager/queue/install` + `skip_post_install=true`)
needs the correct `id`/`version` for disabled packs — the same class of detail
as the disable-payload bug already fixed. Verify empirically against a live
disabled package during implementation rather than assuming.

## Files touched

- `tracker.py` — trial table + methods
- `__init__.py` — boot tick, usage reset hook, 3 routes
- `js/nodes_stats.js` — WF-load hook, classification, Workflow tab, actions,
  expiry execution
- `tests/test_trials.py` — backend unit tests
- `README.md`, `pyproject.toml` — docs + version bump
