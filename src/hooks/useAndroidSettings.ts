import { useEffect, useState } from "react";
import { getGeneralSettings, saveGeneralSettings, type GeneralSettings } from "../api/settings";
import { androidAppsApi, androidSystemApi, type AndroidApplication, type AndroidNetworkInfo } from "../api/android";
import { isAppHidden } from "../utils/appVisibility";

export function useAndroidSettings(loadApps = false) {
  const [settings, setSettings] = useState<GeneralSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [apps, setApps] = useState<AndroidApplication[]>([]);
  const [outbounds, setOutbounds] = useState<string[]>([]);
  const [network, setNetwork] = useState<AndroidNetworkInfo | null>(null);
  useEffect(() => { void getGeneralSettings().then(setSettings).catch(error => setMessage(String(error))); }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let generation = 0;
    const refresh = async () => {
      if (!active || isAppHidden() || inFlight) return;
      const revision = generation;
      inFlight = true;
      try { const value = await androidSystemApi.networkInfo(); if (active && !isAppHidden() && revision === generation) setNetwork(value); }
      catch { /* Keep the last network display; the next foreground refresh retries. */ }
      finally { inFlight = false; if (active && !isAppHidden()) timer = setTimeout(() => void refresh(), revision === generation ? 10000 : 0); }
    };
    const visibility = () => { generation++; clearTimeout(timer); void refresh(); };
    visibility();
    if (loadApps) void androidAppsApi.applications().then(value => { if (active) setApps(value); }).catch(error => { if (active) setMessage(String(error)); });
    void androidSystemApi.outbounds().then(value => { if (active) setOutbounds(value); }).catch(error => { if (active) setMessage(String(error)); });
    document.addEventListener("visibilitychange", visibility);
    return () => { active = false; generation++; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [loadApps]);
  async function openSettings(page: "vpn" | "battery" | "app") {
    try { await androidSystemApi.openSettings(page); } catch (error) { setMessage(String(error)); }
  }
  async function save() {
    if (!settings || busy) return;
    if (!Number.isInteger(settings.speedTestConcurrency ?? 2) || (settings.speedTestConcurrency ?? 2) < 1 || (settings.speedTestConcurrency ?? 2) > 4) { setMessage("同时测速节点数请输入 1–4 的整数"); return; }
    if (!Number.isInteger(settings.healthProbeConcurrency ?? 2) || (settings.healthProbeConcurrency ?? 2) < 1 || (settings.healthProbeConcurrency ?? 2) > 4) { setMessage("同时体检节点数请输入 1–4 的整数"); return; }
    setBusy(true); setMessage("");
    try {
      const value = await saveGeneralSettings({ ...settings, trafficMode: "tun", tunMode: true, enableControllerPort: true });
      setSettings(value); setMessage("设置已保存"); window.dispatchEvent(new Event("netbox-settings-saved"));
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }
  async function addVpnTile() {
    try { const result = await androidSystemApi.addVpnTile(); setMessage(result.manual ? "此系统请下拉快捷面板，点编辑并将 ProcWeaver 拖入已添加区域" : result.added ? "VPN 快捷开关已添加" : "未添加快捷开关，可以稍后重试"); }
    catch { setMessage("系统未能添加快捷开关，请在下拉面板中手动编辑"); }
  }
  return { settings, setSettings, busy, message, save, apps, outbounds, network, openSettings, addVpnTile };
}
