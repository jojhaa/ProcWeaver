import { useEffect } from "react";

const handlers = new Map<symbol, { priority: number; action: () => boolean }>();
if (typeof window !== "undefined") window.addEventListener("procweaver-android-back", event => {
  for (const handler of [...handlers.values()].sort((a, b) => b.priority - a.priority)) {
    if (handler.action()) { event.preventDefault(); break; }
  }
});

export function useMobileBack(action: () => boolean, priority = 10) {
  useEffect(() => {
    const key = Symbol(); handlers.set(key, { priority, action });
    return () => { handlers.delete(key); };
  }, [action, priority]);
}
