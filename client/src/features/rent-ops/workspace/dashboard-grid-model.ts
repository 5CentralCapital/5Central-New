// Layout math for the widget dashboard. Pure functions so the grid can be
// tested without a DOM. Cells are square; every widget is one of a fixed set
// of sizes (like home-screen widgets), so the grid always tiles cleanly.

export type WidgetSize = "S" | "M" | "MT" | "W" | "XT" | "L" | "XL" | "FT" | "F" | "F6";
export const SIZES: Record<WidgetSize, readonly [number, number]> = {
  S: [2, 2], M: [4, 2], MT: [4, 3], W: [8, 2], XT: [8, 3], L: [4, 4], XL: [8, 4], FT: [12, 3], F: [12, 4], F6: [12, 6],
};
export const SIZE_NAMES: Record<WidgetSize, string> = {
  S: "Small", M: "Medium", MT: "Medium tall", W: "Wide", XT: "Wide tall", L: "Large", XL: "Extra large", FT: "Full width", F: "Full · tall", F6: "Full · tallest",
};
export const COLUMNS = 12;
export const PHONE_COLUMNS = 4;
export const GAP = 12;

export interface LayoutItem { id: string; x: number; y: number; w: number; h: number }
export interface PresetEntry { id: string; x: number; y: number; size: WidgetSize }

export function sizeOf(w: number, h: number): WidgetSize {
  return (Object.keys(SIZES) as WidgetSize[]).find(key => SIZES[key][0] === w && SIZES[key][1] === h) ?? "L";
}

export function collide(a: LayoutItem, b: LayoutItem): boolean {
  return a !== b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Push anything the moved item overlaps straight down, then whatever those push. */
export function resolve(moved: LayoutItem, layout: LayoutItem[]): void {
  const stack = [moved];
  let guard = 0;
  while (stack.length && guard++ < 800) {
    const item = stack.pop()!;
    for (const other of layout) {
      if (other !== item && other !== moved && collide(item, other)) { other.y = item.y + item.h; stack.push(other); }
    }
  }
}

/** Float every item as high as it can go, in reading order. */
export function compact(layout: LayoutItem[], pinned?: LayoutItem): void {
  const ordered = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const item of ordered) {
    if (item === pinned) continue;
    while (item.y > 0) {
      item.y -= 1;
      if (layout.some(other => collide(item, other))) { item.y += 1; break; }
    }
  }
}

/** First free position scanning left to right, top to bottom. */
export function firstFit(w: number, h: number, layout: LayoutItem[], columns = COLUMNS): { x: number; y: number } {
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x <= columns - w; x++) {
      const probe = { id: "", x, y, w, h };
      if (!layout.some(other => collide(probe, other))) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

/** Remove overlaps from a preset or a saved layout without changing x. */
export function settle(layout: LayoutItem[]): void {
  const placed: LayoutItem[] = [];
  for (const item of [...layout].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let guard = 0;
    while (placed.some(other => collide(item, other)) && guard++ < 400) item.y += 1;
    placed.push(item);
  }
}

/** The allowed size closest to a dragged width and height, in cells. */
export function nearestSize(allowed: readonly WidgetSize[], w: number, h: number): WidgetSize {
  let best = allowed[0];
  let bestDistance = Infinity;
  for (const key of allowed) {
    const [sw, sh] = SIZES[key];
    const distance = Math.abs(sw - w) * 1.2 + Math.abs(sh - h);
    if (distance < bestDistance) { bestDistance = distance; best = key; }
  }
  return best;
}

export function fromPreset(entries: readonly PresetEntry[], known: (id: string) => boolean): LayoutItem[] {
  const layout: LayoutItem[] = [];
  for (const entry of entries) {
    if (!known(entry.id)) continue;
    const [w, h] = SIZES[entry.size];
    layout.push({ id: entry.id, x: Math.min(entry.x, COLUMNS - w), y: entry.y, w, h });
  }
  settle(layout);
  compact(layout);
  return layout;
}

/** Phone layout: one column of widgets in reading order, small ones two-up. */
export function phoneLayout(layout: readonly LayoutItem[]): LayoutItem[] {
  const result: LayoutItem[] = [];
  for (const item of [...layout].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const w = Math.min(PHONE_COLUMNS, item.w);
    const h = item.w >= 8 && item.h <= 2 ? 2 : item.h;
    const position = firstFit(w, h, result, PHONE_COLUMNS);
    result.push({ id: item.id, x: position.x, y: position.y, w, h });
  }
  return result;
}

export function pixelRect(item: LayoutItem, cell: number, rowHeight: number, gap = GAP) {
  return {
    left: item.x * (cell + gap),
    top: item.y * (rowHeight + gap),
    width: item.w * cell + (item.w - 1) * gap,
    height: item.h * rowHeight + (item.h - 1) * gap,
  };
}

export function gridHeight(layout: readonly LayoutItem[], rowHeight: number, gap = GAP): number {
  const rows = layout.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  return rows ? rows * (rowHeight + gap) - gap : 0;
}

/** Overlapping pairs in a layout; the presets are tested to have none. */
export function overlaps(layout: readonly LayoutItem[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < layout.length; i++) for (let j = i + 1; j < layout.length; j++) if (collide(layout[i], layout[j])) pairs.push([layout[i].id, layout[j].id]);
  return pairs;
}

/** Empty cells per row above the last row; the presets are tested to have none. */
export function emptyCells(layout: readonly LayoutItem[], columns = COLUMNS): number {
  const rows = layout.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  const filled = new Set<string>();
  for (const item of layout) for (let y = item.y; y < item.y + item.h; y++) for (let x = item.x; x < item.x + item.w; x++) filled.add(`${x}:${y}`);
  let empty = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) if (!filled.has(`${x}:${y}`)) empty += 1;
  return empty;
}

export interface SavedLayout { version: 1; preset: string; layout: LayoutItem[] }
export function parseSavedLayout(raw: string | null, known: (id: string) => boolean): SavedLayout | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<SavedLayout>;
    if (value?.version !== 1 || !Array.isArray(value.layout)) return undefined;
    const layout = value.layout.filter((item): item is LayoutItem => !!item && typeof item.id === "string" && known(item.id)
      && [item.x, item.y, item.w, item.h].every(n => Number.isInteger(n) && n >= 0) && item.x + item.w <= COLUMNS && item.w > 0 && item.h > 0)
      .map(item => ({ ...item }));
    if (!layout.length) return undefined;
    settle(layout);
    compact(layout);
    return { version: 1, preset: typeof value.preset === "string" ? value.preset : "Custom", layout };
  } catch { return undefined; }
}
