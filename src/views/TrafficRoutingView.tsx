import React, { useState } from "react";
import { RulesView } from "./RulesView";
import { BusinessBundleView } from "./BusinessBundleView";
import { Layers, Sparkles, Package } from "lucide-react";
import { useBusinessBundles } from "../hooks/useBusinessBundles";

interface Props {
  mode: string | null;
  coreMode?: any;
}

const STORAGE_KEY = "netbox_routing_active_tab";

export const TrafficRoutingView: React.FC<Props> = ({ mode, coreMode }) => {
  const routingState = useBusinessBundles();
  const isProcessEnabled = Boolean(routingState.view && routingState.view.config.bundlesEnabled !== false);

  const [activeTab, setActiveTab] = useState<"rules" | "apps">(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "rules" || saved === "apps") return saved;
    } catch {}
    return "apps";
  });

  const handleTabChange = (tab: "rules" | "apps") => {
    setActiveTab(tab);
    try {
      localStorage.setItem(STORAGE_KEY, tab);
    } catch {}
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-slate-50 dark:bg-slate-950 transition-colors duration-200">
      {/* 顶部清晰的双 Tab 导航条 (业务规则包放前面) */}
      <div className="px-6 py-2.5 border-b border-slate-200/80 dark:border-slate-800/80 bg-white/80 dark:bg-slate-900/60 backdrop-blur-md flex flex-wrap items-center justify-between gap-3 shrink-0 z-10 select-none">
        <div className="flex items-center space-x-1.5 p-1 rounded-xl bg-slate-100/90 dark:bg-slate-950/80 border border-slate-200/80 dark:border-slate-800/80 shadow-inner">
          {/* Tab 1: 业务规则包分流 (Bundles) */}
          <button
            type="button"
            onClick={() => handleTabChange("apps")}
            className={`flex items-center space-x-2 px-4 py-2 rounded-lg text-xs font-bold transition cursor-pointer ${
              activeTab === "apps"
                ? "bg-white dark:bg-indigo-600 text-indigo-600 dark:text-white shadow-sm shadow-black/5"
                : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
            }`}
          >
            <Package className={`w-4 h-4 ${activeTab === "apps" ? "text-indigo-600 dark:text-white" : "text-slate-400"}`} />
            <span>📦 业务规则包分流 (Bundles)</span>
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-medium ${
                isProcessEnabled
                  ? activeTab === "apps"
                    ? "bg-emerald-500/20 text-emerald-800 dark:text-emerald-200 font-bold"
                    : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-bold"
                  : "bg-slate-200/80 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
              }`}
            >
              {routingState.masterPending ? "切换中" : !routingState.view ? "待确认" : isProcessEnabled ? "● 已启用" : "○ 已暂停"}
            </span>
          </button>

          {/* Tab 2: 核心分流规则 (Rules) */}
          <button
            type="button"
            onClick={() => handleTabChange("rules")}
            className={`flex items-center space-x-2 px-4 py-2 rounded-lg text-xs font-bold transition cursor-pointer ${
              activeTab === "rules"
                ? "bg-white dark:bg-indigo-600 text-indigo-600 dark:text-white shadow-sm shadow-black/5"
                : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
            }`}
          >
            <Layers className={`w-4 h-4 ${activeTab === "rules" ? "text-indigo-600 dark:text-white" : "text-slate-400"}`} />
            <span>📑 核心分流规则 (Rules)</span>
            <span
              className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-medium ${
                activeTab === "rules"
                  ? "bg-indigo-50 text-indigo-700 dark:bg-white/20 dark:text-white"
                  : "bg-slate-200/80 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
              }`}
            >
              检索 · 沙盒
            </span>
          </button>
        </div>

        {/* 右侧微型状态指示说明 */}
        <div className="hidden md:flex items-center space-x-2 text-[11px] text-slate-500 dark:text-slate-400">
          <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
          <span>
            {activeTab === "rules"
              ? "支持关键词实时检索与输入网址 1 秒测路沙盒高亮"
              : "支持 ChatGPT、Antigravity、Cursor 业务套件强锁与纯净脱敏规则包"}
          </span>
        </div>
      </div>

      {/* 视图内容容器 */}
      <div className="flex-1 overflow-hidden relative">
        {activeTab === "rules" ? (
          <div className="h-full overflow-y-auto p-6 md:p-8">
            <div className="max-w-6xl mx-auto">
              <RulesView coreMode={coreMode} />
            </div>
          </div>
        ) : (
          <BusinessBundleView mode={mode} />
        )}
      </div>
    </div>
  );
};
