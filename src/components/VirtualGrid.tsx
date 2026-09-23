import React, { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import { gridRange } from "../utils/virtualRange";

const Viewport = createContext({ element: null as HTMLDivElement | null, top: 0, height: 800, width: 1200 });

/** One scroll owner for headings, smart rules, all regions and the ignored section. */
export function VirtualGridScroller({ children, className, resetKey }: { children: React.ReactNode; className: string; resetKey?: string }) {
  const element = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const [viewport, setViewport] = useState({ element: null as HTMLDivElement | null, top: 0, height: 800, width: 1200 });
  const update = () => {
    const el = element.current;
    if (el) setViewport({ element: el, top: el.scrollTop, height: el.clientHeight, width: window.innerWidth });
  };
  useLayoutEffect(() => {
    const observer = new ResizeObserver(update);
    observer.observe(element.current!); update();
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); cancelAnimationFrame(frame.current); };
  }, []);
  useLayoutEffect(() => { if (element.current) { element.current.scrollTop = 0; update(); } }, [resetKey]);
  return <div ref={element} className={className} data-node-scroll
    onScroll={() => { cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(update); }}>
    <Viewport.Provider value={viewport}>{children}</Viewport.Provider>
  </div>;
}

export function VirtualGrid<T>({ items, itemKey, renderItem, label }: {
  items: T[]; itemKey: (item: T) => string; renderItem: (item: T) => React.ReactNode; label: string;
}) {
  const viewport = useContext(Viewport);
  const container = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [focused, setFocused] = useState<string | null>(null);
  const columns = viewport.width >= 1280 ? 4 : viewport.width >= 1024 ? 3 : viewport.width >= 768 ? 2 : 1;
  const rowHeight = 112;
  useLayoutEffect(() => {
    if (container.current && viewport.element) {
      setOffset(container.current.getBoundingClientRect().top - viewport.element.getBoundingClientRect().top + viewport.element.scrollTop);
    }
  });
  const range = gridRange(items.length, columns, rowHeight, viewport.height, viewport.top - offset);
  const indexes = Array.from({ length: range.end - range.start }, (_, index) => range.start + index);
  const focusedIndex = focused === null ? -1 : items.findIndex(item => itemKey(item) === focused);
  if (focusedIndex >= 0 && !indexes.includes(focusedIndex)) indexes.push(focusedIndex);
  indexes.sort((a, b) => a - b);
  return <div ref={container} role="list" aria-label={label} className="relative" style={{ height: range.height }}>
    {indexes.map(index => <div role="listitem" key={itemKey(items[index])} aria-posinset={index + 1} aria-setsize={items.length}
      className="absolute" style={{ top: Math.floor(index / columns) * rowHeight, left: `calc(${index % columns} * ((100% + 10px) / ${columns}))`, width: `calc((100% - ${(columns - 1) * 10}px) / ${columns})`, height: rowHeight - 10 }}
      onFocus={() => setFocused(itemKey(items[index]))}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null); }}>
      {renderItem(items[index])}
    </div>)}
  </div>;
}
