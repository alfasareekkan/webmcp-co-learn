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
    case "agent-step": return "Agent";
    default: return sender;
  }
}

function senderClass(sender) {
  switch (sender) {
    case "user": return "self";
    case "ai": return "ai";
    case "system": return "system";
    case "agent-step": return "agent-step";
    default: return "other";
  }
}

const ACTION_ICONS = {
  click: "\u25B6",
  type: "\u2328",
  scroll: "\u2195",
  navigate: "\uD83C\uDF10",
  press_key: "\u2318",
  observe: "\uD83D\uDC41",
  wait: "\u23F3",
};

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

function AgentResult({ agentResult }) {
  if (!agentResult) return null;
  return (
    <div className="agent-result-badge">
      <span className="agent-result-icon">
        {agentResult.status === "completed" ? "\u2713" : "\u26A0"}
      </span>
      <span>
        Task {agentResult.status} in {agentResult.steps} step{agentResult.steps !== 1 ? "s" : ""}
      </span>
    </div>
  );
}

function AgentStepBubble({ msg }) {
  const icon = ACTION_ICONS[msg.agentAction] || "\u2699";
  return (
    <div className="chat-bubble agent-step">
      <div className="agent-step-inner">
        <span className="agent-step-icon">{icon}</span>
        <span className="agent-step-text">{msg.text}</span>
        <span className="agent-step-pulse" />
      </div>
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

function StepConfirmBubble({ msg, onYes, onNo }) {
  if (msg.confirmed) {
    return <div className="chat-bubble system step-confirm-done">Noted — continuing guidance.</div>;
  }
  return (
    <div className="chat-bubble system step-confirm">
      <div className="step-confirm-question">
        Did you complete step {msg.stepNumber}?
        {msg.instruction && <span className="step-confirm-instruction"> — {msg.instruction}</span>}
      </div>
      <div className="step-confirm-actions">
        <button className="step-confirm-btn yes" onClick={() => onYes(msg.threadId)}>
          ✓ Yes, done
        </button>
        <button className="step-confirm-btn no" onClick={() => onNo(msg.threadId)}>
          ✗ Not yet
        </button>
      </div>
    </div>
  );
}

function TaskSummaryCard({ summary }) {
  if (!summary) return null;
  return (
    <div className="task-summary-card">
      <span className="task-summary-icon">&#9676;</span>
      <div className="task-summary-content">
        <div className="task-summary-label">Guided task</div>
        <div className="task-summary-text">{summary}</div>
      </div>
    </div>
  );
}

function ModelSelector({ providers, activeModels, wsSend }) {
  const [open, setOpen] = useState(false);

  if (!providers?.length) return null;

  const allModels = providers.flatMap((p) =>
    p.models.map((m) => ({ ...m, providerName: p.name }))
  );

  const currentAgent = activeModels?.agent;
  const currentGuidance = activeModels?.guidance;

  const agentLabel = allModels.find(
    (m) => m.provider === currentAgent?.provider && m.id === currentAgent?.model
  )?.label || "Not set";

  const guidanceLabel = allModels.find(
    (m) => m.provider === currentGuidance?.provider && m.id === currentGuidance?.model
  )?.label || "Not set";

  const switchModel = (target, provider, model) => {
    wsSend({ type: "SET_MODEL", target, provider, model });
    setOpen(false);
  };

  return (
    <div className="model-selector-wrapper">
      <button
        className="model-selector-btn"
        onClick={() => setOpen(!open)}
        title="Switch AI model"
      >
        <span className="model-icon">&#9881;</span>
        <span className="model-current">{agentLabel}</span>
      </button>
      {open && (
        <div className="model-dropdown">
          <div className="model-dropdown-section">
            <div className="model-dropdown-title">Agent Model</div>
            {allModels.map((m) => (
              <button
                key={`agent-${m.id}`}
                className={`model-option ${m.provider === currentAgent?.provider && m.id === currentAgent?.model ? "active" : ""}`}
                onClick={() => switchModel("agent", m.provider, m.id)}
              >
                <span className="model-option-label">{m.label}</span>
                <span className={`model-option-tier tier-${m.tier}`}>{m.tier}</span>
                <span className="model-option-provider">{m.providerName}</span>
              </button>
            ))}
          </div>
          <div className="model-dropdown-section">
            <div className="model-dropdown-title">Guidance Model</div>
            {allModels.map((m) => (
              <button
                key={`guide-${m.id}`}
                className={`model-option ${m.provider === currentGuidance?.provider && m.id === currentGuidance?.model ? "active" : ""}`}
                onClick={() => switchModel("guidance", m.provider, m.id)}
              >
                <span className="model-option-label">{m.label}</span>
                <span className={`model-option-tier tier-${m.tier}`}>{m.tier}</span>
                <span className="model-option-provider">{m.providerName}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ChatPanel({ messages, onSend, onStop, connected, aiThinking, agentStatus, providers, activeModels, wsSend, guidanceSuggestions = [], taskSummary = null, onConfirmStepYes, onConfirmStepNo }) {
  const [input, setInput] = useState("");
  const bottomRef = useRef(null);

  const isAgentRunning = agentStatus?.status === "running";
  const isBusy = aiThinking || isAgentRunning;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, aiThinking, isAgentRunning]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    const toSend = text.toLowerCase() === "yes" && guidanceSuggestions.length > 0
      ? guidanceSuggestions[0]
      : text;
    onSend(toSend);
    setInput("");
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-header-left">
          <span className="chat-title">Chat</span>
          <span className="chat-subtitle">
            Ask anything or command the agent
          </span>
        </div>
        <div className="chat-header-right">
          {aiThinking && <span className="thinking-badge">AI thinking...</span>}
          {isAgentRunning && <span className="thinking-badge agent-badge">Agent running...</span>}
          <ModelSelector providers={providers} activeModels={activeModels} wsSend={wsSend} />
        </div>
      </div>

      <div className="chat-messages">
        <TaskSummaryCard summary={taskSummary} />
        {messages.length === 0 && !isBusy && !taskSummary && (
          <div className="chat-empty">
            <div className="chat-empty-icon">🤖</div>
            <p>Browser Agent + AI Guide</p>
            <span>
              <strong>Guide mode:</strong> "Where is the settings button?" "How do I create a new project?"
              <br />
              <strong>Agent mode:</strong> "Click the search button" "Type hello in the search box" "Navigate to google.com"
              <br /><br />
              The AI auto-detects your intent — ask questions for guidance, or give commands for actions.
            </span>
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg.isStepConfirm) {
            return (
              <StepConfirmBubble
                key={i}
                msg={msg}
                onYes={onConfirmStepYes || (() => {})}
                onNo={onConfirmStepNo || (() => {})}
              />
            );
          }
          if (msg.isStepProgress) {
            if (msg.isStepCompleted) {
              return (
                <div className="chat-bubble step-done" key={i}>
                  &#x2705; Step {msg.stepNumber} done
                </div>
              );
            }
            return (
              <div className="chat-bubble step-progress" key={i}>
                <div className="bubble-sender">Step</div>
                <div className="step-progress-text">&#128205; Step {msg.stepNumber} of {msg.totalSteps} &mdash; {msg.instruction}</div>
                {msg.image && <AnnotatedImage src={msg.image} />}
                <div className="bubble-meta">Waiting for you&hellip;</div>
              </div>
            );
          }
          if (msg.isTaskComplete) {
            return (
              <div className={`chat-bubble ${senderClass(msg.sender)} task-complete`} key={i}>
                <div className="bubble-sender">{senderLabel(msg.sender)}</div>
                <div className="bubble-text">{renderText(msg.text)}</div>
                {msg.suggestions?.length > 0 && (
                  <div className="suggestion-chips">
                    {msg.suggestions.map((s, j) => (
                      <button
                        type="button"
                        key={j}
                        className="suggestion-chip"
                        onClick={() => onSend(s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
                <div className="bubble-meta">{formatTime(msg.timestamp)}</div>
              </div>
            );
          }
          if (msg.sender === "agent-step") {
            return <AgentStepBubble key={i} msg={msg} />;
          }

          return (
            <div className={`chat-bubble ${senderClass(msg.sender)}`} key={i}>
              <div className="bubble-sender">{senderLabel(msg.sender)}</div>

              {msg.image && <AnnotatedImage src={msg.image} />}

              {msg.highlights?.length > 0 && <HighlightLegend highlights={msg.highlights} />}

              {msg.guidance?.length > 0 && (
                <GuidanceActions guidance={msg.guidance} wsSend={wsSend} />
              )}

              {msg.agentResult && <AgentResult agentResult={msg.agentResult} />}

              <div className="bubble-text">{renderText(msg.text)}</div>

              {msg.context?.url && (
                <div className="bubble-context">
                  Context: {msg.context.title || msg.context.url}
                </div>
              )}
              <div className="bubble-meta">{formatTime(msg.timestamp)}</div>
            </div>
          );
        })}

        {aiThinking && (
          <div className="chat-bubble ai thinking">
            <div className="bubble-sender">CoLearn AI</div>
            <div className="thinking-status">Capturing screen &amp; analyzing...</div>
            <div className="thinking-dots">
              <span></span><span></span><span></span>
            </div>
          </div>
        )}

        {isAgentRunning && !messages.some((m) => m.isLiveStep) && (
          <div className="chat-bubble agent-thinking">
            <div className="bubble-sender">Browser Agent</div>
            <div className="thinking-status">{agentStatus.message || "Analyzing the page..."}</div>
            <div className="agent-progress-bar">
              <div className="agent-progress-fill" />
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
            isAgentRunning ? "Agent is working..." :
            aiThinking ? "AI is analyzing the screen..." :
            "Ask a question or give a command..."
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!connected || isBusy}
        />
        {isBusy ? (
          <button
            type="button"
            className="chat-stop"
            onClick={onStop}
            title="Stop current operation"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="chat-send"
            disabled={!connected || !input.trim()}
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
