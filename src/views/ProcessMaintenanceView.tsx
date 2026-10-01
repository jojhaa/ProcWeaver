import { useProcessUpdate } from "../hooks/useProcessUpdate";
import { version } from "../../package.json";
export function ProcessMaintenanceView() {
  const state = useProcessUpdate();
  return <section className="max-w-2xl mx-auto p-5 space-y-5 text-sm">
    <h2 className="text-lg font-bold">独立进程版 · 版本维护</h2>
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
      <p>ProcWeaver Process <strong>V{version}</strong></p>
      <p className="text-xs text-slate-500">更新仅匹配独立进程版便携包。下载后正常退出进程版，解压到新的文件夹，按需迁移 process-data；请保留旧目录用于回退。</p>
      <button disabled={state.busy} onClick={() => void state.check()} className="px-4 py-2 rounded-xl bg-indigo-600 text-white disabled:opacity-50">{state.busy ? "处理中…" : "检查进程版更新"}</button>
      {state.error && <p role="alert" className="text-red-600">{state.error}</p>}
      {state.info && <div role="status" className="space-y-3">
        <p>{!state.info.assetName ? "发布列表中暂无独立进程版便携包" : state.info.hasUpdate ? `发现 ${state.info.latestVersion}` : `暂无更高版本（当前 V${version}）`}</p>
        {state.info.assetName && <><p className="break-all text-xs">{state.info.assetName} · {state.info.assetSizeFormatted}</p>
          <button disabled={state.busy} onClick={() => void state.download()} className="px-4 py-2 border rounded-xl disabled:opacity-50">下载独立便携包</button>
          <pre className="whitespace-pre-wrap break-words text-xs max-h-64 overflow-auto">{state.info.releaseNotes}</pre></>}
      </div>}
      {state.path && <div role="status" className="space-y-2"><p>下载完成。文件位置：</p><input aria-label="更新包位置" readOnly value={state.path} onFocus={e => e.target.select()} className="w-full p-2 border rounded-lg bg-transparent" /></div>}
    </div>
  </section>;
}
