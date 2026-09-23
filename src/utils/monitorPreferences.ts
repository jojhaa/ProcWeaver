const key = "procweaver-monitor-low-power";
let lowPower = false;
try { lowPower = localStorage.getItem(key) === "true"; } catch { /* 使用默认刷新频率。 */ }
const listeners = new Set<() => void>();
export const getMonitorLowPower = () => lowPower;
export function setMonitorLowPower(value: boolean) {
  lowPower = value;
  try { localStorage.setItem(key, String(value)); } catch { /* 本次会话仍生效。 */ }
  listeners.forEach(cb => cb());
}
export function subscribeMonitorPreferences(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
export const monitorInterval = () => lowPower ? 2500 : 1000;
export const logFlushInterval = () => lowPower ? 750 : 250;
