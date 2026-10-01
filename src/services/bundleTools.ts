import { bundleToolsApi, type LaunchRequest, type LaunchOutcome, type BundleShortcuts, type BundleEntryState } from "../api/bundleTools";
import { bundleController } from "./bundleRuntime";
import { getBundleStatus } from "../utils/bundleController";
import { getPlatform } from "./platform";
export interface BundleToolsState {
  open: boolean; kind: "launch" | "shortcuts"; title: string; request: LaunchRequest | null;
  busy: boolean; message: string; error: string; outcome: LaunchOutcome | null;
  shortcuts: BundleShortcuts | null; selected: string;
  entries: Record<string, BundleEntryState>;
  hotSwap: boolean;
}
let state: BundleToolsState = { open: false, kind: "launch", title: "", request: null, busy: false, message: "", error: "", outcome: null, shortcuts: null, selected: "", entries: {}, hotSwap: false };
const listeners = new Set<() => void>();
let sequence = 0;
let autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
const cancelAutoClose = () => {
  if (autoCloseTimer !== null) clearTimeout(autoCloseTimer);
  autoCloseTimer = null;
};
const publish = (patch: Partial<BundleToolsState>) => {
  if (Object.entries(patch).every(([key, value]) => JSON.stringify(state[key as keyof BundleToolsState]) === JSON.stringify(value))) return;
  state = { ...state, ...patch }; listeners.forEach(fn => fn());
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const entryIsCurrent = (entry?: BundleEntryState) => Boolean(entry?.instanceKey && ["restart_required", "partial"].includes(entry.state)
  && entry.connectionState !== "core_stopped" && (!entry.monitorState || ["current", "degraded"].includes(entry.monitorState))
  && (!entry.identityState || entry.identityState === "path_verified"));
const title = (id: string) => bundleController.getSnapshot().instances.find(i => i.instanceId === id)?.definition.packageName || id;
async function beforeLaunch(id: string, hotSwap = false) {
  await bundleController.whenIdle();
  const current = bundleController.getSnapshot();
  const item = current.instances.find(i => i.instanceId === id);
  if (!item) throw new Error("业务包已移除，请重新装载后再操作");
  const status = getBundleStatus(item, current);
  if (hotSwap && (!item.enabled || !(item.backend === "external" || item.slotBindings.main) || item.watcherMode !== "hot_swap" || status.phase !== "applied" || !entryIsCurrent(state.entries[id]))) {
    throw new Error("业务包或热替换状态已改变，未重启应用；请检查核心与本包设置后重试");
  }
  if (item.enabled && !["applied", "saved", "paused"].includes(status.phase)) throw new Error(status.message);
}
async function launch(request: LaunchRequest, confirmation: string | null = null, hotSwap = false) {
  if (state.busy) return;
  cancelAutoClose();
  const ticket = ++sequence;
  publish({ open: true, kind: "launch", title: title(request.instanceId), request, hotSwap, busy: true, error: "", message: confirmation ? "正在正常关闭应用，最长等待 15 秒…" : "正在核对业务包入口与已有应用实例…", outcome: null });
  try {
    await beforeLaunch(request.instanceId, hotSwap);
    const outcome = await bundleToolsApi.launch(request, confirmation, hotSwap && !confirmation);
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
  publish({ open: true, kind: "shortcuts", title: title(instanceId), request: { instanceId }, hotSwap: false, busy: true, error: "", message: "正在读取实际桌面与快捷方式…", outcome: null, shortcuts: null, selected: "" });
  try {
    await bundleController.whenIdle();
    const result = await bundleToolsApi.shortcuts(instanceId);
    if (ticket === sequence) publish({ shortcuts: result, selected: result.candidates.length === 1 ? result.candidates[0].path : "", message: "" });
  } catch (error) { if (ticket === sequence) publish({ error: errorText(error), message: "" }); }
  finally { if (ticket === sequence) publish({ busy: false }); }
}
// Keep cancellation/failure suppressed for this process identity and entry. A new
// instance can prompt again, at most once a minute per bundle, without extra polling.
const hotSwapPrompts = new Map<string, { key: string; after: number }>();
let inspecting: Promise<void> | undefined;
let inspectingFull = false;
let pendingFull = false;
const pendingIds = new Set<string>();
function hotSwapEligible(id: string) {
  const current = bundleController.getSnapshot();
  const item = current.instances.find(i => i.instanceId === id);
  return Boolean(item?.enabled && (item.backend === "external" || item.slotBindings.main) && item.watcherMode === "hot_swap"
    && getBundleStatus(item, current).phase === "applied" && entryIsCurrent(state.entries[id]));
}
async function prepareHotSwap(refreshedIds: ReadonlySet<string>) {
  if (!getPlatform().processWatcher) return;
  const current = bundleController.getSnapshot();
  for (const [id, record] of hotSwapPrompts) {
    const item = current.instances.find(i => i.instanceId === id);
    if (!item?.enabled || !(item.backend === "external" || item.slotBindings.main) || item.watcherMode !== "hot_swap") hotSwapPrompts.delete(id);
    else if (["idle", "connected"].includes(state.entries[id]?.state)) record.key = "";
  }
  if (state.open || state.busy) return;
  const entry = Object.values(state.entries).find(item => {
    const previous = hotSwapPrompts.get(item.instanceId);
    return refreshedIds.has(item.instanceId) && ["restart_required", "partial"].includes(item.state) && item.instanceKey
      && item.connectionState !== "core_stopped" && hotSwapEligible(item.instanceId)
      && previous?.key !== item.instanceKey && (!previous || Date.now() >= previous.after);
  });
  if (!entry) return;
  const request = { instanceId: entry.instanceId };
  const ticket = sequence;
  const definition = JSON.stringify(current.instances.find(i => i.instanceId === entry.instanceId));
  hotSwapPrompts.set(entry.instanceId, { key: entry.instanceKey!, after: Date.now() + 60000 });
  let presented = false;
  const stillCurrent = () => ticket === sequence && !state.open && !state.busy && hotSwapEligible(entry.instanceId)
    && state.entries[entry.instanceId]?.instanceKey === entry.instanceKey
    && definition === JSON.stringify(bundleController.getSnapshot().instances.find(i => i.instanceId === entry.instanceId));
  try {
    // Only obtain a confirmation token. The native command must not start an app
    // (or a stopped core) if it exits between entry polling and this preparation.
    const outcome = await bundleToolsApi.launch(request, null, true);
    if (stillCurrent() && outcome.state === "restart_required") {
      presented = true;
      cancelAutoClose();
      ++sequence;
      publish({ open: true, kind: "launch", title: title(entry.instanceId), request, hotSwap: true,
        busy: false, outcome, error: "", message: outcome.message });
    }
  } catch (error) {
    if (stillCurrent()) {
      presented = true;
      cancelAutoClose();
      ++sequence;
      publish({ open: true, kind: "launch", title: title(entry.instanceId), request, hotSwap: true,
        busy: false, outcome: null, message: "", error: `热替换准备失败：${errorText(error)}` });
    }
  } finally {
    // A manual dialog or an intervening edit can supersede this preparation.
    // It wasn't declined by the user, so allow a fresh check after the cooldown.
    if (!presented) {
      const record = hotSwapPrompts.get(entry.instanceId);
      if (record && record.key === entry.instanceKey) record.key = "";
    }
  }
}
function activeEntryIds(): Set<string> {
  const current = bundleController.getSnapshot();
  return new Set(current.instances.filter(i => i.enabled && i.watcherMode !== "disabled" && (i.backend === "external"
    ? current.external?.enabled : current.view?.config.bundlesEnabled !== false && i.slotBindings.main)).map(i => i.instanceId));
}
function mergeEntries(ids: ReadonlySet<string>, results: BundleEntryState[]) {
  const active = activeEntryIds();
  const entries = Object.fromEntries(Object.entries(state.entries).filter(([id]) => active.has(id) && !ids.has(id)));
  for (const entry of results) if (ids.has(entry.instanceId) && active.has(entry.instanceId)) entries[entry.instanceId] = entry;
  publish({ entries });
}
const unavailableEntry = (instanceId: string, message: string): BundleEntryState => ({
  instanceId, state: "unverified", message, chains: [],
  connectionState: "error", connectionMessage: "检测未完成，无法核验连接分流；下次检测会重试",
  monitorState: "stale", monitorMessage: "检测未完成，旧结果已失效", identityState: "unverified", identityMessage: "当前身份未核实",
});
async function refreshEntryBatch(requested?: string[]) {
  const active = activeEntryIds();
  const ids = new Set(requested === undefined ? active : requested.filter(id => active.has(id)));
  mergeEntries(new Set(), []); // Disabled/removed packages are pruned even during a partial refresh.
  const fingerprint = () => { const current = bundleController.getSnapshot(); return JSON.stringify([current.instances.filter(i => ids.has(i.instanceId)), current.view?.config.bundlesEnabled]); };
  const snapshot = fingerprint();
  try {
    const result = ids.size ? await bundleToolsApi.entries([...ids]) : [];
    if (snapshot !== fingerprint()) { mergeEntries(new Set(), []); return; }
    const returned = new Set(result.map(entry => entry.instanceId));
    mergeEntries(ids, [...result, ...[...ids].filter(id => !returned.has(id)).map(id => unavailableEntry(id, "本次未返回该业务包的核验结果，请等待重新检测"))]);
    await prepareHotSwap(ids);
  } catch (error) {
    if (snapshot !== fingerprint()) { mergeEntries(new Set(), []); return; }
    mergeEntries(ids, [...ids].map(id => unavailableEntry(id, `检测失败：${errorText(error)}`)));
  }
}
function refreshEntries(instanceIds?: string[]): Promise<void> {
  if (inspecting && instanceIds === undefined && inspectingFull) return inspecting;
  if (instanceIds === undefined) pendingFull = true;
  else for (const id of instanceIds) pendingIds.add(id);
  if (inspecting) return inspecting;
  inspecting = (async () => {
    do {
      const ids = pendingFull ? undefined : [...pendingIds];
      inspectingFull = pendingFull; pendingFull = false; pendingIds.clear();
      await refreshEntryBatch(ids);
    } while (pendingFull || pendingIds.size > 0);
  })().finally(() => { inspecting = undefined; inspectingFull = false; });
  return inspecting;
}
export const bundleTools = {
  getSnapshot: () => state,
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  launch, shortcuts,
  retry: () => state.request ? launch(state.request, null, state.hotSwap) : Promise.resolve(),
  notifyOverflow: (error: string) => { cancelAutoClose(); publish({ open: true, error }); },
  refreshEntries,
  confirm: () => state.request && state.outcome?.confirmation ? launch(state.request, state.outcome.confirmation, state.hotSwap) : Promise.resolve(),
  close: () => { if (!state.busy) { cancelAutoClose(); ++sequence; publish({ open: false }); } },
  select: (selected: string) => publish({ selected }),
  choose: async () => {
    if (!state.request || state.busy) return;
    const { request, kind, hotSwap } = state;
    cancelAutoClose();
    publish({ busy: true });
    try {
      const selected = await bundleToolsApi.choose(request.instanceId);
      publish({ busy: false });
      if (!selected) return;
      if (kind === "launch") await launch(request, null, hotSwap);
      else await shortcuts(request.instanceId);
    }
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
