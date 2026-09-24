import React, { useState } from "react";
import { version as appVersion } from "../package.json";
import { CoreControlBar } from "./components/CoreControlBar";
import { ExclusionsDialog } from "./components/ExclusionsDialog";
import { useExclusions } from "./hooks/useExclusions";
import { MonitoringRuntime, MonitoredTrafficOverview } from "./components/MonitoringRuntime";
import { ActiveExitCard } from "./components/ActiveExitCard";
import { ChannelDispatcherView } from "./views/ChannelDispatcherView";
import { TrafficRoutingView } from "./views/TrafficRoutingView";
import { ProfilesView } from "./views/ProfilesView";
import { SettingsView } from "./views/SettingsView";
import { MaintenanceView } from "./views/MaintenanceView";
import { ConnectionsView } from "./views/ConnectionsView";
import { LogsView } from "./views/LogsView";
import { useTrayManager } from "./hooks/useTrayManager";
import { useCoreMode } from "./hooks/useCoreMode";
import { useBundleRuntime } from "./hooks/useBusinessBundles";
import { useBundleTools } from "./hooks/useBundleTools";
import { BundleToolsDialog } from "./components/business-bundle/BundleToolsDialog";
import { useCoreStatus } from "./hooks/useCoreStatus";
import { appendAppLog } from "./api/logs";
import { ThemeToggle } from "./components/ThemeToggle";
import { WindowControls } from "./components/WindowControls";
import { windowToggleMaximize, windowStartDragging, getProfiles, isTauri } from "./api";
import appIcon from "./assets/app-icon.png";
import { localNodesApi } from "./api/localNodes";
import type { LocalNodeSummary } from "./types/localNodes";
import {
  LayoutDashboard,
  Radio,
  ArrowRightLeft,
  FileText,
  Settings,
  Layers,
  ShieldCheck,
  AlertTriangle,
  RotateCcw,
  Activity,
  ScrollText,
  Wrench,
} from "lucide-react";

// 页面级 ErrorBoundary，防止任何单个组件渲染错误导致应用崩溃白屏
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("ErrorBoundary 捕获到视图渲染异常:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-center space-y-4 max-w-xl mx-auto my-12">
          <div className="w-12 h-12 rounded-2xl bg-rose-500/20 text-rose-400 flex items-center justify-center mx-auto">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">视图渲染遇到异常</h3>
            <p className="text-xs text-rose-300/80 mt-1 font-mono">
              {this.state.error?.message || "未知错误"}
            </p>
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="inline-flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>重置此页面</span>
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

import { TrayContextMenuView } from "./views/TrayContextMenuView";

export function App() {
  const isTrayMenuWindow = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("window") === "tray-menu";
  if (isTrayMenuWindow) {
    return <TrayContextMenuView />;
  }

  const exclusions = useExclusions();
  useBundleRuntime();
  const bundleTools = useBundleTools();
  const [activeTab, setActiveTab] = useState("dashboard");
  const [profileCount, setProfileCount] = useState<number | null>(null);
  const [localNodeSummaries, setLocalNodeSummaries] = useState<LocalNodeSummary[] | null>(null);
  const { status: coreStatus, refresh: refreshCoreStatus } = useCoreStatus();
  const lastProxyEvent = React.useRef<number | undefined>();
  React.useEffect(() => {
    const event = coreStatus.systemProxy?.lastChange;
    if (event && event.timestamp !== lastProxyEvent.current) {
      lastProxyEvent.current = event.timestamp;
      appendAppLog(event.state === "unknown" || event.state === "external" ? "warning" : "info",
        `[系统代理] ${event.reason}（${new Date(event.timestamp).toLocaleTimeString()}）`);
    }
  }, [coreStatus.systemProxy?.lastChange]);

  const coreMode = useCoreMode(coreStatus.pid);
  const mode = coreMode.mode;
  const [activeNodeName, setActiveNodeName] = useState<string>(() => {
    try {
      return localStorage.getItem("netbox_active_node_name") || "";
    } catch {
      return "";
    }
  });

  // 选项卡切换过渡动画偏好消费 (D08)
  const [tabAnimation, setTabAnimation] = useState<boolean>(() => {
    try {
      return localStorage.getItem("netbox_tab_animation") !== "false";
    } catch {
      return true;
    }
  });



  // 全局托盘状态调度与看门狗（解耦页面依赖，冷启动与常驻无缝保活）
  useTrayManager({
    coreStatus,
    mode,
    activeNodeName,
  });

  React.useEffect(() => {
    const handleNodeChange = (e: any) => {
      const name = e.detail?.nodeName;
      if (name) {
        setActiveNodeName(name);
      }
    };
    window.addEventListener("netbox-active-node-changed", handleNodeChange);
    return () => {
      window.removeEventListener("netbox-active-node-changed", handleNodeChange);
    };
  }, []);

  React.useEffect(() => {
    if (coreStatus.running) {
      import("./api/mihomo").then(({ fetchProxies }) => {
        fetchProxies().then((res) => {
          if (res?.groups) {
            const main = res.groups.find((g) => g.name === "PROXY" || g.name === "GLOBAL" || g.name.includes("节点选择")) || res.groups[0];
            if (main?.now) {
              setActiveNodeName(main.now);
              try {
                localStorage.setItem("netbox_active_node_name", main.now);
              } catch {}
            }
          }
        }).catch(() => {});
      });
    }
  }, [coreStatus.running]);

  const isStartingRef = React.useRef(false);

  React.useEffect(() => {
    if (isStartingRef.current) return;
    isStartingRef.current = true;

    // 启动行为由原生应用按持久化设置执行，页面仅读取状态。
    void refreshCoreStatus();
  }, []);

  React.useEffect(() => {
    const checkProfiles = async () => {
      void localNodesApi.read().then(view => setLocalNodeSummaries(view.nodes)).catch(() => setLocalNodeSummaries(null));
      try {
        const list = await getProfiles();
        setProfileCount(Array.isArray(list) ? list.length : 0);
      } catch {
        setProfileCount(0);
      }
    };
    checkProfiles();

    const onProfileChanged = () => {
      checkProfiles();
    };
    const onNavigateTab = (e: any) => {
      if (e.detail && typeof e.detail === "string") {
        setActiveTab(e.detail);
      }
    };

    window.addEventListener("procweaver-profile-changed", onProfileChanged);
    window.addEventListener("netbox-profile-changed", onProfileChanged);
    window.addEventListener("procweaver-navigate-tab", onNavigateTab);
    window.addEventListener("netbox-navigate-tab", onNavigateTab);

    let unlisteners: Array<() => void> = [];

    if (isTauri()) {
      import("@tauri-apps/api/event").then(({ listen }) => {
        // 1. 系统代理开关联动
        listen<boolean>("netbox-sysproxy-changed", (event) => {
          void refreshCoreStatus();
          window.dispatchEvent(new CustomEvent("netbox-sysproxy-changed", { detail: event.payload }));
        }).then((un) => unlisteners.push(un));
        listen<string>("netbox-sysproxy-error", (event) => {
          window.alert(event.payload);
        }).then((un) => unlisteners.push(un));

        // 2. 核心路由/模式变更联动
        listen("netbox-route-changed", () => {
          void refreshCoreStatus();
          window.dispatchEvent(new CustomEvent("netbox-route-changed"));
        }).then((un) => unlisteners.push(un));

        // 3. 托盘导航页面秒切联动 (打开节点大盘 / 分流规则 / 运行概览)
        listen<string>("procweaver-navigate-tab", (event) => {
          if (event.payload && typeof event.payload === "string") {
            setActiveTab(event.payload);
            window.dispatchEvent(new CustomEvent("procweaver-navigate-tab", { detail: event.payload }));
          }
        }).then((un) => unlisteners.push(un));

        // 4. 托盘地区过滤跳转联动
        listen<string>("procweaver-filter-region", (event) => {
          if (event.payload && typeof event.payload === "string") {
            window.dispatchEvent(new CustomEvent("procweaver-filter-region", { detail: event.payload }));
          }
        }).then((un) => unlisteners.push(un));

        // 5. 设置保存广播联动
        listen("netbox-settings-saved", () => {
          window.dispatchEvent(new CustomEvent("netbox-settings-saved"));
        }).then((un) => unlisteners.push(un));

        // 6. 进程分流总开关广播联动
        listen<boolean>("netbox-process-master-changed", (event) => {
          window.dispatchEvent(new CustomEvent("netbox-process-master-changed", { detail: event.payload }));
        }).then((un) => unlisteners.push(un));
      });
    }

    const onSettingsSaved = () => {
      try {
        setTabAnimation(localStorage.getItem("netbox_tab_animation") !== "false");
      } catch {}
    };
    window.addEventListener("netbox-settings-saved", onSettingsSaved);

    return () => {
      window.removeEventListener("procweaver-profile-changed", onProfileChanged);
      window.removeEventListener("netbox-profile-changed", onProfileChanged);
      window.removeEventListener("procweaver-navigate-tab", onNavigateTab);
      window.removeEventListener("netbox-navigate-tab", onNavigateTab);
      window.removeEventListener("netbox-settings-saved", onSettingsSaved);
      unlisteners.forEach((un) => un());
    };
  }, []);

  const handleModeChange = async (newMode: "rule" | "global" | "direct") => {
    await coreMode.change(newMode);
  };

  const getPageTitle = () => {
    switch (activeTab) {
      case "dashboard":
        return "运行概览";
      case "proxies":
        return "节点管理 (全部节点池 · 自定义分组 · 链式中继)";
      case "routing":
        return "分流规则 (常用业务 · 软件进程 · 域名与 DNS)";
      case "connections":
        return "连接追踪 (活跃连接 · 请求流水 · 实时断开)";
      case "logs":
        return "系统日志 (内核输出 · 等级过滤 · 控制台导出)";
      case "profiles":
        return "订阅配置 (节点订阅 · YAML · 节点提取)";
      case "settings":
        return "系统偏好设置";
      case "maintenance":
        return "版本与组件维护 (客户端更新 · Mihomo 内核 · 规则与 GEO)";
      default:
        return "控制台";
    }
  };

  const handleWindowDrag = async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (
      target.closest("button") ||
      target.closest("input") ||
      target.closest("select") ||
      target.closest("a") ||
      target.closest("[data-no-drag]")
    ) {
      return;
    }
    if (e.detail === 2) {
      try {
        await windowToggleMaximize();
      } catch (err) {
        console.error("切换窗口最大化失败:", err);
      }
      return;
    }
    try {
      await windowStartDragging();
    } catch (err) {
      console.error("启动窗口拖拽失败:", err);
    }
  };

  return (
    <div className="flex h-screen w-screen bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 overflow-hidden font-sans transition-colors duration-200 border border-slate-200/80 dark:border-slate-800/80">
      <MonitoringRuntime />
      {/* 左侧侧边栏 */}
      <aside className="w-60 bg-white/90 dark:bg-slate-900/60 border-r border-slate-200/90 dark:border-slate-800/80 flex flex-col justify-between p-4 backdrop-blur-xl shrink-0 transition-colors duration-200">
        <div>
          {/* Logo 区域 (支持拖拽移动窗口与双击最大化) */}
          <div
            data-tauri-drag-region
            onMouseDown={handleWindowDrag}
            onDoubleClick={() => windowToggleMaximize()}
            className="flex items-center space-x-3 px-3 py-4 mb-4 select-none cursor-default"
          >
            <div className="w-11 h-11 rounded-2xl flex items-center justify-center pointer-events-none shrink-0 overflow-hidden shadow-lg shadow-indigo-500/15 dark:shadow-[0_0_20px_rgba(56,189,248,0.25)] bg-gradient-to-br from-indigo-500/10 via-sky-500/5 to-purple-600/10 dark:from-indigo-950/80 dark:via-slate-900/90 dark:to-cyan-950/60 border border-indigo-200/80 dark:border-indigo-500/40 p-1 transition-all">
              <img
                src={appIcon}
                alt="ProcWeaver Logo"
                className="w-full h-full object-contain filter drop-shadow-[0_0_8px_rgba(56,189,248,0.4)] contrast-110 brightness-105"
                draggable={false}
              />
            </div>
            <div className="pointer-events-none">
              <h1 className="font-bold text-lg text-slate-900 dark:text-white tracking-wider flex items-center gap-1.5">
                <span>ProcWeaver</span>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50 animate-pulse" />
              </h1>
              <span className="text-[11px] text-indigo-500 dark:text-indigo-400 font-mono tracking-normal">V{appVersion} • Mihomo</span>
            </div>
          </div>

          {/* 导航菜单 (7 项收敛一级导航) */}
          <nav className="space-y-1.5">
            {/* 1. 运行概览 */}
            <button
              onClick={() => setActiveTab("dashboard")}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === "dashboard"
                  ? "bg-indigo-50 text-indigo-600 border border-indigo-200/80 dark:bg-indigo-600/15 dark:text-indigo-400 dark:border-indigo-500/30 shadow-sm"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800/60 border border-transparent"
              }`}
            >
              <div className="flex items-center space-x-3">
                <LayoutDashboard className={`w-4 h-4 ${activeTab === "dashboard" ? "text-indigo-600 dark:text-indigo-400" : "text-slate-400"}`} />
                <span>运行概览</span>
              </div>
              <span className="text-[10px] opacity-75 font-mono">实时</span>
            </button>

            {/* 2. 节点管理 */}
            <button
              onClick={() => setActiveTab("proxies")}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === "proxies"
                  ? "bg-indigo-50 text-indigo-600 border border-indigo-200/80 dark:bg-indigo-600/15 dark:text-indigo-400 dark:border-indigo-500/30 shadow-sm"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800/60 border border-transparent"
              }`}
            >
              <div className="flex items-center space-x-3">
                <Radio className={`w-4 h-4 ${activeTab === "proxies" ? "text-indigo-600 dark:text-indigo-400" : "text-slate-400"}`} />
                <span>节点管理</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-200/80 text-slate-700 dark:bg-slate-800 dark:text-slate-300 font-mono">
                大盘/分组
              </span>
            </button>

            {/* 3. 分流规则 */}
            <button
              onClick={() => setActiveTab("routing")}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === "routing"
                  ? "bg-indigo-50 text-indigo-600 border border-indigo-200/80 dark:bg-indigo-600/15 dark:text-indigo-400 dark:border-indigo-500/30 shadow-sm"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800/60 border border-transparent"
              }`}
            >
              <div className="flex items-center space-x-3">
                <ArrowRightLeft className={`w-4 h-4 ${activeTab === "routing" ? "text-indigo-600 dark:text-indigo-400" : "text-slate-400"}`} />
                <span>分流规则</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300 font-mono">
                业务/进程/规则
              </span>
            </button>

            {/* 4. 连接追踪 */}
            <button
              onClick={() => setActiveTab("connections")}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === "connections"
                  ? "bg-indigo-50 text-indigo-600 border border-indigo-200/80 dark:bg-indigo-600/15 dark:text-indigo-400 dark:border-indigo-500/30 shadow-sm"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800/60 border border-transparent"
              }`}
            >
              <div className="flex items-center space-x-3">
                <Activity className={`w-4 h-4 ${activeTab === "connections" ? "text-indigo-600 dark:text-indigo-400" : "text-slate-400"}`} />
                <span>连接追踪</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-300 font-mono">
                活跃/流水
              </span>
            </button>

            {/* 5. 系统日志 */}
            <button
              onClick={() => setActiveTab("logs")}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === "logs"
                  ? "bg-indigo-50 text-indigo-600 border border-indigo-200/80 dark:bg-indigo-600/15 dark:text-indigo-400 dark:border-indigo-500/30 shadow-sm"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800/60 border border-transparent"
              }`}
            >
              <div className="flex items-center space-x-3">
                <ScrollText className={`w-4 h-4 ${activeTab === "logs" ? "text-indigo-600 dark:text-indigo-400" : "text-slate-400"}`} />
                <span>系统日志</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-200/80 text-slate-700 dark:bg-slate-800 dark:text-slate-300 font-mono">
                实时流
              </span>
            </button>

            {/* 6. 订阅配置 */}
            <button
              onClick={() => setActiveTab("profiles")}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === "profiles"
                  ? "bg-indigo-50 text-indigo-600 border border-indigo-200/80 dark:bg-indigo-600/15 dark:text-indigo-400 dark:border-indigo-500/30 shadow-sm"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800/60 border border-transparent"
              }`}
            >
              <div className="flex items-center space-x-3">
                <FileText className={`w-4 h-4 ${activeTab === "profiles" ? "text-indigo-600 dark:text-indigo-400" : "text-slate-400"}`} />
                <span>订阅配置</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300 font-mono">
                {profileCount !== null ? `${profileCount}个源` : "订阅"}
              </span>
            </button>

            {/* 7. 系统偏好设置 */}
            <button
              onClick={() => setActiveTab("settings")}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === "settings"
                  ? "bg-indigo-50 text-indigo-600 border border-indigo-200/80 dark:bg-indigo-600/15 dark:text-indigo-400 dark:border-indigo-500/30 shadow-sm"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800/60 border border-transparent"
              }`}
            >
              <div className="flex items-center space-x-3">
                <Settings className={`w-4 h-4 ${activeTab === "settings" ? "text-indigo-600 dark:text-indigo-400" : "text-slate-400"}`} />
                <span>偏好设置</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-200/80 text-slate-700 dark:bg-slate-800 dark:text-slate-300 font-mono">
                TUN/驱动
              </span>
            </button>

            {/* 8. 版本与组件维护 */}
            <button
              onClick={() => setActiveTab("maintenance")}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === "maintenance"
                  ? "bg-indigo-50 text-indigo-600 border border-indigo-200/80 dark:bg-indigo-600/15 dark:text-indigo-400 dark:border-indigo-500/30 shadow-sm"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800/60 border border-transparent"
              }`}
            >
              <div className="flex items-center space-x-3">
                <Wrench className={`w-4 h-4 ${activeTab === "maintenance" ? "text-indigo-600 dark:text-indigo-400" : "text-slate-400"}`} />
                <span>版本维护</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300 font-mono">
                更新/内核/GEO
              </span>
            </button>
          </nav>
        </div>

        {/* 底部分流模式切换 */}
        <div className="p-3 rounded-xl bg-slate-100/90 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800/80 text-xs">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-slate-500 dark:text-slate-400">运行模式</span>
            <span title={coreMode.error || undefined} className="text-indigo-600 dark:text-indigo-400 font-semibold uppercase">{mode ?? "未就绪"}</span>
          </div>
          <div className="flex rounded-lg bg-slate-200/60 dark:bg-slate-900 p-0.5 border border-slate-300/60 dark:border-slate-800">
            {(["rule", "global", "direct"] as const).map((m) => (
              <button
                key={m}
                onClick={() => handleModeChange(m)}
                disabled={coreMode.busy || !mode}
                className={`flex-1 py-1 rounded-md text-[11px] font-medium transition ${
                  mode === m
                    ? "bg-indigo-600 text-white shadow"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
                }`}
              >
                {m === "rule" ? "规则" : m === "global" ? "全局" : "直连"}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* 右侧主视口 */}
      <main className="flex-1 flex flex-col h-full overflow-hidden bg-slate-50 dark:bg-slate-950 transition-colors duration-200">
        {/* 顶部标题栏 (支持拖拽移动窗口与双击最大化) */}
        <header
          data-tauri-drag-region
          onMouseDown={handleWindowDrag}
          onDoubleClick={() => windowToggleMaximize()}
          className="h-14 border-b border-slate-200 dark:border-slate-800/80 pl-8 pr-3 flex items-center justify-between bg-white/70 dark:bg-slate-900/40 backdrop-blur-md shrink-0 transition-colors duration-200 select-none cursor-default"
        >
          <div className="flex items-center space-x-2 pointer-events-none">
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              {getPageTitle()}
            </span>
          </div>

          <div
            className="flex items-center space-x-3 text-xs"
            data-tauri-drag-region="false"
          >
            {/* 顶栏快速主题切换 */}
            <ThemeToggle compact={false} />

            {/* 分隔竖线 */}
            <div className="h-4 w-px bg-slate-200 dark:bg-slate-800 mx-1" />

            {/* 自定义窗口控制按钮 (最小化、最大化/还原、关闭) */}
            <WindowControls />
          </div>
        </header>

        {/* 内容主体：对高级视窗采用吸顶 Tab 架构，对常规单页保留居中流动排版 */}
        <div className="flex-1 overflow-hidden relative">
          <div key={activeTab} className={tabAnimation ? "h-full animate-in fade-in duration-150" : "h-full"}>
            <ErrorBoundary>
              {activeTab === "proxies" && <ChannelDispatcherView />}

              {activeTab === "routing" && <TrafficRoutingView mode={mode} coreMode={coreMode} />}

            {activeTab === "connections" && (
              <div className="h-full overflow-y-auto p-6 md:p-8">
                <div className="max-w-5xl mx-auto space-y-6">
                  <ConnectionsView controllerPort={coreStatus.controllerPort} />
                </div>
              </div>
            )}

            {activeTab === "logs" && (
              <div className="h-full overflow-y-auto p-6 md:p-8">
                <div className="max-w-5xl mx-auto space-y-6">
                  <LogsView controllerPort={coreStatus.controllerPort} />
                </div>
              </div>
            )}

            {activeTab === "profiles" && (
              <div className="h-full overflow-y-auto p-6 md:p-8">
                <div className="max-w-5xl mx-auto space-y-6">
                  <ProfilesView />
                </div>
              </div>
            )}

            {activeTab === "settings" && (
              <div className="h-full overflow-y-auto p-6 md:p-8">
                <div className="max-w-5xl mx-auto space-y-6">
                  <SettingsView />
                </div>
              </div>
            )}

            {activeTab === "maintenance" && (
              <div className="h-full overflow-y-auto p-6 md:p-8">
                <div className="max-w-5xl mx-auto space-y-6">
                  <MaintenanceView />
                </div>
              </div>
            )}

            {activeTab === "dashboard" && (
              <div className="h-full overflow-y-auto p-6 md:p-8">
                <div className="max-w-5xl mx-auto space-y-6">
                  {/* 首次使用未添加订阅引导横幅 */}
                  {profileCount === 0 && localNodeSummaries?.length === 0 && (
                    <div className="p-5 rounded-2xl bg-gradient-to-r from-indigo-500/10 via-purple-500/10 to-pink-500/10 border border-indigo-200 dark:border-indigo-500/30 flex flex-col sm:flex-row items-center justify-between gap-4 shadow-sm">
                      <div className="flex items-center space-x-3.5">
                        <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center shrink-0 shadow-md shadow-indigo-600/20">
                          <Layers className="w-5 h-5" />
                        </div>
                        <div>
                          <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                            <span>首次使用：尚未添加订阅或节点配置</span>
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300 font-semibold border border-indigo-200 dark:border-indigo-500/30">
                              纯净待机
                            </span>
                          </h4>
                          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                            当前核心处于纯净直连待机状态，未发起多余外部网络探测。请先前往【订阅配置】导入您的节点订阅链接或配置文件。
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveTab("profiles");
                        }}
                        className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/30 transition shrink-0 cursor-pointer"
                      >
                        立即前往添加订阅
                      </button>
                    </div>
                  )}
                  <CoreControlBar
                    extraAction={
                      <ExclusionsDialog
                        state={exclusions.state}
                        actions={exclusions.actions}
                        trigger={(open) => (
                          <button
                            type="button"
                            onClick={open}
                            title="设置直连排除域名与IP列表"
                            className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300/80 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 dark:border-slate-700 transition shadow-sm"
                          >
                            <ShieldCheck className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" />
                            <span>排除域名/IP</span>
                          </button>
                        )}
                      />
                    }
                  />
                  <MonitoredTrafficOverview />
                  <ActiveExitCard
                    proxyPort={coreStatus.running ? coreStatus.mixedPort : undefined}
                    corePid={coreStatus.pid}
                    activeNodeName={activeNodeName}
                    activeNodeLabel={localNodeSummaries?.find(n => n.alias === activeNodeName)?.name}
                  />
                </div>
              </div>
            )}
          </ErrorBoundary>
        </div>
      </div>
    </main>
    <BundleToolsDialog {...bundleTools} />
    </div>
  );
}

export default App;
