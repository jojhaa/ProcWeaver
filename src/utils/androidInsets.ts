import { androidSystemApi, type AndroidWindowInsets } from "../api/android";

// Each WebView document requests its own snapshot, including after config restore/reload.
export function syncAndroidInsets() {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  const apply = (insets: AndroidWindowInsets) => {
    if (!active) return;
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const value = insets[side];
      if (Number.isFinite(value) && value >= 0) document.documentElement.style.setProperty(`--mobile-inset-${side}`, `${value}px`);
    }
  };
  const refresh = async (attempt = 0) => {
    const current = ++revision;
    try {
      const insets = await androidSystemApi.windowInsets();
      if (current === revision) apply(insets);
    } catch {
      if (active && current === revision && attempt < 3) timer = setTimeout(() => void refresh(attempt + 1), 250);
    }
  };
  const changed = (event: Event) => { revision++; apply((event as CustomEvent<AndroidWindowInsets>).detail); };
  const visible = () => { if (!document.hidden) void refresh(); };
  const resize = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 100); };
  window.addEventListener("procweaver-window-insets", changed);
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", visible);
  void refresh();
  return () => {
    active = false; clearTimeout(timer);
    window.removeEventListener("procweaver-window-insets", changed);
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", visible);
  };
}
