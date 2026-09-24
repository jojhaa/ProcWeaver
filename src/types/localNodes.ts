export type NodeConfig = Record<string, unknown>;
export interface LocalNodeDraft { id?: string; name: string; config: NodeConfig }
export interface LocalNodeSummary { id: string; name: string; alias: string; protocol: string; server: string; port: number }
export interface LocalNodesView { revision: number; nodes: LocalNodeSummary[]; running: boolean }
export const nodeProtocols = [
  ["vmess", "VMess"], ["vless", "VLESS"], ["ss", "Shadowsocks"], ["trojan", "Trojan"],
  ["hysteria2", "Hysteria2"], ["wireguard", "WireGuard"], ["socks5", "SOCKS5"],
  ["http", "HTTP / HTTPS"], ["tuic", "TUIC"], ["anytls", "AnyTLS"],
  ["ssr", "ShadowsocksR"], ["hysteria", "Hysteria"], ["snell", "Snell"], ["ssh", "SSH"],
  ["mieru", "Mieru"], ["shadowquic", "ShadowQUIC"], ["gost-relay", "GOST Relay"],
  ["sudoku", "Sudoku"], ["masque", "MASQUE"], ["trusttunnel", "TrustTunnel"],
  ["openvpn", "OpenVPN"], ["tailscale", "Tailscale"], ["zerotier", "ZeroTier"], ["easytier", "EasyTier"],
] as const;
export const usesConfigEditor = (type: unknown) => !["vmess", "vless", "ss", "trojan", "hysteria2", "wireguard", "socks5", "http", "tuic", "anytls"].includes(String(type));
export function nodeConfigTemplate(type: string): NodeConfig {
  const base = { type, server: "", port: 443 };
  switch (type) {
    case "ssr": return { ...base, cipher: "aes-128-ctr", password: "", protocol: "auth_aes128_sha1", obfs: "plain" };
    case "hysteria": return { ...base, "auth-str": "", up: "10 Mbps", down: "50 Mbps" };
    case "snell": return { ...base, psk: "", version: 3 };
    case "ssh": return { ...base, port: 22, username: "", password: "" };
    case "mieru": return { ...base, username: "", password: "", transport: "TCP" };
    case "shadowquic": case "gost-relay": case "trusttunnel": return { ...base, username: "", password: "" };
    case "sudoku": return { ...base, key: "" };
    case "masque": return { ...base, "private-key": "", "public-key": "", ip: "" };
    case "openvpn": return { ...base, port: 1194, proto: "udp", ca: "", cert: "", key: "" };
    case "tailscale": return { type, hostname: "", "auth-key": "", "exit-node": "" };
    case "zerotier": return { type, network: "" };
    case "easytier": return { type, "network-name": "", "network-secret": "", peers: [], "no-listener": true };
    default: return { ...base, ...(type === "vmess" ? { cipher: "auto", alterId: 0 } : {}) };
  }
}
export function localNodeEndpoint(config: NodeConfig): string {
  if (config.server) return `${String(config.server)}:${String(config["port-range"] || config.port || "")}`;
  if (Array.isArray(config.peers) && config.type === "wireguard") return `${config.peers.length} 个对端`;
  return String(config.hostname || config.network || config["network-name"] || "虚拟网络");
}
