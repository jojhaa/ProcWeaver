import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Zap, Shield, RefreshCw, AlertCircle, Check } from "lucide-react";
import type { ProcessCaptureState } from "../../services/processCaptureController";
import type { ProcessAccessMode } from "../../types/functionMode";

type Props = {
  state: ProcessCaptureState;
  onRequest: (mode: ProcessAccessMode) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onRefresh: () => void;
};

const baseBtn =
  "rounded-xl px-3 py-1.5 text-xs font-medium transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-indigo-500";

export function ProcessCaptureControls({
  state,
  onRequest,
  onCancel,
  onConfirm,
  onRefresh,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const busy = useRef(state.pending);
  const cancel = useRef(onCancel);
  busy.current = state.pending;
  cancel.current = onCancel;

  useEffect(() => {
    if (!state.requested) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!busy.current) cancel.current();
      }
      if (event.key !== "Tab") return;
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || [])];
      if (!items.length) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && (document.activeElement === ref.current || document.activeElement === items[0])) {
        event.preventDefault();
        items.at(-1)?.focus();
      } else if (!event.shiftKey && (document.activeElement === ref.current || document.activeElement === items.at(-1))) {
        event.preventDefault();
        items[0].focus();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [state.requested]);

  const mode = state.view?.mode;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {/* 接入方式分段控制器 */}
        <div className="flex items-center space-x-1.5">
          <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 shrink-0">
            接入方式:
          </span>
          <div className="inline-flex p-0.5 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700/80 shadow-2xs">
            <button
              type="button"
              aria-pressed={mode === "app_proxy"}
              disabled={state.pending || !state.view}
              onClick={() => onRequest("app_proxy")}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition cursor-pointer flex items-center space-x-1 select-none ${
                mode === "app_proxy"
                  ? "bg-white dark:bg-slate-900 text-amber-600 dark:text-amber-400 font-bold shadow-2xs"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              }`}
            >
              <Zap className="w-3 h-3 text-amber-500" />
              <span>纯应用层</span>
            </button>
            <button
              type="button"
              aria-pressed={mode === "windivert"}
              disabled={state.pending || !state.view || !state.view.supported}
              onClick={() => onRequest("windivert")}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition cursor-pointer flex items-center space-x-1 select-none ${
                mode === "windivert"
                  ? "bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 font-bold shadow-2xs"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              }`}
            >
              <Shield className="w-3 h-3 text-indigo-500" />
              <span>WinDivert 驱动</span>
            </button>
          </div>
        </div>

        {/* 状态徽标指示 */}
        <div className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200/60 dark:border-slate-700/60 text-[11px] text-slate-600 dark:text-slate-300">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              state.pending
                ? "bg-amber-500 animate-pulse"
                : !state.view
                ? "bg-slate-400"
                : state.view.active
                ? "bg-emerald-500 ring-2 ring-emerald-500/20"
                : mode === "windivert"
                ? "bg-amber-500"
                : "bg-emerald-500"
            }`}
          />
          <span role="status" className="font-medium">
            {state.pending
              ? "正在切换…"
              : !state.view
              ? "读取状态中…"
              : state.view.active
              ? "驱动接管中"
              : mode === "windivert"
              ? "驱动未运行"
              : "应用代理就绪"}
          </span>
        </div>
      </div>

      {/* 错误提示 */}
      {(state.error || state.view?.error) && !state.requested && (
        <div
          role="alert"
          className="text-xs text-red-600 dark:text-red-400 flex items-center space-x-2 bg-red-50 dark:bg-red-950/40 p-2 rounded-xl border border-red-200 dark:border-red-900/60"
        >
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">{state.error || state.view?.error}</span>
          <button
            type="button"
            className={`${baseBtn} bg-white dark:bg-slate-900 border border-red-200 text-red-700 text-[11px] py-0.5 px-2`}
            onClick={onRefresh}
          >
            刷新
          </button>
        </div>
      )}

      {/* WinDivert 统计胶囊条 */}
      {state.view?.mode === "windivert" && (
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono text-slate-500 dark:text-slate-400 pt-0.5">
          <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700/60">
            TCP <strong>{state.view.tcp}</strong>
          </span>
          <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700/60">
            UDP <strong>{state.view.udp}</strong>
          </span>
          <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700/60">
            DNS <strong>{state.view.dns}</strong>
          </span>
          <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700/60">
            未识别 <strong>{state.view.unclassified}</strong>
          </span>
          {state.view.failures > 0 && (
            <span className="px-2 py-0.5 rounded-md bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/60">
              失败 <strong>{state.view.failures}</strong>
            </span>
          )}
          <span className="text-[10px] text-slate-400 ml-1 font-sans">
            (仅限已明确业务包新连接；UDP 域名由原生 DNS 识别)
          </span>
        </div>
      )}

      {/* 确认切换弹窗 */}
      {state.requested &&
        createPortal(
          <div
            className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-in fade-in duration-150"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget && !state.pending) onCancel();
            }}
          >
            <div
              ref={ref}
              role="dialog"
              aria-modal="true"
              aria-labelledby="capture-title"
              aria-describedby="capture-impact"
              tabIndex={-1}
              className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-800 p-6 outline-none shadow-2xl space-y-4"
            >
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-100 dark:border-indigo-900/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0">
                  {state.requested === "windivert" ? <Shield className="w-5 h-5" /> : <Zap className="w-5 h-5" />}
                </div>
                <div>
                  <h2 id="capture-title" className="text-base font-bold text-slate-900 dark:text-white">
                    {state.requested === "windivert" ? "启用独立 WinDivert 驱动" : "切换为纯应用层代理"}
                  </h2>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {state.requested === "windivert" ? "免虚拟网卡 · 进程级数据包拦截" : "系统零侵入 · 极轻量免提权"}
                  </p>
                </div>
              </div>

              <div id="capture-impact" className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800 text-xs leading-relaxed text-slate-600 dark:text-slate-300 space-y-1.5">
                <p>
                  {state.requested === "windivert"
                    ? "将解压并加载随包过滤驱动，按业务包进程直接转发至配置的外部代理，无需运行 Mihomo。需 Windows 管理员授权（UAC）；可能与反作弊等内核过滤驱动冲突；仅影响新发起的连接。"
                    : "将停止本程序的独立驱动接管，现有驱动转发的连接会断开。独立 HTTP/SOCKS5 入口继续运行，应用程序需通过代理参数或环境变量接入。"}
                </p>
              </div>

              {state.error && (
                <div role="alert" className="p-2.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 text-xs text-red-600 dark:text-red-300">
                  {state.error}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  className={`${baseBtn} bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300`}
                  disabled={state.pending}
                  onClick={onCancel}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={`${baseBtn} bg-indigo-600 hover:bg-indigo-700 text-white font-bold flex items-center space-x-1.5 shadow-xs`}
                  disabled={state.pending}
                  onClick={onConfirm}
                >
                  {state.pending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  <span>{state.pending ? "正在切换…" : "确认应用方式"}</span>
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
