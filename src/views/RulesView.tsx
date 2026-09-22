import React, { useState, useEffect, useMemo } from "react";
import { useLocalRulePlan } from "../hooks/useLocalRulePlan";
import { useExclusions } from "../hooks/useExclusions";
import { ExclusionsPanel } from "../components/ExclusionsPanel";
import PRESET_RULE_PROVIDERS from "../data/localRulePresets.json";
import { RuleItem, RuleProviderItem, RuleMatchResult, ProxyGroup } from "../types";
import type { CoreMode, CoreModeState } from "../utils/coreModeController";
import {
  fetchRules,
  fetchRuleProviders,
  updateRuleProvider,
  addExternalRuleProvider,
  removeExternalRuleProvider,
  fetchProxies,
  switchProxy,
} from "../api/mihomo";
import {
  Layers,
  Search,
  RefreshCw,
  Filter,
  Globe,
  Database,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Play,
  CheckCircle2,
  Copy,
  Check,
  Server,
  Network,
  RotateCw,
  Plus,
  Trash2,
  Shield,
  Sparkles,
  Tv,
  X,
  AlertCircle,
} from "lucide-react";

// IP 检查与 CIDR 匹配简易引擎
function isIpv4(str: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(str);
}

function ipToLong(ip: string): number {
  return ip.split(".").reduce((acc, octet) => ((acc << 8) + parseInt(octet, 10)) >>> 0, 0);
}

function matchIpv4Cidr(ip: string, cidr: string): boolean {
  try {
    const [range, bitsStr] = cidr.split("/");
    const bits = bitsStr !== undefined ? parseInt(bitsStr, 10) : 32;
    if (!isIpv4(range)) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipToLong(ip) & mask) === (ipToLong(range) & mask);
  } catch {
    return false;
  }
}

// 知名互联网服务与特征域名集字典 (覆盖各大主流云端规则集)
const KNOWN_SERVICE_DOMAINS: Record<string, string[]> = {
  google: [
    "google.com", "google.cn", "googleapis.com", "gstatic.com", "googleusercontent.com",
    "googlevideo.com", "google.com.hk", "google.co.jp", "google.com.tw", "googleblog.com",
    "googleplay.com", "ggpht.com", "1e100.net", "android.com", "recaptcha.net", "gmail.com",
    "chrome.com", "g.co", "goo.gl", "appspot.com", "doubleclick.net"
  ],
  youtube: [
    "youtube.com", "youtu.be", "ytimg.com", "googlevideo.com", "yt.be", "youtubekids.com"
  ],
  github: [
    "github.com", "githubassets.com", "githubusercontent.com", "ghcr.io", "github.io", "git.io", "github.community"
  ],
  openai: [
    "openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com", "ai.com", "anthropic.com", "claude.ai"
  ],
  telegram: [
    "telegram.org", "t.me", "telegra.ph", "telegram.me", "tdesktop.com", "telesco.pe"
  ],
  twitter: [
    "twitter.com", "x.com", "twimg.com", "t.co", "tweetdeck.com"
  ],
  bilibili: [
    "bilibili.com", "biliapi.net", "hdslb.com", "bilivideo.com", "bilibili.tv", "biliapi.com"
  ],
  netflix: [
    "netflix.com", "nflxvideo.net", "nflxext.com", "nflxso.net", "nflximg.net", "netflix.net"
  ],
  spotify: [
    "spotify.com", "scdn.co", "spoti.fi", "spotifycdn.com"
  ],
  steam: [
    "steampowered.com", "steamcommunity.com", "steamgames.com", "steamstatic.com", "steamcontent.com"
  ],
  apple: [
    "apple.com", "icloud.com", "mzstatic.com", "aaplimg.com", "apple-dns.net", "itunes.com"
  ],
  microsoft: [
    "microsoft.com", "windows.com", "live.com", "office.com", "azure.com", "bing.com", "msn.com",
    "onedrive.com", "sharepoint.com", "outlook.com", "skype.com", "visualstudio.com"
  ],
  discord: [
    "discord.com", "discord.gg", "discordapp.com", "discordapp.net", "discordstatus.com"
  ],
  amazon: [
    "amazon.com", "amazon.cn", "aws.amazon.com", "amazonaws.com", "media-amazon.com", "primevideo.com"
  ],
  facebook: [
    "facebook.com", "fbcdn.net", "instagram.com", "whatsapp.com", "messenger.com"
  ],
};

// 常见中国顶级与大厂域名特征
const DOMESTIC_DOMAINS = [
  "baidu.com", "qq.com", "tencent.com", "taobao.com", "alipay.com", "jd.com",
  "163.com", "126.com", "sina.com", "weibo.com", "zhihu.com", "douyin.com",
  "bytedance.com", "xiaomi.com", "aliyun.com", "tencentcloud.com", "bilibili.com"
];

// 常见中国公共 DNS / 知名 IP
const DOMESTIC_IPS = [
  "114.114.114.114", "114.114.115.115", "223.5.5.5", "223.6.6.6",
  "119.29.29.29", "182.254.116.116", "180.76.76.76", "1.2.4.8"
];

// 提取域名的主要标识 Token (例如从 google.com, mail.google.com, google.cn 提取出 "google")
function extractDomainToken(host: string): string {
  const clean = host.toLowerCase().trim();
  const parts = clean.split(".");
  if (parts.length <= 1) return clean;
  // 处理常见的二级后缀 (如 .com.cn, .co.jp, .com.hk, .org.cn)
  if (parts.length >= 3) {
    const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (["com.cn", "net.cn", "org.cn", "gov.cn", "co.jp", "com.hk", "co.uk"].includes(lastTwo)) {
      return parts[parts.length - 3] || parts[0];
    }
  }
  // 常规一级后缀 (如 google.com -> google)
  return parts[parts.length - 2] || parts[0];
}

// 检查域名或 IP 是否匹配指定的 RuleSet / GeoSite
function checkRuleSetOrGeositeMatch(
  host: string,
  payload: string
): { matched: boolean; detail?: string } {
  const normPayload = (payload || "").toLowerCase().trim();
  const payloadTokens = normPayload.split(/[-_.]+/).filter(Boolean);
  const domainToken = extractDomainToken(host);

  // 1. 特例处理：google-cn 与普通 google
  const isGoogleCnRule = normPayload.includes("google") && (normPayload.includes("cn") || normPayload.includes("china"));
  const isHostGoogleCn = host === "google.cn" || host.endsWith(".google.cn") || host.includes("google.com.cn");

  if (isGoogleCnRule) {
    if (isHostGoogleCn) {
      return { matched: true, detail: "命中 Google 针对中国大陆区域专属域名规则集" };
    }
    // 若不是 .google.cn，则不命中 google-cn 规则集，留待后续普通的 google 规则集命中
    return { matched: false };
  }

  // 2. 检查知名服务映射
  for (const [key, domainList] of Object.entries(KNOWN_SERVICE_DOMAINS)) {
    if (payloadTokens.includes(key) || normPayload.startsWith(key)) {
      // 如果 host 直接在列表中，或者以列表中的域名结尾
      const hit = domainList.some((d) => host === d || host.endsWith("." + d));
      if (hit) {
        return { matched: true, detail: `目标属于 [${key}] 服务生态，命中专属规则集` };
      }
    }
  }

  // 3. 通用二级主域名启发式匹配 (例如 openai_domain 匹配 chatgpt.com / openai.com, facebook 匹配 facebook.com)
  if (domainToken && payloadTokens.includes(domainToken)) {
    return { matched: true, detail: `目标主域名 [${domainToken}] 与规则集特征完全吻合` };
  }

  // 4. 国内域名集与直连白名单规则集 (如 cn, china, domestic, direct, mainland)
  const isCnRule = payloadTokens.some((t) => ["cn", "china", "domestic", "mainland"].includes(t));
  if (isCnRule) {
    const isCnSuffix = host.endsWith(".cn") || host.endsWith(".com.cn");
    const isDomestic = DOMESTIC_DOMAINS.some((d) => host === d || host.endsWith("." + d));
    if (isCnSuffix || isDomestic) {
      return { matched: true, detail: "目标域名属于中国大陆境内网站白名单" };
    }
  }

  // 5. 海外常用代理与 GFW 规则集 (如 gfw, proxy, greatfire, foreign)
  const isGfwRule = payloadTokens.some((t) => ["gfw", "proxy", "greatfire", "foreign"].includes(t)) || normPayload.includes("!cn");
  if (isGfwRule) {
    // 凡是知名海外服务，均属于被代理或 GFW 清单范畴
    for (const domainList of Object.values(KNOWN_SERVICE_DOMAINS)) {
      if (domainList.some((d) => host === d || host.endsWith("." + d))) {
        return { matched: true, detail: "目标域名属于常用海外代理分流规则集" };
      }
    }
  }

  return { matched: false };
}

export const RulesView: React.FC<{ coreMode: CoreModeState & { refresh: () => Promise<void>; change: (mode: CoreMode) => Promise<boolean> } }> = ({ coreMode }) => {
  const exclusions = useExclusions();
  const [rules, setRules] = useState<RuleItem[]>([]);
  const [providers, setProviders] = useState<RuleProviderItem[]>([]);
  const config = { mode: coreMode.mode };
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"rules" | "providers">("rules");

  // 搜索与过滤
  const [keyword, setKeyword] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [proxyFilter, setProxyFilter] = useState<string>("ALL");

  // 分页状态
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // 模拟测试
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<RuleMatchResult | null>(null);
  const [copiedPayload, setCopiedPayload] = useState<string | null>(null);
  const [updatingProvider, setUpdatingProvider] = useState<string | null>(null);
  const [operatingProvider, setOperatingProvider] = useState<string | null>(null);
  const [providerToast, setProviderToast] = useState<{ text: string; isError?: boolean } | null>(null);

  // 自定义添加规则集弹窗状态
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const { plan: localPlan, saving: savingPlan, error: planError, reload: reloadLocalPlan, toggle: toggleLocalPlan } = useLocalRulePlan();
  const handlePlanToggle = async () => {
    if (await toggleLocalPlan()) await loadData();
  };
  const [customName, setCustomName] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customBehavior, setCustomBehavior] = useState<"domain" | "classical" | "ipcidr">("domain");
  const [customFormat, setCustomFormat] = useState("auto");
  const [customTarget, setCustomTarget] = useState<string>("PROXY");

  // 广告与恶意网站拦截策略组状态
  const [adBlockGroup, setAdBlockGroup] = useState<ProxyGroup | null>(null);
  const [togglingAdBlock, setTogglingAdBlock] = useState(false);

  const showProviderToast = (text: string, isError = false) => {
    setProviderToast({ text, isError });
    setTimeout(() => {
      setProviderToast((prev) => (prev?.text === text ? null : prev));
    }, 3500);
  };

  const loadData = async () => {
    setLoading(true);
    try {
      await reloadLocalPlan();
      const [rulesData, , providersData, proxiesData] = await Promise.all([
        fetchRules(),
        coreMode.refresh(),
        fetchRuleProviders(),
        fetchProxies().catch(() => null),
      ]);
      setRules(rulesData);
      setProviders(providersData);
      if (proxiesData?.groups) {
        const found = proxiesData.groups.find(
          (g) => g.name.includes("Reject") || g.name.includes("广告") || g.name.includes("拦截")
        );
        setAdBlockGroup(found || null);
      }
    } catch (e) {
      console.error("加载规则分流数据失败", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // 切换广告与恶意网站拦截开关
  const handleToggleAdBlock = async () => {
    if (!adBlockGroup) return;
    setTogglingAdBlock(true);
    try {
      const isCurrentlyReject = adBlockGroup.now === "REJECT";
      let target = "";
      if (isCurrentlyReject) {
        target =
          adBlockGroup.all.find((p) => p.includes("直连") || p === "DIRECT") || "DIRECT";
      } else {
        target = adBlockGroup.all.find((p) => p === "REJECT") || "REJECT";
      }
      const ok = await switchProxy(adBlockGroup.name, target);
      if (ok) {
        setAdBlockGroup((prev) => (prev ? { ...prev, now: target } : null));
        showProviderToast(
          isCurrentlyReject
            ? "已停用广告拦截（直连放行，避免误杀与Cloudflare验证盾）"
            : "已开启广告拦截（强制拦截 REJECT）"
        );
      }
      setTimeout(loadData, 500);
    } catch (err: any) {
      showProviderToast(`切换失败: ${err?.message || err}`, true);
    } finally {
      setTogglingAdBlock(false);
    }
  };

  // 一键快速启用或禁用预置规则集
  const handleTogglePreset = async (preset: typeof PRESET_RULE_PROVIDERS[0]) => {
    const isInstalled = localPlan?.providers.some((p) => p.name === preset.name);
    setOperatingProvider(preset.name);
    try {
      if (isInstalled) {
        await removeExternalRuleProvider(preset.name);
        showProviderToast(`已停用并移除 [${preset.title}]`);
      } else {
        await addExternalRuleProvider({
          name: preset.name,
          url: preset.url,
          behavior: preset.behavior,
          format: preset.format,
          target_proxy: preset.target_proxy,
        });
        showProviderToast(`已保存 [${preset.title}] 到本地方案；订阅缺少规则时自动使用`);
      }
      setTimeout(loadData, 600);
      setTimeout(loadData, 2000);
    } catch (err: any) {
      showProviderToast(`操作失败: ${err?.message || err}`, true);
    } finally {
      setOperatingProvider(null);
    }
  };

  // 添加自定义规则集
  const handleAddCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = customName.trim();
    const url = customUrl.trim();
    if (!name || !url) return;

    setOperatingProvider(name);
    try {
      await addExternalRuleProvider({
        name,
        url,
        behavior: customBehavior,
        format: customFormat === "auto" ? undefined : customFormat,
        target_proxy: customTarget,
      });
      showProviderToast(`已成功添加外部规则集 [${name}]！`);
      setIsAddModalOpen(false);
      setCustomName("");
      setCustomUrl("");
      setTimeout(loadData, 600);
    } catch (err: any) {
      showProviderToast(`添加失败: ${err?.message || err}`, true);
    } finally {
      setOperatingProvider(null);
    }
  };

  // 移除指定规则集
  const handleRemoveProvider = async (name: string) => {
    setOperatingProvider(name);
    try {
      await removeExternalRuleProvider(name);
      showProviderToast(`已移除规则集 [${name}]`);
      setTimeout(loadData, 600);
    } catch (err: any) {
      showProviderToast(`移除失败: ${err?.message || err}`, true);
    } finally {
      setOperatingProvider(null);
    }
  };

  // 模式切换
  const handleModeChange = async (mode: "rule" | "global" | "direct") => {
    setLoading(true);
    try {
      await coreMode.change(mode);
    } finally {
      setLoading(false);
    }
  };

  // 规则分类统计
  const metrics = useMemo(() => {
    let directDomainCount = 0;
    let ipCount = 0;
    let geoCount = 0;
    let ruleSetCount = 0;
    let otherCount = 0;
    const proxyMap = new Set<string>();

    rules.forEach((r) => {
      const upper = (r.type || "").toUpperCase();
      if (upper.includes("DOMAIN")) {
        directDomainCount++;
      } else if (upper.includes("IP-CIDR") || upper.includes("IPCIDR")) {
        ipCount++;
      } else if (upper.includes("GEO")) {
        geoCount++;
      } else if (upper.includes("RULE-SET") || upper.includes("RULESET")) {
        ruleSetCount++;
      } else {
        otherCount++;
      }
      if (r.proxy) {
        proxyMap.add(r.proxy);
      }
    });

    // 统计外部规则集中的域名规则数与规则集个数
    let domainProviderCount = 0;
    let providerDomainRules = 0;
    providers.forEach((p) => {
      const b = (p.behavior || "").toLowerCase();
      if (b === "domain" || b === "classical") {
        domainProviderCount++;
        providerDomainRules += p.ruleCount || 0;
      }
    });

    return {
      total: rules.length,
      directDomainCount,
      domainProviderCount,
      providerDomainRules,
      ipCount,
      geoCount,
      ruleSetCount,
      otherCount,
      uniqueProxies: Array.from(proxyMap),
    };
  }, [rules, providers]);

  // 复合过滤
  const filteredRules = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return rules.filter((r) => {
      // 类型过滤
      if (typeFilter !== "ALL") {
        const t = (r.type || "").toUpperCase();
        if (typeFilter === "DOMAIN") {
          // 若为 DOMAIN 过滤，包含直属 DOMAIN、GEOSITE 以及域名/经典类外部规则集
          const isDirect = t.includes("DOMAIN");
          const isGeosite = t.includes("GEOSITE");
          const isDomainSet =
            (t.includes("RULE-SET") || t.includes("RULESET")) &&
            providers.some(
              (p) =>
                p.name === r.payload &&
                ((p.behavior || "").toLowerCase() === "domain" ||
                  (p.behavior || "").toLowerCase() === "classical")
            );
          if (!isDirect && !isGeosite && !isDomainSet) return false;
        }
        if (
          typeFilter === "IP" &&
          !t.includes("IP-CIDR") &&
          !t.includes("IPCIDR") &&
          !t.includes("GEOIP")
        )
          return false;
        if (typeFilter === "GEO" && !t.includes("GEO")) return false;
        if (typeFilter === "MATCH" && t !== "MATCH") return false;
        if (typeFilter === "RULE-SET" && !t.includes("RULE-SET") && !t.includes("RULESET"))
          return false;
      }

      // 目标出站过滤
      if (proxyFilter !== "ALL" && r.proxy !== proxyFilter) {
        return false;
      }

      // 关键词搜索
      if (kw) {
        return (
          r.type.toLowerCase().includes(kw) ||
          r.payload.toLowerCase().includes(kw) ||
          r.proxy.toLowerCase().includes(kw)
        );
      }

      return true;
    });
  }, [rules, keyword, typeFilter, proxyFilter, providers]);

  // 分页数据切片
  const totalPages = Math.max(1, Math.ceil(filteredRules.length / pageSize));
  const paginatedRules = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredRules.slice(start, start + pageSize);
  }, [filteredRules, currentPage, pageSize]);

  // 切换过滤条件时回到第一页
  useEffect(() => {
    setCurrentPage(1);
  }, [keyword, typeFilter, proxyFilter, pageSize]);

  // 运行分流命中模拟器测试
  const handleSimulate = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const raw = testInput.trim();
    if (!raw) {
      setTestResult(null);
      return;
    }

    const currentMode = config.mode;
    if (!currentMode) {
      setTestResult(null);
      return;
    }

    // 1. 全局代理模式：所有流量一律强制走全局代理出站，绕过规则列表
    if (currentMode === "global") {
      return setTestResult({
        matchedIndex: 0,
        rule: { type: "GLOBAL", payload: "全局代理接管", proxy: "GLOBAL" },
        targetType: "PROXY",
        explanation: "内核当前运行于【全局代理 (Global)】模式，所有域名与 IP 绕过分流规则库，强制由全局出站代理节点转发。",
      });
    }

    // 2. 完全直连模式：所有流量一律强制直连出站，绕过规则列表与代理节点
    if (currentMode === "direct") {
      return setTestResult({
        matchedIndex: 0,
        rule: { type: "DIRECT", payload: "完全直连绕过", proxy: "DIRECT" },
        targetType: "DIRECT",
        explanation: "内核当前运行于【完全直连 (Direct)】模式，所有域名与 IP 绕过代理与分流，100% 走本地直连出站，不消耗节点流量。",
      });
    }

    if (rules.length === 0) {
      setTestResult(null);
      return;
    }

    // 净化输入（移除协议头和末尾路径与端口）
    const address = raw.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase().trim();
    if (address.startsWith("[") || (address.match(/:/g)?.length ?? 0) > 1) {
      return setTestResult({ matchedIndex: -1, rule: { type: "NONE", payload: "IPv6", proxy: "" },
        targetType: "PROXY", explanation: "IPv6 排除规则由内核处理；此页面模拟器暂不支持 IPv6 匹配，请以实际连接结果为准。" });
    }
    const host = address.split(":")[0];

    const applyMatchResult = (result: RuleMatchResult) => {
      setTestResult(result);
      if (result.matchedIndex > 0) {
        setActiveTab("rules");
        setKeyword("");
        setTypeFilter("ALL");
        setProxyFilter("ALL");
        const targetPage = Math.ceil(result.matchedIndex / pageSize);
        setCurrentPage(targetPage);
        setTimeout(() => {
          const el = document.getElementById(`rule-row-${result.matchedIndex}`);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }, 150);
      }
    };

    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      // 统一归一化处理类型字符串，去除连字符和下划线
      // 例如 DomainSuffix -> DOMAINSUFFIX, DOMAIN-SUFFIX -> DOMAINSUFFIX
      const normType = (r.type || "").toUpperCase().replace(/[-_]/g, "");
      const payload = (r.payload || "").toLowerCase().trim();

      // 1. DOMAIN 完全匹配
      if (normType === "DOMAIN" && host === payload) {
        return applyMatchResult({
          matchedIndex: i + 1,
          rule: r,
          targetType: getTargetType(r.proxy),
          explanation: `目标域名完全匹配规则 [${r.payload}]`,
        });
      }

      // 2. DOMAIN-SUFFIX / DOMAINSUFFIX 后缀匹配
      if (normType === "DOMAINSUFFIX" || normType === "DOMAINSIGN") {
        if (host === payload || host.endsWith("." + payload)) {
          return applyMatchResult({
            matchedIndex: i + 1,
            rule: r,
            targetType: getTargetType(r.proxy),
            explanation: `目标域名命中后缀匹配规则 [*.${r.payload}]`,
          });
        }
      }

      if (normType === "DOMAINWILDCARD") {
        const pattern = payload.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
        if (new RegExp(`^${pattern}$`).test(host)) {
          return applyMatchResult({
            matchedIndex: i + 1,
            rule: r,
            targetType: getTargetType(r.proxy),
            explanation: `目标域名命中通配规则 [${r.payload}]`,
          });
        }
      }

      // 3. DOMAIN-KEYWORD / DOMAINKEYWORD 关键字匹配
      if (normType === "DOMAINKEYWORD") {
        if (host.includes(payload)) {
          return applyMatchResult({
            matchedIndex: i + 1,
            rule: r,
            targetType: getTargetType(r.proxy),
            explanation: `目标域名命中包含关键词 [${r.payload}]`,
          });
        }
      }

      // 4. IP-CIDR 网段匹配
      if ((normType === "IPCIDR" || normType === "IPCIDR6") && isIpv4(host)) {
        if (matchIpv4Cidr(host, r.payload)) {
          return applyMatchResult({
            matchedIndex: i + 1,
            rule: r,
            targetType: getTargetType(r.proxy),
            explanation: `目标 IP 命中网段范围 [${r.payload}]`,
          });
        }
      }

      // 5. RULE-SET / RULESET / GEOSITE 外部规则集与域名库匹配
      if (normType === "RULESET" || normType === "GEOSITE") {
        const check = checkRuleSetOrGeositeMatch(host, r.payload);
        if (check.matched) {
          const provider = providers.find(
            (p) => p.name.toLowerCase() === r.payload.toLowerCase()
          );
          const countInfo = provider?.ruleCount ? `包含 ${provider.ruleCount} 条规则` : "域名集";
          return applyMatchResult({
            matchedIndex: i + 1,
            rule: r,
            targetType: getTargetType(r.proxy),
            explanation: `目标域名 [${host}] 命中外部规则集 [${r.payload}] (${countInfo})${check.detail ? ` · ${check.detail}` : ""}`,
          });
        }
      }

      // 6. GEOIP 区域 IP 匹配
      if (normType === "GEOIP" || normType === "GEO-IP") {
        const country = payload.toUpperCase();
        if (
          country === "CN" &&
          (DOMESTIC_IPS.includes(host) ||
            host.startsWith("192.168.") ||
            host.startsWith("10.") ||
            host.startsWith("127."))
        ) {
          return applyMatchResult({
            matchedIndex: i + 1,
            rule: r,
            targetType: getTargetType(r.proxy),
            explanation: `目标 IP [${host}] 识别为中国大陆境内地址，命中 GEOIP 规则 [${r.payload}]`,
          });
        }
      }

      // 7. PROCESS-NAME 进程分流匹配
      if (normType === "PROCESSNAME") {
        if (
          host.toLowerCase() === payload.toLowerCase() ||
          host.toLowerCase().endsWith(`\\${payload.toLowerCase()}`)
        ) {
          return applyMatchResult({
            matchedIndex: i + 1,
            rule: r,
            targetType: getTargetType(r.proxy),
            explanation: `命中系统进程规则 [${r.payload}]`,
          });
        }
      }

      // 8. MATCH 兜底规则
      if (normType === "MATCH") {
        return applyMatchResult({
          matchedIndex: i + 1,
          rule: r,
          targetType: getTargetType(r.proxy),
          explanation: `未匹配到前面的专属域名或 IP 规则，命中默认兜底规则 (MATCH)`,
        });
      }
    }

    // 若全部规则均未命中兜底
    applyMatchResult({
      matchedIndex: -1,
      rule: { type: "NONE", payload: "无匹配", proxy: "DIRECT" },
      targetType: "DIRECT",
      explanation: "未匹配到任何显式规则，默认走 DIRECT 直连",
    });
  };

  const getTargetType = (target: string): "DIRECT" | "REJECT" | "PROXY" => {
    const t = (target || "").toUpperCase();
    // 如果目标是广告拦截策略组，根据其当前选中的节点动态判定 (默认直连放行即停用)
    if (adBlockGroup && (adBlockGroup.name === target || t.includes("REJECT") || t.includes("广告") || t.includes("拦截"))) {
      if (adBlockGroup.now === "DIRECT" || adBlockGroup.now.includes("直连")) {
        return "DIRECT";
      }
      if (adBlockGroup.now === "REJECT") {
        return "REJECT";
      }
    }
    if (t === "DIRECT" || t.includes("直连")) return "DIRECT";
    if (t === "REJECT") return "REJECT";
    return "PROXY";
  };

  const getTargetBadge = (target: string) => {
    const type = getTargetType(target);
    if (type === "DIRECT") {
      return "text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
    }
    if (type === "REJECT") {
      return "text-rose-400 bg-rose-500/10 border-rose-500/30";
    }
    return "text-indigo-400 bg-indigo-500/10 border-indigo-500/30";
  };

  const copyText = (txt: string) => {
    navigator.clipboard.writeText(txt);
    setCopiedPayload(txt);
    setTimeout(() => setCopiedPayload(null), 1500);
  };

  const handleUpdateProvider = async (name: string) => {
    setUpdatingProvider(name);
    try {
      await updateRuleProvider(name);
      await loadData();
    } finally {
      setUpdatingProvider(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* 顶部标题与路由分流模式切换 */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white tracking-wide flex items-center gap-2.5">
            <div className="p-1.5 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-600 dark:bg-indigo-500/10 dark:border-indigo-500/30 dark:text-indigo-400">
              <Layers className="w-5 h-5" />
            </div>
            <span>分流规则与路由</span>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 font-mono border border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700">
              {metrics.total} 条生效规则
            </span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            当前内核正在生效的智能分流引擎，支持域名精确匹配、规则集与网段策略路由
          </p>
        </div>

        {/* 右侧操作区：自动补充方案开关 + 模式选择器 + 刷新 */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* 自动补充规则集胶囊按钮 */}
          <button
            onClick={handlePlanToggle}
            disabled={!localPlan || savingPlan}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition disabled:opacity-50 ${
              localPlan?.enabled
                ? "bg-indigo-50 hover:bg-indigo-100 text-indigo-600 border-indigo-200 shadow-sm dark:bg-indigo-600/20 dark:hover:bg-indigo-600/30 dark:text-indigo-300 dark:border-indigo-500/40"
                : "bg-white hover:bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-900 dark:hover:bg-slate-800 dark:text-slate-400 dark:border-slate-800"
            }`}
            title="当订阅缺少精细分流规则时，自动注入30+开源高质量规则集与GEOSITE"
          >
            <Sparkles className={`w-3.5 h-3.5 ${localPlan?.enabled ? "text-indigo-600 dark:text-indigo-400" : "text-slate-400 dark:text-slate-500"}`} />
            <span>{savingPlan ? "正在保存..." : localPlan?.enabled ? "自动补充规则: 已开启" : "自动补充规则: 已停用"}</span>
          </button>

          {/* 模式选择分段器 */}
          <div className="bg-slate-100 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800/90 p-1 rounded-xl flex items-center shadow-inner transition-colors">
            <button
              onClick={() => handleModeChange("rule")}
              disabled={coreMode.busy || !coreMode.mode}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 ${
                config?.mode?.toLowerCase() === "rule"
                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-500/20"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
              }`}
            >
              <Network className="w-3.5 h-3.5" />
              <span>规则分流</span>
            </button>
            <button
              onClick={() => handleModeChange("global")}
              disabled={coreMode.busy || !coreMode.mode}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 ${
                config?.mode?.toLowerCase() === "global"
                  ? "bg-amber-600 text-white shadow-md shadow-amber-500/20"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
              }`}
            >
              <Globe className="w-3.5 h-3.5" />
              <span>全局代理</span>
            </button>
            <button
              onClick={() => handleModeChange("direct")}
              disabled={coreMode.busy || !coreMode.mode}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 ${
                config?.mode?.toLowerCase() === "direct"
                  ? "bg-emerald-600 text-white shadow-md shadow-emerald-500/20"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
              }`}
            >
              <ArrowRight className="w-3.5 h-3.5" />
              <span>完全直连</span>
            </button>
          </div>

          {/* 刷新按钮 */}
          <button
            onClick={loadData}
            disabled={loading}
            title="刷新规则与配置"
            className="p-2 rounded-xl bg-white hover:bg-slate-50 text-slate-600 hover:text-slate-900 border border-slate-200 dark:bg-slate-900 dark:border-slate-800 dark:hover:bg-slate-800 dark:text-slate-400 dark:hover:text-white transition shadow-sm"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin text-indigo-500 dark:text-indigo-400" : ""}`} />
          </button>
        </div>
      </div>

      <ExclusionsPanel state={exclusions.state} actions={{ ...exclusions.actions, save: async () => {
        if (await exclusions.actions.save()) await loadData();
      } }} />

      {coreMode.error && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{coreMode.error}</p>}
      {planError && (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-600 dark:text-rose-300 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-500 dark:text-rose-400 shrink-0" />
          <span>{planError}</span>
        </div>
      )}

      {/* 模式激活状态横幅 */}
      {config?.mode?.toLowerCase() === "global" && (
        <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between text-xs text-amber-800 dark:text-amber-300 shadow-sm dark:shadow-lg dark:shadow-amber-950/20">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-600 dark:text-amber-400 shrink-0">
              <Globe className="w-4 h-4" />
            </div>
            <div>
              <div className="font-bold text-amber-900 dark:text-amber-200 text-sm flex items-center gap-1.5">
                全局代理模式已激活 (Global Mode)
              </div>
              <p className="text-[11px] text-amber-700/90 dark:text-amber-300/80 mt-0.5">
                所有网络连接强制经由全局代理出站，绕过规则分流库；下方的分流规则当前处于旁路状态。
              </p>
            </div>
          </div>
          <button
            onClick={() => handleModeChange("rule")}
            className="px-3 py-1.5 rounded-xl bg-amber-100 hover:bg-amber-200 text-amber-800 border border-amber-300 dark:bg-amber-500/20 dark:hover:bg-amber-500/30 dark:text-amber-200 dark:border-amber-500/30 font-medium transition shrink-0"
          >
            切回规则分流
          </button>
        </div>
      )}

      {config?.mode?.toLowerCase() === "direct" && (
        <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-between text-xs text-emerald-800 dark:text-emerald-300 shadow-sm dark:shadow-lg dark:shadow-emerald-950/20">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/20 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
              <ArrowRight className="w-4 h-4" />
            </div>
            <div>
              <div className="font-bold text-emerald-900 dark:text-emerald-200 text-sm flex items-center gap-1.5">
                完全直连模式已激活 (Direct Mode)
              </div>
              <p className="text-[11px] text-emerald-700/90 dark:text-emerald-300/80 mt-0.5">
                所有网络连接直接访问目标网站，绕过代理节点与分流规则，100% 走本地网络，不消耗节点流量。
              </p>
            </div>
          </div>
          <button
            onClick={() => handleModeChange("rule")}
            className="px-3 py-1.5 rounded-xl bg-emerald-100 hover:bg-emerald-200 text-emerald-800 border border-emerald-300 dark:bg-emerald-500/20 dark:hover:bg-emerald-500/30 dark:text-emerald-200 dark:border-emerald-500/30 font-medium transition shrink-0"
          >
            切回规则分流
          </button>
        </div>
      )}

      {/* 规则统计看板 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
        <div className="bg-white dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800/80 rounded-2xl p-4 flex items-center gap-3.5 shadow-sm transition-colors">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-600 dark:bg-indigo-500/10 dark:border-indigo-500/20 dark:text-indigo-400 flex items-center justify-center">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">总规则条数</div>
            <div className="text-lg font-bold text-slate-900 dark:text-white tracking-wide">{metrics.total}</div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800/80 rounded-2xl p-4 flex items-center gap-3.5 shadow-sm transition-colors">
          <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-200 text-blue-600 dark:bg-blue-500/10 dark:border-blue-500/20 dark:text-blue-400 flex items-center justify-center">
            <Globe className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">域名分流规则 (Domain)</div>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className="text-lg font-bold text-slate-900 dark:text-white tracking-wide">
                {metrics.directDomainCount > 0
                  ? `${metrics.directDomainCount} 条`
                  : metrics.domainProviderCount > 0
                  ? `${metrics.domainProviderCount} 个规则集`
                  : "0"}
              </span>
              {metrics.directDomainCount === 0 && metrics.domainProviderCount > 0 && (
                <span className="text-[11px] text-blue-600 dark:text-blue-400/90 font-medium">
                  ({metrics.providerDomainRules > 0 ? `${metrics.providerDomainRules.toLocaleString()} 条` : "涵盖海量域名"})
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800/80 rounded-2xl p-4 flex items-center gap-3.5 shadow-sm transition-colors">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-600 dark:bg-emerald-500/10 dark:border-emerald-500/20 dark:text-emerald-400 flex items-center justify-center">
            <Server className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">网段 / 地理 (IP / Geo)</div>
            <div className="text-lg font-bold text-slate-900 dark:text-white tracking-wide">
              {metrics.ipCount + metrics.geoCount}
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800/80 rounded-2xl p-4 flex items-center gap-3.5 shadow-sm transition-colors">
          <div className="w-10 h-10 rounded-xl bg-purple-50 border border-purple-200 text-purple-600 dark:bg-purple-500/10 dark:border-purple-500/20 dark:text-purple-400 flex items-center justify-center">
            <Database className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">外部规则集 (Providers)</div>
            <div className="text-lg font-bold text-slate-900 dark:text-white tracking-wide">{providers.length} 个</div>
          </div>
        </div>
      </div>

      {/* 广告与恶意网站防护状态横幅 */}
      {adBlockGroup && (
        <div className="p-4 rounded-2xl bg-white dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-4 text-xs shadow-sm transition-colors">
          <div className="flex items-center gap-3">
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                adBlockGroup.now === "REJECT"
                  ? "bg-rose-500/15 text-rose-500 dark:text-rose-400 border border-rose-500/30"
                  : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30"
              }`}
            >
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <div className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <span>广告与恶意网站防护:</span>
                {adBlockGroup.now === "REJECT" ? (
                  <span className="text-rose-600 dark:text-rose-400 font-semibold flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5" />
                    已开启 (强制拦截 REJECT)
                  </span>
                ) : (
                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1">
                    <Check className="w-3.5 h-3.5" />
                    默认已停用 (直连放行)
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                {adBlockGroup.now === "REJECT"
                  ? "当前策略强制丢弃广告与分析追踪；若遇网页加载异常或频繁触发 Cloudflare 5秒盾，建议切换为停用。"
                  : "已默认放行广告与追踪请求直连出站，彻底避免误杀正常网页脚本与频繁触发 Cloudflare 5秒盾人机验证。"}
              </p>
            </div>
          </div>

          <button
            onClick={handleToggleAdBlock}
            disabled={togglingAdBlock}
            className={`px-3.5 py-1.5 rounded-xl font-medium transition flex items-center gap-1.5 shrink-0 ${
              adBlockGroup.now === "REJECT"
                ? "bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 dark:border-slate-700"
                : "bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/20"
            }`}
          >
            {togglingAdBlock ? (
              <RotateCw className="w-3 h-3 animate-spin" />
            ) : (
              <Shield className="w-3 h-3" />
            )}
            <span>
              {adBlockGroup.now === "REJECT" ? "恢复默认停用 (直连)" : "开启广告拦截 (REJECT)"}
            </span>
          </button>
        </div>
      )}

      {/* 分流命中测试模拟器 */}
      <div className="bg-gradient-to-r from-indigo-50/70 via-white to-purple-50/40 dark:from-slate-900/90 dark:via-slate-900/60 dark:to-indigo-950/30 border border-indigo-200/80 hover:border-indigo-300 dark:border-indigo-500/20 dark:hover:border-indigo-500/35 transition rounded-2xl p-4 shadow-sm dark:shadow-lg dark:shadow-black/20">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <div className="p-1 rounded-lg bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-400">
              <Play className="w-3.5 h-3.5 fill-current" />
            </div>
            <span className="text-xs font-bold text-slate-900 dark:text-white tracking-wide">分流匹配实时测试模拟器</span>
            <span className="text-[11px] text-slate-500 dark:text-slate-400 hidden sm:inline">
              (输入域名或 IP，模拟内核匹配顺序测算最终出站)
            </span>
          </div>

          <div className="flex items-center space-x-2">
            {/* 快捷测试小胶囊 */}
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              <span className="hidden md:inline text-slate-400 dark:text-slate-500">快捷测试:</span>
              {[
                { label: "Google", host: "google.com" },
                { label: "B站", host: "bilibili.com" },
                { label: "GitHub", host: "github.com" },
                { label: "ChatGPT", host: "chatgpt.com" },
                { label: "114 DNS", host: "114.114.114.114" },
              ].map((item) => (
                <button
                  key={item.host}
                  type="button"
                  onClick={() => {
                    setTestInput(item.host);
                    setTimeout(() => handleSimulate(), 50);
                  }}
                  className="px-2 py-0.5 rounded-lg bg-white hover:bg-indigo-50 hover:text-indigo-600 border border-slate-200 text-[10px] text-slate-600 font-mono transition dark:bg-slate-800/80 dark:hover:bg-indigo-600/30 dark:hover:text-indigo-200 dark:border-slate-700/60 dark:text-slate-300"
                >
                  {item.label}
                </button>
              ))}
            </div>

            {testResult && (
              <button
                onClick={() => setTestResult(null)}
                className="text-[11px] px-2 py-0.5 rounded-lg bg-white hover:bg-slate-100 text-slate-500 hover:text-slate-800 border border-slate-200 transition dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-400 dark:hover:text-white dark:border-transparent"
              >
                清空
              </button>
            )}
          </div>
        </div>

        <form onSubmit={handleSimulate} className="flex gap-2.5">
          <div className="relative flex-1">
            <input
              type="text"
              placeholder="输入待检测目标，如 google.com、api.github.com、114.114.114.114..."
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              className="w-full pl-3.5 pr-8 py-2 rounded-xl bg-white dark:bg-slate-950/70 border border-slate-300 dark:border-slate-800 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 font-mono transition shadow-sm"
            />
            {testInput && (
              <button
                type="button"
                onClick={() => setTestInput("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 p-0.5"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <button
            type="submit"
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition flex items-center gap-1.5 shrink-0 shadow-md shadow-indigo-600/20 active:scale-95"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>测试分流</span>
          </button>
        </form>

        {testResult && (
          <div className="mt-3 pt-3 border-t border-indigo-100 dark:border-slate-800/80 space-y-2 text-xs animate-in fade-in duration-200">
            <div className="flex flex-wrap items-center justify-between gap-3 bg-white/90 dark:bg-slate-950/40 p-2.5 rounded-xl border border-slate-200 dark:border-slate-800/60 shadow-sm">
              <div className="flex items-center gap-2 flex-wrap">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 dark:text-emerald-400 shrink-0" />
                <span className="text-slate-500 dark:text-slate-400">命中规则:</span>
                <span className="text-slate-900 dark:text-white font-mono font-semibold">
                  {testResult.matchedIndex > 0
                    ? `第 #${testResult.matchedIndex} 条`
                    : testResult.rule.type === "GLOBAL"
                    ? "全局接管"
                    : testResult.rule.type === "DIRECT"
                    ? "直连接管"
                    : "默认兜底"}
                </span>
                <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-800 dark:text-slate-300 font-mono text-[11px] dark:border-slate-700/50">
                  {testResult.rule.type}
                </span>
                <span className="text-indigo-600 dark:text-indigo-300 font-mono font-medium truncate max-w-[280px]" title={testResult.rule.payload}>
                  {testResult.rule.payload || "<兜底全匹配>"}
                </span>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <ArrowRight className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                <span className="text-slate-500 dark:text-slate-400">最终出站:</span>
                <span
                  className={`px-3 py-0.5 rounded-lg text-xs font-bold border shadow-sm ${getTargetBadge(
                    testResult.rule.proxy
                  )}`}
                >
                  {testResult.rule.proxy}
                </span>
              </div>
            </div>
            {testResult.explanation && (
              <div className="text-[11px] text-slate-500 dark:text-slate-400 pl-3 flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-500 dark:bg-indigo-400 shrink-0"></span>
                <span>{testResult.explanation}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 视图 Tab 切换与过滤检索栏 */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800/80 pb-3">
          {/* Tabs 分段器 */}
          <div className="bg-slate-100 dark:bg-slate-900/80 p-1 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center shadow-inner transition-colors">
            <button
              onClick={() => setActiveTab("rules")}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-2 ${
                activeTab === "rules"
                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>规则列表</span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                  activeTab === "rules" ? "bg-indigo-500/30 text-white" : "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                }`}
              >
                {filteredRules.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab("providers")}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-2 ${
                activeTab === "providers"
                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
              }`}
            >
              <Database className="w-3.5 h-3.5" />
              <span>外部规则集</span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                  activeTab === "providers" ? "bg-indigo-500/30 text-white" : "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                }`}
              >
                {providers.length}
              </span>
            </button>
          </div>

          {/* 搜索框 (支持清空) */}
          {activeTab === "rules" && (
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="搜索规则条件、域名或目标代理..."
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                className="pl-8 pr-7 py-1.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700/80 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 w-72 transition font-mono shadow-sm"
              />
              {keyword && (
                <button
                  onClick={() => setKeyword("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* 规则过滤条件过滤器 (仅在 rules tab) */}
        {activeTab === "rules" && (
          <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-100/80 dark:bg-slate-900/40 p-2.5 rounded-xl border border-slate-200/80 dark:border-slate-800/60 shadow-sm transition-colors">
            {/* 类型快速筛选 */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-slate-600 dark:text-slate-400 font-medium flex items-center gap-1 mr-1">
                <Filter className="w-3 h-3 text-indigo-500 dark:text-indigo-400" />
                规则类型:
              </span>
              {[
                { id: "ALL", label: "全部" },
                { id: "DOMAIN", label: "🌐 域名 / 规则集" },
                { id: "IP", label: "📌 IP-CIDR" },
                { id: "GEO", label: "🌍 GEO 地理" },
                { id: "RULE-SET", label: "📦 RULE-SET" },
                { id: "MATCH", label: "🛡️ MATCH 兜底" },
              ].map((item) => (
                <button
                  key={item.id}
                  onClick={() => setTypeFilter(item.id)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition ${
                    typeFilter === item.id
                      ? "bg-indigo-600 text-white shadow-sm shadow-indigo-600/30 border border-indigo-500"
                      : "text-slate-700 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-200 shadow-sm dark:text-slate-400 dark:hover:text-white dark:bg-slate-800/60 dark:hover:bg-slate-800 dark:border-slate-700/60 dark:shadow-none"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {/* 目标出站过滤下拉 */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-600 dark:text-slate-400 font-medium">出站目标:</span>
              <select
                value={proxyFilter}
                onChange={(e) => setProxyFilter(e.target.value)}
                className="px-2.5 py-1 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-xs text-slate-800 dark:text-slate-300 focus:outline-none focus:border-indigo-500 shadow-sm"
              >
                <option value="ALL">全部目标 ({metrics.uniqueProxies.length})</option>
                {metrics.uniqueProxies.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* 域名规则托管提示条 (当筛选域名且直属单行为0时) */}
        {activeTab === "rules" && typeFilter === "DOMAIN" && metrics.directDomainCount === 0 && metrics.domainProviderCount > 0 && (
          <div className="px-4 py-2.5 bg-blue-50 border border-blue-200 text-blue-700 dark:bg-blue-500/10 dark:border-blue-500/25 dark:text-blue-300 rounded-2xl text-xs flex flex-wrap items-center justify-between gap-2 shadow-sm">
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-blue-500 dark:text-blue-400 shrink-0" />
              <span>
                当前订阅自身无单行静态域名规则，分流已由 <strong>{metrics.domainProviderCount} 个外部规则集</strong>（Google、GitHub、流媒体、AI 等）与 <strong>GEOSITE</strong> 全权托管，涵盖海量云端域名。
              </span>
            </div>
            <button
              onClick={() => setActiveTab("providers")}
              className="text-[11px] px-2.5 py-1 rounded-lg bg-blue-100 hover:bg-blue-200 text-blue-800 border border-blue-200 font-medium transition shrink-0 dark:bg-blue-500/20 dark:hover:bg-blue-500/30 dark:text-blue-200 dark:border-blue-500/40"
            >
              查看外部规则集详情 →
            </button>
          </div>
        )}
      </div>

      {/* 主体内容 */}
      {activeTab === "rules" ? (
        <div className="bg-white dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800/80 rounded-2xl overflow-hidden shadow-sm dark:shadow-xl transition-colors">
          {/* 表头 */}
          <div className="grid grid-cols-12 px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-xs font-semibold text-slate-500 dark:text-slate-400">
            <div className="col-span-1">#</div>
            <div className="col-span-3">匹配类型 (Type)</div>
            <div className="col-span-5">匹配条件 (Payload)</div>
            <div className="col-span-3 text-right">分流目标 (Target)</div>
          </div>

          {/* 列表条目 */}
          <div className="divide-y divide-slate-200/60 dark:divide-slate-800/40 min-h-[380px] max-h-[560px] overflow-y-auto">
            {paginatedRules.map((item, idx) => {
              const ruleIndex = (currentPage - 1) * pageSize + idx + 1;
              const provider = providers.find((p) => p.name === item.payload);
              const isDomainSet =
                provider &&
                ((provider.behavior || "").toLowerCase() === "domain" ||
                  (provider.behavior || "").toLowerCase() === "classical");
              const isIpSet =
                provider && (provider.behavior || "").toLowerCase() === "ipcidr";
              const isGeosite = (item.type || "").toUpperCase() === "GEOSITE";

              const isMatched = testResult?.matchedIndex === ruleIndex;

              return (
                <div
                  key={ruleIndex}
                  id={`rule-row-${ruleIndex}`}
                  className={`grid grid-cols-12 px-5 py-2.5 text-xs items-center transition font-mono group ${
                    isMatched
                      ? "bg-indigo-50 dark:bg-indigo-950/70 border-l-4 border-indigo-600 dark:border-indigo-400 ring-1 ring-indigo-500/30"
                      : "hover:bg-slate-50 dark:hover:bg-slate-800/40"
                  }`}
                >
                  <div className="col-span-1 flex items-center gap-1 font-semibold">
                    {isMatched ? (
                      <span className="text-indigo-600 dark:text-indigo-400 flex items-center gap-1 font-bold">
                        <span>🎯</span>
                        <span>{ruleIndex}</span>
                      </span>
                    ) : (
                      <span className="text-slate-400 dark:text-slate-600">{ruleIndex}</span>
                    )}
                  </div>
                  <div className="col-span-3 flex flex-wrap items-center gap-1.5">
                    <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700/50 text-slate-700 dark:text-slate-300 text-[11px]">
                      {item.type}
                    </span>
                    {isDomainSet && (
                      <span className="px-1.5 py-0.2 rounded text-[10px] bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30 font-sans">
                        🌐 域名集
                      </span>
                    )}
                    {isIpSet && (
                      <span className="px-1.5 py-0.2 rounded text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30 font-sans">
                        📌 IP集
                      </span>
                    )}
                    {isGeosite && (
                      <span className="px-1.5 py-0.2 rounded text-[10px] bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-500/30 font-sans">
                        🌐 域名库
                      </span>
                    )}
                  </div>
                  <div className="col-span-5 flex items-center gap-2 pr-3 min-w-0">
                    <span
                      className="text-slate-700 dark:text-slate-300 truncate select-all hover:text-slate-950 dark:hover:text-white transition"
                      title={
                        provider
                          ? `${item.payload} (${provider.ruleCount || 0} 条规则)`
                          : item.payload
                      }
                    >
                      {item.payload || "<默认兜底全匹配>"}
                    </span>
                    {provider && provider.ruleCount !== undefined && provider.ruleCount > 0 && (
                      <span className="text-[10px] text-slate-400 dark:text-slate-500 font-sans shrink-0">
                        ({provider.ruleCount}条)
                      </span>
                    )}
                    {item.payload && (
                      <button
                        onClick={() => copyText(item.payload)}
                        className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 transition p-0.5"
                        title="复制匹配条件"
                      >
                        {copiedPayload === item.payload ? (
                          <Check className="w-3 h-3 text-emerald-500 dark:text-emerald-400" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                    )}
                  </div>
                  <div className="col-span-3 text-right">
                    <span
                      className={`px-2.5 py-0.5 rounded text-[11px] font-semibold border inline-block ${getTargetBadge(
                        item.proxy
                      )}`}
                    >
                      {item.proxy}
                      {adBlockGroup && item.proxy === adBlockGroup.name && (
                        <span className="text-[10px] ml-1 opacity-80 font-normal">
                          ({adBlockGroup.now === "REJECT" ? "拦截" : "直连放行"})
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}

            {filteredRules.length === 0 && (
              <div className="p-16 text-center text-xs text-slate-400 dark:text-slate-500 flex flex-col items-center justify-center gap-3">
                <Filter className="w-8 h-8 text-slate-300 dark:text-slate-600 stroke-[1.5]" />
                <div className="text-slate-600 dark:text-slate-400 font-medium">没有找到符合条件的规则</div>
                <div className="text-[11px] text-slate-400 dark:text-slate-600">请尝试更换筛选条件或关键词</div>
              </div>
            )}
          </div>

          {/* 分页控制栏 */}
          {filteredRules.length > 0 && (
            <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="text-slate-500 dark:text-slate-400 text-[11px]">
                显示第 <span className="text-slate-800 dark:text-white font-semibold">{(currentPage - 1) * pageSize + 1}</span> 至{" "}
                <span className="text-slate-800 dark:text-white font-semibold">
                  {Math.min(currentPage * pageSize, filteredRules.length)}
                </span>{" "}
                条，共 <span className="text-slate-800 dark:text-white font-semibold">{filteredRules.length}</span> 条
              </div>

              <div className="flex items-center space-x-3">
                <div className="flex items-center space-x-1.5">
                  <span className="text-slate-400 dark:text-slate-500 text-[11px]">每页:</span>
                  <select
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    className="px-2 py-0.5 rounded bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 text-xs text-slate-800 dark:text-slate-300 focus:outline-none shadow-sm"
                  >
                    <option value={50}>50 条</option>
                    <option value={100}>100 条</option>
                    <option value={200}>200 条</option>
                  </select>
                </div>

                <div className="flex items-center space-x-1">
                  <button
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="p-1.5 rounded-lg bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 dark:border-transparent disabled:opacity-30 disabled:cursor-not-allowed transition shadow-sm"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>

                  <span className="px-2 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                    {currentPage} / {totalPages}
                  </span>

                  <button
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="p-1.5 rounded-lg bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 dark:border-transparent disabled:opacity-30 disabled:cursor-not-allowed transition shadow-sm"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* 规则集提供者 (Rule Providers) 完整集成工作台 */
        <div className="space-y-6">
          {/* Toast 提示条 */}
          {providerToast && (
            <div
              className={`p-3 rounded-xl border text-xs flex items-center gap-2 transition ${
                providerToast.isError
                  ? "bg-rose-500/10 border-rose-500/30 text-rose-600 dark:text-rose-300"
                  : "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-300"
              }`}
            >
              {providerToast.isError ? (
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-500 dark:text-rose-400" />
              ) : (
                <Check className="w-4 h-4 shrink-0 text-emerald-500 dark:text-emerald-400" />
              )}
              <span>{providerToast.text}</span>
            </div>
          )}

          {/* 顶部操作条 */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900/40 p-4 rounded-2xl border border-slate-200 dark:border-slate-800/80 shadow-sm">
            <div>
              <h3 className="text-sm font-semibold text-slate-800 dark:text-white flex items-center gap-2">
                <Database className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
                外部规则集管理与集成
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                支持一键接入开源高质量分流规则集，由内核定时从云端自动同步
              </p>
            </div>

            <div className="flex items-center space-x-2">
              <button
                onClick={() => setIsAddModalOpen(true)}
                className="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-md shadow-indigo-600/20 transition"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>添加规则集</span>
              </button>

              <button
                onClick={loadData}
                disabled={loading}
                title="刷新状态"
                className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>

          {/* 已加载的外部规则集列表 */}
          {providers.length > 0 && (
            <div className="space-y-3">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                <span>当前已生效的外部规则集 ({providers.length})</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {providers.map((p) => {
                  const behaviorLower = (p.behavior || "").toLowerCase();
                  return (
                    <div
                      key={p.name}
                      className="bg-white dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800/90 hover:border-indigo-400 dark:hover:border-indigo-500/40 rounded-2xl p-4 space-y-3 shadow-sm hover:shadow-md dark:hover:shadow-black/20 transition group"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 dark:border-purple-500/25 flex items-center justify-center text-purple-600 dark:text-purple-400 group-hover:scale-105 transition">
                            <Database className="w-4 h-4" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <h4 className="text-sm font-bold text-slate-800 dark:text-white font-mono">{p.name}</h4>
                              {behaviorLower === "domain" ? (
                                <span className="px-1.5 py-0.2 rounded text-[10px] bg-blue-500/10 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300 border border-blue-500/25 dark:border-blue-500/30">
                                  🌐 域名集
                                </span>
                              ) : behaviorLower === "ipcidr" ? (
                                <span className="px-1.5 py-0.2 rounded text-[10px] bg-emerald-500/10 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/25 dark:border-emerald-500/30">
                                  📌 IP集
                                </span>
                              ) : (
                                <span className="px-1.5 py-0.2 rounded text-[10px] bg-purple-500/10 dark:bg-purple-500/15 text-purple-600 dark:text-purple-300 border border-purple-500/25 dark:border-purple-500/30">
                                  📦 综合集
                                </span>
                              )}
                            </div>
                            <span className="text-[11px] text-slate-500 dark:text-slate-400">
                              传输: {p.vehicleType} · 模式: {p.behavior}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center space-x-1.5">
                          <button
                            onClick={() => handleUpdateProvider(p.name)}
                            disabled={updatingProvider === p.name}
                            className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-medium border border-slate-300 dark:border-slate-700 transition flex items-center gap-1 shadow-sm"
                          >
                            <RotateCw
                              className={`w-3 h-3 ${
                                updatingProvider === p.name ? "animate-spin text-indigo-500 dark:text-indigo-400" : ""
                              }`}
                            />
                            <span>更新</span>
                          </button>

                          <button
                            onClick={() => handleRemoveProvider(p.name)}
                            disabled={
                              operatingProvider === p.name ||
                              !localPlan?.providers.some((local) => local.name === p.name)
                            }
                            className="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800/80 hover:bg-rose-500/10 dark:hover:bg-rose-500/20 text-slate-500 dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-300 border border-slate-300 dark:border-slate-700 transition disabled:opacity-30 disabled:cursor-not-allowed"
                            title="仅移除本地方案规则集；订阅自带规则由订阅管理"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="pt-2 border-t border-slate-100 dark:border-slate-800/70 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                        <div>
                          规则容量:{" "}
                          <span className="text-slate-800 dark:text-white font-bold font-mono">
                            {p.ruleCount ? p.ruleCount.toLocaleString() : 0}
                          </span>{" "}
                          条
                        </div>
                        <div>
                          更新:{" "}
                          <span className="text-slate-600 dark:text-slate-300 font-mono text-[11px]">
                            {p.updatedAt ? new Date(p.updatedAt).toLocaleString() : "本地加载"}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 开箱即用：精选开源规则集市场（一键启用） */}
          <div className="bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800/80 rounded-2xl p-5 space-y-4 shadow-sm">
            <div>
              <h4 className="text-xs font-bold text-slate-800 dark:text-white flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-amber-500 dark:text-amber-400" />
                <span>精选开源规则集一键集成（点击直接生效）</span>
              </h4>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                保存到本地方案；订阅缺少分流规则时自动生效，不修改订阅文件
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 text-xs">
              {PRESET_RULE_PROVIDERS.map((preset) => {
                const isInstalled = localPlan?.providers.some((p) => p.name === preset.name);
                const isOperating = operatingProvider === preset.name;

                return (
                  <div
                    key={preset.id}
                    className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800/80 hover:border-slate-300 dark:hover:border-slate-700/80 space-y-2.5 transition flex flex-col justify-between"
                  >
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="font-semibold text-slate-800 dark:text-white flex items-center gap-1.5">
                          {preset.id === "reject" && <Shield className="w-3.5 h-3.5 text-rose-500 dark:text-rose-400" />}
                          {preset.id === "openai" && <Sparkles className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" />}
                          {preset.id === "youtube" && <Tv className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />}
                          {preset.id === "direct" && <Globe className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />}
                          <span>{preset.title}</span>
                        </div>
                        <span className="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-[10px] text-slate-700 dark:text-slate-300 font-mono">
                          {preset.category} · {preset.source}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-600 dark:text-slate-400">{preset.description}</p>
                      <div className="text-[10px] text-slate-400 dark:text-slate-500 font-mono truncate" title={preset.url}>
                        {preset.url}
                      </div>
                    </div>

                    <div className="pt-2 border-t border-slate-200 dark:border-slate-800/60 flex items-center justify-between">
                      <span className="text-[11px] text-slate-500 dark:text-slate-400">
                        默认分流: <strong className="text-slate-700 dark:text-slate-300">{preset.target_proxy}</strong>
                      </span>

                      <button
                        onClick={() => handleTogglePreset(preset)}
                        disabled={isOperating}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                          isInstalled
                            ? "bg-rose-500/10 dark:bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/25 dark:border-rose-500/30 hover:bg-rose-500/20"
                            : "bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/20"
                        }`}
                      >
                        {isOperating ? (
                          <RotateCw className="w-3 h-3 animate-spin" />
                        ) : isInstalled ? (
                          <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                        ) : (
                          <Plus className="w-3 h-3" />
                        )}
                        <span>
                          {isOperating ? "正在处理..." : isInstalled ? "已启用 (点击停用)" : "一键启用"}
                        </span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 自定义添加规则集弹窗 Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form
            onSubmit={handleAddCustom}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-md p-5 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Plus className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
                添加自定义外部规则集
              </h3>
              <button
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-white p-1 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium">规则集唯一名称 (英文标识)</label>
                <input
                  type="text"
                  required
                  placeholder="如 my-custom-rules"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium">规则订阅源地址 (URL)</label>
                <input
                  type="url"
                  required
                  placeholder="https://..."
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium">匹配类型 (Behavior)</label>
                  <select
                    value={customBehavior}
                    onChange={(e) => setCustomBehavior(e.target.value as any)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="domain">domain (纯域名)</option>
                    <option value="classical">classical (综合规则)</option>
                    <option value="ipcidr">ipcidr (IP网段)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium">文件格式</label>
                  <select
                    aria-label="规则文件格式"
                    value={customFormat}
                    onChange={e => setCustomFormat(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white mb-3 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="auto">自动识别</option>
                    <option value="yaml">YAML（payload 列表）</option>
                    <option value="text">Text（每行一条）</option>
                    <option value="mrs">MRS（二进制）</option>
                  </select>
                  <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium">分流目标 (Target)</label>
                  <select
                    value={customTarget}
                    onChange={(e) => setCustomTarget(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="🔰 节点选择">本地方案·节点选择</option>
                    <option value="DIRECT">DIRECT (直连)</option>
                    <option value="REJECT">REJECT (拦截)</option>
                    {["AI", "流媒体", "通信", "开发", "游戏", "微软"].map(name => <option key={name} value={`本地方案·${name}`}>{`本地方案·${name}`}</option>)}
                  </select>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                className="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs transition"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={operatingProvider !== null}
                className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition flex items-center gap-1"
              >
                {operatingProvider ? <RotateCw className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                <span>{operatingProvider ? "正在添加..." : "保存并启用"}</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
