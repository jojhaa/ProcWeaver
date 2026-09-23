import { useSyncExternalStore } from "react";
import { getMonitorLowPower, setMonitorLowPower, subscribeMonitorPreferences } from "../utils/monitorPreferences";

export function MonitorPerformanceControl() {
  const enabled = useSyncExternalStore(subscribeMonitorPreferences, getMonitorLowPower);
  return <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300"
    title="降低日志和连接监控刷新频率，不影响代理转发；短连接的采样覆盖率可能降低">
    <input type="checkbox" checked={enabled} onChange={event => setMonitorLowPower(event.target.checked)} />
    低性能模式
  </label>;
}
