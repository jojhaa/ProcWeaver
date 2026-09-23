import React, { useLayoutEffect, useRef, useState } from "react";
import { virtualRange } from "../utils/virtualRange";

interface Props<T> {
  items: T[];
  itemKey: (item: T) => string;
  renderRow: (item: T) => React.ReactNode;
  rowHeight: number;
  narrowRowHeight?: number;
  className?: string;
  followEnd?: boolean;
  preserveAnchor?: boolean;
  onLeaveEnd?: () => void;
  label: string;
}

export function VirtualList<T>({ items, itemKey, renderRow, rowHeight, narrowRowHeight, className = "h-[540px]", followEnd, preserveAnchor, onLeaveEnd, label }: Props<T>) {
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const [viewport, setViewport] = useState({ top: 0, height: 540, width: 900 });
  const height = viewport.width < 768 ? narrowRowHeight ?? rowHeight : rowHeight;
  const previous = useRef({ items, height, top: 0 });
  useLayoutEffect(() => {
    const element = container.current!;
    const resize = new ResizeObserver(() => setViewport(old => ({ ...old, height: element.clientHeight, width: element.clientWidth })));
    resize.observe(element);
    return () => { resize.disconnect(); cancelAnimationFrame(frame.current); };
  }, []);
  useLayoutEffect(() => {
    const element = container.current!;
    if (followEnd) element.scrollTop = Math.max(0, items.length * height - element.clientHeight);
    else if (preserveAnchor && previous.current.items !== items) {
      const old = previous.current;
      const anchor = old.items[Math.floor(old.top / old.height)];
      const nextIndex = anchor ? items.findIndex(item => itemKey(item) === itemKey(anchor)) : -1;
      element.scrollTop = nextIndex < 0 ? 0 : nextIndex * height + old.top % old.height;
    }
    previous.current = { items, height, top: element.scrollTop };
    setViewport(old => old.top === element.scrollTop ? old : { ...old, top: element.scrollTop });
  }, [items, followEnd, height, preserveAnchor, viewport.height, viewport.width]);
  const range = virtualRange(items.length, height, viewport.height, viewport.top);
  return <div ref={container} role="list" aria-label={label} tabIndex={0}
    style={{ overflowAnchor: "none" }}
    className={`overflow-y-auto min-h-0 ${className}`}
    onWheel={event => { if (event.deltaY < 0) onLeaveEnd?.(); }}
    onKeyDown={event => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) onLeaveEnd?.(); }}
    onScroll={event => {
      const element = event.currentTarget;
      previous.current.top = element.scrollTop;
      if (element.scrollTop + element.clientHeight < element.scrollHeight - height) onLeaveEnd?.();
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => setViewport(old => ({ ...old, top: element.scrollTop })));
    }}>
    <div style={{ height: range.top }} aria-hidden="true" />
    {items.slice(range.start, range.end).map((item, offset) => <div role="listitem" key={itemKey(item)}
      aria-posinset={range.start + offset + 1} aria-setsize={items.length}
      style={{ height, overflow: "hidden" }} className="border-b border-slate-100 dark:border-slate-800/70">
      {renderRow(item)}
    </div>)}
    <div style={{ height: range.bottom }} aria-hidden="true" />
  </div>;
}
