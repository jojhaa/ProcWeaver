import { useState } from "react";
import {
  RefreshCw,
  Wrench,
  Check,
  AlertCircle,
  Sparkles,
  ArrowRight,
  Sliders,
  CheckCircle2,
} from "lucide-react";
import type { useProcessWorkspace } from "../../hooks/useProcessWorkspace";
import type { FunctionModeView } from "../../types/functionMode";
import type { AppUpdateInfo } from "../../types";
import { checkAppUpdate } from "../../api/maintenance";
import { processUpdateApi } from "../../api/processUpdate";
import { version as appVersion } from "../../../package.json";
import { ProcessCaptureControls } from "./ProcessCaptureControls";

type State = ReturnType<typeof useProcessWorkspace>;
const baseBtn =
  "rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-indigo-500";

export function ProcessAccessBar({
  state: s,
  capability,
  onFull,
}: {
  state: State;
  capability: FunctionModeView;
  onFull?: () => void;
}) {
  const readyCount = s.external?.states.filter((item) => item.ready).length || 0;

  return (
    <section
      aria-label="进程代理运行控制"
      className="border-b border-slate-200/90 dark:border-slate-800/90 px-5 py-3 bg-white/95 dark:bg-slate-900/95 space-y-2.5 shadow-2xs backdrop-blur-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* 左侧：分段接入方式控制 */}
        <div className="min-w-0 flex-1">
          <ProcessCaptureControls
            state={s.capture.state}
            onRequest={s.capture.actions.request}
            onCancel={s.capture.actions.cancel}
            onConfirm={() => void s.capture.actions.confirm()}
            onRefresh={() => void s.capture.actions.refresh()}
          />
        </div>

        {/* 右侧：独立代理入口就绪数与平滑胶囊开关 */}
        <div className="flex items-center space-x-2 shrink-0">
          <span className="inline-flex items-center space-x-1 px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] text-slate-600 dark:text-slate-300 font-mono">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                !s.external
                  ? "bg-slate-400"
                  : s.external.enabled && readyCount > 0
                  ? "bg-emerald-500"
                  : "bg-amber-500"
              }`}
            />
            <span>
              {!s.external
                ? "状态读取中…"
                : s.external.enabled
                ? `入口就绪 ${readyCount} 个`
                : "独立代理已暂停"}
            </span>
          </span>

          {/* 胶囊滑动总开关 */}
          <button
            type="button"
            role="switch"
            aria-label="独立代理总开关"
            aria-checked={s.external?.enabled === true}
            disabled={s.pending || !s.external}
            onClick={() => void s.actions.toggle()}
            className={`h-8 px-3 rounded-xl border text-xs font-medium flex items-center space-x-2 transition shadow-2xs select-none disabled:opacity-50 disabled:cursor-not-allowed ${
              s.external?.enabled
                ? "bg-emerald-50/80 hover:bg-emerald-100/90 dark:bg-emerald-950/30 dark:hover:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60 cursor-pointer"
                : "bg-slate-100 hover:bg-slate-200/80 dark:bg-slate-800 dark:hover:bg-slate-750 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 cursor-pointer"
            }`}
          >
            <span
              aria-hidden="true"
              className={`relative inline-flex items-center w-7 h-4 rounded-full shrink-0 transition-colors duration-200 ${
                s.external?.enabled ? "bg-emerald-500 shadow-xs" : "bg-slate-300 dark:bg-slate-600"
              }`}
            >
              <span
                className={`inline-block w-3 h-3 rounded-full bg-white shadow-xs transition-transform duration-200 ${
                  s.external?.enabled ? "translate-x-[14px]" : "translate-x-0.5"
                }`}
              />
            </span>
            <span>{s.external?.enabled ? "已开启" : "已暂停"}</span>
          </button>
        </div>
      </div>

      {/* 说明与切回完整功能提示条 */}
      <div className="flex flex-wrap items-center justify-between gap-2 p-2 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400">
        <p className="leading-relaxed min-w-0 flex-1">
          {s.capture.state.view?.mode === "windivert"
            ? "无需为代理参数重启已运行的目标；只接管新连接，实际出口请查看连接记录。"
            : "应用需接入本包代理入口；发现进程不代表已接管。"}
          {capability.winDivertReason}。
        </p>
        {onFull && <button
          type="button"
          onClick={onFull}
          className="inline-flex items-center space-x-1 text-indigo-600 dark:text-indigo-400 font-semibold hover:underline shrink-0 cursor-pointer ml-1"
        >
          <span>切回完整功能模式</span>
          <ArrowRight className="w-3 h-3" />
        </button>}
      </div>

      {s.runtimeError && (
        <div
          role="alert"
          className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 p-2.5 rounded-xl border border-red-200 dark:border-red-900/60"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1 break-words">{s.runtimeError}</span>
          <button className={`${baseBtn} bg-white dark:bg-slate-900`} onClick={() => void s.actions.refresh()}>
            重试读取
          </button>
        </div>
      )}
    </section>
  );
}

export function ProcessDiagnostics({ state: s }: { state: State }) {
  const states: Record<string, string> = {
    connecting: "连接中",
    active: "隧道已建立",
    closed: "连接已结束",
    response: "响应已转发",
    failed: "失败",
  };

  return (
    <section className="p-5 sm:p-6 space-y-4 overflow-auto h-full max-w-5xl mx-auto" aria-labelledby="process-diagnostics-title">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 dark:border-slate-800/80 pb-3">
        <div>
          <h2 id="process-diagnostics-title" className="font-bold text-sm text-slate-900 dark:text-white">
            连接与诊断
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            最近 100 条网络流向记录，包含历史连接；不等同于当前并发活跃连接。
          </p>
        </div>
        <select
          aria-label="筛选业务包连接"
          value={s.filter}
          onChange={(e) => s.actions.setFilter(e.target.value)}
          className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-indigo-500 outline-none cursor-pointer"
        >
          <option value="">全部业务包 ({s.records.length})</option>
          {Object.entries(s.bundleNames).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {!s.records.length ? (
        <div className="py-16 text-center text-sm text-slate-500 space-y-2">
          <p>尚未观察到任何独立连接记录。</p>
          <p className="text-xs text-slate-400">请启动已绑定外部代理的业务包并发起网络请求。</p>
        </div>
      ) : (
        <ol className="space-y-2">
          {s.records.map((record) => (
            <li
              key={record.id}
              className="p-3 rounded-xl border border-slate-200/70 dark:border-slate-800/80 bg-white dark:bg-slate-900/60 shadow-2xs text-xs space-y-1"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold text-slate-800 dark:text-slate-200 font-mono break-all">
                  {record.target}
                </span>
                <span
                  className={`px-1.5 py-0.2 rounded-md text-[10px] font-bold ${
                    record.state === "failed"
                      ? "bg-red-500/10 text-red-600 dark:text-red-400"
                      : record.state === "active"
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
                  }`}
                >
                  {states[record.state] || record.state}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-mono break-all">
                {s.bundleNames[record.bundleId] || record.bundleId} · PID {record.pid} · {record.process} · {record.route} → {record.upstream}
              </p>
              {record.message && (
                <p className="text-[11px] text-amber-700 dark:text-amber-300 break-words bg-amber-50 dark:bg-amber-950/20 p-1.5 rounded-lg">
                  {record.message}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function ProcessSettings({
  state: s,
  onOpenMaintenance,
  standalone = false,
}: {
  state: State;
  onOpenMaintenance?: () => void;
  standalone?: boolean;
}) {
  // 更新检测状态
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const handleCheckUpdate = async () => {
    setChecking(true);
    setUpdateError(null);
    try {
      const info = await (standalone ? processUpdateApi.check() : checkAppUpdate());
      setUpdateInfo(info);
    } catch (err) {
      console.error("检查客户端更新失败:", err);
      setUpdateError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="max-w-2xl p-5 sm:p-6 space-y-6 mx-auto" aria-labelledby="process-settings-title">
      <div>
        <h2 id="process-settings-title" className="font-bold text-base text-slate-900 dark:text-white flex items-center space-x-2">
          <Sliders className="w-4 h-4 text-indigo-500" />
          <span>偏好与版本设置</span>
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          {standalone ? "管理独立进程版的系统启动、托盘偏好与版本更新。" : "管理系统启动、托盘偏好及检查客户端与分流核心版本更新。"}
        </p>
      </div>

      {s.error && (
        <div role="alert" className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 text-xs text-red-600 dark:text-red-400">
          {s.error}
        </div>
      )}
      {s.message && (
        <div role="status" className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 text-xs text-emerald-700 dark:text-emerald-300 flex items-center space-x-2">
          <Check className="w-4 h-4 shrink-0 text-emerald-600" />
          <span>{s.message}</span>
        </div>
      )}

      {/* 核心卡片 1：版本维护与更新检测 (响应用户诉求：缺少更新检测) */}
      <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-5 space-y-4 shadow-2xs">
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-100 dark:border-indigo-900/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <strong className="text-xs font-bold text-slate-800 dark:text-slate-100 block">
                客户端版本与更新检测
              </strong>
              <span className="text-[11px] text-slate-500">
                当前运行版本: <strong className="font-mono text-indigo-600 dark:text-indigo-400">v{appVersion}</strong>
              </span>
            </div>
          </div>

          <button
            type="button"
            disabled={checking}
            onClick={handleCheckUpdate}
            className="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs flex items-center space-x-1.5 transition cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${checking ? "animate-spin" : ""}`} />
            <span>{checking ? "检查中…" : "检查更新"}</span>
          </button>
        </div>

        {/* 更新检测结果 */}
        {updateError && (
          <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 text-xs text-red-600 border border-red-200 flex items-center space-x-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>检查更新失败: {updateError}</span>
          </div>
        )}

        {updateInfo && (
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-1.5 text-xs font-medium">
                {updateInfo.hasUpdate ? (
                  <Sparkles className="w-4 h-4 text-amber-500" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                )}
                <span className={updateInfo.hasUpdate ? "text-amber-700 dark:text-amber-300 font-bold" : "text-emerald-700 dark:text-emerald-400 font-semibold"}>
                  {updateInfo.hasUpdate
                    ? `发现新版本: ${updateInfo.latestVersion}`
                    : standalone && !updateInfo.assetName ? "暂无独立进程版发布包" : `当前已是最新版本 (${updateInfo.currentVersion})`}
                </span>
              </div>
              {updateInfo.publishedAt && (
                <span className="text-[10px] text-slate-400 font-mono">
                  发布于: {new Date(updateInfo.publishedAt).toLocaleDateString()}
                </span>
              )}
            </div>

            {updateInfo.hasUpdate && (
              <div className="pt-2 border-t border-slate-200/60 dark:border-slate-800 flex items-center justify-between">
                <span className="text-[11px] text-slate-500 font-mono">
                  安装包大小: {updateInfo.assetSizeFormatted || "约 90 MB"}
                </span>
                {onOpenMaintenance && (
                  <button
                    type="button"
                    onClick={onOpenMaintenance}
                    className="px-3 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 text-xs font-semibold flex items-center space-x-1 transition cursor-pointer"
                  >
                    <span>前往版本维护中心下载</span>
                    <ArrowRight className="w-3 h-3" />
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between pt-1">
          <p className="text-[11px] text-slate-500 leading-relaxed">
            {standalone ? "仅检查独立进程版更新，便携数据保存于 process-data。" : "支持完整客户端自动更新，以及随包内嵌 Mihomo 核心与离线 Geo 规则库的定期校验维护。"}
          </p>
          {onOpenMaintenance && (
            <button
              type="button"
              onClick={onOpenMaintenance}
              className="text-xs text-indigo-600 dark:text-indigo-400 font-semibold hover:underline flex items-center space-x-1 shrink-0 ml-2 cursor-pointer"
            >
              <Wrench className="w-3.5 h-3.5" />
              <span>{standalone ? "打开进程版维护" : "打开完整版本维护"}</span>
            </button>
          )}
        </div>
      </div>

      {/* 核心卡片 2：基础偏好设置 */}
      <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-5 space-y-4 shadow-2xs">
        <strong className="text-xs font-bold text-slate-800 dark:text-slate-100 block border-b border-slate-100 dark:border-slate-800 pb-2.5">
          系统与窗口偏好
        </strong>

        {s.preferences ? (
          <div className="space-y-3">
            {(
              [
                ["autoStart", standalone ? "开机自启 ProcWeaver Process" : "开机自启 ProcWeaver", "系统启动时自动在后台唤醒进程分流服务"],
                ["minimizeOnClose", "关闭窗口时最小化到托盘", "点击关闭按钮时保持后台托盘驻留而不是彻底退出"],
                ["silentStart", "启动时隐藏主窗口", "开机或启动时不主动弹出窗口，保持静默运行"],
              ] as const
            ).map(([key, label, desc]) => (
              <label
                key={key}
                className="flex items-start justify-between gap-4 p-3 rounded-xl border border-slate-100 dark:border-slate-800/80 hover:bg-slate-50 dark:hover:bg-slate-950 transition cursor-pointer select-none"
              >
                <div>
                  <span className="text-xs font-medium text-slate-800 dark:text-slate-200 block">
                    {label}
                  </span>
                  <span className="text-[11px] text-slate-400">{desc}</span>
                </div>
                <input
                  type="checkbox"
                  checked={s.preferences![key]}
                  disabled={s.busy}
                  onChange={(e) =>
                    s.actions.setPreferences({
                      ...s.preferences!,
                      [key]: e.target.checked,
                    })
                  }
                  className="mt-1 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
              </label>
            ))}

            <div className="pt-2 flex justify-end">
              <button
                type="button"
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition shadow-xs disabled:opacity-50 cursor-pointer flex items-center space-x-1.5"
                disabled={s.busy}
                onClick={() => void s.actions.save()}
              >
                {s.busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                <span>{s.busy ? "正在保存…" : "保存偏好设置"}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between py-2">
            <span className="text-xs text-slate-500">
              {s.busy ? "正在读取偏好设置…" : "偏好设置尚未加载"}
            </span>
            <button
              type="button"
              disabled={s.busy}
              className={baseBtn}
              onClick={() => void s.actions.loadPreferences()}
            >
              重新读取
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
