import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check, LayoutGrid, Package, RefreshCw } from "lucide-react";
import type { FunctionMode } from "../../types/functionMode";
import type { FunctionModeState } from "../../services/functionModeController";

const labels: Record<FunctionMode, string> = { full: "完整功能", process_proxy: "进程代理功能" };

const MODE_ITEMS: {
  id: FunctionMode;
  title: string;
  sub: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "full",
    title: "完整功能",
    sub: "全功能面板 · 节点订阅与核心管理",
    icon: <LayoutGrid className="w-3.5 h-3.5 text-indigo-500" />,
  },
  {
    id: "process_proxy",
    title: "进程代理功能",
    sub: "轻量独立 · 专注进程与业务包分流",
    icon: <Package className="w-3.5 h-3.5 text-emerald-500" />,
  },
];

export function FunctionModeSelector({
  mode,
  disabled,
  onChange,
}: {
  mode: FunctionMode;
  disabled?: boolean;
  onChange: (mode: FunctionMode) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const updatePos = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + 6,
        right: window.innerWidth - rect.right,
      });
    }
  };

  const handleToggle = () => {
    if (!isOpen) {
      updatePos();
    }
    setIsOpen((prev) => !prev);
  };

  useEffect(() => {
    if (!isOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        buttonRef.current && !buttonRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    const handleWindowChange = () => {
      updatePos();
    };
    document.addEventListener("mousedown", handleOutsideClick);
    window.addEventListener("resize", handleWindowChange);
    window.addEventListener("scroll", handleWindowChange, true);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      window.removeEventListener("resize", handleWindowChange);
      window.removeEventListener("scroll", handleWindowChange, true);
    };
  }, [isOpen]);

  const currentItem = MODE_ITEMS.find((item) => item.id === mode) || MODE_ITEMS[0];

  return (
    <div className="relative inline-flex items-center" data-no-drag>
      <span className="text-xs text-slate-500 dark:text-slate-400 mr-2 shrink-0 hidden sm:inline select-none">
        功能模式
      </span>

      {/* 触发下拉胶囊按钮 */}
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={handleToggle}
        className="h-8 px-2.5 rounded-xl bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-750 border border-slate-200/90 dark:border-slate-700/80 text-slate-800 dark:text-slate-200 font-medium text-xs flex items-center space-x-1.5 transition shadow-2xs cursor-pointer select-none disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <span className="shrink-0">{currentItem.icon}</span>
        <span className="font-bold text-slate-900 dark:text-slate-100">{currentItem.title}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 shrink-0 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* 通过 Portal 挂载到 body 的全局顶层浮层卡片，绝对杜绝被下方内容遮挡 */}
      {isOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{ top: `${dropdownPos.top}px`, right: `${dropdownPos.right}px` }}
            className="fixed z-[9999] w-64 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl p-1.5 text-xs space-y-1 animate-in fade-in zoom-in-95 duration-100 font-sans"
            data-no-drag
          >
            <div className="px-2.5 py-1.5 text-[10px] text-slate-400 font-semibold uppercase tracking-wider border-b border-slate-100 dark:border-slate-800/80">
              切换工作模式
            </div>
            {MODE_ITEMS.map((item) => {
              const isSelected = item.id === mode;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    if (item.id !== mode) {
                      onChange(item.id);
                    }
                  }}
                  className={`w-full p-2 rounded-xl text-left transition cursor-pointer select-none flex items-start space-x-2.5 ${
                    isSelected
                      ? "bg-indigo-50/80 dark:bg-indigo-950/50 text-indigo-900 dark:text-indigo-200 font-bold border border-indigo-200/60 dark:border-indigo-800/60 shadow-2xs"
                      : "hover:bg-slate-100/80 dark:hover:bg-slate-800/70 text-slate-700 dark:text-slate-300 border border-transparent"
                  }`}
                >
                  <div className="mt-0.5 shrink-0">{item.icon}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs">{item.title}</span>
                      {isSelected && <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />}
                    </div>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 font-normal mt-0.5 leading-tight">
                      {item.sub}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}

export function FunctionModeConfirmation({
  state,
  onCancel,
  onConfirm,
}: {
  state: FunctionModeState;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const pending = useRef(state.pending);
  pending.current = state.pending;

  useEffect(() => {
    if (!state.requested) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!pending.current) cancel.current();
      }
      if (e.key !== "Tab") return;
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || [])];
      if (!items.length) {
        e.preventDefault();
        return;
      }
      if (e.shiftKey && (document.activeElement === items[0] || document.activeElement === ref.current)) {
        e.preventDefault();
        items.at(-1)?.focus();
      } else if (!e.shiftKey && (document.activeElement === items.at(-1) || document.activeElement === ref.current)) {
        e.preventDefault();
        items[0].focus();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [state.requested]);

  if (!state.requested) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-in fade-in duration-150 font-sans"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !state.pending) onCancel();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="function-mode-title"
        aria-describedby="function-mode-impact"
        tabIndex={-1}
        className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 p-6 shadow-2xl outline-none space-y-4"
      >
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-100 dark:border-indigo-900/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0">
            {state.requested === "full" ? <LayoutGrid className="w-5 h-5" /> : <Package className="w-5 h-5" />}
          </div>
          <div>
            <h2 id="function-mode-title" className="text-base font-bold text-slate-900 dark:text-white">
              切换为{labels[state.requested]}
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {state.requested === "full" ? "恢复全功能代理核心与完整面板" : "切换为轻量独立进程代理"}
            </p>
          </div>
        </div>

        <div
          id="function-mode-impact"
          className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800 text-xs leading-relaxed text-slate-600 dark:text-slate-300"
        >
          {state.requested === "process_proxy"
            ? "将停止本程序的代理核心及其接管，恢复本程序设置的系统代理和 DNS。核心现有连接可能断开；独立外部代理继续运行。节点、订阅和业务包绑定保留。"
            : "将停止独立 WinDivert 及其转发连接，恢复完整功能界面和相关后台任务；应用代理入口继续运行。核心保持停止，您可以在运行概览中主动启动；原有配置保留。"}
        </div>

        {state.error && (
          <p role="alert" className="p-2.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 text-xs text-red-600 dark:text-red-400 break-words">
            {state.error}
          </p>
        )}

        {state.pending && (
          <p role="status" className="text-xs text-indigo-600 dark:text-indigo-400 flex items-center space-x-2 font-medium">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            <span>正在平滑切换工作模式，请稍候…</span>
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <button
            type="button"
            disabled={state.pending}
            onClick={onCancel}
            className="px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-750 text-slate-700 dark:text-slate-300 text-xs font-medium transition cursor-pointer disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={state.pending}
            onClick={onConfirm}
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition shadow-xs cursor-pointer disabled:opacity-50 flex items-center space-x-1"
          >
            {state.pending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            <span>{state.pending ? "切换中…" : "确认切换"}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
