import { invoke } from "@tauri-apps/api/core";
import type { FunctionMode, FunctionModeView, ProcessPreferences, ProcessAccessMode, ProcessCaptureView } from "../types/functionMode";

export const functionModeApi = {
  read: () => invoke<FunctionModeView>("get_function_mode"),
  change: (mode: FunctionMode, expectedMode: FunctionMode, confirmNetworkStop: boolean) =>
    invoke<FunctionModeView>("set_function_mode", { mode, expectedMode, confirmNetworkStop }),
  preferences: () => invoke<ProcessPreferences>("get_process_preferences"),
  savePreferences: (settings: ProcessPreferences) => invoke<ProcessPreferences>("save_process_preferences", { settings }),
  capture: () => invoke<ProcessCaptureView>("get_process_capture"),
  changeCapture: (mode: ProcessAccessMode, expectedMode: ProcessAccessMode) => invoke<ProcessCaptureView>("set_process_capture", { mode, expectedMode, confirmed: true }),
};
export type FunctionModeApi = typeof functionModeApi;
