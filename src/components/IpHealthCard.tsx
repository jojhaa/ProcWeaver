import React, { useState } from "react";
import { useExitIpHealth } from "../hooks/useExitIpHealth";
import { 
  ShieldCheck, 
  ShieldAlert, 
  ShieldX, 
  Home, 
  Server, 
  Radio, 
  RefreshCw, 
  Copy, 
  Check, 
  Globe, 
  Compass, 
  Network
} from "lucide-react";

interface Props {
  proxyPort?: number;
  corePid?: number;
}

export const IpHealthCard: React.FC<Props> = ({ proxyPort, corePid }) => {
  const { data, loading, error, phase, loadData } = useExitIpHealth(proxyPort, corePid);
  const [copied, setCopied] = useState(false);

  const copyIp = () => {
    if (!data?.ip) return;
    navigator.clipboard.writeText(data.ip);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // 根据欺诈分判断评级
  const getScoreBadge = (score = 0) => {
    if (score <= 25) {
      return {
        level: "极佳 (低风险)",
        color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
        barColor: "bg-emerald-500",
        icon: <ShieldCheck className="w-5 h-5 text-emerald-400" />,
      };
    }
    if (score <= 60) {
      return {
        level: "中度 (机房/常见代理)",
        color: "text-amber-400 bg-amber-500/10 border-amber-500/30",
        barColor: "bg-amber-500",
        icon: <ShieldAlert className="w-5 h-5 text-amber-400" />,
      };
    }
    return {
      level: "高危 (高风控拦截)",
      color: "text-rose-400 bg-rose-500/10 border-rose-500/30",
      barColor: "bg-rose-500",
      icon: <ShieldX className="w-5 h-5 text-rose-400" />,
    };
  };

  const scoreMeta = getScoreBadge(data?.fraudScore ?? 0);

  return (
    <div className="bg-white/90 dark:bg-slate-900/80 border border-slate-200/90 dark:border-slate-800/80 backdrop-blur-md rounded-2xl p-6 shadow-sm dark:shadow-xl relative overflow-hidden transition-all">
      {/* 顶部标题与操作栏 */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center space-x-3">
          <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-500 dark:text-indigo-400 border border-indigo-500/20">
            <Globe className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900 dark:text-white tracking-tight">出口 IP 纯净度检测</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">来源: {data?.source || "正在获取检测来源"}</p>
          </div>
        </div>

        <button
          onClick={loadData}
          disabled={loading || !proxyPort}
          className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300/80 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 dark:border-slate-700 text-xs font-semibold border transition shadow-sm disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-indigo-500 dark:text-indigo-400" : ""}`} />
          <span>{loading ? phase : "重新检测"}</span>
        </button>
      </div>

      {!proxyPort && <p role="status" className="text-sm text-slate-500">等待核心启动与节点连接后检测</p>}
      {error ? (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-500 dark:text-rose-400 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={loadData} className="underline text-xs hover:text-rose-600 dark:hover:text-rose-300">重试</button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* IP 与主要标签 */}
          <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl bg-slate-100/70 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800/80 transition-colors">
            <div className="flex items-center space-x-3">
              <span className="text-2xl font-mono font-bold text-slate-900 dark:text-white tracking-tight">
                {data ? data.ip : "---.---.---.---"}
              </span>
              <button
                onClick={copyIp}
                title="复制 IP"
                className="p-1.5 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 border border-slate-200 dark:border-slate-700 transition shadow-xs"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-500 dark:text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            {/* 住宅 / 机房 / 广播 Badge */}
            <div className="flex items-center space-x-2">
              {data?.isResidential ? (
                <span className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                  <Home className="w-3.5 h-3.5" />
                  <span>原生住宅 (Residential)</span>
                </span>
              ) : (
                <span className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30">
                  <Server className="w-3.5 h-3.5" />
                  <span>{data?.isResidential === false ? "数据中心 (Datacenter)" : "网络类型未知"}</span>
                </span>
              )}

              {data?.isBroadcast && (
                <span className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/30">
                  <Radio className="w-3.5 h-3.5" />
                  <span>广播 IP</span>
                </span>
              )}
            </div>
          </div>

          {/* 欺诈分风险仪表 */}
          <div className={`p-4 rounded-xl border ${scoreMeta.color}`}>
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center space-x-2">
                {scoreMeta.icon}
                <span className="font-semibold text-xs sm:text-sm">欺诈风险指数 (Fraud Score):</span>
                <span className="font-bold text-base sm:text-lg font-mono">{data?.fraudScore ?? "不可用"}</span>
                <span className="text-xs opacity-75">/ 100</span>
              </div>
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-black/10 dark:bg-black/30 border border-current/20">
                {typeof data?.fraudScore === "number" ? scoreMeta.level : "尚无有效评分"}
              </span>
            </div>

            {/* 评分进度条 */}
            <div className="w-full bg-slate-200 dark:bg-slate-950/80 rounded-full h-2 overflow-hidden p-0.5 border border-slate-300/50 dark:border-slate-800">
              <div
                className={`h-full rounded-full transition-all duration-700 ${scoreMeta.barColor}`}
                style={{ width: `${Math.min(100, Math.max(4, data?.fraudScore ?? 0))}%` }}
              />
            </div>
          </div>

          {/* 地理位置与运营商详情网格 */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200/90 dark:border-slate-800/80 transition-all hover:border-indigo-500/30">
              <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5 mb-1.5 font-medium">
                <Globe className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" />
                国家 / 地区
              </span>
              <p className="font-bold text-slate-800 dark:text-slate-200 text-sm">
                {data ? `${data.country || ""} (${data.countryCode || "N/A"})` : "---"}
              </p>
              <p className="text-slate-500 dark:text-slate-400 text-[11px] mt-0.5">
                {data ? `${data.region || ""}, ${data.city || ""}` : "---"}
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200/90 dark:border-slate-800/80 transition-all hover:border-emerald-500/30">
              <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5 mb-1.5 font-medium">
                <Network className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                ASN 与运营商
              </span>
              <p className="font-bold text-slate-800 dark:text-slate-200 text-sm font-mono">
                {data?.asn ? `AS${data.asn}` : "---"}
              </p>
              <p className="text-slate-500 dark:text-slate-400 text-[11px] truncate mt-0.5" title={data?.asOrganization}>
                {data?.asOrganization || "---"}
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200/90 dark:border-slate-800/80 col-span-2 sm:col-span-1 transition-all hover:border-amber-500/30">
              <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5 mb-1.5 font-medium">
                <Compass className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
                时区与坐标
              </span>
              <p className="font-bold text-slate-800 dark:text-slate-200 text-sm truncate font-mono">
                {data?.timezone || "---"}
              </p>
              <p className="text-slate-500 dark:text-slate-400 text-[11px] mt-0.5 font-mono">
                {data?.latitude && data?.longitude ? `${data.latitude}, ${data.longitude}` : "---"}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
