export type FunctionMode = "full" | "process_proxy";
export type ProcessAccessMode = "app_proxy" | "windivert";
export interface ProcessCaptureView {
  mode: ProcessAccessMode; active: boolean; supported: boolean; admin: boolean; error: string | null;
  tcp: number; udp: number; dns: number; unclassified: number; failures: number;
}
export interface FunctionModeView {
  mode: FunctionMode;
  coreRunning: boolean;
  independentWinDivert: boolean;
  winDivertReason: string;
}
export interface ProcessPreferences {
  autoStart: boolean;
  minimizeOnClose: boolean;
  silentStart: boolean;
}
