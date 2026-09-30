import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { ProfileItem } from "../types";
import {
  getProfiles,
  addProfile,
  updateProfile,
  deleteProfile,
  editProfileMetadata,
  getProfileContent,
  saveProfileContent,
} from "../api";
import {
  Plus,
  RefreshCw,
  Trash2,
  CheckCircle,
  Globe,
  MoreVertical,
  Edit,
  Code,
  Share2,
  Download,
  Copy,
  Check,
  QrCode,
  X,
  FileCode,
  Image,
  Link2,
  Radio,
  ClipboardPaste,
} from "lucide-react";
import QRCode from "qrcode";
import { saveTextFile } from "../services/fileExport";
import { useProfileSwitch } from "../hooks/useProfileSwitch";
import { ProfileSwitchDialog } from "../components/ProfileSwitchDialog";
import { useProfileImport } from "../hooks/useProfileImport";

import { useMobileBack } from "../utils/mobileBack";

// 格式化字节为易读格式 (GB / MB / KB)
function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${parseFloat(val.toFixed(1))} ${sizes[i]}`;
}

// 格式化到期时间戳为 YYYY-MM-DD
function formatExpireDate(expire?: number): string {
  if (!expire || expire === 0) return "长期有效";
  const date = new Date(expire * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function MobileFormDialog({ titleId, onCancel, returnFocus, children }: {
  titleId: string;
  onCancel: () => void;
  returnFocus?: HTMLElement | null;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const viewport = window.visualViewport;
    const fitVisibleArea = () => {
      const height = viewport?.height ?? window.innerHeight;
      element.style.top = `${(viewport?.offsetTop ?? 0) + 12}px`;
      element.style.maxHeight = `${Math.max(160, height - 24)}px`;
    };
    element.showModal();
    fitVisibleArea();
    viewport?.addEventListener("resize", fitVisibleArea);
    viewport?.addEventListener("scroll", fitVisibleArea);
    window.addEventListener("resize", fitVisibleArea);
    element.querySelector<HTMLElement>("input, textarea, select, button")?.focus({ preventScroll: true });
    return () => {
      viewport?.removeEventListener("resize", fitVisibleArea);
      viewport?.removeEventListener("scroll", fitVisibleArea);
      window.removeEventListener("resize", fitVisibleArea);
      if (element.open) element.close();
      const focusTarget = returnFocus?.isConnected ? returnFocus : opener;
      if (focusTarget?.isConnected) requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
    };
  }, []);

  return <dialog
    ref={dialog}
    aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onCancel(); }}
    className="fixed inset-x-4 bottom-auto mx-auto w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 text-slate-900 dark:text-white shadow-2xl backdrop:bg-slate-950/55 space-y-4"
  >{children}</dialog>;
}

export function AndroidProfilesView() {
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState("");

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3000);
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await getProfiles();
      setProfiles(list);
    } catch (e) {
      console.error(e);
      setLoadError(e instanceof Error ? e.message : "无法读取订阅列表，请检查存储或重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
    window.addEventListener("netbox-profile-changed", loadData);
    window.addEventListener("procweaver-profile-changed", loadData);
    return () => {
      window.removeEventListener("netbox-profile-changed", loadData);
      window.removeEventListener("procweaver-profile-changed", loadData);
    };
  }, [loadData]);

  // 导入器 Hook
  const importer = useProfileImport(true, () => {
    void loadData();
    showToast("配置导入成功！");
  });

  // 订阅切换 Hook
  const profileSwitch = useProfileSwitch();

  // 更多操作抽屉选中的 Profile
  const [activeMenuProfile, setActiveMenuProfile] = useState<ProfileItem | null>(null);
  const profileMenuOpener = useRef<HTMLButtonElement | null>(null);
  const addOpener = useRef<HTMLButtonElement | null>(null);

  // 0. 导入方式选择抽屉
  const [showAddMenu, setShowAddMenu] = useState(false);

  // 1. 添加订阅链接弹窗
  const [showAddModal, setShowAddModal] = useState(false);
  const [addName, setAddName] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addingBusy, setAddingBusy] = useState(false);
  const [addError, setAddError] = useState("");

  const closeAdd = () => {
    if (addingBusy) return;
    if ((addName.trim() || addUrl.trim()) && !window.confirm("订阅信息尚未保存，确定放弃吗？")) return;
    setShowAddModal(false);
    setAddName("");
    setAddUrl("");
    setAddError("");
  };

  const handlePasteAddUrl = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setAddUrl(text.trim());
    } catch {
      showToast("无法访问剪贴板，请手动粘贴");
    }
  };

  const handleConfirmAdd = async () => {
    if (!addUrl.trim()) {
      setAddError("请输入订阅链接");
      return;
    }
    setAddingBusy(true);
    setAddError("");
    try {
      await addProfile(addName.trim() || "极速订阅", addUrl.trim());
      setShowAddModal(false);
      setAddName("");
      setAddUrl("");
      await loadData();
      showToast("订阅链接添加成功！");
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingBusy(false);
    }
  };

  // 2. 编辑元数据弹窗
  const [editTarget, setEditTarget] = useState<ProfileItem | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editInterval, setEditInterval] = useState(0);
  const [editBusy, setEditBusy] = useState(false);

  const closeEdit = () => {
    if (editBusy || !editTarget) return;
    const changed = editName !== (editTarget.name || "") || editUrl !== (editTarget.url || "") || editInterval !== (editTarget.autoUpdateInterval || 0);
    if (changed && !window.confirm("订阅信息尚未保存，确定放弃吗？")) return;
    setEditTarget(null);
  };

  const handleOpenEdit = (p: ProfileItem) => {
    setEditTarget(p);
    setEditName(p.name || "");
    setEditUrl(p.url || "");
    setEditInterval(p.autoUpdateInterval || 0);
    setActiveMenuProfile(null);
  };

  const handleSaveEdit = async () => {
    if (!editTarget) return;
    setEditBusy(true);
    try {
      await editProfileMetadata(editTarget.id, editName.trim(), editUrl.trim(), editInterval);
      setEditTarget(null);
      await loadData();
      showToast("订阅信息已更新！");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "更新失败");
    } finally {
      setEditBusy(false);
    }
  };

  // 3. YAML 配置在线编辑弹窗
  const [yamlTarget, setYamlTarget] = useState<ProfileItem | null>(null);
  const [yamlContent, setYamlContent] = useState("");
  const [yamlOriginal, setYamlOriginal] = useState("");
  const [yamlLoading, setYamlLoading] = useState(false);
  const [yamlSaving, setYamlSaving] = useState(false);

  const handleOpenYaml = async (p: ProfileItem) => {
    setActiveMenuProfile(null);
    setYamlTarget(p);
    setYamlLoading(true);
    try {
      const content = await getProfileContent(p.id);
      setYamlContent(content);
      setYamlOriginal(content);
    } catch (e) {
      showToast("读取 YAML 配置失败");
      setYamlTarget(null);
    } finally {
      setYamlLoading(false);
    }
  };

  const handleSaveYaml = async () => {
    if (!yamlTarget) return;
    setYamlSaving(true);
    try {
      await saveProfileContent(yamlTarget.id, yamlContent);
      setYamlTarget(null);
      await loadData();
      showToast("YAML 配置保存成功！");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "保存配置失败");
    } finally {
      setYamlSaving(false);
    }
  };

  // 4. 二维码分享弹窗
  const [shareTarget, setShareTarget] = useState<ProfileItem | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [copiedShare, setCopiedShare] = useState(false);

  const handleOpenShare = async (p: ProfileItem) => {
    setActiveMenuProfile(null);
    setShareTarget(p);
    setCopiedShare(false);
    try {
      const link = p.url || "";
      if (link) {
        const qr = await QRCode.toDataURL(link, { width: 260, margin: 2 });
        setQrCodeUrl(qr);
      } else {
        setQrCodeUrl("");
      }
    } catch {
      setQrCodeUrl("");
    }
  };

  // 弹窗与抽屉安全返回拦截：优先关闭最上层弹层，编辑未保存时防丢提示
  useMobileBack(() => {
    if (showAddMenu) {
      setShowAddMenu(false);
      return true;
    }
    if (activeMenuProfile) {
      setActiveMenuProfile(null);
      return true;
    }
    if (yamlTarget) {
      if (yamlContent !== yamlOriginal && !window.confirm("YAML 配置尚未保存，确定要退出编辑吗？")) return true;
      setYamlTarget(null);
      return true;
    }
    if (editTarget) {
      closeEdit();
      return true;
    }
    if (showAddModal) {
      closeAdd();
      return true;
    }
    if (shareTarget) {
      setShareTarget(null);
      return true;
    }
    if (importer.content) {
      if (!window.confirm("配置尚未导入，确定放弃本次导入吗？")) return true;
      importer.setContent("");
      return true;
    }
    return false;
  }, 20);

  // 单项更新
  const handleUpdate = async (id: string) => {
    setUpdatingId(id);
    setActiveMenuProfile(null);
    try {
      await updateProfile(id);
      await loadData();
      showToast("订阅节点已更新！");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "更新失败");
    } finally {
      setUpdatingId(null);
    }
  };

  // 导出配置
  const handleExport = async (p: ProfileItem) => {
    setActiveMenuProfile(null);
    try {
      const content = await getProfileContent(p.id);
      await saveTextFile(`${p.name || "profile"}.yaml`, content);
      showToast("配置文件导出成功！");
    } catch (e) {
      showToast("导出失败: " + String(e));
    }
  };

  // 删除订阅
  const handleDelete = async (id: string) => {
    setActiveMenuProfile(null);
    if (!window.confirm("确定要删除此订阅吗？删除后相关节点将不可用。")) return;
    try {
      await deleteProfile(id);
      await loadData();
      showToast("订阅已删除");
    } catch (e) {
      showToast("删除失败: " + String(e));
    }
  };

  // 切换生效
  const handleSwitchProfile = async (id: string) => {
    setActiveMenuProfile(null);
    const ok = await profileSwitch.requestSwitch(id);
    if (ok) {
      await loadData();
      showToast("已切换为当前生效订阅");
    }
  };

  const totalNodes = profiles.reduce((sum, p) => sum + (p.nodeCount || 0), 0);

  return (
    <div className="space-y-4 pb-8">
      {/* 页标题由 AndroidApp 提供，此处只显示可操作的统计摘要 */}
      <div className="flex items-center justify-between px-1 text-xs text-slate-600 dark:text-slate-400">
        <span>共 {profiles.length} 个订阅 · {totalNodes} 个节点</span>
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadData()}
          className="p-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:text-slate-900 transition shrink-0 cursor-pointer"
          title="刷新订阅列表"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin text-indigo-500" : ""}`} />
        </button>
      </div>

      {/* 常用 URL 导入直达表单，文件和二维码保留在次级入口 */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <button
          type="button"
          ref={addOpener}
          onClick={() => { setAddError(""); setShowAddModal(true); }}
          className="min-h-[46px] rounded-xl bg-indigo-600 text-white font-bold text-xs flex items-center justify-center space-x-2 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>添加订阅链接</span>
        </button>
        <button type="button" onClick={() => setShowAddMenu(true)} className="px-3 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-300">
          其他导入
        </button>
      </div>

      {/* 待导入内容确认面板 */}
      {importer.content && (
        <div className="mobile-card border-2 border-indigo-500/40 space-y-3 animate-in fade-in slide-in-from-top-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-indigo-600 dark:text-indigo-400">待导入配置确认</h3>
            <button
              type="button"
              onClick={() => { if (!importer.busy && window.confirm("放弃尚未导入的配置？")) importer.setContent(""); }}
              aria-label="放弃导入配置"
              className="text-slate-400 hover:text-slate-600 p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">配置名称</label>
            <input
              value={importer.name}
              onChange={(e) => importer.setName(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              placeholder="请输入配置名称"
            />
          </div>
          <details>
            <summary className="text-xs text-slate-600 dark:text-slate-300 cursor-pointer">预览导入内容</summary>
            <textarea rows={4} readOnly value={importer.content} aria-label="导入内容预览" className="mt-2 w-full p-2.5 rounded-xl bg-slate-100 dark:bg-slate-950 font-mono text-[11px] text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800" />
          </details>
          {importer.message && (
            <p className="text-xs text-rose-600 dark:text-rose-400">{importer.message}</p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={importer.busy || !importer.name.trim()}
              onClick={() => void importer.confirm()}
              className="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white font-semibold text-xs shadow-md"
            >
              {importer.busy ? "正在导入…" : "确认保存并导入"}
            </button>
            <button
              type="button"
              disabled={importer.busy}
              onClick={() => { if (window.confirm("放弃尚未导入的配置？")) importer.setContent(""); }}
              className="px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-xs font-semibold"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 订阅卡片列表（紧凑型卡片） */}
      <div className="space-y-2.5">
        {loading && profiles.length === 0 ? (
          <div className="mobile-card text-center p-8 space-y-3">
            <RefreshCw className="w-6 h-6 animate-spin text-indigo-500 mx-auto" />
            <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">正在读取订阅配置…</p>
            <p className="text-[11px] text-slate-400">请稍候，正在同步本地与云端配置状态</p>
          </div>
        ) : loadError ? (
          <div className="mobile-card text-center p-8 space-y-3 border-rose-200 dark:border-rose-900/50 bg-rose-50/40 dark:bg-rose-950/20">
            <div className="w-10 h-10 rounded-2xl bg-rose-100 dark:bg-rose-900/50 text-rose-600 dark:text-rose-400 flex items-center justify-center mx-auto">
              <X className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <h3 className="text-xs font-bold text-rose-700 dark:text-rose-400">读取订阅配置失败</h3>
              <p className="text-[11px] text-rose-600/80 dark:text-rose-400/80 max-w-xs mx-auto">{loadError}</p>
            </div>
            <button
              type="button"
              onClick={() => void loadData()}
              className="px-4 py-2 rounded-xl bg-rose-600 active:bg-rose-700 text-white font-semibold text-xs shadow-xs transition cursor-pointer inline-flex items-center space-x-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>原地重试</span>
            </button>
          </div>
        ) : profiles.length === 0 ? (
          <div className="mobile-card text-center p-8 space-y-2">
            <div className="w-10 h-10 rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-500 flex items-center justify-center mx-auto">
              <Link2 className="w-5 h-5" />
            </div>
            <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">暂无订阅配置</h3>
            <p className="text-[11px] text-slate-400 max-w-xs mx-auto">
              点击上方“添加或导入订阅配置”，添加后即可在节点池中使用节点。
            </p>
          </div>
        ) : (
          profiles.map((p) => {
            const isUpdating = updatingId === p.id;
            const upload = p.upload ?? 0;
            const download = p.download ?? 0;
            const totalBytes = p.total ?? 0;
            const usedBytes = upload + download;
            const hasTraffic = totalBytes > 0 || usedBytes > 0;
            const percent = totalBytes > 0 ? Math.min(100, Math.round((usedBytes / totalBytes) * 100)) : 0;
            const isNearExhausted = percent >= 90;

            return (
              <div
                key={p.id}
                className={`mobile-card p-3 space-y-2 relative transition ${
                  p.isSelected ? "border-indigo-500/50 ring-1 ring-indigo-500/20" : ""
                }`}
              >
                {/* 顶栏：名称、生效状态、更多菜单 */}
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center space-x-1.5 min-w-0 flex-1">
                    <h3 className="text-xs font-bold text-slate-900 dark:text-white truncate">
                      {p.name || "未命名订阅"}
                    </h3>
                    {p.isSelected ? (
                      <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 shrink-0">
                        <CheckCircle className="w-3 h-3" />
                        <span>生效中</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleSwitchProfile(p.id)}
                        className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 border border-slate-200 dark:border-slate-700 shrink-0 cursor-pointer"
                      >
                        <Radio className="w-3 h-3" />
                        <span>设为生效</span>
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={event => { profileMenuOpener.current = event.currentTarget; setActiveMenuProfile(p); }}
                    className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg cursor-pointer shrink-0"
                    title="更多操作"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                </div>

                {/* 核心指标行：节点总数与更新时间 */}
                <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-900/40 px-2.5 py-1.5 rounded-xl border border-slate-100 dark:border-slate-800/60">
                  <span>
                    包含节点: <strong className="text-indigo-600 dark:text-indigo-400 font-bold">{p.nodeCount ?? 0} 个</strong>
                  </span>
                  <span>
                    更新: <strong className="text-slate-700 dark:text-slate-300 font-medium">{p.updatedAt || "未知"}</strong>
                  </span>
                </div>

                {/* 流量使用量与配额进度 */}
                {hasTraffic ? (
                  <div className="space-y-1">
                    <div className="w-full bg-slate-100 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 rounded-full ${
                          isNearExhausted
                            ? "bg-rose-500"
                            : percent >= 75
                            ? "bg-amber-500"
                            : "bg-indigo-600 dark:bg-indigo-400"
                        }`}
                        style={{ width: `${totalBytes > 0 ? percent : 0}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                      <span>已用: {formatBytes(usedBytes)} / {totalBytes > 0 ? formatBytes(totalBytes) : "无限额"}</span>
                      <span>使用率: {percent}%</span>
                    </div>
                  </div>
                ) : null}

                {/* 到期时间与自动更新频率独立展示 */}
                <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 pt-0.5">
                  <span>到期: <strong className="text-slate-700 dark:text-slate-300 font-medium">{formatExpireDate(p.expire)}</strong></span>
                  {p.autoUpdateInterval ? (
                    <span className="text-indigo-600 dark:text-indigo-400 font-medium">每 {p.autoUpdateInterval}h 自动同步</span>
                  ) : (
                    <span className="text-slate-400">手动更新</span>
                  )}
                </div>

                {/* 订阅链接预览与复制 */}
                {p.url && (
                  <details className="text-[11px] text-slate-500 dark:text-slate-400">
                    <summary className="cursor-pointer">查看订阅链接</summary>
                    <div className="flex items-center justify-between text-[11px] text-slate-400 bg-slate-50 dark:bg-slate-900/60 px-2 py-1 rounded-lg border border-slate-100 dark:border-slate-800/80 mt-1">
                    <div className="flex items-center space-x-1.5 min-w-0 flex-1">
                      <Globe className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                      <span className="truncate font-mono">{p.url}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(p.url || "");
                        showToast("订阅链接已复制到剪贴板");
                      }}
                      className="text-slate-400 hover:text-indigo-500 pl-1.5 shrink-0 cursor-pointer"
                      title="复制链接"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    </div>
                  </details>
                )}

                {/* 底栏：单项更新操作按钮 */}
                <div className="flex items-center justify-end pt-1.5 border-t border-slate-100 dark:border-slate-800/80">
                  <button
                    type="button"
                    disabled={isUpdating}
                    onClick={() => void handleUpdate(p.id)}
                    className="flex items-center space-x-1 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-indigo-600 dark:text-indigo-400 font-semibold text-xs transition cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isUpdating ? "animate-spin" : ""}`} />
                    <span>{isUpdating ? "更新中…" : "更新节点"}</span>
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 添加/导入方式选择抽屉 (ActionSheet) */}
      {showAddMenu && (
        <>
          <div
            className="mobile-drawer-backdrop open"
            onClick={() => setShowAddMenu(false)}
            aria-hidden="true"
          />
          <div className="fixed inset-x-0 bottom-0 z-50 p-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 rounded-t-3xl space-y-3 animate-in slide-in-from-bottom duration-200 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div>
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">导入配置</span>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">选择添加或导入方式</h3>
              </div>
              <button
                type="button"
                aria-label="关闭添加或导入方式"
                onClick={() => setShowAddMenu(false)}
                className="p-1 rounded-full text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-1.5 text-xs">
              <button
                type="button"
                disabled={importer.busy}
                onClick={() => {
                  setShowAddMenu(false);
                  void importer.receive("readDocument");
                }}
                className="w-full flex items-center space-x-3 p-3 rounded-2xl hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-100 dark:border-slate-800/80 transition cursor-pointer text-left"
              >
                <div className="w-8 h-8 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                  <FileCode className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-200">导入本地 YAML 文件</div>
                  <div className="text-[10px] text-slate-400 truncate">从手机系统文件管理器选取 Clash/Mihomo 配置文件</div>
                </div>
              </button>

              <button
                type="button"
                disabled={importer.busy}
                onClick={() => {
                  setShowAddMenu(false);
                  void importer.receive("scanQr");
                }}
                className="w-full flex items-center space-x-3 p-3 rounded-2xl hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-100 dark:border-slate-800/80 transition cursor-pointer text-left"
              >
                <div className="w-8 h-8 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                  <QrCode className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-200">扫描二维码导入</div>
                  <div className="text-[10px] text-slate-400 truncate">使用手机相机扫描屏幕或纸质订阅/配置二维码</div>
                </div>
              </button>

              <button
                type="button"
                disabled={importer.busy}
                onClick={() => {
                  setShowAddMenu(false);
                  void importer.receive("readQrImage");
                }}
                className="w-full flex items-center space-x-3 p-3 rounded-2xl hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-100 dark:border-slate-800/80 transition cursor-pointer text-left"
              >
                <div className="w-8 h-8 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                  <Image className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-200">相册识别二维码</div>
                  <div className="text-[10px] text-slate-400 truncate">从相册照片或截图识别包含的订阅与节点内容</div>
                </div>
              </button>
            </div>
          </div>
        </>
      )}

      {/* 底部动作抽屉 (ActionSheet) */}
      {activeMenuProfile && (
        <>
          <div
            className="mobile-drawer-backdrop open"
            onClick={() => setActiveMenuProfile(null)}
            aria-hidden="true"
          />
          <div className="fixed inset-x-0 bottom-0 z-50 p-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 rounded-t-3xl space-y-3 animate-in slide-in-from-bottom duration-200 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div>
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">订阅操作</span>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white truncate max-w-[240px]">
                  {activeMenuProfile.name || "未命名订阅"}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setActiveMenuProfile(null)}
                className="p-1 rounded-full text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-1 text-xs">
              <button
                type="button"
                onClick={() => void handleUpdate(activeMenuProfile.id)}
                className="w-full flex items-center space-x-3 p-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium"
              >
                <RefreshCw className="w-4 h-4 text-indigo-500" />
                <span>立即更新节点列表</span>
              </button>

              {!activeMenuProfile.isSelected && (
                <button
                  type="button"
                  onClick={() => void handleSwitchProfile(activeMenuProfile.id)}
                  className="w-full flex items-center space-x-3 p-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium"
                >
                  <CheckCircle className="w-4 h-4 text-emerald-500" />
                  <span>设为当前生效订阅</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => handleOpenEdit(activeMenuProfile)}
                className="w-full flex items-center space-x-3 p-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium"
              >
                <Edit className="w-4 h-4 text-indigo-500" />
                <span>编辑名称与更新频率</span>
              </button>

              <button
                type="button"
                onClick={() => void handleOpenYaml(activeMenuProfile)}
                className="w-full flex items-center space-x-3 p-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium"
              >
                <Code className="w-4 h-4 text-indigo-500" />
                <span>在线编辑 YAML 配置</span>
              </button>

              <button
                type="button"
                onClick={() => void handleExport(activeMenuProfile)}
                className="w-full flex items-center space-x-3 p-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium"
              >
                <Download className="w-4 h-4 text-emerald-500" />
                <span>导出配置文件</span>
              </button>

              <button
                type="button"
                onClick={() => void handleOpenShare(activeMenuProfile)}
                className="w-full flex items-center space-x-3 p-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium"
              >
                <Share2 className="w-4 h-4 text-blue-500" />
                <span>分享二维码与链接</span>
              </button>

              <div className="h-px bg-slate-100 dark:bg-slate-800 my-1" />

              <button
                type="button"
                onClick={() => void handleDelete(activeMenuProfile.id)}
                className="w-full flex items-center space-x-3 p-3 rounded-xl hover:bg-rose-50 dark:hover:bg-rose-950/40 text-rose-600 dark:text-rose-400 font-medium"
              >
                <Trash2 className="w-4 h-4" />
                <span>删除此订阅</span>
              </button>
            </div>
          </div>
        </>
      )}

      {/* 弹窗 1：添加订阅链接 */}
      {showAddModal && (
        <MobileFormDialog titleId="mobile-add-profile-title" onCancel={closeAdd} returnFocus={addOpener.current}>
            <div className="flex items-center justify-between">
              <h3 id="mobile-add-profile-title" className="text-sm font-bold text-slate-900 dark:text-white">添加订阅链接</h3>
              <button type="button" aria-label="关闭添加订阅" disabled={addingBusy} onClick={closeAdd} className="text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label htmlFor="mobile-add-profile-name" className="block text-xs text-slate-500 mb-1">订阅名称 (选填)</label>
                <input
                  id="mobile-add-profile-name"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  placeholder="例如：主力专线"
                  className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label htmlFor="mobile-add-profile-url" className="block text-xs text-slate-500">订阅链接 (URL) *</label>
                  <button
                    type="button"
                    onClick={() => void handlePasteAddUrl()}
                    className="text-[11px] text-indigo-600 dark:text-indigo-400 flex items-center space-x-0.5 cursor-pointer"
                  >
                    <ClipboardPaste className="w-3 h-3" />
                    <span>粘贴</span>
                  </button>
                </div>
                <textarea
                  id="mobile-add-profile-url"
                  rows={3}
                  value={addUrl}
                  onChange={(e) => setAddUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full p-2.5 text-xs rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                />
              </div>
            </div>

            {addError && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{addError}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={addingBusy}
                onClick={closeAdd}
                className="px-4 py-2 rounded-xl text-xs text-slate-500 hover:bg-slate-100"
              >
                取消
              </button>
              <button
                type="button"
                disabled={addingBusy || !addUrl.trim()}
                onClick={() => void handleConfirmAdd()}
                className="px-4 py-2 rounded-xl bg-indigo-600 text-white font-semibold text-xs shadow-md disabled:opacity-50"
              >
                {addingBusy ? "保存中…" : "添加并导入"}
              </button>
            </div>
        </MobileFormDialog>
      )}

      {/* 弹窗 2：编辑元数据 */}
      {editTarget && (
        <MobileFormDialog titleId="mobile-edit-profile-title" onCancel={closeEdit} returnFocus={profileMenuOpener.current}>
            <div className="flex items-center justify-between">
              <h3 id="mobile-edit-profile-title" className="text-sm font-bold text-slate-900 dark:text-white">编辑订阅信息</h3>
              <button type="button" aria-label="关闭编辑订阅" disabled={editBusy} onClick={closeEdit} className="text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label htmlFor="mobile-edit-profile-name" className="block text-xs text-slate-500 mb-1">订阅名称</label>
                <input
                  id="mobile-edit-profile-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label htmlFor="mobile-edit-profile-url" className="block text-xs text-slate-500 mb-1">订阅链接 (URL)</label>
                <textarea
                  id="mobile-edit-profile-url"
                  rows={2}
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  className="w-full p-2.5 text-xs rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                />
              </div>

              <div>
                <label htmlFor="mobile-edit-profile-interval" className="block text-xs text-slate-500 mb-1">自动更新频率</label>
                <select
                  id="mobile-edit-profile-interval"
                  value={editInterval}
                  onChange={(e) => setEditInterval(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-none cursor-pointer"
                >
                  <option value={0}>停用自动更新</option>
                  <option value={6}>每 6 小时自动更新</option>
                  <option value={12}>每 12 小时自动更新</option>
                  <option value={24}>每 24 小时自动更新</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={editBusy}
                onClick={closeEdit}
                className="px-4 py-2 rounded-xl text-xs text-slate-500"
              >
                取消
              </button>
              <button
                type="button"
                disabled={editBusy}
                onClick={() => void handleSaveEdit()}
                className="px-4 py-2 rounded-xl bg-indigo-600 text-white font-semibold text-xs shadow-md"
              >
                {editBusy ? "保存中…" : "保存"}
              </button>
            </div>
        </MobileFormDialog>
      )}

      {/* 弹窗 3：YAML 在线编辑 */}
      {yamlTarget && (
        <div className="fixed inset-0 z-50 bg-white dark:bg-slate-950 flex flex-col">
          <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div>
              <h3 className="text-xs font-bold text-slate-900 dark:text-white">
                编辑配置 · {yamlTarget.name}
              </h3>
              <p className="text-[10px] text-slate-400">在线修改 YAML，保存后将重新解析规则与节点</p>
            </div>
            <div className="flex items-center space-x-2">
              <button
                type="button"
                disabled={yamlSaving}
                onClick={() => { if (yamlContent === yamlOriginal || window.confirm("YAML 配置尚未保存，确定要退出编辑吗？")) setYamlTarget(null); }}
                className="px-3 py-1.5 rounded-xl text-xs text-slate-500 hover:bg-slate-100"
              >
                取消
              </button>
              <button
                type="button"
                disabled={yamlSaving || yamlLoading}
                onClick={() => void handleSaveYaml()}
                className="px-3.5 py-1.5 rounded-xl bg-indigo-600 text-white text-xs font-semibold shadow-xs disabled:opacity-50"
              >
                {yamlSaving ? "保存中…" : "保存配置"}
              </button>
            </div>
          </div>

          <div className="flex-1 p-3">
            {yamlLoading ? (
              <div className="flex items-center justify-center h-full text-xs text-slate-400 space-x-2">
                <RefreshCw className="w-4 h-4 animate-spin text-indigo-500" />
                <span>正在加载 YAML…</span>
              </div>
            ) : (
              <textarea
                value={yamlContent}
                onChange={(e) => setYamlContent(e.target.value)}
                spellCheck={false}
                className="w-full h-full p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 leading-relaxed"
              />
            )}
          </div>
        </div>
      )}

      {/* 弹窗 4：二维码分享 */}
      {shareTarget && (
        <>
          <div className="mobile-drawer-backdrop open" onClick={() => setShareTarget(null)} />
          <div className="fixed inset-x-6 top-1/2 -translate-y-1/2 z-50 p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl space-y-4 shadow-2xl text-center animate-in zoom-in-95 duration-150">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              分享订阅 · {shareTarget.name}
            </h3>

            {qrCodeUrl ? (
              <div className="p-3 bg-white rounded-2xl border border-slate-200 inline-block shadow-xs">
                <img src={qrCodeUrl} alt="订阅二维码" className="w-48 h-48 mx-auto" />
              </div>
            ) : (
              <p className="text-xs text-slate-400 py-8">本地配置文件暂无在线订阅链接</p>
            )}

            {shareTarget.url && (
              <div className="space-y-2">
                <p className="text-[11px] font-mono text-slate-400 break-all bg-slate-50 dark:bg-slate-800 p-2.5 rounded-xl">
                  {shareTarget.url}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(shareTarget.url || "");
                    setCopiedShare(true);
                    setTimeout(() => setCopiedShare(false), 2000);
                  }}
                  className="w-full py-2.5 rounded-xl bg-indigo-600 text-white font-semibold text-xs flex items-center justify-center space-x-1 shadow-md"
                >
                  {copiedShare ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  <span>{copiedShare ? "链接已复制" : "复制订阅链接"}</span>
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShareTarget(null)}
              className="text-xs text-slate-400 hover:text-slate-600 pt-1"
            >
              关闭
            </button>
          </div>
        </>
      )}

      {/* 轻量 Toast 提示 */}
      {toastMsg && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-2xl bg-slate-900/90 text-white text-xs font-semibold shadow-lg backdrop-blur-md animate-in fade-in zoom-in-95 duration-150">
          {toastMsg}
        </div>
      )}

      {/* 订阅切换决策弹窗 */}
      <ProfileSwitchDialog state={profileSwitch.state} actions={profileSwitch.actions} />
    </div>
  );
}
