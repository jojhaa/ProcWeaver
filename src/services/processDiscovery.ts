import type { ProcessEntry } from "../types/routingOverrides";
import type { BundleProcessBinding, BundleProcessMember } from "../types/businessBundle";
import type { ConnectionItem } from "../api/connections";
import type { BundlePlatform } from "../types/platform";
import { executableName, processKey } from "../utils/bundlePlatform";

export interface ProcessRow { entry: ProcessEntry; depth: number; hasChildren: boolean }
export function processTreeRows(entries: ProcessEntry[], expanded: Set<string>, query: string): ProcessRow[] {
  const byId = new Map(entries.map(p => [p.identity, p]));
  const children = new Map<string | null, ProcessEntry[]>();
  for (const p of entries) {
    const parent = p.parentIdentity && p.parentIdentity !== p.identity && byId.has(p.parentIdentity) ? p.parentIdentity : null;
    children.set(parent, [...(children.get(parent) ?? []), p]);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);
  const q = query.trim().toLowerCase(), visible = new Set<string>();
  if (q) for (const p of entries) {
    if (!`${p.name} ${p.pid} ${p.executablePath ?? ""}`.toLowerCase().includes(q)) continue;
    let current: ProcessEntry | undefined = p;
    const visited = new Set<string>();
    while (current && !visited.has(current.identity)) { visited.add(current.identity); visible.add(current.identity); current = byId.get(current.parentIdentity ?? ""); }
  }
  const rows: ProcessRow[] = [], visited = new Set<string>();
  const walk = (p: ProcessEntry, depth: number) => {
    if (visited.has(p.identity)) return;
    visited.add(p.identity);
    if (q && !visible.has(p.identity)) return;
    const nodes = children.get(p.identity) ?? [];
    rows.push({ entry: p, depth, hasChildren: nodes.length > 0 });
    if (q || expanded.has(p.identity)) for (const child of nodes) walk(child, depth + 1);
  };
  for (const p of children.get(null) ?? []) walk(p, 0);
  // Orphaned/cyclic snapshots stay inspectable, without infinite recursion.
  for (const p of entries) {
    if (!visited.has(p.identity) && p.parentIdentity && !children.get(null)?.includes(p)) {
      let ancestor = byId.get(p.parentIdentity), seen = new Set([p.identity]);
      while (ancestor && !visited.has(ancestor.identity) && !seen.has(ancestor.identity)) { seen.add(ancestor.identity); ancestor = byId.get(ancestor.parentIdentity ?? ""); }
      if (ancestor && seen.has(ancestor.identity)) walk(p, 0);
    }
  }
  return rows;
}

export function selectedBindings(entries: ProcessEntry[], ids: Set<string>, includeDescendants: boolean, platform: BundlePlatform): BundleProcessBinding[] {
  const byId = new Map(entries.map(p => [p.identity, p]));
  const paths = new Map<string, BundleProcessBinding>();
  for (const p of entries) {
    if (!ids.has(p.identity) || !p.executablePath) continue;
    let parent = byId.get(p.parentIdentity ?? ""), covered = false;
    const visited = new Set([p.identity]);
    while (includeDescendants && parent && !visited.has(parent.identity)) {
      visited.add(parent.identity);
      if (ids.has(parent.identity) && parent.executablePath) { covered = true; break; }
      parent = byId.get(parent.parentIdentity ?? "");
    }
    if (!covered) paths.set(processKey(p.executablePath, platform), { exe: executableName(p.executablePath), executablePath: p.executablePath, includeDescendants });
  }
  return [...paths.values()];
}

export interface ObservationScope {
  paths: Set<string>; names: Set<string>; ambiguousPaths: Set<string>;
  bundleInbound?: string; bundleOwner?: string; platform: BundlePlatform;
}
export function observationScope(entries: ProcessEntry[], members: BundleProcessMember[], bindings: BundleProcessBinding[], platform: BundlePlatform, bundleId?: string): ObservationScope {
  const selected = new Set<string>(), inherits = new Set<string>(), paths = new Set<string>(), names = new Set<string>();
  for (const member of members) {
    const bound = bindings.filter(b => processKey(b.exe, platform) === processKey(member.exe, platform));
    if (!bound.length && platform === "windows" && ["node.exe", "cmd.exe", "powershell.exe", "pwsh.exe"].includes(member.exe.toLowerCase())) continue;
    if (!bound.length) names.add(processKey(member.exe, platform));
    for (const b of bound) paths.add(processKey(b.executablePath, platform));
    for (const p of entries) {
      const b = bound.find(b => p.executablePath && processKey(b.executablePath, platform) === processKey(p.executablePath, platform));
      if (b || !bound.length && processKey(p.name, platform) === processKey(member.exe, platform)) {
        selected.add(p.identity);
        if (b ? b.includeDescendants : member.includeDescendants !== false) inherits.add(p.identity);
      }
      if (p.ancestors?.some(([, path]) => bound.length
        ? bound.some(b => b.includeDescendants && processKey(b.executablePath, platform) === processKey(path, platform))
        : member.includeDescendants !== false && processKey(executableName(path), platform) === processKey(member.exe, platform))) {
        selected.add(p.identity); inherits.add(p.identity);
      }
    }
  }
  const children = new Map<string, ProcessEntry[]>();
  for (const p of entries) if (p.parentIdentity) children.set(p.parentIdentity, [...children.get(p.parentIdentity) ?? [], p]);
  const queue = [...inherits];
  for (let i = 0; i < queue.length; i++) for (const p of children.get(queue[i]) ?? []) {
    selected.add(p.identity);
    if (!inherits.has(p.identity)) { inherits.add(p.identity); queue.push(p.identity); }
  }
  for (const p of entries) if (selected.has(p.identity) && p.executablePath) paths.add(processKey(p.executablePath, platform));
  const ambiguousPaths = new Set(entries.filter(p => !selected.has(p.identity) && p.executablePath && paths.has(processKey(p.executablePath, platform))).map(p => processKey(p.executablePath!, platform)));
  const hex = bundleId && [...new TextEncoder().encode(bundleId)].map(b => b.toString(16).padStart(2, "0")).join("");
  return { paths, names, ambiguousPaths, bundleInbound: hex ? `PW-${hex}-entry` : undefined, bundleOwner: bundleId ? `bundle:${bundleId}` : undefined, platform };
}

export interface DomainCandidate { domain: string; connections: number; lastSeen: number; sources: string[]; processes: string[]; confirmed: boolean }
export function detectedDomain(raw: string): string | null {
  const domain = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!domain.includes(".") || domain.length > 253 || /^[\d.]+$/.test(domain)) return null;
  return domain.split(".").every(s => s.length > 0 && s.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s)) ? domain : null;
}
function attribution(item: ConnectionItem, scope: ObservationScope, includeBundle: boolean) {
  const m = item.metadata, relay = m.inboundName?.startsWith("pw-wd-");
  const context = m.processContext;
  // An owned inlet cannot be attributed to a different package just because
  // both applications happen to run the same node.exe executable.
  if (relay && context?.owner && context.owner !== scope.bundleOwner) return null;
  if (relay && includeBundle && context?.owner && context.owner === scope.bundleOwner) {
    return { process: "业务包进程树", confirmed: false, source: "WinDivert 业务包实例归属（未定位单个进程）" };
  }
  // Never fall back to the relay helper's process fields, including stale contexts.
  const path = relay ? context?.kind === "path" ? context.value : "" : m.processPath ?? "";
  const name = relay ? context?.kind === "name" ? context.value : "" : m.process ?? "";
  if (path && scope.paths.has(processKey(path, scope.platform))) {
    const ambiguous = scope.ambiguousPaths.has(processKey(path, scope.platform));
    return { process: executableName(path), confirmed: !ambiguous,
      source: ambiguous ? "同路径其他实例存在，归属待核实" : relay ? "WinDivert 程序路径入口（非 PID 核验）" : "核心程序路径（非 PID 核验）" };
  }
  // A conflicting exact path must not degrade to a same-name match.
  if (!path && name && scope.names.has(processKey(name, scope.platform))) return { process: name, confirmed: false, source: relay ? "WinDivert 进程名入口（路径未核实）" : "核心进程名（路径未核实）" };
  if (!relay && includeBundle && scope.bundleInbound && m.inboundName === scope.bundleInbound) return { process: "业务包入口", confirmed: false, source: "业务包入口（未定位进程）" };
  return null;
}

export function createDomainCollector(limit = 500, connectionLimit = 10000) {
  const domains = new Map<string, DomainCandidate>();
  let seen = new Set<string>();
  let saturated = false;
  return {
    add(items: ConnectionItem[], scope: ObservationScope, now: number, includeBundle = false, epoch: number | null = null) {
      const nextSeen = new Set<string>();
      for (const item of items) {
        const match = attribution(item, scope, includeBundle);
        const domain = match && detectedDomain(item.metadata.host || "");
        if (!match || !domain) continue;
        const id = `${epoch}:${item.id}:${item.start}:${domain}`;
        // Retain only identities in this sample, so ended connections cannot exhaust a long session.
        if (!nextSeen.has(id) && nextSeen.size >= connectionLimit) { saturated = true; continue; }
        const repeated = seen.has(id) || nextSeen.has(id);
        nextSeen.add(id);
        let row = domains.get(domain);
        if (!row) {
          if (domains.size >= limit) { saturated = true; domains.delete(domains.keys().next().value!); }
          row = { domain, connections: 1, lastSeen: now, sources: [], processes: [], confirmed: false };
        } else if (!repeated) {
          row.connections++;
        }
        // Map order is observation recency; keep a rolling, bounded candidate list.
        domains.delete(domain); domains.set(domain, row);
        row.lastSeen = now; row.confirmed ||= match.confirmed;
        if (!row.sources.includes(match.source) && row.sources.length < 4) row.sources.push(match.source);
        if (!row.processes.includes(match.process) && row.processes.length < 4) row.processes.push(match.process);
      }
      seen = nextSeen;
      return [...domains.values()].map(row => ({ ...row, sources: [...row.sources], processes: [...row.processes] }));
    },
    get saturated() { return saturated; },
  };
}
