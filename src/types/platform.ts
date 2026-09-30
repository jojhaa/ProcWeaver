export type BundlePlatform = "windows" | "macos" | "android";
export type CoreVariant = "auto" | "v3" | "compatible" | "standard";
export interface PlatformCapabilities {
  os: string;
  arch: string;
  label: string;
  appProxy: boolean;
  tun: boolean;
  smartHybrid: boolean;
  systemProxy: boolean;
  dnsGuard: boolean;
  processTree: boolean;
  processWatcher: boolean;
  shortcutManagement: boolean;
  autostart: boolean;
  elevation: boolean;
  coreModes: CoreVariant[];
}

export interface MacTunReadiness {
  canEnable: boolean;
  corePresent: boolean;
  authorizationReady: boolean;
  networkRecoveryReady: boolean;
  message: string;
}
