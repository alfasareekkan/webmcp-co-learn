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

// Simple markdown-ish rendering: bold, code, line breaks
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

export default function ChatPanel({ messages, onSend, connected, aiThinking }) {
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
          Ask anything about the current page
        </span>
        {aiThinking && <span className="thinking-badge">AI thinking...</span>}
      </div>

      <div className="chat-messages">
        {messages.length === 0 && !aiThinking && (
          <div className="chat-empty">
            <div className="chat-empty-icon">💬</div>
            <p>Ask about the current screen</p>
            <span>
              Try: "What is this page?" or "Are there any errors?"
              <br />
              The extension will capture context automatically.
            </span>
          </div>
        )}

        {messages.map((msg, i) => (
          <div className={`chat-bubble ${senderClass(msg.sender)}`} key={i}>
            <div className="bubble-sender">{senderLabel(msg.sender)}</div>
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
            aiThinking ? "AI is processing..." :
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
