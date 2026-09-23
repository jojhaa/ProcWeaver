import { useEffect, useState, useSyncExternalStore } from "react";
import { monitorStore } from "../api/traffic";
import { getGeneralSettings } from "../api/settings";

export function useTraffic() {
  const [onlyProxy, setOnlyProxy] = useState(true);
  const reading = useSyncExternalStore(monitorStore.subscribeTraffic, monitorStore.getTraffic);
  useEffect(() => {
    let alive = true;
    const load = () => { void getGeneralSettings().then(s => { if (alive) setOnlyProxy(s.onlyProxyTraffic ?? true); }).catch(() => {}); };
    load(); window.addEventListener("netbox-settings-saved", load);
    return () => { alive = false; window.removeEventListener("netbox-settings-saved", load); };
  }, []);
  return { reading: onlyProxy ? reading.proxy : reading.all, onlyProxy, error: reading.error };
}
