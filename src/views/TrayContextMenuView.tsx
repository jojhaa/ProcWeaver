import React, { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Globe,
  Zap,
  Shield,
  RotateCw,
  Power,
  ChevronRight,
  Wrench,
  Check,
  Terminal,
  Activity,
  Layers,
  Sparkles,
} from "lucide-react";

interface TrayNodeItem {
  name: string;
  delay?: number;
  active: boolean;
}

interface TrayRegionGroup {
  region: string;
  nodes: TrayNodeItem[];
}

interface TrayMenuPayload {
  running: boolean;
  mode: string;
  sysProxyEnabled: boolean;
  sysProxyState?: "enabled" | "disabled" | "external" | "unknown";
  autoRun: boolean;
  processEnabled: boolean;
  activeNode?: string;
  activeNodeDelay?: number;
  downSpeed?: number;
  upSpeed?: number;
  groups: TrayRegionGroup[];
  direction?: string;
}

function formatSpeed(bps?: number): string {
  if (!bps || bps <= 0) return "0 B/s";
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

type SubmenuType = "none" | "nodes" | "mode" | "tools";

export const TrayContextMenuView: React.FC = () => {
  const [payload, setPayload] = useState<TrayMenuPayload>({
    running: false,
    mode: "rule",
    sysProxyEnabled: false,
    autoRun: false,
    processEnabled: true,
    groups: [],
    direction: "left",
  });
  const [direction, setDirection] = useState<"left" | "right">("left");
  const [activeSubmenu, setActiveSubmenu] = useState<SubmenuType>("none");
  const [expandedRegion, setExpandedRegion] = useState<string | null>(null);

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.className = "antialiased select-none overflow-hidden bg-transparent m-0 p-0";

    // 初始与每次聚焦时直接拉取 Rust 核心穿透真实数据
    const fetchLatestPayload = () => {
      invoke<TrayMenuPayload | null>("get_tray_payload")
        .then((data) => {
          if (data) {
            setPayload(data);
            if (data.direction === "right" || data.direction === "left") {
              setDirection(data.direction);
            }
          }
        })
        .catch(() => {});
    };

    fetchLatestPayload();
    window.addEventListener("focus", fetchLatestPayload);

    // 监听实时更新与飞出方向通知
    const unlistenUpdated = listen<TrayMenuPayload>("tray-payload-updated", (e) => {
      setPayload(e.payload);
      if (e.payload.direction === "right" || e.payload.direction === "left") {
        setDirection(e.payload.direction);
      }
    });

    const unlistenTraffic = listen<{ downSpeed: number; upSpeed: number }>("tray-traffic-updated", e => {
      setPayload(previous => ({ ...previous, ...e.payload }));
    });

    const unlistenDir = listen<string>("tray-direction-changed", (e) => {
      if (e.payload === "right" || e.payload === "left") {
        setDirection(e.payload);
      }
    });

    // 窗口失焦或按 Esc 瞬退
    const handleBlur = () => {
      setActiveSubmenu("none");
      invoke("hide_tray_menu");
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setActiveSubmenu("none");
        invoke("hide_tray_menu");
      }
    };
    window.addEventListener("blur", handleBlur);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      unlistenUpdated.then((u) => u());
      unlistenTraffic.then(u => u());
      unlistenDir.then((u) => u());
      window.removeEventListener("focus", fetchLatestPayload);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // 鼠标感应 Hover Intent（60ms 悬停识别，避免快速掠过乱闪）
  const handleTriggerEnter = (type: SubmenuType) => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = setTimeout(() => {
      setActiveSubmenu(type);
    }, 60);
  };

  // 鼠标离开触发项（180ms 斜移保护期，防止斜向移向二级菜单半路脱手）
  const handleTriggerLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    leaveTimerRef.current = setTimeout(() => {
      setActiveSubmenu("none");
    }, 180);
  };

  // 鼠标移入二级子菜单区域：立即取消关闭，锁定保持
  const handleSubmenuEnter = () => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  };

  // 鼠标真正离开二级子菜单
  const handleSubmenuLeave = () => {
    leaveTimerRef.current = setTimeout(() => {
      setActiveSubmenu("none");
    }, 180);
  };

  const handleAction = async (id: string) => {
    try {
      await invoke("execute_tray_menu_action", { id });
    } finally {
      setActiveSubmenu("none");
      await invoke("hide_tray_menu");
    }
  };

  const modeZh =
    payload.mode === "global"
      ? "全局代理"
      : payload.mode === "direct"
      ? "直接连接"
      : "规则分流";

  return (
    <div className="w-[500px] h-[380px] bg-transparent overflow-visible relative flex items-end select-none text-xs font-sans p-2">
      {/* 动态画布布局容器 */}
      <div
        className={`w-full flex items-end ${
          direction === "left" ? "justify-end space-x-2" : "justify-start flex-row-reverse space-x-2 space-x-reverse"
        }`}
      >
        {/* ===================== 二级飞出感应子菜单 ===================== */}
        {activeSubmenu !== "none" && (
          <div
            onMouseEnter={handleSubmenuEnter}
            onMouseLeave={handleSubmenuLeave}
            className="w-[236px] max-h-[360px] bg-slate-900/95 dark:bg-slate-950/95 backdrop-blur-2xl border border-white/10 rounded-2xl p-1.5 shadow-2xl text-slate-100 flex flex-col animate-in fade-in zoom-in-95 duration-100 overflow-hidden"
          >
            {/* 子菜单 1：节点秒切 */}
            {activeSubmenu === "nodes" && (
              <div className="flex flex-col h-full overflow-hidden">
                <div className="px-2 py-1 text-[11px] font-bold text-slate-400 border-b border-white/10 mb-1 flex items-center justify-between">
                  <span>🚀 节点线路秒切</span>
                  <span className="text-[9px] text-slate-500 font-mono">
                    {payload.groups.reduce((acc, g) => acc + g.nodes.length, 0)} 节点
                  </span>
                </div>

                <div className="flex-1 overflow-y-auto space-y-1 pr-0.5 custom-scrollbar text-[11px]">
                  {/* 一键全局最快 */}
                  <button
                    type="button"
                    onClick={() => handleAction("select_fastest_node")}
                    className="w-full flex items-center space-x-1.5 px-2 py-1.5 rounded-xl bg-indigo-500/20 border border-indigo-500/30 text-indigo-200 hover:bg-indigo-500/30 transition text-left cursor-pointer font-bold"
                  >
                    <Zap className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                    <span>⚡ 全局测速优选 (切最快)</span>
                  </button>

                  {/* 地区分组 */}
                  {payload.groups.map((group) => {
                    const isExpanded = expandedRegion === group.region;
                    return (
                      <div
                        key={group.region}
                        className="rounded-xl bg-white/[0.03] border border-white/5 overflow-hidden"
                      >
                        <button
                          type="button"
                          onClick={() => setExpandedRegion(isExpanded ? null : group.region)}
                          className="w-full flex items-center justify-between px-2 py-1 hover:bg-white/[0.06] transition text-left cursor-pointer"
                        >
                          <span className="font-medium text-slate-300">
                            {group.region} ({group.nodes.length})
                          </span>
                          <ChevronRight
                            className={`w-3 h-3 text-slate-500 transition-transform ${
                              isExpanded ? "rotate-90" : ""
                            }`}
                          />
                        </button>

                        {isExpanded && (
                          <div className="p-1 space-y-0.5 bg-black/30 border-t border-white/5">
                            <button
                              type="button"
                              onClick={() => handleAction(`select_fastest_region:${group.region}`)}
                              className="w-full flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] text-amber-300 hover:bg-white/10 transition text-left cursor-pointer"
                            >
                              <Zap className="w-3 h-3 text-amber-400 shrink-0" />
                              <span>⚡ 优选此地区最低延迟</span>
                            </button>

                            {group.nodes.slice(0, 12).map((node) => (
                              <button
                                key={node.name}
                                type="button"
                                onClick={() => handleAction(`select_node:${node.name}`)}
                                className={`w-full flex items-center justify-between px-1.5 py-0.5 rounded transition text-left cursor-pointer ${
                                  node.active
                                    ? "bg-emerald-500/20 text-emerald-300 font-bold"
                                    : "text-slate-300 hover:bg-white/[0.08]"
                                }`}
                              >
                                <div className="flex items-center space-x-1 truncate mr-1">
                                  {node.active ? (
                                    <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                                  ) : (
                                    <div className="w-3 h-3 shrink-0" />
                                  )}
                                  <span className="truncate">{node.name}</span>
                                </div>
                                {node.delay && node.delay > 0 ? (
                                  <span
                                    className={`text-[9px] font-mono ${
                                      node.delay < 80
                                        ? "text-emerald-400"
                                        : node.delay < 180
                                        ? "text-amber-400"
                                        : "text-rose-400"
                                    }`}
                                  >
                                    {node.delay}ms
                                  </span>
                                ) : null}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <button
                    type="button"
                    onClick={() => handleAction("open_node_view")}
                    className="w-full text-center py-1 text-[10px] text-slate-400 hover:text-indigo-300 transition cursor-pointer"
                  >
                    🌐 在主面板查看全部节点...
                  </button>
                </div>
              </div>
            )}

            {/* 子菜单 2：分流模式 */}
            {activeSubmenu === "mode" && (
              <div className="space-y-1">
                <div className="px-2 py-1 text-[11px] font-bold text-slate-400 border-b border-white/10 mb-1">
                  🛡 分流运行模式
                </div>
                {[
                  {
                    id: "rule",
                    title: "规则分流 (Rule)",
                    desc: "推荐：应用与域名按预设矩阵智能分流",
                  },
                  {
                    id: "global",
                    title: "全局代理 (Global)",
                    desc: "所有出站流量强锁当前出口节点",
                  },
                  {
                    id: "direct",
                    title: "直接连接 (Direct)",
                    desc: "所有出站流量不走代理直接通信",
                  },
                ].map((m) => {
                  const selected = payload.mode === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => handleAction(`set_mode:${m.id}`)}
                      className={`w-full p-2 rounded-xl border text-left transition cursor-pointer ${
                        selected
                          ? "bg-indigo-500/20 border-indigo-500/40 text-white"
                          : "bg-white/[0.03] border-white/5 text-slate-300 hover:bg-white/[0.06]"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="font-bold text-[11px]">{m.title}</span>
                        <span
                          className={`w-2 h-2 rounded-full ${
                            selected ? "bg-indigo-400 ring-2 ring-indigo-400/30" : "bg-slate-600"
                          }`}
                        />
                      </div>
                      <div className="text-[9px] text-slate-400 leading-tight">{m.desc}</div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* 子菜单 3：网络急救 */}
            {activeSubmenu === "tools" && (
              <div className="space-y-1">
                <div className="px-2 py-1 text-[11px] font-bold text-slate-400 border-b border-white/10 mb-1">
                  🛠 网络急救与实用工具
                </div>

                <button
                  type="button"
                  onClick={() => handleAction("tool:flush_dns")}
                  className="w-full flex items-center space-x-2 px-2 py-1.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 transition text-left cursor-pointer"
                >
                  <RotateCw className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <div>
                    <div className="font-medium text-slate-200 text-[11px]">刷新系统 DNS 缓存</div>
                    <div className="text-[9px] text-slate-400">清理本地脏解析与域解析异常</div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleAction("tool:close_all_conns")}
                  className="w-full flex items-center space-x-2 px-2 py-1.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 transition text-left cursor-pointer"
                >
                  <Power className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <div>
                    <div className="font-medium text-slate-200 text-[11px]">掐断所有当前连接</div>
                    <div className="text-[9px] text-slate-400">强制长连接重新协商新出口节点</div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleAction("tool:copy_env_pwsh")}
                  className="w-full flex items-center space-x-2 px-2 py-1.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 transition text-left cursor-pointer"
                >
                  <Terminal className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <div>
                    <div className="font-medium text-slate-200 text-[11px]">复制 PowerShell 代理命令</div>
                    <div className="text-[9px] text-slate-400">$env:http_proxy=...</div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleAction("tool:copy_env_cmd")}
                  className="w-full flex items-center space-x-2 px-2 py-1.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 transition text-left cursor-pointer"
                >
                  <Terminal className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                  <div>
                    <div className="font-medium text-slate-200 text-[11px]">复制 CMD 代理命令</div>
                    <div className="text-[9px] text-slate-400">set http_proxy=...</div>
                  </div>
                </button>

                <div className="border-t border-white/[0.08] my-0.5" />

                <button
                  type="button"
                  onClick={() => handleAction("tool:restart_core")}
                  className="w-full flex items-center space-x-2 px-2 py-1.5 rounded-xl bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 transition text-left cursor-pointer text-indigo-300"
                >
                  <RotateCw className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <div>
                    <div className="font-bold text-[11px]">♻️ 重启网络核心服务</div>
                    <div className="text-[9px] text-indigo-400/80">重新拉起并刷新路由编织底座</div>
                  </div>
                </button>
              </div>
            )}
          </div>
        )}

        {/* ===================== 主菜单卡片 (紧凑高质感，约310px) ===================== */}
        <div className="w-[244px] h-auto bg-slate-900/95 dark:bg-slate-950/95 backdrop-blur-2xl border border-white/10 rounded-2xl p-2 shadow-2xl text-slate-100 flex flex-col space-y-1">
          {/* 标头卡片 */}
          <div className="rounded-xl bg-white/[0.04] border border-white/5 p-2 space-y-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-1.5 font-bold tracking-tight text-white text-[12px]">
                <span className="text-indigo-400">❖</span>
                <span>ProcWeaver</span>
              </div>
              <div className="flex items-center space-x-1 text-[10px]">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    payload.running ? "bg-emerald-400 animate-pulse" : "bg-slate-500"
                  }`}
                />
                <span className={payload.running ? "text-emerald-400 font-medium" : "text-slate-400"}>
                  {payload.running ? `运行中 · ${modeZh}` : "内核已停止"}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between text-[10px] text-slate-300 pt-0.5">
              <div
                onClick={() => handleAction("open_node_view")}
                className="truncate max-w-[130px] flex items-center space-x-1 cursor-pointer hover:text-indigo-300 transition"
                title="点击在主界面定位出口"
              >
                <span className="text-amber-400">📍</span>
                <span className="font-medium truncate text-slate-200">
                  {payload.activeNode || "未选择节点"}
                </span>
                {payload.activeNodeDelay && payload.activeNodeDelay > 0 ? (
                  <span className="text-emerald-400 text-[9px] font-mono">
                    {payload.activeNodeDelay}ms
                  </span>
                ) : null}
              </div>
              <div className="text-slate-400 font-mono text-[9px]">
                ↓{formatSpeed(payload.downSpeed)}
              </div>
            </div>
          </div>

          {/* 核心开关组 */}
          <div className="space-y-0.5">
            {/* 系统代理 */}
            <button
              type="button"
              onClick={() => handleAction("toggle_sysproxy")}
              className="w-full flex items-center justify-between px-2 py-1.5 rounded-xl hover:bg-white/[0.08] transition text-left cursor-pointer group"
            >
              <div className="flex items-center space-x-2">
                <Globe className="w-3.5 h-3.5 text-sky-400" />
                <span className="text-slate-200">系统全局代理</span>
              </div>
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  payload.sysProxyEnabled
                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                    : "bg-white/5 text-slate-400"
                }`}
              >
                {payload.sysProxyState === "unknown" || !payload.sysProxyState ? "状态未知"
                  : payload.sysProxyState === "external" ? "其他代理"
                  : payload.sysProxyEnabled ? "● 已开启" : "○ 已关闭"}
              </span>
            </button>

            {/* 进程分流 */}
            <button
              type="button"
              onClick={() => handleAction("toggle_process_master")}
              className="w-full flex items-center justify-between px-2 py-1.5 rounded-xl hover:bg-white/[0.08] transition text-left cursor-pointer group"
            >
              <div className="flex items-center space-x-2">
                <Zap className="w-3.5 h-3.5 text-indigo-400" />
                <span className="text-slate-200">进程与应用分流</span>
              </div>
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  payload.processEnabled
                    ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                    : "bg-white/5 text-slate-400"
                }`}
              >
                {payload.processEnabled ? "● 已开启" : "○ 待机中"}
              </span>
            </button>

            {/* 开机自启 */}
            <button
              type="button"
              onClick={() => handleAction("toggle_autolaunch")}
              className="w-full flex items-center justify-between px-2 py-1.5 rounded-xl hover:bg-white/[0.08] transition text-left cursor-pointer group"
            >
              <div className="flex items-center space-x-2">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-slate-200">开机自动启动</span>
              </div>
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  payload.autoRun
                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                    : "bg-white/5 text-slate-400"
                }`}
              >
                {payload.autoRun ? "● 已开启" : "○ 已关闭"}
              </span>
            </button>
          </div>

          <div className="border-t border-white/[0.08] my-0.5" />

          {/* 级联感应项 */}
          <div className="space-y-0.5">
            {/* 节点秒切 */}
            <div
              onMouseEnter={() => handleTriggerEnter("nodes")}
              onMouseLeave={handleTriggerLeave}
              className={`w-full flex items-center justify-between px-2 py-1.5 rounded-xl transition text-left cursor-pointer group ${
                activeSubmenu === "nodes" ? "bg-white/10 text-white" : "hover:bg-white/[0.08] text-slate-200"
              }`}
            >
              <div className="flex items-center space-x-2 truncate mr-1">
                <Layers className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>节点线路秒切</span>
              </div>
              <div className="flex items-center space-x-1 text-slate-400 shrink-0">
                <span className="text-[10px] max-w-[70px] truncate text-slate-300">
                  {payload.activeNode || "选择"}
                </span>
                <ChevronRight className="w-3.5 h-3.5 text-slate-500 group-hover:text-white transition" />
              </div>
            </div>

            {/* 分流模式 */}
            <div
              onMouseEnter={() => handleTriggerEnter("mode")}
              onMouseLeave={handleTriggerLeave}
              className={`w-full flex items-center justify-between px-2 py-1.5 rounded-xl transition text-left cursor-pointer group ${
                activeSubmenu === "mode" ? "bg-white/10 text-white" : "hover:bg-white/[0.08] text-slate-200"
              }`}
            >
              <div className="flex items-center space-x-2">
                <Shield className="w-3.5 h-3.5 text-purple-400" />
                <span>分流运行模式</span>
              </div>
              <div className="flex items-center space-x-1 text-slate-400">
                <span className="text-[10px] text-slate-300">{modeZh}</span>
                <ChevronRight className="w-3.5 h-3.5 text-slate-500 group-hover:text-white transition" />
              </div>
            </div>

            {/* 网络急救工具 */}
            <div
              onMouseEnter={() => handleTriggerEnter("tools")}
              onMouseLeave={handleTriggerLeave}
              className={`w-full flex items-center justify-between px-2 py-1.5 rounded-xl transition text-left cursor-pointer group ${
                activeSubmenu === "tools" ? "bg-white/10 text-white" : "hover:bg-white/[0.08] text-slate-200"
              }`}
            >
              <div className="flex items-center space-x-2">
                <Wrench className="w-3.5 h-3.5 text-teal-400" />
                <span>网络急救与工具</span>
              </div>
              <ChevronRight className="w-3.5 h-3.5 text-slate-500 group-hover:text-white transition" />
            </div>
          </div>

          <div className="border-t border-white/[0.08] my-0.5" />

          {/* 运维与退出 */}
          <div className="space-y-0.5">
            <button
              type="button"
              onClick={() => handleAction("open")}
              className="w-full flex items-center space-x-2 px-2 py-1.5 rounded-xl hover:bg-white/[0.08] text-slate-300 hover:text-white transition text-left cursor-pointer"
            >
              <Activity className="w-3.5 h-3.5 text-indigo-400" />
              <span>打开控制主面板</span>
            </button>
            <button
              type="button"
              onClick={() => handleAction("quit")}
              className="w-full flex items-center space-x-2 px-2 py-1.5 rounded-xl text-rose-400 hover:bg-rose-500/20 hover:text-rose-300 transition text-left cursor-pointer"
            >
              <Power className="w-3.5 h-3.5" />
              <span>彻底退出 ProcWeaver</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
