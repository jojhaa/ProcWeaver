import type { RoutingApi } from "../api/routingOverrides";
import type { BundleLocalInstance } from "../types/businessBundle";
import type { RoutingView } from "../types/routingOverrides";
import type { ExternalProxyApi } from "../api/externalProxy";
import type { ExternalProxyView } from "../types/externalProxy";
import { compileExternalBundles, externalSignature } from "../services/externalBundleCompiler";
import { syncBundleBackends } from "../services/bundleBackends";
import { bundlePlatform } from "../services/platform";
import { compileBundlesToProcessRules, compileBundlesToDnsRules, compileBundleRoutes, routeSignature, resolveBundleTargets, ruleSignature, syncBundlesToCore, networkSignature } from "../services/bundleCompiler";

export interface BundleState {
  functionMode?: "full" | "process_proxy";
  instances: BundleLocalInstance[];
  view?: RoutingView;
  pending: boolean;
  masterPending?: boolean;
  pendingInstanceIds?: string[];
  error: string;
  readError: string;
  errorInstanceIds?: string[];
  external?: ExternalProxyView;
  externalReadError?: string;
}
export interface BundleStatus {
  phase: "applied" | "pending" | "saved" | "error" | "disabled" | "unbound" | "paused";
  message: string;
  previousTargets: string[];
}

// After reopening, local drafts may contain a failed edit. Recover the last saved
// network definition from the backend so editing another bundle never retries it.
function savedInstances(instances: BundleLocalInstance[], view?: RoutingView): BundleLocalInstance[] {
  return instances.flatMap(instance => {
    const saved = view?.config.bundles?.find(b => b.id === instance.instanceId);
    if (!saved || !view) return [];
    const belongs = (id: string, prefix: string) => {
      const owners = view.config.bundles?.filter(b => id.startsWith(`${prefix}${b.id}-`)).sort((a, b) => b.id.length - a.id.length);
      return owners?.[0]?.id === instance.instanceId;
    };
    const processes = view.config.processRules.filter(r => belongs(r.id, "bundle-"));
    const dns = view.config.dnsRules.filter(r => belongs(r.id, "bundle-dns-"));
    const os = bundlePlatform();
    const basename = (path: string) => path.split(/[\\/]/).pop() || path;
    const mainName = basename(saved.mainExe);
    const restored = [...new Map(processes.map(rule => {
      const exe = rule.matchKind === "path" ? basename(rule.matchValue) : rule.matchValue;
      return [exe.toLowerCase(), { exe, role: exe.toLowerCase() === mainName.toLowerCase() ? "main" as const : "helper" as const,
        description: rule.label, includeDescendants: rule.includeDescendants }] as const;
    })).values()].sort((a, b) => Number(b.role === "main") - Number(a.role === "main"));
    return [{ ...instance, backend: "core" as const, enabled: saved.enabled,
      ...(os !== "android" && processes.length ? { processBindings: { ...instance.processBindings, [os]: processes.filter(r => r.matchKind === "path").map(r => ({ exe: basename(r.matchValue), executablePath: r.matchValue, includeDescendants: r.includeDescendants })) } } : {}),
      slotBindings: { main: saved.mainTarget?.name || instance.slotBindings.main, dns: saved.dnsTarget?.name || "FOLLOW_MAIN" },
      slotTargets: { main: saved.mainTarget || undefined, dns: saved.dnsTarget || undefined },
      definition: { ...instance.definition, mode: saved.mode === "sandbox" ? "sandbox" as const : "strict" as const,
        fallback: saved.fallback ?? "rules",
        [os === "macos" ? "macosProcesses" : "processes"]: restored.length ? restored : (os === "macos" ? instance.definition.macosProcesses : instance.definition.processes) ?? [],
        ...(bundlePlatform() === "windows" ? { additionalExes: [] } : {}), domains: saved.domains ?? dns.map(rule => `${rule.domainKind === "suffix" ? "*." : ""}${rule.domain}`) },
    }];
  });
}
function savedExternalInstances(instances: BundleLocalInstance[], view?: ExternalProxyView): BundleLocalInstance[] {
  if (!view) return [];
  return instances.flatMap(instance => {
    const saved = view.bundles.find(b => b.id === instance.instanceId);
    if (!saved) return [];
    const basename = (path: string) => path.split(/[\\/]/).pop() || path;
    const main = basename(saved.mainExe);
    return [{ ...instance, backend: "external" as const, enabled: saved.enabled, externalEndpointId: saved.endpointId, externalFallback: saved.fallback,
      processBindings: { ...instance.processBindings, windows: saved.members.filter(m => m.kind === "path").map(m => ({ exe: basename(m.value), executablePath: m.value, includeDescendants: m.descendants })) },
      definition: { ...instance.definition, mode: saved.mode, domains: saved.domains, additionalExes: [], processes: saved.members.map(m => ({ exe: basename(m.value), role: basename(m.value).toLowerCase() === main.toLowerCase() ? "main" as const : "helper" as const, description: "", includeDescendants: m.descendants })) },
    }];
  });
}

export function getBundleStatus(instance: BundleLocalInstance, state: BundleState): BundleStatus {
  const rules = state.view?.config.processRules.filter(r => r.id.startsWith(`bundle-${instance.instanceId}-`)) || [];
  const previousTargets = [...new Set(rules.filter(r => r.enabled && r.target).map(r => r.target!.name))];
  const result = (phase: BundleStatus["phase"], message: string): BundleStatus => ({ phase, message, previousTargets });
  if (state.functionMode === "process_proxy" && instance.backend !== "external") return result("paused", "当前模式不可用；原核心绑定保留，可选择外部代理后启用");
  if (state.pending && (!state.pendingInstanceIds || state.pendingInstanceIds.includes(instance.instanceId))) return result("pending", state.masterPending ? "正在切换业务包总开关" : "正在更新此业务包，其他包保持原配置");
  if (instance.backend === "external") {
    if (state.externalReadError) return result("error", state.externalReadError);
    if (state.error && state.errorInstanceIds?.includes(instance.instanceId)) return result("error", state.error);
    const view = state.external;
    if (!view) return result("pending", "正在核实独立代理状态");
    if (!view.supported) return result("error", "独立进程代理首期支持 Windows");
    const saved = view.bundles.filter(b => b.id === instance.instanceId);
    try {
      if (externalSignature(saved) !== externalSignature(compileExternalBundles([instance]))) return result("error", "本次独立设置尚未应用，请重新应用");
    } catch (error) { return result("error", error instanceof Error ? error.message : String(error)); }
    if (!instance.enabled) return result("disabled", "已停用独立入口；应用需恢复自身代理设置后联网");
    if (!view.enabled) return result("paused", "独立代理总开关已暂停，核心状态不影响此开关");
    const runtime = view.states.find(s => s.id === instance.instanceId);
    if (runtime?.error) return result("error", runtime.error);
    if (!runtime?.ready) return result("error", "独立入口未就绪，请重新应用");
    return result("applied", `独立入口 127.0.0.1:${runtime.port} 已就绪；实际出口以新连接记录为准`);
  }
  if (state.readError) return result("error", state.readError);
  if (state.error && state.errorInstanceIds?.includes(instance.instanceId)) return result("error", state.error);
  if (!instance.enabled || !instance.slotBindings.main) {
    if (rules.length) return result("error", "停用尚未确认，核心仍保留上次规则");
    return instance.enabled ? result("unbound", "请先绑定本机出口") : result("disabled", "已停用，跟随现有规则");
  }
  if (!state.view) return result("pending", "尚未核实核心状态");
  if (state.view.config.bundlesEnabled === false) {
    if (state.view.running && state.view.appliedRevision !== state.view.config.revision) return result("pending", "已保存暂停设置，等待核心确认");
    return result("paused", "总开关已暂停；保留本包选择，新连接沿用原有规则");
  }
  try {
    if (state.view.unavailableRules?.some(id => rules.some(r => r.id === id) || id === `bundle:${instance.instanceId}` || id.startsWith(`bundle-dns-${instance.instanceId}-`))) {
      return result("error", "原出口不可用或已选择稍后换绑；绑定信息保留，匹配流量暂时阻断，请选择可用出口重新绑定");
    }
    const resolved = resolveBundleTargets([instance], state.view.targets, state.view.preservedTargets);
    const expected = compileBundlesToProcessRules(resolved);
    const dns = compileBundlesToDnsRules(resolved);
    const config = state.view.config;
    if (routeSignature(config.bundles?.filter(b => b.id === instance.instanceId)) !== routeSignature(compileBundleRoutes(resolved)) ||
      ruleSignature(rules) !== ruleSignature(expected) ||
      (dns.length > 0 && dns.some(r => !config.dnsRules.some(actual =>
        ruleSignature([{ ...actual, id: r.id }]) === ruleSignature([r]))))) {
      return result("error", state.error ? "本次更新未应用，保留上次规则；请查看失败原因" : "本次选择尚未应用，核心仍使用已保存的配置");
    }
    if (!state.view.running) return result("saved", "已保存，等待核心启动");
    if (state.view.appliedRevision !== config.revision) {
      return result("pending", "已保存，等待核心确认规则版本");
    }
    if (!state.view.capture.active && state.view.trafficDriver !== "tun") return result(state.view.capture.transitioning ? "pending" : "error", state.view.capture.message || "规则已加载，但应用代理尚未就绪");
    if (state.view.tracking.conflicts?.length) return result("error", state.view.tracking.conflicts.join("；"));
    if (state.view.tracking.error) return result("error", state.view.tracking.error);
    if (state.view.appliedGeneration !== state.view.tracking.generation) {
      return result("applied", "核心主规则已应用，可启动应用；新子进程规则正在后台同步");
    }
    return result("applied", "核心已应用；实际进程命中与出口请查看新连接记录");
  } catch (error) {
    return result("error", error instanceof Error ? error.message : String(error));
  }
}

export function createBundleController(api: Pick<RoutingApi, "read" | "save">, storage: {
  load: () => BundleLocalInstance[];
  save: (instances: BundleLocalInstance[]) => void;
}, externalApi?: ExternalProxyApi) {
  let state: BundleState = { instances: storage.load(), pending: false, error: "", readError: "" };
  const listeners = new Set<() => void>();
  let sequence = 0;
  let readSequence = 0;
  let reading: Promise<void> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let confirmed: BundleLocalInstance[] | undefined;
  let suspended = false;
  const publish = (patch: Partial<BundleState>) => {
    state = { ...state, ...patch };
    listeners.forEach(fn => fn());
  };
  const apply = (instances = state.instances, restoring = false) => {
    if (suspended) return Promise.resolve(false);
    const ticket = ++sequence;
    ++readSequence;
    const snapshot: BundleLocalInstance[] = JSON.parse(JSON.stringify(instances));
    const changed = restoring || !state.view ? snapshot.map(i => i.instanceId) : [...new Set([...snapshot, ...state.instances].map(i => i.instanceId))].filter(id => {
      const before = state.instances.find(i => i.instanceId === id), after = snapshot.find(i => i.instanceId === id);
      return !before || !after || networkSignature(before) !== networkSignature(after);
    });
    const affected = [...new Set([...changed, ...(state.pendingInstanceIds || [])])];
    const edited = snapshot.filter(item => JSON.stringify(item) !== JSON.stringify(state.instances.find(old => old.instanceId === item.instanceId))).map(i => i.instanceId);
    if (!edited.length && state.error && !restoring) affected.push(...(state.errorInstanceIds || []));
    // 保存失败的其他包保留已确认规则，不在下一次编辑中暗中重试其未生效选择。
    const effective = snapshot.map(item => {
      const previous = confirmed?.find(old => old.instanceId === item.instanceId);
      return !restoring && !affected.includes(item.instanceId) && !edited.includes(item.instanceId) && previous
        && networkSignature(previous) !== networkSignature(item) ? previous : item;
    });
    publish({ instances: snapshot, pending: true, masterPending: false, pendingInstanceIds: affected, error: "", readError: "", errorInstanceIds: [] });
    const work = tail.then(async () => {
      // 尚未开始的过时请求不再热加载核心；运行中的保存完成后才执行下一次。
      if (ticket !== sequence) return false;
      try {
        storage.save(snapshot);
        const result: Awaited<ReturnType<typeof syncBundlesToCore>> & { external?: ExternalProxyView } = externalApi
          ? await syncBundleBackends(effective, api, externalApi, restoring, affected, state.view, state.functionMode === "process_proxy", state.functionMode === "full")
          : await syncBundlesToCore(effective, api, restoring);
        if (result.success) confirmed = result.instances;
        else if (!confirmed) confirmed = [...savedInstances(snapshot, result.view), ...savedExternalInstances(snapshot, result.external)];
        if (ticket !== sequence) return false;
        const desired = snapshot.map(item => affected.includes(item.instanceId) || !state.view
          ? result.instances.find(next => next.instanceId === item.instanceId) || item : item);
        if (result.success) storage.save(desired);
        publish({ instances: desired, view: result.view, ...(result.external ? { external: result.external, externalReadError: "" } : {}), pending: false, pendingInstanceIds: [], error: result.error || "",
          errorInstanceIds: result.errorInstanceIds?.length ? result.errorInstanceIds : affected });
        return result.success;
      } catch (error) {
        if (ticket === sequence) publish({ pending: false, pendingInstanceIds: [], errorInstanceIds: affected, error: error instanceof Error ? error.message : String(error) });
        return false;
      }
    });
    tail = work;
    return work;
  };
  const refresh = (): Promise<void> => {
    if (state.pending || suspended) return Promise.resolve();
    if (reading) return reading;
    const ticket = ++readSequence;
    reading = (async () => {
      if (externalApi) {
        try {
          const external = await externalApi.read();
          if (ticket === readSequence && !state.pending && (state.externalReadError || JSON.stringify(external) !== JSON.stringify(state.external))) publish({ external, externalReadError: "" });
        } catch (error) { if (ticket === readSequence) publish({ externalReadError: error instanceof Error ? error.message : String(error) }); }
      }
      if (state.functionMode === "process_proxy" || ticket !== readSequence) return;
      try {
        const view = await api.read();
        if (ticket !== readSequence || state.pending) return;
        const restarted = state.view?.running === false && view.running;
        if (state.readError || JSON.stringify(view) !== JSON.stringify(state.view)) publish({ view, readError: "" });
        if (restarted && !externalApi) await apply(state.instances, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ticket === readSequence && state.readError !== message) publish({ readError: message });
      }
    })().finally(() => { reading = undefined; });
    return reading;
  };
  const setMasterEnabled = (enabled: boolean) => {
    if (suspended || state.functionMode === "process_proxy") return Promise.resolve(false);
    const ticket = ++sequence; ++readSequence;
    publish({ pending: true, masterPending: true, pendingInstanceIds: state.instances.filter(i => i.backend !== "external").map(i => i.instanceId), error: "", readError: "", errorInstanceIds: [] });
    const work = tail.then(async () => {
      if (ticket !== sequence) return false;
      try {
        const before = await api.read();
        const config = { ...before.config, bundlesEnabled: enabled };
        const view = await api.save(config, []);
        if ((view.config.bundlesEnabled !== false) !== enabled) throw new Error("业务包总开关状态未确认");
        if (ticket === sequence) publish({ view, pending: false, masterPending: false, pendingInstanceIds: [], error: "" });
        return true;
      } catch (error) {
        if (ticket === sequence) publish({ pending: false, masterPending: false, pendingInstanceIds: [], error: error instanceof Error ? error.message : String(error) });
        return false;
      }
    });
    tail = work;
    return work;
  };
  return {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    apply, refresh, setMasterEnabled,
    suspend: (value: boolean) => { suspended = value; if (value) ++readSequence; },
    setFunctionMode: (mode: "full" | "process_proxy") => {
      ++readSequence;
      publish({ functionMode: mode, view: undefined, readError: "", error: "", errorInstanceIds: [] });
    },
    setExternalEnabled: (enabled: boolean) => {
      if (!externalApi || suspended) return Promise.resolve(false);
      const ticket = ++sequence; ++readSequence;
      const ids = state.instances.filter(i => i.backend === "external").map(i => i.instanceId);
      publish({ pending: true, pendingInstanceIds: ids, error: "", errorInstanceIds: [] });
      const work = tail.then(async () => {
        if (ticket !== sequence) return false;
        try {
          const before = await externalApi.read();
          const external = await externalApi.apply(before.revision, before.bundles, enabled);
          if (ticket === sequence) publish({ external, externalReadError: "", pending: false, pendingInstanceIds: [] }); return true;
        } catch (error) { if (ticket === sequence) publish({ pending: false, pendingInstanceIds: [], errorInstanceIds: ids, error: error instanceof Error ? error.message : String(error) }); return false; }
      });
      tail = work;
      return work;
    },
    restore: () => apply(state.instances, true), whenIdle: () => tail,
  };
}
