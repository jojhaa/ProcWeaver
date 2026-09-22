import React from "react";
import { BundleLocalInstance } from "../../types/businessBundle";
import { exportBundlePackage } from "../../services/bundleStorage";
import { Upload, X, ShieldCheck, Download } from "lucide-react";

interface Props {
  isOpen: boolean;
  instance: BundleLocalInstance | null;
  onClose: () => void;
}

export const ExportBundleModal: React.FC<Props> = ({ isOpen, instance, onClose }) => {
  if (!isOpen || !instance) return null;

  const def = instance.definition;

  const handleDownload = () => {
    const exportedData = exportBundlePackage(instance);
    const jsonString = JSON.stringify(exportedData, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${def.packageName.replace(/[\/\\:*?"<>|]/g, "_")}.pwpack.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700/80 rounded-3xl p-6 shadow-2xl space-y-4 animate-in fade-in duration-150">
        
        {/* 标题 */}
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
          <div className="flex items-center space-x-2">
            <Upload className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
            <h3 className="text-base font-bold text-slate-900 dark:text-white">导出纯净脱敏规则包</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1 rounded-lg transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 脱敏安全保障说明 */}
        <div className="p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 space-y-2 text-xs">
          <div className="flex items-center space-x-2 text-emerald-600 dark:text-emerald-400 font-bold">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>白名单安全脱敏已生效</span>
          </div>
          <p className="text-[11px] text-emerald-700/90 dark:text-emerald-300/80 leading-relaxed">
            系统已自动剥离您当前绑定的私有出口节点名称、策略组身份、订阅凭据及连接历史。导出的文件仅包含纯粹的程序匹配拓扑与抽象插槽定义，可安全分享给他人。
          </p>
        </div>

        {/* 规则包概览 */}
        <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/90 border border-slate-200 dark:border-slate-800 text-xs space-y-1.5">
          <div className="font-bold text-slate-900 dark:text-white flex items-center space-x-1.5">
            <span>{def.icon}</span>
            <span>{def.packageName}</span>
            <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700">
              {def.packageVersion}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            包含 {def.processes.length} 个协同进程 · {def.domains?.length || 0} 个匹配域名
          </p>
        </div>

        {/* 动作区 */}
        <div className="pt-2 flex items-center justify-end space-x-2 border-t border-slate-200 dark:border-slate-800 text-xs">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-xl text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="px-4 py-1.5 rounded-xl font-bold bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer transition shadow-md flex items-center space-x-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            <span>下载 .pwpack.json</span>
          </button>
        </div>

      </div>
    </div>
  );
};
