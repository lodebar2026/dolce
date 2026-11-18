// 谱面的身份索引：排版（Rust）给的各页身份表（`rustlayout.ts::SceneHit`，带身份标签或页眉类名的节点，前序），
// 按标签收起来，供播放高亮、点选、可视化编辑查。引擎只管打标签；这里不认任何引擎内部的类型。
// 表里每项记着 SVG 里画出来的元素先序号（`el`），挂载后由排版器对上 DOM 元素。

import type { ElementId } from "../model/doc";
import type { SceneHit, SceneIdentity } from "./rustlayout";

export type IdentityKind = SceneIdentity["kind"];

/** 页面坐标（页面 SVG 的用户坐标）里的一个盒。 */
export interface PageBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 身份表的一个节点（只含表里的项；`up` / `children` 是表内最近的祖先 / 子孙）。 */
export interface IndexNode {
  readonly page: number;
  /** SVG 元素先序号；没画出来为 -1 */
  readonly el: number;
  readonly ident: SceneIdentity | undefined;
  readonly hdr: SceneHit["hdr"];
  readonly text: string | undefined;
  readonly data: Record<string, number> | undefined;
  /** 本地 → 页面的仿射（`SceneHit.m`）；排版没给几何时缺 */
  readonly m: SceneHit["m"];
  /** 页面坐标的排版盒（同 DOM `getBBox` 的口径）与墨迹盒；没画东西时缺 */
  readonly bound: PageBox | undefined;
  readonly ink: PageBox | undefined;
  readonly parent: IndexNode | null;
  readonly children: IndexNode[];
}

const boxOf = (r: SceneHit["bound"]): PageBox | undefined => (r ? { x0: r[0], y0: r[1], x1: r[2], y1: r[3] } : undefined);

/** 节点本地坐标的点换到页面坐标（没给几何时原样）。 */
export function toPage(node: IndexNode, x: number, y: number): { x: number; y: number } {
  const m = node.m;
  return m ? { x: m[0] * x + m[1] * y + m[2], y: m[3] * x + m[4] * y + m[5] } : { x, y };
}

/** 挂出来的带身份元素 → 身份节点（各排版器挂页时登记；元素随页换掉，表跟着失效）。 */
const nodeByEl = new WeakMap<Element, IndexNode>();

export function bindNode(el: Element, node: IndexNode): void {
  nodeByEl.set(el, node);
}

/** 元素是哪个身份节点画的（不是身份元素为 undefined）。 */
export function nodeOfEl(el: Element): IndexNode | undefined {
  return nodeByEl.get(el);
}

/** 几个盒的并（全缺为 undefined）。 */
export function unionBox(boxes: readonly (PageBox | undefined)[]): PageBox | undefined {
  let out: PageBox | undefined;
  for (const b of boxes) {
    if (!b) continue;
    out = out ? { x0: Math.min(out.x0, b.x0), y0: Math.min(out.y0, b.y0), x1: Math.max(out.x1, b.x1), y1: Math.max(out.y1, b.y1) } : { ...b };
  }
  return out;
}

export interface Hit {
  page: number;
  item: IndexNode;
}

/** 一页的身份表 → 节点树的根（多个根挂在一个虚根下，虚根不带身份）。 */
function treeOf(table: readonly SceneHit[], page: number): IndexNode {
  const root: IndexNode = { page, el: -1, ident: undefined, hdr: undefined, text: undefined, data: undefined, m: undefined, bound: undefined, ink: undefined, parent: null, children: [] };
  const nodes: IndexNode[] = [];
  for (const h of table) {
    const parent = h.up >= 0 ? nodes[h.up]! : root;
    const n: IndexNode = {
      page, el: h.el, ident: h.id, hdr: h.hdr, text: h.text, data: h.data, m: h.m, bound: boxOf(h.bound), ink: boxOf(h.ink),
      parent: h.up >= 0 ? parent : null, children: [],
    };
    parent.children.push(n);
    nodes.push(n);
  }
  return root;
}

/** 同一元素的音符格与增时线格（投影档每遍各一组），按页面树顺序。 */
interface CellHit extends Hit {
  pass: number;
}

export class ScoreIndex {
  private cells = new Map<ElementId, CellHit[]>();
  private barlines = new Map<string, Hit>();
  /** 五线谱 / 混排的小节线，按「小节:侧」收（一条线每个谱表组一段） */
  private measureBars = new Map<string, Hit[]>();
  /** 同一条弧 / 同一个字可能画成几段（跨系统的弧、混排两层），按页面树顺序 */
  private slurs = new Map<string, Hit[]>();
  private syllables = new Map<string, Hit[]>();
  private systems = new Map<IndexNode, IndexNode[]>();
  private headerHits: Hit[] = [];
  /** 各页标了页眉类名（`hdr` / `hdr-keysig` / `hdr-time`）的节点，前序 */
  private hdrNodes: IndexNode[][] = [];
  /** 不在音符格里、标签自带 id 的部件（增时线上的和弦），按「种类:id」收 */
  private ownParts = new Map<string, Hit[]>();
  /** 带身份的全部图元（渲染后把 DOM 元素反查回图元用） */
  readonly all: Hit[] = [];

  private constructor() {}

  /** 各页的身份表（前序）建索引。 */
  static build(pages: readonly (readonly SceneHit[])[]): ScoreIndex {
    const ix = new ScoreIndex();
    pages.forEach((tbl, i) => ix.walk(treeOf(tbl, i), i));
    return ix;
  }

  static empty(): ScoreIndex {
    return new ScoreIndex();
  }

  private lastNoteId: ElementId | null = null;
  /** 最近一个音符格的 id：带自己 id 的增时线格也记到它名下（排在音符格之后），按宿主 + 序数也认得出 */
  private lastHostId: ElementId | null = null;
  /** 还等着后面那个音符来认领的小节线（`‖:` 画在小节第一个音符之前） */
  private pendingBefore: Hit[] = [];

  private walk(root: IndexNode, page: number): void {
    let system: IndexNode | null = null;
    const hdr: IndexNode[] = [];
    this.hdrNodes[page] = hdr;
    const go = (item: IndexNode): void => {
      const outer = system;
      if (item.hdr) hdr.push(item);
      const ident = item.ident;
      if (ident) {
        const hit = { page, item };
        this.all.push(hit);
        const push = (map: Map<string, Hit[]>, key: string): void => {
          const list = map.get(key) ?? [];
          list.push(hit);
          map.set(key, list);
        };
        switch (ident.kind) {
          case "system":
            system = item;
            this.systems.set(item, []);
            break;
          case "note":
          case "sustain":
            if (ident.id !== undefined) {
              const list = this.cells.get(ident.id) ?? [];
              list.push({ ...hit, pass: ident.pass ?? 0 });
              this.cells.set(ident.id, list);
              if (ident.kind === "note") this.lastHostId = ident.id;
              else if (this.lastHostId !== null && this.lastHostId !== ident.id) this.cells.get(this.lastHostId)?.push({ ...hit, pass: ident.pass ?? 0 });
              this.lastNoteId = ident.id;
              for (const b of this.pendingBefore) this.barlines.set(`${ident.id}:before`, b);
              this.pendingBefore = [];
              if (system) this.systems.get(system)!.push(item);
            }
            break;
          case "barline": {
            const edge = ident.edge ?? "after";
            if (ident.measure !== undefined) push(this.measureBars, `${ident.measure}:${edge}`);
            else if (ident.id !== undefined) {
              for (const id of [ident.id, ...(ident.also ?? [])]) this.barlines.set(`${id}:${edge}`, hit);
            } else if (edge === "before") this.pendingBefore.push(hit);
            else if (this.lastNoteId !== null) this.barlines.set(`${this.lastNoteId}:after`, hit);
            break;
          }
          case "slur":
            if (ident.id !== undefined && ident.end !== undefined) push(this.slurs, `${ident.id}:${ident.end}`);
            break;
          case "syllable":
            if (ident.id !== undefined) {
              push(this.syllables, `${ident.id}:${ident.verse ?? 0}`);
              if (system) this.systems.get(system)!.push(item);
            }
            break;
          case "header":
            this.headerHits.push(hit);
            break;
          case "harmony":
          case "deco":
          case "annotation":
            if (ident.id !== undefined) push(this.ownParts, `${ident.kind}:${ident.id}`);
            break;
        }
      }
      for (const c of item.children) go(c);
      system = outer;
    };
    go(root);
  }

  /** 元素 `id` 第 `pass` 遍的音符格（找不到那一遍就取第一个）。增时线有自己 id 的，按它的 id 也认得出。
   *  `occ`：同一遍号画了几次时取第几次（只有一段词的反复，两遍都是第 1 段；页面树顺序就是演唱顺序）。 */
  note(id: ElementId, pass = 0, occ = 0): Hit | null {
    const list = this.cells.get(id);
    if (!list || list.length === 0) return null;
    if (occ > 0) {
      // 只数这个 id 自己的格（宿主名下另记的增时线格不算），音符格优先
      const own = list.filter((h) => h.pass === pass && h.item.ident?.id === id);
      const notes = own.filter((h) => h.item.ident?.kind === "note");
      const pick = (notes.length > 0 ? notes : own)[occ];
      if (pick) return pick;
    }
    return list.find((h) => h.pass === pass) ?? list[0]!;
  }

  pageOf(id: ElementId): number | null {
    return this.note(id)?.page ?? null;
  }

  /** 跟在音符格后面的增时线格（宿主 id 下第 1 个起），按序。 */
  sustainCells(id: ElementId, pass = 0): Hit[] {
    const list = this.cells.get(id);
    if (!list || list.length === 0) return [];
    const same = list.filter((h) => h.pass === pass);
    return (same.length > 0 ? same : list).slice(1);
  }

  /** 宿主 `host` 的第 `ord` 条增时线：有自己的 id（`own`）按 id 认，否则按序数。 */
  sustain(host: ElementId, ord: number, own: ElementId | undefined, pass = 0): Hit | null {
    if (own !== undefined) {
      const hit = this.cells.get(own)?.find((h) => h.item.ident?.kind === "sustain");
      if (hit) return hit;
    }
    return this.sustainCells(host, pass)[ord] ?? null;
  }

  /** 元素 `id` 的全部音符格（混排里五线谱层与简谱层各一个），按页面树顺序。 */
  notes(id: ElementId): Hit[] {
    return (this.cells.get(id) ?? []).filter((h) => h.item.ident?.kind === "note" && h.item.ident.id === id);
  }

  barline(id: ElementId, edge: "before" | "after"): Hit | null {
    return this.barlines.get(`${id}:${edge}`) ?? null;
  }

  /** 五线谱 / 混排：第 `measure` 小节（全曲下标）`edge` 那一侧的小节线各段。 */
  measureBarlines(measure: number, edge: "before" | "after"): Hit[] {
    return this.measureBars.get(`${measure}:${edge}`) ?? [];
  }

  slur(start: ElementId, end: ElementId): Hit | null {
    return this.slurs.get(`${start}:${end}`)?.[0] ?? null;
  }

  /** 同一条弧画出的各段（跨系统时前后两截）。 */
  slurParts(start: ElementId, end: ElementId): Hit[] {
    return this.slurs.get(`${start}:${end}`) ?? [];
  }

  /** 元素 `id` 第 `verse` 段歌词那个字（简谱：行内段序 0 起；五线谱 / 混排：源段号 1 起）。 */
  syllable(id: ElementId, verse = 0): Hit | null {
    // 投影档同一个字每遍各画一次：取最后画的那个（索引一直是后来的盖前面的）
    const list = this.syllables.get(`${id}:${verse}`);
    return list?.[list.length - 1] ?? null;
  }

  /** 简谱各页的页眉项（`hdr` 类名的节点），按页面树顺序。 */
  headerNodes(): readonly (readonly IndexNode[])[] {
    return this.hdrNodes;
  }

  /** 页眉里的字（`header` 标签），按页面树顺序。 */
  headers(): readonly Hit[] {
    return this.headerHits;
  }

  /** 元素 `id` 音符格里某种部件，按页面树顺序（命中的不再往下找）。 */
  parts(id: ElementId, kind: IdentityKind, pass = 0): Hit[] {
    const cell = this.note(id, pass);
    return cell ? findByKind(cell.item, kind).map((item) => ({ page: cell.page, item })) : [];
  }

  /** 标签自带 id 的部件（增时线上的和弦：`id` 是增时线自己的），按页面树顺序。 */
  ownedParts(id: ElementId, kind: IdentityKind): Hit[] {
    return this.ownParts.get(`${kind}:${id}`) ?? [];
  }

  /** 图元所在那一行谱（`system` 标签）与行里的音符、增时线、歌词格。不在任何行里为 null。 */
  systemOf(item: IndexNode): { system: IndexNode; members: readonly IndexNode[] } | null {
    for (let cur: IndexNode | null = item; cur; cur = cur.parent) {
      const members = this.systems.get(cur);
      if (members) return { system: cur, members };
    }
    return null;
  }
}

/** 子树里某种标签的图元，按页面树顺序；命中的项不再往下找。 */
export function findByKind(root: IndexNode, kind: IdentityKind): IndexNode[] {
  const out: IndexNode[] = [];
  const walk = (it: IndexNode): void => {
    if (it !== root && it.ident?.kind === kind) {
      out.push(it);
      return;
    }
    for (const c of it.children) walk(c);
  };
  walk(root);
  return out;
}

/** 从点中的图元往上找它所在的音符格 / 增时线格（带 `note` / `sustain` 标签的那一层）。 */
export function cellOf(item: IndexNode): IndexNode | null {
  for (let cur: IndexNode | null = item; cur; cur = cur.parent) {
    const k = cur.ident?.kind;
    if (k === "note" || k === "sustain") return cur;
  }
  return null;
}
