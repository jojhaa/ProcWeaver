import { useEffect, useId, useRef, useState } from "react";
import { Check, CheckSquare, EyeOff, MoreHorizontal, Pencil, RefreshCw, Shield, Square, Trash2, X, Zap } from "lucide-react";
import { useMobileBack } from "../utils/mobileBack";

type Props = {
  name: string; protocol: string; active: boolean; selected: boolean; selectionMode: boolean;
  switching?: boolean;
  delay: string; delayTone: string; testing: boolean; offline: boolean;
  region?: string; ip?: string; risk?: number | null; multiplier: string;
  probing: boolean; probeDisabled: boolean; local?: boolean; localBusy: boolean;
  onConnect: () => void; onTest: () => void; onProbe: () => void; onSelect: () => void;
  onIgnore: () => void; onEdit: () => void; onDelete: () => void;
};

/** Compact card and its secondary actions share presentation state only. */
export function MobileNodeCard(props: Props) {
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useMobileBack(() => {
    if (!expanded) return false;
    setExpanded(false);
    return true;
  }, 30);

  useEffect(() => {
    const element = dialog.current;
    if (!expanded || !element) return;
    element.showModal();
    return () => { element.close(); if (trigger.current?.isConnected) trigger.current.focus(); };
  }, [expanded]);
  const close = () => setExpanded(false);
  const act = (action: () => void) => { dialog.current?.close(); close(); action(); };
  return <>
    <article className={`mobile-node-card ${props.switching ? "is-switching" : props.active ? "is-active" : props.selected ? "is-selected" : ""}`}>
      <button
        type="button"
        className="mobile-node-name"
        onClick={() => { if (props.selectionMode) props.onSelect(); else if (!props.switching) props.onConnect(); }}
        title={props.name}
        aria-label={props.selectionMode ? `${props.selected ? "取消勾选" : "勾选"} ${props.name}` : props.switching ? `${props.name} 切换中` : `切换至 ${props.name}`}
        aria-pressed={props.selectionMode ? props.selected : undefined}
      >
        {props.selectionMode && (props.selected ? <CheckSquare size={16} className="shrink-0 text-indigo-600 dark:text-indigo-400" /> : <Square size={16} className="shrink-0 text-slate-400" />)}
        <span>{props.name}</span>
      </button>
      <div className="mobile-node-meta">
        <span className="mobile-node-protocol">{props.protocol}</span>
        {props.switching ? (
          <span className="mobile-node-switching text-indigo-600 dark:text-indigo-400 font-semibold inline-flex items-center gap-1">
            <RefreshCw size={10} className="animate-spin shrink-0" />
            <span>切换中</span>
          </span>
        ) : props.active ? (
          <span className="mobile-node-active"><Check size={11} />使用中</span>
        ) : props.selected ? (
          <span className="mobile-node-active"><CheckSquare size={11} />已选</span>
        ) : (
          <span>{props.local ? "本地" : props.region || "未体检"}</span>
        )}
      </div>
      <div className="mobile-node-actions">
        <button type="button" onClick={props.onTest} disabled={props.testing || props.offline} className={props.delayTone} aria-label={`${props.name}：${props.delay}，测速`} title={props.offline ? "连接 VPN 后可测速" : "单节点测速"}><Zap size={13} /><span>{props.delay}</span></button>
        <button ref={trigger} type="button" onClick={() => setExpanded(true)} aria-label={`${props.name} 更多操作`} aria-haspopup="dialog"><MoreHorizontal size={19} /></button>
      </div>
    </article>
    {expanded && <dialog ref={dialog} className="mobile-node-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <header><h2 id={titleId}>{props.name}</h2><button type="button" onClick={close} aria-label="关闭节点操作"><X size={20} /></button></header>
      <p>{props.protocol} · {props.multiplier}{props.local ? " · 本地节点" : ""}</p>
      <p>真实出口：{props.region || "未体检"}{props.ip ? ` · ${props.ip}` : ""}{props.risk != null ? ` · 风险 ${props.risk} 分` : ""}</p>
      {props.offline && <p>连接 VPN 后可切换出口和测速，IP 体检可独立运行。</p>}
      <div className="mobile-node-menu">
        <button type="button" disabled={props.probeDisabled} onClick={() => act(props.onProbe)}><Shield size={17} />{props.probing ? "体检中…" : "IP 体检"}</button>
        <button type="button" aria-pressed={props.selected} onClick={() => act(props.onSelect)}>{props.selected ? <CheckSquare size={17} /> : <Square size={17} />}{props.selected ? "取消勾选" : "勾选以创建线路"}</button>
        {props.local && <>
          <button type="button" disabled={props.localBusy} onClick={() => act(props.onEdit)}><Pencil size={17} />编辑节点</button>
          <button type="button" disabled={props.localBusy} onClick={() => act(props.onDelete)}><Trash2 size={17} />删除节点</button>
        </>}
        <button type="button" onClick={() => act(props.onIgnore)}><EyeOff size={17} />忽略节点（可在列表底部恢复）</button>
      </div>
    </dialog>}
  </>;
}
