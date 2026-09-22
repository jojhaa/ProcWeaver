import React, { useRef } from "react";
import { ExclusionsPanel, ExclusionsPanelProps } from "./ExclusionsPanel";

interface ExclusionsDialogProps extends ExclusionsPanelProps {
  trigger?: (open: () => void) => React.ReactNode;
}

export function ExclusionsDialog({ state, actions, trigger }: ExclusionsDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const openModal = () => {
    dialog.current?.showModal();
    actions.reload();
  };

  return (
    <>
      {trigger ? (
        trigger(openModal)
      ) : (
        <div className="flex justify-end">
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={openModal}
            className="flex items-center space-x-2 px-3.5 py-2 rounded-xl text-xs font-semibold bg-indigo-50 hover:bg-indigo-100 text-indigo-600 border border-indigo-200/80 dark:bg-indigo-950/40 dark:hover:bg-indigo-900/60 dark:text-indigo-300 dark:border-indigo-800/80 transition"
          >
            <span>输入排除域名 / IP</span>
          </button>
        </div>
      )}
    <dialog ref={dialog} aria-labelledby="exclusions-dialog-title"
      onCancel={event => { if (state.saving) event.preventDefault(); }}
      className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-2xl overflow-y-auto rounded-2xl border border-slate-300 bg-white p-5 text-slate-900 shadow-xl backdrop:bg-black/50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
      <div className="flex items-center justify-between gap-4">
        <h2 id="exclusions-dialog-title" className="text-lg font-semibold">排除域名 / IP（直连）</h2>
        <button type="button" autoFocus disabled={state.saving} onClick={() => dialog.current?.close()}
          className="rounded-lg border border-slate-400 px-3 py-1 text-sm disabled:opacity-50">关闭</button>
      </div>
      <ExclusionsPanel expanded state={state} actions={actions} />
    </dialog>
  </>);
}
