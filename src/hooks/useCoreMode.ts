import { useEffect, useMemo, useSyncExternalStore } from "react";
import { fetchMihomoConfig, updateCoreMode } from "../api/mihomo";
import { createCoreModeController } from "../utils/coreModeController";

export function useCoreMode(corePid?: number) {
  const controller = useMemo(() => createCoreModeController({ read: fetchMihomoConfig, write: updateCoreMode }), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    const refresh = () => { void controller.refresh(); };
    refresh();
    const timer = setInterval(refresh, 3000);
    window.addEventListener("netbox-route-changed", refresh);
    window.addEventListener("netbox-settings-saved", refresh);
    return () => { clearInterval(timer); window.removeEventListener("netbox-route-changed", refresh); window.removeEventListener("netbox-settings-saved", refresh); };
  }, [controller, corePid]);
  return { ...state, refresh: controller.refresh, change: controller.change };
}
