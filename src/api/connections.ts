import { isTauri } from "./index";

export interface ConnectionMetadata {
  network: string;
  type: string;
  sourceIP: string;
  destinationIP: string;
  sourcePort: string;
  destinationPort: string;
  host: string;
  dnsMode?: string;
  process?: string;
  processPath?: string;
}

export interface ConnectionItem {
  id: string;
  metadata: ConnectionMetadata;
  upload: number;
  download: number;
  start: string;
  chains: string[];
  rule: string;
  rulePayload: string;
  uploadSpeed?: number;
  downloadSpeed?: number;
  closedAt?: string;
}

export interface ConnectionsSnapshot {
  downloadTotal: number;
  uploadTotal: number;
  connections: ConnectionItem[];
}

export async function getActiveConnections(): Promise<ConnectionsSnapshot> {
  if (!isTauri()) {
    return { downloadTotal: 0, uploadTotal: 0, connections: [] };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const res = await invoke<any>("get_active_connections");
  return {
    downloadTotal: res.downloadTotal || 0,
    uploadTotal: res.uploadTotal || 0,
    connections: res.connections || [],
  };
}

export async function closeConnection(id: string): Promise<boolean> {
  if (!isTauri()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("close_connection", { id });
}

export async function closeAllConnections(): Promise<boolean> {
  if (!isTauri()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("close_all_connections");
}
