import { useState } from "react";
import type { GeneralSettings } from "../api/settings";
import type { AndroidApplication, AndroidNetworkInfo } from "../api/android";
import {
  Share2,
  ShieldCheck,
  Settings2,
  Copy,
  ChevronLeft,
  ChevronRight,
  Search,
  Wifi,
  Zap,
  ExternalLink,
  PlusCircle,
} from "lucide-react";

export type VpnAppFilter = "all" | "user" | "system" | "selected";

export function filterVpnApplications(apps: AndroidApplication[], packages: string[], search: string, filter: VpnAppFilter) {
  const query = search.trim().toLowerCase();
  const selected = new Set(packages);
  return apps.filter(app => {
    if (filter === "user" && app.systemApp) return false;
    if (filter === "system" && !app.systemApp) return false;
    if (filter === "selected" && !selected.has(app.packageName)) return false;
    return !query || `${app.label} ${app.packageName}`.toLowerCase().includes(query);
  });
}

export function updateVpnAppPackages(packages: string[], apps: AndroidApplication[], checked: boolean) {
  const next = new Set(packages);
  for (const app of apps) {
    if (checked) next.add(app.packageName);
    else next.delete(app.packageName);
  }
  return Array.from(next);
}

export function MobileNetworkSettings({
  section = "all",
  settings,
  onChange,
  busy,
  apps,
  outbounds,
  network,
  openSettings,
  addVpnTile,
}: {
  section?: "all" | "apps" | "lan" | "system";
  settings: GeneralSettings;
  onChange: (value: GeneralSettings) => void;
  busy: boolean;
  apps: AndroidApplication[];
  outbounds: string[];
  network: AndroidNetworkInfo | null;
  openSettings: (page: "vpn" | "battery" | "app") => void;
  addVpnTile: () => void;
}) {
  const [search, setSearch] = useState("");
  const [appFilter, setAppFilter] = useState<VpnAppFilter>("all");
  const [page, setPage] = useState(0);
  const [copied, setCopied] = useState("");
  const lan = settings.lanSharing ?? {
    port: 7891,
    username: "",
    password: "",
    allowedNetworks: ["192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12"],
    outbound: "",
  };
  const policy = settings.vpnApps ?? { mode: "all", packages: [] };
  const filtered = filterVpnApplications(apps, policy.packages, search, appFilter);
  const selected = new Set(policy.packages);
  const selectedInFilter = filtered.filter(app => selected.has(app.packageName)).length;
  const pageCount = Math.max(1, Math.ceil(filtered.length / 60));
  const currentPage = Math.min(page, pageCount - 1);
  const appFilters: { id: VpnAppFilter; label: string; count: number }[] = [
    { id: "all", label: "全部", count: apps.length },
    { id: "user", label: "用户", count: apps.filter(app => !app.systemApp).length },
    { id: "system", label: "系统", count: apps.filter(app => app.systemApp).length },
    { id: "selected", label: "已选", count: apps.filter(app => selected.has(app.packageName)).length },
  ];
  const setFilteredSelection = (checked: boolean) => {
    const affected = checked ? filtered.length - selectedInFilter : selectedInFilter;
    if (affected > 20) {
      const action = checked
        ? policy.mode === "exclude" ? "排除" : "纳入"
        : policy.mode === "exclude" ? "取消排除" : "取消纳入";
      const warning = appFilter === "system" ? "系统应用与共享 UID 应用可能一同受影响。" : "";
      if (!window.confirm(`${action} ${affected} 个匹配应用？${warning}修改仅保留在当前草稿，保存后将重建 VPN。`)) return;
    }
    onChange({
      ...settings,
      vpnApps: { ...policy, packages: updateVpnAppPackages(policy.packages, filtered, checked) },
    });
  };
  const updateLan = (value: Partial<typeof lan>) =>
    onChange({ ...settings, lanSharing: { ...lan, ...value } });

  const inputClass =
    "w-full rounded-xl border border-slate-200 dark:border-slate-700 p-2.5 bg-slate-50/60 dark:bg-slate-800/60 text-xs text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition";

  return (
    <div className="space-y-4">
      {/* 1. VPN 应用名单 */}
      {(section === "all" || section === "apps") && <section
        className={`rounded-2xl border border-slate-200/90 dark:border-slate-800/80 bg-white dark:bg-slate-900/80 shadow-sm ${section === "apps" ? "p-3 space-y-2.5" : "p-4 space-y-3.5"}`}
        aria-label="VPN 应用接管名单"
      >
        {section === "all" && <div className="flex items-center space-x-2 border-b border-slate-100 dark:border-slate-800 pb-2.5">
          <ShieldCheck className="w-4 h-4 text-indigo-500" />
          <h3 className="font-bold text-xs text-slate-800 dark:text-slate-200 uppercase tracking-wide">
            VPN 接管应用范围
          </h3>
        </div>}

        <div className="space-y-1">
          <label className="text-xs text-slate-500 dark:text-slate-400">接管模式</label>
          <select
            aria-label="VPN 应用模式"
            className={inputClass}
            disabled={busy}
            value={policy.mode}
            onChange={(e) =>
              onChange({
                ...settings,
                vpnApps: { ...policy, mode: e.target.value as typeof policy.mode },
              })
            }
          >
            <option value="all">全部应用进入 VPN</option>
            <option value="include">仅勾选应用进入 VPN</option>
            <option value="exclude">勾选应用绕过 VPN</option>
          </select>
        </div>

        <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
          保存后将重建 VPN。共享 UID 的应用会一起受影响；系统锁定 VPN 时，被排除应用可能无法联网。
        </p>

        {policy.mode !== "all" && (
          <div className="space-y-3 pt-1">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-3 text-slate-400" />
              <input
                aria-label="搜索 VPN 应用"
                placeholder="搜索应用名称或包名…"
                className={`${inputClass} pl-8`}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
              />
            </div>

            <div role="group" aria-label="筛选 VPN 应用" className="grid grid-cols-4 gap-1">
              {appFilters.map(filter => (
                <button
                  key={filter.id}
                  type="button"
                  aria-pressed={appFilter === filter.id}
                  onClick={() => { setAppFilter(filter.id); setPage(0); }}
                  className={`min-h-12 rounded-lg px-1 text-[11px] font-semibold whitespace-nowrap transition ${appFilter === filter.id
                    ? "bg-indigo-600 text-white"
                    : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"}`}
                >
                  {filter.label} ({filter.count})
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
              <span>已{policy.mode === "exclude" ? "排除" : "纳入"} {policy.packages.length} 个应用</span>
              <span>当前筛选 {filtered.length} 项</span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button type="button" disabled={busy || filtered.length === selectedInFilter}
                onClick={() => setFilteredSelection(true)}
                className="min-h-12 rounded-xl bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 text-[11px] font-semibold disabled:opacity-40">
                {policy.mode === "exclude" ? "排除匹配项" : "纳入匹配项"} ({filtered.length - selectedInFilter})
              </button>
              <button type="button" disabled={busy || selectedInFilter === 0}
                onClick={() => setFilteredSelection(false)}
                className="min-h-12 rounded-xl bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 text-[11px] font-semibold disabled:opacity-40">
                {policy.mode === "exclude" ? "取消排除" : "取消纳入"} ({selectedInFilter})
              </button>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">批量操作作用于全部匹配项，包含其他页；保存后生效。</p>

            <div className="divide-y divide-slate-100 dark:divide-slate-800/80 max-h-72 overflow-y-auto pr-1">
              {filtered.slice(currentPage * 60, (currentPage + 1) * 60).map((app) => (
                <label
                  key={app.packageName}
                  className="flex items-center justify-between gap-3 py-2 cursor-pointer hover:bg-slate-50/50 dark:hover:bg-slate-800/40 rounded-lg px-1 transition"
                >
                  <div className="flex items-center space-x-2.5 min-w-0">
                    <div className="w-7 h-7 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 font-bold text-xs flex items-center justify-center shrink-0">
                      {app.label.charAt(0) || "A"}
                    </div>
                    <div className="min-w-0">
                      <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 block truncate">
                        {app.label}
                      </span>
                      <small className="block text-[10px] text-slate-400 font-mono truncate">
                        {app.packageName}
                        {app.systemApp ? " · 系统应用" : ""}
                        {app.sharedUid ? " · 共享 UID，同组应用一并受影响" : ""}
                      </small>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={selected.has(app.packageName)}
                    onChange={(e) =>
                      onChange({
                        ...settings,
                        vpnApps: {
                          ...policy,
                          packages: updateVpnAppPackages(policy.packages, [app], e.target.checked),
                        },
                      })
                    }
                    className="h-4 w-4 accent-indigo-600 rounded cursor-pointer shrink-0"
                  />
                </label>
              ))}
              {!filtered.length && (
                <p className="py-4 text-center text-xs text-slate-400">当前筛选下没有匹配的应用。</p>
              )}
            </div>

            {filtered.length > 60 && (
              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                  className="flex items-center space-x-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold disabled:opacity-40"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>上一页</span>
                </button>
                <span className="text-xs text-slate-500 font-mono">
                  第 {currentPage + 1} / {pageCount} 页
                </span>
                <button
                  type="button"
                  disabled={currentPage + 1 >= pageCount}
                  onClick={() => setPage(currentPage + 1)}
                  className="flex items-center space-x-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold disabled:opacity-40"
                >
                  <span>下一页</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}
      </section>}

      {/* 2. 局域网共享代理 */}
      {(section === "all" || section === "lan") && <section
        className="rounded-2xl border border-slate-200/90 dark:border-slate-800/80 bg-white dark:bg-slate-900/80 p-4 shadow-sm space-y-3.5"
        aria-label="局域网共享代理"
      >
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2.5">
          <div className="flex items-center space-x-2">
            <Share2 className="w-4 h-4 text-indigo-500" />
            <h3 className="font-bold text-xs text-slate-800 dark:text-slate-200 uppercase tracking-wide">
              局域网共享代理
            </h3>
          </div>
          <input
            type="checkbox"
            checked={settings.allowLan}
            disabled={busy}
            onChange={(e) => onChange({ ...settings, allowLan: e.target.checked })}
            className="h-5 w-5 accent-indigo-600 rounded cursor-pointer"
          />
        </div>

        <p className="text-[11px] text-slate-500 leading-relaxed">
          连接 VPN 后，在同 Wi-Fi 或热点内的设备上手动设置本机代理地址、端口及账号密码。此功能不会自动接管热点的全部流量。
        </p>

        {settings.allowLan && (
          <fieldset disabled={busy} className="space-y-3 pt-1">
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-xs text-slate-600 dark:text-slate-400">共享监听端口</span>
                <input
                  aria-label="共享端口"
                  inputMode="numeric"
                  className={inputClass}
                  value={lan.port || ""}
                  onChange={(e) => updateLan({ port: Number(e.target.value) })}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-slate-600 dark:text-slate-400">指定出口（可选）</span>
                <input
                  list="mobile-lan-outbounds"
                  className={inputClass}
                  value={lan.outbound}
                  onChange={(e) => updateLan({ outbound: e.target.value })}
                  placeholder="跟随当前规则"
                />
                <datalist id="mobile-lan-outbounds">
                  {outbounds.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-xs text-slate-600 dark:text-slate-400">认证用户名</span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  value={lan.username}
                  onChange={(e) => updateLan({ username: e.target.value })}
                  placeholder="留空即免认证"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-slate-600 dark:text-slate-400">认证密码</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  className={inputClass}
                  value={lan.password}
                  onChange={(e) => updateLan({ password: e.target.value })}
                  placeholder="至少 8 字节"
                />
              </label>
            </div>

            <label className="block space-y-1">
              <span className="text-xs text-slate-600 dark:text-slate-400">允许访问的网段</span>
              <textarea
                className={inputClass}
                rows={2}
                value={lan.allowedNetworks.join("\n")}
                onChange={(e) =>
                  updateLan({
                    allowedNetworks: e.target.value.split(/[\n,，;；]/).map((v) => v.trim()),
                  })
                }
                onBlur={() =>
                  updateLan({ allowedNetworks: lan.allowedNetworks.filter(Boolean) })
                }
              />
            </label>

            {/* 本机局域网共享地址一览 */}
            <div className="space-y-2 pt-1">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 block">
                局域网连接地址（点击一键复制）：
              </span>
              {network?.addresses && network.addresses.length > 0 ? (
                <div className="space-y-1.5">
                  {network.addresses.map((item) => (
                    <button
                      key={`${item.interface}:${item.address}`}
                      type="button"
                      className="w-full flex items-center justify-between p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 text-left transition hover:border-indigo-500 cursor-pointer"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(`${item.address}:${lan.port}`)
                          .then(() => setCopied(`已复制 ${item.address}:${lan.port}`))
                          .catch(() => setCopied("复制失败，请长按手动复制"));
                      }}
                    >
                      <div className="flex items-center space-x-2 min-w-0">
                        <Wifi className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                        <span className="text-xs font-mono font-bold text-slate-800 dark:text-slate-200 truncate">
                          {item.address}:{lan.port}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-mono">
                          {item.interface}
                        </span>
                      </div>
                      <Copy className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  尚未检测到可共享的有效 IPv4 地址，请先连接 Wi-Fi 或开启热点。
                </p>
              )}
              {copied && (
                <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400 font-semibold text-center">
                  {copied}
                </p>
              )}
            </div>
          </fieldset>
        )}
      </section>}

      {/* 3. 系统连接与保活设置 */}
      {(section === "all" || section === "system") && <section
        className="rounded-2xl border border-slate-200/90 dark:border-slate-800/80 bg-white dark:bg-slate-900/80 p-4 shadow-sm space-y-3.5"
        aria-label="系统连接设置"
      >
        <div className="flex items-center space-x-2 border-b border-slate-100 dark:border-slate-800 pb-2.5">
          <Settings2 className="w-4 h-4 text-indigo-500" />
          <h3 className="font-bold text-xs text-slate-800 dark:text-slate-200 uppercase tracking-wide">
            系统连接与保活快捷入口
          </h3>
        </div>

        <p className="text-[11px] text-slate-500 leading-relaxed">
          部分定制系统存在严格的后台限制策略，推荐跳转系统配置以确保核心长期平稳运行：
        </p>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="flex items-center justify-center space-x-1.5 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 transition"
            onClick={() => openSettings("vpn")}
          >
            <ExternalLink className="w-3.5 h-3.5 text-indigo-500" />
            <span>系统 VPN 设置</span>
          </button>
          <button
            type="button"
            className="flex items-center justify-center space-x-1.5 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 transition"
            onClick={() => openSettings("battery")}
          >
            <Zap className="w-3.5 h-3.5 text-amber-500" />
            <span>后台省电与自启</span>
          </button>
          <button
            type="button"
            className="flex items-center justify-center space-x-1.5 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 transition"
            onClick={() => openSettings("app")}
          >
            <Settings2 className="w-3.5 h-3.5 text-cyan-500" />
            <span>应用权限与通知</span>
          </button>
          <button
            type="button"
            className="flex items-center justify-center space-x-1.5 p-2.5 rounded-xl border border-indigo-200 dark:border-indigo-800/60 bg-indigo-50/60 dark:bg-indigo-950/40 hover:bg-indigo-100/60 text-xs font-semibold text-indigo-700 dark:text-indigo-300 transition"
            onClick={addVpnTile}
          >
            <PlusCircle className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
            <span>添加快捷开关磁贴</span>
          </button>
        </div>

        <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/60 dark:border-slate-800 text-[11px] text-slate-500 space-y-1">
          <p className="font-semibold text-slate-700 dark:text-slate-300">
            后台订阅与 GEO 定时检查：
            <span className="font-mono ml-1 font-normal">
              {network?.maintenance?.checkedAt
                ? `${new Date(network.maintenance.checkedAt).toLocaleString()} · ${
                    network.maintenance.success ? "检查完成" : "未完成，将重试"
                  }`
                : "等待系统调度任务"}
            </span>
          </p>
        </div>
      </section>}
    </div>
  );
}
