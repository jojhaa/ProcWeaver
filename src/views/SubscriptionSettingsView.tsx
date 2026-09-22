import React, { useState, useEffect } from "react";
import { ProfilesView } from "./ProfilesView";
import { SettingsView } from "./SettingsView";
import { FileText, Sliders, ShieldCheck } from "lucide-react";

interface Props {
  initialTab?: "profiles" | "settings";
}

export const SubscriptionSettingsView: React.FC<Props> = ({ initialTab = "profiles" }) => {
  const [activeTab, setActiveTab] = useState<"profiles" | "settings">(initialTab);

  useEffect(() => {
    const handleNavigate = (e: any) => {
      if (e.detail === "profiles") {
        setActiveTab("profiles");
      } else if (e.detail === "settings") {
        setActiveTab("settings");
      }
    };
    window.addEventListener("procweaver-navigate-tab", handleNavigate);
    window.addEventListener("netbox-navigate-tab", handleNavigate);
    return () => {
      window.removeEventListener("procweaver-navigate-tab", handleNavigate);
      window.removeEventListener("netbox-navigate-tab", handleNavigate);
    };
  }, []);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-slate-50 dark:bg-slate-950 transition-colors duration-200">
      {/* 顶部二级 Tab 切换栏 */}
      <div className="px-6 pt-3.5 border-b border-slate-200/90 dark:border-slate-800/80 flex items-center justify-between shrink-0 bg-white/70 dark:bg-slate-900/40 backdrop-blur-md">
        <div className="flex items-center space-x-1.5">
          {/* Tab 1: 节点订阅管理 */}
          <button
            onClick={() => setActiveTab("profiles")}
            className={`flex items-center space-x-2 px-4 py-2.5 rounded-t-xl text-xs font-bold border-b-2 transition ${
              activeTab === "profiles"
                ? "border-indigo-600 text-indigo-600 bg-indigo-50/60 dark:bg-indigo-600/15 dark:text-indigo-400 dark:border-indigo-500 shadow-2xs"
                : "border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/40"
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>节点订阅配置</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300 font-mono">
              链接/YAML/二维码
            </span>
          </button>

          {/* Tab 2: 系统偏好与驱动设置 */}
          <button
            onClick={() => setActiveTab("settings")}
            className={`flex items-center space-x-2 px-4 py-2.5 rounded-t-xl text-xs font-bold border-b-2 transition ${
              activeTab === "settings"
                ? "border-indigo-600 text-indigo-600 bg-indigo-50/60 dark:bg-indigo-600/15 dark:text-indigo-400 dark:border-indigo-500 shadow-2xs"
                : "border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/40"
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>系统与偏好设置</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300 font-mono">
              TUN/开机自启/Geo
            </span>
          </button>
        </div>

        <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-400 font-medium">
          <ShieldCheck className="w-3.5 h-3.5 text-indigo-500" />
          <span>一站式底层与环境配置</span>
        </div>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-hidden relative">
        <div className={`h-full overflow-y-auto p-6 md:p-8 ${activeTab === "profiles" ? "block" : "hidden"}`}>
          <div className="max-w-5xl mx-auto space-y-6">
            <ProfilesView />
          </div>
        </div>
        <div className={`h-full overflow-y-auto p-6 md:p-8 ${activeTab === "settings" ? "block" : "hidden"}`}>
          <div className="max-w-5xl mx-auto space-y-6">
            <SettingsView />
          </div>
        </div>
      </div>
    </div>
  );
};
