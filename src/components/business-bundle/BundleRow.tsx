import React, { useState } from "react";
import { BundleLocalInstance, BundleWatcherMode } from "../../types/businessBundle";
import type { BundleStatus } from "../../utils/bundleController";
import type { BundleEntryState } from "../../api/bundleTools";
import {
  ChevronDown,
  ChevronRight,
  Shield,
  Upload,
  Trash2,
  CheckCircle2,
  Pencil,
  Play,
  ArrowUp,
  ArrowDown,
} from "lucide-react";

interface Props {
  instance: BundleLocalInstance;
  status: BundleStatus;
  entry?: BundleEntryState;
  onLaunch: () => void;
  onShortcuts: () => void;
  availableProxies: string[];
  preservedBinding?: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onToggleSwitch: (instanceId: string, nextState: boolean) => void;
  onTriggerQuickBind: (instance: BundleLocalInstance) => void;
  onSelectNodeChange: (instanceId: string, nodeName: string) => void;
  onChangeWatcherMode: (instanceId: string, mode: BundleWatcherMode) => void;
  onEdit: (instance: BundleLocalInstance) => void;
  onExport: (instance: BundleLocalInstance) => void;
  onDelete: (instanceId: string) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

export const BundleRow: React.FC<Props> = ({
  instance,
  status,
  entry,
  onLaunch,
  onShortcuts,
  availableProxies,
  preservedBinding = false,
  isExpanded,
  onToggleExpand,
  onToggleSwitch,
  onTriggerQuickBind,
  onSelectNodeChange,
  onChangeWatcherMode,
  onEdit,
  onExport,
  onDelete,
  onMoveUp,
  onMoveDown,
  canMoveUp = false,
  canMoveDown = false,
}) => {
  const [toastMsg, setToastMsg] = useState<string>("");

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3500);
  };

  const def = instance.definition;
  const boundNode = instance.slotBindings.main;
  const isRequested = instance.enabled && Boolean(boundNode);
  const isEnabled = isRequested && status.phase === "applied";
  const canLaunch = !instance.enabled || isEnabled || status.phase === "saved";

  // 点击主开关事件
  const handleSwitchClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!instance.enabled) {
      // 想开启：检查是否绑定出口
      if (!boundNode) {
        // 未绑定出口 -> 触发【方式 A】就地气泡快捷弹窗
        onTriggerQuickBind(instance);
      } else {
        onToggleSwitch(instance.instanceId, true);
        showToast(`正在为「${def.packageName}」应用出口，请等待核心确认`);
      }
    } else {
      // 想停用 -> 彻底回归系统默认
      onToggleSwitch(instance.instanceId, false);
      showToast(`正在停用「${def.packageName}」，请等待核心确认`);
    }
  };

  return (
    <section className="bundle-row rounded-2xl bg-white dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800/80 hover:border-indigo-300 dark:hover:border-slate-700 shadow-xs dark:shadow-md transition overflow-hidden">
      {/* 提示条 */}
      {toastMsg && (
        <div className="bg-indigo-600 text-white text-xs px-4 py-1.5 flex items-center justify-between animate-in fade-in">
          <span>{toastMsg}</span>
          <button
            type="button"
            onClick={() => setToastMsg("")}
            className="text-white/80 hover:text-white text-xs ml-2 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* 行头部：双层丰富控制区 (包含开关 + 智能守护设置) */}
      <div
        onClick={onToggleExpand}
        className="p-4 space-y-3 cursor-pointer select-none hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition"
      >
        {/* 上层：图标、名称、模式徽章、主业务出口选择 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center space-x-3">
            <span className="text-slate-400 text-base font-bold transition-transform duration-200">
              {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </span>
            <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80 flex items-center justify-center text-2xl shadow-inner">
              {def.icon}
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white tracking-tight">{def.packageName}</h3>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                  {def.packageVersion}
                </span>
                {instance.isModified && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300 border border-amber-500/30">
                    已自定义
                  </span>
                )}
                {isRequested ? (
                  def.mode === "sandbox" ? (
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300 border border-emerald-500/30">
                      🌱 智能沙盒
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-500/10 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300 border border-purple-500/30">
                      🔒 强锁模式
                    </span>
                  )
                ) : (
                  <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700/80">
                    ⚪ 停用 (跟随系统默认)
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{def.description}</p>
            </div>
          </div>

          {/* 出口装配快速下拉 */}
          <div className="flex items-center space-x-2" onClick={(e) => e.stopPropagation()}>
            <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">主业务出口:</span>
            <select
              aria-label={`${def.packageName}主业务出口`}
              value={preservedBinding ? "__pw_preserved_binding__" : boundNode || ""}
              onChange={(e) => { if (e.target.value !== "__pw_preserved_binding__") onSelectNodeChange(instance.instanceId, e.target.value); }}
              className={`bg-white dark:bg-slate-950 border rounded-lg px-3 py-1.5 text-xs font-bold focus:outline-none cursor-pointer transition ${
                boundNode
                  ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400 hover:border-indigo-500"
                  : "border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-400 dark:hover:border-slate-500"
              }`}
            >
              <option value="">未指定出口 (点击开启以绑定)...</option>
              {preservedBinding && <option value="__pw_preserved_binding__">原订阅绑定：{boundNode}</option>}
              {!preservedBinding && boundNode && !availableProxies.includes(boundNode) && <option value={boundNode}>不可用：{boundNode}</option>}
              {availableProxies.map((node) => (
                <option key={node} value={node}>
                  {node}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 下层控制中枢：【智能守护设置】 + 【双击防卡死工具】 + 【主开关】 */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-slate-100 dark:border-slate-800 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            {/* 1. 单包智能守护；热替换必须显式选择并逐次确认重启 */}
            <div
              className="flex flex-wrap items-center bg-slate-100/80 dark:bg-slate-950 p-1 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xs"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-[11px] text-slate-500 dark:text-slate-400 pl-2 pr-1.5 font-medium flex items-center space-x-1">
                <Shield className="w-3 h-3 text-indigo-500 dark:text-indigo-400 inline" />
                <span>智能守护:</span>
              </span>
              <button
                type="button"
                onClick={() => onChangeWatcherMode(instance.instanceId, "auto")}
                aria-pressed={instance.watcherMode === "auto"}
                className={`px-2.5 py-1 rounded-lg font-bold text-[11px] transition cursor-pointer ${
                  instance.watcherMode === "auto"
                    ? "bg-purple-600 text-white shadow"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
                }`}
                title="自动检测本包入口，在卡片展示结果；不主动请求重启"
              >
                ⚡ 自动检测
              </button>
              <button
                type="button"
                onClick={() => onChangeWatcherMode(instance.instanceId, "hot_swap")}
                aria-pressed={instance.watcherMode === "hot_swap"}
                className={`px-2.5 py-1 rounded-lg font-bold text-[11px] transition cursor-pointer ${
                  instance.watcherMode === "hot_swap"
                    ? "bg-purple-600 text-white shadow"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
                }`}
                title="自动检测；已接入应用在线切换出口，入口不正确时提示，确认后正常重启并沿用原资料"
              >
                🔄 热替换
              </button>
              <button
                type="button"
                onClick={() => onChangeWatcherMode(instance.instanceId, "notify")}
                aria-pressed={instance.watcherMode === "notify"}
                className={`px-2.5 py-1 rounded-lg font-medium text-[11px] transition cursor-pointer ${
                  instance.watcherMode === "notify"
                    ? "bg-indigo-600 text-white shadow"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
                }`}
                title="模式 B：🔔 温和气泡提示（绝对零强杀，仅轻量提醒）"
              >
                🔔 仅提醒
              </button>
              <button
                type="button"
                onClick={() => onChangeWatcherMode(instance.instanceId, "disabled")}
                aria-pressed={instance.watcherMode === "disabled"}
                className={`px-2.5 py-1 rounded-lg font-medium text-[11px] transition cursor-pointer ${
                  instance.watcherMode === "disabled"
                    ? "bg-slate-300 text-slate-800 dark:bg-slate-700 dark:text-white shadow"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
                }`}
                title="模式 C：⚪ 关闭该套件的后台守护"
              >
                ⚪ 关闭
              </button>
            </div>

            {/* 2. 桌面快捷方式防卡死参数注入工具 */}
            <div className="flex items-center space-x-1.5" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={onShortcuts}
                className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-750 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-500 hover:text-slate-900 dark:hover:text-white transition cursor-pointer shadow-2xs"
                title="选择真实桌面的现有快捷方式，完整备份后接入本业务包"
              >
                🎯 接入现有快捷方式
              </button>
              <button
                type="button"
                onClick={onShortcuts}
                className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-750 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-500 hover:text-slate-900 dark:hover:text-white transition cursor-pointer shadow-2xs"
                title="在实际桌面创建快捷方式，由 ProcWeaver 读取此业务包的当前出口"
              >
                📌 创建业务包快捷方式
              </button>
            </div>
          </div>

          {/* 3. 主启停滑动开关 (Toggle Switch) */}
          <div
            className="flex items-center space-x-3 cursor-pointer"
            role="switch"
            aria-label={`${def.packageName}启用规则`}
            aria-checked={instance.enabled}
            tabIndex={0}
            onKeyDown={e => {
              if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.currentTarget.click(); }
            }}
            onClick={handleSwitchClick}
          >
            <span
              className={`text-xs font-bold transition ${
                isEnabled ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400 dark:text-slate-500"
              }`}
            >
              {isEnabled ? "已应用" : status.phase === "pending" ? "待核心确认" : status.phase === "error" ? "应用未确认" : status.phase === "saved" ? "已保存，待启动" : status.phase === "unbound" ? "待绑定" : "已停用"}
            </span>
            <div className="relative inline-block w-11 h-6 align-middle select-none">
              <div
                className={`block w-11 h-6 rounded-full transition-colors duration-200 ${
                  isEnabled ? "bg-emerald-500" : isRequested ? "bg-amber-500" : "bg-slate-300 dark:bg-slate-700"
                }`}
              >
                <div
                  className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform duration-200 mt-0.5 ml-0.5 ${
                    isRequested ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div role="status" className={`px-4 pb-3 text-xs break-words ${status.phase === "applied" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-300"}`}>
        {status.message}
        {status.phase !== "applied" && status.previousTargets.length > 0 && <span>；核心上次保存出口：{status.previousTargets.join("、")}（当前连接出口未核实）</span>}
        {status.phase === "error" && boundNode && /重新绑定|重绑定|出口.*失效/.test(status.message) && <button type="button" onClick={() => onSelectNodeChange(instance.instanceId, boundNode)} className="ml-2 underline">重新绑定所选出口</button>}
      </div>
      {entry && <div className="px-4 pb-3 text-xs text-slate-600 dark:text-slate-300 break-words">
        <p>应用接入：{entry.message}</p>
        <p className={entry.connectionState === "error" ? "text-amber-700 dark:text-amber-300" : ""}>连接核验：{entry.connectionMessage}</p>
        {entry.chains.map(chain => <p key={chain}>{chain}</p>)}
      </div>}
      {instance.watcherMode === "hot_swap" && <p className="px-4 pb-3 text-xs text-slate-500 dark:text-slate-400">
        热替换：已接入应用的新连接跟随本包出口；入口不正确时提示，确认后正常重启。暂不重启后，可点击“检测并启动应用”重试。
      </p>}

      {/* 展开内容区 (Detail Drawer) */}
      {isExpanded && (
        <div className="border-t border-slate-200/80 dark:border-slate-800/80 p-4 space-y-3.5 bg-slate-50/70 dark:bg-slate-950/40 animate-in fade-in duration-150">
          <p className="text-xs text-slate-600 dark:text-slate-300">
            {def.mode === "sandbox" ? <>
              {def.domains?.length ? "沙盒分流：已接入的程序访问清单域名时使用本包出口。其他请求：" : "沙盒域名清单为空，所有请求："}
              {def.fallback === "system" ? "跟随 ProcWeaver 系统代理开关，开启时沿用原规则，关闭时直连。" : def.fallback === "direct" ? "始终直连。" : "始终沿用现有订阅和本地规则。"}
              切换影响新连接；DNS 策略单独生效。
            </> : "强锁分流：已接入的进程及子进程使用本包出口，保留配置中的排除规则。"}
          </p>
          {/* 插槽与 DNS 状态 */}
          <div className="p-3.5 rounded-xl bg-white dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs shadow-2xs">
            <div className="space-y-1">
              <span className="text-slate-800 dark:text-slate-300 font-bold">主业务出口插槽 [main]:</span>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {boundNode ? (
                  <span className="font-medium">已选择「{boundNode}」；{isEnabled ? "核心已应用" : "以核心确认状态为准"}。</span>
                ) : (
                  <span className="text-slate-400 dark:text-slate-500">未绑定出站节点，当前跟随系统默认网络。</span>
                )}
              </p>
            </div>
            <div className="space-y-1">
              <span className="text-slate-800 dark:text-slate-300 font-bold">DNS 解析出口插槽 [dns]:</span>
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                {instance.slotBindings.dns && instance.slotBindings.dns !== "FOLLOW_MAIN" ? `已选择「${instance.slotBindings.dns}」` : "跟随主业务出口"}；{isEnabled && def.domains?.length ? "核心域名 DNS 规则已应用" : "尚未确认域名 DNS 生效"}。应用自带加密 DNS 不由此规则自动接管。
              </p>
            </div>
          </div>

          {/* 协同成员进程清单 (突出主进程与核心语言服务) */}
          <div className="p-3 rounded-xl bg-white/80 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800/80 space-y-2 text-xs shadow-2xs">
            <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-[11px]">
              <span className="font-medium">套件内协同成员清单：</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-mono">
                {def.processes.length} 个协同进程 · {def.domains?.length || 0} 个匹配域名
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {def.processes.map((p) => {
                const isLanguageServer = p.exe.toLowerCase().includes("language_server");
                const isMain = p.role === "main";

                let badgeClass = "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700";
                if (isMain) {
                  badgeClass = "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
                } else if (isLanguageServer) {
                  badgeClass = "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/40 font-bold";
                }

                return (
                  <span
                    key={p.exe}
                    className={`px-2 py-0.5 rounded text-[11px] font-mono border ${badgeClass}`}
                    title={p.description}
                  >
                    [{isMain ? "主程序" : isLanguageServer ? "核心语言服务" : "伴生依赖"}] {p.exe}
                  </span>
                );
              })}

              {def.domains?.map((domain) => (
                <span
                  key={domain}
                  className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-[11px] border border-slate-200 dark:border-slate-700/60"
                >
                  {domain}
                </span>
              ))}
            </div>
          </div>

          {/* 底部动作栏 */}
          <div className="flex items-center justify-between pt-2 border-t border-slate-200/80 dark:border-slate-800/80 text-xs">
            <div className="flex items-center space-x-3 text-slate-400">
              {isEnabled ? (
                <span className="text-emerald-600 dark:text-emerald-400 flex items-center space-x-1">
                  <CheckCircle2 className="w-3.5 h-3.5 inline" />
                  <span>规则已应用，连接命中待核验</span>
                </span>
              ) : (
                <span className="text-slate-400 dark:text-slate-500">{status.phase === "disabled" ? "已停用" : "尚未确认生效"}</span>
              )}
            </div>

            <div className="flex items-center space-x-2">
              {/* 排序微调 */}
              <div className="flex items-center border border-slate-200 dark:border-slate-700 rounded overflow-hidden">
                <button
                  type="button"
                  disabled={!canMoveUp}
                  onClick={onMoveUp}
                  className="p-1 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent transition cursor-pointer"
                  title="提升该规则包优先级（上移）"
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  disabled={!canMoveDown}
                  onClick={onMoveDown}
                  className="p-1 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent transition cursor-pointer border-l border-slate-200 dark:border-slate-700"
                  title="降低该规则包优先级（下移）"
                >
                  <ArrowDown className="w-3.5 h-3.5" />
                </button>
              </div>

              <button
                type="button"
                disabled={!canLaunch}
                onClick={onLaunch}
                className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs transition cursor-pointer flex items-center space-x-1 shadow-xs disabled:opacity-50"
                title="通过 ProcWeaver 唤起该应用并自动注入环境与代理"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>检测并启动应用</span>
              </button>
              <button
                type="button"
                onClick={() => onEdit(instance)}
                className="px-2.5 py-1 rounded text-slate-600 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer flex items-center space-x-1"
                title="编辑规则包定义（进程列表、域名及模式）"
              >
                <Pencil className="w-3.5 h-3.5" />
                <span>编辑</span>
              </button>
              <button
                type="button"
                onClick={() => onExport(instance)}
                className="px-2.5 py-1 rounded text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition cursor-pointer flex items-center space-x-1"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>导出纯净包</span>
              </button>
              <button
                type="button"
                onClick={() => onDelete(instance.instanceId)}
                className="px-2.5 py-1 rounded text-rose-600 hover:text-rose-700 dark:text-red-400 dark:hover:text-red-300 hover:bg-rose-50 dark:hover:bg-red-500/10 transition cursor-pointer flex items-center space-x-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>卸载</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
