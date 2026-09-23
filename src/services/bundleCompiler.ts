import type { BundleLocalInstance, BundleSlotId } from "../types/businessBundle";
import type { ProcessRule, DnsRule, RoutingOverrides, RoutingTarget, RoutingView, BundleRoute } from "../types/routingOverrides";
import { routingApi, type RoutingApi } from "../api/routingOverrides";

export const sameTarget = (a: RoutingTarget, b: RoutingTarget) =>
  a.profileId === b.profileId && a.kind === b.kind && a.name === b.name;

const normalizedDomains = (domains: string[] = []) => [...new Set(domains.map(raw =>
  raw.trim().toLowerCase().replace(/\.+$/, "").replace(/^\./, "*.")).filter(Boolean))].sort();

class BundleApplyError extends Error {
  constructor(message: string, readonly instanceIds: string[]) { super(message); }
}

// 旧版本只有名称：只允许在当前订阅中唯一解析一次。已保存身份失效时必须显式重绑定。
export function resolveBundleTargets(instances: BundleLocalInstance[], targets: RoutingTarget[], preserved: RoutingTarget[] = []): BundleLocalInstance[] {
  return instances.map(instance => {
    const next = { ...instance, slotTargets: { ...instance.slotTargets } };
    if (!instance.enabled || !instance.slotBindings.main) return next;
    for (const slot of ["main", "dns"] as BundleSlotId[]) {
      const name = instance.slotBindings[slot];
      if (!name || name === "FOLLOW_MAIN") continue;
      const stored = instance.slotTargets?.[slot];
      const candidates = stored ? [...targets, ...preserved.filter(t => !targets.some(current => sameTarget(t, current)))] : targets;
      const matches = candidates.filter(t => t.name === name && (!stored || sameTarget(t, stored)));
      if (matches.length !== 1) {
        throw new BundleApplyError(`「${instance.definition.packageName}」的${slot === "main" ? "主业务" : "DNS"}出口「${name}」已失效或不唯一，请重新绑定`, [instance.instanceId]);
      }
      next.slotTargets[slot] = { ...matches[0] };
    }
    return next;
  });
}

function targetFor(instance: BundleLocalInstance, slot: BundleSlotId): RoutingTarget {
  const actualSlot = slot === "dns" && (!instance.slotBindings.dns || instance.slotBindings.dns === "FOLLOW_MAIN") ? "main" : slot;
  const target = instance.slotTargets?.[actualSlot];
  if (!target || target.name !== instance.slotBindings[actualSlot]) throw new BundleApplyError(`「${instance.definition.packageName}」尚未核实出口，请重新绑定`, [instance.instanceId]);
  return target;
}

export function compileBundlesToProcessRules(instances: BundleLocalInstance[]): ProcessRule[] {
  const rules: ProcessRule[] = [];
  const owners = new Map<string, BundleLocalInstance>();
  for (const instance of instances) {
    if (!instance.enabled || !instance.slotBindings.main) continue;
    const target = targetFor(instance, "main");
    const exes = new Map<string, string>();
    for (const exe of [...instance.definition.processes.map(p => p.exe), ...(instance.definition.additionalExes || [])]) {
      if (exe.trim()) exes.set(exe.trim().toLowerCase(), exe.trim());
    }
    for (const [lower, exe] of exes) {
      const owner = owners.get(lower);
      if (owner) throw new BundleApplyError(`进程 ${exe} 同时属于「${owner.definition.packageName}」和「${instance.definition.packageName}」，请停用其中一个套件或移除重复进程`, [owner.instanceId, instance.instanceId]);
      owners.set(lower, instance);
      rules.push({
        id: `bundle-${instance.instanceId}-${lower}`, enabled: true,
        label: `${instance.definition.packageName} - ${exe}`, matchKind: "name", matchValue: exe,
        action: "proxy", target, includeDescendants: true,
        ruleMode: instance.definition.mode === "strict" ? "strict" : "inherit",
      });
    }
  }
  return rules;
}

export function compileBundlesToDnsRules(instances: BundleLocalInstance[]): DnsRule[] {
  const rules: DnsRule[] = [];
  const owners = new Map<string, BundleLocalInstance[]>();
  for (const instance of instances) {
    if (!instance.enabled || !instance.slotBindings.main) continue;
    const target = targetFor(instance, "dns");
    for (const raw of normalizedDomains(instance.definition.domains)) {
      const clean = raw.trim().toLowerCase().replace(/\.$/, "");
      const domainKind = clean.startsWith("*.") || clean.startsWith(".") ? "suffix" : "exact";
      const domain = clean.replace(/^\*?\./, "");
      if (!domain) continue;
      const overlap = rules.find(r => !sameTarget(r.target, target) && (r.domain === domain ||
        (r.domainKind === "suffix" && domain.endsWith(`.${r.domain}`)) ||
        (domainKind === "suffix" && r.domain.endsWith(`.${domain}`))));
      if (overlap && !sameTarget(overlap.target, target)) {
        const prior = owners.get(overlap.id)!;
        throw new BundleApplyError(`「${instance.definition.packageName}」的域名 ${domain} 的 DNS 出口与「${prior.map(p => p.definition.packageName).join("、")}」冲突，请统一出口或移除重叠域名`, [...prior.map(p => p.instanceId), instance.instanceId]);
      }
      const duplicate = rules.find(r => r.domain === domain && r.domainKind === domainKind);
      if (duplicate) { owners.get(duplicate.id)!.push(instance); continue; }
      const id = `bundle-dns-${instance.instanceId}-${domainKind}-${domain}`;
      owners.set(id, [instance]);
      // 业务 DNS 随所选出口出站；使用 IP DoH 避免解析器主机名的额外引导查询。
      rules.push({ id, enabled: true,
        domainKind, domain, resolverUrl: "https://1.1.1.1/dns-query", target });
    }
  }
  return rules;
}

// 固定字段顺序，避免 Rust JSON 序列化顺序及可选字段影响确认结果。
export function ruleSignature(rules: (ProcessRule | DnsRule)[]): string {
  return JSON.stringify(rules.map(rule => Object.fromEntries(Object.entries(rule)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, key === "target" && value ? [value.profileId, value.kind, value.name] : value]))));
}
export function networkSignature(instance: BundleLocalInstance): string {
  return JSON.stringify([instance.enabled, instance.slotBindings, instance.slotTargets,
    instance.definition.mode, instance.definition.fallback ?? "rules", instance.definition.processes.map(p => p.exe), instance.definition.additionalExes, instance.definition.domains]);
}
export function compileBundleRoutes(instances: BundleLocalInstance[], previous: BundleRoute[] = []): BundleRoute[] {
  return instances.map(instance => ({ id: instance.instanceId, name: instance.definition.packageName,
    mainExe: instance.definition.processes.find(p => p.role === "main")?.exe || instance.definition.processes[0]?.exe || "",
    enabled: instance.enabled && Boolean(instance.slotBindings.main), mode: instance.definition.mode,
    domains: normalizedDomains(instance.definition.domains),
    fallback: instance.definition.fallback ?? "rules",
    port: previous.find(b => b.id === instance.instanceId)?.port || 0,
    mainTarget: instance.enabled && instance.slotBindings.main ? targetFor(instance, "main") : null,
    dnsTarget: instance.enabled && instance.slotBindings.main ? targetFor(instance, "dns") : null,
  }));
}
export const routeSignature = (routes: BundleRoute[] = []) => JSON.stringify(routes.map(r => [r.id, r.name, r.mainExe, r.enabled, r.mode, r.fallback ?? "rules", normalizedDomains(r.domains),
  r.mainTarget && [r.mainTarget.profileId, r.mainTarget.kind, r.mainTarget.name], r.dnsTarget && [r.dnsTarget.profileId, r.dnsTarget.kind, r.dnsTarget.name]]));

export interface BundleSyncResult {
  success: boolean;
  instances: BundleLocalInstance[];
  view?: RoutingView;
  error?: string;
  errorInstanceIds?: string[];
}

export async function syncBundlesToCore(instances: BundleLocalInstance[], api: Pick<RoutingApi, "read" | "save"> = routingApi, restoring = false): Promise<BundleSyncResult> {
  let view: RoutingView | undefined;
  try {
    view = await api.read();
    const resolved = resolveBundleTargets(instances, view.targets, view.preservedTargets);
    const processes = compileBundlesToProcessRules(resolved);
    const dns = compileBundlesToDnsRules(resolved);
    const existing = view.config;
    const bundles = compileBundleRoutes(resolved, existing.bundles);
    const manualProcesses = existing.processRules.filter(r => !r.id.startsWith("bundle-"));
    const manualDns = existing.dnsRules.filter(r => !r.id.startsWith("bundle-dns-"));
    for (const rule of processes) {
      if (manualProcesses.some(r => r.enabled && r.matchKind === "name" && r.matchValue.toLowerCase() === rule.matchValue.toLowerCase())) {
        const owner = resolved.find(instance => rule.id.startsWith(`bundle-${instance.instanceId}-`));
        throw new BundleApplyError(`进程 ${rule.matchValue} 与已有手动进程规则冲突，请先处理重复规则`, owner ? [owner.instanceId] : []);
      }
    }
    const next: RoutingOverrides = { ...existing,
      processEnabled: existing.processEnabled || processes.length > 0,
      dnsEnabled: existing.dnsEnabled || dns.length > 0,
      processRules: [...processes, ...manualProcesses], dnsRules: [...dns, ...manualDns],
      bundles,
    };
    // 已保存业务规则的自动恢复/迁移不重新开启总开关；首次配置和显式应用仍可开启。
    if (restoring) {
      if (existing.processRules.some(r => r.id.startsWith("bundle-"))) next.processEnabled = existing.processEnabled;
      if (existing.dnsRules.some(r => r.id.startsWith("bundle-dns-"))) next.dnsEnabled = existing.dnsEnabled;
    }
    // 重开时已有相同规则则尊重用户手动关闭的总开关；显式应用才重新开启。
    if (restoring && ruleSignature(existing.processRules) === ruleSignature(next.processRules) &&
      ruleSignature(existing.dnsRules) === ruleSignature(next.dnsRules) && routeSignature(existing.bundles) === routeSignature(next.bundles)) {
      return { success: true, instances: resolved, view };
    }
    const matches = (config: RoutingOverrides) => config.processEnabled === next.processEnabled && config.dnsEnabled === next.dnsEnabled &&
      ruleSignature(config.processRules) === ruleSignature(next.processRules) && ruleSignature(config.dnsRules) === ruleSignature(next.dnsRules)
      && routeSignature(config.bundles) === routeSignature(next.bundles);
    if (!matches(existing)) {
      view = await api.save(next, []);
      if (!matches(view.config)) throw new Error("后端返回的规则与本次选择不一致，请重新加载后重试");
    }
    return { success: true, instances: resolved, view };
  } catch (error) {
    return { success: false, instances, view, error: error instanceof Error ? error.message : String(error),
      errorInstanceIds: error instanceof BundleApplyError ? error.instanceIds : [] };
  }
}
