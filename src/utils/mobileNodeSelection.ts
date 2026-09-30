import type { ProxyGroup } from "../types";

export type MobileCoreMode = "rule" | "global" | "direct" | null;

export function mobileSelectionGroup(groups: ProxyGroup[], mode: MobileCoreMode, selected = "") {
  const selectors = groups.filter(group => /^(selector|select)$/i.test(group.type));
  if (mode === "global") return selectors.find(group => group.name === "GLOBAL");
  if (mode !== "rule") return undefined;
  const candidates = selectors.filter(group => group.name !== "GLOBAL");
  if (selected) return candidates.find(group => group.name === selected);
  return candidates.find(group => group.name === "PROXY") ?? (candidates.length === 1 ? candidates[0] : undefined);
}

export function selectedLeaf(groups: ProxyGroup[], group?: ProxyGroup) {
  let name = group?.now ?? "";
  const visited = new Set<string>();
  while (name && !visited.has(name)) {
    visited.add(name);
    const child = groups.find(candidate => candidate.name === name);
    if (!child) return name;
    name = child.now ?? "";
  }
  return "";
}
