import React, { useState, useEffect } from "react";
import { version as appVersion } from "../../package.json";
import {
  Wrench,
  Download,
  RotateCw,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Cpu,
  Layers,
  Sparkles,
  ShieldCheck,
  Edit3,
  X,
  FileCode,
  ArrowUpRight,
  Copy,
  Check,
} from "lucide-react";
import {
  GeoConfig,
  GeoResource,
  AppUpdateInfo,
  MihomoCoreDetail,
  MihomoReleaseInfo,
  RulesRepoInfo,
  CoreRulesUpdateInfo,
} from "../types";
import {
  fetchGeoConfig,
  saveGeoConfig,
  syncGeoResource,
  syncAllGeoResources,
} from "../api/geo";
import {
  checkAppUpdate,
  downloadAppUpdate,
  installAppUpdate,
  restartApp,
  getMihomoCoreDetail,
  checkMihomoUpdate,
  checkRulesRepoUpdate,
  checkCoreRulesUpdate,
  downloadCoreRulesUpdate,
} from "../api/maintenance";

export const MaintenanceView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<"app" | "core" | "geo">("app");

  // ================= 客户端更新状态 =================
  const [appUpdate, setAppUpdate] = useState<AppUpdateInfo | null>(null);
  const [checkingApp, setCheckingApp] = useState(false);
  const [downloadingApp, setDownloadingApp] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<string>("");
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [installingApp, setInstallingApp] = useState(false);
  const [installedSuccess, setInstalledSuccess] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);

  // ================= 内核管理状态 =================
  const [coreDetail, setCoreDetail] = useState<MihomoCoreDetail | null>(null);
  const [mihomoRelease, setMihomoRelease] = useState<MihomoReleaseInfo | null>(null);
  const [loadingCore, setLoadingCore] = useState(false);
  const [checkingCoreUpdate, setCheckingCoreUpdate] = useState(false);
  const [coreError, setCoreError] = useState<string | null>(null);

  // ================= Core-Rules 核心分流规则集状态 =================
  const [coreRulesInfo, setCoreRulesInfo] = useState<CoreRulesUpdateInfo | null>(null);
  const [checkingCoreRules, setCheckingCoreRules] = useState(false);
  const [updatingCoreRules, setUpdatingCoreRules] = useState(false);
  const [coreRulesMsg, setCoreRulesMsg] = useState<{ text: string; isError?: boolean } | null>(null);
  const [copiedCorePath, setCopiedCorePath] = useState(false);

  // ================= 规则生态与 GEO 状态 =================
  const [rulesRepo, setRulesRepo] = useState<RulesRepoInfo | null>(null);
  const [geoConfig, setGeoConfig] = useState<GeoConfig>({
    autoUpdate: true,
    updateIntervalHours: 24,
    resources: [],
  });
  const [loadingGeo, setLoadingGeo] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [geoStatusMsg, setGeoStatusMsg] = useState<{ text: string; isError?: boolean } | null>(null);
  const [editingRes, setEditingRes] = useState<GeoResource | null>(null);
  const [editUrl, setEditUrl] = useState("");
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  // 1. 加载客户端版本与更新检测
  const handleCheckAppUpdate = async () => {
    setCheckingApp(true);
    setAppError(null);
    try {
      const data = await checkAppUpdate();
      setAppUpdate(data);
    } catch (e: any) {
      setAppError(e?.message || String(e));
    } finally {
      setCheckingApp(false);
    }
  };

  // 下载更新包
  const handleDownloadApp = async () => {
    if (!appUpdate?.downloadUrl) return;
    setDownloadingApp(true);
    setAppError(null);
    setDownloadProgress("正在建立高速下载通道...");
    try {
      const fileName = appUpdate.assetName || "ProcWeaver_Portable.zip";
      setDownloadProgress(`正在下载 ${fileName} (${appUpdate.assetSizeFormatted})...`);
      const localPath = await downloadAppUpdate(appUpdate.downloadUrl, fileName);
      setDownloadedPath(localPath);
      setDownloadProgress("下载校验完成，准备就绪！");
    } catch (e: any) {
      setAppError(`下载更新包失败: ${e?.message || e}`);
      setDownloadProgress("");
    } finally {
      setDownloadingApp(false);
    }
  };

  // 安装更新
  const handleInstallApp = async () => {
    if (!downloadedPath) return;
    setInstallingApp(true);
    setAppError(null);
    try {
      const ok = await installAppUpdate(downloadedPath);
      if (ok) {
        setInstalledSuccess(true);
      } else {
        setAppError("更新安装未能正常完成");
      }
    } catch (e: any) {
      setAppError(`安装更新失败: ${e?.message || e}`);
    } finally {
      setInstallingApp(false);
    }
  };

  // 重启应用
  const handleRestart = async () => {
    try {
      await restartApp();
    } catch (e: any) {
      setAppError(`重启失败: ${e?.message || e}`);
    }
  };

  // 2. 加载内核状态
  const loadCoreInfo = async () => {
    setLoadingCore(true);
    setCoreError(null);
    try {
      const detail = await getMihomoCoreDetail();
      setCoreDetail(detail);
    } catch (e: any) {
      setCoreError(e?.message || String(e));
    } finally {
      setLoadingCore(false);
    }
  };

  const handleCheckMihomoRelease = async () => {
    setCheckingCoreUpdate(true);
    try {
      const rel = await checkMihomoUpdate();
      setMihomoRelease(rel);
    } catch (e: any) {
      setCoreError(`获取 Mihomo 官方更新失败: ${e?.message || e}`);
    } finally {
      setCheckingCoreUpdate(false);
    }
  };

  // 3. 加载 Geo 与 规则仓库
  const loadGeoAndRules = async () => {
    setLoadingGeo(true);
    try {
      const [gData, rData] = await Promise.allSettled([
        fetchGeoConfig(),
        checkRulesRepoUpdate(),
      ]);
      if (gData.status === "fulfilled") {
        setGeoConfig(gData.value);
        if (gData.value.lastError) {
          setGeoStatusMsg({ text: `上次更新异常：${gData.value.lastError}`, isError: true });
        }
      }
      if (rData.status === "fulfilled") {
        setRulesRepo(rData.value);
      }
    } catch (e) {
      console.error("加载 Geo 与规则生态失败", e);
    } finally {
      setLoadingGeo(false);
    }
  };

  // 切换 Geo 自动更新
  const handleToggleAutoUpdate = async () => {
    const updated = {
      ...geoConfig,
      autoUpdate: !geoConfig.autoUpdate,
    };
    if (!(await saveGeoConfig(updated))) {
      showGeoMessage("保存失败，自动更新设置未改变", true);
      return;
    }
    setGeoConfig(updated);
    showGeoMessage(updated.autoUpdate ? "已开启 Geo 资源自动更新" : "已关闭 Geo 资源自动更新");
  };

  // 修改更新间隔
  const handleChangeInterval = async (hours: number) => {
    const updated = {
      ...geoConfig,
      updateIntervalHours: hours,
    };
    if (!(await saveGeoConfig(updated))) {
      showGeoMessage("保存失败，更新间隔未改变", true);
      return;
    }
    setGeoConfig(updated);
    showGeoMessage(`已将自动更新间隔设置为 ${hours} 小时`);
  };

  // 单项同步
  const handleSyncItem = async (res: GeoResource) => {
    setSyncingId(res.id);
    setGeoStatusMsg(null);
    try {
      const updated = await syncGeoResource(res.id, res.url);
      if (updated) {
        setGeoConfig((prev) => ({
          ...prev,
          resources: prev.resources.map((r) => (r.id === updated.id ? updated : r)),
        }));
        showGeoMessage(`[${res.name}] 资源同步完成！`);
      }
    } catch (e: any) {
      showGeoMessage(`[${res.name}] 同步失败: ${e?.message || e}`, true);
    } finally {
      setSyncingId(null);
    }
  };

  // 全部同步
  const handleSyncAll = async () => {
    setSyncingAll(true);
    setGeoStatusMsg(null);
    try {
      const updated = await syncAllGeoResources();
      if (updated) {
        setGeoConfig(updated);
        showGeoMessage("所有 Geo 离线数据已成功同步！");
      }
    } catch (e: any) {
      showGeoMessage(`批量同步异常: ${e?.message || e}`, true);
      await loadGeoAndRules();
    } finally {
      setSyncingAll(false);
    }
  };

  const openEdit = (res: GeoResource) => {
    setEditingRes(res);
    setEditUrl(res.url);
  };

  const saveEditUrl = async () => {
    if (!editingRes) return;
    const trimmed = editUrl.trim();
    if (!trimmed) return;

    const updatedResources = geoConfig.resources.map((r) =>
      r.id === editingRes.id ? { ...r, url: trimmed } : r
    );
    const updatedConfig = { ...geoConfig, resources: updatedResources };
    if (!(await saveGeoConfig(updatedConfig))) {
      showGeoMessage("保存失败，同步链接未改变", true);
      return;
    }
    setGeoConfig(updatedConfig);
    setEditingRes(null);
    showGeoMessage(`已保存 [${editingRes.name}] 的同步链接`);
  };

  const restoreDefaultUrl = () => {
    if (!editingRes) return;
    const defaults: Record<string, string> = {
      mmdb: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb",
      asn: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb",
      geoip: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat",
      geosite: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat",
    };
    if (defaults[editingRes.id]) {
      setEditUrl(defaults[editingRes.id]);
    }
  };

  const showGeoMessage = (text: string, isError = false) => {
    setGeoStatusMsg({ text, isError });
    setTimeout(() => {
      setGeoStatusMsg((prev) => (prev?.text === text ? null : prev));
    }, 3500);
  };

  const handleCheckCoreRules = async () => {
    setCheckingCoreRules(true);
    setCoreRulesMsg(null);
    try {
      const data = await checkCoreRulesUpdate();
      setCoreRulesInfo(data);
    } catch (e: any) {
      setCoreRulesMsg({ text: `检测核心规则更新失败: ${e?.message || e}`, isError: true });
    } finally {
      setCheckingCoreRules(false);
    }
  };

  const handleUpdateCoreRules = async () => {
    if (!coreRulesInfo) return;
    setUpdatingCoreRules(true);
    setCoreRulesMsg(null);
    try {
      const url = coreRulesInfo.downloadUrl || "https://github.com/jojhaa/ProcWeaver-Rules/releases/latest/download/Core-Rules.zip";
      const tag = coreRulesInfo.latestVersion || "latest";
      const resMsg = await downloadCoreRulesUpdate(url, tag);
      setCoreRulesMsg({ text: resMsg, isError: false });
      await handleCheckCoreRules();
    } catch (e: any) {
      setCoreRulesMsg({ text: `更新核心规则失败: ${e?.message || e}`, isError: true });
    } finally {
      setUpdatingCoreRules(false);
    }
  };

  const copyCorePath = (txt: string) => {
    navigator.clipboard.writeText(txt);
    setCopiedCorePath(true);
    setTimeout(() => setCopiedCorePath(false), 1500);
  };

  const copyUrl = (txt: string) => {
    navigator.clipboard.writeText(txt);
    setCopiedUrl(txt);
    setTimeout(() => setCopiedUrl(null), 1500);
  };

  useEffect(() => {
    handleCheckAppUpdate();
    loadCoreInfo();
    loadGeoAndRules();
    handleCheckCoreRules();
  }, []);

  return (
    <div className="space-y-6 max-w-4xl pb-12">
      {/* 顶部标题与选项卡导航 */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-3 border-b border-slate-200/80 dark:border-slate-800/80">
        <div className="flex items-center space-x-3">
          <div className="p-2.5 rounded-2xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400 border border-indigo-200/80 dark:border-indigo-500/25 shadow-sm">
            <Wrench className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <span>版本与组件维护中心</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300 font-mono font-medium">
                无损便携保护
              </span>
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              管理客户端外壳升级、Mihomo 内核引擎热替换及离线 Geo 规则库同步
            </p>
          </div>
        </div>

        {/* 子选项卡切换 */}
        <nav className="bg-slate-200/80 dark:bg-slate-900/90 border border-slate-300/80 dark:border-slate-800 p-1 rounded-xl flex items-center shadow-inner">
          <button
            onClick={() => setActiveTab("app")}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 cursor-pointer ${
              activeTab === "app"
                ? "bg-white text-indigo-600 shadow-sm dark:bg-indigo-600 dark:text-white dark:shadow-md dark:shadow-indigo-500/20"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            客户端更新
          </button>
          <button
            onClick={() => setActiveTab("core")}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 cursor-pointer ${
              activeTab === "core"
                ? "bg-white text-indigo-600 shadow-sm dark:bg-indigo-600 dark:text-white dark:shadow-md dark:shadow-indigo-500/20"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            内核维护
          </button>
          <button
            onClick={() => setActiveTab("geo")}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 cursor-pointer ${
              activeTab === "geo"
                ? "bg-white text-indigo-600 shadow-sm dark:bg-indigo-600 dark:text-white dark:shadow-md dark:shadow-indigo-500/20"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            核心规则与 GEO
          </button>
        </nav>
      </div>

      {/* ========================================================================= */}
      {/* 板块 1: 客户端桌面版本更新 (ProcWeaver Desktop)                            */}
      {/* ========================================================================= */}
      {activeTab === "app" && (
        <div className="space-y-6">
          {/* 版本状态卡片 */}
          <div className="bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800/80 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-100 dark:border-slate-800/60">
              <div>
                <div className="flex items-center gap-2.5">
                  <span className="text-xl font-bold text-slate-900 dark:text-white">
                    ProcWeaver Desktop
                  </span>
                  <span className="px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-400 text-xs font-mono font-bold border border-indigo-200/80 dark:border-indigo-500/30">
                    {appUpdate?.currentVersion || `V${appVersion}`}
                  </span>
                  {appUpdate?.hasUpdate && (
                    <span className="px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-400 text-[10px] font-bold animate-pulse">
                      发现新版本
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-2">
                  <span>主仓库发布通道：</span>
                  <a
                    href="https://github.com/jojhaa/ProcWeaver"
                    target="_blank"
                    rel="noreferrer"
                    className="text-indigo-500 hover:underline flex items-center gap-1 font-mono"
                  >
                    jojhaa/ProcWeaver
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </p>
              </div>

              <div className="flex items-center space-x-2.5">
                <button
                  type="button"
                  onClick={handleCheckAppUpdate}
                  disabled={checkingApp}
                  className="px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 text-xs font-medium border border-slate-300 dark:border-slate-700 transition flex items-center gap-2 shadow-sm cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${checkingApp ? "animate-spin text-indigo-500" : ""}`} />
                  <span>{checkingApp ? "正在检测更新..." : "检查更新"}</span>
                </button>
              </div>
            </div>

            {/* 错误提示 */}
            {appError && (
              <div className="mt-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{appError}</span>
              </div>
            )}

            {/* 新版本检测详情 */}
            <div className="mt-5 space-y-4">
              {appUpdate?.hasUpdate ? (
                <div className="p-4 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/40 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-indigo-500" />
                      <span className="text-sm font-bold text-slate-900 dark:text-white">
                        {appUpdate.releaseName || `新版本 ${appUpdate.latestVersion}`}
                      </span>
                    </div>
                    <span className="text-xs text-slate-500 font-mono">
                      发布日期: {appUpdate.publishedAt ? new Date(appUpdate.publishedAt).toLocaleDateString() : "近期"}
                    </span>
                  </div>

                  {appUpdate.releaseNotes && (
                    <div className="p-3 rounded-lg bg-white/80 dark:bg-slate-900/80 border border-slate-200/60 dark:border-slate-800/80 text-xs text-slate-700 dark:text-slate-300 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">
                      {appUpdate.releaseNotes}
                    </div>
                  )}

                  {/* 资产信息 */}
                  <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 pt-1">
                    <div className="flex items-center gap-2">
                      <FileCode className="w-4 h-4 text-indigo-500" />
                      <span className="font-medium text-slate-800 dark:text-slate-200">
                        {appUpdate.assetName || "Windows 便携安装归档"}
                      </span>
                      <span className="text-slate-400">({appUpdate.assetSizeFormatted})</span>
                    </div>

                    {/* 下载与安装按钮 */}
                    <div className="flex items-center space-x-2">
                      {!downloadedPath && !installedSuccess && (
                        <button
                          type="button"
                          onClick={handleDownloadApp}
                          disabled={downloadingApp}
                          className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/20 transition flex items-center gap-1.5 cursor-pointer"
                        >
                          <Download className={`w-3.5 h-3.5 ${downloadingApp ? "animate-bounce" : ""}`} />
                          <span>{downloadingApp ? "正在流式下载..." : "下载新版本"}</span>
                        </button>
                      )}

                      {downloadedPath && !installedSuccess && (
                        <button
                          type="button"
                          onClick={handleInstallApp}
                          disabled={installingApp}
                          className="px-4 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-md shadow-emerald-600/20 transition flex items-center gap-1.5 cursor-pointer"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>{installingApp ? "正在替换文件..." : "一键平滑安装"}</span>
                        </button>
                      )}

                      {installedSuccess && (
                        <button
                          type="button"
                          onClick={handleRestart}
                          className="px-4 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold shadow-md shadow-amber-600/20 transition flex items-center gap-1.5 cursor-pointer animate-pulse"
                        >
                          <RotateCw className="w-3.5 h-3.5" />
                          <span>立即重启应用生效</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 下载进度或安装状态说明 */}
                  {downloadProgress && (
                    <p className="text-[11px] text-indigo-600 dark:text-indigo-400 font-mono">
                      {downloadProgress}
                    </p>
                  )}
                  {installedSuccess && (
                    <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>
                        更新安装成功！原主程序已安全更名为备份，全部用户数据与订阅配置已 100% 完整保留。请点击“立即重启应用”完成切换。
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center space-x-3 p-4 rounded-xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800/80">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      当前已是最新版本 ({appUpdate?.currentVersion || `V${appVersion}`})
                    </h4>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      您正在运行 ProcWeaver 官方稳定版本，未检测到待升级包。
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 便携模式安全保护承诺说明卡 */}
          <div className="p-4 rounded-2xl bg-slate-100/80 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800/80 flex items-start gap-3 text-xs">
            <ShieldCheck className="w-5 h-5 text-indigo-500 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <span className="font-bold text-slate-900 dark:text-white">
                便携环境数据隔离与无损更新保护机制
              </span>
              <p className="text-slate-600 dark:text-slate-400 leading-relaxed text-[11px]">
                ProcWeaver 采用专属隔离升级机制：更新解压与程序替换期间，严格保护 <code className="px-1 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 font-mono">data/</code> 存储目录和本地配置文件。任何更新都不会删除或覆盖您的本地订阅节点、分流规则以及业务配置，保障 100% 数据安全。
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 板块 2: 底层代理内核维护 (Mihomo Core)                                     */}
      {/* ========================================================================= */}
      {activeTab === "core" && (
        <div className="space-y-6">
          <div className="bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800/80 rounded-2xl p-6 shadow-sm space-y-5">
            {/* 顶栏：内核状态与刷新 */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800/60">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-slate-900 dark:text-white">
                    Mihomo 代理内核引擎
                  </h3>
                  {coreDetail?.isRunning ? (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[11px] font-semibold flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      运行中 (PID: {coreDetail.pid})
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400 text-[11px] font-semibold">
                      已休眠
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  基于 MetaCubeX 开源 Mihomo 内核，驱动全局协议代理与流量分流
                </p>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={loadCoreInfo}
                  disabled={loadingCore}
                  className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 transition shadow-sm cursor-pointer"
                  title="刷新内核状态"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingCore ? "animate-spin" : ""}`} />
                </button>
                <button
                  type="button"
                  onClick={handleCheckMihomoRelease}
                  disabled={checkingCoreUpdate}
                  className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition flex items-center gap-1.5 shadow-md shadow-indigo-600/20 cursor-pointer"
                >
                  <Sparkles className={`w-3.5 h-3.5 ${checkingCoreUpdate ? "animate-spin" : ""}`} />
                  <span>检测官方最新内核</span>
                </button>
              </div>
            </div>

            {/* 错误提示 */}
            {coreError && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{coreError}</span>
              </div>
            )}

            {/* 内核详细参数表格网格 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 text-xs">
              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800/80 space-y-1">
                <span className="text-slate-500 text-[11px]">当前活动内核架构</span>
                <p className="font-bold text-slate-900 dark:text-slate-100 font-mono">
                  {coreDetail?.activeCoreMode === "v3"
                    ? "amd64-v3 (AVX2 高性能)"
                    : coreDetail?.activeCoreMode === "compatible"
                    ? "amd64-compatible (通用兼容)"
                    : "自动推荐 (Auto)"}
                </p>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800/80 space-y-1">
                <span className="text-slate-500 text-[11px]">CPU 指令集与推荐</span>
                <p className="font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                  <span>{coreDetail?.cpuArch}</span>
                  {coreDetail?.avx2Supported ? (
                    <span className="px-1.5 py-0.2 rounded bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 text-[10px] font-mono">
                      支持 AVX2 (推选 v3)
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-mono">
                      基础兼容模式
                    </span>
                  )}
                </p>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800/80 space-y-1">
                <span className="text-slate-500 text-[11px]">监听混合端口 / 控制器</span>
                <p className="font-bold text-slate-900 dark:text-slate-100 font-mono">
                  :{coreDetail?.mixedPort || 7890} / :{coreDetail?.controllerPort || 9090}
                </p>
              </div>
            </div>

            {/* 内核版本与二进制信息卡片（现代优雅自适应卡片） */}
            <div className="p-4 rounded-2xl bg-slate-50/90 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800/80 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-slate-200/60 dark:border-slate-800/60">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                    <Cpu className="w-4 h-4" />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                      Mihomo 内核引擎版本
                    </span>
                    <span className="px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 text-[11px] font-mono font-bold">
                      {coreDetail?.coreVersionTag || "v1.19.0"} 官方稳定版
                    </span>
                  </div>
                </div>
                <div className="text-[11px] text-slate-500 font-mono">
                  {coreDetail?.activeCoreMode === "v3" ? "x86_64-v3 高性能优化构建" : "x86_64 通用兼容构建"}
                </div>
              </div>

              <div className="space-y-2 text-xs">
                <div className="text-slate-600 dark:text-slate-300 text-[11px] leading-relaxed">
                  {coreDetail?.coreVersionRaw || "Mihomo Meta 内核已就绪"}
                </div>
                {coreDetail?.activeCorePath && (
                  <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-200/40 dark:border-slate-800/40">
                    <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 font-mono break-all">
                      <span className="text-slate-400 dark:text-slate-500 shrink-0">物理路径:</span>
                      <span className="line-clamp-1 select-all">{coreDetail.activeCorePath}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyCorePath(coreDetail.activeCorePath || "")}
                      className="px-2 py-1 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-[11px] text-slate-600 dark:text-slate-300 flex items-center gap-1 shrink-0 cursor-pointer shadow-2xs transition"
                      title="复制内核文件路径"
                    >
                      {copiedCorePath ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-500" />
                          <span className="text-emerald-500">已复制</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3 text-slate-400" />
                          <span>复制路径</span>
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* 官方 Release 检测结果 */}
            {mihomoRelease && (
              <div className="p-4 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/40 flex items-center justify-between text-xs">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-900 dark:text-white">
                      官方最新发行版: {mihomoRelease.latestVersion}
                    </span>
                    <span className="text-[11px] text-slate-500">
                      ({mihomoRelease.assetSizeFormatted})
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-0.5 font-mono">
                    推荐资产: {mihomoRelease.assetName || "mihomo-windows-amd64.zip"}
                  </p>
                </div>
                <a
                  href={mihomoRelease.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium flex items-center gap-1 shadow-md shadow-indigo-600/20 transition"
                >
                  <span>前往 Release 页面</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </a>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 板块 3: 规则生态与 GEO 离线数据库                                           */}
      {/* ========================================================================= */}
      {activeTab === "geo" && (
        <div className="space-y-6">
          {/* 核心分流规则集 (Core-Rules) 专属更新卡片 */}
          <div className="bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800/80 rounded-2xl p-5 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800/60">
              <div className="flex items-center space-x-3">
                <div className="p-2.5 rounded-2xl bg-purple-50 text-purple-600 dark:bg-purple-500/15 dark:text-purple-400 border border-purple-200/80 dark:border-purple-500/25 shadow-sm">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <span>Mihomo 核心分流规则集 (Core-Rules)</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300 font-mono font-medium">
                      {coreRulesInfo?.currentVersion || "v2026.09.21"}
                    </span>
                    {coreRulesInfo?.hasUpdate && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300 font-mono font-bold animate-pulse">
                        有可用新版
                      </span>
                    )}
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    源自 {rulesRepo?.releaseName || "ProcWeaver 官方规则仓库"} <code className="font-mono text-purple-600 dark:text-purple-400">Core-Rules/</code>，负责驱动底层 30 项分流规则集 (ruleset)
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={handleCheckCoreRules}
                  disabled={checkingCoreRules}
                  className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 text-xs font-medium transition flex items-center gap-1.5 cursor-pointer shadow-xs"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${checkingCoreRules ? "animate-spin text-purple-500" : ""}`} />
                  <span>{checkingCoreRules ? "检测中..." : "检查更新"}</span>
                </button>
                <button
                  type="button"
                  onClick={handleUpdateCoreRules}
                  disabled={updatingCoreRules}
                  className="px-3.5 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-md shadow-purple-600/20 transition flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className={`w-3.5 h-3.5 ${updatingCoreRules ? "animate-bounce" : ""}`} />
                  <span>{updatingCoreRules ? "正在解压热更新..." : "一键更新核心规则"}</span>
                </button>
                <a
                  href={rulesRepo?.repoUrl ? `${rulesRepo.repoUrl}/tree/main/Core-Rules` : "https://github.com/jojhaa/ProcWeaver-Rules/tree/main/Core-Rules"}
                  target="_blank"
                  rel="noreferrer"
                  className="p-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 text-xs transition"
                  title="访问规则仓库 Core-Rules 目录"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>
            </div>

            {/* 核心规则统计与存放说明 */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800/80 space-y-1">
                <span className="text-slate-500 text-[11px]">已装载规则集文件</span>
                <p className="font-bold text-slate-900 dark:text-slate-100 font-mono">
                  {coreRulesInfo?.totalRulesCount ?? 30} 个 (.mrs / .yaml)
                </p>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800/80 space-y-1">
                <span className="text-slate-500 text-[11px]">最新仓库版本</span>
                <p className="font-bold text-slate-900 dark:text-slate-100 font-mono">
                  {coreRulesInfo?.latestVersion || coreRulesInfo?.currentVersion || "v2026.09.21"}
                </p>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800/80 space-y-1">
                <span className="text-slate-500 text-[11px]">生效模式</span>
                <p className="font-bold text-emerald-600 dark:text-emerald-400 font-mono flex items-center gap-1">
                  <span>零断网热重载</span>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                </p>
              </div>
            </div>

            {/* 更新提示或反馈 */}
            {coreRulesMsg && (
              <div
                className={`p-3 rounded-xl border text-xs flex items-center gap-2 transition ${
                  coreRulesMsg.isError
                    ? "bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-500/10 dark:border-rose-500/20 dark:text-rose-400"
                    : "bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-500/10 dark:border-emerald-500/20 dark:text-emerald-400"
                }`}
              >
                {coreRulesMsg.isError ? (
                  <AlertCircle className="w-4 h-4 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                )}
                <span>{coreRulesMsg.text}</span>
              </div>
            )}

            {/* 本地物理路径 */}
            <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center justify-between gap-2 pt-1 border-t border-slate-100 dark:border-slate-800/40 font-mono">
              <span className="truncate">存储目录: {coreRulesInfo?.localRulesDir || "core_data/ruleset/local-plan"}</span>
              <span className="text-slate-400 dark:text-slate-500 text-[10px] shrink-0">原子写入与错误回滚保护</span>
            </div>
          </div>

          {/* 顶部一键同步工具条 */}
          <div className="flex items-center justify-between bg-white dark:bg-slate-900/60 p-4 rounded-2xl border border-slate-200 dark:border-slate-800/80 shadow-sm">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <Layers className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
                离线 IP 域名规则数据库 (GEO)
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                用于精准识别国内/海外 IP 归属地与主流网站域名分流
              </p>
            </div>

            <div className="flex items-center space-x-2">
              <button
                type="button"
                onClick={loadGeoAndRules}
                disabled={loadingGeo}
                title="刷新本地文件状态"
                className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 dark:border-slate-700 transition shadow-sm cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingGeo ? "animate-spin" : ""}`} />
              </button>
              <button
                type="button"
                onClick={handleSyncAll}
                disabled={syncingAll}
                className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition flex items-center gap-1.5 shadow-md shadow-indigo-600/20 cursor-pointer"
              >
                <RotateCw className={`w-3.5 h-3.5 ${syncingAll ? "animate-spin" : ""}`} />
                <span>全部同步</span>
              </button>
            </div>
          </div>

          {/* 提示条 */}
          {geoStatusMsg && (
            <div
              className={`p-3 rounded-xl border text-xs flex items-center gap-2 transition ${
                geoStatusMsg.isError
                  ? "bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-500/10 dark:border-rose-500/20 dark:text-rose-400"
                  : "bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-500/10 dark:border-emerald-500/20 dark:text-emerald-400"
              }`}
            >
              {geoStatusMsg.isError ? (
                <AlertCircle className="w-4 h-4 shrink-0" />
              ) : (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              )}
              <span>{geoStatusMsg.text}</span>
            </div>
          )}

          {/* 4 个 Geo 资源卡片列表 */}
          <div className="space-y-3.5">
            {geoConfig.resources.map((res) => (
              <div
                key={res.id}
                className="bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800/80 rounded-2xl p-4 hover:border-indigo-400 dark:hover:border-slate-700/80 transition space-y-2.5 shadow-sm"
              >
                {/* 第一行：大写名称 */}
                <div className="text-base font-bold text-slate-900 dark:text-white tracking-wide font-mono">
                  {res.name}
                </div>

                {/* 第二行：大小与更新时间 */}
                <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
                  <span className="font-semibold text-slate-800 dark:text-slate-300">
                    {res.fileSizeFormatted}
                  </span>
                  <span className="text-slate-300 dark:text-slate-600">·</span>
                  <span>{res.updatedAtRelative}</span>
                  {!res.exists && (
                    <span className="px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] border border-amber-500/25 dark:border-amber-500/30">
                      待同步
                    </span>
                  )}
                </div>

                {/* 第三行：下载 URL */}
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="text-xs text-slate-400 dark:text-slate-500 font-mono break-all line-clamp-1 hover:text-slate-700 dark:hover:text-slate-300 transition cursor-pointer"
                    title={res.url}
                    onClick={() => copyUrl(res.url)}
                  >
                    {res.url}
                  </span>
                  {copiedUrl === res.url && (
                    <span className="text-[10px] text-emerald-600 dark:text-emerald-400 shrink-0 font-medium">
                      已复制
                    </span>
                  )}
                </div>

                {/* 第四行：操作按钮 [编辑] [同步] */}
                <div className="pt-2 border-t border-slate-100 dark:border-slate-800/60 flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => openEdit(res)}
                    className="px-3.5 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800/80 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-medium border border-slate-300 dark:border-slate-700/70 transition flex items-center gap-1.5 shadow-sm cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                    <span>编辑</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleSyncItem(res)}
                    disabled={syncingId === res.id || syncingAll}
                    className="px-3.5 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800/80 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-medium border border-slate-300 dark:border-slate-700/70 transition flex items-center gap-1.5 shadow-sm cursor-pointer"
                  >
                    <RotateCw
                      className={`w-3.5 h-3.5 text-slate-500 dark:text-slate-400 ${
                        syncingId === res.id ? "animate-spin text-indigo-500 dark:text-indigo-400" : ""
                      }`}
                    />
                    <span>{syncingId === res.id ? "同步中..." : "同步"}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Geo 选项 */}
          <div className="bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800/80 rounded-2xl p-5 space-y-4 shadow-sm">
            <div className="text-sm font-semibold text-slate-900 dark:text-white">Geo 自动化同步选项</div>

            <div className="space-y-4 divide-y divide-slate-100 dark:divide-slate-800/60 text-xs">
              <div className="flex items-center justify-between pt-1">
                <div>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">自动更新</span>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    后台定期静默检查并更新 Geo 离线规则库
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleToggleAutoUpdate}
                  className={`w-11 h-6 rounded-full transition relative p-0.5 ${
                    geoConfig.autoUpdate ? "bg-indigo-600" : "bg-slate-300 dark:bg-slate-800"
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full bg-white transition shadow-sm ${
                      geoConfig.autoUpdate ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between pt-4">
                <div>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">自动更新间隔</span>
                  <p className="text-[11px] text-slate-500 mt-0.5">两次自动检查之间的周期时长</p>
                </div>
                <div>
                  <select
                    value={geoConfig.updateIntervalHours}
                    onChange={(e) => handleChangeInterval(Number(e.target.value))}
                    className="px-3 py-1.5 rounded-xl bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500 font-medium shadow-sm"
                  >
                    <option value={12}>12 小时</option>
                    <option value={24}>24 小时</option>
                    <option value={48}>48 小时</option>
                    <option value={168}>7 天</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 编辑 URL 弹窗 Modal */}
      {editingRes && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-lg p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Edit3 className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
                编辑 {editingRes.name} 同步链接
              </h3>
              <button
                type="button"
                onClick={() => setEditingRes(null)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-white p-1 transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2 text-xs">
              <div className="text-slate-600 dark:text-slate-400">
                文件名称: <span className="text-slate-900 dark:text-slate-200 font-mono font-medium">{editingRes.fileName}</span>
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium">下载 / 同步源地址 (URL)</label>
                <input
                  type="text"
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 font-mono shadow-sm"
                />
              </div>

              {/* 常用高速源快捷填入 */}
              <div className="pt-2">
                <span className="text-[11px] text-slate-500 dark:text-slate-400 block mb-1.5 font-medium">推荐下载源预设：</span>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={restoreDefaultUrl}
                    className="px-2 py-1 rounded-lg text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 transition cursor-pointer"
                  >
                    GitHub 官方原源
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const base = {
                        mmdb: "https://ghfast.top/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb",
                        asn: "https://ghfast.top/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb",
                        geoip: "https://ghfast.top/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat",
                        geosite: "https://ghfast.top/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat",
                      }[editingRes.id];
                      if (base) setEditUrl(base);
                    }}
                    className="px-2 py-1 rounded-lg text-[11px] bg-indigo-50 hover:bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:hover:bg-indigo-500/25 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/30 transition cursor-pointer"
                  >
                    极速镜像 1 (ghfast)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const base = {
                        mmdb: "https://mirror.ghproxy.com/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb",
                        asn: "https://mirror.ghproxy.com/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb",
                        geoip: "https://mirror.ghproxy.com/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat",
                        geosite: "https://mirror.ghproxy.com/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat",
                      }[editingRes.id];
                      if (base) setEditUrl(base);
                    }}
                    className="px-2 py-1 rounded-lg text-[11px] bg-indigo-50 hover:bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:hover:bg-indigo-500/25 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/30 transition cursor-pointer"
                  >
                    极速镜像 2 (ghproxy)
                  </button>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-800 text-xs">
              <span className="text-[11px] text-slate-400">若直连下载慢，可一键切换为国内极速镜像</span>

              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={() => setEditingRes(null)}
                  className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 dark:border-transparent transition cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={saveEditUrl}
                  className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition shadow-md shadow-indigo-600/20 cursor-pointer"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
