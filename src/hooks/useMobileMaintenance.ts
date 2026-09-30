import { useState } from "react";
import { androidSystemApi, type TrafficHistory, type ProxyHistory } from "../api/android";
import { checkAppUpdate, downloadAppUpdate, installAppUpdate } from "../api/maintenance";
import type { AppUpdateInfo } from "../types";

export function useMobileMaintenance() {
  const [update, setUpdate] = useState<AppUpdateInfo | null>(null);
  const [archive, setArchive] = useState("");
  const [history, setHistory] = useState<TrafficHistory | null>(null);
  const [proxyHistory, setProxyHistory] = useState<ProxyHistory | null>(null);
  const [historySource, setHistorySource] = useState<"proxy" | "system">("proxy");
  const [date, setDate] = useState(() => { const now=new Date(); return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`; });
  const [period, setPeriod] = useState<"day" | "month">("day");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function run(action: () => Promise<void>) { if (busy) return; setBusy(true); setMessage(""); try { await action(); } catch (error) { setMessage(String(error)); } finally { setBusy(false); } }
  const check = () => run(async () => { const next=await checkAppUpdate(); setUpdate(next); setArchive(""); setMessage(!next.hasUpdate ? "当前版本无需更新" : !next.downloadUrl ? "发现新版本，但尚未提供正式 Android APK" : "发现可用更新"); });
  const install = () => run(async () => {
    if (!update?.downloadUrl || !update.assetName) return;
    const path=archive || await downloadAppUpdate(update.downloadUrl, update.assetName); setArchive(path);
    await installAppUpdate(path); setMessage("已打开系统安装界面，请按系统提示完成升级");
  });
  const queryHistory = () => run(async () => {
    const [year, month, day]=date.split("-").map(Number);
    const start=new Date(year, month-1, period === "month" ? 1 : day).getTime();
    const end=period === "month" ? new Date(year, month, 1).getTime() : new Date(year,month-1,day+1).getTime();
    if (!Number.isFinite(start) || start > Date.now()) throw new Error("请选择有效的历史日期");
    if (historySource === "proxy") setProxyHistory(await androidSystemApi.proxyHistory(start, Math.min(end,Date.now())));
    else setHistory(await androidSystemApi.history(start, Math.min(end,Date.now())));
  });
  const clearProxyHistory = () => run(async () => { await androidSystemApi.clearProxyHistory(); setProxyHistory(null); setMessage("本机代理流量历史已清除，后续流量会重新统计"); });
  const grantUsage = () => run(async () => { await androidSystemApi.openSettings("usage"); });
  return { update, history, proxyHistory, historySource, setHistorySource, clearProxyHistory, date, setDate, period, setPeriod, busy, message, check, install, queryHistory, grantUsage };
}
