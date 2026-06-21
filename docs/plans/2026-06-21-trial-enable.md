# Workflow Tab + Temporary Trial-Enable Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Node Stats "Workflow" tab that splits a loaded workflow's unresolved nodes into Missing (defer to ComfyUI Manager) and Disabled (re-enable temporarily under a 7 distinct-boot-day rolling trial, or permanently), auto-disabling unused trial packages.

**Architecture:** Approach A — the Python backend only tracks trial state in SQLite, counts boot-days (once per `__init__` import), resets a per-package counter when the existing usage tracker sees the package executed, and exposes trial state via three routes. The frontend (JS) detects unresolved graph nodes, classifies them via ComfyUI Manager's `getmappings`/`getlist`, renders the tab, and performs all Manager enable/disable mutations (reusing the existing disable code). The backend never calls Manager.

**Tech Stack:** Python 3.12 (stdlib `sqlite3`), aiohttp routes (ComfyUI `PromptServer`), vanilla JS (ComfyUI frontend extension), pytest.

**Design doc:** `docs/plans/2026-06-21-trial-enable-design.md`

**Reference for date-mocking in tests:** existing `tests/test_model_tracker.py` patches `tracker.datetime`.

---

## Phase 1 — Backend trial state (pure logic, TDD)

All Phase 1 tasks edit `tracker.py` and `tests/test_trials.py`. Run tests with the project's `python -m pytest`.

### Task 1: Trial table + `start_trial` / `get_trials`

**Files:**
- Modify: `tracker.py` (add to `SCHEMA`, add `DEFAULT_TRIAL_BUDGET`, methods)
- Create: `tests/test_trials.py`

**Step 1: Write the failing test**

```python
# tests/test_trials.py
import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
from tracker import UsageTracker, DEFAULT_TRIAL_BUDGET


@pytest.fixture
def tracker(tmp_path):
    return UsageTracker(db_path=str(tmp_path / "test.db"))


def test_start_trial_initializes(tracker):
    tracker.start_trial("Some-Pack")
    trials = tracker.get_trials()
    assert len(trials) == 1
    t = trials[0]
    assert t["package"] == "Some-Pack"
    assert t["unused_boot_days"] == 0
    assert t["budget"] == DEFAULT_TRIAL_BUDGET
    assert t["days_remaining"] == DEFAULT_TRIAL_BUDGET
    assert t["expired"] is False


def test_start_trial_is_idempotent_resets(tracker):
    tracker.start_trial("Some-Pack")
    tracker.start_trial("Some-Pack")
    assert len(tracker.get_trials()) == 1
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_trials.py -v`
Expected: FAIL (cannot import `DEFAULT_TRIAL_BUDGET` / no `start_trial`).

**Step 3: Write minimal implementation**

In `tracker.py`, after the `SCHEMA` string add a table (append inside the existing `SCHEMA` triple-quoted block, before the closing `"""`):

```sql
CREATE TABLE IF NOT EXISTS trial_packages (
    package TEXT PRIMARY KEY,
    enabled_at TEXT NOT NULL,
    last_use_day TEXT NOT NULL,
    last_boot_day TEXT NOT NULL,
    unused_boot_days INTEGER NOT NULL DEFAULT 0,
    budget INTEGER NOT NULL DEFAULT 7
);
```

Add a module constant near `EXCLUDED_PACKAGES`:

```python
DEFAULT_TRIAL_BUDGET = 7
```

Add methods to `UsageTracker`:

```python
def start_trial(self, package, budget=DEFAULT_TRIAL_BUDGET):
    """Begin/restart a temporary-enable trial. The enable day is not counted."""
    now = datetime.now(timezone.utc)
    today = now.date().isoformat()
    with self._lock:
        self._ensure_db()
        conn = self._connect()
        try:
            conn.execute(
                """INSERT INTO trial_packages
                   (package, enabled_at, last_use_day, last_boot_day, unused_boot_days, budget)
                   VALUES (?, ?, ?, ?, 0, ?)
                   ON CONFLICT(package) DO UPDATE SET
                       enabled_at = excluded.enabled_at,
                       last_use_day = excluded.last_use_day,
                       last_boot_day = excluded.last_boot_day,
                       unused_boot_days = 0,
                       budget = excluded.budget""",
                (package, now.isoformat(), today, today, budget),
            )
            conn.commit()
        finally:
            conn.close()

def get_trials(self):
    """Return trial rows with computed days_remaining/expired."""
    with self._lock:
        self._ensure_db()
        conn = self._connect()
        try:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT package, enabled_at, last_use_day, last_boot_day, "
                "unused_boot_days, budget FROM trial_packages"
            ).fetchall()
        finally:
            conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["days_remaining"] = max(0, d["budget"] - d["unused_boot_days"])
        d["expired"] = d["unused_boot_days"] >= d["budget"]
        result.append(d)
    return result
```

**Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_trials.py -v`
Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add tracker.py tests/test_trials.py
git commit -m "feat(trials): add trial_packages table, start_trial, get_trials"
```

---

### Task 2: `tick_boot_days` (distinct-day counting)

**Files:**
- Modify: `tracker.py`
- Test: `tests/test_trials.py`

**Step 1: Write the failing test**

```python
def _ahead(days):
    return datetime.now(timezone.utc) + timedelta(days=days)


def test_tick_increments_only_on_new_day(tracker):
    tracker.start_trial("Pack")          # enable day, counter 0
    tracker.tick_boot_days()             # same day -> no change
    assert tracker.get_trials()[0]["unused_boot_days"] == 0

    with patch("tracker.datetime") as m:
        m.now.return_value = _ahead(1)
        tracker.tick_boot_days()         # new day -> 1
        tracker.tick_boot_days()         # same (mocked) day -> still 1
    assert tracker.get_trials()[0]["unused_boot_days"] == 1


def test_tick_reaches_expiry(tracker):
    tracker.start_trial("Pack")
    for d in range(1, DEFAULT_TRIAL_BUDGET + 1):
        with patch("tracker.datetime") as m:
            m.now.return_value = _ahead(d)
            tracker.tick_boot_days()
    t = tracker.get_trials()[0]
    assert t["unused_boot_days"] == DEFAULT_TRIAL_BUDGET
    assert t["expired"] is True
    assert t["days_remaining"] == 0
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_trials.py -k tick -v`
Expected: FAIL (no `tick_boot_days`).

**Step 3: Write minimal implementation**

```python
def tick_boot_days(self):
    """Once per distinct calendar day, age every active trial by one boot-day."""
    today = datetime.now(timezone.utc).date().isoformat()
    with self._lock:
        self._ensure_db()
        conn = self._connect()
        try:
            conn.execute(
                """UPDATE trial_packages
                   SET unused_boot_days = unused_boot_days + 1,
                       last_boot_day = ?
                   WHERE last_boot_day != ?""",
                (today, today),
            )
            conn.commit()
        finally:
            conn.close()
```

**Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_trials.py -k tick -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add tracker.py tests/test_trials.py
git commit -m "feat(trials): tick_boot_days counts distinct boot-days"
```

---

### Task 3: `reset_trials_for` (usage resets counter)

**Files:**
- Modify: `tracker.py`
- Test: `tests/test_trials.py`

**Step 1: Write the failing test**

```python
def test_reset_zeroes_counter(tracker):
    tracker.start_trial("Pack")
    with patch("tracker.datetime") as m:
        m.now.return_value = _ahead(1)
        tracker.tick_boot_days()
    assert tracker.get_trials()[0]["unused_boot_days"] == 1
    tracker.reset_trials_for({"Pack", "Not-On-Trial"})
    assert tracker.get_trials()[0]["unused_boot_days"] == 0


def test_reset_empty_is_noop(tracker):
    tracker.start_trial("Pack")
    tracker.reset_trials_for(set())
    assert tracker.get_trials()[0]["unused_boot_days"] == 0
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_trials.py -k reset -v`
Expected: FAIL (no `reset_trials_for`).

**Step 3: Write minimal implementation**

```python
def reset_trials_for(self, packages):
    """Reset the unused-day counter for any of these packages that are on trial."""
    if not packages:
        return
    today = datetime.now(timezone.utc).date().isoformat()
    with self._lock:
        self._ensure_db()
        conn = self._connect()
        try:
            conn.executemany(
                """UPDATE trial_packages
                   SET unused_boot_days = 0, last_use_day = ?
                   WHERE package = ?""",
                [(today, p) for p in packages],
            )
            conn.commit()
        finally:
            conn.close()
```

**Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_trials.py -k reset -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add tracker.py tests/test_trials.py
git commit -m "feat(trials): reset_trials_for zeroes counter on use"
```

---

### Task 4: `stop_trial` + extend `reset()`

**Files:**
- Modify: `tracker.py` (add `stop_trial`; add `DELETE FROM trial_packages` to `reset`)
- Test: `tests/test_trials.py`

**Step 1: Write the failing test**

```python
def test_stop_trial_removes_row(tracker):
    tracker.start_trial("Pack")
    tracker.stop_trial("Pack")
    assert tracker.get_trials() == []


def test_reset_clears_trials(tracker):
    tracker.start_trial("Pack")
    tracker.reset()
    assert tracker.get_trials() == []
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_trials.py -k "stop or clears" -v`
Expected: FAIL (no `stop_trial`; `reset` leaves the row).

**Step 3: Write minimal implementation**

```python
def stop_trial(self, package):
    """End a trial (package became permanent or was disabled)."""
    with self._lock:
        self._ensure_db()
        conn = self._connect()
        try:
            conn.execute("DELETE FROM trial_packages WHERE package = ?", (package,))
            conn.commit()
        finally:
            conn.close()
```

In `reset()`, add alongside the existing deletes:

```python
                conn.execute("DELETE FROM trial_packages")
```

**Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_trials.py -v`
Expected: PASS (all trial tests).

**Step 5: Commit**

```bash
git add tracker.py tests/test_trials.py
git commit -m "feat(trials): stop_trial and clear trials on reset"
```

---

## Phase 2 — Wire backend into the server

### Task 5: Boot tick, usage-reset hook, and routes

**Files:**
- Modify: `__init__.py`

**Step 1: Boot tick at import.** After `model_mapper = ModelMapper()` and before/around the prompt-handler registration, add:

```python
# Age temporary-enable trials once per process start (one "boot").
try:
    tracker.tick_boot_days()
except Exception:
    logger.warning("nodes-stats: error ticking trial boot days", exc_info=True)
```

**Step 2: Reset trials on use.** In `_record_prompt`, after `tracker.record_usage(class_types, mapper)` succeeds, add:

```python
        try:
            packages = {mapper.get_package(ct) for ct in class_types}
            packages.discard("__builtin__")
            packages.discard("__unknown__")
            tracker.reset_trials_for(packages)
        except Exception:
            logger.warning("nodes-stats: error resetting trials", exc_info=True)
```

**Step 3: Add routes.** After the existing `reset_stats` route:

```python
@routes.get("/nodes-stats/trials")
async def get_trials(request):
    try:
        return web.json_response(tracker.get_trials())
    except Exception:
        logger.error("nodes-stats: error getting trials", exc_info=True)
        return web.json_response({"error": "internal error"}, status=500)


@routes.post("/nodes-stats/trials/start")
async def start_trial(request):
    try:
        data = await request.json()
        package = data.get("package")
        if not package:
            return web.json_response({"error": "package required"}, status=400)
        tracker.start_trial(package)
        return web.json_response({"status": "ok"})
    except Exception:
        logger.error("nodes-stats: error starting trial", exc_info=True)
        return web.json_response({"error": "internal error"}, status=500)


@routes.post("/nodes-stats/trials/stop")
async def stop_trial(request):
    try:
        data = await request.json()
        package = data.get("package")
        if not package:
            return web.json_response({"error": "package required"}, status=400)
        tracker.stop_trial(package)
        return web.json_response({"status": "ok"})
    except Exception:
        logger.error("nodes-stats: error stopping trial", exc_info=True)
        return web.json_response({"error": "internal error"}, status=500)
```

**Step 4: Verify import doesn't break.**

Run: `python -c "import ast; ast.parse(open('__init__.py').read()); print('OK')"`
Expected: `OK`. Then `python -m pytest -q` → all green (existing + trial tests).

**Step 5: Commit**

```bash
git add __init__.py
git commit -m "feat(trials): boot tick, usage reset hook, and trial routes"
```

---

## Phase 3 — Verify Manager enable payload (spike)

### Task 6: Empirically confirm the enable payload for a disabled pack

**Why:** the disable bug taught us not to assume Manager's payload shape. Enable goes through `/manager/queue/install` with `skip_post_install=true`.

**Files:** none (investigation; document findings in this plan / a code comment).

**Step 1:** Pick a currently-disabled pack from the live server (port 8189 in this environment; adjust if changed):

Run:
```bash
curl -s "http://127.0.0.1:8189/customnode/getlist?mode=local&skip_update=true" \
 | python3 -c "import sys,json; d=json.load(sys.stdin); [print(k, {x:v.get(x) for x in ('id','version','files','state')}) for k,v in d['node_packs'].items() if v.get('state')=='disabled'][:5]"
```
Expected: rows with `state='disabled'` and their `id`/`version`/`files`.

**Step 2:** Enable one via the install queue mirroring Manager's UI, then verify it flips to `enabled`:

```bash
# Use the id/version/files from Step 1 for ONE pack:
curl -s -XPOST "http://127.0.0.1:8189/manager/queue/reset" -H 'Content-Type: application/json'
curl -s -XPOST "http://127.0.0.1:8189/manager/queue/install" -H 'Content-Type: application/json' \
  -d '{"id":"<ID>","version":"<VERSION>","files":<FILES_JSON>,"channel":"default","mode":"cache","skip_post_install":true,"selected_version":"<VERSION>","ui_id":"<ID>"}'
curl -s -XPOST "http://127.0.0.1:8189/manager/queue/start" -H 'Content-Type: application/json'
# poll status, then re-check getlist state for that pack == 'enabled'
```
Expected: pack state becomes `enabled` (restart still required to load it).

**Step 3:** Record the exact minimal working payload as a comment to reuse in the frontend (`enablePayload`). Likely `{id, version, files?, channel, mode, skip_post_install:true, selected_version, ui_id}`. Note any field that turned out load-bearing.

**Step 4:** (optional) revert the test enable via the disable endpoint so state is unchanged.

**No commit** (investigation only). Carry findings into Task 9.

---

## Phase 4 — Frontend (manual verification; no JS test harness)

All Phase 4 tasks edit `js/nodes_stats.js`. After each, hard-refresh the browser (Ctrl+Shift+R) and verify in ComfyUI. Sanity-check syntax after each edit:
`cp js/nodes_stats.js /tmp/c.mjs && node --check /tmp/c.mjs && rm /tmp/c.mjs`.

### Task 7: Detect unresolved node types on workflow load

**Step 1:** Add a helper that returns the set of node types in the current graph not registered in LiteGraph:

```js
function unresolvedNodeTypes() {
  const types = new Set();
  const nodes = app.graph?._nodes || [];
  for (const n of nodes) {
    const t = n.type;
    if (t && !LiteGraph.registered_node_types[t]) types.add(t);
  }
  return [...types];
}
```

**Step 2:** Hook workflow load by wrapping `app.loadGraphData` in `setup()`:

```js
const origLoad = app.loadGraphData?.bind(app);
if (origLoad) {
  app.loadGraphData = function (...args) {
    const r = origLoad(...args);
    setTimeout(() => onWorkflowLoaded(), 0);  // after graph settles
    return r;
  };
}
```

**Step 3:** Stub `onWorkflowLoaded` to log for now:

```js
async function onWorkflowLoaded() {
  const unresolved = unresolvedNodeTypes();
  if (unresolved.length) console.log("[Node Stats] unresolved:", unresolved);
}
```

**Verify:** load a workflow containing a disabled pack's node → console lists the type(s). **Commit.**

### Task 8: Classify unresolved types into Disabled vs Missing

**Step 1:** Fetch and build the class_type → pack map and pack states. Add:

```js
async function classifyUnresolved(types) {
  if (!types.length) return { disabled: [], missing: [] };
  let mappings = {}, managerInfo = null;
  try {
    const [mResp, gi] = await Promise.all([
      fetch("/customnode/getmappings?mode=local"),
      fetchManagerInfo(),  // existing: getlist -> {dir: {id,version,files,state}}
    ]);
    if (mResp.ok) mappings = await mResp.json();
    managerInfo = gi;
  } catch { /* manager absent */ }

  // class_type -> packKey (getmappings value is [ [class_types...], {meta} ])
  const typeToPack = {};
  for (const [packKey, entry] of Object.entries(mappings)) {
    for (const ct of (entry?.[0] || [])) typeToPack[ct] = packKey;
  }
  // index managerInfo by id/cnr_id/aux_id as well as dir-name key
  const byAnyKey = {};
  if (managerInfo) for (const [dir, info] of Object.entries(managerInfo)) {
    byAnyKey[dir] = info;
    for (const k of [info.id, info.cnr_id, info.aux_id]) if (k) byAnyKey[k] = { ...info, _dir: dir };
  }
  const disabled = [], missing = [];
  for (const ct of types) {
    const packKey = typeToPack[ct];
    const info = packKey ? byAnyKey[packKey] : null;
    if (info && info.state === "disabled") disabled.push({ type: ct, pkg: info._dir || packKey, info });
    else missing.push({ type: ct, pkg: packKey || null });
  }
  return { disabled, missing };
}
```

> Note (from Task 6): confirm `managerInfo` entries actually expose `cnr_id`/`aux_id`; if not, extend `fetchManagerInfo` to keep them so the getmappings key reconciles. `fetchManagerInfo` currently keeps `{id, version, files, state}` — add `cnr_id`/`aux_id` if present in getlist.

**Verify:** in console, call the classifier on `unresolvedNodeTypes()` for a workflow with a disabled pack → it lands in `disabled`. **Commit.**

### Task 9: Workflow tab UI + auto-open

**Step 1:** Add a third tab button `#ns-tab-workflow` next to Nodes/Models in `showStatsDialog`, a `#ns-content-workflow` container, and extend `switchTab` to handle `"workflow"`.

**Step 2:** Build the tab content from a classification result:

```js
function buildWorkflowTabContent({ disabled, missing }, trials) {
  const trialByPkg = Object.fromEntries((trials || []).map(t => [t.package, t]));
  let html = "";
  if (!disabled.length && !missing.length) {
    return `<p style="color:#666;">No missing or disabled nodes in the current workflow.</p>`;
  }
  if (disabled.length) {
    html += sectionHeader("Disabled", "Installed but disabled — re-enable to use", "#e90");
    html += `<table style="width:100%;border-collapse:collapse;margin-bottom:12px;"><tbody>`;
    for (const d of disabled) {
      const t = trialByPkg[d.pkg];
      const note = t ? `<span style="color:#6a6;font-size:11px;">on trial · ${t.days_remaining}d left</span>` : "";
      html += `<tr class="ns-row-consider_removing" style="border-bottom:1px solid #222;">
        <td style="padding:6px 8px;color:#fff;">${escapeHtml(d.type)}</td>
        <td style="padding:6px 8px;color:#888;">${escapeHtml(d.pkg)} ${note}</td>
        <td style="padding:6px 8px;text-align:right;white-space:nowrap;">
          <button class="ns-btn ns-enable-temp-btn" data-pkg="${escapeAttr(d.pkg)}">Enable 7d</button>
          <button class="ns-btn ns-enable-perm-btn" data-pkg="${escapeAttr(d.pkg)}" style="margin-left:6px;">Enable</button>
        </td></tr>`;
    }
    html += `</tbody></table>`;
  }
  if (missing.length) {
    html += sectionHeader("Missing", "Not installed — install via ComfyUI Manager", "#e44");
    html += `<table style="width:100%;border-collapse:collapse;margin-bottom:12px;"><tbody>`;
    for (const m of missing) {
      html += `<tr class="ns-row-safe_to_remove" style="border-bottom:1px solid #222;">
        <td style="padding:6px 8px;color:#fff;">${escapeHtml(m.type)}</td>
        <td style="padding:6px 8px;color:#888;">${m.pkg ? escapeHtml(m.pkg) : "unknown"}</td>
        <td style="padding:6px 8px;text-align:right;">
          ${m.pkg ? `<button class="ns-btn ns-install-btn" data-pkg="${escapeAttr(m.pkg)}">Install</button>` : "&mdash;"}
        </td></tr>`;
    }
    html += `</tbody></table>`;
  }
  return html;
}
```

**Step 3:** Store the latest classification in module scope so `showStatsDialog` can render the tab, and have `onWorkflowLoaded` open the dialog on the Workflow tab when there's ≥1 item:

```js
let _lastWorkflowScan = { disabled: [], missing: [] };
async function onWorkflowLoaded() {
  const types = unresolvedNodeTypes();
  _lastWorkflowScan = await classifyUnresolved(types);
  if (_lastWorkflowScan.disabled.length || _lastWorkflowScan.missing.length) {
    showStatsDialog("workflow");   // showStatsDialog gains an optional initial-tab arg
  }
}
```

**Step 4:** Give `showStatsDialog(initialTab = "nodes")` an optional arg; after building, call `switchTab(initialTab)`; render `buildWorkflowTabContent(_lastWorkflowScan, trials)` where `trials = await fetch('/nodes-stats/trials')`.

**Verify:** load a workflow with a disabled node → dialog auto-opens to Workflow tab listing it. **Commit.**

### Task 10: Enable temporary / permanent actions

**Step 1:** Add `enablePayload(dirName, info)` using the shape confirmed in Task 6, e.g.:

```js
function enablePayload(dirName, info) {
  return {
    id: info.id || dirName, version: info.version, files: info.files,
    channel: "default", mode: "cache", skip_post_install: true,
    selected_version: info.version, ui_id: dirName,
  };
}
```

**Step 2:** Add `runManagerEnable(payload)` mirroring `runManagerDisable` but POSTing to `/manager/queue/install`, then `start`, then `waitForQueue()`.

**Step 3:** Wire the buttons (after the dialog is built, alongside `wireDisableButtons`):

```js
dialog.querySelectorAll(".ns-enable-temp-btn").forEach(b =>
  b.addEventListener("click", e => { e.stopPropagation(); handleEnable(b.dataset.pkg, true, dialog); }));
dialog.querySelectorAll(".ns-enable-perm-btn").forEach(b =>
  b.addEventListener("click", e => { e.stopPropagation(); handleEnable(b.dataset.pkg, false, dialog); }));
```

**Step 4:** Implement `handleEnable`:

```js
async function handleEnable(pkg, temporary, dialog) {
  const info = (_lastWorkflowScan.disabled.find(d => d.pkg === pkg) || {}).info;
  if (!info) return;
  setDisableButtonsBusy(dialog, true);
  try {
    await runManagerEnable(enablePayload(pkg, info));
    if (temporary) await fetch("/nodes-stats/trials/start", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ package: pkg }) });
    else await fetch("/nodes-stats/trials/stop", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ package: pkg }) });
    showRestartBanner(dialog);
    notify(`Enabled ${pkg}${temporary ? " for a 7-day trial" : ""}. Restart ComfyUI to apply.`, "success");
  } catch (e) {
    notify("Failed to enable: " + e.message, "error");
  } finally {
    setDisableButtonsBusy(dialog, false);
  }
}
```

**Verify:** click Enable 7d on a disabled node → pack flips to enabled in getlist, `/nodes-stats/trials` shows it, restart banner appears. Click Enable (permanent) on another → enabled, no trial row. **Commit.**

### Task 11: Missing → install via Manager

**Step 1:** Wire `.ns-install-btn` to install the owning pack via Manager. Resolve the pack's getlist entry (it will be `state:'not-installed'` — fetch a fresh getlist or reuse classification info), then POST `/manager/queue/install` with `selected_version:'latest'`, `skip_post_install:false`, start, wait, restart banner.

```js
async function handleInstall(pkg, dialog) {
  // fetch the not-installed entry's id/version/files from getlist by pkg key
  // POST /manager/queue/install {id, version, files, channel:'default', mode:'cache',
  //   selected_version:'latest', ui_id:pkg}; then start + waitForQueue + restart banner
}
```

> Keep this minimal — "handled by Manager like always." If resolving the install entry proves fiddly, fall back to a button that opens ComfyUI Manager's own Install-Missing UI instead of replicating install. Decide during implementation; document the choice.

**Verify:** click Install on a missing node → Manager installs it (or opens its installer). **Commit.**

### Task 12: Execute expiry on load

**Step 1:** Add `processExpiredTrials()` that fetches `/nodes-stats/trials`, and for each `expired` pack: build a disable payload (reuse `disablePayload` with a fresh `fetchManagerInfo` lookup), `runManagerDisable`, then POST `/nodes-stats/trials/stop`. Collect successes for a single toast.

```js
async function processExpiredTrials() {
  let trials = [];
  try { const r = await fetch("/nodes-stats/trials"); if (r.ok) trials = await r.json(); } catch { return; }
  const expired = trials.filter(t => t.expired);
  if (!expired.length) return;
  const mgr = await fetchManagerInfo();
  if (!mgr) return;
  const done = [];
  for (const t of expired) {
    const info = mgr[t.package];
    if (!info || info.state === "disabled") { await stopTrial(t.package); done.push(t.package); continue; }
    try {
      await runManagerDisable([disablePayload(t.package, info)]);
      await stopTrial(t.package);
      done.push(t.package);
    } catch { /* keep row for next session */ }
  }
  if (done.length) notify(`Auto-disabled ${done.length} unused trial package(s). Restart ComfyUI to apply.`, "info");
}
```

**Step 2:** Call `processExpiredTrials()` once from `setup()` (after a short delay so the app is ready), guarded so it runs only when Manager is present.

**Verify:** with a trial row forced to `unused_boot_days >= budget` (set via DB or repeated tick), reloading ComfyUI auto-disables that pack and clears the trial. **Commit.**

---

## Phase 5 — Docs & version

### Task 13: README + version bump

**Files:** `README.md`, `pyproject.toml`

**Step 1:** Add a "Workflow tab & temporary enable" subsection to the README (what Missing vs Disabled mean, the 7 distinct-boot-day rolling trial, that use resets it, that auto-disable applies on next UI load and needs a restart). Add a feature bullet. Document the three `/nodes-stats/trials*` endpoints in the API table.

**Step 2:** Bump `version` in `pyproject.toml` to `1.3.0`.

**Step 3:** Run `python -m pytest -q` (all green) and JS `node --check`.

**Step 4: Commit**

```bash
git add README.md pyproject.toml
git commit -m "docs: document workflow tab + trial-enable; bump to 1.3.0"
```

---

## Done criteria

- `python -m pytest -q` green (existing + `tests/test_trials.py`).
- Loading a workflow with a disabled node auto-opens the Workflow tab; Enable 7d re-enables + records a trial; Enable makes it permanent.
- A trial package unused for 7 distinct boot-days auto-disables on next UI load; any execution use resets the counter.
- Missing nodes route to ComfyUI Manager.
- Feature is inert when ComfyUI Manager is absent.
