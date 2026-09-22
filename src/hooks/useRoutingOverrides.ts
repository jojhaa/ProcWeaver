import { useEffect, useMemo, useSyncExternalStore } from "react";
import { routingApi } from "../api/routingOverrides";
import { createRoutingController } from "../utils/routingController";
export function useRoutingOverrides() {
  const actions = useMemo(() => createRoutingController(routingApi), []);
  const state = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
  useEffect(() => { void actions.refresh(); const timer = setInterval(() => { void actions.refresh(); }, 4000); return () => clearInterval(timer); }, [actions]);
  return { state, actions };
}
