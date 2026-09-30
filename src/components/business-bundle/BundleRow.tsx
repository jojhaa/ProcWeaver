import React, { useState, useEffect, useRef } from "react";
import { BundleLocalInstance } from "../../types/businessBundle";
import type { BundleStatus } from "../../utils/bundleController";
import type { BundleEntryState } from "../../api/bundleTools";
import { usePlatform } from "../../context/PlatformContext";
import { bundleProcesses } from "../../utils/bundlePlatform";
import {
  Play,
  MoreHorizontal,
  Activity,
  Network,
  Pencil,
  Upload,
  Trash2,
  ArrowUp,
  ArrowDown,
  ExternalLink,
} from "lucide-react";

interface Props {
  instance: BundleLocalInstance;
  status: BundleStatus;
  entry?: BundleEntryState;
  proxyLabels?: Record<string, string>;
  onLaunch: () => void;
  onShortcuts: () => void;
  onToggleSwitch: (instanceId: string, nextState: boolean) => void;
  onOpenSelectExit: (instance: BundleLocalInstance) => void;
  onOpenDetail: (instance: BundleLocalInstance) => void;
  onEdit: (instance: BundleLocalInstance) => void;
  onExport: (instance: BundleLocalInstance) => void;
  onDelete: (instanceId: string) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

export const BundleRow: React.FC<Props> = ({
  instance,
  status,
  entry,
  proxyLabels = {},
  onLaunch,
  onShortcuts,
  onToggleSwitch,
  onOpenSelectExit,
  onOpenDetail,
  onEdit,
  onExport,
  onDelete,
  onMoveUp,
  onMoveDown,
  canMoveUp = false,
  canMoveDown = false,
}) => {
  const platform = usePlatform();
  const processes = bundleProcesses(
    instance.definition,
    platform.os === "android" ? "android" : platform.os === "macos" ? "macos" : "windows"
  );

  const def = instance.definition;
  const boundNode = instance.slotBindings.main;
  const isRequested = instance.enabled && Boolean(boundNode);
  const isEnabled = isRequested && status.phase === "applied";
  const canLaunch = !instance.enabled || isEnabled || status.phase === "saved" || status.phase === "paused";

  // 右键菜单与更多操作状态
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPosition = (x: number, y: number) => ({
    x: Math.max(10, Math.min(x, window.innerWidth - 202)),
    y: Math.max(10, Math.min(y, window.innerHeight - 310)),
  });

  // 点击外部关闭右键菜单
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenuPos(null);
      }
    };
    const closeOnScroll = (e: Event) => { if (!(e.target instanceof Node) || !menuRef.current?.contains(e.target)) setContextMenuPos(null); };
    if (contextMenuPos) {
      window.addEventListener("mousedown", handleOutsideClick);
      window.addEventListener("scroll", closeOnScroll, true);
    }
    return () => {
      window.removeEventListener("mousedown", handleOutsideClick);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [contextMenuPos]);

  // 处理行右键
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 限制菜单在视口内
    setContextMenuPos(menuPosition(e.clientX, e.clientY));
  };

  // 处理行尾更多按钮点击
  const handleMoreButtonClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenuPos(menuPosition(rect.left - 140, rect.bottom + 6));
  };

  // 点击主开关
  const handleSwitchClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!instance.enabled) {
      if (!boundNode) {
        // 未绑定出口 -> 直接呼出出口选择弹窗
        onOpenSelectExit(instance);
      } else {
        onToggleSwitch(instance.instanceId, true);
      }
    } else {
      onToggleSwitch(instance.instanceId, false);
    }
  };

  return (
    <div
      onContextMenu={handleContextMenu}
      onDoubleClick={() => onOpenDetail(instance)}
      className="group relative flex items-center justify-between px-4 py-3 rounded-2xl bg-white dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800/80 hover:border-indigo-400/80 dark:hover:border-indigo-500/50 hover:shadow-md transition-all select-none cursor-pointer"
      title="双击查看运行详情，右键呼出管理菜单"
    >
      {/* 左侧区域：开关 + 应用信息 + 模式 */}
      <div className="flex items-center space-x-3.5 min-w-0 pr-2">
        {/* 1. 开关 */}
        <button
          type="button"
          onClick={handleSwitchClick}
          onDoubleClick={(e) => e.stopPropagation()}
          role="switch"
          aria-label={`${def.packageName}启用开关`}
          aria-checked={instance.enabled}
          aria-busy={status.phase === "pending"}
          disabled={status.phase === "pending"}
          className={`shrink-0 relative inline-flex w-10 h-[22px] items-center rounded-full transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 disabled:cursor-wait disabled:opacity-60 ${
            isEnabled
              ? "bg-emerald-500 shadow-sm"
              : instance.enabled
              ? "bg-amber-500"
              : "bg-slate-300 dark:bg-slate-700"
          }`}
          title={instance.enabled ? "点击停用该套件" : boundNode ? "点击开启该套件" : "点击选择出口并开启"}
        >
          <span
            aria-hidden="true"
            className={`absolute left-0.5 top-0.5 w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 ${
              instance.enabled ? "translate-x-[18px]" : "translate-x-0"
            }`}
          />
        </button>

        {/* 2. 应用名与状态指示 */}
        <div className="flex items-center space-x-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80 flex items-center justify-center text-xl shrink-0 shadow-inner">
            {def.icon || "📦"}
          </div>

          <div className="min-w-0">
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-slate-900 dark:text-white truncate">
                {def.packageName}
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 shrink-0">
                {def.packageVersion}
              </span>
              {instance.isModified && (
                <span className="text-[9px] px-1 py-0.2 rounded font-medium bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30 shrink-0">
                  自定义
                </span>
              )}
            </div>

            {/* 状态小灯与简讯 */}
            <div
              className="flex items-center space-x-1.5 text-[11px] text-slate-500 dark:text-slate-400 mt-0.5"
              title={entry?.connectionMessage || entry?.message || status.message}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  isEnabled
                    ? entry?.connectionState === "error"
                      ? "bg-amber-400"
                      : "bg-emerald-500 shadow-xs"
                    : isRequested
                    ? "bg-amber-500"
                    : "bg-slate-400 dark:bg-slate-600"
                }`}
              />
              <span className="truncate">
                {isEnabled
                  ? entry?.message
                    ? entry.message.slice(0, 16)
                    : "已接管运行"
                  : status.phase === "pending"
                  ? "正在确认变更"
                  : status.phase === "error"
                  ? "应用失败，查看详情"
                  : status.phase === "paused"
                  ? "总开关已暂停"
                  : status.phase === "saved"
                  ? "已保存待启动"
                  : !boundNode
                  ? "待指定节点"
                  : "已停用 (系统默认)"}
              </span>
              <span className="text-slate-300 dark:text-slate-700">·</span>
              <span className="text-[10px] font-mono text-slate-400 shrink-0">
                {processes.length}进程/{def.domains?.length || 0}域名
              </span>
            </div>
          </div>
        </div>

        {/* 3. 分流模式 */}
        <div className="shrink-0 hidden sm:block">
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
              isRequested
                ? def.mode === "sandbox"
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                  : "bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/30"
                : "bg-slate-100 dark:bg-slate-800 text-slate-500 border-slate-200 dark:border-slate-700"
            }`}
          >
            {def.mode === "sandbox" ? "🌱 沙盒" : "🔒 强锁"}
          </span>
        </div>
      </div>

      {/* 右侧区域：节点药丸 + 启动按钮 + 更多操作 */}
      <div className="flex items-center space-x-2.5 shrink-0" onClick={(e) => e.stopPropagation()}>
        {/* 4. 节点按钮 (弹窗形式呼出出口选择) */}
        <button
          type="button"
          onClick={() => onOpenSelectExit(instance)}
          className={`h-7 px-3 rounded-lg text-xs font-mono font-bold border transition flex items-center space-x-1.5 cursor-pointer max-w-[170px] truncate ${
            boundNode
              ? "bg-emerald-50/80 hover:bg-emerald-100/80 dark:bg-emerald-950/40 dark:hover:bg-emerald-900/60 border-emerald-500/40 text-emerald-700 dark:text-emerald-300 shadow-2xs"
              : "bg-slate-50 hover:bg-amber-50 dark:bg-slate-800/80 dark:hover:bg-slate-800 border-slate-200 dark:border-slate-700 hover:border-amber-400 text-slate-500 dark:text-slate-400"
          }`}
          title="点击更换该业务包的出站节点"
        >
          <Network className="w-3 h-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="truncate">{boundNode ? proxyLabels[boundNode] || boundNode : "选择出口..."}</span>
          <span className="text-[10px] text-slate-400 shrink-0">▾</span>
        </button>

        {/* 5. 启动按钮 */}
        {platform.appProxy && (
          <button
            type="button"
            disabled={!canLaunch}
            onClick={onLaunch}
            className="h-7 px-3 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs transition flex items-center space-x-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title="通过 ProcWeaver 拉起应用并自动注入代理环境"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>启动</span>
          </button>
        )}

        {/* 6. 行尾 `···` 更多操作 */}
        <button
          type="button"
          onClick={handleMoreButtonClick}
          className="h-7 w-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
          title="更多管理操作"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </div>

      {/* 悬浮右键上下文菜单 */}
      {contextMenuPos && (
        <div
          ref={menuRef}
          style={{ top: contextMenuPos.y, left: contextMenuPos.x, maxHeight: "calc(100vh - 20px)", overflowY: "auto" }}
          className="fixed z-50 w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl py-1.5 text-xs text-slate-700 dark:text-slate-300 animate-in fade-in zoom-in-95 duration-100 font-medium"
        >
          <button
            type="button"
            onClick={() => {
              setContextMenuPos(null);
              onOpenDetail(instance);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center space-x-2 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer font-bold text-slate-900 dark:text-white"
          >
            <Activity className="w-3.5 h-3.5 text-emerald-500" />
            <span>查看运行详情与核验</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setContextMenuPos(null);
              onOpenSelectExit(instance);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center space-x-2 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            <Network className="w-3.5 h-3.5 text-indigo-500" />
            <span>选择/更换出口节点</span>
          </button>

          {platform.shortcutManagement && (
            <button
              type="button"
              onClick={() => {
                setContextMenuPos(null);
                onShortcuts();
              }}
              className="w-full px-3 py-1.5 text-left flex items-center space-x-2 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5 text-purple-500" />
              <span>管理桌面快捷方式</span>
            </button>
          )}

          <div className="h-px bg-slate-200 dark:bg-slate-800 my-1" />

          {/* 优先级调整 */}
          <div className="flex items-center justify-between px-3 py-1">
            <span className="text-[11px] text-slate-400">优先级排序</span>
            <div className="flex items-center space-x-1">
              <button
                type="button"
                disabled={!canMoveUp}
                onClick={() => {
                  setContextMenuPos(null);
                  onMoveUp?.();
                }}
                className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 cursor-pointer"
                title="上移"
              >
                <ArrowUp className="w-3 h-3" />
              </button>
              <button
                type="button"
                disabled={!canMoveDown}
                onClick={() => {
                  setContextMenuPos(null);
                  onMoveDown?.();
                }}
                className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 cursor-pointer"
                title="下移"
              >
                <ArrowDown className="w-3 h-3" />
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              setContextMenuPos(null);
              onEdit(instance);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center space-x-2 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            <Pencil className="w-3.5 h-3.5 text-slate-500" />
            <span>编辑规则定义</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setContextMenuPos(null);
              onExport(instance);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center space-x-2 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer text-indigo-600 dark:text-indigo-400"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>导出纯净脱敏包</span>
          </button>

          <div className="h-px bg-slate-200 dark:bg-slate-800 my-1" />

          <button
            type="button"
            onClick={() => {
              setContextMenuPos(null);
              onDelete(instance.instanceId);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center space-x-2 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>卸载/移除套件</span>
          </button>
        </div>
      )}
    </div>
  );
};
