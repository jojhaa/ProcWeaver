import type { BundleLocalInstance } from "../types/businessBundle";
import type { ExternalBundle } from "../types/externalProxy";
import { bundleProcesses, bundleExes, processKey, validateProcessBindings } from "../utils/bundlePlatform";
export function compileExternalBundles(instances: BundleLocalInstance[]): ExternalBundle[] {
  return instances.filter(i => i.backend === "external").map(i => {
    const bindings = i.processBindings?.windows ?? [];
    validateProcessBindings(bindings, "windows");
    const processes = bundleProcesses(i.definition, "windows");
    const main = processes.find(p => p.role === "main")?.exe || processes[0]?.exe || "";
    const members = bundleExes(i.definition, "windows").flatMap<ExternalBundle["members"][number]>(exe => {
      const bound = bindings.filter(b => processKey(b.exe, "windows") === processKey(exe, "windows"));
      return bound.length ? bound.map(b => ({ kind: "path" as const, value: b.executablePath, descendants: b.includeDescendants }))
        : [{ kind: "name" as const, value: exe, descendants: processes.find(p => processKey(p.exe, "windows") === processKey(exe, "windows"))?.includeDescendants !== false }];
    });
    return { id: i.instanceId, name: i.definition.packageName, mainExe: bindings.find(b => processKey(b.exe, "windows") === processKey(main, "windows"))?.executablePath || main,
      enabled: i.enabled, mode: i.definition.mode, domains: [...new Set((i.definition.domains || []).map(d => d.trim().toLowerCase().replace(/\.+$/, "").replace(/^\./, "*.")).filter(Boolean))].sort(),
      members, endpointId: i.externalEndpointId || null, fallback: i.externalFallback || "direct", port: 0 };
  });
}
// Native Serde and JavaScript construct member fields in different orders.
// Compare canonical values, excluding runtime ports and visual list order.
export const externalSignature = (bundles: ExternalBundle[]) => JSON.stringify(bundles.map(b => ({
  id: b.id, name: b.name, mainExe: b.mainExe, enabled: b.enabled, mode: b.mode,
  domains: [...b.domains].sort(), endpointId: b.endpointId, fallback: b.fallback,
  members: b.members.map(m => ({ kind: m.kind, value: m.value, descendants: m.descendants }))
    .sort((a, c) => `${a.kind}:${a.value}:${a.descendants}`.localeCompare(`${c.kind}:${c.value}:${c.descendants}`)),
})).sort((a, b) => a.id.localeCompare(b.id)));
export function validateBackendOwnership(instances: BundleLocalInstance[]) {
  const owners = new Map<string, { id: string; name: string; backend: string }>();
  for (const i of instances.filter(i => i.enabled && (i.backend === "external" || i.slotBindings.main))) {
    for (const exe of bundleExes(i.definition, "windows")) {
      const bound = i.processBindings?.windows?.filter(b => processKey(b.exe, "windows") === processKey(exe, "windows")) || [];
      if (!bound.length && /^(node|cmd|powershell|pwsh|python|java)\.exe$/i.test(exe)) continue;
      for (const key of bound.length ? bound.map(b => `path:${processKey(b.executablePath, "windows")}`) : [`name:${exe.toLowerCase()}`]) {
        const old = owners.get(key);
        if (old && old.id !== i.instanceId && (old.backend === "external" || i.backend === "external")) throw new Error(`「${old.name}」与「${i.definition.packageName}」存在重复进程绑定，请明确路径或停用其中一个包`);
        owners.set(key, { id: i.instanceId, name: i.definition.packageName, backend: i.backend || "core" });
      }
    }
  }
}
