import type { FunctionMode, FunctionModeView } from "../types/functionMode";
import type { FunctionModeApi } from "../api/functionMode";

export interface FunctionModeState {
  view?: FunctionModeView;
  loading: boolean;
  pending: boolean;
  requested?: FunctionMode;
  error: string;
}
export function createFunctionModeController(api: Pick<FunctionModeApi, "read" | "change">, runtime: {
  suspend: (value: boolean) => void;
  whenIdle: () => Promise<unknown>;
  activate: (mode: FunctionMode) => void;
}) {
  let state: FunctionModeState = { loading: true, pending: false, error: "" };
  let sequence = 0;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<FunctionModeState>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
  return {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async load() {
      if (state.pending) return;
      const ticket = ++sequence;
      publish({ loading: true, error: "" });
      try {
        const view = await api.read();
        if (ticket !== sequence) return;
        runtime.activate(view.mode);
        publish({ view, loading: false });
      } catch (e) { if (ticket === sequence) publish({ loading: false, error: errorText(e) }); }
    },
    request(mode: FunctionMode) {
      if (!state.view || state.pending || mode === state.view.mode) return;
      publish({ requested: mode, error: "" });
    },
    cancel() { if (!state.pending) publish({ requested: undefined, error: "" }); },
    async confirm() {
      if (!state.view || !state.requested || state.pending) return false;
      const expected = state.view.mode, mode = state.requested;
      ++sequence;
      publish({ pending: true, error: "" });
      runtime.suspend(true);
      let suspended = true;
      try {
        await runtime.whenIdle();
        const view = await api.change(mode, expected, true);
        if (view.mode !== mode) throw new Error("功能模式未确认切换，请重新读取状态");
        runtime.activate(view.mode);
        // The new workspace restores its bundles on mount. Release the gate
        // before publishing the new view, including synchronous store renders.
        runtime.suspend(false);
        suspended = false;
        publish({ view, requested: undefined, pending: false });
        return true;
      } catch (e) { publish({ pending: false, error: errorText(e) }); return false; }
      finally { if (suspended) runtime.suspend(false); }
    },
  };
}
