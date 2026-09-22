import React, { useState, useEffect } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { windowMinimize, windowToggleMaximize, windowIsMaximized, windowClose } from "../api";

export const WindowControls: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    // 初始化时检测窗口是否已最大化
    windowIsMaximized().then(setIsMaximized).catch(() => {});

    const handleResize = () => {
      windowIsMaximized().then(setIsMaximized).catch(() => {});
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handleMinimize = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await windowMinimize();
    } catch (err) {
      console.error("最小化窗口失败:", err);
    }
  };

  const handleToggleMaximize = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const nextMax = await windowToggleMaximize();
      setIsMaximized(nextMax);
    } catch (err) {
      console.error("切换窗口最大化失败:", err);
    }
  };

  const handleClose = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await windowClose();
    } catch (err) {
      console.error("关闭窗口失败:", err);
    }
  };

  return (
    <div className="flex items-center space-x-1 select-none" data-tauri-drag-region="false">
      {/* 最小化 */}
      <button
        type="button"
        onClick={handleMinimize}
        title="最小化"
        className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-200/80 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800/80 transition-colors"
      >
        <Minus className="w-3.5 h-3.5 stroke-[2]" />
      </button>

      {/* 最大化 / 还原 */}
      <button
        type="button"
        onClick={handleToggleMaximize}
        title={isMaximized ? "向下还原" : "最大化"}
        className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-200/80 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800/80 transition-colors"
      >
        {isMaximized ? (
          <Copy className="w-3.5 h-3.5 stroke-[2] rotate-90" />
        ) : (
          <Square className="w-3 h-3 stroke-[2]" />
        )}
      </button>

      {/* 关闭 (悬停变红) */}
      <button
        type="button"
        onClick={handleClose}
        title="关闭"
        className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-white hover:bg-rose-500 dark:text-slate-400 dark:hover:text-white dark:hover:bg-rose-600 transition-colors"
      >
        <X className="w-4 h-4 stroke-[2]" />
      </button>
    </div>
  );
};
