/** Coalesce result bursts; flush before completion/unmount so the tail is retained. */
export function createBatchUpdates<T>(commit: (items: T[]) => void, delay = 250) {
  let items: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!items.length) return;
    const batch = items; items = [];
    commit(batch);
  };
  return { add(item: T) { items.push(item); timer ??= setTimeout(flush, delay); }, flush };
}
