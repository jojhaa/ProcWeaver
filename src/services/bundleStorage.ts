import {
  BusinessBundleDefinition,
  BundleLocalInstance,
  ExportableBundlePackage,
  BundleSlot,
} from "../types/businessBundle";

const STORAGE_KEY = "netbox_business_bundles_instances_v1";

// 标准默认语义插槽
const DEFAULT_SLOTS: BundleSlot[] = [
  {
    id: "main",
    name: "主业务出口",
    description: "业务主进程与核心后台伴生进程访问外网所使用的代理节点",
    required: true,
  },
  {
    id: "dns",
    name: "DNS 解析出口",
    description: "域名解析出站插槽，默认跟随主业务出口以防 DNS 投毒",
    required: false,
    followSlotId: "main",
  },
];

// 内置开箱精选规则包模板（便携包与安装包仅携带 OpenAI 与 Google 反重力 2 个核心套件）
export const PRESET_BUNDLES_CATALOG: BusinessBundleDefinition[] = [
  {
    packageId: "openai-chatgpt",
    packageName: "OpenAI / ChatGPT 生产力套件",
    packageVersion: "v1.3",
    category: "dev",
    mode: "strict",
    icon: "🧠",
    description: "包含 ChatGPT.exe、核心后台 codex.exe 及伴生 node.exe，强锁单出口杜绝异地风控封号",
    slots: DEFAULT_SLOTS,
    processes: [
      { exe: "ChatGPT.exe", role: "main", description: "桌面主客户端" },
      { exe: "codex.exe", role: "worker", description: "OpenAI 核心数据与代码辅助进程" },
      { exe: "node.exe", role: "worker", description: "扩展脚本与本地运行依赖" },
    ],
    additionalExes: ["ChatGPT.exe", "codex.exe", "node.exe"],
    domains: [
      "openai.com",
      "chatgpt.com",
      "oaistatic.com",
      "oaiusercontent.com",
      "auth0.openai.com",
    ],
  },
  {
    packageId: "google-antigravity",
    packageName: "Google Antigravity 2.0 研发套件",
    packageVersion: "v1.0",
    category: "dev",
    mode: "strict",
    icon: "🌌",
    description: "包含 Antigravity.exe、核心语言服务 language_server.exe 及 CLI 工具，全套进程整包强锁",
    slots: DEFAULT_SLOTS,
    processes: [
      { exe: "Antigravity.exe", role: "main", description: "主集成开发环境与核心进程" },
      { exe: "language_server.exe", role: "worker", description: "LSP 语言模型与语义推理核心工作服务" },
      { exe: "agy.exe", role: "cli", description: "Antigravity 开发者命令行终端" },
      { exe: "antigravity-service.exe", role: "worker", description: "后台状态监测守护服务" },
    ],
    additionalExes: [
      "Antigravity.exe",
      "antigravity.exe",
      "language_server.exe",
      "agy.exe",
      "antigravity-service.exe",
      "Antigravity IDE.exe",
    ],
    domains: [
      "antigravity.google",
      "gemini.google.com",
      "generativeai.google",
      "aistudio.google.com",
    ],
  },
];

// 获取全部已装载的本地规则包实例 (开箱严格仅装载官方 2 个预设：OpenAI 与 Google 反重力)
export function getBundleInstances(): BundleLocalInstance[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // 自动清洗历史遗留的旧版未修改 mock 套件 (inst-cursor / inst-browser)
        const cleaned = parsed.filter(
          (item: BundleLocalInstance) =>
            !["inst-cursor", "inst-browser"].includes(item.instanceId)
        );
        if (cleaned.length !== parsed.length) {
          saveBundleInstances(cleaned);
          return cleaned;
        }
        return parsed;
      }
    }
  } catch (err) {
    console.error("读取业务规则包存储失败:", err);
  }

  // 初次初始化：严格仅装载官方开箱双预设（OpenAI 和 反重力），其余全部按需自仓库获取或手动导入
  const initialInstances: BundleLocalInstance[] = [
    {
      instanceId: "inst-chatgpt",
      definition: PRESET_BUNDLES_CATALOG[0], // ChatGPT
      enabled: true,
      slotBindings: { main: null, dns: "FOLLOW_MAIN" },
      watcherMode: "auto",
      isModified: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      instanceId: "inst-antigravity",
      definition: PRESET_BUNDLES_CATALOG[1], // Google Antigravity
      enabled: false, // 默认停用 (跟随系统默认)
      slotBindings: { main: null, dns: "FOLLOW_MAIN" },
      watcherMode: "auto",
      isModified: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];

  saveBundleInstances(initialInstances);
  return initialInstances;
}

// 保存本地实例到持久化存储
export function saveBundleInstances(instances: BundleLocalInstance[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(instances));
  } catch (err) {
    console.error("持久化业务规则包实例失败:", err);
    throw new Error("无法保存本机规则包，请检查存储空间后重试");
  }
}

// 从预设模板装载新实例
export function installPresetBundle(
  definition: BusinessBundleDefinition,
  autoEnable = false,
  boundNode: string | null = null
): BundleLocalInstance {
  const instances = getBundleInstances();
  const instanceId = `inst-${definition.packageId}-${Date.now().toString(36)}`;

  const newInstance: BundleLocalInstance = {
    instanceId,
    definition: JSON.parse(JSON.stringify(definition)),
    enabled: autoEnable && Boolean(boundNode),
    slotBindings: {
      main: boundNode,
      dns: "FOLLOW_MAIN",
    },
    watcherMode: definition.mode === "sandbox" ? "notify" : "auto",
    isModified: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  instances.push(newInstance);
  saveBundleInstances(instances);
  return newInstance;
}

// 更新指定实例
export function updateBundleInstance(
  instanceId: string,
  updater: (prev: BundleLocalInstance) => BundleLocalInstance
): BundleLocalInstance[] {
  const instances = getBundleInstances();
  const index = instances.findIndex((i) => i.instanceId === instanceId);
  if (index !== -1) {
    const updated = updater(instances[index]);
    updated.updatedAt = Date.now();
    instances[index] = updated;
    saveBundleInstances(instances);
  }
  return instances;
}

// 卸载/删除指定实例
export function deleteBundleInstance(instanceId: string): BundleLocalInstance[] {
  const instances = getBundleInstances().filter((i) => i.instanceId !== instanceId);
  saveBundleInstances(instances);
  return instances;
}

// 创建自定义规则包
export function createCustomBundle(
  name: string,
  exes: string[],
  domains: string[]
): BundleLocalInstance {
  const instances = getBundleInstances();
  const packageId = `custom-${Date.now().toString(36)}`;

  const definition: BusinessBundleDefinition = {
    packageId,
    packageName: name,
    packageVersion: "v1.0",
    category: "custom",
    mode: "strict",
    icon: "📦",
    fallback: "system",
    description: "用户自定义业务规则套件",
    slots: DEFAULT_SLOTS,
    processes: exes.map((e, idx) => ({
      exe: e,
      role: idx === 0 ? "main" : "worker",
      description: idx === 0 ? "主程序" : "伴生依赖进程",
    })),
    additionalExes: exes,
    domains,
  };

  const newInstance: BundleLocalInstance = {
    instanceId: `inst-${packageId}`,
    definition,
    enabled: false, // 默认停用 (跟随系统默认)
    slotBindings: { main: null, dns: "FOLLOW_MAIN" },
    watcherMode: "auto",
    isModified: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  instances.push(newInstance);
  saveBundleInstances(instances);
  return newInstance;
}

// 规范安全导出：生成 .pwpack.json (白名单脱敏，绝对剔除本机实际节点与订阅身份)
export function exportBundlePackage(instance: BundleLocalInstance): ExportableBundlePackage {
  const def = instance.definition;
  // 仅克隆通用的结构，绝不携带 slotBindings
  const cleanDef: BusinessBundleDefinition = {
    packageId: def.packageId,
    packageName: def.packageName,
    packageVersion: def.packageVersion,
    category: def.category,
    mode: def.mode,
    fallback: def.fallback ?? "rules",
    icon: def.icon,
    description: def.description,
    slots: def.slots.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      required: s.required,
      followSlotId: s.followSlotId,
    })),
    processes: def.processes.map((p) => ({
      exe: p.exe,
      role: p.role,
      description: p.description,
    })),
    additionalExes: def.additionalExes ? [...def.additionalExes] : undefined,
    domains: def.domains ? [...def.domains] : undefined,
    author: def.author || "Net-Box User",
  };

  return {
    formatVersion: "1.0",
    exportedAt: new Date().toISOString(),
    bundle: cleanDef,
  };
}

// 校验并解析外部导入的 .pwpack.json (严格遵循 B05 契约)
export function validateAndParseBundlePackage(jsonString: string): {
  valid: boolean;
  error?: string;
  bundle?: BusinessBundleDefinition;
} {
  try {
    if (!jsonString || typeof jsonString !== "string") {
      return { valid: false, error: "导入内容为空" };
    }
    if (jsonString.length > 5 * 1024 * 1024) {
      return { valid: false, error: "导入文件体积过大（超过 5MB 上限），已拒绝处理" };
    }

    const data = JSON.parse(jsonString);
    if (!data || typeof data !== "object") {
      return { valid: false, error: "文件格式无效，非合法的 JSON 对象" };
    }

    if (data.formatVersion && typeof data.formatVersion === "string" && !data.formatVersion.startsWith("1.")) {
      return { valid: false, error: `不支持的规则包格式版本: ${data.formatVersion}` };
    }

    const bundle = data.bundle || data;
    if (bundle.fallback !== undefined && !["rules", "system", "direct"].includes(bundle.fallback)) {
      return { valid: false, error: "未命中域名时的策略无效" };
    }
    if (!bundle.packageName || typeof bundle.packageName !== "string" || !bundle.packageName.trim()) {
      return { valid: false, error: "缺少必要的规则包名称 (packageName)" };
    }
    if (!Array.isArray(bundle.processes) || bundle.processes.length === 0) {
      return { valid: false, error: "规则包中必须至少包含一个进程定义 (processes)" };
    }
    if (bundle.processes.length > 100) {
      return { valid: false, error: "单包进程数量超过安全上限 (最大 100 个)" };
    }

    // 清洗并严格校验进程名（严禁路径遍历字符、斜杠以及纯数字）
    const validProcesses: { exe: string; role: "main" | "worker" | "cli"; description: string }[] = [];
    for (const p of bundle.processes) {
      const rawExe = (typeof p === "string" ? p : p?.exe || "").trim();
      if (!rawExe) continue;
      // 拒绝路径遍历或带路径的非法执行内容
      if (rawExe.includes("/") || rawExe.includes("\\") || rawExe.includes("..")) {
        return { valid: false, error: `检测到不安全的进程路径字符: ${rawExe}` };
      }
      // 拒绝纯数字进程名
      if (/^\d+$/.test(rawExe)) {
        return { valid: false, error: `进程名称无效（不能为纯数字）: ${rawExe}` };
      }
      const role = p.role === "main" || p.role === "cli" ? p.role : "worker";
      validProcesses.push({
        exe: rawExe,
        role,
        description: typeof p.description === "string" ? p.description : "",
      });
    }

    if (validProcesses.length === 0) {
      return { valid: false, error: "经过过滤后，未找到任何有效的可执行进程定义" };
    }

    // 校验域名列表
    let validDomains: string[] | undefined = undefined;
    if (Array.isArray(bundle.domains)) {
      if (bundle.domains.length > 1000) {
        return { valid: false, error: "单包域名数量超过安全上限 (最大 1000 个)" };
      }
      validDomains = bundle.domains
        .filter((d: any) => typeof d === "string" && d.trim().length > 0 && !d.includes(" ") && !d.includes("/"))
        .map((d: any) => d.trim().toLowerCase());
    }

    // 格式化并补全插槽
    const validBundle: BusinessBundleDefinition = {
      packageId: bundle.packageId || `imported-${Date.now().toString(36)}`,
      packageName: bundle.packageName.trim(),
      packageVersion: bundle.packageVersion || "v1.0",
      category: bundle.category || "custom",
      mode: bundle.mode === "sandbox" ? "sandbox" : "strict",
      fallback: bundle.fallback ?? "rules",
      icon: bundle.icon || "📦",
      description: bundle.description || "导入的规则包",
      slots: Array.isArray(bundle.slots) && bundle.slots.length > 0 ? bundle.slots : DEFAULT_SLOTS,
      processes: validProcesses,
      additionalExes: Array.isArray(bundle.additionalExes) ? bundle.additionalExes.filter((e: any) => typeof e === "string") : undefined,
      domains: validDomains,
      author: bundle.author,
    };

    return { valid: true, bundle: validBundle };
  } catch (err: any) {
    return { valid: false, error: `解析 JSON 失败: ${err.message || err}` };
  }
}

/**
 * 从 ProcWeaver-Rules 规则仓库的 Business-Rules 目录真实拉取在线业务规则包
 * 严格真实请求，绝不返回虚假 mock 数据！
 */
export async function fetchRemoteBusinessRules(): Promise<BusinessBundleDefinition[]> {
  const candidateUrls = [
    "https://api.github.com/repos/jojhaa/ProcWeaver-Rules/contents/Business-Rules",
    "https://api.github.com/repos/jojhaa/ProcWeaver-Rules/contents/Business-Rule",
  ];

  for (const url of candidateUrls) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/vnd.github.v3+json" } });
      if (res.ok) {
        const items = await res.json();
        if (Array.isArray(items)) {
          const jsonFiles = items.filter((f: any) => f.name && f.name.endsWith(".pwpack.json"));
          const list: BusinessBundleDefinition[] = [];
          for (const file of jsonFiles) {
            if (file.download_url) {
              try {
                const fileRes = await fetch(file.download_url);
                if (fileRes.ok) {
                  const content = await fileRes.text();
                  const check = validateAndParseBundlePackage(content);
                  if (check.valid && check.bundle) {
                    list.push(check.bundle);
                  }
                }
              } catch {
                // 忽略个别损坏文件
              }
            }
          }
          if (list.length > 0) {
            return list;
          }
        }
      }
    } catch (err) {
      console.warn(`从规则仓库在线拉取 ${url} 失败:`, err);
    }
  }

  // 严格返回真实结果：若仓库暂无额外套件，绝不使用虚假 mock 冒充
  return [];
}
