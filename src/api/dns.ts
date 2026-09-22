import { isTauri } from "./index";

export type DnsEnhancedMode = "fake-ip" | "redir-host" | "normal" | "hosts";

export interface DnsSettings {
  enableOverride: boolean;        // 覆写 DNS 总开关
  status: boolean;                // 内核 DNS 服务状态（关闭则使用系统 DNS）
  listen: string;                 // 监听端口，例如 "0.0.0.0:1053"
  enhancedMode: DnsEnhancedMode;  // DNS 运行模式
  fakeIpRange: string;            // Fake-IP 虚拟私有网段
  fakeIpFilter: string[];         // 白名单过滤域名
  useHosts: boolean;              // 启用 Hosts 映射
  useSystemHosts: boolean;        // 优先使用系统 Hosts
  respectRules: boolean;          // DNS 流量遵守分流规则
  preferH3: boolean;              // 优先使用 HTTP/3 (QUIC) 查询 DoH
  ipv6: boolean;                  // DNS 是否解析 IPv6 记录
  defaultNameserver: string[];    // 纯 IP 引导域名服务器
  nameserver: string[];           // 国内高速主域名服务器
  fallback: string[];             // 境外纯净防污染备用域名服务器
  proxyServerNameserver: string[];// 订阅代理节点专属解析服务器
  appendSystemDns?: boolean;      // 追加系统网卡 DNS
  nameserverPolicy?: Record<string, string>; // 域名服务器策略映射
  fallbackFilterGeoip: boolean;   // Fallback 触发条件：GeoIP 判定
  fallbackFilterGeoipCode: string;// Fallback 判定代码，默认 "CN"
  fallbackFilterGeosite?: string[]; // Fallback 防投毒 geosite 分类列表
  fallbackFilterIpcidr?: string[];  // Fallback 投毒 IP 网段列表
  fallbackFilterDomain?: string[];  // Fallback 强制备选解析域名列表
}

export const DEFAULT_DNS_SETTINGS: DnsSettings = {
  enableOverride: false,
  status: true,
  listen: "0.0.0.0:1053",
  enhancedMode: "fake-ip",
  fakeIpRange: "198.18.0.1/16",
  fakeIpFilter: [
    "*.lan",
    "*.local",
    "localhost.ptlogin2.qq.com",
    "+.msftconnecttest.com",
    "+.msftncsi.com",
    "*.msftncsi.com",
    "+.market.xiaomi.com",
  ],
  useHosts: true,
  useSystemHosts: true,
  respectRules: false,
  preferH3: false,
  ipv6: false,
  appendSystemDns: false,
  nameserverPolicy: {},
  defaultNameserver: ["223.5.5.5", "119.29.29.29"],
  nameserver: [
    "https://dns.alidns.com/dns-query",
    "https://doh.pub/dns-query",
  ],
  fallback: [
    "https://1.1.1.1/dns-query",
    "https://8.8.8.8/dns-query",
  ],
  proxyServerNameserver: ["223.5.5.5", "119.29.29.29"],
  fallbackFilterGeoip: true,
  fallbackFilterGeoipCode: "CN",
  fallbackFilterGeosite: ["gfw"],
  fallbackFilterIpcidr: ["240.0.0.0/4"],
  fallbackFilterDomain: [],
};

export async function getDnsSettings(): Promise<DnsSettings> {
  if (!isTauri()) {
    try {
      const cached = localStorage.getItem("netbox_dns_settings");
      if (cached) return JSON.parse(cached);
    } catch {}
    return DEFAULT_DNS_SETTINGS;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DnsSettings>("get_dns_settings");
}

export async function saveDnsSettings(settings: DnsSettings): Promise<DnsSettings> {
  if (!isTauri()) {
    try {
      localStorage.setItem("netbox_dns_settings", JSON.stringify(settings));
    } catch {}
    return settings;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const saved = await invoke<DnsSettings>("save_dns_settings", { settings });
  window.dispatchEvent(new Event("netbox-settings-saved"));
  return saved;
}
