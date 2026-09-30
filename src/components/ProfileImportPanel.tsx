import type { useProfileImport } from "../hooks/useProfileImport";

export function ProfileImportPanel({ mobile, state }: { mobile: boolean; state: ReturnType<typeof useProfileImport> }) {
  return <section aria-label="导入配置" className="rounded-xl border p-4 space-y-3">
    <div className="flex flex-wrap gap-2">
      {mobile ? <><button disabled={state.busy} className="rounded-lg border p-3" onClick={() => void state.receive("readDocument")}>导入 YAML 文件</button>
        <button disabled={state.busy} className="rounded-lg border p-3" onClick={() => void state.receive("scanQr")}>扫描二维码</button>
        <button disabled={state.busy} className="rounded-lg border p-3" onClick={() => void state.receive("readQrImage")}>识别二维码图片</button></>
        : <label className="rounded-lg border p-3 cursor-pointer">导入 YAML 文件<input type="file" accept=".yaml,.yml,text/yaml,application/x-yaml" className="sr-only" disabled={state.busy} onChange={e => { void state.file(e.target.files?.[0]); e.target.value=""; }} /></label>}
    </div>
    {state.content && <div className="space-y-3">
      <label className="block">配置名称<input className="block w-full rounded-lg border bg-transparent p-3" value={state.name} onChange={e => state.setName(e.target.value)} maxLength={240} disabled={state.busy} /></label>
      <p className="text-xs text-slate-500">{mobile ? "首次导入会选为当前订阅，不会自动启动 VPN；已有订阅时不切换。" : "请确认来源。订阅链接会在确认后下载，YAML 导入不会切换当前配置。"}</p>
      <textarea aria-label="待导入内容" rows={4} className="w-full rounded-lg border bg-transparent p-3 font-mono text-xs" value={state.content} onChange={e => state.setContent(e.target.value)} disabled={state.busy} />
      <div className="flex gap-3"><button className="rounded-lg bg-indigo-600 text-white p-3" disabled={state.busy || !state.name.trim()} onClick={() => void state.confirm()}>{state.busy ? "正在导入…" : "确认导入"}</button><button disabled={state.busy} onClick={() => state.setContent("")}>取消</button></div>
    </div>}
    {state.message && <p role="status" className="text-sm break-all">{state.message}</p>}
  </section>;
}
