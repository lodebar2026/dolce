// 试听的竖直播放线（同 Sibelius / MuseScore / Dorico）：横向罩住正在响的那个音，纵向贯穿它所在那一行谱。
// 各视图同一种，当前在哪页的 svg 里就挂在哪页。简谱两条路的纵向范围同一个口径：
// 音符所在那一行（`system` 标签，多声部是连谱号括起的整组）里各音符格、增时线格与歌词格墨迹的并集
// （不取行组本身的包围盒：组里有落在原点的空图元，弧、和弦也会把线撑得忽高忽低）。
// 几何全取排版给的身份表（页面坐标的排版盒 / 墨迹盒），不回 DOM 量。

import { unionBox, type IndexNode, type PageBox, type ScoreIndex } from "./scoreindex";

export interface Span {
  y0: number;
  y1: number;
}

export class Playhead {
  private rect: SVGRectElement | null = null;
  /** 每行谱并一次（换了排版结果——`index` 变了——就作废） */
  private spans: { index: ScoreIndex; bySystem: Map<IndexNode, Span | null> } | null = null;

  /** 撤掉（换页面、换排版结果时）。 */
  reset(): void {
    this.rect = null;
    this.spans = null;
  }

  /** 挂在 `svg` 上：横向取 `box`，纵向取 `span`（页面坐标）。缺哪样都撤掉。
   *  `fixed`：`box` 已是定宽（五线谱一音一宽，不随符尾、错开的头撑宽），横向不再加边。 */
  move(svg?: SVGSVGElement | null, box?: PageBox | null, span?: Span | null, fixed = false): void {
    if (!svg || !box || !span) {
      this.rect?.remove();
      return;
    }
    const pad = 4;
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

  /** 音符格 `cell` 所在那一行的竖向范围（页面坐标）：行里各格墨迹的并集。不在任何行里为 null。 */
  systemSpan(index: ScoreIndex, cell: IndexNode): Span | null {
    const sys = index.systemOf(cell);
    if (!sys) return null;
    if (this.spans?.index !== index) this.spans = { index, bySystem: new Map() };
    const cache = this.spans.bySystem;
    if (cache.has(sys.system)) return cache.get(sys.system)!;
    const b = unionBox(sys.members.map((it) => (it.ink && it.ink.y1 > it.ink.y0 ? it.ink : undefined)));
    const span = b ? { y0: b.y0, y1: b.y1 } : null;
    cache.set(sys.system, span);
    return span;
  }
}
