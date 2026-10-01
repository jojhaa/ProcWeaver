import React, { useState, useEffect, useCallback } from "react";
import {
  BundleLocalInstance,
  BundleWatcherMode,
  BusinessBundleDefinition,
  BundleProcessBindings,
} from "../types/businessBundle";
import {
  getBundleInstances,
  installPresetBundle,
  updateBundleInstance,
  deleteBundleInstance,
} from "../services/bundleStorage";
import { bundleController, useBusinessBundles } from "../hooks/useBusinessBundles";
import { getBundleStatus } from "../utils/bundleController";
import { bundleTools } from "../services/bundleTools";
import { useBundleEntries } from "../hooks/useBundleTools";
import { BundleRow } from "../components/business-bundle/BundleRow";
import { TrafficModeSelector } from "../components/TrafficModeSelector";
import { TrafficModeGuideModal } from "../components/TrafficModeGuideModal";
import { SelectExitModal } from "../components/business-bundle/SelectExitModal";
import { ExternalProxyDialog } from "../components/business-bundle/ExternalProxyDialog";
import { useExternalProxyEditor } from "../hooks/useExternalProxyEditor";
import { BundleDetailModal } from "../components/business-bundle/BundleDetailModal";
import { ImportBundleModal } from "../components/business-bundle/ImportBundleModal";
import { ExportBundleModal } from "../components/business-bundle/ExportBundleModal";
import { EditBundleModal } from "../components/business-bundle/EditBundleModal";
import { BundleStudio } from "../components/business-bundle/BundleStudio";
import { RepositoryCenter } from "../components/business-bundle/RepositoryCenter";
import { useBundleRepositories } from "../hooks/useBundleRepositories";
import { DEFAULT_REPOSITORY, repositoryPage } from "../services/bundleRepositories";
import type { RepositoryPackage } from "../types/bundleRepository";
import { usePlatform } from "../context/PlatformContext";
import { bundleExes, processKey } from "../utils/bundlePlatform";
import { toggleDnsGuard, getDnsGuardStatus, isTauri } from "../api";
import {
  Wrench,
  Download,
  Sparkles,
  HelpCircle,
  Network,
  Settings2,
} from "lucide-react";

interface Props {
  mode: string | null;
  processOnly?: boolean;
}

export const BusinessBundleView: React.FC<Props> = ({ mode: _mode, processOnly = false }) => {
  const platform = usePlatform();
  const os = platform.os === "android" ? "android" : platform.os === "macos" ? "macos" : "windows";
  const bundleState = useBusinessBundles();
  const entryStates = useBundleEntries();
  const { instances } = bundleState;
  const [search, setSearch] = useState("");
  const externalLabel = (instance: BundleLocalInstance) => {
    const id = instance.externalEndpointId || bundleState.external?.defaultEndpointId;
    const proxy = bundleState.external?.endpoints.find(e => e.id === id);
    return proxy ? `${proxy.name} · ${proxy.protocol.toUpperCase()}` : "未选择代理";
  };
  const availableProxies = (bundleState.view?.targets || []).map(target => target.name);
  const [activeTab, setActiveTab] = useState<"installed" | "presets" | "studio">("installed");
  const repositories = useBundleRepositories(activeTab === "presets");
  const repoCount = repositories.state.repositories.filter(r => r.enabled).reduce((sum, r) => sum + (repositories.state.statuses[r.id]?.packages.length || 0), 0);
  const loadingRepo = repositories.state.repositories.some(r => r.enabled && repositories.state.statuses[r.id]?.loading);

  // 弹窗状态
  const [selectExitTarget, setSelectExitTarget] = useState<BundleLocalInstance | null>(null);
  const [externalOpen, setExternalOpen] = useState(false);
  const [externalTarget, setExternalTarget] = useState<BundleLocalInstance | null>(null);
  const externalEditor = useExternalProxyEditor(externalOpen, externalTarget, () => setExternalOpen(false));
  const openExit = (instance: BundleLocalInstance) => {
    if (platform.os === "windows") { setExternalTarget(instance); setExternalOpen(true); }
    else setSelectExitTarget(instance);
  };
  const [detailTarget, setDetailTarget] = useState<BundleLocalInstance | null>(null);
  const [exportTarget, setExportTarget] = useState<BundleLocalInstance | null>(null);
  const [editingTarget, setEditingTarget] = useState<BundleLocalInstance | null>(null);
  const [isImportOpen, setIsImportOpen] = useState<boolean>(false);
  const [isModeGuideOpen, setIsModeGuideOpen] = useState<boolean>(false);

  // 全局 DNS 护航与提示 (C02: 加入 isDnsPending 防重入与反馈)
  const [dnsGuardEnabled, setDnsGuardEnabled] = useState<boolean>(false);
  const [isDnsPending, setIsDnsPending] = useState<boolean>(false);
  const [bannerToast, setBannerToast] = useState<string>("");

  const showToast = (msg: string) => {
    setBannerToast(msg);
    setTimeout(() => setBannerToast(""), 3500);
  };

  // 1. 加载可用节点列表
  useEffect(() => {
    void bundleController.refresh();

    let disposed = false;
    let unlisten: (() => void) | undefined;
    const refreshDns = () => { if (!processOnly && platform.dnsGuard) void getDnsGuardStatus().then(status => { if (!disposed) setDnsGuardEnabled(status); }).catch(() => {}); };
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

  // 切换开关
  const handleToggleSwitch = (instanceId: string, nextState: boolean) => {
    const next = updateBundleInstance(instanceId, (prev) => ({
      ...prev,
      enabled: nextState,
    }));
    persistAndSync(next);
  };

  // 弹窗确认应用出口（含主出口与 DNS 出口联动）
  const handleSelectExitConfirm = (instanceId: string, mainExit: string | null, dnsExit?: string | null) => {
    const next = updateBundleInstance(instanceId, (prev) => {
      const isUnbinding = !mainExit || mainExit.trim() === "";
      return {
        ...prev,
        backend: "core",
        slotBindings: {
          ...prev.slotBindings,
          main: isUnbinding ? null : mainExit,
          dns: dnsExit !== undefined ? dnsExit : prev.slotBindings.dns,
        },
        slotTargets: {
          ...prev.slotTargets,
          main: bundleState.view?.targets.find(t => t.name === mainExit),
          dns: dnsExit && dnsExit !== "FOLLOW_MAIN" ? bundleState.view?.targets.find(t => t.name === dnsExit) : undefined,
        },
        // 如果解除绑定，则自动停用；若选了有效节点，则自动开启强锁
        enabled: !isUnbinding,
      };
    });
    persistAndSync(next);
    showToast(
      mainExit
        ? `正在应用出口【${mainExit}】，请查看核心确认状态`
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

  // 导入完成处理
  const handleImportConfirm = (
    bundle: BusinessBundleDefinition,
    autoEnable: boolean,
    boundNode: string | null
  ) => {
    const installed = installPresetBundle(bundle, processOnly ? false : autoEnable, processOnly ? null : boundNode);
    if (processOnly) updateBundleInstance(installed.instanceId, prev => ({ ...prev, backend: "external" }));
    const next = getBundleInstances();
    persistAndSync(next);
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
    try { const installed = installPresetBundle(def, false, null, item.origin); if (processOnly) updateBundleInstance(installed.instanceId, prev => ({ ...prev, backend: "external" })); }
    catch (e) { showToast(e instanceof Error ? e.message : "装载失败，请重试"); return; }
    const next = getBundleInstances();
    persistAndSync(next);
    setActiveTab("installed");
    showToast(`📦 已将「${def.packageName}」装载到本机列表（已停用跟随系统默认）！`);
  };

  // 自定义工坊保存装载回调
  const handleSaveCustomBundle = (_newInstance: BundleLocalInstance) => {
    if (processOnly) updateBundleInstance(_newInstance.instanceId, prev => ({ ...prev, backend: "external", enabled: false }));
    const next = getBundleInstances();
    persistAndSync(next);
    setActiveTab("installed");
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
  const handleSaveEdit = (updatedDef: BusinessBundleDefinition, processBindings?: BundleProcessBindings) => {
    if (!editingTarget) return;
    const next = updateBundleInstance(editingTarget.instanceId, (prev) => ({
      ...prev,
      definition: updatedDef,
      processBindings,
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
      const exes = new Set(bundleExes(inst.definition, os).flatMap(e => {
        const paths = os === "android" ? [] : inst.processBindings?.[os]?.filter(b => processKey(b.exe, os) === processKey(e, os)) ?? [];
        return paths.length ? paths.map(b => `路径 ${processKey(b.executablePath, os)}`) : [`名称 ${processKey(e, os)}`];
      }));
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

        {/* 顶部全局状态与控制栏 (单行高度仅 ~42px) */}
        {!processOnly && <header className="px-3.5 py-2 rounded-2xl bg-white dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2.5 text-xs shrink-0 shadow-2xs relative z-10 backdrop-blur-md transition-colors">
          {/* 左侧：全局分流总开关 + 底层接管模式下拉 + 核心状态 */}
          <div className="flex items-center space-x-3">
            {/* 业务包分流总开关 */}
            <button
              type="button"
              role="switch"
              aria-label="业务包分流总开关"
              aria-checked={bundleState.view?.config.bundlesEnabled !== false}
              disabled={!bundleState.view || bundleState.pending || Boolean(bundleState.readError)}
              onClick={() => void bundleController.setMasterEnabled(bundleState.view?.config.bundlesEnabled === false)}
              className="flex items-center space-x-2.5 px-1.5 py-1 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer select-none text-xs font-bold text-slate-800 dark:text-slate-200 disabled:opacity-50 transition"
              title={bundleState.view?.config.bundlesEnabled === false ? "点击开启业务包分流" : "点击暂停业务包分流"}
            >
              {/* 1. 胶囊开关 */}
              <span
                aria-hidden="true"
                className={`relative inline-flex items-center w-9 h-5 rounded-full shrink-0 transition-colors duration-200 ${
                  bundleState.view?.config.bundlesEnabled === false
                    ? "bg-slate-300 dark:bg-slate-600"
                    : "bg-emerald-500 shadow-sm"
                }`}
              >
                <span
                  className={`inline-block w-4 h-4 rounded-full bg-white shadow-xs transition-transform duration-200 ${
                    bundleState.view?.config.bundlesEnabled === false
                      ? "translate-x-0.5"
                      : "translate-x-[18px]"
                  }`}
                />
              </span>

              {/* 2. 状态指示灯 */}
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  bundleState.masterPending
                    ? "bg-amber-500 animate-pulse"
                    : bundleState.view?.config.bundlesEnabled === false
                    ? "bg-slate-400"
                    : "bg-emerald-500 ring-2 ring-emerald-500/20"
                }`}
              />

              {/* 3. 状态说明文字 */}
              <span className="text-[11px] sm:text-xs">
                核心业务包 · {bundleState.masterPending ? "切换中" : bundleState.view?.config.bundlesEnabled === false ? "已暂停" : "已开启"}
              </span>
            </button>

            <span className="h-3.5 w-px bg-slate-200 dark:bg-slate-700 hidden sm:inline-block" />

            {/* 全局底层接管模式下拉选择器 (WinDivert / TUN / 智能双模式 / 纯应用层) */}
            {platform.os === "windows" && (
              <TrafficModeSelector
                variant="compact"
                onModeChanged={() => { void bundleController.refresh(); }}
              />
            )}

            {/* 模式说明信息按钮 (点击查看模式架构说明与 WinDivert 优缺点) */}
            {platform.os === "windows" && (
              <button
                type="button"
                onClick={() => setIsModeGuideOpen(true)}
                className="h-7 w-7 rounded-lg bg-slate-100 hover:bg-slate-200/80 dark:bg-slate-800 dark:hover:bg-slate-750 border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 flex items-center justify-center transition shadow-2xs cursor-pointer shrink-0"
                title="查看各底层接管模式说明及 WinDivert 优缺点"
                aria-label="模式说明"
              >
                <HelpCircle className="w-3.5 h-3.5" />
              </button>
            )}

            {/* 核心正常状态小绿点 */}
            <div className="hidden sm:flex items-center space-x-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              <span className={`w-2 h-2 rounded-full ${bundleState.view?.running && !bundleState.readError ? "bg-emerald-500" : "bg-slate-400"}`} />
              <span>{bundleState.readError ? "核心异常" : bundleState.view?.running ? "核心正常" : "核心未运行"}</span>
            </div>
          </div>

          {/* 右侧：DNS 护航开关 + 冲突体检 + 进程跟踪说明悬停气泡 */}
          <div className="flex items-center space-x-2">
            {/* DNS 护航 */}
            <button
              type="button"
              onClick={handleToggleDns}
              disabled={!platform.dnsGuard || isDnsPending}
              className={`px-2.5 py-1 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 text-xs font-medium flex items-center space-x-1.5 shadow-2xs transition ${
                isDnsPending ? "opacity-60 cursor-wait" : "cursor-pointer"
              } ${
                dnsGuardEnabled ? "text-emerald-600 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700/60" : "text-slate-600 dark:text-slate-400"
              }`}
              title={platform.dnsGuard ? "开启后将 Windows 网卡首选 DNS 指向本地核心" : "macOS 首版不修改网卡 DNS；核心 DNS 策略仅作用于进入核心的查询"}
            >
              <span>🛡️</span>
              <span>DNS护航: <strong className={dnsGuardEnabled ? "text-emerald-600 dark:text-emerald-400" : "text-slate-700 dark:text-slate-300"}>
                {!platform.dnsGuard ? "暂不支持" : isDnsPending ? "切换中..." : dnsGuardEnabled ? "已护航" : "关闭"}
              </strong></span>
            </button>

            {/* 冲突体检 */}
            <button
              type="button"
              onClick={handleConflictCheck}
              className="px-2.5 py-1 rounded-xl bg-slate-50 dark:bg-slate-800/80 hover:bg-slate-100 dark:hover:bg-slate-750 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 cursor-pointer transition text-xs font-medium flex items-center space-x-1 shadow-2xs"
            >
              <span>🔍</span>
              <span>冲突体检</span>
            </button>

            {/* 进程跟踪说明悬停气泡 (替代原大黄条) */}
            <div className="relative group">
              <button
                type="button"
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition cursor-help ${
                  bundleState.view?.running && Boolean(bundleState.view.tracking.warnings?.length)
                    ? "text-amber-500 hover:bg-amber-500/10"
                    : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                }`}
                aria-label="进程跟踪说明"
              >
                {bundleState.view?.running && Boolean(bundleState.view.tracking.warnings?.length) ? "⚠️" : "ⓘ"}
              </button>
              <div className="hidden group-hover:block absolute right-0 top-7 z-50 w-72 bg-slate-800 dark:bg-slate-900 text-white text-[11px] p-2.5 rounded-xl shadow-xl leading-relaxed border border-slate-700 dark:border-slate-800 pointer-events-none">
                <span className="font-bold text-amber-300 block mb-1">
                  {bundleState.view?.running && Boolean(bundleState.view.tracking.warnings?.length)
                    ? "进程跟踪提示："
                    : "进程跟踪说明："}
                </span>
                {bundleState.view?.running && Boolean(bundleState.view.tracking.warnings?.length)
                  ? `${bundleState.view.tracking.warnings?.join("；") ?? ""}。未核实的进程不会被标记为已接管。`
                  : "部分短命或受系统保护的后台进程无法直接核验身份；未核实归属的进程不会被强制标记为已接管。"}
              </div>
            </div>
          </div>
        </header>}
        {!processOnly && platform.os === "windows" && (
          <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800/90 bg-white dark:bg-slate-900/90 shadow-2xs p-3.5 sm:px-4 sm:py-3 flex flex-wrap justify-between items-center gap-3 text-xs transition">
            {/* 左侧：图标 + 标题 + 就绪徽标 + 说明 */}
            <div className="flex items-center space-x-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-100 dark:border-indigo-900/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0 shadow-2xs">
                <Network className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center space-x-2">
                  <strong className="text-slate-800 dark:text-slate-100 font-bold text-xs">独立外部代理</strong>
                  <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-[10px] text-slate-600 dark:text-slate-300 font-mono">
                    <span className={`w-1.5 h-1.5 rounded-full ${(bundleState.external?.states.filter(s => s.ready).length || 0) > 0 ? "bg-emerald-500" : "bg-slate-400"}`} />
                    <span>{(bundleState.external?.states.filter(s => s.ready).length || 0) > 0 ? `已就绪 ${bundleState.external?.states.filter(s => s.ready).length || 0} 个入口` : "未就绪"}</span>
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                  HTTP / SOCKS5 · 核心关闭也可独立运行 · 业务专属隔离
                </p>
                {bundleState.externalReadError && (
                  <p role="alert" className="text-[11px] text-red-600 dark:text-red-400 mt-1 font-medium">
                    {bundleState.externalReadError}
                  </p>
                )}
              </div>
            </div>

            {/* 右侧：胶囊滑动开关 + 代理设置与连接记录按钮 */}
            <div className="flex items-center space-x-2">
              <button
                type="button"
                role="switch"
                aria-label="独立代理总开关"
                aria-checked={bundleState.external?.enabled === true}
                disabled={!bundleState.external || bundleState.pending || Boolean(bundleState.externalReadError)}
                onClick={() => void bundleController.setExternalEnabled(!bundleState.external?.enabled)}
                className={`h-8 px-3 rounded-xl border text-xs font-medium flex items-center space-x-2.5 transition shadow-2xs select-none disabled:opacity-50 disabled:cursor-not-allowed ${
                  bundleState.external?.enabled
                    ? "bg-emerald-50/80 hover:bg-emerald-100/90 dark:bg-emerald-950/30 dark:hover:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60 cursor-pointer"
                    : "bg-slate-100 hover:bg-slate-200/80 dark:bg-slate-800 dark:hover:bg-slate-750 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 cursor-pointer"
                }`}
              >
                {/* 滑动胶囊 */}
                <span
                  aria-hidden="true"
                  className={`relative inline-flex items-center w-7 h-4 rounded-full shrink-0 transition-colors duration-200 ${
                    bundleState.external?.enabled ? "bg-emerald-500 shadow-xs" : "bg-slate-300 dark:bg-slate-600"
                  }`}
                >
                  <span
                    className={`inline-block w-3 h-3 rounded-full bg-white shadow-xs transition-transform duration-200 ${
                      bundleState.external?.enabled ? "translate-x-[14px]" : "translate-x-0.5"
                    }`}
                  />
                </span>

                {/* 状态小圆点 */}
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    bundleState.external?.enabled ? "bg-emerald-500 ring-2 ring-emerald-500/20" : "bg-slate-400"
                  }`}
                />

                {/* 说明文字 */}
                <span>
                  独立代理 · {bundleState.external?.enabled ? "已开启" : "已暂停"}
                </span>
              </button>

              <button
                type="button"
                onClick={() => { setExternalTarget(null); setExternalOpen(true); }}
                className="h-8 px-3 rounded-xl bg-indigo-50 hover:bg-indigo-100/80 dark:bg-indigo-950/40 dark:hover:bg-indigo-900/50 text-indigo-600 dark:text-indigo-300 border border-indigo-200/80 dark:border-indigo-800/60 text-xs font-medium flex items-center space-x-1.5 transition shadow-2xs cursor-pointer focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <Settings2 className="w-3.5 h-3.5" />
                <span>代理设置与记录</span>
              </button>
            </div>
          </section>
        )}

        {!processOnly && bundleState.view?.config.bundlesEnabled === false && (
          <p className="text-xs text-amber-600 dark:text-amber-400 px-1">
            核心业务包已暂停，单包设置与快捷方式保留；独立代理由上方独立总开关控制。已有核心连接可能继续使用原出口。
          </p>
        )}

        {/* 主导航切换器与动作区 */}
        <nav className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
          <div className="flex flex-wrap items-center gap-2">
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

          {/* 右侧动作区：导入向导 */}
          <div className="flex items-center space-x-2 text-xs">
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
          <main className="space-y-2.5">
            {processOnly && <label className="block text-xs text-slate-500">搜索业务包<input aria-label="搜索业务包" value={search} onChange={e => setSearch(e.target.value)} placeholder="名称或进程文件名" className="block mt-1 w-full sm:max-w-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-slate-800 dark:text-slate-100 focus-visible:ring-2 focus-visible:ring-indigo-500 outline-none" /></label>}
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
              <>
                {/* 列表表头 */}
                <div className="flex items-center justify-between px-4 py-1 text-[11px] font-bold text-slate-400 dark:text-slate-500 select-none">
                  <div className="flex items-center space-x-3.5">
                    <span className="w-10 text-center">开关</span>
                    <span>业务应用 / 规则包</span>
                  </div>
                  <div className="flex items-center space-x-6 pr-2">
                    <span className="hidden sm:inline">模式</span>
                    <span className="w-[170px] text-left pl-2">出站出口</span>
                    <span className="w-16 text-center">操作</span>
                  </div>
                </div>

                {/* 列表项 */}
                {search && !instances.some(instance => `${instance.definition.packageName} ${bundleExes(instance.definition, os).join(" ")}`.toLowerCase().includes(search.toLowerCase())) && <p role="status" className="py-8 text-center text-sm text-slate-500">没有匹配的业务包，请调整搜索条件。</p>}
                <div className="space-y-2">
                  {instances.map((instance, idx) => (!search || `${instance.definition.packageName} ${bundleExes(instance.definition, os).join(" ")}`.toLowerCase().includes(search.toLowerCase())) && (
                    <BundleRow
                      key={instance.instanceId}
                      instance={instance}
                      status={getBundleStatus(instance, bundleState)}
                      entry={entryStates[instance.instanceId]}
                      proxyLabels={bundleState.view?.targetLabels}
                      externalLabel={externalLabel(instance)}
                      unavailable={processOnly && instance.backend !== "external"}
                      compact={processOnly}
                      onLaunch={() => void bundleTools.launch({ instanceId: instance.instanceId })}
                      onShortcuts={() => void bundleTools.shortcuts(instance.instanceId)}
                      onToggleSwitch={handleToggleSwitch}
                      onOpenSelectExit={openExit}
                      onOpenDetail={(inst) => setDetailTarget(inst)}
                      onEdit={(inst) => setEditingTarget(inst)}
                      onExport={(inst) => setExportTarget(inst)}
                      onDelete={handleDeleteInstance}
                      onMoveUp={() => handleMoveInstance(idx, "up")}
                      onMoveDown={() => handleMoveInstance(idx, "down")}
                      canMoveUp={idx > 0}
                      canMoveDown={idx < instances.length - 1}
                    />
                  ))}
                </div>
              </>
            )}
          </main>
        )}

        {/* 仓库管理独立于已装载规则与运行配置。 */}
        {activeTab === "presets" && <RepositoryCenter state={repositories.state} defaultId={DEFAULT_REPOSITORY.id} instances={instances}
          onRefresh={id => { void repositories.actions.refresh(id); }} onReload={() => { repositories.actions.reload(); }}
          onSave={repositories.actions.upsert} onToggle={repositories.actions.toggle} onRemove={repositories.actions.remove}
          onInstall={handleInstallFromPreset} repositoryLink={repositoryPage} />}

        {/* ================= 视图 3：自定义工坊 (全新重构) ================= */}
        {activeTab === "studio" && (
          <BundleStudio
            os={os}
            existingInstances={instances}
            availableProxies={availableProxies}
            proxyLabels={bundleState.view?.targetLabels}
            processTreeSupported={Boolean(platform.processTree)}
            onSave={handleSaveCustomBundle}
            showToast={showToast}
          />
        )}

      </div>

      {/* 业务出口选择弹窗 (弹窗形式选择出口) */}
      <SelectExitModal
        isOpen={Boolean(selectExitTarget)}
        instance={selectExitTarget}
        availableProxies={availableProxies}
        proxyLabels={bundleState.view?.targetLabels}
        onConfirm={handleSelectExitConfirm}
        onCancel={() => setSelectExitTarget(null)}
      />

      <ExternalProxyDialog open={externalOpen} bundleName={externalTarget?.definition.packageName} state={externalEditor}
        onClose={() => setExternalOpen(false)} onCore={processOnly ? undefined : () => { setExternalOpen(false); setSelectExitTarget(externalTarget); }} />

      {/* 业务包详情与运行状态审计弹窗 (原第二张图信息) */}
      <BundleDetailModal
        isOpen={Boolean(detailTarget)}
        instance={instances.find(i => i.instanceId === detailTarget?.instanceId) || detailTarget}
        status={detailTarget ? getBundleStatus(instances.find(i => i.instanceId === detailTarget.instanceId) || detailTarget, bundleState) : undefined}
        entry={detailTarget ? entryStates[detailTarget.instanceId] : undefined}
        proxyLabels={bundleState.view?.targetLabels}
        externalLabel={detailTarget ? externalLabel(instances.find(i => i.instanceId === detailTarget.instanceId) || detailTarget) : undefined}
        drawer={processOnly}
        unavailable={processOnly && detailTarget?.backend !== "external"}
        onChangeWatcherMode={handleChangeWatcherMode}
        onShortcuts={(id) => void bundleTools.shortcuts(id)}
        onLaunch={(id) => void bundleTools.launch({ instanceId: id })}
        onEdit={(inst) => setEditingTarget(inst)}
        onOpenSelectExit={openExit}
        onClose={() => setDetailTarget(null)}
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

      {/* 接管模式说明及 WinDivert 优缺点详解弹窗 */}
      <TrafficModeGuideModal
        isOpen={isModeGuideOpen}
        onClose={() => setIsModeGuideOpen(false)}
        onConfirm={() => setIsModeGuideOpen(false)}
        currentMode="windivert_v1"
      />
    </div>
  );
};
