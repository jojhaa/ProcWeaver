import { useEffect, useSyncExternalStore } from "react";
import { bundleController } from "../services/bundleRuntime";
export { bundleController } from "../services/bundleRuntime";
export const useBusinessBundles = () => useSyncExternalStore(bundleController.subscribe, bundleController.getSnapshot);

// 挂在主窗口而不是规则页面，保证冷启动及离开该页后仍能核对运行状态。
export function useBundleRuntime() {
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window) || document.documentElement.dataset.platform === "android") return;
    void bundleController.restore();
    const refresh = () => { if (document.documentElement.dataset.platform !== "android" || !isAppHidden()) void bundleController.refresh(); };
    let timer: number | undefined;
    const visibility = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      if (document.documentElement.dataset.platform !== "android" || !isAppHidden()) { refresh(); timer = window.setInterval(refresh, 5000); }
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    const events = ["netbox-route-changed", "netbox-profile-changed", "procweaver-profile-changed", "netbox-process-master-changed"];
    events.forEach(event => window.addEventListener(event, refresh));
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      events.forEach(event => window.removeEventListener(event, refresh));
    };
  }, []);
}
import { isAppHidden } from "../utils/appVisibility";
