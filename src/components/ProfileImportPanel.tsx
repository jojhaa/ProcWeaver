import { createPortal } from "react-dom";
import { FileCode, AlertCircle, Check, X, Loader2 } from "lucide-react";
import type { useProfileImport } from "../hooks/useProfileImport";

export function ProfileImportPanel({
  mobile,
  state,
}: {
  mobile: boolean;
  state: ReturnType<typeof useProfileImport>;
}) {
  return (
    <>
      {/* 导入状态反馈提示条 */}
      {Boolean(state.message) && (
        <div
          role="status"
          className="p-3.5 rounded-2xl bg-indigo-50/90 dark:bg-indigo-950/40 border border-indigo-200/80 dark:border-indigo-800/60 text-indigo-700 dark:text-indigo-300 text-xs flex items-center justify-between gap-3 shadow-2xs animate-in fade-in"
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 shrink-0 text-indigo-500" />
            <span className="truncate">{state.message}</span>
          </div>
          <button
            type="button"
            onClick={state.dismissMessage}
            aria-label="关闭导入提示"
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 待导入内容确认模态框 (通过 Portal 挂载到 body) */}
      {Boolean(state.content) &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="导入配置确认"
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center p-4 animate-in fade-in duration-150"
          >
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 w-full max-w-lg shadow-2xl space-y-4 animate-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                    <FileCode className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">
                      导入配置确认
                    </h3>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      检查配置名称与内容，确认后将保存并加入订阅列表
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={state.busy}
                  onClick={() => state.setContent("")}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-3.5 text-xs">
                <div>
                  <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">
                    配置名称
                  </label>
                  <input
                    type="text"
                    disabled={state.busy}
                    value={state.name}
                    onChange={(e) => state.setName(e.target.value)}
                    maxLength={240}
                    placeholder="请输入配置名称"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:border-indigo-500"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-slate-700 dark:text-slate-300 font-semibold">
                      待导入内容预览
                    </label>
                    <span className="text-[10px] text-slate-400">
                      {state.content.length} 字符
                    </span>
                  </div>
                  <textarea
                    aria-label="待导入内容"
                    rows={6}
                    disabled={state.busy}
                    value={state.content}
                    onChange={(e) => state.setContent(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-xl bg-slate-950 text-slate-200 font-mono text-[11px] border border-slate-800 focus:outline-hidden focus:border-indigo-500 resize-none leading-relaxed"
                  />
                </div>

                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400">
                  {mobile
                    ? "提示：首次导入会设为当前默认配置，不会自动启动 VPN；已有配置时不自动切换。"
                    : "提示：请确认配置来源。订阅链接将在确认后自动下载，导入 YAML 不会自动切换当前配置。"}
                </div>
              </div>

              <div className="flex items-center justify-end space-x-2.5 pt-3 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  disabled={state.busy}
                  onClick={() => state.setContent("")}
                  className="px-4 py-2 rounded-xl text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200 text-xs font-medium cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={state.busy || !state.name.trim()}
                  onClick={() => void state.confirm()}
                  className="flex items-center space-x-1.5 px-4.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/20 transition cursor-pointer disabled:opacity-50"
                >
                  {state.busy ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>正在导入...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>确认导入</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
