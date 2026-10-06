import { useMobileBack } from "../utils/mobileBack";
import React, { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
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
  FileText,
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
  Clock,
  Calendar,
  Activity,
  Radio,
  Layers,
  ShieldCheck,
  FolderUp,
  QrCode,
  ScanLine,
  X,
} from "lucide-react";
import QRCode from "qrcode";
import { saveTextFile } from "../services/fileExport";
import { useProfileSwitch } from "../hooks/useProfileSwitch";
import { ProfileSwitchDialog } from "../components/ProfileSwitchDialog";
import { getPlatform } from "../services/platform";
import { useProfileImport } from "../hooks/useProfileImport";
import { ProfileImportPanel } from "../components/ProfileImportPanel";

// 格式化字节为易读格式 (GB / MB / KB)
function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${parseFloat(val.toFixed(1))} ${sizes[i]}`;
}

// 格式化到期时间戳为 YYYY-MM-DD 并计算剩余天数
function formatExpireDate(expire?: number): { dateStr: string; remainingDays: number | null } {
  if (!expire || expire === 0) return { dateStr: "长期有效", remainingDays: null };
  const date = new Date(expire * 1000);
  const now = Date.now();
  const diffTime = date.getTime() - now;
  const remainingDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return { dateStr: `${year}-${month}-${day}`, remainingDays };
}

export const ProfilesView: React.FC = () => {
  const mobile = getPlatform().os === "android";
  const importer = useProfileImport(mobile, () => { void loadData(); });
  const profileSwitch = useProfileSwitch();
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // 更多操作菜单浮层激活的 profile id
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

  // 1. 添加订阅模态框
  const [showAddModal, setShowAddModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [addError, setAddError] = useState("");
  const [metaError, setMetaError] = useState("");
  const formPending = useRef(false);
  useEffect(() => { if (showAddModal) setAddError(""); }, [showAddModal]);

  // 2. 编辑元数据模态框 (名称, URL, 自定义自动更新时间)
  const [editMetaTarget, setEditMetaTarget] = useState<ProfileItem | null>(null);
  const [editMetaName, setEditMetaName] = useState("");
  const [editMetaUrl, setEditMetaUrl] = useState("");
  const [editMetaInterval, setEditMetaInterval] = useState<number>(0);

  // 3. 编辑配置内容模态框 (查看与在线修改 YAML 配置)
  const [editContentTarget, setEditContentTarget] = useState<ProfileItem | null>(null);
  const [yamlContent, setYamlContent] = useState("");
  const [yamlLoading, setYamlLoading] = useState(false);
  const [yamlSaving, setYamlSaving] = useState(false);
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [yamlLoaded, setYamlLoaded] = useState(false);
  const yamlRequestId = useRef(0);
  const yamlSavePending = useRef(false);

  // 4. 分享模态框 (二维码与链接复制)
  const [shareTarget, setShareTarget] = useState<ProfileItem | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [qrError, setQrError] = useState("");
  const shareRequestId = useRef(0);
  const [copied, setCopied] = useState(false);

  const closeContentEditor = () => {
    if (yamlSavePending.current) return;
    yamlRequestId.current++;
    setEditContentTarget(null);
    setYamlLoaded(false);
  };
  const closeShare = () => {
    shareRequestId.current++;
    setShareTarget(null);
  };
  useEffect(() => () => {
    yamlRequestId.current++;
    shareRequestId.current++;
  }, []);

  // 导出提示
  const [exportLoading, setExportLoading] = useState<string | null>(null);
  const [copiedUrlId, setCopiedUrlId] = useState<string | null>(null);

  // 统计概览计算
  const activeProfile = useMemo(() => profiles.find((p) => p.isSelected) || null, [profiles]);
  const totalNodesCount = useMemo(() => profiles.reduce((sum, p) => sum + (p.nodeCount || 0), 0), [profiles]);
  const activeExpire = useMemo(() => formatExpireDate(activeProfile?.expire), [activeProfile?.expire]);

  const handleCopyCardUrl = async (id: string, url?: string) => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrlId(id);
      setTimeout(() => setCopiedUrlId(null), 2000);
    } catch (e) {
      console.error("复制失败", e);
    }
  };

  const menuRef = useRef<HTMLDivElement>(null);
  useMobileBack(() => {
    if (!mobile) return false;
    if (shareTarget) closeShare();
    else if (editContentTarget) { closeContentEditor(); }
    else if (editMetaTarget) { if (actionLoading) return true; setEditMetaTarget(null); }
    else if (showAddModal) { if (actionLoading) return true; setShowAddModal(false); }
    else if (activeMenuId) setActiveMenuId(null);
    else return false;
    return true;
  }, 30);

  const showNotification = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 3500);
  };

  // 点击空白处关闭操作菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setActiveMenuId(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getProfiles();
      setProfiles(Array.isArray(res) ? res : []);
    } catch (e: unknown) {
      console.error("加载配置失败", e);
      setError(e instanceof Error ? e.message : "加载配置失败");
      setProfiles([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // 添加订阅
  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formPending.current || !newName.trim() || !newUrl.trim()) return;
    formPending.current = true; setAddError("");
    setActionLoading("add");
    try {
      await addProfile(newName.trim(), newUrl.trim());
      setShowAddModal(false);
      setNewName("");
      setNewUrl("");
      showNotification("订阅添加成功");
      await loadData();
      window.dispatchEvent(new CustomEvent("procweaver-profile-changed"));
      window.dispatchEvent(new CustomEvent("netbox-profile-changed"));
    } catch (err: unknown) {
      setAddError(typeof err === "string" ? err : err instanceof Error ? err.message : "添加订阅失败");
    } finally {
      formPending.current = false;
      setActionLoading(null);
    }
  };

  // 刷新更新订阅
  const handleUpdate = async (id: string) => {
    setActionLoading(id);
    try {
      await updateProfile(id);
      showNotification("订阅更新成功");
      await loadData();
      window.dispatchEvent(new CustomEvent("procweaver-profile-changed"));
      window.dispatchEvent(new CustomEvent("netbox-profile-changed"));
    } catch (err: unknown) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "更新配置失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 激活应用订阅
  const handleSelect = async (id: string) => {
    if (formPending.current || actionLoading || profiles.find(p => p.id === id)?.isSelected) return;
    formPending.current = true;
    setError(null);
    setActionLoading(`sel_${id}`);
    try {
      if (!await profileSwitch.requestSwitch(id)) return;
      showNotification("已切换订阅；核心运行时立即应用，未运行时将在启动后使用。");
      await loadData();
      window.dispatchEvent(new CustomEvent("procweaver-profile-changed"));
      window.dispatchEvent(new CustomEvent("netbox-profile-changed"));
    } catch (err: unknown) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "应用配置失败");
    } finally {
      formPending.current = false;
      setActionLoading(null);
    }
  };

  // 删除订阅
  const handleDelete = async (id: string) => {
    setActiveMenuId(null);
    if (!window.confirm("确定要删除此订阅配置吗？")) return;
    try {
      await deleteProfile(id);
      showNotification("订阅已删除");
      await loadData();
      window.dispatchEvent(new CustomEvent("procweaver-profile-changed"));
      window.dispatchEvent(new CustomEvent("netbox-profile-changed"));
    } catch (err: unknown) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "删除失败");
    }
  };

  // 打开元数据编辑模态框
  const handleOpenEditMeta = (item: ProfileItem) => {
    setActiveMenuId(null);
    setEditMetaTarget(item);
    setEditMetaName(item.name);
    setEditMetaUrl(item.url || "");
    setEditMetaInterval(item.autoUpdateInterval || 0);
    setMetaError("");
  };

  // 提交元数据编辑
  const handleSaveEditMeta = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editMetaTarget || formPending.current || !editMetaName.trim()) return;
    formPending.current = true; setActionLoading("metadata"); setMetaError("");
    try {
      await editProfileMetadata(
        editMetaTarget.id,
        editMetaName.trim(),
        editMetaTarget.url ? editMetaUrl.trim() : "",
        editMetaTarget.url ? Number(editMetaInterval) || 0 : 0
      );
      setEditMetaTarget(null);
      showNotification("订阅信息更新成功");
      await loadData();
      window.dispatchEvent(new CustomEvent("procweaver-profile-changed"));
      window.dispatchEvent(new CustomEvent("netbox-profile-changed"));
    } catch (err: unknown) {
      setMetaError(typeof err === "string" ? err : err instanceof Error ? err.message : "修改订阅失败");
    } finally {
      formPending.current = false; setActionLoading(null);
    }
  };

  // 打开编辑配置内容 (YAML)
  const handleOpenEditContent = async (item: ProfileItem) => {
    if (yamlSavePending.current) return;
    const requestId = ++yamlRequestId.current;
    setActiveMenuId(null);
    setEditContentTarget(item);
    setYamlContent("");
    setYamlLoaded(false);
    setYamlLoading(true);
    setYamlError(null);
    try {
      const content = await getProfileContent(item.id);
      if (requestId !== yamlRequestId.current) return;
      setYamlContent(content);
      setYamlLoaded(true);
    } catch (err: unknown) {
      if (requestId === yamlRequestId.current) setYamlError(typeof err === "string" ? err : err instanceof Error ? err.message : "读取配置文件失败");
    } finally {
      if (requestId === yamlRequestId.current) setYamlLoading(false);
    }
  };

  // 保存编辑配置内容 (YAML)
  const handleSaveEditContent = async () => {
    if (!editContentTarget || !yamlLoaded || yamlLoading || yamlSavePending.current) return;
    yamlSavePending.current = true;
    setYamlSaving(true);
    setYamlError(null);
    try {
      await saveProfileContent(editContentTarget.id, yamlContent);
      yamlRequestId.current++;
      setEditContentTarget(null);
      setYamlLoaded(false);
      showNotification("配置文件已保存；当前订阅会在核心运行时应用。");
      await loadData();
      window.dispatchEvent(new CustomEvent("procweaver-profile-changed"));
      window.dispatchEvent(new CustomEvent("netbox-profile-changed"));
    } catch (err: unknown) {
      setYamlError(typeof err === "string" ? err : err instanceof Error ? err.message : "保存配置失败");
    } finally {
      yamlSavePending.current = false;
      setYamlSaving(false);
    }
  };

  // 打开分享模态框并生成二维码
  const handleOpenShare = async (item: ProfileItem) => {
    const requestId = ++shareRequestId.current;
    setActiveMenuId(null);
    setShareTarget(item);
    setQrDataUrl("");
    setQrError("");
    setCopied(false);
    const textToShare = item.url && item.url.startsWith("http") ? item.url : `netbox://${item.name}`;
    try {
      const qr = await QRCode.toDataURL(textToShare, {
        width: 256,
        margin: 2,
        color: {
          dark: "#1e1b4b",
          light: "#ffffff",
        },
      });
      if (requestId === shareRequestId.current) setQrDataUrl(qr);
    } catch {
      if (requestId === shareRequestId.current) setQrError("二维码生成失败，请重新打开分享或复制订阅链接。");
    }
  };

  // 复制分享链接
  const handleCopyLink = async () => {
    if (!shareTarget?.url) return;
    try {
      await navigator.clipboard.writeText(shareTarget.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("复制失败", e);
    }
  };

  // 导出配置文件
  const handleExport = async (item: ProfileItem) => {
    setActiveMenuId(null);
    setExportLoading(item.id);
    try {
      const content = await getProfileContent(item.id);
      if (await saveTextFile(`${item.name.replace(/[\\/:*?"<>|]/g, "_") || "profile"}.yaml`, content, "application/x-yaml")) {
        showNotification(`已成功导出 "${item.name}.yaml"`);
      }
    } catch (err: unknown) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "导出配置失败");
    } finally {
      setExportLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* 顶部标题与操作工具栏 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white tracking-wide flex items-center gap-2">
            <FileText className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
            订阅配置管理
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            统一管理节点订阅、本地 YAML 与自动定时同步任务
          </p>
        </div>

        {/* 顶部操作按钮组 */}
        <div className="flex items-center flex-wrap gap-2">
          {/* 添加订阅链接按钮 */}
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/20 active:scale-[0.98] transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>添加订阅链接</span>
          </button>

          {/* 导入 YAML 文件 (桌面端) */}
          {!mobile && (
            <label className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-750 border border-slate-200/90 dark:border-slate-700/80 text-slate-700 dark:text-slate-200 text-xs font-medium shadow-2xs hover:shadow-xs active:scale-[0.98] transition cursor-pointer select-none">
              <FolderUp className="w-4 h-4 text-emerald-500" />
              <span>导入 YAML 文件</span>
              <input
                type="file"
                accept=".yaml,.yml,text/yaml,application/x-yaml"
                className="sr-only"
                disabled={importer.busy}
                onChange={(e) => {
                  void importer.file(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
          )}

          {/* 移动端专属导入按钮组 */}
          {mobile && (
            <>
              <button
                type="button"
                disabled={importer.busy}
                onClick={() => void importer.receive("readDocument")}
                className="flex items-center space-x-1 px-3 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs font-medium"
              >
                <FolderUp className="w-3.5 h-3.5 text-emerald-500" />
                <span>文件</span>
              </button>
              <button
                type="button"
                disabled={importer.busy}
                onClick={() => void importer.receive("scanQr")}
                className="flex items-center space-x-1 px-3 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs font-medium"
              >
                <QrCode className="w-3.5 h-3.5 text-blue-500" />
                <span>扫码</span>
              </button>
              <button
                type="button"
                disabled={importer.busy}
                onClick={() => void importer.receive("readQrImage")}
                className="flex items-center space-x-1 px-3 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs font-medium"
              >
                <ScanLine className="w-3.5 h-3.5 text-purple-500" />
                <span>识图</span>
              </button>
            </>
          )}

          {/* 刷新所有订阅数据 */}
          <button
            type="button"
            onClick={loadData}
            disabled={loading}
            title="刷新订阅列表"
            className="p-2 rounded-xl bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-750 border border-slate-200/90 dark:border-slate-700/80 text-slate-600 dark:text-slate-300 text-xs shadow-2xs hover:shadow-xs active:scale-[0.98] transition cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin text-indigo-500" : ""}`} />
          </button>
        </div>
      </div>

      {/* 提示消息与导入模态框 */}
      <ProfileImportPanel mobile={mobile} state={importer} />
      {successMsg && (
        <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs flex items-center gap-2">
          <CheckCircle className="w-4 h-4 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {error && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center justify-between">
          <span>{error}</span>
          <button onClick={loadData} className="underline hover:text-rose-700 dark:hover:text-rose-300">重试</button>
        </div>
      )}

      {/* 订阅概览统计横幅 */}
      {profiles.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="p-3.5 rounded-2xl bg-white/70 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800/80 shadow-2xs flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 shrink-0">
              <Radio className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-slate-400 font-medium">订阅配置源</div>
              <div className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
                {profiles.length} <span className="text-[11px] font-normal text-slate-500">个订阅</span>
              </div>
            </div>
          </div>

          <div className="p-3.5 rounded-2xl bg-white/70 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800/80 shadow-2xs flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 shrink-0">
              <CheckCircle className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-slate-400 font-medium">当前生效配置</div>
              <div className="text-sm font-bold text-emerald-600 dark:text-emerald-400 truncate" title={activeProfile?.name || "未选择"}>
                {activeProfile?.name || "未选择"}
              </div>
            </div>
          </div>

          <div className="p-3.5 rounded-2xl bg-white/70 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800/80 shadow-2xs flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400 shrink-0">
              <Layers className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-slate-400 font-medium">可用节点储备</div>
              <div className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
                {activeProfile ? activeProfile.nodeCount ?? 0 : totalNodesCount} <span className="text-[11px] font-normal text-slate-500">个节点</span>
              </div>
            </div>
          </div>

          <div className="p-3.5 rounded-2xl bg-white/70 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800/80 shadow-2xs flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0">
              <Clock className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-slate-400 font-medium">服务到期时间</div>
              <div className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
                {activeExpire.remainingDays !== null ? (
                  activeExpire.remainingDays > 0 ? (
                    <span>余 <strong className="text-amber-600 dark:text-amber-400">{activeExpire.remainingDays}</strong> 天</span>
                  ) : (
                    <span className="text-rose-500">已到期</span>
                  )
                ) : (
                  <span>长期有效</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 订阅卡片列表 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(profiles || []).map((p) => {
          if (!p) return null;
          const isUpdating = actionLoading === p.id;
          const isSelecting = actionLoading === `sel_${p.id}`;

          // 计算已用流量与百分比
          const usedBytes = (p.upload || 0) + (p.download || 0);
          const totalBytes = p.total || 0;
          const hasTrafficInfo = totalBytes > 0 || usedBytes > 0 || Boolean(p.expire);
          const percent = totalBytes > 0 ? Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100)) : 0;
          const isNearExhausted = percent >= 90;
          const isMenuOpen = activeMenuId === p.id;
          const expireInfo = formatExpireDate(p.expire);

          return (
            <div
              key={p.id}
              className={`p-5 rounded-2xl border transition-all duration-200 relative flex flex-col justify-between gap-4 ${
                p.isSelected
                  ? "bg-gradient-to-br from-emerald-50/50 via-white to-indigo-50/20 dark:from-emerald-950/20 dark:via-slate-900/90 dark:to-slate-900 border-emerald-500/40 ring-1 ring-emerald-500/30 shadow-sm shadow-emerald-500/5"
                  : "bg-white/85 hover:bg-white dark:bg-slate-900/60 dark:hover:bg-slate-900/90 border-slate-200/90 dark:border-slate-800/90 hover:border-slate-300 dark:hover:border-slate-700 shadow-2xs hover:shadow-md"
              }`}
            >
              <button
                type="button"
                aria-label={`使用订阅：${p.name || "未命名配置"}`}
                aria-pressed={p.isSelected}
                aria-busy={isSelecting}
                disabled={Boolean(actionLoading)}
                onClick={() => void handleSelect(p.id)}
                className="absolute inset-0 rounded-2xl cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950 disabled:cursor-wait"
              />
              <div className="relative space-y-3 pointer-events-none">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center space-x-2.5 min-w-0">
                    <span className="font-bold text-base text-slate-900 dark:text-white truncate">
                      {p.name || "未命名配置"}
                    </span>
                    {p.isSelected && (
                      <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 shadow-2xs shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        <span>正在生效</span>
                      </span>
                    )}
                  </div>

                  {/* 更多操作下拉菜单按钮 */}
                  <div className="relative shrink-0 pointer-events-auto">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveMenuId(isMenuOpen ? null : p.id);
                      }}
                      title="更多操作"
                      disabled={Boolean(actionLoading)}
                      className="text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>

                    {/* 下拉浮层 */}
                    {isMenuOpen && (
                      <div
                        ref={menuRef}
                        className="absolute right-0 top-8 w-44 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-xl z-30 py-1.5 text-xs text-slate-700 dark:text-slate-300 animate-in fade-in zoom-in-95 duration-100"
                      >
                        <button
                          onClick={() => handleOpenEditMeta(p)}
                          className="w-full text-left px-3.5 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2 cursor-pointer"
                        >
                          <Edit className="w-3.5 h-3.5 text-indigo-500" />
                          <span>编辑信息与更新</span>
                        </button>
                        <button
                          onClick={() => handleOpenEditContent(p)}
                          className="w-full text-left px-3.5 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2 cursor-pointer"
                        >
                          <Code className="w-3.5 h-3.5 text-indigo-500" />
                          <span>编辑配置 (YAML)</span>
                        </button>
                        <button
                          onClick={() => handleExport(p)}
                          disabled={exportLoading === p.id}
                          className="w-full text-left px-3.5 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2 cursor-pointer"
                        >
                          <Download className="w-3.5 h-3.5 text-emerald-500" />
                          <span>导出配置</span>
                        </button>
                        <button
                          onClick={() => handleOpenShare(p)}
                          className="w-full text-left px-3.5 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2 cursor-pointer"
                        >
                          <Share2 className="w-3.5 h-3.5 text-blue-500" />
                          <span>分享 (二维码/链接)</span>
                        </button>
                        <div className="h-px bg-slate-100 dark:bg-slate-800 my-1" />
                        <button
                          onClick={() => handleDelete(p.id)}
                          className="w-full text-left px-3.5 py-2 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-rose-600 dark:text-rose-400 flex items-center gap-2 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>删除订阅</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* 流量与到期时间模块 */}
                {hasTrafficInfo ? (
                  <div className="space-y-2 pt-1 bg-slate-50/70 dark:bg-slate-950/40 p-3 rounded-xl border border-slate-100 dark:border-slate-800/80">
                    {/* 上层说明 */}
                    <div className="flex items-center justify-between text-xs font-medium">
                      <div className="flex items-center space-x-1.5 text-slate-600 dark:text-slate-300">
                        <Activity className="w-3.5 h-3.5 text-indigo-500" />
                        <span>流量已用</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          isNearExhausted
                            ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                            : "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
                        }`}>
                          {totalBytes > 0 ? `${percent.toFixed(1)}%` : "已统计"}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                        <Calendar className="w-3 h-3 text-slate-400" />
                        <span>{expireInfo.dateStr}</span>
                        {expireInfo.remainingDays !== null && (
                          <span className={`font-semibold ${expireInfo.remainingDays <= 3 ? "text-rose-500" : "text-slate-600 dark:text-slate-300"}`}>
                            ({expireInfo.remainingDays > 0 ? `余 ${expireInfo.remainingDays} 天` : "已到期"})
                          </span>
                        )}
                      </div>
                    </div>

                    {/* 胶囊进度条 */}
                    <div className="w-full bg-slate-200/80 dark:bg-slate-800 h-2 rounded-full overflow-hidden p-0.5">
                      <div
                        className={`h-full transition-all duration-500 rounded-full shadow-2xs ${
                          isNearExhausted
                            ? "bg-gradient-to-r from-rose-500 to-amber-500"
                            : percent >= 75
                            ? "bg-gradient-to-r from-amber-500 to-orange-400"
                            : "bg-gradient-to-r from-indigo-500 via-purple-500 to-sky-400"
                        }`}
                        style={{ width: `${totalBytes > 0 ? percent : 100}%` }}
                      />
                    </div>

                    {/* 详情数据 */}
                    <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 pt-0.5">
                      <span>
                        已用 <strong className="text-slate-800 dark:text-slate-200">{formatBytes(usedBytes)}</strong>
                        {totalBytes > 0 && ` / 总计 ${formatBytes(totalBytes)}`}
                      </span>
                      {p.autoUpdateInterval ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400">
                          <Clock className="w-3 h-3" />
                          <span>每 {p.autoUpdateInterval}h 自动同步</span>
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="py-2.5 px-3 rounded-xl bg-slate-50/70 dark:bg-slate-950/30 border border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                    <div className="flex items-center space-x-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      <span>自建 / 本地 YAML 配置 · 无配额与到期限制</span>
                    </div>
                    {p.autoUpdateInterval ? (
                      <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 shrink-0">
                        <Clock className="w-3 h-3" />
                        <span>每 {p.autoUpdateInterval}h 更新</span>
                      </span>
                    ) : null}
                  </div>
                )}

                {/* 链接地址 */}
                <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono">
                  <div className="flex items-center gap-1.5 min-w-0 truncate" title={p.url || "本地文件"}>
                    <Globe className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
                    <span className="truncate">{p.url || "本地文件"}</span>
                  </div>
                  {p.url && (
                    <button
                      type="button"
                      title="复制订阅链接"
                      onClick={() => handleCopyCardUrl(p.id, p.url)}
                      className="pointer-events-auto shrink-0 p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition cursor-pointer"
                    >
                      {copiedUrlId === p.id ? (
                        <Check className="w-3.5 h-3.5 text-emerald-500" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>

              {/* 卡片底部操作与节点指标 */}
              <div className="relative pointer-events-none flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 pt-3 border-t border-slate-100 dark:border-slate-800/80">
                <div className="space-y-0.5">
                  <div className="flex items-center space-x-1.5">
                    <Layers className="w-3.5 h-3.5 text-slate-400" />
                    <span>节点储备: <strong className="text-slate-800 dark:text-slate-200">{p.nodeCount ?? 0} 个</strong></span>
                  </div>
                  <div className="text-[11px] text-slate-400 dark:text-slate-500">
                    更新时间: {p.updatedAt || "未知"}
                  </div>
                </div>

                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => handleUpdate(p.id)}
                    disabled={Boolean(actionLoading)}
                    className="pointer-events-auto flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-750 dark:text-slate-300 text-xs font-medium transition cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isUpdating ? "animate-spin text-indigo-500 dark:text-indigo-400" : ""}`} />
                    <span>更新</span>
                  </button>

                  <span role="status" className={`text-xs font-medium ${p.isSelected ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400 dark:text-slate-500"}`}>
                    {isSelecting ? "正在切换…" : p.isSelected ? "✓ 使用中" : "点击卡片使用"}
                  </span>
                </div>
              </div>
            </div>
          );
        })}

        {(!profiles || profiles.length === 0) && !loading && (
          <div className="col-span-2 p-12 rounded-2xl bg-white/80 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800/80 text-center space-y-4 shadow-sm">
            <div className="p-3.5 w-14 h-14 mx-auto rounded-3xl bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center border border-indigo-200 dark:border-indigo-500/20 shadow-sm">
              <Plus className="w-6 h-6" />
            </div>
            <div>
              <p className="text-base text-slate-800 dark:text-slate-200 font-bold">尚未添加任何订阅配置</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
                {mobile ? "添加订阅后即可查看节点；连接 VPN 需要另行点击连接并完成系统授权。" : "首次使用请点击下方按钮添加您的节点订阅链接，导入后系统将自动加载节点并激活代理网络。"}
              </p>
            </div>
            <button
              onClick={() => setShowAddModal(true)}
              className="inline-flex items-center space-x-1.5 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/20 transition cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>立即添加订阅链接</span>
            </button>
          </div>
        )}
      </div>

      {/* 1. 添加订阅模态框 (通过 Portal 挂载至 document.body，顶层覆盖所有内容包括 Header) */}
      {showAddModal &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="添加订阅配置"
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center p-4 animate-in fade-in duration-150"
          >
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4 animate-in zoom-in-95 duration-150">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">添加订阅配置</h3>
              <form onSubmit={handleAdd} className="space-y-4 text-xs">
                <fieldset disabled={actionLoading === "add"} className="space-y-4 min-w-0">
                  <div>
                    <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium">配置名称</label>
                    <input
                      type="text"
                      required
                      placeholder="例如: 我的主力订阅"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-hidden focus:border-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium">订阅链接 (Clash 格式)</label>
                    <input
                      type="url"
                      required
                      placeholder="https://..."
                      value={newUrl}
                      onChange={(e) => setNewUrl(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-hidden focus:border-indigo-500"
                    />
                  </div>

                  {addError && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400 break-words max-h-32 overflow-auto">{addError}</p>}
                  <div className="flex items-center justify-end space-x-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowAddModal(false)}
                      className="px-4 py-2 rounded-xl text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200 text-xs font-medium cursor-pointer"
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      disabled={actionLoading === "add"}
                      className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 disabled:opacity-50 flex items-center space-x-1.5 cursor-pointer"
                    >
                      {actionLoading === "add" && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                      <span>{actionLoading === "add" ? "下载并保存..." : "立即保存"}</span>
                    </button>
                  </div>
                </fieldset>
              </form>
            </div>
          </div>,
          document.body
        )}

      {/* 2. 编辑订阅信息与自动更新时间模态框 (通过 Portal 挂载至 document.body) */}
      {editMetaTarget &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="编辑订阅配置"
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center p-4 animate-in fade-in duration-150"
          >
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4 animate-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-slate-900 dark:text-white">编辑订阅配置</h3>
                <button
                  type="button"
                  aria-label="关闭编辑"
                  disabled={actionLoading === "metadata"}
                  onClick={() => setEditMetaTarget(null)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <form onSubmit={handleSaveEditMeta} className="space-y-4 text-xs">
                <fieldset disabled={actionLoading === "metadata"} className="space-y-4 min-w-0">
                  <div>
                    <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium">配置名称</label>
                    <input
                      type="text"
                      required
                      value={editMetaName}
                      onChange={(e) => setEditMetaName(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:border-indigo-500"
                    />
                  </div>

                  {editMetaTarget.url ? (
                    <>
                      <div>
                        <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium">订阅链接</label>
                        <input
                          type="url"
                          required
                          value={editMetaUrl}
                          onChange={(e) => setEditMetaUrl(e.target.value)}
                          className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:border-indigo-500"
                        />
                      </div>

                      <div>
                        <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium flex items-center justify-between">
                          <span>自动更新时间间隔</span>
                          <span className="text-indigo-600 dark:text-indigo-400 font-semibold">
                            {editMetaInterval === 0 ? "关闭自动更新" : `每 ${editMetaInterval} 小时更新一次`}
                          </span>
                        </label>
                        <select
                          value={editMetaInterval}
                          onChange={(e) => setEditMetaInterval(Number(e.target.value))}
                          className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:border-indigo-500"
                        >
                          <option value={0}>不自动更新（手动更新）</option>
                          <option value={1}>每 1 小时</option>
                          <option value={2}>每 2 小时</option>
                          <option value={6}>每 6 小时</option>
                          <option value={12}>每 12 小时</option>
                          <option value={24}>每 24 小时 (每天)</option>
                          <option value={48}>每 48 小时 (每两天)</option>
                        </select>
                      </div>
                    </>
                  ) : (
                    <p className="text-slate-500">本地配置可直接修改名称，无需订阅链接。</p>
                  )}
                  {metaError && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400 break-words max-h-32 overflow-auto">{metaError}</p>}

                  <div className="flex items-center justify-end space-x-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setEditMetaTarget(null)}
                      className="px-4 py-2 rounded-xl text-slate-600 hover:text-slate-900 dark:text-slate-400 text-xs font-medium cursor-pointer"
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 cursor-pointer"
                    >
                      {actionLoading === "metadata" ? "正在保存…" : "保存修改"}
                    </button>
                  </div>
                </fieldset>
              </form>
            </div>
          </div>,
          document.body
        )}

      {/* 3. 在线编辑配置内容 (YAML) 模态框 (通过 Portal 挂载至 document.body) */}
      {editContentTarget &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="编辑配置文件"
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[9999] flex items-center justify-center p-4 animate-in fade-in duration-150"
          >
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 w-full max-w-4xl shadow-2xl space-y-4 flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <Code className="w-4 h-4 text-indigo-500" />
                    编辑配置文件 - {editContentTarget.name}
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">直接修改订阅核心 YAML，保存后将自动通过内核语法校验并热重载生效</p>
                </div>
                <button
                  type="button"
                  onClick={closeContentEditor}
                  disabled={yamlSaving}
                  aria-label="关闭配置编辑"
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {yamlError && (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs">
                  {yamlError}
                </div>
              )}

              <div className="flex-1 min-h-[360px] flex flex-col">
                {yamlLoading ? (
                  <div className="flex-1 flex items-center justify-center text-slate-400 text-xs gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>正在读取配置内容...</span>
                  </div>
                ) : (
                  <textarea
                    aria-label="YAML 配置内容"
                    disabled={yamlSaving || !yamlLoaded}
                    value={yamlContent}
                    onChange={(e) => setYamlContent(e.target.value)}
                    placeholder="YAML 配置文本..."
                    className="w-full flex-1 p-4 rounded-xl bg-slate-950 font-mono text-xs text-slate-200 border border-slate-800 focus:outline-hidden focus:border-indigo-500 resize-none leading-relaxed"
                    spellCheck={false}
                  />
                )}
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-[11px] text-slate-500">提示：修改有误将触发内核拒绝回退，保障原有代理不中断</span>
                <div className="flex items-center space-x-3">
                  <button
                    type="button"
                    onClick={closeContentEditor}
                    disabled={yamlSaving}
                    className="px-4 py-2 rounded-xl text-slate-600 hover:text-slate-900 dark:text-slate-400 text-xs font-medium cursor-pointer"
                  >
                    关闭
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveEditContent}
                    disabled={yamlSaving || yamlLoading || !yamlLoaded}
                    className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
                  >
                    {yamlSaving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                    <span>{yamlSaving ? "校验并保存中..." : "保存并重载"}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* 4. 分享模态框 (二维码与链接) (通过 Portal 挂载至 document.body) */}
      {shareTarget &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="分享订阅配置"
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center p-4 animate-in fade-in duration-150"
          >
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 w-full max-w-sm shadow-2xl space-y-5 text-center animate-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <QrCode className="w-4 h-4 text-indigo-500" />
                  分享订阅配置
                </h3>
                <button
                  type="button"
                  onClick={closeShare}
                  aria-label="关闭订阅分享"
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <p className="text-xs text-slate-500 dark:text-slate-400">
                使用手机客户端或其他设备扫描二维码导入，或直接复制订阅链接
              </p>

              {/* 二维码展示区 */}
              <div className="p-4 bg-white rounded-2xl border border-slate-200 shadow-inner inline-block mx-auto">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="订阅二维码" className="w-48 h-48 mx-auto" />
                ) : (
                  <div className="w-48 h-48 flex items-center justify-center text-slate-400 text-xs">
                    {qrError || "生成二维码中..."}
                  </div>
                )}
              </div>

              {/* 链接展示与复制按钮 */}
              <div className="space-y-2 text-left">
                <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">订阅链接</div>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={shareTarget.url || "本地导入，无远程链接"}
                    className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-800 dark:text-slate-200 text-xs font-mono select-all focus:outline-hidden"
                  />
                  <button
                    type="button"
                    onClick={handleCopyLink}
                    disabled={!shareTarget.url}
                    className="px-3 py-2 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-600 dark:bg-indigo-600/20 dark:hover:bg-indigo-600/30 dark:text-indigo-400 text-xs font-semibold shrink-0 transition flex items-center gap-1 disabled:opacity-50 cursor-pointer"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? "已复制" : "复制"}</span>
                  </button>
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={closeShare}
                  className="w-full py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 text-xs font-semibold transition cursor-pointer"
                >
                  完成
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      <ProfileSwitchDialog state={profileSwitch.state} actions={profileSwitch.actions} />
    </div>
  );
};
