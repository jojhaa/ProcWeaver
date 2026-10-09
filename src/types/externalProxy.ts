export interface ExternalEndpoint {
  id: string; name: string; protocol: "http" | "socks5"; host: string; port: number;
  username: string; hasPassword: boolean;
}
export interface ExternalEndpointInput extends Omit<ExternalEndpoint, "hasPassword"> { password?: string | null }
export interface ExternalBundle {
  id: string; name: string; mainExe: string; enabled: boolean; mode: "strict" | "sandbox";
  domains: string[]; members: { value: string; kind: "path" | "name"; descendants: boolean }[];
  endpointId: string | null; fallback: "direct" | "default"; port: number; dnsPort?: number;
}
export interface ExternalDnsSettings { enabled: boolean; server: string; port: number }
export interface ExternalRecord {
  id: number; bundleId: string; generation: number; pid: number; process: string; target: string;
  route: string; upstream: string; state: string; message: string; uploaded: number; downloaded: number; at: number;
}
export interface ProcessLogStatus {
  directory: string; fileName: string; ready: boolean; error: string | null; dropped: number;
  activeTcp: number; activeUdp: number; activeDns: number; lastWriteAt: number;
  maxFileBytes: number; retainedFiles: number;
}
export interface ExternalProxyView {
  revision: number; enabled: boolean; defaultEndpointId: string | null; endpoints: ExternalEndpoint[];
  bundles: ExternalBundle[]; states: { id: string; port: number; ready: boolean; dnsPort: number; dnsReady: boolean; upstream: string; error: string }[];
  dns: ExternalDnsSettings;
  records: ExternalRecord[]; supported: boolean;
  diagnostics?: ProcessLogStatus;
}
export interface ExternalSettingsInput { revision: number; defaultEndpointId: string | null; endpoints: ExternalEndpointInput[]; dns?: ExternalDnsSettings }
export type ExternalProbeKind = "tcp" | "udp_dns" | "udp_stun";
export interface ExternalProbeDraft { kind: ExternalProbeKind; preset: string; host: string; port: number; queryName: string; timeoutMs: number }
export interface ExternalProbeRecord {
  id: number; endpoint: string; kind: ExternalProbeKind; host: string; port: number; queryName: string;
  state: "running" | "success" | "failed"; elapsedMs: number; message: string;
}
