import { useState, useEffect, useMemo, useCallback } from "react";
import { useExclusions } from "../hooks/useExclusions";
import { useLocalRulePlan } from "../hooks/useLocalRulePlan";
import { fetchRules, fetchRuleProviders, updateRuleProvider } from "../api/mihomo";
import { getProfiles, getProfileContent } from "../api";
import PRESET_RULE_PROVIDERS from "../data/localRulePresets.json";
import { RuleItem, RuleProviderItem } from "../types";
import { splitExclusionInput } from "../utils/exclusionInput";
import {
  Layers,
  Search,
  RefreshCw,
  Shield,
  Sparkles,
  ArrowRight,
  Database,
  X,
} from "lucide-react";

interface Props {
  coreMode: { mode: string | null; busy: boolean };
  running: boolean;
}

// 解析 YAML 文本中的 rules 列表
function parseYamlRules(yamlContent: string): RuleItem[] {
  if (!yamlContent) return [];
  const lines = yamlContent.split(/\r?\n/);
  const rules: RuleItem[] = [];
  let inRulesSection = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    // 匹配顶级或独立 section: "rules:"
    if (/^rules\s*:/i.test(trimmed)) {
      inRulesSection = true;
      continue;
    }

    if (inRulesSection) {
      // 遇到非缩进的顶级 key，退出 rules 块
      if (/^[a-zA-Z0-9_-]+\s*:/i.test(rawLine) && !rawLine.startsWith(" ") && !rawLine.startsWith("\t")) {
        break;
      }

      if (trimmed.startsWith("-")) {
        let content = trimmed.substring(1).trim();
        // 移除尾部注释
        const commentIdx = content.indexOf("#");
        if (commentIdx !== -1) {
          content = content.substring(0, commentIdx).trim();
        }
        // 移除单双引号
        if (
          (content.startsWith('"') && content.endsWith('"')) ||
          (content.startsWith("'") && content.endsWith("'"))
        ) {
          content = content.substring(1, content.length - 1).trim();
        }

        if (!content) continue;

        const parts = content.split(",").map((s) => s.trim());
        if (parts.length >= 2) {
          const type = parts[0];
          let payload = "";
          let proxy = "";
          if (parts.length === 2) {
            payload = type.toUpperCase() === "MATCH" || type.toUpperCase() === "FINAL" ? "全部流量" : "";
            proxy = parts[1];
          } else {
            payload = parts[1];
            proxy = parts[2];
          }
          rules.push({ type, payload, proxy });
        }
      }
    }
  }

  return rules;
}

// 解析 YAML 文本中的 rule-providers 字典
function parseYamlRuleProviders(yamlContent: string): RuleProviderItem[] {
  if (!yamlContent) return [];
  const lines = yamlContent.split(/\r?\n/);
  const providers: RuleProviderItem[] = [];
  let inSection = false;
  let currentName = "";
  let currentObj: Partial<RuleProviderItem> = {};

  const saveCurrent = () => {
    if (currentName) {
      providers.push({
        name: currentName,
        type: currentObj.type || "Http",
        behavior: currentObj.behavior || "classical",
        ruleCount: currentObj.ruleCount ?? 0,
        updatedAt: currentObj.updatedAt || "",
        vehicleType: currentObj.vehicleType || (currentObj.type ? currentObj.type.toUpperCase() : "HTTP"),
      });
      currentName = "";
      currentObj = {};
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^rule-providers\s*:/i.test(trimmed)) {
      inSection = true;
      continue;
    }

    if (inSection) {
      if (/^[a-zA-Z0-9_-]+\s*:/i.test(rawLine) && !rawLine.startsWith(" ") && !rawLine.startsWith("\t")) {
        saveCurrent();
        break;
      }

      // 二级键 (provider 名称)
      const nameMatch = rawLine.match(/^(\s{2,4})([a-zA-Z0-9_.-]+)\s*:(.*)$/);
      if (nameMatch) {
        saveCurrent();
        currentName = nameMatch[2].trim();
        const rest = nameMatch[3].trim();
        if (rest.startsWith("{") && rest.endsWith("}")) {
          const typeMatch = rest.match(/type\s*:\s*([^,}]+)/i);
          const behaviorMatch = rest.match(/behavior\s*:\s*([^,}]+)/i);
          const formatMatch = rest.match(/format\s*:\s*([^,}]+)/i);
          if (typeMatch) currentObj.type = typeMatch[1].trim().replace(/['"]/g, "");
          if (behaviorMatch) currentObj.behavior = behaviorMatch[1].trim().replace(/['"]/g, "");
          if (formatMatch) currentObj.vehicleType = formatMatch[1].trim().toUpperCase().replace(/['"]/g, "");
        }
        continue;
      }

      if (currentName) {
        const propMatch = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*:\s*(.+)$/);
        if (propMatch) {
          const k = propMatch[1].toLowerCase();
          const v = propMatch[2].trim().replace(/^['"]|['"]$/g, "");
          if (k === "type") currentObj.type = v;
          if (k === "behavior") currentObj.behavior = v;
          if (k === "format") currentObj.vehicleType = v.toUpperCase();
        }
      }
    }
  }

  saveCurrent();
  return providers;
}

export function AndroidRulesView({ coreMode: _coreMode, running }: Props) {
  // 子导航：direct (直连排除) | rules (生效规则) | providers (外部规则集)
  const [subTab, setSubTab] = useState<"direct" | "rules" | "providers">("direct");

  // 1. 直连排除数据
  const exclusions = useExclusions();

  // 2. 自动补充规则方案
  const rulePlan = useLocalRulePlan();
  useEffect(() => { void rulePlan.reload(); }, []);

  // 3. 生效规则与外部规则集
  const [rules, setRules] = useState<RuleItem[]>([]);
  const [providers, setProviders] = useState<RuleProviderItem[]>([]);
  const [loadingRules, setLoadingRules] = useState(false);
  const [updatingProvider, setUpdatingProvider] = useState<string | null>(null);
  const [updateAllBusy, setUpdateAllBusy] = useState(false);
  const [isOfflinePreview, setIsOfflinePreview] = useState(false);

  // 搜索与过滤
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  const loadAllRules = useCallback(async () => {
    setLoadingRules(true);
    try {
      // 1. 如果在运行中，优先拉取 Mihomo 内核的实时生效规则与规则集
      let runtimeRules: RuleItem[] = [];
      let runtimeProviders: RuleProviderItem[] = [];
      if (running) {
        try {
          const [rRes, pRes] = await Promise.allSettled([fetchRules(), fetchRuleProviders()]);
          if (rRes.status === "fulfilled" && Array.isArray(rRes.value) && rRes.value.length > 0) {
            runtimeRules = rRes.value;
          }
          if (pRes.status === "fulfilled" && Array.isArray(pRes.value) && pRes.value.length > 0) {
            runtimeProviders = pRes.value;
          }
        } catch (e) {
          console.warn("拉取运行时规则异常:", e);
        }
      }

      // 2. 读取当前激活的 Profile YAML
      let profileRules: RuleItem[] = [];
      let profileProviders: RuleProviderItem[] = [];
      try {
        const profileList = await getProfiles();
        const activeProfile = profileList.find((p) => p.isSelected) || profileList[0];
        if (activeProfile) {
          const yaml = await getProfileContent(activeProfile.id);
          if (yaml) {
            profileRules = parseYamlRules(yaml);
            profileProviders = parseYamlRuleProviders(yaml);
          }
        }
      } catch (e) {
        console.warn("读取 Profile 配置异常:", e);
      }

      // 3. 本地方案规则与规则集
      await rulePlan.reload();
      const plan = rulePlan.plan;
      const planProviders: RuleProviderItem[] = [];
      const planRules: RuleItem[] = [];

      if (plan?.enabled && Array.isArray(plan.providers)) {
        for (const p of plan.providers) {
          planProviders.push({
            name: p.name,
            type: "Http",
            behavior: p.behavior || "classical",
            ruleCount: 0,
            updatedAt: "",
            vehicleType: p.format ? p.format.toUpperCase() : "MRS",
          });
          planRules.push({
            type: "RULE-SET",
            payload: p.name,
            proxy: p.target_proxy || "节点选择",
          });
        }
      }

      // 4. 合成最终展示的规则列表
      let finalRules: RuleItem[] = [];
      if (runtimeRules.length > 0) {
        finalRules = runtimeRules;
        setIsOfflinePreview(false);
      } else if (profileRules.length > 0) {
        setIsOfflinePreview(true);
        const hasRealRules = profileRules.some(
          (r) => !["MATCH", "FINAL"].includes((r.type || "").toUpperCase())
        );
        if (!hasRealRules && plan?.enabled) {
          finalRules = [
            { type: "IP-CIDR", payload: "127.0.0.0/8", proxy: "DIRECT" },
            { type: "IP-CIDR", payload: "10.0.0.0/8", proxy: "DIRECT" },
            { type: "IP-CIDR", payload: "172.16.0.0/12", proxy: "DIRECT" },
            { type: "IP-CIDR", payload: "192.168.0.0/16", proxy: "DIRECT" },
            { type: "IP-CIDR6", payload: "::1/128", proxy: "DIRECT" },
            { type: "IP-CIDR6", payload: "fc00::/7", proxy: "DIRECT" },
            { type: "IP-CIDR6", payload: "fe80::/10", proxy: "DIRECT" },
            ...planRules,
            { type: "GEOSITE", payload: "cn", proxy: "DIRECT" },
            { type: "GEOIP", payload: "CN", proxy: "DIRECT" },
            { type: "MATCH", payload: "全部流量", proxy: "节点选择" },
          ];
        } else {
          finalRules = profileRules;
        }
      } else if (plan?.enabled) {
        setIsOfflinePreview(true);
        finalRules = [
          { type: "IP-CIDR", payload: "127.0.0.0/8", proxy: "DIRECT" },
          { type: "IP-CIDR", payload: "10.0.0.0/8", proxy: "DIRECT" },
          { type: "IP-CIDR", payload: "172.16.0.0/12", proxy: "DIRECT" },
          { type: "IP-CIDR", payload: "192.168.0.0/16", proxy: "DIRECT" },
          { type: "IP-CIDR6", payload: "::1/128", proxy: "DIRECT" },
          { type: "IP-CIDR6", payload: "fc00::/7", proxy: "DIRECT" },
          { type: "IP-CIDR6", payload: "fe80::/10", proxy: "DIRECT" },
          ...planRules,
          { type: "GEOSITE", payload: "cn", proxy: "DIRECT" },
          { type: "GEOIP", payload: "CN", proxy: "DIRECT" },
          { type: "MATCH", payload: "全部流量", proxy: "节点选择" },
        ];
      } else {
        setIsOfflinePreview(!running);
      }

      // 如果启用了直连排除白名单，把白名单项合并展示在最顶层
      const exclusionEntries = splitExclusionInput(exclusions.state.text);
      if (exclusions.state.enabled && exclusionEntries.length > 0) {
        const exclRules: RuleItem[] = exclusionEntries.map((entry) => {
          if (entry.includes("/")) {
            return { type: "IP-CIDR", payload: entry, proxy: "DIRECT" };
          }
          if (entry.startsWith("+.") || entry.startsWith("*.")) {
            return { type: "DOMAIN-SUFFIX", payload: entry.replace(/^[+*]\./, ""), proxy: "DIRECT" };
          }
          return { type: "DOMAIN", payload: entry, proxy: "DIRECT" };
        });
        finalRules = [...exclRules, ...finalRules];
      }

      setRules(finalRules);

      // 5. 合成最终展示的外部规则集列表
      const providerMap = new Map<string, RuleProviderItem>();
      // 优先载入 Profile 中的规则集
      for (const p of profileProviders) {
        providerMap.set(p.name, p);
      }
      // 载入本地方案中的规则集
      for (const p of planProviders) {
        if (!providerMap.has(p.name)) {
          providerMap.set(p.name, p);
        }
      }
      // 载入内核运行时返回的规则集（包含真实 ruleCount 与 updatedAt）
      for (const p of runtimeProviders) {
        providerMap.set(p.name, p);
      }

      // 若依旧为空，则将预设中启用的规则集作为待命列表展示
      if (providerMap.size === 0) {
        for (const preset of PRESET_RULE_PROVIDERS) {
          if (preset.enabledByDefault) {
            providerMap.set(preset.name, {
              name: preset.name,
              type: "Http",
              behavior: preset.behavior,
              ruleCount: 0,
              updatedAt: "",
              vehicleType: preset.format ? preset.format.toUpperCase() : "MRS",
            });
          }
        }
      }

      setProviders(Array.from(providerMap.values()));
    } finally {
      setLoadingRules(false);
    }
  }, [running, exclusions.state.enabled, exclusions.state.text]);

  useEffect(() => {
    void loadAllRules();
    window.addEventListener("netbox-profile-changed", loadAllRules);
    window.addEventListener("procweaver-profile-changed", loadAllRules);
    window.addEventListener("netbox-route-changed", loadAllRules);
    return () => {
      window.removeEventListener("netbox-profile-changed", loadAllRules);
      window.removeEventListener("procweaver-profile-changed", loadAllRules);
      window.removeEventListener("netbox-route-changed", loadAllRules);
    };
  }, [loadAllRules]);

  const [updateFeedback, setUpdateFeedback] = useState<{
    succeeded: number;
    failed: string[];
  } | null>(null);
  const [singleErrors, setSingleErrors] = useState<Record<string, string>>({});
  const [visibleRulesCount, setVisibleRulesCount] = useState(50);
  const [expandedRuleIdx, setExpandedRuleIdx] = useState<number | null>(null);
  const [copiedPayload, setCopiedPayload] = useState<string | null>(null);

  // 更新单个规则集
  const handleUpdateProvider = async (name: string) => {
    if (updatingProvider) return;
    if (!running) {
      alert("VPN 核心未运行，请先在主页开启 VPN 连接，即可与远程同步规则集。");
      return;
    }
    setUpdatingProvider(name);
    try {
      await updateRuleProvider(name);
      setSingleErrors((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      await loadAllRules();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "规则集更新失败";
      setSingleErrors((prev) => ({ ...prev, [name]: msg }));
    } finally {
      setUpdatingProvider(null);
    }
  };

  // 一键更新全部规则集（或重试失败项）
  const handleUpdateAllProviders = async (targetList = providers) => {
    if (updateAllBusy) return;
    if (!running) {
      alert("VPN 核心未运行，请先在主页开启 VPN 连接，即可一键更新全部规则集。");
      return;
    }
    setUpdateAllBusy(true);
    setUpdateFeedback(null);
    let succeeded = 0;
    const failed: string[] = [];
    const nextErrors = { ...singleErrors };

    for (const item of targetList) {
      try {
        await updateRuleProvider(item.name);
        succeeded++;
        delete nextErrors[item.name];
      } catch (e) {
        failed.push(item.name);
        nextErrors[item.name] = e instanceof Error ? e.message : "更新失败";
      }
    }
    setSingleErrors(nextErrors);
    setUpdateFeedback({ succeeded, failed });
    await loadAllRules();
    setUpdateAllBusy(false);
  };

  // 快捷追加排除项
  const handleAppendExclusion = (item: string) => {
    const existing = exclusions.state.text.trim();
    if (!existing.includes(item)) {
      const next = existing ? `${existing}\n${item}` : item;
      exclusions.actions.edit(next);
    }
  };

  // 复制规则内容
  const handleCopyPayload = (payload: string) => {
    if (!payload) return;
    void navigator.clipboard.writeText(payload);
    setCopiedPayload(payload);
    setTimeout(() => setCopiedPayload(null), 2000);
  };

  // 过滤后的规则列表
  const filteredRules = useMemo(() => {
    return rules.filter((r) => {
      if (typeFilter !== "all") {
        const type = (r.type || "").toUpperCase();
        if (typeFilter === "DOMAIN" && !type.includes("DOMAIN")) return false;
        if (typeFilter === "IP" && !type.includes("IP") && !type.includes("GEOIP")) return false;
        if (typeFilter === "RULE-SET" && !type.includes("RULE-SET")) return false;
        if (typeFilter === "MATCH" && !type.includes("MATCH")) return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          (r.payload || "").toLowerCase().includes(q) ||
          (r.proxy || "").toLowerCase().includes(q) ||
          (r.type || "").toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [rules, typeFilter, search]);

  return (
    <div className="space-y-3.5 pb-6">
      {/* 顶部二级分段控制器：简化标签名称 */}
      <div className="flex bg-slate-200/80 dark:bg-slate-900 p-1 rounded-xl text-xs">
        <button
          type="button"
          onClick={() => setSubTab("direct")}
          className={`flex-1 py-1.5 rounded-lg font-semibold transition text-center cursor-pointer ${
            subTab === "direct"
              ? "bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs"
              : "text-slate-600 dark:text-slate-400"
          }`}
        >
          直连
        </button>
        <button
          type="button"
          onClick={() => setSubTab("rules")}
          className={`flex-1 py-1.5 rounded-lg font-semibold transition text-center cursor-pointer ${
            subTab === "rules"
              ? "bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs"
              : "text-slate-600 dark:text-slate-400"
          }`}
        >
          规则 ({rules.length})
        </button>
        <button
          type="button"
          onClick={() => setSubTab("providers")}
          className={`flex-1 py-1.5 rounded-lg font-semibold transition text-center cursor-pointer ${
            subTab === "providers"
              ? "bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs"
              : "text-slate-600 dark:text-slate-400"
          }`}
        >
          规则集 ({providers.length})
        </button>
      </div>

      {/* ================= 视图 1：直连排除 (白名单) ================= */}
      {subTab === "direct" && (
        <section className="space-y-3">
          <div className="mobile-card space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Shield className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200">直连排除列表</h3>
              </div>
              <label className="flex items-center space-x-1.5 text-xs text-slate-600 dark:text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={exclusions.state.enabled}
                  disabled={exclusions.state.saving || exclusions.state.loading}
                  onChange={(e) => exclusions.actions.enable(e.target.checked)}
                  className="rounded text-indigo-600 focus:ring-0"
                />
                <span>启用白名单</span>
              </label>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              匹配以下域名、IP 或网段的流量将强制直连，不受任何代理分流影响。优先级高于应用独立出口和普通分流规则。
            </p>

            {/* 常用预设快捷追加 */}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="text-[11px] text-slate-400">快捷推荐:</span>
              <button
                type="button"
                onClick={() => handleAppendExclusion("192.168.0.0/16\n10.0.0.0/8\n172.16.0.0/12")}
                className="text-[11px] px-2 py-0.5 rounded-md bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition cursor-pointer"
              >
                + 内网私有网段
              </button>
              <button
                type="button"
                onClick={() => handleAppendExclusion("+.qq.com\n+.baidu.com\n+.weixin.qq.com")}
                className="text-[11px] px-2 py-0.5 rounded-md bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition cursor-pointer"
              >
                + 常用国内服务
              </button>
              <button
                type="button"
                onClick={() => handleAppendExclusion("+.apple.com\n+.icloud.com")}
                className="text-[11px] px-2 py-0.5 rounded-md bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition cursor-pointer"
              >
                + Apple 直连
              </button>
            </div>

            {/* 文本输入框 */}
            <div>
              <textarea
                aria-label="直连排除域名与IP列表"
                rows={6}
                value={exclusions.state.text}
                onChange={(e) => exclusions.actions.edit(e.target.value)}
                disabled={exclusions.state.saving || exclusions.state.loading}
                placeholder={"支持换行或空格分隔，例如：\n+.example.com\n*.example.org\n192.168.1.0/24"}
                className="w-full p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 font-mono text-xs text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition leading-relaxed"
              />
            </div>

            {exclusions.state.error && (
              <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
                {exclusions.state.error}
              </p>
            )}
            {exclusions.state.message && (
              <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
                {exclusions.state.message}
              </p>
            )}

            <button
              type="button"
              disabled={exclusions.state.saving || exclusions.state.loading || !exclusions.state.ready}
              onClick={() => void exclusions.actions.save()}
              className="mobile-primary cursor-pointer disabled:opacity-50"
            >
              {exclusions.state.saving ? "正在保存…" : "保存直连排除"}
            </button>
          </div>
        </section>
      )}

      {/* ================= 视图 2：生效分流规则 ================= */}
      {subTab === "rules" && (
        <section className="space-y-3">
          {/* 自动补充规则控制条 */}
          <div className="mobile-card flex items-center justify-between p-3.5">
            <div className="space-y-0.5">
              <div className="flex items-center space-x-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                <span className="text-xs font-bold text-slate-800 dark:text-slate-200">自动补充常用规则</span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                自动补充境内直连与常见境外代理分流基础规则
              </p>
            </div>
            <button
              type="button"
              disabled={rulePlan.saving || !rulePlan.plan}
              onClick={async () => {
                const ok = await rulePlan.toggle();
                if (ok) await loadAllRules();
              }}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer shrink-0 ${
                rulePlan.plan?.enabled
                  ? "bg-indigo-600 text-white shadow-xs"
                  : "bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
              }`}
            >
              {rulePlan.plan?.enabled ? "已开启" : "未开启"}
            </button>
          </div>

          {/* 离线预览与实时状态明确横幅 */}
          {(!running || isOfflinePreview) ? (
            <div className="flex items-center space-x-2 px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 text-[11px] border border-amber-200/60 dark:border-amber-900/40">
              <Sparkles className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span className="flex-1">离线规则预览 · 连接 VPN 后内核将加载并执行这些规则</span>
            </div>
          ) : (
            <div className="flex items-center space-x-2 px-3 py-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 text-[11px] border border-emerald-200/60 dark:border-emerald-900/40">
              <Layers className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              <span className="flex-1">内核实时运行中 · 分流规则链正在实时匹配生效</span>
            </div>
          )}

          {/* 搜索与过滤工具栏 */}
          <div className="space-y-2">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索域名、IP 或出口策略…"
                  className="w-full pl-9 pr-8 py-2 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:text-slate-200 shadow-xs"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="absolute right-2.5 top-2 p-0.5 text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <button
                type="button"
                disabled={loadingRules}
                onClick={() => void loadAllRules()}
                className="p-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:text-slate-900 transition shrink-0 cursor-pointer"
                title="刷新规则"
              >
                <RefreshCw className={`w-4 h-4 ${loadingRules ? "animate-spin text-indigo-500" : ""}`} />
              </button>
            </div>

            {/* 类型过滤芯片 */}
            <div className="flex items-center gap-1 overflow-x-auto py-0.5 select-none">
              {[
                ["all", "全部"],
                ["DOMAIN", "域名"],
                ["IP", "IP / CIDR"],
                ["RULE-SET", "规则集"],
                ["MATCH", "兜底"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setTypeFilter(id);
                    setVisibleRulesCount(50);
                  }}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition shrink-0 cursor-pointer ${
                    typeFilter === id
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-400"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 规则条目列表 */}
          <div className="space-y-2">
            {filteredRules.length === 0 ? (
              <div className="mobile-card text-center p-8 space-y-2">
                <Layers className="w-8 h-8 text-slate-400 mx-auto" />
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {search ? "没有找到匹配的规则" : "暂无分流规则"}
                </p>
                <p className="text-[11px] text-slate-400 max-w-xs mx-auto">
                  可开启上方的“自动补充常用规则”，或在订阅管理中导入配置。
                </p>
              </div>
            ) : (
              filteredRules.slice(0, visibleRulesCount).map((rule, idx) => {
                const isDirect = rule.proxy === "DIRECT";
                const isReject = rule.proxy === "REJECT";
                const isExpanded = expandedRuleIdx === idx;
                return (
                  <div
                    key={`${rule.type}-${rule.payload}-${idx}`}
                    onClick={() => setExpandedRuleIdx(isExpanded ? null : idx)}
                    className="p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/80 space-y-1.5 shadow-2xs cursor-pointer transition active:scale-[0.99]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center space-x-2 min-w-0 flex-1">
                        <span className="text-[10px] font-mono text-slate-400 shrink-0">#{idx + 1}</span>
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-mono shrink-0">
                          {rule.type}
                        </span>
                        <span className="text-xs font-mono text-slate-800 dark:text-slate-200 truncate" title={rule.payload}>
                          {rule.payload || "—"}
                        </span>
                      </div>
                      <div className="flex items-center space-x-1 shrink-0">
                        <ArrowRight className="w-3 h-3 text-slate-400" />
                        <span
                          className={`text-[11px] font-bold px-2 py-0.5 rounded-md ${
                            isDirect
                              ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                              : isReject
                              ? "bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border border-rose-500/20"
                              : "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20"
                          }`}
                        >
                          {rule.proxy}
                        </span>
                      </div>
                    </div>

                    {/* 点击展开详情与快捷复制 */}
                    {isExpanded && (
                      <div className="pt-2 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-[11px] text-slate-500">
                        <span className="truncate pr-2 font-mono">匹配规则：{rule.type} · {rule.payload || "全部"}</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyPayload(rule.payload);
                          }}
                          className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 font-semibold text-[10px] shrink-0"
                        >
                          {copiedPayload === rule.payload ? "已复制" : "复制"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {/* 加载更多控件 */}
            {filteredRules.length > visibleRulesCount && (
              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={() => setVisibleRulesCount((prev) => prev + 50)}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-indigo-600 dark:text-indigo-400 font-semibold text-xs transition cursor-pointer shadow-2xs"
                >
                  加载更多规则（剩余 {filteredRules.length - visibleRulesCount} 条）
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ================= 视图 3：外部规则集 ================= */}
      {subTab === "providers" && (
        <section className="space-y-3">
          {/* 更新反馈横幅 */}
          {updateFeedback && (
            <div
              className={`p-3 rounded-2xl border text-xs flex items-center justify-between gap-2 ${
                updateFeedback.failed.length === 0
                  ? "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 text-emerald-700 dark:text-emerald-300"
                  : "bg-amber-50 dark:bg-amber-950/40 border-amber-200 text-amber-800 dark:text-amber-200"
              }`}
            >
              <div className="space-y-0.5">
                <div className="font-bold">
                  {updateFeedback.failed.length === 0 ? "全部规则集更新完成" : "部分规则集更新失败"}
                </div>
                <div className="text-[11px] opacity-80">
                  成功: {updateFeedback.succeeded} 个 · 失败: {updateFeedback.failed.length} 个
                  {updateFeedback.failed.length > 0 && ` (${updateFeedback.failed.join(", ")})`}
                </div>
              </div>
              {updateFeedback.failed.length > 0 && (
                <button
                  type="button"
                  disabled={updateAllBusy}
                  onClick={() => {
                    const failList = providers.filter((p) => updateFeedback.failed.includes(p.name));
                    void handleUpdateAllProviders(failList);
                  }}
                  className="px-2.5 py-1 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-semibold text-xs shadow-xs cursor-pointer shrink-0"
                >
                  重试失败项
                </button>
              )}
            </div>
          )}

          <div className="flex items-center justify-between px-1">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              共 {providers.length} 个规则集 {!running && <span className="text-[10px] text-amber-500">(离线配置就绪)</span>}
            </span>
            <button
              type="button"
              disabled={updateAllBusy || providers.length === 0}
              onClick={() => void handleUpdateAllProviders()}
              className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 flex items-center space-x-1 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${updateAllBusy ? "animate-spin" : ""}`} />
              <span>{updateAllBusy ? "正在更新全部…" : "全部更新"}</span>
            </button>
          </div>

          {providers.length === 0 ? (
            <div className="mobile-card text-center p-8 space-y-2">
              <Database className="w-8 h-8 text-slate-400 mx-auto" />
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                暂未配置外部规则集
              </p>
              <p className="text-[11px] text-slate-400 max-w-xs mx-auto">
                外部规则集（Rule Provider）由订阅或本地方案定义。
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {providers.map((item) => {
                const name = item.name;
                const isUpdating = updatingProvider === name;
                const errorMsg = singleErrors[name];
                return (
                  <div
                    key={name}
                    className={`p-3.5 rounded-xl bg-white dark:bg-slate-900 border space-y-2 shadow-2xs transition ${
                      errorMsg ? "border-rose-300 dark:border-rose-900/60" : "border-slate-200/80 dark:border-slate-800"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <Database className="w-4 h-4 text-indigo-500" />
                        <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200">{name}</h4>
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 font-mono">
                        {item.behavior || item.vehicleType || "RuleSet"}
                      </span>
                    </div>

                    {errorMsg && (
                      <div className="p-2 rounded-lg bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 text-[11px]">
                        更新失败: {errorMsg}
                      </div>
                    )}

                    <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-100 dark:border-slate-800/60">
                      <span>
                        规则条数：
                        <strong className="text-slate-700 dark:text-slate-300">
                          {item.ruleCount > 0 ? `${item.ruleCount} 条` : "待连接加载"}
                        </strong>
                      </span>
                      <button
                        type="button"
                        disabled={isUpdating}
                        onClick={() => void handleUpdateProvider(name)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center space-x-1 cursor-pointer disabled:opacity-50 ${
                          errorMsg
                            ? "bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300"
                            : "bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-indigo-600 dark:text-indigo-400"
                        }`}
                      >
                        <RefreshCw className={`w-3 h-3 ${isUpdating ? "animate-spin" : ""}`} />
                        <span>{isUpdating ? "更新中…" : errorMsg ? "重试更新" : "更新"}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
