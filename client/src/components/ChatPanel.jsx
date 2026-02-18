import { useState, useRef, useEffect } from "react";
import "./ChatPanel.css";

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function senderLabel(sender) {
  switch (sender) {
    case "user": return "You";
    case "ai": return "CoLearn AI";
    case "system": return "System";
    default: return sender;
  }
}

function senderClass(sender) {
  switch (sender) {
    case "user": return "self";
    case "ai": return "ai";
    case "system": return "system";
    default: return "other";
  }
}

function renderText(text) {
  if (!text) return null;
  const parts = text.split(/(\*\*.*?\*\*|`[^`]+`|\n)/g);
  return parts.map((part, i) => {
    if (part === "\n") return <br key={i} />;
    if (part.startsWith("**") && part.endsWith("**"))
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`"))
      return <code key={i} className="inline-code">{part.slice(1, -1)}</code>;
    return <span key={i}>{part}</span>;
  });
}

function AnnotatedImage({ src }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="annotated-image-wrap">
      <img
        src={src}
        alt="Annotated screenshot"
        className={`annotated-image ${expanded ? "expanded" : ""}`}
        onClick={() => setExpanded(!expanded)}
      />
      <div className="image-hint">
        {expanded ? "Click to shrink" : "Click to expand"}
      </div>
    </div>
  );
}

function HighlightLegend({ highlights }) {
  if (!highlights?.length) return null;
  const colors = ["#FF3B6F", "#00BCD4", "#FF9800", "#4CAF50", "#9C27B0", "#2196F3"];

  return (
    <div className="highlight-legend">
      {highlights.map((h, i) => (
        <div className="legend-item" key={i}>
          <span className="legend-dot" style={{ background: colors[i % colors.length] }} />
          <span className="legend-label">{h.label}</span>
          {h.reason && <span className="legend-reason">— {h.reason}</span>}
        </div>
      ))}
    </div>
  );
}

function GuidanceActions({ guidance, wsSend }) {
  const [overlayActive, setOverlayActive] = useState(false);

  if (!guidance?.length || !wsSend) return null;

  const showOnPage = () => {
    wsSend({ type: "SHOW_GUIDANCE", guides: guidance });
    setOverlayActive(true);
  };

  const clearOverlay = () => {
    wsSend({ type: "CLEAR_GUIDANCE" });
    setOverlayActive(false);
  };

  return (
    <div className="guidance-actions">
      {overlayActive ? (
        <>
          <button className="guidance-btn active" onClick={clearOverlay}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
            Clear Overlay
          </button>
          <span className="guidance-status">Showing on page</span>
        </>
      ) : (
        <button className="guidance-btn" onClick={showOnPage}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          Show on Page
        </button>
      )}
    </div>
  );
}

export default function ChatPanel({ messages, onSend, connected, aiThinking, wsSend }) {
  const [input, setInput] = useState("");
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, aiThinking]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">Chat</span>
        <span className="chat-subtitle">
          Ask anything — AI sees your screen
        </span>
        {aiThinking && <span className="thinking-badge">AI thinking...</span>}
      </div>

      <div className="chat-messages">
        {messages.length === 0 && !aiThinking && (
          <div className="chat-empty">
            <div className="chat-empty-icon">💬</div>
            <p>Ask about the current screen</p>
            <span>
              Try: "Where is the create button?" or "Show me how to navigate to settings"
              <br />
              AI will highlight elements on the screenshot and directly on the page.
            </span>
          </div>
        )}

        {messages.map((msg, i) => (
          <div className={`chat-bubble ${senderClass(msg.sender)}`} key={i}>
            <div className="bubble-sender">{senderLabel(msg.sender)}</div>

            {msg.image && <AnnotatedImage src={msg.image} />}

            {msg.highlights?.length > 0 && <HighlightLegend highlights={msg.highlights} />}

            {msg.guidance?.length > 0 && (
              <GuidanceActions guidance={msg.guidance} wsSend={wsSend} />
            )}

            <div className="bubble-text">{renderText(msg.text)}</div>

            {msg.context?.url && (
              <div className="bubble-context">
                Context: {msg.context.title || msg.context.url}
              </div>
            )}
            <div className="bubble-meta">{formatTime(msg.timestamp)}</div>
          </div>
        ))}

        {aiThinking && (
          <div className="chat-bubble ai thinking">
            <div className="bubble-sender">CoLearn AI</div>
            <div className="thinking-status">Capturing screen &amp; analyzing...</div>
            <div className="thinking-dots">
              <span></span><span></span><span></span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <form className="chat-input-bar" onSubmit={handleSubmit}>
        <input
          type="text"
          className="chat-input"
          placeholder={
            !connected ? "Connecting..." :
            aiThinking ? "AI is analyzing the screen..." :
            "Ask about this page..."
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!connected || aiThinking}
        />
        <button
          type="submit"
          className="chat-send"
          disabled={!connected || !input.trim() || aiThinking}
        >
          {aiThinking ? "..." : "Send"}
        </button>
      </form>
    </div>
  );
}
