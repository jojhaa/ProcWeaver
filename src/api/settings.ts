import { isTauri } from "./index";

export interface GeneralSettings {
  mixedPort: number;
  controllerPort: number;
  enableControllerPort?: boolean;
  allowLan: boolean;
  tunMode: boolean;
  autoStart: boolean;
  unifiedDelay: boolean;
  tcpConcurrent: boolean;
  geoLowMemory: boolean;
  minimizeOnClose: boolean;
  silentStart: boolean;
  autoRun: boolean;
  onlyProxyTraffic: boolean;
  trafficMode?: "app_proxy" | "tun" | "smart_hybrid";
  routingPriority?: "domain_first" | "process_first" | "direct_first";
  speedTestUrl?: string;
  speedTestConcurrency?: number;
  healthProbeConcurrency?: number;
  ipv6?: boolean;
  findProcessMode?: string;
  autoCloseConnections?: boolean;
  appendSystemDns?: boolean;
  logCapture?: boolean;
  tabAnimation?: boolean;
  trayMenuStyle?: "modern" | "classic";
}
export async function getGeneralSettings(): Promise<GeneralSettings> {
  if (!isTauri()) throw new Error("请在桌面客户端中读取设置");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("get_general_settings");
}
export async function saveGeneralSettings(settings: GeneralSettings): Promise<GeneralSettings> {
  if (!isTauri()) throw new Error("请在桌面客户端中保存设置");
  const { invoke } = await import("@tauri-apps/api/core");
  const saved = await invoke<GeneralSettings>("save_general_settings", { settings });
  window.dispatchEvent(new Event("netbox-settings-saved"));
  return saved;
}

export async function getActiveTrafficDriver(): Promise<string> {
  if (!isTauri()) return "app_proxy";
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("get_active_traffic_driver");
}
