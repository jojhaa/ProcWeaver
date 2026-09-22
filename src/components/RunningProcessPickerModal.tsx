import React, { useState, useEffect, useMemo } from "react";
import { Search, RefreshCw, X, Cpu, ArrowRight, Laptop } from "lucide-react";
import { routingApi } from "../api/routingOverrides";
import { ProcessEntry } from "../types/routingOverrides";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (exeName: string, fullPath?: string, includeDescendants?: boolean) => void;
}

const KNOWN_APP_NAMES: Record<string, { label: string; icon: string }> = {
  "chrome.exe": { label: "Google Chrome 浏览器", icon: "🌐" },
  "msedge.exe": { label: "Microsoft Edge 浏览器", icon: "🌐" },
  "firefox.exe": { label: "Mozilla Firefox 火狐", icon: "🦊" },
  "antigravity.exe": { label: "Antigravity 2.0 桌面端", icon: "🌌" },
  "antigravity ide.exe": { label: "Antigravity 次世代 IDE", icon: "🛸" },
  "language_server.exe": { label: "Antigravity 核心语言服务 (LSP)", icon: "🧠" },
  "telegram.exe": { label: "Telegram 桌面端", icon: "💬" },
  "discord.exe": { label: "Discord 语音客户端", icon: "🎮" },
  "code.exe": { label: "Visual Studio Code", icon: "💻" },
  "cursor.exe": { label: "Cursor AI 编辑器", icon: "💻" },
  "steam.exe": { label: "Steam 游戏平台", icon: "🕹️" },
  "epicgameslauncher.exe": { label: "Epic Games 客户端", icon: "🎮" },
  "wechat.exe": { label: "微信桌面版", icon: "💬" },
  "qq.exe": { label: "腾讯 QQ 客户端", icon: "🐧" },
  "spotify.exe": { label: "Spotify 音乐播放器", icon: "🎵" },
  "cloudmusic.exe": { label: "网易云音乐", icon: "🎵" },
  "dingtalk.exe": { label: "钉钉桌面端", icon: "💼" },
  "feishu.exe": { label: "飞书桌面端", icon: "💼" },
  "notion.exe": { label: "Notion 笔记", icon: "📝" },
  "obs64.exe": { label: "OBS Studio 录屏推流", icon: "📹" },
  "potplayer64.exe": { label: "PotPlayer 播放器", icon: "🎬" },
  "clash-verge.exe": { label: "Clash Verge 客户端", icon: "🐱" },
};

const SYSTEM_PROCESS_NAMES = new Set([
  "system",
  "registry",
  "smss.exe",
  "csrss.exe",
  "wininit.exe",
  "services.exe",
  "lsass.exe",
  "svchost.exe",
  "fontdrvhost.exe",
  "dwm.exe",
  "memory compression",
  "spoolsv.exe",
  "runtimebroker.exe",
  "taskhostw.exe",
  "sihost.exe",
  "ctfmon.exe",
  "searchhost.exe",
  "shellexperiencehost.exe",
  "startmenuexperiencehost.exe",
  "securityhealthservice.exe",
  "sgrmbroker.exe",
  "smartscreen.exe",
  "conhost.exe",
  "wudfhost.exe",
  "dashost.exe",
  "dllhost.exe",
  "explorer.exe",
  "textinputhost.exe",
  "searchindexer.exe",
  "audiodg.exe",
]);

interface MainProcessItem {
  name: string;
  friendlyName?: string;
  icon: string;
  path?: string;
  subProcessCount: number;
  pid: number;
  isSystem: boolean;
}

export const RunningProcessPickerModal: React.FC<Props> = ({ isOpen, onClose, onSelect }) => {
  const [entries, setEntries] = useState<ProcessEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [hideSystemProcesses, setHideSystemProcesses] = useState(true);
  const [includeDescendants, setIncludeDescendants] = useState(true);

  const fetchProcesses = async () => {
    setLoading(true);
    try {
      const list = await routingApi.tree();
      setEntries(list || []);
    } catch (e) {
      console.error("读取运行中进程失败:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchProcesses();
      setSearch("");
    }
  }, [isOpen]);

  const mainProcesses = useMemo(() => {
    if (!entries || entries.length === 0) return [];

    const groups = new Map<string, ProcessEntry[]>();
    entries.forEach((p) => {
      if (!p.name || p.pid === 0) return;
      const cleanedName = p.name.trim();
      const lower = cleanedName.toLowerCase();
      if (!groups.has(lower)) {
        groups.set(lower, []);
      }
      groups.get(lower)!.push(p);
    });

    const results: MainProcessItem[] = [];

    groups.forEach((items, lowerName) => {
      const representative = items.find((i) => Boolean(i.executablePath)) || items[0];
      const name = representative.name;
      const known = KNOWN_APP_NAMES[lowerName];
      const isSystem = SYSTEM_PROCESS_NAMES.has(lowerName);

      results.push({
        name,
        friendlyName: known?.label,
        icon: known?.icon || "💻",
        path: representative.executablePath || undefined,
        subProcessCount: Math.max(0, items.length - 1),
        pid: representative.pid,
        isSystem,
      });
    });

    return results.sort((a, b) => {
      const aKnown = KNOWN_APP_NAMES[a.name.toLowerCase()] ? 1 : 0;
      const bKnown = KNOWN_APP_NAMES[b.name.toLowerCase()] ? 1 : 0;
      if (aKnown !== bKnown) return bKnown - aKnown;
      return a.name.localeCompare(b.name);
    });
  }, [entries]);

  const filteredList = useMemo(() => {
    const q = search.trim().toLowerCase();
    return mainProcesses.filter((item) => {
      if (hideSystemProcesses && item.isSystem) {
        return false;
      }
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        (item.friendlyName && item.friendlyName.toLowerCase().includes(q)) ||
        (item.path && item.path.toLowerCase().includes(q))
      );
    });
  }, [mainProcesses, search, hideSystemProcesses]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="w-full max-w-xl max-h-[85vh] rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-150">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-xl bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <span>从运行中查找主进程</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-mono font-normal">
                  免翻找文件
                </span>
              </h3>
              <p className="text-[11px] text-slate-400 mt-0.5">
                智能提取主程序，自动关联子进程树，选中即享全自动分流接管
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-950/30 space-y-3 shrink-0">
          <div className="flex items-center space-x-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索进程名、应用名称，如 chrome / telegram / steam..."
                className="w-full pl-9 pr-8 py-2 text-xs rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/30 text-slate-800 dark:text-slate-100 placeholder-slate-400"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={fetchProcesses}
              disabled={loading}
              className="p-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition cursor-pointer shrink-0 disabled:opacity-50"
              title="重新扫描系统运行中进程"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin text-indigo-500" : ""}`} />
            </button>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-500 select-none">
            <label className="flex items-center space-x-2 cursor-pointer hover:text-slate-700 dark:hover:text-slate-300 transition">
              <input
                type="checkbox"
                checked={hideSystemProcesses}
                onChange={(e) => setHideSystemProcesses(e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
              />
              <span>隐藏 Windows 系统后台服务 (svchost/dwm等)</span>
            </label>

            <span className="font-mono text-[11px] text-slate-400">
              就绪主程序: {filteredList.length} 项
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className="py-16 text-center text-xs text-slate-400 space-y-2">
              <RefreshCw className="w-5 h-5 animate-spin mx-auto text-indigo-500" />
              <p>正在读取 Windows 进程快照与主程序树...</p>
            </div>
          ) : filteredList.length === 0 ? (
            <div className="py-16 text-center text-xs text-slate-400 space-y-1">
              <Laptop className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-1" />
              <p className="font-medium">未找到匹配的运行中进程</p>
              <p className="text-[11px] text-slate-400">
                可尝试清除搜索关键词，或先启动该软件后再点击刷新
              </p>
            </div>
          ) : (
            filteredList.map((item) => (
              <div
                key={`${item.name}-${item.pid}`}
                onClick={() => {
                  onSelect(item.name, item.path, includeDescendants);
                  onClose();
                }}
                className="p-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/80 hover:border-indigo-400 dark:hover:border-indigo-500/60 hover:bg-indigo-50/30 dark:hover:bg-indigo-950/20 transition cursor-pointer group flex items-center justify-between gap-3 select-none shadow-2xs"
              >
                <div className="flex items-center space-x-3 min-w-0 flex-1">
                  <div className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200/60 dark:border-slate-700/60 flex items-center justify-center text-lg shrink-0 group-hover:scale-105 transition-transform">
                    {item.icon}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">
                        {item.friendlyName || item.name}
                      </span>
                      {item.friendlyName && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 font-mono shrink-0">
                          {item.name}
                        </span>
                      )}
                    </div>

                    <p
                      className="text-[11px] text-slate-400 dark:text-slate-500 truncate mt-0.5 font-mono"
                      title={item.path || "系统运行路径"}
                    >
                      {item.path || `PID: ${item.pid} · 内存驻留`}
                    </p>
                  </div>
                </div>

                <div className="flex items-center space-x-2.5 shrink-0">
                  {item.subProcessCount > 0 ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 font-medium border border-indigo-200/60 dark:border-indigo-900/60">
                      主进程 · 包含 {item.subProcessCount} 个子进程
                    </span>
                  ) : (
                    <span className="text-[10px] px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 font-medium">
                      单实例主进程
                    </span>
                  )}

                  <span className="flex items-center space-x-1 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 group-hover:bg-indigo-600 group-hover:text-white text-slate-600 dark:text-slate-300 text-xs font-semibold transition">
                    <span>选用</span>
                    <ArrowRight className="w-3 h-3" />
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5 shrink-0">
          <label className="flex items-center space-x-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeDescendants}
              onChange={(e) => setIncludeDescendants(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
            />
            <div className="text-xs">
              <span className="font-bold text-slate-800 dark:text-slate-200">
                自动接管进程树 (后续派生子进程自动继承分流)
              </span>
              <p className="text-[10px] text-slate-400">
                主程序启动的任何游戏组件、渲染器与辅助子程序将被系统底层全自动追踪代理
              </p>
            </div>
          </label>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl text-xs font-medium text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition cursor-pointer self-end sm:self-auto"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
};
