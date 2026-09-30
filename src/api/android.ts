import { invoke } from "@tauri-apps/api/core";
import { routingApi } from "./routingOverrides";

export interface AndroidApplication { packageName: string; label: string; uid: number; sharedUid: boolean; launchable: boolean; systemApp: boolean }
export interface AndroidWindowInsets { top: number; right: number; bottom: number; left: number }
export interface AndroidNetworkInfo { addresses: { interface: string; address: string }[]; vpn: { running: boolean; networkState: string }; maintenance?: { checkedAt: number; success: boolean } }
export interface TrafficHistory { granted: boolean; rows: { uid: number; label: string; packages: string[]; upload: number; download: number }[] }
export interface ProxyHistory { retentionDays: number; rows: { packageName: string; outbound: string; proxied: boolean; upload: number; download: number; connections: number }[] }
export const androidSystemApi = {
  setTheme: (theme: "light" | "dark") => invoke("android_mobile_action", { action: "appearance", page: theme }),
  windowInsets: () => invoke<AndroidWindowInsets>("android_mobile_action", { action: "windowInsets" }),
  outbounds: () => invoke<string[]>("get_lan_outbounds"),
  networkInfo: () => invoke<AndroidNetworkInfo>("android_mobile_action", { action: "networkInfo" }),
  openSettings: (page: "vpn" | "battery" | "app" | "usage") => invoke("android_mobile_action", { action: "openSettings", page }),
  history: (start: number, end: number) => invoke<TrafficHistory>("android_mobile_action", { action: "trafficHistory", start, end }),
  proxyHistory: (start: number, end: number) => invoke<ProxyHistory>("android_mobile_action", { action: "proxyHistory", start, end }),
  clearProxyHistory: () => invoke("android_mobile_action", { action: "clearProxyHistory" }),
  addVpnTile: () => invoke<{ manual?: boolean; added?: boolean }>("android_mobile_action", { action: "addVpnTile" }),
};
export const androidAppsApi = {
  async applications(): Promise<AndroidApplication[]> {
    const result = await invoke<{ applications: AndroidApplication[] }>("get_android_applications");
    return result.applications;
  },
  read: routingApi.read,
  save: routingApi.save,
};
