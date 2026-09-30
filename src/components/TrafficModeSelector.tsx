import React, { useState, useEffect, useRef } from "react";
import { Zap, Bot, Shield, RefreshCw, Cpu, Check, ChevronDown } from "lucide-react";
import { getGeneralSettings, saveGeneralSettings, getActiveTrafficDriver, GeneralSettings } from "../api/settings";
import { toggleSystemProxy } from "../api";

import { useCoreStatus } from "../hooks/useCoreStatus";
import { usePlatform } from "../context/PlatformContext";

export type TrafficModeType = "app_proxy" | "smart_hybrid" | "tun" | "windivert_v1";

interface Props {
  onModeChanged?: (mode: TrafficModeType) => void;
  className?: string;
  variant?: "default" | "compact";
}

export const TrafficModeSelector: React.FC<Props> = ({ onModeChanged, className = "", variant = "default" }) => {
  const platform = usePlatform();
  const [currentMode, setCurrentMode] = useState<TrafficModeType>("app_proxy");
  const [activeDriver, setActiveDriver] = useState<string>("app_proxy");
  const { status: coreStatus, run, pending } = useCoreStatus();
  const [switching, setSwitching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // 加载当前设置与底层驱动状态
  const loadDriverStatus = async () => {
    try {
      const [settings, driver] = await Promise.all([
        getGeneralSettings(),
        getActiveTrafficDriver(),
      ]);
      const mode = (settings.trafficMode as TrafficModeType) || (settings.tunMode ? "tun" : "app_proxy");
      setCurrentMode(mode);
      setActiveDriver(driver);
      setLoadError(null);
    } catch (e) {
      console.error("读取驱动接管模式失败:", e);
      setLoadError(`读取接管模式失败：${String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDriverStatus();
    const interval = platform.os === "android" ? null : setInterval(async () => {
      try {
        const driver = await getActiveTrafficDriver();
        setActiveDriver(driver);
      } catch (_) {}
    }, 2500);

    const onSettingsSaved = () => loadDriverStatus();
    window.addEventListener("netbox-settings-saved", onSettingsSaved);

    return () => {
      if (interval !== null) clearInterval(interval);
      window.removeEventListener("netbox-settings-saved", onSettingsSaved);
    };
  }, [platform.os]);

  // 切换接管模式
  const handleSelectMode = async (mode: TrafficModeType) => {
    if (loading || loadError || switching || mode === currentMode) return;
    setSwitching(true);
    setFeedbackMsg(null);

    try {
      const current = await getGeneralSettings();
      const updated: GeneralSettings = {
        ...current,
        trafficMode: mode,
        tunMode: mode === "tun",
      };
      const saved = await saveGeneralSettings(updated);
      const savedMode = saved.trafficMode || (saved.tunMode ? "tun" : "app_proxy");
      setCurrentMode(savedMode);
      onModeChanged?.(savedMode);

      // 实时获取物理驱动新状态
      let driver: string;
      try {
        driver = await getActiveTrafficDriver();
      } catch (error) {
        setLoadError(`模式已保存，但运行状态读取失败：${String(error)}`);
        return;
      }
      setActiveDriver(driver);

      const labelMap: Record<TrafficModeType, string> = {
        app_proxy: "纯应用层代理 (零驱动 · 极速免特权)",
        smart_hybrid: "智能双模式 (应用层为主 · 游戏自启 TUN)",
        tun: "全局网卡 (TUN 全接管)",
        windivert_v1: "进程接管 (WinDivert · TCP / UDP)",
      };
      setFeedbackMsg(savedMode === "windivert_v1" && driver !== "windivert"
        ? "已保存 WinDivert 模式；启动核心后将请求管理员授权，当前尚未接管"
        : `已切换至【${labelMap[savedMode]}】`);
      setTimeout(() => setFeedbackMsg(null), 3000);
    } catch (err) {
      console.error("切换接管模式失败:", err);
      setFeedbackMsg(`切换失败: ${String(err)}`);
      setTimeout(() => setFeedbackMsg(null), 4000);
    } finally {
      setSwitching(false);
    }
  };

  const MODES: {
    id: TrafficModeType;
    title: string;
    subLabel: string;
    tooltip: string;
    icon: React.ReactNode;
  }[] = [
    {
      id: "app_proxy",
      title: "纯应用层",
      subLabel: "App-Proxy",
      tooltip: "通过应用代理参数、环境变量或系统代理接入；仅支持遵循这些设置的应用",
      icon: <Zap className="w-3.5 h-3.5 text-amber-500" />,
    },
    {
      id: "smart_hybrid",
      title: "智能双模式",
      subLabel: "Auto-Hybrid",
      tooltip: "平时保持应用层轻量巡航；启动 CS2/Apex/外服无代理配置游戏时自动唤醒 TUN，退出后平滑归位",
      icon: <Bot className="w-3.5 h-3.5 text-indigo-500" />,
    },
    {
      id: "windivert_v1",
      title: "WinDivert",
      subLabel: "进程接管 · 实验",
      tooltip: "按明确进程规则接管新 TCP / UDP 连接（含进程自行发出的 DNS）；首次启用解压组件并请求管理员授权。未知归属沿用原链路",
      icon: <Shield className="w-3.5 h-3.5 text-violet-500" />,
    },
    {
      id: "tun",
      title: "全局网卡",
      subLabel: "TUN",
      tooltip: "Wintun 全协议底层全接管，全系统 TCP/UDP 与 DNS 走虚拟网卡，适合无法设置代理的复杂环境",
      icon: <Shield className="w-3.5 h-3.5 text-blue-500" />,
    },
  ];

  if (variant === "compact") {
    const activeModeItem = MODES.find((m) => m.id === currentMode) || MODES[0];
    const availableModes = MODES.filter(
      (item) => item.id === "app_proxy" || (item.id === "windivert_v1" ? platform.os === "windows" : item.id === "tun" ? platform.tun : platform.smartHybrid)
    );

    return (
      <div className={`relative ${isOpen ? "z-50" : ""} ${className}`} ref={dropdownRef}>
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="h-7 px-2.5 rounded-lg bg-slate-100 hover:bg-slate-200/80 dark:bg-slate-800 dark:hover:bg-slate-750 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-medium text-[11px] flex items-center space-x-1.5 transition shadow-2xs cursor-pointer select-none"
          title="点击切换全局底层接管模式与查看驱动状态"
        >
          {activeModeItem.icon}
          <span>
            接管: <strong className="font-bold text-slate-900 dark:text-white">{activeModeItem.title}</strong>
          </span>
          {switching ? (
            <RefreshCw className="w-3 h-3 text-indigo-500 animate-spin" />
          ) : (
            <ChevronDown className="w-3 h-3 text-slate-400" />
          )}
        </button>

        {/* 下拉浮层卡片 */}
        {isOpen && (
          <div className="absolute left-0 top-full mt-1.5 z-50 w-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl p-3 text-xs space-y-2.5 animate-in fade-in zoom-in-95 duration-100 font-sans">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2">
              <span className="font-bold text-slate-800 dark:text-slate-200 flex items-center space-x-1.5">
                <Cpu className="w-3.5 h-3.5 text-indigo-500" />
                <span>全局底层接管模式</span>
              </span>
              <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[10px] font-mono text-slate-600 dark:text-slate-300">
                <span className={`w-1.5 h-1.5 rounded-full ${loading || loadError || !coreStatus.running ? "bg-slate-400" : activeDriver === "windivert_pending" ? "bg-amber-500" : activeDriver === "tun" ? "bg-blue-500" : "bg-emerald-500"}`} />
                <span>{activeDriver === "tun" ? "TUN 就绪" : activeDriver === "windivert" ? "WinDivert 运行中" : activeDriver === "windivert_pending" ? "待授权" : "纯应用层"}</span>
              </span>
            </div>

            {/* 4 个模式卡片 */}
            <div className="grid grid-cols-2 gap-1.5">
              {availableModes.map((item) => {
                const isSelected = currentMode === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={loading || Boolean(loadError) || switching}
                    onClick={() => {
                      void handleSelectMode(item.id);
                    }}
                    className={`p-2 rounded-xl border text-left transition cursor-pointer select-none ${
                      isSelected
                        ? "border-indigo-500 bg-indigo-50/70 dark:bg-indigo-950/40 text-indigo-900 dark:text-indigo-200 font-bold shadow-2xs"
                        : "border-slate-200/80 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-850 text-slate-700 dark:text-slate-300"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="flex items-center space-x-1">
                        {item.icon}
                        <span className="text-[11px]">{item.title}</span>
                      </span>
                      {isSelected && <Check className="w-3 h-3 text-indigo-600 dark:text-indigo-400" />}
                    </div>
                    <span className="text-[9px] opacity-60 font-mono block mt-0.5">{item.subLabel}</span>
                  </button>
                );
              })}
            </div>

            {/* 说明小字 */}
            <div className="text-[10px] text-slate-500 dark:text-slate-400 leading-relaxed bg-slate-50 dark:bg-slate-950 p-2.5 rounded-xl border border-slate-100 dark:border-slate-800/80 space-y-1">
              {currentMode === "windivert_v1" ? (
                <>
                  <div className="font-semibold text-slate-700 dark:text-slate-300">
                    进程级驱动接管 (WinDivert)
                  </div>
                  <div className="text-emerald-600 dark:text-emerald-400">
                    • 优势：0 虚拟网卡、精准进程分流、原生 UDP DNS、按需加载零残留
                  </div>
                  <div className="text-amber-600 dark:text-amber-400">
                    • 缺点：需管理员 UAC 权限、易与反作弊游戏冲突、仅接管新建立连接
                  </div>
                </>
              ) : currentMode === "tun" ? (
                <>
                  <div className="font-semibold text-slate-700 dark:text-slate-300">全局网卡模式 (TUN)</div>
                  <div>全系统所有协议流量及 DNS 经虚拟网卡接管，适合复杂网络或无法设代理的应用。</div>
                </>
              ) : currentMode === "smart_hybrid" ? (
                <>
                  <div className="font-semibold text-slate-700 dark:text-slate-300">智能双模式 (Auto-Hybrid)</div>
                  <div>日常保持 0 网卡轻量应用层代理，启动外服游戏或无代理程序时自启 TUN。</div>
                </>
              ) : (
                <>
                  <div className="font-semibold text-slate-700 dark:text-slate-300">纯应用层代理 (App-Proxy)</div>
                  <div>零驱动、极速免提权、系统零侵入。需目标程序遵循系统或应用代理设置。</div>
                </>
              )}
            </div>

            {/* 切换中反馈 */}
            {feedbackMsg && (
              <div className="text-[10px] text-emerald-600 dark:text-emerald-400 flex items-center space-x-1">
                <Check className="w-3 h-3" />
                <span>{feedbackMsg}</span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (platform.os === "android") return <div className={`p-3 rounded-2xl border text-sm ${className}`}>
    <span className="font-medium">Android VPN</span>
    <p className="text-xs text-slate-500 mt-1">通过系统授权接管应用流量。关闭界面后，连接由前台服务继续维护。</p>
  </div>;
  return (
    <div className={`p-3 rounded-2xl bg-white/70 dark:bg-slate-900/40 border border-slate-200/80 dark:border-slate-800/80 shadow-2xs backdrop-blur-xs transition ${className}`}>
      <div className="flex flex-wrap items-start sm:items-center justify-between gap-2.5">
        {/* 左侧：标题与生效状态 */}
        <div className="flex items-center space-x-2.5 text-xs shrink-0">
          <div className="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
            <Cpu className="w-3.5 h-3.5" />
          </div>
          <span className="font-semibold text-slate-800 dark:text-slate-200">全局接管模式</span>
          <span className="text-slate-300 dark:text-slate-700">|</span>
          <div className="flex items-center space-x-1.5 text-[11px]">
            <span className="text-slate-400">底层状态:</span>
            <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono text-[10px]">
              <span className={`w-1.5 h-1.5 rounded-full ${loading || loadError || !coreStatus.running ? "bg-slate-400" : activeDriver === "windivert_pending" ? "bg-amber-500" : activeDriver === "tun" ? "bg-blue-500" : "bg-emerald-500"}`} />
              <span>{loading ? "读取中…" : loadError ? "状态未确认" : !coreStatus.running ? "核心未运行" : activeDriver === "tun" ? "Wintun 虚拟网卡" : activeDriver === "windivert" ? "WinDivert 已启用" : activeDriver === "windivert_pending" ? "WinDivert 尚未接管" : "纯应用层代理 (零驱动)"}</span>
            </span>
          </div>

          {switching && (
            <div className="flex items-center space-x-1 text-[11px] text-indigo-600 dark:text-indigo-400 font-medium ml-1">
              <RefreshCw className="w-3 h-3 animate-spin" />
              <span>{currentMode === "windivert_v1" ? "切换中..." : "切换中，请留意授权窗口..."}</span>
            </div>
          )}
        </div>

        {/* 右侧：紧凑分段药丸选择器 (Segmented Control) */}
        <div className="flex flex-wrap items-center p-1 rounded-xl bg-slate-100/90 dark:bg-slate-800/80 border border-slate-200/60 dark:border-slate-700/60 text-xs w-full sm:w-auto justify-between sm:justify-start">
          {MODES.filter(item => item.id === "app_proxy" || (item.id === "windivert_v1" ? platform.os === "windows" : item.id === "tun" ? platform.tun : platform.smartHybrid)).map((item) => {
            const isSelected = currentMode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={isSelected}
                disabled={loading || Boolean(loadError) || switching}
                onClick={() => handleSelectMode(item.id)}
                title={item.tooltip}
                className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                  isSelected
                    ? "bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-2xs font-semibold"
                    : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
                }`}
              >
                {item.icon}
                <span>{item.title}</span>
                <span className="text-[10px] opacity-60 font-mono hidden md:inline">({item.subLabel})</span>
              </button>
            );
          })}
        </div>
      </div>

      {loadError && <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
        <span>{loadError}</span>
        <button type="button" disabled={loading || switching} onClick={() => { setLoading(true); void loadDriverStatus(); }} className="rounded border border-current px-2 py-1 disabled:opacity-50">重新读取</button>
      </div>}

      {!platform.tun && <p className="mt-2 text-xs text-slate-500">macOS TUN 尚未启用；当前应用代理的实际接入请核对连接与出口。</p>}
      {currentMode === "windivert_v1" && <p className="mt-2 text-xs text-slate-500">首次启用时解压官方组件并请求管理员授权；停用后释放本程序句柄，保留校验通过的缓存。仅接管已明确的进程新连接；系统 DNS 代查、已有连接及无法确认归属的流量不保证接管。使用前请关闭有驱动限制的游戏。</p>}
      {/* 极简协同小建议 */}
      {currentMode === "app_proxy" && coreStatus.systemProxy?.state === "disabled" && (
        <div className="mt-2.5 pt-2 border-t border-slate-100 dark:border-slate-800/60 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400 animate-in fade-in duration-200">
          <div className="flex items-center space-x-1.5">
            <span className="text-amber-500">💡</span>
            <span>当前处于纯应用层模式。如需让 Chrome/Edge 浏览器接入本核心分流，可一键协同开启系统代理</span>
          </div>
          <button
            type="button"
            disabled={pending || !coreStatus.running}
            onClick={async () => {
              try {
                const actual = await run(() => toggleSystemProxy(true, coreStatus.mixedPort));
                setFeedbackMsg(actual.systemProxy?.state === "enabled"
                  ? "已开启系统代理，浏览器域名分流现已接入"
                  : actual.systemProxy?.message || "系统代理状态尚未确认");
                setTimeout(() => setFeedbackMsg(null), 3000);
              } catch (err) {
                setFeedbackMsg(`开启失败：${String(err)}`);
              }
            }}
            className="px-2.5 py-0.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 font-medium transition cursor-pointer text-[11px] shrink-0"
          >
            开启系统代理
          </button>
        </div>
      )}

      {/* 简短操作反馈 */}
      {feedbackMsg && (
        <div className="mt-2 text-[11px] text-indigo-600 dark:text-indigo-400 flex items-center space-x-1 animate-in fade-in">
          <Check className="w-3 h-3 text-emerald-500" />
          <span>{feedbackMsg}</span>
        </div>
      )}
    </div>
  );
};
