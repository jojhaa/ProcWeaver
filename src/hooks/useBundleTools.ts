import { useEffect, useSyncExternalStore } from "react";
import { bundleTools } from "../services/bundleTools";
import { bundleToolsApi, type LaunchRequest } from "../api/bundleTools";
const queued: LaunchRequest[] = [];
export function useBundleTools() {
  const state = useSyncExternalStore(bundleTools.subscribe, bundleTools.getSnapshot);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false; const removers: (() => void)[] = [];
    const drain = () => {
      if (disposed || bundleTools.getSnapshot().open || !queued.length) return;
      void bundleTools.launch(queued.shift()!);
    };
    const read = async () => { try { queued.push(...await bundleToolsApi.pending()); drain(); } catch { /* A later event retries pending requests. */ } };
    const unsubscribe = bundleTools.subscribe(drain);
    let checking = false;
    const inspect = async () => { if (disposed || checking) return; checking = true; try { await bundleTools.refreshEntries(); } finally { checking = false; } };
    void inspect();
    const timer = window.setInterval(inspect, 15000);
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const unlisten = await listen("procweaver-bundle-launch", read);
      if (disposed) { unlisten(); return; } removers.push(unlisten);
      const overflow = await listen<string>("procweaver-bundle-launch-overflow", event => bundleTools.notifyOverflow(event.payload));
      if (disposed) { overflow(); return; } removers.push(overflow);
      await read(); // First-instance arguments were queued before the WebView existed.
    });
    return () => { disposed = true; removers.forEach(remove => remove()); unsubscribe(); window.clearInterval(timer); };
  }, []);
  return { state, actions: bundleTools };
}
export const useBundleEntries = () => useSyncExternalStore(bundleTools.subscribe, bundleTools.getSnapshot).entries;
