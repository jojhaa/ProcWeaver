import type { ProcessEntry, ProcessRule, ProcessSelection, RoutingTarget } from "../types/routingOverrides";
export function treeRows(entries: ProcessEntry[], query: string, expanded: Set<string>) {
  const index = new Map(entries.map(p => [p.identity || `unknown:${p.pid}`, p]));
  const visible = new Set<string>(); const q = query.trim().toLowerCase();
  if (q) for (const [key, p] of index) if (`${p.name} ${p.executablePath || ""} ${p.pid}`.toLowerCase().includes(q)) {
    let current: string | null = key; const visited = new Set<string>();
    while (current && !visited.has(current)) { visited.add(current); visible.add(current); current = index.get(current)?.parentIdentity || null; }
  }
  const children = new Map<string | null, string[]>();
  for (const [key, p] of index) { const parent = p.parentIdentity && index.has(p.parentIdentity) && p.parentIdentity !== key ? p.parentIdentity : null; children.set(parent, [...(children.get(parent) || []), key]); }
  const rows: { entry: ProcessEntry; key: string; depth: number; hasChildren: boolean }[] = []; const visited = new Set<string>();
  const visit = (key: string, depth: number) => { if (visited.has(key) || depth > 64) return; visited.add(key); if (q && !visible.has(key)) return;
    rows.push({ entry: index.get(key)!, key, depth, hasChildren: !!children.get(key)?.length });
    if (q || expanded.has(key)) for (const child of children.get(key) || []) visit(child, depth + 1);
  };
  for (const root of children.get(null) || []) visit(root, 0);
  return rows;
}
export function subtree(entries: ProcessEntry[], root: string): string[] {
  const children = new Map<string, string[]>();
  for (const p of entries) if (p.identity && p.parentIdentity) children.set(p.parentIdentity, [...(children.get(p.parentIdentity) || []), p.identity]);
  const selected = new Set<string>(); const pending = [root];
  while (pending.length) { const id = pending.pop()!; if (selected.has(id)) continue; selected.add(id); pending.push(...(children.get(id) || [])); }
  return [...selected];
}
export function previewSelection(entries: ProcessEntry[], selected: Set<string>, existing: ProcessRule[], action: ProcessRule["action"], target: RoutingTarget | null, includeDescendants: boolean) {
  const rules: ProcessRule[] = []; const selections: ProcessSelection[] = []; const errors: string[] = []; let reused = 0;
  const byPath = new Map(existing.map(r => [`${r.matchKind}:${r.matchValue.toLowerCase()}`, r]));
  for (const id of selected) {
    const p = entries.find(p => p.identity === id);
    if (!p?.executablePath) { errors.push(p ? `${p.name} 无可读取路径` : "所选进程已退出，请重新选择"); continue; }
    const key = `path:${p.executablePath.toLowerCase()}`; const old = byPath.get(key);
    if (old) { if (old.action !== action || JSON.stringify(old.target) !== JSON.stringify(target) || old.includeDescendants !== includeDescendants) errors.push(`${p.name} 已有不同规则`); else reused++; continue; }
    const rule: ProcessRule = { id: crypto.randomUUID(), enabled: true, label: p.name, matchKind: "path", matchValue: p.executablePath, action, target, includeDescendants };
    rules.push(rule); byPath.set(key, rule); selections.push({ identity: p.identity, executablePath: p.executablePath });
  }
  return { rules, selections, errors, reused };
}
export const splitDomains = (text: string) => [...new Set(text.split(/[\s,，;；、]+/).map(s => s.trim().replace(/\.$/, "").toLowerCase()).filter(Boolean))];
