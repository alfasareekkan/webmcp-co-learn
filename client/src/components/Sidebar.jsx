import { useEffect, useRef } from "react";
import "./Sidebar.css";

const TYPE_META = {
  USER_CLICK: { label: "CLICK", cls: "click" },
  USER_INPUT: { label: "INPUT", cls: "input" },
  NAVIGATION: { label: "NAV", cls: "nav" },
  CONTENT_READY: { label: "READY", cls: "ready" },
  CHAT_MESSAGE: { label: "CHAT", cls: "chat" },
};

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function getAppFromUrl(url) {
  if (!url) return null;
  if (url.includes("figma.com")) return "Figma";
  if (url.includes("docs.google.com/spreadsheets")) return "Sheets";
  if (url.includes("notion.so")) return "Notion";
  if (url.includes("miro.com")) return "Miro";
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export default function Sidebar({ events, connected, aiEnabled }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="logo">CL</div>
        <h1>CoLearn</h1>
        <span className={`conn-badge ${connected ? "on" : "off"}`}>
          {connected ? "Live" : "Offline"}
        </span>
        {aiEnabled && <span className="conn-badge ai-badge">AI</span>}
      </div>

      <div className="sidebar-section-title">Activity Feed</div>

      <div className="event-list">
        {events.length === 0 && (
          <div className="empty">
            Waiting for events...
            <br />
            <span>Browse other tabs with the extension active</span>
          </div>
        )}

        {events.map((ev, i) => {
          const meta = TYPE_META[ev.type] || { label: ev.type, cls: "default" };
          const app = ev.app || getAppFromUrl(ev.url);

          return (
            <div className="event-row" key={i}>
              <span className={`event-badge ${meta.cls}`}>{meta.label}</span>
              <div className="event-body">
                <span className="event-text">
                  {ev.text || ev.tag || ev.url?.slice(0, 60) || "—"}
                </span>
                <span className="event-meta">
                  {app && <span className="event-app">{app}</span>}
                  <span className="event-time">{formatTime(ev.timestamp || ev.receivedAt)}</span>
                </span>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </aside>
  );
}
