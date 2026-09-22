import { IpHealthInfo, CoreStatus, CpuInfo, ProfileItem } from "../types";
import { enqueueProbe } from "../utils/taskQueue";

export const isTauri = () => {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
};

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  throw new Error("NOT_IN_TAURI");
}

async function runIpHealth(proxyPort?: number): Promise<IpHealthInfo> {
  if (isTauri()) {
    const status = await getCoreStatus();
    return await invokeTauri<IpHealthInfo>("check_ip_health", { proxyPort: proxyPort === undefined ? undefined : status.mixedPort });
  }

  const res = await fetch("https://my.ippure.com/v1/info");
  if (!res.ok) {
    throw new Error(`IP 健康度查询失败: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchIpHealth(proxyPort?: number): Promise<IpHealthInfo> {
  return enqueueProbe(() => runIpHealth(proxyPort));
}

export async function waitForExitConnection(proxyPort: number): Promise<void> {
  return invokeTauri<void>("wait_for_exit_connection", { proxyPort });
}

export async function getCpuInfo(): Promise<CpuInfo> {
  if (isTauri()) {
    return await invokeTauri<CpuInfo>("get_cpu_info");
  }
  return {
    arch: "x86_64",
    avx2Supported: true,
    recommendedCore: "v3",
  };
}

export async function toggleCore(
  start: boolean,
  coreMode: "auto" | "v3" | "compatible" = "auto"
): Promise<CoreStatus> {
  if (isTauri()) {
    if (start) {
      return await invokeTauri<CoreStatus>("start_core", { coreMode });
    } else {
      return await invokeTauri<CoreStatus>("stop_core");
    }
  }
  return {
    running: start,
    pid: start ? 12345 : undefined,
    systemProxyEnabled: false,
    mixedPort: 7890,
    controllerPort: 9090,
    activeCore: start
      ? coreMode === "v3"
        ? "amd64-v3 (AVX2 高性能)"
        : "amd64-compatible (通用兼容)"
      : undefined,
  };
}

export async function toggleSystemProxy(enable: boolean, port = 7890): Promise<boolean> {
  if (isTauri()) {
    return await invokeTauri<boolean>("set_system_proxy", { enable, port });
  }
  return enable;
}

export async function getCoreStatus(): Promise<CoreStatus> {
  if (isTauri()) {
    return await invokeTauri<CoreStatus>("get_core_status");
  }
  return {
    running: false,
    systemProxyEnabled: false,
    mixedPort: 7890,
    controllerPort: 9090,
  };
}

// 订阅管理 API
export async function getProfiles(): Promise<ProfileItem[]> {
  if (isTauri()) {
    return await invokeTauri<ProfileItem[]>("list_profiles");
  }
  const raw = localStorage.getItem("mock_profiles");
  return raw ? JSON.parse(raw) : [
    {
      id: "mock_demo",
      name: "演示订阅 (节点 Demo)",
      url: "https://example.com/clash.yaml",
      filePath: "config/default.yaml",
      updatedAt: "2026-09-15 12:00",
      nodeCount: 16,
      isSelected: true,
    }
  ];
}

export async function addProfile(name: String, url: String): Promise<ProfileItem> {
  if (isTauri()) {
    return await invokeTauri<ProfileItem>("add_profile", { name, url });
  }
  const item: ProfileItem = {
    id: `mock_${Date.now()}`,
    name: name as string,
    url: url as string,
    filePath: "config/profiles/demo.yaml",
    updatedAt: "刚刚",
    nodeCount: 28,
    isSelected: false,
  };
  const list = await getProfiles();
  localStorage.setItem("mock_profiles", JSON.stringify([...list, item]));
  return item;
}

export async function updateProfile(id: string): Promise<ProfileItem> {
  if (isTauri()) {
    return await invokeTauri<ProfileItem>("update_profile", { id });
  }
  const list = await getProfiles();
  const found = list.find(p => p.id === id);
  if (!found) throw new Error("订阅不存在");
  found.updatedAt = "刚刚";
  localStorage.setItem("mock_profiles", JSON.stringify(list));
  return found;
}

export async function selectProfile(id: string): Promise<boolean> {
  if (isTauri()) {
    return await invokeTauri<boolean>("select_profile", { id });
  }
  const list = await getProfiles();
  list.forEach(p => p.isSelected = (p.id === id));
  localStorage.setItem("mock_profiles", JSON.stringify(list));
  return true;
}

export async function deleteProfile(id: string): Promise<boolean> {
  if (isTauri()) {
    return await invokeTauri<boolean>("delete_profile", { id });
  }
  const list = await getProfiles();
  localStorage.setItem("mock_profiles", JSON.stringify(list.filter(p => p.id !== id)));
  return true;
}

export async function editProfileMetadata(
  id: string,
  name: string,
  url: string,
  autoUpdateInterval: number
): Promise<ProfileItem> {
  if (isTauri()) {
    return await invokeTauri<ProfileItem>("edit_profile_metadata", {
      id,
      name,
      url,
      autoUpdateInterval,
    });
  }
  const list = await getProfiles();
  const item = list.find((p) => p.id === id);
  if (!item) throw new Error("订阅不存在");
  item.name = name;
  item.url = url;
  item.autoUpdateInterval = autoUpdateInterval;
  localStorage.setItem("mock_profiles", JSON.stringify(list));
  return item;
}

export async function getProfileContent(id: string): Promise<string> {
  if (isTauri()) {
    return await invokeTauri<string>("get_profile_content", { id });
  }
  return "proxies: []\nrules:\n  - MATCH,DIRECT\n";
}

export async function saveProfileContent(id: string, content: string): Promise<ProfileItem> {
  if (isTauri()) {
    return await invokeTauri<ProfileItem>("save_profile_content", { id, content });
  }
  const list = await getProfiles();
  const item = list.find((p) => p.id === id);
  if (!item) throw new Error("订阅不存在");
  item.updatedAt = "刚刚";
  localStorage.setItem("mock_profiles", JSON.stringify(list));
  return item;
}

export async function exportProfileFile(id: string, targetPath: string): Promise<boolean> {
  if (isTauri()) {
    return await invokeTauri<boolean>("export_profile_file", { id, targetPath });
  }
  return true;
}

// 智能策略组持久化与内核配置同步 API (D03: 真实状态与错误上抛)
export async function getSmartGroups(): Promise<import("../types/smartGroup").SmartGroupRule[]> {
  if (isTauri()) {
    try {
      const res = await invokeTauri<import("../types/smartGroup").SmartGroupRule[]>("get_smart_groups");
      if (Array.isArray(res)) {
        return res; // 严格返回后端真实数据，合法空数组不回退旧缓存
      }
    } catch (e) {
      console.warn("读取本地智能策略组失败:", e);
      throw e;
    }
  }
  const raw = localStorage.getItem("netbox_smart_rules");
  return raw ? JSON.parse(raw) : [];
}

export async function saveSmartGroups(rules: import("../types/smartGroup").SmartGroupRule[]): Promise<boolean> {
  if (isTauri()) {
    const ok = await invokeTauri<boolean>("save_smart_groups", { rules });
    if (!ok) {
      throw new Error("磁盘保存智能策略组失败");
    }
  }
  localStorage.setItem("netbox_smart_rules", JSON.stringify(rules));
  return true;
}

export interface SmartGroupInjectSpec {
  name: string;
  type: string;
  proxies: string[];
  tolerance?: number;
}

export async function syncSmartGroupsToCore(
  groups: SmartGroupInjectSpec[],
  channels?: import("../types/smartGroup").BusinessChannelConfig[]
): Promise<boolean> {
  if (isTauri()) {
    return await invokeTauri<boolean>("sync_smart_groups_to_core", { groups, channels });
  }
  return true;
}

export function getBusinessChannels(): import("../types/smartGroup").BusinessChannelConfig[] {
  try {
    const raw = localStorage.getItem("netbox_business_channels");
    if (raw) {
      const parsed: import("../types/smartGroup").BusinessChannelConfig[] = JSON.parse(raw);
      // 保证旧数据兼容性 (若缺失 customDomains 或 customProcesses 则补全)
      return parsed.map((item) => ({
        ...item,
        customDomains: item.customDomains || [],
        customProcesses: item.customProcesses || [],
      }));
    }
  } catch (e) {
    console.warn("读取业务矩阵路由配置失败", e);
  }
  // 默认初始开箱多轨业务矩阵
  return [
    {
      id: "ai",
      name: "🤖 AI 业务",
      icon: "Sparkles",
      desc: "OpenAI, Claude, Gemini, Grok 等高风控 AI 交互",
      targetType: "smart_group",
      targetName: "🛡️ 美区极稳接力",
      matchRulesSummary: "OpenAI / Claude / Gemini / Copilot",
      customDomains: [
        "openai.com",
        "chatgpt.com",
        "anthropic.com",
        "claude.ai",
        "oaistatic.com",
        "oaiusercontent.com",
        "generativelanguage.googleapis.com",
        "grok.com",
        "x.ai",
        "perplexity.ai",
      ],
      customProcesses: [],
      isCustom: false,
    },
    {
      id: "media",
      name: "🎬 国际流媒体",
      icon: "Film",
      desc: "YouTube, Netflix, Disney+, Spotify 4K 大带宽视听",
      targetType: "smart_group",
      targetName: "⚡ 港区低延迟优选",
      matchRulesSummary: "YouTube / Netflix / Disney+ / Spotify",
      customDomains: [
        "youtube.com",
        "googlevideo.com",
        "netflix.com",
        "nflxvideo.net",
        "disneyplus.com",
        "spotify.com",
      ],
      customProcesses: ["Spotify.exe"],
      isCustom: false,
    },
    {
      id: "office",
      name: "💼 协同办公",
      icon: "Briefcase",
      desc: "Telegram, Slack, Notion, Zoom 专线长连接防断",
      targetType: "smart_group",
      targetName: "🦁 新加坡优质节点",
      matchRulesSummary: "Telegram / Slack / Notion / Zoom",
      customDomains: [
        "telegram.org",
        "t.me",
        "slack.com",
        "notion.so",
        "zoom.us",
      ],
      customProcesses: ["Telegram.exe", "Slack.exe", "Notion.exe", "Zoom.exe"],
      isCustom: false,
    },
    {
      id: "dev",
      name: "💻 研发极客",
      icon: "Code",
      desc: "GitHub, Docker Hub, StackOverflow, NPM 低时延加速",
      targetType: "smart_group",
      targetName: "🌸 日本低风控原生",
      matchRulesSummary: "GitHub / Docker / npm / PyPI",
      customDomains: [
        "github.com",
        "githubusercontent.com",
        "docker.com",
        "docker.io",
        "npmjs.org",
        "npmjs.com",
      ],
      customProcesses: ["Code.exe", "git.exe", "docker.exe"],
      isCustom: false,
    },
    {
      id: "game",
      name: "🎮 游戏与本地",
      icon: "Gamepad2",
      desc: "Steam, 国内各大站点与局域网，0 延迟直通",
      targetType: "direct",
      targetName: "DIRECT",
      matchRulesSummary: "局域网 / 国内 CN 域名与 IP / 游戏服务",
      customDomains: ["steampowered.com", "steamcommunity.com"],
      customProcesses: ["steam.exe"],
      isCustom: false,
    },
  ];
}

export async function saveBusinessChannels(
  channels: import("../types/smartGroup").BusinessChannelConfig[]
): Promise<boolean> {
  localStorage.setItem("netbox_business_channels", JSON.stringify(channels));
  if (isTauri()) {
    try {
      return await invokeTauri<boolean>("save_business_channels", { channels });
    } catch (e) {
      console.warn("保存业务矩阵到后端失败:", e);
      return false;
    }
  }
  return true;
}

export function getSmartOverrideStatus(): import("../types/smartGroup").SmartOverrideStatus {
  try {
    const raw = localStorage.getItem("netbox_smart_override");
    return raw ? JSON.parse(raw) : { enabled: false };
  } catch {
    return { enabled: false };
  }
}

export function setSmartOverrideStatus(status: import("../types/smartGroup").SmartOverrideStatus): void {
  localStorage.setItem("netbox_smart_override", JSON.stringify(status));
}

export async function windowMinimize(): Promise<void> {
  if (isTauri()) {
    try {
      return await invokeTauri<void>("window_minimize");
    } catch {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().minimize();
      } catch (err) {
        console.error("最小化失败:", err);
      }
    }
  }
}

export async function windowStartDragging(): Promise<void> {
  if (isTauri()) {
    try {
      return await invokeTauri<void>("window_start_dragging");
    } catch {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().startDragging();
      } catch (err) {
        console.error("启动拖拽失败:", err);
      }
    }
  }
}

export async function windowToggleMaximize(): Promise<boolean> {
  if (isTauri()) {
    try {
      return await invokeTauri<boolean>("window_toggle_maximize");
    } catch {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().toggleMaximize();
        return await getCurrentWindow().isMaximized();
      } catch (err) {
        console.error("切换最大化失败:", err);
      }
    }
  }
  return false;
}

export async function windowIsMaximized(): Promise<boolean> {
  if (isTauri()) {
    try {
      return await invokeTauri<boolean>("window_is_maximized");
    } catch {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        return await getCurrentWindow().isMaximized();
      } catch {
        return false;
      }
    }
  }
  return false;
}

export async function windowClose(): Promise<void> {
  if (isTauri()) {
    try {
      return await invokeTauri<void>("window_close");
    } catch {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().close();
      } catch (err) {
        console.error("关闭窗口失败:", err);
      }
    }
  }
}

export async function checkIsAdmin(): Promise<boolean> {
  if (isTauri()) {
    try {
      return await invokeTauri<boolean>("check_is_admin");
    } catch (e) {
      console.warn("检查管理员权限异常:", e);
      return true;
    }
  }
  return true;
}

export async function restartElevated(): Promise<void> {
  if (isTauri()) {
    return await invokeTauri<void>("restart_elevated");
  }
}

export async function toggleDnsGuard(enable: boolean): Promise<boolean> {
  if (isTauri()) {
    return await invokeTauri<boolean>("toggle_dns_guard", { enable });
  }
  return enable;
}

export async function getDnsGuardStatus(): Promise<boolean> {
  if (isTauri()) {
    return await invokeTauri<boolean>("get_dns_guard_status");
  }
  return false;
}

export async function runNetworkEmergencyRepair(): Promise<string> {
  if (isTauri()) {
    return await invokeTauri<string>("run_network_emergency_repair");
  }
  return "急救已触发";
}

export async function launchPresetApp(presetId: string): Promise<{ success: boolean; message: string }> {
  if (isTauri()) {
    return await invokeTauri<{ success: boolean; message: string }>("launch_preset_app", { presetId });
  }
  return { success: true, message: `网页预览：已唤起 ${presetId}` };
}

export interface ShortcutStatus {
  existingFound: boolean;
  existingPatched: boolean;
  dedicatedExists: boolean;
  targetExeFound: boolean;
}

export async function getShortcutStatus(): Promise<ShortcutStatus> {
  if (isTauri()) {
    return await invokeTauri<ShortcutStatus>("get_shortcut_status");
  }
  return { existingFound: true, existingPatched: false, dedicatedExists: false, targetExeFound: true };
}

export async function patchExistingShortcut(): Promise<string> {
  if (isTauri()) {
    return await invokeTauri<string>("patch_existing_shortcut");
  }
  return "网页预览：已优化桌面快捷方式";
}

export async function restoreExistingShortcut(): Promise<string> {
  if (isTauri()) {
    return await invokeTauri<string>("restore_existing_shortcut");
  }
  return "网页预览：已还原桌面快捷方式";
}

export async function createDedicatedShortcut(): Promise<string> {
  if (isTauri()) {
    return await invokeTauri<string>("create_dedicated_shortcut");
  }
  return "网页预览：已在桌面创建专属加速快捷方式";
}

export async function toggleProcessWatcher(enable: boolean): Promise<boolean> {
  if (isTauri()) {
    return await invokeTauri<boolean>("toggle_process_watcher", { enable });
  }
  return enable;
}

export async function getProcessWatcherStatus(): Promise<boolean> {
  if (isTauri()) {
    return await invokeTauri<boolean>("get_process_watcher_status");
  }
  return false;
}

export type WatcherMode = "auto_relaunch" | "notify_only" | "disabled";

export interface BareProcessDetectedEvent {
  app_id: string;
  display_name: string;
  pid: number;
  is_browser: boolean;
  message: string;
}

export interface AutoRelaunchedEvent {
  app_id: string;
  display_name: string;
  pid: number;
  message: string;
}

export async function getWatcherMode(): Promise<WatcherMode> {
  if (isTauri()) {
    return await invokeTauri<WatcherMode>("get_watcher_mode");
  }
  return "disabled";
}

export async function setWatcherMode(mode: WatcherMode): Promise<WatcherMode> {
  if (isTauri()) {
    return await invokeTauri<WatcherMode>("set_watcher_mode", { mode });
  }
  return mode;
}

export async function getAppShortcutStatus(appId: string): Promise<ShortcutStatus> {
  if (isTauri()) {
    return await invokeTauri<ShortcutStatus>("get_app_shortcut_status", { appId });
  }
  return { existingFound: true, existingPatched: false, dedicatedExists: false, targetExeFound: true };
}

export async function patchAppShortcut(appId: string): Promise<string> {
  if (isTauri()) {
    return await invokeTauri<string>("patch_app_shortcut", { appId });
  }
  return "网页预览：已优化快捷方式";
}

export async function restoreAppShortcut(appId: string): Promise<string> {
  if (isTauri()) {
    return await invokeTauri<string>("restore_app_shortcut", { appId });
  }
  return "网页预览：已还原快捷方式";
}

export async function createDedicatedAppShortcut(appId: string): Promise<string> {
  if (isTauri()) {
    return await invokeTauri<string>("create_dedicated_app_shortcut", { appId });
  }
  return "网页预览：已生成专属快捷方式";
}

