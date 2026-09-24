import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import type { BundleRepository } from "../../types/bundleRepository";

const input = "w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-indigo-500/40";
const button = "rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50";
interface Props {
  open: boolean; repositories: BundleRepository[]; defaultId: string; error: string;
  onClose(): void; onSave(repo: BundleRepository): boolean; onToggle(id: string): void; onRemove(id: string): boolean;
}
export function RepositoryManager({ open, repositories, defaultId, error, onClose, onSave, onToggle, onRemove }: Props) {
  const ref = useRef<HTMLDialogElement>(null), nameRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<BundleRepository | null>(null), [removing, setRemoving] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current; setDraft(null); setRemoving(null); dialog?.showModal();
    return () => { dialog?.close(); if (trigger?.isConnected) trigger.focus(); };
  }, [open]);
  useEffect(() => { if (draft) nameRef.current?.focus(); }, [draft?.id]);
  if (!open) return null;
  const add = () => { setRemoving(null); setDraft({ id: crypto.randomUUID(), name: "", kind: "github", url: "", branch: "", directory: "", enabled: true }); };
  return createPortal(<dialog ref={ref} aria-labelledby="repository-manager-title" onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) { const r = ref.current.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }} className="m-auto w-[min(46rem,calc(100vw-2rem))] max-h-[90dvh] overflow-y-auto rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 p-0 shadow-xl backdrop:bg-slate-950/40">
    <header className="flex justify-between items-center p-5 border-b border-slate-100 dark:border-slate-800"><div><h2 id="repository-manager-title" className="font-bold">管理规则仓库</h2><p className="text-xs text-slate-500 mt-1">最多 20 个来源；停用或删除来源后，已装载套件仍然保留。</p></div><button type="button" onClick={onClose} aria-label="关闭仓库管理" className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"><X size={18} /></button></header>
    <div className="p-5 space-y-4">
      <ul className="space-y-2">{repositories.map(repo => <li key={repo.id} className="rounded-xl border border-slate-200 dark:border-slate-700 p-3">
        <div className="flex gap-3 items-start"><div className="flex-1 min-w-0"><div className="text-sm font-semibold break-words">{repo.name}{repo.id === defaultId && <span className="ml-2 text-[10px] text-indigo-600 dark:text-indigo-300">内置</span>}</div><p className="text-[11px] text-slate-500 break-all mt-1">{repo.url}</p>{repo.kind === "github" && <p className="text-[11px] text-slate-500 mt-1 break-words">{repo.branch || "默认分支"} · {repo.directory || "根目录"}</p>}</div>
          <div className="flex items-center gap-1 shrink-0"><button type="button" role="switch" aria-checked={repo.enabled} aria-label={`${repo.enabled ? "停用" : "启用"}仓库 ${repo.name}`} onClick={() => onToggle(repo.id)} className={`relative w-10 h-5 rounded-full ${repo.enabled ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-700"}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${repo.enabled ? "left-0.5 translate-x-5" : "left-0.5"}`} /></button>
            {repo.id !== defaultId && <><button type="button" aria-label={`编辑仓库 ${repo.name}`} className="p-2 text-slate-500 hover:text-indigo-500" onClick={() => { setRemoving(null); setDraft({ ...repo }); }}><Pencil size={15} /></button><button type="button" aria-label={`删除仓库 ${repo.name}`} className="p-2 text-slate-500 hover:text-rose-500" onClick={() => setRemoving(repo.id)}><Trash2 size={15} /></button></>}
          </div>
        </div>
        {removing === repo.id && <div className="mt-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 text-xs space-y-2"><p>删除「{repo.name}」的仓库配置？已装载套件和出口绑定保持不变。</p><div className="flex gap-2"><button type="button" className={button} onClick={() => setRemoving(null)}>取消删除</button><button type="button" className="px-3 py-2 rounded-xl bg-rose-600 text-white" onClick={() => { if (onRemove(repo.id)) { setRemoving(null); if (draft?.id === repo.id) setDraft(null); } }}>确认删除来源</button></div></div>}
      </li>)}</ul>
      {error && <p role="alert" className="rounded-xl p-3 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 text-xs break-words">{error}</p>}
      {draft ? <form aria-label="仓库配置" className="rounded-xl border border-indigo-200 dark:border-indigo-800 p-4 space-y-3" onSubmit={e => { e.preventDefault(); if (onSave(draft)) setDraft(null); }}>
        <h3 className="text-sm font-bold">{repositories.some(r => r.id === draft.id) ? "编辑仓库" : "添加仓库"}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><label className="text-xs space-y-1 block"><span>仓库名称</span><input ref={nameRef} required maxLength={80} className={input} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label><label className="text-xs space-y-1 block"><span>来源类型</span><select className={input} value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as BundleRepository["kind"] })}><option value="github">GitHub 公开仓库</option><option value="index">HTTPS JSON 索引</option></select></label></div>
        <label className="text-xs space-y-1 block"><span>仓库地址</span><input required className={input} value={draft.url} maxLength={2048} placeholder={draft.kind === "github" ? "https://github.com/所有者/仓库/tree/main/Business-Rules" : "https://example.com/rules/index.json"} onChange={e => setDraft({ ...draft, url: e.target.value })} /></label>
        {draft.kind === "github" ? <><div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><label className="text-xs space-y-1 block"><span>分支 / 标签（可选）</span><input className={input} value={draft.branch} maxLength={200} placeholder="留空使用目录链接或仓库默认分支" onChange={e => setDraft({ ...draft, branch: e.target.value })} /></label><label className="text-xs space-y-1 block"><span>规则包目录（可选）</span><input className={input} value={draft.directory} maxLength={400} placeholder="例如 Business-Rules；留空读取链接目录" onChange={e => setDraft({ ...draft, directory: e.target.value })} /></label></div><p className="text-xs text-slate-500">读取指定目录下的 .pwpack.json 文件。分支名含 / 时，请使用仓库首页地址并单独填写分支和目录。</p></> : <div className="text-xs text-slate-500 space-y-1"><p>支持直接填写 .pwpack.json 地址，或提供 packages 列表；文件地址可相对于索引。</p><pre className="whitespace-pre-wrap break-all rounded-lg bg-slate-50 dark:bg-slate-950 p-2">{'{"packages":["browser.pwpack.json","tools.pwpack.json"]}'}</pre></div>}
        <div className="flex justify-end gap-2"><button type="button" className={button} onClick={() => setDraft(null)}>取消编辑</button><button type="submit" className="px-4 py-2 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white">保存仓库</button></div>
      </form> : <button type="button" disabled={repositories.length >= 20 || !repositories.length} onClick={add} className="inline-flex gap-1.5 items-center rounded-xl px-4 py-2 text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"><Plus size={15} />添加仓库</button>}
    </div>
  </dialog>, document.body);
}
