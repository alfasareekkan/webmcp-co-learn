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
  return (
    <div className="mirror-container">
      <div className="mirror-header">
        <span className="mirror-title">Screen Mirror</span>
        {screenshot && (
          <span className="mirror-meta">
            {screenshot.url?.slice(0, 60)} &middot; {formatTime(screenshot.timestamp)}
          </span>
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
    </div>
  );
}
