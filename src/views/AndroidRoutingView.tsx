import { useState } from "react";
import { AndroidAppsView } from "./AndroidAppsView";
import { AndroidRulesView } from "./AndroidRulesView";
import { useAndroidSettings } from "../hooks/useAndroidSettings";
import { MobileNetworkSettings } from "../components/MobileNetworkSettings";
import type { useCoreMode } from "../hooks/useCoreMode";

function AppScope() {
  const state = useAndroidSettings(true);
  if (!state.settings) return <p role="status" className="mobile-help">{state.message || "正在读取接管范围…"}</p>;
  return <div className="mobile-scope"><MobileNetworkSettings section="apps" settings={state.settings} onChange={state.setSettings} apps={state.apps} outbounds={state.outbounds} network={state.network} busy={state.busy} openSettings={page => void state.openSettings(page)} addVpnTile={() => void state.addVpnTile()} /><div className="mobile-scope-footer"><button className="mobile-primary" disabled={state.busy} onClick={() => void state.save()}>保存接管范围</button>{state.message && <p role="status" className="mobile-help">{state.message}</p>}</div></div>;
}

export function AndroidRoutingView({ coreMode, running }: { coreMode: ReturnType<typeof useCoreMode>; running: boolean }) {
  const mode = coreMode.mode;
  const [tab, setTab] = useState(() => {
    try {
      const stored = localStorage.getItem("procweaver-mobile-routing");
      if (stored === "bundles") return "exits";
      return stored || "exits";
    } catch {
      return "exits";
    }
  });
  const select = (value: string) => { setTab(value); try { localStorage.setItem("procweaver-mobile-routing", value); } catch {} };
  return <div className="h-full flex flex-col min-h-0">
    <div className="mobile-page mobile-routing-nav">
      <div className="mobile-segments" role="group" aria-label="应用分流分类">
        {[["exits", "应用出口"], ["scope", "接管范围"], ["rules", "域名/IP"]].map(([id, label]) => (
          <button key={id} aria-pressed={tab === id} onClick={() => select(id)} className="text-xs">
            {label}
          </button>
        ))}
      </div>
      {(!running || mode !== "rule") && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">{!running ? "未连接 · 配置可保存，连接后生效" : "当前为非规则模式 · 应用出口暂不生效"}</p>}
    </div>
    <div className={`flex-1 min-h-0 ${tab === "exits" ? "overflow-hidden" : "overflow-auto"}`}>
      {tab === "scope" ? (
        <div className="mobile-page mobile-scope-page"><AppScope /></div>
      ) : tab === "rules" ? (
        <div className="mobile-page"><AndroidRulesView coreMode={coreMode} running={running} /></div>
      ) : (
        <AndroidAppsView onOpenRules={() => select("rules")} />
      )}
    </div>
  </div>;
}
