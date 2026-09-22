import { IpHealthInfo } from "./index";

export type SmartGroupType = "select" | "url-test" | "fallback" | "sticky" | "relay";

export interface SmartGroupRule {
  id: string;
  name: string;
  desc?: string;
  type: SmartGroupType;
  // 链式中继专有：前置跳板（第一跳，节点名或策略组名）
  relayEntry?: string;
  // 链式中继专有：后置落地（第二跳，节点名或策略组名）
  relayExit?: string;
  // 节点圈选方式：'auto' (规则正则+过滤) | 'manual' (手动勾选指定节点)
  nodeSelectionMode?: "auto" | "manual";
  // 手动勾选指定的节点列表
  manualNodes?: string[];
  // 地区前置正则/关键字（如 "美国|US", "香港|HK"）
  regionPattern?: string;
  // 绑定的国家代码（如 US, HK, JP, SG, TW 等）
  countryCode?: string;
  // 测速容差带 (毫秒，例如 80 代表新节点快 80ms 以上才切换，默认 80)
  tolerance?: number;
  // 极稳接力模式下当前锁定的实体节点名称
  stickyCurrentNode?: string;
  // 最大允许流量倍率（如 1.0 代表仅允许 <= 1.0x 的节点）
  maxMultiplier?: number;
  // 是否要求住宅 IP
  requireResidential?: boolean;
  // 是否要求原生 IP (非机房广播)
  requireNative?: boolean;
  // 最大欺诈风险分（纯净度指标，越低越纯净，如 <= 20 或 <= 40）
  maxFraudScore?: number;
  // 排除测速离线节点 (delay == null 或 0)
  excludeOffline: boolean;
  // 是否按延迟升序排序 (优选延迟最低的节点置顶)
  sortByLatency: boolean;
  // 兜底代理出站（向下兼容单个兜底，默认 "DIRECT" 或 "节点选择"）
  fallbackProxy: string;
  // 多级链路型兜底方案（按优先级顺位回退，如：["美区备用代理组", "REJECT"]）
  fallbackChain?: string[];
  // 匹配到的节点列表（持久化缓存结果）
  matchedProxies?: string[];
  // 上次嗅探完成时间
  lastEvaluatedAt?: string;
}

export type BusinessChannelId = string;

export interface BusinessChannelConfig {
  id: BusinessChannelId;
  name: string;
  icon?: string;
  desc: string;
  targetType: "smart_group" | "proxy_group" | "direct" | "node";
  targetName: string; // 绑定的策略组名称或节点名称或 DIRECT
  matchRulesSummary: string;
  // 自定义匹配域名列表 (支持后缀与完整域名，如 openai.com, binance.com 等)
  customDomains: string[];
  // 自定义匹配进程列表 (如 Telegram.exe, Code.exe, chrome.exe 等)
  customProcesses?: string[];
  // 是否为用户自定义创建的业务组 (用户创建的可以删除)
  isCustom?: boolean;
}

export interface NodeHealthCacheItem {
  health: IpHealthInfo;
  updatedAt: number;
}

export interface SmartOverrideStatus {
  enabled: boolean;
  activeGroupId?: string;
  activeGroupName?: string;
}

