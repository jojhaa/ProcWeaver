import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ProfileSwitchState } from "../hooks/useProfileSwitch";
export function ProfileSwitchDialog({ state, actions }: {
  state: ProfileSwitchState; actions: { choose(mode: "keep" | "hold"): Promise<void>; cancel(): void };
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (state.preview && !dialog.current?.open) dialog.current?.showModal();
    if (!state.preview) dialog.current?.close();
  }, [state.preview]);
  const button = "px-3 py-2 rounded-lg border text-xs disabled:opacity-40 disabled:cursor-not-allowed border-slate-300 dark:border-slate-600";
  return createPortal(<dialog ref={dialog} aria-labelledby="profile-switch-title" onCancel={event => { event.preventDefault(); actions.cancel(); }}
    className="w-[min(620px,calc(100vw-32px))] max-h-[85vh] overflow-y-auto rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 p-5 shadow-xl backdrop:bg-slate-950/40">
    <h2 id="profile-switch-title" className="text-base font-bold">切换订阅 · 已绑定出口</h2>
    {state.preview && <>
      <p className="mt-3 text-sm break-words">即将切换到「{state.preview.profileName}」。以下分流出口来自其他订阅，请选择处理方式。</p>
      <ul className="my-4 max-h-40 overflow-auto space-y-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-950 p-3">
        {state.preview.affected.map(({ target, subscriptionName }) => <li className="break-words" key={JSON.stringify(target)}>{subscriptionName} · {target.name}（{target.kind === "group" ? "策略组" : "节点"}）</li>)}
      </ul>
      <div className="space-y-3 text-xs text-slate-600 dark:text-slate-300">
        <p><strong>继续使用原节点：</strong>分流规则继续使用原订阅出口，新订阅负责默认线路。请保留原订阅。</p>
        <p><strong>保留绑定，稍后换绑：</strong>不修改原绑定信息；相关匹配流量暂时阻断，重新绑定后恢复。已有连接可能仍沿用原出口。</p>
      </div>
      {state.preview.keepError && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300 break-words">无法继续使用原节点：{state.preview.keepError}</p>}
      {state.error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300 break-words">{state.error}</p>}
      {state.busy && <p role="status" className="mt-3 text-xs">正在校验并切换，完成前请稍候…</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button autoFocus className={button} disabled={state.busy} onClick={actions.cancel}>取消</button>
        <button className={button} disabled={state.busy} onClick={() => void actions.choose("hold")}>保留绑定，稍后换绑</button>
        <button className={`${button} bg-indigo-600 text-white`} disabled={state.busy || !state.preview.canKeep} onClick={() => void actions.choose("keep")}>继续使用原节点</button>
      </div>
    </>}
  </dialog>, document.body);
}
