# Disabled-Node Mirror Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a standalone "mirror search" palette (toolbar button + hotkey) that searches nodes belonging to currently-disabled custom-node packages and offers Enable 7d / Enable on each result, reusing the trial-enable code.

**Architecture:** Frontend-only, all in `js/nodes_stats.js`. Build an in-memory catalog by joining ComfyUI Manager's `getmappings` (repo-URL → class_type names, registry-wide) with `getlist` (packs whose `state === 'disabled'`), cached per session. A separate modal palette filters the catalog live. Enable actions reuse a shared `enablePackage()` core (extracted from the existing `handleEnable`). No backend changes.

**Tech Stack:** Vanilla JS (ComfyUI frontend extension via `app.registerExtension`), ComfyUI Manager HTTP endpoints, the trial-enable feature already in this file.

**Design doc:** `docs/plans/2026-06-21-mirror-search-design.md`

**Testing note:** No JS test harness exists. "Verify" steps use `node --check` for syntax and explicit browser-console / in-app checks. Pure helpers are written standalone so they can be exercised from the console. After every JS edit run:
`cp js/nodes_stats.js /tmp/c.mjs && node --check /tmp/c.mjs && echo OK && rm /tmp/c.mjs`

Reuse points already in `js/nodes_stats.js` (confirmed): `fetchManagerInfo()` (getlist → `{dir:{id,version,files,state}}`), `enablePayload()`, `runManagerEnable()`, `managerIsBusy()`, `handleEnable()`, `notify()`, `escapeHtml()`, `escapeAttr()`, `showRestartBanner()`, the toolbar-button mount in `setup()`.

---

### Task 1: Extract shared `enablePackage()` core (refactor, no behavior change)

**Why:** `handleEnable` is hard-wired to the Workflow tab's `_lastWorkflowScan` and `dialog`. The palette needs the same enable logic without that coupling. Extract the Manager-enable + trial-route + toast into `enablePackage(pkg, info, temporary)`; keep `handleEnable` as the Workflow-tab wrapper.

**Files:** Modify `js/nodes_stats.js` (around lines 717–746).

**Step 1: Add the shared core** immediately above `handleEnable`:

```js
// Shared enable core used by the Workflow tab and the mirror search palette.
// Performs the Manager enable + trial bookkeeping + success toast.
// Returns true on success, false if Manager was busy. Throws on failure.
// Caller owns its own busy UI and restart affordance.
async function enablePackage(pkg, info, temporary) {
  if (!info) throw new Error("no enable info for " + pkg);
  if (await managerIsBusy()) {
    notify("ComfyUI Manager is busy. Please try again in a moment.", "warn");
    return false;
  }
  await runManagerEnable(enablePayload(pkg, info));
  const route = temporary ? "/nodes-stats/trials/start" : "/nodes-stats/trials/stop";
  await fetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package: pkg }),
  });
  notify(`Enabled ${pkg}${temporary ? " for a 7-day trial" : ""}. Restart ComfyUI to apply.`, "success");
  return true;
}
```

**Step 2: Replace the body of `handleEnable`** to delegate:

```js
async function handleEnable(pkg, temporary, dialog) {
  const entry = _lastWorkflowScan.disabled.find((d) => d.pkg === pkg);
  const info = entry && entry.info;
  if (!info) return;
  setWorkflowButtonsBusy(dialog, true);
  try {
    if (await enablePackage(pkg, info, temporary)) {
      entry.info.state = "enabled";
      showRestartBanner(dialog);
    }
  } catch (e) {
    notify("Failed to enable: " + e.message, "error");
  } finally {
    setWorkflowButtonsBusy(dialog, false);
  }
}
```

**Step 3: Verify syntax** — run the `node --check` line above. Expected: `OK`.

**Step 4: Verify no behavior change (manual)** — hard-refresh ComfyUI, load a workflow with a disabled node, click Enable 7d in the Workflow tab → still enables + restart banner + `/nodes-stats/trials` shows it. (If you don't want to mutate state, just confirm the buttons still render and the console shows no errors on open.)

**Step 5: Commit**

```bash
git add js/nodes_stats.js
git commit -m "refactor: extract enablePackage core from handleEnable"
```

---

### Task 2: Catalog build — URL normalize + join + cache

**Files:** Modify `js/nodes_stats.js` (add near `fetchManagerInfo`).

**Step 1: Add pure helpers + cached loader:**

```js
// Normalize a repo URL for joining getmappings keys to getlist pack files.
function normalizeRepoUrl(url) {
  return String(url || "").trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
}

// Join Manager's node->pack mappings with the disabled packs from getlist.
// mappings: { <repoUrl>: [ [class_type,...], {title_aux} ] }  (from getmappings)
// managerInfo: { <dir>: {id,version,files,state,title?} }       (from fetchManagerInfo)
// Returns [{ class_type, pack, title, info }] for disabled packs only.
function buildDisabledCatalog(mappings, managerInfo) {
  const byUrl = {};
  for (const [url, entry] of Object.entries(mappings || {})) {
    const list = entry && entry[0];
    if (Array.isArray(list)) byUrl[normalizeRepoUrl(url)] = list;
  }
  const catalog = [];
  for (const [dir, info] of Object.entries(managerInfo || {})) {
    if (!info || info.state !== "disabled") continue;
    const urls = (info.files && info.files.length ? info.files : [info.repository]).filter(Boolean);
    let nodes = null;
    for (const u of urls) {
      const hit = byUrl[normalizeRepoUrl(u)];
      if (hit) { nodes = hit; break; }
    }
    if (!nodes) { console.debug("[Node Stats] no node map for disabled pack", dir); continue; }
    const title = info.title || dir;
    for (const ct of nodes) catalog.push({ class_type: ct, pack: dir, title, info });
  }
  return catalog;
}

let _disabledCatalog = null;   // cached for the session
async function ensureDisabledCatalog(forceRefresh = false) {
  if (_disabledCatalog && !forceRefresh) return _disabledCatalog;
  const managerInfo = await fetchManagerInfo();
  if (!managerInfo) return null;           // Manager absent
  let mappings = {};
  try {
    const r = await fetch("/customnode/getmappings?mode=local");
    if (r.ok) mappings = await r.json();
  } catch { /* fall through -> empty catalog */ }
  _disabledCatalog = buildDisabledCatalog(mappings, managerInfo);
  return _disabledCatalog;
}
```

**Step 2: Verify syntax** — `node --check` line. Expected `OK`.

**Step 3: Verify the join (browser console)** — hard-refresh ComfyUI, open devtools console:

```js
// paste: pull the two sources and join, then sanity-check
const mi = await (await fetch("/customnode/getlist?mode=local&skip_update=true")).json();
const mp = await (await fetch("/customnode/getmappings?mode=local")).json();
```
Then confirm in the app once Task 4 wires it; for now just confirm `getmappings` returns an object and `getlist.node_packs` has `state:'disabled'` entries. Expected: yes (≈73 disabled packs in this install).

**Step 4: Commit**

```bash
git add js/nodes_stats.js
git commit -m "feat(search): build disabled-node catalog from getmappings x getlist"
```

---

### Task 3: Search filter (pure)

**Files:** Modify `js/nodes_stats.js`.

**Step 1: Add ranking + filter:**

```js
// Rank a catalog entry against a lowercased query. Lower = better; null = no match.
// class_type prefix (0) < class_type word-start (1) < class_type substring (2)
// < pack-name match (3). No match -> null.
function scoreEntry(entry, q) {
  const name = entry.class_type.toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.split(/[\s_\-./]/).some((w) => w.startsWith(q))) return 1;
  if (name.includes(q)) return 2;
  if (entry.pack.toLowerCase().includes(q)) return 3;
  return null;
}

// Filter + rank a catalog. Returns { rows, total } where rows is capped at limit.
function filterCatalog(catalog, query, limit = 50) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { rows: [], total: 0 };
  const scored = [];
  for (const e of catalog) {
    const s = scoreEntry(e, q);
    if (s !== null) scored.push([s, e]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].class_type.localeCompare(b[1].class_type));
  return { rows: scored.slice(0, limit).map((x) => x[1]), total: scored.length };
}
```

**Step 2: Verify syntax** — `node --check`. Expected `OK`.

**Step 3: Verify logic (browser console, after Task 4 exposes catalog, or inline)** — confirm e.g. `filterCatalog([{class_type:"MaskComposite",pack:"masquerade"}], "mask").total === 1` and `scoreEntry({class_type:"MaskComposite",pack:"x"}, "mask") === 0`.

**Step 4: Commit**

```bash
git add js/nodes_stats.js
git commit -m "feat(search): catalog ranking + filter helpers"
```

---

### Task 4: Mirror search palette UI

**Files:** Modify `js/nodes_stats.js`.

**Step 1: Add the palette open/render:**

```js
async function openMirrorSearch() {
  const existing = document.getElementById("nodes-stats-mirror");
  if (existing) { existing.querySelector("#ns-mirror-input")?.focus(); return; }

  const overlay = document.createElement("div");
  overlay.id = "nodes-stats-mirror";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:flex-start;justify-content:center;";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") overlay.remove(); });

  const box = document.createElement("div");
  box.style.cssText =
    "margin-top:10vh;background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:8px;width:90%;max-width:640px;max-height:70vh;display:flex;flex-direction:column;font-family:monospace;font-size:13px;overflow:hidden;";
  box.innerHTML = `
    <style>
      #nodes-stats-mirror .ns-btn{font-family:monospace;font-size:11px;border:1px solid #555;background:#262626;color:#ddd;border-radius:4px;padding:3px 10px;cursor:pointer;white-space:nowrap;}
      #nodes-stats-mirror .ns-btn:hover:not(:disabled){background:#203a20;border-color:#4a4;color:#fff;}
      #nodes-stats-mirror .ns-btn:disabled{opacity:0.5;cursor:default;}
      #nodes-stats-mirror .ns-mrow:hover{background:#262626;}
    </style>
    <div style="padding:12px;border-bottom:1px solid #333;display:flex;gap:8px;align-items:center;">
      <input id="ns-mirror-input" placeholder="search disabled-pack nodes…" autocomplete="off"
        style="flex:1;background:#111;border:1px solid #444;border-radius:4px;color:#fff;padding:8px 10px;font-family:monospace;font-size:14px;outline:none;">
      <button id="ns-mirror-refresh" class="ns-btn" title="Rebuild catalog">↻</button>
    </div>
    <div id="ns-mirror-results" style="overflow-y:auto;padding:6px 0;"></div>
    <div id="ns-mirror-footer" style="padding:8px 12px;border-top:1px solid #333;color:#666;font-size:11px;"></div>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const input = box.querySelector("#ns-mirror-input");
  const results = box.querySelector("#ns-mirror-results");
  const footer = box.querySelector("#ns-mirror-footer");

  footer.textContent = "loading disabled-node catalog…";
  let catalog = await ensureDisabledCatalog();
  if (catalog === null) { footer.textContent = "ComfyUI Manager not available."; return; }
  if (catalog.length === 0) { footer.textContent = "No disabled packages — nothing to search."; return; }
  const packCount = new Set(catalog.map((e) => e.pack)).size;
  footer.textContent = `${catalog.length} nodes across ${packCount} disabled packs · enabling needs a restart`;

  function render() {
    const { rows, total } = filterCatalog(catalog, input.value);
    if (!input.value.trim()) {
      results.innerHTML = `<div style="padding:14px;color:#666;">Type to search ${catalog.length} nodes in ${packCount} disabled packs.</div>`;
      return;
    }
    if (total === 0) { results.innerHTML = `<div style="padding:14px;color:#666;">No disabled nodes match “${escapeHtml(input.value)}”.</div>`; return; }
    let html = "";
    for (const e of rows) {
      html += `<div class="ns-mrow" style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid #222;">
        <div style="flex:1;min-width:0;">
          <div style="color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(e.class_type)}</div>
          <div style="color:#888;font-size:11px;">${escapeHtml(e.pack)}</div>
        </div>
        <button class="ns-btn ns-mirror-temp" data-pkg="${escapeAttr(e.pack)}">Enable 7d</button>
        <button class="ns-btn ns-mirror-perm" data-pkg="${escapeAttr(e.pack)}">Enable</button>
      </div>`;
    }
    if (total > rows.length) html += `<div style="padding:8px 12px;color:#666;">+${total - rows.length} more — refine your search.</div>`;
    results.innerHTML = html;
    results.querySelectorAll(".ns-mirror-temp").forEach((b) =>
      b.addEventListener("click", () => mirrorEnable(b.dataset.pkg, true, overlay)));
    results.querySelectorAll(".ns-mirror-perm").forEach((b) =>
      b.addEventListener("click", () => mirrorEnable(b.dataset.pkg, false, overlay)));
  }

  input.addEventListener("input", render);
  box.querySelector("#ns-mirror-refresh").addEventListener("click", async () => {
    footer.textContent = "refreshing…";
    catalog = await ensureDisabledCatalog(true) || [];
    footer.textContent = `${catalog.length} nodes across ${new Set(catalog.map((e)=>e.pack)).size} disabled packs · enabling needs a restart`;
    render();
  });
  render();
  input.focus();
}

// Enable from the palette. Marks all rows for the pack as enabled on success.
async function mirrorEnable(pkg, temporary, overlay) {
  const entry = (_disabledCatalog || []).find((e) => e.pack === pkg);
  const info = entry && entry.info;
  if (!info) return;
  overlay.querySelectorAll(".ns-btn").forEach((b) => (b.disabled = true));
  try {
    if (await enablePackage(pkg, info, temporary)) {
      (_disabledCatalog || []).forEach((e) => { if (e.pack === pkg) e.info.state = "enabled"; });
      overlay.querySelectorAll(`.ns-mirror-temp[data-pkg="${cssEscape(pkg)}"], .ns-mirror-perm[data-pkg="${cssEscape(pkg)}"]`)
        .forEach((b) => { b.replaceWith(Object.assign(document.createElement("span"), { textContent: "✓ enabled · restart", style: "color:#6a6;font-size:11px;" })); });
    }
  } catch (e) {
    notify("Failed to enable: " + e.message, "error");
  } finally {
    overlay.querySelectorAll(".ns-btn").forEach((b) => (b.disabled = false));
  }
}
```

> If `cssEscape` does not already exist in the file, add the small helper used elsewhere: `function cssEscape(s){return window.CSS&&CSS.escape?CSS.escape(s):String(s).replace(/["\\]/g,"\\$&");}` (check first — the disable feature may already define it).

**Step 2: Verify syntax** — `node --check`. Expected `OK`.

**Step 3: Verify (manual)** — temporarily call `openMirrorSearch()` from the console after hard-refresh. Search a known disabled pack node (e.g. an Inspire-Pack class_type). Expected: results list; clicking Enable 7d enables the pack (verify via `/nodes-stats/trials` and getlist state flip), rows turn into "✓ enabled · restart".

**Step 4: Commit**

```bash
git add js/nodes_stats.js
git commit -m "feat(search): mirror search palette UI + enable actions"
```

---

### Task 5: Toolbar button + keyboard shortcut

**Files:** Modify `js/nodes_stats.js` — inside the existing `setup()` (where the Node Stats button is mounted).

**Step 1: Add a second toolbar button** after the existing Node Stats button mount:

```js
    const searchBtn = document.createElement("button");
    searchBtn.textContent = "⌕";
    searchBtn.title = "Search disabled-pack nodes (Ctrl/Cmd+Shift+D)";
    searchBtn.className = "comfyui-button comfyui-menu-mobile-collapse";
    searchBtn.style.cssText = "display:flex;align-items:center;justify-content:center;padding:6px;cursor:pointer;font-size:16px;";
    searchBtn.onclick = () => openMirrorSearch();
    if (app.menu?.settingsGroup?.element) app.menu.settingsGroup.element.before(searchBtn);
    else document.querySelector(".comfy-menu")?.append(searchBtn);
```

**Step 2: Register the hotkey** (guarded `keydown`, ignores typing contexts) at the end of `setup()`:

```js
    window.addEventListener("keydown", (e) => {
      if (!(e.shiftKey && (e.ctrlKey || e.metaKey) && (e.key === "D" || e.key === "d"))) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      openMirrorSearch();
    });
```

> If `Ctrl/Cmd+Shift+D` conflicts with a ComfyUI binding in this build, change the key here (e.g. to `K`) and update both titles.

**Step 3: Verify syntax** — `node --check`. Expected `OK`.

**Step 4: Verify (manual)** — hard-refresh ComfyUI; the ⌕ button appears in the top menu; clicking it and pressing Ctrl/Cmd+Shift+D both open the palette; Esc / click-outside closes it.

**Step 5: Commit**

```bash
git add js/nodes_stats.js
git commit -m "feat(search): toolbar button + hotkey to open mirror search"
```

---

### Task 6: Docs + version bump

**Files:** Modify `README.md`, `pyproject.toml`.

**Step 1:** Add a "Mirror search (disabled-pack nodes)" subsection to the README: what it does, how to open it (⌕ button / Ctrl/Cmd+Shift+D), that results come from disabled packs, that Enable 7d/Enable take effect after restart, and that it's inert without ComfyUI Manager. Add a feature bullet.

**Step 2:** Bump `version` in `pyproject.toml` to `1.4.0`.

**Step 3: Verify** — `python -m pytest -q` (unchanged, still green) and the `node --check` line (`OK`).

**Step 4: Commit**

```bash
git add README.md pyproject.toml
git commit -m "docs: document mirror search; bump to 1.4.0"
```

---

## Done criteria

- ⌕ button + Ctrl/Cmd+Shift+D open a palette that searches nodes of disabled packs (joined from getmappings × getlist), cached per session with a refresh.
- Typing filters instantly (ranked); results show `class_type` + pack with Enable 7d / Enable.
- Enabling reuses `enablePackage` → Manager enable + trial start/stop + "restart to apply" toast; rows mark "✓ enabled · restart".
- Workflow-tab enable still works (shared core, no regression).
- Inert + clear message when ComfyUI Manager is absent or there are no disabled packs.
- `python -m pytest -q` green; `node --check` clean.
