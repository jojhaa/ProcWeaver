import type { ConnectionsSnapshot } from "../api/connections";
import { createTrafficCounter, TrafficSnapshot, TrafficReading } from "./trafficCounter";

export interface MonitorSnapshot extends TrafficSnapshot { details?: ConnectionsSnapshot }
export interface ConnectionSample extends ConnectionsSnapshot { epoch: number | null; timestamp: number }
const zero: TrafficReading = { upload: 0, download: 0, upSpeed: 0, downSpeed: 0 };

// 两个订阅通道共享采集，连接详情仅在可见页面需要时请求。
export function createMonitorStore(fetch: (details: boolean) => Promise<MonitorSnapshot>, interval: number | (() => number) = 1000) {
  const listeners = new Set<() => void>();
  const details = new Set<() => void>();
  let traffic = { all: zero, proxy: zero, error: "" };
  let sample: ConnectionSample | null = null;
  const count = createTrafficCounter();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let generation = 0;
  let detailGeneration = 0;
  const active = () => listeners.size + details.size > 0;
  const publish = (subscribers: Set<() => void>) => subscribers.forEach(cb => cb());
  async function poll() {
    if (inFlight || !active()) return;
    inFlight = true;
    const revision = generation;
    const detailRevision = detailGeneration;
    let delay = typeof interval === "function" ? interval() : interval;
    try {
      const data = await fetch(details.size > 0);
      if (revision !== generation || !active()) return;
      const now = Date.now();
      traffic = { ...count(data, now), error: "" };
      if (data.details && details.size && detailRevision === detailGeneration) {
        sample = { ...data.details, epoch: data.epoch, timestamp: now };
        publish(details);
      }
      publish(listeners);
    } catch {
      delay = 3000;
      if (revision === generation && active()) {
        traffic = { all: { ...traffic.all, upSpeed: 0, downSpeed: 0 }, proxy: { ...traffic.proxy, upSpeed: 0, downSpeed: 0 }, error: "核心未就绪或统计暂不可用" };
        publish(listeners);
      }
    } finally {
      inFlight = false;
      if (active()) timer = setTimeout(poll, revision === generation ? delay : 0);
    }
  }
  function subscribe(set: Set<() => void>, cb: () => void) {
    const wasActive = active();
    set.add(cb);
    if (!wasActive) void poll();
    return () => {
      set.delete(cb);
      if (set === details && !details.size) { sample = null; detailGeneration++; }
      if (!active()) { generation++; clearTimeout(timer); }
    };
  }
  return {
    getTraffic: () => traffic,
    getConnections: () => sample,
    subscribeTraffic: (cb: () => void) => subscribe(listeners, cb),
    subscribeConnections: (cb: () => void) => subscribe(details, cb),
    invalidate() {
      generation++;
      sample = null;
      clearTimeout(timer);
      if (!inFlight) void poll();
    },
  };
}
