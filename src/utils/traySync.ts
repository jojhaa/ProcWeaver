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
let pendingSyncTimer: any = null;

export async function syncTrayMenu(payload: TrayMenuPayload): Promise<void> {
  if (!isTauri()) return;
  const json = JSON.stringify(payload);
  if (json === lastPayloadJson) return;

  if (pendingSyncTimer) {
    clearTimeout(pendingSyncTimer);
  }

  pendingSyncTimer = setTimeout(async () => {
    try {
      lastPayloadJson = json;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("update_tray_menu", { payload });
    } catch (err) {
      console.warn("同步托盘菜单失败:", err);
    }
  }, 250);
}
