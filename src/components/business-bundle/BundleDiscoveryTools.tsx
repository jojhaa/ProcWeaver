import { useMemo, useState } from "react";
import { FolderTree, Globe, X } from "lucide-react";
import { ProcessDiscoveryDialog } from "./ProcessDiscoveryDialog";
import { matchingBindings, processKey, processMembers, processNames, validateProcessBindings } from "../../utils/bundlePlatform";
import type { BundleProcessBinding, BundleProcessMember } from "../../types/businessBundle";
import type { BundlePlatform } from "../../types/platform";

interface Props {
  platform: BundlePlatform; bundleId?: string; exesText: string; domainsText: string;
  bindings: BundleProcessBinding[]; members?: BundleProcessMember[];
  onProcesses: (text: string, bindings: BundleProcessBinding[]) => void;
  onDomains: (text: string) => void;
}
export function BundleDiscoveryTools(props: Props) {
  const [dialog, setDialog] = useState<"processes" | "domains" | null>(null);
  const [error, setError] = useState("");
  const names = processNames(props.exesText);
  const bindings = matchingBindings(props.bindings, names, props.platform);
  const input = useMemo(() => ({ platform: props.platform, bundleId: props.bundleId,
    members: processMembers(processNames(props.exesText), props.members ?? [], props.bindings, props.platform),
    bindings: matchingBindings(props.bindings, processNames(props.exesText), props.platform),
  }), [props.platform, props.bundleId, props.exesText, props.bindings, props.members]);
  const addProcesses = (items: BundleProcessBinding[]) => {
    try {
      const merged = new Map(bindings.map(b => [processKey(b.executablePath, props.platform), b]));
      for (const b of items) merged.set(processKey(b.executablePath, props.platform), b);
      const next = [...merged.values()]; validateProcessBindings(next, props.platform);
      const namesByKey = new Map(names.map(n => [processKey(n, props.platform), n]));
      for (const b of items) namesByKey.set(processKey(b.exe, props.platform), b.exe);
      props.onProcesses([...namesByKey.values()].join("\n"), next); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "进程选择无效"); }
  };
  return <div className="space-y-2 mt-2">
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => setDialog("processes")} className="px-3 py-1.5 rounded-lg border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-300 flex items-center gap-1.5 hover:bg-indigo-50 dark:hover:bg-indigo-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"><FolderTree size={14} />从运行进程选择</button>
      <button type="button" disabled={!names.length} onClick={() => setDialog("domains")} className="px-3 py-1.5 rounded-lg border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-300 flex items-center gap-1.5 disabled:opacity-50 hover:bg-indigo-50 dark:hover:bg-indigo-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"><Globe size={14} />检测已连接域名</button>
    </div>
    {error && <p role="alert" className="text-amber-700 dark:text-amber-300">{error}</p>}
    {bindings.length > 0 && <div className="space-y-1 max-h-36 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 p-2">
      <p className="text-[11px] text-slate-500 dark:text-slate-400">以下程序按本机路径匹配；手动输入且未绑定的程序仍按名称匹配。导出仅保留名称与继承选项。</p>
      {bindings.map(b => <div key={processKey(b.executablePath, props.platform)} className="flex flex-wrap items-center gap-2 py-1">
        <span className="truncate flex-1 min-w-0 basis-40 font-mono text-[11px]" title={b.executablePath}>{b.executablePath}</span>
        <label className="flex items-center gap-1 text-[11px]"><input type="checkbox" checked={b.includeDescendants} onChange={e => props.onProcesses(props.exesText, bindings.map(item => item === b ? { ...item, includeDescendants: e.target.checked } : item))} />包含子进程</label>
        <button type="button" className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800" aria-label={`移除程序 ${b.executablePath}`} onClick={() => {
          const next = bindings.filter(item => item !== b);
          const remainingNames = next.some(item => processKey(item.exe, props.platform) === processKey(b.exe, props.platform)) ? names : names.filter(name => processKey(name, props.platform) !== processKey(b.exe, props.platform));
          props.onProcesses(remainingNames.join("\n"), next);
        }}><X size={13} /></button>
      </div>)}
    </div>}
    {dialog && <ProcessDiscoveryDialog mode={dialog} input={input} onClose={() => setDialog(null)} onProcesses={addProcesses} onDomains={items => props.onDomains([...new Set([...processNames(props.domainsText).map(s => s.toLowerCase()), ...items])].join("\n"))} />}
  </div>;
}
