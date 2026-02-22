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
  const uninstalled = custom.filter((p) => p.status === "uninstalled");

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
    <div id="nodes-stats-used-badge" style="background:#1a2a1a;padding:8px 14px;border-radius:4px;border-left:3px solid #4a4;cursor:default;user-select:none;">
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

  if (uninstalled.length > 0) {
    html += sectionHeader("Uninstalled", "Previously tracked, no longer installed", "#555");
    html += buildTable(uninstalled, "uninstalled");
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

  // Easter egg: click "used" badge 5 times to show podium
  let eggClicks = 0;
  let eggTimer = null;
  const usedBadge = document.getElementById("nodes-stats-used-badge");
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
  uninstalled:       { bg: "#1a1a1a", hover: "#252525" },
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
