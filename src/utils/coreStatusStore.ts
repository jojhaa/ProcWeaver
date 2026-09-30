import type { CoreStatus, SystemProxyStatus } from "../types";
import { isAppHidden } from "./appVisibility";

export const proxyStateLabel = (state: SystemProxyStatus["state"]) => ({
  enabled: "已开启", disabled: "已关闭", external: "其他代理", unknown: "状态未知",
}[state]);

export function createCoreStatusStore(read: () => Promise<CoreStatus>) {
  let snapshot = {
    status: { running: false, systemProxyEnabled: false, mixedPort: 7890, controllerPort: 9090,
      systemProxy: { state: "unknown", bypassChanged: false, message: "正在读取系统代理状态" },
    } as CoreStatus,
    pending: false,
    known: false,
    readError: "",
  };
  let generation = 0;
  let reading: Promise<void> | undefined;
  let readingGeneration = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(listener => listener());
  const visibility = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (typeof document === "undefined" || document.documentElement.dataset.platform !== "android" || !isAppHidden()) {
      void refresh(); timer = setInterval(() => void refresh(), 3000);
    } else { ++generation; }
  };
  const refresh = async (duringAction = false) => {
    if (snapshot.pending && !duringAction) return;
    if (!duringAction && reading && readingGeneration === generation) return reading;
    const request = ++generation;
    const work = (async () => {
      try {
        const status = await read();
        if (request !== generation) return;
        // Compatibility for preview data; desktop sends the detailed actual Windows state.
        status.systemProxy ??= { state: status.systemProxyEnabled ? "enabled" : "disabled", bypassChanged: false, message: "" };
        if (snapshot.known && !snapshot.readError && JSON.stringify(status) === JSON.stringify(snapshot.status)) return;
        snapshot = { ...snapshot, status, known: true, readError: "" };
      } catch (error) {
        if (request !== generation) return;
        if (!snapshot.known && snapshot.readError === `状态读取失败：${String(error)}`) return;
        snapshot = { ...snapshot, known: false, readError: `状态读取失败：${String(error)}`, status: { ...snapshot.status, systemProxy: {
          ...snapshot.status.systemProxy, state: "unknown", bypassChanged: false,
          message: `状态读取失败：${String(error)}`,
        } } };
      }
      publish();
    })();
    reading = work; readingGeneration = request;
    try { await work; } finally { if (reading === work) reading = undefined; }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) { visibility(); if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility); }
      return () => { listeners.delete(listener); if (!listeners.size) { ++generation; clearInterval(timer); timer = undefined; if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visibility); } };
    },
    refresh: () => refresh(),
    async run(action: () => Promise<unknown>) {
      if (snapshot.pending) throw new Error("正在切换核心或系统代理，请稍候");
      ++generation; // A pre-action read must never overwrite the verified post-action state.
      snapshot = { ...snapshot, pending: true }; publish();
      try { await action(); }
      finally {
        await refresh(true);
        snapshot = { ...snapshot, pending: false }; publish();
      }
      return snapshot.status;
    },
  };
}
