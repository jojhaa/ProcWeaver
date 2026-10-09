import { useEffect, useRef, useState } from "react";
import { functionModeApi } from "../api/functionMode";
import { bundleController, useBusinessBundles } from "./useBusinessBundles";
import type { ProcessPreferences } from "../types/functionMode";
import { useProcessCapture } from "./useProcessCapture";
import { externalProxyApi } from "../api/externalProxy";

export type ProcessTab = "bundles" | "external" | "diagnostics" | "settings" | "maintenance";
const navigation: Record<string, ProcessTab> = { bundles: "bundles", external: "external", diagnostics: "diagnostics", routing: "bundles", dashboard: "bundles", connections: "diagnostics", logs: "diagnostics", settings: "settings", maintenance: "maintenance", updates: "maintenance" };
export function useProcessWorkspace() {
  const bundles = useBusinessBundles();
  const capture = useProcessCapture();
  const [tab, setTab] = useState<ProcessTab>("bundles");
  const [filter, setFilter] = useState("");
  const [preferences, setPreferences] = useState<ProcessPreferences>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [logsBusy, setLogsBusy] = useState(false), [logsError, setLogsError] = useState("");
  const logsPending = useRef(false);
  const openLogs = async () => {
    if (logsPending.current) return;
    logsPending.current = true; setLogsBusy(true); setLogsError("");
    try { await externalProxyApi.openLogs(); }
    catch (e) { setLogsError(e instanceof Error ? e.message : "无法打开日志目录"); }
    finally { logsPending.current = false; setLogsBusy(false); }
  };
  useEffect(() => {
    let disposed = false;
    const removers: (() => void)[] = [];
    const navigate = (value: string) => { if (navigation[value]) setTab(navigation[value]); };
    const local = (e: Event) => navigate((e as CustomEvent<string>).detail);
    window.addEventListener("procweaver-navigate-tab", local);
    window.addEventListener("netbox-navigate-tab", local);
    if ("__TAURI_INTERNALS__" in window) void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const remove = await listen<string>("procweaver-navigate-tab", event => navigate(event.payload));
      if (disposed) remove(); else removers.push(remove);
    }).catch(() => {});
    return () => { disposed = true; removers.forEach(fn => fn()); window.removeEventListener("procweaver-navigate-tab", local); window.removeEventListener("netbox-navigate-tab", local); };
  }, []);
  const loadPreferences = async () => {
    setBusy(true); setError(""); setMessage("");
    try { setPreferences(await functionModeApi.preferences()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (tab === "settings") void loadPreferences(); }, [tab]);
  const save = async () => {
    if (!preferences || busy) return;
    setBusy(true); setError(""); setMessage("");
    try { setPreferences(await functionModeApi.savePreferences(preferences)); setMessage("基础设置已保存"); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return { tab, filter, preferences, busy, error, message, capture, logsBusy, logsError,
    external: bundles.external, runtimeError: bundles.error || bundles.externalReadError || "", pending: bundles.pending,
    bundleNames: Object.fromEntries(bundles.instances.map(i => [i.instanceId, i.definition.packageName])),
    records: (bundles.external?.records || []).filter(r => !filter || r.bundleId === filter).slice(-100).reverse(),
    actions: { setTab, setFilter, setPreferences, loadPreferences, save, openLogs,
      refresh: () => bundleController.refresh(), toggle: () => bundleController.setExternalEnabled(!bundles.external?.enabled) } };
}
