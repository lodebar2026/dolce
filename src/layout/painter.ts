// 唯一的排版器 `ScorePainter`：按请求排版（简谱 / 投影、五线谱 / 混排），持有提交后的结果、
// 页面渲染（DOM 映射）、点选与播放高亮索引。
//
// 排版在 Rust（`crates/dolce-session/src/layout.rs`；网页经 dolce-wasm、桌面版异步那路走原生，见 `rustlayout.ts`）：
// 这里只管请求版本、结果提交与交互状态。排好的一份留在宿主那边（`LaidHandle`），按页取 SVG 字符串挂载，
// 身份表（每项记着 SVG 里的元素先序号）建 `ScoreIndex`，挂载后对上 DOM 元素。
//
// 点选 / 高亮部分移植自 mp/layout/draw.kt。

import type { ElementId, ScoreDoc } from "../model/doc";
import type { PlayItem } from "../score/playtypes";
import { MetaData } from "../smufl/smufl";
import type { StyleSheet } from "../style/sheet";
import { dolce } from "../common/dolce";
import { docJson } from "../model/rustdoc";
import { bindNode, nodeOfEl, ScoreIndex, toPage, type Hit, type IndexNode, type PageBox } from "./scoreindex";
import { Playhead, type Span } from "./playhead";
import { layoutAsync, layoutSync, type LaidHandle, type LayoutWire, type ProjPass } from "./rustlayout";

/** 页眉里画出来的一项：文字（标题、署名…）、调号、拍号。 */
export interface HeaderPart {
  el: SVGGraphicsElement;
  text: string;
  role: "text" | "key" | "time";
}

/** 五线谱播放线的宽（tenths，线距 10）：两个符头宽上下，各音一样宽 */
const PLAYHEAD_W = 24;

/** 节点本地的竖向范围 [top, bottom] → 页面坐标。 */
function spanOf(node: IndexNode, top: number, bottom: number): Span {
  const a = toPage(node, 0, top).y;
  const b = toPage(node, 0, bottom).y;
  return { y0: Math.min(a, b), y1: Math.max(a, b) };
}

/** 节点本地以 `cx` 为心、宽 `w` 的横向范围 → 页面坐标（竖向不用，给 0）。 */
function fixedBoxOf(node: IndexNode, cx: number, w: number): PageBox {
  const a = toPage(node, cx - w / 2, 0).x;
  const b = toPage(node, cx + w / 2, 0).x;
  return { x0: Math.min(a, b), x1: Math.max(a, b), y0: 0, y1: 0 };
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

// ---------------------------------------------------------------- 请求与资源

/** 五线谱 / 混排的纸（pt；`heightPt` null = 长图；`override` = 盖过谱里自带的纸）。同 Rust `StaffPage`。 */
export interface StaffPage {
  readonly widthPt: number;
  readonly heightPt: number | null;
  readonly marginsPt?: readonly number[];
  readonly override?: boolean;
}

/** 五线谱 / 混排的请求（`doc` 须是 MusicXML 形状）。 */
export interface StaffPaintRequest {
  readonly view: "staff" | "mixed";
  readonly doc: ScoreDoc;
  /** computed 样式表（主题 `staff`）；缺省取内置那份。 */
  readonly style?: StyleSheet;
  /** 谱里没写纸时用的那张（pt；`heightPt` null = 长图）。 */
  readonly page: StaffPage | null;
  readonly hideBarNumber: boolean;
  /** 混排：简谱层叠在第几个声部上（缺省 0） */
  readonly jianpuPart?: number;
  /** 谱里的换行换页是源文写明的，当硬断点 */
  readonly sourceBreaks?: boolean;
}

/** 原样文档这一路（文本谱与多声部 123/ABC、MusicXML 的简谱档）：整份 `ScoreDoc` 按源行排，印刷原版观感。
 *  `expanded`：投影档（反复逐遍展开、一遍一页、投影片纸）。 */
export interface JianpuPaintRequest {
  readonly view: "original" | "expanded";
  readonly doc: ScoreDoc;
  /** computed 样式表（简谱档那份）。null = print 主题出厂。 */
  readonly style: StyleSheet | null;
  /** 照文档里的换行排，不按窄纸重新断行（断点已由调用方写进文档时用）。 */
  readonly noReflow?: boolean;
  /** 投影档：`.jpwabc` 的 `.Layout` 分页描述（其他格式没有） */
  readonly breakDesc?: string | null;
  /** 简谱档的纸（pt），不给按样式表的纸。`snippet` 时只取宽、高随内容 */
  readonly page?: { w: number; h: number };
  /** 只排谱行、不放页眉页脚（帮助页的谱例片段） */
  readonly snippet?: boolean;
  /** 覆盖墨色（帮助页的谱例画在压暗的纸上） */
  readonly ink?: number;
}

export type PaintRequest = JianpuPaintRequest | StaffPaintRequest;
/** 同步入口收的请求（简谱两档）。 */
export type SyncPaintRequest = JianpuPaintRequest;
export type LoadOutcome = "committed" | "superseded";

export interface PreparedResources {
  /** SMuFL 元数据（还在 TS 里读它的：识别核对叠层、混排会话的乐句量宽） */
  readonly smuflMeta: MetaData | undefined;
}

/** 排版资源（SMuFL 元数据）。排版本身在 wasm，资源由宿主开机时交过去（`rustlayout.ts::installLayoutHost`）；
 *  这里保留「异步备好资源再排」的次序，`fixed` = 调用方手里已有，同步入口随时可用。 */
export class PaintResources {
  private _ready: PreparedResources | null;
  private _pending: Promise<PreparedResources> | null = null;

  private constructor(ready: PreparedResources | null) {
    this._ready = ready;
  }

  static fixed(smuflMeta?: MetaData): PaintResources {
    return new PaintResources({ smuflMeta });
  }

  static shared(): PaintResources {
    return new PaintResources(null);
  }

  ready(): PreparedResources | null {
    return this._ready;
  }

  prepare(): Promise<PreparedResources> {
    if (this._ready) return Promise.resolve(this._ready);
    return (this._pending ??= MetaData.shared().then(
      (smuflMeta) => (this._ready = { smuflMeta }),
      (e: unknown) => {
        this._pending = null;
        throw e;
      },
    ));
  }
}

/** 自然量宽（简谱引擎，乐句重排用）：清掉换行、整首不折，量第 `song` 首旋律声部每个音（键为元素 id）的自然横向区间与版心宽。
 *  `slide`：按投影档的画法量（数字共基线、增时线「-」字）。不改 `doc`。 */
export function measureDocument(
  doc: ScoreDoc, sheet: StyleSheet, width: number, slide = false, song = 0,
): { width: number; spans: Map<string | number, { x0: number; x1: number; x1b?: number }> } {
  const r = JSON.parse(dolce().measureDocument(docJson(doc).json, JSON.stringify(sheet), width, slide, song)) as {
    width: number;
    spans: [number, { x0: number; x1: number; x1b: number | null }][];
  };
  const spans = new Map<string | number, { x0: number; x1: number; x1b?: number }>();
  for (const [id, s] of r.spans) spans.set(id, s.x1b === null ? { x0: s.x0, x1: s.x1 } : { x0: s.x0, x1: s.x1, x1b: s.x1b });
  return { width: r.width, spans };
}

const isStaffRequest = (r: PaintRequest): r is StaffPaintRequest => r.view === "staff" || r.view === "mixed";

/** 一份请求过边界的形状（Rust `StaffRequest` / `JianpuRequest`）。 */
function wireOf(req: PaintRequest): LayoutWire {
  if (isStaffRequest(req)) {
    return {
      kind: "staff",
      doc: req.doc,
      req: {
        view: req.view,
        style: req.style ?? null,
        page: req.page ?? null,
        hideBarNumber: req.hideBarNumber,
        jianpuPart: req.jianpuPart ?? 0,
        sourceBreaks: req.sourceBreaks ?? false,
      },
    };
  }
  return {
    kind: "jianpu",
    doc: req.doc,
    req: {
      view: req.view,
      style: req.style,
      noReflow: req.noReflow ?? false,
      breakDesc: req.breakDesc ?? null,
      page: req.page ?? null,
      snippet: req.snippet ?? false,
      ...(req.ink !== undefined ? { ink: req.ink } : {}),
    },
  };
}

// ---------------------------------------------------------------- 排版器

/** 可视化编辑选中挂在音符上的子项的角色（就是身份标签的 kind）。 */
export type VisualPartRole = "aug-dot" | "harmony" | "deco" | "annotation";


export class ScorePainter {
  /** 最近一次提交的简谱档；还没排过简谱为 null。 */
  jianpuView: "original" | "expanded" | null = null;
  pageWidth = 0;
  pageHeight = 0;
  private cur: LaidHandle | null = null;
  /** 当前结果的排版请求（宿主对账脚本取它在别的宿主上重排） */
  private curWire: LayoutWire | null = null;
  /** 身份索引（按排版给的身份表建）：试听高亮、点选、可视化编辑查它。简谱、五线谱 / 混排同一份。 */
  private index: ScoreIndex = ScoreIndex.empty();
  /** 试听的竖直播放线（各视图同一种，当前在哪页的 svg 里就挂在哪页）。 */
  private playhead = new Playhead();
  /** 各页挂出来的 SVG 里的元素（先序，身份表的 `el` 是下标）；还没渲染的页没有。 */
  private pageEls: (Element[] | undefined)[] = [];
  private version = 0;

  constructor(readonly resources: PaintResources = PaintResources.shared()) {}

  /** 投影档：各首实际走的演唱顺序（`page-check` 的 P5 按它数遍数）；别的结果为 null */
  get expandPlans(): ReadonlyArray<readonly PlayItem[] | null> | null {
    return this.cur?.info.plans ?? null;
  }

  /** 投影档各首各遍的段落出现表（`SceneIdentity.slot` 指进这里）；不是投影档为 null。 */
  get projPasses(): ReadonlyArray<readonly ProjPass[] | null> | null {
    return this.cur?.info.projPasses ?? null;
  }

  /** 投影档点中的是哪一处音：第几首、第几遍、这一遍第几个符号，以及它是不是所在行的第一个 / 最后一个音。不是投影档的音为 null。 */
  slotAt(target: Element | null): { song: number; pass: number; slot: number; id: ElementId; rowFirst: boolean; rowLast: boolean } | null {
    let node: IndexNode | undefined;
    for (let el = target; el && !(el instanceof SVGSVGElement) && !node; el = el.parentElement) {
      const n = nodeOfEl(el);
      if (n?.ident?.kind === "note") node = n;
    }
    const ident = node?.ident;
    if (!node || !ident?.slot || ident.id === undefined) return null;
    const notes = (this.index.systemOf(node)?.members ?? []).filter((m) => m.ident?.kind === "note" && m.ident.slot);
    return {
      song: this.cur?.info.pages[node.page]?.song ?? 0,
      pass: ident.slot[0],
      slot: ident.slot[1],
      id: ident.id,
      rowFirst: notes[0] === node,
      rowLast: notes[notes.length - 1] === node,
    };
  }

  /** 导出 PPTX 用的页面（`editor/pptxexport.ts::buildPptx`）：简谱排的那一份；还没排过简谱时为空。 */
  async pptxSource(): Promise<{ pages: Json[]; stackGap: number | undefined; pageWidth: number; pageHeight: number }> {
    const jp = this.cur?.info.renderer === "jianpu";
    return { pages: jp ? await this.scenes() : [], stackGap: this.cur?.info.stackGap, pageWidth: this.pageWidth, pageHeight: this.pageHeight };
  }

  /** 当前结果的排版请求（宿主对账：`rustlayout.ts::wireDump` 录下、交别的宿主重排）；还没排为 null。 */
  get wire(): LayoutWire | null {
    return this.curWire;
  }

  /** 当前结果是哪一路画的。 */
  get renderer(): "jianpu" | "staff" | null {
    return this.cur?.info.renderer ?? null;
  }

  /** 简谱各行首音（行序）；五线谱 / 还没排为 null。 */
  get lineStarts(): readonly ElementId[] | null {
    return this.cur?.info.lineStarts ?? null;
  }

  /** 排版并提交。资源等待后与提交前各核一次版本：期间来了新请求就丢掉这份（`superseded`），
   *  不边算边改当前结果；最新请求失败则抛出、保留上次成功的结果。 */
  async load(request: PaintRequest): Promise<LoadOutcome> {
    const v = ++this.version;
    await this.resources.prepare();
    if (v !== this.version) return "superseded";
    let laid: LaidHandle;
    const wire = wireOf(request);
    try {
      laid = await layoutAsync(wire);
    } catch (e) {
      if (v !== this.version) return "superseded";
      throw e;
    }
    if (v !== this.version) {
      laid.free();
      return "superseded";
    }
    this.commit(laid, request, wire);
    return "committed";
  }

  /** 资源已就绪时同步排版并提交（帮助页谱例、量断行）。也作废在途的异步请求。 */
  loadSync(request: SyncPaintRequest): void {
    if (!this.resources.ready()) throw new Error("排版资源还没准备好");
    ++this.version;
    const wire = wireOf(request);
    this.commit(layoutSync(wire), request, wire);
  }

  private commit(laid: LaidHandle, req: PaintRequest, wire: LayoutWire): void {
    const info = laid.info;
    this.cur?.free();
    this.cur = laid;
    this.curWire = wire;
    if (info.renderer === "jianpu") {
      this.jianpuView = req.view as "original" | "expanded";
      this.pageWidth = info.pages[0]?.w ?? 0;
      this.pageHeight = info.pages[0]?.h ?? 0;
    }
    this.pageEls = [];
    this.playhead.reset();
    this.index = ScoreIndex.build(laid.hits);
  }

  /** 让未完成的请求作废，放掉持有的结果与 DOM 引用。 */
  dispose(): void {
    ++this.version;
    this.cur?.free();
    this.cur = null;
    this.curWire = null;
    this.pageEls = [];
    this.index = ScoreIndex.empty();
  }

  /** 当前结果的曲名（导出文件名取首行）。 */
  get title(): string {
    return this.cur?.info.title ?? "";
  }

  /** 简谱这一路定稿的栅格（样式快照脚本核对用，JSON）；别的路为 null。 */
  get documentMetrics(): Json | null {
    return this.cur?.grid() ?? null;
  }

  /** 简谱这一路的规范化定位结构（回归脚本核对几何用，JSON）；别的路为 null。 */
  placedJson(): Json | null {
    return this.cur?.placed() ?? null;
  }

  /** 各页场景（`crates/dolce-scene` 的 `Page` JSON；导出 PDF / PPTX 交 Rust 写出端）。 */
  scenes(): Promise<Json[]> {
    const c = this.cur;
    return c ? Promise.all(c.info.pages.map((_, i) => c.scene(i))) : Promise.resolve([]);
  }

  /** 元素 `id` 的音符格：简谱两条路按第 `pass` 遍（找不到那一遍取第一个），五线谱 / 混排取五线谱层那一组。 */
  private noteHit(id: ElementId, pass = 0, occ = 0): Hit | null {
    return this.index.note(id, pass, occ);
  }

  /** 身份节点画出来的 SVG 元素（那页还没渲染、或没画出来为 undefined）。 */
  private svgOf(item: IndexNode): SVGGraphicsElement | undefined {
    return item.el >= 0 ? (this.pageEls[item.page]?.[item.el] as SVGGraphicsElement | undefined) : undefined;
  }

  private elsOf(items: readonly IndexNode[]): SVGGElement[] {
    return items.flatMap((it) => {
      const el = this.svgOf(it);
      return el ? [el as SVGGElement] : [];
    });
  }

  /** 各段画出来、仍挂在文档里的元素。 */
  private shownEls(hits: readonly Hit[]): SVGGraphicsElement[] {
    return hits.flatMap((h) => {
      const el = this.svgOf(h.item);
      return el?.isConnected ? [el] : [];
    });
  }

  private elOf(hit: Hit | null): SVGGElement | null {
    return hit ? ((this.svgOf(hit.item) as SVGGElement | undefined) ?? null) : null;
  }

  /** 试听光标挪到元素 `id` 第 `pass` 遍的音（null = 撤掉）。返回所在页。
   *  各视图统一放竖直播放线（`playhead.ts`），不给音符着色；这一视图里没画的音不挪，留在上一处。
   *  纵向：五线谱 / 混排取谱表带；简谱两条路取音符所在那一行（`system` 标签，多声部是连谱号括起的整组）。 */
  highlight(id: ElementId | null, pass = 0, occ = 0): number | null {
    if (id === null) {
      this.playhead.move();
      return null;
    }
    if (this.renderer === "staff") {
      const hit = this.index.note(id);
      const sys = hit ? this.index.systemOf(hit.item)?.system : undefined;
      if (!hit || !sys) return null;
      const band = sys.data;
      const span = band ? spanOf(sys, band.top!, band.bottom!) : null;
      const cx = hit.item.data?.cx;
      // 五线谱一音一宽：以和弦组的 `cx` 为心定宽，不随符尾、错开的头撑宽
      const box = cx !== undefined ? fixedBoxOf(hit.item, cx, PLAYHEAD_W) : hit.item.bound;
      this.playhead.move(this.svgOf(hit.item)?.ownerSVGElement, box, span, cx !== undefined);
      return hit.page;
    }
    const hit = this.index.note(id, pass, occ);
    const el = hit ? this.svgOf(hit.item) : undefined;
    if (!hit || !el) return null;
    const span = this.playhead.systemSpan(this.index, hit.item) ?? (hit.item.ink ? { y0: hit.item.ink.y0, y1: hit.item.ink.y1 } : null);
    this.playhead.move(el.ownerSVGElement, hit.item.bound, span);
    return hit.page;
  }

  /** 点中的元素（事件目标）落在哪个音符格 / 和弦组里 → 元素 id；不在音符上为 null。 */
  noteAt(target: Element | null): ElementId | null {
    for (let el = target; el && !(el instanceof SVGSVGElement); el = el.parentElement) {
      const ident = nodeOfEl(el)?.ident;
      if (ident?.kind === "note" && ident.id !== undefined) return ident.id;
    }
    return null;
  }

  /** 元素 `id` 画出来的各个音符格（混排里五线谱层、简谱叠层各一个；投影档每遍一个）。 */
  noteEls(id: ElementId): SVGGElement[] {
    return this.elsOf(this.index.notes(id).map((h) => h.item));
  }

  /** 五线谱 / 混排：第 `measure` 小节（全曲下标）`edge` 那一侧的小节线各段；没画出来为空。 */
  measureBarlineEls(measure: number, edge: "before" | "after"): SVGGraphicsElement[] {
    return this.shownEls(this.index.measureBarlines(measure, edge));
  }

  /** 从 `start` 连到 `end` 的那条弧画出来的各段（跨系统时两截）。 */
  slurEls(start: ElementId, end: ElementId): SVGGraphicsElement[] {
    return this.shownEls(this.index.slurParts(start, end));
  }

  /** 五线谱 / 混排：和弦 `id` 第 `verse` 段（源段号）的那个字；没画出来为空。 */
  lyricEls(id: ElementId, verse: number): SVGGraphicsElement[] {
    const hit = this.index.syllable(id, verse);
    return hit ? this.shownEls([hit]) : [];
  }

  /** 五线谱 / 混排：和弦 `id` 所在系统的谱表带（混排连同简谱层），换成它所在页面 SVG 的用户坐标：光标竖线照这一带的高度画。 */
  staffBand(id: ElementId): { svg: SVGSVGElement; y: number; h: number } | null {
    const hit = this.index.note(id);
    const sys = hit ? this.index.systemOf(hit.item)?.system : undefined;
    const svg = sys ? this.svgOf(sys)?.ownerSVGElement : undefined;
    const d = sys?.data;
    if (!sys || !svg || !d || this.renderer !== "staff") return null;
    const s = spanOf(sys, d.top!, d.bottom!);
    return { svg, y: s.y0, h: s.y1 - s.y0 };
  }

  /** 元素 `id` 第一次出现在第几页（光标同步翻页用）；没画出来为 null。 */
  pageOf(id: ElementId): number | null {
    return this.index.pageOf(id);
  }

  /** 元素 `id` 第 `pass` 遍那个音的 `<g>`（点选、滚动到可见用）；没画出来为 null。 */
  entryEl(id: ElementId, pass = 0, occ = 0): SVGGElement | null {
    return this.elOf(this.noteHit(id, pass, occ));
  }

  /** 挨着元素 `id` 的那条小节线的 `<g>`（`edge` 是它在音符的哪一侧）；没画出来为 null。 */
  barlineEl(id: ElementId, edge: "before" | "after"): SVGGElement | null {
    return this.elOf(this.index.barline(id, edge));
  }

  /** 从 `start` 连到 `end` 的那条圆滑线/延音线的 `<g>`；没画出来（跨行时另一端不在本行）为 null。 */
  slurEl(start: ElementId, end: ElementId): SVGGElement | null {
    return this.elOf(this.index.slur(start, end));
  }

  /** 宿主音符 `hostId` 的第 `ord` 条增时线（0 起）的 `<g>`；没画出来为 null。
   *  增时线有自己 id 的按 id 认；没有的（`.jpwabc` 的 `-` 写在音符 token 里）按跟在音符格后面的序数认。 */
  sustainEl(hostId: ElementId, ord: number, ownId?: ElementId, pass = 0): SVGGElement | null {
    return this.elOf(this.index.sustain(hostId, ord, ownId, pass));
  }

  /** 元素 `id` 的各条增时线格的 `<g>`（跟在音符格后面的那几个「-」格，按序）。 */
  sustainCellEls(id: ElementId, pass = 0): SVGGElement[] {
    return this.elsOf(this.index.sustainCells(id, pass).map((h) => h.item));
  }

  /** 元素 `id` 第 `verse` 段（行内 0 起）歌词的那个字的 `<g>`（一段一个音节）。 */
  lyricEl(id: ElementId, verse = 0): SVGGElement | null {
    return this.elOf(this.index.syllable(id, verse));
  }

  /** 元素 `id` 音符格里某角色子项的 `<g>`，按页面树顺序（可视化编辑选中附点与挂在音符上的记号）。 */
  partEls(id: ElementId, role: VisualPartRole, pass = 0): SVGGElement[] {
    return this.elsOf(this.index.parts(id, role, pass).map((h) => h.item));
  }

  /** 不在音符格里的部件（增时线 `ownId` 上方的和弦），按页面树顺序。 */
  ownedPartEls(ownId: ElementId, role: VisualPartRole): SVGGElement[] {
    return this.elsOf(this.index.ownedParts(ownId, role).map((h) => h.item));
  }

  /** 页眉里画出来的东西（标题、署名、调号拍号）：`<g>`、所画的字、是不是调号拍号。可视化编辑按字对回原文字段。 */
  headerParts(): HeaderPart[] {
    if (this.renderer === "staff") {
      // 五线谱 / 混排：标题块各行（`header` 标签），按所画的字认
      return this.index.headers().flatMap((h) => {
        const el = this.svgOf(h.item);
        return el?.isConnected && h.item.text !== undefined ? [{ el, text: h.item.text, role: "text" as const }] : [];
      });
    }
    // 简谱：各页标了 `hdr`（文字）/ `hdr-keysig`（调号）/ `hdr-time`（拍号）的项
    const out: HeaderPart[] = [];
    const roles = [["hdr", "text"], ["hdr-keysig", "key"], ["hdr-time", "time"]] as const;
    this.index.headerNodes().forEach((nodes) => {
      for (const [cls, role] of roles) {
        for (const n of nodes) {
          if (n.hdr !== cls) continue;
          const el = this.svgOf(n);
          if (el?.isConnected) out.push({ el, text: n.text ?? "", role });
        }
      }
    });
    return out;
  }

  // ---------------- SVG ----------------

  /** 第 `pageIndex` 页的 SVG 字符串（`outerHTML` 口径；Node 出图、回归指纹）。 */
  pageSvg(pageIndex: number): string {
    const c = this.cur;
    if (!c || pageIndex < 0 || pageIndex >= c.info.pages.length) throw new Error(`ScorePainter: 没有第 ${pageIndex + 1} 页`);
    return c.svg(pageIndex);
  }

  /** 第 `pageIndex` 页渲染成独立的 `<svg>`（viewBox 是原生坐标：简谱排版单位 / 五线谱 tenths）。 */
  renderPage(pageIndex: number): SVGSVGElement {
    const holder = document.createElement("div");
    holder.innerHTML = this.pageSvg(pageIndex);
    const svg = holder.firstElementChild as SVGSVGElement;
    svg.remove();
    const els = Array.from(svg.getElementsByTagName("*"));
    this.pageEls[pageIndex] = els;
    // 带身份的元素反查回身份节点（`noteAt` 按它认点选）
    for (const h of this.index.all) {
      if (h.page !== pageIndex || h.item.el < 0) continue;
      const el = els[h.item.el];
      if (el) bindNode(el, h.item);
    }
    return svg;
  }

  /** 第 `i` 页画出来的墨迹盒（页面坐标）；空页或没排为 undefined。 */
  pageInk(i: number): PageBox | undefined {
    const r = this.cur?.info.pages[i]?.ink;
    return r ? { x0: r[0], y0: r[1], x1: r[2], y1: r[3] } : undefined;
  }

  get pageCount(): number {
    return this.cur?.info.pages.length ?? 0;
  }

  /** 第 `index` 页的物理尺寸（pt）。简谱排版单位就是 pt；五线谱按谱里的 scaling 从 tenths 换算。 */
  pageSize(index: number): { w: number; h: number } {
    const p = this.cur?.info.pages[index] ?? this.cur?.info.pages[0];
    if (p) return { w: p.w * p.ptPerUnit, h: p.h * p.ptPerUnit };
    return { w: this.pageWidth, h: this.pageHeight };
  }
}
