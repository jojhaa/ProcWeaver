import React, { useState, useEffect } from "react";
import { BundleLocalInstance } from "../../types/businessBundle";
import { Lightbulb, X, Check } from "lucide-react";

interface Props {
  isOpen: boolean;
  bundleInstance: BundleLocalInstance | null;
  availableProxies: string[];
  proxyLabels?: Record<string, string>;
  onConfirm: (selectedNode: string) => void;
  onCancel: () => void;
}

export const QuickBindModal: React.FC<Props> = ({
  isOpen,
  bundleInstance,
  availableProxies,
  proxyLabels = {},
  onConfirm,
  onCancel,
}) => {
  const [selectedNode, setSelectedNode] = useState<string>("");

  useEffect(() => {
    if (availableProxies.length > 0) {
      // 默认优先挑选低延迟节点或第一个节点
      setSelectedNode(availableProxies[0]);
    }
  }, [availableProxies, isOpen]);

  if (!isOpen || !bundleInstance) return null;

  const def = bundleInstance.definition;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700/80 rounded-2xl p-5 shadow-2xl space-y-4 animate-in fade-in duration-150">
        
        {/* 弹窗头部 */}
        <div className="flex items-start justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-lg shadow-inner">
              <Lightbulb className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">指定出口节点并开启套件</h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">开启后将强锁专属通道，杜绝跨国异地风控</p>
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

        {/* 状态与机制说明 */}
        <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/80 border border-slate-200 dark:border-slate-800 text-xs space-y-1">
          <div className="flex items-center justify-between text-slate-700 dark:text-slate-300">
            <span className="font-bold text-slate-900 dark:text-white flex items-center space-x-1.5">
              <span>{def.icon}</span>
              <span>{def.packageName}</span>
            </span>
            <span className="text-[11px] text-slate-500 dark:text-slate-400">当前：已停用 (跟随系统默认)</span>
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 pt-1 leading-relaxed">
            当前套件不干预网络。开启后，包内全套协同进程（包含核心语言服务、伴生模块）将脱离系统默认，强锁至指定的独立节点。
          </p>
        </div>

        {/* 节点选择 */}
        <div className="space-y-1.5">
          <label className="block text-xs font-bold text-slate-700 dark:text-slate-200">
            请选择要绑定的主业务出口节点：
          </label>
          <select
            value={selectedNode}
            onChange={(e) => setSelectedNode(e.target.value)}
            className="w-full bg-white dark:bg-slate-950 border-2 border-indigo-500/90 hover:border-indigo-500 rounded-xl px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400 font-bold focus:outline-none cursor-pointer shadow-2xs"
          >
            {availableProxies.length === 0 ? (
              <option value="" disabled>
                ⚠️ 暂无可用出站节点，请先配置订阅或核心代理
              </option>
            ) : (
              availableProxies.map((node) => (
                <option key={node} value={node}>
                  {proxyLabels[node] || node}
                </option>
              ))
            )}
          </select>
        </div>

        {/* 底部动作按钮 */}
        <div className="pt-2 flex items-center justify-end space-x-2 border-t border-slate-200 dark:border-slate-800">
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-1.5 rounded-lg text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 cursor-pointer transition"
          >
            取消 (保持停用)
          </button>
          <button
            type="button"
            disabled={!selectedNode}
            onClick={() => onConfirm(selectedNode)}
            className="px-4 py-1.5 rounded-lg text-xs font-bold bg-gradient-to-r from-emerald-500 to-teal-600 hover:opacity-95 text-white shadow-md cursor-pointer transition disabled:opacity-50 flex items-center space-x-1"
          >
            <Check className="w-3.5 h-3.5 mr-1" />
            <span>确定并开启套件</span>
          </button>
        </div>

      </div>
    </div>
  );
};
