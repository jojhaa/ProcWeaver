// IP 健康度/纯净度数据结构 (对应 https://my.ippure.com/v1/info)
export interface IpHealthInfo {
  source?: string;
  ip: string;
  asn?: number;
  asOrganization?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  regionCode?: string;
  city?: string;
  timezone?: string;
  longitude?: string;
  latitude?: string;
  postalCode?: string;
  fraudScore?: number;
  isResidential?: boolean;
  isBroadcast?: boolean;
  userAgent?: string;
}

// CPU 与内核匹配信息
export interface CpuInfo {
  arch: string;
  avx2Supported: boolean;
  recommendedCore: "v3" | "compatible" | string;
}

// 内核运行状态
export interface SystemProxyStatus {
  state: "enabled" | "disabled" | "external" | "unknown";
  bypassChanged: boolean;
  message: string;
  lastChange?: { timestamp: number; state: string; reason: string } | null;
}

export interface CoreStatus {
  running: boolean;
  pid?: number;
  uptimeSeconds?: number;
  version?: string;
  systemProxyEnabled: boolean;
  systemProxy?: SystemProxyStatus;
  mixedPort: number;
  controllerPort: number;
  activeCore?: string;
  startedAt?: number;
}

// 实时流量网速
export interface TrafficStats {
  up: number;
  down: number;
}

// 订阅配置项
export interface ProfileItem {
  id: string;
  name: string;
  url: string;
  filePath: string;
  updatedAt: string;
  nodeCount: number;
  isSelected: boolean;
  upload?: number;
  download?: number;
  total?: number;
  expire?: number;
  autoUpdateInterval?: number;
  lastUpdatedAtSeconds?: number;
}

// 节点信息
export interface ProxyItem {
  name: string;
  type: string;
  udp?: boolean;
  history?: Array<{ time: string; delay: number }>;
  delay?: number;
}

// 策略组
export interface ProxyGroup {
  name: string;
  type: string;
  now: string;
  all: string[];
}

// 规则条目
export interface RuleItem {
  type: string;
  payload: string;
  proxy: string;
  size?: number;
}

// 规则集提供者
export interface RuleProviderItem {
  name: string;
  type: string;
  behavior: string;
  ruleCount: number;
  updatedAt: string;
  vehicleType: string;
}

// 规则集配置定义
export interface RuleProviderSpec {
  name: string;
  url: string;
  behavior: "classical" | "domain" | "ipcidr" | string;
  target_proxy: string;
}


// Mihomo 配置
export interface MihomoConfig {
  port?: number;
  "socks-port"?: number;
  "mixed-port"?: number;
  mode: "rule" | "global" | "direct" | string;
  "log-level"?: string;
  ipv6?: boolean;
}

// 规则匹配模拟测试结果
export interface RuleMatchResult {
  matchedIndex: number;
  rule: RuleItem;
  targetType: "DIRECT" | "REJECT" | "PROXY";
  explanation: string;
}

// Geo 资源项
export interface GeoResource {
  id: string;
  name: string;
  fileName: string;
  url: string;
  fileSizeBytes: number;
  fileSizeFormatted: string;
  updatedAtRelative: string;
  updatedAt?: string;
  exists: boolean;
}

// Geo 配置
export interface GeoConfig {
  autoUpdate: boolean;
  updateIntervalHours: number;
  lastCheckedAt?: string;
  lastError?: string | null;
  resources: GeoResource[];
}

export interface UnlockItem {
  id: string;
  name: string;
  category: "AI" | "Media" | string;
  status: "unlocked" | "restricted" | "blocked" | "failed";
  info: string;
  latency_ms?: number | null;
}

// 客户端主版本更新检测结果
export interface AppUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseName: string;
  releaseNotes: string;
  publishedAt: string;
  downloadUrl?: string | null;
  assetName?: string | null;
  assetSizeBytes: number;
  assetSizeFormatted: string;
  htmlUrl: string;
  repoUrl: string;
}

// 代理内核运行与版本详情
export interface MihomoCoreDetail {
  activeCoreMode: string;
  activeCorePath?: string | null;
  coreVersionRaw: string;
  coreVersionTag: string;
  cpuArch: string;
  avx2Supported: boolean;
  recommendedCore: string;
  isRunning: boolean;
  pid?: number | null;
  mixedPort: number;
  controllerPort: number;
  startedAt?: number | null;
}

// 官方 Mihomo 发行版检测结果
export interface MihomoReleaseInfo {
  latestVersion: string;
  releaseName: string;
  publishedAt: string;
  downloadUrl?: string | null;
  assetName?: string | null;
  assetSizeBytes: number;
  assetSizeFormatted: string;
  htmlUrl: string;
}

// 规则仓库状态
export interface RulesRepoInfo {
  repoUrl: string;
  latestTag?: string | null;
  releaseName?: string | null;
  updatedAt?: string | null;
  description: string;
}

// 核心分流规则集 (Core-Rules) 更新检测结果
export interface CoreRulesUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  totalRulesCount: number;
  releaseName: string;
  releaseNotes: string;
  publishedAt: string;
  downloadUrl?: string | null;
  assetName?: string | null;
  assetSizeBytes: number;
  assetSizeFormatted: string;
  localRulesDir: string;
}

export * from "./smartGroup";
