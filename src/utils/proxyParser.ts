import { SmartGroupRule } from "../types/smartGroup";
import { IpHealthInfo } from "../types";

/**
 * 解析节点名称提取地区标志，并映射到国旗 Emoji 与标准中文地区
 * 支持各种常见订阅节点命名格式：
 * - "🇺🇸 美国 01 [2x] 专线" -> 2.0
 * - "香港 02 | 1.5X" -> 1.5
 * - "日本 03 0.5x" -> 0.5
 * - "新加坡 x2.0" -> 2.0
 * - 未标注时默认 1.0
 */
export function parseMultiplier(name: string): number {
  if (!name) return 1.0;

  // 1. 匹配类似 "1.5x", "2X", "0.5x", "[2x]"
  const matchNumFirst = name.match(/(?:^|[^\d.])(\d+(?:\.\d+)?)\s*[xX](?:$|[^\w])/i);
  if (matchNumFirst && matchNumFirst[1]) {
    const val = parseFloat(matchNumFirst[1]);
    if (!isNaN(val) && val > 0 && val <= 50) {
      return val;
    }
  }

  // 2. 匹配类似 "x2", "X1.5", "[X2.0]"
  const matchXFirst = name.match(/(?:^|[^\w])[xX]\s*(\d+(?:\.\d+)?)(?:$|[^\w])/i);
  if (matchXFirst && matchXFirst[1]) {
    const val = parseFloat(matchXFirst[1]);
    if (!isNaN(val) && val > 0 && val <= 50) {
      return val;
    }
  }

  return 1.0;
}

/**
 * 倍率格式化显示（如 0.5x, 1x, 1.5x, 2x）
 */
export function formatMultiplier(multiplier: number): string {
  if (multiplier === 1.0) return "1.0x";
  return Number.isInteger(multiplier) ? `${multiplier}x` : `${multiplier.toFixed(1)}x`;
}

const REGION_ALIAS_MAP: Record<string, string[]> = {
  JP: ["日本", "japan", "jp", "东京", "tokyo", "大阪", "osaka", "名古屋", "nagoya", "福冈", "fukuoka", "羽田", "成田", "🇯🇵"],
  HK: ["香港", "hong kong", "hongkong", "hk", "hkg", "维多利亚", "九龙", "中环", "🇭🇰"],
  US: ["美国", "united states", "usa", "us", "洛杉矶", "los angeles", "la", "旧金山", "san francisco", "硅谷", "silicon valley", "圣何塞", "san jose", "西雅图", "seattle", "纽约", "new york", "芝加哥", "chicago", "达拉斯", "dallas", "凤凰城", "phoenix", "波特兰", "portland", "迈阿密", "miami", "🇺🇸"],
  SG: ["新加坡", "singapore", "sg", "sin", "狮城", "🇸🇬"],
  TW: ["台湾", "taiwan", "tw", "twn", "台北", "taipei", "新北", "台中", "高雄", "🇹🇼"],
  KR: ["韩国", "korea", "kr", "kor", "首尔", "seoul", "仁川", "incheon", "釜山", "busan", "🇰🇷"],
  UK: ["英国", "united kingdom", "uk", "gb", "great britain", "伦敦", "london", "曼彻斯特", "manchester", "🇬🇧"],
  DE: ["德国", "germany", "de", "deu", "法兰克福", "frankfurt", "柏林", "berlin", "🇩🇪"],
};

/**
 * 根据智能策略组的规则，对候选节点进行全维度特征过滤和排序
 */
export function filterAndSortProxies(
  nodeNames: string[],
  rule: SmartGroupRule,
  healthMap: Record<string, IpHealthInfo | undefined>,
  delayMap: Record<string, number | null | undefined>
): string[] {
  // 如果是手动挑选模式，以用户勾选的节点为基础池
  let matched =
    rule.nodeSelectionMode === "manual" && Array.isArray(rule.manualNodes)
      ? rule.manualNodes.filter((n) => nodeNames.includes(n))
      : [...nodeNames];

  // 1. 地区智能识别与特征匹配 (自动筛选模式)
  if (rule.nodeSelectionMode !== "manual" && (rule.regionPattern?.trim() || rule.countryCode)) {
    const rawPattern = (rule.regionPattern || "").trim();
    const patternLower = rawPattern.toLowerCase();

    // 识别目标国家代码
    let targetCountry = (rule.countryCode || "").toUpperCase();
    if (!targetCountry) {
      for (const [code, aliases] of Object.entries(REGION_ALIAS_MAP)) {
        if (aliases.some((alias) => patternLower.includes(alias.toLowerCase()))) {
          targetCountry = code;
          break;
        }
      }
    }

    const aliases = targetCountry && REGION_ALIAS_MAP[targetCountry]
      ? REGION_ALIAS_MAP[targetCountry]
      : [];

    matched = matched.filter((name) => {
      // 优先从已完成的 IP 真实体检画像中匹配真实国家
      const health = healthMap[name];
      if (targetCountry && health?.countryCode && health.countryCode.toUpperCase() === targetCountry) {
        return true;
      }

      // 如果节点名字命中了该国家相关的城市、别名或国旗 Emoji
      const nameLower = name.toLowerCase();
      if (aliases.some((alias) => nameLower.includes(alias.toLowerCase()))) {
        return true;
      }

      // 兜底：用用户自填的正则或关键词测试节点名
      if (rawPattern) {
        try {
          const reg = new RegExp(rawPattern, "i");
          if (reg.test(name)) return true;
        } catch {
          if (nameLower.includes(patternLower)) return true;
        }
      }

      return false;
    });
  }

  // 3. 排除已确认离线与超时的节点 (delay === null 或 <= 0，未测速的节点允许先作为候选保留)
  if (rule.excludeOffline) {
    matched = matched.filter((name) => {
      const delay = delayMap[name];
      if (delay === null || (typeof delay === "number" && delay <= 0)) {
        return false;
      }
      return true;
    });
  }

  // 4. IP 健康与出口属性过滤 (严格满足用户设定的纯净度与特征要求)
  matched = matched.filter((name) => {
    const health = healthMap[name];
    // 如果没有配置任何 IP 健康条件，直接放行
    if (!rule.requireResidential && !rule.requireNative && rule.maxFraudScore === undefined) {
      return true;
    }

    // 欺诈纯净度限制（欺诈分 <= 阈值，严格排除未知评分与未检测节点）
    if (rule.maxFraudScore !== undefined) {
      if (!health || typeof health.fraudScore !== "number" || health.fraudScore > rule.maxFraudScore) {
        return false;
      }
    }

    // 住宅宽带过滤：未检测或明确检测为非住宅时剔除
    if (rule.requireResidential) {
      if (!health || health.isResidential !== true) {
        return false;
      }
    }

    // 原生 IP (非广播)：未检测或明确为广播时剔除
    if (rule.requireNative) {
      if (!health || health.isBroadcast !== false) {
        return false;
      }
    }

    return true;
  });

  // 5. 排序与接力决策
  // 如果是 sticky 极稳接力模式（不死不切）：
  if (rule.type === "sticky") {
    // 如果当前锁定的节点在 matched 候选池中且可用（未被判断为离线），保持其在最顶端第一位
    const currentNode = rule.stickyCurrentNode;
    if (currentNode && matched.includes(currentNode)) {
      const delay = delayMap[currentNode];
      const isAlive = delay !== null && (typeof delay === "number" ? delay > 0 : true);
      if (isAlive) {
        // 当前节点健在，置顶作为第一选择，其他节点按备用排在后面
        matched = [currentNode, ...matched.filter((n) => n !== currentNode)];
        return matched;
      }
    }
    // 如果当前节点死了或者尚未指定，按原先顺序（或延迟）挑出一个活着的节点成为新主力
    if (rule.sortByLatency) {
      matched.sort((a, b) => {
        const delayA = delayMap[a] ?? 999999;
        const delayB = delayMap[b] ?? 999999;
        return delayA - delayB;
      });
    }
    return matched;
  }

  // 6. 普通模式：按延迟升序（低延迟优先）
  if (rule.sortByLatency) {
    matched.sort((a, b) => {
      const delayA = delayMap[a] ?? 999999;
      const delayB = delayMap[b] ?? 999999;
      return delayA - delayB;
    });
  }

  return matched;
}

export interface CountryInfo {
  code: string;
  name: string;
  emoji: string;
  pattern: string;
}

export const SUPPORTED_COUNTRIES: CountryInfo[] = [
  { code: "HK", name: "中国香港", emoji: "🇭🇰", pattern: "HK|HongKong|Hong Kong|香港|深港|沪港" },
  { code: "TW", name: "中国台湾", emoji: "🇹🇼", pattern: "TW|Taiwan|台湾|台北|台中" },
  { code: "JP", name: "日本", emoji: "🇯🇵", pattern: "JP|Japan|日本|东京|大阪|埼玉" },
  { code: "SG", name: "新加坡", emoji: "🇸🇬", pattern: "SG|Singapore|狮城|新加坡" },
  { code: "US", name: "美国", emoji: "🇺🇸", pattern: "US|USA|United States|美国|美|洛杉矶|硅谷|西雅图|达拉斯|纽约" },
  { code: "KR", name: "韩国", emoji: "🇰🇷", pattern: "KR|Korea|韩国|首尔" },
  { code: "GB", name: "英国", emoji: "🇬🇧", pattern: "UK|GB|United Kingdom|Great Britain|英国|伦敦" },
  { code: "DE", name: "德国", emoji: "🇩🇪", pattern: "DE|Germany|德国|法兰克福" },
  { code: "FR", name: "法国", emoji: "🇫🇷", pattern: "FR|France|法国|巴黎" },
  { code: "CA", name: "加拿大", emoji: "🇨🇦", pattern: "CA|Canada|加拿大|多伦多|温哥华" },
  { code: "AU", name: "澳大利亚", emoji: "🇦🇺", pattern: "AU|Australia|澳大利亚|澳洲|悉尼|墨尔本" },
  { code: "NL", name: "荷兰", emoji: "🇳🇱", pattern: "NL|Netherlands|荷兰|阿姆斯特丹" },
  { code: "RU", name: "俄罗斯", emoji: "🇷🇺", pattern: "RU|Russia|俄罗斯|莫斯科" },
  { code: "IN", name: "印度", emoji: "🇮🇳", pattern: "IN|India|印度|孟买" },
  { code: "TH", name: "泰国", emoji: "🇹🇭", pattern: "TH|Thailand|泰国|曼谷" },
  { code: "MY", name: "马来西亚", emoji: "🇲🇾", pattern: "MY|Malaysia|马来西亚|大马|吉隆坡" },
  { code: "PH", name: "菲律宾", emoji: "🇵🇭", pattern: "PH|Philippines|菲律宾|马尼拉" },
  { code: "VN", name: "越南", emoji: "🇻🇳", pattern: "VN|Vietnam|越南|胡志明|河内" },
  { code: "TR", name: "土耳其", emoji: "🇹🇷", pattern: "TR|Turkey|土耳其|伊斯坦布尔" },
  { code: "BR", name: "巴西", emoji: "🇧🇷", pattern: "BR|Brazil|巴西|圣保罗" },
  { code: "AR", name: "阿根廷", emoji: "🇦🇷", pattern: "AR|Argentina|阿根廷|布宜诺斯艾利斯" },
];

/**
 * 依据节点名称提取国家代码
 */
export function extractCountryCode(nodeName: string): string | null {
  for (const c of SUPPORTED_COUNTRIES) {
    const reg = new RegExp(c.pattern, "i");
    if (reg.test(nodeName)) {
      return c.code;
    }
  }
  return null;
}

/**
 * 根据国家代码 (如 "JP", "US") 获取对应国家元数据
 */
export function getCountryInfoByCode(code?: string): CountryInfo | null {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  return SUPPORTED_COUNTRIES.find((c) => c.code === upper) || null;
}

/**
 * 格式化大盘地区标题 (如 "🇯🇵 日本", "🇺🇸 美国")
 */
export function formatCountryRegionTitle(countryCode?: string, fallbackName?: string): string {
  if (countryCode) {
    const info = getCountryInfoByCode(countryCode);
    if (info) {
      return `${info.emoji} ${info.name}`;
    }
  }
  if (fallbackName) {
    const codeFromName = extractCountryCode(fallbackName);
    if (codeFromName) {
      const info = getCountryInfoByCode(codeFromName);
      if (info) {
        return `${info.emoji} ${info.name}`;
      }
    }
  }
  return "🌐 其它地区";
}

/**
 * 判断是否为订阅套餐/流量/到期/公告等非真实出站节点
 */
export function isInformationalNode(name: string, type?: string): boolean {
  if (!name) return false;
  const n = name.trim();

  // 1. 类型特征过滤 (如 Compatible 占位符)
  if (type && /^(compatible|unknown)$/i.test(type.trim())) {
    return true;
  }

  // 2. 关键词黑名单过滤 (覆盖主流订阅源提示节点)
  const pattern = /(剩余流量|套餐到期|到期时间|重置剩余|下次重置|距离下次|官网|通知|公告|更新|群|频道|客服|套餐|expired|reset|traffic|[\d.]+\s*(?:GB|MB|TB|KB)\s*剩余|距离.*天|剩余.*GB|到期.*20\d\d|COMPATIBLE)/i;
  if (pattern.test(n)) {
    return true;
  }

  return false;
}

/**
 * 从订阅信息节点中提取元数据（剩余流量、套餐到期日、重置倒计时等）
 */
export function extractSubscriptionMeta(nodes: { name: string }[]): {
  remainingTraffic?: string;
  expireDate?: string;
  resetDays?: string;
} {
  const result: { remainingTraffic?: string; expireDate?: string; resetDays?: string } = {};

  for (const node of nodes) {
    const name = node.name;
    if (!name) continue;

    // 提取剩余流量，如 "剩余流量: 42.64 GB" 或 "42.64 GB 剩余"
    if (!result.remainingTraffic && /(?:剩余流量|剩余|流量).*?(\d+(?:\.\d+)?\s*(?:TB|GB|MB))/i.test(name)) {
      const match = name.match(/(?:剩余流量|剩余|流量).*?(\d+(?:\.\d+)?\s*(?:TB|GB|MB))/i);
      if (match && match[1]) {
        result.remainingTraffic = match[1].trim();
      }
    } else if (!result.remainingTraffic && /(\d+(?:\.\d+)?\s*(?:TB|GB|MB)).*?(?:剩余|可用)/i.test(name)) {
      const match = name.match(/(\d+(?:\.\d+)?\s*(?:TB|GB|MB)).*?(?:剩余|可用)/i);
      if (match && match[1]) {
        result.remainingTraffic = match[1].trim();
      }
    }

    // 提取套餐到期，如 "套餐到期: 2026-10-11" 或 "到期时间 2026/10/11"
    if (!result.expireDate && /(?:套餐到期|到期时间|到期).*?(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/i.test(name)) {
      const match = name.match(/(?:套餐到期|到期时间|到期).*?(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/i);
      if (match && match[1]) {
        result.expireDate = match[1].trim();
      }
    }

    // 提取重置剩余天数，如 "距离下次重置剩余: 23 天" 或 "重置剩余 23 天"
    if (!result.resetDays && /(?:重置剩余|下次重置|距离下次).*?(\d+)\s*天/i.test(name)) {
      const match = name.match(/(?:重置剩余|下次重置|距离下次).*?(\d+)\s*天/i);
      if (match && match[1]) {
        result.resetDays = `${match[1]} 天`;
      }
    }
  }

  return result;
}
