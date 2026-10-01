import { useEffect, useRef, useState } from "react";
import { externalProxyApi } from "../api/externalProxy";
import { bundleController } from "../services/bundleRuntime";
import type { BundleLocalInstance } from "../types/businessBundle";
import type { ExternalDnsSettings, ExternalEndpointInput, ExternalProbeKind, ExternalProbeRecord, ExternalProxyView } from "../types/externalProxy";
import { defaultExternalProbe, externalProbePresets, savedProbeEndpoint, selectProbeKind, selectProbePreset, validateProbe } from "../services/externalProxyProbe";
const blank = (): ExternalEndpointInput => ({ id: `proxy-${crypto.randomUUID()}`, name: "", protocol: "http", host: "127.0.0.1", port: 7890, username: "", password: "" });
export function useExternalProxyEditor(open: boolean, instance: BundleLocalInstance | null, close: () => void) {
  const [view, setView] = useState<ExternalProxyView>();
  const [draft, setDraft] = useState<ExternalEndpointInput>(blank);
  const [endpointId, setEndpointId] = useState("");
  const [fallback, setFallback] = useState<"direct" | "default">("direct");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [probe, setProbe] = useState(defaultExternalProbe);
  const [probeRecords, setProbeRecords] = useState<ExternalProbeRecord[]>([]);
  const probeLock = useRef(false);
  const probeSerial = useRef(0);
  const [dns, setDns] = useState<ExternalDnsSettings>({ enabled: false, server: "1.1.1.1", port: 53 });
  const edit = (id: string, current = view) => {
    const endpoint = current?.endpoints.find(e => e.id === id);
    setDraft(endpoint ? { id: endpoint.id, name: endpoint.name, protocol: endpoint.protocol, host: endpoint.host, port: endpoint.port, username: endpoint.username, password: undefined } : blank());
    setMessage(""); setError("");
  };
  const load = async () => {
    setBusy(true); setError("");
    try { const next = await externalProxyApi.read(); setView(next); setDns(next.dns || { enabled: false, server: "1.1.1.1", port: 53 }); edit(next.defaultEndpointId || next.endpoints[0]?.id || "", next); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!open) { setView(undefined); setDraft(blank()); setError(""); setMessage(""); return; }
    setEndpointId(instance?.externalEndpointId || ""); setFallback(instance?.externalFallback || "direct"); setEnabled(instance?.enabled ?? true);
    void load();
  }, [open, instance?.instanceId]);
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await work(); await bundleController.refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const saveEndpoint = () => run(async () => {
    if (!view) throw new Error("请先读取代理配置");
    if (!draft.name.trim() || !draft.host.trim() || !Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) throw new Error("请填写名称、代理地址及有效端口");
    const endpoints = view.endpoints.filter(e => e.id !== draft.id).map(({ hasPassword: _secret, ...e }) => e);
    const password = draft.password === "" && view.endpoints.some(e => e.id === draft.id && e.hasPassword && e.username === draft.username) ? undefined : draft.password;
    const saved = await externalProxyApi.settings({ revision: view.revision, defaultEndpointId: view.defaultEndpointId || draft.id,
      endpoints: [...endpoints, { ...draft, password }] });
    setView(saved); edit(draft.id, saved); setMessage("代理已保存；修改上游后新连接使用新设置，已有隧道继续运行。");
  });
  const setDefault = (id: string) => run(async () => {
    if (!view) return;
    const saved = await externalProxyApi.settings({ revision: view.revision, defaultEndpointId: id || null, endpoints: view.endpoints.map(({ hasPassword: _secret, ...e }) => e) });
    setView(saved); setMessage("默认代理已更新；单独指定代理的业务包不受影响。");
  });
  const remove = () => run(async () => {
    if (!view || !view.endpoints.some(e => e.id === draft.id)) return;
    if (view.defaultEndpointId === draft.id || view.bundles.some(b => b.endpointId === draft.id)) throw new Error("此代理仍被默认出口或业务包引用，请先换绑");
    if (!window.confirm(`移除「${view.endpoints.find(e => e.id === draft.id)?.name}」？保存的代理凭据会一并移除；之后可重新填写添加。`)) return;
    const saved = await externalProxyApi.settings({ revision: view.revision, defaultEndpointId: view.defaultEndpointId, endpoints: view.endpoints.filter(e => e.id !== draft.id).map(({ hasPassword: _secret, ...e }) => e) });
    setView(saved); edit("", saved); setMessage("已移除代理；可重新添加。");
  });
  const saveBundle = () => run(async () => {
    if (!instance || !view) return;
    const next = bundleController.getSnapshot().instances.map(i => i.instanceId === instance.instanceId
      ? { ...i, backend: "external" as const, externalEndpointId: endpointId || null, externalFallback: fallback, enabled, updatedAt: Date.now() } : i);
    if (!await bundleController.apply(next)) throw new Error(bundleController.getSnapshot().error || "独立业务包应用失败");
    close();
  });
  const saveDns = () => run(async () => {
    if (!view) throw new Error("请先读取代理配置");
    if (!dns.server.trim() || !Number.isInteger(dns.port) || dns.port < 1 || dns.port > 65535) throw new Error("请填写 DNS 上游 IP 及有效端口");
    const saved = await externalProxyApi.settings({ revision: view.revision, defaultEndpointId: view.defaultEndpointId,
      endpoints: view.endpoints.map(({ hasPassword: _secret, ...e }) => e), dns });
    setView(saved); setDns(saved.dns); setMessage(dns.enabled ? "独立 DNS 入口已启用；请将支持自定义 DNS 的应用接入对应地址。系统 DNS 未修改。" : "独立 DNS 入口已关闭；SOCKS5 内的 DNS 转发仍可使用。");
  });
  const probeEndpoint = savedProbeEndpoint(draft, view?.endpoints || []);
  const test = async () => {
    if (busy || probeLock.current) return;
    setError(""); setMessage("");
    let request;
    try {
      if (!probeEndpoint) throw new Error("请先保存新增或修改后的代理，再进行检测");
      request = validateProbe(probe, probeEndpoint.protocol);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    probeLock.current = true; setBusy(true);
    const id = ++probeSerial.current, started = performance.now();
    const row: ExternalProbeRecord = { id, endpoint: probeEndpoint.name, kind: request.kind, host: request.host, port: request.port, queryName: request.queryName, state: "running", elapsedMs: 0, message: "正在通过所选代理检测…" };
    setProbeRecords(old => [row, ...old].slice(0, 6));
    try {
      const message = await externalProxyApi.test(probeEndpoint.id, request.host, request.port, request.kind, request.kind === "udp_dns" ? request.queryName : undefined, request.timeoutMs);
      setProbeRecords(old => old.map(r => r.id === id ? { ...r, state: "success", message, elapsedMs: Math.round(performance.now() - started) } : r));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setProbeRecords(old => old.map(r => r.id === id ? { ...r, state: "failed", message, elapsedMs: Math.round(performance.now() - started) } : r));
    } finally { probeLock.current = false; setBusy(false); }
  };
  return { view, draft, endpointId, fallback, enabled, busy, error, message, dns, probe, probeRecords, probeEndpoint,
    probePresets: externalProbePresets.filter(p => p.kind === probe.kind),
    actions: { load, edit, setDraft, setEndpointId, setFallback, setEnabled, saveEndpoint, setDefault, remove, saveBundle, test, setDns, saveDns,
      setProbe, setProbeKind: (kind: ExternalProbeKind) => setProbe(current => selectProbeKind(current, kind)),
      setProbePreset: (id: string) => setProbe(current => selectProbePreset(current, id)), clearProbeRecords: () => setProbeRecords([]) } };
}
