import { useState } from "react";
import { ExternalLink, RefreshCw, Settings2 } from "lucide-react";
import type { BundleLocalInstance } from "../../types/businessBundle";
import type { BundleRepository, RepositoryPackage, RepositorySnapshot } from "../../types/bundleRepository";
import { RepositoryManager } from "./RepositoryManager";

interface Props {
  state: RepositorySnapshot; defaultId: string; instances: BundleLocalInstance[];
  onRefresh(id?: string): void; onReload(): void; onSave(repo: BundleRepository): boolean; onToggle(id: string): void; onRemove(id: string): boolean;
  onInstall(item: RepositoryPackage): void; repositoryLink(repo: BundleRepository): string;
}
const button = "inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs disabled:opacity-50";
export function RepositoryCenter(props: Props) {
  const { state } = props;
  const [selected, setSelected] = useState("all"), [manager, setManager] = useState(false), [query, setQuery] = useState("");
  const enabled = state.repositories.filter(r => r.enabled);
  const effectiveSelected = enabled.some(r => r.id === selected) ? selected : "all";
  const visible = enabled.filter(r => effectiveSelected === "all" || r.id === effectiveSelected);
  const loading = visible.some(r => state.statuses[r.id]?.loading);
  const packages = visible.flatMap(r => state.statuses[r.id]?.packages || []).filter(p => `${p.definition.packageName} ${p.definition.description} ${p.definition.packageId}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold text-slate-900 dark:text-white">规则仓库业务套件</h2><p className="text-xs text-slate-500 mt-1">已启用 {enabled.length} / {state.repositories.length} 个来源；装载新实例后再选择本机出口。</p></div><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={loading || !enabled.length} onClick={() => props.onRefresh(effectiveSelected === "all" ? undefined : effectiveSelected)}><RefreshCw size={14} className={loading ? "animate-spin" : ""} />{loading ? "刷新中…" : effectiveSelected === "all" ? "刷新全部仓库" : "刷新当前仓库"}</button><button type="button" className={button} onClick={() => setManager(true)}><Settings2 size={14} />管理仓库</button></div></div>
    <div className="flex flex-wrap gap-3"><label className="flex gap-2 items-center text-xs text-slate-600 dark:text-slate-400">仓库来源<select aria-label="筛选仓库来源" value={effectiveSelected} onChange={e => setSelected(e.target.value)} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 max-w-60"><option value="all">全部已启用仓库</option>{enabled.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label><input aria-label="搜索仓库规则包" placeholder="搜索规则包名称、说明或 ID" value={query} maxLength={200} onChange={e => setQuery(e.target.value)} className="min-w-0 flex-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500/40" /></div>
    {state.error && <div role="alert" className="text-xs bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 p-3 rounded-xl flex gap-3 items-center justify-between"><span>{state.error}</span><button type="button" className={button} onClick={props.onReload}>重新加载配置</button></div>}
    <div className="space-y-2">{visible.map(repo => { const status = state.statuses[repo.id]; return <div key={repo.id} className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><span className="font-semibold break-words">{repo.name}</span><span className="ml-2 text-slate-500">{status?.loading ? "正在读取…" : status?.error ? status.packages.length ? "刷新失败 · 显示上次成功结果" : "读取失败" : status?.fetched ? `${status.packages.length} 个规则包` : "等待读取"}</span>{status?.updatedAt && <span className="ml-2 text-slate-400">{new Date(status.updatedAt).toLocaleTimeString()}</span>}</div><div className="flex shrink-0 gap-2"><button type="button" disabled={status?.loading} aria-label={`刷新仓库 ${repo.name}`} onClick={() => props.onRefresh(repo.id)} className="p-1 text-slate-500 hover:text-indigo-500 disabled:opacity-50"><RefreshCw size={14} /></button><a aria-label={`访问仓库 ${repo.name}`} href={props.repositoryLink(repo)} target="_blank" rel="noreferrer" className="p-1 text-slate-500 hover:text-indigo-500"><ExternalLink size={14} /></a></div></div>
      {status?.error && <p role="alert" className="text-amber-700 dark:text-amber-300 mt-2 break-words">{status.error}</p>}
      {!!status?.warnings.length && <details className="mt-2 text-amber-700 dark:text-amber-300"><summary className="cursor-pointer">{status.warnings.length} 项未载入，查看原因</summary><ul className="list-disc pl-5 mt-1 space-y-1">{status.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
    </div>; })}</div>
    {!packages.length ? <div className="p-10 text-center rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-sm text-slate-500">{loading ? "正在读取规则包…" : !enabled.length ? "暂无启用的仓库，请在管理仓库中添加或启用来源。" : query ? "没有匹配的规则包。" : visible.some(r => state.statuses[r.id]?.error) ? "暂时没有可用结果，请查看上方仓库错误并重试。" : "所选仓库暂未提供规则包。"}</div> : <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{packages.map(item => {
      const bundle = item.definition;
      const installed = props.instances.some(i => i.definition.packageId === bundle.packageId && i.repositoryOrigin?.repositoryKey === item.origin.repositoryKey);
      return <article key={item.key} className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs space-y-3"><div className="flex gap-3"><span className="text-2xl">{bundle.icon}</span><div className="min-w-0 flex-1"><h3 className="text-sm font-bold text-slate-900 dark:text-white break-words">{bundle.packageName}<span className="ml-2 text-[10px] font-mono text-slate-500">{bundle.packageVersion}</span></h3><p className="text-[11px] text-slate-500 mt-1 break-words">{bundle.description}</p><p className="text-[11px] text-indigo-600 dark:text-indigo-300 mt-2 break-words">来源：{item.origin.repositoryName}</p></div></div><div className="flex flex-wrap gap-1">{bundle.processes.slice(0, 8).map((p, i) => <span key={i} className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-slate-100 dark:bg-slate-800 text-slate-500 break-all">{p.exe}</span>)}{bundle.processes.length > 8 && <span className="text-[10px] text-slate-500">等 {bundle.processes.length} 个进程</span>}</div><div className="flex justify-end"><button type="button" onClick={() => props.onInstall(item)} className="px-3 py-1.5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white">{installed ? "再装载一个实例" : "装载到本机"}</button></div></article>;
    })}</div>}
    <RepositoryManager open={manager} onClose={() => setManager(false)} repositories={state.repositories} defaultId={props.defaultId} error={state.error} onSave={props.onSave} onToggle={props.onToggle} onRemove={props.onRemove} />
  </section>;
}
