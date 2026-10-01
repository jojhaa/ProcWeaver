import { invoke } from "@tauri-apps/api/core";
import type { ExternalBundle, ExternalProxyView, ExternalSettingsInput } from "../types/externalProxy";
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>(command, args); }
  catch (error) { throw new Error(typeof error === "string" ? error : error instanceof Error ? error.message : "独立代理操作失败"); }
}
export const externalProxyApi = {
  read: () => call<ExternalProxyView>("get_external_proxy"),
  apply: (revision: number, bundles: ExternalBundle[], enabled: boolean) => call<ExternalProxyView>("apply_external_bundles", { revision, bundles, enabled }),
  settings: (input: ExternalSettingsInput) => call<ExternalProxyView>("save_external_proxy_settings", { input }),
  test: (endpointId: string, host: string, port: number, protocol = "tcp", queryName?: string, timeoutMs = 10000) => call<string>("test_external_proxy", { endpointId, host, port, protocol, queryName, timeoutMs }),
};
export type ExternalProxyApi = typeof externalProxyApi;
