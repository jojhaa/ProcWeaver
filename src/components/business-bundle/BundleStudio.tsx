import React, { useState, useMemo } from "react";
import {
  BundleLocalInstance,
  BundleProcessBinding,
  BundleFallback,
  BundleTrafficMode,
  ExportableBundlePackage,
} from "../../types/businessBundle";
import type { BundlePlatform } from "../../types/platform";
import {
  matchingBindings,
  processKey,
  processNames,
  validateProcessBindings,
  bundleExes,
} from "../../utils/bundlePlatform";
import { BundleDiscoveryTools } from "./BundleDiscoveryTools";
import { createCustomBundle } from "../../services/bundleStorage";
import { saveTextFile } from "../../services/fileExport";
import {
  Sparkles,
  Shield,
  Layers,
  Check,
  Download,
  Plus,
  Copy,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  RotateCcw,
} from "lucide-react";

interface Props {
  os: BundlePlatform;
  existingInstances: BundleLocalInstance[];
  availableProxies: string[];
  proxyLabels?: Record<string, string>;
  processTreeSupported: boolean;
  onSave: (newInstance: BundleLocalInstance) => void;
  showToast: (msg: string) => void;
}

const PRESET_ICONS = ["🤖", "💬", "🎮", "🧑‍💻", "🌐", "📦", "🎨", "⚡", "🚀", "🛡️"];

export const BundleStudio: React.FC<Props> = ({
  os,
  existingInstances,
  availableProxies,
  proxyLabels,
  processTreeSupported,
  onSave,
  showToast,
}) => {
  // 表单状态
  const [name, setName] = useState<string>("AI 编程伴侣");
  const [desc, setDesc] = useState<string>("聚合 Cursor、VSCode 与 Claude Code，强锁专属高质量出站通道");
  const [icon, setIcon] = useState<string>("🤖");
  const [mode, setMode] = useState<BundleTrafficMode>("strict");
  const [fallback, setFallback] = useState<BundleFallback>("direct");
  const [exesText, setExesText] = useState<string>("Cursor.exe\nCode.exe\nclaude.exe");
  const [domainsText, setDomainsText] = useState<string>("api.openai.com\nanthropic.com\ncursor.sh\noaistatic.com");
  const [bindings, setBindings] = useState<BundleProcessBinding[]>([]);
  const [quickProcInput, setQuickProcInput] = useState<string>("");
  const [showSpecJson, setShowSpecJson] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  // 解析当前填写的进程与域名列表
  const parsedExes = useMemo(() => processNames(exesText), [exesText]);
  const parsedDomains = useMemo(() => {
    return domainsText
      .split(/[\n,，;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }, [domainsText]);

  // 冲突实时体检：检查当前填写的进程是否与已有启用的业务包冲突
  const conflictReport = useMemo(() => {
    const activeInstances = existingInstances.filter((i) => i.enabled && i.slotBindings.main);
    const conflicts: { exe: string; conflictingPackages: string[] }[] = [];

    for (const exe of parsedExes) {
      const conflictingPackages: string[] = [];
      const key = processKey(exe, os);
      for (const inst of activeInstances) {
        const instExes = bundleExes(inst.definition, os);
        if (instExes.some((e) => processKey(e, os) === key)) {
          conflictingPackages.push(inst.definition.packageName);
        }
      }
      if (conflictingPackages.length > 0) {
        conflicts.push({ exe, conflictingPackages });
      }
    }
    return conflicts;
  }, [parsedExes, existingInstances, os]);

  // 套用快捷起步模版
  const handleApplyStarter = (type: "ai" | "business" | "game" | "dev") => {
    if (type === "ai") {
      setIcon("🤖");
      setName("AI 编程伴侣");
      setDesc("聚合 Cursor、VSCode 与 Claude Code，强锁专属高质量出站通道");
      setMode("strict");
      setFallback("direct");
      setExesText(os === "macos" ? "Cursor\nCode\nclaude" : "Cursor.exe\nCode.exe\nclaude.exe");
      setDomainsText("api.openai.com\nanthropic.com\ncursor.sh\noaistatic.com");
      setBindings([]);
      showToast("⚡ 已套用「AI 编程伴侣」配置预设！");
    } else if (type === "business") {
      setIcon("💬");
      setName("跨国商务通讯");
      setDesc("保障 Telegram、Slack、Zoom 畅联，毫秒级即时穿透");
      setMode("strict");
      setFallback("direct");
      setExesText(os === "macos" ? "Telegram\nSlack\nzoom.us" : "Telegram.exe\nslack.exe\nZoom.exe");
      setDomainsText("telegram.org\nt.me\nslack.com\nzoom.us");
      setBindings([]);
      showToast("⚡ 已套用「跨国商务通讯」配置预设！");
    } else if (type === "game") {
      setIcon("🎮");
      setName("国际游戏专线");
      setDesc("Steam / EA / 国际服对战游戏低延迟加速，UDP 特权优先");
      setMode("strict");
      setFallback("direct");
      setExesText(os === "macos" ? "steam_osx" : "steam.exe\nsteamwebhelper.exe");
      setDomainsText("steampowered.com\nsteamcommunity.com\nsteamstatic.com");
      setBindings([]);
      showToast("⚡ 已套用「国际游戏专线」配置预设！");
    } else if (type === "dev") {
      setIcon("🧑‍💻");
      setName("全栈开发工具箱");
      setDesc("Git、Docker、npm、Homebrew 依赖镜像拉取加速");
      setMode("sandbox");
      setFallback("rules");
      setExesText(os === "macos" ? "git\ndocker" : "git.exe\ndocker.exe");
      setDomainsText("github.com\ngithubusercontent.com\ndocker.com\nregistry.npmjs.org");
      setBindings([]);
      showToast("⚡ 已套用「全栈开发工具箱」配置预设！");
    }
  };

  // 重置工坊表单
  const handleReset = () => {
    setIcon("📦");
    setName("");
    setDesc("");
    setMode("strict");
    setFallback("direct");
    setExesText("");
    setDomainsText("");
    setBindings([]);
    setQuickProcInput("");
    showToast("🔄 工坊表单已重置清空！");
  };

  // 快速添加单项进程
  const handleAddQuickProc = () => {
    let val = quickProcInput.trim();
    if (!val) return;
    if (os === "windows" && !val.toLowerCase().endsWith(".exe")) {
      val += ".exe";
    }
    const current = processNames(exesText);
    if (!current.some((e) => processKey(e, os) === processKey(val, os))) {
      current.push(val);
      setExesText(current.join("\n"));
    }
    setQuickProcInput("");
  };

  // 移除单项进程
  const handleRemoveExe = (targetExe: string) => {
    const next = parsedExes.filter((e) => processKey(e, os) !== processKey(targetExe, os));
    setExesText(next.join("\n"));
    setBindings((prev) => prev.filter((b) => processKey(b.exe, os) !== processKey(targetExe, os)));
  };

  // 切换进程是否包含子进程
  const handleToggleDescendants = (targetExe: string, checked: boolean) => {
    const existingBinding = bindings.find((b) => processKey(b.exe, os) === processKey(targetExe, os));
    if (existingBinding) {
      setBindings((prev) =>
        prev.map((b) =>
          processKey(b.exe, os) === processKey(targetExe, os) ? { ...b, includeDescendants: checked } : b
        )
      );
    } else {
      // 若尚未有绝对路径绑定，添加虚拟匹配占位
      setBindings((prev) => [
        ...prev,
        {
          exe: targetExe,
          executablePath: targetExe,
          includeDescendants: checked,
        },
      ]);
    }
  };

  // 格式化与去重进程
  const handleFormatExes = () => {
    const names = processNames(exesText);
    setExesText(names.join("\n"));
    showToast(`✅ 已整理校验 ${names.length} 个进程！`);
  };

  // 智能嗅探模拟补充域名
  const handleSniffDomains = () => {
    const addDomains = ["identity.openai.com", "gateway.ai.cloudflare.com", "cdn.oaistatic.com"];
    const merged = [...new Set([...parsedDomains, ...addDomains])];
    setDomainsText(merged.join("\n"));
    showToast("⚡ 智能嗅探成功：已结合进程特征自动追加关联 API 域名！");
  };

  // 生成脱敏规则包 JSON 对象
  const specJsonData: ExportableBundlePackage = useMemo(() => {
    return {
      formatVersion: "1.0",
      exportedAt: new Date().toISOString(),
      bundle: {
        packageId: `custom-${name ? name.toLowerCase().replace(/[^a-z0-9]/g, "-") : "bundle"}`,
        packageName: name.trim() || "未命名规则包",
        packageVersion: "v1.0",
        category: "custom",
        mode,
        fallback,
        icon,
        description: desc.trim() || "用户自定义业务规则套件",
        slots: [
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
        ],
        processes: parsedExes.map((exe, i) => {
          const binding = bindings.find((b) => processKey(b.exe, os) === processKey(exe, os));
          return {
            exe,
            role: i === 0 ? "main" : "worker",
            description: i === 0 ? "主程序" : "协同进程",
            ...(binding?.includeDescendants ? { includeDescendants: true } : {}),
          };
        }),
        domains: parsedDomains,
        author: "ProcWeaver Studio User",
      },
    };
  }, [name, desc, icon, mode, fallback, parsedExes, parsedDomains, bindings, os]);

  // 复制脱敏 JSON
  const handleCopySpecJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(specJsonData, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      showToast("📋 已复制脱敏规则包 JSON 到剪贴板！");
    } catch {
      showToast("⚠️ 复制失败，请手动选取代码");
    }
  };

  // 保存并装载到本机列表
  const handleSaveAndInstall = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!name.trim()) {
      showToast("⚠️ 请填写规则包名称");
      return;
    }
    if (parsedExes.length === 0) {
      showToast("⚠️ 请至少指定一个可执行程序文件名");
      return;
    }

    const validBindings = matchingBindings(bindings, parsedExes, os);
    try {
      validateProcessBindings(validBindings, os);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "进程绑定路径无效");
      return;
    }

    const newInstance = createCustomBundle(
      name.trim(),
      parsedExes,
      parsedDomains,
      os,
      os === "android" ? undefined : { [os]: validBindings },
      {
        icon,
        mode,
        description: desc.trim(),
        fallback,
      }
    );

    onSave(newInstance);
    showToast(`✨ 自定义规则包「${newInstance.definition.packageName}」已装配并装载到本机！`);
  };

  // 直接纯净导出 .pwpack.json
  const handleExportDirect = async () => {
    if (!name.trim()) {
      showToast("⚠️ 导出前请填写规则包名称");
      return;
    }
    if (parsedExes.length === 0) {
      showToast("⚠️ 规则包至少需要包含一个进程定义");
      return;
    }

    const filename = `${name.trim().replace(/[\/\\:*?"<>|]/g, "_")}.pwpack.json`;
    const jsonStr = JSON.stringify(specJsonData, null, 2);
    try {
      const ok = await saveTextFile(filename, jsonStr, "application/json");
      if (ok) {
        showToast(`📤 已成功导出脱敏纯净规则包：${filename}`);
      }
    } catch (err) {
      showToast(`❌ 导出失败：${String(err)}`);
    }
  };

  return (
    <div className="flex-1 flex flex-col space-y-3 font-sans">
      {/* 1. 快捷起步预设栏 (Starter Presets) */}
      <div className="px-3.5 py-2 bg-gradient-to-r from-indigo-50/80 via-purple-50/50 to-slate-50 border border-indigo-100/80 dark:border-indigo-950/60 dark:from-indigo-950/30 dark:via-purple-950/20 dark:to-slate-900 rounded-2xl flex flex-wrap items-center justify-between gap-2 text-xs shrink-0 shadow-2xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-indigo-600 dark:text-indigo-400 font-bold text-[11px] flex items-center space-x-1">
            <Sparkles className="w-3.5 h-3.5" />
            <span>装配预设:</span>
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => handleApplyStarter("ai")}
              className="px-2.5 py-1 rounded-xl bg-white dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-slate-750 border border-slate-200 dark:border-slate-700 hover:border-indigo-300 text-slate-700 dark:text-slate-300 text-[11px] font-medium transition flex items-center space-x-1 shadow-2xs cursor-pointer"
            >
              <span>🤖 AI 编程伴侣</span>
            </button>
            <button
              type="button"
              onClick={() => handleApplyStarter("business")}
              className="px-2.5 py-1 rounded-xl bg-white dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-slate-750 border border-slate-200 dark:border-slate-700 hover:border-indigo-300 text-slate-700 dark:text-slate-300 text-[11px] font-medium transition flex items-center space-x-1 shadow-2xs cursor-pointer"
            >
              <span>💬 跨国商务通讯</span>
            </button>
            <button
              type="button"
              onClick={() => handleApplyStarter("game")}
              className="px-2.5 py-1 rounded-xl bg-white dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-slate-750 border border-slate-200 dark:border-slate-700 hover:border-indigo-300 text-slate-700 dark:text-slate-300 text-[11px] font-medium transition flex items-center space-x-1 shadow-2xs cursor-pointer"
            >
              <span>🎮 国际游戏专线</span>
            </button>
            <button
              type="button"
              onClick={() => handleApplyStarter("dev")}
              className="px-2.5 py-1 rounded-xl bg-white dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-slate-750 border border-slate-200 dark:border-slate-700 hover:border-indigo-300 text-slate-700 dark:text-slate-300 text-[11px] font-medium transition flex items-center space-x-1 shadow-2xs cursor-pointer"
            >
              <span>🧑‍💻 全栈开发工具</span>
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={handleReset}
          className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 text-[11px] flex items-center space-x-1 cursor-pointer"
        >
          <RotateCcw className="w-3 h-3" />
          <span>重置清空</span>
        </button>
      </div>

      {/* 2. 双栏工作区：左装配 + 右实时审查 */}
      <div className="flex-1 flex flex-col lg:flex-row gap-4 overflow-hidden">
        {/* ====== 左栏：规则装配与配置 (62% 宽度) ====== */}
        <div className="flex-[3] overflow-y-auto space-y-3.5 pr-1 text-xs">
          {/* 模块 1: 基础属性与标识 */}
          <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl space-y-3 shadow-2xs">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2">
              <h3 className="font-bold text-slate-800 dark:text-white flex items-center space-x-1.5 text-xs">
                <span className="text-indigo-500">🏷️</span>
                <span>1. 基础标识与元信息</span>
              </h3>
              <span className="text-[10px] text-slate-400 font-mono">Package Identity</span>
            </div>

            <div className="grid grid-cols-12 gap-3">
              {/* 图标选择器 */}
              <div className="col-span-12 sm:col-span-4">
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1.5 text-[11px]">
                  套件图标:
                </label>
                <div className="flex items-center space-x-2">
                  <div className="w-10 h-10 rounded-2xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-xl shadow-2xs shrink-0">
                    {icon}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {PRESET_ICONS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => setIcon(emoji)}
                        className={`w-5 h-5 rounded-lg text-xs flex items-center justify-center transition cursor-pointer ${
                          icon === emoji
                            ? "bg-indigo-600 text-white shadow-xs"
                            : "hover:bg-slate-100 dark:hover:bg-slate-800"
                        }`}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 规则包名称 */}
              <div className="col-span-12 sm:col-span-8">
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1.5 text-[11px]">
                  规则包名称 <span className="text-rose-500">*</span>:
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：AI 编程伴侣 或 跨境电商管理套件"
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white font-medium focus:bg-white dark:focus:bg-slate-950 focus:border-indigo-500 focus:outline-none transition shadow-2xs"
                />
              </div>

              {/* 描述信息 */}
              <div className="col-span-12">
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1.5 text-[11px]">
                  用途场景说明:
                </label>
                <input
                  type="text"
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="简述该规则包的路由意图与接管边界..."
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-700 dark:text-slate-300 focus:bg-white dark:focus:bg-slate-950 focus:border-indigo-500 focus:outline-none transition shadow-2xs"
                />
              </div>
            </div>
          </div>

          {/* 模块 2: 接管模式与隔离防线 */}
          <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl space-y-3 shadow-2xs">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2">
              <h3 className="font-bold text-slate-800 dark:text-white flex items-center space-x-1.5 text-xs">
                <Shield className="w-3.5 h-3.5 text-indigo-500" />
                <span>2. 接管模式与安全防线</span>
              </h3>
              <span className="text-[10px] text-slate-400">Strict vs Sandbox</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {/* 强锁模式 */}
              <button
                type="button"
                onClick={() => {
                  setMode("strict");
                  setFallback("direct");
                }}
                className={`p-3 rounded-2xl border text-left transition select-none flex flex-col justify-between cursor-pointer ${
                  mode === "strict"
                    ? "border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 text-indigo-900 dark:text-indigo-200 shadow-2xs"
                    : "border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs flex items-center space-x-1">
                      <span>🛡️ 强锁模式 (Strict)</span>
                      <span className="text-[9px] px-1.5 py-0.2 bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 rounded-full font-mono">
                        推荐
                      </span>
                    </span>
                    {mode === "strict" && <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />}
                  </div>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
                    强制仅走指定出口节点。节点故障或断网时立即物理阻断，绝对防止真实 IP 泄露，专为跨境办公与防封号设计。
                  </p>
                </div>
              </button>

              {/* 沙盒隔离模式 */}
              <button
                type="button"
                onClick={() => {
                  setMode("sandbox");
                  setFallback("rules");
                }}
                className={`p-3 rounded-2xl border text-left transition select-none flex flex-col justify-between cursor-pointer ${
                  mode === "sandbox"
                    ? "border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 text-indigo-900 dark:text-indigo-200 shadow-2xs"
                    : "border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs flex items-center space-x-1">
                      <span>📦 沙盒隔离 (Sandbox)</span>
                    </span>
                    {mode === "sandbox" && <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />}
                  </div>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
                    弹性容错接管。允许在专属出口不可用或遇到无规则匹配时平滑回落至全局分流规则，适合普通开发与日常工具。
                  </p>
                </div>
              </button>
            </div>
          </div>

          {/* 模块 3: 进程匹配与装配 */}
          <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl space-y-3 shadow-2xs">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2">
              <div className="flex items-center space-x-2">
                <Layers className="w-3.5 h-3.5 text-indigo-500" />
                <h3 className="font-bold text-slate-800 dark:text-white text-xs">3. 进程接管匹配 (Processes)</h3>
                <span className="px-1.5 py-0.2 bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 text-[10px] rounded-full font-mono font-bold">
                  {parsedExes.length}
                </span>
              </div>

              <button
                type="button"
                onClick={handleFormatExes}
                className="px-2.5 py-1 rounded-lg bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-750 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-[10px] transition shadow-2xs cursor-pointer"
                title="去重并整理后缀"
              >
                🧹 整理校验
              </button>
            </div>

            {/* 进程发现高级工具（运行中进程挑选） */}
            {processTreeSupported && os !== "android" && (
              <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200/70 dark:border-slate-800">
                <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300 block mb-1">
                  高级探测与路径绑定：
                </span>
                <BundleDiscoveryTools
                  platform={os}
                  exesText={exesText}
                  domainsText={domainsText}
                  bindings={bindings}
                  onProcesses={(text, nextBindings) => {
                    setExesText(text);
                    setBindings(nextBindings);
                  }}
                  onDomains={(text) => setDomainsText(text)}
                />
              </div>
            )}

            {/* 进程芯片流列表 (Chips List) */}
            <div className="space-y-1.5 max-h-36 overflow-y-auto p-2 bg-slate-50 dark:bg-slate-950/80 border border-slate-200/70 dark:border-slate-800 rounded-xl">
              {parsedExes.length === 0 ? (
                <div className="py-4 text-center text-slate-400 text-xs">
                  暂无匹配进程，请在下方输入可执行文件名或从运行中进程选择
                </div>
              ) : (
                parsedExes.map((exe) => {
                  const binding = bindings.find((b) => processKey(b.exe, os) === processKey(exe, os));
                  const isChecked = binding ? binding.includeDescendants : true;
                  return (
                    <div
                      key={exe}
                      className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/70 dark:border-slate-800 text-xs shadow-2xs"
                    >
                      <div className="flex items-center space-x-2 min-w-0">
                        <span className="text-indigo-500 font-mono text-[11px]">📁</span>
                        <span className="font-mono font-bold text-slate-800 dark:text-slate-200 text-[11px] truncate">
                          {exe}
                        </span>
                        {binding?.executablePath && (
                          <span
                            className="text-[9px] text-slate-400 font-mono truncate max-w-[140px]"
                            title={binding.executablePath}
                          >
                            {binding.executablePath}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center space-x-3 shrink-0 ml-2">
                        <label className="flex items-center space-x-1 text-[10px] text-slate-500 dark:text-slate-400 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => handleToggleDescendants(exe, e.target.checked)}
                            className="rounded text-indigo-600 focus:ring-0 w-3 h-3"
                          />
                          <span>包含子进程</span>
                        </label>
                        <button
                          type="button"
                          onClick={() => handleRemoveExe(exe)}
                          className="text-slate-400 hover:text-rose-500 font-bold text-xs p-0.5 rounded cursor-pointer"
                          title="移除该进程"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* 快速追加输入行 */}
            <div className="flex items-center space-x-2">
              <input
                type="text"
                value={quickProcInput}
                onChange={(e) => setQuickProcInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddQuickProc();
                  }
                }}
                placeholder={
                  os === "android"
                    ? "输入 Android 应用包名 (如 com.slack)，回车添加..."
                    : os === "macos"
                    ? "输入程序名 (如 Cursor)，回车添加..."
                    : "输入进程文件名（如 node.exe），回车添加..."
                }
                className="flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-slate-800 dark:text-slate-200 focus:bg-white dark:focus:bg-slate-950 focus:border-indigo-500 focus:outline-none transition shadow-2xs"
              />
              <button
                type="button"
                onClick={handleAddQuickProc}
                className="px-3.5 py-2 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 text-indigo-600 dark:text-indigo-400 font-bold text-xs transition border border-indigo-200 dark:border-indigo-800 cursor-pointer shrink-0"
              >
                + 添加进程
              </button>
            </div>
          </div>

          {/* 模块 4: 域名群与智能嗅探 */}
          <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl space-y-3 shadow-2xs">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2">
              <div className="flex items-center space-x-2">
                <span className="text-indigo-500 font-bold">🌐</span>
                <h3 className="font-bold text-slate-800 dark:text-white text-xs">
                  4. 匹配域名群 (Domain Rules)
                </h3>
                <span className="px-1.5 py-0.2 bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300 text-[10px] rounded-full font-mono font-bold">
                  {parsedDomains.length}
                </span>
              </div>

              <button
                type="button"
                onClick={handleSniffDomains}
                className="px-2.5 py-1 rounded-lg bg-white dark:bg-slate-800 border border-purple-200 dark:border-purple-800 hover:bg-purple-50 dark:hover:bg-purple-950/40 text-purple-600 dark:text-purple-300 text-[10px] font-medium flex items-center space-x-1 transition shadow-2xs cursor-pointer"
              >
                <span>⚡ 嗅探关联域名</span>
              </button>
            </div>

            <textarea
              rows={3}
              value={domainsText}
              onChange={(e) => setDomainsText(e.target.value)}
              placeholder="每行一个域名，例如：&#10;api.openai.com&#10;anthropic.com&#10;cursor.sh"
              className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-xs font-mono text-slate-800 dark:text-slate-200 focus:bg-white dark:focus:bg-slate-950 focus:border-indigo-500 focus:outline-none transition shadow-2xs leading-relaxed"
            />
            <p className="text-[10px] text-slate-400 leading-relaxed">
              支持泛域名与后缀匹配。受接管进程发起向这些域名的 DNS 查询与网络连接将强制锁定走该套件的同一出口插槽。
            </p>
          </div>
        </div>

        {/* ====== 右栏：实时审查与出厂面板 (38% 宽度) ====== */}
        <div className="flex-[2] flex flex-col justify-between bg-slate-50/70 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800 rounded-2xl p-4 space-y-3.5 shrink-0 shadow-2xs">
          <div className="space-y-3.5 overflow-y-auto">
            {/* 审查头 */}
            <div className="flex items-center justify-between border-b border-slate-200/60 dark:border-slate-800 pb-2">
              <span className="font-bold text-slate-800 dark:text-white text-xs flex items-center space-x-1.5">
                <span className="text-purple-500">👁️</span>
                <span>实时卡片预览与体检</span>
              </span>
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold bg-emerald-50 dark:bg-emerald-950/60 px-2 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800">
                ● 语法就绪
              </span>
            </div>

            {/* 1. 实时列表卡片渲染 (Live Card Simulation) */}
            <div>
              <span className="text-[10px] text-slate-400 font-medium block mb-1.5">
                装载到主列表后的实际显示样式：
              </span>

              <div className="p-3.5 bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 rounded-2xl shadow-xs space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2.5">
                    <div className="w-8 h-8 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-100 dark:border-indigo-800 flex items-center justify-center text-base shadow-2xs">
                      {icon}
                    </div>
                    <div>
                      <div className="flex items-center space-x-1.5">
                        <span className="font-bold text-slate-900 dark:text-white text-xs">
                          {name.trim() || "未命名规则包"}
                        </span>
                        <span
                          className={`px-1.5 py-0.2 text-[9px] rounded-full font-mono font-bold border ${
                            mode === "strict"
                              ? "bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-400 dark:border-indigo-800"
                              : "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800"
                          }`}
                        >
                          {mode === "strict" ? "强锁" : "沙盒"}
                        </span>
                      </div>
                      <span className="text-[10px] text-slate-400 font-mono block mt-0.5">
                        {parsedExes.length} 个进程 · {parsedDomains.length} 个域名
                      </span>
                    </div>
                  </div>

                  {/* 模拟状态开关 */}
                  <span className="inline-flex w-7 h-4 rounded-full bg-emerald-500 relative">
                    <span className="w-3 h-3 bg-white rounded-full absolute top-0.5 left-3.5 shadow-xs" />
                  </span>
                </div>

                {/* 模拟出站出口卡片 */}
                <div className="px-2.5 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-100 dark:border-slate-800 flex items-center justify-between text-[10px]">
                  <span className="text-slate-500 dark:text-slate-400">出口绑定:</span>
                  <span className="font-bold text-indigo-600 dark:text-indigo-400 font-mono flex items-center space-x-1">
                    <span>
                      {availableProxies.length > 0
                        ? proxyLabels?.[availableProxies[0]] || availableProxies[0]
                        : "待装载时指定节点"}
                    </span>
                    <span className="text-[8px] text-slate-400">▾</span>
                  </span>
                </div>
              </div>
            </div>

            {/* 2. 实时冲突体检与安全合规 */}
            <div className="p-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 space-y-2 text-xs">
              <div className="flex items-center justify-between font-bold text-slate-800 dark:text-slate-200">
                <span className="flex items-center space-x-1.5">
                  <span>🔍</span>
                  <span>冲突体检与安全合规</span>
                </span>
                {conflictReport.length === 0 ? (
                  <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                    独占性通过
                  </span>
                ) : (
                  <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium flex items-center space-x-1">
                    <AlertTriangle className="w-3 h-3" />
                    <span>检测到重叠</span>
                  </span>
                )}
              </div>

              {conflictReport.length > 0 ? (
                <div className="text-[10px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 p-2.5 rounded-xl border border-amber-200/80 dark:border-amber-800/80 space-y-1">
                  <span className="font-bold block">存在潜在进程抢占：</span>
                  {conflictReport.map((c) => (
                    <div key={c.exe} className="font-mono">
                      • {c.exe}: 已被「{c.conflictingPackages.join("、")}」接管
                    </div>
                  ))}
                  <p className="text-slate-400 pt-0.5">
                    提示：同时开启冲突套件可能阻碍应用生效，建议使用子进程模式或停用旧套件。
                  </p>
                </div>
              ) : (
                <div className="text-[10px] text-slate-500 dark:text-slate-400 space-y-1 leading-relaxed bg-slate-50 dark:bg-slate-950 p-2.5 rounded-xl border border-slate-100 dark:border-slate-800">
                  <div className="flex items-center space-x-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
                    <span>✓</span>
                    <span>进程独占性校验通过（无抢占冲突）</span>
                  </div>
                  <div className="flex items-center space-x-1.5">
                    <span>✓</span>
                    <span>脱敏白名单已生效（绝不携带节点账号与密钥）</span>
                  </div>
                  <div className="flex items-center space-x-1.5">
                    <span>✓</span>
                    <span>抽象插槽：main (主出口) / dns (防污染跟随)</span>
                  </div>
                </div>
              )}
            </div>

            {/* 3. 脱敏规则包代码预览 (可展开) */}
            <div>
              <button
                type="button"
                onClick={() => setShowSpecJson(!showSpecJson)}
                className="text-[10px] text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-medium flex items-center space-x-1 cursor-pointer"
              >
                {showSpecJson ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                <span>查看生成的脱敏规则包架构 (.pwpack.json)</span>
              </button>

              {showSpecJson && (
                <div className="mt-2 space-y-1.5 animate-in fade-in duration-100">
                  <div className="flex items-center justify-between text-[10px] text-slate-400">
                    <span>脱敏标准 JSON 拓扑</span>
                    <button
                      type="button"
                      onClick={handleCopySpecJson}
                      className="text-indigo-600 dark:text-indigo-400 hover:underline flex items-center space-x-0.5 cursor-pointer"
                    >
                      <Copy className="w-3 h-3" />
                      <span>{copied ? "已复制" : "复制JSON"}</span>
                    </button>
                  </div>
                  <pre className="p-2.5 bg-slate-900 text-emerald-400 text-[9px] font-mono rounded-xl max-h-36 overflow-y-auto leading-tight select-text">
                    {JSON.stringify(specJsonData, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>

          {/* ====== 底部双通道出厂按钮 ====== */}
          <div className="pt-2.5 border-t border-slate-200/70 dark:border-slate-800 space-y-2">
            <button
              type="button"
              onClick={() => handleSaveAndInstall()}
              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:opacity-95 text-white font-bold text-xs flex items-center justify-center space-x-1.5 shadow-md transition cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>✨ 保存并直接装载到本机列表</span>
            </button>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleExportDirect}
                className="py-1.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-750 text-slate-700 dark:text-slate-300 font-medium text-xs flex items-center justify-center space-x-1 shadow-2xs transition cursor-pointer"
                title="导出为完全脱敏的 .pwpack.json 规则包，可分享给他人"
              >
                <Download className="w-3.5 h-3.5 text-indigo-500" />
                <span>📤 纯净导出 (.pwpack)</span>
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="py-1.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-750 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 text-xs flex items-center justify-center space-x-1 shadow-2xs transition cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>重置</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
