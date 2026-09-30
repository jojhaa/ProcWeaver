import type { DnsListenerMode, DnsListenerStatus } from "../api/dns";

interface Props {
  mode?: DnsListenerMode | null;
  status: DnsListenerStatus | null;
  error: string;
  onChange(mode: DnsListenerMode): void;
}

export function DnsListenerSettings({ mode, status, error, onChange }: Props) {
  const actual = !status ? "正在读取 DNS 运行状态…" : !status.running
    ? "核心未启动，不占用 DNS 端口；可保存设置，等待启动后应用。"
    : status.listen ? `核心已确认监听：${status.listen}（TCP / UDP）`
    : status.resolverEnabled ? "核心内部解析已启用，未开放本地 DNS 端口。" : "核心 DNS 未启用。";
  return <div className="bg-white/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3 text-xs">
    <label className="flex flex-wrap items-center justify-between gap-3 font-semibold text-slate-900 dark:text-white">
      本地 DNS 监听策略
      <select aria-label="本地 DNS 监听策略" value={mode ?? "legacy"} onChange={event => onChange(event.target.value as DnsListenerMode)}
        className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500">
        {!mode && <option value="legacy" disabled>沿用现有监听</option>}
        <option value="auto">自动（推荐）</option>
        <option value="fixed">固定地址与端口</option>
        <option value="off">关闭本地监听</option>
      </select>
    </label>
    <p className="text-slate-500 dark:text-slate-400 leading-relaxed">
      {mode === "auto" ? "有 DNS 接管需求时自动分配本地端口，优先复用上次成功端口；其他情况仅保留内部解析。53 端口和局域网 DNS 监听保持固定。"
        : mode === "off" ? "仅关闭本地监听，保留核心内部解析和上游设置。DNS 护航或 DNS 接管规则仍启用时不能关闭。"
        : "按指定监听运行，端口被占用会明确报错。供系统 DNS 或其他客户端使用时请选择固定模式。"}
    </p>
    <p aria-live="polite" className={error ? "text-rose-600 dark:text-rose-400" : "text-slate-600 dark:text-slate-300"}>{error || actual}</p>
  </div>;
}
