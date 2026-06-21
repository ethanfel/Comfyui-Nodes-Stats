import { app } from "../../scripts/app.js";

// Bar chart with nodes icon
const STATS_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="12" width="4" height="9" rx="1"/>
  <rect x="10" y="7" width="4" height="14" rx="1"/>
  <rect x="17" y="3" width="4" height="18" rx="1"/>
  <circle cx="5" cy="8" r="2" fill="currentColor" stroke="none"/>
  <circle cx="12" cy="3.5" r="2" fill="currentColor" stroke="none"/>
  <line x1="7" y1="8" x2="10" y2="4.5"/>
</svg>`;

// Single source of truth for per-status presentation: badge label, accent
// color, row background + hover, and summary-card colors. Used by the nodes
// tab, models tab, and summary bars so they all stay in sync.
const STATUS_META = {
  safe_to_remove:    { label: "safe to remove",    color: "#e44", bg: "#2a1515", hover: "#3a2020", summaryBg: "#3a1a1a", summaryText: "#c99" },
  consider_removing: { label: "consider removing", color: "#e90", bg: "#2a2215", hover: "#3a2e20", summaryBg: "#2a2215", summaryText: "#ca8" },
  unused_new:        { label: "unused &lt;1mo",    color: "#68f", bg: "#1a1a25", hover: "#252530", summaryBg: "#1a1a2a", summaryText: "#99b" },
  used:              { label: "used",              color: "#4a4", bg: "#151a15", hover: "#202a20", summaryBg: "#1a2a1a", summaryText: "#9c9" },
  uninstalled:       { label: "uninstalled",       color: "#555", bg: "#1a1a1a", hover: "#252525", summaryBg: "#1a1a1a", summaryText: "#888" },
};

// Tiers that may offer a "Disable" action (when ComfyUI Manager is available).
const DISABLEABLE_TIERS = new Set(["safe_to_remove", "consider_removing"]);

app.registerExtension({
  name: "comfyui.nodes_stats",

  async setup() {
    const btn = document.createElement("button");
    btn.innerHTML = STATS_ICON;
    btn.title = "Node Stats";
    btn.className = "comfyui-button comfyui-menu-mobile-collapse";
    btn.onclick = () => showStatsDialog();
    btn.style.cssText =
      "display:flex;align-items:center;justify-content:center;padding:6px;cursor:pointer;";

    if (app.menu?.settingsGroup?.element) {
      app.menu.settingsGroup.element.before(btn);
    } else {
      const menu = document.querySelector(".comfy-menu");
      if (menu) {
        menu.append(btn);
      }
    }

    const searchBtn = document.createElement("button");
    searchBtn.textContent = "⌕";
    searchBtn.title = "Search disabled-pack nodes (Ctrl/Cmd+Shift+D)";
    searchBtn.className = "comfyui-button comfyui-menu-mobile-collapse";
    searchBtn.style.cssText = "display:flex;align-items:center;justify-content:center;padding:6px;cursor:pointer;font-size:16px;";
    searchBtn.onclick = () => openMirrorSearch();
    if (app.menu?.settingsGroup?.element) app.menu.settingsGroup.element.before(searchBtn);
    else document.querySelector(".comfy-menu")?.append(searchBtn);

    // Detect missing/disabled nodes whenever a workflow is loaded.
    const origLoad = app.loadGraphData?.bind(app);
    if (origLoad) {
      app.loadGraphData = function (...args) {
        const r = origLoad(...args);
        setTimeout(() => onWorkflowLoaded(), 0); // after graph settles
        return r;
      };
    }

    // Once the app has settled, auto-disable trial packages that went unused for
    // their full budget of distinct boot-days. Inert when ComfyUI Manager is absent.
    setTimeout(() => { processExpiredTrials().catch(() => {}); }, 3000);

    window.addEventListener("keydown", (e) => {
      if (!(e.shiftKey && (e.ctrlKey || e.metaKey) && (e.key === "D" || e.key === "d"))) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      openMirrorSearch();
    });
  },
});

// Return the set of node types present in the current graph that LiteGraph
// doesn't have registered — i.e. nodes from missing or disabled packages.
function unresolvedNodeTypes() {
  const types = new Set();
  const nodes = app.graph?._nodes || [];
  for (const n of nodes) {
    const t = n.type;
    if (t && !LiteGraph.registered_node_types[t]) types.add(t);
  }
  return [...types];
}

// Latest workflow scan, shared so showStatsDialog can render the Workflow tab.
let _lastWorkflowScan = { disabled: [], missing: [] };

async function onWorkflowLoaded() {
  const types = unresolvedNodeTypes();
  _lastWorkflowScan = await classifyUnresolved(types);
  if (_lastWorkflowScan.disabled.length || _lastWorkflowScan.missing.length) {
    showStatsDialog("workflow"); // auto-open on the Workflow tab
  }
}

async function showStatsDialog(initialTab = "nodes") {
  let data, modelData, managerInfo, trials = [];
  try {
    const [pkgResp, modelResp, mgr, trialsResp] = await Promise.all([
      fetch("/nodes-stats/packages"),
      fetch("/nodes-stats/models"),
      fetchManagerInfo(),
      fetch("/nodes-stats/trials").catch(() => null),
    ]);
    if (!pkgResp.ok) { alert("Failed to load node stats: HTTP " + pkgResp.status); return; }
    if (!modelResp.ok) { alert("Failed to load model stats: HTTP " + modelResp.status); return; }
    data = await pkgResp.json();
    modelData = await modelResp.json();
    managerInfo = mgr;
    if (trialsResp && trialsResp.ok) { try { trials = await trialsResp.json(); } catch { trials = []; } }
    if (!Array.isArray(data) || !Array.isArray(modelData)) {
      alert("Failed to load stats: unexpected response format");
      return;
    }
  } catch (e) {
    alert("Failed to load stats: " + e.message);
    return;
  }

  const custom = data.filter((p) => p.package !== "__builtin__");

  // Remove existing dialog if any
  const existing = document.getElementById("nodes-stats-dialog");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "nodes-stats-dialog";
  overlay.style.cssText =
    "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const dialog = document.createElement("div");
  dialog.style.cssText =
    "background:#1e1e1e;color:#ddd;border-radius:8px;padding:24px;max-width:800px;width:90%;max-height:85vh;overflow-y:auto;font-family:monospace;font-size:13px;";

  let html = dialogStyle();

  html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
    <h2 style="margin:0;color:#fff;font-size:18px;">Usage Stats</h2>
    <button id="nodes-stats-close" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer;">&times;</button>
  </div>`;

  // Tab switcher — wired via addEventListener after insertion, no onclick globals
  html += `
  <div id="ns-tabs" style="display:flex;gap:0;margin-bottom:20px;border-bottom:1px solid #333;">
    <button id="ns-tab-nodes"
      style="background:none;border:none;border-bottom:2px solid #4a4;color:#4a4;padding:8px 18px;cursor:pointer;font-family:monospace;font-size:13px;font-weight:bold;">
      Nodes
    </button>
    <button id="ns-tab-models"
      style="background:none;border:none;border-bottom:2px solid transparent;color:#888;padding:8px 18px;cursor:pointer;font-family:monospace;font-size:13px;">
      Models
    </button>
    <button id="ns-tab-workflow"
      style="background:none;border:none;border-bottom:2px solid transparent;color:#888;padding:8px 18px;cursor:pointer;font-family:monospace;font-size:13px;">
      Workflow
    </button>
  </div>`;

  // Nodes tab content
  html += `<div id="ns-content-nodes">`;
  html += buildNodesTabContent(custom, managerInfo);
  html += `</div>`;

  // Models tab content
  html += `<div id="ns-content-models" style="display:none;">`;
  html += buildModelsTabContent(modelData);
  html += `</div>`;

  // Workflow tab content (missing / disabled nodes in the loaded workflow)
  html += `<div id="ns-content-workflow" style="display:none;">`;
  html += buildWorkflowTabContent(_lastWorkflowScan, trials);
  html += `</div>`;

  dialog.innerHTML = html;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Tab switch — local function, no window pollution
  const TABS = ["nodes", "models", "workflow"];
  function switchTab(tab) {
    for (const t of TABS) {
      dialog.querySelector(`#ns-content-${t}`).style.display = t === tab ? "" : "none";
      const b = dialog.querySelector(`#ns-tab-${t}`);
      b.style.borderBottomColor = t === tab ? "#4a4" : "transparent";
      b.style.color = t === tab ? "#4a4" : "#888";
      b.style.fontWeight = t === tab ? "bold" : "normal";
    }
  }
  for (const t of TABS) {
    dialog.querySelector(`#ns-tab-${t}`).addEventListener("click", () => switchTab(t));
  }

  dialog.querySelector("#nodes-stats-close").addEventListener("click", () => overlay.remove());

  // Toggle expandable rows
  dialog.querySelectorAll(".pkg-row").forEach((row) => {
    row.addEventListener("click", () => {
      const detail = row.nextElementSibling;
      if (detail && detail.classList.contains("pkg-detail")) {
        detail.style.display =
          detail.style.display === "none" ? "table-row" : "none";
        const arrow = row.querySelector(".arrow");
        if (arrow)
          arrow.textContent = detail.style.display === "none" ? "▶" : "▼";
      }
    });
  });

  wireDisableButtons(dialog, managerInfo);
  wireWorkflowButtons(dialog);

  switchTab(TABS.includes(initialTab) ? initialTab : "nodes");

  // Easter egg: click "used" badge 5 times to show podium
  let eggClicks = 0;
  let eggTimer = null;
  const usedBadge = dialog.querySelector("#nodes-stats-used-badge");
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
}

// Scoped CSS for the dialog: row backgrounds + hover (replaces inline
// onmouseover/onmouseout) and the action buttons. Generated from STATUS_META.
function dialogStyle() {
  let rows = "";
  for (const [status, m] of Object.entries(STATUS_META)) {
    rows += `#nodes-stats-dialog .ns-row-${status}{background:${m.bg};}`;
    rows += `#nodes-stats-dialog .ns-row-${status}:hover{background:${m.hover};}`;
  }
  return `<style>
    #nodes-stats-dialog .ns-disabled-row{opacity:0.45;}
    #nodes-stats-dialog .ns-btn{font-family:monospace;font-size:11px;border:1px solid #555;background:#262626;color:#ddd;border-radius:4px;padding:3px 10px;cursor:pointer;white-space:nowrap;}
    #nodes-stats-dialog .ns-btn:hover:not(:disabled){background:#3a2020;border-color:#e44;color:#fff;}
    #nodes-stats-dialog .ns-btn:disabled{opacity:0.5;cursor:default;}
    #nodes-stats-dialog .ns-disable-all-btn{border-color:#a33;color:#e88;}
    ${rows}
  </style>`;
}

// Summary cards row. items: [{count, status, label, id?}]
function summaryBar(items) {
  let html = `<div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">`;
  for (const it of items) {
    const m = STATUS_META[it.status];
    const idAttr = it.id ? ` id="${it.id}"` : "";
    const cursor = it.id ? "cursor:default;user-select:none;" : "";
    html += `<div${idAttr} style="background:${m.summaryBg};padding:8px 14px;border-radius:4px;border-left:3px solid ${m.color};${cursor}">
      <span style="font-size:20px;font-weight:bold;color:${m.color};">${it.count}</span>
      <span style="color:${m.summaryText};margin-left:6px;">${it.label}</span>
    </div>`;
  }
  html += `</div>`;
  return html;
}

function buildNodesTabContent(custom, managerInfo) {
  const byStatus = (s) => custom.filter((p) => p.status === s);
  const safeToRemove     = byStatus("safe_to_remove");
  const considerRemoving = byStatus("consider_removing");
  const unusedNew        = byStatus("unused_new");
  const used             = byStatus("used");
  const uninstalled      = byStatus("uninstalled");

  let html = summaryBar([
    { count: safeToRemove.length,     status: "safe_to_remove",    label: "safe to remove" },
    { count: considerRemoving.length, status: "consider_removing", label: "consider removing" },
    { count: unusedNew.length,        status: "unused_new",        label: "unused &lt;1 month" },
    { count: used.length,             status: "used",              label: "used", id: "nodes-stats-used-badge" },
  ]);

  html += renderSection("Safe to Remove", "Unused for 2+ months", "safe_to_remove", safeToRemove, managerInfo);
  html += renderSection("Consider Removing", "Unused for 1-2 months", "consider_removing", considerRemoving, managerInfo);
  html += renderSection("Recently Unused", "Unused for less than 1 month", "unused_new", unusedNew, managerInfo);
  html += renderSection("Used", "", "used", used, managerInfo);
  html += renderSection("Uninstalled", "Previously tracked, no longer installed", "uninstalled", uninstalled, managerInfo);

  return html;
}

function renderSection(title, subtitle, status, packages, managerInfo) {
  if (packages.length === 0) return "";

  const color = STATUS_META[status].color;
  const withActions = !!managerInfo && DISABLEABLE_TIERS.has(status);
  const eligible = withActions
    ? packages.filter((p) => isDisableEligible(p, managerInfo)).map((p) => p.package)
    : [];

  let action = "";
  if (eligible.length > 0) {
    action = `<button class="ns-btn ns-disable-all-btn" data-pkgs="${escapeAttr(JSON.stringify(eligible))}">Disable all (${eligible.length})</button>`;
  }

  let html = `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:16px 0 8px;">
    <h3 style="color:${color};margin:0;font-size:14px;">${escapeHtml(title)}`;
  if (subtitle) html += ` <span style="color:#666;font-size:12px;font-weight:normal;">— ${escapeHtml(subtitle)}</span>`;
  html += `</h3>${action}</div>`;

  html += buildTable(packages, status, withActions, managerInfo);
  return html;
}

// A package can be disabled only if ComfyUI Manager knows it (by directory
// name) and it is currently active (any state other than already-disabled).
function isDisableEligible(pkg, managerInfo) {
  if (!managerInfo || !pkg.installed) return false;
  const info = managerInfo[pkg.package];
  return !!(info && info.state && info.state !== "disabled");
}

function buildModelsTabContent(modelData) {
  const allModels = modelData.flatMap((g) => g.models);
  const count = (s) => allModels.filter((m) => m.status === s).length;

  let html = summaryBar([
    { count: count("safe_to_remove"),    status: "safe_to_remove",    label: "safe to remove" },
    { count: count("consider_removing"), status: "consider_removing", label: "consider removing" },
    { count: count("unused_new"),        status: "unused_new",        label: "unused &lt;1 month" },
    { count: count("used"),              status: "used",              label: "used" },
  ]);

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
    const meta = STATUS_META[m.status] || STATUS_META.used;
    const lastSeen = m.last_seen ? new Date(m.last_seen).toLocaleDateString() : "—";

    html += `<tr class="ns-row-${m.status}" style="border-bottom:1px solid #222;">
      <td style="padding:6px 8px;color:#fff;">${escapeHtml(m.model_name)}</td>
      <td style="padding:6px 8px;text-align:right;">${m.count}</td>
      <td style="padding:6px 8px;color:#888;">${lastSeen}</td>
      <td style="padding:6px 8px;"><span style="color:${meta.color};font-size:11px;">${meta.label}</span></td>
    </tr>`;
  }

  html += `</tbody></table>`;
  return html;
}

// Render the Workflow tab from a classification result. `disabled` entries get
// re-enable actions (temporary trial or permanent); `missing` entries get an
// Install button that defers to ComfyUI Manager.
function buildWorkflowTabContent({ disabled, missing }, trials) {
  const trialByPkg = Object.fromEntries((trials || []).map((t) => [t.package, t]));
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

function sectionHeader(title, subtitle, color) {
  let html = `<h3 style="color:${color};margin:16px 0 8px;font-size:14px;">${escapeHtml(title)}`;
  if (subtitle) html += ` <span style="color:#666;font-size:12px;font-weight:normal;">— ${escapeHtml(subtitle)}</span>`;
  html += `</h3>`;
  return html;
}

function buildTable(packages, status, withActions, managerInfo) {
  const colspan = withActions ? 7 : 6;

  let html = `<table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
    <thead><tr style="color:#888;text-align:left;border-bottom:1px solid #333;">
      <th style="padding:6px 8px;"></th>
      <th style="padding:6px 8px;">Package</th>
      <th style="padding:6px 8px;text-align:right;">Nodes</th>
      <th style="padding:6px 8px;text-align:right;">Used</th>
      <th style="padding:6px 8px;text-align:right;">Executions</th>
      <th style="padding:6px 8px;">Last Used</th>`;
  if (withActions) html += `<th style="padding:6px 8px;"></th>`;
  html += `</tr></thead><tbody>`;

  for (const pkg of packages) {
    const hasNodes = pkg.nodes && pkg.nodes.length > 0;
    const lastSeen = pkg.last_seen ? new Date(pkg.last_seen).toLocaleDateString() : "—";

    html += `<tr class="pkg-row ns-row-${status}" style="cursor:${hasNodes ? "pointer" : "default"};border-bottom:1px solid #222;">
      <td style="padding:6px 8px;width:20px;"><span class="arrow" style="color:#666;">${hasNodes ? "▶" : " "}</span></td>
      <td style="padding:6px 8px;color:#fff;">${escapeHtml(pkg.package)}</td>
      <td style="padding:6px 8px;text-align:right;">${pkg.total_nodes}</td>
      <td style="padding:6px 8px;text-align:right;">${pkg.used_nodes}/${pkg.total_nodes}</td>
      <td style="padding:6px 8px;text-align:right;">${pkg.total_executions}</td>
      <td style="padding:6px 8px;color:#888;">${lastSeen}</td>`;

    if (withActions) {
      const eligible = isDisableEligible(pkg, managerInfo);
      const cell = eligible
        ? `<button class="ns-btn ns-disable-btn" data-pkg="${escapeAttr(pkg.package)}">Disable</button>`
        : `<span style="color:#555;">—</span>`;
      html += `<td class="ns-action-cell" data-pkg="${escapeAttr(pkg.package)}" style="padding:6px 8px;text-align:right;">${cell}</td>`;
    }
    html += `</tr>`;

    if (hasNodes) {
      html += `<tr class="pkg-detail" style="display:none;"><td colspan="${colspan}" style="padding:0 0 0 32px;">
        <table style="width:100%;border-collapse:collapse;">`;
      for (const node of pkg.nodes) {
        const nLastSeen = node.last_seen ? new Date(node.last_seen).toLocaleDateString() : "—";
        html += `<tr style="border-bottom:1px solid #1a1a1a;color:#aaa;">
          <td style="padding:3px 8px;">${escapeHtml(node.class_type)}</td>
          <td style="padding:3px 8px;text-align:right;">${node.count}</td>
          <td style="padding:3px 8px;color:#666;">${nLastSeen}</td>
        </tr>`;
      }
      html += `</table></td></tr>`;
    }
  }

  html += `</tbody></table>`;
  return html;
}

// ---------------------------------------------------------------------------
// ComfyUI Manager integration: disable unused node packages
// ---------------------------------------------------------------------------

// Map of installed packages from ComfyUI Manager, keyed by directory name:
//   { <dir name>: { id, version, files, state }, ... }
// We read the unified list (/customnode/getlist) rather than /customnode/installed
// because only the unified list reports the install *state version* the disable
// endpoint needs: "nightly" for git installs, the semver for registry installs,
// or "unknown". (/customnode/installed returns a raw git commit hash instead,
// which the disable endpoint rejects.) This mirrors what Manager's own UI sends.
// Returns null when the Manager is not installed/reachable, so the disable UI is
// omitted entirely.
async function fetchManagerInfo() {
  try {
    const resp = await fetch("/customnode/getlist?mode=local&skip_update=true");
    if (!resp.ok) return null;
    const data = await resp.json();
    const packs = data && data.node_packs;
    if (!packs || typeof packs !== "object") return null;
    const info = {};
    for (const [key, v] of Object.entries(packs)) {
      if (!v || v.state === "not-installed") continue;
      // For installed packs the key is the directory name — matches our package names.
      // cnr_id/aux_id are kept so getmappings keys (which may be a registry id or
      // repo URL rather than the dir name) can be reconciled in classifyUnresolved.
      info[key] = {
        id: v.id || key, version: v.version, files: v.files, state: v.state,
        cnr_id: v.cnr_id, aux_id: v.aux_id,
      };
    }
    return info;
  } catch {
    return null;
  }
}

// Normalize an identifier (repo URL, dir name, or registry id) for joining
// getmappings keys to getlist packs. Same ordering as classifyUnresolved's norm.
function normalizeRepoUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

// Join Manager's node->pack mappings with the disabled packs from getlist.
// mappings: { <packKey>: [ [class_type,...], {title_aux} ] }   (from getmappings)
// managerInfo: { <dir>: {id,version,files,state,cnr_id,aux_id} } (from fetchManagerInfo)
// getmappings keys come in several forms (dir name, registry id, repo/gist URL),
// and Manager keys the node map by dir/id far more often than by URL — so we
// resolve each key against EVERY identifier a pack exposes, exactly as
// classifyUnresolved does. Matching repo URLs alone misses the vast majority of
// packs. Returns [{ class_type, pack, title, info }] for disabled packs only.
function buildDisabledCatalog(mappings, managerInfo) {
  const byAnyKey = {};
  for (const [dir, info] of Object.entries(managerInfo || {})) {
    if (!info) continue;
    const rec = { dir, info };
    byAnyKey[normalizeRepoUrl(dir)] = rec;
    for (const k of [info.id, info.cnr_id, info.aux_id]) if (k) byAnyKey[normalizeRepoUrl(k)] = rec;
    for (const f of (info.files || [])) if (f) byAnyKey[normalizeRepoUrl(f)] = rec;
  }
  const catalog = [];
  const seen = new Set();
  const packMeta = {};   // dir -> shared { pack, title, author, description, repo, version, info, nodes:[] }
  for (const [packKey, entry] of Object.entries(mappings || {})) {
    const rec = byAnyKey[normalizeRepoUrl(packKey)];
    if (!rec || rec.info.state !== "disabled") continue;
    const list = entry && entry[0];
    if (!Array.isArray(list)) continue;
    const m = (entry && entry[1]) || {};
    let meta = packMeta[rec.dir];
    if (!meta) {
      const repo = (rec.info.files || []).find((f) => /^https?:\/\//i.test(f)) || "";
      meta = packMeta[rec.dir] = {
        pack: rec.dir,
        title: m.title || m.title_aux || rec.info.title || rec.dir,
        author: m.author || "",
        description: m.description || "",
        repo,
        version: rec.info.version || "",
        info: rec.info,
        nodes: [],
      };
    }
    for (const ct of list) {
      const dedup = rec.dir + "\n" + ct;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      meta.nodes.push(ct);
      catalog.push({ class_type: ct, pack: rec.dir, title: meta.title, info: rec.info, meta });
    }
  }
  for (const meta of Object.values(packMeta)) meta.nodes.sort((a, b) => a.localeCompare(b));
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

// Split unresolved node types into packages that are installed-but-disabled
// (re-enable to use) vs not installed (install via Manager). Reconciles
// ComfyUI Manager's getmappings (class_type -> pack key) against getlist state.
async function classifyUnresolved(types) {
  if (!types.length) return { disabled: [], missing: [] };
  let mappings = {}, managerInfo = null;
  try {
    const [mResp, gi] = await Promise.all([
      fetch("/customnode/getmappings?mode=local"),
      fetchManagerInfo(), // getlist -> {dir: {id, cnr_id, aux_id, version, files, state}}
    ]);
    if (mResp.ok) mappings = await mResp.json();
    managerInfo = gi;
  } catch { /* manager absent */ }

  // class_type -> packKey. getmappings value is [ [class_types...], {meta} ];
  // packKey is a directory name OR a repo/gist URL depending on the pack.
  const typeToPack = {};
  for (const [packKey, entry] of Object.entries(mappings)) {
    for (const ct of (entry?.[0] || [])) typeToPack[ct] = packKey;
  }

  // Index installed/disabled packs by every identifier they expose (dir name,
  // id, cnr_id, aux_id, and each repo URL) so a getmappings key in any of those
  // forms resolves. URLs are normalized (drop trailing slash / .git, lowercase).
  const norm = (s) => String(s).trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  const byAnyKey = {};
  if (managerInfo) for (const [dir, info] of Object.entries(managerInfo)) {
    const rec = { ...info, _dir: dir };
    byAnyKey[norm(dir)] = rec;
    for (const k of [info.id, info.cnr_id, info.aux_id]) if (k) byAnyKey[norm(k)] = rec;
    for (const f of (info.files || [])) if (f) byAnyKey[norm(f)] = rec;
  }

  const disabled = [], missing = [];
  for (const ct of types) {
    const packKey = typeToPack[ct];
    const info = packKey ? byAnyKey[norm(packKey)] : null;
    if (info && info.state === "disabled") disabled.push({ type: ct, pkg: info._dir, info });
    else missing.push({ type: ct, pkg: packKey || null });
  }
  return { disabled, missing };
}

// Build the payload ComfyUI Manager's /manager/queue/disable expects, mirroring
// Manager's own frontend: id = directory name, version = install state
// ("nightly" / semver / "unknown"), and files (repo URL) only for "unknown".
function disablePayload(dirName, info) {
  const payload = { id: info.id || dirName, version: info.version, ui_id: dirName };
  if (info.version === "unknown") {
    payload.files = info.files && info.files.length ? info.files : [dirName];
  }
  return payload;
}

function wireDisableButtons(dialog, managerInfo) {
  if (!managerInfo) return;

  dialog.querySelectorAll(".ns-disable-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleDisable([btn.dataset.pkg], dialog, managerInfo);
    });
  });

  dialog.querySelectorAll(".ns-disable-all-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      let names = [];
      try { names = JSON.parse(btn.dataset.pkgs); } catch { names = []; }
      handleDisable(names, dialog, managerInfo);
    });
  });
}

// Wire the Workflow tab's enable/install buttons. Handlers are filled in by the
// enable (Task 10) and install (Task 11) steps.
function wireWorkflowButtons(dialog) {
  dialog.querySelectorAll(".ns-enable-temp-btn").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); handleEnable(b.dataset.pkg, true, dialog); }));
  dialog.querySelectorAll(".ns-enable-perm-btn").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); handleEnable(b.dataset.pkg, false, dialog); }));
  dialog.querySelectorAll(".ns-install-btn").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); handleInstall(b.dataset.pkg, dialog); }));
}

async function handleDisable(pkgNames, dialog, managerInfo) {
  // Only act on packages Manager still reports as active (guards against
  // double-clicks and stale buttons after a partial batch).
  pkgNames = pkgNames.filter((n) => managerInfo[n] && managerInfo[n].state !== "disabled");
  if (pkgNames.length === 0) return;

  const what = pkgNames.length === 1 ? `"${pkgNames[0]}"` : `${pkgNames.length} packages`;
  const confirmMsg =
    `Disable ${what} via ComfyUI Manager?\n\n` +
    `They will be moved to custom_nodes/.disabled and a ComfyUI restart is ` +
    `required to take effect. You can re-enable them anytime from ComfyUI Manager.`;
  if (!confirm(confirmMsg)) return;

  setDisableButtonsBusy(dialog, true);
  try {
    const pre = await fetch("/manager/queue/status").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (pre && pre.is_processing) {
      notify("ComfyUI Manager is busy. Please try again in a moment.", "warn");
      setDisableButtonsBusy(dialog, false);
      return;
    }

    const payloads = pkgNames.map((n) => disablePayload(n, managerInfo[n]));
    await runManagerDisable(payloads);

    // Reconcile against Manager's actual state: a package is considered
    // disabled only if it's no longer reported as active on disk.
    const after = await fetchManagerInfo();
    const isStillActive = (n) => after && after[n] && after[n].state !== "disabled";
    const succeeded = after ? pkgNames.filter((n) => !isStillActive(n)) : pkgNames;
    const failed = pkgNames.filter((n) => !succeeded.includes(n));

    succeeded.forEach((n) => { if (managerInfo[n]) managerInfo[n].state = "disabled"; });
    markPackagesDisabled(dialog, succeeded);
    updateBulkButtons(dialog, managerInfo);

    if (succeeded.length > 0) {
      showRestartBanner(dialog);
      notify(`Disabled ${succeeded.length} package${succeeded.length !== 1 ? "s" : ""}. Restart ComfyUI to apply.`, "success");
    }
    if (failed.length > 0) {
      notify(`ComfyUI Manager could not disable: ${failed.join(", ")}`, "error");
    }
  } catch (e) {
    notify("Failed to disable: " + e.message, "error");
  } finally {
    setDisableButtonsBusy(dialog, false);
  }
}

// Queue the disable tasks and run them, then wait for the Manager worker to
// finish. /manager/queue/start returns 201 if a worker is already running.
async function runManagerDisable(payloads) {
  await fetch("/manager/queue/reset", { method: "POST", headers: { "Content-Type": "application/json" } });

  for (const payload of payloads) {
    const r = await fetch("/manager/queue/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`disable request failed (HTTP ${r.status})`);
  }

  const start = await fetch("/manager/queue/start", { method: "POST", headers: { "Content-Type": "application/json" } });
  if (!start.ok && start.status !== 201) throw new Error(`queue start failed (HTTP ${start.status})`);

  await waitForQueue();
}

// Re-enable a disabled pack via ComfyUI Manager (confirmed against the live
// server and ComfyUI-Manager's manager_server.py / manager_core.py). Two routes
// through /manager/queue/install, both ending in unified_enable (a dir move out
// of .disabled — never a re-clone):
//   • version != "unknown" (nightly/semver): skip_post_install takes the fast
//     path, unified_enable(id) is called and the route returns before reading
//     channel/mode/files. Load-bearing: id, version, skip_post_install.
//   • version == "unknown": queues an install task; install_by_id sees the pack
//     is_disabled and calls unified_enable. Needs files (repo URL), channel, mode.
// selected_version always mirrors version, so the "invalid request" arm (version
// set but selected_version=="unknown") is never hit. One payload covers both.
function enablePayload(dirName, info) {
  return {
    id: info.id || dirName,
    version: info.version,
    files: info.files,
    channel: "default",
    mode: "cache",
    skip_post_install: true,
    selected_version: info.version,
    ui_id: dirName,
  };
}

// Whether ComfyUI Manager is mid-operation. Used to avoid resetting its queue
// out from under an in-progress install/disable (the manual disable flow guards
// the same way before calling runManagerDisable).
async function managerIsBusy() {
  try {
    const r = await fetch("/manager/queue/status");
    if (!r.ok) return false;
    const st = await r.json();
    return !!(st && st.is_processing);
  } catch {
    return false;
  }
}

async function runManagerEnable(payload) {
  await fetch("/manager/queue/reset", { method: "POST", headers: { "Content-Type": "application/json" } });

  const r = await fetch("/manager/queue/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`enable request failed (HTTP ${r.status})`);

  const start = await fetch("/manager/queue/start", { method: "POST", headers: { "Content-Type": "application/json" } });
  if (!start.ok && start.status !== 201) throw new Error(`queue start failed (HTTP ${start.status})`);

  await waitForQueue();
}

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

// Enable a disabled package, optionally under a temporary trial. A permanent
// enable clears any existing trial row so the package is never auto-disabled.
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

// ---------------------------------------------------------------------------
// Mirror search: a standalone palette over nodes of currently-disabled packs
// ---------------------------------------------------------------------------

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
    "margin-top:10vh;background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:8px;width:90%;max-width:880px;max-height:70vh;display:flex;flex-direction:column;font-family:monospace;font-size:13px;overflow:hidden;";
  box.innerHTML = `
    <style>
      #nodes-stats-mirror .ns-btn{font-family:monospace;font-size:11px;border:1px solid #555;background:#262626;color:#ddd;border-radius:4px;padding:3px 10px;cursor:pointer;white-space:nowrap;}
      #nodes-stats-mirror .ns-btn:hover:not(:disabled){background:#203a20;border-color:#4a4;color:#fff;}
      #nodes-stats-mirror .ns-btn:disabled{opacity:0.5;cursor:default;}
      #nodes-stats-mirror .ns-mrow:hover{background:#262626;}
      #nodes-stats-mirror .ns-mrow.active{background:#1f2c1f;}
      #nodes-stats-mirror a{color:#6a9bd8;}
    </style>
    <div style="padding:12px;border-bottom:1px solid #333;display:flex;gap:8px;align-items:center;">
      <input id="ns-mirror-input" placeholder="search disabled-pack nodes…" autocomplete="off"
        style="flex:1;background:#111;border:1px solid #444;border-radius:4px;color:#fff;padding:8px 10px;font-family:monospace;font-size:14px;outline:none;">
      <button id="ns-mirror-refresh" class="ns-btn" title="Rebuild catalog">↻</button>
    </div>
    <div style="display:flex;flex:1;min-height:0;overflow:hidden;">
      <div id="ns-mirror-results" style="flex:1;min-width:0;overflow-y:auto;padding:6px 0;border-right:1px solid #333;"></div>
      <div id="ns-mirror-preview" style="width:300px;flex-shrink:0;overflow-y:auto;padding:14px;color:#999;line-height:1.5;"></div>
    </div>
    <div id="ns-mirror-footer" style="padding:8px 12px;border-top:1px solid #333;color:#666;font-size:11px;"></div>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const input = box.querySelector("#ns-mirror-input");
  const results = box.querySelector("#ns-mirror-results");
  const preview = box.querySelector("#ns-mirror-preview");
  const footer = box.querySelector("#ns-mirror-footer");

  let currentRows = [];
  let activeIndex = -1;

  function clearPreview(msg) {
    preview.innerHTML = `<div style="color:#666;">${escapeHtml(msg || "Hover a result to preview its package.")}</div>`;
  }

  // Preview panel for the active row. We can't render a real node graphic (the
  // pack is disabled, so its definition isn't loaded), so we show the pack
  // metadata we do have: title/author/description + the sibling nodes in the pack.
  function renderPreview(entry) {
    if (!entry) { clearPreview(); return; }
    const m = entry.meta || {};
    const sibs = m.nodes || [];
    const CAP = 60;
    const shown = sibs.slice(0, CAP);
    const sibHtml = shown.map((n) => {
      const me = n === entry.class_type;
      return `<div style="padding:1px 0;color:${me ? "#fff" : "#9a9"};${me ? "font-weight:bold;" : ""}white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${me ? "▸ " : "· "}${escapeHtml(n)}</div>`;
    }).join("") + (sibs.length > shown.length ? `<div style="color:#666;">+${sibs.length - shown.length} more</div>` : "");
    const meta = [`<span style="color:#777;">pack</span><span style="color:#ccc;word-break:break-all;">${escapeHtml(entry.pack)}</span>`];
    if (m.author) meta.push(`<span style="color:#777;">author</span><span style="color:#ccc;">${escapeHtml(m.author)}</span>`);
    if (m.version) meta.push(`<span style="color:#777;">version</span><span style="color:#ccc;">${escapeHtml(String(m.version))}</span>`);
    preview.innerHTML = `
      <div style="color:#fff;font-size:14px;word-break:break-word;margin-bottom:10px;">${escapeHtml(entry.class_type)}</div>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:3px 8px;font-size:11px;margin-bottom:10px;">${meta.join("")}</div>
      ${m.description ? `<div style="color:#aaa;font-size:11px;font-style:italic;border-left:2px solid #444;padding-left:8px;margin-bottom:10px;">${escapeHtml(m.description)}</div>` : ""}
      ${m.repo ? `<div style="margin-bottom:12px;"><a href="${escapeAttr(m.repo)}" target="_blank" rel="noopener" style="font-size:11px;word-break:break-all;">${escapeHtml(m.repo)}</a></div>` : ""}
      <div style="margin-bottom:10px;">
        <button class="ns-btn ns-mirror-temp" data-pkg="${escapeAttr(entry.pack)}">Enable 7d</button>
        <button class="ns-btn ns-mirror-perm" data-pkg="${escapeAttr(entry.pack)}" style="margin-left:6px;">Enable</button>
      </div>
      <div style="color:#777;font-size:11px;margin-bottom:4px;">${sibs.length} node${sibs.length !== 1 ? "s" : ""} in this pack</div>
      <div style="font-size:11px;">${sibHtml}</div>`;
    preview.querySelectorAll(".ns-mirror-temp").forEach((b) =>
      b.addEventListener("click", () => mirrorEnable(b.dataset.pkg, true, overlay)));
    preview.querySelectorAll(".ns-mirror-perm").forEach((b) =>
      b.addEventListener("click", () => mirrorEnable(b.dataset.pkg, false, overlay)));
  }

  function setActive(i) {
    if (!currentRows.length) { activeIndex = -1; clearPreview(); return; }
    activeIndex = Math.max(0, Math.min(i, currentRows.length - 1));
    const els = results.querySelectorAll(".ns-mrow");
    els.forEach((el, idx) => el.classList.toggle("active", idx === activeIndex));
    els[activeIndex]?.scrollIntoView({ block: "nearest" });
    renderPreview(currentRows[activeIndex]);
  }

  footer.textContent = "loading disabled-node catalog…";
  clearPreview("Loading…");
  let catalog = await ensureDisabledCatalog();
  if (catalog === null) { footer.textContent = "ComfyUI Manager not available."; clearPreview(" "); return; }
  if (catalog.length === 0) { footer.textContent = "No disabled packages — nothing to search."; clearPreview(" "); return; }
  const packCount = new Set(catalog.map((e) => e.pack)).size;
  footer.textContent = `${catalog.length} nodes across ${packCount} disabled packs · enabling needs a restart`;

  function render() {
    const { rows, total } = filterCatalog(catalog, input.value);
    currentRows = rows;
    activeIndex = -1;
    if (!input.value.trim()) {
      results.innerHTML = `<div style="padding:14px;color:#666;">Type to search ${catalog.length} nodes in ${packCount} disabled packs.</div>`;
      clearPreview();
      return;
    }
    if (total === 0) {
      results.innerHTML = `<div style="padding:14px;color:#666;">No disabled nodes match “${escapeHtml(input.value)}”.</div>`;
      clearPreview("No match.");
      return;
    }
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
    results.querySelectorAll(".ns-mrow").forEach((el, i) =>
      el.addEventListener("mouseenter", () => setActive(i)));
    setActive(0);
  }

  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(activeIndex + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(activeIndex - 1); }
  });
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

// Missing packages are deferred to ComfyUI Manager — the design treats "Missing"
// as handled by Manager like always, and Manager already surfaces missing nodes
// on workflow load. We intentionally do NOT replicate install: a not-installed
// pack's exact spec can't be resolved reliably client-side (mode=local getlist
// exposes no cnr_id and an ambiguous version field, so cnr@latest vs git@unknown
// can't be chosen without risking "cannot resolve install target"). Instead open
// Manager's Custom Nodes Manager (which has a built-in Missing filter); if that
// command isn't available in this ComfyUI build, guide the user to it.
async function handleInstall(pkg, dialog) {
  let opened = false;
  try {
    const cmd = app?.extensionManager?.command;
    if (cmd && typeof cmd.execute === "function") {
      await cmd.execute("Comfy.Manager.CustomNodesManager.ToggleVisibility");
      opened = true;
    }
  } catch { /* fall through to guidance */ }
  notify(
    opened
      ? `Opened ComfyUI Manager — choose the "Missing" filter to install ${pkg}.`
      : `Install ${pkg} via ComfyUI Manager → "Install Missing Custom Nodes".`,
    "info"
  );
}

function setWorkflowButtonsBusy(dialog, busy) {
  dialog.querySelectorAll(".ns-enable-temp-btn, .ns-enable-perm-btn, .ns-install-btn").forEach((b) => {
    b.disabled = busy;
  });
}

async function stopTrial(pkg) {
  try {
    await fetch("/nodes-stats/trials/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: pkg }),
    });
  } catch { /* best-effort; row ages out next session */ }
}

// On UI load, disable any trial package whose 7 distinct boot-days elapsed with
// no use (the backend marks it expired). The disable goes through ComfyUI
// Manager exactly like a manual disable; the trial row is then cleared. Inert
// when Manager is absent. A package already disabled on disk just clears its row.
async function processExpiredTrials() {
  let trials = [];
  try {
    const r = await fetch("/nodes-stats/trials");
    if (r.ok) trials = await r.json();
  } catch { return; }

  const expired = trials.filter((t) => t.expired);
  if (!expired.length) return;

  const mgr = await fetchManagerInfo();
  if (!mgr) return; // Manager unavailable — leave rows for a later session

  // Don't reset Manager's queue out from under an in-progress operation
  // (e.g. startup install work); the expired rows persist and retry next session.
  if (await managerIsBusy()) return;

  const done = [];
  for (const t of expired) {
    const info = mgr[t.package];
    if (!info || info.state === "disabled") {
      await stopTrial(t.package);
      done.push(t.package);
      continue;
    }
    try {
      await runManagerDisable([disablePayload(t.package, info)]);
      await stopTrial(t.package);
      done.push(t.package);
    } catch { /* keep the row; retry next session */ }
  }

  if (done.length) {
    notify(`Auto-disabled ${done.length} unused trial package(s). Restart ComfyUI to apply.`, "info");
  }
}

async function waitForQueue(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  await sleep(300);
  while (Date.now() < deadline) {
    let st = null;
    try {
      const r = await fetch("/manager/queue/status");
      if (r.ok) st = await r.json();
    } catch { /* transient; retry */ }
    if (st && !st.is_processing && st.in_progress_count === 0) return;
    await sleep(500);
  }
  throw new Error("timed out waiting for ComfyUI Manager");
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function setDisableButtonsBusy(dialog, busy) {
  dialog.querySelectorAll(".ns-disable-btn, .ns-disable-all-btn").forEach((b) => {
    b.disabled = busy;
  });
}

function markPackagesDisabled(dialog, pkgNames) {
  for (const name of pkgNames) {
    const cell = dialog.querySelector(`.ns-action-cell[data-pkg="${cssEscape(name)}"]`);
    if (cell) {
      cell.innerHTML = `<span style="color:#6a6;font-size:11px;">✓ disabled · restart</span>`;
      cell.closest("tr")?.classList.add("ns-disabled-row");
    }
  }
}

// Recompute "Disable all (N)" counts after a batch; hide buttons with nothing
// left to disable.
function updateBulkButtons(dialog, managerInfo) {
  dialog.querySelectorAll(".ns-disable-all-btn").forEach((btn) => {
    let names = [];
    try { names = JSON.parse(btn.dataset.pkgs); } catch { names = []; }
    const remaining = names.filter((n) => managerInfo[n] && managerInfo[n].state !== "disabled");
    if (remaining.length === 0) {
      btn.style.display = "none";
    } else {
      btn.dataset.pkgs = JSON.stringify(remaining);
      btn.textContent = `Disable all (${remaining.length})`;
    }
  });
}

function showRestartBanner(dialog) {
  if (dialog.querySelector("#ns-restart-banner")) return;

  const banner = document.createElement("div");
  banner.id = "ns-restart-banner";
  banner.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:12px;background:#2a2215;border:1px solid #a83;border-radius:4px;padding:10px 14px;margin-bottom:16px;";
  banner.innerHTML =
    `<span style="color:#eca;">Changes applied on disk. Restart ComfyUI to unload disabled packages.</span>
     <span style="white-space:nowrap;">
       <button id="ns-restart-btn" class="ns-btn" style="border-color:#a83;color:#fc8;">Restart ComfyUI</button>
       <button id="ns-restart-dismiss" class="ns-btn" style="margin-left:6px;">Later</button>
     </span>`;

  const tabs = dialog.querySelector("#ns-tabs");
  tabs ? tabs.before(banner) : dialog.prepend(banner);

  banner.querySelector("#ns-restart-btn").addEventListener("click", rebootComfy);
  banner.querySelector("#ns-restart-dismiss").addEventListener("click", () => banner.remove());
}

async function rebootComfy() {
  if (!confirm("Restart ComfyUI now? The server will go down briefly and the page will reconnect.")) return;
  notify("Restarting ComfyUI…", "info");
  try {
    await fetch("/manager/reboot", { method: "POST", headers: { "Content-Type": "application/json" } });
  } catch {
    // The reboot tears down the connection, so a network error here is expected.
  }
}

function notify(detail, severity) {
  try {
    const toast = app?.extensionManager?.toast;
    if (toast && typeof toast.add === "function") {
      toast.add({ severity: severity === "warn" ? "warn" : severity, summary: "Node Stats", detail, life: 5000 });
      return;
    }
  } catch { /* fall through to console/alert */ }
  if (severity === "error") alert(detail);
  else console.log("[Node Stats] " + detail);
}

// ---------------------------------------------------------------------------
// Easter egg
// ---------------------------------------------------------------------------

// Internal: builds celebratory overlay for top contributors
function showPodium(top3, overlay) {
  const existing = document.getElementById("nodes-stats-podium");
  if (existing) { existing.remove(); return; }

  const colors = ["#FFD700", "#C0C0C0", "#CD7F32"];
  const heights = [160, 120, 90];
  const order = [1, 0, 2];

  // SVG characters: champion with cape, cool runner-up, happy bronze
  const characters = [
    // Gold: flexing champion with crown and cape
    `<svg viewBox="0 0 80 100" width="80" height="100" xmlns="http://www.w3.org/2000/svg">
      <polygon points="28,18 40,6 52,18" fill="#FFD700" stroke="#DAA520" stroke-width="1"/>
      <polygon points="32,18 36,10 40,18" fill="#FFD700"/><polygon points="40,18 44,10 48,18" fill="#FFD700"/>
      <circle cx="40" cy="30" r="12" fill="#ffd08a"/>
      <circle cx="36" cy="28" r="1.5" fill="#333"/><circle cx="44" cy="28" r="1.5" fill="#333"/>
      <path d="M36,34 Q40,38 44,34" stroke="#333" stroke-width="1.5" fill="none"/>
      <rect x="32" y="42" width="16" height="24" rx="4" fill="#e44"/>
      <path d="M32,42 Q24,50 16,42 L24,38 Z" fill="#e44" opacity="0.8"/>
      <path d="M48,42 Q56,50 64,42 L56,38 Z" fill="#e44" opacity="0.8"/>
      <rect x="20" y="42" width="6" height="16" rx="3" fill="#ffd08a" transform="rotate(-30,23,50)"/>
      <rect x="54" y="42" width="6" height="16" rx="3" fill="#ffd08a" transform="rotate(30,57,50)"/>
      <rect x="34" y="66" width="5" height="16" rx="2" fill="#336"/>
      <rect x="41" y="66" width="5" height="16" rx="2" fill="#336"/>
      <text x="40" y="96" text-anchor="middle" font-size="10" fill="#FFD700">GOAT</text>
    </svg>`,
    // Silver: sunglasses dude, arms crossed
    `<svg viewBox="0 0 80 100" width="70" height="88" xmlns="http://www.w3.org/2000/svg">
      <circle cx="40" cy="30" r="12" fill="#ffd08a"/>
      <rect x="28" y="26" width="24" height="6" rx="3" fill="#333" opacity="0.85"/>
      <circle cx="34" cy="29" r="4" fill="#222" opacity="0.6"/><circle cx="46" cy="29" r="4" fill="#222" opacity="0.6"/>
      <path d="M37,36 L40,38 L43,36" stroke="#333" stroke-width="1.2" fill="none"/>
      <rect x="32" y="42" width="16" height="22" rx="4" fill="#448"/>
      <path d="M30,48 Q40,56 50,48" stroke="#ffd08a" stroke-width="5" fill="none" stroke-linecap="round"/>
      <rect x="34" y="64" width="5" height="14" rx="2" fill="#336"/>
      <rect x="41" y="64" width="5" height="14" rx="2" fill="#336"/>
      <text x="40" y="92" text-anchor="middle" font-size="9" fill="#C0C0C0">cool.</text>
    </svg>`,
    // Bronze: happy little guy waving
    `<svg viewBox="0 0 80 100" width="60" height="75" xmlns="http://www.w3.org/2000/svg">
      <circle cx="40" cy="32" r="11" fill="#ffd08a"/>
      <circle cx="36" cy="30" r="1.5" fill="#333"/><circle cx="44" cy="30" r="1.5" fill="#333"/>
      <path d="M35,36 Q40,42 45,36" stroke="#333" stroke-width="1.5" fill="none"/>
      <ellipse cx="32" cy="34" rx="3" ry="2" fill="#f99" opacity="0.5"/>
      <ellipse cx="48" cy="34" rx="3" ry="2" fill="#f99" opacity="0.5"/>
      <rect x="33" y="43" width="14" height="20" rx="4" fill="#4a4"/>
      <rect x="22" y="38" width="5" height="14" rx="2.5" fill="#ffd08a" transform="rotate(-45,24,38)"/>
      <rect x="53" y="43" width="5" height="14" rx="2.5" fill="#ffd08a"/>
      <rect x="35" y="63" width="4" height="13" rx="2" fill="#336"/>
      <rect x="41" y="63" width="4" height="13" rx="2" fill="#336"/>
      <text x="40" y="90" text-anchor="middle" font-size="9" fill="#CD7F32">yay!</text>
    </svg>`,
  ];

  const podium = document.createElement("div");
  podium.id = "nodes-stats-podium";
  podium.style.cssText =
    "position:absolute;top:0;left:0;width:100%;height:100%;background:radial-gradient(ellipse at center,#1a1a2e 0%,#0a0a12 100%);display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:8px;z-index:1;cursor:pointer;overflow:hidden;";
  podium.addEventListener("click", () => podium.remove());

  // Sparkle particles
  let sparkles = "";
  for (let i = 0; i < 20; i++) {
    const x = Math.random() * 100;
    const y = Math.random() * 60;
    const d = (1 + Math.random() * 2).toFixed(1);
    const o = (0.3 + Math.random() * 0.7).toFixed(2);
    sparkles += `<div style="position:absolute;left:${x}%;top:${y}%;width:${d}px;height:${d}px;background:#fff;border-radius:50%;opacity:${o};animation:ns-twinkle ${(1 + Math.random() * 2).toFixed(1)}s ease-in-out infinite alternate;"></div>`;
  }

  let html = `<style>
    @keyframes ns-twinkle { from { opacity: 0.1; transform: scale(0.5); } to { opacity: 1; transform: scale(1.2); } }
    @keyframes ns-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
    @keyframes ns-trophy { 0% { transform: scale(0) rotate(-20deg); } 60% { transform: scale(1.2) rotate(5deg); } 100% { transform: scale(1) rotate(0deg); } }
  </style>`;
  html += sparkles;

  // Trophy title
  html += `<div style="animation:ns-trophy 0.6s ease-out;margin-bottom:20px;text-align:center;">
    <svg width="48" height="48" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <path d="M14,8 H34 V20 Q34,32 24,36 Q14,32 14,20 Z" fill="#FFD700" stroke="#DAA520" stroke-width="1.5"/>
      <path d="M14,12 H8 Q6,12 6,14 V18 Q6,24 14,22" fill="none" stroke="#DAA520" stroke-width="2"/>
      <path d="M34,12 H40 Q42,12 42,14 V18 Q42,24 34,22" fill="none" stroke="#DAA520" stroke-width="2"/>
      <rect x="20" y="36" width="8" height="4" fill="#DAA520"/>
      <rect x="16" y="40" width="16" height="3" rx="1" fill="#DAA520"/>
      <text x="24" y="26" text-anchor="middle" font-size="14" font-weight="bold" fill="#8B6914">#1</text>
    </svg>
    <div style="font-size:20px;font-weight:bold;color:#FFD700;text-shadow:0 0 20px rgba(255,215,0,0.5);">Hall of Fame</div>
  </div>`;

  // Podium blocks
  html += `<div style="display:flex;align-items:flex-end;gap:8px;">`;

  for (const i of order) {
    const node = top3[i];
    if (!node) continue;
    const isGold = i === 0;
    const w = isGold ? 170 : 140;
    const floatDelay = [0, 0.3, 0.6][i];

    html += `<div style="display:flex;flex-direction:column;align-items:center;width:${w}px;animation:ns-float 3s ease-in-out ${floatDelay}s infinite;">
      <div style="margin-bottom:-4px;">${characters[i]}</div>
      <div style="font-size:${isGold ? 13 : 11}px;color:#fff;text-align:center;word-break:break-all;max-width:${w - 10}px;margin-bottom:4px;${isGold ? "font-weight:bold;text-shadow:0 0 10px rgba(255,215,0,0.4);" : ""}">${escapeHtml(node.class_type)}</div>
      <div style="font-size:10px;color:#666;margin-bottom:6px;">${escapeHtml(node.pkg)}</div>
      <div style="width:100%;height:${heights[i]}px;background:linear-gradient(to top,${colors[i]}22,${colors[i]}88);border:1px solid ${colors[i]}66;border-bottom:none;border-radius:8px 8px 0 0;display:flex;align-items:center;justify-content:center;flex-direction:column;backdrop-filter:blur(4px);">
        <div style="font-size:${isGold ? 32 : 24}px;font-weight:bold;color:${colors[i]};text-shadow:0 0 15px ${colors[i]}66;">${i + 1}${["st","nd","rd"][i]}</div>
        <div style="font-size:16px;color:#fff;opacity:0.8;margin-top:4px;">${node.count.toLocaleString()}x</div>
      </div>
    </div>`;
  }

  html += `</div>`;
  html += `<div style="color:#444;font-size:10px;margin-top:12px;">click to dismiss</div>`;

  podium.innerHTML = html;
  overlay.querySelector("div").style.position = "relative";
  overlay.querySelector("div").appendChild(podium);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Escape a value for use inside a double-quoted HTML attribute.
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

// Escape a string for use in a CSS attribute selector.
function cssEscape(str) {
  return window.CSS && CSS.escape ? CSS.escape(str) : String(str).replace(/["\\]/g, "\\$&");
}
