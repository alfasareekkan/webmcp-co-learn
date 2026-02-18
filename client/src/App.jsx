import { useState, useCallback } from "react";
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

  return (
    <div className="app-layout">
      <Sidebar events={events} connected={connected} aiEnabled={aiEnabled} />
      <main className="main-content">
        <ScreenMirror screenshot={screenshot} />
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
