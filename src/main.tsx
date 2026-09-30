import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./mobile.css";
import { monitorStore } from "./api/traffic";

import { ThemeProvider } from "./context/ThemeContext";
import { PlatformContext } from "./context/PlatformContext";
import { initializePlatform } from "./services/platform";
import { isAppHidden } from "./utils/appVisibility";
import { applyPendingBrowserRestore } from "./api/configTransfer";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
async function bootstrap() {
  root.render(<p role="status" className="p-8">正在读取平台能力…</p>);
  try {
    await applyPendingBrowserRestore();
    const platform = await initializePlatform();
    document.documentElement.dataset.platform = platform.os;
    if (platform.os === "android") {
      const visibility = () => monitorStore.setPaused(isAppHidden());
      document.addEventListener("visibilitychange", visibility);
      visibility();
    }
    root.render(
  <React.StrictMode>
    <PlatformContext.Provider value={platform}>
    <ThemeProvider>
      <App />
    </ThemeProvider>
    </PlatformContext.Provider>
  </React.StrictMode>,
);
  } catch (error) {
    root.render(<div className="p-8 space-y-4"><p role="alert">启动失败：{String(error)}</p>
      <button onClick={() => void bootstrap()} className="border rounded px-4 py-2">重试</button></div>);
  }
}
void bootstrap();
