import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, RefreshCw, X } from "lucide-react";
import { VirtualList } from "../VirtualList";
import { processTreeRows, selectedBindings } from "../../services/processDiscovery";
import { useProcessDiscovery, type DiscoveryInput } from "../../hooks/useProcessDiscovery";
import type { BundleProcessBinding } from "../../types/businessBundle";

type Props = { mode: "processes" | "domains"; input: DiscoveryInput; onClose: () => void;
  onProcesses: (items: BundleProcessBinding[]) => void; onDomains: (domains: string[]) => void };
const button = "px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500";

export function ProcessDiscoveryDialog(props: Props) {
  const model = useProcessDiscovery(props.input);
  return <DiscoveryDialog {...props} model={model} />;
}
function DiscoveryDialog({ mode, input, onClose, onProcesses, onDomains, model }: Props & { model: ReturnType<typeof useProcessDiscovery> }) {
  const { state, actions } = model;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  const [expanded, setExpanded] = useState(new Set<string>());
  const [descendants, setDescendants] = useState(true);
  const ref = useRef<HTMLDivElement>(null), title = useId();
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLInputElement>("input[type=search]")?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
      if (event.key !== "Tab") return;
      const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])].filter(n => n.getClientRects().length);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyboard, true);
    return () => { document.removeEventListener("keydown", keyboard, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  const toggle = (id: string) => setSelected(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const rows = useMemo(() => processTreeRows(state.entries, expanded, query), [state.entries, expanded, query]);
  const domains = useMemo(() => state.domains.filter(d => `${d.domain} ${d.processes.join(" ")}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.domain.localeCompare(b.domain)), [state.domains, query]);
  const chosenProcesses = useMemo(() => selectedBindings(state.entries, selected, descendants, input.platform), [state.entries, selected, descendants, input.platform]);
  const chosenDomains = [...selected];
  return createPortal(<div className="fixed inset-0 z-[90] bg-black/50 flex items-center justify-center p-3" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={title} className="w-full max-w-3xl max-h-[92vh] flex flex-col rounded-2xl shadow-2xl bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700 text-xs overflow-hidden">
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
        <div><h3 id={title} className="text-sm font-bold">{mode === "processes" ? "从运行进程选择" : "检测已连接域名"}</h3>
          <p className="text-slate-500 dark:text-slate-400 mt-1">当前模式：{state.mode} · 纯应用层、TUN、WinDivert 共用此选择器</p></div>
        <button type="button" aria-label="关闭选择窗口" onClick={onClose} className={button}><X size={16} /></button>
      </div>
      <div className="p-4 space-y-3 overflow-y-auto min-h-0">
        <p className="text-slate-500 dark:text-slate-400 leading-relaxed">{mode === "processes"
          ? "按实际父子关系展示。选择父进程并包含子进程时，仅保存根程序路径，由已有进程树规则跟踪后代；不会把整棵树的文件名添加为全局规则。同路径的多个实例共用此绑定。"
          : "开始后持续检测，关闭窗口停止采集，也可手动停止。仅汇总进入当前核心且能关联到选择范围的连接；纯应用层需先接入代理。短连接可能漏采，仅有 IP 或域名不可见时不会猜测。重新开始会清空上次候选。"}</p>
        <div className="flex flex-wrap gap-2 items-center">
          <input type="search" aria-label={mode === "processes" ? "搜索进程、PID 或路径" : "搜索域名或进程"} placeholder={mode === "processes" ? "搜索进程、PID 或路径" : "搜索域名或进程"} value={query} onChange={e => setQuery(e.target.value)} className="min-w-0 flex-1 basis-48 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 bg-slate-50 dark:bg-slate-950 focus:outline-indigo-500" />
          {mode === "processes" ? <button type="button" className={button} disabled={state.loading} onClick={() => void actions.refresh()}><RefreshCw size={13} className="inline mr-1" />刷新进程</button>
            : <button type="button" className={button} disabled={state.loading || !input.members.length} onClick={() => { if (state.running) actions.stop(); else { setSelected(new Set()); actions.start(); } }}>{state.running ? "停止检测" : "开始检测"}</button>}
        </div>
        {mode === "processes" ? <label className="flex items-center gap-2"><input type="checkbox" checked={descendants} onChange={e => setDescendants(e.target.checked)} />包含子进程（也跟踪后续新启动的子进程）</label>
          : input.bundleId && <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={state.includeBundle} disabled={state.running} onChange={e => { setSelected(new Set()); actions.includeBundle(e.target.checked); }} />也显示本业务包入口的域名（可能包含包内其他进程，单独标注）</label>}
        {state.error && <p role="alert" className="text-amber-700 dark:text-amber-300 break-words">{state.error}</p>}
        {state.limited && <p role="status" className="text-amber-700 dark:text-amber-300">候选滚动保留最近 500 个域名，每次最多处理 10000 条匹配连接；检测仍在继续，已勾选项不会丢失。</p>}
        {mode === "processes" ? <>
          <div className="flex gap-2"><button type="button" className={button} onClick={() => setExpanded(new Set(state.entries.map(p => p.identity)))}>展开全部</button><button type="button" className={button} onClick={() => setExpanded(new Set())}>收起全部</button></div>
          {state.loading ? <p role="status">正在读取进程树…</p> : !rows.length ? <p role="status">没有匹配的进程，可修改搜索条件或刷新。</p> :
            <VirtualList items={rows} itemKey={r => r.entry.identity} rowHeight={62} className="h-[min(42vh,360px)] rounded-xl border border-slate-200 dark:border-slate-700" label="运行进程树" renderRow={({ entry, depth, hasChildren }) => <div className="flex gap-2 items-center h-full pr-2" style={{ paddingLeft: 8 + Math.min(depth, 6) * 16 }}>
              <button type="button" aria-label={`${expanded.has(entry.identity) ? "收起" : "展开"} ${entry.name} ${entry.pid}`} aria-expanded={expanded.has(entry.identity)} disabled={!hasChildren} className="p-1 disabled:invisible shrink-0" onClick={() => setExpanded(old => { const next = new Set(old); if (next.has(entry.identity)) next.delete(entry.identity); else next.add(entry.identity); return next; })}><ChevronRight size={14} className={expanded.has(entry.identity) ? "rotate-90" : ""} /></button>
              <label className="flex gap-2 items-center min-w-0 flex-1 cursor-pointer"><input type="checkbox" checked={selected.has(entry.identity)} disabled={!entry.executablePath} onChange={() => toggle(entry.identity)} aria-label={`选择 ${entry.name} PID ${entry.pid}`} />
                <span className="min-w-0"><span className="block truncate font-semibold">{entry.name} <span className="font-normal text-slate-500">PID {entry.pid}</span></span><span className="block truncate text-[11px] text-slate-500 dark:text-slate-400" title={entry.executablePath ?? "路径无法读取，不能保存可靠绑定"}>{entry.executablePath || "路径无法读取，不能保存可靠绑定"}</span></span>
              </label></div>} />}
        </> : <>
          <div className="flex flex-wrap gap-2 items-center"><span>{state.domains.length} 个域名 · 已选 {chosenDomains.length} 个</span><button type="button" className={button} onClick={() => setSelected(new Set([...selected, ...domains.filter(d => d.confirmed).map(d => d.domain)]))}>选择按路径关联的候选</button><button type="button" className={button} onClick={() => setSelected(new Set())}>清空选择</button></div>
          {!domains.length ? <p role="status" className="py-10 text-center text-slate-500">{state.running ? "尚未观察到匹配域名，请在目标应用发起新请求。" : "点击开始检测；未发现域名不代表应用没有网络请求。"}</p> :
            <VirtualList items={domains} itemKey={d => d.domain} rowHeight={84} className="h-[min(42vh,360px)] rounded-xl border border-slate-200 dark:border-slate-700" label="已观察域名" renderRow={d => <label className="flex gap-3 px-3 items-center h-full cursor-pointer min-w-0"><input type="checkbox" checked={selected.has(d.domain)} onChange={() => toggle(d.domain)} aria-label={`选择域名 ${d.domain}`} /><span className="min-w-0 flex-1"><span className="block font-mono font-semibold truncate" title={d.domain}>{d.domain}</span><span className="block truncate text-[11px] text-slate-500 dark:text-slate-400" title={d.processes.join("、")}>{d.processes.join("、")} · {d.connections} 条连接 · {new Date(d.lastSeen).toLocaleTimeString()}</span><span className={`block truncate text-[11px] ${d.confirmed ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-300"}`} title={d.sources.join("；")}>{d.sources.join("；")}</span></span></label>} />}
          <p className="text-slate-500 dark:text-slate-400">按准确域名加入，不自动扩大为通配域名。连接数按连续采样去重，漏采后重现可能重复计数。候选滚动保留最近 500 个域名，已勾选项保留至加入或清空；关闭窗口释放记录。</p>
        </>}
      </div>
      <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
        <button type="button" className={button} onClick={onClose}>取消</button>
        <button type="button" disabled={mode === "processes" ? !chosenProcesses.length || state.loading : !chosenDomains.length} className="px-4 py-2 rounded-lg bg-indigo-600 text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400" onClick={() => { if (mode === "processes") onProcesses(chosenProcesses); else onDomains(chosenDomains); onClose(); }}>{mode === "processes" ? `加入 ${chosenProcesses.length} 个程序` : `加入 ${chosenDomains.length} 个域名`}</button>
      </div>
    </div>
  </div>, document.body);
}
