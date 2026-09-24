import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { localNodeEndpoint, nodeConfigTemplate, nodeProtocols, usesConfigEditor, type LocalNodeDraft, type NodeConfig } from "../types/localNodes";
import type { LocalNodeDialog as DialogState } from "../hooks/useLocalNodes";

interface Props {
  dialog: DialogState; busy: boolean; error: string; preview: LocalNodeDraft[];
  onClose: () => void; onSave: (draft: LocalNodeDraft) => void; onDelete: () => void;
  onPreview: (text: string, mode: "links" | "yaml") => void; onImport: () => void; onClearPreview: () => void;
}
const inputClass = "w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-indigo-500/40 disabled:opacity-50";
const secondary = "px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50";
const primary = "px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm disabled:opacity-50";
const isConfigEditor = (config: NodeConfig) => usesConfigEditor(config.type) || config.type === "wireguard" && config.peers !== undefined;
const editableKeys = (config: NodeConfig) => {
  if (isConfigEditor(config)) return new Set(["name", "type"]);
  const fields: Record<string, string[]> = {
    vmess: ["uuid", "cipher", "alterId", "servername", "tls"], vless: ["uuid", "flow", "servername", "tls"],
    ss: ["password", "cipher"], trojan: ["password", "sni"], hysteria2: ["password", "sni"],
    tuic: ["uuid", "password", "token", "sni"], anytls: ["password", "sni"],
    socks5: ["username", "password", "tls", "sni"], http: ["username", "password", "tls", "sni"],
    wireguard: ["ip", "ipv6", "private-key", "public-key", "pre-shared-key"],
  };
  return new Set(["name", "type", "server", "port", "udp", ...(fields[String(config.type)] || [])]);
};
const extraOptions = (config: NodeConfig) => Object.fromEntries(Object.entries(config).filter(([k]) => !editableKeys(config).has(k)));
export function LocalNodeDialog(props: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<LocalNodeDraft>({ name: "", config: {} });
  const [advanced, setAdvanced] = useState("");
  const [formError, setFormError] = useState("");
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"links" | "yaml">("links");
  const protocolDrafts = useRef(new Map<string, { config: NodeConfig; advanced: string }>());
  useEffect(() => {
    if (!props.dialog) { ref.current?.close(); return; }
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = ref.current;
    if (props.dialog.kind === "edit") { setDraft(structuredClone(props.dialog.draft)); setAdvanced(JSON.stringify(extraOptions(props.dialog.draft.config), null, 2)); }
    setText(""); setFormError(""); setMode("links"); protocolDrafts.current.clear();
    if (!ref.current?.open) ref.current?.showModal();
    return () => { element?.close(); if (trigger?.isConnected) trigger.focus(); };
  }, [props.dialog]);
  if (!props.dialog) return null;
  const dialog = props.dialog;
  const close = () => { if (!props.busy) { ref.current?.close(); props.onClose(); } };
  const kind = String(draft.config.type || "vless");
  const configEditor = isConfigEditor(draft.config);
  const tokenAuth = kind === "tuic" && draft.config.token !== undefined;
  const nodeContent = dialog.kind === "edit" && advanced.trim() !== "" && !advanced.trim().startsWith("{");
  const fillFromPreview = () => {
    const node = props.preview[0];
    if (!node || props.preview.length !== 1) return;
    setDraft(d => ({ ...node, ...(d.id ? { id: d.id, name: d.name } : {}), config: structuredClone(node.config) }));
    setAdvanced(JSON.stringify(extraOptions(node.config), null, 2)); setFormError("");
    protocolDrafts.current.clear(); props.onClearPreview();
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
    setAdvanced(previous?.advanced ?? JSON.stringify(extraOptions(config), null, 2)); setFormError("");
    setDraft(d => ({ ...d, config }));
  };
  const put = (key: string, value: unknown) => setDraft(d => { const config = { ...d.config }; if (value === "" && key !== "token") delete config[key]; else config[key] = value; return { ...d, config }; });
  const field = (key: string, label: string, type = "text", required = false) => <label key={key} className="block space-y-1.5 text-xs text-slate-600 dark:text-slate-400">
    <span>{label}{required ? " *" : ""}</span><input className={inputClass} value={String(draft.config[key] ?? "")} type={type} required={required}
      min={type === "number" ? 0 : undefined} max={key === "port" ? 65535 : undefined} autoComplete="off" spellCheck={false}
      onChange={e => put(key, type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)} />
  </label>;
  const submit = () => {
    try {
      const keys = editableKeys(draft.config);
      let config = Object.fromEntries(Object.entries(draft.config).filter(([k]) => keys.has(k)));
      if (advanced.trim()) {
        const extra = JSON.parse(advanced) as NodeConfig;
        if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error("高级选项须为 JSON 对象");
        if (Object.keys(extra).some(k => keys.has(k))) throw new Error("高级选项不能覆盖基本字段，请在上方修改");
        config = { ...config, ...extra };
      }
      setFormError(""); props.onSave({ ...draft, config });
    } catch (e) { setFormError(e instanceof Error ? e.message : "高级选项 JSON 无效"); }
  };
  return createPortal(<dialog ref={ref} aria-labelledby="local-node-title" onCancel={e => { e.preventDefault(); close(); }}
    onClick={e => { if (e.target === ref.current && !props.busy) { const r = ref.current.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(); } }}
    className="m-auto w-[min(42rem,calc(100vw-2rem))] max-h-[90dvh] overflow-y-auto rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-0 text-slate-800 dark:text-slate-200 shadow-xl backdrop:bg-slate-950/40">
    <header className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 p-5">
      <div><h2 id="local-node-title" className="font-bold">{dialog.kind === "delete" ? "删除本地节点" : dialog.kind === "import" ? "导入本地节点" : draft.id ? "编辑本地节点" : "新增本地节点"}</h2>
        <p className="text-xs text-slate-500 mt-1">独立保存，切换或更新订阅时保留。</p></div>
      <button type="button" aria-label="关闭节点窗口" disabled={props.busy} onClick={close} className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"><X size={18} /></button>
    </header>
    <form onSubmit={e => { e.preventDefault(); if (!props.busy) { if (nodeContent) previewOrApply(); else if (dialog.kind === "edit") submit(); else if (dialog.kind === "delete") props.onDelete(); else if (props.preview.length) props.onImport(); else props.onPreview(text, mode); } }}>
      <fieldset disabled={props.busy} className="p-5 space-y-4 min-w-0">
        {dialog.kind === "delete" ? <p className="text-sm break-words">删除「{dialog.node.name}」？业务包、手工规则或自建线路仍引用它时，将阻止删除并列出引用位置。删除后可重新导入，但不会恢复旧身份。</p> : dialog.kind === "import" ? <>
          <div className="flex flex-wrap gap-2"><button type="button" aria-pressed={mode === "links"} className={mode === "links" ? primary : secondary} onClick={() => { setMode("links"); props.onClearPreview(); }}>节点链接 / Base64</button><button type="button" aria-pressed={mode === "yaml"} className={mode === "yaml" ? primary : secondary} onClick={() => { setMode("yaml"); props.onClearPreview(); }}>节点 YAML / JSON</button></div>
          <label className="block text-xs space-y-2"><span>{mode === "links" ? "每行一个节点链接，或粘贴整段 Base64 编码的链接列表" : "仅粘贴节点对象、节点数组或 proxies 列表"}</span><textarea aria-label="导入内容" value={text} onChange={e => { setText(e.target.value); props.onClearPreview(); }} spellCheck={false} className={`${inputClass} font-mono min-h-44`} required maxLength={1048576} /></label>
          <p className="text-xs text-slate-500">链接支持 VMess、VLESS、SS、SSR、Trojan、Hysteria/2、TUIC、AnyTLS、Mieru、HTTP/HTTPS 和 SOCKS5。其他核心协议使用节点 YAML / JSON；未知参数会提示，不会静默丢弃。</p>
          {!!props.preview.length && <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden"><p className="p-3 text-xs bg-slate-50 dark:bg-slate-800">待导入 {props.preview.length} 个节点（尚未保存或测试连通性）</p><ul className="max-h-48 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">{props.preview.map((n, i) => <li key={i} className="px-3 py-2 text-xs break-words"><b>{n.name}</b><span className="ml-2 text-slate-500">{String(n.config.type)} · {localNodeEndpoint(n.config)}</span></li>)}</ul></div>}
        </> : <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block space-y-1.5 text-xs text-slate-600 dark:text-slate-400"><span>节点名称 *</span><input value={draft.name} required maxLength={160} className={inputClass} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} /></label>
            <label className="block space-y-1.5 text-xs text-slate-600 dark:text-slate-400"><span>协议 *</span><select className={inputClass} value={kind} onChange={e => changeProtocol(e.target.value)}>{nodeProtocols.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            {!configEditor && <>{field("server", "服务器地址", "text", true)}{field("port", "端口", "number", true)}
            {kind === "tuic" && <label className="block space-y-1.5 text-xs text-slate-600 dark:text-slate-400"><span>TUIC 认证方式</span><select className={inputClass} value={tokenAuth ? "token" : "uuid"} onChange={e => setDraft(d => { const config = { ...d.config }; if (e.target.value === "token") { delete config.uuid; delete config.password; config.token = ""; } else { delete config.token; config.uuid = ""; config.password = ""; } return { ...d, config }; })}><option value="uuid">v5 · UUID / 密码</option><option value="token">v4 · Token</option></select></label>}
            {["vmess", "vless", "tuic"].includes(kind) && !tokenAuth && field("uuid", "UUID", "text", true)}
            {["ss", "trojan", "hysteria2", "tuic", "anytls"].includes(kind) && !tokenAuth && field("password", "密码", "password", true)}
            {tokenAuth && field("token", "Token", "password", true)}
            {["socks5", "http"].includes(kind) && <>{field("username", "用户名（可选）")}{field("password", "密码（可选）", "password")}</>}
            {["ss", "vmess"].includes(kind) && field("cipher", "加密方法", "text", true)}
            {kind === "vmess" && field("alterId", "Alter ID", "number")}
            {kind === "vless" && field("flow", "Flow（可选）")}
            {kind === "wireguard" && <>{field("ip", "本地 IPv4", "text", !draft.config.ipv6)}{field("ipv6", "本地 IPv6（可选）")}{field("private-key", "私钥", "password", true)}{field("public-key", "对端公钥", "text", true)}{field("pre-shared-key", "预共享密钥（可选）", "password")}</>}
            {kind !== "wireguard" && kind !== "ss" && field(["vmess", "vless"].includes(kind) ? "servername" : "sni", "TLS 服务器名称（SNI，可选）")}</>}
          </div>
          {!configEditor && <div className="flex flex-wrap gap-4 text-xs">
            {["vmess", "vless", "http", "socks5"].includes(kind) && <label className="flex items-center gap-2"><input type="checkbox" checked={draft.config.tls === true} onChange={e => put("tls", e.target.checked)} />启用 TLS{kind === "http" ? "（HTTPS 代理）" : ""}</label>}
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.config.udp === true} onChange={e => put("udp", e.target.checked)} />UDP</label>
          </div>}
          <details key={configEditor ? kind : "basic"} open={configEditor ? true : undefined} className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 text-xs"><summary className="cursor-pointer font-medium">{configEditor ? "节点配置" : "高级选项"}</summary>
            {configEditor && <p className="my-2 text-slate-500">填写此协议的 Mihomo 节点参数 JSON（名称与协议在上方选择）。证书与私钥请填写内容，不支持本机文件路径；虚拟网络状态目录由程序按节点身份独立管理。</p>}
            <p className="my-2 text-slate-500">支持 Mihomo 高级选项 JSON、节点链接和 Base64 编码的链接列表。JSON 可直接编辑；链接先预览，单个节点可回填表单，多个节点可批量新增。</p>
            <label className="block space-y-2"><span>高级选项 / 节点内容</span><textarea aria-label="高级选项 / 节点内容" className={`${inputClass} font-mono min-h-28`} spellCheck={false} value={advanced} maxLength={1048576} onChange={e => { setAdvanced(e.target.value); setFormError(""); props.onClearPreview(); }} placeholder={'粘贴 vless://…、Base64，或 {"network":"ws","ws-opts":{"path":"/"}}'} /></label>
            {nodeContent && <div className="mt-3 space-y-2">
              {!!props.preview.length && <><p className="text-slate-500">{props.preview.length === 1 ? "回填将替换表单中的节点参数，仍需校验并保存；编辑已有节点时保留本机身份与名称。" : `已识别 ${props.preview.length} 个节点。批量新增不会修改当前节点。`}</p>
                <ul className="max-h-40 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800">{props.preview.map((n, i) => <li key={i} className="p-2 break-words"><b>{n.name}</b><span className="ml-2 text-slate-500">{String(n.config.type)} · {localNodeEndpoint(n.config)}</span></li>)}</ul></>}
              {!props.preview.length && <p className="text-slate-500">点击下方“解析并预览”，不会立即保存或连接节点。</p>}
            </div>}
          </details>
          <p className="text-xs text-slate-500">保存会执行核心配置校验；测速与 IP 体检需在节点卡片中执行。改名不影响已有绑定。</p>
        </>}
        {(props.error || formError) && <p role="alert" className="rounded-xl p-3 text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/30 break-words">{formError || props.error}</p>}
      </fieldset>
      <footer className="flex flex-wrap justify-end gap-2 px-5 py-4 border-t border-slate-100 dark:border-slate-800">
        <button type="button" className={secondary} disabled={props.busy} onClick={close}>取消</button>
        <button type={nodeContent ? "button" : "submit"} onClick={nodeContent ? e => { e.preventDefault(); previewOrApply(); } : undefined} className={dialog.kind === "delete" ? "px-4 py-2 rounded-xl bg-rose-600 text-white text-sm disabled:opacity-50" : primary} disabled={props.busy}>{props.busy ? "处理中…" : nodeContent ? !props.preview.length ? "解析并预览" : props.preview.length === 1 ? "回填到表单" : `批量新增 ${props.preview.length} 个节点` : dialog.kind === "delete" ? "确认删除" : dialog.kind === "edit" ? "校验并保存" : props.preview.length ? `保存 ${props.preview.length} 个节点` : "预览节点"}</button>
      </footer>
    </form>
  </dialog>, document.body);
}
