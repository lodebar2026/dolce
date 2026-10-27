// 试听的竖直播放线（同 Sibelius / MuseScore / Dorico）：横向罩住正在响的那个音，纵向贯穿它所在那一行谱。
// 各视图同一种，当前在哪页的 svg 里就挂在哪页。简谱两条路的纵向范围同一个口径：
// 音符所在那一行（`system` 标签，多声部是连谱号括起的整组）里各音符格、增时线格与歌词格墨迹的并集
// （不取行组本身的包围盒：组里有落在原点的空图元，弧、和弦也会把线撑得忽高忽低）。

import type { PageItem } from "../pagetree/pageitem";
import type { ScoreIndex } from "./scoreindex";

export interface Span {
  y0: number;
  y1: number;
}

export class Playhead {
  private rect: SVGRectElement | null = null;
  /** 每行谱量一次（换了排版结果——`index` 变了——就作废） */
  private spans: { index: ScoreIndex; bySystem: Map<PageItem, Span | null> } | null = null;

  /** 撤掉（换页面、换排版结果时）。 */
  reset(): void {
    this.rect = null;
    this.spans = null;
  }

  /** 横向取音 `noteEl` 的包围盒，纵向取 `span`（`noteEl` 所在 svg 的用户坐标）。缺哪样都撤掉。
   *  给了 `fixed`（`noteEl` 自己坐标系里的中心 x 与宽）就按它居中定宽：五线谱一音一宽，不随符尾、错开的头撑宽。 */
  move(noteEl?: SVGGraphicsElement, span?: Span | null, fixed?: { cx: number; w: number }): void {
    const svg = noteEl?.ownerSVGElement;
    const box = noteEl && span ? (fixed ? fixedBox(noteEl, fixed.cx, fixed.w) : svgBox(noteEl)) : null;
    if (!noteEl || !svg || !span || !box) {
      this.rect?.remove();
      return;
    }
    const pad = 4;
    // 定宽的横向不再加边（宽度已含），竖向照旧伸出谱表带
    const x0 = fixed ? box.x0 : box.x0 - pad;
    const x1 = fixed ? box.x1 : box.x1 + pad;
    const y0 = span.y0 - pad * 2;
    const y1 = span.y1 + pad * 2;
    let rect = this.rect;
    if (!rect) {
      rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("class", "playhead");
      rect.setAttribute("rx", "3");
      this.rect = rect;
    }
    rect.setAttribute("x", x0.toFixed(1));
    rect.setAttribute("y", y0.toFixed(1));
    rect.setAttribute("width", Math.max(8, x1 - x0).toFixed(1));
    rect.setAttribute("height", Math.max(8, y1 - y0).toFixed(1));
    if (rect.ownerSVGElement !== svg) svg.appendChild(rect);
  }

  /** 音符格 `cell` 所在那一行的竖向范围（svg 用户坐标）：行里各格墨迹的并集。不在任何行里为 null。 */
  systemSpan(index: ScoreIndex, cell: PageItem, nodeOf: (it: PageItem) => SVGGraphicsElement | undefined): Span | null {
    const sys = index.systemOf(cell);
    if (!sys) return null;
    if (this.spans?.index !== index) this.spans = { index, bySystem: new Map() };
    const cache = this.spans.bySystem;
    if (cache.has(sys.system)) return cache.get(sys.system)!;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const it of sys.members) {
      const el = nodeOf(it);
      const b = el ? svgBox(el) : null;
      if (!b || b.y1 - b.y0 <= 0) continue;
      y0 = Math.min(y0, b.y0);
      y1 = Math.max(y1, b.y1);
    }
    const span = y1 > y0 ? { y0, y1 } : null;
    cache.set(sys.system, span);
    return span;
  }
}

/** 元素包围盒换到它所在 svg 的用户坐标（`getBBox` 是元素自己的坐标系，各层平移、缩放都要算进去）。 */
export function svgBox(el: SVGGraphicsElement): { x0: number; x1: number; y0: number; y1: number } | null {
  const svgCtm = el.ownerSVGElement?.getScreenCTM();
  const ctm = el.getScreenCTM();
  if (!svgCtm || !ctm) return null;
  const m = svgCtm.inverse().multiply(ctm);
  const b = el.getBBox();
  const xs = [m.a * b.x + m.c * b.y + m.e, m.a * (b.x + b.width) + m.c * (b.y + b.height) + m.e];
  const ys = [m.b * b.x + m.d * b.y + m.f, m.b * (b.x + b.width) + m.d * (b.y + b.height) + m.f];
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** `el` 坐标系里以 `cx` 为中心、宽 `w` 的横向范围 → 它所在 svg 的用户坐标（竖向不用，给 0）。 */
function fixedBox(el: SVGGraphicsElement, cx: number, w: number): { x0: number; x1: number; y0: number; y1: number } | null {
  const svgCtm = el.ownerSVGElement?.getScreenCTM();
  const ctm = el.getScreenCTM();
  if (!svgCtm || !ctm) return null;
  const m = svgCtm.inverse().multiply(ctm);
  const xa = m.a * (cx - w / 2) + m.e;
  const xb = m.a * (cx + w / 2) + m.e;
  return { x0: Math.min(xa, xb), x1: Math.max(xa, xb), y0: 0, y1: 0 };
}

/** `el` 坐标系里的竖向范围 [top, bottom] → 它所在 svg 的用户坐标。 */
export function spanIn(el: SVGGraphicsElement, top: number, bottom: number): Span | null {
  const svgCtm = el.ownerSVGElement?.getScreenCTM();
  const ctm = el.getScreenCTM();
  if (!svgCtm || !ctm) return null;
  const m = svgCtm.inverse().multiply(ctm);
  return { y0: m.d * top + m.f, y1: m.d * bottom + m.f };
}
