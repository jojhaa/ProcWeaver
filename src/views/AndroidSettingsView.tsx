import { useState } from "react";
import { ArrowLeft, ChevronRight, Globe, Shield, Share2, Cloud, Activity, ScrollText, RefreshCw, History, LucideIcon } from "lucide-react";
import { version } from "../../package.json";
import { useAndroidSettings } from "../hooks/useAndroidSettings";
import { MobileNetworkSettings } from "../components/MobileNetworkSettings";
import { ConfigTransferPanel } from "../components/ConfigTransferPanel";
import { useConfigTransfer } from "../hooks/useConfigTransfer";
import { useMobileMaintenance } from "../hooks/useMobileMaintenance";
import { MobileMaintenancePanel } from "../components/MobileMaintenancePanel";
import { ThemeToggle } from "../components/ThemeToggle";
import { useMobileBack } from "../utils/mobileBack";

function BackupSettings() { const state = useConfigTransfer(); return <ConfigTransferPanel mobile state={state} />; }
function HistorySettings() { const state = useMobileMaintenance(); return <MobileMaintenancePanel state={state} />; }

function NetworkSettings({ section }: { section: "network" | "lan" | "system" }) {
  const state = useAndroidSettings();
  const settings = state.settings;
  if (!settings) return <p role="status" className="mobile-notice">{state.message || "正在读取设置…"}</p>;
  return <div className="space-y-4">
    {section === "network" ? <>
      <section className="mobile-card">
        {([
          ["ipv6", "IPv6 流量转发", "接管 IPv6 流量，适用于双栈网络。"],
          ["geoLowMemory", "低内存 GEO 加载", "按需读取规则数据库，减少内存占用。"],
          ["tcpConcurrent", "TCP 并发连接", "尝试多个解析地址，使用先建立的连接。"],
          ["onlyProxyTraffic", "仅统计代理流量", "首页图表过滤直连流量。"],
          ["logCapture", "运行日志", "进入日志页面时读取核心输出。"],
          ["tabAnimation", "页面过渡动画", "减少动效有助于降低界面开销。"],
        ] as const).map(([key, label, help]) => <label className="mobile-setting-row" key={key}><span><strong>{label}</strong><small>{help}</small></span><input type="checkbox" checked={Boolean(settings[key])} disabled={state.busy} onChange={event => state.setSettings({ ...settings, [key]: event.target.checked })} /></label>)}
        <label className="mobile-setting-row"><span><strong>同时测速节点数</strong><small>手机建议 2 个，最多 4 个。</small></span><input aria-label="同时测速节点数" className="mobile-number" type="number" min={1} max={4} inputMode="numeric" value={settings.speedTestConcurrency ?? 2} onChange={event => state.setSettings({ ...settings, speedTestConcurrency: Number(event.target.value) })} /></label>
        <label className="mobile-setting-row"><span><strong>同时体检节点数</strong><small>默认 2 个；遇到服务限流时可降为 1 个。</small></span><input aria-label="同时体检节点数" className="mobile-number" type="number" min={1} max={4} inputMode="numeric" value={settings.healthProbeConcurrency ?? 2} onChange={event => state.setSettings({ ...settings, healthProbeConcurrency: Number(event.target.value) })} /></label>
      </section>
      <p className="mobile-help">修改网络参数可能短暂重连 VPN；界面偏好无需重连。</p>
    </> : <MobileNetworkSettings section={section} settings={settings} onChange={state.setSettings} busy={state.busy} apps={state.apps} outbounds={state.outbounds} network={state.network} openSettings={page => void state.openSettings(page)} addVpnTile={() => void state.addVpnTile()} />}
    {section !== "system" && <button className="mobile-primary" disabled={state.busy} onClick={() => void state.save()}>{state.busy ? "正在保存…" : "保存设置"}</button>}
    {state.message && <p role="status" className="mobile-notice">{state.message}</p>}
  </div>;
}

type SettingItem = {
  id: string;
  title: string;
  detail: string;
  icon: LucideIcon;
};

type SettingGroup = {
  groupTitle: string;
  items: SettingItem[];
};

const settingGroups: SettingGroup[] = [
  {
    groupTitle: "网络与共享",
    items: [
      { id: "network", title: "网络与界面偏好", detail: "IPv6、内存、测速并发与流量统计", icon: Globe },
      { id: "lan", title: "局域网共享代理", detail: "共享地址、认证凭据和允许网段", icon: Share2 },
    ],
  },
  {
    groupTitle: "系统与权限",
    items: [
      { id: "system", title: "系统权限与后台运行", detail: "VPN 授权、省电白名单、通知与快捷开关", icon: Shield },
    ],
  },
  {
    groupTitle: "数据与同步",
    items: [
      { id: "backup", title: "备份与同步", detail: "配置加密备份、恢复和 WebDAV 云同步", icon: Cloud },
    ],
  },
  {
    groupTitle: "规则与维护",
    items: [
      { id: "maintenance", title: "规则与 GEO 更新", detail: "在线更新域名分流和 IP 归属数据库", icon: RefreshCw },
      { id: "history", title: "更新与流量历史", detail: "检查 APK 更新、查询历史流量账单", icon: History },
    ],
  },
  {
    groupTitle: "监控与日志",
    items: [
      { id: "connections", title: "连接记录", detail: "查看活跃应用连接与真实出口链路", icon: Activity },
      { id: "logs", title: "运行日志", detail: "连接排障、测速记录与 IP 体检详情", icon: ScrollText },
    ],
  },
];

const allDestinations = settingGroups.flatMap(g => g.items);

export function AndroidSettingsView({ onNavigate = page => window.dispatchEvent(new CustomEvent("netbox-navigate-tab", { detail: page })) }: { onNavigate?: (page: string) => void }) {
  const [page, setPage] = useState("home");
  useMobileBack(() => { if (page === "home") return false; setPage("home"); return true; }, 20);
  return <div className="mobile-page space-y-4">
    {page !== "home" && <button className="mobile-back cursor-pointer" onClick={() => setPage("home")}><ArrowLeft size={18} />{allDestinations.find(item => item.id === page)?.title}</button>}
    {page === "home" ? (
      <div className="space-y-4">
        {settingGroups.map((group) => (
          <div key={group.groupTitle} className="space-y-1.5">
            <h3 className="px-2 text-xs font-semibold text-slate-500 dark:text-slate-400 tracking-wider">
              {group.groupTitle}
            </h3>
            <section className="mobile-card mobile-menu">
              {group.items.map(({ id, title, detail, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => ["maintenance", "connections", "logs"].includes(id) ? onNavigate(id) : setPage(id)}
                  className="cursor-pointer"
                >
                  <Icon size={20} className="text-indigo-600 dark:text-indigo-400 shrink-0" />
                  <span>
                    <strong>{title}</strong>
                    <small>{detail}</small>
                  </span>
                  <ChevronRight size={18} className="text-slate-400 shrink-0" />
                </button>
              ))}
            </section>
          </div>
        ))}

        <div className="space-y-1.5">
          <h3 className="px-2 text-xs font-semibold text-slate-500 dark:text-slate-400 tracking-wider">
            外观与显示
          </h3>
          <section className="mobile-card">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="mobile-section-title">色彩主题</h2>
                <p className="mobile-help">浅色、深色或跟随系统外观</p>
              </div>
              <ThemeToggle />
            </div>
          </section>
        </div>

        <section className="mobile-card">
          <h2 className="mobile-section-title">ProcWeaver v{version}</h2>
          <p className="mobile-help">Android 客户端 · 内核随应用交付</p>
          <p className="mobile-help mt-1">后台服务保持连接，界面切入后台时图表与日志暂停刷新以节省电量。</p>
        </section>
      </div>
    ) : page === "backup" ? <BackupSettings /> : page === "history" ? <HistorySettings /> : <NetworkSettings section={page as "network" | "lan" | "system"} />}
  </div>;
}
