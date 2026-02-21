import { useState, useEffect } from "react";

export default function WebMCPStatus() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    setAvailable(!!navigator.modelContext);
  }, []);

  return (
    <div className={`webmcp-status ${available ? "available" : "unavailable"}`}>
      <div className="status-dot" />
      <div className="status-info">
        <strong>WebMCP {available ? "Active" : "Unavailable"}</strong>
        {available ? (
          <span>7 cart tools registered via navigator.modelContext</span>
        ) : (
          <span>
            Enable <code>chrome://flags/#enable-webmcp-testing</code> in Chrome
            146+
          </span>
        )}
      </div>
    </div>
  );
}
