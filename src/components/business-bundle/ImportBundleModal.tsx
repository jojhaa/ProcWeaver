import React, { useState, useRef } from "react";
import { BusinessBundleDefinition } from "../../types/businessBundle";
import { validateAndParseBundlePackage } from "../../services/bundleStorage";
import { Download, X, Upload, CheckCircle2, AlertCircle } from "lucide-react";

interface Props {
  isOpen: boolean;
  availableProxies: string[];
  onConfirm: (bundle: BusinessBundleDefinition, autoEnable: boolean, boundNode: string | null) => void;
  onCancel: () => void;
}

export const ImportBundleModal: React.FC<Props> = ({
  isOpen,
  availableProxies,
  onConfirm,
  onCancel,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsedBundle, setParsedBundle] = useState<BusinessBundleDefinition | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [selectedNode, setSelectedNode] = useState("");

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      const res = validateAndParseBundlePackage(content);
      if (res.valid && res.bundle) {
        setParsedBundle(res.bundle);
        setErrorMsg("");
      } else {
        setParsedBundle(null);
        setErrorMsg(res.error || "解析规则包失败");
      }
    };
    reader.readAsText(file);
  };

  const handleClose = () => {
    setParsedBundle(null);
    setErrorMsg("");
    setSelectedNode("");
    onCancel();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700/80 rounded-3xl p-6 shadow-2xl space-y-4 animate-in fade-in duration-150">
        
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
          <div className="flex items-center space-x-2">
            <Download className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
            <h3 className="text-base font-bold text-slate-900 dark:text-white">业务规则包导入向导</h3>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1 rounded-lg transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 文件选取区 */}
        <div className="space-y-3 text-xs">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.pwpack.json"
            onChange={handleFileChange}
            className="hidden"
          />

          {!parsedBundle && (
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-slate-300 hover:border-indigo-500 dark:border-slate-700 dark:hover:border-indigo-500 rounded-2xl p-6 flex flex-col items-center justify-center space-y-2 cursor-pointer bg-slate-50 hover:bg-slate-100 dark:bg-slate-950/40 dark:hover:bg-slate-950/80 transition"
            >
              <Upload className="w-8 h-8 text-indigo-500 dark:text-indigo-400" />
              <div className="text-slate-700 dark:text-slate-300 font-medium">点击选择本地 .pwpack.json 规则包文件</div>
              <div className="text-[11px] text-slate-400 dark:text-slate-500">或直接将文件拖拽至此区域</div>
            </div>
          )}

          {errorMsg && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-300 text-xs flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-500 dark:text-red-400" />
              <span>{errorMsg}</span>
            </div>
          )}

          {parsedBundle && (
            <div className="space-y-3">
              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/90 border border-slate-200 dark:border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className="text-xl">{parsedBundle.icon}</span>
                    <span className="font-bold text-slate-900 dark:text-white text-sm">{parsedBundle.packageName}</span>
                    <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700">
                      {parsedBundle.packageVersion}
                    </span>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 flex items-center space-x-1">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>脱敏校验通过</span>
                  </span>
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">{parsedBundle.description}</p>
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  {parsedBundle.processes.map((p) => (
                    <span
                      key={p.exe}
                      className="px-2 py-0.5 rounded text-[10px] font-mono bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:border-indigo-500/20"
                    >
                      {p.exe}
                    </span>
                  ))}
                </div>
              </div>

              {/* 出口插槽分配 (可选) */}
              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300">
                  为该套件分配主业务出口节点（可选）：
                </label>
                <select
                  value={selectedNode}
                  onChange={(e) => setSelectedNode(e.target.value)}
                  className="w-full bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 hover:border-indigo-500 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white cursor-pointer focus:outline-none shadow-2xs"
                >
                  <option value="">暂不分配（导入后默认停用，跟随系统默认网络）</option>
                  {availableProxies.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  💡 提示：若不选择节点，规则包将以【已停用】状态导入，软件正常走系统默认网络，完全零干扰；后续随时点击开启即可指定节点。
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 底部动作按钮 */}
        <div className="pt-3 flex items-center justify-between border-t border-slate-200 dark:border-slate-800 text-xs">
          <button
            type="button"
            onClick={handleClose}
            className="px-3.5 py-1.5 rounded-xl text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 cursor-pointer"
          >
            取消
          </button>

          {parsedBundle ? (
            <div className="flex items-center space-x-2">
              <button
                type="button"
                onClick={() => {
                  onConfirm(parsedBundle, false, null);
                  handleClose();
                }}
                className="px-3.5 py-1.5 rounded-xl font-medium bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-750 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 cursor-pointer transition shadow-2xs"
              >
                仅导入 (保持停用)
              </button>
              <button
                type="button"
                disabled={!selectedNode}
                onClick={() => {
                  onConfirm(parsedBundle, true, selectedNode);
                  handleClose();
                }}
                className="px-4 py-1.5 rounded-xl font-bold bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer transition shadow-md disabled:opacity-50"
              >
                导入并立即开启
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-1.5 rounded-xl font-bold bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer transition shadow-md"
            >
              浏览文件...
            </button>
          )}
        </div>

      </div>
    </div>
  );
};
