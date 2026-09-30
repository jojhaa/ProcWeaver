import type { BusinessBundleDefinition, BundleProcessMember, BundleProcessBinding } from "../types/businessBundle";
import type { BundlePlatform } from "../types/platform";
export function bundleProcesses(definition: BusinessBundleDefinition, platform: BundlePlatform): BundleProcessMember[] {
  if (platform === "android") return (definition.androidPackages ?? []).map((exe, index) => ({ exe, role: index ? "worker" : "main", description: "Android 应用包名" }));
  return platform === "macos" ? definition.macosProcesses ?? [] : definition.processes;
}

export function validAndroidPackage(value: string): boolean {
  return value.length <= 255 && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value);
}
export function bundleExes(definition: BusinessBundleDefinition, platform: BundlePlatform): string[] {
  return [...bundleProcesses(definition, platform).map(p => p.exe), ...(platform === "windows" ? definition.additionalExes ?? [] : [])];
}

export const executableName = (path: string) => path.split(/[\\/]/).pop() || path;
export const processKey = (value: string, platform: BundlePlatform) => platform === "windows" ? value.replace(/\//g, "\\").toLowerCase() : value;
export function processNames(text: string): string[] {
  return [...new Set(text.split(/[\n,，;；]+/).map(s => s.trim()).filter(Boolean))];
}
export function matchingBindings(bindings: BundleProcessBinding[], names: string[], platform: BundlePlatform): BundleProcessBinding[] {
  return bindings.filter(b => names.some(name => processKey(name, platform) === processKey(b.exe, platform)));
}
export function processMembers(names: string[], existing: BundleProcessMember[], bindings: BundleProcessBinding[], platform: BundlePlatform): BundleProcessMember[] {
  return names.map((exe, i) => {
    const prior = existing.find(p => processKey(p.exe, platform) === processKey(exe, platform));
    const bound = matchingBindings(bindings, [exe], platform);
    return { exe, role: i === 0 ? "main" : prior?.role === "main" ? "worker" : prior?.role ?? "worker",
      description: prior?.description ?? (i === 0 ? "主程序" : "协同进程"),
      ...(bound.length ? { includeDescendants: bound.some(b => b.includeDescendants) } : prior?.includeDescendants !== undefined ? { includeDescendants: prior.includeDescendants } : {}) };
  });
}
export function validateProcessBindings(bindings: BundleProcessBinding[], platform: BundlePlatform): void {
  if (!Array.isArray(bindings) || bindings.length > 100) throw new Error("本机进程绑定最多 100 项");
  const seen = new Set<string>();
  for (const b of bindings) {
    if (!b || typeof b.exe !== "string" || typeof b.executablePath !== "string" || typeof b.includeDescendants !== "boolean" ||
      !b.exe || b.executablePath.length > 1024 || /[\x00-\x1f,#&=*?]/.test(b.executablePath) || !balancedPath(b.executablePath) ||
      !(platform === "windows" ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(b.executablePath) : b.executablePath.startsWith("/")) ||
      processKey(executableName(b.executablePath), platform) !== processKey(b.exe, platform)) throw new Error("本机进程路径无效，请重新从进程树选择");
    const key = processKey(b.executablePath, platform);
    if (seen.has(key)) throw new Error("本机进程路径重复，请合并选择");
    seen.add(key);
  }
}
function balancedPath(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === "(" && ++depth > 8 || char === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

export function bindingRuleKey(path: string): string {
  // Stable, short rule IDs; paths remain only in matchValue, never in labels/IDs.
  let a = 2166136261, b = 5381;
  for (const char of path) { a = Math.imul(a ^ char.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ char.charCodeAt(0); }
  return `path-${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}
