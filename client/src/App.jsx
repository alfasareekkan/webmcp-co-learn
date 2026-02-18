import { useState, useCallback, useRef, useEffect } from "react";
import useWebSocket from "./hooks/useWebSocket";
import Sidebar from "./components/Sidebar";
import ScreenMirror from "./components/ScreenMirror";
import ChatPanel from "./components/ChatPanel";
import "./App.css";

export default function App() {
  const [events, setEvents] = useState([]);
  const [screenshot, setScreenshot] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [aiThinking, setAiThinking] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);

  // Resizable panels: chatRatio = fraction of main-content height for chat
  const [chatRatio, setChatRatio] = useState(0.45);
  const [dragging, setDragging] = useState(false);
  const mainRef = useRef(null);

  // Sidebar collapse
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const handleMessage = useCallback((data) => {
    switch (data.type) {
      case "INIT":
        setEvents(data.events || []);
        if (data.screenshot) setScreenshot(data.screenshot);
        if (data.aiEnabled !== undefined) setAiEnabled(data.aiEnabled);
        break;
      case "EVENT":
        setEvents((prev) => [...prev.slice(-200), data.event]);
        break;
      case "SCREENSHOT":
        setScreenshot({
          dataUrl: data.dataUrl,
          url: data.url,
          timestamp: data.timestamp,
        });
        break;
      case "CHAT_MESSAGE":
        setChatMessages((prev) => [
          ...prev,
          {
            text: data.text,
            sender: data.sender,
            timestamp: data.timestamp,
            context: data.context,
            image: data.image || null,
            highlights: data.highlights || [],
          },
        ]);
        break;
      case "AI_THINKING":
        setAiThinking(data.thinking);
        break;
    }
  }, []);

  const { connected, send } = useWebSocket(handleMessage);

  const sendChat = (text) => {
    send({ type: "CHAT_MESSAGE", text });
  };

  // Drag handlers for the resizer
  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const onMouseMove = (e) => {
      const main = mainRef.current;
      if (!main) return;
      const rect = main.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const ratio = 1 - y / rect.height;
      setChatRatio(Math.min(0.85, Math.max(0.15, ratio)));
    };

    const onMouseUp = () => setDragging(false);

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragging]);

  const mirrorPercent = ((1 - chatRatio) * 100).toFixed(2);
  const chatPercent = (chatRatio * 100).toFixed(2);

  return (
    <div className={`app-layout ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <Sidebar
        events={events}
        connected={connected}
        aiEnabled={aiEnabled}
        collapsed={!sidebarOpen}
        onToggle={() => setSidebarOpen((v) => !v)}
      />
      <main
        className="main-content"
        ref={mainRef}
        style={{
          gridTemplateRows: `${mirrorPercent}% 6px ${chatPercent}%`,
        }}
      >
        <ScreenMirror screenshot={screenshot} />
        <div
          className={`resizer ${dragging ? "active" : ""}`}
          onMouseDown={onMouseDown}
        >
          <div className="resizer-handle" />
        </div>
        <ChatPanel
          messages={chatMessages}
          onSend={sendChat}
          connected={connected}
          aiThinking={aiThinking}
        />
      </main>
    </div>
  );
}
