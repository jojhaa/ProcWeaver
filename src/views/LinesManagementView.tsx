import React, { useState, useEffect, useMemo, useRef } from "react";
import { ProxyGroup, ProxyItem, IpHealthInfo, ProfileItem } from "../types";
import { SmartGroupRule } from "../types/smartGroup";
import { fetchProxies, fetchMihomoConfig, switchProxy, testDelay, getPreferredSpeedTestUrl } from "../api/mihomo";
import { mobileSelectionGroup, selectedLeaf, type MobileCoreMode } from "../utils/mobileNodeSelection";
import { logInfo, logWarn, logError } from "../api/logs";
import {
  getSmartGroups,
  syncSmartGroupsToCore,
  getProfiles,
  addProfile,
  updateProfile,
  deleteProfile,
} from "../api";
import {
  probeNodeHealthBatch,
  getPersistedHealthCache,
  savePersistedHealthCache,
  getPersistedNodeRegions,
  savePersistedNodeRegions,
  flushHealthCache,
  flushNodeRegions,
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
import { VirtualGrid, VirtualGridScroller } from "../components/VirtualGrid";
import { MobileNodeCard } from "../components/MobileNodeCard";
import { createBatchUpdates } from "../utils/batchUpdates";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useProfileSwitch } from "../hooks/useProfileSwitch";
import { ProfileSwitchDialog } from "../components/ProfileSwitchDialog";
import { LocalNodeDialog } from "../components/LocalNodeDialog";
import { useLocalNodes } from "../hooks/useLocalNodes";
import {
  Search,
  RefreshCw,
  Plus,
  Radio,
  Zap,
  Link2,
  Pencil,
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
  ChevronDown,
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

export const LinesManagementView: React.FC<{ coreMode?: MobileCoreMode }> = React.memo(({ coreMode = null }) => {
  const mobile = document.documentElement.dataset.platform === "android";
  const [catalogOffline, setCatalogOffline] = useState(false);
  const [catalogMessage, setCatalogMessage] = useState("");
  const [probeMessage, setProbeMessage] = useState("");
  const readRevision = useRef(0);
  const nodeSession = useRef(0);
  const openSubscriptions = () => {
    if (mobile) window.dispatchEvent(new CustomEvent("netbox-navigate-tab", { detail: "profiles" }));
    else setSubDrawerOpen(true);
  };
  const profileSwitch = useProfileSwitch();
  const localNodes = useLocalNodes();
  const localByAlias = useMemo(() => new Map(localNodes.view?.nodes.map(n => [n.alias, n]) || []), [localNodes.view]);
  const nodeLabel = (name: string) => localByAlias.get(name)?.name || name;
  const [sourceFilter, setSourceFilter] = useState("all");
  const [groups, setGroups] = useState<ProxyGroup[]>([]);
  const [selectionGroup, setSelectionGroup] = useState("");
  const switchingNode = useRef(false);
  const [switchingNodeName, setSwitchingNodeName] = useState<string | null>(null);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [mobileSelecting, setMobileSelecting] = useState(false);
  const [proxies, setProxies] = useState<Record<string, ProxyItem>>({});
  const [delayMap, setDelayMap] = useState<Record<string, number | null>>({});
  const [testingAll, setTestingAll] = useState(false);
  const [testingNodes, setTestingNodes] = useState<Record<string, boolean>>({});
  const [searchKeyword, setSearchKeyword] = useState("");
  const search = useDebouncedValue(searchKeyword, 180);
  const pendingBatches = useRef(new Set<() => void>());
  const pendingJobs = useRef(new Set<AbortController>());
  useEffect(() => {
    const flush = () => {
      pendingBatches.current.forEach(commit => commit());
      flushNodeRegions();
      void flushHealthCache().catch(error => logError("IP健康", `保存体检缓存失败：${String(error)}`));
    };
    const hidden = () => { if (document.hidden) flush(); };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      pendingJobs.current.forEach(job => job.abort()); pendingJobs.current.clear();
      flush(); pendingBatches.current.clear();
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  const [hideTimeout, setHideTimeout] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("netbox_hide_timeout_nodes");
      return saved !== null ? saved === "true" : true;
    } catch {
      return true;
    }
  });
  const [sortBy, setSortBy] = useState<"default" | "latency-asc" | "name-asc">("default");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    if (addMenuOpen) document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [addMenuOpen]);

  // 自建智能策略组规则
  const [smartRules, setSmartRules] = useState<SmartGroupRule[]>([]);
  const [smartModalOpen, setSmartModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<SmartGroupRule | null>(null);
  const smartTrigger = useRef<HTMLButtonElement | null>(null);

  // 节点多选打包
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selectedNodes), [selectedNodes]);
  const [packModalType, setPackModalType] = useState<"url-test" | "relay" | null>(null);
  const [packName, setPackName] = useState("");
  const [packError, setPackError] = useState("");
  const [packSaving, setPackSaving] = useState(false);
  const packPending = useRef(false);
  const packDialog = useRef<HTMLDialogElement>(null);
  const closePack = () => { if (!packPending.current) setPackModalType(null); };
  useEffect(() => {
    setPackError("");
    if (packModalType) packDialog.current?.showModal();
    else packDialog.current?.close();
  }, [packModalType]);

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
  const singleProbeBusy = useRef(false);
  const anySingleProbe = Object.values(probingNodes).some(Boolean);
  const [probeProgress, setProbeProgress] = useState<{ completed: number; total: number } | null>(null);

  // 节点归属国家/地区持久化字典 (nodeName -> "🇯🇵 日本")
  const [persistedNodeRegions, setPersistedNodeRegions] = useState<Record<string, string>>({});

  // 用户主动忽略的节点名称列表 (本地持久化)
  const [ignoredNodes, setIgnoredNodes] = useState<string[]>(() => getIgnoredNodes());
  const ignoredSet = useMemo(() => new Set(ignoredNodes), [ignoredNodes]);
  const [showIgnoredDrawer, setShowIgnoredDrawer] = useState(false);

  // 初始加载
  const loadData = async () => {
    const revision = ++readRevision.current;
    const profileVersion = profileReadVersion.current;
    try {
      const pData = await fetchProxies();
      if (revision !== readRevision.current) return;
      setCatalogOffline(Boolean(pData.offline));
      setCatalogMessage((pData.warnings || []).join("；"));
      setProxies(pData.proxies || {});
      setGroups(pData.groups || []);

      const sRules = await getSmartGroups();
      if (revision !== readRevision.current) return;
      setSmartRules(sRules);

      const savedCache = await getPersistedHealthCache();
      if (revision !== readRevision.current) return;
      const diskCache = mobile ? Object.fromEntries(Object.entries(savedCache).filter(([name, info]) => Boolean(pData.proxies[name]?.catalogKey) && info.catalogKey === pData.proxies[name].catalogKey)) : savedCache;
      if (diskCache) setHealthCache(diskCache);

      const diskRegions = await getPersistedNodeRegions();
      if (revision !== readRevision.current) return;
      const mergedRegions = mobile ? {} as Record<string, string> : { ...diskRegions };
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
      if (revision === readRevision.current) setCatalogMessage(`读取节点失败：${String(err)}`);
      console.error("加载线路管理大盘数据失败:", err);
    }
  };

  useEffect(() => {
    loadData();
    const handleProfileChange = () => {
      nodeSession.current++;
      pendingJobs.current.forEach(job => job.abort());
      pendingBatches.current.forEach(flush => flush());
      setTestingNodes({});
      setDelayMap({});
      setSelectionGroup("");
      void loadData();
    };
    const handleHealthUpdated = (e: any) => {
      const { node, health } = e.detail || {};
      if (node && health) {
        setHealthCache((prev) => ({ ...prev, [node]: health }));
      }
    };
    window.addEventListener("procweaver-profile-changed", handleProfileChange);
    window.addEventListener("netbox-core-status-changed", handleProfileChange);
    window.addEventListener("netbox-node-health-updated", handleHealthUpdated);
    return () => {
      window.removeEventListener("procweaver-profile-changed", handleProfileChange);
      window.removeEventListener("netbox-core-status-changed", handleProfileChange);
      readRevision.current++;
      nodeSession.current++;
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
    for (const node of localNodes.view?.nodes || []) {
      if (!list.some(p => p.name === node.alias)) list.push({ name: node.alias, type: node.protocol, udp: false, history: [] });
    }
    return list;
  }, [proxies, localNodes.view]);

  const realNodeNames = useMemo(() => realNodes.map((n) => n.name), [realNodes]);
  const smartFallbackOptions = useMemo(() => ["DIRECT", "REJECT", ...realNodeNames], [realNodeNames]);
  const smartCounts = useMemo(() => Object.fromEntries(smartRules.map(rule => [rule.id,
    rule.type === "relay" ? (rule.relayEntry && rule.relayExit ? 2 : 0)
      : rule.nodeSelectionMode === "manual" ? rule.manualNodes?.length || 0 : filterAndSortProxies(realNodeNames, rule, healthCache, delayMap).length,
  ])), [smartRules, realNodeNames, healthCache, delayMap]);

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
    if (mobile) return selectedLeaf(groups, mobileSelectionGroup(groups, coreMode, selectionGroup));
    const mainGroup = groups.find((g) => g.name === "PROXY" || g.name === "GLOBAL") || groups[0];
    return mainGroup?.now || "";
  }, [groups, mobile, coreMode, selectionGroup]);

  // 全量测速
  const handleTestAll = async () => {
    if (testingAll || realNodes.length === 0) return;
    setTestingAll(true);
    const job = new AbortController(); pendingJobs.current.add(job);
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
    const batch = createBatchUpdates<{ node: string; testing: boolean; delay?: number | null }>(results => {
      const statuses: Record<string, boolean> = {}, delays: Record<string, number | null> = {};
      for (const result of results) {
        statuses[result.node] = result.testing;
        if (result.delay !== undefined) delays[result.node] = result.delay;
      }
      setTestingNodes(previous => ({ ...previous, ...statuses }));
      if (Object.keys(delays).length) setDelayMap(previous => ({ ...previous, ...delays }));
    });
    pendingBatches.current.add(batch.flush);

    // 分批受控并发测速（使用用户设置的并发度，防止 20000ms 超时）
    const queue = [...targetNodes];
    const runWorker = async () => {
      while (queue.length > 0 && !job.signal.aborted) {
        const node = queue.shift();
        if (!node) break;
        batch.add({ node, testing: true });
        try {
          const delay = await testDelay(node, testEndpoint, 3000);
          if (job.signal.aborted) break;
          batch.add({ node, testing: false, delay: delay ?? 0 });
          if (delay !== null && delay > 0) {
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
          if (job.signal.aborted) break;
          batch.add({ node, testing: false, delay: 0 });
          timeoutCount++;
        } finally {
          if (!job.signal.aborted) batch.add({ node, testing: false });
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => runWorker());
    await Promise.all(workers);
    batch.flush();
    pendingBatches.current.delete(batch.flush);
    pendingJobs.current.delete(job);
    setTestingAll(false);

    const costBatchMs = Math.round(performance.now() - startBatchTime);
    const avgDelay = successCount > 0 ? Math.round(totalDelay / successCount) : 0;
    const fastestSummary = fastestNode ? `最快: [${fastestNode}] (${fastestDelay}ms)` : "无可用节点";

    logInfo(
      "批量测速",
      `批量测速${job.signal.aborted ? "已停止" : "全部完成"} [总耗时: ${costBatchMs}ms]: 成功 ${successCount} 个, 超时 ${timeoutCount} 个 | ${fastestSummary} | 平均延迟: ${avgDelay}ms`
    );
  };

  // 单节点测速
  const handleTestNode = async (name: string, e?: React.MouseEvent) => {
    if (catalogOffline) { setCatalogMessage("延迟测速需要先连接 VPN；IP 体检可以独立运行。"); return; }
    e?.stopPropagation();
    if (testingAll || testingNodes[name]) return;
    const revision = nodeSession.current;
    setTestingNodes((prev) => ({ ...prev, [name]: true }));
    const testEndpoint = getPreferredSpeedTestUrl() || "https://cp.cloudflare.com/generate_204";
    logInfo("节点测速", `发起单节点延迟测速: [${name}] -> 目标: ${testEndpoint}`);
    try {
      const delay = await testDelay(name, testEndpoint, 3000);
      if (revision !== nodeSession.current) return;
      setDelayMap((prev) => ({ ...prev, [name]: delay ?? 0 }));
      if (delay !== null && delay > 0) {
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
      if (revision !== nodeSession.current) return;
      setDelayMap((prev) => ({ ...prev, [name]: 0 }));
      logError("节点测速", `节点 [${name}] 测速异常: ${err?.message || String(err)}`);
    } finally {
      if (revision === nodeSession.current) setTestingNodes((prev) => ({ ...prev, [name]: false }));
    }
  };

  // 单节点深度 IP 体检 (体检完成立即将真实出口国家持久化)
  const handleProbeHealth = async (name: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (probingAll || singleProbeBusy.current) return;
    singleProbeBusy.current = true;
    setProbeMessage("");
    const job = new AbortController(); pendingJobs.current.add(job);
    setProbingNodes((prev) => ({ ...prev, [name]: true }));
    logInfo("IP健康", `发起单节点深度体检: [${name}]`);
    try {
      let resultItem: IpHealthInfo | null = null;
      await probeNodeHealthBatch([name], (_node, res, _completed, _total, error) => {
        if (res) resultItem = { ...res, catalogKey: proxies[name]?.catalogKey };
        else setProbeMessage(`${nodeLabel(name)}：${error || "未获取到有效出口 IP"}`);
      }, job.signal);
      if (job.signal.aborted) return;
      if (resultItem) {
        const next = { ...healthCache, [name]: resultItem };
        setHealthCache(next);
        await savePersistedHealthCache(next, true);

        // 核心：一旦获得真实出口 IP，即刻根据权威国家归类并持久化锁定！
        const realRegion = formatCountryRegionTitle(
          (resultItem as IpHealthInfo).countryCode,
          (resultItem as IpHealthInfo).country
        );
        const nextRegions = { ...persistedNodeRegions, [name]: realRegion };
        setPersistedNodeRegions(nextRegions);
        savePersistedNodeRegions(nextRegions);

        const rInfo = resultItem as IpHealthInfo;
        const riskScore = rInfo.fraudScore != null ? `${rInfo.fraudScore}分` : "无评分";
        logInfo(
          "IP健康",
          `节点 [${name}] 深度体检就绪: IP: ${rInfo.ip} (${rInfo.country || "未知"}${rInfo.city ? " · " + rInfo.city : ""}) | 运营商: ${rInfo.asOrganization || rInfo.asn || "未知"} | 风控分: ${riskScore} | 类型: ${rInfo.isResidential == null ? "未知" : rInfo.isResidential ? "原生住宅" : "数据中心"}`
        );
      } else {
        logWarn("IP健康", `节点 [${name}] 深度体检未能解析到出口画像数据`);
      }
    } catch (err: any) {
      setProbeMessage(`体检失败：${String(err)}`);
      console.error("单节点体检失败:", err);
      logError("IP健康", `节点 [${name}] 深度体检失败: ${err?.message || String(err)}`);
    } finally {
      pendingJobs.current.delete(job);
      singleProbeBusy.current = false;
      setProbingNodes((prev) => ({ ...prev, [name]: false }));
    }
  };

  // 全量 IP 纯净体检与真实地区重排
  const handleProbeAllHealth = async (requestedNames?: string[]) => {
    const targetNames = realNodes.filter(n => !ignoredSet.has(n.name) && (!requestedNames || requestedNames.includes(n.name))).map(n => n.name);
    if (targetNames.length === 0 || probingAll || singleProbeBusy.current) return;

    setProbingAll(true);
    setProbeMessage("");
    const job = new AbortController(); pendingJobs.current.add(job);
    setProbeProgress({ completed: 0, total: targetNames.length });
    const failures: string[] = [];

    const probeConcurrency = getStoredHealthProbeConcurrency();
    logInfo(
      "IP健康",
      `启动全量节点深度 IP 体检: 共 ${targetNames.length} 个节点，受控分批执行中 (当前并发度: ${probeConcurrency})...`
    );
    const startAllTime = performance.now();
    let successCount = 0;

    const currentCache = { ...healthCache };
    const currentRegions = { ...persistedNodeRegions };
    const batch = createBatchUpdates<{ node: string; result: IpHealthInfo | null; completed: number; total: number }>(results => {
      let changed = false;
      for (const { node, result } of results) if (result) {
        currentCache[node] = result;
        currentRegions[node] = formatCountryRegionTitle(result.countryCode, result.country);
        changed = true;
      }
      const last = results[results.length - 1];
      setProbeProgress({ completed: last.completed, total: last.total });
      if (changed) {
        const cache = { ...currentCache }, regions = { ...currentRegions };
        setHealthCache(cache); setPersistedNodeRegions(regions);
        void savePersistedHealthCache(cache);
        savePersistedNodeRegions(regions);
      }
    });
    pendingBatches.current.add(batch.flush);

    try {
      await probeNodeHealthBatch(targetNames, (node, result, completed, total, error) => {
        if (result) result = { ...result, catalogKey: proxies[node]?.catalogKey };
        else if (failures.length < 3) failures.push(`${nodeLabel(node)}：${error || "未获取到有效 IP"}`);
        if (result) successCount++;
        batch.add({ node, result, completed, total });
      }, job.signal);
      const costMs = Math.round(performance.now() - startAllTime);
      setProbeMessage(job.signal.aborted ? "体检已取消" : `体检完成：成功 ${successCount}，失败 ${targetNames.length - successCount}。${failures.length ? `失败示例：${failures.join("；")}。可单独重试。` : ""}`);
      logInfo(
        "IP健康",
        `全量节点深度体检${job.signal.aborted ? "已停止" : "完成"} [总耗时: ${costMs}ms]: 成功获取画像 ${successCount}/${targetNames.length} 个节点`
      );
    } catch (err: any) {
      console.error("全量 IP 健康体检出错:", err);
      setProbeMessage(`体检未完成：${String(err)}`);
      logError("IP健康", `全量 IP 健康体检异常中断: ${err?.message || String(err)}`);
    } finally {
      batch.flush();
      pendingBatches.current.delete(batch.flush);
      pendingJobs.current.delete(job);
      try { if (!job.signal.aborted) await savePersistedHealthCache({ ...currentCache }, true); }
      catch (error) { logError("IP健康", `保存体检结果失败：${String(error)}`); }
      if (!job.signal.aborted) savePersistedNodeRegions({ ...currentRegions }, true);
      setProbingAll(false);
      setProbeProgress(null);
    }
  };

  // Android 只切换当前模式下明确选择的策略组，保留应用独立出口。
  const handleSelectProxy = async (nodeName: string) => {
    if (catalogOffline) { setCatalogMessage("节点已保存，请先连接 VPN 再切换当前出口。"); return; }
    if (mobile) {
      if (switchingNode.current) return;
      switchingNode.current = true;
      setSwitchingNodeName(nodeName);
      try {
        const [config, catalog] = await Promise.all([fetchMihomoConfig(), fetchProxies()]);
        const group = mobileSelectionGroup(catalog.groups, config?.mode as MobileCoreMode, selectionGroup);
        if (!group) {
          setMobileToolsOpen(true);
          throw new Error(config?.mode === "direct" ? "直连模式无需切换节点，请先切换为规则或全局模式。" : "请选择要切换的策略组，然后重试。");
        }
        if (!group.all?.includes(nodeName)) {
          setMobileToolsOpen(true);
          throw new Error(`策略组 ${group.name} 不包含此节点，请选择对应策略组。`);
        }
        if (!await switchProxy(group.name, nodeName)) throw new Error("核心未接受节点切换，请重试。");
        setCatalogMessage("");
        window.dispatchEvent(new CustomEvent("netbox-active-node-changed", { detail: { nodeName } }));
        window.dispatchEvent(new Event("netbox-route-changed"));
        await loadData();
      } catch (error) { setCatalogMessage(String(error)); }
      finally {
        switchingNode.current = false;
        setSwitchingNodeName(null);
      }
      return;
    }
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
  const toggleSelectNode = (name: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
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
    await syncSmartGroupsToCore(specs, undefined, rules);
  };

  // 打包为优选组或中继
  const handleConfirmPack = async () => {
    if (packPending.current || !packModalType) return;
    setPackError("");
    if (!packName.trim()) { setPackError("请输入新线路名称。"); return; }
    if (selectedNodes.length < 2) { setPackError("请至少选择两个节点。"); return; }
    if (packModalType === "relay" && selectedNodes.length !== 2) { setPackError("链式中继需要正好两个节点。"); return; }
    if (["DIRECT", "REJECT", "GLOBAL", "RULES", "PROXY"].includes(packName.trim()) || groups.some(g => g.name === packName.trim()) || realNodeNames.includes(packName.trim()) || smartRules.some(r => r.name === packName.trim())) {
      setPackError("此名称已被节点、策略组或系统占用，请更换名称。"); return;
    }
    packPending.current = true; setPackSaving(true);
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
      await syncRules(updated);
      setSmartRules(updated);
      setSelectedNodes([]);
      setMobileSelecting(false);
      setPackModalType(null);
      setPackName("");
      loadData();
    } catch (err) {
      setPackError(`创建线路失败：${String(err)}`);
    } finally {
      packPending.current = false; setPackSaving(false);
    }
  };

  // 删除自建线路
  const handleDeleteSmartRule = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = smartRules.filter((r) => r.id !== id);
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
      if (!await profileSwitch.requestSwitch(id)) return;
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
        const local = localByAlias.get(n.name);
        if (sourceFilter === "local" && !local || sourceFilter === "subscription" && local) return false;
        // 排除用户主动忽略的节点
        if (ignoredSet.has(n.name)) {
          return false;
        }
        const region = persistedNodeRegions[n.name];
        const health = healthCache[n.name];
        const country = health?.countryCode ? formatCountryRegionTitle(health.countryCode, health.country) : "";
        if (search && !`${local?.name || n.name} ${n.type} ${region || ""} ${health?.country || ""} ${health?.countryCode || ""} ${country}`.toLowerCase().includes(search.toLowerCase())) {
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
  }, [realNodes, search, hideTimeout, sortBy, delayMap, ignoredSet, sourceFilter, localByAlias, persistedNodeRegions, healthCache]);

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
    if (!mobile && realNodes.length > 0) {
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
    if (mobile) return;
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
    <div className={`${mobile ? "mobile-nodes-page " : ""}flex-1 flex flex-col h-full overflow-hidden bg-slate-50 dark:bg-slate-950 transition-colors duration-200 relative`}>
      {(catalogMessage || (!mobile && catalogOffline) || (probeMessage && (!mobile || (!probingAll && !anySingleProbe))) || (!mobile && (probingAll || anySingleProbe))) && <div role="status" className="mobile-notice mx-3 my-2 shrink-0">
        {!mobile && catalogOffline && <p>节点已从本地订阅读取。连接 VPN 后可切换出口和测速；IP 体检可独立运行。</p>}
        {catalogMessage && <p>{catalogMessage} <button onClick={() => void loadData()}>重新读取</button></p>}
        {probeMessage && (!mobile || (!probingAll && !anySingleProbe)) && <p>{probeMessage}</p>}
        {!mobile && (probingAll || anySingleProbe) && <button onClick={() => { pendingJobs.current.forEach(job => job.abort()); setProbeMessage("正在取消体检…"); }}>取消检测</button>}
      </div>}
      {/* 顶栏控制台 */}
      {mobile ? (
        <div className="mobile-node-toolbar px-3 py-2 border-b border-slate-200/90 dark:border-slate-800/80 bg-white/80 dark:bg-slate-900/60 backdrop-blur-md flex flex-col gap-2 shrink-0">
          {/* 第一行：搜索 + 排除超时 + 排序 */}
          <div className="flex items-center gap-2 w-full">
            <div className="relative flex-1 min-w-0">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="搜索节点"
                placeholder="搜索节点、地区、协议..."
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                className="w-full pl-9 pr-9 py-2 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80 rounded-xl focus:outline-hidden focus:border-indigo-500 transition"
              />
              {searchKeyword && (
                <button
                  type="button"
                  onClick={() => setSearchKeyword("")}
                  aria-label="清空搜索"
                  className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 w-8 h-8 flex items-center justify-center cursor-pointer active:scale-90 transition-transform"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                const next = !hideTimeout;
                setHideTimeout(next);
                try {
                  localStorage.setItem("netbox_hide_timeout_nodes", String(next));
                } catch {}
              }}
              className={`h-9 px-3 text-xs rounded-xl border font-medium transition cursor-pointer shrink-0 active:scale-95 ${
                hideTimeout
                  ? "bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-600/15 dark:text-indigo-400 dark:border-indigo-500/30"
                  : "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700"
              }`}
              title="过滤测速超时的无效节点"
            >
              排除超时
            </button>

            <select
              aria-label="节点排序"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="h-9 px-2 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 shrink-0 font-medium cursor-pointer"
            >
              <option value="default">默认</option>
              <option value="latency-asc">延迟优先</option>
              <option value="name-asc">名称排序</option>
            </select>
          </div>

          {/* 数量与操作在窄屏下自动分行，避免状态被按钮覆盖。 */}
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 text-xs pt-1 border-t border-slate-100 dark:border-slate-800/60 text-slate-500 dark:text-slate-400">
            <div className="flex items-center gap-1.5 min-w-[130px] flex-1 truncate">
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                {filteredNodes.length < realNodes.length ? `${filteredNodes.length}/${realNodes.length}` : `${filteredNodes.length}`} 个节点
              </span>
              <span>·</span>
              <span className="truncate text-[11px]" title={activeNodeName ? nodeLabel(activeNodeName) : "未连接"}>
                {catalogOffline ? "离线模式" : activeNodeName ? `出口: ${nodeLabel(activeNodeName)}` : "未连接"}
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0 ml-auto">
              {unprobedCount > 0 && (
                <button
                  type="button"
                  onClick={() => void handleProbeAllHealth(filteredNodes.filter(n => !persistedNodeRegions[n.name] && !healthCache[n.name]?.countryCode).map(n => n.name))}
                  disabled={probingAll || anySingleProbe}
                  className="h-7 px-2.5 text-xs text-purple-600 dark:text-purple-400 font-semibold flex items-center gap-1 rounded-lg border border-purple-200/80 dark:border-purple-800/60 bg-purple-50/50 dark:bg-purple-950/30 active:scale-95 transition-transform cursor-pointer"
                  title="一键体检待确认真实出口的节点"
                >
                  <Shield size={12} className={probingAll ? "animate-spin" : ""} />
                  <span>{probingAll ? "体检中" : `${unprobedCount} 待检`}</span>
                </button>
              )}
              <button
                type="button"
                aria-pressed={mobileSelecting}
                onClick={() => { setMobileSelecting(prev => !prev); setSelectedNodes([]); }}
                className={`h-7 px-2.5 rounded-lg border text-xs font-semibold flex items-center gap-1 active:scale-95 transition-transform cursor-pointer ${mobileSelecting ? "bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-950/40 dark:border-indigo-700 dark:text-indigo-300 shadow-xs" : "border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300"}`}
              >
                {mobileSelecting ? "完成" : "多选"}
              </button>
              <button
                type="button"
                onClick={() => setMobileToolsOpen(prev => !prev)}
                className={`h-7 px-2.5 rounded-lg border text-xs font-semibold flex items-center gap-1 transition active:scale-95 cursor-pointer ${
                  mobileToolsOpen
                    ? "bg-indigo-50 border-indigo-200 text-indigo-600 dark:bg-indigo-950/40 dark:border-indigo-800 dark:text-indigo-400"
                    : "bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
                }`}
              >
                {mobileToolsOpen ? "收起工具" : "高级工具"}
              </button>
              <button
                type="button"
                onClick={openSubscriptions}
                className="h-7 px-2.5 rounded-lg border border-indigo-200 dark:border-indigo-800/80 bg-indigo-50/60 dark:bg-indigo-950/40 text-xs text-indigo-600 dark:text-indigo-400 font-semibold flex items-center gap-1 active:scale-95 transition-transform cursor-pointer"
              >
                <Radio size={12} />
                <span>订阅</span>
              </button>
            </div>
          </div>

          {(probingAll || anySingleProbe) && (
            <div role="status" className="flex items-center gap-2 text-[11px] text-purple-700 dark:text-purple-300">
              <Shield size={13} className="animate-spin shrink-0" />
              <span className="truncate flex-1">IP 体检中{probeProgress ? ` ${probeProgress.completed}/${probeProgress.total}` : "…"}</span>
              <button type="button" onClick={() => { pendingJobs.current.forEach(job => job.abort()); setProbeMessage("正在取消体检…"); }} className="font-semibold">取消</button>
            </div>
          )}

          {coreMode === "rule" && groups.some(g => /^(selector|select)$/i.test(g.type)) && !mobileSelectionGroup(groups, coreMode, selectionGroup) && (
            <label className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
              <span className="shrink-0">切换策略组</span>
              <select aria-label="切换策略组" value={selectionGroup} onChange={event => setSelectionGroup(event.target.value)} className="min-w-0 flex-1 rounded-xl border border-amber-300 dark:border-amber-700 bg-white dark:bg-slate-900 px-2 py-1">
                <option value="">请选择</option>
                {groups.filter(g => g.name !== "GLOBAL" && /^(selector|select)$/i.test(g.type)).map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
              </select>
            </label>
          )}

          {/* 高级工具面板（展开时展示） */}
          {mobileToolsOpen && (
            <div className="pt-2 pb-1 border-t border-slate-200/80 dark:border-slate-800/80 space-y-2">
              {coreMode === "rule" && (
                <label className="flex items-center gap-1.5 w-full min-w-0 text-xs text-slate-600 dark:text-slate-300">
                  <span className="shrink-0 font-medium">策略组:</span>
                  <select
                    aria-label="切换策略组"
                    value={mobileSelectionGroup(groups, coreMode, selectionGroup)?.name ?? ""}
                    onChange={event => setSelectionGroup(event.target.value)}
                    className="min-w-0 flex-1 px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800"
                  >
                    <option value="" disabled>请选择策略组</option>
                    {groups.filter(g => g.name !== "GLOBAL" && /^(selector|select)$/i.test(g.type)).map(g => (
                      <option key={g.name} value={g.name}>{g.name}</option>
                    ))}
                  </select>
                </label>
              )}
              <div className="grid grid-cols-2 gap-2">
                <select
                  aria-label="节点来源"
                  value={sourceFilter}
                  onChange={e => setSourceFilter(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 font-medium cursor-pointer"
                >
                  <option value="all">全部来源</option>
                  <option value="subscription">订阅节点</option>
                  <option value="local">本地节点</option>
                </select>
                <button
                  type="button"
                  onClick={handleTestAll}
                  disabled={testingAll || realNodes.length === 0 || catalogOffline}
                  className="w-full flex items-center justify-center space-x-1 px-2.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 text-xs font-semibold disabled:opacity-50 active:scale-95 transition-transform cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${testingAll ? "animate-spin text-indigo-500" : ""}`} />
                  <span>{testingAll ? "测速中…" : "全量测速"}</span>
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={localNodes.busy || !localNodes.view}
                  onClick={localNodes.openNew}
                  className="flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-xl border border-indigo-200 dark:border-indigo-700 text-indigo-600 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/30 text-xs font-semibold disabled:opacity-50 active:scale-95 transition-transform cursor-pointer"
                >
                  <Plus size={13} />
                  <span>新增节点</span>
                </button>
                <button
                  type="button"
                  disabled={localNodes.busy || !localNodes.view}
                  onClick={localNodes.openImport}
                  className="flex items-center justify-center px-2.5 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-300 disabled:opacity-50 active:scale-95 transition-transform cursor-pointer"
                >
                  导入节点
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void handleProbeAllHealth()}
                  disabled={probingAll || anySingleProbe || realNodes.length === 0}
                  className="flex items-center justify-center space-x-1 px-2.5 py-1.5 rounded-xl bg-purple-50 text-purple-700 dark:bg-purple-600/15 dark:text-purple-300 border border-purple-200 dark:border-purple-800/60 text-xs font-semibold disabled:opacity-50 active:scale-95 transition-transform cursor-pointer"
                >
                  <Shield className={`w-3.5 h-3.5 ${probingAll ? "animate-spin text-purple-600 dark:text-purple-400" : "text-purple-500"}`} />
                  <span>{probingAll ? `体检 ${probeProgress?.completed || 0}/${probeProgress?.total || realNodes.length}` : "全量 IP 体检"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent("netbox-navigate-tab", { detail: "logs" }));
                  }}
                  className="flex items-center justify-center space-x-1 px-2.5 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 text-xs font-semibold active:scale-95 transition-transform cursor-pointer"
                >
                  <ScrollText size={13} />
                  <span>查看日志</span>
                </button>
              </div>
              <button
                type="button"
                onClick={(event) => {
                  smartTrigger.current = event.currentTarget;
                  setEditingRule(null);
                  setSmartModalOpen(true);
                }}
                className="w-full flex items-center justify-center space-x-1.5 px-3 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold active:scale-[0.98] transition-transform cursor-pointer shadow-xs"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>新建自建线路</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="px-5 py-2.5 border-b border-slate-200/90 dark:border-slate-800/80 bg-white/70 dark:bg-slate-900/40 backdrop-blur-md flex items-center justify-between gap-3 shrink-0 relative z-20 shadow-2xs overflow-x-auto">
          {/* 左侧：搜索 + 来源筛选 + 超时过滤 + 排序 (单行规整排布，严禁断行错位) */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {/* 搜索框 */}
            <div className="relative flex-1 min-w-[130px] max-w-[220px]">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="搜索节点"
                placeholder="搜索节点名称、地区、协议..."
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                className="w-full pl-9 pr-7 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80 rounded-xl focus:outline-hidden focus:border-indigo-500 transition"
              />
              {searchKeyword && (
                <button
                  type="button"
                  onClick={() => setSearchKeyword("")}
                  aria-label="清空搜索"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-0.5"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* 来源下拉 */}
            <select
              aria-label="节点来源"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium cursor-pointer shrink-0"
            >
              <option value="all">全部来源</option>
              <option value="subscription">仅订阅节点</option>
              <option value="local">仅本地自建</option>
            </select>

            {/* 排除超时 */}
            <button
              type="button"
              onClick={() => {
                const next = !hideTimeout;
                setHideTimeout(next);
                try {
                  localStorage.setItem("netbox_hide_timeout_nodes", String(next));
                } catch {}
              }}
              className={`px-2.5 py-1.5 text-xs rounded-xl border font-medium transition cursor-pointer select-none shrink-0 whitespace-nowrap ${
                hideTimeout
                  ? "bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-600/15 dark:text-indigo-400 dark:border-indigo-500/30 font-semibold"
                  : "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700"
              }`}
              title="过滤测速超时的无效节点"
            >
              排除超时
            </button>

            {/* 排序方式 */}
            <select
              aria-label="节点排序"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium cursor-pointer shrink-0"
            >
              <option value="default">默认排序</option>
              <option value="latency-asc">延迟优先</option>
              <option value="name-asc">名称排序</option>
            </select>
          </div>

          {/* 右侧：诊断运维 + 订阅入口 + 聚合添加菜单 */}
          <div className="flex items-center space-x-2 shrink-0">
            {/* 1. 全量测速 */}
            <button
              type="button"
              onClick={handleTestAll}
              disabled={testingAll || realNodes.length === 0 || catalogOffline}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 text-xs font-semibold transition shadow-2xs disabled:opacity-50 cursor-pointer"
              title="测试全部节点真实往返握手延迟"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${testingAll ? "animate-spin text-indigo-500" : ""}`} />
              <span>{testingAll ? "测速中..." : "全量测速"}</span>
            </button>

            {/* 2. 全量 IP 体检 */}
            <button
              type="button"
              onClick={() => void handleProbeAllHealth()}
              disabled={probingAll || anySingleProbe || realNodes.length === 0}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-purple-50 hover:bg-purple-100 text-purple-700 dark:bg-purple-600/15 dark:hover:bg-purple-600/25 dark:text-purple-300 border border-purple-200 dark:border-purple-800/60 text-xs font-semibold transition shadow-2xs disabled:opacity-50 cursor-pointer"
              title="深度检测全部节点的真实出口 IP、风控评分与住宅/机房属性"
            >
              <Shield className={`w-3.5 h-3.5 ${probingAll ? "animate-spin text-purple-600 dark:text-purple-400" : "text-purple-500"}`} />
              <span>
                {probingAll
                  ? `体检中 ${probeProgress?.completed || 0}/${probeProgress?.total || realNodes.length}`
                  : "IP 体检"}
              </span>
            </button>

            {/* 3. 日志 */}
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("netbox-navigate-tab", { detail: "logs" })
                );
              }}
              className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 text-xs transition shadow-2xs cursor-pointer"
              title="查看测速、IP 体检与网络运行日志"
            >
              <ScrollText className="w-3.5 h-3.5 text-indigo-500" />
            </button>

            {/* 分隔线 */}
            <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-1 hidden sm:block" />

            {/* 4. 订阅管理 */}
            <button
              type="button"
              onClick={() => {
                openSubscriptions();
                if (!mobile) void runSubscriptionAction(async () => { setProfiles(await getProfiles()); });
              }}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-600 dark:bg-indigo-600/15 dark:hover:bg-indigo-600/25 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-500/30 text-xs font-semibold transition shadow-2xs cursor-pointer"
            >
              <Radio className="w-3.5 h-3.5" />
              <span>订阅管理</span>
              {profiles.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-indigo-200/80 dark:bg-indigo-500/40 font-mono">
                  {profiles.length}
                </span>
              )}
            </button>

            {/* 5. 聚合操作：添加与自建 ▾ */}
            <div className="relative inline-block" ref={addMenuRef}>
              <button
                type="button"
                onClick={() => setAddMenuOpen(!addMenuOpen)}
                className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/20 transition cursor-pointer select-none"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>节点与自建</span>
                <ChevronDown className={`w-3 h-3 text-white/80 transition-transform duration-200 ${addMenuOpen ? "rotate-180" : ""}`} />
              </button>

              {/* 下拉浮层卡片 */}
              {addMenuOpen && (
                <div className="absolute right-0 top-full mt-1.5 z-50 w-52 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl p-1.5 text-xs space-y-1 animate-in fade-in zoom-in-95 duration-100 font-sans">
                  <div className="px-2.5 py-1.5 text-[10px] text-slate-400 font-semibold uppercase tracking-wider border-b border-slate-100 dark:border-slate-800/80">
                    管理与自定义
                  </div>
                  <button
                    type="button"
                    disabled={localNodes.busy || !localNodes.view}
                    onClick={() => {
                      setAddMenuOpen(false);
                      localNodes.openNew();
                    }}
                    className="w-full p-2 rounded-xl text-left hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition flex items-center space-x-2.5 cursor-pointer disabled:opacity-50"
                  >
                    <Plus className="w-3.5 h-3.5 text-indigo-500" />
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-slate-100">新增本地节点</div>
                      <div className="text-[10px] text-slate-400">手动录入单节点配置</div>
                    </div>
                  </button>

                  <button
                    type="button"
                    disabled={localNodes.busy || !localNodes.view}
                    onClick={() => {
                      setAddMenuOpen(false);
                      localNodes.openImport();
                    }}
                    className="w-full p-2 rounded-xl text-left hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition flex items-center space-x-2.5 cursor-pointer disabled:opacity-50"
                  >
                    <Link2 className="w-3.5 h-3.5 text-emerald-500" />
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-slate-100">导入节点配置</div>
                      <div className="text-[10px] text-slate-400">从剪贴板或链接批量导入</div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={(event) => {
                      setAddMenuOpen(false);
                      smartTrigger.current = event.currentTarget;
                      setEditingRule(null);
                      setSmartModalOpen(true);
                    }}
                    className="w-full p-2 rounded-xl text-left hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition flex items-center space-x-2.5 cursor-pointer"
                  >
                    <Zap className="w-3.5 h-3.5 text-amber-500" />
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-slate-100">新建自建线路</div>
                      <div className="text-[10px] text-slate-400">配置轮询/负载均衡策略组</div>
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 主工作区滚动面板 */}
      <VirtualGridScroller className={`${mobile ? "mobile-node-scroller " : ""}flex-1 min-h-0 overflow-y-auto p-6 space-y-6`} resetKey={`${search}:${hideTimeout}:${sourceFilter}`}>
        {/* 节点订阅账号状态看板 (由伪节点提炼为纯净看板) */}
        {!mobile && (subMeta.remainingTraffic || subMeta.expireDate || subMeta.resetDays) && (
          <div className={mobile
            ? "p-2 rounded-xl bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-200/60 dark:border-indigo-800/40 flex items-center justify-between gap-2 text-[11px]"
            : "p-3.5 rounded-2xl bg-gradient-to-r from-indigo-500/10 via-purple-500/10 to-sky-500/10 border border-indigo-200/80 dark:border-indigo-500/30 flex flex-wrap items-center justify-between gap-3 shadow-2xs"
          }>
            <div hidden={mobile} className="flex items-center space-x-2.5">
              <div className="p-1.5 rounded-xl bg-indigo-500/20 text-indigo-600 dark:text-indigo-400">
                <Radio className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-white">节点订阅状态看板</h4>
                <p className="text-[10px] text-slate-500 dark:text-slate-400">订阅提供的流量与有效期信息</p>
              </div>
            </div>

            <div className={`flex items-center ${mobile ? "justify-between w-full" : "space-x-3"} text-xs font-mono`}>
              {subMeta.remainingTraffic && (
                <div className={`flex items-center space-x-1.5 ${mobile ? "px-2 py-0.5" : "px-3 py-1"} rounded-lg bg-white/80 dark:bg-slate-900/80 border border-indigo-200 dark:border-indigo-800`}>
                  <span className="text-[10px] text-slate-400 font-sans">余量:</span>
                  <span className="font-bold text-indigo-600 dark:text-indigo-400">{subMeta.remainingTraffic}</span>
                </div>
              )}
              {subMeta.expireDate && (
                <div className={`flex items-center space-x-1.5 ${mobile ? "px-2 py-0.5" : "px-3 py-1"} rounded-lg bg-white/80 dark:bg-slate-900/80 border border-purple-200 dark:border-purple-800`}>
                  <span className="text-[10px] text-slate-400 font-sans">到期:</span>
                  <span className="font-bold text-purple-600 dark:text-purple-400">{subMeta.expireDate}</span>
                </div>
              )}
              {subMeta.resetDays && (
                <div className={`flex items-center space-x-1.5 ${mobile ? "px-2 py-0.5" : "px-3 py-1"} rounded-lg bg-white/80 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800`}>
                  <span className="text-[10px] text-slate-400 font-sans">重置:</span>
                  <span className="font-bold text-slate-700 dark:text-slate-300">{subMeta.resetDays}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 板块一：自建核心线路区 */}
        {(!mobile || smartRules.length > 0) && <div>
          <div className={`${mobile ? "mobile-node-list-heading " : ""}flex items-center justify-between mb-3`}>
            <div className="flex items-center space-x-2">
              <Zap className="w-4 h-4 text-indigo-500" />
              <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 tracking-wide uppercase">
                {mobile ? "自建线路" : "自建核心线路 (智能优选 / 双跳中继)"}
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
                const matchedCount = smartCounts[rule.id] || 0;

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
                              smartTrigger.current = e.currentTarget;
                              setEditingRule(rule);
                              setSmartModalOpen(true);
                            }}
                            title="编辑该自建线路"
                            aria-label={`编辑自建线路：${rule.name}`}
                            className="p-1 rounded-md text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
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
        </div>}

        {/* 板块二：基础节点库 */}
        <div>
          {!mobile && (
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center space-x-2">
                <Globe className="w-4 h-4 text-indigo-500" />
                <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 tracking-wide uppercase">
                  基础节点池大盘 (按真实出口 IP 归属持久化)
                </h3>
                <span className="text-[11px] text-slate-400 font-mono">({filteredNodes.length} 可用)</span>
              </div>
            </div>
          )}

          {/* 首次无 IP 体检体验或存在未确认节点提示横幅 */}
          {!mobile && unprobedCount > 0 && (
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
                    节点名称可能与实际出口地区不同。完成 IP 体检后，按检测到的地区分类。
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => void handleProbeAllHealth()}
                disabled={probingAll || anySingleProbe}
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
              <p className="text-xs text-slate-500">{realNodes.length > 0 ? "没有符合当前搜索或筛选条件的节点。" : "还没有节点，请前往订阅管理添加订阅。"}</p>
              <button
                type="button"
                onClick={realNodes.length > 0 ? () => { setSearchKeyword(""); setHideTimeout(false); setSourceFilter("all"); } : openSubscriptions}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow transition"
              >
                {realNodes.length > 0 ? "清除筛选" : "添加订阅"}
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              {(mobile ? [["全部节点", filteredNodes] as [string, ProxyItem[]]] : regionGroups).map(([regionTitle, nodes]) => (
                <div key={regionTitle} className="space-y-2">
                  {!mobile && <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300 pb-1 border-b border-slate-200/80 dark:border-slate-800/60">
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
                  </div>}

                  <VirtualGrid items={nodes} itemKey={node => node.name} label={`${regionTitle}节点`} columns={mobile ? 2 : undefined} rowHeight={mobile ? 138 : undefined} renderItem={(node) => {
                      const isSelected = selectedSet.has(node.name);
                      const isActive = activeNodeName === node.name;
                      const delay = delayMap[node.name] ?? node.history?.[node.history.length - 1]?.delay ?? null;
                      const isTesting = testingNodes[node.name];
                      const isProbing = probingNodes[node.name];
                      const health = healthCache[node.name];
                      const mult = parseMultiplier(node.name);
                      const realCountry = persistedNodeRegions[node.name] || (health?.countryCode ? formatCountryRegionTitle(health.countryCode, health.country) : undefined);

                      if (mobile) return <MobileNodeCard name={nodeLabel(node.name)} protocol={node.type} active={isActive && !catalogOffline} selected={isSelected}
                        selectionMode={mobileSelecting}
                        switching={switchingNodeName === node.name}
                        delay={isTesting ? "测速中" : delay === null ? "未测速" : delay <= 0 ? "超时" : `${delay}ms`}
                        delayTone={delay === null ? "text-slate-500" : delay <= 0 || delay >= 500 ? "text-rose-500" : delay < 200 ? "text-emerald-600" : "text-amber-600"}
                        testing={!!isTesting} offline={catalogOffline} region={realCountry} ip={health?.ip} risk={health?.fraudScore}
                        multiplier={mult === null ? "1.0x" : formatMultiplier(mult)} probing={!!isProbing} probeDisabled={!!isProbing || probingAll || anySingleProbe}
                        local={localByAlias.has(node.name)} localBusy={localNodes.busy} onConnect={() => void handleSelectProxy(node.name)}
                        onTest={() => void handleTestNode(node.name)} onProbe={() => void handleProbeHealth(node.name)}
                        onSelect={() => { setMobileSelecting(true); toggleSelectNode(node.name); }} onIgnore={() => handleIgnoreNode(node.name)}
                        onEdit={() => { const local = localByAlias.get(node.name); if (local) void localNodes.edit(local.id); }}
                        onDelete={() => { const local = localByAlias.get(node.name); if (local) localNodes.remove(local); }} />;

                      return (
                        <div
                          key={node.name}
                          onClick={() => handleSelectProxy(node.name)}
                          className={`h-full p-3 rounded-2xl border transition-colors cursor-pointer relative group flex flex-col justify-between select-none ${
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
                              <span className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate flex-1" title={nodeLabel(node.name)}>
                                {nodeLabel(node.name)}
                              </span>
                            </div>
                            {localByAlias.has(node.name) && <div className="flex items-center gap-1 shrink-0">
                              <button type="button" aria-label={`编辑 ${nodeLabel(node.name)}`} title="编辑本地节点" disabled={localNodes.busy} onClick={e => { e.stopPropagation(); void localNodes.edit(localByAlias.get(node.name)!.id); }} className="p-1 text-slate-400 hover:text-indigo-500"><Pencil size={13} /></button>
                              <button type="button" aria-label={`删除 ${nodeLabel(node.name)}`} title="删除本地节点" disabled={localNodes.busy} onClick={e => { e.stopPropagation(); localNodes.remove(localByAlias.get(node.name)!); }} className="p-1 text-slate-400 hover:text-rose-500"><Trash2 size={13} /></button>
                            </div>}
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
                              {localByAlias.has(node.name) && <span className="text-[10px] px-1.5 rounded-md bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300">本地</span>}
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
                              {health && health.fraudScore != null && (
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
                                disabled={isProbing || probingAll || anySingleProbe}
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
                    }} />
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
      </VirtualGridScroller>

      {/* 底部悬浮操作栏：当勾选多节点时出现 */}
      {selectedNodes.length >= (mobile ? 1 : 2) && (
        <div className={`${mobile ? "mobile-node-selection " : ""}absolute bottom-6 left-1/2 -translate-x-1/2 z-40 bg-slate-900/95 text-white dark:bg-slate-800/95 border border-slate-700 rounded-2xl px-5 py-3 shadow-2xl backdrop-blur-md flex items-center space-x-4 animate-in fade-in slide-in-from-bottom-4 duration-200`}>
          <div className="flex items-center space-x-2 text-xs font-semibold">
            <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
            <span>已选中 <strong className="text-indigo-400 font-mono">{selectedNodes.length}</strong> 个节点</span>
          </div>

          <div className="h-4 w-px bg-slate-700" />

          {/* 打包为优选组 */}
          <button
            type="button"
            disabled={selectedNodes.length < 2}
            onClick={() => {
              setPackModalType("url-test");
              setPackName("自动优选线路");
            }}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold shadow transition"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>{mobile ? "自动优选" : "打包为自动优选线路"}</span>
          </button>

          {/* 打包为中继 */}
          <button
            type="button"
            disabled={selectedNodes.length !== 2}
            onClick={() => {
              setPackModalType("relay");
              setPackName("链式双跳中继");
            }}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-xs font-semibold shadow transition"
          >
            <Link2 className="w-3.5 h-3.5" />
            <span>{mobile ? "链式中继" : "打包为链式中继"}</span>
          </button>

          <button
            type="button"
            onClick={() => { setSelectedNodes([]); setMobileSelecting(false); }}
            className="text-xs text-slate-400 hover:text-white transition"
          >
            取消选择
          </button>
        </div>
      )}

      {/* 快速打包起名弹窗 */}
      <dialog ref={packDialog} aria-label="打包创建线路" aria-busy={packSaving} onCancel={event => { event.preventDefault(); closePack(); }} className="m-auto w-[calc(100%-32px)] max-w-sm max-h-[85dvh] p-0 bg-transparent rounded-2xl backdrop:bg-slate-900/60">
      {packModalType && (
          <div className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 space-y-4 shadow-2xl">
            <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              {packModalType === "relay" ? <Link2 className="w-4 h-4 text-purple-500" /> : <Zap className="w-4 h-4 text-indigo-500" />}
              <span>{packModalType === "relay" ? "打包创建中继线路" : "打包创建自动优选线路"}</span>
            </h4>
            <div className="space-y-2">
              <label className="text-xs text-slate-500">为新线路命名：</label>
              <input
                type="text"
                aria-label="新线路名称"
                disabled={packSaving}
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
              {packModalType === "relay" && selectedNodes.length === 2 && (
                <button type="button" disabled={packSaving} onClick={() => setSelectedNodes(([first, second]) => [second, first])} className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">交换入口与出口</button>
              )}
            </div>
            {packError && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400 break-words">{packError}</p>}
            <div className="flex justify-end space-x-2 pt-2">
              <button
                type="button"
                onClick={closePack}
                disabled={packSaving}
                className="px-3.5 py-1.5 rounded-xl text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleConfirmPack}
                disabled={packSaving}
                className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
              >
                {packSaving ? "正在创建…" : "确认创建"}
              </button>
            </div>
          </div>
      )}
      </dialog>

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
              <p className="text-xs text-slate-500 dark:text-slate-400">{mobile ? "切换当前订阅，节点列表会立即更新。" : "切换会应用该订阅的节点与规则；业务包出口不可用时会保留原订阅并提示重新绑定。"}</p>
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
        onClose={() => { setSmartModalOpen(false); smartTrigger.current?.focus(); }}
        editingRule={editingRule}
        allProxyNames={realNodeNames}
        proxyLabels={Object.fromEntries([...localByAlias].map(([alias, node]) => [alias, `${node.name} · 本地`]))}
        fallbackOptions={smartFallbackOptions}
        otherSmartGroupNames={smartRules.filter(rule => rule.id !== editingRule?.id).map(rule => rule.name)}
        onSave={async (savedRule) => {
          const exists = smartRules.some((r) => r.id === savedRule.id);
          const next = exists
            ? smartRules.map((r) => (r.id === savedRule.id ? savedRule : r))
            : [...smartRules, savedRule];
          await syncRules(next);
          setSmartRules(next);
          void loadData();
        }}
      />
      <ProfileSwitchDialog state={profileSwitch.state} actions={profileSwitch.actions} />
      <LocalNodeDialog dialog={localNodes.dialog} busy={localNodes.busy} error={localNodes.error} preview={localNodes.preview}
        onClose={localNodes.close} onSave={localNodes.save} onDelete={localNodes.confirmDelete} onPreview={localNodes.previewText} onImport={localNodes.importPreview} onClearPreview={localNodes.clearPreview} />
      {!localNodes.dialog && (localNodes.error || localNodes.notice) && <div role="status" className="absolute bottom-4 left-4 right-4 rounded-xl border border-slate-200 dark:border-slate-700 p-3 bg-white dark:bg-slate-900 text-xs text-slate-700 dark:text-slate-300 shadow-md flex items-center justify-between gap-2"><span>{localNodes.error || localNodes.notice}</span>{localNodes.error ? <button type="button" className="text-indigo-600 shrink-0" onClick={() => void localNodes.refresh()}>重新读取</button> : <button type="button" aria-label="关闭节点提示" onClick={localNodes.dismissNotice} className="shrink-0 p-1"><X size={14} /></button>}</div>}
    </div>
  );
});
