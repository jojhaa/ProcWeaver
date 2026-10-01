import { useState } from "react";
import { processUpdateApi } from "../api/processUpdate";
import type { AppUpdateInfo } from "../types";
export function useProcessUpdate() {
  const [info, setInfo] = useState<AppUpdateInfo>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [path, setPath] = useState("");
  async function check() {
    if (busy) return; setBusy(true); setError("");
    try { setInfo(await processUpdateApi.check()); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function download() {
    if (busy) return; setBusy(true); setError(""); setPath("");
    try { setPath(await processUpdateApi.download()); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return { info, busy, error, path, check, download };
}
