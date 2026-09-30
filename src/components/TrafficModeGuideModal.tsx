import React, { useState } from "react";
import { Zap, Bot, Shield, X, Check, HelpCircle } from "lucide-react";
import { usePlatform } from "../context/PlatformContext";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (dontShowAgain: boolean) => void;
  currentMode?: string;
}

export const TrafficModeGuideModal: React.FC<Props> = ({
  isOpen,
  onClose,
  onConfirm,
  currentMode,
}) => {
  const platform = usePlatform();
  const [dontShowAgain, setDontShowAgain] = useState(true);

  if (!isOpen) return null;

  const MODES = [
    {
      id: "app_proxy",
      title: "纯应用层代理 (App Proxy)",
      badge: "开箱首选 · 零驱动",
      desc: "零虚拟网卡 · 极低开销 · 系统零侵入",
      detail:
        "通过应用代理参数、环境变量或系统代理接入。由应用程序主动将网络连接转发给本地核心端口。",
      pros: [
        "零驱动特权：无需管理员权限，无任何驱动安装，极轻量省电，无系统冲突风险。",
        "即开即用零干扰：不影响任何网络底层驱动与系统路由表，适合日常浏览器与开发工具分流。",
      ],
      cons: [
        "受限于应用支持：仅对主动遵循系统代理或支持自定义代理的程序生效，非代理协议程序无法接管。",
      ],
      icon: <Zap className="w-4 h-4 text-amber-500" />,
      tagColor: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    },
    {
      id: "smart_hybrid",
      title: "智能双模式 (Auto-Hybrid)",
      badge: "智能感知 · 极客推荐",
      desc: "平时 0 网卡轻量巡航 · 启动游戏自动升维 TUN",
      detail:
        "优先使用应用代理；当启动 CS2、Apex、外服无代理配置游戏时自动唤醒 TUN，退出后平滑归位。",
      pros: [
        "动静结合：日常办公零网卡开销，启动大型外服游戏时自动拥有全协议接管能力。",
      ],
      cons: [
        "依赖 TUN 虚拟网卡环境，首次启动游戏时会有虚拟网卡短暂初始化握手。",
      ],
      icon: <Bot className="w-4 h-4 text-indigo-500" />,
      tagColor: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20",
    },
    {
      id: "windivert_v1",
      title: "进程级驱动接管 (WinDivert)",
      badge: "Windows · 精准穿透",
      desc: "按明确进程过滤并接管新 TCP / UDP 连接，免装虚拟网卡",
      detail:
        "通过 Windows 官方数字签名内核网络过滤驱动，按需拦截指定进程的网络数据包并注入分流核心，关闭时自动释放驱动句柄，零系统残留。",
      pros: [
        "免装虚拟网卡 (0 虚拟网卡)：不创建虚拟网卡适配器，不修改全局系统默认路由，完全不影响内网、局域网访问与局域网打印/共享。",
        "精准进程级分流：仅对目标业务程序定向分流，未指定的其他应用保持原生直连，性能损耗极低。",
        "原生 UDP DNS 捕获：支持捕获目标进程自行发起的 UDP DNS 解析，防污染重定向更精准。",
        "按需加载零残留：运行时动态挂载驱动，退出或关闭即刻释放系统过滤句柄，干净纯粹。",
      ],
      cons: [
        "需管理员提权 (UAC)：底层驱动安装与初始化必须拥有 Windows 管理员授权。",
        "内核反作弊游戏兼容性风险：易与带有内核级反作弊驱动的游戏（如 EAC、BattlEye、Vanguard 等）发生冲突；排错或游玩外服游戏时建议改用 TUN 模式或临时关闭。",
        "仅接管新建立的连接：仅对驱动启动后新发起的 TCP/UDP 连接生效；已有长连接及借道系统 DNS 代查 (svchost.exe) 的流量不保证接管。",
      ],
      icon: <Shield className="w-4 h-4 text-violet-500" />,
      tagColor: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20",
    },
    {
      id: "tun",
      title: "全局网卡模式 (TUN 虚拟网卡)",
      badge: "全协议接管 · 终极保障",
      desc: "Wintun 底层全协议接管 · 游戏与开发兜底",
      detail:
        "全系统所有 TCP、UDP 与 ICMP 流量及系统 DNS 强力接管走虚拟网卡，适合极复杂企业网络环境或特殊外服联机需求。",
      pros: [
        "终极兜底强力穿透：全系统所有协议流量（TCP/UDP/ICMP）与 DNS 无一遗漏全部进入核心，彻底解决软件无法配置代理的问题。",
        "游戏防作弊兼容良好：基于标准 Wintun 网卡，与绝大多数游戏内核反作弊组件兼容性优于包过滤驱动。",
      ],
      cons: [
        "全局流量均经由虚拟网卡，部分局域网内网穿透或特殊 VPN 拓扑可能需要调整旁路分流规则。",
      ],
      icon: <Shield className="w-4 h-4 text-blue-500" />,
      tagColor: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="w-full max-w-xl rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl p-5 space-y-4 font-sans">
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
          <div className="flex items-center space-x-2">
            <div className="p-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400">
              <HelpCircle className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                应用分流接管模式与驱动特性说明
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                深入了解各底层模式的架构差异、适用场景与 WinDivert 优缺点：
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 模式特性卡片列表 */}
        <div className="space-y-3 max-h-[62vh] overflow-y-auto pr-1">
          {MODES.filter(item => item.id === "app_proxy" || (item.id === "windivert_v1" ? platform.os === "windows" : item.id === "tun" ? platform.tun : platform.smartHybrid)).map((item) => {
            const isHighlight = currentMode === item.id;
            return (
              <div
                key={item.id}
                className={`p-3.5 rounded-xl border transition ${
                  isHighlight
                    ? "bg-indigo-50/40 dark:bg-indigo-950/30 border-indigo-300 dark:border-indigo-500/40 shadow-xs"
                    : "bg-slate-50/80 dark:bg-slate-950/50 border-slate-200/80 dark:border-slate-800/80"
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center space-x-2">
                    {item.icon}
                    <h4 className="text-xs font-bold text-slate-900 dark:text-white">
                      {item.title}
                    </h4>
                  </div>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-md border font-mono ${item.tagColor}`}
                  >
                    {item.badge}
                  </span>
                </div>
                <p className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                  {item.desc}
                </p>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                  {item.detail}
                </p>

                {/* 优势列表 */}
                {item.pros && item.pros.length > 0 && (
                  <div className="mt-2 space-y-1 bg-emerald-500/5 dark:bg-emerald-950/20 p-2.5 rounded-xl border border-emerald-500/20 text-[10px]">
                    <span className="font-bold text-emerald-700 dark:text-emerald-400 block text-[11px] mb-0.5">
                      ✓ 核心优势：
                    </span>
                    {item.pros.map((p, idx) => (
                      <div key={idx} className="text-slate-700 dark:text-slate-300 flex items-start space-x-1.5 leading-relaxed">
                        <span className="text-emerald-500 font-bold shrink-0">•</span>
                        <span>{p}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* 缺点与注意事项 */}
                {item.cons && item.cons.length > 0 && (
                  <div className="mt-1.5 space-y-1 bg-amber-500/5 dark:bg-amber-950/20 p-2.5 rounded-xl border border-amber-500/20 text-[10px]">
                    <span className="font-bold text-amber-700 dark:text-amber-400 block text-[11px] mb-0.5">
                      ⚠️ 缺点与注意事项：
                    </span>
                    {item.cons.map((c, idx) => (
                      <div key={idx} className="text-slate-700 dark:text-slate-300 flex items-start space-x-1.5 leading-relaxed">
                        <span className="text-amber-500 font-bold shrink-0">•</span>
                        <span>{c}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 底部交互 */}
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <label className="flex items-center space-x-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
            />
            <span>下次切换时不再自动提示</span>
          </label>

          <button
            type="button"
            onClick={() => onConfirm(dontShowAgain)}
            className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow-xs cursor-pointer flex items-center space-x-1"
          >
            <Check className="w-3.5 h-3.5" />
            <span>我知道了</span>
          </button>
        </div>
      </div>
    </div>
  );
};
