// CoLearn Agent — On-Page Guidance Overlay
// Renders visual guides (highlights, arrows, step badges, tooltips) directly
// on the website the user is browsing. Driven by messages from the background script.

(function () {
  "use strict";

  if (location.host === "localhost:5173") return;

  const OVERLAY_ID = "__colearn_overlay__";
  const HIGHLIGHT_COLORS = ["#FF3B6F", "#00BCD4", "#FF9800", "#4CAF50", "#9C27B0", "#2196F3"];

  let currentOverlay = null;
  let currentGuides = [];
  let stepIndex = 0;
  let autoAdvanceTimer = null;

  function injectStyles() {
    if (document.getElementById("__colearn_styles__")) return;
    const style = document.createElement("style");
    style.id = "__colearn_styles__";
    style.textContent = `
      .__colearn_overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        pointer-events: none;
      }

      .__colearn_highlight {
        position: fixed;
        border-radius: 6px;
        pointer-events: none;
        animation: __cl_fadeIn 0.3s ease, __cl_pulse 2s ease-in-out infinite;
        box-sizing: border-box;
      }

      .__colearn_badge {
        position: fixed;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 20px;
        font-family: -apple-system, "Inter", "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        font-weight: 700;
        color: #fff;
        white-space: nowrap;
        pointer-events: auto;
        cursor: pointer;
        z-index: 2147483647;
        box-shadow: 0 2px 12px rgba(0,0,0,0.3);
        animation: __cl_slideIn 0.35s ease;
        transition: transform 0.15s ease;
      }

      .__colearn_badge:hover {
        transform: scale(1.08);
      }

      .__colearn_badge_num {
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        background: rgba(255,255,255,0.25);
        font-size: 11px;
        font-weight: 800;
      }

      .__colearn_tooltip {
        position: fixed;
        max-width: 280px;
        padding: 10px 14px;
        border-radius: 10px;
        background: #1a1d24;
        color: #e4e8f0;
        font-family: -apple-system, "Inter", "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.5;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        pointer-events: auto;
        z-index: 2147483647;
        animation: __cl_fadeIn 0.25s ease;
        border: 1px solid #2a2d35;
      }

      .__colearn_tooltip_reason {
        margin-top: 4px;
        font-size: 11px;
        color: #8a8f9c;
      }

      .__colearn_arrow_svg {
        position: fixed;
        z-index: 2147483646;
        pointer-events: none;
        overflow: visible;
      }

      .__colearn_controls {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        background: #1a1d24;
        border: 1px solid #2a2d35;
        border-radius: 12px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.5);
        z-index: 2147483647;
        pointer-events: auto;
        animation: __cl_slideUp 0.3s ease;
        font-family: -apple-system, "Inter", "Segoe UI", Roboto, sans-serif;
      }

      .__colearn_ctrl_btn {
        padding: 6px 14px;
        border: none;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s;
        color: #fff;
      }

      .__colearn_ctrl_prev,
      .__colearn_ctrl_next {
        background: #6c5ce7;
      }

      .__colearn_ctrl_prev:hover,
      .__colearn_ctrl_next:hover {
        background: #7d6ff0;
      }

      .__colearn_ctrl_prev:disabled,
      .__colearn_ctrl_next:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }

      .__colearn_ctrl_close {
        background: #333740;
        color: #c4c8d4;
        border: 1px solid #444;
      }

      .__colearn_ctrl_close:hover {
        background: #444;
        color: #fff;
      }

      .__colearn_ctrl_step {
        font-size: 12px;
        color: #8a8f9c;
        padding: 0 8px;
        min-width: 60px;
        text-align: center;
      }

      .__colearn_ctrl_showall {
        background: #00BCD4;
      }

      .__colearn_ctrl_showall:hover {
        background: #00d4ef;
      }

      @keyframes __cl_fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      @keyframes __cl_slideIn {
        from { opacity: 0; transform: translateY(-8px) scale(0.95); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      @keyframes __cl_slideUp {
        from { opacity: 0; transform: translateX(-50%) translateY(20px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
      }

      @keyframes __cl_pulse {
        0%, 100% { box-shadow: 0 0 0 0 transparent; }
        50% { box-shadow: 0 0 0 4px var(--cl-glow, rgba(255,59,111,0.3)); }
      }
    `;
    document.head.appendChild(style);
  }

  function removeOverlay() {
    if (currentOverlay) {
      currentOverlay.remove();
      currentOverlay = null;
    }
    document.querySelectorAll(
      ".__colearn_highlight, .__colearn_badge, .__colearn_tooltip, .__colearn_arrow_svg, .__colearn_controls"
    ).forEach((el) => el.remove());
    clearTimeout(autoAdvanceTimer);
    currentGuides = [];
    stepIndex = 0;
  }

  function findElementByBounds(bounds) {
    if (!bounds) return null;
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const el = document.elementFromPoint(cx, cy);
    return el;
  }

  function getElementBounds(guide) {
    if (guide.selector) {
      const el = document.querySelector(guide.selector);
      if (el) return el.getBoundingClientRect();
    }
    if (guide.bounds) {
      return guide.bounds;
    }
    return null;
  }

  function renderSingleGuide(guide, index, total) {
    const bounds = getElementBounds(guide);
    if (!bounds) return;

    const color = guide.color || HIGHLIGHT_COLORS[index % HIGHLIGHT_COLORS.length];

    // Highlight box
    const highlight = document.createElement("div");
    highlight.className = "__colearn_highlight";
    highlight.style.cssText = `
      left: ${bounds.x - 4}px;
      top: ${bounds.y - 4}px;
      width: ${bounds.width + 8}px;
      height: ${bounds.height + 8}px;
      border: 3px solid ${color};
      background: ${color}15;
      --cl-glow: ${color}40;
    `;
    document.body.appendChild(highlight);

    // Numbered badge
    const badge = document.createElement("div");
    badge.className = "__colearn_badge";
    badge.style.cssText = `
      left: ${Math.max(0, bounds.x - 4)}px;
      top: ${Math.max(0, bounds.y - 36)}px;
      background: ${color};
    `;
    badge.innerHTML = `
      <span class="__colearn_badge_num">${index + 1}</span>
      <span>${escapeHtml(guide.label || `Step ${index + 1}`)}</span>
    `;
    badge.addEventListener("click", () => showTooltip(guide, bounds, color));
    document.body.appendChild(badge);

    // Tooltip (if reason provided)
    if (guide.reason) {
      const tooltip = document.createElement("div");
      tooltip.className = "__colearn_tooltip";
      const tooltipX = bounds.x + bounds.width + 12;
      const tooltipY = bounds.y;
      tooltip.style.left = `${Math.min(tooltipX, window.innerWidth - 300)}px`;
      tooltip.style.top = `${tooltipY}px`;
      tooltip.innerHTML = `
        <div><strong>${escapeHtml(guide.label || `Step ${index + 1}`)}</strong></div>
        <div class="__colearn_tooltip_reason">${escapeHtml(guide.reason)}</div>
      `;
      document.body.appendChild(tooltip);
    }

    // Scroll element into view
    const el = findElementByBounds(bounds);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    }
  }

  function renderArrowBetween(from, to, color) {
    const fromBounds = getElementBounds(from);
    const toBounds = getElementBounds(to);
    if (!fromBounds || !toBounds) return;

    const x1 = fromBounds.x + fromBounds.width / 2;
    const y1 = fromBounds.y + fromBounds.height + 4;
    const x2 = toBounds.x + toBounds.width / 2;
    const y2 = toBounds.y - 4;

    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.classList.add("__colearn_arrow_svg");

    const minX = Math.min(x1, x2) - 20;
    const minY = Math.min(y1, y2) - 20;
    const maxX = Math.max(x1, x2) + 20;
    const maxY = Math.max(y1, y2) + 20;

    svg.style.left = `${minX}px`;
    svg.style.top = `${minY}px`;
    svg.style.width = `${maxX - minX}px`;
    svg.style.height = `${maxY - minY}px`;
    svg.setAttribute("viewBox", `0 0 ${maxX - minX} ${maxY - minY}`);

    const lx1 = x1 - minX, ly1 = y1 - minY;
    const lx2 = x2 - minX, ly2 = y2 - minY;
    const midY = (ly1 + ly2) / 2;

    const path = document.createElementNS(svgNs, "path");
    path.setAttribute("d", `M${lx1},${ly1} C${lx1},${midY} ${lx2},${midY} ${lx2},${ly2}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color || "#6c5ce7");
    path.setAttribute("stroke-width", "2.5");
    path.setAttribute("stroke-dasharray", "6,4");

    const defs = document.createElementNS(svgNs, "defs");
    const marker = document.createElementNS(svgNs, "marker");
    marker.setAttribute("id", "__cl_arr");
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("refX", "8");
    marker.setAttribute("refY", "3");
    marker.setAttribute("orient", "auto");
    const poly = document.createElementNS(svgNs, "polygon");
    poly.setAttribute("points", "0 0, 8 3, 0 6");
    poly.setAttribute("fill", color || "#6c5ce7");
    marker.appendChild(poly);
    defs.appendChild(marker);
    svg.appendChild(defs);

    path.setAttribute("marker-end", "url(#__cl_arr)");
    svg.appendChild(path);
    document.body.appendChild(svg);
  }

  function showTooltip(guide, bounds, color) {
    document.querySelectorAll(".__colearn_tooltip").forEach((el) => el.remove());
    const tooltip = document.createElement("div");
    tooltip.className = "__colearn_tooltip";
    tooltip.style.left = `${Math.min(bounds.x + bounds.width + 12, window.innerWidth - 300)}px`;
    tooltip.style.top = `${bounds.y}px`;
    tooltip.innerHTML = `
      <div><strong style="color:${color}">${escapeHtml(guide.label || "")}</strong></div>
      ${guide.reason ? `<div class="__colearn_tooltip_reason">${escapeHtml(guide.reason)}</div>` : ""}
    `;
    document.body.appendChild(tooltip);
  }

  // Render all guides at once
  function showAllGuides(guides) {
    removeOverlay();
    injectStyles();
    currentGuides = guides;

    guides.forEach((guide, i) => {
      renderSingleGuide(guide, i, guides.length);
    });

    // Draw connecting arrows between sequential steps
    for (let i = 0; i < guides.length - 1; i++) {
      const color = HIGHLIGHT_COLORS[i % HIGHLIGHT_COLORS.length];
      renderArrowBetween(guides[i], guides[i + 1], color);
    }

    renderControls(guides, -1);
  }

  // Step-by-step mode
  function showStep(guides, idx) {
    document.querySelectorAll(
      ".__colearn_highlight, .__colearn_badge, .__colearn_tooltip, .__colearn_arrow_svg"
    ).forEach((el) => el.remove());

    if (idx < 0 || idx >= guides.length) return;
    stepIndex = idx;

    renderSingleGuide(guides[idx], idx, guides.length);

    if (idx > 0) {
      const color = HIGHLIGHT_COLORS[(idx - 1) % HIGHLIGHT_COLORS.length];
      renderArrowBetween(guides[idx - 1], guides[idx], color);
    }

    renderControls(guides, idx);
  }

  function renderControls(guides, activeStep) {
    document.querySelectorAll(".__colearn_controls").forEach((el) => el.remove());

    const controls = document.createElement("div");
    controls.className = "__colearn_controls";

    const isStepMode = activeStep >= 0;

    if (isStepMode) {
      const prev = document.createElement("button");
      prev.className = "__colearn_ctrl_btn __colearn_ctrl_prev";
      prev.textContent = "Prev";
      prev.disabled = activeStep <= 0;
      prev.onclick = () => showStep(guides, activeStep - 1);

      const stepLabel = document.createElement("span");
      stepLabel.className = "__colearn_ctrl_step";
      stepLabel.textContent = `Step ${activeStep + 1} of ${guides.length}`;

      const next = document.createElement("button");
      next.className = "__colearn_ctrl_btn __colearn_ctrl_next";
      next.textContent = "Next";
      next.disabled = activeStep >= guides.length - 1;
      next.onclick = () => showStep(guides, activeStep + 1);

      const showAll = document.createElement("button");
      showAll.className = "__colearn_ctrl_btn __colearn_ctrl_showall";
      showAll.textContent = "Show All";
      showAll.onclick = () => showAllGuides(guides);

      controls.append(prev, stepLabel, next, showAll);
    } else {
      const stepMode = document.createElement("button");
      stepMode.className = "__colearn_ctrl_btn __colearn_ctrl_next";
      stepMode.textContent = "Step-by-Step";
      stepMode.onclick = () => showStep(guides, 0);

      const label = document.createElement("span");
      label.className = "__colearn_ctrl_step";
      label.textContent = `${guides.length} elements highlighted`;

      controls.append(label, stepMode);
    }

    const close = document.createElement("button");
    close.className = "__colearn_ctrl_btn __colearn_ctrl_close";
    close.textContent = "Dismiss";
    close.onclick = removeOverlay;
    controls.appendChild(close);

    document.body.appendChild(controls);
  }

  // Message listener from background script
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "SHOW_GUIDANCE") {
      showAllGuides(msg.guides || []);
      sendResponse({ ok: true });
    } else if (msg.type === "CLEAR_GUIDANCE") {
      removeOverlay();
      sendResponse({ ok: true });
    } else if (msg.type === "STEP_GUIDANCE") {
      showStep(currentGuides, msg.step || 0);
      sendResponse({ ok: true });
    }
  });

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }
})();
