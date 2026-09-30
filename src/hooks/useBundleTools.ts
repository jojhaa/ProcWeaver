import { useEffect, useSyncExternalStore } from "react";
import { bundleTools } from "../services/bundleTools";
import { bundleToolsApi, type LaunchRequest, type ProcessMonitorChange } from "../api/bundleTools";
const queued: LaunchRequest[] = [];
export function useBundleTools() {
  const state = useSyncExternalStore(bundleTools.subscribe, bundleTools.getSnapshot);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window) || document.documentElement.dataset.platform === "android") return;
    let disposed = false; const removers: (() => void)[] = [];
    const drain = () => {
      if (disposed || bundleTools.getSnapshot().open || !queued.length) return;
      void bundleTools.launch(queued.shift()!);
    };
    const read = async () => { try { queued.push(...await bundleToolsApi.pending()); drain(); } catch { /* A later event retries pending requests. */ } };
    const unsubscribe = bundleTools.subscribe(drain);
    let checking = false; let pendingFull = false; let debounce: number | undefined; let debounceFull = false;
    const pendingIds = new Set<string>(); const debounceIds = new Set<string>();
    const inspect = async (ids?: string[]) => {
      if (disposed) return;
      if (ids === undefined) pendingFull = true; else ids.forEach(id => pendingIds.add(id));
      if (checking) return;
      checking = true;
      try {
        do {
          const selected = pendingFull ? undefined : [...pendingIds];
          pendingFull = false; pendingIds.clear();
          await bundleTools.refreshEntries(selected);
        } while ((pendingFull || pendingIds.size > 0) && !disposed);
      } finally { checking = false; }
    };
    const changed = (change?: ProcessMonitorChange) => {
      if (disposed) return;
      if (!change || change.refreshAll) debounceFull = true; else change.instanceIds.forEach(id => debounceIds.add(id));
      if (debounce !== undefined) return;
      debounce = window.setTimeout(() => {
        debounce = undefined;
        const ids = debounceFull ? undefined : [...debounceIds];
        debounceFull = false; debounceIds.clear(); void inspect(ids);
      }, 300);
    };
    void inspect();
    const timer = window.setInterval(() => { void inspect(); }, 15000);
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const unlisten = await listen("procweaver-bundle-launch", read);
      if (disposed) { unlisten(); return; } removers.push(unlisten);
      const overflow = await listen<string>("procweaver-bundle-launch-overflow", event => bundleTools.notifyOverflow(event.payload));
      if (disposed) { overflow(); return; } removers.push(overflow);
      const processes = await listen<ProcessMonitorChange>("procweaver-processes-changed", event => changed(event?.payload));
      if (disposed) { processes(); return; } removers.push(processes);
      changed(); // Close the gap between the initial query and event subscription.
      await read(); // First-instance arguments were queued before the WebView existed.
    }).catch(() => { /* Keep periodic inspection if event subscription is unavailable. */ });
    return () => { disposed = true; removers.forEach(remove => remove()); unsubscribe(); window.clearInterval(timer); window.clearTimeout(debounce); };
  }, []);
  return { state, actions: bundleTools };
}
export const useBundleEntries = () => useSyncExternalStore(bundleTools.subscribe, bundleTools.getSnapshot).entries;
