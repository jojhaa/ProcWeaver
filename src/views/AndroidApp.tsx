import { useEffect, useState, useRef } from "react";
import { Activity, ArrowLeft, ArrowRightLeft, LayoutDashboard, Radio, Settings, ScrollText, FileText, Wrench, ShieldCheck, Menu, X } from "lucide-react";
import { useCoreStatus } from "../hooks/useCoreStatus";
import { useCoreMode } from "../hooks/useCoreMode";
import { resetExitIpHealth } from "../hooks/useExitIpHealth";
import { CoreControlBar } from "../components/CoreControlBar";
import { ActiveExitCard } from "../components/ActiveExitCard";
import { MonitoredTrafficOverview } from "../components/MonitoringRuntime";
import { LinesManagementView } from "./LinesManagementView";
import { AndroidProfilesView } from "./AndroidProfilesView";
import { AndroidSettingsView } from "./AndroidSettingsView";
import { AndroidRoutingView } from "./AndroidRoutingView";
import { MaintenanceView } from "./MaintenanceView";
import { ConnectionsView } from "./ConnectionsView";
import { LogsView } from "./LogsView";
import { fetchProxies } from "../api/mihomo";
import { useMobileBack } from "../utils/mobileBack";
import { getGeneralSettings } from "../api/settings";
import { setStoredConcurrency, setStoredHealthProbeConcurrency } from "../utils/taskQueue";
import { useTheme } from "../context/ThemeContext";
import { androidSystemApi } from "../api/android";
import { syncAndroidInsets } from "../utils/androidInsets";
import { useExclusions } from "../hooks/useExclusions";
import { ExclusionsDialog } from "../components/ExclusionsDialog";
import { ThemeToggle } from "../components/ThemeToggle";

const tabs = [
  { id: "dashboard", label: "控制台", icon: LayoutDashboard },
  { id: "proxies", label: "节点池", icon: Radio },
  { id: "routing", label: "应用分流", icon: ArrowRightLeft },
  { id: "settings", label: "偏好设置", icon: Settings },
];
const titles: Record<string, string> = { profiles: "订阅管理", maintenance: "规则与 GEO 更新", connections: "连接记录", logs: "运行日志" };

export function AndroidApp() {
  useEffect(syncAndroidInsets, []);
  const { resolvedTheme } = useTheme();
  useEffect(() => { void androidSystemApi.setTheme(resolvedTheme).catch(error => console.warn("同步系统栏主题失败", error)); }, [resolvedTheme]);
  const [page, setPage] = useState("dashboard");
  const [history, setHistory] = useState<string[]>(["dashboard"]);
  const [exit, setExit] = useState("");
  const [tabAnimation, setTabAnimation] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerOpenRef = useRef(drawerOpen);
  drawerOpenRef.current = drawerOpen;
  const { status, known, readError } = useCoreStatus();
  const mode = useCoreMode(known ? status.pid : undefined);
  const main = tabs.some(tab => tab.id === page);
  const selected = page === "profiles" ? "proxies" : main ? page : "settings";

  // 统一的页面跳转：压入历史栈
  const navigateTo = (target: string) => {
    if (target === page) return;
    setHistory(prev => {
      // 避免连续重复
      if (prev[prev.length - 1] === target) return prev;
      return [...prev, target];
    });
    setPage(target);
    setDrawerOpen(false);
  };

  // 统一的返回逻辑：兼顾顶栏返回和物理/手势返回键
  const handleBack = () => {
    if (drawerOpen) {
      setDrawerOpen(false);
      return true;
    }
    const expanded = document.querySelector<HTMLDetailsElement>(".mobile-content details[open]");
    if (expanded) {
      expanded.open = false;
      return true;
    }
    if (history.length > 1) {
      const nextHistory = [...history];
      nextHistory.pop(); // 弹出当前页
      const prevPage = nextHistory[nextHistory.length - 1];
      setHistory(nextHistory);
      setPage(prevPage);
      return true;
    }
    if (page !== "dashboard") {
      setPage("dashboard");
      setHistory(["dashboard"]);
      return true;
    }
    return false;
  };

  // 边缘手势滑动检测 (Edge Swipe: 从屏幕最左侧向右滑展开抽屉，抽屉展开时左滑关闭)
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let isEdgeSwipe = false;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      isEdgeSwipe = startX <= 32;
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.changedTouches.length !== 1) return;
      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;

      // 水平位移显著大于垂直位移，判定为水平滑动
      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 45) {
        if (isEdgeSwipe && deltaX > 45) {
          setDrawerOpen(true);
        } else if (drawerOpenRef.current && deltaX < -45) {
          setDrawerOpen(false);
        }
      }
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  useMobileBack(handleBack);
  useEffect(() => { const refresh = () => void getGeneralSettings().then(value => {
    setTabAnimation(value.tabAnimation !== false);
    setStoredConcurrency(Math.min(4, value.speedTestConcurrency ?? 2));
    setStoredHealthProbeConcurrency(Math.min(4, value.healthProbeConcurrency ?? 2));
  }).catch(() => {}); refresh(); window.addEventListener("netbox-settings-saved", refresh); return () => window.removeEventListener("netbox-settings-saved", refresh); }, []);
  useEffect(() => {
    window.dispatchEvent(new Event("netbox-core-status-changed"));
    if (known && !status.running) resetExitIpHealth();
  }, [status.running, known]);
  useEffect(() => {
    const navigate = (event: Event) => {
      const value = (event as CustomEvent).detail;
      const target = typeof value === "string" ? value : value?.tab;
      if (tabs.some(tab => tab.id === target) || titles[target]) navigateTo(target);
    };
    window.addEventListener("netbox-navigate-tab", navigate);
    window.addEventListener("procweaver-navigate-tab", navigate);
    return () => { window.removeEventListener("netbox-navigate-tab", navigate); window.removeEventListener("procweaver-navigate-tab", navigate); };
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (!status.running) { setExit(""); return; }
      void fetchProxies().then(value => {
        const group = value.groups.find(item => item.name === (mode.mode === "global" ? "GLOBAL" : "PROXY")) || value.groups.find(item => item.now);
        if (active) setExit(group?.now || "");
      }).catch(() => {});
    };
    refresh();
    window.addEventListener("netbox-route-changed", refresh);
    window.addEventListener("procweaver-profile-changed", refresh);
    return () => { active = false; window.removeEventListener("netbox-route-changed", refresh); window.removeEventListener("procweaver-profile-changed", refresh); };
  }, [status.running, mode.mode]);
  const exclusions = useExclusions();
  return <div className="android-layout mobile-app bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
    <header className="mobile-header">
      <div className="flex items-center gap-2 min-w-0">
        {!main ? (
          <button
            type="button"
            aria-label="返回"
            onClick={handleBack}
            className="mobile-icon-button cursor-pointer"
          >
            <ArrowLeft size={20} />
          </button>
        ) : (
          <button
            type="button"
            aria-label="打开侧栏导航"
            onClick={() => setDrawerOpen(true)}
            className="mobile-icon-button cursor-pointer text-slate-700 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
          >
            <Menu size={22} />
          </button>
        )}
        <div>
          <p className="text-[11px] tracking-[.14em] font-semibold text-indigo-600 dark:text-indigo-400">PROCWEAVER</p>
          <h1 className="text-lg font-bold">{titles[page] || tabs.find(tab => tab.id === page)?.label}</h1>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className={`mobile-status ${status.running ? "connected" : ""}`}>{!known ? "状态未知" : status.running ? "VPN 已连接" : "VPN 未连接"}</span>
      </div>
    </header>
    <main className={`mobile-content ${tabAnimation ? "mobile-page-enter" : ""}`} key={page}>
      {page === "dashboard" && <div className="mobile-page space-y-3.5">
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
                  className="flex items-center space-x-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300/80 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 dark:border-slate-700 transition shadow-xs cursor-pointer"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" />
                  <span>直连排除</span>
                </button>
              )}
            />
          }
        />
        {readError && <p role="alert" className="mobile-notice">{readError}</p>}

        {/* 首屏核心：当前出口节点与出口 IP 状态 / 待命就绪卡片 */}
        {status.running ? (
          <ActiveExitCard proxyPort={status.mixedPort} corePid={status.generation ?? status.pid} activeNodeName={exit} />
        ) : (
          <section className="mobile-card space-y-3 border-indigo-100 dark:border-indigo-950/60 bg-gradient-to-b from-white to-slate-50/50 dark:from-slate-900 dark:to-slate-950/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-slate-400 dark:bg-slate-600 ring-2 ring-slate-200 dark:ring-slate-800" />
                <h2 className="mobile-section-title mb-0">系统已就绪 · 待命中</h2>
              </div>
              <span className="text-[11px] px-2 py-0.5 rounded-md font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200/60 dark:border-indigo-800/40">
                离线就绪
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              节点、规则与订阅配置均支持离线编辑；轻触上方“连接 VPN”即可接管网络流量。
            </p>
            <div className="pt-1 flex items-center gap-2.5">
              <button
                type="button"
                className="flex-1 min-h-[42px] px-3 py-2 rounded-xl text-xs font-semibold bg-white dark:bg-slate-800/90 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:border-indigo-400 dark:hover:border-indigo-600 transition shadow-xs cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                onClick={() => navigateTo("proxies")}
              >
                <Radio size={14} className="text-indigo-500" />
                <span>节点池列表</span>
              </button>
              <button
                type="button"
                className="flex-1 min-h-[42px] px-3 py-2 rounded-xl text-xs font-semibold bg-white dark:bg-slate-800/90 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-600 transition shadow-xs cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                onClick={() => navigateTo("profiles")}
              >
                <FileText size={14} className="text-emerald-500" />
                <span>订阅管理</span>
              </button>
            </div>
          </section>
        )}

        {/* 代理模式选择 */}
        <section className="mobile-card">
          <h2 className="mobile-section-title">运行模式</h2>
          <div className="mobile-segments">
            {(["rule", "global", "direct"] as const).map(value => (
              <button
                key={value}
                type="button"
                aria-pressed={mode.mode === value}
                disabled={mode.busy || !status.running || !mode.mode}
                onClick={() => void mode.change(value)}
              >
                {value === "rule" ? "规则分流" : value === "global" ? "全局代理" : "全部直连"}
              </button>
            ))}
          </div>
          <p className="mobile-help">
            {!status.running ? "待机状态保留预设规则；连接 VPN 后生效并可实时无缝切换。" : mode.mode === "rule" ? "按应用、域名和 IP 规则选择出口。" : "应用独立出口仅在规则模式下生效。"}
          </p>
          {mode.error && <p role="alert" className="mobile-notice">{mode.error}</p>}
        </section>

        {/* 流量与速率（次级监控） */}
        {status.running && <MonitoredTrafficOverview />}

        {/* 底部快捷操作 */}
        <div className="mobile-quick-links">
          <button type="button" onClick={() => navigateTo("profiles")}><FileText size={18} className="text-emerald-500" /><span>订阅配置</span></button>
          <button type="button" onClick={() => navigateTo("connections")}><Activity size={18} className="text-cyan-500" /><span>连接记录</span></button>
          <button type="button" onClick={() => navigateTo("logs")}><ScrollText size={18} className="text-amber-500" /><span>运行日志</span></button>
          <button type="button" onClick={() => navigateTo("maintenance")}><Wrench size={18} className="text-indigo-500" /><span>规则与 GEO 更新</span></button>
        </div>
      </div>}
      {page === "proxies" && <LinesManagementView coreMode={mode.mode} />}
      {page === "profiles" && <div className="mobile-page"><AndroidProfilesView /></div>}
      {page === "routing" && <AndroidRoutingView coreMode={mode} running={status.running} />}
      {page === "settings" && <AndroidSettingsView onNavigate={navigateTo} />}
      {page === "maintenance" && <div className="mobile-page"><MaintenanceView /></div>}
      {page === "connections" && <div className="mobile-page"><ConnectionsView controllerPort={status.controllerPort} /></div>}
      {page === "logs" && <div className="mobile-page"><LogsView controllerPort={status.controllerPort} /></div>}
    </main>
    <nav className="mobile-bottom-nav" aria-label="主导航">
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          aria-current={selected === id ? "page" : undefined}
          onClick={() => navigateTo(id)}
        >
          <Icon size={21} />
          <span>{label}</span>
        </button>
      ))}
    </nav>

    {/* 移动端侧栏抽屉背景遮罩 */}
    <div
      className={`mobile-drawer-backdrop ${drawerOpen ? "open" : ""}`}
      onClick={() => setDrawerOpen(false)}
      aria-hidden="true"
    />

    {/* 侧栏抽屉主体 */}
    <aside className={`android-nav ${drawerOpen ? "open" : ""}`} aria-label="全局导航抽屉">
      {/* 抽屉头部 */}
      <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-black text-sm shadow-md shadow-indigo-500/20">
            P
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white leading-tight">ProcWeaver</h2>
            <span className="text-[10px] text-slate-400 font-medium">移动控制台</span>
          </div>
        </div>
        <button
          type="button"
          aria-label="关闭侧栏"
          onClick={() => setDrawerOpen(false)}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
        >
          <X size={18} />
        </button>
      </div>

      {/* 核心状态摘要卡片 */}
      <div className="p-3 mx-3 my-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800/80 text-xs space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-slate-500 dark:text-slate-400 text-[11px]">VPN 状态</span>
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${status.running ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400" : "bg-slate-200/80 dark:bg-slate-800 text-slate-500"}`}>
            {status.running ? "已连接" : "未连接"}
          </span>
        </div>
        {status.running && exit && (
          <div className="flex items-center justify-between text-[11px] pt-1 border-t border-slate-200/40 dark:border-slate-800/40">
            <span className="text-slate-500 dark:text-slate-400">当前出口</span>
            <span className="font-semibold text-slate-700 dark:text-slate-300 truncate max-w-[130px]">{exit}</span>
          </div>
        )}
      </div>

      {/* 快速模式切换 */}
      {status.running && mode.mode && (
        <div className="px-3 pb-2 space-y-1">
          <div className="text-[10px] font-bold text-slate-400 px-1 uppercase tracking-wider">运行模式</div>
          <div className="grid grid-cols-3 gap-1 bg-slate-100 dark:bg-slate-900 p-1 rounded-xl text-[11px]">
            {(["rule", "global", "direct"] as const).map(value => (
              <button
                key={value}
                type="button"
                aria-pressed={mode.mode === value}
                disabled={mode.busy}
                onClick={() => void mode.change(value)}
                className={`py-1.5 rounded-lg font-semibold transition text-center cursor-pointer ${
                  mode.mode === value
                    ? "bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs"
                    : "text-slate-600 dark:text-slate-400 hover:text-slate-900"
                }`}
              >
                {value === "rule" ? "规则" : value === "global" ? "全局" : "直连"}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 菜单列表 */}
      <div className="flex-1 px-3 space-y-1 overflow-y-auto">
        <div className="text-[10px] font-bold text-slate-400 px-3 py-1.5 uppercase tracking-wider">核心面板</div>
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => navigateTo(id)}
            className={`mobile-drawer-item ${selected === id && main ? "active" : ""}`}
          >
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}

        <div className="text-[10px] font-bold text-slate-400 px-3 pt-3 pb-1.5 uppercase tracking-wider">工具与记录</div>
        <button
          type="button"
          onClick={() => navigateTo("profiles")}
          className={`mobile-drawer-item ${page === "profiles" ? "active" : ""}`}
        >
          <FileText size={18} className="text-emerald-500" />
          <span>订阅配置</span>
        </button>
        <button
          type="button"
          onClick={() => navigateTo("connections")}
          className={`mobile-drawer-item ${page === "connections" ? "active" : ""}`}
        >
          <Activity size={18} className="text-cyan-500" />
          <span>连接记录</span>
        </button>
        <button
          type="button"
          onClick={() => navigateTo("logs")}
          className={`mobile-drawer-item ${page === "logs" ? "active" : ""}`}
        >
          <ScrollText size={18} className="text-amber-500" />
          <span>运行日志</span>
        </button>
        <button
          type="button"
          onClick={() => navigateTo("maintenance")}
          className={`mobile-drawer-item ${page === "maintenance" ? "active" : ""}`}
        >
          <Wrench size={18} className="text-indigo-500" />
          <span>规则与 GEO 更新</span>
        </button>
      </div>

      {/* 抽屉底部 */}
      <div className="p-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs text-slate-400">
        <span className="text-[11px]">夜间模式</span>
        <ThemeToggle compact={true} />
      </div>
    </aside>
  </div>;
}
