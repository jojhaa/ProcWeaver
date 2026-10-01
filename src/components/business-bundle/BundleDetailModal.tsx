import React, { useEffect, useRef } from "react";
import { BundleLocalInstance, BundleWatcherMode } from "../../types/businessBundle";
import type { BundleStatus } from "../../utils/bundleController";
import type { BundleEntryState } from "../../api/bundleTools";
import { usePlatform } from "../../context/PlatformContext";
import { bundleProcesses } from "../../utils/bundlePlatform";
import {
  X,
  Shield,
  Activity,
  CheckCircle2,
  AlertCircle,
  Play,
  Pencil,
  FileCode2,
  ExternalLink,
} from "lucide-react";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  instance: BundleLocalInstance | null;
  status?: BundleStatus;
  entry?: BundleEntryState;
  proxyLabels?: Record<string, string>;
  externalLabel?: string;
  drawer?: boolean;
  unavailable?: boolean;
  onChangeWatcherMode: (instanceId: string, mode: BundleWatcherMode) => void;
  onShortcuts?: (instanceId: string) => void;
  onLaunch?: (instanceId: string) => void;
  onEdit?: (instance: BundleLocalInstance) => void;
  onOpenSelectExit?: (instance: BundleLocalInstance) => void;
}

export const BundleDetailModal: React.FC<Props> = ({
  isOpen,
  onClose,
  instance,
  status,
  entry,
  proxyLabels = {},
  externalLabel,
  drawer = false,
  unavailable = false,
  onChangeWatcherMode,
  onShortcuts,
  onLaunch,
  onEdit,
  onOpenSelectExit,
}) => {
  const platform = usePlatform();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    if (!isOpen || !drawer) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // Nested editor dialogs own keyboard focus while open.
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-bundle-detail])')) return;
      if (e.key === "Escape") { e.preventDefault(); close.current(); }
      if (e.key !== "Tab") return;
      const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]') || [])];
      if (!items.length) { e.preventDefault(); return; }
      if (e.shiftKey && (document.activeElement === items[0] || document.activeElement === panel.current)) { e.preventDefault(); items[items.length - 1].focus(); }
      else if (!e.shiftKey && (document.activeElement === items[items.length - 1] || document.activeElement === panel.current)) { e.preventDefault(); items[0].focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); if (previous?.isConnected) previous.focus(); };
  }, [isOpen, drawer]);

  if (!isOpen || !instance) return null;

  const def = instance.definition;
  const independent = instance.backend === "external";
  const boundNode = independent ? externalLabel || "未选择代理" : instance.slotBindings.main;
  const isEnabled = instance.enabled && Boolean(boundNode) && status?.phase === "applied";
  const processes = bundleProcesses(
    def,
    platform.os === "android" ? "android" : platform.os === "macos" ? "macos" : "windows"
  );

  return (
    <div className={`fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex ${drawer ? "justify-end" : "items-center justify-center p-4"}`} onMouseDown={e => { if (drawer && e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} tabIndex={-1} data-bundle-detail role="dialog" aria-modal="true" aria-label="业务包详情" className={`w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden flex flex-col outline-none ${drawer ? "h-full" : "rounded-2xl max-h-[90vh]"} animate-in fade-in duration-150`}>
        
        {/* 头部 */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/80 dark:bg-slate-950/60">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-2xl shadow-inner">
              {def.icon || "📦"}
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  {def.packageName}
                </h3>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                  {def.packageVersion}
                </span>
                {instance.isModified && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                    已自定义
                  </span>
                )}
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                    instance.enabled
                      ? "bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/30"
                      : "bg-slate-100 dark:bg-slate-800 text-slate-500 border-slate-200 dark:border-slate-700"
                  }`}
                >
                  {def.mode === "sandbox" ? "🌱 智能沙盒" : "🔒 强锁模式"}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {def.description || "业务规则包运行状态审计、协同进程与域名清单"}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-200/60 dark:hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 滚动内容区 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 text-xs">
          
          {/* 1. 核心状态与实时连接核验面板 (图 2 重点) */}
          <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-200/60 dark:border-slate-800 pb-2">
              <span className="font-bold text-slate-800 dark:text-slate-200 flex items-center space-x-1.5 text-xs">
                <Activity className="w-4 h-4 text-emerald-500" />
                <span>{independent ? "独立代理与连接核验" : "核心运行与连接核验"}</span>
              </span>
              <span className={`font-bold flex items-center space-x-1 ${isEnabled ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                {isEnabled ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                <span>{isEnabled ? (independent ? "独立入口已就绪" : "核心已应用 · 规则正常生效") : status?.message || "未确认就绪"}</span>
              </span>
            </div>

            {/* 接入与连接诊断 */}
            <div className="space-y-1.5 text-slate-600 dark:text-slate-300 leading-relaxed">
              {entry?.monitorMessage && (
                <p className="flex items-start space-x-1">
                  <span className="text-slate-400 shrink-0">进程监控：</span>
                  <span>{entry.monitorMessage}</span>
                </p>
              )}
              {entry?.identityMessage && (
                <p className="flex items-start space-x-1">
                  <span className="text-slate-400 shrink-0">进程身份：</span>
                  <span>{entry.identityMessage}</span>
                </p>
              )}
              {entry?.message && (
                <p className="flex items-start space-x-1">
                  <span className="text-slate-400 shrink-0">应用接入：</span>
                  <span>{entry.message}</span>
                </p>
              )}
              {entry?.connectionMessage && (
                <p className={`flex items-start space-x-1 ${entry.connectionState === "error" ? "text-amber-600 dark:text-amber-400 font-medium" : ""}`}>
                  <span className="text-slate-400 shrink-0">连接核验：</span>
                  <span>{entry.connectionMessage}</span>
                </p>
              )}
            </div>

            {/* 命中流向列表 */}
            {entry?.chains && entry.chains.length > 0 && (
              <div className="pt-2 border-t border-slate-200/50 dark:border-slate-800/80 space-y-1">
                <span className="text-[11px] text-slate-400 font-medium block">已观察到的近期命中连接：</span>
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 font-mono text-[11px] space-y-1 text-slate-700 dark:text-slate-300">
                  {entry.chains.map((chain, idx) => (
                    <div key={idx} className="flex items-center space-x-1.5">
                      <span className="text-emerald-500">↳</span>
                      <span className="truncate">{chain}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 分流模式说明 */}
            <p className="text-[11px] text-slate-500 dark:text-slate-400 pt-1">
              {independent ? (def.mode === "sandbox" ? `独立沙盒：同时匹配本包进程和域名时使用包内代理；其他请求${instance.externalFallback === "default" ? "使用默认外部代理" : "直连"}。域名清单为空也使用未命中策略。` : "独立强锁：已接入且归属本包的请求使用包内代理；UDP 需应用与 SOCKS5 上游支持。尚未接入的请求不会被自动接管。") : def.mode === "sandbox"
                ? "沙盒分流：仅程序访问清单内的域名时使用本包出口，其余流量遵循默认规则。"
                : "强锁分流：已接入的主进程及其所有衍生子进程均强制使用本包指定出口，杜绝异地风控。"}
            </p>
          </div>

          {/* 2. 插槽与 DNS 解析配置卡片 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-800 dark:text-slate-200 text-xs">
                  主业务出口插槽 [main]
                </span>
                {onOpenSelectExit && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenSelectExit(instance);
                    }}
                    className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer flex items-center space-x-0.5"
                  >
                    <span>切换出口</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                )}
              </div>
              <p className="text-slate-600 dark:text-slate-300 font-mono text-xs">
                {boundNode ? (
                  <span className="font-bold text-emerald-600 dark:text-emerald-400">
                    {proxyLabels[boundNode] || boundNode}
                  </span>
                ) : (
                  <span className="text-slate-400">未指定（跟随系统默认网络）</span>
                )}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {independent ? status?.message : boundNode && isEnabled ? "核心已正确应用该节点并保持长连接监听" : "需绑定有效节点后方可生效"}
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800 space-y-2">
              <span className="font-bold text-slate-800 dark:text-slate-200 text-xs block">
                {independent ? "域名解析与协议范围" : "DNS 解析出口插槽 [dns]"}
              </span>
              <p className="text-slate-600 dark:text-slate-300 font-mono text-xs">
                {independent ? "有域名的代理请求交由上游解析" : instance.slotBindings.dns && instance.slotBindings.dns !== "FOLLOW_MAIN" ? (
                  <span className="text-indigo-600 dark:text-indigo-400 font-bold">
                    独立节点: {instance.slotBindings.dns}
                  </span>
                ) : (
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold">
                    跟随主业务出口
                  </span>
                )}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {independent ? "支持 SOCKS5 TCP / UDP；可在独立代理设置中开启本包 DNS 入口，按查询域名分流。系统 DNS 不自动修改；只有 IP 的请求不推测域名。代理失败不自动直连。" : isEnabled && def.domains?.length
                  ? "核心域名专属 DNS 规则已应用，有效防止 DNS 投毒与污染"
                  : "尚未确认域名 DNS 生效，应用自带加密 DNS 不由此规则接管"}
              </p>
            </div>
          </div>

          {/* 3. 协同成员进程与匹配域名清单 (图 2 重点) */}
          <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-800 dark:text-slate-200 text-xs flex items-center space-x-1.5">
                <FileCode2 className="w-4 h-4 text-indigo-500" />
                <span>套件内协同成员清单</span>
              </span>
              <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                {processes.length} 个受纳管进程 · {def.domains?.length || 0} 个匹配域名
              </span>
            </div>

            {/* 进程列表 */}
            <div className="space-y-1.5">
              <span className="text-[11px] text-slate-400 font-medium block">进程成员 (Process Tree)：</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {processes.length === 0 ? (
                  <span className="text-slate-400 text-xs">暂无定义进程</span>
                ) : (
                  processes.map((p) => {
                    const isMain = p.role === "main";
                    const isLsp = p.exe.toLowerCase().includes("language_server");

                    let badgeClass = "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700";
                    if (isMain) {
                      badgeClass = "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 font-bold";
                    } else if (isLsp) {
                      badgeClass = "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/40 font-bold";
                    }

                    return (
                      <span
                        key={p.exe}
                        className={`px-2 py-0.5 rounded text-[11px] font-mono border ${badgeClass}`}
                        title={p.description}
                      >
                        [{isMain ? "主程序" : isLsp ? "核心语言服务" : "伴生依赖"}] {p.exe}
                      </span>
                    );
                  })
                )}
              </div>
            </div>

            {/* 域名列表 */}
            {def.domains && def.domains.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <span className="text-[11px] text-slate-400 font-medium block">匹配域名清单 (Domains)：</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {def.domains.map((domain) => (
                    <span
                      key={domain}
                      className="px-2 py-0.5 rounded text-[11px] font-mono bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800"
                    >
                      {domain}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 4. 智能守护设置 */}
          {platform.processTree && (
            <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800 space-y-2.5">
              <span className="font-bold text-slate-800 dark:text-slate-200 text-xs flex items-center space-x-1.5">
                <Shield className="w-4 h-4 text-indigo-500" />
                <span>后台守护策略模式</span>
              </span>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <button
                  type="button"
                  onClick={() => onChangeWatcherMode(instance.instanceId, "auto")}
                  className={`p-2 rounded-xl text-xs font-bold border transition text-center cursor-pointer ${
                    instance.watcherMode === "auto"
                      ? "bg-purple-600 text-white border-purple-600 shadow-xs"
                      : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                  }`}
                >
                  ⚡ 自动检测
                </button>
                <button
                  type="button"
                  onClick={() => onChangeWatcherMode(instance.instanceId, "hot_swap")}
                  disabled={!platform.processWatcher}
                  className={`p-2 rounded-xl text-xs font-bold border transition text-center cursor-pointer ${
                    instance.watcherMode === "hot_swap"
                      ? "bg-purple-600 text-white border-purple-600 shadow-xs"
                      : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                  }`}
                >
                  🔄 热替换
                </button>
                <button
                  type="button"
                  onClick={() => onChangeWatcherMode(instance.instanceId, "notify")}
                  className={`p-2 rounded-xl text-xs font-bold border transition text-center cursor-pointer ${
                    instance.watcherMode === "notify"
                      ? "bg-indigo-600 text-white border-indigo-600 shadow-xs"
                      : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                  }`}
                >
                  🔔 仅提醒
                </button>
                <button
                  type="button"
                  onClick={() => onChangeWatcherMode(instance.instanceId, "disabled")}
                  className={`p-2 rounded-xl text-xs font-bold border transition text-center cursor-pointer ${
                    instance.watcherMode === "disabled"
                      ? "bg-slate-600 text-white border-slate-600 shadow-xs"
                      : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                  }`}
                >
                  ⚪ 关闭守护
                </button>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {instance.watcherMode === "hot_swap"
                  ? "热替换：应用接入的新连接跟随本包出口；入口不正确时提示，确认后正常重启。"
                  : instance.watcherMode === "auto"
                  ? "自动检测：自动检测本包入口并展示结果，不主动请求重启应用。"
                  : instance.watcherMode === "notify"
                  ? "温和提醒：入口异常时以轻量气泡提醒，不执行任何强杀与干预。"
                  : "关闭守护：不监控应用主实例与后台进程启动。"}
              </p>
            </div>
          )}

          {/* 5. 快捷方式工具接入 */}
          {!unavailable && platform.shortcutManagement && onShortcuts && (
            <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800 flex items-center justify-between">
              <div>
                <span className="font-bold text-slate-800 dark:text-slate-200 text-xs block">
                  桌面快捷方式集成
                </span>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  将 ProcWeaver 代理参数与环境变量直接固化进桌面快捷方式，一键防卡死启动
                </p>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={() => onShortcuts(instance.instanceId)}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 transition cursor-pointer"
                >
                  🎯 接入快捷方式
                </button>
                <button
                  type="button"
                  onClick={() => onShortcuts(instance.instanceId)}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 transition cursor-pointer"
                >
                  📌 创建快捷方式
                </button>
              </div>
            </div>
          )}

        </div>

        {/* 底部按钮栏 */}
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between bg-white dark:bg-slate-900">
          <div className="flex items-center space-x-2">
            {onEdit && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onEdit(instance);
                }}
                className="px-3 py-1.5 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer flex items-center space-x-1.5 border border-slate-200 dark:border-slate-700"
              >
                <Pencil className="w-3.5 h-3.5" />
                <span>编辑规则定义</span>
              </button>
            )}
          </div>

          <div className="flex items-center space-x-2.5">
            {!unavailable && platform.appProxy && onLaunch && (
              <button
                type="button"
                onClick={() => {
                  onLaunch(instance.instanceId);
                }}
                className="px-4 py-1.5 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-md transition cursor-pointer flex items-center space-x-1.5"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>检测并启动应用</span>
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
            >
              关闭
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
