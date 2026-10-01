import type { ExternalEndpoint, ExternalProbeDraft, ExternalProbeKind, ExternalProbeRecord } from "../../types/externalProxy";

type Props = {
  busy: boolean;
  endpoint?: ExternalEndpoint;
  draft: ExternalProbeDraft;
  presets: readonly { id: string; label: string }[];
  records: ExternalProbeRecord[];
  onDraft: (draft: ExternalProbeDraft) => void;
  onKind: (kind: ExternalProbeKind) => void;
  onPreset: (id: string) => void;
  onTest: () => void;
  onClear: () => void;
};
const input = "w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-50";
const button = "rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-indigo-500";
const labels: Record<ExternalProbeKind, string> = { tcp: "TCP", udp_dns: "UDP · DNS", udp_stun: "UDP · STUN" };

export function ExternalProxyProbePanel({ busy, endpoint, draft, presets, records, onDraft, onKind, onPreset, onTest, onClear }: Props) {
  const unsupported = draft.kind !== "tcp" && endpoint?.protocol !== "socks5";
  return <section aria-label="代理连接检测" className="border-t border-slate-200 dark:border-slate-700 pt-4 space-y-3">
    <strong>已保存代理的连接检测</strong>
    <p className="text-slate-500 break-words">{endpoint ? `检测代理：${endpoint.name} · ${endpoint.protocol.toUpperCase()}` : "请先保存或选择代理；连接参数和认证信息修改后需重新保存。"}</p>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <label className="space-y-1">检测类型<select aria-label="连接检测类型" className={input} disabled={busy} value={draft.kind} onChange={e => onKind(e.target.value as ExternalProbeKind)}>
        <option value="tcp">TCP · 建立目标隧道</option><option value="udp_dns">UDP · DNS 查询</option><option value="udp_stun">UDP · STUN 往返</option>
      </select></label>
      <label className="space-y-1">目标预设<select aria-label="连接检测预设" className={input} disabled={busy} value={draft.preset} onChange={e => onPreset(e.target.value)}>
        {presets.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}<option value="custom">自定义地址</option>
      </select></label>
      <label className="space-y-1">{draft.kind === "udp_dns" ? "DNS 服务器地址" : "目标域名 / IP"}<input aria-label="检测目标地址" className={input} disabled={busy} value={draft.host} maxLength={255} spellCheck={false} onChange={e => onDraft({ ...draft, preset: "custom", host: e.target.value })} /></label>
      <label className="space-y-1">目标端口<input aria-label="检测目标端口" className={input} type="number" min={1} max={65535} disabled={busy} value={draft.port} onChange={e => onDraft({ ...draft, preset: "custom", port: Number(e.target.value) })} /></label>
      {draft.kind === "udp_dns" && <label className="space-y-1">查询域名<input aria-label="DNS 检测查询域名" className={input} disabled={busy} value={draft.queryName} list="external-dns-query-presets" maxLength={253} spellCheck={false} onChange={e => onDraft({ ...draft, queryName: e.target.value })} /><datalist id="external-dns-query-presets"><option value="example.com" /><option value="cloudflare.com" /><option value="google.com" /></datalist></label>}
      <label className="space-y-1">超时时间<select aria-label="连接检测超时" className={input} disabled={busy} value={draft.timeoutMs} onChange={e => onDraft({ ...draft, timeoutMs: Number(e.target.value) })}>
        {[3, 5, 10, 15, 30].map(seconds => <option key={seconds} value={seconds * 1000}>{seconds} 秒</option>)}
      </select></label>
    </div>
    {endpoint && unsupported && <p className="text-amber-700 dark:text-amber-300">HTTP 代理不支持此 UDP 检测，请选择已保存的 SOCKS5 代理。</p>}
    <div className="flex gap-2 flex-wrap"><button className={`${button} text-indigo-600 dark:text-indigo-300`} disabled={busy || !endpoint || unsupported} onClick={onTest}>{records.some(r => r.state === "running") ? "正在检测…" : "开始连接检测"}</button>{records.length > 0 && <button className={button} disabled={busy} onClick={onClear}>清空检测结果</button>}</div>
    <p className="text-slate-500 leading-relaxed">{draft.kind === "tcp" ? "TCP 检测确认代理可建立目标隧道，不验证 TLS 或网页内容。" : draft.kind === "udp_dns" ? "向指定服务器发送 DNS A 查询，收到匹配的 UDP 响应才确认可达，不转为 TCP 重试。" : "目标须提供 STUN 服务，收到匹配的 Binding 响应才确认 UDP 往返。"} 仅手动检测已保存代理，不验证业务应用接入，也不修改 DNS 设置。预设服务的可达性取决于上游网络。</p>
    <div aria-live="polite" aria-relevant="additions text" className="space-y-2">
      {records.map(r => <div key={r.id} data-probe-state={r.state} className={`rounded-xl border p-3 space-y-1 break-words ${r.state === "failed" ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300" : r.state === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300" : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-950"}`}>
        <div className="flex gap-2 flex-wrap justify-between"><strong>{labels[r.kind]} · {r.state === "running" ? "检测中" : r.state === "success" ? "通过" : "未通过"}</strong><span>{r.state === "running" ? "等待响应" : `${r.elapsedMs} ms`}</span></div>
        <div className="break-all">{r.endpoint} → {r.host.includes(":") ? `[${r.host}]` : r.host}:{r.port}{r.kind === "udp_dns" && ` · 查询 ${r.queryName}`}</div>
        <p>{r.message}</p>
      </div>)}
    </div>
  </section>;
}
