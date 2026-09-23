import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Search,
  Trash2,
  Pause,
  Play,
  Clock,
  Globe,
  Server,
  Layers,
  X,
  AlertCircle,
  Laptop,
  ChevronRight,
} from "lucide-react";
import {
  closeConnection,
  closeAllConnections,
  ConnectionItem,
} from "../api/connections";

import { monitorStore } from "../api/traffic";
import { VirtualList } from "../components/VirtualList";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useMonitorVisible } from "../hooks/useMonitorVisible";
import { MonitorPerformanceControl } from "../components/MonitorPerformanceControl";

interface ConnectionsViewProps {
  controllerPort?: number;
}

export const ConnectionsView: React.FC<ConnectionsViewProps> = React.memo(({ controllerPort: _controllerPort }) => {
  // 视图模式：活跃连接 vs 历史请求流水
  const [viewMode, setViewMode] = useState<"active" | "closed">("active");

  // 活跃连接列表与历史请求列表
  const [activeConnections, setActiveConnections] = useState<ConnectionItem[]>([]);
  const [closedRequests, setClosedRequests] = useState<ConnectionItem[]>([]);
  const [totalDownload, setTotalDownload] = useState(0);
  const [totalUpload, setTotalUpload] = useState(0);
  const [aggregateDownSpeed, setAggregateDownSpeed] = useState(0);
  const [aggregateUpSpeed, setAggregateUpSpeed] = useState(0);

  // 轮询与控制
  const [isPaused, setIsPaused] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"download" | "upload" | "downSpeed" | "time">("download");
  const [networkFilter, setNetworkFilter] = useState<"all" | "tcp" | "udp">("all");
  const [selectedConnection, setSelectedConnection] = useState<ConnectionItem | null>(null);
  const [showCloseAllConfirm, setShowCloseAllConfirm] = useState(false);
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());

  const visible = useMonitorVisible();
  const settledQuery = useDebouncedValue(searchQuery);
  const [monitorError, setMonitorError] = useState("");
  const epochRef = useRef<number | null | undefined>(undefined);

  // 引用追踪：用于计算连接瞬时速率与发现关闭的连接
  const prevConnectionsMapRef = useRef<Map<string, { upload: number; download: number; time: number; item: ConnectionItem }>>(new Map());
  const prevTotalRef = useRef<{ download: number; upload: number; time: number }>({ download: 0, upload: 0, time: Date.now() });

  // 格式化辅助函数（严格保留最多 3 位小数，去除无效零）
  const formatSpeed = (bytesPerSec: number) => {
    if (!bytesPerSec || bytesPerSec <= 0 || !Number.isFinite(bytesPerSec)) return "0 B/s";
    if (bytesPerSec < 1024) return `${Number(bytesPerSec.toFixed(3))} B/s`;
    if (bytesPerSec < 1024 * 1024) return `${Number((bytesPerSec / 1024).toFixed(3))} KB/s`;
    return `${Number((bytesPerSec / (1024 * 1024)).toFixed(3))} MB/s`;
  };

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return "0 B";
    if (bytes < 1024) return `${Number(bytes.toFixed(3))} B`;
    if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(3))} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${Number((bytes / (1024 * 1024)).toFixed(3))} MB`;
    return `${Number((bytes / (1024 * 1024 * 1024)).toFixed(3))} GB`;
  };

  const formatDuration = (startTime: string) => {
    if (!startTime) return "-";
    const startMs = new Date(startTime).getTime();
    if (isNaN(startMs)) return "-";
    const diffSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    if (diffSec < 60) return `${diffSec}秒`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分${diffSec % 60}秒`;
    return `${Math.floor(diffSec / 3600)}时${Math.floor((diffSec % 3600) / 60)}分`;
  };

  // 订阅与流量统计共用的快照，暂停或不可见时不请求连接详情。
  useEffect(() => {
    if (isPaused || !visible) return;

    const receive = () => {
        const snap = monitorStore.getConnections();
        if (!snap) return;
        if (epochRef.current !== snap.epoch) {
          epochRef.current = snap.epoch;
          prevConnectionsMapRef.current.clear();
          prevTotalRef.current = { download: 0, upload: 0, time: snap.timestamp };
          setClosedRequests([]);
          setAggregateDownSpeed(0);
          setAggregateUpSpeed(0);
        }
        const now = snap.timestamp;
        const prevMap = prevConnectionsMapRef.current;
        const currentMap = new Map<string, { upload: number; download: number; time: number; item: ConnectionItem }>();
        const enrichedConnections: ConnectionItem[] = [];

        // 1. 计算总吞吐速率
        const prevTotal = prevTotalRef.current;
        const dtTotal = (now - prevTotal.time) / 1000;
        if (dtTotal > 0 && prevTotal.download > 0) {
          const downDelta = Math.max(0, snap.downloadTotal - prevTotal.download);
          const upDelta = Math.max(0, snap.uploadTotal - prevTotal.upload);
          setAggregateDownSpeed(downDelta / dtTotal);
          setAggregateUpSpeed(upDelta / dtTotal);
        }
        prevTotalRef.current = { download: snap.downloadTotal, upload: snap.uploadTotal, time: now };
        setTotalDownload(snap.downloadTotal);
        setTotalUpload(snap.uploadTotal);

        // 2. 遍历每个连接计算单连接瞬时速率
        for (const conn of snap.connections) {
          let downloadSpeed = 0;
          let uploadSpeed = 0;
          const prev = prevMap.get(conn.id);
          if (prev) {
            const dt = (now - prev.time) / 1000;
            if (dt > 0) {
              downloadSpeed = Math.max(0, (conn.download - prev.download) / dt);
              uploadSpeed = Math.max(0, (conn.upload - prev.upload) / dt);
            }
          }
          const item: ConnectionItem = {
            ...conn,
            downloadSpeed,
            uploadSpeed,
          };
          enrichedConnections.push(item);
          currentMap.set(conn.id, {
            upload: conn.upload,
            download: conn.download,
            time: now,
            item,
          });
        }

        // 3. 检测已消失断开的连接，将其沉淀到 closedRequests 历史流
        const newClosedItems: ConnectionItem[] = [];
        prevMap.forEach((val, id) => {
          if (!currentMap.has(id)) {
            newClosedItems.push({
              ...val.item,
              closedAt: new Date().toLocaleTimeString(),
            });
          }
        });

        if (newClosedItems.length > 0) {
          setClosedRequests((prev) => {
            const combined = [...newClosedItems, ...prev];
            return combined.slice(0, 500); // 维持最多 500 条历史请求
          });
        }

        prevConnectionsMapRef.current = currentMap;
        setActiveConnections(enrichedConnections);
    };
    const unsubscribe = monitorStore.subscribeConnections(receive);
    const unsubscribeError = monitorStore.subscribeTraffic(() => setMonitorError(monitorStore.getTraffic().error));
    receive();
    return () => { unsubscribe(); unsubscribeError(); };
  }, [isPaused, visible]);

  // 断开单个连接 (D02: 真实校验结果，拒绝断开时不假消失)
  const handleCloseOne = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setClosingIds((prev) => new Set(prev).add(id));
    try {
      const ok = await closeConnection(id);
      if (!ok) {
        alert("断开连接失败：核心拒绝了关闭该连接的请求");
        return;
      }
      monitorStore.invalidate();
      setActiveConnections((prev) => prev.filter((c) => c.id !== id));
      const removed = prevConnectionsMapRef.current.get(id);
      if (removed) {
        setClosedRequests((prev) => [
          { ...removed.item, closedAt: new Date().toLocaleTimeString() },
          ...prev.slice(0, 499),
        ]);
        prevConnectionsMapRef.current.delete(id);
      }
    } catch (err: any) {
      console.error("关闭连接失败:", err);
      alert(`关闭连接异常: ${err?.message || err}`);
    } finally {
      setClosingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // 一键断开全部连接 (D02)
  const handleCloseAll = async () => {
    try {
      const ok = await closeAllConnections();
      if (!ok) {
        alert("断开全部连接失败：核心拒绝了请求");
        return;
      }
      setShowCloseAllConfirm(false);
      // 将所有活跃连接转移到历史
      const nowTime = new Date().toLocaleTimeString();
      const newClosed = activeConnections.map((c) => ({ ...c, closedAt: nowTime }));
      setClosedRequests((prev) => [...newClosed, ...prev].slice(0, 500));
      monitorStore.invalidate();
      setActiveConnections([]);
      prevConnectionsMapRef.current.clear();
    } catch (err: any) {
      console.error("断开全部连接失败:", err);
      alert(`断开全部连接异常: ${err?.message || err}`);
    }
  };

  // 清空历史记录
  const handleClearHistory = () => {
    setClosedRequests([]);
  };

  // 列表过滤与排序
  const displayList = useMemo(() => {
    const list = viewMode === "active" ? activeConnections : closedRequests;
    const query = settledQuery.trim().toLowerCase();

    return list
      .filter((c) => {
        // 协议筛选
        if (networkFilter !== "all" && c.metadata.network.toLowerCase() !== networkFilter) {
          return false;
        }
        // 搜索筛选
        if (!query) return true;
        const host = (c.metadata.host || "").toLowerCase();
        const destIp = (c.metadata.destinationIP || "").toLowerCase();
        const destPort = String(c.metadata.destinationPort || "");
        const process = (c.metadata.process || "").toLowerCase();
        const rule = (c.rule || "").toLowerCase();
        const rulePayload = (c.rulePayload || "").toLowerCase();
        const chains = (c.chains || []).join(" ").toLowerCase();

        return (
          host.includes(query) ||
          destIp.includes(query) ||
          destPort.includes(query) ||
          process.includes(query) ||
          rule.includes(query) ||
          rulePayload.includes(query) ||
          chains.includes(query)
        );
      })
      .sort((a, b) => {
        if (sortBy === "download") return b.download - a.download;
        if (sortBy === "upload") return b.upload - a.upload;
        if (sortBy === "downSpeed") return (b.downloadSpeed || 0) - (a.downloadSpeed || 0);
        if (sortBy === "time") {
          return new Date(b.start).getTime() - new Date(a.start).getTime();
        }
        return 0;
      });
  }, [viewMode, activeConnections, closedRequests, settledQuery, networkFilter, sortBy]);

  return (
    <div className="space-y-4">
      {/* 顶部指标卡片 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        {/* 1. 活动连接数 */}
        <div className="bg-white/90 dark:bg-slate-900/80 border border-slate-200/90 dark:border-slate-800/80 rounded-2xl p-4 shadow-sm transition-all duration-200">
          <div className="flex items-center justify-between mb-2">
            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
              <Activity className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-mono font-bold tracking-wider px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              ACTIVE
            </span>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium block">活跃连接</span>
          <p className="text-xl font-mono font-bold text-slate-900 dark:text-white mt-0.5">
            {activeConnections.length} <span className="text-xs font-normal text-slate-400">个会话</span>
          </p>
        </div>

        {/* 2. 实时下行 */}
        <div className="bg-white/90 dark:bg-slate-900/80 border border-slate-200/90 dark:border-slate-800/80 rounded-2xl p-4 shadow-sm transition-all duration-200">
          <div className="flex items-center justify-between mb-2">
            <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/20">
              <ArrowDown className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-mono font-bold tracking-wider px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
              DOWN
            </span>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium block">实时下行</span>
          <p className="text-xl font-mono font-bold text-slate-900 dark:text-white mt-0.5">
            {formatSpeed(aggregateDownSpeed)}
          </p>
        </div>

        {/* 3. 实时上行 */}
        <div className="bg-white/90 dark:bg-slate-900/80 border border-slate-200/90 dark:border-slate-800/80 rounded-2xl p-4 shadow-sm transition-all duration-200">
          <div className="flex items-center justify-between mb-2">
            <div className="p-2 rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
              <ArrowUp className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-mono font-bold tracking-wider px-2 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400">
              UP
            </span>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium block">实时上行</span>
          <p className="text-xl font-mono font-bold text-slate-900 dark:text-white mt-0.5">
            {formatSpeed(aggregateUpSpeed)}
          </p>
        </div>

        {/* 4. 累计吞吐 */}
        <div className="bg-white/90 dark:bg-slate-900/80 border border-slate-200/90 dark:border-slate-800/80 rounded-2xl p-4 shadow-sm transition-all duration-200">
          <div className="flex items-center justify-between mb-2">
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
              <Globe className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-mono font-bold tracking-wider px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              TOTAL
            </span>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium block">会话总吞吐</span>
          <p className="text-xl font-mono font-bold text-slate-900 dark:text-white mt-0.5">
            {formatBytes(totalDownload + totalUpload)}
          </p>
        </div>
      </div>

      {/* 视图切换分段器与操作控制条 */}
      <div className="bg-white dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 rounded-2xl p-3 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* 活跃连接与请求流水分段控件 */}
          <div className="flex items-center p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl border border-slate-200 dark:border-slate-700/60">
            <button
              onClick={() => setViewMode("active")}
              className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                viewMode === "active"
                  ? "bg-white dark:bg-indigo-600 text-indigo-600 dark:text-white shadow-sm"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>活跃连接</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-slate-200 dark:bg-indigo-700 text-slate-700 dark:text-white">
                {activeConnections.length}
              </span>
            </button>

            <button
              onClick={() => setViewMode("closed")}
              className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                viewMode === "closed"
                  ? "bg-white dark:bg-indigo-600 text-indigo-600 dark:text-white shadow-sm"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              <span>请求流水</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                {closedRequests.length}
              </span>
            </button>
          </div>

          {/* 右侧操作按钮组 */}
          <div className="flex items-center space-x-2">
            {/* 暂停 / 继续刷新 */}
            <button
              onClick={() => setIsPaused(!isPaused)}
              title={isPaused ? "继续实时拉取" : "暂停自动拉取"}
              className={`flex items-center space-x-1 px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-colors ${
                isPaused
                  ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
                  : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700"
              }`}
            >
              {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              <span>{isPaused ? "已暂停" : "实时"}</span>
            </button>

            {/* 一键断开全部连接（仅在活跃视图） */}
            {viewMode === "active" ? (
              <button
                onClick={() => setShowCloseAllConfirm(true)}
                disabled={activeConnections.length === 0}
                className="flex items-center space-x-1 px-3 py-1.5 rounded-xl text-xs font-semibold bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 border border-rose-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>断开全部</span>
              </button>
            ) : (
              <button
                onClick={handleClearHistory}
                disabled={closedRequests.length === 0}
                className="flex items-center space-x-1 px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 transition-colors disabled:opacity-40"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>清空流水</span>
              </button>
            )}
          </div>
        </div>

        {/* 筛选与搜索工具条 */}
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-100 dark:border-slate-800">
          {/* 搜索框 */}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索主机域名、IP、端口、进程名 (如 chrome.exe)、规则..."
              className="w-full pl-9 pr-8 py-1.5 text-xs bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:text-slate-200"
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

          {/* 协议过滤器 */}
          <div className="flex items-center space-x-1 bg-slate-50 dark:bg-slate-800/60 p-0.5 rounded-xl border border-slate-200 dark:border-slate-700">
            {(["all", "tcp", "udp"] as const).map((net) => (
              <button
                key={net}
                onClick={() => setNetworkFilter(net)}
                className={`px-2.5 py-1 text-xs font-mono font-medium rounded-lg uppercase transition-all ${
                  networkFilter === net
                    ? "bg-indigo-600 text-white shadow-xs"
                    : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white"
                }`}
              >
                {net === "all" ? "全部" : net}
              </button>
            ))}
          </div>

          {/* 排序方式 */}
          <div className="flex items-center space-x-1 bg-slate-50 dark:bg-slate-800/60 px-2 py-1 rounded-xl border border-slate-200 dark:border-slate-700 text-xs">
            <span className="text-slate-400">排序:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="bg-transparent text-slate-700 dark:text-slate-300 font-medium focus:outline-none cursor-pointer"
            >
              <option value="download" className="dark:bg-slate-800">已下载流量</option>
              <option value="upload" className="dark:bg-slate-800">已上传流量</option>
              <option value="downSpeed" className="dark:bg-slate-800">实时下行速率</option>
              <option value="time" className="dark:bg-slate-800">连接建立时间</option>
            </select>
          </div>
        </div>
      </div>

      {monitorError && <p role="status" className="text-xs text-amber-600">{monitorError}；当前列表为上次采样。</p>}
      <div className="flex justify-end"><MonitorPerformanceControl /></div>
      {/* 连接列表区域 */}
      {displayList.length === 0 ? (
        <div className="bg-white/80 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 rounded-2xl p-12 text-center shadow-sm">
          <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400">
            {viewMode === "active" ? <Activity className="w-6 h-6" /> : <Clock className="w-6 h-6" />}
          </div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
            {viewMode === "active" ? "暂无活跃连接" : "暂无历史请求流水"}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
            {viewMode === "active"
              ? "连接数据按周期采样，刷新期间可继续搜索和查看详情。"
              : "仅保留采样中观察到的最近 500 条已关闭连接；短连接可能未被采样。"}
          </p>
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm">
          <VirtualList items={displayList} itemKey={conn => conn.id} rowHeight={100} narrowRowHeight={156}
            label="连接追踪" renderRow={(conn) => {
              const isClosing = closingIds.has(conn.id);
              const processName = conn.metadata.process || conn.metadata.processPath?.split("\\").pop() || "";
              const hostTitle = conn.metadata.host || conn.metadata.destinationIP || "未知主机";
              const chainsStr = (conn.chains || []).join(" ➔ ") || "DIRECT";

              return (
                <div
                  key={conn.id}
                  onClick={() => setSelectedConnection(conn)}
                  role="button" tabIndex={0} aria-label={`查看连接 ${hostTitle}`}
                  onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setSelectedConnection(conn); } }}
                  className="h-full overflow-hidden p-3.5 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer flex flex-col md:flex-row md:items-center justify-between gap-3 group"
                >
                  {/* 左侧：主机、IP、进程与协议 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2">
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                        {conn.metadata.network}
                      </span>
                      <h4 className="text-xs sm:text-sm font-semibold text-slate-800 dark:text-slate-200 truncate font-mono" title={hostTitle}>
                        {hostTitle}
                        <span className="text-slate-400 text-xs font-normal ml-1.5">
                          :{conn.metadata.destinationPort}
                        </span>
                      </h4>
                      {processName && (
                        <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 truncate max-w-[150px]">
                          <Laptop className="w-2.5 h-2.5 flex-shrink-0" />
                          <span className="truncate">{processName}</span>
                        </span>
                      )}
                    </div>

                    {/* 下方元数据：IP映射、链路链条与分流规则 */}
                    <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                      {conn.metadata.destinationIP && conn.metadata.host && (
                        <span className="font-mono text-slate-400">
                          ➔ {conn.metadata.destinationIP}
                        </span>
                      )}
                      <span className="inline-flex items-center space-x-1 px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 font-mono">
                        <Layers className="w-2.5 h-2.5 text-indigo-400" />
                        <span>{conn.rule}</span>
                        {conn.rulePayload && <span className="text-slate-400">({conn.rulePayload})</span>}
                      </span>
                      <span className="inline-flex items-center space-x-1 text-slate-500 dark:text-slate-400 font-mono text-[10px]">
                        <Server className="w-2.5 h-2.5 text-emerald-500" />
                        <span className="truncate max-w-[220px]">{chainsStr}</span>
                      </span>
                    </div>
                  </div>

                  {/* 右侧：流量吞吐、速率、时间与操作 */}
                  <div className="flex items-center justify-between md:justify-end space-x-4 flex-shrink-0 pt-2 md:pt-0 border-t md:border-t-0 border-slate-100 dark:border-slate-800/60">
                    {/* 实时速率 / 累计流量 */}
                    <div className="text-right font-mono">
                      <div className="flex items-center justify-end space-x-2 text-xs font-semibold text-slate-800 dark:text-slate-200">
                        <span className="inline-flex items-center text-cyan-600 dark:text-cyan-400">
                          <ArrowDown className="w-3 h-3 mr-0.5" />
                          {formatBytes(conn.download)}
                        </span>
                        <span className="inline-flex items-center text-purple-600 dark:text-purple-400">
                          <ArrowUp className="w-3 h-3 mr-0.5" />
                          {formatBytes(conn.upload)}
                        </span>
                      </div>
                      <div className="flex items-center justify-end space-x-2 text-[10px] text-slate-400 mt-0.5">
                        {conn.downloadSpeed && conn.downloadSpeed > 0 ? (
                          <span className="text-cyan-500 font-medium">
                            ↓ {formatSpeed(conn.downloadSpeed)}
                          </span>
                        ) : null}
                        <span>{viewMode === "active" ? formatDuration(conn.start) : `断开于 ${conn.closedAt || "-"}`}</span>
                      </div>
                    </div>

                    {/* 单独断开按钮（活跃连接） */}
                    {viewMode === "active" ? (
                      <button
                        onClick={(e) => handleCloseOne(conn.id, e)}
                        disabled={isClosing}
                        title="立即掐断此连接"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    ) : (
                      <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-500 transition-colors" />
                    )}
                  </div>
                </div>
              );
            }} />
        </div>
      )}

      {/* 一键断开全部连接确认弹窗 */}
      {showCloseAllConfirm && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-sm w-full p-5 shadow-2xl space-y-4">
            <div className="flex items-center space-x-3 text-rose-500">
              <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20">
                <AlertCircle className="w-6 h-6" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-slate-900 dark:text-white">断开全部活跃连接</h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">此操作将掐断当前所有 {activeConnections.length} 个会话</p>
              </div>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              正在进行的下载、视频播放或流媒体会话可能会被瞬间中断。新发起的网络请求将自动重连并分配节点。是否确认执行？
            </p>
            <div className="flex items-center justify-end space-x-2 pt-2">
              <button
                onClick={() => setShowCloseAllConfirm(false)}
                className="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCloseAll}
                className="px-4 py-1.5 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white shadow-sm transition-colors"
              >
                确认断开
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 单条连接详情模态弹窗 (Detail Modal) */}
      {selectedConnection && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-lg w-full p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center space-x-2">
                <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                  <Activity className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-slate-900 dark:text-white">连接元数据详情</h4>
                  <p className="text-xs font-mono text-slate-400 truncate max-w-[320px]">{selectedConnection.id}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedConnection(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2 text-xs font-mono">
              <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/60">
                <span className="text-slate-500 font-sans">目标主机 (Host):</span>
                <span className="text-slate-800 dark:text-slate-200 font-semibold">{selectedConnection.metadata.host || "-"}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/60">
                <span className="text-slate-500 font-sans">目的地址 (Dest):</span>
                <span className="text-slate-800 dark:text-slate-200">
                  {selectedConnection.metadata.destinationIP}:{selectedConnection.metadata.destinationPort}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/60">
                <span className="text-slate-500 font-sans">源地址 (Source):</span>
                <span className="text-slate-800 dark:text-slate-200">
                  {selectedConnection.metadata.sourceIP}:{selectedConnection.metadata.sourcePort}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/60">
                <span className="text-slate-500 font-sans">网络类型:</span>
                <span className="uppercase text-indigo-600 dark:text-indigo-400 font-bold">
                  {selectedConnection.metadata.network} ({selectedConnection.metadata.type})
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/60">
                <span className="text-slate-500 font-sans">命中规则:</span>
                <span className="text-emerald-600 dark:text-emerald-400">
                  {selectedConnection.rule} {selectedConnection.rulePayload && `(${selectedConnection.rulePayload})`}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/60">
                <span className="text-slate-500 font-sans">出口链路:</span>
                <span className="text-slate-800 dark:text-slate-200 font-semibold">
                  {(selectedConnection.chains || []).join(" ➔ ") || "DIRECT"}
                </span>
              </div>
              {selectedConnection.metadata.process && (
                <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/60">
                  <span className="text-slate-500 font-sans">触发进程:</span>
                  <span className="text-slate-800 dark:text-slate-200">{selectedConnection.metadata.process}</span>
                </div>
              )}
              {selectedConnection.metadata.processPath && (
                <div className="py-1 border-b border-slate-100 dark:border-slate-800/60">
                  <span className="text-slate-500 font-sans block mb-1">进程完整路径:</span>
                  <span className="text-[11px] text-slate-600 dark:text-slate-400 break-all">
                    {selectedConnection.metadata.processPath}
                  </span>
                </div>
              )}
              <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/60">
                <span className="text-slate-500 font-sans">下行/上行流量:</span>
                <span className="text-slate-800 dark:text-slate-200">
                  ↓ {formatBytes(selectedConnection.download)} / ↑ {formatBytes(selectedConnection.upload)}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-slate-500 font-sans">建立时间:</span>
                <span className="text-slate-800 dark:text-slate-200">{new Date(selectedConnection.start).toLocaleString()}</span>
              </div>
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2">
              {viewMode === "active" && (
                <button
                  onClick={() => {
                    handleCloseOne(selectedConnection.id);
                    setSelectedConnection(null);
                  }}
                  className="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 border border-rose-500/30 transition-colors"
                >
                  掐断此会话
                </button>
              )}
              <button
                onClick={() => setSelectedConnection(null)}
                className="px-4 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
