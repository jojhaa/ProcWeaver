import { useEffect, useState } from "react";
import { fetchTrafficSnapshot } from "../api/traffic";
import { getGeneralSettings } from "../api/settings";
import { createTrafficCounter, TrafficReading } from "../utils/trafficCounter";

const zero: TrafficReading = { upload: 0, download: 0, upSpeed: 0, downSpeed: 0 };
export function useTraffic() {
  const [onlyProxy, setOnlyProxy] = useState(true);
  const [reading, setReading] = useState({ all: zero, proxy: zero });
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const load = () => { void getGeneralSettings().then(s => {if (alive) setOnlyProxy(s.onlyProxyTraffic ?? true);}).catch(() => {}); };
    load(); window.addEventListener("netbox-settings-saved", load);
    return () => { alive = false; window.removeEventListener("netbox-settings-saved", load); };
  }, []);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const count = createTrafficCounter();
    const poll = async () => {
      let nextDelay = 1000;
      try {
        const snapshot = await fetchTrafficSnapshot();
        if (alive) { setReading(count(snapshot, Date.now())); setError(""); }
      } catch {
        if (alive) {
          setError("核心未就绪或统计暂不可用");
          setReading(old => ({ all: {...old.all, upSpeed: 0, downSpeed: 0}, proxy: {...old.proxy, upSpeed: 0, downSpeed: 0} }));
          nextDelay = 3000; // 核心未就绪或无数据时退避至 3 秒
        }
      } finally { if (alive) timer = setTimeout(poll, nextDelay); }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  return { reading: onlyProxy ? reading.proxy : reading.all, onlyProxy, error };
}
