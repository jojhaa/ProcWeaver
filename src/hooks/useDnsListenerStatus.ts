import { useEffect, useState } from "react";
import { getDnsListenerStatus, type DnsListenerStatus } from "../api/dns";

export function useDnsListenerStatus(enabled: boolean, running: boolean, pid: number | null | undefined, pending: boolean) {
  const [status, setStatus] = useState<DnsListenerStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        const next = await getDnsListenerStatus();
        if (request === generation) { setStatus(next); setError(""); }
      } catch (cause) {
        if (request === generation) { setStatus(null); setError(`DNS 运行状态读取失败：${String(cause)}`); }
      }
    };
    void refresh();
    window.addEventListener("netbox-settings-saved", refresh);
    return () => { ++generation; window.removeEventListener("netbox-settings-saved", refresh); };
  }, [enabled, running, pid, pending]);
  return { status, error };
}
