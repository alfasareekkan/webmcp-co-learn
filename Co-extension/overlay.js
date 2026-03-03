// CoLearn Agent — On-Page Guidance Overlay
// Non-blocking: all visual elements pass clicks through to the page.
// Only the compact control pill in the corner captures pointer events.

(function () {
  "use strict";

  const _DASHBOARD_HOST = (typeof COLEARN_CONFIG !== "undefined")
    ? COLEARN_CONFIG.dashboardHost : "localhost:5173";
  if (location.host === _DASHBOARD_HOST) return;
  // Guard against double-injection when scripts are injected programmatically
  if (window.__colearn_overlay_injected__) return;
  window.__colearn_overlay_injected__ = true;

  const HIGHLIGHT_COLORS = ["#FF3B6F", "#00BCD4", "#FF9800", "#4CAF50", "#9C27B0", "#2196F3"];

  let currentGuides = [];
  let stepIndex = 0;
  let fadeTimer = null;
  let dismissed = false;
  let currentStepInfo = { stepNumber: 0, totalSteps: 0, instruction: "", taskSummary: "" };
  let progressMinimized = false;
  let progressPanel = null;

  function injectStyles() {
    if (document.getElementById("__colearn_styles__")) return;
    const style = document.createElement("style");
    style.id = "__colearn_styles__";
    style.textContent = `
      /* --- Highlight ring around elements (click-through) --- */
      .__colearn_highlight {
        position: fixed;
        border-radius: 4px;
        pointer-events: none;
        box-sizing: border-box;
        animation: __cl_fadeIn 0.25s ease, __cl_pulse 2s ease-in-out infinite;
        transition: opacity 0.4s ease;
      }
      @keyframes __cl_pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.4); }
        50% { box-shadow: 0 0 0 8px rgba(76, 175, 80, 0); }
      }

      /* --- Small numbered circle at corner (click-through) --- */
      .__colearn_pin {
        position: fixed;
        width: 22px;
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        font-family: -apple-system, "Inter", "Segoe UI", Roboto, sans-serif;
        font-size: 11px;
        font-weight: 800;
        color: #fff;
        pointer-events: none;
        z-index: 2147483647;
        box-shadow: 0 1px 6px rgba(0,0,0,0.35);
        animation: __cl_popIn 0.3s ease;
        transition: opacity 0.4s ease;
      }

      /* --- Compact label (appears next to pin, click-through) --- */
      .__colearn_label {
        position: fixed;
        pointer-events: none;
        font-family: -apple-system, "Inter", "Segoe UI", Roboto, sans-serif;
        font-size: 11px;
        font-weight: 600;
        color: #fff;
        padding: 2px 8px;
        border-radius: 4px;
        white-space: nowrap;
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        z-index: 2147483647;
        box-shadow: 0 1px 4px rgba(0,0,0,0.3);
        animation: __cl_fadeIn 0.3s ease;
        transition: opacity 0.4s ease;
      }

      /* --- Arrow connectors (click-through) --- */
      .__colearn_arrow_svg {
        position: fixed;
        z-index: 2147483646;
        pointer-events: none;
        overflow: visible;
        transition: opacity 0.4s ease;
      }

      /* --- Floating control pill (only interactive element) --- */
      .__colearn_pill {
        position: fixed;
        bottom: 16px;
        right: 16px;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: rgba(26, 29, 36, 0.92);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 24px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        z-index: 2147483647;
        pointer-events: auto;
        animation: __cl_slideUp 0.3s ease;
        font-family: -apple-system, "Inter", "Segoe UI", Roboto, sans-serif;
      }

      .__colearn_pill_label {
        font-size: 11px;
        color: #8a8f9c;
        white-space: nowrap;
      }

      .__colearn_pill_btn {
        padding: 4px 10px;
        border: none;
        border-radius: 14px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s;
        color: #fff;
      }

      .__colearn_pill_btn:hover { filter: brightness(1.15); }

      .__colearn_pill_step  { background: #6c5ce7; }
      .__colearn_pill_nav   { background: #6c5ce7; }
      .__colearn_pill_all   { background: #00BCD4; }
      .__colearn_pill_close {
        background: none;
        border: none;
        padding: 4px;
        cursor: pointer;
        color: #666;
        display: flex;
        align-items: center;
        font-size: 0;
        transition: color 0.15s;
      }
      .__colearn_pill_close:hover { color: #fff; }

      /* --- Tooltip (only in step mode, click-through) --- */
      .__colearn_tooltip {
        position: fixed;
        max-width: 240px;
        padding: 8px 12px;
        border-radius: 8px;
        background: rgba(26, 29, 36, 0.94);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        color: #e4e8f0;
        font-family: -apple-system, "Inter", "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        line-height: 1.4;
        box-shadow: 0 4px 16px rgba(0,0,0,0.35);
        pointer-events: none;
        z-index: 2147483647;
        animation: __cl_fadeIn 0.2s ease;
        border: 1px solid rgba(255,255,255,0.06);
        transition: opacity 0.4s ease;
      }

      .__colearn_tooltip_reason {
        margin-top: 3px;
        font-size: 10px;
        color: #8a8f9c;
      }

      /* --- Faded state --- */
      .__colearn_faded {
        opacity: 0.35 !important;
      }

      @keyframes __cl_fadeIn {
        from { opacity: 0; }
        to   { opacity: 1; }
      }

      @keyframes __cl_popIn {
        from { opacity: 0; transform: scale(0.5); }
        to   { opacity: 1; transform: scale(1); }
      }

      @keyframes __cl_slideUp {
        from { opacity: 0; transform: translateY(12px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      /* --- Top-right step progress panel --- */
      .__colearn_progress {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        pointer-events: auto;
        max-width: 264px;
        font-family: -apple-system, "Inter", "Segoe UI", Roboto, sans-serif;
        animation: __cl_slideDown 0.3s ease;
      }

      @keyframes __cl_slideDown {
        from { opacity: 0; transform: translateY(-10px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      .__colearn_progress_header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 12px;
        background: rgba(26, 29, 36, 0.93);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid rgba(255,255,255,0.09);
        border-radius: 10px;
        cursor: pointer;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        transition: background 0.15s;
        user-select: none;
      }

      .__colearn_progress_header:hover { background: rgba(36, 40, 52, 0.95); }

      .__colearn_progress_logo {
        font-size: 12px;
        flex-shrink: 0;
      }

      .__colearn_progress_summary {
        flex: 1;
        font-size: 11px;
        font-weight: 600;
        color: #e4e8f0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .__colearn_progress_toggle {
        font-size: 9px;
        color: #8a8f9c;
        transition: transform 0.2s;
        flex-shrink: 0;
      }

      .__colearn_progress.minimized .__colearn_progress_toggle {
        transform: rotate(180deg);
      }

      .__colearn_progress_body {
        margin-top: 4px;
        padding: 10px 12px;
        background: rgba(26, 29, 36, 0.93);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid rgba(255,255,255,0.09);
        border-radius: 10px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        animation: __cl_fadeIn 0.2s ease;
      }

      .__colearn_progress.minimized .__colearn_progress_body {
        display: none;
      }

      .__colearn_progress_dots {
        display: flex;
        align-items: center;
        gap: 5px;
        margin-bottom: 8px;
      }

      .__colearn_dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        transition: all 0.3s;
        flex-shrink: 0;
      }

      .__colearn_dot.done   { background: #4CAF50; }
      .__colearn_dot.current {
        background: #6c5ce7;
        animation: __cl_dot_pulse 1.2s ease-in-out infinite;
      }
      .__colearn_dot.pending {
        background: rgba(255,255,255,0.18);
        border: 1px solid rgba(255,255,255,0.12);
      }

      @keyframes __cl_dot_pulse {
        0%, 100% { transform: scale(1);   box-shadow: 0 0 0 0   rgba(108,92,231,0.5); }
        50%       { transform: scale(1.35); box-shadow: 0 0 0 5px rgba(108,92,231,0);   }
      }

      .__colearn_progress_instr {
        font-size: 12px;
        font-weight: 500;
        color: #e4e8f0;
        line-height: 1.4;
        margin-bottom: 7px;
      }

      .__colearn_progress_status {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 10px;
        color: #8a8f9c;
      }

      .__colearn_status_dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: #4CAF50;
        flex-shrink: 0;
        animation: __cl_status_pulse 1.5s ease-in-out infinite;
      }

      @keyframes __cl_status_pulse {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.25; }
      }
    `;
    document.head.appendChild(style);
  }

  // ---- Cleanup ----
  function removeOverlay() {
    document.querySelectorAll(
      ".__colearn_highlight, .__colearn_pin, .__colearn_label, " +
      ".__colearn_tooltip, .__colearn_arrow_svg, .__colearn_pill"
    ).forEach((el) => el.remove());
    removeProgressPanel();
    clearTimeout(fadeTimer);
    currentGuides = [];
    stepIndex = 0;
    dismissed = false;
  }

  function setFaded(faded) {
    document.querySelectorAll(
      ".__colearn_highlight, .__colearn_pin, .__colearn_label, " +
      ".__colearn_tooltip, .__colearn_arrow_svg"
    ).forEach((el) => el.classList.toggle("__colearn_faded", faded));
  }

  // ---- Top-right step progress panel ----
  function renderProgressPanel(stepNumber, totalSteps, instruction, taskSummary) {
    removeProgressPanel();

    progressPanel = document.createElement("div");
    progressPanel.className = "__colearn_progress" + (progressMinimized ? " minimized" : "");

    // Clickable header — shows task summary, click toggles expand/collapse
    const header = document.createElement("div");
    header.className = "__colearn_progress_header";

    const logo = document.createElement("span");
    logo.className = "__colearn_progress_logo";
    logo.textContent = "◈";

    const summary = document.createElement("span");
    summary.className = "__colearn_progress_summary";
    summary.textContent = taskSummary || `Step ${stepNumber} of ${totalSteps}`;
    summary.title = taskSummary || "";

    const toggle = document.createElement("span");
    toggle.className = "__colearn_progress_toggle";
    toggle.textContent = "▲";

    header.append(logo, summary, toggle);
    header.onclick = () => {
      progressMinimized = !progressMinimized;
      progressPanel.classList.toggle("minimized", progressMinimized);
    };

    // Body — dots + instruction + waiting indicator
    const body = document.createElement("div");
    body.className = "__colearn_progress_body";

    const dotsEl = document.createElement("div");
    dotsEl.className = "__colearn_progress_dots";
    for (let i = 1; i <= totalSteps; i++) {
      const dot = document.createElement("span");
      const cls = i < stepNumber ? "done" : i === stepNumber ? "current" : "pending";
      dot.className = `__colearn_dot ${cls}`;
      dotsEl.appendChild(dot);
    }

    const instr = document.createElement("div");
    instr.className = "__colearn_progress_instr";
    instr.textContent = instruction || "";

    const status = document.createElement("div");
    status.className = "__colearn_progress_status";
    const sDot = document.createElement("span");
    sDot.className = "__colearn_status_dot";
    const sTxt = document.createElement("span");
    sTxt.textContent = "Waiting for you\u2026";
    status.append(sDot, sTxt);

    body.append(dotsEl, instr, status);
    progressPanel.append(header, body);
    document.body.appendChild(progressPanel);
  }

  function removeProgressPanel() {
    if (progressPanel) {
      progressPanel.remove();
      progressPanel = null;
    }
    // Fallback: remove any orphaned panels
    document.querySelectorAll(".__colearn_progress").forEach((el) => el.remove());
  }

  function updateProgressPanel() {
    if (!progressPanel) return;
    // Update dots
    const dots = progressPanel.querySelectorAll(".__colearn_dot");
    dots.forEach((dot, i) => {
      const stepNum = i + 1;
      dot.className = `__colearn_dot ${
        stepNum < currentStepInfo.stepNumber ? "done"
        : stepNum === currentStepInfo.stepNumber ? "current"
        : "pending"
      }`;
    });
    // Update instruction
    const instr = progressPanel.querySelector(".__colearn_progress_instr");
    if (instr && currentStepInfo.instruction) instr.textContent = currentStepInfo.instruction;
    // Update summary
    const sum = progressPanel.querySelector(".__colearn_progress_summary");
    if (sum && currentStepInfo.taskSummary) sum.textContent = currentStepInfo.taskSummary;
  }

  // ---- Element bounds ----
  // Prefer live DOM lookup via selector for accurate viewport-relative positions.
  // Falls back to the cached bounds from the server (which may be stale if the
  // user scrolled or the layout changed since context was gathered).
  function getElementBounds(guide) {
    if (guide.selector) {
      try {
        const el = document.querySelector(guide.selector);
        if (el) {
          const rect = el.getBoundingClientRect();
          // Verify the element is visible (non-zero dimensions)
          if (rect.width > 0 && rect.height > 0) return rect;
        }
      } catch (e) {
        // Invalid selector — fall through to bounds
      }
    }
    return guide.bounds || null;
  }

  // ---- Render a single guide ----
  function renderSingleGuide(guide, index, _total, showTooltip) {
    const bounds = getElementBounds(guide);
    if (!bounds) return;

    const color = guide.color || HIGHLIGHT_COLORS[index % HIGHLIGHT_COLORS.length];

    // Thin dashed outline — fully click-through
    const hl = document.createElement("div");
    hl.className = "__colearn_highlight";
    hl.style.cssText = `
      left: ${bounds.x - 3}px;
      top: ${bounds.y - 3}px;
      width: ${bounds.width + 6}px;
      height: ${bounds.height + 6}px;
      border: 2px dashed ${color};
      background: ${color}08;
    `;
    document.body.appendChild(hl);

    // Small numbered circle pinned to top-left corner
    const pin = document.createElement("div");
    pin.className = "__colearn_pin";
    pin.style.cssText = `
      left: ${bounds.x - 11}px;
      top: ${bounds.y - 11}px;
      background: ${color};
    `;
    pin.textContent = String(index + 1);
    document.body.appendChild(pin);

    // Compact label next to the pin
    if (guide.label) {
      const lbl = document.createElement("div");
      lbl.className = "__colearn_label";
      lbl.style.cssText = `
        left: ${bounds.x + 14}px;
        top: ${Math.max(0, bounds.y - 12)}px;
        background: ${color}dd;
      `;
      lbl.textContent = guide.label;
      document.body.appendChild(lbl);
    }

    // Tooltip: only shown in step-by-step mode
    if (showTooltip && guide.reason) {
      const tt = document.createElement("div");
      tt.className = "__colearn_tooltip";
      const ttX = bounds.x + bounds.width + 10;
      const ttY = bounds.y + bounds.height / 2 - 20;
      tt.style.left = `${Math.min(ttX, window.innerWidth - 260)}px`;
      tt.style.top = `${Math.max(8, ttY)}px`;
      tt.innerHTML = `
        <div style="font-weight:700;color:${color}">${escapeHtml(guide.label || `Step ${index + 1}`)}</div>
        <div class="__colearn_tooltip_reason">${escapeHtml(guide.reason)}</div>
      `;
      document.body.appendChild(tt);
    }

    // Scroll into view
    if (guide.selector) {
      const el = document.querySelector(guide.selector);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    }
  }

  // ---- Arrows between guides ----
  function renderArrow(from, to, color) {
    const fb = getElementBounds(from);
    const tb = getElementBounds(to);
    if (!fb || !tb) return;

    const x1 = fb.x + fb.width / 2, y1 = fb.y + fb.height + 4;
    const x2 = tb.x + tb.width / 2, y2 = tb.y - 4;

    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.classList.add("__colearn_arrow_svg");

    const pad = 20;
    const minX = Math.min(x1, x2) - pad, minY = Math.min(y1, y2) - pad;
    const maxX = Math.max(x1, x2) + pad, maxY = Math.max(y1, y2) + pad;
    svg.style.left = `${minX}px`;
    svg.style.top  = `${minY}px`;
    svg.style.width  = `${maxX - minX}px`;
    svg.style.height = `${maxY - minY}px`;
    svg.setAttribute("viewBox", `0 0 ${maxX - minX} ${maxY - minY}`);

    const lx1 = x1 - minX, ly1 = y1 - minY;
    const lx2 = x2 - minX, ly2 = y2 - minY;
    const midY = (ly1 + ly2) / 2;

    const markerId = `__cl_arr_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
    const defs = document.createElementNS(ns, "defs");
    const marker = document.createElementNS(ns, "marker");
    marker.setAttribute("id", markerId);
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "5");
    marker.setAttribute("refX", "7");
    marker.setAttribute("refY", "2.5");
    marker.setAttribute("orient", "auto");
    const poly = document.createElementNS(ns, "polygon");
    poly.setAttribute("points", "0 0, 7 2.5, 0 5");
    poly.setAttribute("fill", color);
    marker.appendChild(poly);
    defs.appendChild(marker);
    svg.appendChild(defs);

    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", `M${lx1},${ly1} C${lx1},${midY} ${lx2},${midY} ${lx2},${ly2}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-dasharray", "5,4");
    path.setAttribute("stroke-opacity", "0.6");
    path.setAttribute("marker-end", `url(#${markerId})`);
    svg.appendChild(path);
    document.body.appendChild(svg);
  }

  // ---- Clear visuals only (keep pill & state) ----
  function clearVisuals() {
    document.querySelectorAll(
      ".__colearn_highlight, .__colearn_pin, .__colearn_label, " +
      ".__colearn_tooltip, .__colearn_arrow_svg"
    ).forEach((el) => el.remove());
  }

  // ---- Show all guides at once ----
  function showAllGuides(guides) {
    removeOverlay();
    injectStyles();
    currentGuides = guides;
    dismissed = false;

    guides.forEach((g, i) => renderSingleGuide(g, i, guides.length, false));
    for (let i = 0; i < guides.length - 1; i++) {
      renderArrow(guides[i], guides[i + 1], HIGHLIGHT_COLORS[i % HIGHLIGHT_COLORS.length]);
    }

    renderPill(guides, -1);
    startFadeTimer();
  }

  // ---- Step-by-step mode ----
  function showStep(guides, idx) {
    const doRender = () => {
      clearVisuals();
      if (idx < 0 || idx >= guides.length) return;
      stepIndex = idx;
      clearTimeout(fadeTimer);
      renderSingleGuide(guides[idx], idx, guides.length, true);
      if (idx > 0) {
        renderArrow(guides[idx - 1], guides[idx], HIGHLIGHT_COLORS[(idx - 1) % HIGHLIGHT_COLORS.length]);
      }
      renderPill(guides, idx);
      if (progressPanel) updateProgressPanel();
    };

    const existing = document.querySelectorAll(
      ".__colearn_highlight, .__colearn_pin, .__colearn_label, " +
      ".__colearn_tooltip, .__colearn_arrow_svg"
    );

    if (existing.length > 0) {
      existing.forEach((el) => {
        el.style.transition = "opacity 0.2s ease";
        el.style.opacity = "0";
      });
      setTimeout(doRender, 220);
    } else {
      doRender();
    }
  }

  // ---- Auto-fade after 6 seconds so overlay fades to subtle ----
  function startFadeTimer() {
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => setFaded(true), 6000);
  }

  // ---- Compact control pill in bottom-right ----
  function renderPill(guides, activeStep) {
    document.querySelectorAll(".__colearn_pill").forEach((el) => el.remove());

    const pill = document.createElement("div");
    pill.className = "__colearn_pill";
    const isStepMode = activeStep >= 0;

    if (isStepMode) {
      const total = currentStepInfo.totalSteps || guides.length;
      const num = currentStepInfo.stepNumber || activeStep + 1;
      const instr = currentStepInfo.instruction || "";
      // Step-by-step controls
      const prevBtn = document.createElement("button");
      prevBtn.className = "__colearn_pill_btn __colearn_pill_nav";
      prevBtn.textContent = "\u25C0";
      prevBtn.disabled = activeStep <= 0;
      prevBtn.style.opacity = activeStep <= 0 ? "0.3" : "1";
      prevBtn.onclick = () => showStep(guides, activeStep - 1);

      const stepLabel = document.createElement("span");
      stepLabel.className = "__colearn_pill_label";
      stepLabel.textContent = instr ? `Step ${num} of ${total}: ${instr}` : `${num}/${total}`;
      stepLabel.title = instr || "";

      const nextBtn = document.createElement("button");
      nextBtn.className = "__colearn_pill_btn __colearn_pill_nav";
      nextBtn.textContent = "\u25B6";
      nextBtn.disabled = activeStep >= guides.length - 1;
      nextBtn.style.opacity = activeStep >= guides.length - 1 ? "0.3" : "1";
      nextBtn.onclick = () => showStep(guides, activeStep + 1);

      const allBtn = document.createElement("button");
      allBtn.className = "__colearn_pill_btn __colearn_pill_all";
      allBtn.textContent = "All";
      allBtn.onclick = () => showAllGuides(guides);

      pill.append(prevBtn, stepLabel, nextBtn, allBtn);
    } else {
      const label = document.createElement("span");
      label.className = "__colearn_pill_label";
      label.textContent = `${guides.length} highlighted`;

      const stepBtn = document.createElement("button");
      stepBtn.className = "__colearn_pill_btn __colearn_pill_step";
      stepBtn.textContent = "Steps";
      stepBtn.onclick = () => showStep(guides, 0);

      pill.append(label, stepBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "__colearn_pill_close";
    closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    closeBtn.title = "Dismiss guidance";
    closeBtn.onclick = removeOverlay;
    pill.appendChild(closeBtn);

    // Hover on pill un-fades the visuals
    pill.addEventListener("mouseenter", () => setFaded(false));
    pill.addEventListener("mouseleave", () => {
      if (!dismissed && activeStep < 0) startFadeTimer();
    });

    document.body.appendChild(pill);
  }

  // ---- Keyboard shortcut: Escape dismisses overlay ----
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && currentGuides.length > 0) {
      removeOverlay();
    }
  });

  // ---- Message listener from background script ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "SHOW_GUIDANCE") {
      showAllGuides(msg.guides || []);
      sendResponse({ ok: true });
    } else if (msg.type === "CLEAR_GUIDANCE") {
      removeOverlay();
      sendResponse({ ok: true });
    } else if (msg.type === "STEP_GUIDANCE") {
      if (msg.stepNumber != null) currentStepInfo.stepNumber = msg.stepNumber;
      if (msg.totalSteps != null) currentStepInfo.totalSteps = msg.totalSteps;
      if (msg.instruction != null) currentStepInfo.instruction = msg.instruction;
      if (msg.taskSummary != null) currentStepInfo.taskSummary = msg.taskSummary;
      renderProgressPanel(
        currentStepInfo.stepNumber,
        currentStepInfo.totalSteps,
        currentStepInfo.instruction,
        currentStepInfo.taskSummary
      );
      showStep(currentGuides, msg.step ?? 0);
      sendResponse({ ok: true });
    }
  });

  // ---- Custom event bridge for Electron (desktop CDP path) ----
  // In Electron, chrome.tabs.sendMessage from background → content is unreliable.
  // The desktop injects guidance via wc.executeJavaScript → dispatchEvent instead.
  window.addEventListener("__colearn_guidance__", (e) => {
    const msg = e.detail;
    if (!msg) return;
    if (msg.type === "SHOW_GUIDANCE") {
      showAllGuides(msg.guides || []);
    } else if (msg.type === "CLEAR_GUIDANCE") {
      removeOverlay();
    } else if (msg.type === "STEP_GUIDANCE") {
      if (msg.stepNumber != null) currentStepInfo.stepNumber = msg.stepNumber;
      if (msg.totalSteps != null) currentStepInfo.totalSteps = msg.totalSteps;
      if (msg.instruction != null) currentStepInfo.instruction = msg.instruction;
      if (msg.taskSummary != null) currentStepInfo.taskSummary = msg.taskSummary;
      renderProgressPanel(
        currentStepInfo.stepNumber,
        currentStepInfo.totalSteps,
        currentStepInfo.instruction,
        currentStepInfo.taskSummary
      );
      showStep(currentGuides, msg.step ?? 0);
    }
  });

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }
})();
