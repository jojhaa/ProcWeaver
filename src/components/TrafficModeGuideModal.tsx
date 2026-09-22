import React, { useState } from "react";
import { Zap, Bot, Shield, X, Check, HelpCircle } from "lucide-react";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (dontShowAgain: boolean) => void;
  currentMode?: string;
}

export const TrafficModeGuideModal: React.FC<Props> = ({
  isOpen,
  onClose,
  onConfirm,
  currentMode,
}) => {
  const [dontShowAgain, setDontShowAgain] = useState(true);

  if (!isOpen) return null;

  const MODES = [
    {
      id: "windivert",
      title: "极简轻量 (WinDivert)",
      badge: "开箱首选 · 0 虚拟网卡",
      desc: "零虚拟网卡 · 极低开销 · 系统零侵入",
      detail:
        "内核级进程与数据包过滤，国内流量与局域网完全零损耗直出，彻底杜绝虚拟网卡断网与 IT 审计报警。最适合日常普通办公与网页浏览。",
      icon: <Zap className="w-4 h-4 text-amber-500" />,
      tagColor: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    },
    {
      id: "smart_hybrid",
      title: "智能双模式 (Auto-Hybrid)",
      badge: "智能感知 · 极客推荐",
      desc: "平时 0 网卡巡航 · 遇游戏自动升维 TUN",
      detail:
        "平时保持 WinDivert 轻量冰凉；一旦检测到启动 Steam、Apex、外服联机网游，毫秒级无感唤醒 TUN 虚拟网卡接管，游戏退出后平滑归位。",
      icon: <Bot className="w-4 h-4 text-indigo-500" />,
      tagColor: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20",
    },
    {
      id: "tun",
      title: "全局网卡 (TUN 虚拟网卡)",
      badge: "全协议接管 · 兜底保障",
      desc: "Wintun 底层全协议接管 · 游戏与开发兜底",
      detail:
        "全系统所有 TCP、UDP 与 ICMP 流量及系统 DNS 强力接管走虚拟网卡，适合极复杂企业网络环境或特殊外服联机需求。",
      icon: <Shield className="w-4 h-4 text-blue-500" />,
      tagColor: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl p-5 space-y-4">
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
          <div className="flex items-center space-x-2">
            <div className="p-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400">
              <HelpCircle className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                应用分流模式与驱动特性说明
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                开启进程分流后，系统将依据您所选模式对软件与业务进行底层调度：
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 三种模式特性卡片 */}
        <div className="space-y-2.5 max-h-[60vh] overflow-y-auto pr-1">
          {MODES.map((item) => {
            const isHighlight = currentMode === item.id;
            return (
              <div
                key={item.id}
                className={`p-3.5 rounded-xl border transition ${
                  isHighlight
                    ? "bg-indigo-50/40 dark:bg-indigo-950/30 border-indigo-300 dark:border-indigo-500/40 shadow-xs"
                    : "bg-slate-50/80 dark:bg-slate-950/50 border-slate-200/80 dark:border-slate-800/80"
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center space-x-2">
                    {item.icon}
                    <h4 className="text-xs font-bold text-slate-900 dark:text-white">
                      {item.title}
                    </h4>
                  </div>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-md border font-mono ${item.tagColor}`}
                  >
                    {item.badge}
                  </span>
                </div>
                <p className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                  {item.desc}
                </p>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                  {item.detail}
                </p>
              </div>
            );
          })}
        </div>

        {/* 底部交互 */}
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <label className="flex items-center space-x-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
            />
            <span>下次切换时不再自动提示</span>
          </label>

          <button
            type="button"
            onClick={() => onConfirm(dontShowAgain)}
            className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow-xs cursor-pointer flex items-center space-x-1"
          >
            <Check className="w-3.5 h-3.5" />
            <span>我知道了</span>
          </button>
        </div>
      </div>
    </div>
  );
};
