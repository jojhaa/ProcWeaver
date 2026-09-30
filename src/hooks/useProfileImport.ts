import { useCallback, useEffect, useState } from "react";
import { profileImportApi } from "../api/profileImport";

export function useProfileImport(mobile: boolean, onImported: () => void, api = profileImportApi) {
  const [content, setContent] = useState("");
  const [name, setName] = useState("导入的配置");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const receive = useCallback(async (action: "takeImport" | "readDocument" | "scanQr" | "readQrImage") => {
    setBusy(true); setMessage("");
    try { const result = await api.native(action); if (!result.cancelled) setContent(result.content ?? ""); }
    catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  }, [api]);
  useEffect(() => {
    if (!mobile) return;
    const ready = () => { void receive("takeImport"); };
    ready(); window.addEventListener("procweaver-import-ready", ready);
    return () => window.removeEventListener("procweaver-import-ready", ready);
  }, [mobile, receive]);
  async function file(file: File | undefined) {
    if (!file) return;
    try { if (file.size > 8 * 1024 * 1024) throw new Error("文件不能超过 8 MB"); setName(file.name.replace(/\.ya?ml$/i, "")); setContent(await file.text()); }
    catch (error) { setMessage(String(error)); }
  }
  async function confirm() {
    if (busy || !content.trim() || !name.trim()) return;
    setBusy(true); setMessage("");
    try {
      const raw = content.trim();
      if (/^https?:\/\//i.test(raw)) {
        const url = new URL(raw);
        if (raw.length > 8192 || url.username || url.password || /[\r\n]/.test(raw)) throw new Error("订阅链接格式无效");
        await api.subscription(name.trim(), url.href);
      } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw new Error("此入口支持 HTTP(S) 订阅链接或完整 YAML 配置");
      else await api.file(name.trim(), raw);
      setContent(""); setMessage("导入成功，可在订阅列表选择启用"); onImported();
      window.dispatchEvent(new Event("netbox-profile-changed"));
    } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  }
  return { content, setContent, name, setName, message, busy, receive, file, confirm };
}
