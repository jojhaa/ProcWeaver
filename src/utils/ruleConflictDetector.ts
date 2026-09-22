/**
 * 规则冲突与遮蔽分析器 (Rule Conflict & Shadowing Detector)
 */

export interface ShadowedRuleItem {
  ruleId: string;
  ruleName: string;
  shadowedDomain: string;
  shadowedTarget: string;
  parentRuleId: string;
  parentRuleName: string;
  parentDomain: string;
  parentTarget: string;
  reason: string;
}

export interface ProcessDomainCrossConflict {
  processName: string;
  processTarget: string;
  conflictingRules: Array<{
    ruleId: string;
    ruleName: string;
    domain: string;
    domainTarget: string;
  }>;
}

const BROWSER_PROCESSES = new Set([
  "chrome.exe",
  "msedge.exe",
  "firefox.exe",
  "brave.exe",
  "opera.exe",
  "vivaldi.exe",
  "arc.exe",
  "qqbrowser.exe",
  "360chrome.exe",
  "sogouexplorer.exe",
]);

export function cleanDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\*\./, "").replace(/^\./, "").replace(/\.$/, "");
}

export function isDomainCovered(childDomain: string, parentDomain: string): boolean {
  const child = cleanDomain(childDomain);
  const parent = cleanDomain(parentDomain);
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.endsWith("." + parent);
}

export function detectShadowedRules(
  rules: Array<{
    id: string;
    name: string;
    domains: string[];
    target: string;
  }>
): ShadowedRuleItem[] {
  const shadowed: ShadowedRuleItem[] = [];
  const seenRules: Array<{
    ruleId: string;
    ruleName: string;
    domain: string;
    target: string;
  }> = [];

  for (const rule of rules) {
    for (const rawDomain of rule.domains || []) {
      const domain = cleanDomain(rawDomain);
      if (!domain) continue;

      const parent = seenRules.find(
        (prior) => isDomainCovered(domain, prior.domain) && prior.target !== rule.target
      );

      if (parent) {
        shadowed.push({
          ruleId: rule.id,
          ruleName: rule.name,
          shadowedDomain: domain,
          shadowedTarget: rule.target,
          parentRuleId: parent.ruleId,
          parentRuleName: parent.ruleName,
          parentDomain: parent.domain,
          parentTarget: parent.target,
          reason: `排在前面的「${parent.ruleName}」(${parent.domain} ➔ ${parent.target}) 会先一步拦截匹配，导致本条规则 (${domain} ➔ ${rule.target}) 无法生效。`,
        });
      }

      seenRules.push({
        ruleId: rule.id,
        ruleName: rule.name,
        domain,
        target: rule.target,
      });
    }
  }

  return shadowed;
}

export function detectProcessDomainCross(
  processRules: Array<{
    name: string;
    target: string;
  }>,
  domainRules: Array<{
    id: string;
    name: string;
    domains: string[];
    target: string;
  }>
): ProcessDomainCrossConflict[] {
  const conflicts: ProcessDomainCrossConflict[] = [];

  for (const proc of processRules) {
    const procNameLower = proc.name.toLowerCase().trim();
    const isBrowser = BROWSER_PROCESSES.has(procNameLower);
    if (!isBrowser) continue;

    const crossRules: ProcessDomainCrossConflict["conflictingRules"] = [];

    for (const dRule of domainRules) {
      if (dRule.target === proc.target) continue;

      for (const rawDomain of dRule.domains || []) {
        const domain = cleanDomain(rawDomain);
        if (!domain) continue;
        crossRules.push({
          ruleId: dRule.id,
          ruleName: dRule.name,
          domain,
          domainTarget: dRule.target,
        });
      }
    }

    if (crossRules.length > 0) {
      conflicts.push({
        processName: proc.name,
        processTarget: proc.target,
        conflictingRules: crossRules,
      });
    }
  }

  return conflicts;
}
