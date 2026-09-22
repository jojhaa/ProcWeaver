import { isTauri } from "./index";
import { UnlockItem } from "../types";

export async function probeUnlockMatrix(proxyPort?: number): Promise<UnlockItem[]> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<UnlockItem[]>("probe_unlock_matrix", { proxyPort });
    } catch (err) {
      console.warn("探测流媒体/AI 解锁能力失败:", err);
    }
  }
  return [];
}
