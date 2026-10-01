import type { ProcessAccessMode, ProcessCaptureView } from "../types/functionMode";
import type { FunctionModeApi } from "../api/functionMode";
export interface ProcessCaptureState { view?: ProcessCaptureView; pending: boolean; requested?: ProcessAccessMode; error: string }
export function createProcessCaptureController(api: Pick<FunctionModeApi, "capture" | "changeCapture">) {
  let state: ProcessCaptureState = { pending: false, error: "" }, sequence = 0;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<ProcessCaptureState>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  const text = (e: unknown) => e instanceof Error ? e.message : String(e);
  return {
    getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async refresh() {
      if (state.pending || state.requested) return;
      const ticket = ++sequence;
      try { const view = await api.capture(); if (ticket === sequence) publish({ view, error: "" }); }
      catch (error) { if (ticket === sequence) publish({ error: text(error) }); }
    },
    request(mode: ProcessAccessMode) { if (state.view && !state.pending) publish({ requested: mode, error: "" }); },
    cancel() { if (!state.pending) publish({ requested: undefined, error: "" }); },
    async confirm() {
      if (!state.view || !state.requested || state.pending) return false;
      const mode = state.requested, expected = state.view.mode; ++sequence; publish({ pending: true, error: "" });
      try { const view = await api.changeCapture(mode, expected); publish({ view, requested: undefined, pending: false }); return true; }
      catch (error) { publish({ pending: false, error: text(error) }); return false; }
    },
  };
}
