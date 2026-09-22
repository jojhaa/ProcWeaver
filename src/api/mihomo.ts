import { ProxyGroup, ProxyItem, RuleItem, MihomoConfig, RuleProviderItem } from "../types";
import { isTauri } from "./index";
import { enqueueProbe } from "../utils/taskQueue";

export interface Exclusions { enabled: boolean; entries: string[] }
export function fetchExclusions(): Promise<Exclusions> {
  return invokeTauri<Exclusions>("get_exclusions");
}
export function saveExclusions(config: Exclusions): Promise<Exclusions> {
  return invokeTauri<Exclusions>("save_exclusions", { config });
}

export interface LocalRulePlan {
  enabled: boolean;
  providers: { name: string; url: string; behavior: string; format?: string | null; target_proxy: string }[];
}
export function fetchLocalRulePlan(): Promise<LocalRulePlan> {
  return invokeTauri<LocalRulePlan>("get_local_rule_plan");
}
export function setLocalRulePlanEnabled(enabled: boolean): Promise<LocalRulePlan> {
  return invokeTauri<LocalRulePlan>("set_local_rule_plan_enabled", { enabled });
}

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  throw new Error("NOT_IN_TAURI");
}

export async function fetchProxies(): Promise<{
  groups: ProxyGroup[];
  proxies: Record<string, ProxyItem>;
}> {
  if (isTauri()) {
    // 自动重试机制：最多尝试 4 次（间隔 350ms），确保核心启动阶段稳妥拉取到全部真实节点
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const data = await invokeTauri<any>("get_mihomo_proxies");
        const allProxies = data?.proxies || {};
        if (Object.keys(allProxies).length > 0) {
          const groups: ProxyGroup[] = [];
          const proxies: Record<string, ProxyItem> = {};

          for (const [name, val] of Object.entries<any>(allProxies)) {
            if (val.all && Array.isArray(val.all)) {
              groups.push({
                name,
                type: val.type,
                now: val.now,
                all: val.all,
              });
            }
            proxies[name] = {
              name,
              type: val.type,
              udp: val.udp,
              history: val.history,
              delay: val.history?.length ? val.history[val.history.length - 1].delay : undefined,
            };
          }
          return { groups, proxies };
        }
      } catch (err) {
        // 内核可能刚拉起，等待 350ms 后重试
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }
  }

  // 彻底剔除假数据！未连接时返回空列表，绝不展示虚假的 6 个节点
  return {
    groups: [],
    proxies: {},
  };
}

export async function switchProxy(groupName: string, proxyName: string): Promise<boolean> {
  try {
    if (isTauri()) {
      const changed = await invokeTauri<boolean>("switch_mihomo_proxy", {
        group: groupName,
        proxy: proxyName,
      });
      if (changed) window.dispatchEvent(new Event("netbox-route-changed"));
      return changed;
    }
  } catch (err) {
    console.error("切换节点失败:", err);
    throw err;
  }
  return true;
}

let cachedSpeedTestUrl = "https://cp.cloudflare.com/generate_204";

export function setPreferredSpeedTestUrl(url: string) {
  if (url && url.trim()) {
    cachedSpeedTestUrl = url.trim();
  }
}

export function getPreferredSpeedTestUrl(): string {
  return cachedSpeedTestUrl;
}

// 监听偏好设置变更事件以实时同步测速 URL
if (typeof window !== "undefined") {
  window.addEventListener("netbox-settings-saved", () => {
    import("./settings").then(({ getGeneralSettings }) => {
      getGeneralSettings()
        .then((s) => {
          if (s.speedTestUrl) setPreferredSpeedTestUrl(s.speedTestUrl);
        })
        .catch(() => {});
    });
  });
}

async function runDelay(
  proxyName: string,
  url?: string,
  timeout = 2000
): Promise<number | null> {
  const targetUrl = url || cachedSpeedTestUrl;
  try {
    if (isTauri()) {
      return await invokeTauri<number | null>("test_mihomo_delay", {
        proxy: proxyName,
        url: targetUrl,
        timeout,
      });
    }
  } catch (err) {
    console.warn(`节点 [${proxyName}] 测速异常/超时:`, err);
  }
  return null;
}

export async function testDelay(proxyName: string, url?: string, timeout = 2000): Promise<number | null> {
  return enqueueProbe(() => runDelay(proxyName, url, timeout));
}

export async function fetchRules(): Promise<RuleItem[]> {
  try {
    if (isTauri()) {
      const data = await invokeTauri<any>("get_mihomo_rules");
      return data?.rules || [];
    }
  } catch (err) {
    console.warn("获取规则失败:", err);
  }
  return [];
}

export async function fetchMihomoConfig(): Promise<MihomoConfig | null> {
  try {
    if (isTauri()) {
      return await invokeTauri<MihomoConfig>("get_mihomo_config");
    }
  } catch (err) {
    console.warn("获取 Mihomo 配置失败:", err);
  }
  return null;
}

export async function updateCoreMode(mode: "rule" | "global" | "direct"): Promise<boolean> {
  try {
    if (isTauri()) {
      const changed = await invokeTauri<boolean>("set_mihomo_mode", { mode });
      if (changed) window.dispatchEvent(new Event("netbox-route-changed"));
      return changed;
    }
  } catch (err) {
    console.error("更新模式失败:", err);
  }
  return false;
}

export async function fetchRuleProviders(): Promise<RuleProviderItem[]> {
  try {
    if (isTauri()) {
      const data = await invokeTauri<any>("get_mihomo_rule_providers");
      const providersObj = data?.providers || {};
      return Object.entries(providersObj).map(([name, item]: [string, any]) => ({
        name,
        type: item.type || "Http",
        behavior: item.behavior || "classical",
        ruleCount: item.ruleCount ?? 0,
        updatedAt: item.updatedAt || "",
        vehicleType: item.vehicleType || "HTTP",
      }));
    }
  } catch (err) {
    console.warn("获取规则集提供者失败:", err);
  }
  return [];
}

export async function updateRuleProvider(name: string): Promise<boolean> {
  try {
    if (isTauri()) {
      return await invokeTauri<boolean>("update_mihomo_rule_provider", { name });
    }
  } catch (err) {
    console.error(`更新规则集 ${name} 失败:`, err);
  }
  return false;
}

export async function addExternalRuleProvider(spec: {
  name: string;
  url: string;
  behavior: string;
  format?: string;
  target_proxy: string;
}): Promise<boolean> {
  try {
    if (isTauri()) {
      return await invokeTauri<boolean>("add_external_rule_provider", { spec });
    }
  } catch (err) {
    console.error(`添加外部规则集 [${spec.name}] 失败:`, err);
    throw err;
  }
  return false;
}

export async function removeExternalRuleProvider(name: string): Promise<boolean> {
  try {
    if (isTauri()) {
      return await invokeTauri<boolean>("remove_external_rule_provider", { name });
    }
  } catch (err) {
    console.error(`移除外部规则集 [${name}] 失败:`, err);
    throw err;
  }
  return false;
}
