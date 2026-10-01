import type { ReactNode } from "react";
import { Package, Radio, Activity, Settings, Wrench } from "lucide-react";
import { useBundleRuntime } from "../hooks/useBusinessBundles";
import { useBundleTools } from "../hooks/useBundleTools";
import { useExternalProxyEditor } from "../hooks/useExternalProxyEditor";
import { useProcessWorkspace, type ProcessTab } from "../hooks/useProcessWorkspace";
import { BusinessBundleView } from "./BusinessBundleView";
import { ExternalProxyDialog } from "../components/business-bundle/ExternalProxyDialog";
import { BundleToolsDialog } from "../components/business-bundle/BundleToolsDialog";
import { ProcessAccessBar, ProcessDiagnostics, ProcessSettings } from "../components/function-mode/ProcessWorkspacePanels";
import { ThemeToggle } from "../components/ThemeToggle";
import { WindowControls } from "../components/WindowControls";
import type { FunctionModeView } from "../types/functionMode";
import { windowStartDragging, windowToggleMaximize } from "../api";
import appIcon from "../assets/app-icon.png";

export function ProcessProxyView({
  modeControl,
  capability,
  onFull,
  standalone = false,
  maintenance,
}: {
  modeControl?: ReactNode;
  capability: FunctionModeView;
  onFull?: () => void;
  standalone?: boolean;
  maintenance: ReactNode;
}) {
  useBundleRuntime();
  const tools = useBundleTools();
  const state = useProcessWorkspace();
  const editor = useExternalProxyEditor(state.tab === "external", null, () => {});

  const tabs: { id: ProcessTab; label: string; icon: React.ReactNode; badge?: string }[] = [
    { id: "bundles", label: "业务包", icon: <Package className="w-3.5 h-3.5" /> },
    { id: "external", label: "外部代理", icon: <Radio className="w-3.5 h-3.5" /> },
    { id: "diagnostics", label: "连接与诊断", icon: <Activity className="w-3.5 h-3.5" /> },
    { id: "settings", label: "偏好设置", icon: <Settings className="w-3.5 h-3.5" /> },
    { id: "maintenance", label: "版本维护", icon: <Wrench className="w-3.5 h-3.5" />, badge: "更新" },
  ];

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-800 font-sans">
      {/* 顶部标题与导航栏 */}
      <header className="relative shrink-0 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800/80 z-50 shadow-2xs">
        {/* 顶部标题栏与窗口控制 */}
        <div
          className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5 border-b border-slate-100 dark:border-slate-800/60"
          onMouseDown={(event) => {
            if (event.button !== 0 || (event.target as HTMLElement).closest("button,select,input,a,label,[data-no-drag]")) return;
            if (event.detail === 2) void windowToggleMaximize();
            else void windowStartDragging();
          }}
        >
          {/* 左侧 Logo 与模式徽标 */}
          <div className="flex items-center gap-2.5 select-none">
            <img src={appIcon} alt="" className="h-7 w-7 drop-shadow-xs" draggable={false} />
            <div className="flex items-center space-x-2">
              <span className="font-bold text-sm tracking-tight text-slate-900 dark:text-white">{standalone ? "ProcWeaver Process" : "ProcWeaver"}</span>
              <span className="px-1.5 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 font-mono text-[10px] font-semibold border border-indigo-200/60 dark:border-indigo-800/60">
                {standalone ? "独立进程版" : "进程代理功能"}
              </span>
            </div>
          </div>

          {/* 右侧：模式切换下拉 + 主题切换 + 窗口控制 */}
          <div className="flex items-center gap-2">
            {modeControl}
            <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 hidden sm:block mx-1" />
            <ThemeToggle compact />
            <WindowControls />
          </div>
        </div>

        {/* 导航 Tab 栏 */}
        <nav aria-label="进程代理导航" className="px-4 flex gap-1.5 overflow-x-auto pt-1 pb-1">
          {tabs.map((tab) => {
            const isActive = state.tab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                aria-current={isActive ? "page" : undefined}
                onClick={() => state.actions.setTab(tab.id)}
                className={`shrink-0 px-3.5 py-1.5 text-xs rounded-xl font-medium transition flex items-center space-x-1.5 cursor-pointer select-none border ${
                  isActive
                    ? "bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 font-bold border-indigo-200 dark:border-indigo-800/80 shadow-2xs"
                    : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 border-transparent"
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {tab.badge && (
                  <span className={`text-[9px] px-1 py-0.2 rounded-full font-mono ${
                    isActive ? "bg-indigo-200/70 dark:bg-indigo-800/80 text-indigo-800 dark:text-indigo-200 font-bold" : "bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                  }`}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </header>

      {/* 进程代理控制栏 (仅在业务包 Tab 或诊断 Tab 展示) */}
      {state.tab === "bundles" && (
        <ProcessAccessBar state={state} capability={capability} onFull={onFull} />
      )}

      {/* 主体视图区域 */}
      <main className="flex-1 min-h-0 overflow-auto relative z-0">
        {state.tab === "bundles" && <BusinessBundleView mode={null} processOnly />}
        {state.tab === "external" && <ExternalProxyDialog inline open state={editor} onClose={() => {}} />}
        {state.tab === "diagnostics" && <ProcessDiagnostics state={state} />}
        {state.tab === "settings" && (
          <ProcessSettings
            state={state}
            standalone={standalone}
            onOpenMaintenance={() => state.actions.setTab("maintenance")}
          />
        )}
        {state.tab === "maintenance" && (
          <div className="h-full overflow-y-auto p-5 sm:p-8">
            <div className="max-w-5xl mx-auto space-y-6">
              {maintenance}
            </div>
          </div>
        )}
      </main>

      <BundleToolsDialog {...tools} />
    </div>
  );
}
