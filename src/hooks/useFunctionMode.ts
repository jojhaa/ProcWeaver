import { useEffect, useSyncExternalStore } from "react";
import { functionModeApi } from "../api/functionMode";
import { bundleController } from "../services/bundleRuntime";
import { createFunctionModeController } from "../services/functionModeController";

const controller = createFunctionModeController(functionModeApi, {
  suspend: bundleController.suspend,
  whenIdle: bundleController.whenIdle,
  activate: bundleController.setFunctionMode,
});
export function useFunctionMode() {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => { void controller.load(); }, []);
  return { state, actions: controller };
}
