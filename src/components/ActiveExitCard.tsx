import React, { useState, useEffect } from "react";
import { useExitIpHealth } from "../hooks/useExitIpHealth";
import { getPersistedHealthCache, savePersistedHealthCache } from "../api/nodeHealth";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  RefreshCw,
  Copy,
  Check,
  Globe,
  Home,
  Server,
  Radio,
  ExternalLink,
  X,
  ScrollText,
} from "lucide-react";

interface Props {
  proxyPort?: number;
  corePid?: number;
  activeNodeName?: string;
  activeNodeLabel?: string;
}

export const ActiveExitCard: React.FC<Props> = ({ proxyPort, corePid, activeNodeName, activeNodeLabel }) => {
  const { data, loading, phase, loadData } = useExitIpHealth(proxyPort, corePid);
  const [copied, setCopied] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // 当探测到出口健康数据且存在活动节点名时，自动反哺写入大盘缓存
  useEffect(() => {
    if (data && activeNodeName) {
      getPersistedHealthCache()
        .then(async (currentCache) => {
          currentCache[activeNodeName] = data;
          await savePersistedHealthCache(currentCache, true);
          window.dispatchEvent(
            new CustomEvent("netbox-node-health-updated", {
              detail: { node: activeNodeName, health: data },
            })
          );
        })
        .catch(console.error);
    }
  }, [data, activeNodeName]);

  const copyIp = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!data?.ip) return;
    navigator.clipboard.writeText(data.ip);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getScoreBadge = (score = 0) => {
    if (score <= 25) {
      return {
        level: "极佳 · 低风险",
        color: "text-emerald-500 bg-emerald-500/10 border-emerald-500/30",
        barColor: "bg-emerald-500",
        icon: <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />,
      };
    }
    if (score <= 60) {
      return {
        level: "良好 · 常见机房",
        color: "text-amber-500 bg-amber-500/10 border-amber-500/30",
        barColor: "bg-amber-500",
        icon: <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />,
      };
    }
    return {
      level: "风险较高 · 滥用疑虑",
      color: "text-rose-500 bg-rose-500/10 border-rose-500/30",
      barColor: "bg-rose-500",
      icon: <ShieldX className="w-3.5 h-3.5 text-rose-500" />,
    };
  };

  const scoreMeta = getScoreBadge(data?.fraudScore ?? 0);

  return (
    <>
      <div className="bg-white/90 dark:bg-slate-900/80 border border-slate-200/90 dark:border-slate-800/80 backdrop-blur-md rounded-2xl p-5 shadow-sm space-y-4 transition-all">
        {/* 出口 IP 与地理/组织画像 */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          {/* 左侧：出口名称与 IP */}
          <div className="flex items-start space-x-3.5">
            <div className="w-11 h-11 rounded-2xl bg-indigo-500/10 text-indigo-500 dark:text-indigo-400 border border-indigo-500/20 flex items-center justify-center shrink-0 mt-0.5">
              <Globe className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  当前物理出口画像 · 活动节点: <strong className="text-indigo-600 dark:text-indigo-400 font-bold">{activeNodeLabel || activeNodeName || "默认主组 (PROXY)"}</strong>
                </span>
                {data?.country && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium break-words">
                    {data.country} {data.city ? `· ${data.city}` : ""}
                  </span>
                )}
                {data?.isResidential !== undefined && (
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-md font-semibold ${data.isResidential ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-blue-500/10 text-blue-600 dark:text-blue-400"}`}>
                    {data.isResidential ? "原生家庭宽带" : "机房数据中心"}
                  </span>
                )}
                {data?.isBroadcast !== undefined && (
                  <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-purple-500/10 text-purple-600 dark:text-purple-400 font-mono">
                    {data.isBroadcast ? "广播宣告" : "原生分配"}
                  </span>
                )}
              </div>

              <div className="flex items-center space-x-2 mt-1">
                <span className="text-lg font-mono font-bold text-slate-900 dark:text-white tracking-tight">
                  {data?.ip || (loading ? phase : "---.---.---.---")}
                </span>
                {data?.ip && (
                  <button
                    type="button"
                    onClick={copyIp}
                    title="复制出口 IP"
                    className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                )}
              </div>

              <div className="text-[11px] text-slate-400 truncate max-w-sm sm:max-w-md mt-0.5 font-sans">
                {data?.asOrganization || data?.asn ? `运营商: ${data.asOrganization || data.asn}` : "等待核心网络数据就绪..."}
              </div>
            </div>
          </div>

          {/* 右侧：风控评分卡与刷新按钮 */}
          <div className="flex items-center space-x-2.5 shrink-0 self-end lg:self-center">
            {data ? (
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                className={`inline-flex items-center space-x-1.5 px-3.5 py-2 rounded-xl border text-xs font-semibold transition cursor-pointer hover:shadow-sm ${scoreMeta.color}`}
                title="点击查看完整体检报告"
              >
                {scoreMeta.icon}
                <span>{scoreMeta.level}</span>
                <span className="font-mono text-[11px] opacity-80">({data.fraudScore ?? 0}分)</span>
                <ExternalLink className="w-3 h-3 ml-0.5 opacity-60" />
              </button>
            ) : (
              <span className="text-xs text-slate-400">
                {proxyPort ? (loading ? "体检中..." : "待体检") : "核心待就绪"}
              </span>
            )}

            <button
              type="button"
              onClick={() => {
                loadData();
              }}
              disabled={loading || !proxyPort}
              title="刷新当前出口 IP 与健康指标"
              className="p-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 transition disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-indigo-500" : ""}`} />
            </button>

            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("netbox-navigate-tab", { detail: "logs" })
                );
              }}
              title="查看出口 IP 探测与系统运行日志"
              className="p-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 transition cursor-pointer"
            >
              <ScrollText className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 暂时隐藏：主流 AI 模型与流媒体解锁矩阵 (按需隐藏，保留底层接口) */}
      </div>

      {/* 完整体检报告弹窗 */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center space-x-2">
                <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-500 dark:text-indigo-400">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-white">出口 IP 深度体检报告</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    来源: {data?.source || "网络权威数据库"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* IP 与归属 */}
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800/80 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-500">检测出口 IP</span>
                <span className="text-base font-mono font-bold text-slate-900 dark:text-white">{data?.ip}</span>
              </div>
              <div className="flex justify-between items-start text-xs gap-3">
                <span className="text-slate-500 shrink-0">地理位置</span>
                <span className="text-slate-800 dark:text-slate-200 font-medium text-right break-words max-w-[280px]">
                  {data?.country} {data?.city}
                </span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-500">运营商 / 组织</span>
                <span className="text-slate-800 dark:text-slate-200 font-medium truncate max-w-[240px]">
                  {data?.asOrganization || data?.asn || "未知"}
                </span>
              </div>
            </div>

            {/* 风险分条 */}
            <div className={`p-4 rounded-xl border ${scoreMeta.color}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold">欺诈风险指数:</span>
                <span className="font-mono font-bold text-base">{data?.fraudScore ?? 0} / 100</span>
              </div>
              <div className="w-full bg-slate-200 dark:bg-slate-950 rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full rounded-full ${scoreMeta.barColor}`}
                  style={{ width: `${Math.min(100, Math.max(4, data?.fraudScore ?? 0))}%` }}
                />
              </div>
              <div className="text-[11px] mt-2 opacity-85 leading-relaxed">
                {data?.fraudScore !== undefined && data.fraudScore <= 25
                  ? "该 IP 极度纯净，无滥用记录，OpenAI、海外数字银行及防欺诈风控畅通无阻。"
                  : data?.fraudScore !== undefined && data.fraudScore <= 60
                  ? "该 IP 为常见数据中心机房出口，偶有人机验证。"
                  : "该 IP 风险较高，可能频繁触发人机验证或封锁。"}
              </div>
            </div>

            {/* 住宅与广播属性 */}
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 flex items-center space-x-2">
                {data?.isResidential ? (
                  <>
                    <Home className="w-4 h-4 text-emerald-500" />
                    <span className="text-emerald-600 dark:text-emerald-400 font-semibold">原生住宅宽带</span>
                  </>
                ) : (
                  <>
                    <Server className="w-4 h-4 text-blue-500" />
                    <span className="text-blue-600 dark:text-blue-400 font-semibold">机房数据中心</span>
                  </>
                )}
              </div>
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 flex items-center space-x-2">
                <Radio className="w-4 h-4 text-purple-500" />
                <span className="text-slate-700 dark:text-slate-300 font-semibold">
                  {data?.isBroadcast ? "广播宣告 IP" : "原生分配 IP"}
                </span>
              </div>
            </div>

            <div className="pt-2 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  window.dispatchEvent(
                    new CustomEvent("netbox-navigate-tab", { detail: "logs" })
                  );
                }}
                className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium transition cursor-pointer"
              >
                <ScrollText className="w-3.5 h-3.5 text-indigo-500" />
                <span>查看检测日志</span>
              </button>

              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow transition cursor-pointer"
              >
                关闭报告
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
