import React, { useState, useEffect, useCallback } from "react";
import {
  BundleLocalInstance,
  BundleWatcherMode,
  BusinessBundleDefinition,
} from "../types/businessBundle";
import {
  getBundleInstances,
  installPresetBundle,
  updateBundleInstance,
  deleteBundleInstance,
  createCustomBundle,
} from "../services/bundleStorage";
import { bundleController, useBusinessBundles } from "../hooks/useBusinessBundles";
import { getBundleStatus } from "../utils/bundleController";
import { bundleTools } from "../services/bundleTools";
import { useBundleEntries } from "../hooks/useBundleTools";
import { BundleRow } from "../components/business-bundle/BundleRow";
import { QuickBindModal } from "../components/business-bundle/QuickBindModal";
import { ImportBundleModal } from "../components/business-bundle/ImportBundleModal";
import { ExportBundleModal } from "../components/business-bundle/ExportBundleModal";
import { EditBundleModal } from "../components/business-bundle/EditBundleModal";
import { RepositoryCenter } from "../components/business-bundle/RepositoryCenter";
import { useBundleRepositories } from "../hooks/useBundleRepositories";
import { DEFAULT_REPOSITORY, repositoryPage } from "../services/bundleRepositories";
import type { RepositoryPackage } from "../types/bundleRepository";
import { toggleDnsGuard, getDnsGuardStatus, isTauri } from "../api";
import {
  Package,
  Wrench,
  Download,
  Plus,
  Sparkles,
} from "lucide-react";

interface Props {
  mode: string | null;
}

export const BusinessBundleView: React.FC<Props> = ({ mode: _mode }) => {
  const bundleState = useBusinessBundles();
  const entryStates = useBundleEntries();
  const { instances } = bundleState;
  const availableProxies = (bundleState.view?.targets || []).map(target => target.name);
  const [activeTab, setActiveTab] = useState<"installed" | "presets" | "studio">("installed");
  const repositories = useBundleRepositories(activeTab === "presets");
  const repoCount = repositories.state.repositories.filter(r => r.enabled).reduce((sum, r) => sum + (repositories.state.statuses[r.id]?.packages.length || 0), 0);
  const loadingRepo = repositories.state.repositories.some(r => r.enabled && repositories.state.statuses[r.id]?.loading);

  // 折叠状态追踪 (默认第一项展开，其余折叠)
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>(() => ({
    "inst-chatgpt": true,
  }));
  const [allExpanded, setAllExpanded] = useState<boolean>(false);

  // 弹窗状态
  const [quickBindTarget, setQuickBindTarget] = useState<BundleLocalInstance | null>(null);
  const [exportTarget, setExportTarget] = useState<BundleLocalInstance | null>(null);
  const [editingTarget, setEditingTarget] = useState<BundleLocalInstance | null>(null);
  const [isImportOpen, setIsImportOpen] = useState<boolean>(false);

  // 全局 DNS 护航与提示 (C02: 加入 isDnsPending 防重入与反馈)
  const [dnsGuardEnabled, setDnsGuardEnabled] = useState<boolean>(false);
  const [isDnsPending, setIsDnsPending] = useState<boolean>(false);
  const [bannerToast, setBannerToast] = useState<string>("");

  // 自定义工坊表单
  const [customName, setCustomName] = useState<string>("");
  const [customExesText, setCustomExesText] = useState<string>("");
  const [customDomainsText, setCustomDomainsText] = useState<string>("");

  const showToast = (msg: string) => {
    setBannerToast(msg);
    setTimeout(() => setBannerToast(""), 3500);
  };

  // 1. 加载可用节点列表
  useEffect(() => {
    void bundleController.refresh();

    let disposed = false;
    let unlisten: (() => void) | undefined;
    const refreshDns = () => { void getDnsGuardStatus().then(status => { if (!disposed) setDnsGuardEnabled(status); }).catch(() => {}); };
    refreshDns();
    window.addEventListener("focus", refreshDns);
    if (isTauri()) void import("@tauri-apps/api/event").then(({ listen }) => listen("procweaver-dns-guard-changed", refreshDns))
      .then(remove => { if (disposed) remove(); else unlisten = remove; }).catch(() => {});

    return () => { disposed = true; unlisten?.(); window.removeEventListener("focus", refreshDns); };
  }, []);

  // 2. 业务包守护由独立入口检测负责，不修改其他进程使用的旧版全局守护。
  const persistAndSync = useCallback((nextInstances: BundleLocalInstance[]) => {
    void bundleController.apply(nextInstances).then(async success => {
      if (!success) { setBannerToast(""); return; }
      if (isTauri()) await bundleTools.refreshEntries();
    });
  }, []);

  // 切换折叠单个行
  const handleToggleExpand = (instanceId: string) => {
    setExpandedMap((prev) => ({
      ...prev,
      [instanceId]: !prev[instanceId],
    }));
  };

  // 一键全部折叠 / 全部展开
  const handleToggleAll = () => {
    const nextState = !allExpanded;
    setAllExpanded(nextState);
    const nextMap: Record<string, boolean> = {};
    for (const inst of instances) {
      nextMap[inst.instanceId] = nextState;
    }
    setExpandedMap(nextMap);
  };

  // 切换开关
  const handleToggleSwitch = (instanceId: string, nextState: boolean) => {
    const next = updateBundleInstance(instanceId, (prev) => ({
      ...prev,
      enabled: nextState,
    }));
    persistAndSync(next);
  };

  // 直接在下拉框中选择节点
  const handleSelectNodeChange = (instanceId: string, nodeName: string) => {
    const next = updateBundleInstance(instanceId, (prev) => {
      const isUnbinding = !nodeName || nodeName.trim() === "";
      return {
        ...prev,
        slotBindings: {
          ...prev.slotBindings,
          main: isUnbinding ? null : nodeName,
        },
        slotTargets: { ...prev.slotTargets, main: bundleState.view?.targets.find(t => t.name === nodeName) },
        // 如果解除绑定，则自动停用；若选了有效节点，则自动开启强锁
        enabled: !isUnbinding,
      };
    });
    persistAndSync(next);
    showToast(
      nodeName
        ? `正在应用出口【${nodeName}】，请查看核心确认状态`
        : `正在解除绑定，请等待核心确认`
    );
  };

  // 切换单包守护模式
  const handleChangeWatcherMode = (instanceId: string, mode: BundleWatcherMode) => {
    const next = updateBundleInstance(instanceId, (prev) => ({
      ...prev,
      watcherMode: mode,
    }));
    persistAndSync(next);
  };

  // 卸载套件
  const handleDeleteInstance = (instanceId: string) => {
    const next = deleteBundleInstance(instanceId);
    persistAndSync(next);
    showToast("已移除本机规则包，正在确认核心规则已移除");
  };

  // 方式 A：确认快捷绑定并开启
  const handleConfirmQuickBind = (selectedNode: string) => {
    if (!quickBindTarget) return;
    const instanceId = quickBindTarget.instanceId;
    const targetName = quickBindTarget.definition.packageName;

    const next = updateBundleInstance(instanceId, (prev) => ({
      ...prev,
      slotBindings: {
        ...prev.slotBindings,
        main: selectedNode,
      },
      slotTargets: { ...prev.slotTargets, main: bundleState.view?.targets.find(t => t.name === selectedNode) },
      enabled: true,
    }));

    persistAndSync(next);
    setQuickBindTarget(null);
    showToast(`正在为「${targetName}」应用出口【${selectedNode}】，请等待核心确认`);
  };

  // 导入完成处理
  const handleImportConfirm = (
    bundle: BusinessBundleDefinition,
    autoEnable: boolean,
    boundNode: string | null
  ) => {
    const newInst = installPresetBundle(bundle, autoEnable, boundNode);
    const next = getBundleInstances();
    persistAndSync(next);
    // 自动展开新导入的行
    setExpandedMap((prev) => ({ ...prev, [newInst.instanceId]: true }));
    setActiveTab("installed");
    showToast(
      autoEnable
        ? `已导入「${bundle.packageName}」，正在应用规则`
        : `📥 成功导入「${bundle.packageName}」，当前处于【已停用 (跟随系统默认)】状态。`
    );
  };

  // 预设中心装载
  const handleInstallFromPreset = (item: RepositoryPackage) => {
    const def = item.definition;
    let newInst: BundleLocalInstance;
    try { newInst = installPresetBundle(def, false, null, item.origin); }
    catch (e) { showToast(e instanceof Error ? e.message : "装载失败，请重试"); return; }
    const next = getBundleInstances();
    persistAndSync(next);
    setExpandedMap((prev) => ({ ...prev, [newInst.instanceId]: true }));
    setActiveTab("installed");
    showToast(`📦 已将「${def.packageName}」装载到本机列表（已停用跟随系统默认）！`);
  };

  // 自定义工坊保存
  const handleSaveCustomBundle = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customName.trim()) {
      showToast("⚠️ 请填写规则包名称");
      return;
    }
    const exes = customExesText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (exes.length === 0) {
      showToast("⚠️ 请至少输入一个进程可执行文件名 (exe)");
      return;
    }
    const domains = customDomainsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const newInst = createCustomBundle(customName.trim(), exes, domains);
    const next = getBundleInstances();
    persistAndSync(next);

    setCustomName("");
    setCustomExesText("");
    setCustomDomainsText("");
    setExpandedMap((prev) => ({ ...prev, [newInst.instanceId]: true }));
    setActiveTab("installed");
    showToast(`✨ 自定义规则包「${newInst.definition.packageName}」已创建并装载到本机！`);
  };

  // DNS 护航切换 (C01, C02: 防重入与 pending 反馈)
  const handleToggleDns = async () => {
    if (isDnsPending) return;
    setIsDnsPending(true);
    try {
      const next = !dnsGuardEnabled;
      const res = await toggleDnsGuard(next);
      setDnsGuardEnabled(res);
      showToast(res ? "🛡️ 已开启本地 DNS 防投毒护航" : "ℹ️ 已关闭本地 DNS 防投毒护航");
    } catch (err: any) {
      showToast(`❌ 切换 DNS 护航失败: ${err?.message || err}`);
    } finally {
      setIsDnsPending(false);
    }
  };

  // 保存二次编辑 (B03)
  const handleSaveEdit = (updatedDef: BusinessBundleDefinition) => {
    if (!editingTarget) return;
    const next = updateBundleInstance(editingTarget.instanceId, (prev) => ({
      ...prev,
      definition: updatedDef,
      isModified: true,
    }));
    persistAndSync(next);
    setEditingTarget(null);
    showToast(`✏️ 规则包「${updatedDef.packageName}」定义已成功更新！`);
  };

  // 调整规则包在列表中的优先级次序 (B10)
  const handleMoveInstance = (index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= instances.length) return;
    const next = [...instances];
    const [moved] = next.splice(index, 1);
    next.splice(targetIndex, 0, moved);
    persistAndSync(next);
    showToast(`🔄 已调整「${moved.definition.packageName}」优先级次序！`);
  };

  // 冲突体检（包含主进程与全部附加进程，严格对齐 B10）
  const handleConflictCheck = () => {
    const activeInstances = instances.filter((i) => i.enabled && i.slotBindings.main);
    const exeCounts: Record<string, string[]> = {};
    for (const inst of activeInstances) {
      const exes = new Set([
        ...inst.definition.processes.map((p) => p.exe.toLowerCase()),
        ...(inst.definition.additionalExes || []).map((e) => e.toLowerCase()),
      ]);
      for (const exe of exes) {
        if (!exeCounts[exe]) exeCounts[exe] = [];
        exeCounts[exe].push(inst.definition.packageName);
      }
    }

    const conflicts = Object.entries(exeCounts).filter(([_, pkgs]) => pkgs.length > 1);
    if (conflicts.length === 0) {
      alert("✅ 冲突体检通过：\n\n所有已开启的业务规则包之间（包含主进程与附加进程）不存在任何重复的进程抢占冲突，出口策略清晰明确！");
    } else {
      const detail = conflicts.map(([exe, pkgs]) => `• ${exe}: 被 [${pkgs.join(", ")}] 同时接管`).join("\n");
      alert(`⚠️ 检测到进程规则重叠：\n\n${detail}\n\n重复进程会阻止本次应用。请停用冲突套件或编辑移除重复进程。`);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans p-4 md:p-6 select-none transition-colors duration-200">
      <div className="max-w-6xl w-full mx-auto space-y-4">
        {(bundleState.error || bundleState.readError || bundleState.pending) && (
          <div role={bundleState.pending ? "status" : "alert"} className="p-3 rounded-xl border border-amber-400/50 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 text-xs flex flex-wrap items-center gap-2">
            <span className="flex-1 min-w-0 break-words">{bundleState.pending ? "正在保存本次变更；未修改的业务包保持原配置。节点切换仅影响该包的新连接。" : `${bundleState.error || bundleState.readError}。本次变更未确认生效，请查看受影响业务包的上次保存出口。`}</span>
            <button type="button" disabled={bundleState.pending} onClick={() => persistAndSync(instances)} className="px-3 py-1 rounded border border-current disabled:opacity-50">重新应用</button>
          </div>
        )}
        {bundleState.view?.running && Boolean(bundleState.view.tracking.warnings?.length) && (
          <div role="status" aria-label="进程跟踪提示" className="p-3 rounded-xl border border-amber-300/70 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 text-xs break-words">
            进程跟踪提示：{bundleState.view.tracking.warnings?.join("；")}。未核实的进程不会被标记为已接管。
          </div>
        )}
        
        {/* 全局通知条 */}
        {bannerToast && (
          <div className="p-3 rounded-xl bg-indigo-600 text-white text-xs font-medium shadow-lg flex items-center justify-between animate-in fade-in">
            <div className="flex items-center space-x-2">
              <Sparkles className="w-4 h-4" />
              <span>{bannerToast}</span>
            </div>
            <button
              type="button"
              onClick={() => setBannerToast("")}
              className="text-white/80 hover:text-white cursor-pointer ml-3"
            >
              ✕
            </button>
          </div>
        )}

        {/* 顶部全局状态控制条 */}
        <header className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl bg-white dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800 shadow-sm dark:shadow-lg backdrop-blur-md transition-colors">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center text-xl shadow-md text-white">
              <Package className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h1 className="text-base font-bold tracking-tight text-slate-900 dark:text-white">ProcWeaver 业务规则包中心</h1>
                <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-indigo-500/10 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-400 border border-indigo-500/30">
                  全控折叠架构
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">独立启停开关 · 单包专属智能守护 · 语义插槽解耦装配</p>
            </div>
          </div>

          {/* 全局健康状态 */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <button type="button" role="switch" aria-label="业务包分流总开关"
              aria-checked={bundleState.view?.config.bundlesEnabled !== false}
              disabled={!bundleState.view || bundleState.pending || Boolean(bundleState.readError)}
              onClick={() => void bundleController.setMasterEnabled(bundleState.view?.config.bundlesEnabled === false)}
              className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 disabled:opacity-50 cursor-pointer">
              <span>业务包分流 · {bundleState.masterPending ? "切换中" : bundleState.view?.config.bundlesEnabled === false ? "已暂停" : "已开启"}</span>
              <span className={`relative w-9 h-5 rounded-full ${bundleState.view?.config.bundlesEnabled === false ? "bg-slate-300 dark:bg-slate-600" : "bg-emerald-500"}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${bundleState.view?.config.bundlesEnabled === false ? "left-0.5" : "left-0.5 translate-x-4"}`} />
              </span>
            </button>
            <div className="flex items-center space-x-2 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
              <span className={`w-2 h-2 rounded-full ${bundleState.view?.running && !bundleState.readError ? "bg-emerald-500" : "bg-slate-400"}`} />
              <span className="text-slate-700 dark:text-slate-300 font-medium">{bundleState.readError ? "核心状态读取失败" : bundleState.view?.running ? "Mihomo 核心运行中" : "核心尚未运行或未确认"}</span>
              <span className="text-slate-300 dark:text-slate-600">|</span>
              <button
                type="button"
                onClick={handleToggleDns}
                disabled={isDnsPending}
                className={`font-medium transition ${
                  isDnsPending ? "opacity-60 cursor-wait" : "cursor-pointer"
                } ${
                  dnsGuardEnabled ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                }`}
                title="开启后将 Windows 网卡首选 DNS 指向本地 127.0.0.1 核心以抵御污染"
              >
                {isDnsPending
                  ? "⏳ DNS 切换中..."
                  : dnsGuardEnabled
                  ? "🛡️ DNS 防投毒已护航"
                  : "⚪ DNS 护航未开启"}
              </button>
            </div>
            <button
              type="button"
              onClick={handleConflictCheck}
              className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-750 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 cursor-pointer transition shadow-2xs"
            >
              🔍 冲突体检
            </button>
          </div>
        </header>
        {bundleState.view?.config.bundlesEnabled === false && <p className="text-xs text-slate-500 dark:text-slate-400">业务包已暂停，单包设置与快捷方式保留，新连接沿用原有规则。已有连接可能继续使用原出口。</p>}

        {/* 主导航切换器与动作区 */}
        <nav className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={() => setActiveTab("installed")}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center space-x-2 cursor-pointer ${
                activeTab === "installed"
                  ? "bg-indigo-600 text-white shadow-md"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-200/60 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-900"
              }`}
            >
              <span>📦 已装载套件</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                activeTab === "installed" ? "bg-white/20 text-white" : "bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
              }`}>
                {instances.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab("presets");
              }}
              className={`px-4 py-2 rounded-xl text-xs font-medium transition flex items-center space-x-2 cursor-pointer ${
                activeTab === "presets"
                  ? "bg-indigo-600 text-white shadow-md font-bold"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-200/60 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-900"
              }`}
            >
              <span>🌐 仓库中心</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                activeTab === "presets" ? "bg-white/20 text-white font-bold" : "bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
              }`}>
                {loadingRepo ? "..." : repoCount}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("studio")}
              className={`px-4 py-2 rounded-xl text-xs font-medium transition flex items-center space-x-2 cursor-pointer ${
                activeTab === "studio"
                  ? "bg-indigo-600 text-white shadow-md font-bold"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-200/60 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-900"
              }`}
            >
              <Wrench className="w-3.5 h-3.5" />
              <span>自定义工坊</span>
            </button>
          </div>

          {/* 右侧动作区：一键折叠/展开 & 导入向导 */}
          <div className="flex items-center space-x-2 text-xs">
            {activeTab === "installed" && (
              <button
                type="button"
                onClick={handleToggleAll}
                className="px-3 py-1.5 rounded-xl font-medium bg-white hover:bg-slate-100 dark:bg-slate-900 dark:hover:bg-slate-850 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800 shadow-2xs flex items-center space-x-1 cursor-pointer transition"
              >
                <span>{allExpanded ? "↕️ 全部折叠" : "↕️ 全部展开"}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setIsImportOpen(true)}
              className="px-3.5 py-1.5 rounded-xl font-bold bg-gradient-to-r from-indigo-500 to-purple-600 text-white hover:opacity-95 shadow-md flex items-center space-x-1.5 cursor-pointer transition"
            >
              <Download className="w-3.5 h-3.5" />
              <span>导入规则包 (.pwpack.json)</span>
            </button>
          </div>
        </nav>

        {/* ================= 视图 1：已装载套件列表 ================= */}
        {activeTab === "installed" && (
          <main className="space-y-3.5">
            {instances.length === 0 ? (
              <div className="p-12 text-center rounded-2xl bg-white dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800 space-y-3 shadow-xs">
                <div className="text-3xl">📦</div>
                <div className="text-sm font-bold text-slate-900 dark:text-white">暂未装载任何业务规则包</div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  您可以前往「仓库中心」挑选常用套件，或导入现有的 .pwpack.json 规则包。
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab("presets")}
                  className="px-4 py-2 rounded-xl text-xs font-bold bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer transition inline-block shadow-md"
                >
                  前往仓库中心浏览
                </button>
              </div>
            ) : (
              instances.map((instance, idx) => (
                <BundleRow
                  key={instance.instanceId}
                  instance={instance}
                  status={getBundleStatus(instance, bundleState)}
                  entry={entryStates[instance.instanceId]}
                  onLaunch={() => void bundleTools.launch({ instanceId: instance.instanceId })}
                  onShortcuts={() => void bundleTools.shortcuts(instance.instanceId)}
                  availableProxies={availableProxies}
                  proxyLabels={bundleState.view?.targetLabels}
                  preservedBinding={bundleState.view?.preservedTargets?.some(target => {
                    const stored = instance.slotTargets?.main;
                    return stored && target.profileId === stored.profileId && target.kind === stored.kind && target.name === stored.name;
                  })}
                  isExpanded={Boolean(expandedMap[instance.instanceId])}
                  onToggleExpand={() => handleToggleExpand(instance.instanceId)}
                  onToggleSwitch={handleToggleSwitch}
                  onTriggerQuickBind={(inst) => setQuickBindTarget(inst)}
                  onSelectNodeChange={handleSelectNodeChange}
                  onChangeWatcherMode={handleChangeWatcherMode}
                  onEdit={(inst) => setEditingTarget(inst)}
                  onExport={(inst) => setExportTarget(inst)}
                  onDelete={handleDeleteInstance}
                  onMoveUp={() => handleMoveInstance(idx, "up")}
                  onMoveDown={() => handleMoveInstance(idx, "down")}
                  canMoveUp={idx > 0}
                  canMoveDown={idx < instances.length - 1}
                />
              ))
            )}
          </main>
        )}

        {/* 仓库管理独立于已装载规则与运行配置。 */}
        {activeTab === "presets" && <RepositoryCenter state={repositories.state} defaultId={DEFAULT_REPOSITORY.id} instances={instances}
          onRefresh={id => { void repositories.actions.refresh(id); }} onReload={() => { repositories.actions.reload(); }}
          onSave={repositories.actions.upsert} onToggle={repositories.actions.toggle} onRemove={repositories.actions.remove}
          onInstall={handleInstallFromPreset} repositoryLink={repositoryPage} />}

        {/* ================= 视图 3：自定义工坊 ================= */}
        {activeTab === "studio" && (
          <section className="space-y-4">
            <div className="p-5 rounded-2xl bg-white dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800 space-y-4 text-xs shadow-xs dark:shadow-md">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center space-x-2">
                  <Wrench className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
                  <span>业务规则包工坊</span>
                </h2>
                <p className="text-slate-500 dark:text-slate-400 mt-1">
                  定义好您的进程和域名规则后，一键生成抽象语义插槽，可保存到本机或导出为脱敏纯净的 .pwpack.json 规则包。
                </p>
              </div>

              <form onSubmit={handleSaveCustomBundle} className="space-y-3">
                <div>
                  <label className="block text-slate-700 dark:text-slate-300 font-bold mb-1">规则包名称：</label>
                  <input
                    type="text"
                    required
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="例如：跨国商务通讯套件 或 全栈开发工具箱"
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-slate-900 dark:text-white focus:bg-white dark:focus:bg-slate-950 focus:border-indigo-500 focus:outline-none transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 dark:text-slate-300 font-bold mb-1">
                    进程列表（每行一个可执行程序文件名）：
                  </label>
                  <textarea
                    rows={4}
                    required
                    value={customExesText}
                    onChange={(e) => setCustomExesText(e.target.value)}
                    placeholder={"Telegram.exe\nSlack.exe\nzoom.exe"}
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-slate-900 dark:text-white font-mono focus:bg-white dark:focus:bg-slate-950 focus:border-indigo-500 focus:outline-none transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 dark:text-slate-300 font-bold mb-1">
                    匹配域名群（可选，每行一个域名）：
                  </label>
                  <textarea
                    rows={3}
                    value={customDomainsText}
                    onChange={(e) => setCustomDomainsText(e.target.value)}
                    placeholder={"telegram.org\nslack.com\nzoom.us"}
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-slate-900 dark:text-white font-mono focus:bg-white dark:focus:bg-slate-950 focus:border-indigo-500 focus:outline-none transition-colors"
                  />
                </div>

                <div className="pt-2 flex justify-end">
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold cursor-pointer transition shadow-md flex items-center space-x-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    <span>保存并装载到本机列表</span>
                  </button>
                </div>
              </form>
            </div>
          </section>
        )}

      </div>

      {/* 方式 A：快捷指定出口节点弹窗 */}
      <QuickBindModal
        isOpen={Boolean(quickBindTarget)}
        bundleInstance={quickBindTarget}
        availableProxies={availableProxies}
        proxyLabels={bundleState.view?.targetLabels}
        onConfirm={handleConfirmQuickBind}
        onCancel={() => setQuickBindTarget(null)}
      />

      {/* 导入向导弹窗 */}
      <ImportBundleModal
        isOpen={isImportOpen}
        availableProxies={availableProxies}
        proxyLabels={bundleState.view?.targetLabels}
        onConfirm={handleImportConfirm}
        onCancel={() => setIsImportOpen(false)}
      />

      {/* 导出向导弹窗 */}
      <ExportBundleModal
        isOpen={Boolean(exportTarget)}
        instance={exportTarget}
        onClose={() => setExportTarget(null)}
      />

      {/* 规则包二次编辑弹窗 (B03) */}
      <EditBundleModal
        isOpen={Boolean(editingTarget)}
        bundleInstance={editingTarget}
        onSave={handleSaveEdit}
        onCancel={() => setEditingTarget(null)}
      />
    </div>
  );
};
