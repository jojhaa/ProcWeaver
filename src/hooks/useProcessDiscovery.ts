import { useCallback, useEffect, useRef, useState } from "react";
import { routingApi } from "../api/routingOverrides";
import { getGeneralSettings } from "../api/settings";
import { monitorStore } from "../api/traffic";
import { createDomainCollector, observationScope, type DomainCandidate } from "../services/processDiscovery";
import type { BundleProcessBinding, BundleProcessMember } from "../types/businessBundle";
import type { BundlePlatform } from "../types/platform";
import type { ProcessEntry } from "../types/routingOverrides";

export interface DiscoveryInput { members: BundleProcessMember[]; bindings: BundleProcessBinding[]; platform: BundlePlatform; bundleId?: string }
export function useProcessDiscovery(input: DiscoveryInput) {
  const [entries, setEntries] = useState<ProcessEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("读取模式中");
  const [domains, setDomains] = useState<DomainCandidate[]>([]);
  const [running, setRunning] = useState(false);
  const [limited, setLimited] = useState(false);
  const [includeBundle, setIncludeBundle] = useState(false);
  const alive = useRef(true), fetching = useRef(false);
  const latest = useRef(entries);
  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true; setLoading(true);
    try {
      const rows = await routingApi.tree();
      if (alive.current) { latest.current = rows; setEntries(rows); setError(""); }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "无法读取进程树"); }
    finally { fetching.current = false; if (alive.current) setLoading(false); }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const readMode = () => { void getGeneralSettings().then(s => { if (alive.current) setMode(s.trafficMode === "windivert_v1" ? "WinDivert" : s.tunMode || s.trafficMode === "tun" ? "TUN" : "纯应用层"); })
      .catch(() => { if (alive.current) setMode("模式读取失败，按连接证据检测"); }); };
    readMode();
    window.addEventListener("netbox-settings-saved", readMode);
    return () => { alive.current = false; window.removeEventListener("netbox-settings-saved", readMode); };
  }, [refresh]);

  useEffect(() => {
    if (!running) return;
    let cancelled = false, refreshing = false;
    let scope = observationScope(latest.current, input.members, input.bindings, input.platform, input.bundleId);
    let valid = true, sampled = 0, treeError = "";
    const start = Date.now(), collector = createDomainCollector();
    setDomains([]); setError(""); setLimited(false);
    const consume = () => {
      const sample = monitorStore.getConnections();
      if (cancelled || !valid || !sample || sample.timestamp < start || sample.timestamp === sampled) return;
      sampled = sample.timestamp;
      setDomains(collector.add(sample.connections, scope, sample.timestamp, includeBundle, sample.epoch));
      setLimited(collector.saturated);
    };
    const removeConnections = monitorStore.subscribeConnections(consume);
    const reportError = () => { if (!cancelled) setError(treeError || monitorStore.getTraffic().error); };
    const removeStatus = monitorStore.subscribeTraffic(reportError);
    const timer = window.setInterval(() => {
      if (!refreshing) {
        refreshing = true;
        void routingApi.tree().then(rows => {
          if (cancelled) return;
          latest.current = rows; setEntries(rows);
          scope = observationScope(rows, input.members, input.bindings, input.platform, input.bundleId); valid = true;
          treeError = ""; reportError();
        }).catch(() => { if (!cancelled) { valid = false; treeError = "进程树刷新失败，已暂停归属采集；等待下次刷新"; reportError(); } })
          .finally(() => { refreshing = false; });
      }
    }, 5000);
    return () => { cancelled = true; clearInterval(timer); removeConnections(); removeStatus(); };
    // Inputs are a frozen dialog selection; explicit stop/start opens a new observation window.
  }, [running, includeBundle]);
  return { state: { entries, loading, error, mode, domains, running, limited, includeBundle }, actions: {
    refresh, start: () => setRunning(true), stop: () => setRunning(false),
    includeBundle: (value: boolean) => { setRunning(false); setDomains([]); setIncludeBundle(value); },
  } };
}
