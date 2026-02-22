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

app.registerExtension({
  name: "comfyui.nodes_stats",

  async setup() {
    try {
      const { ComfyButton } = await import(
        "../../scripts/ui/components/button.js"
      );

      const btn = new ComfyButton({
        icon: "bar-chart-2",
        content: "Node Stats",
        tooltip: "Show node and package usage statistics",
        action: () => showStatsDialog(),
        classList: "comfyui-button comfyui-menu-mobile-collapse",
      });

      app.menu?.settingsGroup.element.before(btn.element);
    } catch (e) {
      console.log(
        "[nodes-stats] New menu API unavailable, falling back to legacy menu",
        e
      );

      const btn = document.createElement("button");
      btn.innerHTML = STATS_ICON;
      btn.title = "Node Stats";
      btn.onclick = () => showStatsDialog();
      btn.style.cssText =
        "display:flex;align-items:center;justify-content:center;padding:6px;background:none;border:none;cursor:pointer;color:var(--input-text,#ddd);";

      const menu = document.querySelector(".comfy-menu");
      if (menu) {
        menu.append(btn);
      }
    }
  },
});

async function showStatsDialog() {
  let data;
  try {
    const resp = await fetch("/nodes-stats/packages");
    if (!resp.ok) {
      alert("Failed to load node stats: HTTP " + resp.status);
      return;
    }
    data = await resp.json();
    if (!Array.isArray(data)) {
      alert("Failed to load node stats: unexpected response format");
      return;
    }
  } catch (e) {
    alert("Failed to load node stats: " + e.message);
    return;
  }

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

  const custom = data.filter((p) => p.package !== "__builtin__");
  const safeToRemove = custom.filter((p) => p.status === "safe_to_remove");
  const considerRemoving = custom.filter((p) => p.status === "consider_removing");
  const unusedNew = custom.filter((p) => p.status === "unused_new");
  const used = custom.filter((p) => p.status === "used");

  let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
    <h2 style="margin:0;color:#fff;font-size:18px;">Node Package Stats</h2>
    <button id="nodes-stats-close" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer;">&times;</button>
  </div>`;

  html += `<div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
    <div style="background:#3a1a1a;padding:8px 14px;border-radius:4px;border-left:3px solid #e44;">
      <span style="font-size:20px;font-weight:bold;color:#e44;">${safeToRemove.length}</span>
      <span style="color:#c99;margin-left:6px;">safe to remove</span>
    </div>
    <div style="background:#2a2215;padding:8px 14px;border-radius:4px;border-left:3px solid #e90;">
      <span style="font-size:20px;font-weight:bold;color:#e90;">${considerRemoving.length}</span>
      <span style="color:#ca8;margin-left:6px;">consider removing</span>
    </div>
    <div style="background:#1a1a2a;padding:8px 14px;border-radius:4px;border-left:3px solid #68f;">
      <span style="font-size:20px;font-weight:bold;color:#68f;">${unusedNew.length}</span>
      <span style="color:#99b;margin-left:6px;">unused &lt;1 month</span>
    </div>
    <div style="background:#1a2a1a;padding:8px 14px;border-radius:4px;border-left:3px solid #4a4;">
      <span style="font-size:20px;font-weight:bold;color:#4a4;">${used.length}</span>
      <span style="color:#9c9;margin-left:6px;">used</span>
    </div>
  </div>`;

  if (safeToRemove.length > 0) {
    html += sectionHeader("Safe to Remove", "Unused for 2+ months", "#e44");
    html += buildTable(safeToRemove, "safe_to_remove");
  }

  if (considerRemoving.length > 0) {
    html += sectionHeader("Consider Removing", "Unused for 1-2 months", "#e90");
    html += buildTable(considerRemoving, "consider_removing");
  }

  if (unusedNew.length > 0) {
    html += sectionHeader("Recently Unused", "Unused for less than 1 month", "#68f");
    html += buildTable(unusedNew, "unused_new");
  }

  if (used.length > 0) {
    html += sectionHeader("Used", "", "#4a4");
    html += buildTable(used, "used");
  }

  dialog.innerHTML = html;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  document
    .getElementById("nodes-stats-close")
    .addEventListener("click", () => overlay.remove());

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
}

function sectionHeader(title, subtitle, color) {
  let html = `<h3 style="color:${color};margin:16px 0 8px;font-size:14px;">${title}`;
  if (subtitle) html += ` <span style="color:#666;font-size:12px;font-weight:normal;">— ${subtitle}</span>`;
  html += `</h3>`;
  return html;
}

const STATUS_COLORS = {
  safe_to_remove:    { bg: "#2a1515", hover: "#3a2020" },
  consider_removing: { bg: "#2a2215", hover: "#3a2e20" },
  unused_new:        { bg: "#1a1a25", hover: "#252530" },
  used:              { bg: "#151a15", hover: "#202a20" },
};

function buildTable(packages, status) {
  const { bg: bgColor, hover: hoverColor } = STATUS_COLORS[status] || STATUS_COLORS.used;

  let html = `<table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
    <thead><tr style="color:#888;text-align:left;border-bottom:1px solid #333;">
      <th style="padding:6px 8px;"></th>
      <th style="padding:6px 8px;">Package</th>
      <th style="padding:6px 8px;text-align:right;">Nodes</th>
      <th style="padding:6px 8px;text-align:right;">Used</th>
      <th style="padding:6px 8px;text-align:right;">Executions</th>
      <th style="padding:6px 8px;">Last Used</th>
    </tr></thead><tbody>`;

  for (const pkg of packages) {
    const hasNodes = pkg.nodes && pkg.nodes.length > 0;
    const lastSeen = pkg.last_seen
      ? new Date(pkg.last_seen).toLocaleDateString()
      : "—";

    html += `<tr class="pkg-row" style="cursor:${hasNodes ? "pointer" : "default"};background:${bgColor};border-bottom:1px solid #222;"
      onmouseover="this.style.background='${hoverColor}'" onmouseout="this.style.background='${bgColor}'">
      <td style="padding:6px 8px;width:20px;"><span class="arrow" style="color:#666;">${hasNodes ? "▶" : " "}</span></td>
      <td style="padding:6px 8px;color:#fff;">${escapeHtml(pkg.package)}</td>
      <td style="padding:6px 8px;text-align:right;">${pkg.total_nodes}</td>
      <td style="padding:6px 8px;text-align:right;">${pkg.used_nodes}/${pkg.total_nodes}</td>
      <td style="padding:6px 8px;text-align:right;">${pkg.total_executions}</td>
      <td style="padding:6px 8px;color:#888;">${lastSeen}</td>
    </tr>`;

    if (hasNodes) {
      html += `<tr class="pkg-detail" style="display:none;"><td colspan="6" style="padding:0 0 0 32px;">
        <table style="width:100%;border-collapse:collapse;">`;
      for (const node of pkg.nodes) {
        const nLastSeen = node.last_seen
          ? new Date(node.last_seen).toLocaleDateString()
          : "—";
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
