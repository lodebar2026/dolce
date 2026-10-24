// 可视化编辑控制器：谱面上的选中、光标、键盘与点击。
//
// **源码仍是真身**：选中、移动都只是改代码区的选区；改谱的动作落成对原文的局部补丁
// （`view.dispatch({ changes })`），撤销重做直接用代码区那份 history。
// 光标状态只有一份——代码区选区（非空 = 编辑模式，空 = 插入模式），谱面光标由它推出（`overlay.ts`）。
//
// 与 omr / playback 两个控制器同一个做法：通过一个**列全了的**宿主接口 `VisualHost` 向 App 要能力。

import { redo, undo } from "@codemirror/commands";
import { type ChangeSpec, ChangeSet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { Chord, ElementId, Part, ScoreDoc, Song } from "../../model/doc";
import { type BeatIssue, beatTag, checkMeasureDurations, describeBeatIssue } from "../../model/beatcheck";
import { GlyphCodes } from "../../smufl/smufl";
import type { BreakMark, SyncEntry, SyncIndex } from "../sync";
import { deleteBreak, insertBreak } from "./breaks";
import { setBeatSpans, setBreakSpans, setScoreFocus } from "./cursor";
import { buildPalette, type MenuRunner, type MenuTarget, showMenu } from "./menu";
import { midiOf, NotePreview } from "./preview";
import type { EditDialect, NoteDuration } from "./dialect";
import {
  addSustain, clearBeams, deleteEntries, double, dropInlineSustain, type EditCtx, type EditOutcome, groupEnd, halve, insertNote, insertToken,
  attachedTextOf, chordEntryOf, DYNAMICS, chordNameOf, insertLetter, isError, noteCtx, retargetToken, setAttachedText, setChordName, shiftSemitones, toggleTupletText, spacedInsert, noteSpans, notesIn, setAccidental, setDegree, setLetter, shiftOctave, stepDegree, stepSemitone, toggleDeco, toggleDot, toggleSlur, toggleTie,
} from "./ops";
import { keyHit, VISUAL_ACTIONS, type VisualAction, type VisualMode } from "./keys";
import { type Clip, clipFor, itemsToText, setClip } from "./clipboard";
import { beamGroupOf, clipOfChords, directionTextOf, locate, measureCtx } from "../../model/edit";
import { pitchAt } from "../omrlinks";
import { moveAttachedText, moveSlurText, shiftLyricText } from "./moves";
import { harmonyText } from "../../model/jianpu";
import { showTransposeDialog, transposeText } from "./transpose";
import { lyricTextOf, setLyricText } from "./lyrics";
import { selectionInfo } from "./selinfo";
import { type InlineDone, inlineEditing, openInlineEditor } from "./inline";
import { measureEdit } from "./measureops";
import { directionModel, harmonyModel, insertAtSourceModel, lyricModel, moveSelected, pasteModel, runModelAction, transposeModel, type ModelActionCtx } from "./modelops";
import {
  type Box, boxInPage, charIndexAt, inkBoxInPage, clearDragHints, clearOverlay, drawBlock, drawBreak, caretWidth, drawCaret, drawDragHint, hitThroughOverlay, musicBox, rightEdgeInBand,
  sameRow, setBeatIssues, textCaretInPage,
} from "./overlay";
import { t as tr } from "../../i18n";

/** 键盘上这几样交给浏览器的剪贴板事件（`onClipboardEvent`）：那里拿得到系统剪贴板的字 */
const CLIPBOARD_ACTIONS = new Set(["edit.copy", "edit.cut", "edit.paste"]);
const actionById = (id: string): VisualAction => VISUAL_ACTIONS.find((a) => a.id === id)!;

export interface VisualHost {
  readonly view: EditorView;
  /** 当前的双向定位索引（每次重排后重建） */
  readonly sync: SyncIndex;
  readonly scorePane: HTMLElement;
  /** 此刻能不能可视化编辑：有代码区、在简谱档或五线谱/混排档、不在识别核对 */
  visualEnabled(): boolean;
  /** 谱面是哪一路画的。减时线、附点、token 里的增时线靠简谱字形的几何命中，只有 `jianpu` 那一路有 */
  surfaceKind(): "jianpu" | "staff" | "recognize";
  /** 光标竖线的纵向范围（页面 SVG 用户坐标）：五线谱取这个音所在系统的谱表带；null = 按元素框（简谱） */
  caretBand(entry: SyncEntry): { svg: SVGSVGElement; y: number; h: number } | null;
  /** 条目在谱面上的 `<g>`（增时线、记号借宿主音符的） */
  entryEl(entry: SyncEntry): SVGGraphicsElement | null;
  /** 音符在谱面上的 `<g>` */
  noteEl(id: ElementId): SVGGraphicsElement | null;
  /** 和弦里每个音各自的图元（五线谱对照视图一个音一个框）；缺省只有 `noteEl` 那一个 */
  chordEls?(id: ElementId): SVGGraphicsElement[];
  /** 文字条目（歌词、页眉字段）在谱面上的 `<g>`：页眉的多行署名、调号拍号一组不止一个 */
  textEls(entry: SyncEntry): SVGGraphicsElement[];
  /** 音符的附点在谱面上的 `<g>`（每个点一个；可单独点选） */
  augDotEls(id: ElementId): SVGGraphicsElement[];
  /** 小节线自己的 `<g>`（它没有 id，按「相邻音符 + 侧」认）；没画出来为 null */
  barlineEl(entry: SyncEntry): SVGGraphicsElement | null;
  /** 一条增时线自己的 `<g>`；没画出来为 null */
  sustainEl(entry: SyncEntry): SVGGraphicsElement | null;
  /** 一条圆滑线/延音线的弧本身的 `<g>`；没画出来（跨行时另一端不在本行）为 null */
  slurEl(entry: SyncEntry): SVGGraphicsElement | null;
  /** 写在音符 token 里的增时线（`.jpwabc` 的 `5---`）画出来的那几个格，按序 */
  inlineSustainEls(id: ElementId): SVGGraphicsElement[];
  /** 谱面上点中的 `<g>` 对应哪个条目（从事件目标往上找） */
  entryAtTarget(target: EventTarget | null): SyncEntry | null;
  /** 当前格式怎么改原文；null = 这种格式在谱面上只能选中、不能改（`.musicxml` 走模型那一路，见 `modelEditing`） */
  editDialect(): EditDialect | null;
  /** 这种格式改的是模型（`.musicxml`：没有原文 token 可补丁，动作经 `modelops.ts` 改 `ScoreDoc` 再整份重写） */
  modelEditing(): boolean;
  /** 按代码区当前原文新读一份模型（模型那一路在它上面改） */
  freshModel(): ScoreDoc | null;
  /** 模型 → 原文（唯一写出端） */
  writeModel(doc: ScoreDoc): string;
  /** 建索引用的那份模型（与 `sync` 同一版） */
  syncDoc(): ScoreDoc | null;
  /** 改完原文马上重排（不等输入防抖） */
  reloadNow(): void;
  /** 等在途的异步排版（五线谱 / 混排）落定、谱面元素绑好 */
  whenIdle(): Promise<void>;
  /** 正在试听：按键发声让路 */
  playbackBusy(): boolean;
  /** 索引是不是按代码区当前的原文建的（代码区刚改过、重排还在防抖里时为 false） */
  syncFresh(): boolean;
  setStatus(text: string): void;
  saveSettings(): void;
  /** 识别核对：Alt+点原图的那一处落在哪两个音之间（五线谱另给按位置推出的音高）；不在核对视图为 null */
  sourcePoint?(ev: MouseEvent): { after: ElementId | null; before: ElementId | null; pitch?: { step: "A" | "B" | "C" | "D" | "E" | "F" | "G"; octave: number } } | null;
  /** 识别核对时的可疑项（F8 与拍数不对的小节按原文位置一起走）：各在原文的哪儿、怎么跳过去 */
  doubtStops?(): { at: number; go(): void }[];
}

const XML_ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
function unescapeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, _n, dec, hex) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : XML_ENT[m] ?? m);
}
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 元素里的 `<text>`：简谱那一路是一个 `<g>` 里收着字，五线谱的歌词字本身就是 `<text>`。 */
function textsOf(el: Element): SVGTextElement[] {
  return el instanceof SVGTextElement ? [el] : [...el.querySelectorAll("text")];
}

/** 方向键能停的条目：音符、增时线、小节线、原文里有符号的换行 */
const NAVIGABLE = new Set<SyncEntry["kind"]>(["note", "sustain", "barline", "break"]);

/** 只有 `.musicxml`（改模型那一路）做得了的：简谱各格式没有谱号、渐强渐弱、八度线与这几种奏法装饰的写法 */
const XML_ONLY = new Set(["meas.clef", "meas.clefReread", "wedge.cresc", "wedge.dim", "ottava.up", "ottava.down", "grace.toggle",
  "deco.staccato", "deco.tenuto", "deco.marcato", "deco.staccatissimo", "deco.fermataInv", "deco.trill", "deco.mordent", "deco.turn"]);

export class VisualEditController {
  /** 谱面上显示换行/换页符号。持久化。 */
  showFormatMarks = true;
  /** 插入或改音后响一下（按键即发声）。持久化。 */
  noteSound = true;
  /** 发声用的音源；回归脚本可换成假的，断言它收到的音高 */
  preview: { play(midi: number): unknown } = new NotePreview();
  /** 小节时值自检：拍数对不上的小节标红。持久化。 */
  beatCheck = true;
  private beatIssues: BeatIssue[] = [];
  /** 原文里的空小节 `| |`（整小节的音删光了）。模型里没有它（解析时空小节不成小节），小节时值自检看不见，另从原文认 */
  private emptyBars: { from: number; to: number }[] = [];
  /** 打开时首小节就不满（弱起）的声部 `songIndex:partIndex`；null = 刚打开、还没查过（`documentLoaded`） */
  private pickups: Set<string> | null = null;
  private beatBtn: HTMLButtonElement | null = null;
  private beatEl: HTMLElement | null = null;
  /** 计数标签点一下跳到下一处：上次跳到第几处 */
  private beatCursor = -1;
  /** 记号面板：显示与否持久化 */
  showPalette = false;
  private paletteEl: HTMLElement | null = null;
  private paletteBtn: HTMLButtonElement | null = null;
  private paletteRefresh: (() => void) | null = null;
  private modeEl: HTMLElement | null = null;
  /** 选中元素的读数（声部、小节、拍、音高、时值），见 `selinfo.ts` */
  private selInfoEl: HTMLElement | null = null;
  /** 刚框选完：浏览器随后补发的那一下 `click` 不能再当单击（会把框出来的选区换成插入光标） */
  private swallowClick = false;
  private marksBtn: HTMLButtonElement | null = null;
  /** 叠加层里画出来的换行符号 → 它那一处换行 */
  private breakEls = new Map<Element, BreakMark>();
  /** 点中的一处**原文里没有符号**的换行（文本谱另起一行 `Q:`）：选区表达不了它，另记一份；
   *  `sel` 是点中时的光标位置，选区一挪开就作废 */
  private pickedBreak: { after: ElementId; sel: number } | null = null;
  /** 双击文字进了代码区改字（`handleDoubleClick` 置上；代码区失焦、在代码区按下鼠标即清）：
   *  只有这时代码区的 Enter 才归 `textEnter`，直接在代码区打字时照常换行 */
  private textEditing = false;
  /** 插入模式的「当前时值」：新插的音符用它 */
  curDur: NoteDuration = { halvings: 0, dots: 0 };
  /** 声部输入：插入模式新插的音落在光标所在谱表的第几声线（`.musicxml` 用；Ctrl+Alt+1–4）。
   *  null = 没指定过，跟光标前那个音的声线；换文档回到 null */
  curVoice: number | null = null;
  /** Alt+点击单独选中的和弦音（从低到高第几个）；`sel` 是选中时的选区，选区一动就作废 */
  private pickedNote: { id: ElementId; index: number; from: number; to: number } | null = null;

  constructor(private host: VisualHost) {}

  // ---------------- 装配 ----------------

  /** 界面语言变了：记号面板重建、模式标签与拍数提示重画。 */
  relabel(): void {
    if (this.paletteEl) this.paletteRefresh = buildPalette(this.paletteEl, this.runner);
    this.refresh();
  }

  /** 谱面可聚焦、接键盘；工具条上的模式标签与格式标记开关。 */
  attach(els: {
    mode: HTMLElement | null; selInfo?: HTMLElement | null; marksBtn: HTMLButtonElement | null;
    beatBtn: HTMLButtonElement | null; beatCount: HTMLElement | null;
    palette: HTMLElement | null; paletteBtn: HTMLButtonElement | null;
  }): void {
    const { mode: modeEl, marksBtn, beatBtn, beatCount: beatEl } = els;
    const pane = this.host.scorePane;
    pane.addEventListener("contextmenu", (ev) => this.onContextMenu(ev));
    this.paletteEl = els.palette;
    this.paletteBtn = els.paletteBtn;
    if (els.palette) this.paletteRefresh = buildPalette(els.palette, this.runner);
    els.paletteBtn?.addEventListener("click", () => {
      this.showPalette = !this.showPalette;
      this.syncButtons();
      this.host.saveSettings();
      this.refresh();
    });
    pane.tabIndex = 0;
    pane.addEventListener("keydown", (ev) => this.onKeyDown(ev));
    // 复制剪切粘贴走浏览器的剪贴板事件（不用要剪贴板权限，桌面外壳里一样）；键盘那一下在 onKeyDown 里放过去
    pane.addEventListener("copy", (ev) => this.onClipboardEvent(ev, "copy"));
    pane.addEventListener("cut", (ev) => this.onClipboardEvent(ev, "cut"));
    pane.addEventListener("paste", (ev) => this.onClipboardEvent(ev, "paste"));
    // WebKit（Safari、macOS 桌面版的 WKWebView）：焦点不在可编辑区、又没有文字选区时，复制粘贴菜单项是灰的、事件不发；
    // `before*` 里 preventDefault 就是告诉它「这里能复制 / 粘贴」
    for (const t of ["beforecopy", "beforecut", "beforepaste"]) {
      pane.addEventListener(t, (ev) => {
        if (this.host.visualEnabled() && !inlineEditing()) ev.preventDefault();
      });
    }
    pane.addEventListener("focus", () => this.setFocus(true));
    pane.addEventListener("blur", () => this.setFocus(false));
    // 改字会话：在代码区里按下鼠标（直接改代码）、焦点去了代码区以外，都算结束
    const inCode = (t: EventTarget | null): boolean => t instanceof Element && !!t.closest(".cm-editor");
    document.addEventListener("pointerdown", (ev) => {
      if (inCode(ev.target)) this.textEditing = false;
    }, true);
    document.addEventListener("focusin", (ev) => {
      if (!inCode(ev.target)) this.textEditing = false;
    });
    // 点谱面就把焦点给谱面（SVG 里的点击不会自己聚焦到容器上）
    pane.addEventListener("pointerdown", () => {
      if (this.host.visualEnabled()) pane.focus({ preventScroll: true });
    });
    this.modeEl = modeEl;
    this.selInfoEl = els.selInfo ?? null;
    this.marksBtn = marksBtn;
    // 拖动挂件先挂：按住选中的挂件时由它接走（`stopImmediatePropagation`），框选就不开
    this.attachDrag(pane);
    this.attachMarquee(pane);
    marksBtn?.addEventListener("click", () => this.toggleFormatMarks());
    this.beatBtn = beatBtn;
    this.beatEl = beatEl;
    beatBtn?.addEventListener("click", () => this.toggleBeatCheck());
    beatEl?.addEventListener("click", () => this.nextBeatIssue());
    this.syncButtons();
  }

  loadSettings(s: { showFormatMarks?: unknown; beatCheck?: unknown; noteSound?: unknown; showPalette?: unknown }): void {
    if (typeof s.showPalette === "boolean") this.showPalette = s.showPalette;
    if (typeof s.showFormatMarks === "boolean") this.showFormatMarks = s.showFormatMarks;
    if (typeof s.noteSound === "boolean") this.noteSound = s.noteSound;
    if (typeof s.beatCheck === "boolean") this.beatCheck = s.beatCheck;
    this.syncButtons();
  }

  private setFocus(on: boolean): void {
    this.host.view.dispatch({ effects: setScoreFocus.of(on && this.host.visualEnabled()) });
    this.refresh();
  }

  private syncButtons(): void {
    for (const [btn, on] of [[this.marksBtn, this.showFormatMarks], [this.beatBtn, this.beatCheck], [this.paletteBtn, this.showPalette]] as const) {
      if (!btn) continue;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
  }

  setNoteSound(on: boolean): void {
    this.noteSound = on;
    this.host.saveSettings();
  }

  /** 响一下光标处的音：编辑模式是选中的第一个音，插入模式是光标前那个。 */
  private sound(): void {
    if (!this.noteSound || this.host.playbackBusy()) return;
    const c = this.editCtx(true);
    if (!c) return;
    const sel = c.state.selection.main;
    const e = sel.empty
      ? [...this.navigable()].reverse().find((x) => x.kind === "note" && x.to <= sel.head)
      : notesIn(c, sel.from, sel.to)[0];
    if (!e) return;
    const nc = noteCtx(c, e.from);
    const t = c.dialect.parseNote(c.state.doc.sliceString(e.from, e.to), nc);
    if (!t || t.degree === 0) return;
    void this.preview.play(midiOf(t.degree, t.octave, t.acc, nc.fifths));
  }

  toggleBeatCheck(): void {
    this.beatCheck = !this.beatCheck;
    this.syncButtons();
    this.host.saveSettings();
    this.afterRebuild();
  }

  /** 拍数不对的小节与空小节，按原文顺序（计数标签逐个跳）。 */
  private beatMarks(): ({ at: number; issue: BeatIssue } | { at: number; empty: { from: number; to: number } })[] {
    const out: ({ at: number; issue: BeatIssue } | { at: number; empty: { from: number; to: number } })[] = [];
    for (const issue of this.beatIssues) {
      const first = this.host.sync.ordered().find((e) => e.kind === "note" && issue.ids.includes(e.id));
      out.push({ at: first?.from ?? issue.source?.offset ?? 0, issue });
    }
    for (const empty of this.emptyBars) out.push({ at: empty.from, empty });
    return out.sort((a, b) => a.at - b.at);
  }

  /** 计数标签：选中下一处拍数不对的小节的第一个音；空小节把插入光标放进两条小节线中间。 */
  private nextBeatIssue(dir: 1 | -1 = 1): void {
    const marks = this.beatMarks();
    if (marks.length === 0) {
      this.host.setStatus(tr("issue.none"));
      return;
    }
    this.beatCursor = ((this.beatCursor < 0 && dir < 0 ? 0 : this.beatCursor) + dir + marks.length) % marks.length;
    this.goBeat(marks[this.beatCursor]!);
  }

  private goBeat(m: ReturnType<VisualEditController["beatMarks"]>[number]): void {
    if ("empty" in m) {
      this.select(m.empty.from + 1, m.empty.from + 1);
      this.host.setStatus(tr("beat.emptyCursor"));
      return;
    }
    const first = this.host.sync.ordered().find((e) => e.kind === "note" && m.issue.ids.includes(e.id));
    if (first) {
      const span = this.noteSel(first);
      this.select(span.from, span.to);
    }
    this.host.setStatus(tr("beat.measure", { n: m.issue.measureIndex + 1, issue: describeBeatIssue(m.issue) }));
  }

  /** 原文里的空小节：同一行里两条小节线之间只有空白，且这一行是曲谱行（行里有音符）。 */
  private findEmptyBars(): { from: number; to: number }[] {
    const doc = this.host.view.state.doc;
    const text = doc.toString();
    const musicLines = new Set(this.host.sync.ordered().filter((e) => e.kind === "note").map((e) => doc.lineAt(e.from).number));
    const out: { from: number; to: number }[] = [];
    for (const m of text.matchAll(/\|(?=([ \t]+)\|)/g)) {
      const from = m.index!;
      if (!musicLines.has(doc.lineAt(from).number)) continue;
      out.push({ from, to: from + 1 + m[1]!.length + 1 });
    }
    return out;
  }

  toggleFormatMarks(): void {
    this.showFormatMarks = !this.showFormatMarks;
    this.syncButtons();
    this.host.saveSettings();
    this.refresh();
  }

  // ---------------- 状态 ----------------

  get mode(): VisualMode {
    return this.host.view.state.selection.main.empty ? "insert" : "edit";
  }

  private get pages(): SVGSVGElement[] {
    // 排版稿是 `svg.score-page`，识别核对视图是 `svg.omr-recognize`
    return [...this.host.scorePane.querySelectorAll<SVGSVGElement>("svg.score-page, svg.omr-recognize")];
  }

  /** 按原文顺序、方向键能停的条目。 */
  private navigable(): SyncEntry[] {
    return this.host.sync.ordered().filter((e) => NAVIGABLE.has(e.kind));
  }

  /** 换了一份文档（打开、导入、识别落地）：弱起重新认。 */
  documentLoaded(): void {
    this.pickups = null;
    this.curVoice = null;
  }

  /** 重排之后（索引重建了）：把换行符号的原文位置交给代码区，再重画谱面叠加层。 */
  afterRebuild(): void {
    const spans = this.host.sync.breaks().flatMap((b) => (b.span ? [b.span] : []));
    const doc = this.host.syncDoc();
    if (doc && this.pickups === null) {
      // 打开后第一次查：不放过弱起查一遍，首小节不满的声部才认它是弱起。之后改谱把首小节改短了照样报
      const strict = checkMeasureDurations(doc, { pickup: () => false });
      this.pickups = new Set(strict.filter((i) => i.measureIndex === 0 && i.got < i.want).map((i) => `${i.songIndex}:${i.partIndex}`));
    }
    const pickups = this.pickups;
    this.beatIssues = this.beatCheck && doc && this.host.visualEnabled()
      ? checkMeasureDurations(doc, { pickup: (s, p) => pickups?.has(`${s}:${p}`) ?? true })
      : [];
    this.emptyBars = this.beatCheck && doc && this.host.visualEnabled() ? this.findEmptyBars() : [];
    this.beatCursor = -1;
    const beatSpans = [
      ...this.beatIssues.flatMap((i) => (i.source ? [{ from: i.source.offset, to: i.source.offset + i.source.length }] : [])),
      ...this.emptyBars,
    ].sort((a, b) => a.from - b.from);
    this.host.view.dispatch({
      effects: [setBreakSpans.of(this.showFormatMarks ? spans : []), setBeatSpans.of(beatSpans)],
    });
    this.refresh();
  }

  /** 重画谱面叠加层与模式标签。选区一动、重排之后、焦点进出都要调。 */
  refresh(): void {
    const pages = this.pages;
    clearOverlay(pages, undefined, "vis-beat");
    this.breakEls.clear();
    const on = this.host.visualEnabled();
    if (this.selInfoEl) {
      const first = on && !this.host.view.state.selection.main.empty ? this.selectedEntries().find((e) => e.kind === "note") : undefined;
      const info = first ? selectionInfo(this.host.syncDoc(), first.id) : null;
      this.selInfoEl.hidden = !info;
      this.selInfoEl.textContent = info ?? "";
      this.selInfoEl.title = info ?? "";
    }
    if (this.modeEl) {
      this.modeEl.hidden = !on;
      this.modeEl.textContent = this.mode === "edit" ? tr("vis.modeEdit") : tr("vis.modeInsert", { dur: durName(this.curDur) }) + (this.curVoice !== null ? tr("vis.modeVoice", { n: this.curVoice }) : "");
      this.modeEl.dataset.mode = this.mode;
    }
    if (this.paletteEl) {
      this.paletteEl.hidden = !(on && this.showPalette);
      this.paletteRefresh?.();
    }
    if (this.beatEl) {
      const n = on ? this.beatIssues.length + this.emptyBars.length : 0;
      this.beatEl.hidden = n === 0;
      this.beatEl.textContent = tr("beat.count", { n });
    }
    this.drawBeatIssues(on ? this.beatIssues : [], on ? this.emptyBars : []);
    if (!on) return;
    const sel = this.host.view.state.selection.main;
    if (this.pickedBreak && (!sel.empty || sel.head !== this.pickedBreak.sel)) this.pickedBreak = null;
    if (this.showFormatMarks) this.drawBreaks(sel.from, sel.to);
    // 光标与方块都只在谱面有焦点时画（没点过谱面不亮光标）；双击改字时焦点在代码区，字里的光标照画
    const focused = document.activeElement === this.host.scorePane;
    if (sel.empty) {
      if (focused || this.textEditing) this.drawInsertCaret(sel.head);
    } else if (focused) this.drawEditBlock(sel.from, sel.to);
  }

  /** 一个条目在谱面上的 `<g>`。小节线与增时线有自己的（它们在模型里不按自己的 id 定位，
   *  见 `VisualHost.barlineEl` / `sustainEl`）；取不到就退回宿主音符那个（旧行为）。 */
  private elOf(entry: SyncEntry): SVGGraphicsElement | null {
    return this.ownEl(entry) ?? this.host.entryEl(entry);
  }

  /** 条目在谱面上的元素（给弹出框定位）。 */
  elOfEntry(e: SyncEntry): SVGGraphicsElement | null {
    return this.elOf(e);
  }

  /** 条目**自己**那个图元（没有就 null，不退回宿主音符）：小节线、增时线、弧。 */
  private ownEl(entry: SyncEntry): SVGGraphicsElement | null {
    if (entry.kind === "barline") return this.host.barlineEl(entry);
    if (entry.kind === "sustain") return this.host.sustainEl(entry);
    if (entry.kind === "mark" && entry.markKind === "slur") return this.host.slurEl(entry);
    return null;
  }

  private boxOf(entry: SyncEntry): { svg: SVGSVGElement; box: Box } | null {
    const el = this.elOf(entry);
    return el ? this.elBox(el) : null;
  }

  /** 元素的框：简谱取音乐那部分（`musicBox`）；五线谱的和弦组没有「数字 + 歌词」那种结构，
   *  整组就是音乐部分，而 Bravura 字形要按墨迹量（`inkBoxInPage`）。 */
  private elBox(el: SVGGraphicsElement): { svg: SVGSVGElement; box: Box } | null {
    return this.host.surfaceKind() === "staff" ? inkBoxInPage(el) : musicBox(el);
  }

  /** 光标竖线要罩的那一带：五线谱 / 识别核对取谱表带（横向仍按元素框），简谱取本行音符数字的字框（`digitBand`）。 */
  private caretBox(entry: SyncEntry, hit: { svg: SVGSVGElement; box: Box }): Box {
    const band = this.host.caretBand(entry) ?? (this.host.surfaceKind() === "jianpu" ? this.digitBand(entry, hit) : null);
    return band && band.svg === hit.svg ? { x: hit.box.x, y: band.y, w: hit.box.w, h: band.h } : hit.box;
  }

  /** 简谱：离这个条目最近、同一行的音符的数字字框（音符 `<g>` 的第一个子元素）。同字号的数字字框等高、同基线，
   *  光标在一行音符里走就不再随和弦、八度点、小节线的框忽高忽低。 */
  private digitBand(entry: SyncEntry, hit: { svg: SVGSVGElement; box: Box }): { svg: SVGSVGElement; y: number; h: number } | null {
    const nav = this.navigable();
    const k = nav.indexOf(entry);
    if (k < 0) return null;
    for (let d = 0; d < 8; d++) {
      for (const e of d === 0 ? [nav[k]] : [nav[k - d], nav[k + d]]) {
        if (e?.kind !== "note") continue;
        const digit = this.host.entryEl(e)?.firstElementChild;
        const b = digit instanceof SVGGraphicsElement ? boxInPage(digit) : null;
        if (b && b.svg === hit.svg && b.box.h > 0 && sameRow(b.box, hit.box)) return { svg: b.svg, y: b.box.y, h: b.box.h };
      }
    }
    return null;
  }

  /** 拍数不对的小节：它的音符按行各圈一个淡红底；空小节圈前后两个音之间的空当。 */
  private drawBeatIssues(issues: readonly BeatIssue[], empties: readonly { from: number; to: number }[]): void {
    const perPage = new Map<SVGSVGElement, { box: Box; title: string; tag?: string }[]>(this.pages.map((p) => [p, []]));
    for (const issue of issues) {
      const boxes: { svg: SVGSVGElement; box: Box }[] = [];
      for (const id of issue.ids) {
        // 整个和弦框进来（只框第一个音，差额标签就抬到和弦上音的音名上去了）
        const one = this.host.noteEl(id);
        let hit: { svg: SVGSVGElement; box: Box } | null = null;
        for (const el of this.host.chordEls?.(id) ?? (one ? [one] : [])) {
          const h = this.elBox(el);
          if (h) hit = hit && hit.svg === h.svg ? { svg: hit.svg, box: union(hit.box, h.box) } : hit ?? h;
        }
        if (!hit) continue;
        const same = boxes.find((b) => b.svg === hit.svg && sameRow(b.box, hit.box));
        if (same) same.box = union(same.box, hit.box);
        else boxes.push(hit);
      }
      const title = tr("beat.measure", { n: issue.measureIndex + 1, issue: describeBeatIssue(issue) });
      const tag = beatTag(issue);
      // 一小节跨了几处（换行、几行谱）只在第一处标差额
      boxes.forEach((b, k) => perPage.get(b.svg)?.push({ box: b.box, title, ...(k === 0 ? { tag } : {}) }));
    }
    // 空小节：谱面上没有它的音符，框住前后两个音之间的空当（前后不在同一行就在前一个音后面留一格）
    const notes = empties.length ? this.host.sync.ordered().filter((e) => e.kind === "note") : [];
    for (const empty of empties) {
      const prev = [...notes].reverse().find((e) => e.to <= empty.from);
      const next = notes.find((e) => e.from >= empty.to);
      const pb = prev ? this.boxOf(prev) : null;
      const nb = next ? this.boxOf(next) : null;
      const ref = pb ?? nb;
      if (!ref) continue;
      const h = ref.box.h;
      let x0 = pb ? pb.box.x + pb.box.w + h * 0.6 : nb!.box.x - h * 1.8;
      let x1 = x0 + h * 1.2;
      if (pb && nb && nb.svg === pb.svg && sameRow(pb.box, nb.box)) {
        x0 = pb.box.x + pb.box.w + h * 0.4;
        x1 = Math.max(x0 + h * 0.6, nb.box.x - h * 0.4);
      }
      perPage.get(ref.svg)?.push({ box: { x: x0, y: ref.box.y, w: x1 - x0, h }, title: tr("beat.empty") });
    }
    for (const [svg, items] of perPage) setBeatIssues(svg, items);
  }

  private drawBreaks(selFrom: number, selTo: number): void {
    const cache = new Map<SVGSVGElement, Box[]>();
    for (const b of this.host.sync.breaks()) {
      const el = this.host.noteEl(b.after);
      const hit = el && this.elBox(el);
      if (!hit) continue;
      const selected = b.span
        ? b.span.from >= selFrom && b.span.to <= selTo && selTo > selFrom
        : this.pickedBreak?.after === b.after || this.newlineSelected(b, selFrom, selTo);
      const x = rightEdgeInBand(hit.svg, hit.box, cache);
      this.breakEls.set(drawBreak(hit.svg, x, hit.box, b.page, selected), b);
    }
  }

  /** 插入光标：画在光标前那个元素的右缘；光标在行首（前后两个元素不同行）时画在后一个的左缘。 */
  private drawInsertCaret(head: number): void {
    if (this.drawTextCaret(head)) return;
    const inside = this.host.sync.at(head);
    if (inside && inside.from < head) return; // 光标落在 token 中间：那是在改原文，谱面上已高亮该元素
    const nav = this.navigable();
    let prev: SyncEntry | null = null;
    let next: SyncEntry | null = null;
    for (const e of nav) {
      if (e.to <= head) prev = e;
      else if (e.from >= head) {
        next = e;
        break;
      }
    }
    let pb = prev && prev.kind !== "break" ? this.boxOf(prev) : null;
    const nb = next && next.kind !== "break" ? this.boxOf(next) : null;
    // 前一项在谱面上没有框（识别核对里的小节线），后一项也没有：退到再往前最近一个有框的，别让光标消失
    if (prev && !pb && !nb && prev.kind !== "break") {
      for (let k = nav.indexOf(prev) - 1; k >= 0 && !pb; k--) {
        if (nav[k]!.kind === "break") break;
        pb = this.boxOf(nav[k]!);
        if (pb) prev = nav[k]!;
      }
    }
    const brokeBetween = prev?.kind === "break";
    const gap = (b: Box): number => Math.min(b.h, b.w * 2) * 0.12;
    const staff = this.host.surfaceKind() !== "jianpu";
    // 五线谱 / 识别核对：同一行的两个音之间，光标画在正中（贴着符头右缘会压在符干、符尾上；核对框又紧）
    if (staff && pb && nb && !brokeBetween && nb.svg === pb.svg && sameRow(pb.box, nb.box) && nb.box.x > pb.box.x) {
      drawCaret(pb.svg, (pb.box.x + pb.box.w + nb.box.x) / 2, this.caretBox(prev!, pb));
      return;
    }
    if (pb && !brokeBetween && (!nb || nb.svg !== pb.svg || sameRow(pb.box, nb.box))) {
      drawCaret(pb.svg, pb.box.x + pb.box.w + gap(pb.box), this.caretBox(prev!, pb));
    } else if (nb) {
      drawCaret(nb.svg, nb.box.x - gap(nb.box), this.caretBox(next!, nb));
    } else if (pb) {
      drawCaret(pb.svg, pb.box.x + pb.box.w + gap(pb.box), this.caretBox(prev!, pb));
    }
  }

  /** 光标落在文字条目（歌词、页眉字段）里或两端：谱面上画在那串字里对应的位置。画了返回 true。 */
  private drawTextCaret(head: number): boolean {
    // 和弦名只在双击进来的改字会话里画字里的光标：平时光标停在它两端是在音符之间
    const e = this.host.sync.ordered().find((x) => (isText(x) || (this.textEditing && isChordName(x))) && head >= x.from && head <= x.to);
    if (!e) return false;
    const src = this.host.view.state.doc.sliceString(e.from, e.to);
    const texts = this.host.textEls(e).flatMap(textsOf);
    for (const t of texts) {
      const disp = t.textContent ?? "";
      const shift = textShift(disp, src);
      if (shift === null) continue;
      const di = head - e.from - shift;
      if (di < 0 || di > disp.length) continue;
      const c = textCaretInPage(t, di);
      if (!c) continue;
      drawCaret(c.svg, c.x, c.box, this.textCaretStyle(c.svg));
      return true;
    }
    // 字对不上（`♭B` 对 `bB`、叠排的拍号）：画在这一项的右边
    const els = this.host.textEls(e);
    const boxes = els.map((el) => boxInPage(el)).filter((b): b is { svg: SVGSVGElement; box: Box } => !!b);
    if (boxes.length === 0) return false;
    const box = boxes.slice(1).reduce((a, b) => (b.svg === a.svg ? { svg: a.svg, box: union(a.box, b.box) } : a), boxes[0]!);
    drawCaret(box.svg, box.box.x + box.box.w + box.box.h * 0.12, box.box, this.textCaretStyle(box.svg));
    return true;
  }

  /** 文字 / 和弦名里的光标与音符间的光标同一个样子：线宽取这一页音符光标的（按音符那一带的高度），改字会话里照闪。 */
  private textCaretStyle(svg: SVGSVGElement): { width?: number; live: boolean } {
    for (const e of this.navigable()) {
      if (e.kind !== "note") continue;
      const hit = this.boxOf(e);
      if (hit?.svg === svg) return { width: caretWidth(this.caretBox(e, hit).h), live: this.textEditing };
    }
    return { live: this.textEditing };
  }

  /** 编辑方块：选区罩住的元素，按页、按行各画一个。 */
  private drawEditBlock(from: number, to: number): void {
    // Alt+点击选中的和弦音：方块只罩那个符头
    const pn = this.pickedChordNote();
    if (pn) {
      const e = this.host.sync.ordered().find((x) => x.kind === "note" && x.id === pn.id);
      const head = e ? this.noteheadsOf(e)[pn.index] : undefined;
      const hit = head ? inkBoxInPage(head.el) : null;
      if (hit) {
        drawBlock(hit.svg, hit.box);
        return;
      }
    }
    const dotOf = this.pickedDot();
    if (dotOf) {
      // 选中的是附点：方块只罩附点
      let hit: { svg: SVGSVGElement; box: Box } | null = null;
      for (const el of this.host.augDotEls(dotOf.id)) {
        const b = boxInPage(el);
        if (b) hit = hit ? { svg: hit.svg, box: union(hit.box, b.box) } : b;
      }
      if (hit) {
        drawBlock(hit.svg, hit.box);
        return;
      }
    }
    // 选中的是 token 里的一条增时线：方块罩它画出来的那一格
    const inline = this.pickedInlineSustain();
    if (inline) {
      const el = this.host.inlineSustainEls(inline.note.id)[inline.index];
      const hit = el && this.elBox(el);
      if (hit) {
        drawBlock(hit.svg, hit.box);
        return;
      }
    }
    // 选中的是减时线：方块罩音头下方那一带（减时线没有自己的图元，按音头的框推）
    if (this.pickedBeams()) {
      const e = this.host.sync.at(from);
      const el = e && e.kind === "note" ? this.host.entryEl(e) : null;
      const b = el?.firstElementChild ? boxInPage(el.firstElementChild as SVGGraphicsElement) : null;
      if (b) {
        drawBlock(b.svg, { x: b.box.x, y: b.box.y + b.box.h, w: b.box.w, h: b.box.h * 0.5 });
        return;
      }
    }
    const boxes: { svg: SVGSVGElement; box: Box }[] = [];
    const seen = new Set<Element>();
    const add = (hit: { svg: SVGSVGElement; box: Box }): void => {
      const same = boxes.find((b) => b.svg === hit.svg && sameRow(b.box, hit.box));
      if (same) same.box = union(same.box, hit.box);
      else boxes.push(hit);
    };
    for (const e of this.host.sync.range(from, to)) {
      if (e.kind === "break") continue;
      // 文字条目（歌词、页眉）：单击选中的就是它，罩它画出来的那几个 `<g>`
      //（署名可能多行、调号拍号一组不止一个）
      if (isText(e)) {
        for (const el of this.host.textEls(e)) {
          if (seen.has(el)) continue;
          seen.add(el);
          const hit = boxInPage(el);
          if (hit) add(hit);
        }
        continue;
      }
      const el = this.elOf(e);
      if (!el || seen.has(el)) continue;
      seen.add(el);
      const hit = this.elBox(el);
      if (!hit) continue;
      add(thin(e) ? { svg: hit.svg, box: plump(hit.box) } : hit);
    }
    for (const b of boxes) drawBlock(b.svg, b.box);
  }

  // ---------------- 点击 ----------------

  /** 谱面上的点击。处理了返回 true（App 就不再走音符点选那条路）。 */
  handleClick(ev: MouseEvent, entry: SyncEntry | null): boolean {
    if (!this.host.visualEnabled()) return false;
    if (this.swallowClick) {
      this.swallowClick = false;
      return true;
    }
    // Alt+点击和弦里的某个符头（五线谱）：单独选中这一个音（Delete 只删它）
    if (ev.altKey && entry?.kind === "note" && this.host.surfaceKind() === "staff" && this.pickChordNote(entry, ev.clientY)) return true;
    // Alt+点原图上没有东西的地方（识别核对）：在那儿补一个漏识的音 / 小节线（PhotoScore 的 Alt+点复制选中的那一样）
    if (ev.altKey && !entry) {
      const sp = this.host.sourcePoint?.(ev);
      if (sp) return this.insertAtSource(sp);
    }
    // 点在换行符号上：选中它
    const t = ev.target instanceof Element ? ev.target.closest(".vis-break") : null;
    const brk = t ? this.breakEls.get(t) : undefined;
    if (brk) {
      if (brk.span) {
        this.select(brk.span.from, brk.span.to);
        return true;
      }
      const nl = this.newlineOf(brk);
      if (nl !== null && this.host.editDialect()?.lyricBlockByCodeLine) {
        // ABC：换行就是代码行末那个换行符，选中它
        this.select(nl, nl + 1);
        return true;
      }
      // 文本谱：另起一行 `Q:`，原文里没有符号。光标落在行末，另记「点中了这处换行」
      const at = nl ?? this.host.view.state.selection.main.head;
      this.select(at, at);
      this.pickedBreak = { after: brk.after, sel: at };
      this.host.setStatus(tr("vis.puBreakSelected"));
      this.refresh();
      return true;
    }
    // 点在音符下方的减时线上：选中 token 里那串减时线。**要赶在文字分支之前**——
    // 减时线与歌词行挨得极近（歌词第一个字的顶就在音头外框下缘），落在减时线带里的点算减时线
    const jianpu = this.host.surfaceKind() === "jianpu";
    if (!ev.shiftKey && jianpu) {
      const beams = this.beamAtPoint(ev.clientX, ev.clientY);
      if (beams) {
        this.select(beams.from, beams.to);
        return true;
      }
    }
    // 点在文字上（歌词、页眉）：**单击只选中**这个文字对象（整段罩上方块，焦点留在谱面），
    // 双击才进插入模式改字（`handleDoubleClick`）——与 Sibelius 一路的手感一致
    if (entry && isText(entry)) {
      this.select(entry.from, entry.to);
      return true;
    }
    // 点在附点上（附点很小，四周放宽几像素）：只选中附点
    if (!ev.shiftKey && jianpu) {
      const dot = this.dotAtPoint(ev.clientX, ev.clientY, entry);
      if (dot) {
        this.select(dot.from, dot.to);
        return true;
      }
    }
    if (entry) {
      // Shift+点击：从原来的选区扩到这个元素
      if (ev.shiftKey) {
        const sel = this.host.view.state.selection.main;
        const span = this.spanOfEntry(entry);
        this.select(Math.min(sel.from, span.from), Math.max(sel.to, span.to));
        return true;
      }
      // 点中的是写在 token 里的增时线（`.jpwabc` 的 `5---`）画出来的那一格：选 token 里对应的那个 `-`
      const inline = this.inlineSustainAt(entry, ev.target);
      if (inline) {
        this.select(inline.from, inline.to);
        return true;
      }
      // 点音符：只选中音头（升降号、唱名、八度点），不带减时线、附点
      if (entry.kind === "note") {
        const span = this.noteSel(entry);
        this.select(span.from, span.to);
        return true;
      }
      // 点小节线、增时线、弧：选中它自己（都有自己的 `<g>`，框罩的就是它本身）
      if (entry.kind === "barline" || entry.kind === "sustain" || (entry.kind === "mark" && entry.markKind === "slur")) {
        this.select(entry.from, entry.to);
        return true;
      }
      return false; // 其余（歌词、记号）：App 的双向定位照旧
    }
    // 点空了：先看是不是差一点点没点中细线（小节线、增时线画出来只有一两像素厚）
    const near = this.thinAtPoint(ev.clientX, ev.clientY);
    if (near) {
      this.select(near.from, near.to);
      return true;
    }
    // 点在空白处：找同一行里离得最近的元素，光标落到它前面或后面（插入模式）
    const caret = this.caretAtPoint(ev.clientX, ev.clientY);
    if (caret !== null) {
      this.select(caret, caret);
      return true;
    }
    return false;
  }

  /**
   * 内联改字（`.musicxml`）：改的是 XML 原文里那几个字（纯文字改动直接局部补丁，不必整份重写）。
   * 标题在 `<work-title>` 与 `<credit-words>` 里常各写一份，原字相同的一起改，免得两处对不上。
   * 歌词里 Enter / Tab 提交后跳到同一段的下一个字接着改（Shift+Tab 往前），Esc 放弃。
   */
  private editTextInline(e: SyncEntry): void {
    const el = this.host.textEls(e)[0];
    if (!el) return;
    const raw = this.host.view.state.doc.sliceString(e.from, e.to);
    const sameVerse = (x: SyncEntry): boolean => x.kind === "lyric" && x.verseNo === e.verseNo;
    const before = this.host.sync.ordered().filter(sameVerse);
    const ord = before.findIndex((x) => x.from === e.from);
    openInlineEditor(el, unescapeXml(raw), ({ value, nav }) => {
      // 下一个 / 当前这个字按音认（改成空串时这个字的条目没了，按序号数会跳过一个）
      const nextId = e.kind === "lyric" && nav !== 0 ? before[ord + nav]?.id : undefined;
      if (value !== null && value !== unescapeXml(raw)) {
        const targets = e.kind === "header"
          ? this.host.sync.ordered().filter((x) => x.kind === "header" && this.host.view.state.doc.sliceString(x.from, x.to) === raw)
          : [e];
        this.host.view.dispatch({
          changes: targets.map((x) => ({ from: x.from, to: x.to, insert: escapeXml(value) })),
          userEvent: "input.visual",
        });
        this.host.reloadNow();
      }
      const list = this.host.sync.ordered().filter(sameVerse);
      const next = nextId !== undefined ? list.find((x) => x.id === nextId) : undefined;
      const cur = list.find((x) => x.id === e.id);
      if (next) {
        this.select(next.from, next.to);
        // 谱面是异步重排的（五线谱档），等排完、元素绑好再开下一个框
        void this.host.whenIdle().then(() => this.editTextInline(next));
        return;
      }
      if (e.kind === "lyric" && cur) this.select(cur.from, cur.to);
      this.host.scorePane.focus({ preventScroll: true });
    });
  }

  /** 点在空白处（`caretAtPoint` 那一行的最近元素）所在的那一小节：从上一条小节线（或换行）之后的第一个元素到下一条小节线之前的最后一个。 */
  private selectMeasureAt(cx: number, cy: number): boolean {
    const caret = this.caretAtPoint(cx, cy);
    if (caret === null) return false;
    const nav = this.navigable();
    const i = nav.findIndex((e) => e.from >= caret);
    const at = i < 0 ? nav.length - 1 : i;
    // 光标落在小节线前面：那是前一小节的尾巴，往回认
    const pivot = nav[at]?.kind === "barline" || nav[at]?.kind === "break" || i < 0 ? at - 1 : at;
    const isEdge = (e: SyncEntry | undefined): boolean => !e || e.kind === "barline" || e.kind === "break";
    if (isEdge(nav[pivot])) return false;
    let a = pivot;
    while (!isEdge(nav[a - 1])) a--;
    let b = pivot;
    while (!isEdge(nav[b + 1])) b++;
    this.select(nav[a]!.from, this.groupEnd(nav[b]!));
    return true;
  }

  /** 当前格式能不能做这个动作（菜单不列、面板灰掉）。 */
  available(a: VisualAction): boolean {
    const model = this.host.modelEditing();
    if (a.id === "chord.add" || a.id === "voice.set" || XML_ONLY.has(a.id)) return model;
    if (a.group === "meas") return model || !!this.host.editDialect()?.measure;
    return true;
  }

  /** 文本格式的小节操作（`measureops.ts`）。 */
  private measureText(id: string, value: string | null): boolean {
    const c = this.editCtx();
    if (!c) return true;
    return this.apply(measureEdit(c, id, value));
  }

  /** Alt+点击单独选中的和弦音；选区挪开了就作废。 */
  private pickedChordNote(): { id: ElementId; index: number } | null {
    const p = this.pickedNote;
    const sel = this.host.view.state.selection.main;
    if (!p || sel.from !== p.from || sel.to !== p.to) return null;
    return { id: p.id, index: p.index };
  }

  /** 和弦组里的各个符头（SMuFL 符头区 U+E0A0–E0FF 的字），按纵坐标从下到上（= 音从低到高）。
   *  纵坐标取字的**基线**在屏幕上的位置：SMuFL 符头的墨心就在基线上，而 `getBoundingClientRect` 给的是整行字体盒（CLAUDE.md 那条）。 */
  private noteheadsOf(entry: SyncEntry): { el: SVGTextElement; y: number }[] {
    const el = this.host.entryEl(entry);
    if (!el) return [];
    return [...el.querySelectorAll("text")]
      .filter((t) => {
        const c = t.textContent?.codePointAt(0) ?? 0;
        return c >= 0xe0a0 && c <= 0xe0ff;
      })
      .map((t) => ({ el: t, y: t.getScreenCTM() ? new DOMPoint(0, 0).matrixTransform(t.getScreenCTM()!).y : 0 }))
      .sort((a, b) => b.y - a.y);
  }

  private pickChordNote(entry: SyncEntry, cy: number): boolean {
    const heads = this.noteheadsOf(entry);
    if (heads.length < 2) return false;
    let k = 0;
    let best = Infinity;
    heads.forEach((h, i) => {
      const d = Math.abs(h.y - cy);
      if (d < best) (best = d), (k = i);
    });
    const span = this.host.sync.spanOfNote(entry.id) ?? entry;
    this.pickedNote = { id: entry.id, index: k, from: span.from, to: span.to };
    this.select(span.from, span.to);
    this.host.setStatus(tr("ve.chordNotePicked", { n: k + 1 }));
    return true;
  }

  /** 全选：谱面上第一个到最后一个元素（不带页眉、文字）。 */
  private selectAll(): boolean {
    const nav = this.navigable().filter((e) => e.kind !== "break");
    if (nav.length === 0) return false;
    this.select(nav[0]!.from, this.groupEnd(nav[nav.length - 1]!));
    return true;
  }

  /**
   * 框选：鼠标**从空白处**按下拖动超过 4px 才开框（4px 内仍是单击，照旧落插入光标）；从音符、文字上起拖不开框。
   * 松开时框里（元素框中心落在框内）的第一个到最后一个元素按原文顺序整段选中——选区只有一段，与代码区同一份。
   * 触屏不开（拖动是平移）。
   */
  private attachMarquee(pane: HTMLElement): void {
    let start: { x: number; y: number; id: number } | null = null;
    let box: HTMLDivElement | null = null;
    const rectOf = (x: number, y: number): { l: number; t: number; r: number; b: number } =>
      ({ l: Math.min(start!.x, x), t: Math.min(start!.y, y), r: Math.max(start!.x, x), b: Math.max(start!.y, y) });
    pane.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType !== "mouse" || ev.button !== 0 || ev.shiftKey || !this.host.visualEnabled()) return;
      const t = hitThroughOverlay(ev);
      if (!(t instanceof Element) || !t.closest("svg.score-page, svg.omr-recognize")) return;
      if (this.host.entryAtTarget(t) || t.closest(".vis-break")) return;
      start = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
    });
    pane.addEventListener("pointermove", (ev) => {
      if (!start || ev.pointerId !== start.id) return;
      if (!box && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      if (!box) {
        box = document.createElement("div");
        box.className = "vis-marquee";
        document.body.appendChild(box);
        pane.setPointerCapture(ev.pointerId);
      }
      const r = rectOf(ev.clientX, ev.clientY);
      Object.assign(box.style, { left: `${r.l}px`, top: `${r.t}px`, width: `${r.r - r.l}px`, height: `${r.b - r.t}px` });
    });
    const end = (ev: PointerEvent): void => {
      if (!start || ev.pointerId !== start.id) return;
      const dragged = box !== null;
      const r = rectOf(ev.clientX, ev.clientY);
      box?.remove();
      box = null;
      start = null;
      if (!dragged) return;
      this.swallowClick = true;
      setTimeout(() => (this.swallowClick = false), 0); // 松开在别处时不会补发 click，别让标志留到下一次
      const inside = this.navigable().filter((e) => {
        if (e.kind === "break") return false;
        const el = this.elOf(e);
        const b = el?.getBoundingClientRect();
        if (!b || (b.width === 0 && b.height === 0)) return false;
        const cx = (b.left + b.right) / 2;
        const cy = (b.top + b.bottom) / 2;
        return cx >= r.l && cx <= r.r && cy >= r.t && cy <= r.b;
      });
      if (inside.length === 0) return;
      this.select(inside[0]!.from, this.groupEnd(inside[inside.length - 1]!));
      this.host.scorePane.focus({ preventScroll: true });
    };
    pane.addEventListener("pointerup", end);
    pane.addEventListener("pointercancel", end);
  }

  /**
   * 拖动挂件（识谱软件 PhotoScore / Audiveris 那样）：在**已选中**的力度、文字、和弦名、歌词字、圆滑线（按下处离哪一端近就拖哪一端）上按下，
   * 移过 4px 起拖；拖动中离指针最近的那个音描框、从挂件拉一条虚线过去，松手按「隔了几个音」走一次挪动（与 Alt+←/→ 同一个动作，一步撤销）。
   * 从空白按下仍是框选、在没选中的东西上按下仍是点选，三者不冲突；触屏不开（拖动是平移）。
   */
  private attachDrag(pane: HTMLElement): void {
    type Drag = { id: number; x: number; y: number; entry: SyncEntry; which: "both" | "start" | "end"; anchor: ElementId; from: { svg: SVGSVGElement; x: number; y: number } | null; target: SyncEntry | null; moving: boolean };
    let drag: Drag | null = null;
    // 文本格式的装饰（`!mf!`、`!fermata!` 写在音前面）也能搬；MusicXML 的奏法装饰长在音符上，不挪
    const movable = (e: SyncEntry): boolean => e.kind === "lyric" ||
      (e.kind === "mark" && (e.markKind === "slur" || e.markKind === "dynamic" || e.markKind === "annotation" || e.markKind === "harmony" || e.markKind === "dir" ||
        (e.markKind === "deco" && !this.host.modelEditing())));
    const center = (b: Box): { x: number; y: number } => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    const toSvg = (svg: SVGSVGElement, x: number, y: number): { x: number; y: number } | null => {
      const m = svg.getScreenCTM();
      if (!m) return null;
      const p = new DOMPoint(x, y).matrixTransform(m.inverse());
      return { x: p.x, y: p.y };
    };
    /** 指针下离得最近的音（同一页；纵向差出一个音的高度以外加重罚，免得挂到别的谱行） */
    const nearest = (cx: number, cy: number): { e: SyncEntry; svg: SVGSVGElement; box: Box } | null => {
      const under = document.elementFromPoint(cx, cy)?.closest<SVGSVGElement>("svg.score-page, svg.omr-recognize");
      if (!under) return null;
      const p = toSvg(under, cx, cy);
      if (!p) return null;
      let best: { e: SyncEntry; svg: SVGSVGElement; box: Box } | null = null;
      let bd = Infinity;
      for (const e of this.host.sync.ordered()) {
        if (e.kind !== "note") continue;
        const b = this.boxOf(e);
        if (!b || b.svg !== under) continue;
        const c = center(b.box);
        const d = Math.abs(c.x - p.x) + 3 * Math.max(0, Math.abs(c.y - p.y) - b.box.h);
        if (d < bd) (bd = d), (best = { e, ...b });
      }
      return best;
    };
    pane.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType !== "mouse" || ev.button !== 0 || ev.shiftKey || ev.altKey || !this.host.visualEnabled()) return;
      const sel = this.host.view.state.selection.main;
      if (sel.empty) return;
      // 按在选中那一样的框里（略放宽）就算按住了它：细线（弧）不好按准，与别的记号叠在一起时也以选中的为准
      let e = this.host.entryAtTarget(hitThroughOverlay(ev));
      const cur = this.host.sync.ordered().find((x) => x.from === sel.from && x.to === sel.to && movable(x));
      if (cur && e !== cur) {
        const r = (cur.kind === "mark" && cur.markKind === "slur" ? this.host.slurEl(cur) : null)?.getBoundingClientRect() ?? this.elOf(cur)?.getBoundingClientRect();
        const pad = r ? Math.max(r.height, 6) * 0.3 : 0;
        if (r && ev.clientX >= r.left - pad && ev.clientX <= r.right + pad && ev.clientY >= r.top - pad && ev.clientY <= r.bottom + pad) e = cur;
      }
      if (!e || !movable(e)) return;
      const picked = (e.from === sel.from && e.to === sel.to) || (!!e.pair && e.pair.from === sel.from && e.pair.to === sel.to);
      if (!picked) return;
      let which: Drag["which"] = "both";
      let anchor = e.id;
      if (e.kind === "mark" && e.markKind === "slur" && e.end !== undefined) {
        // 按在弧的右半边拖终点、左半边拖起点（短弧两头的音挨得近，按离哪个音近判会判反）
        const r = (this.host.slurEl(e) ?? this.elOf(e))?.getBoundingClientRect();
        which = !r || ev.clientX >= r.left + r.width / 2 ? "end" : "start";
        anchor = which === "end" ? e.end : e.id;
      }
      ev.stopImmediatePropagation();
      const own = this.boxOf(e);
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, entry: e, which, anchor, from: own ? { svg: own.svg, ...center(own.box) } : null, target: null, moving: false };
    });
    pane.addEventListener("pointermove", (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      if (!drag.moving && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 4) return;
      if (!drag.moving) {
        drag.moving = true;
        try {
          pane.setPointerCapture(ev.pointerId);
        } catch {
          // 指针已经松开（合成事件、窗口外松手）：不抓也照样能拖完
        }
      }
      const n = nearest(ev.clientX, ev.clientY);
      drag.target = n?.e ?? null;
      if (n) {
        const from = drag.from && drag.from.svg === n.svg ? drag.from : toSvg(n.svg, drag.x, drag.y) ?? center(n.box);
        drawDragHint(n.svg, from, n.box);
      } else clearDragHints();
    });
    const end = (ev: PointerEvent): void => {
      if (!drag || ev.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      clearDragHints();
      if (!d.moving) return;
      this.swallowClick = true;
      setTimeout(() => (this.swallowClick = false), 0);
      if (!d.target || ev.type === "pointercancel") return;
      let delta = this.voiceSteps(d.anchor, d.target.id, d.entry);
      if (delta === null) {
        this.host.setStatus(tr("ve.dragSameVoice"));
        return;
      }
      // 挂在小节末（最后一个音之后）的：拖到第 n 个音前，往前（含那最后一个音）要多算一格，与键盘的 Alt+← 口径对上
      if (d.entry.dirEnd && delta <= 0) delta -= 1;
      if (delta === 0) return;
      this.host.scorePane.focus({ preventScroll: true });
      if (this.host.modelEditing()) moveSelected(this.modelCtx, delta, false, d.which);
      else this.moveText(delta, false, d.which);
    };
    pane.addEventListener("pointerup", end);
    pane.addEventListener("pointercancel", end);
  }

  /**
   * Alt+点原图补漏识：选中的是小节线就在那儿补一条小节线（拆小节）；否则补一个音——五线谱音高按点的位置、时值照选中的音，
   * 简谱照抄选中的那个音的原文（没选中音时说明一下）。插完选中新音（编辑模式），接着 ↑↓、数字键改。
   */
  private insertAtSource(sp: { after: ElementId | null; before: ElementId | null; pitch?: { step: "A" | "B" | "C" | "D" | "E" | "F" | "G"; octave: number } }): boolean {
    const sync = this.host.sync;
    const sel = this.host.view.state.selection.main;
    const picked = sync.ordered().find((e) => e.from === sel.from && e.to === sel.to);
    const after = sp.after !== null ? sync.ordered().find((e) => e.kind === "note" && e.id === sp.after) : undefined;
    const before = sp.before !== null ? sync.ordered().find((e) => e.kind === "note" && e.id === sp.before) : undefined;
    this.host.scorePane.focus({ preventScroll: true });
    if (picked?.kind === "barline") {
      if (!after) return this.status(tr("ve.cantInsert"));
      const at = this.groupEnd(after);
      this.select(at, at);
      return this.runById("bar.insert");
    }
    if (this.host.modelEditing()) {
      if (!sp.pitch) return this.status(tr("ve.cantInsert"));
      return insertAtSourceModel(this.modelCtx, { after: sp.after, before: sp.before }, sp.pitch);
    }
    const c = this.editCtx();
    if (!c) return true;
    const ref = this.selectedEntries().find((e) => e.kind === "note");
    if (!ref) return this.status(tr("ve.altClickNeedsNote"));
    // 照抄选中的音（连同它的增时线）：简谱的音高从位置推不出来，PhotoScore 的 Alt+点也是复制选中的那一样。
    // 五线谱识别的对照（原文换成了 ABC / 123）给了音高：音头改成点的那个音高，时值照抄
    let tok = c.state.doc.sliceString(ref.from, this.groupEnd(ref));
    const pos = after ? this.groupEnd(after) : before ? before.from : null;
    if (pos === null) return this.status(tr("ve.cantInsert"));
    const doc = this.host.syncDoc();
    const refPitch = sp.pitch && doc ? pitchAt(doc, ref.id) : undefined;
    if (sp.pitch && refPitch) {
      const head = retargetToken(c, ref.from, c.state.doc.sliceString(ref.from, ref.to), refPitch, sp.pitch);
      if (typeof head !== "string") return this.status(head.error);
      tok = head + tok.slice(ref.to - ref.from);
    }
    const out = insertToken(c, pos, tok);
    if (isError(out)) return this.apply(out);
    // 选中刚补的那个音（跳过前面补的空格；补丁就这一处，落点就是 `pos`）
    const lead = /^\s*/.exec(out.changes[0]!.insert)?.[0].length ?? 0;
    return this.apply({ ...out, anchor: pos + lead, head: pos + lead + (tok.length - (this.groupEnd(ref) - ref.to)) });
  }

  private status(text: string): true {
    this.host.setStatus(text);
    return true;
  }

  /**
   * 从 `from` 那个音到 `to` 那个音，在同一声部同一声线里隔了几个「能挂的音」（往后为正）；不在同一声线为 null。
   * 能挂的音照各动作的口径：弧跳过休止与倚音，歌词只算能配字的（休止只在本来挂着字时算），其余跳过倚音。
   */
  private voiceSteps(from: ElementId, to: ElementId, what: SyncEntry): number | null {
    const doc = this.host.syncDoc();
    const a = doc ? locate(doc, from) : null;
    const b = doc ? locate(doc, to) : null;
    if (!a || !b || a.si !== b.si || a.pi !== b.pi || a.chord.voice !== b.chord.voice) return null;
    const ok = (c: Chord): boolean => !c.grace && (what.kind === "lyric" ? (c.lyricAnchor ?? (!c.rest || !!c.lyrics?.length))
      : what.markKind === "slur" ? !c.rest : true);
    const seq = a.part.measures.flatMap((m) => m.elements.filter((e): e is Chord => e.kind === "chord" && e.voice === a.chord.voice && ok(e)));
    const i = seq.indexOf(a.chord);
    const j = seq.indexOf(b.chord);
    return i < 0 || j < 0 ? null : j - i;
  }

  /** 谱面上的双击：文字对象由此进插入模式——光标落在原文里点中的那个字前后，焦点交给代码区，
   *  接着打字就是改原文（谱面焦点下数字键是插音符，不能留在谱面上）。处理了返回 true。
   *
   *  浏览器先发两次 `click` 再发 `dblclick`：第一下已经把这个文字对象选中了，这里再覆盖成插入光标，
   *  所以不必自己做点击计时。 */
  handleDoubleClick(ev: MouseEvent, entry: SyncEntry | null): boolean {
    if (!this.host.visualEnabled()) return false;
    // 双击小节里的空白：选中整小节（第一下 click 已落了插入光标，这里覆盖成选区；双击音符不做事）
    if (!entry) return this.selectMeasureAt(ev.clientX, ev.clientY);
    if (!isText(entry) && !isChordName(entry)) return false;
    // 没有可见代码区（`.musicxml`）：就地弹输入框改字
    if (this.host.modelEditing()) {
      if (!isText(entry)) return false;
      this.editTextInline(entry);
      return true;
    }
    const at = this.textCaretAt(entry, ev.clientX, ev.clientY);
    // 先置上改字会话再挪焦点：谱面失焦那次重画要认得出这是改字（字里照画光标），最后按新状态再画一遍
    this.textEditing = true;
    this.select(at, at);
    this.host.view.focus();
    this.refresh();
    return true;
  }

  /** 双击文字进来、焦点在代码区改字时的 Enter / Shift+Enter（代码区键位，`app.ts`）：
   *  歌词里在这个字的音处换行 / 换页（光标在字前 = 这个音之前，否则之后），按格式改原文，焦点回谱面；
   *  页眉字段里结束改字，回到谱面选中这个字段。光标不在文字里时返回 false，代码区照常插换行。 */
  textEnter(page: boolean): boolean {
    if (!this.textEditing || !this.host.visualEnabled() || this.host.modelEditing()) return false;
    if (!this.host.syncFresh()) this.host.reloadNow();
    const sel = this.host.view.state.selection.main;
    if (!sel.empty) return false;
    const head = sel.head;
    const e = this.host.sync.ordered().find((x) => (isText(x) || isChordName(x)) && head >= x.from && head <= x.to);
    if (!e) return false;
    this.textEditing = false;
    const pane = this.host.scorePane;
    if (e.kind === "header" || isChordName(e)) {
      this.select(e.from, e.to);
      pane.focus({ preventScroll: true });
      return true;
    }
    const note = this.entryOfElement(e.id);
    pane.focus({ preventScroll: true });
    if (!note) {
      this.host.setStatus(tr("vis.selectNote"));
      return true;
    }
    return this.insertBreakAt(page, head === e.from ? note.from : this.groupEnd(note));
  }

  /** 点在文字条目的哪个字前后 → 原文偏移。字对不上（`♭B` 对 `bB`、叠排的拍号）时按点在那一项的左半还是右半落到字段两端。 */
  private textCaretAt(e: SyncEntry, cx: number, cy: number): number {
    const src = this.host.view.state.doc.sliceString(e.from, e.to);
    let best: SVGTextElement | null = null;
    let bestD = Infinity;
    for (const el of this.host.textEls(e)) {
      for (const t of textsOf(el)) {
        const r = t.getBoundingClientRect();
        const d = Math.max(0, r.left - cx, cx - r.right) + Math.max(0, r.top - cy, cy - r.bottom);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
    }
    if (!best) return e.to;
    const disp = best.textContent ?? "";
    const i = charIndexAt(best, cx, cy);
    const shift = textShift(disp, src);
    if (shift === null) return i <= disp.length / 2 ? e.from : e.to;
    return e.from + Math.max(0, Math.min(src.length, i + shift));
  }

  /** 点击点落在哪条小节线 / 增时线**附近**（它们画出来只有一两像素厚，正中很难点）。
   *  只在点空了的时候才问它——落在音符上的点击照旧归音符，不抢。 */
  private thinAtPoint(cx: number, cy: number): SyncEntry | null {
    const PAD = 5; // 屏幕像素
    let best: { e: SyncEntry; d: number } | null = null;
    for (const e of this.host.sync.ordered()) {
      if (!thin(e)) continue;
      // 只认它自己的 `<g>`：取不到时 `elOf` 会退回宿主音符，那个框大得会乱抢点击
      const el = this.ownEl(e);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const dx = Math.max(0, r.left - cx, cx - r.right);
      const dy = Math.max(0, r.top - cy, cy - r.bottom);
      if (dx > PAD || dy > PAD) continue;
      if (!best || dx + dy < best.d) best = { e, d: dx + dy };
    }
    return best?.e ?? null;
  }

  /** 点击点落在哪个音符的附点上（先看点中的那个音符，再看同一带里别的音符）；返回附点的原文区间。 */
  private dotAtPoint(cx: number, cy: number, entry: SyncEntry | null): { from: number; to: number } | null {
    const c = this.editCtx(true);
    if (!c) return null;
    const notes = entry?.kind === "note" ? [entry] : [];
    for (const e of this.navigable()) if (e.kind === "note" && e !== entry) notes.push(e);
    for (const e of notes) {
      const els = this.host.augDotEls(e.id);
      if (els.length === 0) continue;
      const hit = els.some((el) => {
        const r = el.getBoundingClientRect();
        const pad = Math.max(4, r.height);
        return cx >= r.left - pad && cx <= r.right + pad && cy >= r.top - pad && cy <= r.bottom + pad;
      });
      if (!hit) continue;
      const dots = noteSpans(c, e).dots;
      if (dots) return dots;
    }
    return null;
  }

  /** 点击点落在哪个音符的减时线上（音头正下方那一条带）。
   *
   *  减时线在模型里不是对象（时值的派生量，见 `docs/模块/模型-scoredoc.md`），谱面上也没有独立 `<g>`，
   *  所以照附点那套按几何认：认出来选中的是 token 里那串减时线符号（`_` / 文本谱的 `/`）。 */
  private beamAtPoint(cx: number, cy: number): { from: number; to: number } | null {
    const c = this.editCtx(true);
    if (!c) return null;
    for (const e of this.navigable()) {
      if (e.kind !== "note") continue;
      const beams = noteSpans(c, e).beams;
      if (!beams) continue;
      const el = this.host.entryEl(e);
      // 量的是**音头那个数字**（`<g>` 里第一个子项，同 `musicBox` 的锚），不是整个音符格——
      // 格子是连歌词一起算的，下缘会落到歌词底下去
      const digit = el?.firstElementChild ?? el;
      if (!digit) continue;
      const r = digit.getBoundingClientRect();
      if (r.height <= 0) continue;
      // 减时线紧贴数字下缘：旧简谱引擎画在外框下缘**略上方**（字形墨迹之下、外框之内），
      // 原样文档画在下缘之下。带子按字高取比例罩住这两处，**不能再往下伸**——
      // 歌词行紧接着就从下缘起头（实测第一个字的顶就在下缘 ±0），伸过去就把歌词的点击抢了
      if (cx < r.left - 3 || cx > r.right + 3) continue;
      if (cy < r.bottom - r.height * 0.35 || cy > r.bottom + r.height * 0.4) continue;
      return beams;
    }
    return null;
  }

  /** 点中的是不是某个音符**写在 token 里**的增时线（`.jpwabc`）画出来的那一格；是就给出那个 `-` 的区间。
   *
   *  这种增时线在模型里没有自己的对象（写在音符 token 里），谱面上却各画一格——
   *  点中第几格就选 token 里第几个 `-`，照附点、减时线那套「选 token 里的一段」。 */
  private inlineSustainAt(entry: SyncEntry, target: EventTarget | null): { from: number; to: number } | null {
    if (entry.kind !== "note" || !(target instanceof Element)) return null;
    const cells = this.host.inlineSustainEls(entry.id);
    const i = cells.findIndex((el) => el === target || el.contains(target));
    if (i < 0) return null;
    const c = this.editCtx(true);
    const run = c && noteSpans(c, entry).sustains;
    if (!run || run.from + i >= run.to) return null;
    return { from: run.from + i, to: run.from + i + 1 };
  }

  /** 选区恰好是 token 里的一个 `-` 时，返回那个音符与它是第几条。 */
  private pickedInlineSustain(): { note: SyncEntry; index: number } | null {
    const sel = this.host.view.state.selection.main;
    if (sel.empty || sel.to - sel.from !== 1) return null;
    const c = this.editCtx(true);
    const e = c && this.host.sync.at(sel.from);
    if (!c || !e || e.kind !== "note") return null;
    const run = noteSpans(c, e).sustains;
    if (!run || sel.from < run.from || sel.from >= run.to) return null;
    return { note: e, index: sel.from - run.from };
  }

  /** 选区恰好是某个音符的减时线时，返回那串减时线的区间。 */
  private pickedBeams(): { from: number; to: number } | null {
    const sel = this.host.view.state.selection.main;
    if (sel.empty) return null;
    const c = this.editCtx(true);
    const e = c && this.host.sync.at(sel.from);
    if (!c || !e || e.kind !== "note") return null;
    const beams = noteSpans(c, e).beams;
    return beams && beams.from === sel.from && beams.to === sel.to ? beams : null;
  }

  /** 选区恰好是某个音符的附点时，返回那个音符。 */
  pickedDot(): SyncEntry | null {
    const sel = this.host.view.state.selection.main;
    if (sel.empty) return null;
    const c = this.editCtx(true);
    const e = c && this.host.sync.at(sel.from);
    if (!c || !e || e.kind !== "note" || sel.to > e.to) return null;
    const dots = noteSpans(c, e).dots;
    return dots && dots.from === sel.from && dots.to === sel.to ? e : null;
  }

  /** 换行前那个元素所在代码行的行末（换行符的位置）。 */
  private newlineOf(b: BreakMark): number | null {
    const note = this.host.sync.spanOfNote(b.after);
    if (!note) return null;
    return this.host.view.state.doc.lineAt(note.to).to;
  }

  private newlineSelected(b: BreakMark, from: number, to: number): boolean {
    if (to !== from + 1) return false;
    return this.newlineOf(b) === from;
  }

  /** 原文里没有符号可指的换行（ABC 的代码行末、文本谱另起一行 `Q:`），连同它的位置：挂换行那个音所在代码行的行末。
   *  它们不进索引条目，方向键、插入模式的删除要另外认。 */
  private virtualBreaks(): { b: BreakMark; nl: number }[] {
    if (this.host.modelEditing()) return [];
    const out: { b: BreakMark; nl: number }[] = [];
    for (const b of this.host.sync.breaks()) {
      if (b.span) continue;
      const nl = this.newlineOf(b);
      if (nl !== null) out.push({ b, nl });
    }
    return out;
  }

  /** 插入光标贴着一处虚拟换行时（往前删在本行行首、往后删在本行行末），返回这处换行与它两边同一声线的元素。
   *  按光标所在的声线看：多声部时换行符只挂在第一声部上（换的是整个系统），别的声部那一行的行首、行末也算贴着它；
   *  原文顺序上的前一个元素可能是别的声部的，不能拿来比。 */
  private virtualBreakBeside(pos: number, dir: -1 | 1): { b: BreakMark; nl: number; prev: SyncEntry; next: SyncEntry } | null {
    const vbs = this.virtualBreaks();
    const doc = this.host.syncDoc();
    if (!vbs.length || !doc) return null;
    const nav = this.navigable();
    const text = this.host.view.state.doc;
    const line = text.lineAt(pos);
    const onLine = (e: SyncEntry): boolean => e.from >= line.from && e.to <= line.to;
    const isNote = (e: SyncEntry): boolean => e.kind === "note" || e.kind === "sustain";
    // 光标那一侧在本行不能再有元素
    if (nav.some((e) => onLine(e) && (dir < 0 ? e.to <= pos : e.from >= pos))) return null;
    // 光标另一侧本行紧挨着的那个音，与它在同一声线里隔着换行的邻居
    const near = dir < 0 ? nav.find((e) => e.from >= pos && onLine(e) && isNote(e)) : [...nav].reverse().find((e) => e.to <= pos && onLine(e) && isNote(e));
    if (!near) return null;
    const ord = voiceOrdinal(doc, near.id);
    const otherId = ord ? elementAtOrdinal(doc, ord.key, ord.k + (dir < 0 ? -1 : 1)) : null;
    const other = otherId === null ? null : this.entryOfElement(otherId);
    if (!other || text.lineAt(other.from).number === line.number) return null;
    const [prev, next] = dir < 0 ? [other, near] : [near, other];
    // prev 与 next 之间的那处：next 之前最后一处
    const v = [...vbs].reverse().find((x) => x.nl < next.from);
    if (!v) return null;
    // ABC 各声部的代码行各管各的：只认挂换行的那条声线自己（别的声部那里删不了第一声部的代码行）
    if (this.host.editDialect()?.lyricBlockByCodeLine && v.b.after !== prev.id) return null;
    return { ...v, prev, next };
  }

  /** 一个元素（音符 / 休止）的索引条目。 */
  private entryOfElement(id: ElementId): SyncEntry | null {
    const span = this.host.sync.spanOfNote(id);
    return span ? this.navigable().find((e) => e.kind === "note" && e.from === span.from) ?? null : null;
  }

  /** 选中一处虚拟换行：ABC 选中代码行末的换行符，文本谱光标落行末并记下「点中了这处换行」（与点谱面上的换行符同）。 */
  private pickVirtualBreak(v: { b: BreakMark; nl: number }): void {
    if (this.host.editDialect()?.lyricBlockByCodeLine) {
      this.select(v.nl, v.nl + 1);
      return;
    }
    this.select(v.nl, v.nl);
    this.pickedBreak = { after: v.b.after, sel: v.nl };
    this.host.setStatus(tr("vis.puBreakSelected"));
    this.refresh();
  }

  /** 删一处虚拟换行：ABC 两条代码行接成一条（`w:` 跟着并），文本谱与下一行合并。 */
  private deleteVirtualBreak(c: EditCtx, v: { b: BreakMark; nl: number }): boolean {
    if (c.dialect.relayoutBreaks) return this.relayoutBreak(c, v.b.after, false, false);
    return this.apply(deleteBreak(c, { kind: "break", from: v.nl, to: v.nl + 1, id: -1, verse: null }));
  }

  /** 屏幕坐标 → 插入位置：同一行（纵向覆盖点击点）里水平最近的元素，点在它中线左边就落在它前面。 */
  private caretAtPoint(cx: number, cy: number): number | null {
    let best: { e: SyncEntry; r: DOMRect; d: number } | null = null;
    for (const e of this.navigable()) {
      if (e.kind === "break") continue;
      const el = this.host.entryEl(e);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const pad = r.height * 0.6;
      if (cy < r.top - pad || cy > r.bottom + pad) continue;
      const d = cx < r.left ? r.left - cx : cx > r.right ? cx - r.right : 0;
      if (!best || d < best.d) best = { e, r, d };
    }
    if (!best || best.d > best.r.height * 3) return null;
    const span = this.spanOfEntry(best.e);
    return cx < (best.r.left + best.r.right) / 2 ? span.from : this.groupEnd(best.e);
  }

  // ---------------- 键盘 ----------------

  private onKeyDown(ev: KeyboardEvent): void {
    if (!this.host.visualEnabled() || inlineEditing()) return;
    const hit = keyHit(ev);
    if (!hit) return;
    if (CLIPBOARD_ACTIONS.has(hit.action.id)) return; // 交给随后的 copy / cut / paste 事件
    if (this.runChecked(hit.action, hit.key)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  /** 键盘、面板、菜单共用的入口：模式不对不做；索引落后于原文（刚撤销、刚在代码区打过字）先重排，免得按旧偏移改错地方。 */
  private runChecked(a: VisualAction, key = ""): boolean {
    if (a.modes && !a.modes.includes(this.mode)) return false;
    if (!this.host.syncFresh()) this.host.reloadNow();
    return this.run(a, key);
  }

  /** 给面板与菜单用的那一面 */
  private readonly runner: MenuRunner = this.makeRunner();

  /** 模型那一路（`.musicxml`）向控制器要的东西 */
  private readonly modelCtx: ModelActionCtx = this.makeModelCtx();

  private makeModelCtx(): ModelActionCtx {
    const ctl = this;
    return {
      get view() {
        return ctl.host.view;
      },
      get sync() {
        return ctl.host.sync;
      },
      get curDur() {
        return ctl.curDur;
      },
      get curVoice() {
        return ctl.curVoice;
      },
      get pickedChordNote() {
        return ctl.pickedChordNote();
      },
      prompt: (hint, initial) => new Promise((resolve) => {
        const first = ctl.selectedEntries()[0] ?? [...ctl.navigable()].reverse().find((e) => e.to <= ctl.host.view.state.selection.main.head);
        const anchor = (first && ctl.elOfEntry(first)) ?? ctl.host.scorePane;
        openInlineEditor(anchor, initial, ({ value }) => {
          ctl.host.scorePane.focus({ preventScroll: true });
          resolve(value);
        }, hint);
      }),
      freshModel: () => ctl.host.freshModel(),
      writeModel: (doc) => ctl.host.writeModel(doc),
      syncDoc: () => ctl.host.syncDoc(),
      reloadNow: () => ctl.host.reloadNow(),
      setStatus: (t) => ctl.host.setStatus(t),
      select: (f, t) => ctl.select(f, t),
      navigable: () => ctl.navigable(),
      selectedEntries: () => ctl.selectedEntries(),
      play: (midi) => {
        if (ctl.noteSound && !ctl.host.playbackBusy()) void ctl.preview.play(midi);
      },
    };
  }

  private makeRunner(): MenuRunner {
    const ctl = this;
    return {
      get mode(): VisualMode {
        return ctl.mode;
      },
      get surface() {
        return ctl.host.surfaceKind();
      },
      run: (a, key) => ctl.runChecked(a, key),
      available: (a) => ctl.available(a),
      refocus: () => ctl.host.scorePane.focus({ preventScroll: true }),
    };
  }

  /** 右键：先按点击的规则选中（音符 / 记号 / 换行符 / 空白处落插入光标），再按选中的是什么弹菜单。 */
  private onContextMenu(ev: MouseEvent): void {
    if (!this.host.visualEnabled()) return;
    ev.preventDefault();
    this.host.scorePane.focus({ preventScroll: true });
    if (!this.host.syncFresh()) this.host.reloadNow();
    const entry = this.host.entryAtTarget(hitThroughOverlay(ev));
    const sel = this.host.view.state.selection.main;
    let target: MenuTarget = "other";
    const onBreak = ev.target instanceof Element && ev.target.closest(".vis-break");
    if (onBreak) {
      this.handleClick(ev, null);
      target = "break";
    } else if (entry && isText(entry)) {
      this.handleClick(ev, entry);
      // 歌词字：菜单上有挪格（识别字整串错开时用）
      if (entry.kind === "lyric") target = "mark";
    } else if (entry) {
      // 点在已选中的范围里就不动选区（右键一段选区整体操作）
      const inside = entry.from < sel.to && entry.to > sel.from && !sel.empty;
      if (!inside) {
        const span = this.noteSel(entry);
        this.select(span.from, span.to);
      }
      // 小节线、增时线与换行符一样：菜单上只有删除与撤销/重做
      target = entry.kind === "mark" ? "mark"
        : entry.kind === "break" || entry.kind === "barline" || entry.kind === "sustain" ? "break"
        : "note";
    } else if (this.handleClick(ev, null)) {
      target = this.mode === "insert" ? "caret" : "note";
    }
    showMenu(ev.clientX, ev.clientY, target, this.runner);
  }

  /** 按动作 id 执行（没有键位的动作，脚本与外部入口用）。 */
  runById(id: string, key = ""): boolean {
    const a = VISUAL_ACTIONS.find((x) => x.id === id);
    return a ? this.run(a, key) : false;
  }

  /** 执行一个动作（键盘、菜单、面板共用）。做了返回 true。`key` 是按下的键（唱名动作要知道是几）。 */
  run(a: VisualAction, key = ""): boolean {
    if (this.host.modelEditing()) {
      const r = runModelAction(this.modelCtx, a, key);
      if (r !== null) return r;
    }
    switch (a.id) {
      case "note.digit": return this.digit(Number(key));
      case "note.letter": return this.letter(key);
      case "oct.up": return this.pitchEdit((c, f, t) => shiftOctave(c, f, t, 1));
      case "oct.down": return this.pitchEdit((c, f, t) => shiftOctave(c, f, t, -1));
      case "step.up": return this.pitchEdit((c, f, t) => stepDegree(c, f, t, 1));
      case "step.down": return this.pitchEdit((c, f, t) => stepDegree(c, f, t, -1));
      case "semi.up": return this.pitchEdit((c, f, t) => stepSemitone(c, f, t, 1));
      case "semi.down": return this.pitchEdit((c, f, t) => stepSemitone(c, f, t, -1));
      case "acc.sharp": return this.editNotes((c, f, t) => setAccidental(c, f, t, "sharp"), true);
      case "acc.flat": return this.editNotes((c, f, t) => setAccidental(c, f, t, "flat"), true);
      case "acc.natural": return this.editNotes((c, f, t) => setAccidental(c, f, t, "natural"), true);
      case "dur.dot": return this.editNotes(toggleDot);
      case "dur.halve": return this.duration(-1);
      case "dur.double": return this.duration(1);
      case "sus.add": return this.sustain();
      case "slur.toggle": return this.editNotes(toggleSlur);
      case "tie.toggle": return this.editNotes(toggleTie);
      case "tuplet.toggle": return this.editNotes(toggleTupletText);
      case "deco.fermata": return this.editNotes((c, f, t) => toggleDeco(c, f, t, "fermata"));
      case "deco.accent": return this.editNotes((c, f, t) => toggleDeco(c, f, t, "accent"));
      case "bar.insert": return this.insertAtCursor((c, pos) => insertToken(c, pos, c.dialect.barline));
      case "brk.line": return this.insertBreakAt(false);
      case "brk.page": return this.insertBreakAt(true);
      case "del.forward": return this.remove(1);
      case "del.back": return this.remove(-1);
      case "mode.insert": return this.toInsert();
      case "mode.edit": return this.toEdit();
      case "nav.prev": return this.move(-1, false);
      case "nav.next": return this.move(1, false);
      case "nav.extendPrev": return this.move(-1, true);
      case "nav.extendNext": return this.move(1, true);
      case "sel.all": return this.selectAll();
      case "chord.add":
        this.host.setStatus(tr("ve.chordOnlyXml"));
        return true;
      case "meas.append": case "meas.insert": case "meas.delete":
      case "bar.single": case "bar.double": case "bar.final": case "bar.repeatStart": case "bar.repeatEnd":
      case "volta.1": case "volta.2":
      case "jump.segno": case "jump.coda": case "jump.dc": case "jump.ds": case "jump.fine":
        return this.measureText(a.id, null);
      case "meas.key": case "meas.time": case "meas.tempo": {
        const hint = a.id === "meas.key" ? tr("ve.hint.key") : a.id === "meas.time" ? tr("ve.hint.time") : tr("ve.hint.tempo");
        void this.modelCtx.prompt(hint, "").then((v) => {
          if (v !== null) this.measureText(a.id, v);
        });
        return true;
      }
      case "voice.set": {
        this.curVoice = Number(key) || 1;
        this.host.setStatus(this.host.modelEditing()
          ? tr("ve.voiceNow", { n: this.curVoice })
          : tr("ve.voiceOnlyXml"));
        this.refresh();
        return true;
      }
      case "nav.measPrev": return this.measureJump(-1, false);
      case "nav.measNext": return this.measureJump(1, false);
      case "nav.extendMeasPrev": return this.measureJump(-1, true);
      case "nav.extendMeasNext": return this.measureJump(1, true);
      case "nav.gotoMeasure":
        void this.modelCtx.prompt(tr("ve.gotoPrompt"), "").then((v) => {
          this.host.scorePane.focus({ preventScroll: true });
          if (v !== null && v.trim()) this.gotoMeasure(Number(v.trim()));
        });
        return true;
      case "edit.copy": this.copy(); return true;
      case "edit.cut": return this.cut();
      case "edit.paste": return this.paste(clipFor(null), null);
      case "edit.repeat": return this.repeat();
      case "edit.transpose": return this.transpose();
      case "lyric.entry": return this.startLyrics();
      case "chord.entry": return this.startChords();
      case "text.entry": return this.startAttached("annotation");
      case "dyn.entry": return this.startAttached("dynamic");
      case "nav.home": return this.rowEdge(-1);
      case "nav.end": return this.rowEdge(1);
      case "move.prev": return this.moveText(-1, false, "both");
      case "move.next": return this.moveText(1, false, "both");
      case "move.measPrev": case "move.measNext":
        this.host.setStatus(tr("ve.moveLyricOneNote"));
        return true;
      case "span.endPrev": return this.moveText(-1, false, "end");
      case "span.endNext": return this.moveText(1, false, "end");
      case "sel.beamGroup": return this.selectBeamGroup();
      case "issue.next": return this.nextIssue(1);
      case "issue.prev": return this.nextIssue(-1);
      case "meas.keyReread":
        // 文本格式的音按调号读（简谱数字、ABC 音名），只改调号字段本来就是重读
        void this.modelCtx.prompt(tr("ve.hint.keyReread"), "").then((v) => {
          if (v !== null) this.measureText("meas.key", v);
        });
        return true;
      case "meas.clef": case "meas.clefReread": case "wedge.cresc": case "wedge.dim": case "ottava.up": case "ottava.down": case "grace.toggle":
      case "deco.staccato": case "deco.tenuto": case "deco.marcato": case "deco.staccatissimo": case "deco.fermataInv":
      case "deco.trill": case "deco.mordent": case "deco.turn":
        this.host.setStatus(tr("ve.onlyXml"));
        return true;
      case "mark.next": return this.cycleMark(1);
      case "mark.prev": return this.cycleMark(-1);
      case "view.formatMarks": this.toggleFormatMarks(); return true;
      case "edit.undo": return this.afterHistory(undo(this.host.view));
      case "edit.redo": return this.afterHistory(redo(this.host.view));
    }
    return false;
  }

  /** 改代码区选区（谱面高亮、叠加层由 App 的选区监听刷新）。 */
  select(from: number, to: number): void {
    this.host.view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
  }

  /** 一个条目在原文里的区间。音符按它自己的 token（不含增时线）。 */
  private spanOfEntry(e: SyncEntry): { from: number; to: number } {
    return { from: e.from, to: e.to };
  }

  /** 选中一个条目时的区间：音符只罩音头（不带减时线、附点、括号），其余整个条目。 */
  private noteSel(e: SyncEntry): { from: number; to: number } {
    if (e.kind !== "note") return this.spanOfEntry(e);
    const c = this.editCtx(true);
    return c ? noteSpans(c, e).head : this.spanOfEntry(e);
  }

  /** 一个元素「连同它的增时线」的结尾：插入光标落在音符后面时，要落到它最后一条增时线后面。 */
  private groupEnd(e: SyncEntry): number {
    if (e.kind !== "note") return e.to;
    let end = e.to;
    for (const s of this.navigable()) {
      if (s.from < e.to) continue;
      if (s.kind === "sustain" && s.id === e.id) end = s.to;
      else break;
    }
    return end;
  }

  /** 选区碰到的条目（编辑模式；选中音头时整个音符也算选中）。 */
  private selectedEntries(): SyncEntry[] {
    const sel = this.host.view.state.selection.main;
    return this.navigable().filter((e) => e.from < sel.to && e.to > sel.from);
  }

  private toInsert(): boolean {
    const sel = this.host.view.state.selection.main;
    const last = this.selectedEntries().pop();
    const at = last ? this.groupEnd(last) : sel.to;
    this.select(at, at);
    return true;
  }

  private toEdit(): boolean {
    const head = this.host.view.state.selection.main.head;
    const nav = this.navigable();
    const before = [...nav].reverse().find((e) => e.to <= head);
    const pick = before ?? nav.find((e) => e.from >= head);
    if (!pick) return false;
    const span = this.noteSel(pick);
    this.select(span.from, span.to);
    return true;
  }

  private move(dir: -1 | 1, extend: boolean): boolean {
    const nav = this.navigable();
    if (nav.length === 0) return false;
    const sel = this.host.view.state.selection.main;
    // 点中的文本谱换行（光标在行末、另记了一笔）：当它是选中的元素，往两边走到相邻的元素
    if (this.pickedBreak && sel.empty && sel.head === this.pickedBreak.sel && !extend) {
      this.pickedBreak = null;
      const target = dir > 0 ? nav.find((e) => e.from >= sel.head) : [...nav].reverse().find((e) => e.to <= sel.head);
      if (!target) return false;
      const span = this.noteSel(target);
      this.select(span.from, span.to);
      return true;
    }
    if (sel.empty && !extend) {
      // 插入模式：光标跨过一个元素（连同音符的增时线一起跨）；跨过虚拟换行算一步（行末 → 下一行行首）
      const vb = this.virtualBreakBeside(sel.head, dir);
      if (vb) {
        const at = dir > 0 ? vb.next.from : this.groupEnd(vb.prev);
        this.select(at, at);
        return true;
      }
      if (dir > 0) {
        const next = nav.find((e) => e.from >= sel.head);
        if (!next) return false;
        const at = this.groupEnd(next);
        this.select(at, at);
      } else {
        const prev = [...nav].reverse().find((e) => e.to <= sel.head);
        if (!prev) return false;
        // 跨过的是增时线时一直退到它的音符前面
        let from = prev.from;
        if (prev.kind === "sustain") from = this.host.sync.spanOfNote(prev.id)?.from ?? from;
        this.select(from, from);
      }
      return true;
    }
    const cur = this.selectedEntries();
    if (extend) {
      // 以选区的另一端为锚，往 dir 那边多罩一个
      if (dir > 0) {
        const next = nav.find((e) => e.from >= sel.to);
        if (!next) return false;
        this.select(sel.from, next.to);
      } else {
        const prev = [...nav].reverse().find((e) => e.to <= sel.from);
        if (!prev) return false;
        this.select(sel.to, prev.from);
      }
      return true;
    }
    let target: SyncEntry | undefined;
    let edge: number;
    if (dir > 0) {
      edge = cur.length ? cur[cur.length - 1]!.to : sel.to;
      target = nav.find((e) => e.from >= edge);
    } else {
      edge = cur.length ? cur[0]!.from : sel.from;
      target = [...nav].reverse().find((e) => e.to <= edge);
    }
    // 中间夹着虚拟换行：先停在换行上（选中的换行符本身不算夹着）
    const selNl = sel.to === sel.from + 1 ? sel.from : -1;
    const vb = this.virtualBreaks().find((v) => v.nl !== selNl && (dir > 0
      ? edge <= v.nl && (!target || v.nl < target.from)
      : v.nl < edge && (!target || target.to <= v.nl)));
    if (vb) {
      this.pickVirtualBreak(vb);
      return true;
    }
    if (!target) return false;
    const span = this.noteSel(target);
    this.select(span.from, span.to);
    return true;
  }

  // ---------------- 剪贴板（`clipboard.ts`） ----------------

  private onClipboardEvent(ev: ClipboardEvent, kind: "copy" | "cut" | "paste"): void {
    if (!this.host.visualEnabled() || inlineEditing()) return;
    if (!this.host.syncFresh()) this.host.reloadNow();
    ev.preventDefault();
    if (kind === "paste") {
      const text = ev.clipboardData?.getData("text/plain") ?? "";
      this.paste(clipFor(text), text);
      return;
    }
    const c = kind === "cut" ? this.cutClip() : this.copy(false);
    if (c) ev.clipboardData?.setData("text/plain", c.text);
  }

  /** 选区 → 剪贴板内容（不动剪贴板）。只收音、增时线、小节线。 */
  private buildClip(): Clip | null {
    const sel = this.host.view.state.selection.main;
    const es = sel.empty ? [] : this.selectedEntries().filter((e) => e.kind === "note" || e.kind === "sustain" || e.kind === "barline");
    if (!es.length) {
      this.host.setStatus(tr("ve.selectToCopy"));
      return null;
    }
    if (this.host.modelEditing()) {
      const doc = this.host.syncDoc();
      const ids = [...new Set(es.filter((e) => e.kind === "note").map((e) => e.id))];
      return doc ? { dialect: null, text: "", items: clipOfChords(doc, ids) } : null;
    }
    const c = this.editCtx();
    if (!c) return null;
    const items: Clip["items"] = [];
    for (const e of es) {
      if (e.kind === "barline") items.push({ kind: "bar" });
      else if (e.kind === "sustain") items.push({ kind: "sustain" });
      else {
        const t = c.dialect.parseNote(c.state.doc.sliceString(e.from, e.to), noteCtx(c, e.from));
        if (!t) continue;
        items.push({ kind: "note", degree: t.degree, octave: t.octave, acc: t.acc, halvings: t.halvings, dots: t.dots });
        for (let k = 0; k < t.inlineSustains; k++) items.push({ kind: "sustain" });
      }
    }
    const from = es[0]!.from;
    const to = this.groupEnd(es[es.length - 1]!);
    return { dialect: c.dialect, text: c.state.doc.sliceString(from, to), items };
  }

  /** 复制：记进剪贴板；`system` 时（菜单、面板点的）顺手写进系统剪贴板（键盘那一下由 copy 事件写）。 */
  private copy(system = true): Clip | null {
    const c = this.buildClip();
    if (!c) return null;
    setClip(c);
    if (system && c.text) void navigator.clipboard?.writeText(c.text).catch(() => undefined);
    this.host.setStatus(tr("ve.copied", { n: c.items.filter((i) => i.kind === "note").length }));
    return c;
  }

  private cutClip(): Clip | null {
    const c = this.copy(false);
    if (c) this.run(actionById("del.forward"));
    return c;
  }

  private cut(): boolean {
    const c = this.cutClip();
    if (c?.text) void navigator.clipboard?.writeText(c.text).catch(() => undefined);
    return true;
  }

  /**
   * 粘贴：插入模式贴在光标处，编辑模式贴在选区后面（不覆盖），贴完选中贴进来的那段。
   * 同一种格式原样贴原文；别的格式按 `ClipItem` 重写；外面拷来的字（`raw`，对不上上次复制的）当这种格式的原文贴。
   */
  private paste(clip: Clip | null, raw: string | null): boolean {
    if (this.host.modelEditing()) {
      if (!clip) {
        this.host.setStatus(raw ? tr("ve.pasteXmlOnly") : tr("ve.clipEmpty"));
        return true;
      }
      return pasteModel(this.modelCtx, clip.items);
    }
    const c = this.editCtx();
    if (!c) return true;
    const pos = this.insertPos(c);
    const text = clip ? (clip.dialect === c.dialect && clip.text ? clip.text : itemsToText(clip.items, c.dialect, noteCtx(c, pos))) : raw;
    if (!text?.trim()) {
      this.host.setStatus(tr("ve.clipEmpty"));
      return true;
    }
    const r = spacedInsert(c, pos, text.trim());
    const sel = c.state.selection.main;
    return this.apply({ changes: [r.change], anchor: sel.empty ? r.end : r.start, head: r.end });
  }

  // ---------------- 歌词录入（`lyrics.ts`；MusicXML 走 `model/edit.ts::setLyric`） ----------------

  /** 可配字的音（不含休止），按原文顺序、一个音一条。 */
  private lyricNotes(): SyncEntry[] {
    const doc = this.host.syncDoc();
    const c = this.host.modelEditing() ? null : this.editCtx(true);
    const seen = new Set<number>();
    return this.navigable().filter((e) => {
      if (e.kind !== "note" || seen.has(e.id)) return false;
      seen.add(e.id);
      // 与对位格同口径（`isLyricSlot`）：倚音、延续半截、第二声线不配字
      const ch = doc ? locate(doc, e.id)?.chord : undefined;
      if (ch && (ch.grace || ch.continued || ch.voice > 1)) return false;
      if (c) return (c.dialect.parseNote(c.state.doc.sliceString(e.from, e.to), noteCtx(c, e.from))?.degree ?? 1) !== 0;
      return !(doc && locate(doc, e.id)?.chord.rest);
    });
  }

  /** Ctrl/⌘+L：从选中的音（选中的是字就从它的音、它那一段）开始逐字填词。 */
  private startLyrics(): boolean {
    const notes = this.lyricNotes();
    if (!notes.length) return false;
    const sel = this.host.view.state.selection.main;
    const es = this.selectedEntries();
    const lyr = es.find((e) => e.kind === "lyric");
    const id = es.find((e) => e.kind === "note")?.id ?? lyr?.id ?? [...this.navigable()].reverse().find((e) => e.kind === "note" && e.to <= sel.head)?.id;
    const at = Math.max(0, notes.findIndex((e) => e.id === id));
    const verse = lyr ? lyr.verseNo ?? (lyr.verse ?? 0) + 1 : 1;
    this.openLyricBox(at, verse);
    return true;
  }

  /** 在第 `idx` 个可配字的音下面开歌词框。 */
  private openLyricBox(idx: number, verse: number): void {
    const note = this.lyricNotes()[idx];
    if (!note) {
      this.host.scorePane.focus({ preventScroll: true });
      return;
    }
    const span = this.noteSel(note);
    this.select(span.from, span.to);
    const anchor = this.host.noteEl(note.id) ?? this.elOfEntry(note) ?? this.host.scorePane;
    const raw = lyricTextOf(this.host.view.state, this.host.sync.ordered(), note, verse);
    const cur = this.host.modelEditing() ? unescapeXml(raw) : raw;
    openInlineEditor(anchor, cur, (d) => this.lyricDone(idx, verse, cur, d), tr("ve.verseN", { n: verse }), {
      keys: { " ": "next", "-": "hyphen", _: "extend", "/": "skip", "Shift+ ": "prev", Enter: "verse" },
    });
  }

  private lyricDone(idx: number, verse: number, old: string, d: InlineDone): void {
    if (d.value === null) {
      this.host.scorePane.focus({ preventScroll: true });
      return;
    }
    const value = d.value.trim();
    const tag = d.tag ?? (d.nav === 0 ? "stop" : d.nav < 0 ? "prev" : "next");
    let last = idx;
    if (tag !== "skip" && (value !== old || tag === "hyphen" || tag === "extend")) {
      // 一次打了几个汉字：一字一音往后分（最后一个字带上这次的连字符 / 续记号）
      const chars = /^[㐀-鿿豈-﫿]{2,}$/.test(value) ? [...value] : [value];
      chars.forEach((ch, k) => {
        const final = k === chars.length - 1;
        this.writeLyric(idx + k, verse, ch, final && tag === "hyphen", final && tag === "extend");
      });
      last = idx + chars.length - 1;
    }
    const next = tag === "verse" ? idx : tag === "prev" ? idx - 1 : tag === "extend" ? last + 2 : tag === "stop" ? -1 : last + 1;
    if (next < 0) {
      this.host.scorePane.focus({ preventScroll: true });
      return;
    }
    void this.host.whenIdle().then(() => this.openLyricBox(next, tag === "verse" ? verse + 1 : verse));
  }

  private writeLyric(idx: number, verse: number, text: string, hyphen: boolean, extend: boolean): void {
    if (!this.host.syncFresh()) this.host.reloadNow();
    const note = this.lyricNotes()[idx];
    if (!note) return;
    if (this.host.modelEditing()) {
      lyricModel(this.modelCtx, note.id, verse, text, hyphen, extend);
      return;
    }
    const c = this.editCtx();
    if (!c) return;
    this.apply(setLyricText(c, note, verse, text, hyphen, extend));
  }

  // ---------------- 和弦名录入 ----------------

  /** 能挂和弦名的音（休止也能挂），按原文顺序、一个音一条。 */
  private chordNotes(): SyncEntry[] {
    const seen = new Set<number>();
    return this.navigable().filter((e) => e.kind === "note" && !seen.has(e.id) && (seen.add(e.id), true));
  }

  /** Ctrl/⌘+K：从选中的音（或光标前那个）开始逐个填和弦名。 */
  private startChords(): boolean {
    const notes = this.chordNotes();
    if (!notes.length) return false;
    const sel = this.host.view.state.selection.main;
    const es = this.selectedEntries();
    const id = es.find((e) => e.kind === "note" || e.kind === "mark")?.id ?? [...this.navigable()].reverse().find((e) => e.kind === "note" && e.to <= sel.head)?.id;
    this.openChordBox(Math.max(0, notes.findIndex((e) => e.id === id)));
    return true;
  }

  private openChordBox(idx: number): void {
    const note = this.chordNotes()[idx];
    if (!note) {
      this.host.scorePane.focus({ preventScroll: true });
      return;
    }
    const span = this.noteSel(note);
    this.select(span.from, span.to);
    let cur = "";
    if (this.host.modelEditing()) {
      const doc = this.host.syncDoc();
      const h = doc ? locate(doc, note.id)?.chord.harmony : undefined;
      cur = h ? harmonyText(h) : "";
    } else {
      const c = this.editCtx(true);
      const e = c ? chordEntryOf(c, note) : null;
      cur = c && e ? chordNameOf(c, e) : "";
    }
    const anchor = this.host.noteEl(note.id) ?? this.elOfEntry(note) ?? this.host.scorePane;
    openInlineEditor(anchor, cur, (d) => this.chordDone(idx, cur, d), tr("ve.chordName"), { keys: { " ": "next", "Shift+ ": "prev", Enter: "stop" } });
  }

  private chordDone(idx: number, old: string, d: InlineDone): void {
    if (d.value === null) {
      this.host.scorePane.focus({ preventScroll: true });
      return;
    }
    const value = d.value.trim();
    if (value !== old) {
      if (!this.host.syncFresh()) this.host.reloadNow();
      const note = this.chordNotes()[idx];
      if (note && this.host.modelEditing()) harmonyModel(this.modelCtx, note.id, value);
      else if (note) {
        const c = this.editCtx();
        if (c) this.apply(setChordName(c, note, value));
      }
    }
    const tag = d.tag ?? (d.nav === 0 ? "stop" : d.nav < 0 ? "prev" : "next");
    if (tag === "stop") {
      this.host.scorePane.focus({ preventScroll: true });
      return;
    }
    void this.host.whenIdle().then(() => this.openChordBox(idx + (tag === "prev" ? -1 : 1)));
  }

  // ---------------- 文字 / 力度 ----------------

  private startAttached(kind: "annotation" | "dynamic"): boolean {
    const notes = this.chordNotes();
    if (!notes.length) return false;
    const sel = this.host.view.state.selection.main;
    const id = this.selectedEntries().find((e) => e.kind === "note" || e.kind === "mark")?.id ??
      [...this.navigable()].reverse().find((e) => e.kind === "note" && e.to <= sel.head)?.id;
    this.openAttachedBox(kind, Math.max(0, notes.findIndex((e) => e.id === id)));
    return true;
  }

  private openAttachedBox(kind: "annotation" | "dynamic", idx: number): void {
    const note = this.chordNotes()[idx];
    if (!note) {
      this.host.scorePane.focus({ preventScroll: true });
      return;
    }
    const span = this.noteSel(note);
    this.select(span.from, span.to);
    const type = kind === "annotation" ? "words" : "dynamics";
    const doc = this.host.syncDoc();
    const c = this.host.modelEditing() ? null : this.editCtx(true);
    const cur = c ? attachedTextOf(c, note, kind) : doc ? directionTextOf(doc, note.id, type) : "";
    const anchor = this.host.noteEl(note.id) ?? this.elOfEntry(note) ?? this.host.scorePane;
    const keys: Record<string, string> = kind === "dynamic" ? { " ": "next", "Shift+ ": "prev", Enter: "stop" } : { Enter: "stop" };
    openInlineEditor(anchor, cur, (d) => {
      if (d.value === null) {
        this.host.scorePane.focus({ preventScroll: true });
        return;
      }
      const value = d.value.trim();
      if (kind === "dynamic" && value && !DYNAMICS.test(value)) {
        this.host.setStatus(tr("ve.notDynamic", { v: value }));
        this.host.scorePane.focus({ preventScroll: true });
        return;
      }
      if (value !== cur) {
        if (!this.host.syncFresh()) this.host.reloadNow();
        const n = this.chordNotes()[idx];
        if (n && this.host.modelEditing()) directionModel(this.modelCtx, n.id, type, value);
        else if (n) {
          const cc = this.editCtx();
          if (cc) this.apply(setAttachedText(cc, n, kind, value));
        }
      }
      const tag = d.tag ?? (d.nav === 0 ? "stop" : d.nav < 0 ? "prev" : "next");
      if (tag === "stop" || kind === "annotation") {
        this.host.scorePane.focus({ preventScroll: true });
        return;
      }
      void this.host.whenIdle().then(() => this.openAttachedBox(kind, idx + (tag === "prev" ? -1 : 1)));
    }, kind === "annotation" ? tr("ve.text") : tr("ve.dynamic"), { keys });
  }

  /** 选区里的音（按原文顺序；试听的循环段用）。插入模式为空。 */
  selectedNoteIds(): number[] {
    if (this.host.view.state.selection.main.empty) return [];
    return [...new Set(this.selectedEntries().filter((e) => e.kind === "note").map((e) => e.id))];
  }

  /** 移调对话框：全曲换调或选中的音移几个半音（`transpose.ts`）。 */
  private transpose(): boolean {
    const doc = this.host.syncDoc();
    const song = doc?.songs[0];
    const fifths = song?.key?.fifths ?? song?.parts[0]?.measures[0]?.attrs?.key?.fifths ?? 0;
    const sel = this.host.view.state.selection.main;
    const hasSel = !sel.empty && this.selectedEntries().some((e) => e.kind === "note");
    showTransposeDialog(fifths, hasSel, (whole, n) => {
      this.host.scorePane.focus({ preventScroll: true });
      if (!this.host.syncFresh()) this.host.reloadNow();
      if (this.host.modelEditing()) {
        transposeModel(this.modelCtx, whole, n);
        return;
      }
      const c = this.editCtx();
      if (!c) return;
      if (whole) this.apply(transposeText(c, n));
      else this.editNotes((cc, f, t) => shiftSemitones(cc, f, t, n), true);
    });
    return true;
  }

  /** `R`：把选区原样再贴一遍在它后面（不动剪贴板），选中新贴的那段——再按接着往后重复。 */
  private repeat(): boolean {
    const c = this.buildClip();
    return c ? this.paste(c, null) : true;
  }

  /** 按原文顺序把可停的条目按小节线 / 换行切成一段段（每段一小节，空段不要）。 */
  private measureRuns(): SyncEntry[][] {
    const runs: SyncEntry[][] = [];
    let cur: SyncEntry[] = [];
    for (const e of this.navigable()) {
      if (e.kind === "barline" || e.kind === "break") {
        if (cur.length) runs.push(cur);
        cur = [];
      } else cur.push(e);
    }
    if (cur.length) runs.push(cur);
    return runs;
  }

  /** Ctrl/⌘+←→：跳到上 / 下一小节开头；`extend` 时以选区另一端为锚扩到那一小节的尾（往后）或头（往前）。 */
  private measureJump(dir: -1 | 1, extend: boolean): boolean {
    const runs = this.measureRuns();
    if (!runs.length) return false;
    const sel = this.host.view.state.selection.main;
    const first = (r: SyncEntry[]): SyncEntry => r[0]!;
    const last = (r: SyncEntry[]): SyncEntry => r[r.length - 1]!;
    // 选区（光标）所在那一小节：往后跳看选区尾，往前跳看选区头
    const edge = dir > 0 ? sel.to : sel.from;
    let i = runs.findIndex((r) => this.groupEnd(last(r)) > edge || (sel.empty && this.groupEnd(last(r)) >= edge));
    if (i < 0) i = runs.length - 1;
    if (extend) {
      const atEnd = sel.to >= this.groupEnd(last(runs[i]!));
      const atStart = sel.from <= first(runs[i]!).from;
      const j = dir > 0 ? (atEnd ? i + 1 : i) : (atStart ? i - 1 : i);
      const r = runs[Math.max(0, Math.min(runs.length - 1, j))]!;
      if (dir > 0) this.select(sel.from, this.groupEnd(last(r)));
      else this.select(sel.to, first(r).from);
      return true;
    }
    const atStart = sel.empty ? sel.head <= first(runs[i]!).from : sel.from <= first(runs[i]!).from;
    const j = dir > 0 ? i + 1 : atStart ? i - 1 : i;
    const r = runs[j];
    if (!r) return false;
    if (sel.empty) this.select(first(r).from, first(r).from);
    else {
      const span = this.noteSel(first(r));
      this.select(span.from, span.to);
    }
    return true;
  }

  /** 跳到第 `n` 小节（按模型的小节数，从 1 数；多声部时在选区所在声部里数）。 */
  private gotoMeasure(n: number): boolean {
    const doc = this.host.syncDoc();
    if (!doc || !Number.isInteger(n) || n < 0) {
      this.host.setStatus(tr("ve.measureInt"));
      return true;
    }
    const nav = this.navigable();
    const byId = new Map<number, SyncEntry>();
    for (const e of nav) if (e.kind === "note" && !byId.has(e.id)) byId.set(e.id, e);
    const sel = this.host.view.state.selection.main;
    const here = this.selectedEntries()[0] ?? [...nav].reverse().find((e) => e.to <= sel.head) ?? nav[0];
    // 选区所在那首、那个声部先找（多曲文档里第 n 小节按当前这首数）
    let si0 = 0;
    let pi0 = 0;
    doc.songs.forEach((song, si) => song.parts.forEach((part, pi) => {
      if (here && part.measures.some((m) => m.elements.some((el) => el.id === here.id))) [si0, pi0] = [si, pi];
    }));
    const order = [si0, ...doc.songs.map((_, si) => si).filter((si) => si !== si0)];
    for (const si of order) {
      const song = doc.songs[si]!;
      const part = song.parts[pi0] ?? song.parts[0];
      if (!part) continue;
      // 曲首弱起小节（不满一小节）是第 0 小节，之后从 1 数（同打谱软件）
      const pickup = isPickup(song, part);
      if (n === 0 && !pickup) continue;
      const m = part.measures[pickup ? n : n - 1];
      const hit = m?.elements.map((el) => byId.get(el.id)).find((e): e is SyncEntry => !!e);
      if (!hit) continue;
      if (sel.empty) this.select(hit.from, hit.from);
      else {
        const span = this.noteSel(hit);
        this.select(span.from, span.to);
      }
      return true;
    }
    this.host.setStatus(tr("ve.noMeasure", { n }));
    return true;
  }

  /** Home / End：沿同一行谱走到头（按谱面上的行认，与原文怎么分行无关）。 */
  private rowEdge(dir: -1 | 1): boolean {
    const nav = this.navigable().filter((e) => e.kind !== "break");
    const sel = this.host.view.state.selection.main;
    let i = nav.findIndex((e) => e.to > sel.from);
    if (i < 0) i = nav.length - 1;
    if (i < 0) return false;
    const cur = this.boxOf(nav[i]!);
    if (!cur) return false;
    let j = i;
    for (;;) {
      const k = j + dir;
      const nb = nav[k] && this.boxOf(nav[k]!);
      if (!nb || nb.svg !== cur.svg || !sameRow(nb.box, cur.box)) break;
      j = k;
    }
    const e = nav[j]!;
    if (sel.empty) {
      const at = dir < 0 ? e.from : this.groupEnd(e);
      this.select(at, at);
    } else {
      const span = this.noteSel(e);
      this.select(span.from, span.to);
    }
    return true;
  }

  /** 撤销/重做之后马上重排（谱面与索引跟上）。 */
  private afterHistory(done: boolean): boolean {
    if (done) this.host.reloadNow();
    return done;
  }

  // ---------------- 改谱 ----------------

  /** 能改谱时给出动作上下文；不能改（格式没有 dialect、没有模型）时在状态栏说明并返回 null。 */
  private editCtx(quiet = false): EditCtx | null {
    const dialect = this.host.editDialect();
    if (!dialect || !this.host.syncDoc()) {
      if (!quiet) this.host.setStatus(tr("vis.unsupported"));
      return null;
    }
    return { state: this.host.view.state, sync: this.host.sync, dialect, doc: this.host.syncDoc() };
  }

  /** 把一次动作的结果落进代码区（进撤销记录），马上重排。出错就在状态栏说明。 */
  private apply(out: EditOutcome, sound = false): boolean {
    if (isError(out)) {
      this.host.setStatus(out.error);
      return true; // 键已经被认下了，只是这回做不了
    }
    const { state } = this.host.view;
    let changes: ChangeSpec = out.changes;
    let anchor = out.anchor;
    let head = out.head;
    const post = this.host.editDialect()?.postEdit;
    if (post) {
      // 连带修正（`.jpwabc` 的歌词锚点）与这次改动并成一步，撤销时一起撤
      const cs = state.changes(out.changes);
      const newText = cs.apply(state.doc).toString();
      const fixed = post(state.doc.toString(), newText, (p) => cs.mapPos(p, 1));
      if (fixed !== newText) {
        const cs2 = ChangeSet.of([diffRegion(newText, fixed)], newText.length);
        changes = cs.compose(cs2);
        anchor = cs2.mapPos(anchor, -1);
        head = cs2.mapPos(head, 1);
      }
    }
    this.host.view.dispatch({
      changes,
      selection: { anchor, head },
      userEvent: "input.visual",
      scrollIntoView: true,
    });
    this.host.reloadNow();
    if (sound) this.sound();
    return true;
  }

  /** 换行不是符号的格式（文本谱）：整份重切行，补丁只取前后不同的那一段。 */
  private relayoutBreak(c: EditCtx, afterId: ElementId, add: boolean, page: boolean): boolean {
    const fn = c.dialect.relayoutBreaks;
    const doc = this.host.syncDoc();
    if (!fn || !doc) return true;
    const text = fn(c.state, doc, afterId, add, page);
    if (text === null) {
      this.host.setStatus(tr(add ? "vis.cantBreak" : "vis.cantUnbreak"));
      return true;
    }
    const old = c.state.doc.toString();
    if (text === old) return true;
    const change = diffRegion(old, text);
    const cs = c.state.changes([change]);
    const at = cs.mapPos(c.state.selection.main.head, 1);
    return this.apply({ changes: [change], anchor: at, head: at });
  }

  private editNotes(fn: (c: EditCtx, from: number, to: number) => EditOutcome, sound = false): boolean {
    const c = this.editCtx();
    if (!c) return true;
    const sel = c.state.selection.main;
    return this.apply(fn(c, sel.from, sel.to), sound);
  }

  /** 插入模式：光标处；编辑模式：选中那段（连同最后一个音符的增时线）之后。 */
  private insertPos(c: EditCtx): number {
    const sel = c.state.selection.main;
    if (sel.empty) return sel.head;
    const last = this.selectedEntries().pop();
    return last ? groupEnd(c, last) : sel.to;
  }

  /** 换行 / 换页：换行是符号的格式插符号（`breaks.ts`），不是符号的（文本谱）重切行。`at` 缺省取光标处 / 选中段之后。 */
  private insertBreakAt(page: boolean, at?: number): boolean {
    const c = this.editCtx();
    if (!c) return true;
    const pos = at ?? this.insertPos(c);
    if (c.dialect.relayoutBreaks) {
      const prev = [...this.navigable()].reverse().find((e) => e.to <= pos && (e.kind === "note" || e.kind === "sustain"));
      if (!prev) {
        this.host.setStatus(tr("vis.lineStart"));
        return true;
      }
      // 重切行的补丁按整段前后差异算，光标映射过去落不准；重排后元素 id 也会变。
      // 按「同一声线里的第几个元素」对回换行后的那个元素，落到它前面（小节末换行时小节线留在上一行，不能按原文顺序取下一个）
      const doc0 = this.host.syncDoc();
      const ord = doc0 ? voiceOrdinal(doc0, prev.id) : null;
      const before = c.state.doc.toString();
      this.relayoutBreak(c, prev.id, true, page);
      const doc1 = this.host.syncDoc();
      if (ord && doc1 && this.host.view.state.doc.toString() !== before) {
        const id = elementAtOrdinal(doc1, ord.key, ord.k + 1);
        const span = id !== null ? this.host.sync.spanOfNote(id) : null;
        if (span) this.select(span.from, span.from);
      }
      return true;
    }
    return this.apply(insertBreak(c, pos, page));
  }

  private insertAtCursor(fn: (c: EditCtx, pos: number) => EditOutcome): boolean {
    const c = this.editCtx();
    if (!c) return true;
    return this.apply(fn(c, this.insertPos(c)));
  }

  /** 改音高（音级、半音、八度）：编辑模式改选中的；插入模式改光标前刚插的那个音，光标留在它后面。 */
  private pitchEdit(fn: (c: EditCtx, from: number, to: number) => EditOutcome): boolean {
    const c = this.editCtx();
    if (!c) return true;
    const sel = c.state.selection.main;
    if (!sel.empty) return this.apply(fn(c, sel.from, sel.to), true);
    const prev = [...this.navigable()].reverse().find((e) => e.to <= sel.head);
    if (prev?.kind !== "note") {
      this.host.setStatus(tr("ve.selectNote"));
      return true;
    }
    const out = fn(c, prev.from, prev.to);
    if (isError(out)) return this.apply(out);
    const caret = c.state.changes(out.changes).mapPos(sel.head, 1);
    return this.apply({ ...out, anchor: caret, head: caret }, true);
  }

  private letter(key: string): boolean {
    const c = this.editCtx();
    if (!c) return true;
    const sel = c.state.selection.main;
    if (!sel.empty) return this.apply(setLetter(c, sel.from, sel.to, key), true);
    return this.apply(insertLetter(c, sel.head, key, this.curDur), true);
  }

  private digit(d: number): boolean {
    const c = this.editCtx();
    if (!c) return true;
    const sel = c.state.selection.main;
    if (!sel.empty) return this.apply(setDegree(c, sel.from, sel.to, d), true);
    return this.apply(insertNote(c, sel.head, d, this.curDur), true);
  }

  /** `_` / `=`：编辑模式改选中音符，插入模式改「当前时值」。 */
  private duration(dir: -1 | 1): boolean {
    const sel = this.host.view.state.selection.main;
    if (sel.empty) {
      const h = this.curDur.halvings - dir;
      if (h < 0 || h > 4) {
        this.host.setStatus(tr(h < 0 ? "vis.durMax" : "vis.durMin"));
        return true;
      }
      this.curDur = { ...this.curDur, halvings: h };
      this.refresh();
      return true;
    }
    return this.editNotes(dir < 0 ? halve : double);
  }

  /** `-`：编辑模式给选中的（最后一个）音符加增时线；插入模式在光标处插一条。 */
  private sustain(): boolean {
    const c = this.editCtx();
    if (!c) return true;
    const sel = c.state.selection.main;
    if (!sel.empty) {
      const note = notesIn(c, sel.from, sel.to).pop();
      if (!note) {
        this.host.setStatus(tr("vis.selectNote"));
        return true;
      }
      return this.apply(addSustain(c, note));
    }
    if (c.dialect.sustain === "inline") {
      // 增时线写在音符 token 里的格式：加到光标前那个音符上
      const prev = [...this.navigable()].reverse().find((e) => e.to <= sel.head && e.kind === "note");
      if (!prev) return true;
      const out = addSustain(c, prev);
      if (!isError(out)) out.anchor = out.head; // 仍是插入模式，光标落在音符后
      return this.apply(out);
    }
    return this.apply(insertToken(c, sel.head, "-"));
  }

  /** Delete / Backspace。编辑模式删选中的；插入模式删光标后面 / 前面那个元素。 */
  private remove(dir: -1 | 1): boolean {
    const c = this.editCtx();
    if (!c) return true;
    const sel = c.state.selection.main;
    // 点中的文本谱换行（原文里没有符号）：与下一行合并
    if (this.pickedBreak && sel.empty && sel.head === this.pickedBreak.sel) {
      const after = this.pickedBreak.after;
      this.pickedBreak = null;
      return this.relayoutBreak(c, after, false, false);
    }
    // 选中的是代码行末的换行符（ABC 的换行）
    if (!sel.empty && c.dialect.lyricBlockByCodeLine && c.state.doc.sliceString(sel.from, sel.to) === "\n") {
      return this.apply(deleteBreak(c, { kind: "break", from: sel.from, to: sel.to, id: -1, verse: null }));
    }
    // 插入光标贴着一处虚拟换行（行首退格、行末 Delete）：删的是换行，不是隔壁的元素
    const vb = sel.empty ? this.virtualBreakBeside(sel.head, dir) : null;
    if (vb) return this.deleteVirtualBreak(c, vb);
    // 选中的是附点：只去掉附点
    if (this.pickedDot()) return this.apply(toggleDot(c, sel.from, sel.to));
    // 选中的是减时线：只去掉减时线（时值回到四分音符）
    if (this.pickedBeams()) return this.apply(clearBeams(c, sel.from, sel.to));
    // 选中的是 token 里的一条增时线：只短一拍（`5---` → `5--`）
    if (this.pickedInlineSustain()) return this.apply(dropInlineSustain(c, sel.from, sel.to));
    let targets: SyncEntry[];
    if (sel.empty) {
      const nav = this.navigable();
      const t = dir > 0 ? nav.find((e) => e.from >= sel.head) : [...nav].reverse().find((e) => e.to <= sel.head);
      if (!t) return true;
      // 退格退到增时线：只删这一条增时线（不连带音符）
      targets = [t];
    } else {
      const exact = this.host.sync.ordered().find((e) => e.from === sel.from && e.to === sel.to);
      // 选区恰好是某个条目：记号、换行、文字（单击选中的歌词字/页眉字段）整体删掉，其余按选区碰到的音符算
      targets = exact && (exact.kind === "mark" || exact.kind === "break" || isText(exact)) ? [exact] : this.selectedEntries();
    }
    if (targets.length === 0) {
      this.host.setStatus(tr("vis.nothingToDelete"));
      return true;
    }
    const brk = targets.find((e) => e.kind === "break");
    if (brk) {
      if (targets.length > 1) {
        this.host.setStatus(tr("vis.breakAlone"));
        return true;
      }
      return this.apply(deleteBreak(c, brk));
    }
    return this.apply(deleteEntries(c, targets));
  }

  /**
   * 挪选中的记号 / 歌词字（文本那一路，`moves.ts`）：歌词字整串挪一格、力度注记和弦名搬到相邻的音、圆滑线挪终点或整条。
   * 模型那一路（`.musicxml`）在 `modelops.ts::moveSelected`，不走这里。
   */
  private moveText(delta: number, byMeasure: boolean, which: "both" | "start" | "end"): boolean {
    const endOnly = which !== "both";
    const c = this.editCtx();
    if (!c) return true;
    const sel = this.host.view.state.selection.main;
    if (sel.empty) {
      this.host.setStatus(tr("ve.selectToMoveMark"));
      return true;
    }
    const exact = this.host.sync.ordered().find((e) => e.from === sel.from && e.to === sel.to && (e.kind === "mark" || e.kind === "lyric"));
    const lyrics = this.host.sync.range(sel.from, sel.to).filter((e) => e.kind === "lyric");
    const ly = exact?.kind === "lyric" ? exact : lyrics[0];
    if (ly && !byMeasure && !endOnly) {
      const count = lyrics.filter((e) => e.verseNo === ly.verseNo).length;
      return this.apply(shiftLyricText(c, ly, delta, count > 1 ? count : undefined));
    }
    if (exact?.kind === "mark" && exact.markKind === "slur" && !byMeasure) return this.apply(moveSlurText(c, exact, which, delta));
    if (exact?.kind === "mark" && exact.markKind !== "slur" && !endOnly && !byMeasure) return this.apply(moveAttachedText(c, exact, delta));
    this.host.setStatus(tr(ly || exact ? "ve.moveLyricOneNote" : "ve.selectToMoveMark"));
    return true;
  }

  /** 选中这个音所在那一组连杠的音（接着 `_` / `=` 整组减半 / 加倍 = 补 / 删一层符杠）。 */
  private selectBeamGroup(): boolean {
    const doc = this.host.syncDoc();
    const note = this.selectedEntries().find((e) => e.kind === "note");
    if (!doc || !note) {
      this.host.setStatus(tr("ve.selectNote"));
      return true;
    }
    const group = beamGroupOf(doc, note.id);
    const spans = group.map((ch) => this.host.sync.spanOfNote(ch.id)).filter((x): x is { from: number; to: number } => !!x);
    if (!spans.length) return true;
    this.select(Math.min(...spans.map((x) => x.from)), Math.max(...spans.map((x) => x.to)));
    this.host.setStatus(tr("ve.beamGroupSelected", { n: group.length }));
    return true;
  }

  /**
   * F8 / Shift+F8：下一处 / 上一处问题（PhotoScore 的坏小节导航）。拍数不对的小节与识别核对的可疑项（`VisualHost.doubtStops`）
   * 并成一张按原文位置排的表，从当前选区往后 / 往前找，到头绕回。
   */
  private nextIssue(dir: 1 | -1): boolean {
    // 按跳过去之后选区落在哪儿比（空小节光标落在小节线后一格、音符只罩音头），否则往回找会一直找到同一处
    const land = (m: ReturnType<VisualEditController["beatMarks"]>[number]): number => {
      if ("empty" in m) return m.empty.from + 1;
      const first = this.host.sync.ordered().find((e) => e.kind === "note" && m.issue.ids.includes(e.id));
      return first ? this.noteSel(first).from : m.at;
    };
    const stops: { at: number; go(): void }[] = [
      ...this.beatMarks().map((m) => ({ at: land(m), go: () => this.goBeat(m) })),
      // 可疑项给的是 token 起点：点中后选区只罩音头，同样换成落点
      ...(this.host.doubtStops?.() ?? []).map((x) => {
        const e = this.host.sync.at(x.at);
        return { ...x, at: e?.kind === "note" ? this.noteSel(e).from : x.at };
      }),
    ].sort((a, b) => a.at - b.at);
    if (!stops.length) {
      this.host.setStatus(tr("issue.none"));
      return true;
    }
    const sel = this.host.view.state.selection.main;
    const pick = dir > 0 ? stops.find((x) => x.at > sel.from) ?? stops[0]! : [...stops].reverse().find((x) => x.at < sel.from) ?? stops[stops.length - 1]!;
    pick.go();
    return true;
  }

  /** Tab：在选中音符挂的记号之间轮换（选中的已经是记号时从它往下接着轮）。 */
  private cycleMark(dir: -1 | 1): boolean {
    const sel = this.host.view.state.selection.main;
    const sync = this.host.sync;
    const at = sync.at(sel.from);
    if (!at) return false;
    const owner = at.kind === "mark" ? at.id : at.kind === "note" || at.kind === "sustain" ? at.id : null;
    if (owner === null) return false;
    const marks = sync.marksOf(owner);
    if (marks.length === 0) {
      this.host.setStatus(tr("vis.noMarks"));
      return true;
    }
    const cur = marks.findIndex((m) => m.from === at.from || m.pair?.from === at.from);
    const next = cur < 0
      ? (dir > 0 ? 0 : marks.length - 1)
      : (cur + dir + marks.length) % marks.length;
    const m = marks[next]!;
    // 第一次 Tab 之后再轮回到音符本身：多一格「音符」，轮完一圈回来
    if (cur >= 0 && ((dir > 0 && cur === marks.length - 1) || (dir < 0 && cur === 0))) {
      const note = sync.ordered().find((e) => e.kind === "note" && e.id === owner);
      if (note) {
        const span = this.noteSel(note);
        this.select(span.from, span.to);
        return true;
      }
    }
    this.select(m.from, m.to);
    this.host.setStatus(tr("vis.markSelected", { mark: markLabel(m) }));
    return true;
  }
}

/** 文字条目：歌词、页眉字段（单击选中、双击进插入模式） */
/** 元素在它那条声线里的位置（第几首·声部·声线 + 第几个元素）：重切行前后靠它对回同一个元素。 */
function voiceOrdinal(doc: ScoreDoc, id: ElementId): { key: string; k: number } | null {
  for (const [si, song] of doc.songs.entries()) {
    for (const [pi, part] of song.parts.entries()) {
      const seen = new Map<number, number>();
      for (const m of part.measures) {
        for (const el of m.elements) {
          const k = seen.get(el.voice) ?? 0;
          seen.set(el.voice, k + 1);
          if (el.id === id) return { key: `${si}:${pi}:${el.voice}`, k };
        }
      }
    }
  }
  return null;
}

/** `voiceOrdinal` 的反查。 */
function elementAtOrdinal(doc: ScoreDoc, key: string, k: number): ElementId | null {
  for (const [si, song] of doc.songs.entries()) {
    for (const [pi, part] of song.parts.entries()) {
      const seen = new Map<number, number>();
      for (const m of part.measures) {
        for (const el of m.elements) {
          const n = seen.get(el.voice) ?? 0;
          seen.set(el.voice, n + 1);
          if (n === k && `${si}:${pi}:${el.voice}` === key) return el.id;
        }
      }
    }
  }
  return null;
}

function isText(e: SyncEntry): boolean {
  return e.kind === "lyric" || e.kind === "header";
}

/** 和弦名：单击选中整个记号，双击同文字一样进改字（`handleDoubleClick`）。 */
function isChordName(e: SyncEntry): boolean {
  return e.kind === "mark" && e.markKind === "harmony";
}

/** 细线条目：小节线（竖）、增时线（横）。它们有自己的 `<g>`，但某一个方向上薄得没有厚度 */
function thin(e: SyncEntry): boolean {
  return e.kind === "barline" || e.kind === "sustain";
}

/** 细线的框：竖线的几何包围盒宽是 0、横线高是 0，照原样罩什么也看不见。
 *  按长边的比例撑到看得见（比例式，与纸张、字号、缩放无关）。 */
function plump(box: Box): Box {
  const min = Math.max(box.w, box.h) * 0.12;
  let { x, y, w, h } = box;
  if (w < min) {
    x -= (min - w) / 2;
    w = min;
  }
  if (h < min) {
    y -= (min - h) / 2;
    h = min;
  }
  return { x, y, w, h };
}

/** 画出来的字 `disp` 与原文的值 `src` 怎么对位：原文下标 = 显示下标 + 返回值；对不上为 null。
 *  署名会补「作词：」（显示包含原文），`.jpwabc` 的 `{三四}` 画出来不带括号（原文包含显示）。 */
function textShift(disp: string, src: string): number | null {
  const k = disp.indexOf(src);
  if (k >= 0) return -k;
  const k2 = src.indexOf(disp);
  if (k2 >= 0 && disp.length > 0) return k2;
  // 单独画出来的升降号字形（调号「1=♭B」的 csym ♭ 是自己一段，engrave/keysig.ts）：换回原文写法再找
  for (const spell of ACCIDENTAL_SPELLINGS.get(disp) ?? []) {
    const k3 = src.indexOf(spell);
    if (k3 >= 0) return k3;
  }
  return null;
}

/** 谱面上的升降号字形 → 原文里可能的写法（123 / `.jpwabc` 写 `b` `#` `n`，文本谱的降号写 `$`，也有人写 `♭♯♮`）。 */
const ACCIDENTAL_SPELLINGS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ...[GlyphCodes.csymAccidentalFlat, GlyphCodes.accidentalFlat, "♭"].map((g) => [g, ["b", "$", "♭"]] as [string, string[]]),
  ...[GlyphCodes.csymAccidentalSharp, GlyphCodes.accidentalSharp, "♯"].map((g) => [g, ["#", "♯"]] as [string, string[]]),
  ...[GlyphCodes.csymAccidentalNatural, GlyphCodes.accidentalNatural, "♮"].map((g) => [g, ["n", "♮"]] as [string, string[]]),
]);

/** 两份原文前后相同的部分去掉，剩下中间不同的那一段（局部补丁，撤销与光标映射都干净）。 */
function diffRegion(a: string, b: string): { from: number; to: number; insert: string } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return { from: p, to: a.length - q, insert: b.slice(p, b.length - q) };
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** 插入模式的当前时值怎么叫（模式标签上显示）。 */
function durName(d: NoteDuration): string {
  return d.halvings >= 0 && d.halvings <= 4 ? tr(`vis.dur${d.halvings as 0 | 1 | 2 | 3 | 4}`) : tr("vis.durN", { n: d.halvings });
}

/** 记号条目的中文说法（状态栏、菜单用）。 */
export function markLabel(e: SyncEntry): string {
  switch (e.markKind) {
    case "harmony": return tr("mark.harmony", { name: e.name ?? "" });
    case "annotation": return tr("mark.annotation", { name: e.name ?? "" });
    case "dynamic": return tr("mark.dynamic", { name: e.name ?? "" });
    case "slur": return tr("mark.slur");
    default: return tr("mark.other", { name: e.name ?? "" });
  }
}

/** 第一小节是弱起（第一声线的时值不满拍号的一小节）。 */
function isPickup(song: Song, part: Part): boolean {
  const m = part.measures[0];
  if (!m) return false;
  if (m.implicit) return true;
  const { time, dpq } = measureCtx(song, part, 0);
  if (!time) return false;
  const v1 = m.elements.filter((e) => e.kind === "chord" && e.voice === (m.elements.find((x) => x.kind === "chord")?.voice ?? 1) && !e.grace);
  const len = v1.reduce((a, e) => a + (e.kind === "chord" ? (e.duration?.divisions ?? 0) : 0), 0) / dpq;
  return len > 0 && len < (time.beats * 4) / time.beatType - 1e-6;
}
