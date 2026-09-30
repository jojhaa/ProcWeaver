import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Link,
  QrCode,
  Image,
  ClipboardPaste,
  Edit,
} from "lucide-react";
import {
  localNodeEndpoint,
  nodeConfigTemplate,
  nodeProtocols,
  usesConfigEditor,
  type LocalNodeDraft,
  type NodeConfig,
} from "../types/localNodes";
import type { LocalNodeDialog as DialogState } from "../hooks/useLocalNodes";
import { profileImportApi } from "../api/profileImport";

interface Props {
  dialog: DialogState;
  busy: boolean;
  error: string;
  preview: LocalNodeDraft[];
  onClose: () => void;
  onSave: (draft: LocalNodeDraft) => void;
  onDelete: () => void;
  onPreview: (text: string, mode: "links" | "yaml") => void;
  onImport: () => void;
  onClearPreview: () => void;
}

const inputClass =
  "w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3.5 py-2.5 text-xs text-slate-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 disabled:opacity-50 transition";
const secondary =
  "px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition cursor-pointer";
const primary =
  "px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-xs font-semibold shadow-md shadow-indigo-600/20 disabled:opacity-50 transition cursor-pointer";

const isConfigEditor = (config: NodeConfig) =>
  usesConfigEditor(config.type) || (config.type === "wireguard" && config.peers !== undefined);

const editableKeys = (config: NodeConfig) => {
  if (isConfigEditor(config)) return new Set(["name", "type"]);
  const fields: Record<string, string[]> = {
    vmess: ["uuid", "cipher", "alterId", "servername", "tls"],
    vless: ["uuid", "flow", "servername", "tls"],
    ss: ["password", "cipher"],
    trojan: ["password", "sni"],
    hysteria2: ["password", "sni"],
    tuic: ["uuid", "password", "token", "sni"],
    anytls: ["password", "sni"],
    socks5: ["username", "password", "tls", "sni"],
    http: ["username", "password", "tls", "sni"],
    wireguard: ["ip", "ipv6", "private-key", "public-key", "pre-shared-key"],
  };
  return new Set(["name", "type", "server", "port", "udp", ...(fields[String(config.type)] || [])]);
};

const extraOptions = (config: NodeConfig) =>
  Object.fromEntries(Object.entries(config).filter(([k]) => !editableKeys(config).has(k)));

export function LocalNodeDialog(props: Props) {
  const mobile = typeof document !== "undefined" && document.documentElement.dataset.platform === "android";
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<LocalNodeDraft>({ name: "", config: {} });
  const [advanced, setAdvanced] = useState("");
  const [formError, setFormError] = useState("");
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"links" | "yaml">("links");
  const protocolDrafts = useRef(new Map<string, { config: NodeConfig; advanced: string }>());

  // 移动端分段 Tab：quick (极速链接/扫码导入) vs manual (手动填写参数)
  const [creationTab, setCreationTab] = useState<"quick" | "manual">("quick");

  useEffect(() => {
    if (!props.dialog) {
      ref.current?.close();
      return;
    }
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = ref.current;

    if (props.dialog.kind === "edit") {
      setDraft(structuredClone(props.dialog.draft));
      setAdvanced(JSON.stringify(extraOptions(props.dialog.draft.config), null, 2));
      // 若已有 id 则是编辑已有节点，切到 manual；若无 id 则是新建，手机端优先 quick
      setCreationTab(props.dialog.draft.id ? "manual" : "quick");
    } else if (props.dialog.kind === "import") {
      setCreationTab("quick");
    }

    setText("");
    setFormError("");
    setMode("links");
    protocolDrafts.current.clear();

    if (!ref.current?.open) ref.current?.showModal();
    return () => {
      element?.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, [props.dialog]);

  if (!props.dialog) return null;
  const dialog = props.dialog;
  const isDelete = dialog.kind === "delete";
  const isEditingExisting = dialog.kind === "edit" && Boolean(draft.id);

  const close = () => {
    if (!props.busy) {
      ref.current?.close();
      props.onClose();
    }
  };

  const kind = String(draft.config.type || "vless");
  const configEditor = isConfigEditor(draft.config);
  const tokenAuth = kind === "tuic" && draft.config.token !== undefined;
  const nodeContent = dialog.kind === "edit" && advanced.trim() !== "" && !advanced.trim().startsWith("{");

  const fillFromPreview = () => {
    const node = props.preview[0];
    if (!node || props.preview.length !== 1) return;
    setDraft((d) => ({
      ...node,
      ...(d.id ? { id: d.id, name: d.name } : {}),
      config: structuredClone(node.config),
    }));
    setAdvanced(JSON.stringify(extraOptions(node.config), null, 2));
    setFormError("");
    protocolDrafts.current.clear();
    props.onClearPreview();
    setCreationTab("manual");
  };

  const previewOrApply = () => {
    setFormError("");
    if (!props.preview.length) props.onPreview(advanced, "links");
    else if (props.preview.length === 1) fillFromPreview();
    else props.onImport();
  };

  const changeProtocol = (next: string) => {
    props.onClearPreview();
    protocolDrafts.current.set(kind, { config: structuredClone(draft.config), advanced });
    const previous = protocolDrafts.current.get(next);
    const config = previous ? structuredClone(previous.config) : nodeConfigTemplate(next);
    setAdvanced(previous?.advanced ?? JSON.stringify(extraOptions(config), null, 2));
    setFormError("");
    setDraft((d) => ({ ...d, config }));
  };

  const put = (key: string, value: unknown) =>
    setDraft((d) => {
      const config = { ...d.config };
      if (value === "" && key !== "token") delete config[key];
      else config[key] = value;
      return { ...d, config };
    });

  const field = (key: string, label: string, type = "text", required = false) => (
    <label key={key} className="block space-y-1.5 text-xs text-slate-600 dark:text-slate-400">
      <span>
        {label}
        {required ? " *" : ""}
      </span>
      <input
        className={inputClass}
        value={String(draft.config[key] ?? "")}
        type={type}
        required={required}
        min={type === "number" ? 0 : undefined}
        max={key === "port" ? 65535 : undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) =>
          put(key, type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)
        }
      />
    </label>
  );

  const submit = () => {
    try {
      const keys = editableKeys(draft.config);
      let config = Object.fromEntries(Object.entries(draft.config).filter(([k]) => keys.has(k)));
      if (advanced.trim()) {
        const extra = JSON.parse(advanced) as NodeConfig;
        if (!extra || typeof extra !== "object" || Array.isArray(extra))
          throw new Error("高级选项须为 JSON 对象");
        if (Object.keys(extra).some((k) => keys.has(k)))
          throw new Error("高级选项不能覆盖基本字段，请在上方修改");
        config = { ...config, ...extra };
      }
      setFormError("");
      props.onSave({ ...draft, config });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "高级选项 JSON 无效");
    }
  };

  // 移动端：快捷粘贴剪贴板
  const handlePasteClipboard = async () => {
    setFormError("");
    try {
      const clip = await navigator.clipboard.readText();
      if (clip && clip.trim()) {
        setText(clip.trim());
        props.onPreview(clip.trim(), mode);
      } else {
        setFormError("剪贴板内容为空");
      }
    } catch {
      setFormError("无法访问剪贴板，请长按输入框手动粘贴");
    }
  };

  // 移动端：扫描二维码
  const handleScanQr = async () => {
    setFormError("");
    try {
      const res = await profileImportApi.native("scanQr");
      if (!res.cancelled && res.content) {
        setText(res.content);
        props.onPreview(res.content, "links");
      }
    } catch (e) {
      setFormError("扫码失败: " + String(e));
    }
  };

  // 移动端：相册识别二维码
  const handleReadQrImage = async () => {
    setFormError("");
    try {
      const res = await profileImportApi.native("readQrImage");
      if (!res.cancelled && res.content) {
        setText(res.content);
        props.onPreview(res.content, "links");
      }
    } catch (e) {
      setFormError("识别二维码失败: " + String(e));
    }
  };

  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby="local-node-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (!mobile && e.target === ref.current && !props.busy) {
          const r = ref.current.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
            close();
        }
      }}
      className={
        mobile
          ? "fixed inset-0 z-50 w-full h-full max-w-none max-h-none m-0 p-0 border-0 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200 flex flex-col"
          : "m-auto w-[min(42rem,calc(100vw-2rem))] max-h-[90dvh] overflow-y-auto rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-0 text-slate-800 dark:text-slate-200 shadow-xl backdrop:bg-slate-950/40"
      }
    >
      {/* 弹窗头部 */}
      <header className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 px-5 py-4 shrink-0 bg-white dark:bg-slate-900">
        <div>
          <h2 id="local-node-title" className="text-sm font-bold text-slate-900 dark:text-white">
            {isDelete
              ? "删除本地节点"
              : isEditingExisting
              ? "编辑本地节点"
              : dialog.kind === "import"
              ? "导入节点"
              : "新增本地节点"}
          </h2>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            独立保存在本机，切换或更新订阅时始终保留。
          </p>
        </div>
        <button
          type="button"
          aria-label="关闭节点窗口"
          disabled={props.busy}
          onClick={close}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
        >
          <X size={18} />
        </button>
      </header>

      {/* 移动端新增节点分段控制器 (链接/扫码 vs 手动参数) */}
      {!isDelete && !isEditingExisting && (
        <div className="px-5 pt-3 pb-1 shrink-0 bg-white dark:bg-slate-900 border-b border-slate-100/60 dark:border-slate-800/60">
          <div className="flex bg-slate-100 dark:bg-slate-800/80 p-1 rounded-xl text-xs">
            <button
              type="button"
              onClick={() => {
                setCreationTab("quick");
                props.onClearPreview();
              }}
              className={`flex-1 py-1.5 rounded-lg font-semibold transition text-center cursor-pointer flex items-center justify-center space-x-1.5 ${
                creationTab === "quick"
                  ? "bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-xs"
                  : "text-slate-600 dark:text-slate-400"
              }`}
            >
              <Link size={13} />
              <span>链接 / 扫码极速导入</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setCreationTab("manual");
                props.onClearPreview();
              }}
              className={`flex-1 py-1.5 rounded-lg font-semibold transition text-center cursor-pointer flex items-center justify-center space-x-1.5 ${
                creationTab === "manual"
                  ? "bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-xs"
                  : "text-slate-600 dark:text-slate-400"
              }`}
            >
              <Edit size={13} />
              <span>手动配置参数</span>
            </button>
          </div>
        </div>
      )}

      {/* 弹窗内容主体 */}
      <form
        className="flex-1 min-h-0 flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (!props.busy) {
            if (isDelete) props.onDelete();
            else if (creationTab === "quick" && props.preview.length) props.onImport();
            else if (creationTab === "quick") props.onPreview(text, mode);
            else if (nodeContent) previewOrApply();
            else submit();
          }
        }}
      >
        <fieldset disabled={props.busy} className="flex-1 overflow-y-auto p-5 space-y-4 min-w-0">
          {/* 模式 1：删除确认 */}
          {isDelete ? (
            <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/40 space-y-2">
              <h3 className="text-xs font-bold text-rose-700 dark:text-rose-400">
                确认删除此本地节点？
              </h3>
              <p className="text-xs text-rose-600 dark:text-rose-300 leading-relaxed break-words">
                删除「{dialog.node.name}」后无法自动撤销。若规则或自建线路仍引用此节点，将阻止删除并提示对应引用位置。
              </p>
            </div>
          ) : creationTab === "quick" ? (
            /* 模式 2：链接/扫码极速导入模式 */
            <div className="space-y-3.5">
              {/* 快捷操作微卡片 */}
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => void handlePasteClipboard()}
                  className="flex flex-col items-center justify-center gap-1 p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:border-indigo-500 transition text-xs font-semibold shadow-2xs cursor-pointer"
                >
                  <ClipboardPaste className="w-4 h-4 text-indigo-500" />
                  <span>粘贴剪贴板</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleScanQr()}
                  className="flex flex-col items-center justify-center gap-1 p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:border-indigo-500 transition text-xs font-semibold shadow-2xs cursor-pointer"
                >
                  <QrCode className="w-4 h-4 text-emerald-500" />
                  <span>扫描二维码</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleReadQrImage()}
                  className="flex flex-col items-center justify-center gap-1 p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:border-indigo-500 transition text-xs font-semibold shadow-2xs cursor-pointer"
                >
                  <Image className="w-4 h-4 text-amber-500" />
                  <span>相册识码</span>
                </button>
              </div>

              {/* 格式切换与输入区 */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500">
                    {mode === "links" ? "粘贴节点链接 / Base64" : "粘贴节点 YAML / JSON"}
                  </span>
                  <div className="flex items-center space-x-1">
                    <button
                      type="button"
                      onClick={() => {
                        setMode("links");
                        props.onClearPreview();
                      }}
                      className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                        mode === "links"
                          ? "bg-indigo-600 text-white"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      单/多链接
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMode("yaml");
                        props.onClearPreview();
                      }}
                      className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                        mode === "yaml"
                          ? "bg-indigo-600 text-white"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      YAML/JSON
                    </button>
                  </div>
                </div>

                <textarea
                  aria-label="导入内容"
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    props.onClearPreview();
                  }}
                  spellCheck={false}
                  placeholder={
                    mode === "links"
                      ? "支持 vless://, vmess://, ss://, trojan://, hysteria2://, tuic:// 等链接，或整段 Base64 编码"
                      : "proxies:\n  - name: 节点名称\n    type: vless\n    server: ..."
                  }
                  className={`${inputClass} font-mono min-h-32 leading-relaxed`}
                  required
                />
              </div>

              {/* 解析预览卡片列表 */}
              {!!props.preview.length && (
                <div className="rounded-2xl border border-indigo-200 dark:border-indigo-800/60 overflow-hidden shadow-2xs space-y-0 animate-in fade-in zoom-in-95 duration-150">
                  <div className="p-3 bg-indigo-50/70 dark:bg-indigo-950/40 flex items-center justify-between border-b border-indigo-100 dark:border-indigo-900/40">
                    <span className="text-xs font-bold text-indigo-700 dark:text-indigo-300">
                      已成功解析 {props.preview.length} 个节点
                    </span>
                    <button
                      type="button"
                      onClick={props.onClearPreview}
                      className="text-[11px] text-slate-400 hover:text-slate-600 cursor-pointer"
                    >
                      清空重新解析
                    </button>
                  </div>
                  <ul className="max-h-48 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 bg-white dark:bg-slate-900">
                    {props.preview.map((n, i) => (
                      <li key={i} className="p-2.5 text-xs flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-bold text-slate-800 dark:text-slate-200 truncate">
                            {n.name}
                          </div>
                          <div className="text-[10px] text-slate-400 font-mono truncate">
                            {localNodeEndpoint(n.config)}
                          </div>
                        </div>
                        <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-[10px] text-slate-500 uppercase shrink-0">
                          {String(n.config.type)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            /* 模式 3：手动表单填写模式 */
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <label className="block space-y-1 text-xs text-slate-600 dark:text-slate-400">
                  <span>节点名称 *</span>
                  <input
                    value={draft.name}
                    required
                    maxLength={160}
                    placeholder="例如：自建专线-01"
                    className={inputClass}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  />
                </label>

                <label className="block space-y-1 text-xs text-slate-600 dark:text-slate-400">
                  <span>节点协议 *</span>
                  <select
                    className={inputClass}
                    value={kind}
                    onChange={(e) => changeProtocol(e.target.value)}
                  >
                    {nodeProtocols.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>

                {!configEditor && (
                  <>
                    {field("server", "服务器地址 (域名 / IP)", "text", true)}
                    {field("port", "端口 (Port)", "number", true)}
                    {kind === "tuic" && (
                      <label className="block space-y-1 text-xs text-slate-600 dark:text-slate-400">
                        <span>TUIC 认证方式</span>
                        <select
                          className={inputClass}
                          value={tokenAuth ? "token" : "uuid"}
                          onChange={(e) =>
                            setDraft((d) => {
                              const config = { ...d.config };
                              if (e.target.value === "token") {
                                delete config.uuid;
                                delete config.password;
                                config.token = "";
                              } else {
                                delete config.token;
                                config.uuid = "";
                                config.password = "";
                              }
                              return { ...d, config };
                            })
                          }
                        >
                          <option value="uuid">v5 · UUID / 密码</option>
                          <option value="token">v4 · Token</option>
                        </select>
                      </label>
                    )}
                    {["vmess", "vless", "tuic"].includes(kind) &&
                      !tokenAuth &&
                      field("uuid", "UUID 密钥", "text", true)}
                    {["ss", "trojan", "hysteria2", "tuic", "anytls"].includes(kind) &&
                      !tokenAuth &&
                      field("password", "连接密码", "password", true)}
                    {tokenAuth && field("token", "认证 Token", "password", true)}
                    {["socks5", "http"].includes(kind) && (
                      <>
                        {field("username", "认证用户名（选填）")}
                        {field("password", "认证密码（选填）", "password")}
                      </>
                    )}
                    {["ss", "vmess"].includes(kind) && field("cipher", "加密算法", "text", true)}
                    {kind === "vmess" && field("alterId", "Alter ID", "number")}
                    {kind === "vless" && field("flow", "Flow 流控（选填，如 xtls-rprx-vision）")}
                    {kind !== "wireguard" &&
                      kind !== "ss" &&
                      field(
                        ["vmess", "vless"].includes(kind) ? "servername" : "sni",
                        "TLS 服务器名称 (SNI，选填)"
                      )}
                  </>
                )}
              </div>

              {!configEditor && (
                <div className="flex flex-wrap items-center gap-4 pt-1 text-xs">
                  {["vmess", "vless", "http", "socks5"].includes(kind) && (
                    <label className="flex items-center space-x-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draft.config.tls === true}
                        onChange={(e) => put("tls", e.target.checked)}
                        className="rounded text-indigo-600"
                      />
                      <span>启用 TLS 加密</span>
                    </label>
                  )}
                  <label className="flex items-center space-x-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.config.udp === true}
                      onChange={(e) => put("udp", e.target.checked)}
                      className="rounded text-indigo-600"
                    />
                    <span>启用 UDP 转发</span>
                  </label>
                </div>
              )}

              {/* 高级选项折叠 */}
              <details
                key={configEditor ? kind : "basic"}
                open={configEditor ? true : undefined}
                className="rounded-2xl border border-slate-200 dark:border-slate-800 p-3 text-xs space-y-2"
              >
                <summary className="cursor-pointer font-bold text-slate-700 dark:text-slate-300">
                  {configEditor ? "协议核心配置 JSON" : "高级 JSON 选项与额外参数"}
                </summary>
                <p className="text-[11px] text-slate-400">
                  可在此处补充混淆、WebSocket 路径等 Mihomo 支持的高级 JSON 参数。
                </p>
                <textarea
                  aria-label="高级选项"
                  className={`${inputClass} font-mono min-h-24`}
                  spellCheck={false}
                  value={advanced}
                  onChange={(e) => {
                    setAdvanced(e.target.value);
                    setFormError("");
                  }}
                  placeholder={'例如：{"network":"ws","ws-opts":{"path":"/api"}}'}
                />
              </details>
            </div>
          )}

          {/* 错误提示 */}
          {(props.error || formError) && (
            <p
              role="alert"
              className="rounded-xl p-3 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/30 break-words"
            >
              {formError || props.error}
            </p>
          )}
        </fieldset>

        {/* 底部固定操作栏 */}
        <footer className="flex items-center justify-end gap-2.5 px-5 py-4 border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0">
          <button type="button" className={secondary} disabled={props.busy} onClick={close}>
            取消
          </button>

          {isDelete ? (
            <button
              type="button"
              onClick={props.onDelete}
              disabled={props.busy}
              className="px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold shadow-md"
            >
              {props.busy ? "删除中…" : "确认删除"}
            </button>
          ) : creationTab === "quick" ? (
            props.preview.length > 0 ? (
              <button
                type="button"
                disabled={props.busy}
                onClick={props.onImport}
                className={primary}
              >
                {props.busy ? "导入中…" : `保存 ${props.preview.length} 个节点到本地`}
              </button>
            ) : (
              <button
                type="button"
                disabled={props.busy || !text.trim()}
                onClick={() => props.onPreview(text, mode)}
                className={primary}
              >
                {props.busy ? "解析中…" : "解析节点链接"}
              </button>
            )
          ) : (
            <button type="button" disabled={props.busy} onClick={submit} className={primary}>
              {props.busy ? "校验保存中…" : isEditingExisting ? "保存修改" : "校验并保存节点"}
            </button>
          )}
        </footer>
      </form>
    </dialog>,
    document.body
  );
}
