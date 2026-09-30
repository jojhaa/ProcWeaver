import { useState } from "react";
import { configTransferApi, applyPendingBrowserRestore, type BackupPreview, type SyncConnection } from "../api/configTransfer";
import { profileImportApi } from "../api/profileImport";
import { encryptConfiguration, decryptConfiguration } from "../services/configEncryption";
import { saveTextFile } from "../services/fileExport";

export function useConfigTransfer() {
  const [password, setPassword] = useState("");
  const [connection, setConnectionState] = useState<SyncConnection>({ url: "", username: "", password: "" });
  const [etag, setEtag] = useState<string | undefined>();
  const [snapshot, setSnapshot] = useState<unknown>();
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const setConnection = (value: SyncConnection) => { setConnectionState(value); setEtag(undefined); };
  async function run(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setMessage("");
    try { await action(); } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  }
  async function load(raw: string) {
    setPreview(null); setSnapshot(undefined); setConfirmed(false);
    const data = await decryptConfiguration(raw, password);
    const info = await configTransferApi.preview(data);
    setSnapshot(data); setPreview(info);
  }
  const exportFile = () => run(async () => {
    const encrypted = await encryptConfiguration(await configTransferApi.export(), password);
    if (await saveTextFile(`ProcWeaver-${new Date().toISOString().slice(0, 10)}.pwbackup.json`, encrypted, "application/json")) setMessage("加密备份已保存，请独立保管密码");
  });
  const selectFile = (file: File | undefined) => run(async () => { if (!file) return; if (file.size > 8*1024*1024) throw new Error("备份不能超过 8 MB"); await load(await file.text()); });
  const selectNative = () => run(async () => { const result = await profileImportApi.native("readDocument"); if (!result.cancelled) await load(result.content ?? ""); });
  const restore = () => run(async () => {
    if (!confirmed || !snapshot || !preview) return;
    await configTransferApi.restore(snapshot); await applyPendingBrowserRestore(); window.location.reload();
  });
  const download = () => run(async () => {
    const remote = await configTransferApi.remote(connection); setEtag(remote.etag);
    if (!remote.content) { setMessage("远端尚无备份，可以上传本机配置"); return; }
    await load(remote.content); setMessage("远端配置已解密并校验，请预览后决定是否恢复");
  });
  const upload = () => run(async () => {
    const encrypted = await encryptConfiguration(await configTransferApi.export(), password);
    const result = await configTransferApi.remote(connection, encrypted, etag);
    setEtag(result.etag || "unavailable"); setMessage("已上传加密配置；其他设备使用同一地址和备份密码下载");
  });
  return { password, setPassword, connection, setConnection, preview, confirmed, setConfirmed, busy, message,
    exportFile, selectFile, selectNative, restore, download, upload };
}
