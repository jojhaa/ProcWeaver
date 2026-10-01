import { useEffect, useSyncExternalStore } from "react";
import { functionModeApi } from "../api/functionMode";
import { createProcessCaptureController } from "../services/processCaptureController";
const actions = createProcessCaptureController(functionModeApi);
export function useProcessCapture() {
  const state = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
  useEffect(() => {
    void actions.refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void actions.refresh(); }, 3000);
    return () => window.clearInterval(timer);
  }, []);
  return { state, actions };
}
