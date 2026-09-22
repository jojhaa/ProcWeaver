import React, { useState, useEffect, useMemo, useRef } from "react";
import { ProxyGroup, ProxyItem, IpHealthInfo, ProfileItem } from "../types";
import { SmartGroupRule } from "../types/smartGroup";
import { fetchProxies, switchProxy, testDelay, getPreferredSpeedTestUrl } from "../api/mihomo";
import { logInfo, logWarn, logError } from "../api/logs";
import {
  getSmartGroups,
  saveSmartGroups,
  syncSmartGroupsToCore,
  getProfiles,
  addProfile,
  updateProfile,
  deleteProfile,
  selectProfile,
} from "../api";
import {
  probeNodeHealthBatch,
  getPersistedHealthCache,
  savePersistedHealthCache,
  getPersistedNodeRegions,
  savePersistedNodeRegions,
  getIgnoredNodes,
  saveIgnoredNodes,
} from "../api/nodeHealth";
import { getStoredConcurrency, getStoredHealthProbeConcurrency } from "../utils/taskQueue";
import {
  parseMultiplier,
  formatMultiplier,
  formatCountryRegionTitle,
  isInformationalNode,
  extractSubscriptionMeta,
  filterAndSortProxies,
} from "../utils/proxyParser";
import { setGlobalTrayGroups } from "../hooks/useTrayManager";
import { buildCategorizedTrayGroups, RawNodeForTray } from "../utils/trayGroups";
import { SmartGroupModal } from "../components/SmartGroupModal";
import {
  Search,
  RefreshCw,
  Plus,
  Radio,
  Zap,
  Link2,
  Trash2,
  CheckSquare,
  Square,
  Globe,
  X,
  Shield,
  Check,
  AlertCircle,
  Eye,
  EyeOff,
  ScrollText,
} from "lucide-react";

// 格式化字节为易读格式 (GB / MB)
function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${parseFloat(val.toFixed(1))} ${sizes[i]}`;
}

export const LinesManagementView: React.FC = () => {
  const [groups, setGroups] = useState<ProxyGroup[]>([]);
  const [proxies, setProxies] = useState<Record<string, ProxyItem>>({});
  const [delayMap, setDelayMap] = useState<Record<string, number | null>>({});
  const [testingAll, setTestingAll] = useState(false);
  const [testingNodes, setTestingNodes] = useState<Record<string, boolean>>({});
  const [searchKeyword, setSearchKeyword] = useState("");
  const [hideTimeout, setHideTimeout] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("netbox_hide_timeout_nodes");
      return saved !== null ? saved === "true" : true;
    } catch {
      return true;
    }
  });
  const [sortBy] = useState<"default" | "latency-asc" | "name-asc">("default");

  // 自建智能策略组规则
  const [smartRules, setSmartRules] = useState<SmartGroupRule[]>([]);
  const [smartModalOpen, setSmartModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<SmartGroupRule | null>(null);

  // 节点多选打包
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const [packModalType, setPackModalType] = useState<"url-test" | "relay" | null>(null);
  const [packName, setPackName] = useState("");

  // 侧边订阅管理抽屉
  const [subDrawerOpen, setSubDrawerOpen] = useState(false);
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [subLoading, setSubLoading] = useState(false);
  const [newSubUrl, setNewSubUrl] = useState("");
  const [newSubName, setNewSubName] = useState("");
  const [showAddSubModal, setShowAddSubModal] = useState(false);
  const [switchingProfileId, setSwitchingProfileId] = useState<string | null>(null);
  const [subError, setSubError] = useState("");
  const [addSubError, setAddSubError] = useState("");
  const [subNotice, setSubNotice] = useState("");
  const subPending = useRef(false);
  const profileReadVersion = useRef(0);
  const subDrawer = useRef<HTMLDialogElement>(null);
  const addSubDialog = useRef<HTMLDialogElement>(null);
  const backdropPressed = useRef<EventTarget | null>(null);

  useEffect(() => {
    if (subDrawerOpen && !subDrawer.current?.open) subDrawer.current?.showModal();
    else if (!subDrawerOpen) subDrawer.current?.close();
  }, [subDrawerOpen]);
  useEffect(() => {
    if (showAddSubModal && !addSubDialog.current?.open) addSubDialog.current?.showModal();
    else if (!showAddSubModal) addSubDialog.current?.close();
  }, [showAddSubModal]);

  const closeSubscriptionDialog = (adding: boolean) => {
    if (subPending.current) return;
    if (adding) setShowAddSubModal(false);
    else setSubDrawerOpen(false);
  };
  const closeSubscriptionBackdrop = (event: React.MouseEvent<HTMLDialogElement>, adding: boolean) => {
    if (event.target === event.currentTarget && backdropPressed.current === event.currentTarget) {
      closeSubscriptionDialog(adding);
    }
    backdropPressed.current = null;
  };

  // 节点 IP 纯净度缓存与全量体检状态
  const [healthCache, setHealthCache] = useState<Record<string, IpHealthInfo>>({});
  const [probingNodes, setProbingNodes] = useState<Record<string, boolean>>({});
  const [probingAll, setProbingAll] = useState(false);
  const [probeProgress, setProbeProgress] = useState<{ completed: number; total: number } | null>(null);

  // 节点归属国家/地区持久化字典 (nodeName -> "🇯🇵 日本")
  const [persistedNodeRegions, setPersistedNodeRegions] = useState<Record<string, string>>({});

  // 用户主动忽略的节点名称列表 (本地持久化)
  const [ignoredNodes, setIgnoredNodes] = useState<string[]>(() => getIgnoredNodes());
  const [showIgnoredDrawer, setShowIgnoredDrawer] = useState(false);

  // 初始加载
  const loadData = async () => {
    const profileVersion = profileReadVersion.current;
    try {
      const pData = await fetchProxies();
      setProxies(pData.proxies || {});
      setGroups(pData.groups || []);

      const sRules = await getSmartGroups();
      setSmartRules(sRules);

      const diskCache = await getPersistedHealthCache();
      if (diskCache) setHealthCache(diskCache);

      const diskRegions = await getPersistedNodeRegions();
      const mergedRegions = { ...diskRegions };
      if (diskCache) {
        Object.entries(diskCache).forEach(([name, info]) => {
          if (info.countryCode && !mergedRegions[name]) {
            mergedRegions[name] = formatCountryRegionTitle(info.countryCode, info.country);
          }
        });
      }
      setPersistedNodeRegions(mergedRegions);
      savePersistedNodeRegions(mergedRegions);

      const savedIgnored = getIgnoredNodes();
      setIgnoredNodes(savedIgnored);

      const profs = await getProfiles();
      if (profileVersion === profileReadVersion.current) setProfiles(profs);
    } catch (err) {
      console.error("加载线路管理大盘数据失败:", err);
    }
  };

  useEffect(() => {
    loadData();
    const handleProfileChange = () => loadData();
    const handleHealthUpdated = (e: any) => {
      const { node, health } = e.detail || {};
      if (node && health) {
        setHealthCache((prev) => ({ ...prev, [node]: health }));
      }
    };
    window.addEventListener("procweaver-profile-changed", handleProfileChange);
    window.addEventListener("netbox-node-health-updated", handleHealthUpdated);
    return () => {
      window.removeEventListener("procweaver-profile-changed", handleProfileChange);
      window.removeEventListener("netbox-node-health-updated", handleHealthUpdated);
    };
  }, []);

  // 提取所有真实出站节点（坚决排除套餐、到期日、剩余流量与 Compatible 占位符）
  const realNodes = useMemo(() => {
    const list: ProxyItem[] = [];
    const specialTypes = new Set(["Selector", "URLTest", "Fallback", "LoadBalance", "Relay", "Direct", "Reject"]);
    Object.values(proxies).forEach((p) => {
      if (
        !specialTypes.has(p.type) &&
        p.name !== "GLOBAL" &&
        p.name !== "DIRECT" &&
        p.name !== "REJECT" &&
        !isInformationalNode(p.name, p.type)
      ) {
        list.push(p);
      }
    });
    return list;
  }, [proxies]);

  const realNodeNames = useMemo(() => realNodes.map((n) => n.name), [realNodes]);
  const smartFallbackOptions = useMemo(() => ["DIRECT", "REJECT", ...realNodeNames], [realNodeNames]);

  // 从所有节点中提炼账号订阅状态 (剩余流量、套餐到期日、重置倒计时)
  const subMeta = useMemo(() => {
    return extractSubscriptionMeta(Object.values(proxies));
  }, [proxies]);

  // 忽略单个节点
  const handleIgnoreNode = (nodeName: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!ignoredNodes.includes(nodeName)) {
      const next = [...ignoredNodes, nodeName];
      setIgnoredNodes(next);
      saveIgnoredNodes(next);
    }
  };

  // 取消忽略单个节点 (恢复)
  const handleUnignoreNode = (nodeName: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const next = ignoredNodes.filter((n) => n !== nodeName);
    setIgnoredNodes(next);
    saveIgnoredNodes(next);
  };

  // 一键忽略全部未体检节点
  const handleIgnoreAllUnprobed = (unprobedNodes: ProxyItem[], e?: React.MouseEvent) => {
    e?.stopPropagation();
    const names = unprobedNodes.map((n) => n.name);
    const next = Array.from(new Set([...ignoredNodes, ...names]));
    setIgnoredNodes(next);
    saveIgnoredNodes(next);
  };

  // 当前激活使用中的主节点名称
  const activeNodeName = useMemo(() => {
    const mainGroup = groups.find((g) => g.name === "PROXY" || g.name === "GLOBAL") || groups[0];
    return mainGroup?.now || "";
  }, [groups]);

  // 全量测速
  const handleTestAll = async () => {
    if (testingAll || realNodes.length === 0) return;
    setTestingAll(true);
    const targetNodes = realNodes.map((n) => n.name);
    const concurrency = getStoredConcurrency();
    const testEndpoint = getPreferredSpeedTestUrl() || "https://cp.cloudflare.com/generate_204";

    logInfo(
      "批量测速",
      `启动批量并发测速: 待测节点 ${targetNodes.length} 个 | 并发度: ${concurrency} | 端点: ${testEndpoint}`
    );
    const startBatchTime = performance.now();

    let successCount = 0;
    let timeoutCount = 0;
    let totalDelay = 0;
    let fastestNode = "";
    let fastestDelay = Infinity;

    // 分批受控并发测速（使用用户设置的并发度，防止 20000ms 超时）
    const queue = [...targetNodes];
    const runWorker = async () => {
      while (queue.length > 0) {
        const node = queue.shift();
        if (!node) break;
        setTestingNodes((prev) => ({ ...prev, [node]: true }));
        try {
          const delay = await testDelay(node, testEndpoint, 3000);
          setDelayMap((prev) => ({ ...prev, [node]: delay }));
          if (delay !== null && delay !== undefined) {
            successCount++;
            totalDelay += delay;
            if (delay < fastestDelay) {
              fastestDelay = delay;
              fastestNode = node;
            }
          } else {
            timeoutCount++;
          }
        } catch {
          setDelayMap((prev) => ({ ...prev, [node]: null }));
          timeoutCount++;
        } finally {
          setTestingNodes((prev) => ({ ...prev, [node]: false }));
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => runWorker());
    await Promise.all(workers);
    setTestingAll(false);

    const costBatchMs = Math.round(performance.now() - startBatchTime);
    const avgDelay = successCount > 0 ? Math.round(totalDelay / successCount) : 0;
    const fastestSummary = fastestNode ? `最快: [${fastestNode}] (${fastestDelay}ms)` : "无可用节点";

    logInfo(
      "批量测速",
      `批量测速全部完成 [总耗时: ${costBatchMs}ms]: 成功 ${successCount} 个, 超时 ${timeoutCount} 个 | ${fastestSummary} | 平均延迟: ${avgDelay}ms`
    );
  };

  // 单节点测速
  const handleTestNode = async (name: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (testingNodes[name]) return;
    setTestingNodes((prev) => ({ ...prev, [name]: true }));
    const testEndpoint = getPreferredSpeedTestUrl() || "https://cp.cloudflare.com/generate_204";
    logInfo("节点测速", `发起单节点延迟测速: [${name}] -> 目标: ${testEndpoint}`);
    try {
      const delay = await testDelay(name, testEndpoint, 3000);
      setDelayMap((prev) => ({ ...prev, [name]: delay }));
      if (delay !== null && delay !== undefined) {
        const quality =
          delay <= 100
            ? "极速 · 极佳"
            : delay <= 200
            ? "平稳 · 良好"
            : delay <= 350
            ? "可用 · 一般"
            : "延迟偏高";
        logInfo("节点测速", `节点 [${name}] 测速完成: ${delay}ms (${quality})`);
      } else {
        logWarn("节点测速", `节点 [${name}] 测速超时或无法连通 (>3000ms)`);
      }
    } catch (err: any) {
      setDelayMap((prev) => ({ ...prev, [name]: null }));
      logError("节点测速", `节点 [${name}] 测速异常: ${err?.message || String(err)}`);
    } finally {
      setTestingNodes((prev) => ({ ...prev, [name]: false }));
    }
  };

  // 单节点深度 IP 体检 (体检完成立即将真实出口国家持久化)
  const handleProbeHealth = async (name: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (probingNodes[name]) return;
    setProbingNodes((prev) => ({ ...prev, [name]: true }));
    logInfo("IP健康", `发起单节点深度体检: [${name}]`);
    try {
      let resultItem: IpHealthInfo | null = null;
      await probeNodeHealthBatch([name], (_node, res) => {
        if (res) resultItem = res;
      });
      if (resultItem) {
        const next = { ...healthCache, [name]: resultItem };
        setHealthCache(next);
        savePersistedHealthCache(next, true);

        // 核心：一旦获得真实出口 IP，即刻根据权威国家归类并持久化锁定！
        const realRegion = formatCountryRegionTitle(
          (resultItem as IpHealthInfo).countryCode,
          (resultItem as IpHealthInfo).country
        );
        const nextRegions = { ...persistedNodeRegions, [name]: realRegion };
        setPersistedNodeRegions(nextRegions);
        savePersistedNodeRegions(nextRegions);

        const rInfo = resultItem as IpHealthInfo;
        const riskScore = rInfo.fraudScore !== undefined ? `${rInfo.fraudScore}分` : "无评分";
        logInfo(
          "IP健康",
          `节点 [${name}] 深度体检就绪: IP: ${rInfo.ip} (${rInfo.country || "未知"}${rInfo.city ? " · " + rInfo.city : ""}) | 运营商: ${rInfo.asOrganization || rInfo.asn || "未知"} | 风控分: ${riskScore} | 类型: ${rInfo.isResidential ? "原生住宅" : "数据中心"}`
        );
      } else {
        logWarn("IP健康", `节点 [${name}] 深度体检未能解析到出口画像数据`);
      }
    } catch (err: any) {
      console.error("单节点体检失败:", err);
      logError("IP健康", `节点 [${name}] 深度体检失败: ${err?.message || String(err)}`);
    } finally {
      setProbingNodes((prev) => ({ ...prev, [name]: false }));
    }
  };

  // 全量 IP 纯净体检与真实地区重排
  const handleProbeAllHealth = async () => {
    const targetNames = realNodes.map((n) => n.name);
    if (targetNames.length === 0 || probingAll) return;

    setProbingAll(true);
    setProbeProgress({ completed: 0, total: targetNames.length });

    const probeConcurrency = getStoredHealthProbeConcurrency();
    logInfo(
      "IP健康",
      `启动全量节点深度 IP 体检: 共 ${targetNames.length} 个节点，受控分批执行中 (当前并发度: ${probeConcurrency})...`
    );
    const startAllTime = performance.now();
    let successCount = 0;

    let currentCache = { ...healthCache };
    let currentRegions = { ...persistedNodeRegions };

    try {
      await probeNodeHealthBatch(targetNames, (node, result, completed, total) => {
        setProbeProgress({ completed, total });
        if (result) {
          successCount++;
          currentCache = { ...currentCache, [node]: result };
          setHealthCache({ ...currentCache });
          savePersistedHealthCache(currentCache);

          // 核心：体检完一个节点，立即锁定其真实出口地区并持久化
          const realRegion = formatCountryRegionTitle(result.countryCode, result.country);
          currentRegions = { ...currentRegions, [node]: realRegion };
          setPersistedNodeRegions({ ...currentRegions });
          savePersistedNodeRegions(currentRegions);
        }
      });
      const costMs = Math.round(performance.now() - startAllTime);
      logInfo(
        "IP健康",
        `全量节点深度体检完成 [总耗时: ${costMs}ms]: 成功获取画像 ${successCount}/${targetNames.length} 个节点`
      );
    } catch (err: any) {
      console.error("全量 IP 健康体检出错:", err);
      logError("IP健康", `全量 IP 健康体检异常中断: ${err?.message || String(err)}`);
    } finally {
      setProbingAll(false);
      setProbeProgress(null);
    }
  };

  // 切换当前节点 (全面穿透：同步切换 PROXY、GLOBAL 以及包含该节点的所有主选择策略组，D01: 真实结果校验)
  const handleSelectProxy = async (nodeName: string) => {
    try {
      const targetGroups = groups.filter(
        (g) =>
          g.name === "PROXY" ||
          g.name === "GLOBAL" ||
          ((g.type?.toLowerCase() === "selector" || g.type?.toLowerCase() === "select") &&
            g.all?.includes(nodeName))
      );

      let hasSuccess = false;
      const failedGroups: string[] = [];

      if (targetGroups.length > 0) {
        const results = await Promise.allSettled(
          targetGroups.map((g) => switchProxy(g.name, nodeName))
        );
        results.forEach((res, idx) => {
          if (res.status === "fulfilled" && res.value) {
            hasSuccess = true;
          } else {
            failedGroups.push(targetGroups[idx].name);
          }
        });
      } else if (groups[0]) {
        try {
          const ok = await switchProxy(groups[0].name, nodeName);
          if (ok) hasSuccess = true;
        } catch {
          failedGroups.push(groups[0].name);
        }
      }

      if (!hasSuccess) {
        alert(`切换节点失败：核心拒绝将出口切换为 [${nodeName}]。请检查核心运行状态。`);
        return;
      }

      if (failedGroups.length > 0) {
        console.warn(`部分策略组未切换成功: ${failedGroups.join(", ")}`);
      }

      try {
        localStorage.setItem("netbox_active_node_name", nodeName);
      } catch {}

      window.dispatchEvent(
        new CustomEvent("netbox-active-node-changed", { detail: { nodeName } })
      );
      window.dispatchEvent(new CustomEvent("netbox-route-changed"));

      loadData();
    } catch (err: any) {
      console.error("切换节点失败:", err);
      alert(`切换节点异常: ${err?.message || err}`);
    }
  };

  // 节点多选操作
  const toggleSelectNode = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedNodes((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    );
  };

  // 辅助同步到内核
  const syncRules = async (rules: SmartGroupRule[]) => {
    const specs = rules.map((r) => {
      let candidateNodes: string[] = [];
      if (r.type === "relay") {
        const entry = r.relayEntry?.trim();
        const exit = r.relayExit?.trim();
        candidateNodes = [entry, exit].filter((p): p is string => !!p && p !== "GLOBAL");
      } else if (r.nodeSelectionMode === "manual" && r.manualNodes && r.manualNodes.length > 0) {
        candidateNodes = r.manualNodes.filter((n) => realNodeNames.includes(n));
      } else {
        // 自动圈选模式：实时执行智能匹配与特征排序
        candidateNodes = filterAndSortProxies(realNodeNames, r, healthCache, delayMap);
      }

      // 如果有真实候选节点，使用真实候选节点；若极端情况下为空，使用兜底项，杜绝空组或无效伪组
      const finalProxies =
        candidateNodes.length > 0
          ? candidateNodes
          : r.fallbackChain && r.fallbackChain.length > 0
          ? r.fallbackChain
          : [r.fallbackProxy || "DIRECT"];

      return {
        name: r.name,
        type: r.type,
        proxies: finalProxies,
        tolerance: r.tolerance,
      };
    });
    await syncSmartGroupsToCore(specs);
  };

  // 打包为优选组或中继
  const handleConfirmPack = async () => {
    if (!packName.trim() || selectedNodes.length < 2 || !packModalType) return;
    try {
      const newRule: SmartGroupRule = {
        id: `sg-${Date.now()}`,
        name: packName.trim(),
        type: packModalType === "relay" ? "relay" : "url-test",
        tolerance: 80,
        nodeSelectionMode: "manual",
        manualNodes: selectedNodes,
        relayEntry: packModalType === "relay" ? selectedNodes[0] : undefined,
        relayExit: packModalType === "relay" ? selectedNodes[1] : undefined,
        excludeOffline: true,
        sortByLatency: true,
        fallbackProxy: "DIRECT",
      };

      const updated = [...smartRules, newRule];
      await saveSmartGroups(updated);
      await syncRules(updated);
      setSmartRules(updated);
      setSelectedNodes([]);
      setPackModalType(null);
      setPackName("");
      loadData();
    } catch (err) {
      console.error("打包创建线路失败:", err);
    }
  };

  // 删除自建线路
  const handleDeleteSmartRule = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = smartRules.filter((r) => r.id !== id);
    await saveSmartGroups(updated);
    await syncRules(updated);
    setSmartRules(updated);
  };

  const runSubscriptionAction = async (action: () => Promise<void>, adding = false) => {
    if (subPending.current) return;
    subPending.current = true;
    ++profileReadVersion.current;
    setSubLoading(true);
    setSubError("");
    setAddSubError("");
    setSubNotice("");
    try {
      await action();
    } catch (error) {
      const message = typeof error === "string" ? error : error instanceof Error ? error.message : "订阅操作失败，请重试";
      (adding ? setAddSubError : setSubError)(message);
    } finally {
      subPending.current = false;
      setSubLoading(false);
      setSwitchingProfileId(null);
    }
  };

  const refreshSubscriptions = async (message: string) => {
    setSubNotice(message);
    window.dispatchEvent(new CustomEvent("procweaver-profile-changed"));
    window.dispatchEvent(new CustomEvent("netbox-profile-changed"));
    try { setProfiles(await getProfiles()); }
    catch { setSubError(`${message}，但订阅列表刷新失败，请重新打开订阅管理。`); }
  };

  // 添加订阅：失败保留表单，成功返回抽屉。
  const handleAddSubscription = async () => {
    if (!newSubUrl.trim()) return;
    await runSubscriptionAction(async () => {
      await addProfile(
        newSubName.trim() || `订阅源 #${profiles.length + 1}`,
        newSubUrl.trim()
      );
      setNewSubUrl("");
      setNewSubName("");
      await refreshSubscriptions("订阅已添加，可点击“切换使用”应用此订阅。");
      setShowAddSubModal(false);
    }, true);
  };

  // 更新订阅
  const handleUpdateSubscription = async (id: string) => {
    await runSubscriptionAction(async () => {
      await updateProfile(id);
      await refreshSubscriptions("订阅已更新。");
    });
  };

  const handleSelectSubscription = async (id: string) => {
    if (profiles.find(profile => profile.id === id)?.isSelected) return;
    await runSubscriptionAction(async () => {
      setSwitchingProfileId(id);
      if (!await selectProfile(id)) throw new Error("订阅未能应用，请重试");
      // The backend has applied the configuration; never switch this marker optimistically.
      setProfiles(current => current.map(profile => ({ ...profile, isSelected: profile.id === id })));
      setSelectedNodes([]);
      setDelayMap({});
      await refreshSubscriptions("已切换并应用订阅配置。已有连接仍沿用原连接出口。");
    });
  };

  const handleDeleteSubscription = async (id: string) => {
    if (subPending.current || !window.confirm("确定要删除此订阅配置吗？")) return;
    await runSubscriptionAction(async () => {
      await deleteProfile(id);
      await refreshSubscriptions("订阅已删除。");
    });
  };

  // 节点过滤与排序
  const filteredNodes = useMemo(() => {
    return realNodes
      .filter((n) => {
        // 排除用户主动忽略的节点
        if (ignoredNodes.includes(n.name)) {
          return false;
        }
        if (searchKeyword && !n.name.toLowerCase().includes(searchKeyword.toLowerCase())) {
          return false;
        }
        const delay = delayMap[n.name] ?? n.history?.[n.history.length - 1]?.delay ?? null;
        // 仅当明确测速过且失败超时（<= 0）时才隐藏；未测速（delay === null）绝不隐藏
        if (hideTimeout && delay !== null && delay <= 0) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const delayA = delayMap[a.name] ?? a.history?.[a.history.length - 1]?.delay ?? 999999;
        const delayB = delayMap[b.name] ?? b.history?.[b.history.length - 1]?.delay ?? 999999;
        if (sortBy === "latency-asc") return delayA - delayB;
        if (sortBy === "name-asc") return a.name.localeCompare(b.name);
        return 0;
      });
  }, [realNodes, searchKeyword, hideTimeout, sortBy, delayMap]);

  // 按地区自动归类：优先使用基于真实 IP 体检的持久化结果，未体检的归入待确认真实出口
  const { regionGroups, unprobedCount } = useMemo(() => {
    const map: Record<string, ProxyItem[]> = {};
    let unprobed = 0;

    filteredNodes.forEach((node) => {
      // 1. 优先读取持久化归属（来自以往 IP 体检），等待再次体检前绝不变更！
      const persisted = persistedNodeRegions[node.name];
      if (persisted) {
        if (!map[persisted]) map[persisted] = [];
        map[persisted].push(node);
        return;
      }

      // 2. 检查当前内存/磁盘体检缓存是否有真实国家
      const health = healthCache[node.name];
      if (health && health.countryCode) {
        const title = formatCountryRegionTitle(health.countryCode, health.country);
        if (!map[title]) map[title] = [];
        map[title].push(node);
        return;
      }

      // 3. 首次未体检（无 IP 结果）：统一归入待体检确认真实出口分组
      unprobed++;
      const pendingKey = "⏳ 待确认真实出口";
      if (!map[pendingKey]) map[pendingKey] = [];
      map[pendingKey].push(node);
    });

    const entries = Object.entries(map);
    // 排序：先展示待确认组（如果有的话），接着按国家规范展示
    entries.sort(([a], [b]) => {
      if (a.startsWith("⏳")) return -1;
      if (b.startsWith("⏳")) return 1;
      return a.localeCompare(b, "zh-CN");
    });

    return { regionGroups: entries, unprobedCount: unprobed };
  }, [filteredNodes, persistedNodeRegions, healthCache]);

  // 自动将二级真实国家/地区节点及实时延迟同步至系统托盘二级菜单
  useEffect(() => {
    if (realNodes.length > 0) {
      const rawNodes: RawNodeForTray[] = realNodes.map((n) => {
        const persisted = persistedNodeRegions[n.name];
        const health = healthCache[n.name];
        return {
          name: n.name,
          type: n.type,
          delay: delayMap[n.name] ?? n.history?.[n.history.length - 1]?.delay ?? null,
          countryCode: health?.countryCode,
          country: persisted || health?.country,
        };
      });

      const groups = buildCategorizedTrayGroups(rawNodes, activeNodeName);
      if (groups.length > 0) {
        setGlobalTrayGroups(groups);
      }
    }
  }, [realNodes, delayMap, activeNodeName, persistedNodeRegions, healthCache]);

  // 监听系统托盘“👉 查看全部该地区节点...”菜单事件，自动定位并过滤该地区
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<string>("procweaver-filter-region", (event) => {
        const raw = event.payload || "";
        const cleanKeyword = raw.replace(/[^\u4e00-\u9fa5a-zA-Z]/g, "").replace(/中国/g, "").trim() || raw;
        setSearchKeyword(cleanKeyword);
      }).then((fn) => {
        unlisten = fn;
      });
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-slate-50 dark:bg-slate-950 transition-colors duration-200 relative">
      {/* 顶栏控制台 */}
      <div className="px-6 py-3.5 border-b border-slate-200/90 dark:border-slate-800/80 bg-white/70 dark:bg-slate-900/40 backdrop-blur-md flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center space-x-2.5 flex-1 min-w-[280px] max-w-md">
          {/* 搜索框 */}
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="搜索节点名称、地区、协议..."
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80 rounded-xl focus:outline-hidden focus:border-indigo-500 transition"
            />
            {searchKeyword && (
              <button
                type="button"
                onClick={() => setSearchKeyword("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* 排序筛选 */}
          <div className="flex items-center space-x-1.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                const next = !hideTimeout;
                setHideTimeout(next);
                try {
                  localStorage.setItem("netbox_hide_timeout_nodes", String(next));
                } catch {}
              }}
              className={`px-2.5 py-1.5 text-xs rounded-xl border font-medium transition cursor-pointer ${
                hideTimeout
                  ? "bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-600/15 dark:text-indigo-400 dark:border-indigo-500/30"
                  : "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700"
              }`}
              title="过滤测速超时的无效节点"
            >
              排除超时
            </button>
          </div>
        </div>

        {/* 右侧动作区 */}
        <div className="flex items-center space-x-2">
          {/* 一键全量测速 */}
          <button
            type="button"
            onClick={handleTestAll}
            disabled={testingAll || realNodes.length === 0}
            className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 text-xs font-semibold transition shadow-2xs disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${testingAll ? "animate-spin text-indigo-500" : ""}`} />
            <span>{testingAll ? "全量测速中..." : "全量测速"}</span>
          </button>

          {/* 一键全量 IP 健康体检 */}
          <button
            type="button"
            onClick={handleProbeAllHealth}
            disabled={probingAll || realNodes.length === 0}
            className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-purple-50 hover:bg-purple-100 text-purple-700 dark:bg-purple-600/15 dark:hover:bg-purple-600/25 dark:text-purple-300 border border-purple-200 dark:border-purple-800/60 text-xs font-semibold transition shadow-2xs disabled:opacity-50 cursor-pointer"
            title="通过真实出口检测各个节点的实际落地国家、原生性与欺诈风险并持久化归类"
          >
            <Shield className={`w-3.5 h-3.5 ${probingAll ? "animate-spin text-purple-600 dark:text-purple-400" : "text-purple-500"}`} />
            <span>
              {probingAll
                ? `体检中 ${probeProgress?.completed || 0}/${probeProgress?.total || realNodes.length}`
                : "全量 IP 体检"}
            </span>
          </button>

          {/* 查看测速与体检日志快捷入口 */}
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("netbox-navigate-tab", { detail: "logs" })
              );
            }}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 text-xs font-semibold transition shadow-2xs cursor-pointer"
            title="查看测速、IP 体检与网络运行日志"
          >
            <ScrollText className="w-3.5 h-3.5 text-indigo-500" />
            <span>测速/IP日志</span>
          </button>

          {/* 订阅管理抽屉唤起 */}
          <button
            type="button"
            onClick={() => {
              setSubDrawerOpen(true);
              void runSubscriptionAction(async () => { setProfiles(await getProfiles()); });
            }}
            className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-600 dark:bg-indigo-600/15 dark:hover:bg-indigo-600/25 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-500/30 text-xs font-semibold transition shadow-2xs cursor-pointer"
          >
            <Radio className="w-3.5 h-3.5" />
            <span>订阅管理</span>
            {profiles.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-indigo-200/80 dark:bg-indigo-500/40 font-mono">
                {profiles.length}
              </span>
            )}
          </button>

          {/* 新建智能线路 */}
          <button
            type="button"
            onClick={() => {
              setEditingRule(null);
              setSmartModalOpen(true);
            }}
            className="flex items-center space-x-1 px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/20 transition cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新建自建线路</span>
          </button>
        </div>
      </div>

      {/* 主工作区滚动面板 */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* 节点订阅账号状态看板 (由伪节点提炼为纯净看板) */}
        {(subMeta.remainingTraffic || subMeta.expireDate || subMeta.resetDays) && (
          <div className="p-3.5 rounded-2xl bg-gradient-to-r from-indigo-500/10 via-purple-500/10 to-sky-500/10 border border-indigo-200/80 dark:border-indigo-500/30 flex flex-wrap items-center justify-between gap-3 shadow-2xs">
            <div className="flex items-center space-x-2.5">
              <div className="p-1.5 rounded-xl bg-indigo-500/20 text-indigo-600 dark:text-indigo-400">
                <Radio className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-white">节点订阅状态看板</h4>
                <p className="text-[10px] text-slate-500 dark:text-slate-400">已智能排除信息占位伪节点，归纳为订阅摘要</p>
              </div>
            </div>

            <div className="flex items-center space-x-3 text-xs font-mono">
              {subMeta.remainingTraffic && (
                <div className="flex items-center space-x-1.5 px-3 py-1 rounded-xl bg-white/80 dark:bg-slate-900/80 border border-indigo-200 dark:border-indigo-800">
                  <span className="text-[10px] text-slate-400 font-sans">剩余流量:</span>
                  <span className="font-bold text-indigo-600 dark:text-indigo-400">{subMeta.remainingTraffic}</span>
                </div>
              )}
              {subMeta.expireDate && (
                <div className="flex items-center space-x-1.5 px-3 py-1 rounded-xl bg-white/80 dark:bg-slate-900/80 border border-purple-200 dark:border-purple-800">
                  <span className="text-[10px] text-slate-400 font-sans">套餐到期:</span>
                  <span className="font-bold text-purple-600 dark:text-purple-400">{subMeta.expireDate}</span>
                </div>
              )}
              {subMeta.resetDays && (
                <div className="flex items-center space-x-1.5 px-3 py-1 rounded-xl bg-white/80 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800">
                  <span className="text-[10px] text-slate-400 font-sans">下次重置:</span>
                  <span className="font-bold text-slate-700 dark:text-slate-300">{subMeta.resetDays}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 板块一：自建核心线路区 */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center space-x-2">
              <Zap className="w-4 h-4 text-indigo-500" />
              <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 tracking-wide uppercase">
                自建核心线路 (智能优选 / 双跳中继)
              </h3>
              <span className="text-[11px] text-slate-400 font-mono">({smartRules.length})</span>
            </div>
          </div>

          {smartRules.length === 0 ? (
            <div className="p-4 rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 text-center text-xs text-slate-500 dark:text-slate-400">
              <span>暂无自建线路。您可以在下方节点库中勾选多个节点，在底部操作栏一键打包为“自动优选组”或“中继链”。</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {smartRules.map((rule) => {
                const isRelay = rule.type === "relay";
                const isActive = activeNodeName === rule.name;
                const matchedCount = isRelay
                  ? rule.relayEntry && rule.relayExit
                    ? 2
                    : 0
                  : rule.nodeSelectionMode === "manual"
                  ? rule.manualNodes?.length || 0
                  : filterAndSortProxies(realNodeNames, rule, healthCache, delayMap).length;

                return (
                  <div
                    key={rule.id}
                    onClick={() => handleSelectProxy(rule.name)}
                    className={`p-4 rounded-2xl transition-all cursor-pointer group select-none border relative flex flex-col justify-between ${
                      isActive
                        ? "bg-emerald-50/80 border-emerald-500 dark:bg-emerald-600/15 dark:border-emerald-500 shadow-xs ring-1 ring-emerald-500/50"
                        : "bg-white/90 dark:bg-slate-900/80 border-slate-200/90 dark:border-slate-800/80 shadow-xs hover:border-indigo-400 dark:hover:border-indigo-500/50"
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center space-x-2 min-w-0 flex-1">
                          <span
                            className={`p-1.5 rounded-lg text-xs ${
                              isRelay
                                ? "bg-purple-100 text-purple-600 dark:bg-purple-500/20 dark:text-purple-400"
                                : "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-400"
                            }`}
                          >
                            {isRelay ? <Link2 className="w-3.5 h-3.5" /> : <Zap className="w-3.5 h-3.5" />}
                          </span>
                          <span className="text-xs font-bold text-slate-900 dark:text-white truncate" title={rule.name}>
                            {rule.name}
                          </span>
                        </div>
                        <div className="flex items-center space-x-1.5 shrink-0">
                          {isActive ? (
                            <span className="flex items-center space-x-0.5 px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold">
                              <Check className="w-3 h-3" />
                              <span>使用中</span>
                            </span>
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 opacity-70 group-hover:opacity-100 transition font-medium">
                              点击启用
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteSmartRule(rule.id, e);
                            }}
                            title="删除该自建线路"
                            className="p-1 rounded-md text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="text-[11px] text-slate-500 dark:text-slate-400 space-y-1">
                        {isRelay ? (
                          <div className="flex items-center space-x-1 text-xs">
                            <span className="truncate max-w-[110px]">{rule.relayEntry || "入口"}</span>
                            <span>➔</span>
                            <span className="truncate max-w-[110px] font-semibold text-purple-500">
                              {rule.relayExit || "出口"}
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-medium text-slate-700 dark:text-slate-300">
                              成员节点: <b className="font-mono text-indigo-600 dark:text-indigo-400">{matchedCount}</b> 个
                            </span>
                            <span className="text-indigo-500 font-mono text-[10px] uppercase">
                              {rule.type} 智能优选
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 板块二：基础节点库 */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center space-x-2">
              <Globe className="w-4 h-4 text-indigo-500" />
              <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 tracking-wide uppercase">
                基础节点池大盘 (按真实出口 IP 归属持久化)
              </h3>
              <span className="text-[11px] text-slate-400 font-mono">({filteredNodes.length} 可用)</span>
            </div>
          </div>

          {/* 首次无 IP 体检体验或存在未确认节点提示横幅 */}
          {unprobedCount > 0 && (
            <div className="mb-3.5 p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-900 dark:text-amber-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-start space-x-2.5 max-w-[80%]">
                <div className="p-1.5 rounded-xl bg-amber-500/20 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5">
                  <AlertCircle className="w-4 h-4" />
                </div>
                <div className="space-y-0.5">
                  <div className="flex items-center space-x-2">
                    <span className="text-xs font-bold">检测到 {unprobedCount} 个节点尚未体检真实出口 IP</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-amber-500/20 font-mono">出口待核验</span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
                    因部分中继节点名与实际出口国家不符，建议点击右侧【全量 IP 体检】，系统将按真实国家重新划分大盘并自动持久化锁定。
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={handleProbeAllHealth}
                disabled={probingAll}
                className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold transition shadow-xs cursor-pointer shrink-0"
              >
                <Shield className="w-3.5 h-3.5" />
                <span>{probingAll ? "体检中..." : "一键体检确认"}</span>
              </button>
            </div>
          )}

          {regionGroups.length === 0 ? (
            <div className="p-8 rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 text-center space-y-3">
              <Radio className="w-8 h-8 text-slate-300 mx-auto" />
              <p className="text-xs text-slate-500">未找到匹配的节点，请尝试清空筛选词或前往【订阅管理】导入节点订阅。</p>
              <button
                type="button"
                onClick={() => setSubDrawerOpen(true)}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow transition"
              >
                立即添加订阅
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              {regionGroups.map(([regionTitle, nodes]) => (
                <div key={regionTitle} className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300 pb-1 border-b border-slate-200/80 dark:border-slate-800/60">
                    <div className="flex items-center space-x-2">
                      <span>{regionTitle}</span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-200/80 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-mono">
                        {nodes.length}
                      </span>
                    </div>

                    {/* 待确认真实出口分组提供【一键忽略本组】 */}
                    {regionTitle.startsWith("⏳") && (
                      <button
                        type="button"
                        onClick={(e) => handleIgnoreAllUnprobed(nodes, e)}
                        className="flex items-center space-x-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-600 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 transition cursor-pointer"
                        title="一键忽略这批尚未确认真实出口的节点，从大盘隐藏且不再提示"
                      >
                        <EyeOff className="w-3.5 h-3.5 text-slate-400" />
                        <span>忽略本组</span>
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5">
                    {nodes.map((node) => {
                      const isSelected = selectedNodes.includes(node.name);
                      const isActive = activeNodeName === node.name;
                      const delay = delayMap[node.name] ?? node.history?.[node.history.length - 1]?.delay ?? null;
                      const isTesting = testingNodes[node.name];
                      const isProbing = probingNodes[node.name];
                      const health = healthCache[node.name];
                      const mult = parseMultiplier(node.name);
                      const realCountry = persistedNodeRegions[node.name];

                      return (
                        <div
                          key={node.name}
                          onClick={() => handleSelectProxy(node.name)}
                          className={`p-3 rounded-2xl border transition-all cursor-pointer relative group flex flex-col justify-between select-none ${
                            isActive
                              ? "bg-emerald-50/80 border-emerald-500 dark:bg-emerald-600/15 dark:border-emerald-500 shadow-xs ring-1 ring-emerald-500/50"
                              : isSelected
                              ? "bg-indigo-50/70 border-indigo-400 dark:bg-indigo-600/15 dark:border-indigo-500 shadow-2xs"
                              : "bg-white/80 dark:bg-slate-900/60 border-slate-200/80 dark:border-slate-800/80 hover:border-indigo-300 dark:hover:border-slate-700 hover:shadow-xs"
                          }`}
                        >
                          {/* 节点第一行：勾选框、名称与活动徽章 */}
                          <div className="flex items-start justify-between space-x-2 mb-2">
                            <div className="flex items-center space-x-2 min-w-0 flex-1">
                              <button
                                type="button"
                                onClick={(e) => toggleSelectNode(node.name, e)}
                                title={isSelected ? "取消勾选" : "勾选以打包为线路"}
                                className="text-slate-400 hover:text-indigo-600 transition shrink-0"
                              >
                                {isSelected ? (
                                  <CheckSquare className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                                ) : (
                                  <Square className="w-3.5 h-3.5 opacity-40 group-hover:opacity-100 transition" />
                                )}
                              </button>
                              <span className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate flex-1" title={node.name}>
                                {node.name}
                              </span>
                            </div>
                            {isActive && (
                              <span className="flex items-center space-x-0.5 px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold shrink-0">
                                <Check className="w-3 h-3" />
                                <span>使用中</span>
                              </span>
                            )}
                          </div>

                          {/* 节点第二行：协议、倍率、真实出口与体检/测速/忽略 */}
                          <div className="flex items-center justify-between text-[11px] pt-1 border-t border-slate-100 dark:border-slate-800/40">
                            <div className="flex items-center space-x-1.5 flex-wrap gap-y-1">
                              <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 font-mono">
                                {node.type}
                              </span>
                              {mult !== null && (
                                <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400 font-mono font-bold">
                                  {formatMultiplier(mult)}
                                </span>
                              )}
                              {realCountry ? (
                                <span
                                  className="text-[10px] px-1.5 py-0.2 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium"
                                  title={`真实出口 IP: ${health?.ip || "已验证"} (${realCountry})`}
                                >
                                  {realCountry}
                                </span>
                              ) : (
                                <span
                                  className="inline-flex items-center space-x-0.5 text-[10px] px-1.5 py-0.2 rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-300 font-medium"
                                  title="该节点尚未进行过真实出口 IP 体检"
                                >
                                  <Shield className="w-2.5 h-2.5 opacity-80" />
                                  <span>未体检</span>
                                </span>
                              )}
                              {health && health.fraudScore !== undefined && (
                                <span
                                  className={`text-[10px] px-1 py-0.2 rounded-md font-mono ${
                                    health.fraudScore <= 25
                                      ? "text-emerald-500 bg-emerald-500/10"
                                      : health.fraudScore <= 60
                                      ? "text-amber-500 bg-amber-500/10"
                                      : "text-rose-500 bg-rose-500/10"
                                  }`}
                                  title={`欺诈风险分: ${health.fraudScore}`}
                                >
                                  {health.fraudScore}分
                                </span>
                              )}
                            </div>

                            {/* 操作区：⚡ 单节点测速、🛡️ 单节点体检、🙈 忽略本节点 */}
                            <div className="flex items-center space-x-1 shrink-0 ml-1">
                              {/* 延迟数字与单测速 */}
                              <button
                                type="button"
                                onClick={(e) => handleTestNode(node.name, e)}
                                disabled={isTesting}
                                title={delay === null ? "尚未测速，点击为此节点测速" : "单独为此节点测速"}
                                className={`inline-flex items-center space-x-0.5 px-1.5 py-0.5 rounded-md text-[11px] font-mono font-semibold transition cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 ${
                                  isTesting
                                    ? "text-indigo-500 animate-pulse"
                                    : delay === null
                                    ? "text-slate-400 bg-slate-100/80 dark:bg-slate-800/60"
                                    : delay <= 0
                                    ? "text-rose-500 bg-rose-50 dark:bg-rose-950/30"
                                    : delay < 200
                                    ? "text-emerald-500"
                                    : delay < 500
                                    ? "text-amber-500"
                                    : "text-rose-500"
                                }`}
                              >
                                <Zap className={`w-3 h-3 ${isTesting ? "animate-bounce text-indigo-500" : delay === null ? "text-slate-400" : "text-amber-500"}`} />
                                <span>{isTesting ? "测速中" : delay === null ? "未测速" : delay <= 0 ? "超时" : `${delay}ms`}</span>
                              </button>

                              {/* 单节点 IP 体检入口 */}
                              <button
                                type="button"
                                onClick={(e) => handleProbeHealth(node.name, e)}
                                disabled={isProbing}
                                title="单节点 IP 深度体检并锁定真实出口国家"
                                className="p-1 rounded-md text-slate-400 hover:text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-950/40 transition cursor-pointer"
                              >
                                <Shield className={`w-3.5 h-3.5 ${isProbing ? "animate-spin text-purple-600" : ""}`} />
                              </button>

                              {/* 忽略节点按钮 */}
                              <button
                                type="button"
                                onClick={(e) => handleIgnoreNode(node.name, e)}
                                title="忽略此节点（大盘隐藏且不再警告）"
                                className="p-1 rounded-md text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition cursor-pointer opacity-30 group-hover:opacity-100"
                              >
                                <EyeOff className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 底部已忽略节点折叠查看栏 */}
          {ignoredNodes.length > 0 && (
            <div className="mt-6 p-4 rounded-2xl border border-slate-200/90 dark:border-slate-800/80 bg-white/60 dark:bg-slate-900/40 backdrop-blur-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <EyeOff className="w-4 h-4 text-slate-400" />
                  <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300">
                    已忽略的节点 ({ignoredNodes.length})
                  </h4>
                  <span className="text-[10px] text-slate-400">已从大盘与体检提示中隐藏</span>
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIgnoredNodes([]);
                      saveIgnoredNodes([]);
                    }}
                    className="px-2.5 py-1 text-xs font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 hover:underline cursor-pointer"
                  >
                    全部恢复
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowIgnoredDrawer(!showIgnoredDrawer)}
                    className="px-2.5 py-1 text-xs rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition cursor-pointer"
                  >
                    {showIgnoredDrawer ? "收起" : "展开查看"}
                  </button>
                </div>
              </div>

              {showIgnoredDrawer && (
                <div className="mt-3 pt-3 border-t border-slate-200/80 dark:border-slate-800/60 flex flex-wrap gap-2 max-h-48 overflow-y-auto">
                  {ignoredNodes.map((name) => (
                    <div
                      key={name}
                      className="flex items-center space-x-1.5 px-2.5 py-1 rounded-xl bg-slate-100 dark:bg-slate-800/80 text-xs text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700/60"
                    >
                      <span className="truncate max-w-[200px]" title={name}>{name}</span>
                      <button
                        type="button"
                        onClick={(e) => handleUnignoreNode(name, e)}
                        title="恢复显示到大盘"
                        className="text-slate-400 hover:text-emerald-500 cursor-pointer p-0.5"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 底部悬浮操作栏：当勾选多节点时出现 */}
      {selectedNodes.length >= 2 && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 bg-slate-900/95 text-white dark:bg-slate-800/95 border border-slate-700 rounded-2xl px-5 py-3 shadow-2xl backdrop-blur-md flex items-center space-x-4 animate-in fade-in slide-in-from-bottom-4 duration-200">
          <div className="flex items-center space-x-2 text-xs font-semibold">
            <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
            <span>已选中 <strong className="text-indigo-400 font-mono">{selectedNodes.length}</strong> 个节点</span>
          </div>

          <div className="h-4 w-px bg-slate-700" />

          {/* 打包为优选组 */}
          <button
            type="button"
            onClick={() => {
              setPackModalType("url-test");
              setPackName("自动优选线路");
            }}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold shadow transition"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>打包为自动优选线路</span>
          </button>

          {/* 打包为中继 */}
          <button
            type="button"
            onClick={() => {
              setPackModalType("relay");
              setPackName("链式双跳中继");
            }}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-xs font-semibold shadow transition"
          >
            <Link2 className="w-3.5 h-3.5" />
            <span>打包为链式中继</span>
          </button>

          <button
            type="button"
            onClick={() => setSelectedNodes([])}
            className="text-xs text-slate-400 hover:text-white transition"
          >
            取消选择
          </button>
        </div>
      )}

      {/* 快速打包起名弹窗 */}
      {packModalType && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 space-y-4 shadow-2xl">
            <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              {packModalType === "relay" ? <Link2 className="w-4 h-4 text-purple-500" /> : <Zap className="w-4 h-4 text-indigo-500" />}
              <span>{packModalType === "relay" ? "打包创建中继线路" : "打包创建自动优选线路"}</span>
            </h4>
            <div className="space-y-2">
              <label className="text-xs text-slate-500">为新线路命名：</label>
              <input
                type="text"
                value={packName}
                onChange={(e) => setPackName(e.target.value)}
                placeholder="例如：香港超快优选"
                className="w-full px-3 py-2 text-xs rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700"
              />
              <p className="text-[11px] text-slate-400">
                {packModalType === "relay"
                  ? `将以【${selectedNodes[0]}】为入口前置，以【${selectedNodes[1]}】为落地出口。`
                  : `系统将在所选的 ${selectedNodes.length} 个节点中自动秒选延迟最低的节点。`}
              </p>
            </div>
            <div className="flex justify-end space-x-2 pt-2">
              <button
                type="button"
                onClick={() => setPackModalType(null)}
                className="px-3.5 py-1.5 rounded-xl text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleConfirmPack}
                className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
              >
                确认创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 侧边订阅管理抽屉 (Slide-over Drawer) */}
        <dialog
          ref={subDrawer}
          aria-labelledby="subscription-drawer-title"
          aria-busy={subLoading}
          onCancel={event => { event.preventDefault(); closeSubscriptionDialog(false); }}
          onPointerDown={event => { backdropPressed.current = event.target; }}
          onClick={event => closeSubscriptionBackdrop(event, false)}
          className="fixed inset-0 m-0 ml-auto h-[100dvh] max-h-none w-full max-w-md p-0 overflow-hidden bg-transparent text-slate-800 dark:text-slate-100 backdrop:bg-slate-900/50"
        >
          <div className="w-full max-w-md bg-white dark:bg-slate-900 h-full shadow-2xl flex flex-col justify-between border-l border-slate-200 dark:border-slate-800 animate-in slide-in-from-right duration-200">
            {/* 抽屉顶部 */}
            <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center space-x-2.5">
                <Radio className="w-4 h-4 text-indigo-500" />
                <h3 id="subscription-drawer-title" className="text-sm font-bold text-slate-900 dark:text-white">订阅源管理</h3>
              </div>
              <button
                type="button"
                aria-label="关闭订阅管理"
                autoFocus
                disabled={subLoading}
                onClick={() => closeSubscriptionDialog(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 抽屉主体：订阅卡片列表 */}
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              <p className="text-xs text-slate-500 dark:text-slate-400">切换会应用该订阅的节点与规则；业务包出口不可用时会保留原订阅并提示重新绑定。</p>
              {subError && <p role="alert" className="text-xs text-red-700 dark:text-red-300 break-words">{subError}</p>}
              {subNotice && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300 break-words">{subNotice}</p>}
              {profiles.length === 0 ? (
                <div className="text-center py-12 text-xs text-slate-400 space-y-2">
                  <p>您尚未添加任何订阅源。</p>
                </div>
              ) : (
                profiles.map((prof) => (
                  <div
                    key={prof.id}
                    className={`p-4 rounded-xl border space-y-2.5 ${prof.isSelected ? "border-indigo-300 dark:border-indigo-600 bg-indigo-50/60 dark:bg-indigo-950/30" : "border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate max-w-[200px]">
                        {prof.name}
                      </span>
                      <div className="flex items-center space-x-1">
                        <button
                          type="button"
                          onClick={() => handleUpdateSubscription(prof.id)}
                          disabled={subLoading}
                          aria-label={`更新订阅：${prof.name}`}
                          title="一键更新该订阅"
                          className="p-1 rounded-md text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/30"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${subLoading ? "animate-spin" : ""}`} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteSubscription(prof.id)}
                          disabled={subLoading}
                          aria-label={`删除订阅：${prof.name}`}
                          title="删除订阅"
                          className="p-1 rounded-md text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        disabled={subLoading || prof.isSelected}
                        aria-label={`${prof.isSelected ? "正在使用" : "切换使用"}：${prof.name}`}
                        onClick={() => void handleSelectSubscription(prof.id)}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-slate-100 disabled:text-slate-500 dark:disabled:bg-slate-800 dark:disabled:text-slate-400 disabled:cursor-default"
                      >
                        {switchingProfileId === prof.id ? "正在切换…" : prof.isSelected ? "使用中" : "切换使用"}
                      </button>
                    </div>

                    <div className="text-[11px] text-slate-400 flex justify-between">
                      <span>节点数量: {prof.nodeCount || 0} 个</span>
                      {prof.upload !== undefined && (
                        <span>已用: {formatBytes((prof.upload || 0) + (prof.download || 0))}</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* 抽屉底部按钮 */}
            <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60">
              <button
                type="button"
                onClick={() => { setAddSubError(""); setShowAddSubModal(true); }}
                disabled={subLoading}
                className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow transition flex items-center justify-center space-x-2 disabled:opacity-40"
              >
                <Plus className="w-4 h-4" />
                <span>添加新订阅源</span>
              </button>
            </div>
          </div>
        </dialog>

      {/* 添加订阅小弹窗 */}
        <dialog
          ref={addSubDialog}
          aria-labelledby="add-subscription-title"
          aria-busy={subLoading}
          onCancel={event => { event.preventDefault(); closeSubscriptionDialog(true); }}
          onPointerDown={event => { backdropPressed.current = event.target; }}
          onClick={event => closeSubscriptionBackdrop(event, true)}
          className="w-[min(384px,calc(100vw-32px))] max-h-[85dvh] overflow-y-auto p-0 rounded-2xl bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 shadow-2xl backdrop:bg-slate-900/60"
        >
          <form onSubmit={event => { event.preventDefault(); void handleAddSubscription(); }} className="w-full border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
            <h4 id="add-subscription-title" className="text-sm font-bold text-slate-900 dark:text-white">添加订阅链接</h4>
            {addSubError && <p role="alert" className="text-xs text-red-700 dark:text-red-300 break-words">{addSubError}</p>}
            <div className="space-y-3">
              <div>
                <label htmlFor="add-subscription-name" className="text-xs text-slate-500 block mb-1">订阅名称 (选填):</label>
                <input
                  id="add-subscription-name"
                  autoFocus
                  disabled={subLoading}
                  type="text"
                  placeholder="例如：极速专线"
                  value={newSubName}
                  onChange={(e) => setNewSubName(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700"
                />
              </div>
              <div>
                <label htmlFor="add-subscription-url" className="text-xs text-slate-500 block mb-1">订阅链接 (URL):</label>
                <input
                  id="add-subscription-url"
                  disabled={subLoading}
                  type="text"
                  placeholder="https://..."
                  value={newSubUrl}
                  onChange={(e) => setNewSubUrl(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700"
                />
              </div>
            </div>
            <div className="flex justify-end space-x-2 pt-2">
              <button
                type="button"
                disabled={subLoading}
                onClick={() => closeSubscriptionDialog(true)}
                className="px-3.5 py-1.5 rounded-xl text-xs text-slate-500"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={subLoading || !newSubUrl.trim()}
                className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold disabled:opacity-50"
              >
                {subLoading ? "下载中..." : "保存并导入"}
              </button>
            </div>
          </form>
        </dialog>

      {/* 新建/编辑智能线路高级弹窗 */}
      <SmartGroupModal
        isOpen={smartModalOpen}
        onClose={() => setSmartModalOpen(false)}
        editingRule={editingRule}
        allProxyNames={realNodeNames}
        fallbackOptions={smartFallbackOptions}
        onSave={async (savedRule) => {
          const exists = smartRules.some((r) => r.id === savedRule.id);
          const next = exists
            ? smartRules.map((r) => (r.id === savedRule.id ? savedRule : r))
            : [...smartRules, savedRule];
          await saveSmartGroups(next);
          await syncRules(next);
          setSmartRules(next);
          setSmartModalOpen(false);
          loadData();
        }}
      />
    </div>
  );
};
