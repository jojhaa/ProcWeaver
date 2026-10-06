import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { ThemeProvider } from "./context/ThemeContext";
import { PlatformContext } from "./context/PlatformContext";
import { initializePlatform } from "./services/platform";
import { ProcessProxyView } from "./views/ProcessProxyView";
import { ProcessMaintenanceView } from "./views/ProcessMaintenanceView";
import { bundleController } from "./services/bundleRuntime";
import { configureDesktopContextMenu } from "./utils/desktopContextMenu";

bundleController.setFunctionMode("process_proxy");
document.documentElement.dataset.edition = "process";
const root = ReactDOM.createRoot(document.getElementById("root")!);
async function bootstrap() {
  root.render(<p role="status" className="p-8">正在打开独立进程版…</p>);
  try {
    const platform = await initializePlatform();
    document.documentElement.dataset.platform = platform.os;
    configureDesktopContextMenu(platform.os !== "android");
    root.render(<React.StrictMode><PlatformContext.Provider value={platform}><ThemeProvider>
      <ProcessProxyView standalone maintenance={<ProcessMaintenanceView />} capability={{
        mode: "process_proxy", coreRunning: false, independentWinDivert: true,
        winDivertReason: "WinDivert 需管理员权限；与完整版同时运行时请使用纯应用层",
      }} />
    </ThemeProvider></PlatformContext.Provider></React.StrictMode>);
  } catch (error) {
    root.render(<div className="p-8 space-y-4"><p role="alert">启动失败：{String(error)}</p>
      <button onClick={() => void bootstrap()} className="border rounded px-4 py-2">重试</button></div>);
  }
}
void bootstrap();
