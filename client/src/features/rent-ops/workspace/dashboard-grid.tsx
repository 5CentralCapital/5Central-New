// The customizable widget grid: square cells, fixed widget sizes, drag to
// move, drag the corner to snap between sizes, a library by category, and
// saved layouts per user. Controls live in one small corner button and the
// right-click menu so the dashboard itself stays quiet.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { ArrowUpRight, Check, ChevronRight, LayoutGrid, Minus, X } from "lucide-react";
import { COLUMNS, GAP, PHONE_COLUMNS, SIZES, SIZE_NAMES, compact, firstFit, fromPreset, gridHeight, nearestSize, parseSavedLayout, phoneLayout, pixelRect, resolve, showCompanyPanelsInAttention, sizeOf, type LayoutItem, type PresetEntry, type WidgetSize } from "./dashboard-grid-model";
import { WIDGETS, WIDGET_CATEGORIES, widgetById, type DashboardData, type WidgetCategory, type WidgetDefinition, type WidgetMetrics } from "./dashboard-widgets";
import { DASHBOARD_PRESETS } from "./dashboard-presets";
import "./dashboard-grid.css";

const DEFAULT_PRESET = "Command";
const HEADER = 44, PAD_X = 36, PAD_Y = 26;

const storageKey = (identity: string) => `rent-ops-dashboard-layout:${identity || "anonymous"}`;
const known = (id: string) => !!widgetById(id);
function presetLayout(name: string): LayoutItem[] {
  const entries = DASHBOARD_PRESETS[name];
  if (entries) return fromPreset(entries, known);
  const layout: LayoutItem[] = [];
  for (const widget of WIDGETS) { const [w, h] = SIZES[widget.defaultSize]; const at = firstFit(w, h, layout); layout.push({ id: widget.id, x: at.x, y: at.y, w, h }); }
  compact(layout);
  return layout;
}

function useContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    let frame = 0;
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setWidth(element.clientWidth)); });
    observer.observe(element);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, []);
  return [ref, width] as const;
}

export function DashboardGrid({ data }: { data: DashboardData }) {
  const identity = data.identity;
  const [state, setState] = useState<{ preset: string; layout: LayoutItem[] }>(() => {
    try { const saved = parseSavedLayout(localStorage.getItem(storageKey(identity)), known); if (saved) return { preset: saved.preset, layout: saved.layout }; } catch { /* storage unavailable */ }
    return { preset: DEFAULT_PRESET, layout: presetLayout(DEFAULT_PRESET) };
  });
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState<WidgetCategory>("rent");
  const [query, setQuery] = useState("");
  const [gridRef, width] = useContainerWidth<HTMLDivElement>();
  const [drag, setDrag] = useState<{ id: string; rect: { left: number; top: number; width: number; height: number }; ghost: LayoutItem } | null>(null);
  const layoutRef = useRef(state.layout);
  layoutRef.current = state.layout;

  const columns = width > 0 && width < 720 ? PHONE_COLUMNS : COLUMNS;
  const phone = columns === PHONE_COLUMNS;
  const cell = width > 0 ? (width - GAP * (columns - 1)) / columns : 100;
  const rowHeight = phone ? cell * 1.3 : cell;
  const view = useMemo(() => phone ? phoneLayout(state.layout) : state.layout, [phone, state.layout]);

  const persist = useCallback((next: { preset: string; layout: LayoutItem[] }) => {
    setState(next);
    try { localStorage.setItem(storageKey(identity), JSON.stringify({ version: 1, preset: next.preset, layout: next.layout })); } catch { /* storage unavailable */ }
  }, [identity]);
  const applyPreset = (name: string) => { persist({ preset: name, layout: presetLayout(name) }); };
  const addWidget = (id: string, size?: WidgetSize) => {
    const widget = widgetById(id);
    if (!widget || state.layout.some(item => item.id === id)) return;
    const [w, h] = SIZES[size ?? widget.defaultSize];
    const at = firstFit(w, h, state.layout);
    const layout = [...state.layout.map(item => ({ ...item })), { id, x: at.x, y: at.y, w, h }];
    compact(layout);
    persist({ preset: "Custom", layout });
  };
  const removeWidget = (id: string) => { const layout = state.layout.filter(item => item.id !== id).map(item => ({ ...item })); compact(layout); persist({ preset: "Custom", layout }); };
  const setSize = (id: string, size: WidgetSize) => {
    const layout = state.layout.map(item => ({ ...item }));
    const item = layout.find(entry => entry.id === id);
    if (!item) return;
    const [w, h] = SIZES[size];
    item.w = w; item.h = h; if (item.x + w > COLUMNS) item.x = COLUMNS - w;
    resolve(item, layout); compact(layout, item); compact(layout);
    persist({ preset: "Custom", layout });
  };

  // Drag to move and drag to resize share one pointer routine working on a
  // scratch copy of the layout; the copy is committed on release.
  const startPointer = (event: ReactPointerEvent<HTMLElement>, id: string, mode: "move" | "resize") => {
    if (!editing || phone || event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const scratch = layoutRef.current.map(item => ({ ...item }));
    const item = scratch.find(entry => entry.id === id)!;
    const widget = widgetById(id)!;
    const origin = { x: event.clientX, y: event.clientY, item: { ...item } };
    const base = pixelRect(origin.item, cell, rowHeight);
    setDrag({ id, rect: base, ghost: { ...item } });
    const move = (pointer: PointerEvent) => {
      const dx = pointer.clientX - origin.x, dy = pointer.clientY - origin.y;
      if (mode === "move") {
        const nx = Math.max(0, Math.min(COLUMNS - item.w, Math.round((base.left + dx) / (cell + GAP))));
        const ny = Math.max(0, Math.round((base.top + dy) / (rowHeight + GAP)));
        if (nx !== item.x || ny !== item.y) { item.x = nx; item.y = ny; resolve(item, scratch); compact(scratch, item); }
        setDrag({ id, rect: { ...base, left: base.left + dx, top: base.top + dy }, ghost: { ...item } });
      } else {
        const widthPx = base.width + dx, heightPx = base.height + dy;
        const size = nearestSize(widget.sizes, (widthPx + GAP) / (cell + GAP), (heightPx + GAP) / (rowHeight + GAP));
        const [w, h] = SIZES[size];
        if (w !== item.w || h !== item.h) { item.w = w; item.h = h; if (item.x + w > COLUMNS) item.x = COLUMNS - w; resolve(item, scratch); compact(scratch, item); }
        setDrag({ id, rect: { ...base, width: Math.max(cell, widthPx), height: Math.max(rowHeight, heightPx) }, ghost: { ...item } });
      }
      setState(current => ({ ...current, layout: scratch.map(entry => ({ ...entry })) }));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      compact(scratch);
      setDrag(null);
      persist({ preset: "Custom", layout: scratch.map(entry => ({ ...entry })) });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  useEffect(() => { if (!editing) setQuery(""); }, [editing]);
  const placed = new Set(state.layout.map(item => item.id));
  const companyWidgetPlaced = !showCompanyPanelsInAttention(state.layout);
  const library = WIDGETS.filter(widget => query.trim() ? `${widget.name} ${widget.description}`.toLowerCase().includes(query.trim().toLowerCase()) : widget.category === category);
  const height = gridHeight(view, rowHeight);

  return <div className={`ops-dashboard${editing ? " is-editing" : ""}${phone ? " is-phone" : ""}`}>
    <div className="ops-dashboard-head">
      <span className="ops-dashboard-sub">{state.layout.length} widgets · {state.preset === "Custom" ? "custom layout" : `${state.preset} layout`}</span>
      {editing ? <button type="button" className="rm-button ops-dashboard-done" onClick={() => setEditing(false)}>Done</button>
        : <Dropdown.Root modal={false}>
          <Dropdown.Trigger className="ops-dashboard-gear" aria-label="Dashboard options" title="Customize dashboard"><LayoutGrid size={15} aria-hidden="true" /></Dropdown.Trigger>
          <Dropdown.Portal><Dropdown.Content className="rops-nav-menu ops-dashboard-menu" align="end" sideOffset={6} collisionPadding={12} loop>
            <Dropdown.Item className="rops-menu-item" onSelect={() => setEditing(true)}>Customize…</Dropdown.Item>
            <Dropdown.Separator className="rops-menu-separator" />
            <Dropdown.Label className="rops-menu-label">Layout</Dropdown.Label>
            <Dropdown.RadioGroup value={state.preset} onValueChange={applyPreset}>
              {Object.keys(DASHBOARD_PRESETS).map(name => <Dropdown.RadioItem key={name} className="rops-menu-item" value={name}>{name}<Dropdown.ItemIndicator><Check size={15} aria-hidden="true" /></Dropdown.ItemIndicator></Dropdown.RadioItem>)}
            </Dropdown.RadioGroup>
            <Dropdown.Separator className="rops-menu-separator" />
            <Dropdown.Item className="rops-menu-item" onSelect={() => applyPreset(state.preset === "Custom" ? DEFAULT_PRESET : state.preset)}>Reset layout</Dropdown.Item>
          </Dropdown.Content></Dropdown.Portal>
        </Dropdown.Root>}
    </div>
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>
        <div ref={gridRef} className="ops-grid" style={{ height: height ? `${height}px` : undefined }} aria-label="Dashboard widgets">
          {width > 0 && view.map(item => {
            const widget = widgetById(item.id);
            if (!widget) return null;
            const rect = drag?.id === item.id ? drag.rect : pixelRect(item, cell, rowHeight);
            const metrics: WidgetMetrics = { size: sizeOf(item.w, item.h), w: item.w, h: item.h, bodyWidth: rect.width - PAD_X, bodyHeight: rect.height - PAD_Y - (widget.bare ? 0 : HEADER) };
            return <Widget key={item.id} widget={widget} data={data} companyWidgetPlaced={companyWidgetPlaced} metrics={metrics} rect={rect} editing={editing && !phone} dragging={drag?.id === item.id}
              onMove={event => startPointer(event, item.id, "move")} onResize={event => startPointer(event, item.id, "resize")} onRemove={() => removeWidget(item.id)} onSize={size => setSize(item.id, size)} onCustomize={() => setEditing(true)} />;
          })}
          {drag && <div className="ops-grid-ghost" style={pixelStyle(pixelRect(drag.ghost, cell, rowHeight))}><span>{SIZE_NAMES[sizeOf(drag.ghost.w, drag.ghost.h)]}</span></div>}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal><ContextMenu.Content className="rops-nav-menu ops-dashboard-menu" collisionPadding={12} loop>
        <ContextMenu.Item className="rops-menu-item" onSelect={() => setEditing(current => !current)}>{editing ? "Done customizing" : "Customize…"}</ContextMenu.Item>
        <ContextMenu.Separator className="rops-menu-separator" />
        <ContextMenu.Label className="rops-menu-label">Layout</ContextMenu.Label>
        <ContextMenu.RadioGroup value={state.preset} onValueChange={applyPreset}>
          {Object.keys(DASHBOARD_PRESETS).map(name => <ContextMenu.RadioItem key={name} className="rops-menu-item" value={name}>{name}<ContextMenu.ItemIndicator><Check size={15} aria-hidden="true" /></ContextMenu.ItemIndicator></ContextMenu.RadioItem>)}
        </ContextMenu.RadioGroup>
        <ContextMenu.Separator className="rops-menu-separator" />
        <ContextMenu.Item className="rops-menu-item" onSelect={() => applyPreset(state.preset === "Custom" ? DEFAULT_PRESET : state.preset)}>Reset layout</ContextMenu.Item>
      </ContextMenu.Content></ContextMenu.Portal>
    </ContextMenu.Root>
    {editing && <aside className="ops-library" aria-label="Widget library">
      <header className="ops-library-head">
        <div><h2>Widgets</h2><button type="button" className="ops-library-close" aria-label="Close widget library" onClick={() => setEditing(false)}><X size={16} aria-hidden="true" /></button></div>
        <p>Pick a size to add. Drag a title to move, the corner to resize, − to remove. Right-click a widget for its sizes.</p>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search widgets" aria-label="Search widgets" autoComplete="off" />
      </header>
      <div className="ops-library-tabs" role="tablist">
        {(Object.keys(WIDGET_CATEGORIES) as WidgetCategory[]).map(key => <button key={key} type="button" role="tab" aria-selected={key === category && !query.trim()} onClick={() => { setCategory(key); setQuery(""); }}>{WIDGET_CATEGORIES[key]}<small>{WIDGETS.filter(widget => widget.category === key && placed.has(widget.id)).length}/{WIDGETS.filter(widget => widget.category === key).length}</small></button>)}
      </div>
      <ul className="ops-library-list">
        {library.length ? library.map(widget => {
          const current = state.layout.find(item => item.id === widget.id);
          const currentSize = current ? sizeOf(current.w, current.h) : undefined;
          return <li key={widget.id} className={current ? "is-placed" : ""}>
            <span className="ops-library-text"><strong>{widget.name}</strong><small>{widget.description}</small></span>
            <span className="ops-library-sizes">
              {widget.sizes.map(size => <button key={size} type="button" className={size === currentSize ? "is-current" : ""} title={`${SIZE_NAMES[size]} · ${SIZES[size][0]}×${SIZES[size][1]}`} aria-label={`${current ? "Resize" : "Add"} ${widget.name}, ${SIZE_NAMES[size]}`} onClick={() => current ? setSize(widget.id, size) : addWidget(widget.id, size)}><i className={`ops-size-icon is-${size}`} aria-hidden="true" /></button>)}
              {current && <button type="button" className="ops-library-remove" aria-label={`Remove ${widget.name}`} title="Remove" onClick={() => removeWidget(widget.id)}><Minus size={14} aria-hidden="true" /></button>}
            </span>
          </li>;
        }) : <li className="ops-library-empty">No widgets match.</li>}
      </ul>
    </aside>}
  </div>;
}

const pixelStyle = (rect: { left: number; top: number; width: number; height: number }): CSSProperties => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });

function Widget({ widget, data, companyWidgetPlaced, metrics, rect, editing, dragging, onMove, onResize, onRemove, onSize, onCustomize }: {
  widget: WidgetDefinition; data: DashboardData; metrics: WidgetMetrics; rect: { left: number; top: number; width: number; height: number };
  companyWidgetPlaced: boolean;
  editing: boolean; dragging: boolean; onMove: (event: ReactPointerEvent<HTMLElement>) => void; onResize: (event: ReactPointerEvent<HTMLElement>) => void; onRemove: () => void; onSize: (size: WidgetSize) => void; onCustomize: () => void;
}) {
  const widgetData = widget.id === "attention" && companyWidgetPlaced ? { ...data, companyPanels: undefined } : data;
  const open = widget.open?.(widgetData);
  const body: ReactNode = widget.render({ data: widgetData, metrics });
  return <ContextMenu.Root modal={false}>
    <ContextMenu.Trigger asChild>
      <section className={`ops-widget rmd-panel${widget.bare ? " is-bare" : ""}${widget.scrolls ? " is-scrolling" : ""}${dragging ? " is-dragging" : ""}`} data-widget={widget.id} data-size={metrics.size} aria-label={widget.name} style={pixelStyle(rect)}>
        {!widget.bare && <header className="rmd-panel-header ops-widget-head" onPointerDown={onMove}><h2>{widget.name}</h2>{open && !editing && <button type="button" onClick={open} title={`Open ${widget.name}`} aria-label={`Open ${widget.name}`}><ArrowUpRight size={13} /></button>}</header>}
        {widget.bare && editing && <div className="ops-widget-grab" onPointerDown={onMove} aria-hidden="true">{widget.name}</div>}
        <div className="ops-widget-body">{body}</div>
        {editing && <><button type="button" className="ops-widget-remove" aria-label={`Remove ${widget.name}`} onClick={onRemove}><Minus size={14} aria-hidden="true" /></button><i className="ops-widget-resize" title="Resize" onPointerDown={onResize} /></>}
      </section>
    </ContextMenu.Trigger>
    <ContextMenu.Portal><ContextMenu.Content className="rops-nav-menu ops-dashboard-menu" collisionPadding={12} loop>
      <ContextMenu.Label className="rops-menu-label">{widget.name}</ContextMenu.Label>
      <ContextMenu.RadioGroup value={metrics.size} onValueChange={value => onSize(value as WidgetSize)}>
        {widget.sizes.map(size => <ContextMenu.RadioItem key={size} className="rops-menu-item" value={size}>{SIZE_NAMES[size]}<small className="ops-menu-dim">{SIZES[size][0]}×{SIZES[size][1]}</small><ContextMenu.ItemIndicator><Check size={15} aria-hidden="true" /></ContextMenu.ItemIndicator></ContextMenu.RadioItem>)}
      </ContextMenu.RadioGroup>
      {open && <><ContextMenu.Separator className="rops-menu-separator" /><ContextMenu.Item className="rops-menu-item" onSelect={open}>Open {widget.name}<ChevronRight size={14} aria-hidden="true" /></ContextMenu.Item></>}
      <ContextMenu.Separator className="rops-menu-separator" />
      <ContextMenu.Item className="rops-menu-item is-danger" onSelect={onRemove}>Remove</ContextMenu.Item>
      <ContextMenu.Item className="rops-menu-item" onSelect={onCustomize}>Customize…</ContextMenu.Item>
    </ContextMenu.Content></ContextMenu.Portal>
  </ContextMenu.Root>;
}
