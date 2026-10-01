import type { ExternalEndpoint, ExternalEndpointInput, ExternalProbeDraft, ExternalProbeKind } from "../types/externalProxy";

type Preset = { id: string; kind: ExternalProbeKind; label: string; host: string; port: number };
// Public service addresses are only contacted after the user starts a probe.
export const externalProbePresets: readonly Preset[] = [
  { id: "tcp-example", kind: "tcp", label: "example.com · 443", host: "example.com", port: 443 },
  { id: "tcp-dns-domain", kind: "tcp", label: "cloudflare-dns.com · 443", host: "cloudflare-dns.com", port: 443 },
  { id: "tcp-google-domain", kind: "tcp", label: "dns.google · 443", host: "dns.google", port: 443 },
  { id: "tcp-ipv4", kind: "tcp", label: "1.1.1.1 · 443（IPv4）", host: "1.1.1.1", port: 443 },
  { id: "tcp-ipv6", kind: "tcp", label: "2606:4700:4700::1111 · 443（IPv6）", host: "2606:4700:4700::1111", port: 443 },
  { id: "udp-dns-one", kind: "udp_dns", label: "1.1.1.1 · 53", host: "1.1.1.1", port: 53 },
  { id: "udp-dns-two", kind: "udp_dns", label: "8.8.8.8 · 53", host: "8.8.8.8", port: 53 },
  { id: "udp-dns-ipv6", kind: "udp_dns", label: "2606:4700:4700::1111 · 53（IPv6）", host: "2606:4700:4700::1111", port: 53 },
  { id: "udp-stun", kind: "udp_stun", label: "stun.cloudflare.com · 3478", host: "stun.cloudflare.com", port: 3478 },
];
export const defaultExternalProbe = (): ExternalProbeDraft => ({ kind: "tcp", preset: "tcp-example", host: "example.com", port: 443, queryName: "example.com", timeoutMs: 10000 });
export function selectProbePreset(draft: ExternalProbeDraft, id: string): ExternalProbeDraft {
  if (id === "custom") return { ...draft, preset: id };
  const preset = externalProbePresets.find(p => p.id === id && p.kind === draft.kind);
  if (!preset) return draft;
  return { ...draft, preset: preset.id, host: preset.host, port: preset.port };
}
export function selectProbeKind(draft: ExternalProbeDraft, kind: ExternalProbeKind): ExternalProbeDraft {
  const preset = externalProbePresets.find(p => p.kind === kind)!;
  return selectProbePreset({ ...draft, kind }, preset.id);
}
export function savedProbeEndpoint(draft: ExternalEndpointInput, endpoints: ExternalEndpoint[]): ExternalEndpoint | undefined {
  const saved = endpoints.find(e => e.id === draft.id);
  if (!saved || saved.protocol !== draft.protocol || saved.host !== draft.host || saved.port !== draft.port || saved.username !== draft.username || !!draft.password || (draft.password === null && saved.hasPassword)) return undefined;
  return saved;
}
export function validateProbe(draft: ExternalProbeDraft, protocol: string): ExternalProbeDraft {
  const host = draft.host.trim().replace(/^\[|\]$/g, "");
  if (!host || host.length > 253 || /[\s/@?#]/.test(host)) throw new Error("检测地址请填写纯域名或 IP，不含协议前缀和路径");
  if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) throw new Error("检测端口须为 1–65535 的整数");
  if (!Number.isInteger(draft.timeoutMs) || draft.timeoutMs < 1000 || draft.timeoutMs > 30000) throw new Error("检测超时须为 1–30 秒");
  if (draft.kind !== "tcp" && protocol !== "socks5") throw new Error("UDP 检测需要已保存的 SOCKS5 代理");
  const queryName = draft.queryName.trim().replace(/\.$/, "").toLowerCase();
  if (draft.kind === "udp_dns" && (!queryName || queryName.length > 253 || !queryName.split(".").every(p => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(p)) || /^[\d.]+$/.test(queryName))) throw new Error("DNS 查询名须为有效域名，国际域名请使用 Punycode");
  return { ...draft, host, queryName };
}
