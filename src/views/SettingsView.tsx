import React, { useState, useEffect } from "react";
import {
  Settings,
  Network,
  Sliders,
  Cpu,
  Save,
  Globe,
  Check,
  AlertCircle,
  Sun,
  Moon,
  Laptop,
  Palette,
  Zap,
} from "lucide-react";
import { useTheme, Theme } from "../context/ThemeContext";
import { getGeneralSettings, saveGeneralSettings } from "../api/settings";
import { DnsSettingsView } from "./DnsSettingsView";

export const SettingsView: React.FC = () => {
  const { theme, resolvedTheme, setTheme } = useTheme();

  // 常规设置、DNS 覆写与应用设置状态
  const [subTab, setSubTab] = useState<"general" | "dns" | "app">("general");

  // 常规设置状态
  const [mixedPort, setMixedPort] = useState(7890);
  const [controllerPort, setControllerPort] = useState(9090);
  const [enableControllerPort, setEnableControllerPort] = useState(true);
  const [allowLan, setAllowLan] = useState(false);
  const [ipv6, setIpv6] = useState(false);
  const [findProcessMode, setFindProcessMode] = useState("auto");
  const [autoCloseConnections, setAutoCloseConnections] = useState(true);
  const [trafficMode, setTrafficMode] = useState<string>("windivert");
  const [autoStart, setAutoStart] = useState(false);
  const [minimizeOnClose, setMinimizeOnClose] = useState(false);
  const [silentStart, setSilentStart] = useState(false);
  const [autoRun, setAutoRun] = useState(true);
  const [onlyProxyTraffic, setOnlyProxyTraffic] = useState(true);
  const [settingsReady, setSettingsReady] = useState(false);
  const [unifiedDelay, setUnifiedDelay] = useState(true);
  const [tcpConcurrent, setTcpConcurrent] = useState(false);
  const [geoLowMemory, setGeoLowMemory] = useState(true);
  const [speedTestUrl, setSpeedTestUrl] = useState("https://cp.cloudflare.com/generate_204");
  const [speedTestConcurrency, setSpeedTestConcurrency] = useState<number>(10);
  const [healthProbeConcurrency, setHealthProbeConcurrency] = useState<number>(4);
  const [appendSystemDns, setAppendSystemDns] = useState(false);
  const [logCapture, setLogCapture] = useState(true);
  const [tabAnimation, setTabAnimation] = useState(true);
  const [trayMenuStyle, setTrayMenuStyle] = useState<"modern" | "classic">("modern");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");

  useEffect(() => {
    getGeneralSettings().then((s) => {
      setMixedPort(s.mixedPort); setControllerPort(s.controllerPort);
      if (s.enableControllerPort !== undefined) setEnableControllerPort(s.enableControllerPort);
      setAllowLan(s.allowLan);
      if (s.ipv6 !== undefined) setIpv6(s.ipv6);
      if (s.findProcessMode !== undefined) setFindProcessMode(s.findProcessMode);
      if (s.autoCloseConnections !== undefined) setAutoCloseConnections(s.autoCloseConnections);
      if (s.appendSystemDns !== undefined) setAppendSystemDns(s.appendSystemDns);
      if (s.logCapture !== undefined) setLogCapture(s.logCapture);
      if (s.tabAnimation !== undefined) setTabAnimation(s.tabAnimation);
      if (s.trayMenuStyle) setTrayMenuStyle(s.trayMenuStyle);
      setTrafficMode(s.trafficMode || (s.tunMode ? "tun" : "windivert"));
      setAutoStart(s.autoStart);
      setUnifiedDelay(s.unifiedDelay ?? true); setTcpConcurrent(s.tcpConcurrent ?? false); setGeoLowMemory(s.geoLowMemory ?? true);
      setMinimizeOnClose(s.minimizeOnClose ?? false); setSilentStart(s.silentStart ?? false);
      setAutoRun(s.autoRun ?? true); setOnlyProxyTraffic(s.onlyProxyTraffic ?? true);
      if (s.speedTestUrl) setSpeedTestUrl(s.speedTestUrl);
      if (s.speedTestConcurrency) setSpeedTestConcurrency(s.speedTestConcurrency);
      if (s.healthProbeConcurrency) setHealthProbeConcurrency(s.healthProbeConcurrency);
      setSettingsReady(true);
    }).catch((e) => setSettingsError(String(e)));
  }, []);

  const handleGeneralSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setSaved(false); setSettingsError("");
    try {
      await saveGeneralSettings({
        mixedPort,
        controllerPort,
        enableControllerPort,
        allowLan,
        ipv6,
        findProcessMode,
        autoCloseConnections,
        appendSystemDns,
        logCapture,
        tabAnimation,
        trayMenuStyle,
        tunMode: trafficMode === "tun",
        trafficMode: trafficMode as any,
        autoStart,
        unifiedDelay,
        tcpConcurrent,
        geoLowMemory,
        minimizeOnClose,
        silentStart,
        autoRun,
        onlyProxyTraffic,
        speedTestUrl,
        speedTestConcurrency,
        healthProbeConcurrency,
      });
      try {
        localStorage.setItem("netbox_speed_test_concurrency", String(speedTestConcurrency));
        localStorage.setItem("netbox_health_probe_concurrency", String(healthProbeConcurrency));
        localStorage.setItem("netbox_tab_animation", String(tabAnimation));
        localStorage.setItem("netbox_log_capture", String(logCapture));
      } catch {}
      setSaved(true);
    } catch (error) { setSettingsError(String(error)); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* 顶部分类指示与子页面切换导航 (消除双标题，结构通透) */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-3 border-b border-slate-200/80 dark:border-slate-800/80">
        <div className="flex items-center space-x-3">
          <div className="p-2 rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400 border border-indigo-200/80 dark:border-indigo-500/25">
            {subTab === "general" ? <Settings className="w-4 h-4" /> : subTab === "app" ? <Cpu className="w-4 h-4" /> : <Globe className="w-4 h-4" />}
          </div>
          <div>
            <span className="text-sm font-bold text-slate-900 dark:text-white">
              {subTab === "general" ? "网络与核心常规设置" : subTab === "app" ? "外观与系统启动偏好" : "DNS 覆写与解析优化"}
            </span>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {subTab === "general"
                ? "配置本地代理端口、TUN 模式及核心运行性能"
                : subTab === "app"
                ? "管理托盘关闭、静默启动及流量统计范围"
                : "自定义配置本地防污染 DNS 服务器与解析策略"}
            </p>
          </div>
        </div>

        {/* 子页面切换 Pill 选项卡 (3 项收敛) */}
        <nav aria-label="设置分类" className="bg-slate-200/80 dark:bg-slate-900/90 border border-slate-300/80 dark:border-slate-800 p-1 rounded-xl flex flex-wrap items-center shadow-inner transition-colors">
          <button
            onClick={() => setSubTab("general")}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 cursor-pointer ${
              subTab === "general"
                ? "bg-white text-indigo-600 shadow-sm dark:bg-indigo-600 dark:text-white dark:shadow-md dark:shadow-indigo-500/20"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
            常规设置
          </button>
          <button
            onClick={() => setSubTab("dns")}
            aria-current={subTab === "dns" ? "page" : undefined}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 cursor-pointer ${
              subTab === "dns"
                ? "bg-white text-indigo-600 shadow-sm dark:bg-indigo-600 dark:text-white dark:shadow-md dark:shadow-indigo-500/20"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            DNS 覆写
          </button>
          <button
            onClick={() => setSubTab("app")}
            aria-current={subTab === "app" ? "page" : undefined}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 cursor-pointer ${
              subTab === "app"
                ? "bg-white text-indigo-600 shadow-sm dark:bg-indigo-600 dark:text-white dark:shadow-md dark:shadow-indigo-500/20"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            应用偏好
          </button>
        </nav>
      </div>

      {/* ======================= 子页面 2：DNS 覆写设置 ======================= */}
      {subTab === "dns" && <DnsSettingsView />}

      {/* ======================= 子页面 1：常规偏好与应用设置 ======================= */}
      {subTab !== "dns" && (
        <form onSubmit={handleGeneralSave} className="space-y-5">
          {subTab === "general" && <>
          {/* 端口与网络 */}
          <div className="bg-white/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4 shadow-sm transition-colors">
            <div className="flex items-center space-x-2 text-sm font-semibold text-slate-900 dark:text-white">
              <Network className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
              <span>网络与监听端口</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-slate-600 dark:text-slate-400 font-medium">
                    Mixed 本地混合端口 (HTTP/SOCKS5)
                  </label>
                  <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">常驻核心端口</span>
                </div>
                <input
                  type="number"
                  value={mixedPort}
                  onChange={(e) => {
                    setMixedPort(Number(e.target.value));
                    setSaved(false);
                  }}
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300/80 dark:border-slate-800 text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  系统代理与各应用 SOCKS5 / HTTP 流量接入端点
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-slate-600 dark:text-slate-400 font-medium">
                    API 外部控制端口 (RESTful)
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setEnableControllerPort(!enableControllerPort);
                      setSaved(false);
                    }}
                    className={`w-9 h-5 rounded-full transition relative p-0.5 ${
                      enableControllerPort ? "bg-indigo-600" : "bg-slate-300 dark:bg-slate-800"
                    }`}
                    title={enableControllerPort ? "点击关闭外部控制端口" : "点击开启外部控制端口"}
                  >
                    <div
                      className={`w-4 h-4 rounded-full bg-white transition shadow-sm ${
                        enableControllerPort ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
                <input
                  type="number"
                  value={controllerPort}
                  disabled={!enableControllerPort}
                  onChange={(e) => {
                    setControllerPort(Number(e.target.value));
                    setSaved(false);
                  }}
                  placeholder={enableControllerPort ? "9090" : "外部控制已关闭"}
                  className={`w-full px-3.5 py-2 rounded-xl border font-mono transition-colors ${
                    enableControllerPort
                      ? "bg-slate-50 dark:bg-slate-950 border-slate-300/80 dark:border-slate-800 text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500"
                      : "bg-slate-100 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800/50 text-slate-400 dark:text-slate-500 cursor-not-allowed"
                  }`}
                />
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  {enableControllerPort
                    ? "开启后允许本地或第三方 Web 仪表盘通过 REST API 进行管理"
                    : "已关闭外部控制端口，核心将不暴露 REST 控制接口"}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-800/60 text-xs">
              <div>
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  允许来自局域网的连接 (Allow LAN)
                </span>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  开启后同 WiFi/局域网内的手机或其它设备可填本机 IP 使用代理
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setAllowLan(!allowLan);
                  setSaved(false);
                }}
                className={`w-11 h-6 rounded-full transition relative p-0.5 ${
                  allowLan ? "bg-indigo-600" : "bg-slate-300 dark:bg-slate-800"
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-full bg-white transition shadow-sm ${
                    allowLan ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-800/60 text-xs">
              <div>
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  IPv6 流量支持
                </span>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  开启后内核将接收并转发 IPv6 流量；关闭可避免部分运营商 IPv6 握手缓慢
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIpv6(!ipv6);
                  setSaved(false);
                }}
                className={`w-11 h-6 rounded-full transition relative p-0.5 ${
                  ipv6 ? "bg-indigo-600" : "bg-slate-300 dark:bg-slate-800"
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-full bg-white transition shadow-sm ${
                    ipv6 ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </div>

          {/* 内核网络运行参数 */}
          <div className="bg-white/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4 shadow-sm transition-colors">
            <div className="flex items-center space-x-2 text-sm font-semibold text-slate-900 dark:text-white">
              <Sliders className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
              <span>内核网络运行参数</span>
            </div>

            <div className="space-y-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 p-4 text-slate-900 dark:text-slate-100">
              {[
                { title: "统一延迟", description: "统一延迟计算方式，减少不同代理协议握手带来的测量差异。", value: unifiedDelay, update: setUnifiedDelay },
                { title: "TCP 并发", description: "同时连接域名解析出的多个 IP，使用最先成功的连接。", value: tcpConcurrent, update: setTcpConcurrent },
                { title: "Geo 低内存", description: "使用节省内存的 Geo 数据加载器；关闭后使用标准加载器。", value: geoLowMemory, update: setGeoLowMemory },
                {
                  title: "查找进程",
                  description: "解析发起网络连接的应用名称与路径；开启后可配合进程分流，默认跟随进程分流状态自动启用。",
                  value: findProcessMode === "always",
                  update: (checked: boolean) => setFindProcessMode(checked ? "always" : "off"),
                },
                {
                  title: "追加系统 DNS",
                  description: "自动提取 Windows 本地网卡或路由器 DHCP 下发的 DNS，追加至解析服务器列表末尾以兼容内网解析。",
                  value: appendSystemDns,
                  update: setAppendSystemDns,
                },
              ].map(option => <label key={option.title} className="flex items-center justify-between gap-4 cursor-pointer">
                <span><span className="block text-sm font-medium">{option.title}</span><span className="block text-xs text-slate-500 dark:text-slate-400">{option.description}</span></span>
                <input type="checkbox" role="switch" checked={option.value} disabled={saving} onChange={e => { option.update(e.target.checked); setSaved(false); }} className="h-5 w-5 shrink-0 accent-indigo-600 rounded cursor-pointer" />
              </label>)}
              <p className="text-xs text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-200/60 dark:border-slate-800/60">保存后自动重启正在运行的核心；未运行时将在下次启动生效。</p>
            </div>
          </div>

          {/* 测速探针 URL 配置 */}
          <div className="bg-white/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4 shadow-sm transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2 text-sm font-semibold text-slate-900 dark:text-white">
                <Zap className="w-4 h-4 text-amber-500 dark:text-amber-400" />
                <span>节点测速探针与 204 源</span>
              </div>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                标准化极速 HTTP 204 零负载探针
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <button
                type="button"
                onClick={() => { setSpeedTestUrl("https://cp.cloudflare.com/generate_204"); setSaved(false); }}
                className={`p-3 rounded-xl border text-left transition flex items-start space-x-2.5 cursor-pointer ${
                  speedTestUrl === "https://cp.cloudflare.com/generate_204"
                    ? "border-indigo-500 bg-indigo-50/70 dark:bg-indigo-600/15 text-indigo-900 dark:text-indigo-200 ring-1 ring-indigo-500"
                    : "border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 text-slate-600 dark:text-slate-400 hover:border-slate-300"
                }`}
              >
                <div className="p-1 rounded-lg bg-indigo-500/10 text-indigo-500 shrink-0 mt-0.5">
                  <Zap className="w-3.5 h-3.5" />
                </div>
                <div>
                  <div className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                    <span>Cloudflare 204</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-mono">
                      默认推荐
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                    全球 Anycast 边缘网络，测速极速且低波动
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => { setSpeedTestUrl("https://www.google.com/generate_204"); setSaved(false); }}
                className={`p-3 rounded-xl border text-left transition flex items-start space-x-2.5 cursor-pointer ${
                  speedTestUrl === "https://www.google.com/generate_204"
                    ? "border-indigo-500 bg-indigo-50/70 dark:bg-indigo-600/15 text-indigo-900 dark:text-indigo-200 ring-1 ring-indigo-500"
                    : "border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 text-slate-600 dark:text-slate-400 hover:border-slate-300"
                }`}
              >
                <div className="p-1 rounded-lg bg-sky-500/10 text-sky-500 shrink-0 mt-0.5">
                  <Globe className="w-3.5 h-3.5" />
                </div>
                <div>
                  <div className="font-bold text-slate-900 dark:text-white">Google 204</div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                    直连海外核心网络，检验真实外网连通度
                  </p>
                </div>
              </button>
            </div>

            <div className="pt-2">
              <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                测速目标 URL (支持自定义):
              </label>
              <input
                type="text"
                value={speedTestUrl}
                onChange={(e) => { setSpeedTestUrl(e.target.value); setSaved(false); }}
                className="w-full px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300/80 dark:border-slate-800 text-xs font-mono text-slate-900 dark:text-white focus:outline-hidden focus:border-indigo-500"
                placeholder="https://cp.cloudflare.com/generate_204"
              />
            </div>

            {/* 批量延迟测速并发数 */}
            <div className="pt-3 border-t border-slate-200 dark:border-slate-800/60">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">
                    节点延迟测速并发数
                  </span>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    控制节点批量延迟测速的工作线程数。推荐 8 ~ 16，过高可能造成系统网络拥堵。
                  </p>
                </div>
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200/60 dark:border-indigo-800/60">
                  {speedTestConcurrency} 并发
                </span>
              </div>

              <div className="flex items-center space-x-3">
                <input
                  type="range"
                  min={1}
                  max={32}
                  step={1}
                  value={speedTestConcurrency}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setSpeedTestConcurrency(val);
                    setSaved(false);
                  }}
                  className="flex-1 h-2 bg-slate-200 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                />
                <div className="flex items-center space-x-1.5 shrink-0">
                  {[
                    { label: "8 稳定", value: 8 },
                    { label: "10 推荐", value: 10 },
                    { label: "16 高速", value: 16 },
                  ].map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => {
                        setSpeedTestConcurrency(preset.value);
                        setSaved(false);
                      }}
                      className={`px-2 py-1 rounded-lg text-[10px] font-medium transition cursor-pointer border ${
                        speedTestConcurrency === preset.value
                          ? "bg-indigo-600 text-white border-indigo-600"
                          : "bg-slate-100 hover:bg-slate-200 text-slate-600 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700"
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* IP 健康体检并发数 */}
            <div className="pt-3 border-t border-slate-200 dark:border-slate-800/60">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">
                    IP 健康体检并发数
                  </span>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    控制节点深度 IP 出口体检的分批与并发数量。采用动态分批机制，低并发（2~4）可杜绝端口冲突并规避外部查询 API 限流（45次/分）。
                  </p>
                </div>
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/60">
                  {healthProbeConcurrency} 并发
                </span>
              </div>

              <div className="flex items-center space-x-3">
                <input
                  type="range"
                  min={1}
                  max={32}
                  step={1}
                  value={healthProbeConcurrency}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setHealthProbeConcurrency(val);
                    setSaved(false);
                  }}
                  className="flex-1 h-2 bg-slate-200 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-600"
                />
                <div className="flex items-center space-x-1.5 shrink-0">
                  {[
                    { label: "2 稳妥", value: 2 },
                    { label: "4 推荐", value: 4 },
                    { label: "8 极速", value: 8 },
                    { label: "16 激进", value: 16 },
                  ].map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => {
                        setHealthProbeConcurrency(preset.value);
                        setSaved(false);
                      }}
                      className={`px-2 py-1 rounded-lg text-[10px] font-medium transition cursor-pointer border ${
                        healthProbeConcurrency === preset.value
                          ? "bg-emerald-600 text-white border-emerald-600"
                          : "bg-slate-100 hover:bg-slate-200 text-slate-600 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700"
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          </>}
          {/* 外观与主题 */}
          {subTab === "app" && (
            <div className="bg-white/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4 shadow-sm transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2 text-sm font-semibold text-slate-900 dark:text-white">
                  <Palette className="w-4 h-4 text-indigo-500" />
                  <span>外观与主题</span>
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  当前生效：<strong className="text-indigo-600 dark:text-indigo-400">{resolvedTheme === "dark" ? "🌙 暗黑模式" : "☀️ 明亮模式"}</strong>
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  { key: "light", label: "明亮模式", desc: "默认推荐，清爽通透", icon: Sun },
                  { key: "dark", label: "暗黑模式", desc: "深色夜间，沉浸护眼", icon: Moon },
                  { key: "system", label: "跟随系统", desc: "自动跟随系统明暗设置", icon: Laptop },
                ].map((item) => {
                  const Icon = item.icon;
                  const isSelected = theme === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setTheme(item.key as Theme)}
                      className={`flex flex-col items-center justify-center p-4 rounded-xl border text-center transition-all ${
                        isSelected
                          ? "bg-indigo-50 dark:bg-indigo-600/15 border-indigo-500 text-indigo-600 dark:text-indigo-400 shadow-sm ring-1 ring-indigo-500"
                          : "bg-slate-50/80 dark:bg-slate-800/40 border-slate-200 dark:border-slate-800/80 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-200"
                      }`}
                    >
                      <div
                        className={`p-2.5 rounded-xl mb-2.5 transition ${
                          isSelected
                            ? "bg-indigo-600 text-white shadow-md shadow-indigo-500/25"
                            : "bg-slate-200/80 dark:bg-slate-700/60 text-slate-600 dark:text-slate-300"
                        }`}
                      >
                        <Icon className="w-5 h-5" />
                      </div>
                      <span className="text-xs font-semibold">{item.label}</span>
                      <span className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{item.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 开机与自启 */}
          {subTab === "app" && (
            <div className="bg-white/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4 shadow-sm transition-colors">
              <div className="flex items-center space-x-2 text-sm font-semibold text-slate-900 dark:text-white">
                <Cpu className="w-4 h-4 text-amber-500 dark:text-amber-400" />
                <span>系统与启动项</span>
              </div>

              <div className="flex items-center justify-between text-xs">
                <div>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">自启动</span>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    登录系统后自动启动本应用
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="自启动"
                  aria-checked={autoStart}
                  disabled={saving || !settingsReady}
                  onClick={() => { setAutoStart(!autoStart); setSaved(false); }}
                  className={`w-11 h-6 rounded-full transition relative p-0.5 ${
                    autoStart ? "bg-indigo-600" : "bg-slate-300 dark:bg-slate-800"
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full bg-white transition shadow-sm ${
                      autoStart ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            </div>
          )}
          {subTab === "app" && <div className="space-y-5 rounded-xl border border-slate-300 bg-white p-5 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
            {[
              { label: "退出时最小化", description: "点击窗口关闭按钮时收起到托盘；从托盘菜单选择“退出 NetBox”可完全退出。", value: minimizeOnClose, set: setMinimizeOnClose },
              { label: "静默启动", description: "下次打开应用时隐藏主窗口，通过托盘重新打开。", value: silentStart, set: setSilentStart },
              { label: "自动运行", description: "下次打开应用时自动启动核心；关闭后由你手动启动。", value: autoRun, set: setAutoRun },
              { label: "自动关闭连接", description: "切换出站节点或路由模式后自动关闭存量连接，防止旧长连接延迟切换或遗留。", value: autoCloseConnections, set: setAutoCloseConnections },
              { label: "仅统计代理", description: "首页仅统计代理连接的采样流量，排除直连。短连接可能漏计，应用或核心重启后重新累计。", value: onlyProxyTraffic, set: setOnlyProxyTraffic },
              { label: "选项卡动画", description: "在切换主导航视图或设置子页时启用平滑过渡动效；关闭后页面将瞬间切换。", value: tabAnimation, set: setTabAnimation },
              { label: "日志捕获", description: "向内核订阅控制台实时输出与日志流；关闭可降低内存与后台 IPC 通信负荷。", value: logCapture, set: setLogCapture },
            ].map(option => <label key={option.label} className="flex items-center justify-between gap-4">
              <span><span className="block text-sm font-semibold">{option.label}</span><span className="block text-xs text-slate-600 dark:text-slate-400">{option.description}</span></span>
              <input type="checkbox" role="switch" checked={option.value} disabled={saving || !settingsReady} onChange={e => {option.set(e.target.checked); setSaved(false);}} className="h-5 w-5 shrink-0 accent-indigo-600" />
            </label>)}

            {/* 托盘菜单交互风格 */}
            <div className="pt-4 border-t border-slate-200/80 dark:border-slate-800/80 space-y-3">
              <div>
                <span className="block text-sm font-semibold">托盘右键菜单风格</span>
                <span className="block text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                  自定义任务栏托盘图标的右键交互形态。默认启用高颜值现代亚克力菜单，亦可选用极简原生菜单。
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => { setTrayMenuStyle("modern"); setSaved(false); }}
                  className={`flex flex-col p-3 rounded-xl border text-left transition cursor-pointer ${
                    trayMenuStyle === "modern"
                      ? "border-indigo-600 bg-indigo-50/50 dark:bg-indigo-950/30 text-indigo-900 dark:text-indigo-200 ring-1 ring-indigo-600"
                      : "border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-700 dark:text-slate-300"
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold text-xs mb-1">
                    <span>✨ 现代高颜值菜单 (推荐)</span>
                    {trayMenuStyle === "modern" && <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />}
                  </div>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    亚克力半透明磨砂、平滑抽屉滑动、精细对齐、即刻秒弹与深浅色自适应
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => { setTrayMenuStyle("classic"); setSaved(false); }}
                  className={`flex flex-col p-3 rounded-xl border text-left transition cursor-pointer ${
                    trayMenuStyle === "classic"
                      ? "border-indigo-600 bg-indigo-50/50 dark:bg-indigo-950/30 text-indigo-900 dark:text-indigo-200 ring-1 ring-indigo-600"
                      : "border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-700 dark:text-slate-300"
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold text-xs mb-1">
                    <span>🖥️ 系统原生经典菜单</span>
                    {trayMenuStyle === "classic" && <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />}
                  </div>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    Windows 原生 Win32 纯文本排版，零额外渲染消耗
                  </span>
                </button>
              </div>
            </div>
          </div>}
          {/* 表单底部统一操作栏与状态说明 */}
          {settingsError && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 dark:bg-rose-950/40 dark:border-rose-800/60 dark:text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{settingsError}</span>
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 border-t border-slate-200/80 dark:border-slate-800/80">
            <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />
              <span>
                {subTab === "general"
                  ? "修改端口或性能后保存，正在运行的核心将自动平滑重启生效；失败时自动恢复。"
                  : "自启动与静默启动将在下次登录或打开应用时生效；仅统计代理立即生效。"}
              </span>
            </div>

            <div className="flex items-center space-x-3 shrink-0 self-end sm:self-auto">
              {saved && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" />
                  已保存生效
                </span>
              )}
              <button
                type="submit"
                disabled={saving || !settingsReady}
                className="flex items-center space-x-1.5 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/25 transition disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                <span>{saving ? "保存并校验中..." : "保存偏好设置"}</span>
              </button>
            </div>
          </div>
        </form>
      )}



    </div>
  );
};
