import React from "react";
import { X } from "lucide-react";
import { DnsEnhancedMode } from "../api/dns";

interface DnsModeModalProps {
  isOpen: boolean;
  currentMode: DnsEnhancedMode;
  onSelect: (mode: DnsEnhancedMode) => void;
  onClose: () => void;
}

interface ModeOption {
  key: DnsEnhancedMode;
  title: string;
  description: string;
  badge?: string;
}

const MODES: ModeOption[] = [
  {
    key: "normal",
    title: "normal",
    description: "标准传统解析模式，不创建假 IP，解析后直连公网目标，兼容性最高。",
  },
  {
    key: "fake-ip",
    title: "fakeIp",
    badge: "默认推荐",
    description: "虚拟 Fake-IP 模式，本地 0ms 极速秒开网页，杜绝本地 DNS 投毒与泄露。",
  },
  {
    key: "redir-host",
    title: "redirHost",
    description: "公网真实 IP 重定向，内核逆向查找域名，ping 可见真实公网 IP。",
  },
  {
    key: "hosts",
    title: "hosts",
    description: "纯静态 hosts 映射模式，仅匹配本地配置与系统 hosts，超出则走直连。",
  },
];

export const DnsModeModal: React.FC<DnsModeModalProps> = ({
  isOpen,
  currentMode,
  onSelect,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <h3 className="text-base font-bold text-slate-900 dark:text-white">
            DNS模式
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 选项列表 */}
        <div className="p-3 space-y-1.5">
          {MODES.map((option) => {
            const isSelected = currentMode === option.key;
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => {
                  onSelect(option.key);
                  onClose();
                }}
                className={`w-full p-3 rounded-xl text-left transition flex items-start space-x-3 cursor-pointer ${
                  isSelected
                    ? "bg-indigo-50/80 dark:bg-indigo-600/15 border border-indigo-500/80 text-indigo-900 dark:text-indigo-200 ring-1 ring-indigo-500/50"
                    : "hover:bg-slate-50 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300 border border-transparent"
                }`}
              >
                {/* 自定义 Radio 圆圈 */}
                <div className="pt-0.5 shrink-0">
                  <div
                    className={`w-4 h-4 rounded-full border flex items-center justify-center transition ${
                      isSelected
                        ? "border-indigo-600 dark:border-indigo-400 bg-indigo-600 dark:bg-indigo-500"
                        : "border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800"
                    }`}
                  >
                    {isSelected && (
                      <div className="w-1.5 h-1.5 rounded-full bg-white" />
                    )}
                  </div>
                </div>

                {/* 文本内容 */}
                <div className="flex-1">
                  <div className="flex items-center space-x-2">
                    <span className="font-semibold text-sm text-slate-900 dark:text-white font-mono">
                      {option.title}
                    </span>
                    {option.badge && (
                      <span className="text-[10px] px-1.5 py-0.2 rounded font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                        {option.badge}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                    {option.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>

        {/* 底部按钮 */}
        <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl text-xs font-semibold bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
};
