import type { RoutingApi } from "../api/routingOverrides";
import type { ExternalProxyApi } from "../api/externalProxy";
import type { BundleLocalInstance } from "../types/businessBundle";
import type { ExternalProxyView } from "../types/externalProxy";
import type { RoutingView } from "../types/routingOverrides";
import { syncBundlesToCore, type BundleSyncResult } from "./bundleCompiler";
import { compileExternalBundles, externalSignature, validateBackendOwnership } from "./externalBundleCompiler";

export async function syncBundleBackends(instances: BundleLocalInstance[], core: Pick<RoutingApi, "read" | "save">,
  external: ExternalProxyApi, restoring: boolean, affected: string[], previous?: RoutingView, processOnly = false, reconcileCore = false): Promise<BundleSyncResult & { external?: ExternalProxyView }> {
  let before: ExternalProxyView | undefined, current: ExternalProxyView | undefined;
  let oldCore: RoutingView | undefined, coreResult: BundleSyncResult | undefined;
  let coreSaved = false;
  try {
    validateBackendOwnership(processOnly ? instances.filter(i => i.backend === "external") : instances);
    const plans = compileExternalBundles(instances);
    const coreInstances = instances.filter(i => i.backend !== "external");
    try { before = current = await external.read(); }
    catch (error) { if (plans.length) throw error; }
    const returning = processOnly ? [] : before?.bundles.filter(b => coreInstances.some(i => i.instanceId === b.id)) || [];
    // Stop the previous entry before installing rules in the other backend.
    if (returning.length && current && before) current = await external.apply(current.revision, before.bundles.filter(b => !returning.some(r => r.id === b.id)), before.enabled);
    const hasCore = coreInstances.some(i => i.enabled && i.slotBindings.main) || Boolean(previous?.config.bundles?.length);
    const coreNeeded = !processOnly && (reconcileCore && restoring || hasCore && (restoring || !previous || affected.some(id => coreInstances.some(i => i.instanceId === id)
      || previous?.config.bundles?.some(b => b.id === id))));
    if (coreNeeded) {
      try { oldCore = await core.read(); }
      catch (error) { if (hasCore) throw error; }
      // Full-mode reconciliation can remove bindings left by a mode switch,
      // but an unavailable optional core must not block external-only startup.
      if (oldCore) {
        coreResult = await syncBundlesToCore(coreInstances, core, restoring);
        coreSaved = coreResult.view?.config.revision !== oldCore.config.revision;
        if (!coreResult.success) throw new Error(coreResult.error || "核心业务包保存失败");
      }
    }
    if (current && (externalSignature(plans) !== externalSignature(current.bundles)
      || plans.some(b => b.enabled && current!.enabled && !current!.states.find(s => s.id === b.id)?.ready))) {
      current = await external.apply(current.revision, plans, current.enabled);
    }
    return { success: true, instances: instances.map(i => coreResult?.instances.find(v => v.instanceId === i.instanceId) || i), view: coreResult?.view || previous, external: current };
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    // Restore only changes made by this attempt. The returned revisions are used
    // for optimistic concurrency; never overwrite another page's later edit.
    if (coreSaved && oldCore && coreResult?.view) {
      try { coreResult.view = await core.save({ ...oldCore.config, revision: coreResult.view.config.revision }, []); }
      catch { message += "；核心原配置恢复失败，请查看核心规则后重试"; }
    }
    if (before && current && before.revision !== current.revision) {
      try { current = await external.apply(current.revision, before.bundles, before.enabled); }
      catch { message += "；独立入口原配置恢复失败，请重新应用"; }
    }
    return { success: false, instances, view: coreResult?.view || previous, external: current,
      error: message, errorInstanceIds: coreResult?.errorInstanceIds?.length ? coreResult.errorInstanceIds : affected };
  }
}
