import { useEffect, useRef } from "react";
import type { BundleToolsState } from "../../services/bundleTools";
interface Actions {
  close(): void; confirm(): Promise<void>; retry(): Promise<void>; select(path: string): void; choose(): Promise<void>;
  change(action: "patch" | "create" | "restore", id?: string | null): Promise<void>;
}
export function BundleToolsDialog({ state, actions }: { state: BundleToolsState; actions: Actions }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (state.open && !dialog.current?.open) dialog.current?.showModal(); else if (!state.open) dialog.current?.close(); }, [state.open]);
  const button = "px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 text-xs disabled:opacity-40 disabled:cursor-not-allowed";
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); actions.close(); }} aria-labelledby="bundle-tools-title" className="w-[min(620px,calc(100vw-32px))] max-h-[85vh] overflow-y-auto rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 p-5 shadow-xl backdrop:bg-slate-950/40">
    <h2 id="bundle-tools-title" className="font-bold text-base">{state.title} · {state.kind === "launch" ? "应用接入" : "桌面快捷方式"}</h2>
    <p className="text-xs text-slate-500 dark:text-slate-400 my-3">沿用现有用户资料、登录状态和资料目录。业务包入口固定，节点切换后快捷方式继续使用该包的当前选择。</p>
    {state.message && <p role="status" className="text-sm my-3 break-words">{state.message}</p>}
    {state.error && <p role="alert" className="text-sm my-3 text-red-700 dark:text-red-300 break-words">{state.error}</p>}
    {!state.busy && !state.error && state.kind === "launch" && (state.outcome?.state === "launched" || state.outcome?.state === "reused") && <p className="text-xs text-slate-500 dark:text-slate-400">本次操作已完成，窗口将自动关闭；实际出口请查看连接记录。</p>}
    {state.outcome && <p className="text-xs my-3">本包入口：{state.outcome.entry} · 检测到 {state.outcome.processCount} 个主实例</p>}
    {state.kind === "shortcuts" && state.shortcuts && <div className="space-y-3 text-xs">
      <p className="break-all">实际桌面：{state.shortcuts.desktop}</p>
      <label className="block">选择现有快捷方式（保留其资料目录参数）
        <select aria-label="现有快捷方式" value={state.selected} disabled={state.busy} onChange={e => actions.select(e.target.value)} className="w-full mt-2 p-2 border rounded-lg bg-white dark:bg-slate-950 border-slate-300 dark:border-slate-600">
          <option value="">{state.shortcuts.candidates.length ? "请选择快捷方式" : "未找到指向该应用的桌面快捷方式"}</option>
          {state.shortcuts.candidates.map(item => <option key={item.path} value={item.path}>{item.label} · {item.path}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={state.busy || !state.selected} onClick={() => void actions.change("patch")}>接入所选快捷方式</button>
        <button className={button} disabled={state.busy || !state.shortcuts.executableFound} onClick={() => void actions.change("create")}>创建业务包快捷方式</button>
        <button className={button} disabled={state.busy} onClick={() => void actions.choose()}>选择主程序</button>
      </div>
      <p className="text-slate-500 dark:text-slate-400">接入前会在原位置备份完整快捷方式。未选择现有快捷方式时，新建图标使用应用默认资料。</p>
      {state.shortcuts.managed.map(item => <div key={item.id} className="p-3 border rounded-lg border-slate-200 dark:border-slate-700 space-y-2">
        <p className="break-all">{item.path}</p>
        <p>{item.verified ? "目标和启动参数已核验" : "当前文件与记录不一致，请检查"}</p>
        {item.backup && <><p className="break-all text-slate-500 dark:text-slate-400">完整备份：{item.backup}</p><button className={button} disabled={state.busy} onClick={() => void actions.change("restore", item.id)}>还原原快捷方式</button></>}
      </div>)}
    </div>}
    <div className="flex flex-wrap justify-end gap-2 mt-5">
      {state.kind === "launch" && state.error && <button className={button} disabled={state.busy} onClick={() => void actions.choose()}>选择主程序 / 快捷方式</button>}
      {state.kind === "launch" && state.error && state.request && <button className={button} disabled={state.busy} onClick={() => void actions.retry()}>重新检测并启动</button>}
      <button autoFocus className={button} disabled={state.busy} onClick={actions.close}>{state.outcome?.state === "restart_required" ? "暂不重启" : "关闭"}</button>
      {state.outcome?.state === "restart_required" && <button className={`${button} bg-indigo-600 text-white`} disabled={state.busy} onClick={() => void actions.confirm()}>已保存工作，正常关闭并重启</button>}
    </div>
  </dialog>;
}
