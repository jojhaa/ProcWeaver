import { invoke } from "@tauri-apps/api/core";
import { createMonitorStore, MonitorSnapshot } from "../utils/monitorStore";
import { isTauri } from "./index";
import { monitorInterval } from "../utils/monitorPreferences";

export function fetchTrafficSnapshot(includeConnections = false): Promise<MonitorSnapshot> {
  if (!isTauri()) return Promise.resolve({ epoch: null, uploadTotal: 0, downloadTotal: 0, connections: [],
    ...(includeConnections ? { details: { uploadTotal: 0, downloadTotal: 0, connections: [] } } : {}) });
  return invoke("get_traffic_snapshot", { includeConnections });
}

export const monitorStore = createMonitorStore(fetchTrafficSnapshot, monitorInterval);
