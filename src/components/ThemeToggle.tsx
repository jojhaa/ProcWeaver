import React from "react";
import { Sun, Moon, Laptop } from "lucide-react";
import { useTheme, Theme } from "../context/ThemeContext";

export const ThemeToggle: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { theme, setTheme } = useTheme();

  const options: { key: Theme; label: string; icon: React.FC<{ className?: string }> }[] = [
    { key: "light", label: "明亮", icon: Sun },
    { key: "dark", label: "暗黑", icon: Moon },
    { key: "system", label: "跟随系统", icon: Laptop },
  ];

  return (
    <div className="flex items-center rounded-xl bg-slate-200/80 dark:bg-slate-800/80 p-0.5 border border-slate-300/80 dark:border-slate-700/60 shadow-inner">
      {options.map((opt) => {
        const Icon = opt.icon;
        const isActive = theme === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            onClick={() => setTheme(opt.key)}
            title={`切换为${opt.label}模式`}
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
              isActive
                ? "bg-white text-indigo-600 shadow-sm dark:bg-indigo-600 dark:text-white"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {!compact && <span>{opt.label}</span>}
          </button>
        );
      })}
    </div>
  );
};
