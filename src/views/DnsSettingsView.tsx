import React, { useState, useEffect } from "react";
import {
  Globe,
  Zap,
  Server,
  Filter,
  Save,
  RotateCcw,
  Check,
  AlertCircle,
  ChevronRight,
  Sliders,
  Network,
  Plus,
  Trash2,
} from "lucide-react";
import {
  DnsSettings,
  DnsEnhancedMode,
  DEFAULT_DNS_SETTINGS,
  getDnsSettings,
  saveDnsSettings,
} from "../api/dns";
import { DnsModeModal } from "../components/DnsModeModal";

export const DnsSettingsView: React.FC = () => {
  const [settings, setSettings] = useState<DnsSettings>(DEFAULT_DNS_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [isModeModalOpen, setIsModeModalOpen] = useState(false);
  const [newPolicyPattern, setNewPolicyPattern] = useState("");
  const [newPolicyServer, setNewPolicyServer] = useState("");

  useEffect(() => {
    getDnsSettings()
      .then((data) => {
        setSettings(data);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await saveDnsSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleResetToDefault = () => {
    if (window.confirm("确定要将 DNS 设置恢复为官方推荐的防污染预设吗？")) {
      setSettings({
        ...DEFAULT_DNS_SETTINGS,
        enableOverride: settings.enableOverride,
      });
      setSaved(false);
    }
  };

  const getModeDisplayName = (mode: DnsEnhancedMode) => {
    switch (mode) {
      case "fake-ip":
        return "fakeIp (虚拟假IP - 推荐)";
      case "redir-host":
        return "redirHost (真实IP重定向)";
      case "normal":
        return "normal (传统标准解析)";
      case "hosts":
        return "hosts (纯静态映射)";
      default:
        return mode;
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
        正在加载 DNS 覆写配置...
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-5 animate-in fade-in duration-200">
      {/* 顶部总开关卡片 */}
      <div className="bg-white/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm transition-colors">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              <Globe className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  覆写 DNS (Override DNS)
                </h3>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                    settings.enableOverride
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
                  }`}
                >
                  {settings.enableOverride ? "接管运行中" : "未覆写 (使用订阅原样)"}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                开启后将覆盖订阅配置中的 DNS 选项，强制应用纯净防污染本地分流引擎
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              setSettings({ ...settings, enableOverride: !settings.enableOverride });
              setSaved(false);
            }}
            className={`w-12 h-6 rounded-full transition relative p-0.5 cursor-pointer ${
              settings.enableOverride ? "bg-indigo-600" : "bg-slate-300 dark:bg-slate-800"
            }`}
          >
            <div
              className={`w-5 h-5 rounded-full bg-white transition shadow-sm ${
                settings.enableOverride ? "translate-x-6" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>

      {/* 基础控制与模式卡片 */}
      <div className="bg-white/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4 shadow-sm transition-colors">
        <div className="flex items-center space-x-2 text-sm font-semibold text-slate-900 dark:text-white">
          <Sliders className="w-4 h-4 text-indigo-500" />
          <span>基础解析与模式选项</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          {/* DNS 模式触发按钮 */}
          <div
            onClick={() => setIsModeModalOpen(true)}
            className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 hover:border-indigo-500/60 transition cursor-pointer flex items-center justify-between"
          >
            <div>
              <span className="block font-medium text-slate-600 dark:text-slate-400">
                DNS 模式 (Enhanced Mode)
              </span>
              <span className="block font-bold text-slate-900 dark:text-white mt-0.5 text-sm font-mono">
                {getModeDisplayName(settings.enhancedMode)}
              </span>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400" />
          </div>

          {/* 监听端口 */}
          <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40">
            <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
              本地监听端点 (Listen)
            </label>
            <input
              type="text"
              value={settings.listen}
              onChange={(e) => {
                setSettings({ ...settings, listen: e.target.value });
                setSaved(false);
              }}
              className="w-full px-3 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-300/80 dark:border-slate-800 text-slate-900 dark:text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
            />
          </div>
        </div>

        {/* 开关网格 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-200/60 dark:border-slate-800/60 text-xs">
          {[
            {
              label: "DNS 服务状态",
              desc: "关闭后将直接使用 Windows 操作系统本地 DNS",
              val: settings.status,
              toggle: () => setSettings({ ...settings, status: !settings.status }),
            },
            {
              label: "优先 HTTP/3 (PreferH3)",
              desc: "优先使用基于 QUIC 的 HTTP/3 向上游 DoH 查询",
              val: settings.preferH3,
              toggle: () => setSettings({ ...settings, preferH3: !settings.preferH3 }),
            },
            {
              label: "使用本地 Hosts",
              desc: "优先采用客户端配置文件中的自定义 Hosts 映射",
              val: settings.useHosts,
              toggle: () => setSettings({ ...settings, useHosts: !settings.useHosts }),
            },
            {
              label: "使用系统 Hosts",
              desc: "自动读取系统 hosts 文件静态条目",
              val: settings.useSystemHosts,
              toggle: () => setSettings({ ...settings, useSystemHosts: !settings.useSystemHosts }),
            },
            {
              label: "遵守分流规则 (Respect Rules)",
              desc: "DNS 连接本身也将经过分流规则判定路由出口",
              val: settings.respectRules,
              toggle: () => setSettings({ ...settings, respectRules: !settings.respectRules }),
            },
            {
              label: "DNS IPv6 解析",
              desc: "是否向服务器发起 AAAA 记录查询",
              val: settings.ipv6,
              toggle: () => setSettings({ ...settings, ipv6: !settings.ipv6 }),
            },
            {
              label: "追加系统 DNS",
              desc: "自动追加宿主机 Windows 网卡或 DHCP 下发的本地 DNS",
              val: settings.appendSystemDns ?? false,
              toggle: () => setSettings({ ...settings, appendSystemDns: !settings.appendSystemDns }),
            },
          ].map((item) => (
            <div
              key={item.label}
              className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50/40 dark:bg-slate-950/20 border border-slate-100 dark:border-slate-800/60"
            >
              <div>
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  {item.label}
                </span>
                <p className="text-[10px] text-slate-500 dark:text-slate-400">
                  {item.desc}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  item.toggle();
                  setSaved(false);
                }}
                className={`w-9 h-5 rounded-full transition relative p-0.5 cursor-pointer shrink-0 ml-2 ${
                  item.val ? "bg-indigo-600" : "bg-slate-300 dark:bg-slate-800"
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white transition shadow-sm ${
                    item.val ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Fake-IP 虚拟私有网段与白名单卡片 */}
      <div className="bg-white/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4 shadow-sm transition-colors">
        <div className="flex items-center space-x-2 text-sm font-semibold text-slate-900 dark:text-white">
          <Zap className="w-4 h-4 text-amber-500" />
          <span>Fake-IP 虚拟保留网段与白名单</span>
        </div>

        <div className="text-xs space-y-3">
          <div>
            <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium">
              Fake-IP 网段分配 (fake-ip-range)
            </label>
            <input
              type="text"
              value={settings.fakeIpRange}
              onChange={(e) => {
                setSettings({ ...settings, fakeIpRange: e.target.value });
                setSaved(false);
              }}
              className="w-full px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300/80 dark:border-slate-800 text-slate-900 dark:text-white font-mono focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              默认使用 RFC 6598 预留地址网段 198.18.0.1/16，避免与内网 192.168.x.x 发生冲突
            </p>
          </div>

          <div>
            <label className="block text-slate-600 dark:text-slate-400 mb-1 font-medium">
              Fake-IP 过滤白名单 (fake-ip-filter)
            </label>
            <textarea
              rows={3}
              value={settings.fakeIpFilter.join("\n")}
              onChange={(e) => {
                const list = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
                setSettings({ ...settings, fakeIpFilter: list });
                setSaved(false);
              }}
              placeholder="每行一个域名规则，例如 *.lan"
              className="w-full px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300/80 dark:border-slate-800 text-slate-900 dark:text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              白名单内的域名将直接获得真实 IP 解析，防止局域网设备或特定 Windows 网络探测报错
            </p>
          </div>
        </div>
      </div>

      {/* 域名解析服务器分流矩阵卡片 */}
      <div className="bg-white/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4 shadow-sm transition-colors">
        <div className="flex items-center space-x-2 text-sm font-semibold text-slate-900 dark:text-white">
          <Server className="w-4 h-4 text-emerald-500" />
          <span>域名解析服务器矩阵 (Nameservers)</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <div>
            <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">
              主域名服务器 (国内高速 DoH / nameserver)
            </label>
            <textarea
              rows={3}
              value={settings.nameserver.join("\n")}
              onChange={(e) => {
                const list = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
                setSettings({ ...settings, nameserver: list });
                setSaved(false);
              }}
              className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300/80 dark:border-slate-800 text-slate-900 dark:text-white font-mono focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              预设：阿里安全 DoH + 腾讯 DNSPod DoH
            </p>
          </div>

          <div>
            <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">
              备用防投毒服务器 (境外纯净 / fallback)
            </label>
            <textarea
              rows={3}
              value={settings.fallback.join("\n")}
              onChange={(e) => {
                const list = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
                setSettings({ ...settings, fallback: list });
                setSaved(false);
              }}
              className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300/80 dark:border-slate-800 text-slate-900 dark:text-white font-mono focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              预设：Cloudflare DoH (1.1.1.1) + Google DoH (8.8.8.8)
            </p>
          </div>

          <div>
            <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">
              默认引导服务器 (纯 IP / default-nameserver)
            </label>
            <input
              type="text"
              value={settings.defaultNameserver.join(", ")}
              onChange={(e) => {
                const list = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                setSettings({ ...settings, defaultNameserver: list });
                setSaved(false);
              }}
              className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300/80 dark:border-slate-800 text-slate-900 dark:text-white font-mono focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              用于首次解析 DoH 服务器域名自身（纯 IP：223.5.5.5, 119.29.29.29）
            </p>
          </div>

          <div>
            <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">
              代理节点解析服务器 (proxy-server-nameserver)
            </label>
            <input
              type="text"
              value={settings.proxyServerNameserver.join(", ")}
              onChange={(e) => {
                const list = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                setSettings({ ...settings, proxyServerNameserver: list });
                setSaved(false);
              }}
              className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300/80 dark:border-slate-800 text-slate-900 dark:text-white font-mono focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              专门用于解析代理节点连接地址域名的服务器
            </p>
          </div>
        </div>
      </div>

      {/* 域名服务器策略 (nameserver-policy) */}
      <div className="bg-white/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4 shadow-sm transition-colors">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2 text-sm font-semibold text-slate-900 dark:text-white">
            <Network className="w-4 h-4 text-cyan-500" />
            <span>域名服务器策略 (nameserver-policy)</span>
          </div>
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            定向专属上游映射，按规则精确定向解析
          </span>
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400">
          允许为指定域名规则（如 <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 font-mono">geosite:cn</code> 或 <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 font-mono">+.internal</code>）指定专属 DNS 服务器，彻底消除内外网解析冲突。
        </p>

        {/* 现有策略列表 */}
        <div className="space-y-2">
          {Object.entries(settings.nameserverPolicy || {}).length === 0 ? (
            <div className="p-4 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 text-center text-xs text-slate-400">
              暂未配置域名定向策略，默认使用上方通用 Nameserver 与 Fallback 解析矩阵
            </div>
          ) : (
            <div className="space-y-2">
              {Object.entries(settings.nameserverPolicy || {}).map(([pattern, server]) => (
                <div
                  key={pattern}
                  className="flex items-center justify-between p-3 rounded-xl bg-slate-50/70 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800/80 text-xs"
                >
                  <div className="flex items-center gap-3 overflow-hidden">
                    <span className="px-2.5 py-1 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-mono font-bold shrink-0">
                      {pattern}
                    </span>
                    <span className="text-slate-400 shrink-0">➔</span>
                    <span className="font-mono text-slate-700 dark:text-slate-300 truncate">
                      {server}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const updated = { ...(settings.nameserverPolicy || {}) };
                      delete updated[pattern];
                      setSettings({ ...settings, nameserverPolicy: updated });
                      setSaved(false);
                    }}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition shrink-0 ml-2 cursor-pointer"
                    title="删除规则"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 添加新策略表单 */}
        <div className="pt-2 border-t border-slate-200/60 dark:border-slate-800/60 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 text-xs">
            <input
              type="text"
              placeholder="域名规则 (如 geosite:cn 或 +.lan)"
              value={newPolicyPattern}
              onChange={(e) => setNewPolicyPattern(e.target.value)}
              className="sm:col-span-2 px-3 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-300/80 dark:border-slate-800 text-slate-900 dark:text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
            />
            <input
              type="text"
              placeholder="指定服务器 (如 https://dns.alidns.com/dns-query)"
              value={newPolicyServer}
              onChange={(e) => setNewPolicyServer(e.target.value)}
              className="sm:col-span-2 px-3 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-300/80 dark:border-slate-800 text-slate-900 dark:text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
            />
            <button
              type="button"
              onClick={() => {
                if (!newPolicyPattern.trim() || !newPolicyServer.trim()) return;
                setSettings({
                  ...settings,
                  nameserverPolicy: {
                    ...(settings.nameserverPolicy || {}),
                    [newPolicyPattern.trim()]: newPolicyServer.trim(),
                  },
                });
                setNewPolicyPattern("");
                setNewPolicyServer("");
                setSaved(false);
              }}
              disabled={!newPolicyPattern.trim() || !newPolicyServer.trim()}
              className="flex items-center justify-center space-x-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white font-medium text-xs transition cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>添加策略</span>
            </button>
          </div>

          {/* 快捷预设 */}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[11px] text-slate-500 dark:text-slate-400">快速预设:</span>
            {[
              { label: "国内直连加速 (geosite:cn ➔ 阿里DoH)", pattern: "geosite:cn", server: "https://dns.alidns.com/dns-query" },
              { label: "内网局域网解析 (+.lan ➔ 192.168.1.1)", pattern: "+.lan", server: "192.168.1.1" },
              { label: "企业/内网直通 (+.internal ➔ 10.0.0.1)", pattern: "+.corp.internal", server: "10.0.0.1" },
            ].map((preset) => (
              <button
                key={preset.pattern}
                type="button"
                onClick={() => {
                  setSettings({
                    ...settings,
                    nameserverPolicy: {
                      ...(settings.nameserverPolicy || {}),
                      [preset.pattern]: preset.server,
                    },
                  });
                  setSaved(false);
                }}
                className="px-2 py-0.5 rounded-md text-[10px] font-mono bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition cursor-pointer"
              >
                + {preset.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Fallback 防污染触发判定规则卡片 */}
      <div className="bg-white/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4 shadow-sm transition-colors">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2 text-sm font-semibold text-slate-900 dark:text-white">
            <Filter className="w-4 h-4 text-purple-500" />
            <span>Fallback 境外防污染过滤条件 (Fallback Filter)</span>
          </div>
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            多层防污染判定引擎，命中则改用纯净 Fallback 结果
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-50/50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800">
            <div>
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                GeoIP 判定过滤
              </span>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                若主服务器解析结果为非中国大陆 IP，自动采纳境外 Fallback 结果
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setSettings({
                  ...settings,
                  fallbackFilterGeoip: !settings.fallbackFilterGeoip,
                });
                setSaved(false);
              }}
              className={`w-10 h-5 rounded-full transition relative p-0.5 cursor-pointer shrink-0 ml-2 ${
                settings.fallbackFilterGeoip ? "bg-indigo-600" : "bg-slate-300 dark:bg-slate-800"
              }`}
            >
              <div
                className={`w-4 h-4 rounded-full bg-white transition shadow-sm ${
                  settings.fallbackFilterGeoip ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-50/50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800">
            <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">
              GeoIP 国家代码 (geoip-code)
            </label>
            <input
              type="text"
              value={settings.fallbackFilterGeoipCode}
              onChange={(e) => {
                setSettings({ ...settings, fallbackFilterGeoipCode: e.target.value.toUpperCase() });
                setSaved(false);
              }}
              className="w-full px-3 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-300/80 dark:border-slate-800 text-slate-900 dark:text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              默认 CN。符合该代码的 IP 将被认可为国内无污染真实 IP
            </p>
          </div>
        </div>

        {/* 进阶防投毒：geosite, ipcidr, domain */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-200/60 dark:border-slate-800/60 text-xs">
          <div>
            <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">
              Geosite 强制规则分类 (geosite)
            </label>
            <textarea
              rows={2}
              value={(settings.fallbackFilterGeosite || ["gfw"]).join("\n")}
              onChange={(e) => {
                const list = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
                setSettings({ ...settings, fallbackFilterGeosite: list });
                setSaved(false);
              }}
              placeholder="每行一个分类，例如 gfw"
              className="w-full px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300/80 dark:border-slate-800 text-slate-900 dark:text-white font-mono focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              默认预设 gfw。属于该分类的域名强制采纳境外 Fallback 结果
            </p>
          </div>

          <div>
            <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">
              投毒 IP 网段过滤池 (ipcidr)
            </label>
            <textarea
              rows={2}
              value={(settings.fallbackFilterIpcidr || ["240.0.0.0/4"]).join("\n")}
              onChange={(e) => {
                const list = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
                setSettings({ ...settings, fallbackFilterIpcidr: list });
                setSaved(false);
              }}
              placeholder="例如 240.0.0.0/4"
              className="w-full px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300/80 dark:border-slate-800 text-slate-900 dark:text-white font-mono focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              默认包含业内公认投毒网段 240.0.0.0/4，命中即判定污染
            </p>
          </div>

          <div>
            <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">
              强制 Fallback 域名 (domain)
            </label>
            <textarea
              rows={2}
              value={(settings.fallbackFilterDomain || []).join("\n")}
              onChange={(e) => {
                const list = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
                setSettings({ ...settings, fallbackFilterDomain: list });
                setSaved(false);
              }}
              placeholder="每行一个域名，例如 +.google.com"
              className="w-full px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300/80 dark:border-slate-800 text-slate-900 dark:text-white font-mono focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              可选。特定指定必须采纳 Fallback 结果的特殊域名列表
            </p>
          </div>
        </div>
      </div>

      {/* 状态与错误提示 */}
      {error && (
        <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 dark:bg-rose-950/40 dark:border-rose-800/60 dark:text-rose-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* 底部按钮栏 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 border-t border-slate-200/80 dark:border-slate-800/80">
        <button
          type="button"
          onClick={handleResetToDefault}
          className="flex items-center space-x-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 transition cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>恢复推荐防污染预设</span>
        </button>

        <div className="flex items-center space-x-3">
          {saved && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
              <Check className="w-3.5 h-3.5" />
              <span>DNS 覆写配置已保存并生效</span>
            </span>
          )}
          <button
            type="submit"
            disabled={saving}
            className="flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white font-semibold text-xs transition shadow-sm disabled:opacity-50 cursor-pointer"
          >
            <Save className="w-4 h-4" />
            <span>{saving ? "应用重启中..." : "保存 DNS 覆写"}</span>
          </button>
        </div>
      </div>

      {/* 4 档 DNS 模式单选弹窗 */}
      <DnsModeModal
        isOpen={isModeModalOpen}
        currentMode={settings.enhancedMode}
        onSelect={(newMode) => {
          setSettings({ ...settings, enhancedMode: newMode });
          setSaved(false);
        }}
        onClose={() => setIsModeModalOpen(false)}
      />
    </form>
  );
};
