export type LogLevel = "all" | "info" | "warning" | "error" | "debug";

export interface LogEntry {
  id: string;
  time: string;
  timestamp: number;
  level: "info" | "warning" | "error" | "debug";
  payload: string;
}

// 全局内存日志缓冲区 (最大保留 2000 条，跨页面切换/Tab返回不丢失)
const GLOBAL_LOG_BUFFER: LogEntry[] = [];
const LOG_LISTENERS: Set<(entry: LogEntry) => void> = new Set();

/**
 * 向全局日志系统注入一条结构化日志
 */
export function appendAppLog(level: "info" | "warning" | "error" | "debug", payload: string): LogEntry {
  const now = new Date();
  const timeStr =
    now.toTimeString().split(" ")[0] +
    "." +
    String(now.getMilliseconds()).padStart(3, "0");
  const entry: LogEntry = {
    id: `${now.getTime()}-${Math.random().toString(36).substring(2, 7)}`,
    time: timeStr,
    timestamp: now.getTime(),
    level,
    payload,
  };

  GLOBAL_LOG_BUFFER.push(entry);
  if (GLOBAL_LOG_BUFFER.length > 2000) {
    GLOBAL_LOG_BUFFER.shift();
  }

  for (const listener of LOG_LISTENERS) {
    try {
      listener(entry);
    } catch {}
  }

  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("netbox-app-log", { detail: entry }));
    }
  } catch {}

  return entry;
}

/**
 * 快捷记录 INFO 级别日志
 * @param tag 模块标签，例如 "IP健康", "节点测速", "批量测速"
 * @param message 具体信息
 */
export function logInfo(tag: string, message: string): LogEntry {
  return appendAppLog("info", `[${tag}] ${message}`);
}

/**
 * 快捷记录 WARN 级别日志
 */
export function logWarn(tag: string, message: string): LogEntry {
  return appendAppLog("warning", `[${tag}] ${message}`);
}

/**
 * 快捷记录 ERROR 级别日志
 */
export function logError(tag: string, message: string): LogEntry {
  return appendAppLog("error", `[${tag}] ${message}`);
}

/**
 * 获取当前全局已缓存的所有日志快照
 */
export function getGlobalLogs(): LogEntry[] {
  return [...GLOBAL_LOG_BUFFER];
}

/**
 * 订阅实时全局日志流
 */
export function subscribeLogs(cb: (entry: LogEntry) => void): () => void {
  LOG_LISTENERS.add(cb);
  return () => {
    LOG_LISTENERS.delete(cb);
  };
}

/**
 * 清空全局日志
 */
export function clearGlobalLogs() {
  GLOBAL_LOG_BUFFER.length = 0;
}

export function getLogsWsUrl(controllerPort: number, level: LogLevel = "debug", secret?: string): string {
  const queryLevel = level === "all" ? "debug" : level;
  let url = `ws://127.0.0.1:${controllerPort}/logs?level=${queryLevel}`;
  if (secret) {
    url += `&token=${encodeURIComponent(secret)}`;
  }
  return url;
}

