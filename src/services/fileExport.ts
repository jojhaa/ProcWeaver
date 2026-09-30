import { getPlatform } from "./platform";

export async function saveTextFile(filename: string, content: string, mime = "text/plain"): Promise<boolean> {
  if (getPlatform().os === "android" && "__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ saved: boolean }>("save_android_document", { filename, content, mime });
    return result.saved;
  }
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
