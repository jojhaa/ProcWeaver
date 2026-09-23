import { useEffect, useState } from "react";
import { CoreStatus } from "../types";
import { getGeneralSettings, GeneralSettings } from "../api/settings";
import { fetchProxies } from "../api/mihomo";
import { syncTrayMenu, TrayRegionGroup } from "../utils/traySync";
import { buildCategorizedTrayGroups, RawNodeForTray } from "../utils/trayGroups";

let globalTrayGroupsCache: TrayRegionGroup[] = [];

export function setGlobalTrayGroups(groups: TrayRegionGroup[]) {
  globalTrayGroupsCache = groups;
  window.dispatchEvent(new CustomEvent("netbox-tray-groups-updated", { detail: groups }));
}

interface TrayManagerProps {
  coreStatus: CoreStatus;
  mode: "rule" | "global" | "direct" | null;
  activeNodeName: string;
}

export function useTrayManager({
  coreStatus,
  mode,
  activeNodeName,
}: TrayManagerProps) {
  const [settings, setSettings] = useState<GeneralSettings | null>(null);
  const [groups, setGroups] = useState<TrayRegionGroup[]>(globalTrayGroupsCache);
  const [activeNodeDelay, setActiveNodeDelay] = useState<number | null>(null);
  const [processEnabled, setProcessEnabled] = useState<boolean>(true);

  // 1. 获取常规偏好（开机自启等）
  const refreshSettings = async () => {
    try {
      const s = await getGeneralSettings();
      setSettings(s);
    } catch {
      // 忽略客户端未就绪异常
    }
  };

  const refreshProcessMaster = async () => {
    try {
      const { routingApi } = await import("../api/routingOverrides");
      const v = await routingApi.read();
      if (v?.config) {
        setProcessEnabled(Boolean(v.config.processEnabled));
      }
    } catch {
      // 忽略
    }
  };

  useEffect(() => {
    refreshSettings();
    refreshProcessMaster();

    const onSettingsSaved = () => {
      refreshSettings();
    };
    const onMasterChanged = (e: any) => {
      if (typeof e.detail === "boolean") {
        setProcessEnabled(e.detail);
      } else {
        refreshProcessMaster();
      }
    };
    window.addEventListener("netbox-settings-saved", onSettingsSaved);
    window.addEventListener("netbox-process-master-changed", onMasterChanged);
    return () => {
      window.removeEventListener("netbox-settings-saved", onSettingsSaved);
      window.removeEventListener("netbox-process-master-changed", onMasterChanged);
    };
  }, []);

  // 2. 监听外部或 LinesManagementView 推送的分组更新
  useEffect(() => {
    const handleGroupsUpdate = (e: any) => {
      if (e.detail && Array.isArray(e.detail)) {
        setGroups(e.detail);
      }
    };
    window.addEventListener("netbox-tray-groups-updated", handleGroupsUpdate);
    return () => {
      window.removeEventListener("netbox-tray-groups-updated", handleGroupsUpdate);
    };
  }, []);

  // 3. 当处于冷启动或用户尚未打开节点管理页时，若 groups 为空且核心已运行，主动拉取一次节点池并进行地区智能归类
  useEffect(() => {
    if (coreStatus.running && groups.length === 0) {
      fetchProxies()
        .then((res) => {
          if (!res || !res.proxies) return;
          const mainGroup =
            res.groups.find(
              (g) =>
                g.name === "PROXY" ||
                g.name === "GLOBAL" ||
                g.name.includes("节点选择")
            ) || res.groups[0];

          if (mainGroup && Array.isArray(mainGroup.all)) {
            const rawNodes: RawNodeForTray[] = mainGroup.all.map((name) => {
              const proxyData = res.proxies[name];
              const lastHistory = proxyData?.history?.[proxyData.history.length - 1];
              return {
                name,
                type: proxyData?.type,
                delay: lastHistory?.delay ?? null,
              };
            });

            const categorized = buildCategorizedTrayGroups(rawNodes, activeNodeName);
            if (categorized.length > 0) {
              setGroups(categorized);
              globalTrayGroupsCache = categorized;
            }
          }
        })
        .catch(() => {});
    }
  }, [coreStatus.running, groups.length, activeNodeName]);

  // 4. 查找当前活动节点的最新延迟
  useEffect(() => {
    if (!activeNodeName) {
      setActiveNodeDelay(null);
      return;
    }
    for (const group of groups) {
      const found = group.nodes.find((n) => n.name === activeNodeName);
      if (found && found.delay) {
        setActiveNodeDelay(found.delay);
        return;
      }
    }
  }, [groups, activeNodeName]);

  // 5. 状态看门狗：当任意核心状态发生变化，即时同步至原生托盘
  useEffect(() => {
    syncTrayMenu({
      running: coreStatus.running,
      mode: mode || "rule",
      sysProxyEnabled: coreStatus.systemProxyEnabled,
      sysProxyState: coreStatus.systemProxy?.state ?? "unknown",
      tunEnabled: settings?.tunMode ?? false,
      autoRun: settings?.autoStart ?? settings?.autoRun ?? true,
      processEnabled: processEnabled,
      activeNode: activeNodeName || null,
      activeNodeDelay: activeNodeDelay,
      groups: groups.map((g) => ({
        ...g,
        nodes: g.nodes.map((n) => ({
          ...n,
          active: n.name === activeNodeName,
        })),
      })),
    });
  }, [
    coreStatus.running,
    coreStatus.systemProxyEnabled,
    coreStatus.systemProxy?.state,
    mode,
    activeNodeName,
    activeNodeDelay,
    settings?.tunMode,
    settings?.autoStart,
    settings?.autoRun,
    processEnabled,
    groups,
  ]);
}
