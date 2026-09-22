import { invoke } from "@tauri-apps/api/core";
export interface LaunchRequest { instanceId: string; shortcutId?: string | null }
export interface LaunchOutcome { state: "launched" | "reused" | "restart_required"; message: string; confirmation: string | null; entry: string; processCount: number }
export interface BundleShortcuts { desktop: string; executableFound: boolean; candidates: { path: string; label: string }[]; managed: { id: string; path: string; dedicated: boolean; verified: boolean; backup: string | null }[] }
export interface BundleEntryState { instanceId: string; state: string; message: string; chains: string[]; connectionState: string; connectionMessage: string }
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!("__TAURI_INTERNALS__" in window)) throw new Error("此功能需要 Windows 桌面客户端");
  try { return await invoke<T>(command, args); } catch (error) { throw new Error(typeof error === "string" ? error : error instanceof Error ? error.message : "操作失败，请重试"); }
}
export const bundleToolsApi = {
  entries: (instanceIds: string[]) => call<BundleEntryState[]>("get_bundle_entry_states", { instanceIds }),
  launch: (request: LaunchRequest, confirmation: string | null = null) => call<LaunchOutcome>("launch_bundle_app", { request, confirmation }),
  pending: () => call<LaunchRequest[]>("take_bundle_launch_requests"),
  shortcuts: (instanceId: string) => call<BundleShortcuts>("get_bundle_shortcuts", { instanceId }),
  shortcut: (instanceId: string, action: "patch" | "create" | "restore", candidate: string | null = null, recordId: string | null = null) => call<string>("change_bundle_shortcut", { instanceId, action, candidate, recordId }),
  choose: (instanceId: string) => call<string | null>("choose_bundle_executable", { instanceId }),
};
