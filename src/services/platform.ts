import type { BundlePlatform, MacTunReadiness, PlatformCapabilities } from "../types/platform";

let platform: PlatformCapabilities | undefined;
export function getPlatform(): PlatformCapabilities {
  if (!platform) throw new Error("平台能力尚未初始化");
  return platform;
}
export function bundlePlatform(): BundlePlatform {
  const os = getPlatform().os;
  if (os !== "windows" && os !== "macos" && os !== "android") throw new Error("当前系统尚未支持业务规则包");
  return os;
}

// 浏览器预览使用明确的模拟平台；桌面环境只信任后端，不通过 UA 猜测。
export async function initializePlatform(): Promise<PlatformCapabilities> {
  if ("__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<PlatformCapabilities>("get_platform_capabilities");
    if (!result || typeof result.os !== "string" || !Array.isArray(result.coreModes) || (!result.appProxy && !result.tun)) {
      throw new Error("未获取到受支持的平台能力，请确认安装包完整");
    }
    platform = Object.freeze(result);
  } else {
    const preview = new URLSearchParams(window.location.search).get("previewPlatform");
    const mac = preview === "macos-arm64" || preview === "macos-amd64";
    if (preview === "android") {
      platform = Object.freeze({ os: "android", arch: "aarch64", label: "Android · ARM64（预览）", appProxy: false,
        tun: true, smartHybrid: false, systemProxy: false, dnsGuard: false, processTree: false, processWatcher: false,
        shortcutManagement: false, autostart: false, elevation: false, coreModes: ["auto", "standard"] } satisfies PlatformCapabilities);
      return platform;
    }
    const arch = preview === "macos-arm64" ? "aarch64" : "x86_64";
    platform = Object.freeze({ os: mac ? "macos" : "windows", arch,
      label: mac ? `macOS · ${arch === "aarch64" ? "Apple Silicon" : "Intel"}（预览）` : "Windows · x64（预览）",
      appProxy: true, tun: !mac, smartHybrid: !mac, systemProxy: true, dnsGuard: !mac, processTree: true,
      processWatcher: !mac, shortcutManagement: !mac, autostart: true, elevation: !mac,
      coreModes: mac ? ["auto", "standard"] : ["auto", "v3", "compatible"],
    } satisfies PlatformCapabilities);
  }
  return platform;
}

export async function getMacTunReadiness(): Promise<MacTunReadiness> {
  if (getPlatform().os !== "macos") throw new Error("此检查仅适用于 macOS");
  if (!("__TAURI_INTERNALS__" in window)) return {
    canEnable: false, corePresent: false, authorizationReady: false, networkRecoveryReady: false,
    message: "浏览器预览不检查 Mac 权限、核心或路由；TUN 尚不可启用。",
  };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<MacTunReadiness>("get_macos_tun_readiness");
}
