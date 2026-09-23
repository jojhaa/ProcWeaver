import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  ScrollText,
  Search,
  Trash2,
  Download,
  Pause,
  Play,
  ArrowDown,
  Power,
  X,
  Copy,
  Check,
  Clock,
  Layers,
  Info,
  AlertTriangle,
  AlertOctagon,
  Bug,
  Globe,
  Zap,
} from "lucide-react";
import {
  LogEntry,
  LogLevel,
  getLogsWsUrl,
  getGlobalLogs,
  appendAppLog,
  subscribeLogs,
  clearGlobalLogs,
  getLogBufferStats,
} from "../api/logs";
import { getGeneralSettings, saveGeneralSettings } from "../api/settings";

import { VirtualList } from "../components/VirtualList";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useMonitorVisible } from "../hooks/useMonitorVisible";
import { MonitorPerformanceControl } from "../components/MonitorPerformanceControl";

interface LogsViewProps {
  controllerPort?: number;
}

export const LogsView: React.FC<LogsViewProps> = React.memo(({ controllerPort = 9090 }) => {
  // 日志捕获总控开关状态
  const [logCaptureEnabled, setLogCaptureEnabled] = useState<boolean>(true);
  const [isEnablingCapture, setIsEnablingCapture] = useState(false);

  // 日志集合与连接状态 (初始化时从全局日志池恢复，跨视图不丢数据)
  const [logs, setLogs] = useState<LogEntry[]>(() => getGlobalLogs());
  const [wsStatus, setWsStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);

  // 过滤与搜索
  const [selectedLevel, setSelectedLevel] = useState<LogLevel>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const visible = useMonitorVisible();
  const settledQuery = useDebouncedValue(searchQuery);
  const [bufferStats, setBufferStats] = useState(getLogBufferStats);
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);

  // DOM 与滚动引用
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<any>(null);

  // 1. 读取系统偏好中的 log_capture 开关配置
  useEffect(() => {
    const checkSettings = async () => {
      try {
        const s = await getGeneralSettings();
        if (s && s.logCapture !== undefined) {
          setLogCaptureEnabled(s.logCapture);
        }
      } catch (err) {
        console.warn("读取日志开关设置失败:", err);
      }
    };
    checkSettings();

    const handleSettingsSaved = () => {
      checkSettings();
    };
    window.addEventListener("netbox-settings-saved", handleSettingsSaved);
    return () => {
      window.removeEventListener("netbox-settings-saved", handleSettingsSaved);
    };
  }, []);

  // 2. 启用日志捕获
  const handleEnableLogCapture = async () => {
    setIsEnablingCapture(true);
    try {
      const s = await getGeneralSettings();
      await saveGeneralSettings({ ...s, logCapture: true });
      setLogCaptureEnabled(true);
    } catch (err) {
      console.error("启用日志捕获失败:", err);
    } finally {
      setIsEnablingCapture(false);
    }
  };

  // 3. WebSocket 实时日志流连接
  useEffect(() => {
    if (!logCaptureEnabled) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setWsStatus("disconnected");
      return;
    }

    let isMounted = true;

    const connectWs = () => {
      if (!isMounted) return;
      setWsStatus("connecting");

      try {
        const url = getLogsWsUrl(controllerPort, "debug");
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!isMounted) return;
          setWsStatus("connected");
        };

        ws.onmessage = (event) => {
          if (!isMounted) return;
          try {
            const data = JSON.parse(event.data);
            const level = data.type ? (data.type.toLowerCase() as any) : "info";
            const payload = typeof data.payload === "string" ? data.payload : String(data.payload ?? "");
            // 同时汇入全局日志总线
            appendAppLog(level, payload);
          } catch (e) {
            console.warn("解析日志帧失败:", e);
          }
        };

        ws.onerror = () => {
          if (!isMounted) return;
          setWsStatus("disconnected");
        };

        ws.onclose = () => {
          if (!isMounted) return;
          setWsStatus("disconnected");
          // 2.5 秒后尝试重连
          reconnectTimeoutRef.current = setTimeout(() => {
            if (isMounted && logCaptureEnabled) {
              connectWs();
            }
          }, 2500);
        };
      } catch (err) {
        if (!isMounted) return;
        setWsStatus("disconnected");
      }
    };

    connectWs();

    return () => {
      isMounted = false;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [logCaptureEnabled, controllerPort]);

  // 暂停仅冻结显示；恢复时一次读取有界缓存，不重建日志连接。
  useEffect(() => {
    if (isPaused || !visible) return;
    const refresh = () => { setLogs(getGlobalLogs()); setBufferStats(getLogBufferStats()); };
    refresh();
    return subscribeLogs(refresh);
  }, [isPaused, visible]);

  // 5. 清空日志
  const handleClearLogs = () => {
    clearGlobalLogs();
    setLogs([]);
    setBufferStats(getLogBufferStats());
  };

  // 6. 导出为 .log 文件
  const handleExportLogs = () => {
    if (logs.length === 0) return;
    const content = logs
      .map((l) => `[${l.time}] [${l.level.toUpperCase()}] ${l.payload}`)
      .join("\n");

    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date();
    const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
    a.href = url;
    a.download = `netbox-logs-${dateStr}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // 复制单行日志
  const handleCopyLog = (log: LogEntry) => {
    const text = `[${log.time}] [${log.level.toUpperCase()}] ${log.payload}`;
    navigator.clipboard.writeText(text);
    setCopiedId(log.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  // 7. 过滤逻辑
  const filteredLogs = useMemo(() => {
    const query = settledQuery.trim().toLowerCase();
    return logs.filter((log) => {
      if (selectedLevel !== "all" && log.level !== selectedLevel) {
        return false;
      }
      if (!query) return true;
      return log.payload.toLowerCase().includes(query) || log.time.includes(query);
    });
  }, [logs, selectedLevel, settledQuery]);

  // 8. 统计各个级别的条数
  const levelCounts = useMemo(() => {
    const counts = { all: logs.length, info: 0, warning: 0, error: 0, debug: 0 };
    for (const l of logs) {
      if (l.level in counts) {
        counts[l.level as keyof typeof counts]++;
      }
    }
    return counts;
  }, [logs]);

  // 辅助渲染级别徽章
  const renderLevelBadge = (level: string) => {
    switch (level) {
      case "error":
        return (
          <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold font-mono uppercase bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400 border border-rose-200/80 dark:border-rose-800/60 shadow-2xs">
            <AlertOctagon className="w-2.5 h-2.5 flex-shrink-0" />
            <span>ERR</span>
          </span>
        );
      case "warning":
        return (
          <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold font-mono uppercase bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400 border border-amber-200/80 dark:border-amber-800/60 shadow-2xs">
            <AlertTriangle className="w-2.5 h-2.5 flex-shrink-0" />
            <span>WARN</span>
          </span>
        );
      case "info":
        return (
          <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold font-mono uppercase bg-sky-50 dark:bg-sky-950/50 text-sky-600 dark:text-sky-400 border border-sky-200/80 dark:border-sky-800/60 shadow-2xs">
            <Info className="w-2.5 h-2.5 flex-shrink-0" />
            <span>INFO</span>
          </span>
        );
      case "debug":
      default:
        return (
          <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold font-mono uppercase bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200/80 dark:border-slate-700/60 shadow-2xs">
            <Bug className="w-2.5 h-2.5 flex-shrink-0" />
            <span>DBG</span>
          </span>
        );
    }
  };

  // 辅助渲染日志内容：突出关键协议与流向
  const renderLogPayload = (payload: string, level: string) => {
    // 1. 识别业务专属标签: [IP健康], [节点测速], [批量测速], [流媒体体检]
    const appTagRegex = /^\[(IP健康|节点测速|批量测速|流媒体体检)\]\s*(.*)$/i;
    const appMatch = payload.match(appTagRegex);

    const textColor =
      level === "error"
        ? "text-rose-600 dark:text-rose-400 font-medium"
        : level === "warning"
        ? "text-amber-700 dark:text-amber-300 font-medium"
        : "text-slate-700 dark:text-slate-300";

    if (appMatch) {
      const tag = appMatch[1];
      const rest = appMatch[2];
      const isIp = tag === "IP健康";

      return (
        <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5">
          <span
            className={`inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-bold font-mono flex-shrink-0 border shadow-2xs ${
              isIp
                ? "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border-emerald-200/80 dark:border-emerald-800/60"
                : "bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 border-purple-200/80 dark:border-purple-800/60"
            }`}
          >
            {isIp ? (
              <Globe className="w-2.5 h-2.5 flex-shrink-0 text-emerald-500" />
            ) : (
              <Zap className="w-2.5 h-2.5 flex-shrink-0 text-purple-500" />
            )}
            <span>{tag}</span>
          </span>
          <span className={`break-all leading-relaxed text-xs font-mono ${textColor}`}>
            {rest}
          </span>
        </div>
      );
    }

    // 2. 识别 [TCP], [UDP], [DNS], [HTTP] 等协议标签
    const protoRegex = /^(\[(TCP|UDP|DNS|HTTP|HTTPS)\])\s*(.*)$/i;
    const protoMatch = payload.match(protoRegex);

    if (protoMatch) {
      const proto = protoMatch[2].toUpperCase();
      const rest = protoMatch[3];

      return (
        <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5">
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200/60 dark:border-indigo-800/60 flex-shrink-0">
            {proto}
          </span>
          <span className={`break-all leading-relaxed font-mono text-xs ${textColor}`}>
            {rest}
          </span>
        </div>
      );
    }

    return (
      <span className={`flex-1 min-w-0 break-all leading-relaxed font-mono text-xs ${textColor}`}>
        {payload}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      {/* 顶部状态与工具卡片 */}
      <div className="bg-white dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-xs space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* 左侧：标题、端口与连接状态指示灯 */}
          <div className="flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-900/40 shadow-2xs">
              <ScrollText className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200">
                  系统运行日志
                </h3>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                  :{controllerPort}
                </span>
              </div>
              <div className="flex items-center space-x-1.5 mt-0.5">
                <span
                  className={`w-2 h-2 rounded-full ${
                    !logCaptureEnabled
                      ? "bg-slate-400"
                      : wsStatus === "connected"
                      ? "bg-emerald-500 animate-pulse"
                      : wsStatus === "connecting"
                      ? "bg-amber-500"
                      : "bg-rose-500"
                  }`}
                />
                <span className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                  {!logCaptureEnabled
                    ? "日志捕获已停用"
                    : wsStatus === "connected"
                    ? "实时日志流水已接入"
                    : wsStatus === "connecting"
                    ? "正在建立 WebSocket 监听..."
                    : "未接入 (内核未启动或端口离线)"}
                </span>
              </div>
            </div>
          </div>

          {/* 右侧：动作按钮组 */}
          <div className="flex flex-wrap items-center gap-2">
            <MonitorPerformanceControl />
            {/* 暂停 / 实时 */}
            <button
              onClick={() => setIsPaused(!isPaused)}
              title={isPaused ? "恢复显示缓存中的最新日志" : "暂停显示，继续接收到有界缓存"}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors ${
                isPaused
                  ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30 font-semibold"
                  : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-700"
              }`}
            >
              {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              <span>{isPaused ? "已暂停" : "实时"}</span>
            </button>

            {/* 自动滚屏 */}
            <button
              onClick={() => setAutoScroll(!autoScroll)}
              title={autoScroll ? "锁定底部自动追踪最新条目" : "停止底部锁定"}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors ${
                autoScroll
                  ? "bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800/60 font-semibold"
                  : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-700"
              }`}
            >
              <ArrowDown className="w-3.5 h-3.5" />
              <span>滚动追踪</span>
            </button>

            {/* 清空列表 */}
            <button
              onClick={handleClearLogs}
              disabled={logs.length === 0}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="清空当前已加载的日志记录"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>清空</span>
            </button>

            {/* 导出为 .log 文件 */}
            <button
              onClick={handleExportLogs}
              disabled={logs.length === 0}
              className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="导出当前收集的日志为 .log 文件"
            >
              <Download className="w-3.5 h-3.5" />
              <span>导出日志</span>
            </button>
          </div>
        </div>

        {/* 级别过滤器与搜索栏 */}
        <div className="flex flex-wrap items-center gap-2.5 pt-2.5 border-t border-slate-100 dark:border-slate-800/80">
          {/* 级别单选分段控制器 */}
          <div className="flex items-center space-x-1 p-1 bg-slate-100/90 dark:bg-slate-800/80 rounded-xl border border-slate-200 dark:border-slate-700">
            {(
              [
                { key: "all", label: "全部", badgeColor: "text-slate-600 dark:text-slate-300" },
                { key: "info", label: "INFO", badgeColor: "text-sky-600 dark:text-sky-400" },
                { key: "warning", label: "WARN", badgeColor: "text-amber-600 dark:text-amber-400" },
                { key: "error", label: "ERR", badgeColor: "text-rose-600 dark:text-rose-400" },
                { key: "debug", label: "DBG", badgeColor: "text-slate-500 dark:text-slate-400" },
              ] as const
            ).map((lvl) => {
              const isActive = selectedLevel === lvl.key;
              return (
                <button
                  key={lvl.key}
                  onClick={() => setSelectedLevel(lvl.key)}
                  className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                    isActive
                      ? "bg-white dark:bg-slate-900 shadow-xs " + lvl.badgeColor
                      : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                  }`}
                >
                  <span className="font-mono">{lvl.label}</span>
                  <span
                    className={`text-[10px] px-1 rounded-full font-mono ${
                      isActive
                        ? "bg-slate-100 dark:bg-slate-800"
                        : "bg-slate-200/70 dark:bg-slate-700/60 text-slate-500 dark:text-slate-400"
                    }`}
                  >
                    {levelCounts[lvl.key]}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 关键字搜索框 */}
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="快速检索日志内容 (支持 dial, match, TCP, DNS, DIRECT 等)..."
              className="w-full pl-9 pr-8 py-1.5 text-xs bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:text-slate-200 font-sans placeholder:font-sans placeholder:text-slate-400"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 当 log_capture 开关关闭时的温馨引导条 */}
      {!logCaptureEnabled && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-2xs">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-xl bg-amber-500/20 text-amber-600 dark:text-amber-400">
              <Power className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-xs font-bold text-amber-900 dark:text-amber-200">
                系统运行日志捕获处于停用状态
              </h4>
              <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5">
                此选项可在“系统偏好 ➔ 基础功能 ➔ 日志捕获”中管理，停用时可最大程度节约内存与 CPU 资源。
              </p>
            </div>
          </div>
          <button
            onClick={handleEnableLogCapture}
            disabled={isEnablingCapture}
            className="flex-shrink-0 px-4 py-1.5 rounded-xl text-xs font-bold bg-amber-600 hover:bg-amber-700 text-white shadow-xs transition-colors"
          >
            {isEnablingCapture ? "正在开启..." : "立即开启日志记录"}
          </button>
        </div>
      )}

      {(bufferStats.evicted > 0 || bufferStats.truncated > 0) && <p className="text-xs text-amber-600 dark:text-amber-400">
        缓存已淘汰 {bufferStats.evicted} 条旧日志，截断 {bufferStats.truncated} 条超长日志；导出仅包含当前显示缓存。
      </p>}
      {/* 日志记录流水卡片大盘 */}
      <div className="bg-white dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm flex flex-col h-[580px]">
        {/* 表头大盘状态信息栏 */}
        <div className="bg-slate-50/90 dark:bg-slate-800/60 px-4 py-2.5 border-b border-slate-200/80 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 select-none">
          <div className="flex items-center space-x-2">
            <Layers className="w-3.5 h-3.5 text-indigo-500" />
            <span className="font-semibold text-slate-700 dark:text-slate-200">
              内核运行流水记录
            </span>
            <span className="text-[11px] text-slate-400 font-normal">
              (按时间序实时排布)
            </span>
          </div>

          <div className="flex items-center space-x-3 text-[11px] font-mono">
            {autoScroll && !isPaused && visible && (
              <span className="hidden sm:inline-flex items-center space-x-1 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 px-2 py-0.5 rounded-full border border-emerald-200/60 dark:border-emerald-800/60">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span>实时追踪中</span>
              </span>
            )}
            <span>
              匹配: <strong className="text-slate-700 dark:text-slate-300">{filteredLogs.length}</strong> 行
            </span>
            <span className="text-slate-300 dark:text-slate-700">|</span>
            <span title="缓存最多 2000 行 / 2 MiB，单条最多 32 KiB">缓存: 2000 行 / 2 MiB</span>
          </div>
        </div>

        {/* 现代卡片式日志流水列表 */}
        <div
          className="flex-1 min-h-0 select-text"
        >
          {filteredLogs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-12">
              <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 mb-3 shadow-2xs">
                <ScrollText className="w-6 h-6" />
              </div>
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                暂无匹配的运行日志
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
                {!logCaptureEnabled
                  ? "日志捕获处于关闭状态，请点击上方“立即开启日志记录”即可实时呈现内核数据。"
                  : searchQuery
                  ? `未找到包含 "${searchQuery}" 的相关日志，您可以尝试清空筛选关键词。`
                  : "当系统产生网络连接、节点策略切换、DNS 解析或底层异常时，将在此处实时归档。"}
              </p>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="mt-3 px-3 py-1 rounded-xl text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors"
                >
                  清除搜索条件
                </button>
              )}
            </div>
          ) : (
            <VirtualList items={filteredLogs} itemKey={log => log.id} rowHeight={64} className="h-full"
              label="运行日志" followEnd={autoScroll} preserveAnchor onLeaveEnd={() => setAutoScroll(false)} renderRow={(log) => (
              <div
                key={log.id}
                className="group px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors flex items-start space-x-3 text-xs"
              >
                {/* 时间戳 */}
                <div className="flex items-center space-x-1 text-slate-400 dark:text-slate-500 text-[11px] font-mono flex-shrink-0 select-none pt-0.5">
                  <Clock className="w-3 h-3 text-slate-300 dark:text-slate-600" />
                  <span>{log.time}</span>
                </div>

                {/* 级别标签 */}
                <div className="flex-shrink-0 select-none pt-0.5">
                  {renderLevelBadge(log.level)}
                </div>

                {/* 日志主体内容 */}
                <button type="button" onClick={() => setSelectedLog(log)} title="查看完整日志"
                  className="min-w-0 flex-1 text-left h-11 overflow-hidden focus:outline-indigo-500">
                  <span className="line-clamp-2 break-all">{renderLogPayload(log.payload, log.level)}</span>
                </button>

                {/* 行内悬浮快捷复制按钮 */}
                <div className="flex-shrink-0 select-none">
                  <button
                    onClick={() => handleCopyLog(log)}
                    title="复制本行日志"
                    className="opacity-0 group-hover:opacity-100 p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
                  >
                    {copiedId === log.id ? (
                      <span className="flex items-center space-x-1 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
                        <Check className="w-3.5 h-3.5" />
                        <span>已复制</span>
                      </span>
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>
            )} />
          )}
        </div>
      </div>
      {selectedLog && <div className="fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-6"
        onClick={() => setSelectedLog(null)} onKeyDown={e => { if (e.key === "Escape") setSelectedLog(null); }}>
        <div role="dialog" aria-modal="true" aria-label="日志详情" className="bg-white dark:bg-slate-900 rounded-xl p-5 max-w-3xl w-full" onClick={e => e.stopPropagation()}>
          <div className="flex justify-between mb-3"><strong>日志详情 · {selectedLog.time}</strong>
            <button autoFocus onClick={() => setSelectedLog(null)} aria-label="关闭日志详情"><X className="w-5 h-5" /></button></div>
          <pre className="text-xs whitespace-pre-wrap break-all max-h-[65vh] overflow-auto">{selectedLog.payload}</pre>
          <button className="mt-3 text-indigo-600" onClick={() => handleCopyLog(selectedLog)}>复制日志</button>
        </div>
      </div>}
    </div>
  );
});
