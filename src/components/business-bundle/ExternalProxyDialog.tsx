import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X, Plus, Network, Check, Trash2, Globe, Save, Radio, RefreshCw } from "lucide-react";
import type { useExternalProxyEditor } from "../../hooks/useExternalProxyEditor";
import { ExternalProxyProbePanel } from "./ExternalProxyProbePanel";

type Props = {
  open: boolean;
  bundleName?: string;
  state: ReturnType<typeof useExternalProxyEditor>;
  onClose: () => void;
  onCore?: () => void;
  inline?: boolean;
};

const inputClass =
  "w-full rounded-xl border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 outline-none transition disabled:opacity-50 disabled:bg-slate-100 dark:disabled:bg-slate-900";

const selectClass =
  "w-full rounded-xl border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-800 dark:text-slate-100 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 outline-none transition cursor-pointer disabled:opacity-50 disabled:bg-slate-100 dark:disabled:bg-slate-900";

const baseBtn =
  "rounded-xl px-3 py-2 text-xs font-medium transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-indigo-500";

export function ExternalProxyDialog({ open, bundleName, state: s, onClose, onCore, inline = false }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const busy = useRef(s.busy);
  busy.current = s.busy;

  useEffect(() => {
    if (!open || inline) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!busy.current) close.current();
      }
      if (e.key === "Tab") {
        const items = Array.from(
          panel.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'
          ) || []
        );
        const first = items[0];
        const last = items[items.length - 1];
        if (!first) {
          e.preventDefault();
          return;
        }
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      previous?.focus();
    };
  }, [open, inline]);

  if (!open) return null;
  const a = s.actions;
  const stateLabels: Record<string, string> = {
    connecting: "连接中",
    active: "隧道已建立",
    closed: "已结束",
    failed: "失败",
    response: "响应已转发",
  };

  const content = (
    <div
      className={inline ? "h-full min-h-0 flex flex-col" : "fixed inset-0 z-[95] bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 animate-in fade-in duration-150"}
      onMouseDown={(e) => {
        if (!inline && e.target === e.currentTarget && !s.busy) onClose();
      }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role={inline ? "region" : "dialog"}
        aria-modal={inline ? undefined : true}
        aria-labelledby="external-proxy-title"
        className={inline ? "w-full h-full flex flex-col bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 outline-none overflow-hidden" : "w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 shadow-2xl border border-slate-200 dark:border-slate-800 outline-none overflow-hidden"}
      >
        {/* 标题栏 */}
        <div className="px-5 py-4 flex items-center justify-between border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 shrink-0">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-100 dark:border-indigo-900/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0 shadow-2xs">
              <Network className="w-4.5 h-4.5" />
            </div>
            <div>
              <h2 id="external-proxy-title" className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                {bundleName ? `${bundleName} · 出口方式` : "独立外部代理"}
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                HTTP / SOCKS5 · 核心关闭也可独立运行 · SOCKS5 支持 TCP / UDP
              </p>
            </div>
          </div>
          {!inline && <button
            type="button"
            aria-label="关闭独立代理设置"
            className="w-8 h-8 rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
            onClick={onClose}
            disabled={s.busy}
          >
            <X className="w-4 h-4" />
          </button>}
        </div>

        {/* 主体滚动区 */}
        <div className="p-5 sm:p-6 space-y-5 overflow-y-auto text-xs flex-1">
          {s.error && (
            <div role="alert" className="rounded-xl p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-300 break-words flex items-start space-x-2">
              <span className="font-bold shrink-0">⚠️ 错误：</span>
              <span>{s.error}</span>
            </div>
          )}
          {s.message && (
            <div role="status" className="rounded-xl p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 text-emerald-700 dark:text-emerald-300 flex items-center space-x-2">
              <Check className="w-4 h-4 shrink-0 text-emerald-600" />
              <span>{s.message}</span>
            </div>
          )}

          {!s.view ? (
            <div className="flex items-center justify-center py-8 space-x-3 text-slate-500">
              <RefreshCw className={`w-4 h-4 ${s.busy ? "animate-spin text-indigo-500" : ""}`} />
              <span>{s.busy ? "正在读取代理设置…" : "代理设置尚未读取"}</span>
              <button
                type="button"
                className={`${baseBtn} bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-750 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700`}
                disabled={s.busy}
                onClick={() => void a.load()}
              >
                重新读取
              </button>
            </div>
          ) : (
            <>
              {/* 单包专属代理绑定模式 */}
              {bundleName && (
                <section className="rounded-xl border border-indigo-200/90 dark:border-indigo-900/60 bg-indigo-50/40 dark:bg-indigo-950/20 p-4 space-y-3">
                  <div className="flex justify-between items-center gap-2">
                    <strong className="text-indigo-950 dark:text-indigo-200 font-bold">此业务包使用独立代理</strong>
                    {onCore && <button
                      type="button"
                      className={`${baseBtn} bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/50`}
                      disabled={s.busy}
                      onClick={onCore}
                    >
                      改用 Mihomo 核心节点
                    </button>}
                  </div>
                  <label className="block space-y-1">
                    <span className="font-semibold text-slate-700 dark:text-slate-300">包内出口</span>
                    <select
                      aria-label="包内外部代理"
                      className={selectClass}
                      disabled={s.busy}
                      value={s.endpointId}
                      onChange={(e) => a.setEndpointId(e.target.value)}
                    >
                      <option value="">跟随默认代理</option>
                      {s.view.endpoints.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name} · {e.protocol.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block space-y-1">
                    <span className="font-semibold text-slate-700 dark:text-slate-300">沙盒未命中 / 域名清单为空</span>
                    <select
                      aria-label="独立沙盒未命中策略"
                      className={selectClass}
                      disabled={s.busy}
                      value={s.fallback}
                      onChange={(e) => a.setFallback(e.target.value as "direct" | "default")}
                    >
                      <option value="direct">直连（不走代理）</option>
                      <option value="default">使用默认外部代理</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-800 dark:text-slate-200 select-none">
                    <input
                      type="checkbox"
                      className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                      checked={s.enabled}
                      disabled={s.busy}
                      onChange={(e) => a.setEnabled(e.target.checked)}
                    />
                    <span>启用此业务包</span>
                  </label>
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    保留原核心节点绑定。强锁处理已接入且归属本包的请求；沙盒同时匹配进程与域名，DNS 按查询域名匹配。只有 IP 的请求无法还原域名，按未命中策略处理。
                  </p>
                </section>
              )}

              {/* 业务包库默认代理 */}
              <div className="p-3.5 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 space-y-1.5">
                <label className="block space-y-1">
                  <span className="font-semibold text-slate-800 dark:text-slate-200 text-xs">
                    业务包库默认代理
                  </span>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                    未指定专属出口的独立业务包将默认分配给该入口
                  </p>
                  <select
                    aria-label="默认外部代理"
                    className={selectClass}
                    disabled={s.busy}
                    value={s.view.defaultEndpointId || ""}
                    onChange={(e) => void a.setDefault(e.target.value)}
                  >
                    <option value="">未指定（默认使用直连/系统路由）</option>
                    {s.view.endpoints.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name} · {e.protocol.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {/* 代理配置管理 */}
              <section className="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/50 space-y-3.5 shadow-2xs">
                <div className="flex justify-between items-center">
                  <strong className="text-slate-800 dark:text-slate-200 text-xs font-bold flex items-center space-x-1.5">
                    <Radio className="w-3.5 h-3.5 text-indigo-500" />
                    <span>代理节点配置</span>
                  </strong>
                  <button
                    type="button"
                    className={`${baseBtn} bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/40 dark:hover:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 border border-indigo-200/80 dark:border-indigo-800/80 flex items-center gap-1 font-semibold`}
                    disabled={s.busy}
                    onClick={() => a.edit("")}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>新增代理</span>
                  </button>
                </div>

                {/* 代理选择药丸 Tab */}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {s.view.endpoints.map((e) => {
                    const isSelected = s.draft.id === e.id;
                    return (
                      <button
                        key={e.id}
                        type="button"
                        className={`px-3 py-1.5 rounded-xl text-xs font-medium transition cursor-pointer select-none flex items-center space-x-1.5 border ${
                          isSelected
                            ? "bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border-indigo-400 dark:border-indigo-600 shadow-2xs font-semibold ring-1 ring-indigo-500/20"
                            : "bg-slate-100/80 hover:bg-slate-200/80 dark:bg-slate-800 dark:hover:bg-slate-750 text-slate-600 dark:text-slate-300 border-transparent"
                        }`}
                        disabled={s.busy}
                        onClick={() => a.edit(e.id)}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${isSelected ? "bg-indigo-500" : "bg-slate-400"}`} />
                        <span>{e.name}</span>
                        <span className="text-[10px] opacity-60 font-mono">({e.protocol.toUpperCase()})</span>
                      </button>
                    );
                  })}
                </div>

                {/* 表单输入网格 */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <label className="space-y-1 block">
                    <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">代理名称</span>
                    <input
                      aria-label="代理名称"
                      className={inputClass}
                      value={s.draft.name}
                      maxLength={120}
                      disabled={s.busy}
                      onChange={(e) => a.setDraft({ ...s.draft, name: e.target.value })}
                      placeholder="例如: local-socks"
                    />
                  </label>

                  <label className="space-y-1 block">
                    <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">代理协议</span>
                    <select
                      aria-label="外部代理协议"
                      className={selectClass}
                      value={s.draft.protocol}
                      disabled={s.busy}
                      onChange={(e) => a.setDraft({ ...s.draft, protocol: e.target.value as "http" | "socks5" })}
                    >
                      <option value="http">HTTP（支持 CONNECT 隧道）</option>
                      <option value="socks5">SOCKS5（支持 TCP / UDP）</option>
                    </select>
                  </label>

                  <label className="space-y-1 block">
                    <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">主机名 / IP</span>
                    <input
                      aria-label="代理地址"
                      className={inputClass}
                      value={s.draft.host}
                      disabled={s.busy}
                      onChange={(e) => a.setDraft({ ...s.draft, host: e.target.value })}
                      placeholder="127.0.0.1"
                    />
                  </label>

                  <label className="space-y-1 block">
                    <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">端口</span>
                    <input
                      aria-label="代理端口"
                      className={inputClass}
                      type="number"
                      min={1}
                      max={65535}
                      value={s.draft.port || ""}
                      disabled={s.busy}
                      onChange={(e) => a.setDraft({ ...s.draft, port: Number(e.target.value) })}
                      placeholder="10808"
                    />
                  </label>

                  <label className="space-y-1 block">
                    <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">用户名（留空不认证）</span>
                    <input
                      aria-label="代理用户名"
                      className={inputClass}
                      autoComplete="off"
                      value={s.draft.username}
                      disabled={s.busy}
                      onChange={(e) => a.setDraft({ ...s.draft, username: e.target.value })}
                      placeholder="留空即无需认证"
                    />
                  </label>

                  <label className="space-y-1 block">
                    <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">密码</span>
                    <input
                      aria-label="代理密码"
                      type="password"
                      autoComplete="new-password"
                      className={inputClass}
                      value={s.draft.password || ""}
                      disabled={s.busy || !s.draft.username}
                      placeholder={s.view.endpoints.find((e) => e.id === s.draft.id)?.hasPassword ? "已保存；留空保持不变" : "请输入密码"}
                      onChange={(e) => a.setDraft({ ...s.draft, password: e.target.value })}
                    />
                  </label>
                </div>

                <p className="text-[11px] text-slate-500 leading-relaxed bg-slate-50 dark:bg-slate-950/60 p-2.5 rounded-xl border border-slate-100 dark:border-slate-800">
                  凭据由当前 Windows 账户加密保存，不进入规则包导出。HTTP 支持 Basic 认证；SOCKS5 支持用户名/密码。有域名的代理请求交给上游解析；直连使用本机解析。
                </p>

                {/* 操作按钮 */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-100 dark:border-slate-800">
                  <button
                    type="button"
                    className={`${baseBtn} bg-indigo-600 hover:bg-indigo-700 text-white font-semibold flex items-center space-x-1.5 shadow-xs`}
                    disabled={s.busy}
                    onClick={() => void a.saveEndpoint()}
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>保存当前代理</span>
                  </button>

                  <button
                    type="button"
                    className={`${baseBtn} text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 border border-slate-200 dark:border-slate-800 flex items-center space-x-1.5`}
                    disabled={s.busy || !s.view.endpoints.some((e) => e.id === s.draft.id)}
                    onClick={() => void a.remove()}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>移除当前代理</span>
                  </button>
                </div>
              </section>

              {/* 本地 DNS 入口设置卡片 (彻底解决遮挡与挤压) */}
              <section className="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/30 space-y-3">
                <div className="flex items-center space-x-2">
                  <Globe className="w-4 h-4 text-emerald-500" />
                  <strong className="text-slate-800 dark:text-slate-200 text-xs font-bold">本地 DNS 入口</strong>
                </div>

                <label className="flex items-center space-x-2 cursor-pointer font-medium text-slate-800 dark:text-slate-200 select-none">
                  <input
                    type="checkbox"
                    aria-label="启用独立 DNS 入口"
                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                    checked={s.dns.enabled}
                    disabled={s.busy}
                    onChange={(e) => a.setDns({ ...s.dns, enabled: e.target.checked })}
                  />
                  <span>为每个已启用的独立业务包开放专用本地 DNS 入口</span>
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <label className="space-y-1 block">
                    <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">DNS 上游 IP</span>
                    <input
                      aria-label="独立 DNS 上游 IP"
                      className={inputClass}
                      value={s.dns.server}
                      disabled={s.busy}
                      onChange={(e) => a.setDns({ ...s.dns, server: e.target.value })}
                      placeholder="223.5.5.5 或 8.8.8.8"
                    />
                  </label>
                  <label className="space-y-1 block">
                    <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">DNS 上游端口</span>
                    <input
                      aria-label="独立 DNS 上游端口"
                      className={inputClass}
                      type="number"
                      min={1}
                      max={65535}
                      value={s.dns.port || ""}
                      disabled={s.busy}
                      onChange={(e) => a.setDns({ ...s.dns, port: Number(e.target.value) })}
                      placeholder="53"
                    />
                  </label>
                </div>

                <p className="text-[11px] text-slate-500 leading-relaxed">
                  仅允许所属业务包的进程访问，按查询域名及未命中策略选择出口。SOCKS5 转发 UDP DNS；HTTP 使用 DNS TCP 隧道。本地端口自动分配并保存，不占用系统 53 端口，亦不修改系统 DNS。
                </p>

                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    className={`${baseBtn} bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/40 dark:hover:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 border border-indigo-200/80 dark:border-indigo-800/80 font-semibold flex items-center space-x-1.5`}
                    disabled={s.busy}
                    onClick={() => void a.saveDns()}
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>保存 DNS 设置</span>
                  </button>
                </div>

                {/* 业务包 DNS 状态卡片 */}
                {s.view.states.length > 0 && (
                  <div className="space-y-1.5 pt-2 border-t border-slate-200/60 dark:border-slate-800/60">
                    <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400 block">各业务包运行中端口：</span>
                    {s.view.states.map((entry) => (
                      <div
                        key={entry.id}
                        className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 p-2.5 text-[11px] flex flex-wrap items-center justify-between gap-2"
                      >
                        <span className="font-bold text-slate-800 dark:text-slate-200">
                          {s.view?.bundles.find((b) => b.id === entry.id)?.name || entry.id}
                        </span>
                        <div className="flex items-center space-x-3 text-slate-600 dark:text-slate-300 font-mono text-[10px]">
                          <span className="inline-flex items-center space-x-1">
                            <span className={`w-1.5 h-1.5 rounded-full ${entry.ready ? "bg-emerald-500" : "bg-slate-400"}`} />
                            <span>代理: {entry.ready ? `127.0.0.1:${entry.port}` : "未就绪"}</span>
                          </span>
                          <span className="inline-flex items-center space-x-1">
                            <span className={`w-1.5 h-1.5 rounded-full ${entry.dnsReady ? "bg-blue-500" : "bg-slate-400"}`} />
                            <span>DNS: {entry.dnsReady ? `127.0.0.1:${entry.dnsPort}` : "未开启"}</span>
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* 连通性探测测试面板 */}
              <ExternalProxyProbePanel
                busy={s.busy}
                endpoint={s.probeEndpoint}
                draft={s.probe}
                presets={s.probePresets}
                records={s.probeRecords}
                onDraft={a.setProbe}
                onKind={a.setProbeKind}
                onPreset={a.setProbePreset}
                onTest={() => void a.test()}
                onClear={a.clearProbeRecords}
              />

              {/* 注意事项 */}
              <div className="rounded-xl bg-amber-500/10 dark:bg-amber-950/20 border border-amber-500/20 text-amber-800 dark:text-amber-300 p-3 leading-relaxed text-[11px] space-y-1">
                <span className="font-bold block">💡 接入提醒：</span>
                <p>
                  应用必须主动接入本包代理或 DNS 入口。UDP 需要应用和 SOCKS5 上游均支持 UDP ASSOCIATE；HTTP 上游不转发普通 UDP。不自动接管系统 DNS、应用自带 DoH 或未接入的 QUIC，不使用 TUN / WinDivert。代理失败不自动直连。停用后需恢复应用代理与 DNS 设置或正常重启。
                </p>
              </div>

              {/* 最近独立连接记录 */}
              {!bundleName && (
                <section className="space-y-2.5 pt-2 border-t border-slate-100 dark:border-slate-800">
                  <div className="flex items-center justify-between">
                    <strong className="text-slate-800 dark:text-slate-200 text-xs font-bold">
                      最近独立连接（最多展示 20 项）
                    </strong>
                    <button
                      type="button"
                      className={`${baseBtn} bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-750 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 flex items-center space-x-1`}
                      disabled={s.busy}
                      onClick={() => void a.load()}
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>刷新记录</span>
                    </button>
                  </div>

                  {!s.view.records.length ? (
                    <p className="text-slate-500 dark:text-slate-400 py-3 text-center bg-slate-50 dark:bg-slate-950/40 rounded-xl border border-slate-100 dark:border-slate-800/80">
                      尚无独立连接记录。可启动已配置代理的应用后点击上方刷新查看。
                    </p>
                  ) : (
                    <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                      {s.view.records.slice(0, 20).map((r) => (
                        <div
                          key={r.id}
                          className="rounded-xl border border-slate-200/70 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-950/40 p-2.5 text-[11px] space-y-0.5"
                        >
                          <div className="flex items-center justify-between font-mono">
                            <span className="font-semibold text-slate-800 dark:text-slate-200 truncate max-w-[280px]">
                              {r.target || "未取得目标"}
                            </span>
                            <span
                              className={`px-1.5 py-0.2 rounded-md text-[10px] font-bold ${
                                r.state === "active"
                                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                  : r.state === "failed"
                                  ? "bg-red-500/10 text-red-600 dark:text-red-400"
                                  : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
                              }`}
                            >
                              {stateLabels[r.state] || r.state}
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-500 dark:text-slate-400 flex items-center justify-between font-mono">
                            <span>上游: {r.upstream}</span>
                            <span>PID {r.pid} · {r.route}</span>
                          </div>
                          {r.message && (
                            <div className="text-[10px] text-slate-400 truncate">{r.message}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>

        {/* 固定底部操作栏 (绝不被内容遮挡或截断) */}
        <div className="px-5 py-3.5 bg-slate-50/90 dark:bg-slate-900/90 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            {s.busy ? "正在同步更新…" : "设置修改将加密留存于本地账户"}
          </span>
          <div className="flex items-center space-x-2">
            {!inline && <button
              type="button"
              className={`${baseBtn} bg-white hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-750 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-4`}
              disabled={s.busy}
              onClick={onClose}
            >
              关闭
            </button>}
            {bundleName && (
              <button
                type="button"
                disabled={s.busy || !s.view?.supported}
                onClick={() => void a.saveBundle()}
                className={`${baseBtn} bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-4 shadow-xs`}
              >
                {s.busy ? "正在应用…" : "应用独立代理"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
  return inline ? content : createPortal(content, document.body);
}
