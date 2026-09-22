import React, { useState } from "react";
import { X, Search, Sparkles, CheckCircle2, ArrowRight } from "lucide-react";
import { cleanDomain, isDomainCovered } from "../utils/ruleConflictDetector";
import { BusinessChannelConfig } from "../types/smartGroup";

import { ProcessRule } from "../types/routingOverrides";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  channels: BusinessChannelConfig[];
  processRules?: ProcessRule[];
  routingPriority: "domain_first" | "process_first" | "direct_first";
  onHighlightRule?: (ruleId: string) => void;
}

const COMMON_CN_DOMAINS = [
  "baidu.com", "bilibili.com", "qq.com", "taobao.com", "jd.com", "alipay.com",
  "zhihu.com", "weibo.com", "163.com", "douyin.com", "feishu.cn", "dingtalk.com"
];

const COMMON_AD_KEYWORDS = [
  "telemetry", "tracking", "analytics", "adservice", "doubleclick"
];

export const RouteTesterModal: React.FC<Props> = ({
  isOpen,
  onClose,
  channels,
  processRules = [],
  routingPriority,
  onHighlightRule,
}) => {
  const [testInput, setTestInput] = useState("");
  const [selectedProcess, setSelectedProcess] = useState("chrome.exe");
  const [matchResult, setMatchResult] = useState<{
    hit: boolean;
    ruleName: string;
    ruleType: "DIRECT-WHITELIST" | "DOMAIN-SUFFIX" | "SUB-RULE-SANDBOX" | "PROCESS-STRICT" | "MATCH";
    matchedPayload: string;
    targetName: string;
    reason: string;
    rank: number;
    pipeline: string[];
  } | null>(null);

  if (!isOpen) return null;

  const handleRunTest = (e?: React.FormEvent) => {
    e?.preventDefault();
    const raw = testInput.trim();
    if (!raw) return;

    // 解析出纯域名
    let domainCandidate = raw;
    try {
      if (raw.includes("://")) {
        const u = new URL(raw);
        domainCandidate = u.hostname;
      } else {
        domainCandidate = raw.split("/")[0].split(":")[0];
      }
    } catch (_) {
      domainCandidate = raw.split("/")[0].split(":")[0];
    }
    const cleanTestDomain = cleanDomain(domainCandidate);
    const testProcLower = selectedProcess.trim().toLowerCase();

    // 1. 整理域名规则
    const domainRulesList: Array<{
      id: string;
      name: string;
      domain: string;
      target: string;
      isSuffix: boolean;
    }> = [];

    channels.forEach((ch) => {
      (ch.customDomains || []).forEach((d) => {
        domainRulesList.push({
          id: ch.id,
          name: ch.name,
          domain: cleanDomain(d),
          target: ch.targetName || "DIRECT",
          isSuffix: true,
        });
      });
    });

    // 2. 整理进程规则 (包括 ProcessRule 与 channels.customProcesses)
    const procRulesList: Array<{
      id: string;
      name: string;
      process: string;
      target: string;
      action: "proxy" | "direct" | "reject";
      ruleMode: "inherit" | "strict";
    }> = [];

    processRules.filter((r) => r.enabled).forEach((r) => {
      procRulesList.push({
        id: r.id,
        name: r.label || r.matchValue,
        process: r.matchValue.trim().toLowerCase(),
        target: r.target?.name || (r.action === "direct" ? "DIRECT" : "REJECT"),
        action: r.action,
        ruleMode: r.ruleMode || "inherit",
      });
    });

    channels.forEach((ch) => {
      (ch.customProcesses || []).forEach((p) => {
        const procName = p.trim().toLowerCase();
        if (!procRulesList.some((pr) => pr.process === procName)) {
          procRulesList.push({
            id: ch.id,
            name: ch.name,
            process: procName,
            target: ch.targetName || "DIRECT",
            action: ch.targetName?.toUpperCase() === "DIRECT" ? "direct" : "proxy",
            ruleMode: "inherit",
          });
        }
      });
    });

    const isCnDomain = cleanTestDomain.endsWith(".cn") || COMMON_CN_DOMAINS.some((d) => cleanTestDomain === d || cleanTestDomain.endsWith("." + d));
    const isAdDomain = COMMON_AD_KEYWORDS.some((kw) => cleanTestDomain.includes(kw));

    let result = null;
    const pipeline: string[] = [];

    pipeline.push(`仲裁基准：【${
      routingPriority === "direct_first"
        ? "白名单直连绝对最高"
        : routingPriority === "process_first"
        ? "进程强锁防关联"
        : "业务专线优先 (推荐日常)"
    }】`);

    // 判定流水线
    if (routingPriority === "direct_first") {
      // 阶段 1: 扫描所有标记为 DIRECT 的规则 (域名直连优先)
      const directDomainHit = domainRulesList.find((r) => r.target === "DIRECT" && isDomainCovered(cleanTestDomain, r.domain));
      if (directDomainHit) {
        pipeline.push(`直接命中域名白名单直连规则「${directDomainHit.name}」(${directDomainHit.domain})`);
        result = {
          hit: true,
          ruleName: directDomainHit.name,
          ruleType: "DIRECT-WHITELIST" as const,
          matchedPayload: directDomainHit.domain,
          targetName: "DIRECT (本地物理网卡直连)",
          reason: "「白名单直连绝对最高」生效：域名直连规则享有绝对优先出站权，直接走本地物理网卡。",
          rank: 1,
          pipeline,
        };
        onHighlightRule?.(directDomainHit.id);
      }

      // 阶段 2: 扫描标记为 DIRECT 的进程
      if (!result && testProcLower) {
        const directProcHit = procRulesList.find((p) => p.process === testProcLower && p.target === "DIRECT");
        if (directProcHit) {
          pipeline.push(`直接命中进程白名单直连规则「${directProcHit.name}」`);
          result = {
            hit: true,
            ruleName: directProcHit.name,
            ruleType: "DIRECT-WHITELIST" as const,
            matchedPayload: directProcHit.process,
            targetName: "DIRECT (本地物理网卡直连)",
            reason: "「白名单直连绝对最高」生效：该进程已被标记为本地直连，强制绕过所有代理出站。",
            rank: 1,
            pipeline,
          };
          onHighlightRule?.(directProcHit.id);
        }
      }
    }

    // 若未在 direct_first 中决出：
    if (!result) {
      if (routingPriority === "process_first") {
        // 进程强锁优先
        if (testProcLower) {
          const procHit = procRulesList.find((p) => p.process === testProcLower);
          if (procHit) {
            if (procHit.ruleMode === "strict") {
              pipeline.push(`程序「${testProcLower}」被「进程强锁防关联」接管，执行独占出国绑定`);
              result = {
                hit: true,
                ruleName: procHit.name,
                ruleType: "PROCESS-STRICT" as const,
                matchedPayload: procHit.process,
                targetName: `${procHit.target} (强锁独占)`,
                reason: `进程强锁防关联模式生效：程序「${testProcLower}」死锁在指定节点，不跳出该国出口，压制后续域名规则。`,
                rank: 1,
                pipeline,
              };
            } else {
              // 继承模式：进沙盒
              if (isAdDomain) {
                pipeline.push(`程序「${testProcLower}」进入专属子规则沙盒 -> 命中公共广告拦截规则`);
                result = {
                  hit: true,
                  ruleName: `${procHit.name} (沙盒)`,
                  ruleType: "SUB-RULE-SANDBOX" as const,
                  matchedPayload: "GEOSITE:category-ads-all",
                  targetName: "REJECT (广告丢弃)",
                  reason: `继承核心订阅：程序「${testProcLower}」访问广告/追踪域名，被子规则沙盒拦截丢弃。`,
                  rank: 1,
                  pipeline,
                };
              } else if (isCnDomain) {
                pipeline.push(`程序「${testProcLower}」进入专属子规则沙盒 -> 命中中国大陆直连规则 (CN)`);
                result = {
                  hit: true,
                  ruleName: `${procHit.name} (沙盒)`,
                  ruleType: "SUB-RULE-SANDBOX" as const,
                  matchedPayload: "GEOIP/GEOSITE:cn",
                  targetName: "DIRECT (本地直连)",
                  reason: `继承核心订阅：程序「${testProcLower}」访问国内网站，智能继承国内直连，不耗费代理流量。`,
                  rank: 1,
                  pipeline,
                };
              } else {
                pipeline.push(`程序「${testProcLower}」进入专属子规则沙盒 -> 出国流量定向定向走专属节点`);
                result = {
                  hit: true,
                  ruleName: `${procHit.name} (沙盒)`,
                  ruleType: "SUB-RULE-SANDBOX" as const,
                  matchedPayload: procHit.process,
                  targetName: procHit.target,
                  reason: `继承核心订阅：程序「${testProcLower}」访问海外网站，精准定向至用户指定的专属出口。`,
                  rank: 1,
                  pipeline,
                };
              }
            }
            onHighlightRule?.(procHit.id);
          }
        }

        // 若进程未纳管，回退查域名规则
        if (!result) {
          for (let i = 0; i < domainRulesList.length; i++) {
            const r = domainRulesList[i];
            if (isDomainCovered(cleanTestDomain, r.domain)) {
              pipeline.push(`进程未纳管，回退命中业务专线「${r.name}」(${r.domain})`);
              result = {
                hit: true,
                ruleName: r.name,
                ruleType: "DOMAIN-SUFFIX" as const,
                matchedPayload: r.domain,
                targetName: r.target,
                reason: `进程未被单独接管，顺位匹配到第 ${i + 1} 位业务域名规则。`,
                rank: i + 1,
                pipeline,
              };
              onHighlightRule?.(r.id);
              break;
            }
          }
        }
      } else {
        // domain_first (或 direct_first 未命中的常规流)
        // 1. 优先查特定域名专线
        for (let i = 0; i < domainRulesList.length; i++) {
          const r = domainRulesList[i];
          if (isDomainCovered(cleanTestDomain, r.domain)) {
            pipeline.push(`优先命中业务专线规则「${r.name}」(${r.domain})`);
            result = {
              hit: true,
              ruleName: r.name,
              ruleType: "DOMAIN-SUFFIX" as const,
              matchedPayload: r.domain,
              targetName: r.target,
              reason: `业务专线优先生效：域名「${r.domain}」命中业务专线「${r.name}」，即使进程有指定出口也被业务专线接管。`,
              rank: i + 1,
              pipeline,
            };
            onHighlightRule?.(r.id);
            break;
          }
        }

        // 2. 域名未命中专线，查对应进程
        if (!result && testProcLower) {
          const procHit = procRulesList.find((p) => p.process === testProcLower);
          if (procHit) {
            if (procHit.ruleMode === "strict") {
              pipeline.push(`域名无专线，落入程序「${testProcLower}」强锁独占规则`);
              result = {
                hit: true,
                ruleName: procHit.name,
                ruleType: "PROCESS-STRICT" as const,
                matchedPayload: procHit.process,
                targetName: `${procHit.target} (强锁独占)`,
                reason: `域名未配置专线，落入程序「${testProcLower}」的整进程出站规则。`,
                rank: domainRulesList.length + 1,
                pipeline,
              };
            } else {
              // 继承沙盒
              if (isAdDomain) {
                pipeline.push(`域名无专线，落入程序「${testProcLower}」沙盒 -> 命中广告拦截`);
                result = {
                  hit: true,
                  ruleName: `${procHit.name} (沙盒)`,
                  ruleType: "SUB-RULE-SANDBOX" as const,
                  matchedPayload: "category-ads-all",
                  targetName: "REJECT (广告丢弃)",
                  reason: `子规则沙盒生效：拦截了该应用访问的广告与遥测域名。`,
                  rank: domainRulesList.length + 1,
                  pipeline,
                };
              } else if (isCnDomain) {
                pipeline.push(`域名无专线，落入程序「${testProcLower}」沙盒 -> 命中国内直连 (CN)`);
                result = {
                  hit: true,
                  ruleName: `${procHit.name} (沙盒)`,
                  ruleType: "SUB-RULE-SANDBOX" as const,
                  matchedPayload: "CN 域名/IP",
                  targetName: "DIRECT (本地直连)",
                  reason: `子规则沙盒生效：该应用访问国内服务，保留国内高速直连。`,
                  rank: domainRulesList.length + 1,
                  pipeline,
                };
              } else {
                pipeline.push(`域名无专线，落入程序「${testProcLower}」沙盒 -> 出国定向专属节点`);
                result = {
                  hit: true,
                  ruleName: `${procHit.name} (沙盒)`,
                  ruleType: "SUB-RULE-SANDBOX" as const,
                  matchedPayload: procHit.process,
                  targetName: procHit.target,
                  reason: `子规则沙盒生效：该应用访问海外服务，定向到为其指定的专属出口。`,
                  rank: domainRulesList.length + 1,
                  pipeline,
                };
              }
            }
            onHighlightRule?.(procHit.id);
          }
        }
      }
    }

    // 兜底大盘
    if (!result) {
      pipeline.push(`前置规则均未命中 -> 移交流水线末尾 MATCH 兜底 (系统代理大盘)`);
      result = {
        hit: false,
        ruleName: "系统代理大盘 / MATCH 兜底",
        ruleType: "MATCH" as const,
        matchedPayload: "*",
        targetName: "PROXY (全局大盘默认节点)",
        reason: "未命中任何前置专线、白名单或已纳管进程，遵循系统代理大盘默认节点出站。",
        rank: domainRulesList.length + procRulesList.length + 1,
        pipeline,
      };
    }

    setMatchResult(result);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-lg rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden flex flex-col">
        {/* 标题栏 */}
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">分流路线测路沙盒</h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">模拟单次网络请求的自上而下匹配与出站走向</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 表单内容 */}
        <div className="p-6 space-y-4">
          <form onSubmit={handleRunTest} className="space-y-3.5">
            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                测试目标网址 / 域名:
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={testInput}
                  onChange={(e) => setTestInput(e.target.value)}
                  placeholder="例如: ping0.cc 或 https://chatgpt.com"
                  className="w-full px-3.5 py-2.5 pl-9 rounded-2xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition font-mono"
                  autoFocus
                />
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                模拟发起请求的进程:
              </label>
              <div className="flex items-center space-x-2">
                {["chrome.exe", "msedge.exe", "Spotify.exe", "其他软件"].map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setSelectedProcess(p === "其他软件" ? "" : p)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${
                      selectedProcess === p || (p === "其他软件" && !selectedProcess)
                        ? "bg-indigo-600 border-indigo-600 text-white"
                        : "bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-300"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="submit"
              disabled={!testInput.trim()}
              className="w-full py-2.5 rounded-2xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold transition shadow-sm flex items-center justify-center space-x-1.5 cursor-pointer"
            >
              <Search className="w-3.5 h-3.5" />
              <span>立即测路模拟</span>
            </button>
          </form>

          {/* 测路结果展示 */}
          {matchResult && (
            <div className="mt-4 p-4 rounded-2xl bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 space-y-3 animate-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between pb-2 border-b border-slate-200/80 dark:border-slate-800">
                <div className="flex items-center space-x-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  <span className="text-xs font-bold text-slate-900 dark:text-white">测路裁决结果</span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-mono font-bold">
                  命中耗时: 0.1ms
                </span>
              </div>

              <div className="flex items-center justify-between p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 shadow-2xs">
                <div className="space-y-0.5">
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider block">最终出站走向</span>
                  <span className="text-sm font-extrabold text-indigo-600 dark:text-indigo-400">
                    {matchResult.targetName}
                  </span>
                </div>
                <div className="text-right space-y-0.5">
                  <span className="text-[10px] text-slate-400 block">规则类型</span>
                  <span className="text-xs font-mono font-bold text-slate-700 dark:text-slate-300">
                    {matchResult.ruleType}
                  </span>
                </div>
              </div>

              <div className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed space-y-1">
                <div className="flex items-center space-x-1.5 text-slate-700 dark:text-slate-300 font-medium">
                  <ArrowRight className="w-3.5 h-3.5 text-indigo-500" />
                  <span>匹配依据: 命中「{matchResult.ruleName}」({matchResult.matchedPayload})</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 pl-5">
                  {matchResult.reason}
                </p>
              </div>

              {matchResult.pipeline && matchResult.pipeline.length > 0 && (
                <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800/80 space-y-1">
                  <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">裁决匹配流水线：</span>
                  {matchResult.pipeline.map((step, idx) => (
                    <div key={idx} className="text-[11px] text-slate-600 dark:text-slate-300 flex items-start space-x-1.5 font-mono">
                      <span className="text-indigo-500 font-bold shrink-0">{idx + 1}.</span>
                      <span>{step}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
