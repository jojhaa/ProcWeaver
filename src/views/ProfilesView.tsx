import React, { useState, useEffect, useRef } from "react";
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
  QrCode,
  X,
} from "lucide-react";
import QRCode from "qrcode";
import { useProfileSwitch } from "../hooks/useProfileSwitch";
import { ProfileSwitchDialog } from "../components/ProfileSwitchDialog";

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

export const ProfilesView: React.FC = () => {
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

  // 4. 分享模态框 (二维码与链接复制)
  const [shareTarget, setShareTarget] = useState<ProfileItem | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);

  // 导出提示
  const [exportLoading, setExportLoading] = useState<string | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);

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
    if (!newName || !newUrl) return;
    setActionLoading("add");
    try {
      await addProfile(newName, newUrl);
      setShowAddModal(false);
      setNewName("");
      setNewUrl("");
      showNotification("订阅添加成功");
      await loadData();
      window.dispatchEvent(new CustomEvent("procweaver-profile-changed"));
      window.dispatchEvent(new CustomEvent("netbox-profile-changed"));
    } catch (err: unknown) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "添加订阅失败");
    } finally {
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
    setActionLoading(`sel_${id}`);
    try {
      if (!await profileSwitch.requestSwitch(id)) return;
      showNotification("已切换并应用该订阅配置");
      await loadData();
      window.dispatchEvent(new CustomEvent("procweaver-profile-changed"));
      window.dispatchEvent(new CustomEvent("netbox-profile-changed"));
    } catch (err: unknown) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "应用配置失败");
    } finally {
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
  };

  // 提交元数据编辑
  const handleSaveEditMeta = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editMetaTarget) return;
    try {
      await editProfileMetadata(
        editMetaTarget.id,
        editMetaName,
        editMetaUrl,
        Number(editMetaInterval) || 0
      );
      setEditMetaTarget(null);
      showNotification("订阅信息更新成功");
      await loadData();
      window.dispatchEvent(new CustomEvent("procweaver-profile-changed"));
      window.dispatchEvent(new CustomEvent("netbox-profile-changed"));
    } catch (err: unknown) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "修改订阅失败");
    }
  };

  // 打开编辑配置内容 (YAML)
  const handleOpenEditContent = async (item: ProfileItem) => {
    setActiveMenuId(null);
    setEditContentTarget(item);
    setYamlLoading(true);
    setYamlError(null);
    try {
      const content = await getProfileContent(item.id);
      setYamlContent(content);
    } catch (err: unknown) {
      setYamlError(typeof err === "string" ? err : err instanceof Error ? err.message : "读取配置文件失败");
    } finally {
      setYamlLoading(false);
    }
  };

  // 保存编辑配置内容 (YAML)
  const handleSaveEditContent = async () => {
    if (!editContentTarget) return;
    setYamlSaving(true);
    setYamlError(null);
    try {
      await saveProfileContent(editContentTarget.id, yamlContent);
      setEditContentTarget(null);
      showNotification("配置文件保存成功并已重载核心");
      await loadData();
      window.dispatchEvent(new CustomEvent("procweaver-profile-changed"));
      window.dispatchEvent(new CustomEvent("netbox-profile-changed"));
    } catch (err: unknown) {
      setYamlError(typeof err === "string" ? err : err instanceof Error ? err.message : "保存配置失败");
    } finally {
      setYamlSaving(false);
    }
  };

  // 打开分享模态框并生成二维码
  const handleOpenShare = async (item: ProfileItem) => {
    setActiveMenuId(null);
    setShareTarget(item);
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
      setQrDataUrl(qr);
    } catch (err) {
      console.error("生成二维码失败", err);
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
      // 浏览器/Webview 触发安全下载保存
      const blob = new Blob([content], { type: "application/x-yaml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${item.name.replace(/[\\/:*?"<>|]/g, "_") || "profile"}.yaml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showNotification(`已成功导出 "${item.name}.yaml"`);
    } catch (err: unknown) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "导出配置失败");
    } finally {
      setExportLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* 顶部标题与操作 */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white tracking-wide flex items-center gap-2">
            <FileText className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
            订阅配置管理
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">管理节点订阅、自动更新定时、分享与在线配置编辑</p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 transition"
        >
          <Plus className="w-4 h-4" />
          <span>添加订阅链接</span>
        </button>
      </div>

      {/* 提示消息 */}
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

      {/* 订阅卡片列表 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(profiles || []).map((p) => {
          if (!p) return null;
          const isUpdating = actionLoading === p.id;
          const isSelecting = actionLoading === `sel_${p.id}`;

          // 计算已用流量与百分比
          const usedBytes = (p.upload || 0) + (p.download || 0);
          const totalBytes = p.total || 0;
          const hasTrafficInfo = totalBytes > 0 || usedBytes > 0 || !!p.expire;
          const percent = totalBytes > 0 ? Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100)) : 0;
          const isNearExhausted = percent >= 90;
          const isMenuOpen = activeMenuId === p.id;

          return (
            <div
              key={p.id || Math.random()}
              className={`p-5 rounded-2xl border transition relative flex flex-col justify-between space-y-4 shadow-sm ${
                p.isSelected
                  ? "bg-indigo-50/50 dark:bg-slate-900 border-indigo-500/60 shadow-indigo-500/10 dark:shadow-xl"
                  : "bg-white/80 hover:bg-white dark:bg-slate-900/60 dark:hover:bg-slate-900/90 border-slate-200 dark:border-slate-800"
              }`}
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className="font-bold text-base text-slate-900 dark:text-white">{p.name || "未命名配置"}</span>
                    {p.isSelected && (
                      <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                        <CheckCircle className="w-3 h-3" />
                        <span>正在生效</span>
                      </span>
                    )}
                  </div>

                  {/* 更多操作下拉菜单按钮 */}
                  <div className="relative">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveMenuId(isMenuOpen ? null : p.id);
                      }}
                      title="更多操作"
                      className="text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>

                    {/* 下拉浮层 */}
                    {isMenuOpen && (
                      <div
                        ref={menuRef}
                        className="absolute right-0 top-8 w-44 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl z-30 py-1.5 text-xs text-slate-700 dark:text-slate-300 animate-in fade-in zoom-in-95 duration-100"
                      >
                        <button
                          onClick={() => handleOpenEditMeta(p)}
                          className="w-full text-left px-3.5 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2"
                        >
                          <Edit className="w-3.5 h-3.5 text-indigo-500" />
                          <span>编辑信息与更新</span>
                        </button>
                        <button
                          onClick={() => handleOpenEditContent(p)}
                          className="w-full text-left px-3.5 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2"
                        >
                          <Code className="w-3.5 h-3.5 text-indigo-500" />
                          <span>编辑配置 (YAML)</span>
                        </button>
                        <button
                          onClick={() => handleExport(p)}
                          disabled={exportLoading === p.id}
                          className="w-full text-left px-3.5 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2"
                        >
                          <Download className="w-3.5 h-3.5 text-emerald-500" />
                          <span>导出配置</span>
                        </button>
                        <button
                          onClick={() => handleOpenShare(p)}
                          className="w-full text-left px-3.5 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2"
                        >
                          <Share2 className="w-3.5 h-3.5 text-blue-500" />
                          <span>分享 (二维码/链接)</span>
                        </button>
                        <div className="h-px bg-slate-100 dark:bg-slate-800 my-1" />
                        <button
                          onClick={() => handleDelete(p.id)}
                          className="w-full text-left px-3.5 py-2 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-rose-600 dark:text-rose-400 flex items-center gap-2"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>删除订阅</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* 流量与到期时间模块 */}
                {hasTrafficInfo && (
                  <div className="space-y-1.5 pt-0.5">
                    {/* 进度条 */}
                    <div className="w-full bg-slate-200 dark:bg-slate-700/60 h-1.5 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-500 rounded-full ${
                          isNearExhausted
                            ? "bg-rose-500"
                            : percent >= 75
                            ? "bg-amber-500"
                            : "bg-indigo-500 dark:bg-indigo-400"
                        }`}
                        style={{ width: `${totalBytes > 0 ? percent : 0}%` }}
                      />
                    </div>
                    {/* 已用 / 总量 · 到期日 样式如：39.6GB / 100GB · 2026-10-11 */}
                    <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-medium tracking-tight">
                      <span>
                        {totalBytes > 0
                          ? `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`
                          : formatBytes(usedBytes)}
                        {p.expire ? ` · ${formatExpireDate(p.expire)}` : ""}
                      </span>
                      {p.autoUpdateInterval ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400">
                          <Clock className="w-3 h-3" />
                          <span>每 {p.autoUpdateInterval}h 更新</span>
                        </span>
                      ) : null}
                    </div>
                  </div>
                )}

                <p className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate flex items-center gap-1" title={p.url}>
                  <Globe className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
                  <span>{p.url || "本地文件"}</span>
                </p>
              </div>

              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 pt-3 border-t border-slate-200 dark:border-slate-800">
                <div className="space-y-0.5">
                  <div>节点总数: <strong className="text-slate-800 dark:text-slate-200">{p.nodeCount ?? 0} 个</strong></div>
                  <div className="text-[11px] text-slate-400 dark:text-slate-500">更新时间: {p.updatedAt || "未知"}</div>
                </div>

                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => handleUpdate(p.id)}
                    disabled={isUpdating}
                    className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 dark:border-slate-700 text-xs border transition disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isUpdating ? "animate-spin text-indigo-500 dark:text-indigo-400" : ""}`} />
                    <span>更新</span>
                  </button>

                  {!p.isSelected && (
                    <button
                      onClick={() => handleSelect(p.id)}
                      disabled={isSelecting}
                      className="px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-600 border border-indigo-200 dark:bg-indigo-600/15 dark:hover:bg-indigo-600/30 dark:text-indigo-400 dark:border-indigo-500/30 text-xs font-semibold transition disabled:opacity-50"
                    >
                      {isSelecting ? "应用中..." : "应用"}
                    </button>
                  )}
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
                首次使用请点击下方按钮添加您的节点订阅链接，导入后系统将自动加载节点并激活代理网络。
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

      {/* 1. 添加订阅模态框 */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">添加订阅配置</h3>
            <form onSubmit={handleAdd} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium">配置名称</label>
                <input
                  type="text"
                  required
                  placeholder="例如: 我的主力订阅"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
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
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex items-center justify-end space-x-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-xl text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200 text-xs font-medium"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={actionLoading === "add"}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 disabled:opacity-50 flex items-center space-x-1.5"
                >
                  {actionLoading === "add" && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  <span>{actionLoading === "add" ? "下载并保存..." : "立即保存"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 2. 编辑订阅信息与自动更新时间模态框 */}
      {editMetaTarget && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">编辑订阅配置</h3>
              <button onClick={() => setEditMetaTarget(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveEditMeta} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium">配置名称</label>
                <input
                  type="text"
                  required
                  value={editMetaName}
                  onChange={(e) => setEditMetaName(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium">订阅链接</label>
                <input
                  type="url"
                  required
                  value={editMetaUrl}
                  onChange={(e) => setEditMetaUrl(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500"
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
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500"
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

              <div className="flex items-center justify-end space-x-3 pt-2">
                <button
                  type="button"
                  onClick={() => setEditMetaTarget(null)}
                  className="px-4 py-2 rounded-xl text-slate-600 hover:text-slate-900 dark:text-slate-400 text-xs font-medium"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30"
                >
                  保存修改
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 3. 在线编辑配置内容 (YAML) 模态框 */}
      {editContentTarget && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 w-full max-w-4xl shadow-2xl space-y-4 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <Code className="w-4 h-4 text-indigo-500" />
                  编辑配置文件 - {editContentTarget.name}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">直接修改订阅核心 YAML，保存后将自动通过内核语法校验并热重载生效</p>
              </div>
              <button onClick={() => setEditContentTarget(null)} className="text-slate-400 hover:text-slate-600">
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
                  value={yamlContent}
                  onChange={(e) => setYamlContent(e.target.value)}
                  placeholder="YAML 配置文本..."
                  className="w-full flex-1 p-4 rounded-xl bg-slate-950 font-mono text-xs text-slate-200 border border-slate-800 focus:outline-none focus:border-indigo-500 resize-none leading-relaxed"
                  spellCheck={false}
                />
              )}
            </div>

            <div className="flex items-center justify-between pt-2">
              <span className="text-[11px] text-slate-500">提示：修改有误将触发内核拒绝回退，保障原有代理不中断</span>
              <div className="flex items-center space-x-3">
                <button
                  type="button"
                  onClick={() => setEditContentTarget(null)}
                  className="px-4 py-2 rounded-xl text-slate-600 hover:text-slate-900 dark:text-slate-400 text-xs font-medium"
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={handleSaveEditContent}
                  disabled={yamlSaving || yamlLoading}
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 disabled:opacity-50 flex items-center gap-1.5"
                >
                  {yamlSaving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  <span>{yamlSaving ? "校验并保存中..." : "保存并重载"}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. 分享模态框 (二维码与链接) */}
      {shareTarget && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 w-full max-w-sm shadow-2xl space-y-5 text-center">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <QrCode className="w-4 h-4 text-indigo-500" />
                分享订阅配置
              </h3>
              <button onClick={() => setShareTarget(null)} className="text-slate-400 hover:text-slate-600">
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
                  生成二维码中...
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
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-800 dark:text-slate-200 text-xs font-mono select-all focus:outline-none"
                />
                <button
                  onClick={handleCopyLink}
                  disabled={!shareTarget.url}
                  className="px-3 py-2 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-600 dark:bg-indigo-600/20 dark:hover:bg-indigo-600/30 dark:text-indigo-400 text-xs font-semibold shrink-0 transition flex items-center gap-1 disabled:opacity-50"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? "已复制" : "复制"}</span>
                </button>
              </div>
            </div>

            <div className="pt-2">
              <button
                onClick={() => setShareTarget(null)}
                className="w-full py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 text-xs font-semibold transition"
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}
      <ProfileSwitchDialog state={profileSwitch.state} actions={profileSwitch.actions} />
    </div>
  );
};
