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
  const [agentStatus, setAgentStatus] = useState({ status: "idle" });
  const [providers, setProviders] = useState([]);
  const [activeModels, setActiveModels] = useState({ agent: null, guidance: null });

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
        if (data.providers) setProviders(data.providers);
        if (data.activeAgentModel || data.activeGuidanceModel) {
          setActiveModels({ agent: data.activeAgentModel, guidance: data.activeGuidanceModel });
        }
        break;
      case "MODEL_CHANGED":
        setActiveModels({ agent: data.activeAgentModel, guidance: data.activeGuidanceModel });
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
          ...prev.filter((m) => !m.isLiveStep),
          {
            text: data.text,
            sender: data.sender,
            timestamp: data.timestamp,
            context: data.context,
            image: data.image || null,
            highlights: data.highlights || [],
            guidance: data.guidance || [],
            agentResult: data.agentResult || null,
          },
        ]);
        break;
      case "AI_THINKING":
        setAiThinking(data.thinking);
        break;
      case "AGENT_STATUS":
        setAgentStatus({ status: data.status, message: data.message });
        break;
      case "AGENT_STEP":
        setChatMessages((prev) => {
          const existing = prev.findIndex(
            (m) => m.sender === "agent-step" && m.isLiveStep
          );
          const stepMsg = {
            text: data.step.description,
            sender: "agent-step",
            timestamp: data.timestamp,
            agentAction: data.step.action,
            isLiveStep: true,
          };
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = stepMsg;
            return updated;
          }
          return [...prev, stepMsg];
        });
        break;
    }
  }, []);

  const { connected, send } = useWebSocket(handleMessage);

  const sendChat = (text) => {
    send({ type: "CHAT_MESSAGE", text });
  };

  const stopChat = () => {
    send({ type: "STOP_CHAT" });
    setAiThinking(false);
    setAgentStatus({ status: "idle" });
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
          onStop={stopChat}
          connected={connected}
          aiThinking={aiThinking}
          agentStatus={agentStatus}
          providers={providers}
          activeModels={activeModels}
          wsSend={send}
        />
      </main>
    </div>
  );
}
