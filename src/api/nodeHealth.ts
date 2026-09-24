import { IpHealthInfo } from "../types";
import { getStoredHealthProbeConcurrency } from "../utils/taskQueue";

export async function probeNodeHealthBatch(
  names: string[],
  onResult: (node: string, result: IpHealthInfo | null, completed: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const unique = [...new Set(names)];
  if (!unique.length) return;

  const { invoke } = await import("@tauri-apps/api/core");
  const concurrency = getStoredHealthProbeConcurrency();
  const chunkSize = Math.max(1, Math.min(concurrency, 32));

  let completed = 0;
  const total = unique.length;

  for (let start = 0; start < total; start += chunkSize) {
    if (signal?.aborted) break;
    const chunk = unique.slice(start, start + chunkSize);
    let session: string | null = null;
    try {
      session = await invoke<string>("begin_health_probe", { names: chunk });

      await Promise.allSettled(
        chunk.map(async (node, index) => {
          // 适度微小错峰（50ms），防止瞬间冲垮第三方免费 IP 接口触发 429 限流
          if (index > 0) {
            await new Promise((r) => setTimeout(r, index * 50));
          }
          if (signal?.aborted) return;
          let result: IpHealthInfo | null = null;
          try {
            result = await invoke<IpHealthInfo>("probe_node_health", { session, node });
          } catch (e) {
            /* 节点失败以 null 返回，继续处理排队任务 */
            console.warn(`节点 [${node}] 体检失败:`, e);
          }
          completed++;
          if (!signal?.aborted) onResult(node, result, completed, total);
        })
      );
    } finally {
      if (session) {
        try {
          await invoke("end_health_probe", { session });
        } catch (e) {
          console.error("释放体检内核会话失败:", e);
        }
      }
    }

    // 批次间轻微间隔（60ms），让系统 TCP 栈释放端口并降低频控压力
    if (start + chunkSize < total) {
      await new Promise((r) => setTimeout(r, 60));
    }
  }
}


// 读取持久化的健康检测缓存（双保险：磁盘文件 config/health_cache.json + localStorage 互为备份与平滑迁移）
export async function getPersistedHealthCache(): Promise<Record<string, IpHealthInfo>> {
  await flushHealthCache().catch(error => console.error("读取前保存体检缓存失败:", error));
  let fileCache: Record<string, IpHealthInfo> = {};
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const res = await invoke<Record<string, IpHealthInfo>>("get_health_cache");
    if (res && typeof res === "object") {
      fileCache = res;
    }
  } catch (e) {
    console.warn("读取本地持久化健康缓存失败，将尝试从 localStorage 恢复:", e);
  }

  let localCache: Record<string, IpHealthInfo> = {};
  try {
    const saved = localStorage.getItem("netbox_health_cache");
    if (saved) {
      localCache = JSON.parse(saved);
    }
  } catch (e) {
    console.warn("读取 localStorage 缓存失败:", e);
  }

  // 合并两者（互相兜底，确保万无一失）
  const merged: Record<string, IpHealthInfo> = { ...localCache, ...fileCache, ...latestCacheToSave };

  // 同步两端状态
  try {
    localStorage.setItem("netbox_health_cache", JSON.stringify(merged));
  } catch {}

  // 如果本地文件之前为空但 localStorage 里有历史数据，自动同步写入磁盘持久化文件
  if (Object.keys(fileCache).length === 0 && Object.keys(localCache).length > 0) {
    try {
      await savePersistedHealthCache(merged, true);
    } catch {}
  }

  return merged;
}

// 合并批量写入；任务结束和离页主动刷盘，失败保留待重试结果。
let pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
let latestCacheToSave: Record<string, IpHealthInfo> | null = null;
let savingCache: Promise<void> | null = null;

export function flushHealthCache(): Promise<void> {
  if (pendingSaveTimer) clearTimeout(pendingSaveTimer);
  pendingSaveTimer = null;
  if (savingCache) return savingCache;
  savingCache = (async () => {
    while (latestCacheToSave) {
      const data = latestCacheToSave;
      latestCacheToSave = null;
      try {
        try { localStorage.setItem("netbox_health_cache", JSON.stringify(data)); } catch {}
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("save_health_cache", { cache: data });
      } catch (error) {
        latestCacheToSave ??= data;
        throw error;
      }
    }
  })().finally(() => { savingCache = null; });
  return savingCache;
}
export function savePersistedHealthCache(cache: Record<string, IpHealthInfo>, flushImmediate = false): Promise<void> {
  latestCacheToSave = cache;
  if (flushImmediate) return flushHealthCache();
  if (!pendingSaveTimer) {
    pendingSaveTimer = setTimeout(() => {
      void flushHealthCache().catch(error => console.error("保存健康检测缓存失败:", error));
    }, 1000);
  }
  return Promise.resolve();
}

// 读取持久化的节点地区归属映射（双保险：localStorage 极速恢复）
export async function getPersistedNodeRegions(): Promise<Record<string, string>> {
  try {
    const saved = localStorage.getItem("netbox_node_regions");
    if (saved) {
      return { ...JSON.parse(saved), ...pendingRegions };
    }
  } catch {}
  return pendingRegions ? { ...pendingRegions } : {};
}

// 保存持久化的节点地区归属映射
let pendingRegions: Record<string, string> | null = null;
let regionTimer: ReturnType<typeof setTimeout> | undefined;
export function flushNodeRegions() {
  if (regionTimer !== undefined) clearTimeout(regionTimer);
  regionTimer = undefined;
  if (!pendingRegions) return;
  try { localStorage.setItem("netbox_node_regions", JSON.stringify(pendingRegions)); pendingRegions = null; } catch {}
}
export function savePersistedNodeRegions(regions: Record<string, string>, flushImmediate = false): void {
  pendingRegions = regions;
  if (flushImmediate) flushNodeRegions();
  else regionTimer ??= setTimeout(flushNodeRegions, 1000);
}

// A local node keeps its alias when edited; observations of the old endpoint must
// not be presented as measurements of its new configuration.
export async function invalidateNodeObservations(names: string[]): Promise<void> {
  if (!names.length) return;
  const [health, regions] = await Promise.all([getPersistedHealthCache(), getPersistedNodeRegions()]);
  for (const name of names) { delete health[name]; delete regions[name]; }
  savePersistedNodeRegions(regions, true);
  await savePersistedHealthCache(health, true);
}

// 读取已忽略节点名称列表
export function getIgnoredNodes(): string[] {
  try {
    const saved = localStorage.getItem("netbox_ignored_nodes");
    if (saved) {
      return JSON.parse(saved);
    }
  } catch {}
  return [];
}

// 保存已忽略节点名称列表
export function saveIgnoredNodes(nodes: string[]): void {
  try {
    localStorage.setItem("netbox_ignored_nodes", JSON.stringify(nodes));
  } catch {}
}
