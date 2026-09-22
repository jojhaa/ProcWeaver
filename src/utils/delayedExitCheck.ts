export async function delayedExitCheck<T>(ready: () => Promise<void>, wait: (ms: number) => Promise<void>, detect: () => Promise<T>, active: () => boolean): Promise<T | undefined> {
  await ready();
  if (!active()) return;
  await wait(3000);
  if (!active()) return;
  const result = await detect();
  return active() ? result : undefined;
}
