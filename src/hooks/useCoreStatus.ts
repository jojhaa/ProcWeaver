import { useSyncExternalStore } from "react";
import { getCoreStatus } from "../api";
import { createCoreStatusStore } from "../utils/coreStatusStore";

const store = createCoreStatusStore(getCoreStatus);
export function useCoreStatus() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { ...snapshot, refresh: store.refresh, run: store.run };
}
