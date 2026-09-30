import { useState } from "react";
import type { useMobileMaintenance } from "../hooks/useMobileMaintenance";
import {
  Download,
  RefreshCw,
  BarChart3,
  Trash2,
  ArrowUp,
  ArrowDown,
  ExternalLink,
} from "lucide-react";

export function MobileMaintenancePanel({
  state,
}: {
  state: ReturnType<typeof useMobileMaintenance>;
}) {
  const [shown, setShown] = useState(30);
  const [onlyProxy, setOnlyProxy] = useState(true);
  const proxyRows =
    state.proxyHistory?.rows.filter((row) => !onlyProxy || row.proxied) ?? [];
  const proxyTotals = proxyRows.reduce((totals, row) => ({ upload: totals.upload + row.upload, download: totals.download + row.download }), { upload: 0, download: 0 });
  const systemRows = state.history?.rows ?? [];
  const systemTotals = systemRows.reduce((totals, row) => ({ upload: totals.upload + row.upload, download: totals.download + row.download }), { upload: 0, download: 0 });
  const bytes = (value: number) => {
    if (value >= 1024 * 1024 * 1024) {
      return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
  };

  const inputClass =
    "rounded-xl border border-slate-200 dark:border-slate-700 p-2 bg-slate-50/60 dark:bg-slate-800/60 text-xs text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition";

  return (
    <div className="space-y-4" aria-label="手机维护与历史流量">
      {/* 1. 应用与核心更新 */}
      <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800/80 bg-white dark:bg-slate-900/80 p-3 shadow-sm space-y-2.5">
        <div className="flex items-center space-x-2 border-b border-slate-100 dark:border-slate-800 pb-2.5">
          <Download className="w-4 h-4 text-indigo-500" />
          <h3 className="font-bold text-xs text-slate-800 dark:text-slate-200 uppercase tracking-wide">
            客户端与核心一体更新
          </h3>
        </div>

        <p className="text-[11px] text-slate-500 leading-relaxed">
          应用与内核随 APK 一同更新。系统会校验安装包签名；正常覆盖升级保留配置与订阅。
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="flex items-center space-x-1.5 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 transition cursor-pointer disabled:opacity-50"
            disabled={state.busy}
            onClick={() => void state.check()}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${state.busy ? "animate-spin" : ""}`} />
            <span>检查最新版本</span>
          </button>

          {state.update?.hasUpdate && state.update.downloadUrl && (
            <button
              type="button"
              className="flex items-center space-x-1.5 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-md shadow-indigo-600/30 transition cursor-pointer disabled:opacity-50"
              disabled={state.busy}
              onClick={() => void state.install()}
            >
              <Download className="w-3.5 h-3.5" />
              <span>下载并安装 {state.update.latestVersion}</span>
            </button>
          )}
        </div>

        {state.update?.hasUpdate && (
          <div className="p-3 rounded-xl bg-indigo-50/60 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/60 space-y-2">
            <span className="text-xs font-bold text-indigo-700 dark:text-indigo-300 block">
              新版本更新说明 ({state.update.latestVersion})：
            </span>
            <pre className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap max-h-48 overflow-auto font-sans leading-relaxed">
              {state.update.releaseNotes}
            </pre>
          </div>
        )}
      </section>

      {/* 2. 90天精准历史流量账本 */}
      <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800/80 bg-white dark:bg-slate-900/80 p-3 shadow-sm space-y-2.5">
        <div className="flex flex-col gap-3 border-b border-slate-100 dark:border-slate-800 pb-2.5">
          <div className="flex items-center space-x-2">
            <BarChart3 className="w-4 h-4 shrink-0 text-indigo-500" />
            <h3 className="font-bold text-xs text-slate-800 dark:text-slate-200 uppercase tracking-wide">
              历史流量账本（保留 90 天）
            </h3>
          </div>
          <select
            aria-label="历史流量来源"
            className="w-full min-w-0 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-2 text-xs bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold"
            value={state.historySource}
            onChange={(e) => {
              state.setHistorySource(e.target.value as "proxy" | "system");
              setShown(30);
            }}
          >
            <option value="proxy">本机代理账本</option>
            <option value="system">系统网络用量</option>
          </select>
        </div>

        {state.historySource === "proxy" ? (
          <p className="text-[11px] text-slate-500 leading-relaxed">
            按应用包名与出口节点累计核心处理的有效载荷，保留 90 天账本。关闭界面依然记录，意外退出最多丢失最近约一分钟。
          </p>
        ) : (
          <p className="text-[11px] text-slate-500 leading-relaxed">
            读取 Android 系统保存的 Wi-Fi 与移动网络总用量，包含直连和全部系统进程。
          </p>
        )}

        {/* 筛选与查询工具栏 */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <input
            aria-label="统计日期"
            type="date"
            className={inputClass}
            value={state.date}
            onChange={(e) => state.setDate(e.target.value)}
          />
          <select
            aria-label="统计周期"
            className={inputClass}
            value={state.period}
            onChange={(e) => state.setPeriod(e.target.value as "day" | "month")}
          >
            <option value="day">按日查询</option>
            <option value="month">按月查询</option>
          </select>
          <button
            type="button"
            className="flex items-center space-x-1.5 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-sm shadow-indigo-600/25 transition cursor-pointer disabled:opacity-50"
            disabled={state.busy}
            onClick={() => {
              setShown(30);
              void state.queryHistory();
            }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${state.busy ? "animate-spin" : ""}`} />
            <span>查询用量</span>
          </button>
        </div>

        {/* 代理账本结果 */}
        {state.historySource === "proxy" && (
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyProxy}
                  onChange={(e) => setOnlyProxy(e.target.checked)}
                  className="h-4 w-4 accent-indigo-600 rounded cursor-pointer"
                />
                <span>只显示经过代理出口的流量</span>
              </label>
              <button
                type="button"
                disabled={state.busy}
                className="flex items-center space-x-1 text-xs text-rose-500 hover:text-rose-600 px-2 py-1 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/30 transition cursor-pointer"
                onClick={() => {
                  if (
                    window.confirm(
                      "清除本机全部代理流量历史？此操作无法恢复，后续新流量会重新开始记录。"
                    )
                  ) {
                    void state.clearProxyHistory();
                  }
                }}
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>清除全部历史</span>
              </button>
            </div>

            {state.proxyHistory && <p className="text-[11px] text-slate-600 dark:text-slate-300" role="status">本次查询 {proxyRows.length} 条 · 上传 {bytes(proxyTotals.upload)} · 下载 {bytes(proxyTotals.download)} · 合计 {bytes(proxyTotals.upload + proxyTotals.download)}</p>}

            <div className="divide-y divide-slate-100 dark:divide-slate-800/80 max-h-80 overflow-y-auto pr-1">
              {proxyRows.slice(0, shown).map((row) => (
                <div
                  key={`${row.packageName}:${row.outbound}:${row.proxied}`}
                  className="flex items-center justify-between gap-3 py-2.5 text-xs hover:bg-slate-50/50 dark:hover:bg-slate-800/40 rounded-lg px-1 transition"
                >
                  <div className="min-w-0">
                    <span className="font-semibold text-slate-800 dark:text-slate-200 block truncate">
                      {row.packageName === "@unknown"
                        ? "无法识别应用 / 局域网接入设备"
                        : row.packageName === "@other"
                        ? "其他应用"
                        : row.packageName}
                    </span>
                    <span className="text-[10px] text-slate-400 block font-mono mt-0.5 truncate">
                      {row.outbound} · {row.proxied ? "代理" : "直连"} · {row.connections} 个连接
                    </span>
                  </div>
                  <div className="shrink-0 text-right space-y-0.5 font-mono">
                    <span className="flex items-center justify-end text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold">
                      <ArrowUp className="w-3 h-3 mr-0.5" />
                      {bytes(row.upload)}
                    </span>
                    <span className="flex items-center justify-end text-[11px] text-indigo-600 dark:text-indigo-400 font-semibold">
                      <ArrowDown className="w-3 h-3 mr-0.5" />
                      {bytes(row.download)}
                    </span>
                  </div>
                </div>
              ))}
              {state.proxyHistory && !proxyRows.length && (
                <p className="py-4 text-center text-xs text-slate-400">此时间范围暂无对应代理记录。</p>
              )}
            </div>

            {shown < proxyRows.length && (
              <button
                type="button"
                onClick={() => setShown(shown + 30)}
                className="w-full py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              >
                加载更多记录（还剩 {proxyRows.length - shown} 项）
              </button>
            )}
          </div>
        )}

        {/* 系统用量结果 */}
        {state.historySource === "system" && state.history && !state.history.granted && (
          <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 space-y-2.5">
            <p className="text-xs text-amber-800 dark:text-amber-300">
              读取系统网络用量需要系统“使用情况访问权限”，请在设置中授权 ProcWeaver。
            </p>
            <button
              type="button"
              className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold shadow-sm transition"
              onClick={() => void state.grantUsage()}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>打开系统授权页面</span>
            </button>
          </div>
        )}

        {state.historySource === "system" && state.history?.granted && (
          <div className="divide-y divide-slate-100 dark:divide-slate-800/80 max-h-80 overflow-y-auto pr-1">
            <p className="text-[11px] text-slate-600 dark:text-slate-300 py-2" role="status">本次查询 {systemRows.length} 条 · 上传 {bytes(systemTotals.upload)} · 下载 {bytes(systemTotals.download)} · 合计 {bytes(systemTotals.upload + systemTotals.download)}</p>
            {state.history.rows.slice(0, shown).map((row) => (
              <div
                key={row.uid}
                className="flex items-center justify-between gap-3 py-2.5 text-xs hover:bg-slate-50/50 dark:hover:bg-slate-800/40 rounded-lg px-1 transition"
              >
                <div className="min-w-0">
                  <span className="font-semibold text-slate-800 dark:text-slate-200 block truncate">
                    {row.label}
                  </span>
                  <small className="block text-[10px] text-slate-400 font-mono truncate mt-0.5">
                    {row.packages.join("、")}
                  </small>
                </div>
                <div className="shrink-0 text-right space-y-0.5 font-mono">
                  <span className="flex items-center justify-end text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold">
                    <ArrowUp className="w-3 h-3 mr-0.5" />
                    {bytes(row.upload)}
                  </span>
                  <span className="flex items-center justify-end text-[11px] text-indigo-600 dark:text-indigo-400 font-semibold">
                    <ArrowDown className="w-3 h-3 mr-0.5" />
                    {bytes(row.download)}
                  </span>
                </div>
              </div>
            ))}
            {!state.history.rows.length && (
              <p className="py-4 text-center text-xs text-slate-400">此时间范围暂无系统用量记录。</p>
            )}
            {shown < state.history.rows.length && (
              <button
                type="button"
                onClick={() => setShown(shown + 30)}
                className="w-full py-2 mt-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              >
                加载更多记录
              </button>
            )}
          </div>
        )}

        {state.message && (
          <p role="status" className="text-xs text-slate-500 dark:text-slate-400 text-center pt-1">
            {state.busy ? "正在处理，请稍候…" : state.message}
          </p>
        )}
      </section>
    </div>
  );
}
