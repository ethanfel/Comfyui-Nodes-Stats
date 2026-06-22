# Design: Trial-install (7-day) for missing nodes on workflow load

Date: 2026-06-22
Status: Approved

## Summary

Extend the existing 7-day rolling trial from *disabled* packages to *missing*
(not-installed) ones. When a loaded workflow references node types whose owning
pack isn't installed, the Workflow tab's **Missing** section gains:

- **Install 7d** — really install the pack via ComfyUI Manager, then register a
  7-day trial. If it isn't used (executed) within 7 distinct boot-days, it
  auto-disables (moves to `.disabled`, reversible) via the existing expiry path.
- **Install** — really install the pack permanently (no trial).

This makes trying out someone else's workflow non-committal: pull in what it
needs, and anything you don't actually use gets parked in `.disabled` instead of
permanently bloating the install (which slows boot — the whole point of this
extension).

## Decisions (from clarification)

- **Expiry action:** auto-**disable** (not uninstall). This is free: the trial
  table is keyed by package and `processExpiredTrials()` already disables any
  expired trial pack and clears its row. No new expiry code.
- **Missing-row actions:** both **Install 7d** and **Install** (permanent),
  symmetric with the Disabled section's Enable 7d / Enable. Both perform real
  installs from our UI; the current "open ComfyUI Manager" behavior becomes the
  failure fallback.

## Current state it builds on (v1.6.0, verified)

- `tracker.py`: `trial_packages` table + `start_trial` / `tick_boot_days` /
  `reset_trials_for` / `stop_trial` / `get_trials`. Boot tick + usage reset +
  routes (`/nodes-stats/trials[/start|/stop]`) wired in `__init__.py`.
- `js/nodes_stats.js`:
  - `classifyUnresolved()` (≈624) → `{ disabled[], missing[] }`; missing entries
    are `{ type, pkg: <getmappings packKey> }` where packKey is a dir name,
    registry id, or repo/gist URL.
  - `handleInstall(pkg, dialog)` (≈1155) currently only opens Manager's Custom
    Nodes Manager.
  - `runManagerEnable(payload)` (≈701) = reset → POST `/manager/queue/install`
    → start → `waitForQueue` (install and enable share this endpoint; only the
    payload differs).
  - `processExpiredTrials()` (≈1192) disables expired trial packs via Manager,
    then `stopTrial`.
  - `fetchManagerInfo()` (≈483) returns installed/disabled packs only — it
    **skips** `state==="not-installed"`, so registry data for missing packs is
    not in hand and must be fetched separately.

## Install resolution (the only real new logic)

Not-installed `getlist` entries expose enough to install (verified live):

- CNR pack: `id` = cnr_id, `version` = semver, `files` = `[git url]`.
- Git-only pack: no `id`, `version` = `"unknown"`, `files` = `[git url]`.

Plan:

1. **`resolveInstallTarget(packKey)`** — fetch
   `/customnode/getlist?mode=local&skip_update=true`, index `not-installed`
   entries by every identifier (key, `id`, `files`, `repository`) with the same
   normalize used in `classifyUnresolved` (lowercase, strip trailing `/`,
   `.git`), and return the matching entry (or null).
2. **`installPayload(entry)`** — mirror Manager's installNodes:
   `{ id: entry.id || <key>, version: entry.version, files: entry.files,
   channel:"default", mode:"cache", selected_version: entry.version==="unknown"
   ? "unknown" : "latest", skip_post_install:false, ui_id:<key> }`.
3. Install via the existing `runManagerEnable(payload)` (same queue endpoint).
4. **`findInstalledDir(entry)`** — re-fetch getlist; find the now-installed entry
   matching `entry` by id/files/repo; its **key is the directory name** (needed
   to key the trial). Fallback: repo basename of `files[0]` (strip `.git`).
5. For Install 7d: `POST /nodes-stats/trials/start { package: <dir name> }`.
6. Show the restart banner: "Installed X — restart to load it" (+ " for a 7-day
   trial").

## Components (all in `js/nodes_stats.js`)

- `resolveInstallTarget(packKey)`, `installPayload(entry)`, `findInstalledDir(entry)`
  — small, mostly-pure helpers.
- `handleTrialInstall(pkg, dialog, temporary)` — orchestrates resolve → install →
  dir discovery → (trial start if temporary) → restart banner; on any failure
  falls back to the existing open-Manager behavior of `handleInstall`.
- Missing rows render `[Install 7d]` + `[Install]`; wire them in
  `wireWorkflowButtons`. Reuse `setWorkflowButtonsBusy`, `notify`,
  `showRestartBanner`, `managerIsBusy`.

## Data flow

```
Workflow tab (missing row)
  Install 7d -> resolveInstallTarget(packKey) -> installPayload
             -> runManagerEnable (POST install, start, wait)
             -> findInstalledDir -> trials/start{dir}
             -> restart banner "installed for 7-day trial"
  Install    -> same, minus trials/start
later boots  -> tracker.tick_boot_days (distinct days)
use in prompt-> tracker.reset_trials_for (counter -> 0)
expiry       -> processExpiredTrials (UI load) -> Manager disable + stopTrial
```

## Error handling

- ComfyUI Manager absent → Missing actions inert (as today).
- `resolveInstallTarget` miss, install HTTP error, or git-url install blocked by
  Manager security level → toast + fall back to `handleInstall`'s open-Manager
  guidance. No crash.
- `findInstalledDir` returns nothing (install didn't land) → don't register a
  trial; toast "installed; couldn't register trial — enable/disable manually".
- `managerIsBusy()` → ask the user to retry (same guard as enable/disable).

## Testing

- Backend unchanged → no new pytest; existing `tests/` stays green.
- Pure helpers (`resolveInstallTarget` matching, `installPayload`,
  `findInstalledDir` matching) written standalone; `node --check` for syntax.
- Manual: load a workflow needing a not-installed CNR pack → Install 7d installs
  it, `/nodes-stats/trials` shows the resulting dir, restart banner appears;
  Install (permanent) installs without a trial row; a git-url-only/blocked pack
  falls back to opening Manager; Manager-absent path inert.

## Files touched

- `js/nodes_stats.js` — resolution helpers, `handleTrialInstall`, Missing-row
  buttons + wiring.
- `README.md`, `pyproject.toml` — docs + version bump (1.6.0 → 1.7.0).

## Out of scope (YAGNI)

- Auto-uninstall on expiry (chose disable; reversible + free).
- Bulk "install all missing 7d" (start per-row; revisit if wanted).
- Replicating Manager's full dependency/security UX (fall back to Manager).
