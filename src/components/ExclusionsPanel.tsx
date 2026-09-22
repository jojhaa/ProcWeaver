export interface ExclusionsPanelProps {
  expanded?: boolean;
  state: { text: string; enabled: boolean; loading: boolean; saving: boolean; error: string; message: string; ready: boolean };
  actions: { edit: (value: string) => void; enable: (value: boolean) => void; reload: () => void; save: () => void };
}

export function ExclusionsPanel({ state, actions, expanded = false }: ExclusionsPanelProps) {
  const disabled = state.loading || state.saving || !state.ready;
  const content = <div className="mt-4 space-y-3">
      <p id="exclusions-help" className="text-sm text-slate-600 dark:text-slate-400">
        支持换行、空格、逗号（中英文）、分号（中英文）和顿号分隔。example.com 精确匹配；+.example.com 包含主域和全部子域；*.example.com 匹配子域，通配符支持 * 和 ?；也支持 IPv4、IPv6 和 CIDR 网段（如 192.168.1.0/24）。只填写域名或地址，不含协议、端口。最多 2000 项。
      </p>
      <p className="text-sm text-slate-600 dark:text-slate-400">仅在规则分流模式下优先直连，独立于自动补充开关。修改后点击保存；删除对应行并保存即可取消排除。</p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={state.enabled} disabled={disabled} onChange={e => actions.enable(e.target.checked)} />启用排除列表
      </label>
      <label htmlFor="exclusions-entries" className="block text-sm">域名与 IP 列表</label>
      <textarea id="exclusions-entries" aria-describedby="exclusions-help" value={state.text}
        onChange={e => actions.edit(e.target.value)} disabled={disabled} rows={7} maxLength={512000} spellCheck={false}
        placeholder={"+.example.com\n*.example.org\n192.168.1.0/24\n2001:db8::/32"}
        className="w-full rounded-lg border border-slate-300 bg-white p-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-950" />
      {state.loading && <p role="status">正在读取排除列表…</p>}
      {state.error && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{state.error}</p>}
      {state.message && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{state.message}</p>}
      <div className="flex flex-wrap gap-2">
        <button disabled={disabled} onClick={actions.save} className="rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white disabled:opacity-50">{state.saving ? "正在保存…" : "保存排除列表"}</button>
        {!state.ready && !state.loading && <button onClick={actions.reload} className="rounded-lg border border-slate-400 px-3 py-2 text-sm">重新读取</button>}
      </div>
    </div>;
  if (expanded) return content;
  return <details className="rounded-xl border border-slate-300 bg-white p-4 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
    <summary className="cursor-pointer font-semibold">排除域名 / IP（直连）</summary>
    {content}
  </details>;
}
