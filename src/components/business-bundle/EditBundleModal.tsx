import React, { useState, useEffect } from "react";
import { BundleLocalInstance, BusinessBundleDefinition, BundleFallback } from "../../types/businessBundle";
import { PRESET_BUNDLES_CATALOG } from "../../services/bundleStorage";
import { Pencil, X, RotateCcw, Save } from "lucide-react";

interface Props {
  isOpen: boolean;
  bundleInstance: BundleLocalInstance | null;
  onSave: (updatedDefinition: BusinessBundleDefinition) => void;
  onCancel: () => void;
}

export const EditBundleModal: React.FC<Props> = ({
  isOpen,
  bundleInstance,
  onSave,
  onCancel,
}) => {
  const [name, setName] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [mode, setMode] = useState<"strict" | "sandbox">("strict");
  const [fallback, setFallback] = useState<BundleFallback>("rules");
  const [exesText, setExesText] = useState<string>("");
  const [domainsText, setDomainsText] = useState<string>("");

  useEffect(() => {
    if (bundleInstance) {
      const def = bundleInstance.definition;
      setName(def.packageName);
      setDescription(def.description);
      setMode(def.mode);
      setFallback(def.fallback ?? "rules");
      const exes = def.processes.map((p) => p.exe);
      setExesText(exes.join("\n"));
      setDomainsText((def.domains || []).join("\n"));
    }
  }, [bundleInstance, isOpen]);

  if (!isOpen || !bundleInstance) return null;

  const currentDef = bundleInstance.definition;
  const originalPreset = PRESET_BUNDLES_CATALOG.find(
    (p) => p.packageId === currentDef.packageId
  );

  const handleResetToPreset = () => {
    if (!originalPreset) return;
    setName(originalPreset.packageName);
    setDescription(originalPreset.description);
    setMode(originalPreset.mode);
    setFallback(originalPreset.fallback ?? "rules");
    setExesText(originalPreset.processes.map((p) => p.exe).join("\n"));
    setDomainsText((originalPreset.domains || []).join("\n"));
  };

  const handleSave = () => {
    const rawExes = exesText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const rawDomains = domainsText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (!name.trim()) {
      alert("规则包名称不能为空！");
      return;
    }

    if (rawExes.length === 0) {
      alert("规则包至少需要包含一个可执行文件进程！");
      return;
    }

    // 格式化进程定义列表
    const processes = rawExes.map((exe, idx) => ({
      exe,
      role: (idx === 0 ? "main" : "worker") as "main" | "worker",
      description: idx === 0 ? "主程序" : "协同伴生进程",
    }));

    const updatedDef: BusinessBundleDefinition = {
      ...currentDef,
      packageName: name.trim(),
      description: description.trim(),
      mode,
      fallback,
      processes,
      additionalExes: rawExes,
      domains: rawDomains,
    };

    onSave(updatedDef);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-2xl space-y-4 animate-in fade-in duration-150 max-h-[90vh] overflow-y-auto">
        {/* 弹窗头部 */}
        <div className="flex items-start justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shadow-inner">
              <Pencil className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                编辑规则包定义
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                修改包名称、协同进程、匹配域名及接管模式（保存为本机独立配置）
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1 rounded-lg transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 表单内容 */}
        <div className="space-y-3.5 text-xs">
          {/* 套件名称 */}
          <div>
            <label className="block font-bold text-slate-700 dark:text-slate-200 mb-1">
              规则包名称
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：OpenAI / ChatGPT 生产力套件"
              className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* 套件描述 */}
          <div>
            <label className="block font-bold text-slate-700 dark:text-slate-200 mb-1">
              功能描述
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简要说明套件包含的进程与分流策略"
              className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* 接管模式 */}
          <div>
            <label className="block font-bold text-slate-700 dark:text-slate-200 mb-1">
              路由接管模式
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setMode("strict")}
                className={`px-3 py-2 rounded-xl text-left border transition cursor-pointer ${
                  mode === "strict"
                    ? "bg-purple-500/10 border-purple-500 text-purple-700 dark:text-purple-300 font-bold"
                    : "bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400"
                }`}
              >
                <div>🔒 强锁独占</div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  已接入的进程与子进程使用所选出口
                </div>
              </button>

              <button
                type="button"
                onClick={() => setMode("sandbox")}
                className={`px-3 py-2 rounded-xl text-left border transition cursor-pointer ${
                  mode === "sandbox"
                    ? "bg-emerald-500/10 border-emerald-500 text-emerald-700 dark:text-emerald-300 font-bold"
                    : "bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400"
                }`}
              >
                <div>🌱 智能沙盒</div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  指定域名走所选出口，其余按下方策略
                </div>
              </button>
            </div>
          </div>

          {mode === "sandbox" && <div>
            <label htmlFor="bundle-fallback" className="block font-bold text-slate-700 dark:text-slate-200 mb-1">未命中域名时</label>
            <select id="bundle-fallback" value={fallback} onChange={e => setFallback(e.target.value as BundleFallback)}
              className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500">
              <option value="system">跟随系统代理开关</option>
              <option value="rules">始终沿用原规则</option>
              <option value="direct">始终直连</option>
            </select>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {fallback === "system" ? "跟随 ProcWeaver 的系统代理开关：开启时按订阅和本地规则分流，关闭时直连。命中清单的请求不受影响。" : fallback === "direct" ? "未命中清单的请求由本地核心直接连接目标，不经过代理节点。" : "未命中清单的请求始终按现有订阅和本地规则分流，与系统代理开关无关。"}
              切换影响新连接，已有连接不会自动迁移；DNS 策略单独生效。
            </p>
          </div>}

          {/* 协同进程列表 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="font-bold text-slate-700 dark:text-slate-200">
                协同进程清单 (每行一个可执行程序文件名)
              </label>
              <span className="text-[11px] text-indigo-600 dark:text-indigo-400">
                无需加路径
              </span>
            </div>
            <textarea
              rows={4}
              value={exesText}
              onChange={(e) => setExesText(e.target.value)}
              placeholder="例如：&#10;ChatGPT.exe&#10;codex.exe&#10;node.exe"
              className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* 匹配域名列表 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="font-bold text-slate-700 dark:text-slate-200">
                {mode === "sandbox" ? "独立出口域名清单" : "DNS 策略域名清单"} (可选，每行一个)
              </label>
              <span className="text-[11px] text-slate-400">*.example.com 包含根域名及子域名</span>
            </div>
            <textarea
              rows={3}
              value={domainsText}
              onChange={(e) => setDomainsText(e.target.value)}
              placeholder="例如：&#10;openai.com&#10;chatgpt.com&#10;*.oaistatic.com"
              className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {mode === "sandbox" ? "进程与域名同时命中才使用本包出口；留空则所有请求按“未命中域名时”的策略处理。" : "强锁模式不受域名清单限制；此清单仅用于核心 DNS 策略。"}
              DNS 解析与网页连接分别匹配，应用自带加密 DNS 不由此自动接管。
            </p>
          </div>
        </div>

        {/* 底部按钮栏 */}
        <div className="pt-3 flex items-center justify-between border-t border-slate-200 dark:border-slate-800">
          <div>
            {originalPreset && (
              <button
                type="button"
                onClick={handleResetToPreset}
                className="px-3 py-1.5 rounded-lg text-xs text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10 cursor-pointer transition flex items-center space-x-1"
                title="重置为预设库的原始初始定义"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>重置为预设</span>
              </button>
            )}
          </div>

          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3.5 py-1.5 rounded-lg text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 cursor-pointer transition"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-4 py-1.5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-700 text-white shadow-md hover:shadow-indigo-500/25 transition cursor-pointer flex items-center space-x-1"
            >
              <Save className="w-3.5 h-3.5" />
              <span>保存修改</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
