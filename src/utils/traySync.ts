import { isTauri } from "../api";

export interface TrayNodeItem {
  name: string;
  delay?: number | null;
  active: boolean;
}

export interface TrayRegionGroup {
  region: string;
  nodes: TrayNodeItem[];
}

export interface TrayMenuPayload {
  running: boolean;
  mode: string;
  sysProxyEnabled: boolean;
  sysProxyState?: "enabled" | "disabled" | "external" | "unknown";
  tunEnabled?: boolean;
  autoRun?: boolean;
  processEnabled?: boolean;
  activeNode?: string | null;
  activeNodeDelay?: number | null;
  downSpeed?: number;
  upSpeed?: number;
  groups: TrayRegionGroup[];
}

let lastPayloadJson = "";
let pendingMenu: TrayMenuPayload | undefined;
let menuTimer: ReturnType<typeof setTimeout> | undefined;
let menuInFlight = false;

async function flushMenu() {
  menuTimer = undefined;
  const payload = pendingMenu;
  pendingMenu = undefined;
  if (!payload) return;
  const json = JSON.stringify(payload);
  if (json === lastPayloadJson) return;
  menuInFlight = true;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("update_tray_menu", { payload });
    lastPayloadJson = json;
  } catch (err) {
    console.warn("同步托盘菜单失败:", err);
  } finally {
    menuInFlight = false;
    if (pendingMenu) menuTimer = setTimeout(flushMenu, 0);
  }
}

export async function syncTrayMenu(payload: TrayMenuPayload): Promise<void> {
  if (!isTauri()) return;
  pendingMenu = payload;
  if (menuInFlight) return;
  clearTimeout(menuTimer);
  menuTimer = setTimeout(flushMenu, 250);
}

let latestTraffic: { downSpeed: number; upSpeed: number } | undefined;
let trafficTimer: ReturnType<typeof setTimeout> | undefined;
let trafficInFlight = false;
let trafficInterval = 1500;
let scheduledInterval = 1500;
let lastTrafficJson = "";

export function syncTrayTraffic(downSpeed: number, upSpeed: number, interval = 1500) {
  if (!isTauri()) return;
  latestTraffic = { downSpeed: Math.round(downSpeed), upSpeed: Math.round(upSpeed) };
  trafficInterval = interval;
  if (trafficInFlight) return;
  if (trafficTimer !== undefined) {
    if (interval >= scheduledInterval) return;
    clearTimeout(trafficTimer);
  }
  scheduledInterval = interval;
  trafficTimer = setTimeout(async () => {
    trafficTimer = undefined;
    const payload = latestTraffic!;
    latestTraffic = undefined;
    const json = JSON.stringify(payload);
    if (json === lastTrafficJson) return;
    trafficInFlight = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("update_tray_traffic", payload);
      lastTrafficJson = json;
    } catch { /* 下一次采样重试，不产生高频日志。 */ }
    finally {
      trafficInFlight = false;
      const queued = latestTraffic as { downSpeed: number; upSpeed: number } | undefined;
      if (queued) syncTrayTraffic(queued.downSpeed, queued.upSpeed, trafficInterval);
    }
  }, interval);
}
