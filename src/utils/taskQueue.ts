export const DEFAULT_CONCURRENCY = 32;

export function getStoredConcurrency(): number {
  try {
    const saved = localStorage.getItem("netbox_speed_test_concurrency");
    if (saved) {
      const val = parseInt(saved, 10);
      if (Number.isInteger(val) && val >= 1 && val <= 64) {
        return val;
      }
    }
  } catch {}
  return DEFAULT_CONCURRENCY;
}

export function setStoredConcurrency(limit: number): void {
  try {
    if (Number.isInteger(limit) && limit >= 1 && limit <= 64) {
      localStorage.setItem("netbox_speed_test_concurrency", limit.toString());
      if (concurrencyController) {
        concurrencyController.setLimit(limit);
      }
    }
  } catch {}
}

/** 跨页面共享的 FIFO 队列；失败同样释放名额，支持动态调整并发上限。 */
export function createTaskQueue(initialLimit = getStoredConcurrency()) {
  let currentLimit = Number.isInteger(initialLimit) && initialLimit >= 1 ? initialLimit : DEFAULT_CONCURRENCY;
  let active = 0;
  const waiting: Array<() => void> = [];
  const drain = () => {
    while (active < currentLimit && waiting.length) {
      active++;
      waiting.shift()!();
    }
  };

  const queue = (<T>(task: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    waiting.push(() => {
      Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; drain(); });
    });
    drain();
  })) as (<T>(task: () => Promise<T>) => Promise<T>) & {
    setLimit: (newLimit: number) => void;
    getLimit: () => number;
  };

  queue.setLimit = (newLimit: number) => {
    if (Number.isInteger(newLimit) && newLimit >= 1) {
      currentLimit = newLimit;
      drain();
    }
  };

  queue.getLimit = () => currentLimit;

  return queue;
}

export const enqueueProbe = createTaskQueue();
let concurrencyController = enqueueProbe;

export const DEFAULT_HEALTH_PROBE_CONCURRENCY = 4;

export function getStoredHealthProbeConcurrency(): number {
  try {
    const saved = localStorage.getItem("netbox_health_probe_concurrency");
    if (saved) {
      const val = parseInt(saved, 10);
      if (Number.isInteger(val) && val >= 1 && val <= 32) {
        return val;
      }
    }
  } catch {}
  return DEFAULT_HEALTH_PROBE_CONCURRENCY;
}

export function setStoredHealthProbeConcurrency(limit: number): void {
  try {
    if (Number.isInteger(limit) && limit >= 1 && limit <= 32) {
      localStorage.setItem("netbox_health_probe_concurrency", limit.toString());
    }
  } catch {}
}

// 监听常规设置保存事件，自动保持并发设置同步
if (typeof window !== "undefined") {
  window.addEventListener("netbox-settings-saved", () => {
    import("../api/settings").then(({ getGeneralSettings }) => {
      getGeneralSettings()
        .then((s) => {
          if (s.speedTestConcurrency) {
            setStoredConcurrency(s.speedTestConcurrency);
          }
          if (s.healthProbeConcurrency) {
            setStoredHealthProbeConcurrency(s.healthProbeConcurrency);
          }
        })
        .catch(() => {});
    });
  });
}
