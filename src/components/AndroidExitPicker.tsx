import { useEffect, useMemo, useRef, useState } from "react";
import type { RoutingTarget } from "../types/routingOverrides";
import { isInformationalNode } from "../utils/proxyParser";
import { Search, X, ShieldAlert } from "lucide-react";

type Choice = "inherit" | "direct" | "reject" | "proxy";
interface Props {
  label: string;
  targets: RoutingTarget[];
  labels: Record<string, string>;
  busy: boolean;
  error: string;
  selected: string;
  onChoose(action: Choice, target: RoutingTarget | null): Promise<boolean>;
  onClose(): void;
}
const PAGE_SIZE = 30;

/** One on-demand picker shared by all app rows; at most 60 exit buttons mount. */
export function AndroidExitPicker({
  label,
  targets,
  labels,
  busy,
  error,
  selected,
  onChoose,
  onClose,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);

  const filtered = useMemo(
    () =>
      targets.filter((target) =>
        !isInformationalNode(target.name) &&
        !isInformationalNode(labels[target.name] ?? target.name) &&
        `${labels[target.name] ?? target.name} ${target.profileId}`
          .toLowerCase()
          .includes(search.trim().toLowerCase())
      ),
    [targets, labels, search]
  );

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    searchInput.current?.focus({ preventScroll: true });
    return () => element?.close();
  }, []);

  function close() {
    if (!busy) {
      dialog.current?.close();
      onClose();
    }
  }

  async function choose(action: Choice, target: RoutingTarget | null) {
    if (await onChoose(action, target)) {
      dialog.current?.close();
      onClose();
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby="android-exit-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 text-slate-900 dark:text-white backdrop:bg-black/50 shadow-2xl space-y-4"
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
        <h2 id="android-exit-title" className="font-bold text-sm truncate">
          {label} · 选择独立出口
        </h2>
        <button
          type="button"
          aria-label="关闭出口选择"
          disabled={busy}
          onClick={close}
          className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 text-xs font-semibold text-rose-600 dark:text-rose-400 flex items-center space-x-2"
        >
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* 快捷系统动作 */}
      <div className="android-exit-actions grid grid-cols-3 gap-2">
        <button
          type="button"
          aria-pressed={selected === "inherit"}
          disabled={busy}
          onClick={() => void choose("inherit", null)}
          className="py-2.5 px-2 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-700 dark:text-slate-300 transition cursor-pointer"
        >
          跟随规则
        </button>
        <button
          type="button"
          aria-pressed={selected === "direct"}
          disabled={busy}
          onClick={() => void choose("direct", null)}
          className="py-2.5 px-2 rounded-xl text-xs font-semibold bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/80 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 transition cursor-pointer"
        >
          直连
        </button>
        <button
          type="button"
          aria-pressed={selected === "reject"}
          disabled={busy}
          onClick={() => void choose("reject", null)}
          className="py-2.5 px-2 rounded-xl text-xs font-semibold bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/80 text-rose-700 dark:text-rose-300 hover:bg-rose-100 transition cursor-pointer"
        >
          阻止联网
        </button>
      </div>

      <p className="text-[11px] text-slate-500 dark:text-slate-400" role="status">
        当前选择：{selected === "inherit" ? "跟随规则" : selected === "direct" ? "直连" : selected === "reject" ? "阻止联网" : selected.startsWith("target:") ? (labels[targets[Number(selected.slice(7))]?.name] ?? targets[Number(selected.slice(7))]?.name ?? "出口已失效") : "未设置"}
      </p>

      {/* 搜索出口 */}
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
        <input
          ref={searchInput}
          aria-label="搜索出口"
          placeholder="搜索节点或策略组名称…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setLimit(PAGE_SIZE);
          }}
          className="w-full rounded-xl border border-slate-200 dark:border-slate-700 pl-9 pr-3 py-2.5 bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition"
        />
      </div>

      <p className="text-[11px] text-slate-400" role="status">
        共 {filtered.length} 个节点/策略组
      </p>

      {/* 出口节点列表 */}
      <div className="space-y-1.5 pr-1">
        {filtered
          .slice(0, limit)
          .map((target) => (
            <button
              key={`${target.profileId}:${target.kind}:${target.name}`}
              type="button"
              aria-pressed={selected === `target:${targets.indexOf(target)}`}
              disabled={busy}
              onClick={() => void choose("proxy", target)}
              className="android-exit-option w-full flex items-center justify-between p-2.5 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-800/70 hover:border-indigo-500 text-left text-xs font-semibold text-slate-800 dark:text-slate-200 transition cursor-pointer"
            >
              <span className="truncate">{labels[target.name] ?? target.name}</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 font-mono shrink-0 ml-2">
                {target.kind === "group" ? "策略组" : "节点"}
              </span>
            </button>
          ))}
        {!filtered.length && (
          <p className="py-6 text-center text-xs text-slate-400">没有匹配的出口节点或策略组。</p>
        )}
      </div>

      {filtered.length > limit && (
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
          <button
            type="button"
            onClick={() => setLimit(value => value + PAGE_SIZE)}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold"
          >
            加载更多（还剩 {filtered.length - limit} 项）
          </button>
        </div>
      )}
    </dialog>
  );
}
