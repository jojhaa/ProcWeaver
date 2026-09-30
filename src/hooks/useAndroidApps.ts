import { getGeneralSettings, type GeneralSettings } from "../api/settings";
import { useEffect, useRef, useState } from "react";
import { androidAppsApi, type AndroidApplication } from "../api/android";
import type { RoutingView, RoutingTarget, ProcessRule } from "../types/routingOverrides";
import { sameTarget } from "../services/bundleCompiler";

export function useAndroidApps(api = androidAppsApi) {
  const [scope, setScope] = useState<GeneralSettings["vpnApps"]>();
  const [apps, setApps] = useState<AndroidApplication[]>([]);
  const [view, setView] = useState<RoutingView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const pending = useRef(false);
  async function reload() {
    setBusy(true); setError("");
    try { const [items, state] = await Promise.all([api.applications(), api.read()]); setApps(items); setView(state); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void reload(); void getGeneralSettings().then(value => setScope(value.vpnApps)).catch(error => setError(String(error))); }, [api]);
  async function save(app: AndroidApplication, action: ProcessRule["action"] | "inherit", target: RoutingTarget | null) {
    if (!view || busy || pending.current) return false;
    pending.current = true;
    setBusy(true); setError("");
    try {
      if (app.sharedUid) throw new Error("此应用共享系统 UID，无法单独识别连接；请使用域名规则。");
      const id = `android-app-${app.packageName}`;
      const processRules = view.config.processRules.filter(r => r.id !== id && !(r.matchKind === "name" && r.matchValue === app.packageName));
      if (action !== "inherit") processRules.push({ id, enabled: true, label: app.label, matchKind: "name", matchValue: app.packageName,
        includeDescendants: false, ruleMode: "strict", action, target: action === "proxy" ? target : null });
      const next = await api.save({ ...view.config, processRules }, []);
      setView(next);
      window.dispatchEvent(new Event("netbox-route-changed"));
      return true;
    } catch (e) { setError(String(e)); await api.read().then(setView).catch(() => {}); return false; }
    finally { pending.current = false; setBusy(false); }
  }
  async function setEnabled(enabled: boolean) {
    if (!view || busy || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      setView(await api.save({ ...view.config, processEnabled: enabled }, []));
      window.dispatchEvent(new Event("netbox-route-changed"));
    } catch (e) { setError(String(e)); await api.read().then(setView).catch(() => {}); }
    finally { pending.current = false; setBusy(false); }
  }
  const targets = view?.targets ?? [];
  const rows = apps.map(app => {
    const rule = view?.config.processRules.find(r => r.enabled && r.matchKind === "name" && r.matchValue === app.packageName);
    const selected = rule?.action === "proxy"
      ? `target:${targets.findIndex(t => !!rule.target && sameTarget(t, rule.target))}`
      : rule?.action ?? "inherit";
    const excluded = scope?.mode === "include" ? !scope.packages.includes(app.packageName) : scope?.mode === "exclude" ? scope.packages.includes(app.packageName) : false;
    return { ...app, selected, excluded, routingDisabled: view?.config.processEnabled === false && !!rule };
  });
  return { apps: rows, targets, view, busy, error, reload, save, setEnabled };
}
