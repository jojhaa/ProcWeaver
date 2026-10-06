const textInputTypes = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

function handleContextMenu(event: MouseEvent): void {
  // 业务组件已经处理的菜单继续使用组件自身的行为。
  if (event.defaultPrevented) return;

  const target = event.target;
  if (target instanceof HTMLInputElement && textInputTypes.has(target.type) && !target.matches(":disabled")) return;
  if (target instanceof HTMLTextAreaElement && !target.matches(":disabled")) return;
  if (target instanceof HTMLElement && target.isContentEditable) return;

  // 仅阻止浏览器默认菜单，不停止事件传播或拦截编辑快捷键。
  event.preventDefault();
}

export function configureDesktopContextMenu(isDesktop: boolean): void {
  // 启动重试时复用同一个监听器；Android 保留原生长按菜单。
  document.removeEventListener("contextmenu", handleContextMenu);
  if (isDesktop) document.addEventListener("contextmenu", handleContextMenu);
}
