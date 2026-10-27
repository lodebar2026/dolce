// 双向定位的谱面一侧：代码区光标 ↔ 谱面元素。
//
// 索引本身（原文偏移 ↔ 元素 id）在 `sync.ts::SyncIndex`；这里管它与**画出来的谱面**之间的事：
// 条目 ↔ 谱面 `<g>` 两张反查表（每次重排后重建，页面节点全换了）、页眉按字对位、光标点亮、两向跳转，
// 以及可视化编辑问的「这个元素画在哪」（`VisualHost.noteEl` 等，App 转发到这里）。
// 三种谱面各有各的取法：简谱档问排版器，五线谱 / 混排把源 id 换成派生五线谱的 id，识别核对问命中层。

import type { EditorView } from "@codemirror/view";
import type { ElementId, ScoreDoc } from "../model/doc";
import { locate } from "../model/edit";
import type { ScorePainter } from "../layout/painter";
import { t } from "../i18n";
import type { DocFormatId } from "./formats";
import type { MixedSession } from "./mixedsession";
import type { OmrController } from "./omrctl";
import { SyncIndex, type SyncEntry } from "./sync";
import type { EditDialect } from "./visual/dialect";
import type { VisualEditController } from "./visual/controller";

/** SyncView 向 App 要的东西。 */
export interface SyncViewHost {
  readonly mode: "jp" | "mixed" | "recognize";
  readonly painter: ScorePainter;
  readonly omr: OmrController;
  readonly mixed: MixedSession;
  readonly docFormat: DocFormatId;
  readonly view: EditorView;
  readonly visual: VisualEditController;
  pageIndex: number;
  getText(): string;
  setStatus(text: string): void;
  editDialect(): EditDialect | null;
  /** 这种格式能不能在谱面上改（有代码区的文本格式，或 `.musicxml`） */
  visualSource(): boolean;
}

export class SyncView {
  readonly index = new SyncIndex();
  /** 谱面 `<g>` → 索引条目（点谱面时从事件目标往上找） */
  private _els = new Map<Element, SyncEntry>();
  /** 条目 → 谱面 `<g>`（光标移动时直接取） */
  private _elOf = new Map<SyncEntry, SVGGraphicsElement>();
  /** 页眉字段 → 谱面上画它的那几个 `<g>`（多行署名、调号拍号一组都不止一个） */
  private _headerEls = new Map<SyncEntry, SVGGraphicsElement[]>();
  /** 当前被光标点亮的那些 `<g>` */
  private _marked: Element[] = [];
  /** 防回环：两条方向互相触发时，被动的那一侧不要再反推一次 */
  private _syncing = false;
  /** 建索引用的那份模型（可视化编辑按它数对位格） */
  private _doc: ScoreDoc | null = null;
  /** 建索引时代码区的原文：与当前原文不同就说明索引落后了（重排还在防抖里） */
  private _text = "";

  constructor(private readonly host: SyncViewHost) {}

  get doc(): ScoreDoc | null {
    return this._doc;
  }

  /** 索引跟得上当前原文（不在重排防抖里）。 */
  fresh(): boolean {
    return this._text === this.host.getText();
  }

  /** 重建索引与「条目 ↔ 谱面 `<g>`」两张反查表。**每次重排后都要建**——页面节点全换了。 */
  build(doc: ScoreDoc): void {
    this.buildIndex(doc);
    this.bindEls();
  }

  /** 只建索引（原文偏移 ↔ 元素 id），不碰谱面。五线谱档的排版是异步的，索引却要跟原文同步——
   *  可视化编辑的动作按索引改原文，索引落后一拍就会按旧偏移改错地方——所以两步拆开：
   *  `reload` 里先建索引，排完版再 `bindEls`。 */
  buildIndex(doc: ScoreDoc): void {
    const host = this.host;
    this._doc = doc;
    this._text = host.getText();
    if (host.docFormat === "musicxml") {
      // 模型不记原文位置：按 DOM 节点的文档序对到隐藏代码区里的 XML 原文（`SyncIndex.buildXml`）
      if (!this.index.buildXml(doc, this._text)) host.setStatus(t("status.xmlUnaligned"));
    } else {
      this.index.build(doc);
      const fields = host.editDialect()?.headerFields?.(this._text) ?? [];
      if (fields.length) this.index.addHeader(fields);
    }
    this._els.clear();
    this._elOf.clear();
    this._headerEls.clear();
    this._marked = [];
  }

  /** 索引条目 ↔ 谱面元素两张反查表。**每次重排后都要建**——页面节点全换了。 */
  bindEls(): void {
    const host = this.host;
    this._els.clear();
    this._elOf.clear();
    this._headerEls.clear();
    this._marked = [];
    if (host.mode === "recognize") {
      this._bindRecognizeEls();
      this._bindHeader();
      this.cursorToScore();
      host.visual.afterRebuild();
      return;
    }
    if (host.mode === "mixed") {
      this._bindStaffEls();
      this._bindHeader();
      this.cursorToScore();
      host.visual.afterRebuild();
      return;
    }
    for (const entry of this.index.all()) {
      const el = this._groupEl(entry);
      if (!el) continue;
      this._elOf.set(entry, el);
      // 和弦名的组标上类名：点亮、方块都按它把和弦从音符里剔出去（`styles.css`、`overlay.ts::musicBox`；SVG 输出本身不带类名）
      if (entry.kind === "mark" && entry.markKind === "harmony" && el !== host.painter.entryEl(entry.id, 0)) el.classList.add("vis-chord");
      // 展开档里音符与它的歌词共用一个 `<g>`，先来的音符条目占住它（`all()` 已排好序）
      if (!this._els.has(el)) this._els.set(el, entry);
    }
    // 兜底第二趟：`.jpwabc` 的增时线写在音符 token 里、没有自己的条目，它那几个「-」格于是谁也不指——
    // 指到宿主音符上，点中了才有得选（点的是第几条由控制器按格认，见 `VisualHost.inlineSustainEls`）。
    // **必须等第一趟走完**：123 / 文本谱的增时线有自己的条目、那几个格归它们，先兜底就把它们抢了
    for (const entry of this.index.all()) {
      if (entry.kind !== "note") continue;
      for (const cell of this.inlineSustainEls(entry.id)) if (!this._els.has(cell)) this._els.set(cell, entry);
    }
    this._bindHeader();
    this.cursorToScore();
    host.visual.afterRebuild();
  }

  /** 源模型的元素 id → 派生五线谱里的 id。文本格式靠 `srcId` 两向表；`.musicxml` 两份是同一份原文读的，id 一样。 */
  mixedIds(id: ElementId): ElementId[] {
    if (this.host.docFormat === "musicxml") return [id];
    return this.host.mixed._srcToMixed.get(id) ?? [];
  }

  // ---- 「这个元素画在哪」（`VisualHost` 的同名方法转发到这里）----

  entryEl(entry: SyncEntry): SVGGraphicsElement | null {
    return this._elOf.get(entry) ?? this._groupEl(entry);
  }

  noteEl(id: ElementId): SVGGraphicsElement | null {
    const host = this.host;
    if (host.mode === "recognize") return host.omr.hitFor("note", id);
    if (host.mode === "mixed") {
      const m = this.mixedIds(id)[0];
      return m === undefined ? null : host.painter.noteEls(m)[0] ?? null;
    }
    return host.painter.entryEl(id, 0);
  }

  chordEls(id: ElementId): SVGGraphicsElement[] {
    const staff = this.host.mode === "recognize" ? this.host.omr.chordHits(id) : null;
    if (staff?.length) return staff;
    const one = this.noteEl(id);
    return one ? [one] : [];
  }

  // 五线谱 / 混排上：附点、增时线不是单独的图元（附点是符头旁的点、增时线并进时值），小节线与弧走带身份的叶子
  augDotEls(id: ElementId): SVGGraphicsElement[] {
    return this.host.mode !== "jp" ? [] : this.host.painter.partEls(id, "aug-dot");
  }

  barlineEl(entry: SyncEntry): SVGGraphicsElement | null {
    const host = this.host;
    if (host.mode === "recognize") return null;
    if (host.mode === "mixed") return this._staffElsOf(entry)[0] ?? null;
    return host.painter.barlineEl(entry.id, entry.edge ?? "after");
  }

  sustainEl(entry: SyncEntry): SVGGraphicsElement | null {
    if (this.host.mode !== "jp") return null;
    return this.host.painter.sustainEl(entry.id, entry.ord ?? 0, entry.own, entry.verse ?? 0);
  }

  slurEl(entry: SyncEntry): SVGGraphicsElement | null {
    const host = this.host;
    if (host.mode === "recognize") return host.omr.staffMarkHit(entry);
    if (host.mode === "mixed") return this._staffElsOf(entry)[0] ?? null;
    return entry.end === undefined ? null : host.painter.slurEl(entry.id, entry.end);
  }

  inlineSustainEls(id: ElementId): SVGGraphicsElement[] {
    return this.host.mode !== "jp" ? [] : this.host.painter.sustainCellEls(id);
  }

  textEls(entry: SyncEntry): SVGGraphicsElement[] {
    const hdr = this._headerEls.get(entry);
    if (hdr) return hdr;
    const el = this._elOf.get(entry);
    return el ? [el] : [];
  }

  /** 一个条目对应的谱面 `<g>`：按元素 id 问排版器（歌词按段取那一个字）。
   *  小节线与增时线有自己的图元（它们不按自己的 id 定位，见 `ScorePainter.barlineEl` / `sustainEl`）——
   *  取到了就归它们自己，点击才落得到它们头上；取不到退回宿主音符（旧行为）。 */
  private _groupEl(entry: SyncEntry): SVGGraphicsElement | null {
    const host = this.host;
    if (host.mode === "mixed") return this._staffElsOf(entry)[0] ?? null;
    if (host.mode === "recognize") return this._recognizeElOf(entry);
    if (entry.kind === "mark") {
      // 弧有自己的图元（`(` 与 `)` 两条都指向同一条弧）；其余记号按类名在音符格里认
      if (entry.markKind === "slur") {
        const arc = this.slurEl(entry);
        if (arc) return arc;
      }
      const part = this._markPartEl(entry);
      if (part) return part;
    }
    if (entry.kind === "lyric") return host.painter.lyricEl(entry.id, entry.verse ?? 0);
    if (entry.kind === "barline") return this.barlineEl(entry) ?? host.painter.entryEl(entry.id, 0);
    if (entry.kind === "sustain") return this.sustainEl(entry) ?? host.painter.entryEl(entry.id, 0);
    return host.painter.entryEl(entry.id, entry.verse ?? 0);
  }

  /** 五线谱 / 混排（文本格式）：索引条目按源 id 换成派生五线谱的 id，对上五线谱上画出的元素。
   *  音符 → 和弦组（五线谱层与简谱叠层各一个）；歌词、弧、小节线 → 带身份标签的叶子（`pagetree/identity.ts`）。
   *  增时线在五线谱上不是单独的东西（并进时值 / 延音线），和弦名、装饰暂不认。 */
  private _bindStaffEls(): void {
    for (const entry of this.index.all()) {
      const els = this._staffElsOf(entry);
      if (els.length === 0) continue;
      this._elOf.set(entry, els[0]!);
      if (els.length > 1) this._headerEls.set(entry, els);
      for (const el of els) if (!this._els.has(el)) this._els.set(el, entry);
    }
  }

  /** 识别核对（简谱识别结果）：音符、歌词对到核对视图的命中框（`OmrController.hitFor`），页眉按字对（`headerHits`）。 */
  private _bindRecognizeEls(): void {
    for (const entry of this.index.all()) {
      const el = this._recognizeElOf(entry);
      if (!el) continue;
      this._elOf.set(entry, el);
      if (!this._els.has(el)) this._els.set(el, entry);
    }
  }

  private _recognizeElOf(entry: SyncEntry): SVGGraphicsElement | null {
    const omr = this.host.omr;
    if (entry.kind === "note") return omr.hitFor("note", entry.id);
    // 五线谱对照：歌词字、弧、力度、文字按写进元素的识别 id 对到源图上的框
    if ((entry.kind === "lyric" || entry.kind === "mark") && omr.hasStaffResult) return omr.staffMarkHit(entry);
    if (entry.kind === "lyric") return omr.hitFor("lyric", entry.id, entry.verse ?? 0);
    // 和弦名：这个音的第几个（音符本身的在前、增时线上的按序在后，同原文顺序）
    if (entry.kind === "mark" && entry.markKind === "harmony" && !omr.hasStaffResult) {
      const slot = this.index.marksOf(entry.id).filter((m) => m.markKind === "harmony").indexOf(entry);
      return slot < 0 ? null : omr.hitFor("chord", entry.id, slot);
    }
    // 五线谱对照：小节末那条线（条目借本小节最后一个音的 id）按「收尾的是第几小节」对到源图上的那条
    if (entry.kind === "barline" && entry.edge !== "before" && omr.hasStaffResult) {
      const doc = this._doc;
      const l = doc ? locate(doc, entry.id) : null;
      return l ? omr.barlineHit(l.mi) : null;
    }
    return null;
  }

  private _staffElsOf(entry: SyncEntry): SVGGraphicsElement[] {
    const mids = (id: ElementId): ElementId[] => this.mixedIds(id);
    const p = this.host.painter;
    switch (entry.kind) {
      case "note":
        return mids(entry.id).flatMap((m) => p.noteEls(m));
      case "lyric": {
        const verse = entry.verseNo ?? (entry.verse ?? 0) + 1;
        return mids(entry.id).flatMap((m) => p.lyricEls(m, verse));
      }
      case "barline": {
        const m = mids(entry.id)[0];
        const measure = m === undefined ? undefined : this.host.mixed._mixedMeasureOf.get(m);
        if (measure === undefined) return [];
        if (entry.edge !== "before") return p.measureBarlineEls(measure, "after");
        // 音符前面那条：系统开头是本小节的 before，其余是前一小节的 after
        const own = p.measureBarlineEls(measure, "before");
        return own.length ? own : p.measureBarlineEls(measure - 1, "after");
      }
      case "mark": {
        if (entry.markKind !== "slur" || entry.end === undefined) return [];
        const s = mids(entry.id)[0];
        const ends = mids(entry.end);
        const e = ends[ends.length - 1];
        return s === undefined || e === undefined ? [] : p.slurEls(s, e);
      }
      default:
        return [];
    }
  }

  /** 页眉：从原文认出字段（`EditDialect.headerFields`）并进索引，再按字对上谱面上画出来的页眉项。
   *  字对得上的（画出来的字就是原文的值、或包含它——署名会补「作词：」）归它；调号、拍号按角色归。 */
  private _bindHeader(): void {
    const entries = this.index.ordered().filter((e) => e.kind === "header");
    if (entries.length === 0) return;
    // 页眉项：排版器画的那一份；核对视图是识别命中层里的标题、著作者框
    const parts = this.host.mode === "recognize" ? this.host.omr.headerHits() : this.host.painter.headerParts();
    const norm = (t: string): string => t.replace(/\s+/g, "");
    const bind = (e: SyncEntry, el: SVGGraphicsElement): void => {
      const list = this._headerEls.get(e) ?? [];
      if (list.length === 0) {
        this._headerEls.set(e, list);
        this._elOf.set(e, el);
      }
      list.push(el);
      if (!this._els.has(el)) this._els.set(el, e);
    };
    for (const p of parts) {
      if (p.role !== "text") {
        // 调号、拍号：字与原文写法不同，按角色对（`1=C4/4` 这种一处写两样的两者都归它）
        const e = entries.find((x) => x.headerRole === p.role || x.headerRole === "keytime");
        if (e) bind(e, p.el);
        continue;
      }
      const t = norm(p.text);
      let best: SyncEntry | null = null;
      let score = 0;
      for (const e of entries) {
        if (e.headerRole) continue;
        const v = norm(this._text.slice(e.from, e.to));
        if (!v || !t) continue;
        const sc = t === v ? 3 : t.includes(v) ? 2 : t.length >= 2 && v.includes(t) ? 1 : 0;
        if (sc > score) {
          best = e;
          score = sc;
        }
      }
      if (best) bind(best, p.el);
    }
  }

  /** 挂在音符上的记号自己的 `<g>`（和弦名、装饰、注记）：按类名在音符格里找，
   *  同类记号按原文顺序对第几个。弧、画不出来的记号（引擎只画延长号与重音）取不到，借宿主音符的 `<g>`。 */
  private _markPartEl(entry: SyncEntry): SVGGraphicsElement | null {
    const role = entry.markKind === "harmony" || entry.markKind === "deco" || entry.markKind === "annotation" ? entry.markKind : null;
    if (!role) return null;
    // 挂在增时线上的（长音中途换的和弦）不在音符格里，按增时线 id 认；音符格里的只数挂在音符本身的
    const p = this.host.painter;
    const els = entry.own !== undefined ? p.ownedPartEls(entry.own, role) : p.partEls(entry.id, role);
    const same = this.index.marksOf(entry.id).filter((m) => m.markKind === entry.markKind && m.own === entry.own);
    const nth = same.findIndex((m) => m.from === entry.from);
    return els.length === same.length && nth >= 0 ? els[nth] ?? null : null;
  }

  // ---- 两向跳转与点亮 ----

  /** 点亮一个条目。 */
  private _mark(el: Element): void {
    el.classList.add("cursor-at");
    this._marked.push(el);
  }

  /** 文本 → 谱面：光标/选区落在哪些音符上，就给哪些 `<g>` 加 `cursor-at`。
   *  **走 CSS 类、不重渲染**（沿用编辑器既有判据）。 */
  cursorToScore(): void {
    const host = this.host;
    if (this._syncing) return;
    for (const el of this._marked) el.classList.remove("cursor-at");
    this._marked = [];
    // 五线谱 / 混排（文本格式）与简谱档同一条路：条目 → `_bindStaffEls` 绑好的元素。`.musicxml` 没有代码区，不走
    if (host.mode === "mixed" ? !host.visualSource() : host.mode !== "jp") return;
    const sel = host.view.state.selection.main;
    // 选中的是附点：只点亮附点
    const dotOf = host.visual.pickedDot();
    if (dotOf) {
      for (const el of this.augDotEls(dotOf.id)) {
        el.classList.add("cursor-at");
        this._marked.push(el);
      }
      if (this._marked.length) return;
    }
    const entries = this.index.range(sel.from, sel.to);
    // 识别过的谱：排版稿里选中音符时右下角小窗跟着显示原图那一行（`OmrController.followSelection`）
    if (host.mode !== "recognize") host.omr.followSelection(entries.find((e) => e.kind === "note" || e.kind === "lyric")?.id ?? null);
    if (entries.length === 0) return;
    // 选中音符只亮音符，选中歌词只亮那一段的那个字（不连带别的段）
    for (const entry of entries) {
      for (const el of this._headerEls.get(entry) ?? [this._elOf.get(entry)]) if (el) this._mark(el);
    }
    this._scrollIntoView(this._marked[0], entries[0]!);
  }

  /** 谱面 → 文本：把光标放到这个条目对应的原文区间上。 */
  scoreToCursor(entry: SyncEntry): void {
    const span = entry.kind === "note"
      ? this.index.spanOfNote(entry.id)
      : { from: entry.from, to: entry.to };
    if (!span) return;
    this.selectSpan(span);
    // 谱面这一侧的高亮照旧自己刷一次（上面被 _syncing 挡掉了）
    this._markOnly(entry);
  }

  /** 代码区选中这段原文并滚过去，**不反推谱面**（谱面那侧调用方自己点亮）。 */
  selectSpan(span: { from: number; to: number }): void {
    this._syncing = true;
    try {
      this.host.view.dispatch({
        selection: { anchor: span.from, head: span.to },
        scrollIntoView: true,
      });
    } finally {
      this._syncing = false;
    }
  }

  /** 只点亮这一个条目（谱面点选时用；文本那侧已经跳好了，不必再反推）。 */
  private _markOnly(entry: SyncEntry): void {
    for (const el of this._marked) el.classList.remove("cursor-at");
    this._marked = [];
    for (const el of this._headerEls.get(entry) ?? [this._elOf.get(entry)]) if (el) this._mark(el);
  }

  /** 需要的话翻页并滚动到可视区（复用播放高亮那一套做法）。 */
  private _scrollIntoView(el: Element | undefined, entry: SyncEntry): void {
    if (!el) return;
    const page = this.host.painter.pageOf(entry.id);
    if (page !== null && page !== this.host.pageIndex) this.host.pageIndex = page;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** 谱面上点到的 `<g>` → 索引条目（从事件目标往上找最近的那个）。 */
  entryAt(target: EventTarget | null): SyncEntry | null {
    let el = target instanceof Element ? target : null;
    while (el) {
      const hit = this._els.get(el);
      if (hit) return hit;
      el = el.parentElement ?? (el.parentNode as Element | null);
      if (el && el.nodeType !== 1) return null;
    }
    return null;
  }

  // ---- 下面三个供脚本化测试（`window.__app` 转发，见 scripts/sync-check.mjs）----
  /** 索引里的全部条目，只给可序列化的那几个字段。 */
  entries(): Array<{ from: number; to: number; verse: number | null }> {
    // 只给音符与歌词（`sync-check` 按它们验两个方向；增时线、记号借宿主的 `<g>`，不单独验）
    return this.index.all()
      .filter((e) => e.kind === "note" || e.kind === "lyric")
      .map((e) => ({ from: e.from, to: e.to, verse: e.verse }));
  }

  /** 某条目对应的谱面 `<g>`（按 `from` + `verse` 认，跨 evaluate 边界不能靠对象身份）。 */
  elAt(from: number, verse: number | null): SVGGraphicsElement | null {
    for (const [entry, el] of this._elOf) {
      if (entry.from === from && entry.verse === verse) return el;
    }
    return null;
  }

  /** 谱面 `<g>` → 条目（反查表命中与否）。 */
  entryOfEl(el: Element): { from: number; to: number; verse: number | null } | null {
    const e = this._els.get(el);
    return e ? { from: e.from, to: e.to, verse: e.verse } : null;
  }
}
