import { useEffect, useMemo, useSyncExternalStore } from "react";
import { fetchMihomoConfig, updateCoreMode } from "../api/mihomo";
import { createCoreModeController } from "../utils/coreModeController";
import { usePlatform } from "../context/PlatformContext";
import { isAppHidden } from "../utils/appVisibility";

export function useCoreMode(corePid?: number) {
  const mobile = usePlatform().os === "android";
  const controller = useMemo(() => createCoreModeController({ read: fetchMihomoConfig, write: updateCoreMode }), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    const refresh = () => { if (!mobile || (!isAppHidden() && corePid)) void controller.refresh(); };
    let timer: ReturnType<typeof setInterval> | undefined;
    const resume = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      controller.invalidateRead();
      if (mobile && (isAppHidden() || !corePid)) return;
      refresh(); timer = setInterval(refresh, 3000);
    };
    resume();
    if (mobile) document.addEventListener("visibilitychange", resume);
    const changed = () => { controller.invalidateRead(); refresh(); };
    window.addEventListener("netbox-route-changed", changed);
    window.addEventListener("netbox-settings-saved", changed);
    return () => { clearInterval(timer); controller.invalidateRead(); if (mobile) document.removeEventListener("visibilitychange", resume); window.removeEventListener("netbox-route-changed", changed); window.removeEventListener("netbox-settings-saved", changed); };
  }, [controller, corePid, mobile]);
  return { ...state, mode: mobile && !corePid ? null : state.mode, error: mobile && !corePid ? "" : state.error, refresh: controller.refresh, change: controller.change };
}
