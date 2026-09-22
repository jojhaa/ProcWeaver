import { TrayRegionGroup } from "./traySync";
import {
  extractCountryCode,
  formatCountryRegionTitle,
  isInformationalNode,
} from "./proxyParser";

export interface RawNodeForTray {
  name: string;
  delay?: number | null;
  type?: string;
  countryCode?: string;
  country?: string;
}

// 热门黄金六区及主流地区显示与排序配置
const REGION_CONFIG_MAP: Record<string, { priority: number; label: string }> = {
  HK: { priority: 1, label: "🇭🇰 中国香港" },
  JP: { priority: 2, label: "🇯🇵 日本" },
  SG: { priority: 3, label: "🇸🇬 新加坡" },
  US: { priority: 4, label: "🇺🇸 美国" },
  TW: { priority: 5, label: "🇹🇼 中国台湾" },
  KR: { priority: 6, label: "🇰🇷 韩国" },
  GB: { priority: 10, label: "🇬🇧 英国" },
  DE: { priority: 11, label: "🇩🇪 德国" },
  FR: { priority: 12, label: "🇫🇷 法国" },
  NL: { priority: 13, label: "🇳🇱 荷兰" },
  CA: { priority: 14, label: "🇨🇦 加拿大" },
  AU: { priority: 15, label: "🇦🇺 澳大利亚" },
  RU: { priority: 16, label: "🇷🇺 俄罗斯" },
  IN: { priority: 17, label: "🇮🇳 印度" },
  MY: { priority: 18, label: "🇲🇾 马来西亚" },
  TH: { priority: 19, label: "🇹🇭 泰国" },
  VN: { priority: 20, label: "🇻🇳 越南" },
  PH: { priority: 21, label: "🇵🇭 菲律宾" },
  TR: { priority: 22, label: "🇹🇷 土耳其" },
  BR: { priority: 23, label: "🇧🇷 巴西" },
  AR: { priority: 24, label: "🇦🇷 阿根廷" },
};

/**
 * 将原始节点列表转化为经过垃圾清洗、黄金地区排序、延迟低到高排序的高品质托盘二级菜单数据
 */
export function buildCategorizedTrayGroups(
  nodes: RawNodeForTray[],
  activeNodeName?: string
): TrayRegionGroup[] {
  if (!nodes || nodes.length === 0) return [];

  // 1. 过滤掉 DIRECT / REJECT 以及订阅信息/到期/流量/官网等非真实代理节点
  const validNodes = nodes.filter((node) => {
    if (!node || !node.name) return false;
    const name = node.name.trim();
    if (name === "DIRECT" || name === "REJECT" || name === "GLOBAL") return false;
    if (isInformationalNode(name, node.type)) return false;
    return true;
  });

  // 2. 按国家/地区分桶
  interface GroupBucket {
    region: string;
    priority: number;
    nodes: Array<{ name: string; delay: number | null; active: boolean }>;
  }

  const buckets: Record<string, GroupBucket> = {};

  for (const node of validNodes) {
    const code = node.countryCode || extractCountryCode(node.name);
    let regionLabel = "🌐 其它地区";
    let priority = 999;

    if (code) {
      const upper = code.toUpperCase();
      const cfg = REGION_CONFIG_MAP[upper];
      if (cfg) {
        regionLabel = cfg.label;
        priority = cfg.priority;
      } else {
        regionLabel = formatCountryRegionTitle(upper, node.country || node.name);
        priority = 50;
      }
    }

    if (!buckets[regionLabel]) {
      buckets[regionLabel] = {
        region: regionLabel,
        priority,
        nodes: [],
      };
    }

    const d = typeof node.delay === "number" && node.delay > 0 ? node.delay : null;
    buckets[regionLabel].nodes.push({
      name: node.name,
      delay: d,
      active: node.name === activeNodeName,
    });
  }

  // 3. 对每个地区内的节点按延迟低到高升序排列（测速快的前排优先），未测速的排在后面
  const result: TrayRegionGroup[] = Object.values(buckets)
    .sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.region.localeCompare(b.region, "zh-CN");
    })
    .map((bucket) => {
      bucket.nodes.sort((a, b) => {
        // 如果两者都有合法延迟，升序排列
        if (a.delay !== null && b.delay !== null) {
          return a.delay - b.delay;
        }
        // 有延迟的排在未测速或超时前面
        if (a.delay !== null) return -1;
        if (b.delay !== null) return 1;
        // 均无延迟时按名称排序
        return a.name.localeCompare(b.name, "zh-CN");
      });

      return {
        region: bucket.region,
        nodes: bucket.nodes,
      };
    });

  return result;
}
