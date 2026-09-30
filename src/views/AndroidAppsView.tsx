import { useMemo, useRef, useState } from "react";
import { useAndroidApps } from "../hooks/useAndroidApps";
import { AndroidExitPicker } from "../components/AndroidExitPicker";
import { useMobileBack } from "../utils/mobileBack";
import {
  Search,
  RefreshCw,
  X,
  ChevronDown,
  ShieldAlert,
} from "lucide-react";

type FilterType = "launchable" | "all" | "custom" | "inherit";

export function AndroidAppsView({ onOpenRules }: { onOpenRules?: () => void } = {}) {
  const state = useAndroidApps();
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<FilterType>("launchable");
  const [limit, setLimit] = useState(60);
  const [editingPackage, setEditingPackage] = useState<string | null>(null);
  const pickerOpener = useRef<HTMLButtonElement | null>(null);

  const closePicker = () => {
    setEditingPackage(null);
    requestAnimationFrame(() => pickerOpener.current?.focus({ preventScroll: true }));
  };
  useMobileBack(() => { if (!editingPackage) return false; closePicker(); return true; }, 30);
  useMobileBack(() => {
    if (editingPackage) return false;
    if (search) {
      setSearch("");
      return true;
    }
    if (filterType !== "launchable") {
      setFilterType("launchable");
      return true;
    }
    return false;
  }, 20);

  const editing = state.apps.find((app) => app.packageName === editingPackage);

  const filteredApps = useMemo(() => {
    return state.apps.filter((app) => {
      const matchSearch = `${app.label} ${app.packageName}`
        .toLowerCase()
        .includes(search.toLowerCase());
      if (!matchSearch) return false;

      if (filterType === "launchable") {
        return app.launchable || app.selected !== "inherit";
      }

      if (filterType === "custom") {
        return (
          app.selected !== "inherit" &&
          app.selected !== "direct" &&
          app.selected !== "reject"
        );
      }
      if (filterType === "inherit") {
        return app.selected === "inherit";
      }
      return true;
    });
  }, [state.apps, search, filterType]);

  const customCount = useMemo(() => {
    return state.apps.filter(
      (a) => a.selected !== "inherit" && a.selected !== "direct" && a.selected !== "reject"
    ).length;
  }, [state.apps]);
  const launchableCount = useMemo(() => state.apps.filter(app => app.launchable || app.selected !== "inherit").length, [state.apps]);

  return (
    <div className="h-full overflow-y-auto p-3 space-y-2.5">
      {/* 独立出口总开关保持可见，状态和规则模式提示由上层提供 */}
      <div className="rounded-xl border border-slate-200/90 dark:border-slate-800/80 bg-white/80 dark:bg-slate-900/60 px-3 py-2 flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
          <input type="checkbox" checked={state.view?.config.processEnabled ?? false} disabled={state.busy || !state.view}
            onChange={event => void state.setEnabled(event.target.checked)} />
          启用应用出口规则
        </label>
        <span className={`text-[11px] shrink-0 ${state.view?.config.processEnabled ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}>{state.view?.config.processEnabled ? "已启用" : "已停用"}</span>
      </div>

      {/* 粘性搜索栏与快捷过滤芯片 */}
      <div className="sticky top-0 z-10 -mx-3 px-3 py-2 bg-slate-50/95 dark:bg-slate-950/95 space-y-2 border-b border-slate-200/60 dark:border-slate-800/60 shadow-xs">
        {/* 搜索栏与刷新 */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3.5 top-3 text-slate-400" />
            <input
              aria-label="搜索应用"
              placeholder="搜索应用名称或包名…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setLimit(60);
              }}
              className="w-full rounded-xl border border-slate-200 dark:border-slate-700 pl-9 pr-8 py-2.5 bg-white dark:bg-slate-900 text-xs text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition shadow-xs"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-2.5 p-0.5 text-slate-400 hover:text-slate-600 rounded-full cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <button
            type="button"
            disabled={state.busy}
            onClick={() => void state.reload()}
            className="flex items-center space-x-1.5 px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 text-xs font-semibold text-slate-700 dark:text-slate-300 transition shadow-xs shrink-0 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${state.busy ? "animate-spin" : ""}`} />
            <span>刷新</span>
          </button>
        </div>

        {/* 快捷过滤芯片 */}
        <div className="flex items-center gap-1.5 select-none overflow-x-auto py-0.5">
          <button
            type="button"
            onClick={() => {
              setFilterType("launchable");
              setLimit(60);
            }}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer shrink-0 ${
              filterType === "launchable"
                ? "bg-indigo-600 text-white shadow-xs"
                : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900"
            }`}
          >
            可启动 ({launchableCount})
          </button>
          <button
            type="button"
            onClick={() => {
              setFilterType("all");
              setLimit(60);
            }}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer shrink-0 ${
              filterType === "all"
                ? "bg-indigo-600 text-white shadow-xs"
                : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900"
            }`}
          >
            全部 ({state.apps.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setFilterType("custom");
              setLimit(60);
            }}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer shrink-0 ${
              filterType === "custom"
                ? "bg-indigo-600 text-white shadow-xs"
                : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900"
            }`}
          >
            独立出口 ({customCount})
          </button>
          <button
            type="button"
            onClick={() => {
              setFilterType("inherit");
              setLimit(60);
            }}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer shrink-0 ${
              filterType === "inherit"
                ? "bg-indigo-600 text-white shadow-xs"
                : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900"
            }`}
          >
            跟随规则
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {state.error && (
        <div
          role="alert"
          className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 text-xs font-semibold text-rose-600 dark:text-rose-400 flex items-center space-x-2"
        >
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      )}

      {/* 加载状态 */}
      {state.busy && !state.view && (
        <div className="flex items-center justify-center p-8 space-x-2 text-xs text-slate-400">
          <RefreshCw className="w-4 h-4 animate-spin text-indigo-500" />
          <span>正在读取应用列表与出口路由…</span>
        </div>
      )}

      {/* 列表渲染 */}
      <div className="space-y-2.5">
        {filteredApps.slice(0, limit).map((app) => {
          const targets = state.targets;
          const selected = app.selected;
          const target = selected.startsWith("target:")
            ? targets[Number(selected.slice(7))]
            : null;
          const label =
            selected === "inherit"
              ? "跟随分流规则"
              : selected === "direct"
              ? "直连"
              : selected === "reject"
              ? "阻止联网"
              : target
              ? state.view?.targetLabels?.[target.name] ?? target.name
              : "出口已失效，请重新选择";

          const isCustomTarget = Boolean(target);
          const isDirect = selected === "direct";
          const isReject = selected === "reject";

          return (
            <div
              key={app.packageName}
              className="rounded-xl border border-slate-200/90 dark:border-slate-800/80 bg-white dark:bg-slate-900/80 p-2.5 shadow-sm space-y-1.5 transition"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center space-x-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500/10 to-purple-500/10 dark:from-indigo-950/60 dark:to-purple-950/60 border border-indigo-200/60 dark:border-indigo-800/60 text-indigo-600 dark:text-indigo-400 font-bold text-sm flex items-center justify-center shrink-0">
                    {app.label.charAt(0) || "A"}
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-xs text-slate-800 dark:text-slate-100 truncate">
                      {app.label}
                    </p>
                    <p className="text-[10px] break-all text-slate-400 font-mono truncate">
                      {app.packageName}
                    </p>
                  </div>
                </div>

                <div className="flex items-center space-x-1 shrink-0">
                  {app.sharedUid && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium border border-amber-500/20">
                      共享 UID
                    </span>
                  )}
                </div>
              </div>


              <button
                type="button"
                aria-label={`${app.label} 出口`}
                aria-haspopup="dialog"
                disabled={state.busy || app.sharedUid}
                onClick={(event) => {
                  pickerOpener.current = event.currentTarget;
                  setEditingPackage(app.packageName);
                }}
                className={`w-full flex items-center justify-between p-2.5 rounded-xl border text-xs font-semibold transition cursor-pointer disabled:opacity-50 ${
                  isCustomTarget
                    ? "bg-indigo-50/70 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-800/80 text-indigo-700 dark:text-indigo-300"
                    : isDirect
                    ? "bg-emerald-50/70 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800/80 text-emerald-700 dark:text-emerald-300"
                    : isReject
                    ? "bg-rose-50/70 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800/80 text-rose-700 dark:text-rose-300"
                    : "bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:border-indigo-400"
                }`}
              >
                <div className="flex items-center space-x-1.5 min-w-0 truncate">
                  <span className="text-[10px] opacity-75 font-normal">{app.excluded ? "未纳入 VPN:" : app.routingDisabled ? "分流已停用:" : "指定出口:"}</span>
                  <span className="truncate">{label}</span>
                </div>
                <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-60" />
              </button>
              {app.sharedUid && <p className="text-[11px] text-amber-700 dark:text-amber-300">此应用与其他应用共用 UID，无法单独指定出口。<button type="button" onClick={onOpenRules} className="font-semibold underline">前往域名/IP 规则</button></p>}
            </div>
          );
        })}

        {!state.busy && !filteredApps.length && (
          <div className="p-8 text-center text-xs text-slate-400 space-y-1">
            <p>没有匹配的应用。</p>
            <p className="text-[10px] text-slate-500">可尝试调整搜索关键词或切换筛选分类。</p>
          </div>
        )}
      </div>

      {limit < filteredApps.length && (
        <button
          type="button"
          onClick={() => setLimit(limit + 60)}
          className="w-full py-3 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
        >
          加载更多应用（还剩 {filteredApps.length - limit} 项）
        </button>
      )}

      {/* 弹出的独立出口选择器 */}
      {editing && (
        <AndroidExitPicker
          label={editing.label}
          targets={state.targets}
          labels={state.view?.targetLabels ?? {}}
          selected={editing.selected}
          busy={state.busy}
          error={state.error}
          onClose={closePicker}
          onChoose={(action, target) => state.save(editing, action, target)}
        />
      )}
    </div>
  );
}
