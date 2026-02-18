import { useState } from "react";
import DrawingCanvas from "./DrawingCanvas";
import "./ScreenMirror.css";

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function ScreenMirror({ screenshot }) {
  const [drawingOpen, setDrawingOpen] = useState(false);
  const [savedDrawings, setSavedDrawings] = useState([]);

  const handleSaveDrawing = (dataUrl) => {
    setSavedDrawings((prev) => [...prev, { dataUrl, timestamp: Date.now() }]);
    setDrawingOpen(false);
  };

  return (
    <div className="mirror-container">
      <div className="mirror-header">
        <span className="mirror-title">Screen Mirror</span>
        {screenshot && (
          <>
            <span className="mirror-meta">
              {screenshot.url?.slice(0, 60)} &middot; {formatTime(screenshot.timestamp)}
            </span>
            <button
              className="mirror-draw-btn"
              onClick={() => setDrawingOpen(true)}
              title="Draw & annotate on screenshot"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
              </svg>
              Draw
            </button>
          </>
        )}
      </div>

      <div className="mirror-viewport">
        {screenshot?.dataUrl ? (
          <img src={screenshot.dataUrl} alt="Remote tab screenshot" />
        ) : (
          <div className="mirror-empty">
            <div className="mirror-icon">🖥</div>
            <p>No screenshot yet</p>
            <span>Attach the debugger from the extension popup, then click Screenshot</span>
          </div>
        )}
      </div>

      {savedDrawings.length > 0 && (
        <div className="mirror-saved-strip">
          {savedDrawings.map((d, i) => (
            <img
              key={i}
              src={d.dataUrl}
              alt={`Drawing ${i + 1}`}
              className="saved-thumb"
              title={`Saved ${formatTime(d.timestamp)}`}
            />
          ))}
        </div>
      )}

      {drawingOpen && screenshot?.dataUrl && (
        <DrawingCanvas
          imageUrl={screenshot.dataUrl}
          onSave={handleSaveDrawing}
          onClose={() => setDrawingOpen(false)}
        />
      )}
    </div>
  );
}
