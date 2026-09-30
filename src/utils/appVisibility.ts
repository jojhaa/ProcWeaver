export function isAppHidden(): boolean {
  return typeof document !== "undefined" && (document.hidden ||
    (typeof window !== "undefined" && (window as Window & { __PROCWEAVER_BACKGROUND__?: boolean }).__PROCWEAVER_BACKGROUND__ === true));
}
