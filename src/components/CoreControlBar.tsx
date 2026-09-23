import React, { useState, useEffect } from "react";
import { CpuInfo } from "../types";
import { getCpuInfo, toggleCore, toggleSystemProxy } from "../api";
import { Play, Square, Globe, RefreshCw, Cpu, Zap } from "lucide-react";

import { useCoreStatus } from "../hooks/useCoreStatus";
import { proxyStateLabel } from "../utils/coreStatusStore";

interface Props {
  extraAction?: React.ReactNode;
}

export const CoreControlBar: React.FC<Props> = ({ extraAction }) => {
  const { status, pending: loading, run, refresh } = useCoreStatus();
  const proxy = status.systemProxy!;
  const [cpuInfo, setCpuInfo] = useState<CpuInfo | null>(null);
  const [coreMode, setCoreMode] = useState<"auto" | "v3" | "compatible">("auto");
  const [error, setError] = useState("");
  const [uptimeSeconds, setUptimeSeconds] = useState(0);
  const [localStartTime, setLocalStartTime] = useState<number | null>(null);

  useEffect(() => {
    getCpuInfo().then(setCpuInfo).catch(console.error);
  }, []);

  // 运行耗时秒级自增计时器 (几时几分几秒)
  useEffect(() => {
    if (!status.running) {
      setUptimeSeconds(0);
      setLocalStartTime(null);
      return;
    }

    const startSecs = status.startedAt || localStartTime || Math.floor(Date.now() / 1000);
    if (!localStartTime) {
      setLocalStartTime(startSecs);
    }

    const updateUptime = () => {
      const now = Math.floor(Date.now() / 1000);
      const effectiveStart = status.startedAt || startSecs;
      setUptimeSeconds(Math.max(0, now - effectiveStart));
    };

    updateUptime();
    const timer = setInterval(updateUptime, 1000);
    return () => clearInterval(timer);
  }, [status.running, status.startedAt]);

  const formatUptime = (totalSecs: number) => {
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `已运行 ${pad(h)}时${pad(m)}分${pad(s)}秒`;
  };

  const handleToggleCore = async () => {
    setError("");
    try {
      await run(() => toggleCore(!status.running, coreMode));
    } catch (e) {
      console.error("切换内核失败", e);
      setError(String(e));
    }
  };

  const handleToggleSystemProxy = async () => {
    setError("");
    if (proxy.state === "unknown") { await refresh(); return; }
    try {
      await run(() => toggleSystemProxy(proxy.state !== "enabled", status.mixedPort));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="bg-white/90 dark:bg-slate-900/80 border border-slate-200/90 dark:border-slate-800/80 backdrop-blur-md rounded-2xl p-5 shadow-sm dark:shadow-xl space-y-4 transition-colors">
      {error && <p role="alert" className="text-sm text-rose-500 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/30 p-2.5 rounded-xl border border-rose-200 dark:border-rose-900/50">{error}</p>}
      
      {/* 顶部主控制行 */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* 核心状态信息 */}
        <div className="flex items-center space-x-3.5">
          <div className="relative flex items-center justify-center">
            <div
              className={`w-3.5 h-3.5 rounded-full ${
                status.running ? "bg-emerald-500 shadow-sm shadow-emerald-500/50" : "bg-slate-400 dark:bg-slate-600"
              }`}
            />
            {status.running && (
              <div className="absolute -inset-1 bg-emerald-500/30 rounded-full animate-ping pointer-events-none" />
            )}
          </div>

          <div>
            <div className="flex items-center space-x-2.5">
              <span className="font-bold text-slate-900 dark:text-white text-base tracking-tight">
                Mihomo 核心
              </span>
              <span
                className={`px-2.5 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                  status.running
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 font-mono shadow-xs"
                    : "bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700 font-sans"
                }`}
              >
                {status.running ? formatUptime(uptimeSeconds) : "已停止"}
              </span>
            </div>
            <div className="flex items-center space-x-2 text-xs text-slate-500 dark:text-slate-400 mt-1.5">
              <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800/70 border border-slate-200/80 dark:border-slate-700/60 font-mono text-[11px]">
                Mixed: <strong className="text-slate-800 dark:text-slate-200 ml-1">{status.mixedPort}</strong>
              </span>
              <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800/70 border border-slate-200/80 dark:border-slate-700/60 font-mono text-[11px]">
                API: <strong className="text-slate-800 dark:text-slate-200 ml-1">{status.controllerPort}</strong>
              </span>
            </div>
          </div>
        </div>

        {/* 控制按钮组 */}
        <div className="flex items-center space-x-2.5">
          {/* 嵌入的扩展设置（排除域名/IP） */}
          {extraAction}

          {/* 系统代理开关 */}
          <button
            onClick={handleToggleSystemProxy}
            title={proxy.state === "external" ? "点击将系统代理接入本核心" : proxy.message}
            disabled={loading || (!status.running && proxy.state !== "enabled" && proxy.state !== "unknown")}
            className={`flex items-center space-x-2 px-3.5 py-2 rounded-xl text-xs font-semibold border transition shadow-sm ${
              status.systemProxyEnabled
                ? "bg-indigo-600 hover:bg-indigo-500 text-white border-indigo-500 shadow-indigo-600/30"
                : "bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300/80 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 dark:border-slate-700 disabled:opacity-40"
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>系统代理: {loading ? "切换中…" : proxyStateLabel(proxy.state)}</span>
          </button>

          {/* 内核启动/关闭 */}
          <button
            onClick={handleToggleCore}
            disabled={loading}
            className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-semibold border transition shadow-sm ${
              status.running
                ? "bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 border-rose-500/30"
                : "bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500 shadow-emerald-600/30"
            }`}
          >
            {loading ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : status.running ? (
              <Square className="w-3.5 h-3.5" />
            ) : (
              <Play className="w-3.5 h-3.5 fill-current" />
            )}
            <span>{status.running ? "停止核心" : "启动核心"}</span>
          </button>
        </div>
      </div>

      {(proxy.bypassChanged || proxy.state === "unknown" || proxy.state === "external") && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400">{proxy.message}{proxy.state === "unknown" ? "；点击系统代理按钮重试" : ""}</p>
      )}
      {proxy.lastChange && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          最近变更 {new Date(proxy.lastChange.timestamp).toLocaleTimeString()}：{proxy.lastChange.reason}
        </p>
      )}
      {/* 内核版本与 CPU 架构选择器 */}
      <div className="pt-3 border-t border-slate-200 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center space-x-2 text-slate-500 dark:text-slate-400">
          <Cpu className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
          <span>硬件架构: <strong className="text-slate-800 dark:text-slate-300 font-mono">{cpuInfo?.arch || "x86_64"}</strong></span>
          {cpuInfo?.avx2Supported ? (
            <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
              <Zap className="w-3 h-3 fill-current" />
              <span>支持 AVX2 指令集</span>
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
              常规指令集
            </span>
          )}
        </div>

        {/* 双内核切换选择器 */}
        <div className="flex items-center space-x-1 bg-slate-100 dark:bg-slate-950 p-1 rounded-xl border border-slate-200 dark:border-slate-800">
          <span className="text-slate-500 px-2 font-medium">内核版本:</span>
          {(
            [
              { id: "auto", label: "自动优选" },
              { id: "v3", label: "amd64-v3 (AVX2 高性能)" },
              { id: "compatible", label: "amd64-compatible (通用兼容)" },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              onClick={() => setCoreMode(item.id)}
              disabled={status.running}
              className={`px-2.5 py-1 rounded-lg transition font-medium text-[11px] ${
                coreMode === item.id
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              } disabled:opacity-50`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
