import { invoke } from "@tauri-apps/api/core";
export const BROWSER_STATE_KEYS = ["netbox_business_bundles_instances_v1"] as const;
export interface BackupPreview { files: number; createdAt: number; platform: string; crossPlatform: boolean; appVersion: string }
export interface SyncConnection { url: string; username: string; password: string }
export const configTransferApi = {
  export: () => invoke("export_config_snapshot", { browserState: Object.fromEntries(BROWSER_STATE_KEYS.map(key => [key, localStorage.getItem(key) ?? "[]"])) }),
  preview: (snapshot: unknown) => invoke<BackupPreview>("preview_config_snapshot", { snapshot }),
  restore: (snapshot: unknown) => invoke<void>("restore_config_snapshot", { snapshot }),
  remote: (connection: SyncConnection, content?: string, etag?: string) => invoke<{ content: string; etag: string }>("sync_config_remote", { connection, content, etag }),
};
export async function applyPendingBrowserRestore() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const pending = await invoke<Record<string, string> | null>("pending_restore_ui", { acknowledge: false });
  if (!pending) return;
  for (const key of BROWSER_STATE_KEYS) localStorage.setItem(key, pending[key] ?? "[]");
  await invoke("pending_restore_ui", { acknowledge: true });
}
