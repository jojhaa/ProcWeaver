import { bundleToolsApi, type LaunchRequest, type LaunchOutcome, type BundleShortcuts, type BundleEntryState } from "../api/bundleTools";
import { bundleController } from "./bundleRuntime";
import { getBundleStatus } from "../utils/bundleController";
export interface BundleToolsState {
  open: boolean; kind: "launch" | "shortcuts"; title: string; request: LaunchRequest | null;
  busy: boolean; message: string; error: string; outcome: LaunchOutcome | null;
  shortcuts: BundleShortcuts | null; selected: string;
  entries: Record<string, BundleEntryState>;
}
let state: BundleToolsState = { open: false, kind: "launch", title: "", request: null, busy: false, message: "", error: "", outcome: null, shortcuts: null, selected: "", entries: {} };
const listeners = new Set<() => void>();
let sequence = 0;
let autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
const cancelAutoClose = () => {
  if (autoCloseTimer !== null) clearTimeout(autoCloseTimer);
  autoCloseTimer = null;
};
const publish = (patch: Partial<BundleToolsState>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const title = (id: string) => bundleController.getSnapshot().instances.find(i => i.instanceId === id)?.definition.packageName || id;
async function beforeLaunch(id: string) {
  await bundleController.whenIdle();
  const current = bundleController.getSnapshot();
  const item = current.instances.find(i => i.instanceId === id);
  if (!item) throw new Error("业务包已移除，请重新装载后创建快捷方式");
  const status = getBundleStatus(item, current);
  if (item.enabled && !["applied", "saved"].includes(status.phase)) throw new Error(status.message);
}
async function launch(request: LaunchRequest, confirmation: string | null = null) {
  if (state.busy) return;
  cancelAutoClose();
  const ticket = ++sequence;
  publish({ open: true, kind: "launch", title: title(request.instanceId), request, busy: true, error: "", message: confirmation ? "正在正常关闭应用，最长等待 15 秒…" : "正在核对业务包入口与已有应用实例…", outcome: null });
  try {
    await beforeLaunch(request.instanceId);
    const outcome = await bundleToolsApi.launch(request, confirmation);
    if (ticket === sequence) publish({ outcome, message: outcome.message });
    await bundleController.refresh();
  } catch (error) { if (ticket === sequence) publish({ error: errorText(error), message: "" }); }
  finally {
    if (ticket === sequence) {
      publish({ busy: false });
      if (!state.error && (state.outcome?.state === "launched" || state.outcome?.state === "reused")) {
        autoCloseTimer = setTimeout(() => {
          if (ticket !== sequence) return;
          autoCloseTimer = null;
          // Only this successful launch may close its own dialog.
          if (state.open && state.kind === "launch" && !state.busy && !state.error) {
            bundleTools.close();
          }
        }, 1500);
      }
    }
  }
}
async function shortcuts(instanceId: string) {
  if (state.busy) return;
  cancelAutoClose();
  const ticket = ++sequence;
  publish({ open: true, kind: "shortcuts", title: title(instanceId), request: { instanceId }, busy: true, error: "", message: "正在读取实际桌面与快捷方式…", outcome: null, shortcuts: null, selected: "" });
  try {
    await bundleController.whenIdle();
    const result = await bundleToolsApi.shortcuts(instanceId);
    if (ticket === sequence) publish({ shortcuts: result, selected: result.candidates.length === 1 ? result.candidates[0].path : "", message: "" });
  } catch (error) { if (ticket === sequence) publish({ error: errorText(error), message: "" }); }
  finally { if (ticket === sequence) publish({ busy: false }); }
}
export const bundleTools = {
  getSnapshot: () => state,
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  launch, shortcuts,
  retry: () => state.request ? launch(state.request) : Promise.resolve(),
  notifyOverflow: (error: string) => { cancelAutoClose(); publish({ open: true, error }); },
  refreshEntries: async () => {
    const ids = bundleController.getSnapshot().instances.filter(i => i.enabled && i.slotBindings.main && i.watcherMode !== "disabled").map(i => i.instanceId);
    try { const result = ids.length ? await bundleToolsApi.entries(ids) : []; publish({ entries: Object.fromEntries(result.map(item => [item.instanceId, item])) }); }
    catch (error) {
      publish({ entries: Object.fromEntries(ids.map(instanceId => [instanceId, {
        instanceId, state: "unverified", message: `检测失败：${errorText(error)}`, chains: [],
        connectionState: "error", connectionMessage: "检测未完成，无法核验连接分流；下次检测会重试",
      }])) });
    }
  },
  confirm: () => state.request && state.outcome?.confirmation ? launch(state.request, state.outcome.confirmation) : Promise.resolve(),
  close: () => { if (!state.busy) { cancelAutoClose(); ++sequence; publish({ open: false }); } },
  select: (selected: string) => publish({ selected }),
  choose: async () => {
    if (!state.request || state.busy) return;
    const id = state.request.instanceId; publish({ busy: true, error: "" });
    try { await bundleToolsApi.choose(id); publish({ busy: false }); await shortcuts(id); }
    catch (error) { publish({ busy: false, error: errorText(error) }); }
  },
  change: async (action: "patch" | "create" | "restore", recordId: string | null = null) => {
    if (!state.request || state.busy) return;
    const id = state.request.instanceId; publish({ busy: true, error: "", message: "正在写入并核验快捷方式…" });
    try {
      const message = await bundleToolsApi.shortcut(id, action, state.selected || null, recordId);
      const result = await bundleToolsApi.shortcuts(id);
      publish({ shortcuts: result, message, selected: "" });
    } catch (error) { publish({ error: errorText(error), message: "" }); }
    finally { publish({ busy: false }); }
  },
};
