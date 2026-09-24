import { useCallback, useEffect, useRef, useState } from "react";
import { localNodesApi } from "../api/localNodes";
import type { LocalNodeDraft, LocalNodesView, LocalNodeSummary } from "../types/localNodes";
import { parseNodeLinks } from "../utils/nodeLinks";
import { invalidateNodeObservations } from "../api/nodeHealth";

export type LocalNodeDialog = { kind: "edit"; draft: LocalNodeDraft } | { kind: "import" } | { kind: "delete"; node: LocalNodeSummary } | null;
export function useLocalNodes() {
  const [view, setView] = useState<LocalNodesView>();
  const [dialog, setDialog] = useState<LocalNodeDialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<LocalNodeDraft[]>([]);
  const locked = useRef(false), version = useRef(0), revision = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++version.current;
    try { const value = await localNodesApi.read(); if (ticket === version.current) { setView(value); revision.current = value.revision; setError(""); } }
    catch { if (ticket === version.current) setError("本地节点读取失败，请刷新后重试"); }
  }, []);
  useEffect(() => { void refresh(); return () => { ++version.current; }; }, [refresh]);
  const perform = async (operation: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try { await operation(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { locked.current = false; setBusy(false); }
  };
  const commit = async (drafts: LocalNodeDraft[], deletes: string[] = []) => {
    const result = await localNodesApi.save(revision.current, drafts, deletes);
    const changed = new Set([...drafts.map(d => d.id), ...deletes]);
    const aliases = view?.nodes.filter(n => changed.has(n.id)).map(n => n.alias) || [];
    let observationWarning = "";
    try { await invalidateNodeObservations(aliases); } catch { observationWarning = "旧体检缓存清理失败，请重新执行 IP 体检。"; }
    ++version.current; setView(result); revision.current = result.revision;
    setDialog(null); setPreview([]);
    setNotice((result.running ? "本地节点已保存并应用；连通性请通过测速或 IP 体检验证。" : "本地节点已保存并通过核心校验，启动核心后可使用。") + observationWarning);
    window.dispatchEvent(new Event("procweaver-profile-changed"));
    window.dispatchEvent(new Event("procweaver-local-nodes-changed"));
  };
  return { view, dialog, busy, error, notice, preview, refresh,
    dismissNotice: () => setNotice(""),
    openNew: () => { if (!locked.current) { setError(""); setPreview([]); setDialog({ kind: "edit", draft: { name: "", config: { type: "vless", server: "", port: 443, uuid: "", tls: true } } }); } },
    edit: (id: string) => perform(async () => { setPreview([]); const draft = await localNodesApi.detail(id); setDialog({ kind: "edit", draft }); }),
    openImport: () => { if (!locked.current) { setError(""); setPreview([]); setDialog({ kind: "import" }); } },
    remove: (node: LocalNodeSummary) => { if (!locked.current) { setError(""); setDialog({ kind: "delete", node }); } },
    close: () => { if (!locked.current) { setDialog(null); setPreview([]); setError(""); } },
    clearPreview: () => { setPreview([]); setError(""); },
    previewText: (text: string, mode: "links" | "yaml") => perform(async () => {
      setPreview([]);
      const raw = mode === "links" ? JSON.stringify(parseNodeLinks(text).map(d => ({ ...d.config, name: d.name }))) : text;
      setPreview(await localNodesApi.preview(raw));
    }),
    save: (draft: LocalNodeDraft) => perform(() => commit([draft])),
    importPreview: () => perform(() => preview.length ? commit(preview) : Promise.reject(new Error("请先预览节点"))),
    confirmDelete: () => perform(() => dialog?.kind === "delete" ? commit([], [dialog.node.id]) : Promise.resolve()),
  };
}
