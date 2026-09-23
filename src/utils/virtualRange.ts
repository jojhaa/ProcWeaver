export function virtualRange(count: number, rowHeight: number, height: number, scrollTop: number, overscan = 6) {
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, count * rowHeight - height));
  const start = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((top + height) / rowHeight) + overscan);
  return { start, end, top: start * rowHeight, bottom: (count - end) * rowHeight };
}

// Unlike a standalone list, a region outside the parent viewport must draw zero rows.
export function gridRange(count: number, columns: number, rowHeight: number, height: number, relativeTop: number) {
  const rows = Math.ceil(count / columns);
  const first = Math.max(0, Math.min(rows, Math.floor(relativeTop / rowHeight) - 2));
  const last = Math.max(first, Math.min(rows, Math.ceil((relativeTop + height) / rowHeight) + 2));
  return { start: Math.min(count, first * columns), end: Math.min(count, last * columns), height: rows * rowHeight };
}
