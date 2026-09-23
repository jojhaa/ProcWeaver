import React, { useState, useEffect, useRef } from "react";
import { SmartGroupRule, SmartGroupType } from "../types/smartGroup";
import { X, Sparkles, Check, Shield, Wifi, Search, CheckSquare, Square, ArrowUp, ArrowDown, Plus, Trash2, Link2 } from "lucide-react";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSave: (rule: SmartGroupRule) => Promise<void> | void;
  editingRule?: SmartGroupRule | null;
  allProxyNames: string[];
  fallbackOptions: string[];
  otherSmartGroupNames?: string[];
}

export const SmartGroupModal: React.FC<Props> = ({
  isOpen,
  onClose,
  onSave,
  editingRule,
  allProxyNames,
  fallbackOptions,
  otherSmartGroupNames = [],
}) => {
  const [name, setName] = useState("");
  const [type, setType] = useState<SmartGroupType>("sticky");
  // 圈选模式: 'auto' 规则圈选，'manual' 手动勾选
  const [nodeSelectionMode, setNodeSelectionMode] = useState<"auto" | "manual">("auto");
  const [manualNodes, setManualNodes] = useState<string[]>([]);
  const [manualSearch, setManualSearch] = useState("");
  const [regionPattern, setRegionPattern] = useState("");
  const [countryCode, setCountryCode] = useState<string | undefined>("US");
  const [tolerance, setTolerance] = useState<number>(80);
  const [requireResidential, setRequireResidential] = useState(false);
  const [requireNative, setRequireNative] = useState(false);
  const [maxFraudScore, setMaxFraudScore] = useState<number | undefined>(30);
  const [excludeOffline, setExcludeOffline] = useState(true);
  const [sortByLatency, setSortByLatency] = useState(true);
  // 链式中继（前置跳板与后置落地）
  const [relayEntry, setRelayEntry] = useState<string>("");
  const [relayExit, setRelayExit] = useState<string>("");
  // 多级链路型兜底方案列表
  const [fallbackChain, setFallbackChain] = useState<string[]>(["REJECT"]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const submitting = useRef(false);

  // 防抖锁：仅在弹窗刚打开瞬间或切换编辑规则时初始化表单，严禁因外部数据刷新冲掉用户刚选的地区
  const prevIsOpenRef = useRef(false);
  const prevRuleIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!isOpen) {
      prevIsOpenRef.current = false;
      return;
    }

    const ruleId = editingRule ? editingRule.id : null;
    const isJustOpened = !prevIsOpenRef.current;
    const isRuleChanged = prevRuleIdRef.current !== ruleId;

    if (isJustOpened || isRuleChanged) {
      prevIsOpenRef.current = true;
      prevRuleIdRef.current = ruleId;
      setSaveError("");
      setManualSearch("");

      if (editingRule) {
        setName(editingRule.name);
        setType(editingRule.type);
        setRelayEntry(editingRule.relayEntry || "");
        setRelayExit(editingRule.relayExit || "");
        setNodeSelectionMode(editingRule.nodeSelectionMode || "auto");
        setManualNodes(editingRule.manualNodes || []);
        setRegionPattern(editingRule.regionPattern || "");
        setCountryCode(editingRule.countryCode);
        setTolerance(editingRule.tolerance ?? 80);
        setRequireResidential(!!editingRule.requireResidential);
        setRequireNative(!!editingRule.requireNative);
        setMaxFraudScore(editingRule.maxFraudScore);
        setExcludeOffline(editingRule.excludeOffline);
        setSortByLatency(editingRule.sortByLatency);
        
        // 读取多级链路或兼容旧单个 fallbackProxy
        if (editingRule.fallbackChain && editingRule.fallbackChain.length > 0) {
          setFallbackChain([...editingRule.fallbackChain]);
        } else if (editingRule.fallbackProxy) {
          setFallbackChain([editingRule.fallbackProxy]);
        } else {
          setFallbackChain(["REJECT"]);
        }
      } else {
        // 默认新建模板：推荐极稳接力模式
        setName("🛡️ 美区极稳接力");
        setType("sticky");
        setRelayEntry(allProxyNames[0] || "");
        setRelayExit(allProxyNames[1] || allProxyNames[0] || "");
        setNodeSelectionMode("auto");
        setManualNodes([]);
        setRegionPattern("美国|US|United States");
        setCountryCode("US");
        setTolerance(80);
        setRequireResidential(false);
        setRequireNative(false);
        setMaxFraudScore(30);
        setExcludeOffline(true);
        setSortByLatency(true);
        // 默认推荐安全阻断，守住风控底线
        setFallbackChain(["REJECT"]);
      }
    }
  }, [isOpen, editingRule]);

  if (!isOpen) return null;

  // 实时估算命中候选节点数量（基于地区正则）
  const candidateCount = allProxyNames.filter((nodeName) => {
    if (regionPattern.trim()) {
      try {
        const reg = new RegExp(regionPattern.trim(), "i");
        if (!reg.test(nodeName)) return false;
      } catch {
        if (!nodeName.toLowerCase().includes(regionPattern.trim().toLowerCase())) return false;
      }
    }
    return true;
  }).length;

  const handleQuickRegion = (pat: string, label: string) => {
    setRegionPattern(pat);
    if (pat.includes("US")) setCountryCode("US");
    else if (pat.includes("HK")) setCountryCode("HK");
    else if (pat.includes("JP")) setCountryCode("JP");
    else if (pat.includes("SG")) setCountryCode("SG");
    else setCountryCode(undefined);

    if (!editingRule) {
      if (pat.includes("US")) setName("🏠 美区纯净住宅");
      else if (pat.includes("HK")) setName("⚡ 港区低延迟优选");
      else if (pat.includes("JP")) setName("🌸 日本低风控原生");
      else if (pat.includes("SG")) setName("🦁 新加坡优质节点");
      else setName(`✨ ${label}代理组`);
    }
  };

  const toggleManualNode = (node: string) => {
    setManualNodes((prev) =>
      prev.includes(node) ? prev.filter((n) => n !== node) : [...prev, node]
    );
  };

  const selectAllFiltered = (nodes: string[]) => {
    setManualNodes((prev) => Array.from(new Set([...prev, ...nodes])));
  };

  const deselectAllFiltered = (nodes: string[]) => {
    const removeSet = new Set(nodes);
    setManualNodes((prev) => prev.filter((n) => !removeSet.has(n)));
  };

  // 链路操作：添加兜底项
  const handleAddFallbackStep = () => {
    setFallbackChain((prev) => {
      // 可用备选项
      const candidates = [
        ...fallbackOptions,
        ...otherSmartGroupNames.filter((n) => n !== name.trim()),
        "DIRECT",
        "REJECT",
      ];
      // 找出当前链路尚未包含的选项，或者默认使用 DIRECT / fallbackOptions[0]
      const unused = candidates.find((c) => !prev.includes(c));
      const nextStep = unused || fallbackOptions[0] || "DIRECT";
      return [...prev, nextStep];
    });
  };

  // 链路操作：更新某级兜底项
  const handleUpdateFallbackStep = (index: number, val: string) => {
    setFallbackChain((prev) => {
      const next = [...prev];
      next[index] = val;
      return next;
    });
  };

  // 链路操作：删除某级兜底项
  const handleRemoveFallbackStep = (index: number) => {
    setFallbackChain((prev) => {
      if (prev.length <= 1) {
        // 至少保留 1 级，若删除则重置为 REJECT
        return ["REJECT"];
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  // 链路操作：上移优先级
  const handleMoveFallbackUp = (index: number) => {
    if (index === 0) return;
    setFallbackChain((prev) => {
      const next = [...prev];
      const temp = next[index - 1];
      next[index - 1] = next[index];
      next[index] = temp;
      return next;
    });
  };

  // 链路操作：下移优先级
  const handleMoveFallbackDown = (index: number) => {
    setFallbackChain((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      const temp = next[index + 1];
      next[index + 1] = next[index];
      next[index] = temp;
      return next;
    });
  };

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (submitting.current) return;
    setSaveError("");
    if (!name.trim()) {
      alert("请输入代理组名称");
      return;
    }
    if (otherSmartGroupNames.includes(name.trim()) || allProxyNames.includes(name.trim()) || ["DIRECT", "REJECT", "GLOBAL", "RULES"].includes(name.trim())) {
      setSaveError("该名称已被其他线路、节点或系统出口使用，请换一个名称。");
      return;
    }

    if (type === "relay") {
      if (!relayEntry.trim() || !relayExit.trim()) {
        alert("链式中继模式下，前置代理与后置代理均不能为空！");
        return;
      }
      if (relayEntry.trim() === relayExit.trim()) {
        alert("前置代理与后置代理不能相同，请选择不同的跳板与落地节点！");
        return;
      }
    } else {
      if (nodeSelectionMode === "manual" && manualNodes.length === 0) {
        alert("手动挑选模式下，请至少勾选 1 个节点！");
        return;
      }
    }

    const safeChain = fallbackChain.length > 0 ? fallbackChain : ["REJECT"];

    const rule: SmartGroupRule = {
      ...editingRule,
      id: editingRule ? editingRule.id : `smart_${Date.now()}`,
      name: name.trim(),
      type,
      relayEntry: type === "relay" ? relayEntry.trim() : undefined,
      relayExit: type === "relay" ? relayExit.trim() : undefined,
      nodeSelectionMode: type === "relay" ? undefined : nodeSelectionMode,
      manualNodes: type !== "relay" && nodeSelectionMode === "manual" ? manualNodes : undefined,
      regionPattern: type !== "relay" && nodeSelectionMode === "auto" ? (regionPattern.trim() || undefined) : undefined,
      countryCode: type === "relay" ? undefined : countryCode,
      tolerance: type === "url-test" ? tolerance : undefined,
      stickyCurrentNode: editingRule?.stickyCurrentNode,
      requireResidential: type === "relay" ? false : requireResidential,
      requireNative: type === "relay" ? false : requireNative,
      maxFraudScore: type === "relay" ? undefined : maxFraudScore,
      excludeOffline: type === "relay" ? false : excludeOffline,
      sortByLatency: type === "relay" ? false : sortByLatency,
      fallbackProxy: safeChain[0] || "REJECT",
      fallbackChain: safeChain,
      matchedProxies: type === "relay" ? [relayEntry.trim(), relayExit.trim()] : editingRule?.matchedProxies,
      lastEvaluatedAt: editingRule?.lastEvaluatedAt,
    };

    submitting.current = true;
    setSaving(true);
    try {
      await onSave(rule);
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="smart-group-title" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!saving) onClose(); }
      if (event.key === "Tab") {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]'))
          .filter(el => !el.matches(':disabled') && el.tabIndex >= 0 && el.getClientRects().length > 0);
        const first = controls[0], last = controls[controls.length - 1];
        if (!first) event.preventDefault();
        else if (event.shiftKey && event.target === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && event.target === last) { event.preventDefault(); first.focus(); }
      }
    }} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h3 id="smart-group-title" className="text-base font-semibold text-slate-900 dark:text-white">
                {editingRule ? "编辑代理组" : "新建代理组"}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                支持国家严格隔离、极稳接力 (不死不切) 与容差选优
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            aria-label="关闭线路编辑"
            className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Form */}
        <form id="smart-group-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <fieldset disabled={saving} className="space-y-5 min-w-0">
          {/* 代理组名称与模式 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                代理组名称 <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                autoFocus
                aria-label="代理组名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：🛡️ 美区极稳接力"
                className="w-full bg-white dark:bg-slate-800/80 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-purple-500 transition shadow-sm dark:shadow-none"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">运行模式</label>
              <select
                aria-label="运行模式"
                value={type}
                onChange={(e) => setType(e.target.value as SmartGroupType)}
                className="w-full bg-white dark:bg-slate-800/80 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-purple-500 transition shadow-sm dark:shadow-none font-medium"
              >
                <option value="sticky">🛡️ 极稳接力 (不死不切 · 会话不掉线)</option>
                <option value="url-test">⚡ 容差测速优选 (带容差防频繁跳变)</option>
                <option value="fallback">🔄 传统顺位故障转移 (fallback)</option>
                <option value="select">👆 手动自由选择 (select)</option>
                <option value="relay">🔗 链式中继 (前置跳板 + 后置落地)</option>
              </select>
            </div>
          </div>

          {/* 链式中继专属配置面板 */}
          {type === "relay" ? (
            <div className="space-y-4">
              <div className="p-3.5 bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-200/80 dark:border-indigo-800/50 rounded-2xl text-xs space-y-1.5 text-indigo-900 dark:text-indigo-200">
                <div className="font-semibold flex items-center gap-1.5 text-sm">
                  <Link2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  <span>链式双跳代理管道说明</span>
                </div>
                <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                  流量将从本地出发，先连接【前置跳板】建立中转，再由跳板连接【后置落地】出站，最后由落地节点访问目标网站。
                  两跳既可以是具体单节点，也可以是已有代理组。
                </p>
              </div>

              {/* 可视化双跳管道卡片 */}
              <div className="bg-slate-50 dark:bg-slate-800/40 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 space-y-4">
                {/* 第一跳：前置跳板 */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-slate-800 dark:text-white flex items-center gap-1.5">
                      <span className="w-5 h-5 rounded-full bg-indigo-600 text-white flex items-center justify-center text-[10px] font-bold">1</span>
                      <span>第一跳 · 前置代理 (入口跳板 / 中转)</span>
                      <span className="text-rose-500">*</span>
                    </label>
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">突破本地封锁 / IPLC专线</span>
                  </div>
                  <select
                    value={relayEntry}
                    onChange={(e) => setRelayEntry(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500 font-mono font-medium"
                  >
                    <option value="">-- 请选择前置跳板节点或策略组 --</option>
                    {otherSmartGroupNames.length > 0 && (
                      <optgroup label="自建代理组">
                        {otherSmartGroupNames
                          .filter((n) => n !== name.trim())
                          .map((n) => (
                            <option key={n} value={n}>
                              ✨ 代理组: {n}
                            </option>
                          ))}
                      </optgroup>
                    )}
                    {fallbackOptions.length > 0 && (
                      <optgroup label="订阅基础策略组">
                        {fallbackOptions.map((opt) => (
                          <option key={opt} value={opt}>
                            🌐 策略组: {opt}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="所有原始节点">
                      {allProxyNames.map((node) => (
                        <option key={node} value={node}>
                          📍 {node}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </div>

                {/* 管道连接示意 */}
                <div className="flex items-center justify-center py-1">
                  <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-indigo-100/70 dark:bg-indigo-900/40 border border-indigo-200 dark:border-indigo-700/60 text-indigo-700 dark:text-indigo-300 text-xs font-semibold shadow-inner">
                    <Link2 className="w-3.5 h-3.5 animate-pulse" />
                    <span>隧道加密直串中继 (Relay Tunnel)</span>
                    <ArrowDown className="w-3.5 h-3.5" />
                  </div>
                </div>

                {/* 第二跳：后置落地 */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-slate-800 dark:text-white flex items-center gap-1.5">
                      <span className="w-5 h-5 rounded-full bg-purple-600 text-white flex items-center justify-center text-[10px] font-bold">2</span>
                      <span>第二跳 · 后置代理 (出口落地 / 目标)</span>
                      <span className="text-rose-500">*</span>
                    </label>
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">流媒体解锁 / 原生住宅IP</span>
                  </div>
                  <select
                    value={relayExit}
                    onChange={(e) => setRelayExit(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-purple-500 font-mono font-medium"
                  >
                    <option value="">-- 请选择后置落地节点或策略组 --</option>
                    {otherSmartGroupNames.length > 0 && (
                      <optgroup label="自建代理组">
                        {otherSmartGroupNames
                          .filter((n) => n !== name.trim())
                          .map((n) => (
                            <option key={n} value={n}>
                              ✨ 代理组: {n}
                            </option>
                          ))}
                      </optgroup>
                    )}
                    {fallbackOptions.length > 0 && (
                      <optgroup label="订阅基础策略组">
                        {fallbackOptions.map((opt) => (
                          <option key={opt} value={opt}>
                            🌐 策略组: {opt}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="所有原始节点">
                      {allProxyNames.map((node) => (
                        <option key={node} value={node}>
                          📍 {node}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </div>

                {/* 校验冲突提示 */}
                {relayEntry && relayExit && relayEntry === relayExit && (
                  <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-1.5">
                    <span>⚠️ 前置跳板与后置落地不能为同一节点或组，请调整出口。</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>

          {/* 容差带设置 (仅 url-test 显示) */}
          {type === "url-test" && (
            <div className="p-3 bg-blue-50/50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900/40 rounded-xl flex items-center justify-between text-xs">
              <div className="space-y-0.5">
                <span className="font-semibold text-blue-700 dark:text-blue-300">切换容差带 (Tolerance)</span>
                <p className="text-slate-500 dark:text-slate-400">只有当新节点比当前节点快指定毫秒以上时才切换，杜绝微小延迟波动频繁换 IP</p>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min="0"
                  max="500"
                  step="10"
                  value={tolerance}
                  onChange={(e) => setTolerance(parseInt(e.target.value) || 0)}
                  className="w-20 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg px-2 py-1 text-right text-sm"
                />
                <span className="text-slate-500">ms</span>
              </div>
            </div>
          )}

          {/* 极稳接力提示 */}
          {type === "sticky" && (
            <div className="p-3 bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 rounded-xl text-xs space-y-1 text-amber-800 dark:text-amber-200">
              <div className="font-semibold flex items-center gap-1">
                <span>🛡️ 极稳模式特性说明</span>
              </div>
              <p className="text-slate-600 dark:text-slate-400">
                始终固定在当前节点。只有当该节点彻底超时断连时，才自动顺延切到同国下一个节点并保持，原节点恢复后绝不回跳，保障 AI、远程桌面与金融交易会话持续。
              </p>
            </div>
          )}

          {/* 节点圈选方式切换 */}
          <div className="bg-slate-50 dark:bg-slate-800/40 p-1 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setNodeSelectionMode("auto")}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1.5 ${
                nodeSelectionMode === "auto"
                  ? "bg-white dark:bg-slate-800 text-purple-600 dark:text-purple-400 shadow-sm border border-slate-200 dark:border-slate-700"
                  : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              }`}
            >
              <Wifi className="w-3.5 h-3.5" />
              <span>按条件规则自动圈选</span>
            </button>
            <button
              type="button"
              onClick={() => setNodeSelectionMode("manual")}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1.5 ${
                nodeSelectionMode === "manual"
                  ? "bg-white dark:bg-slate-800 text-purple-600 dark:text-purple-400 shadow-sm border border-slate-200 dark:border-slate-700"
                  : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              }`}
            >
              <CheckSquare className="w-3.5 h-3.5" />
              <span>从节点池手动自选勾选 ({manualNodes.length})</span>
            </button>
          </div>

          {/* 手动勾选模式面板 */}
          {nodeSelectionMode === "manual" && (
            <div className="bg-slate-50 dark:bg-slate-800/40 p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                    勾选加入本代理组的节点:
                  </span>
                  <span className="text-xs font-mono text-purple-600 dark:text-purple-400 font-semibold bg-purple-50 dark:bg-purple-500/10 px-2 py-0.5 rounded border border-purple-200 dark:border-purple-500/20">
                    已选 {manualNodes.length} / 共 {allProxyNames.length} 个
                  </span>
                </div>

                {/* 搜索与批量操作 */}
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="w-3 h-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      value={manualSearch}
                      onChange={(e) => setManualSearch(e.target.value)}
                      placeholder="搜索节点..."
                      className="pl-7 pr-2 py-1 text-xs rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 w-32 focus:outline-none focus:border-purple-500"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const filtered = allProxyNames.filter((n) =>
                        manualSearch ? n.toLowerCase().includes(manualSearch.toLowerCase()) : true
                      );
                      selectAllFiltered(filtered);
                    }}
                    className="text-[11px] px-2 py-1 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:text-purple-600 dark:hover:text-purple-400 transition"
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const filtered = allProxyNames.filter((n) =>
                        manualSearch ? n.toLowerCase().includes(manualSearch.toLowerCase()) : true
                      );
                      deselectAllFiltered(filtered);
                    }}
                    className="text-[11px] px-2 py-1 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:text-rose-600 dark:hover:text-rose-400 transition"
                  >
                    清空
                  </button>
                </div>
              </div>

              {/* 节点多选滚动区域 */}
              <div className="max-h-60 overflow-y-auto space-y-1.5 pr-1 border border-slate-200 dark:border-slate-700/80 rounded-xl p-2 bg-white dark:bg-slate-900/60">
                {allProxyNames
                  .filter((n) => (manualSearch ? n.toLowerCase().includes(manualSearch.toLowerCase()) : true))
                  .map((name) => {
                    const checked = manualNodes.includes(name);
                    return (
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        aria-label={name}
                        key={name}
                        onClick={() => toggleManualNode(name)}
                        className={`w-full text-left p-2 rounded-lg border transition cursor-pointer flex items-center justify-between gap-2 text-xs ${
                          checked
                            ? "bg-purple-50/80 dark:bg-purple-950/40 border-purple-300 dark:border-purple-500/50 text-purple-900 dark:text-purple-200 font-medium"
                            : "bg-slate-50/50 dark:bg-slate-800/40 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {checked ? (
                            <CheckSquare className="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />
                          ) : (
                            <Square className="w-4 h-4 text-slate-400 shrink-0" />
                          )}
                          <span className="truncate" title={name}>
                            {name}
                          </span>
                        </div>
                      </button>
                    );
                  })}
              </div>
            </div>
          )}

          {/* 自动筛选模式面板 */}
          {nodeSelectionMode === "auto" && (
            <>
              {/* 地区前置范围 */}
              <div className="bg-slate-50 dark:bg-slate-800/40 p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-2.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                    <Wifi className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
                    候选地区前置匹配 (缩小探测范围)
                  </label>
                  <span className="text-xs text-purple-600 dark:text-purple-400 font-medium">
                    预估命中: {candidateCount} 个候选节点
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  {[
                    { label: "🇺🇸 美国", pat: "美国|US|United States" },
                    { label: "🇭🇰 香港", pat: "香港|HK|Hong Kong" },
                    { label: "🇯🇵 日本", pat: "日本|JP|Japan" },
                    { label: "🇸🇬 新加坡", pat: "新加坡|SG|Singapore" },
                    { label: "🌐 全部地区", pat: "" },
                  ].map((item) => (
                    <button
                      key={item.pat}
                      type="button"
                      onClick={() => handleQuickRegion(item.pat, item.label)}
                      className={`text-xs px-2.5 py-1 rounded-lg border transition ${
                        regionPattern === item.pat
                          ? "bg-purple-100 border-purple-300 text-purple-700 dark:bg-purple-500/20 dark:border-purple-500/60 dark:text-purple-300 font-medium"
                          : "bg-white border-slate-200 text-slate-600 hover:text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={regionPattern}
                  onChange={(e) => setRegionPattern(e.target.value)}
                  placeholder="支持正则或多关键字，如：美国|US|洛杉矶"
                  className="w-full bg-white dark:bg-slate-800/80 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-purple-500 transition shadow-sm dark:shadow-none"
                />
              </div>
            </>
          )}

          {/* IP 健康出口与风控要求 */}
          <div className="bg-slate-50 dark:bg-slate-800/40 p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3">
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
              IP 出口物理属性与健康纯净度 (IPPure 检测)
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              {/* 仅限住宅 IP */}
              <label className="flex items-center gap-2.5 p-2.5 rounded-xl bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-750 transition shadow-sm dark:shadow-none">
                <input
                  type="checkbox"
                  checked={requireResidential}
                  onChange={(e) => setRequireResidential(e.target.checked)}
                  className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500 bg-white border-slate-300 dark:bg-slate-700 dark:border-slate-600"
                />
                <div>
                  <div className="text-xs font-medium text-slate-800 dark:text-slate-200">仅限住宅宽带 IP</div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">排除机房 Hosting/DC IP</div>
                </div>
              </label>

              {/* 仅限原生 IP */}
              <label className="flex items-center gap-2.5 p-2.5 rounded-xl bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-750 transition shadow-sm dark:shadow-none">
                <input
                  type="checkbox"
                  checked={requireNative}
                  onChange={(e) => setRequireNative(e.target.checked)}
                  className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500 bg-white border-slate-300 dark:bg-slate-700 dark:border-slate-600"
                />
                <div>
                  <div className="text-xs font-medium text-slate-800 dark:text-slate-200">仅限原生出口</div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">排除广播或 Anycast IP</div>
                </div>
              </label>
            </div>

            {/* 风控纯净度分数 */}
            <div className="pt-1">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-slate-700 dark:text-slate-300">欺诈风控分上限 (越低越纯净)：</span>
                <span className="font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
                  {maxFraudScore === undefined ? "不限制" : `≤ ${maxFraudScore} 分`}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="5"
                  max="80"
                  step="5"
                  value={maxFraudScore ?? 80}
                  onChange={(e) => setMaxFraudScore(parseInt(e.target.value))}
                  className="flex-1 accent-emerald-500"
                />
                <button
                  type="button"
                  onClick={() => setMaxFraudScore(undefined)}
                  className="text-[11px] text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white px-2 py-1 bg-white border border-slate-200 dark:bg-slate-800 dark:border-slate-700 rounded transition shadow-sm dark:shadow-none"
                >
                  不设限
                </button>
              </div>
              <div className="flex justify-between text-[10px] text-slate-400 dark:text-slate-500 mt-1">
                <span>≤15 (极度纯净/过一切风控)</span>
                <span>≤30 (常规纯净)</span>
                <span>≤50 (宽松)</span>
              </div>
            </div>
          </div>

          {/* 性能与排序优化 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex items-center gap-2.5 p-3 rounded-xl bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/80 transition shadow-sm dark:shadow-none">
              <input
                type="checkbox"
                checked={excludeOffline}
                onChange={(e) => setExcludeOffline(e.target.checked)}
                className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500 bg-white border-slate-300 dark:bg-slate-700 dark:border-slate-600"
              />
              <div>
                <div className="text-xs font-medium text-slate-800 dark:text-slate-200">排除测速离线节点</div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400">超时或不可达节点自动剔除</div>
              </div>
            </label>

            <label className="flex items-center gap-2.5 p-3 rounded-xl bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/80 transition shadow-sm dark:shadow-none">
              <input
                type="checkbox"
                checked={sortByLatency}
                onChange={(e) => setSortByLatency(e.target.checked)}
                className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500 bg-white border-slate-300 dark:bg-slate-700 dark:border-slate-600"
              />
              <div>
                <div className="text-xs font-medium text-slate-800 dark:text-slate-200">按真实延迟升序排序</div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400">Ping 优秀低延迟优先置顶</div>
              </div>
            </label>
          </div>

          {/* 多级链路型兜底方案 (按顺位回退) */}
          <div className="bg-slate-50 dark:bg-slate-800/40 p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200/80 dark:border-slate-700/80 pb-2">
              <div>
                <label className="text-xs font-bold text-slate-800 dark:text-white flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                  多级链路型安全兜底方案 (按顺位依次故障转移)
                </label>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  当本组节点全部离线或不满足条件时，按设定顺序向下回退接管
                </p>
              </div>

              {/* 快捷推荐模板 */}
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-slate-400">预设:</span>
                <button
                  type="button"
                  onClick={() => setFallbackChain(["REJECT"])}
                  className="px-2 py-0.5 rounded text-[10px] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition font-medium"
                  title="仅限当前业务安全阻断，绝不向外暴露真实 IP"
                >
                  🛡️ 纯粹阻断
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const fallbackGrp = fallbackOptions[0] || "DIRECT";
                    setFallbackChain([fallbackGrp, "REJECT"]);
                  }}
                  className="px-2 py-0.5 rounded text-[10px] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/30 transition font-medium"
                  title="先尝试回退其他代理组/节点选择，最终安全阻断"
                >
                  🌐 代理回退+阻断
                </button>
                <button
                  type="button"
                  onClick={() => setFallbackChain(["DIRECT"])}
                  className="px-2 py-0.5 rounded text-[10px] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition font-medium"
                  title="直接走本机宽带直连（不防 IP 泄漏）"
                >
                  ⚡ 全球直连
                </button>
              </div>
            </div>

            {/* 链路顺位列表 */}
            <div className="space-y-2">
              {/* 第 0 顺位：本代理组节点（固定） */}
              <div className="flex items-center justify-between p-2.5 rounded-xl bg-purple-50/70 dark:bg-purple-950/30 border border-purple-200/80 dark:border-purple-500/30 text-xs text-purple-900 dark:text-purple-200">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-purple-600 text-white flex items-center justify-center text-[10px] font-bold shrink-0">
                    1
                  </span>
                  <span className="font-semibold">【第 1 顺位 · 主出站】</span>
                  <span className="text-purple-700/80 dark:text-purple-300/80 text-[11px]">
                    本代理组筛选或选中的目标节点池
                  </span>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300 border border-purple-200 dark:border-purple-500/30">
                  首选主力
                </span>
              </div>

              {/* 后续各级顺位 */}
              {fallbackChain.map((step, idx) => {
                const stepNum = idx + 2;

                return (
                  <div
                    key={idx}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700 text-xs shadow-sm"
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="w-5 h-5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 flex items-center justify-center text-[10px] font-bold shrink-0">
                        {stepNum}
                      </span>
                      <span className="font-semibold text-slate-700 dark:text-slate-200 shrink-0">
                        第 {stepNum} 顺位:
                      </span>

                      {/* 目标选择下拉框 */}
                      <select
                        value={step}
                        onChange={(e) => handleUpdateFallbackStep(idx, e.target.value)}
                        className="flex-1 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-800 dark:text-slate-200 font-medium focus:outline-none focus:border-purple-500"
                      >
                        <optgroup label="核心动作">
                          <option value="REJECT">
                            🛡️ 安全阻断 REJECT（仅阻断本业务，绝不泄漏国内真实 IP）
                          </option>
                          <option value="DIRECT">
                            ⚡ 全球直连 DIRECT（直接走物理宽带，保畅通不防泄漏）
                          </option>
                        </optgroup>

                        {otherSmartGroupNames.length > 0 && (
                          <optgroup label="其他自建代理组">
                            {otherSmartGroupNames
                              .filter((n) => n !== name.trim())
                              .map((n) => (
                                <option key={n} value={n}>
                                  ✨ 回退至代理组: {n}
                                </option>
                              ))}
                          </optgroup>
                        )}

                        <optgroup label="订阅基础策略组">
                          {fallbackOptions.map((opt) => (
                            <option key={opt} value={opt}>
                              🌐 回退至基础组: {opt}
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    </div>

                    {/* 操作按钮：上移、下移、删除 */}
                    <div className="flex items-center gap-1 self-end sm:self-auto shrink-0">
                      <button
                        type="button"
                        onClick={() => handleMoveFallbackUp(idx)}
                        disabled={idx === 0}
                        className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-white disabled:opacity-30 transition"
                        title="提升优先级"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMoveFallbackDown(idx)}
                        disabled={idx === fallbackChain.length - 1}
                        className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-white disabled:opacity-30 transition"
                        title="降低优先级"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveFallbackStep(idx)}
                        className="p-1 rounded text-slate-400 hover:text-rose-600 transition"
                        title="删除该兜底级别"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 增加顺位级别按钮 */}
            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                onClick={handleAddFallbackStep}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-dashed border-purple-300 dark:border-purple-600/60 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/30 text-xs transition"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>+ 增加下一级兜底顺位</span>
              </button>

              <span className="text-[10px] text-slate-400">
                可自由多选、调整顺位次序与兜底行为
              </span>
            </div>
          </div>
          </>
          )}
          </fieldset>
        </form>

        {saveError && <div role="alert" className="px-6 py-2 text-xs text-rose-600 dark:text-rose-400 break-words">{saveError}</div>}

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/90 dark:bg-slate-900/90 flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 rounded-xl text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-800 transition"
          >
            取消
          </button>
          <button
            type="submit"
            form="smart-group-form"
            disabled={saving}
            className="px-5 py-2 rounded-xl text-xs font-medium text-white bg-purple-600 hover:bg-purple-500 shadow-lg shadow-purple-600/30 transition flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            {saving ? "正在保存并应用…" : "保存并应用规则"}
          </button>
        </div>
      </div>
    </div>
  );
};
