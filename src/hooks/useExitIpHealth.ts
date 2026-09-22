import { useEffect, useState, useCallback } from "react";
import { fetchIpHealth, waitForExitConnection, getProfiles } from "../api";
import { IpHealthInfo } from "../types";
import { delayedExitCheck } from "../utils/delayedExitCheck";
import { logInfo, logError } from "../api/logs";

interface GlobalExitIpState {
  data: IpHealthInfo | null;
  loading: boolean;
  error: string | null;
  phase: string;
  proxyPort?: number;
  corePid?: number;
}

// 模块级单例缓存：页面 Tab 切换不会销毁此状态
let globalState: GlobalExitIpState = {
  data: null,
  loading: false,
  error: null,
  phase: "等待核心启动",
};

let lastCheckedKey: string | null = null;
let currentGeneration = 0;
let routeChanged = false;

const listeners = new Set<(state: GlobalExitIpState) => void>();

function notifyListeners() {
  const snapshot = { ...globalState };
  for (const listener of listeners) {
    listener(snapshot);
  }
}

async function runDetection(proxyPort?: number, corePid?: number, force = false) {
  if (!proxyPort) {
    globalState = {
      ...globalState,
      loading: false,
      error: null,
      phase: "等待核心启动",
      proxyPort,
      corePid,
    };
    notifyListeners();
    return;
  }

  // 检查是否有可用节点订阅，无订阅时直接进入待机状态，绝不发起网络请求
  try {
    const profiles = await getProfiles();
    const hasAnyProfile = Array.isArray(profiles) && profiles.length > 0;
    const hasActiveProfile = hasAnyProfile && profiles.some((p) => p.isSelected && (p.nodeCount ?? 0) > 0);
    if (!hasAnyProfile || !hasActiveProfile) {
      globalState = {
        ...globalState,
        loading: false,
        error: null,
        phase: !hasAnyProfile ? "待机中：尚未添加订阅" : "待机中：所选订阅无可用节点",
        data: null,
        proxyPort,
        corePid,
      };
      notifyListeners();
      logInfo("IP健康", `待机状态: ${!hasAnyProfile ? "尚未添加订阅配置" : "当前所选订阅无可用出站节点"}，暂停出口检测`);
      return;
    }
  } catch {}

  const currentKey = `${corePid ?? 0}:${proxyPort}`;

  // 非强制刷新时：若节点未变更且已有缓存数据且核心未变化，直接复用，绝不重复探测
  if (!force && !routeChanged && globalState.data && lastCheckedKey === currentKey) {
    return;
  }

  // 避免并发重复发起探测
  if (globalState.loading && !force && !routeChanged) {
    return;
  }

  const thisGen = ++currentGeneration;
  const isRouteChange = routeChanged;
  routeChanged = false;

  globalState = {
    ...globalState,
    loading: true,
    error: null,
    phase: "等待节点连接",
    proxyPort,
    corePid,
  };
  notifyListeners();

  const triggerReason = force
    ? "用户手动刷新"
    : isRouteChange
    ? "检测到节点/路由切换"
    : "初始化链路探测";

  logInfo("IP健康", `开始检测出口 IP 健康画像 (${triggerReason} | 代理端口: ${proxyPort})`);
  const probeStartTime = performance.now();

  const active = () => thisGen === currentGeneration;

  try {
    const result = await delayedExitCheck(
      async () => {
        logInfo("IP健康", "正在验证出口网络连通性 (Cloudflare 204)...");
        await waitForExitConnection(proxyPort);
      },
      async (ms) => {
        if (active()) {
          globalState = { ...globalState, phase: "连接已就绪，等待 3 秒" };
          notifyListeners();
          logInfo("IP健康", "出口连通性验证通过，等待链路缓冲区稳定 (3 秒)...");
        }
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
      () => {
        if (active()) {
          globalState = { ...globalState, phase: "正在检测出口 IP" };
          notifyListeners();
          logInfo("IP健康", "正在向权威数据库请求出口 IP 画像与风控指标...");
        }
        return fetchIpHealth(proxyPort);
      },
      active
    );

    if (result && active()) {
      lastCheckedKey = currentKey;
      globalState = {
        ...globalState,
        data: result,
        loading: false,
        error: null,
        phase: "",
      };
      notifyListeners();

      const costMs = Math.round(performance.now() - probeStartTime);
      const riskScoreStr =
        result.fraudScore !== undefined
          ? `${result.fraudScore}分 (${
              result.fraudScore <= 25
                ? "极佳 · 低风险"
                : result.fraudScore <= 60
                ? "良好 · 常见机房"
                : "风险较高 · 滥用疑虑"
            })`
          : "无评分";
      const resiStr =
        result.isResidential === true
          ? "原生住宅宽带"
          : result.isResidential === false
          ? "机房数据中心"
          : "未知属性";
      const broadStr =
        result.isBroadcast === true
          ? " [广播宣告]"
          : result.isBroadcast === false
          ? " [原生分配]"
          : "";

      logInfo(
        "IP健康",
        `出口 IP 画像解析就绪 [${costMs}ms]: ${result.ip} (${
          result.country || "未知国家"
        }${result.city ? " · " + result.city : ""}) | 运营商: ${
          result.asOrganization || result.asn || "未知"
        } | 欺诈风控: ${riskScoreStr} | 类型: ${resiStr}${broadStr} | 数据源: ${
          result.source || "IPpure"
        }`
      );
    }
  } catch (cause) {
    if (active()) {
      globalState = {
        ...globalState,
        loading: false,
        error: String(cause),
        phase: "",
      };
      notifyListeners();
      logError("IP健康", `出口 IP 健康检测异常: ${String(cause)}`);
    }
  }
}

// 全局监听节点切换与路由变更：只有切实切换了节点时才自动触发重新探测
if (typeof window !== "undefined") {
  window.addEventListener("netbox-route-changed", () => {
    routeChanged = true;
    if (globalState.proxyPort) {
      void runDetection(globalState.proxyPort, globalState.corePid, true);
    }
  });
}

export function useExitIpHealth(proxyPort?: number, corePid?: number) {
  const [state, setState] = useState<GlobalExitIpState>(() => ({
    ...globalState,
    proxyPort,
    corePid,
  }));

  useEffect(() => {
    globalState.proxyPort = proxyPort;
    globalState.corePid = corePid;

    const listener = (newState: GlobalExitIpState) => {
      setState(newState);
    };
    listeners.add(listener);

    const currentKey = `${corePid ?? 0}:${proxyPort ?? 0}`;
    const needInit =
      Boolean(proxyPort) &&
      (routeChanged || !globalState.data || lastCheckedKey !== currentKey);

    if (needInit && !globalState.loading) {
      void runDetection(proxyPort, corePid, false);
    } else {
      // 保持与当前全局缓存一致（切换 Tab 返回时瞬间恢复渲染，绝不重新探测）
      setState({ ...globalState, proxyPort, corePid });
    }

    const onProfileChanged = () => {
      routeChanged = true;
      void runDetection(proxyPort, corePid, true);
    };
    window.addEventListener("procweaver-profile-changed", onProfileChanged);
    window.addEventListener("netbox-profile-changed", onProfileChanged);

    return () => {
      listeners.delete(listener);
      window.removeEventListener("procweaver-profile-changed", onProfileChanged);
      window.removeEventListener("netbox-profile-changed", onProfileChanged);
    };
  }, [proxyPort, corePid]);

  const loadData = useCallback(() => {
    void runDetection(proxyPort, corePid, true);
  }, [proxyPort, corePid]);

  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    phase: state.phase,
    loadData,
  };
}
