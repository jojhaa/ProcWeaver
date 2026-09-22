export type CoreMode = "rule" | "global" | "direct";
export interface CoreModeState { mode: CoreMode | null; busy: boolean; error: string }
export function createCoreModeController(api: { read: () => Promise<{ mode?: string } | null>; write: (mode: CoreMode) => Promise<boolean> }) {
  let state: CoreModeState = { mode: null, busy: false, error: "" };
  let revision = 0;
  const listeners = new Set<() => void>();
  const publish = (next: CoreModeState) => { state = next; listeners.forEach(listener => listener()); };
  const readMode = async () => {
    const value = (await api.read())?.mode?.toLowerCase();
    if (value !== "rule" && value !== "global" && value !== "direct") throw Error("无法读取核心运行模式");
    return value;
  };
  const refresh = async () => {
    if (state.busy) return;
    const current = ++revision;
    try { const mode = await readMode(); if (revision === current) publish({ mode, busy: false, error: "" }); }
    catch { if (revision === current) publish({ mode: null, busy: false, error: "核心未就绪，无法读取模式" }); }
  };
  const change = async (mode: CoreMode) => {
    if (state.busy) return false;
    ++revision; // 使切换之前的读取失效。
    publish({ ...state, busy: true, error: "" });
    let error = "";
    try { if (!await api.write(mode)) throw Error("切换模式失败"); }
    catch (cause) { error = String(cause); }
    try {
      const actual = await readMode();
      if (!error && actual !== mode) error = "核心模式未切换，请重试";
      publish({ mode: actual, busy: false, error });
    } catch { publish({ mode: null, busy: false, error: error || "无法确认核心模式，请刷新重试" }); }
    return !state.error;
  };
  return { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, refresh, change };
}
