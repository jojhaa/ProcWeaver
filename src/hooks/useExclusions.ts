import { useEffect, useState } from "react";
import { fetchExclusions, saveExclusions } from "../api/mihomo";
import { splitExclusionInput } from "../utils/exclusionInput";

export function useExclusions() {
  const [text, setText] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);
  async function reload() {
    setLoading(true);
    setReady(false);
    setMessage("");
    setError("");
    try {
      const config = await fetchExclusions();
      setText(config.entries.join("\n")); setEnabled(config.enabled); setReady(true);
    } catch (cause) { setError(String(cause)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, []);
  async function save() {
    if (saving || !ready) return false;
    setSaving(true); setError(""); setMessage("");
    try {
      const config = await saveExclusions({ enabled, entries: splitExclusionInput(text) });
      setText(config.entries.join("\n")); setEnabled(config.enabled);
      setMessage(`已保存 ${config.entries.length} 条排除项；运行中的核心已应用，未启动时将在下次启动生效。`);
      return true;
    } catch (cause) { setError(String(cause)); return false; }
    finally { setSaving(false); }
  }
  return {
    state: { text, enabled, loading, saving, error, message, ready },
    actions: {
      edit: (value: string) => { setText(value); setMessage(""); },
      enable: (value: boolean) => { setEnabled(value); setMessage(""); },
      reload, save,
    },
  };
}
