import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { ExclusionsPanel, ExclusionsPanelProps } from "./ExclusionsPanel";

interface ExclusionsDialogProps extends ExclusionsPanelProps {
  trigger?: (open: () => void) => React.ReactNode;
}

export function ExclusionsDialog({ state, actions, trigger }: ExclusionsDialogProps) {
  const [isOpen, setIsOpen] = useState(false);

  const openModal = () => {
    setIsOpen(true);
    actions.reload();
  };

  const closeModal = () => {
    if (!state.saving) {
      setIsOpen(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, state.saving]);

  return (
    <>
      {trigger ? (
        trigger(openModal)
      ) : (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={openModal}
            className="flex items-center space-x-2 px-3.5 py-2 rounded-xl text-xs font-semibold bg-indigo-50 hover:bg-indigo-100 text-indigo-600 border border-indigo-200/80 dark:bg-indigo-950/40 dark:hover:bg-indigo-900/60 dark:text-indigo-300 dark:border-indigo-800/80 transition cursor-pointer"
          >
            <span>输入排除域名 / IP</span>
          </button>
        </div>
      )}

      {isOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/60 backdrop-blur-xs animate-in fade-in duration-150"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeModal();
            }}
          >
            <div
              role="dialog"
              aria-labelledby="exclusions-dialog-title"
              aria-modal="true"
              className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 p-4 sm:p-6 shadow-2xl space-y-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-4 pb-3 border-b border-slate-100 dark:border-slate-800/80">
                <h2 id="exclusions-dialog-title" className="text-base font-bold text-slate-900 dark:text-white">
                  排除域名 / IP（直连）
                </h2>
                <button
                  type="button"
                  disabled={state.saving}
                  onClick={closeModal}
                  className="p-2 -mr-1 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition disabled:opacity-50 cursor-pointer active:scale-90"
                  title="关闭"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <ExclusionsPanel expanded state={state} actions={actions} />
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

