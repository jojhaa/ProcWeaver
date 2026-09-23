import type { RoutingTarget } from "./routingOverrides";
// 业务规则包系统核心数据类型定义 (Business Rule Bundle Types)

export type BundleSlotId = "main" | "dns";

export interface BundleSlot {
  id: BundleSlotId;
  name: string;
  description: string;
  required: boolean;
  followSlotId?: BundleSlotId; // 允许跟随其他插槽 (例如 dns 跟随 main)
}

export interface BundleProcessMember {
  exe: string;
  role: "main" | "worker" | "cli" | "helper";
  description: string;
}

export type BundleCategory = "dev" | "chat" | "browser" | "game" | "media" | "custom";
export type BundleTrafficMode = "strict" | "sandbox"; // strict = 强锁独占, sandbox = 智能沙盒
export type BundleFallback = "rules" | "system" | "direct";
// 热替换单独选择；旧版 auto 继续只检测，不能升级为自动重启授权。
export type BundleWatcherMode = "auto" | "hot_swap" | "notify" | "disabled";

export interface BusinessBundleDefinition {
  packageId: string;
  packageName: string;
  packageVersion: string;
  category: BundleCategory;
  mode: BundleTrafficMode;
  fallback?: BundleFallback; // 缺省保留旧包的原规则；system 仅跟随本软件系统代理开关
  description: string;
  icon: string;
  slots: BundleSlot[];
  processes: BundleProcessMember[];
  additionalExes?: string[];
  domains?: string[];
  author?: string;
}

// 本机实例 (Local Instance)，实现包定义与本机出口节点完全解耦
export interface BundleLocalInstance {
  instanceId: string;
  definition: BusinessBundleDefinition;
  enabled: boolean; // 停用状态下彻底不干涉网络 (跟随系统默认)
  slotBindings: Record<string, string | null>; // 插槽绑定 (如 { main: "🌸 日本 04", dns: "FOLLOW_MAIN" })
  slotTargets?: Partial<Record<BundleSlotId, RoutingTarget>>; // 仅本机保存，不进入导出白名单
  watcherMode: BundleWatcherMode;
  isModified: boolean;
  createdAt: number;
  updatedAt: number;
}

// 规范的 .pwpack.json 纯净脱敏导出文件结构 (白名单脱敏)
export interface ExportableBundlePackage {
  formatVersion: "1.0";
  exportedAt: string;
  bundle: BusinessBundleDefinition;
}
