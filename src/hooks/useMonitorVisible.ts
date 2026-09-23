import { useSyncExternalStore } from "react";
import { getWindowMonitorVisible } from "../api";

let visible = !document.hidden;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;
let generation = 0;
const getSnapshot = () => visible;

async function refresh() {
  if (inFlight || !listeners.size) return;
  clearTimeout(timer);
  inFlight = true;
  const revision = generation;
  try {
    const next = await getWindowMonitorVisible() && !document.hidden;
    if (revision === generation && listeners.size && visible !== next) {
      visible = next;
      listeners.forEach(cb => cb());
    }
  } catch { /* 查询失败保持原状态，不误停前台显示。 */ }
  finally {
    inFlight = false;
    if (listeners.size) timer = setTimeout(refresh, 2000);
  }
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("blur", refresh);
    void refresh();
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size) {
      generation++;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("blur", refresh);
    }
  };
}
export function useMonitorVisible() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
