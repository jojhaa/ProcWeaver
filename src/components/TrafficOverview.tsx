import React from "react";
import { ArrowDown, ArrowUp, Download, Upload, Activity } from "lucide-react";
import { TrafficReading } from "../utils/trafficCounter";

interface Props {
  reading: TrafficReading;
  onlyProxy: boolean;
  error: string;
}

export const TrafficOverview: React.FC<Props> = ({ reading, onlyProxy, error }) => {
  const { upSpeed, downSpeed, download: totalDownload, upload: totalUpload } = reading;

  const formatSpeed = (bytesPerSec: number) => {
    if (!bytesPerSec || bytesPerSec <= 0 || !Number.isFinite(bytesPerSec)) return "0 B/s";
    if (bytesPerSec < 1024) return `${Number(bytesPerSec.toFixed(3))} B/s`;
    if (bytesPerSec < 1024 * 1024) return `${Number((bytesPerSec / 1024).toFixed(3))} KB/s`;
    return `${Number((bytesPerSec / (1024 * 1024)).toFixed(3))} MB/s`;
  };

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return "0 B";
    if (bytes < 1024) return `${Number(bytes.toFixed(3))} B`;
    if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(3))} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${Number((bytes / (1024 * 1024)).toFixed(3))} MB`;
    return `${Number((bytes / (1024 * 1024 * 1024)).toFixed(3))} GB`;
  };

  return (
    <div className="space-y-2.5">
      {/* 状态说明顶栏 */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center space-x-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
          <Activity className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
          <span>网络流量监控</span>
        </div>
        <div className="flex items-center space-x-2 text-[11px]">
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/60 text-slate-600 dark:text-slate-400">
            <span className={`w-1.5 h-1.5 rounded-full ${downSpeed > 0 || upSpeed > 0 ? "bg-emerald-500 animate-pulse" : "bg-slate-400 dark:bg-slate-500"}`} />
            <span>{onlyProxy ? "仅代理 · 连接采样" : "全流量 · 含直连"}</span>
          </span>
          {error && <span className="text-rose-500 dark:text-rose-400 font-mono">({error})</span>}
        </div>
      </div>

      {/* 4 列流量指标卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* 1. 实时下行 */}
        <div className="bg-white/90 dark:bg-slate-900/80 border border-slate-200/90 dark:border-slate-800/80 hover:border-cyan-500/40 dark:hover:border-cyan-500/40 rounded-2xl p-4 shadow-sm dark:shadow-lg transition-all duration-200 group">
          <div className="flex items-center justify-between mb-2">
            <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/20 group-hover:scale-105 transition-transform">
              <ArrowDown className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-mono font-bold tracking-wider px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
              DOWN
            </span>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium block">实时下行</span>
          <p className="text-lg sm:text-xl font-mono font-bold text-slate-900 dark:text-white mt-0.5 tracking-tight">
            {formatSpeed(downSpeed)}
          </p>
        </div>

        {/* 2. 实时上行 */}
        <div className="bg-white/90 dark:bg-slate-900/80 border border-slate-200/90 dark:border-slate-800/80 hover:border-violet-500/40 dark:hover:border-violet-500/40 rounded-2xl p-4 shadow-sm dark:shadow-lg transition-all duration-200 group">
          <div className="flex items-center justify-between mb-2">
            <div className="p-2 rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20 group-hover:scale-105 transition-transform">
              <ArrowUp className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-mono font-bold tracking-wider px-2 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400">
              UP
            </span>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium block">实时上行</span>
          <p className="text-lg sm:text-xl font-mono font-bold text-slate-900 dark:text-white mt-0.5 tracking-tight">
            {formatSpeed(upSpeed)}
          </p>
        </div>

        {/* 3. 累计下载 */}
        <div className="bg-white/90 dark:bg-slate-900/80 border border-slate-200/90 dark:border-slate-800/80 hover:border-emerald-500/40 dark:hover:border-emerald-500/40 rounded-2xl p-4 shadow-sm dark:shadow-lg transition-all duration-200 group">
          <div className="flex items-center justify-between mb-2">
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 group-hover:scale-105 transition-transform">
              <Download className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-mono font-bold tracking-wider px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              TOTAL
            </span>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium block">累计下载</span>
          <p className="text-lg sm:text-xl font-mono font-bold text-slate-900 dark:text-white mt-0.5 tracking-tight">
            {formatBytes(totalDownload)}
          </p>
        </div>

        {/* 4. 累计上传 */}
        <div className="bg-white/90 dark:bg-slate-900/80 border border-slate-200/90 dark:border-slate-800/80 hover:border-amber-500/40 dark:hover:border-amber-500/40 rounded-2xl p-4 shadow-sm dark:shadow-lg transition-all duration-200 group">
          <div className="flex items-center justify-between mb-2">
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 group-hover:scale-105 transition-transform">
              <Upload className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-mono font-bold tracking-wider px-2 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
              TOTAL
            </span>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium block">累计上传</span>
          <p className="text-lg sm:text-xl font-mono font-bold text-slate-900 dark:text-white mt-0.5 tracking-tight">
            {formatBytes(totalUpload)}
          </p>
        </div>
      </div>
    </div>
  );
};
