import React, { useEffect } from "react";
import { useTraffic } from "../hooks/useTraffic";
import { useMonitorVisible } from "../hooks/useMonitorVisible";
import { syncTrayTraffic } from "../utils/traySync";
import { TrafficOverview } from "./TrafficOverview";

// 高频采样状态局限在监控组件，不再推动整个 App 重渲染。
export const MonitoringRuntime = React.memo(function MonitoringRuntime() {
  const { reading } = useTraffic();
  const visible = useMonitorVisible();
  useEffect(() => {
    syncTrayTraffic(reading.downSpeed, reading.upSpeed, visible ? 1500 : 5000);
  }, [reading.downSpeed, reading.upSpeed, visible]);
  return null;
});

export const MonitoredTrafficOverview = React.memo(function MonitoredTrafficOverview() {
  return <TrafficOverview {...useTraffic()} />;
});
