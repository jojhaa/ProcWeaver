import { invoke } from "@tauri-apps/api/core";
import { RoutingOverrides, RoutingView, ProcessEntry, ProcessSelection, DnsDiagnostic } from "../types/routingOverrides";
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!("__TAURI_INTERNALS__" in window)) throw new Error("此功能需要 Windows 桌面客户端；浏览器预览无法读取进程或保存规则");
  try { return await invoke<T>(command, args); } catch (error) { throw new Error(typeof error === "string" ? error : error instanceof Error ? error.message : "操作失败，请重试"); }
}
export const routingApi = {
  read: () => call<RoutingView>("get_routing_overrides"),
  save: (config: RoutingOverrides, selections: ProcessSelection[]) => call<RoutingView>("save_routing_overrides", { config, selections }),
  tree: () => call<ProcessEntry[]>("get_process_tree"),
  browse: () => call<string | null>("choose_routing_executable"),
  diagnose: (ruleId: string) => call<DnsDiagnostic>("diagnose_routing_dns", { ruleId }),
};
export type RoutingApi = typeof routingApi;
