import { useRef, useState, useEffect, useCallback } from "react";
import "./DrawingCanvas.css";

const TOOLS = {
  PEN: "pen",
  ARROW: "arrow",
  RECT: "rect",
  CIRCLE: "circle",
  TEXT: "text",
  ERASER: "eraser",
};

const COLORS = [
  "#FF3B6F", "#00BCD4", "#FF9800", "#4CAF50",
  "#9C27B0", "#2196F3", "#FFFFFF", "#FFD600",
];

const SIZES = [2, 4, 6, 10];

export default function DrawingCanvas({ imageUrl, onSave, onClose }) {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const containerRef = useRef(null);

  const [tool, setTool] = useState(TOOLS.PEN);
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(4);
  const [drawing, setDrawing] = useState(false);
  const [history, setHistory] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [textInput, setTextInput] = useState(null);

  const startPos = useRef(null);
  const imgRef = useRef(null);
  const scaleRef = useRef(1);

  // Load image and set canvas size
  useEffect(() => {
    if (!imageUrl) return;
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const container = containerRef.current;
      if (!container) return;

      const containerW = container.clientWidth;
      const containerH = container.clientHeight;
      const scale = Math.min(containerW / img.width, containerH / img.height, 1);
      scaleRef.current = scale;

      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);

      const canvas = canvasRef.current;
      const overlay = overlayRef.current;
      canvas.width = w;
      canvas.height = h;
      overlay.width = w;
      overlay.height = h;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  const getPos = useCallback((e) => {
    const rect = overlayRef.current.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  const saveState = useCallback(() => {
    const canvas = canvasRef.current;
    setHistory((prev) => [...prev, canvas.toDataURL()]);
    setRedoStack([]);
  }, []);

  const redrawBase = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const img = imgRef.current;
    if (!img) return;
    const scale = scaleRef.current;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }, []);

  const undo = useCallback(() => {
    if (history.length === 0) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const last = history[history.length - 1];

    setRedoStack((prev) => [...prev, canvas.toDataURL()]);
    setHistory((prev) => prev.slice(0, -1));

    if (history.length === 1) {
      redrawBase();
    } else {
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
      };
      img.src = history[history.length - 2];
    }
  }, [history, redrawBase]);

  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const next = redoStack[redoStack.length - 1];

    setHistory((prev) => [...prev, canvas.toDataURL()]);
    setRedoStack((prev) => prev.slice(0, -1));

    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
    };
    img.src = next;
  }, [redoStack]);

  const clearAll = useCallback(() => {
    saveState();
    redrawBase();
  }, [saveState, redrawBase]);

  // Drawing
  const handleMouseDown = useCallback((e) => {
    if (tool === TOOLS.TEXT) {
      const pos = getPos(e);
      setTextInput(pos);
      return;
    }

    setDrawing(true);
    saveState();
    startPos.current = getPos(e);

    if (tool === TOOLS.PEN || tool === TOOLS.ERASER) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      ctx.beginPath();
      ctx.moveTo(startPos.current.x, startPos.current.y);
      ctx.strokeStyle = tool === TOOLS.ERASER ? "#000000" : color;
      ctx.lineWidth = tool === TOOLS.ERASER ? size * 4 : size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (tool === TOOLS.ERASER) {
        ctx.globalCompositeOperation = "destination-out";
      }
    }
  }, [tool, color, size, getPos, saveState]);

  const handleMouseMove = useCallback((e) => {
    if (!drawing) return;
    const pos = getPos(e);

    if (tool === TOOLS.PEN || tool === TOOLS.ERASER) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    } else {
      // Preview shapes on overlay canvas
      const overlay = overlayRef.current;
      const ctx = overlay.getContext("2d");
      ctx.clearRect(0, 0, overlay.width, overlay.height);

      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.lineCap = "round";
      ctx.fillStyle = color + "22";

      const start = startPos.current;
      const dx = pos.x - start.x;
      const dy = pos.y - start.y;

      if (tool === TOOLS.RECT) {
        ctx.strokeRect(start.x, start.y, dx, dy);
        ctx.fillRect(start.x, start.y, dx, dy);
      } else if (tool === TOOLS.CIRCLE) {
        const rx = Math.abs(dx) / 2;
        const ry = Math.abs(dy) / 2;
        const cx = start.x + dx / 2;
        const cy = start.y + dy / 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (tool === TOOLS.ARROW) {
        drawArrow(ctx, start.x, start.y, pos.x, pos.y, color, size);
      }
    }
  }, [drawing, tool, color, size, getPos]);

  const handleMouseUp = useCallback((e) => {
    if (!drawing) return;
    setDrawing(false);
    const pos = getPos(e);

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    if (tool === TOOLS.PEN || tool === TOOLS.ERASER) {
      ctx.closePath();
      ctx.globalCompositeOperation = "source-over";
    } else {
      // Commit shape from overlay to main canvas
      const overlay = overlayRef.current;
      const oCtx = overlay.getContext("2d");
      oCtx.clearRect(0, 0, overlay.width, overlay.height);

      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.lineCap = "round";
      ctx.fillStyle = color + "22";

      const start = startPos.current;
      const dx = pos.x - start.x;
      const dy = pos.y - start.y;

      if (tool === TOOLS.RECT) {
        ctx.strokeRect(start.x, start.y, dx, dy);
        ctx.fillRect(start.x, start.y, dx, dy);
      } else if (tool === TOOLS.CIRCLE) {
        const rx = Math.abs(dx) / 2;
        const ry = Math.abs(dy) / 2;
        const cx = start.x + dx / 2;
        const cy = start.y + dy / 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (tool === TOOLS.ARROW) {
        drawArrow(ctx, start.x, start.y, pos.x, pos.y, color, size);
      }
    }
  }, [drawing, tool, color, size, getPos]);

  const handleTextSubmit = useCallback((text) => {
    if (!text || !textInput) return;
    saveState();
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    ctx.font = `bold ${size * 4 + 10}px "Inter", Arial, sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(text, textInput.x, textInput.y);
    setTextInput(null);
  }, [textInput, color, size, saveState]);

  const handleSave = useCallback(() => {
    const canvas = canvasRef.current;
    const dataUrl = canvas.toDataURL("image/png");
    onSave?.(dataUrl);
  }, [onSave]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
        if (e.key === "z" && e.shiftKey) { e.preventDefault(); redo(); }
      }
      if (e.key === "Escape") {
        if (textInput) setTextInput(null);
        else onClose?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo, textInput, onClose]);

  return (
    <div className="drawing-overlay">
      <div className="drawing-toolbar">
        <div className="toolbar-group">
          {Object.entries(TOOLS).map(([key, val]) => (
            <button
              key={val}
              className={`tool-btn ${tool === val ? "active" : ""}`}
              onClick={() => setTool(val)}
              title={key}
            >
              {toolIcon(val)}
            </button>
          ))}
        </div>

        <div className="toolbar-divider" />

        <div className="toolbar-group colors">
          {COLORS.map((c) => (
            <button
              key={c}
              className={`color-btn ${color === c ? "active" : ""}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>

        <div className="toolbar-divider" />

        <div className="toolbar-group sizes">
          {SIZES.map((s) => (
            <button
              key={s}
              className={`size-btn ${size === s ? "active" : ""}`}
              onClick={() => setSize(s)}
            >
              <span className="size-dot" style={{ width: s + 4, height: s + 4 }} />
            </button>
          ))}
        </div>

        <div className="toolbar-divider" />

        <div className="toolbar-group actions">
          <button className="action-btn" onClick={undo} disabled={history.length === 0} title="Undo">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 10h10a5 5 0 0 1 0 10H9"/><path d="M3 10l5-5M3 10l5 5"/></svg>
          </button>
          <button className="action-btn" onClick={redo} disabled={redoStack.length === 0} title="Redo">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10H11a5 5 0 0 0 0 10h4"/><path d="M21 10l-5-5M21 10l-5 5"/></svg>
          </button>
          <button className="action-btn" onClick={clearAll} title="Clear all">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M5 6v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6"/></svg>
          </button>
        </div>

        <div className="toolbar-spacer" />

        <div className="toolbar-group">
          <button className="save-btn" onClick={handleSave}>Save</button>
          <button className="close-btn" onClick={onClose}>Close</button>
        </div>
      </div>

      <div className="drawing-canvas-container" ref={containerRef}>
        <canvas ref={canvasRef} className="drawing-canvas-base" />
        <canvas
          ref={overlayRef}
          className="drawing-canvas-overlay"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { if (drawing) handleMouseUp({ clientX: 0, clientY: 0 }); }}
          style={{ cursor: getCursor(tool) }}
        />

        {textInput && (
          <input
            className="drawing-text-input"
            style={{ left: textInput.x, top: textInput.y }}
            autoFocus
            placeholder="Type text..."
            onKeyDown={(e) => {
              if (e.key === "Enter") handleTextSubmit(e.target.value);
              if (e.key === "Escape") setTextInput(null);
            }}
            onBlur={(e) => handleTextSubmit(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}

function drawArrow(ctx, x1, y1, x2, y2, color, lineWidth) {
  const headLen = Math.max(12, lineWidth * 3);
  const angle = Math.atan2(y2 - y1, x2 - x1);

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.beginPath();
  ctx.fillStyle = color;
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLen * Math.cos(angle - Math.PI / 6),
    y2 - headLen * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    x2 - headLen * Math.cos(angle + Math.PI / 6),
    y2 - headLen * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();
}

function getCursor(tool) {
  switch (tool) {
    case TOOLS.PEN: return "crosshair";
    case TOOLS.ERASER: return "cell";
    case TOOLS.TEXT: return "text";
    case TOOLS.ARROW: return "crosshair";
    default: return "crosshair";
  }
}

function toolIcon(tool) {
  switch (tool) {
    case TOOLS.PEN:
      return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>;
    case TOOLS.ARROW:
      return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 19L19 5M19 5v10M19 5H9"/></svg>;
    case TOOLS.RECT:
      return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>;
    case TOOLS.CIRCLE:
      return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/></svg>;
    case TOOLS.TEXT:
      return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>;
    case TOOLS.ERASER:
      return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>;
    default: return "?";
  }
}
