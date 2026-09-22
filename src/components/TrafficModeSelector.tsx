import React, { useState, useEffect } from "react";
import { Zap, Bot, Shield, RefreshCw, Cpu, Check } from "lucide-react";
import { getGeneralSettings, saveGeneralSettings, getActiveTrafficDriver, GeneralSettings } from "../api/settings";
import { getCoreStatus, toggleSystemProxy } from "../api";

export type TrafficModeType = "app_proxy" | "smart_hybrid" | "tun";

interface Props {
  onModeChanged?: (mode: TrafficModeType) => void;
  className?: string;
}

export const TrafficModeSelector: React.FC<Props> = ({ onModeChanged, className = "" }) => {
  const [currentMode, setCurrentMode] = useState<TrafficModeType>("app_proxy");
  const [activeDriver, setActiveDriver] = useState<string>("app_proxy");
  const [sysProxyEnabled, setSysProxyEnabled] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  // 加载当前设置与底层驱动状态
  const loadDriverStatus = async () => {
    try {
      const [settings, driver, coreStatus] = await Promise.all([
        getGeneralSettings(),
        getActiveTrafficDriver(),
        getCoreStatus().catch(() => ({ systemProxyEnabled: false })),
      ]);
      const mode = (settings.trafficMode as TrafficModeType) || (settings.tunMode ? "tun" : "app_proxy");
      setCurrentMode(mode);
      setActiveDriver(driver);
      if (coreStatus) {
        setSysProxyEnabled(coreStatus.systemProxyEnabled);
      }
    } catch (e) {
      console.error("读取驱动接管模式失败:", e);
    }
  };

  useEffect(() => {
    loadDriverStatus();
    const interval = setInterval(async () => {
      try {
        const driver = await getActiveTrafficDriver();
        setActiveDriver(driver);
      } catch (_) {}
    }, 2500);

    const onSettingsSaved = () => loadDriverStatus();
    window.addEventListener("netbox-settings-saved", onSettingsSaved);

    return () => {
      clearInterval(interval);
      window.removeEventListener("netbox-settings-saved", onSettingsSaved);
    };
  }, []);

  // 切换接管模式
  const handleSelectMode = async (mode: TrafficModeType) => {
    if (mode === currentMode && !switching) return;
    setSwitching(true);
    setFeedbackMsg(null);

    try {
      const current = await getGeneralSettings();
      const updated: GeneralSettings = {
        ...current,
        trafficMode: mode,
        tunMode: mode === "tun",
      };
      await saveGeneralSettings(updated);
      setCurrentMode(mode);
      onModeChanged?.(mode);

      // 实时获取物理驱动新状态
      const driver = await getActiveTrafficDriver();
      setActiveDriver(driver);

      const labelMap: Record<TrafficModeType, string> = {
        app_proxy: "纯应用层代理 (零驱动 · 极速免特权)",
        smart_hybrid: "智能双模式 (应用层为主 · 游戏自启 TUN)",
        tun: "全局网卡 (TUN 全接管)",
      };
      setFeedbackMsg(`已切换至【${labelMap[mode]}】`);
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
      tooltip: "0 虚拟网卡 · 0 驱动 · 极低开销 · 普通权限秒开，浏览器及各类桌面应用丝滑分流",
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
      id: "tun",
      title: "全局网卡",
      subLabel: "TUN",
      tooltip: "Wintun 全协议底层全接管，全系统 TCP/UDP 与 DNS 走虚拟网卡，适合无法设置代理的复杂环境",
      icon: <Shield className="w-3.5 h-3.5 text-blue-500" />,
    },
  ];

  return (
    <div className={`p-3 rounded-2xl bg-white/70 dark:bg-slate-900/40 border border-slate-200/80 dark:border-slate-800/80 shadow-2xs backdrop-blur-xs transition ${className}`}>
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5">
        {/* 左侧：标题与生效状态 */}
        <div className="flex items-center space-x-2.5 text-xs shrink-0">
          <div className="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
            <Cpu className="w-3.5 h-3.5" />
          </div>
          <span className="font-semibold text-slate-800 dark:text-slate-200">流量接管驱动</span>
          <span className="text-slate-300 dark:text-slate-700">|</span>
          <div className="flex items-center space-x-1.5 text-[11px]">
            <span className="text-slate-400">底层状态:</span>
            <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono text-[10px]">
              <span className={`w-1.5 h-1.5 rounded-full ${activeDriver === "tun" ? "bg-blue-500" : "bg-emerald-500"}`} />
              <span>{activeDriver === "tun" ? "Wintun 虚拟网卡" : "纯应用层代理 (零驱动)"}</span>
            </span>
          </div>

          {switching && (
            <div className="flex items-center space-x-1 text-[11px] text-indigo-600 dark:text-indigo-400 font-medium ml-1">
              <RefreshCw className="w-3 h-3 animate-spin" />
              <span>热切换中...</span>
            </div>
          )}
        </div>

        {/* 右侧：紧凑分段药丸选择器 (Segmented Control) */}
        <div className="flex items-center p-1 rounded-xl bg-slate-100/90 dark:bg-slate-800/80 border border-slate-200/60 dark:border-slate-700/60 text-xs w-full sm:w-auto justify-between sm:justify-start">
          {MODES.map((item) => {
            const isSelected = currentMode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                disabled={switching}
                onClick={() => handleSelectMode(item.id)}
                title={item.tooltip}
                className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
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

      {/* 极简协同小建议 (仅处于纯应用层代理且未开系统代理时温和展示，不喧宾夺主) */}
      {currentMode === "app_proxy" && !sysProxyEnabled && (
        <div className="mt-2.5 pt-2 border-t border-slate-100 dark:border-slate-800/60 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400 animate-in fade-in duration-200">
          <div className="flex items-center space-x-1.5">
            <span className="text-amber-500">💡</span>
            <span>当前处于纯应用层模式。如需让 Chrome/Edge 浏览器接入本核心分流，可一键协同开启系统代理</span>
          </div>
          <button
            type="button"
            onClick={async () => {
              try {
                await toggleSystemProxy(true);
                setSysProxyEnabled(true);
                setFeedbackMsg("已开启系统代理，浏览器域名分流现已接入");
                setTimeout(() => setFeedbackMsg(null), 3000);
              } catch (err) {
                console.error(err);
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

