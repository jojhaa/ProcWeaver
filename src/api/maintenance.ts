import { isTauri } from "./index";
import { version as appVersion } from "../../package.json";
import {
  AppUpdateInfo,
  MihomoCoreDetail,
  MihomoReleaseInfo,
  RulesRepoInfo,
} from "../types";

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  throw new Error("NOT_IN_TAURI");
}

/**
 * 检查客户端桌面版本更新 (主仓库: jojhaa/ProcWeaver)
 */
export async function checkAppUpdate(): Promise<AppUpdateInfo> {
  if (isTauri()) {
    return await invokeTauri<AppUpdateInfo>("check_app_update");
  }
  // Web 预览兜底
  return {
    currentVersion: `V${appVersion}`,
    latestVersion: `V${appVersion}`,
    hasUpdate: false,
    releaseName: `ProcWeaver V${appVersion} (当前为最新版)`,
    releaseNotes: "### 核心特性更新\n- 统一版本与组件维护中心\n- 深度集成 GEO 离线数据库\n- 优化代理流量采样统计",
    publishedAt: new Date().toISOString(),
    downloadUrl: null,
    assetName: `ProcWeaver_v${appVersion}_x64_Portable.zip`,
    assetSizeBytes: 106450000,
    assetSizeFormatted: "101.5 MB",
    htmlUrl: "https://github.com/jojhaa/ProcWeaver/releases",
    repoUrl: "https://github.com/jojhaa/ProcWeaver",
  };
}

/**
 * 下载客户端更新包到本地缓存
 */
export async function downloadAppUpdate(downloadUrl: string, fileName: string): Promise<string> {
  if (isTauri()) {
    return await invokeTauri<string>("download_app_update", { downloadUrl, fileName });
  }
  return ".update_cache/mock.zip";
}

/**
 * 执行客户端更新替换安装（便携保护）
 */
export async function installAppUpdate(archivePath: string): Promise<boolean> {
  if (isTauri()) {
    return await invokeTauri<boolean>("install_app_update", { archivePath });
  }
  return true;
}

/**
 * 重启应用程序
 */
export async function restartApp(): Promise<void> {
  if (isTauri()) {
    return await invokeTauri<void>("restart_app");
  }
  window.location.reload();
}

/**
 * 获取内核详细运行与底层架构信息
 */
export async function getMihomoCoreDetail(): Promise<MihomoCoreDetail> {
  if (isTauri()) {
    return await invokeTauri<MihomoCoreDetail>("get_mihomo_core_detail");
  }
  return {
    activeCoreMode: "auto",
    activeCorePath: "binaries/mihomo-v3.exe",
    coreVersionRaw: "Mihomo Meta v1.19.0 windows amd64 with go1.22.5",
    coreVersionTag: "v1.19.0",
    cpuArch: "x86_64",
    avx2Supported: true,
    recommendedCore: "v3",
    isRunning: true,
    pid: 1234,
    mixedPort: 7890,
    controllerPort: 9090,
    startedAt: Math.floor(Date.now() / 1000) - 3600,
  };
}

/**
 * 检查官方 Mihomo Meta 最新发行版
 */
export async function checkMihomoUpdate(): Promise<MihomoReleaseInfo> {
  if (isTauri()) {
    return await invokeTauri<MihomoReleaseInfo>("check_mihomo_update");
  }
  return {
    latestVersion: "v1.19.0",
    releaseName: "Mihomo Meta v1.19.0 稳定版",
    publishedAt: new Date().toISOString(),
    downloadUrl: "https://github.com/MetaCubeX/mihomo/releases",
    assetName: "mihomo-windows-amd64-v3-v1.19.0.zip",
    assetSizeBytes: 61047808,
    assetSizeFormatted: "58.2 MB",
    htmlUrl: "https://github.com/MetaCubeX/mihomo/releases",
  };
}

/**
 * 检查规则仓库 (ProcWeaver-Rules) 状态
 */
export async function checkRulesRepoUpdate(): Promise<RulesRepoInfo> {
  if (isTauri()) {
    return await invokeTauri<RulesRepoInfo>("check_rules_repo_update");
  }
  return {
    repoUrl: "https://github.com/jojhaa/ProcWeaver-Rules",
    latestTag: "main (实时更新)",
    releaseName: "ProcWeaver 官方规则仓库",
    updatedAt: new Date().toISOString(),
    description: "承载 Business-Rules 业务规则包与 Core-Rules 核心分流规则集",
  };
}

/**
 * 检查 Core-Rules 核心规则集更新
 */
export async function checkCoreRulesUpdate(): Promise<import("../types").CoreRulesUpdateInfo> {
  if (isTauri()) {
    return await invokeTauri<import("../types").CoreRulesUpdateInfo>("check_core_rules_update");
  }
  return {
    currentVersion: "v2026.09.21",
    latestVersion: "v2026.09.21",
    hasUpdate: false,
    totalRulesCount: 30,
    releaseName: "Core-Rules 核心规则基准版",
    releaseNotes: "### 核心规则变动\n- 覆盖主流 AI 服务分流 (Claude/OpenAI/Gemini)\n- 优化流媒体规则与国内 CN-CIDR 兜底",
    publishedAt: new Date().toISOString(),
    downloadUrl: null,
    assetName: "Core-Rules.zip",
    assetSizeBytes: 3145728,
    assetSizeFormatted: "3.0 MB",
    localRulesDir: "core_data/ruleset/local-plan",
  };
}

/**
 * 下载并更新 Core-Rules 核心规则集（解压写入 local-plan 并热重载内核）
 */
export async function downloadCoreRulesUpdate(
  downloadUrl: string,
  versionTag: string
): Promise<string> {
  if (isTauri()) {
    return await invokeTauri<string>("download_core_rules_update", { downloadUrl, versionTag });
  }
  return "成功更新 30 个核心规则集文件，内核分流规则已热重载生效！";
}
