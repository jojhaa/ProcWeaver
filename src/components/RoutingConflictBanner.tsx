import React from "react";
import { AlertTriangle, Info, ArrowDownUp, Sparkles } from "lucide-react";
import { ShadowedRuleItem, ProcessDomainCrossConflict } from "../utils/ruleConflictDetector";

interface Props {
  shadowedRules: ShadowedRuleItem[];
  processConflicts: ProcessDomainCrossConflict[];
  routingPriority: "domain_first" | "process_first" | "direct_first";
  onTogglePriority: () => void;
  onFixShadowing?: (shadowed: ShadowedRuleItem) => void;
  onDismiss?: () => void;
  className?: string;
}

export const RoutingConflictBanner: React.FC<Props> = ({
  shadowedRules,
  processConflicts,
  routingPriority,
  onTogglePriority,
  onFixShadowing,
  className = "",
}) => {
  const hasShadowing = shadowedRules.length > 0;
  const hasCrossConflict = processConflicts.length > 0;

  if (!hasShadowing && !hasCrossConflict) {
    return null;
  }

  return (
    <div className={`space-y-2.5 animate-in fade-in slide-in-from-top-2 duration-200 ${className}`}>
      {/* 遮蔽警告 (Dead Rule 告警) */}
      {hasShadowing && (
        <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-900 dark:text-amber-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start space-x-2.5 max-w-[75%]">
            <div className="p-1.5 rounded-xl bg-amber-500/20 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center space-x-2">
                <span className="text-xs font-bold">检测到 {shadowedRules.length} 处规则遮蔽 (死规则)</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/20 font-mono">严格位置截胡</span>
              </div>
              <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
                上方的「<strong>{shadowedRules[0].parentRuleName}</strong>」({shadowedRules[0].parentDomain} ➔ {shadowedRules[0].parentTarget}) 会导致下方的「<strong>{shadowedRules[0].ruleName}</strong>」({shadowedRules[0].shadowedDomain} ➔ {shadowedRules[0].shadowedTarget}) 被完全覆盖而<strong>无法生效</strong>。
              </p>
            </div>
          </div>

          {onFixShadowing && (
            <div className="flex items-center space-x-2 shrink-0">
              <button
                type="button"
                onClick={() => onFixShadowing(shadowedRules[0])}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold transition shadow-xs cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>一键优化调换顺序</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* 跨维度交叉提示 (进程 vs 域名) */}
      {hasCrossConflict && (
        <div className="p-3.5 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 text-indigo-900 dark:text-indigo-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start space-x-2.5 max-w-[75%]">
            <div className="p-1.5 rounded-xl bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5">
              <Info className="w-4 h-4" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center space-x-2">
                <span className="text-xs font-bold">进程与域名交叉重叠感知</span>
                <span className="text-[10px] px-2 py-0.5 rounded-md bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 font-bold">
                  {routingPriority === "domain_first" ? "当前：域名规则优先" : "当前：进程规则优先"}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-indigo-800 dark:text-indigo-300">
                浏览器 <strong>{processConflicts[0].processName}</strong> (绑定走向 {processConflicts[0].processTarget}) 与自定义域名 <strong>{processConflicts[0].conflictingRules[0].domain}</strong> (走向 {processConflicts[0].conflictingRules[0].domainTarget}) 目标不一致。
                {routingPriority === "domain_first"
                  ? " 当前域名优先生效：访问该域名时走指定出口，访问其他站点走浏览器进程出口。"
                  : " 当前进程优先生效：浏览器访问该域名将被整体接管，不单独按域名分流。"}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2 shrink-0">
            <button
              type="button"
              onClick={onTogglePriority}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition shadow-xs cursor-pointer"
            >
              <ArrowDownUp className="w-3.5 h-3.5" />
              <span>
                {routingPriority === "domain_first" ? "切换为进程优先" : "切换为域名优先"}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
