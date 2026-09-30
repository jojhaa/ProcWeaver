import type { useConfigTransfer } from "../hooks/useConfigTransfer";
export function ConfigTransferPanel({ state, mobile }: { state: ReturnType<typeof useConfigTransfer>; mobile: boolean }) {
  const field="w-full rounded-lg border bg-transparent p-3";
  return <section aria-label="备份与多端同步" className="rounded-2xl border p-4 space-y-4">
    <h2 className="font-semibold">备份与多端同步</h2>
    <p className="text-xs text-slate-500">{mobile ? "包含设置、订阅、本地节点与应用分流，导出前加密。" : "包含设置、订阅、节点、规则与业务包绑定，导出前加密。"}离线规则数据库、设备系统恢复记录和运行日志不进入备份。密码仅在本次页面中使用，遗失后无法恢复。</p>
    <fieldset disabled={state.busy} className="space-y-3">
      <label className="block">备份密码<input type="password" autoComplete="new-password" className={field} value={state.password} onChange={e => state.setPassword(e.target.value)} placeholder="至少 12 个字符，多端使用相同密码" /></label>
      <div className="flex flex-wrap gap-2"><button className="rounded-lg border p-3" onClick={() => void state.exportFile()}>导出加密备份</button>
        {mobile ? <button className="rounded-lg border p-3" onClick={() => void state.selectNative()}>读取备份文件</button>
          : <label className="rounded-lg border p-3 cursor-pointer">读取备份文件<input className="sr-only" type="file" accept=".json" disabled={state.busy} onChange={e => { void state.selectFile(e.target.files?.[0]); e.target.value=""; }} /></label>}
      </div>
      <details className="space-y-3"><summary className="cursor-pointer py-2">配置 WebDAV 同步</summary>
        <p className="text-xs text-slate-500">填写已存在目录中的完整 HTTPS 文件地址。手动上传／下载；远端变更时拒绝覆盖，先下载预览再决定取舍。跨平台恢复保留本机网络设置，应用绑定默认停用，需重新核对。</p>
        <label className="block">同步文件地址<input type="url" className={field} value={state.connection.url} onChange={e => state.setConnection({ ...state.connection, url: e.target.value })} placeholder="https://你的存储服务/目录/procweaver.pwbackup.json" /></label>
        <label className="block">用户名<input className={field} autoComplete="off" value={state.connection.username} onChange={e => state.setConnection({ ...state.connection, username: e.target.value })} /></label>
        <label className="block">访问密码<input type="password" className={field} autoComplete="off" value={state.connection.password} onChange={e => state.setConnection({ ...state.connection, password: e.target.value })} /></label>
        <div className="flex flex-wrap gap-2"><button className="rounded-lg border p-3" onClick={() => void state.download()}>下载并预览</button><button className="rounded-lg border p-3" onClick={() => void state.upload()}>上传本机配置</button></div>
      </details>
      {state.preview && <div className="rounded-lg border border-amber-400 p-3 space-y-3">
        <p>备份来源：{state.preview.platform} · {state.preview.appVersion} · {state.preview.files} 个配置文件</p>
        <p className="text-xs">恢复会替换当前配置并刷新界面，请先停止核心／VPN。写入失败或意外中断时使用本地事务记录回滚。</p>
        {state.preview.crossPlatform && <p className="text-xs">{mobile ? "跨平台恢复保留本机网络设置，仅恢复手机支持的配置，应用分流需重新核对。" : "跨平台恢复：保留接收端系统设置，应用分流与业务包绑定需重新启用。"}</p>}
        <label className="flex items-center gap-2"><input type="checkbox" checked={state.confirmed} onChange={e => state.setConfirmed(e.target.checked)} />确认使用此备份替换当前配置</label>
        <button className="rounded-lg bg-amber-600 text-white p-3 disabled:opacity-50" disabled={!state.confirmed} onClick={() => void state.restore()}>恢复配置</button>
      </div>}
    </fieldset>
    <p role="status" className="text-sm break-all">{state.busy ? "正在处理，请稍候…" : state.message}</p>
  </section>;
}
