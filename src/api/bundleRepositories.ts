import { invoke } from "@tauri-apps/api/core";
import { httpsUrl, type RepositoryRequest } from "../services/bundleRepositories";

export const requestRepository: RepositoryRequest = async (address, signal, maxBytes) => {
  if (signal.aborted) throw new Error("请求已取消");
  const url = httpsUrl(address);
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const requestId = crypto.randomUUID();
    const cancel = () => { void invoke("cancel_bundle_repository_request", { requestId }).catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try { const text = await invoke<string>("read_bundle_repository_file", { url, maxBytes, requestId }); if (signal.aborted) throw new Error("请求已取消"); return text; }
    catch (e) { throw e instanceof Error ? e : new Error(typeof e === "string" ? e : "仓库请求失败"); }
    finally { signal.removeEventListener("abort", cancel); }
  }
  const controller = new AbortController(), cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 15000);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`仓库请求失败（HTTP ${response.status}）`);
    if (!response.body) throw new Error("仓库响应为空");
    const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "", bytes = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > maxBytes) throw new Error("仓库响应超过大小上限"); text += decoder.decode(part.value, { stream: true }); } return text + decoder.decode(); }
    finally { await reader.cancel(); }
  } catch (e) { if (controller.signal.aborted) throw new Error(signal.aborted ? "请求已取消" : "仓库请求超时，请重试"); throw e; }
  finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
};
