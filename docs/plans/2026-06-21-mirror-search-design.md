# Design: Mirror search for disabled-pack nodes

Date: 2026-06-21
Status: Approved

## Summary

A standalone "mirror search" palette that lets you find nodes belonging to
currently-**disabled** custom-node packages — without loading those packages
(which slows ComfyUI boot/runtime). Each result has Enable buttons; enabling
re-enables the owning package (temporarily or permanently) and takes effect
after a ComfyUI restart, after which the node appears in ComfyUI's native search.

This runs *alongside* ComfyUI's native node search rather than inside it:
ComfyUI's frontend is compiled/bundled and exposes no search-provider or
node-def injection hook, so the native search cannot be extended. A separate
palette is the only viable design (and matches the request — a "mirror" search).

## Constraints discovered (reconnaissance)

- Native search injection is **not feasible**: bundled frontend, no public hook
  (`app.registerExtension` offers `nodeCreated`/`beforeRegisterNodeDef` only),
  and disabled packs never enter `NODE_CLASS_MAPPINGS` / `/object_info`.
- `/customnode/getmappings?mode=local` returns a registry-wide map keyed by repo
  URL: `{ <repo_url>: [ [class_type, ...], { title_aux } ] }`. It **does**
  include the class_type names for every pack, including disabled ones.
- `/customnode/getlist?mode=local&skip_update=true` lists packs with `state`
  (`disabled`/`enabled`/`not-installed`), `id`, `version`, `files`,
  `repository`. There are 73 disabled packs in the reference install.
- Available metadata for an unloaded node: **class_type name + pack name/title
  only**. No categories, descriptions, or input/output ports (those require the
  pack to be loaded).

## Decisions (from brainstorming)

- **Trigger:** dedicated palette opened by a toolbar button + a keyboard
  shortcut. Not a tab in the Node Stats dialog.
- **Enable actions:** both "Enable 7d" (rolling trial) and "Enable" (permanent),
  reusing the trial-enable feature. Takes effect after restart.
- **Catalog construction:** frontend-only. Fetch getmappings + getlist on first
  open, join by repo URL, cache in memory for the session, with a refresh
  affordance. No backend changes.
- **Scope:** disabled packs only (not the full not-installed registry — that's
  Manager's job).

## Architecture

All in `js/nodes_stats.js`; no backend changes.

### Catalog
- `ensureDisabledCatalog()` (cached in a module variable):
  1. `fetchManagerInfo()` (existing; getlist) → packs with `state === 'disabled'`.
  2. `fetch('/customnode/getmappings?mode=local')` → build `repoUrl -> [class_types]`.
  3. Normalize URLs (lowercase, strip trailing `/` and `.git`) on both sides.
  4. For each disabled pack, look up class_types by its `files[0]`/`repository`;
     emit `{ class_type, pack: <dir name>, title, enableInfo }` per node.
- A `refresh()` clears the cache and rebuilds.

### Search/filter (pure functions, for clarity + manual testability)
- `scoreEntry(entry, queryLower)` → null if no match; else a rank where
  class_type prefix < word-start < substring, pack-name match ranked lower.
- `filterCatalog(catalog, query, limit=50)` → sorted, capped list + total count.

### Palette UI
- `openMirrorSearch()`: ensure catalog; render a modal overlay (reusing the
  dialog styling helpers) with a text input (autofocused) and a results list.
- Input `keyup` → re-render rows via `filterCatalog`.
- Row: `class_type` · `(pack)` · `[Enable 7d]` `[Enable]`.
- Footer: "<shown>/<total> from <N> disabled packs · enabling needs a restart" +
  "↻ refresh".
- Empty/error/inert states handled explicitly.

### Trigger
- Toolbar button (like the existing Node Stats button), title "Search disabled
  nodes".
- Keyboard shortcut: prefer ComfyUI's extension command/keybinding API if
  available; else a guarded `document` `keydown` listener (default
  `Ctrl/Cmd+Shift+D`), ignored when focus is in an input/textarea.

### Actions
- Reuse `handleEnable(pkg, temporary)` from the trial-enable feature:
  - `[Enable 7d]` → `temporary=true` (Manager enable → `trials/start`).
  - `[Enable]` → `temporary=false` (Manager enable → `trials/stop`).
- Reuse the restart banner / toast. After enable, mark the row "enabled ·
  restart".

## Data flow

```
setup() -> add toolbar button + register hotkey
trigger -> openMirrorSearch()
        -> ensureDisabledCatalog()  (1st time: getmappings + getlist, join, cache)
        -> render modal (input + results)
type    -> filterCatalog() -> render rows (instant, in-memory)
Enable  -> handleEnable(pkg, temp?) -> Manager enable -> trials/start|stop
        -> restart banner/toast
refresh -> clear cache -> ensureDisabledCatalog() -> re-render
```

## Error handling

- ComfyUI Manager absent or getlist/getmappings fails → palette shows a clear
  message ("ComfyUI Manager not available" / "couldn't load disabled-node
  list"); the button stays but the palette is inert. No crash.
- Zero disabled packs → "No disabled packages — nothing to search."
- Enable failure → existing error toast; row left actionable.
- URL-join misses for a pack → that pack contributes no rows (logged to
  console); never throws.

## Testing

- No backend changes → no new pytest.
- Pure helpers (`scoreEntry`, `filterCatalog`, URL normalization, catalog join)
  written as small standalone functions; `node --check` for syntax.
- Manual verification: open palette via button + hotkey; search a known disabled
  pack's node (e.g. an Inspire-Pack node); Enable 7d → getlist flips to enabled
  + `/nodes-stats/trials` shows it + restart banner; Enable (permanent) → enabled,
  no trial row; refresh rebuilds; Manager-absent path shows the inert message.

## Files touched

- `js/nodes_stats.js` — catalog, filter, palette UI, trigger, reuse enable.
- `README.md`, `pyproject.toml` — docs + version bump.

## Out of scope (YAGNI)

- Injecting results into ComfyUI's native search (not feasible).
- Rich node metadata (titles/categories/ports) for unloaded nodes (unavailable).
- Auto-placing the node into the graph after restart.
- Searching not-installed registry packs (Manager already does this).
