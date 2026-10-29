// App controller: CodeMirror editor <-> live relayout/render <-> paging <-> file I/O.
// Mirrors EditorController in CodeEditor.kt (doBind/tryLoad/updateLayout/paint/load/doSave).

import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState, MapMode, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sniffDialect, type Dialect } from "../fanqie";
import type { ElementId, ScoreDoc } from "../model/doc";
import { applyBreaks } from "../model/breaks";
import { JpwFile, LayoutSection } from "../jpword/jpwfile";
import { measureDocument, PaintResources, ScorePainter, type StaffPaintRequest, type SyncPaintRequest } from "../layout/painter";
import { pageMargins, resolvePaper, songPageDecl } from "../style/paper";
import { songHeaderFonts, songLyricSize, songStaffSize } from "../model/pagemeta";
import { STAFF_LONG_IMAGE_WIDTH, STAFF_PAPER_DEFAULT, isPaper } from "../style/themes";
import { colorToCss } from "../common/geom";
import { MetaData } from "../smufl/smufl";
import type { BarsOverflow, FitMeasure } from "../jianpu/phrase";
import { docView } from "../jianpu/slots";
import { voiceNumbers } from "../jianpu/ast";
import type { JpwMeta, JpwRange } from "../omrkit/types";
import { loadConverter, type HanDirection } from "../common/hanconv";
import { convertScoreDoc, convertSourceText, detectHanDirection } from "../model/hanconv";
import { isTauriRuntime } from "./fileio";
import { is123File, isJcxFile, isJlyFile, isProjectFile, isFanqieFile } from "../common/filetypes";
import type { Draft } from "./autosave";
import { formatOf, musicXmlFormat, type DocFormatId, type FormatAdapter, type FormatHost, type ScoreDocAdapter } from "./formats";
import type { SyncIndex, SyncEntry } from "./sync";
import { SyncView } from "./syncview";
import { StyleState, type RenderSettings } from "./stylestate";
import { VisualEditController, type VisualHost } from "./visual/controller";
import { visualCursorExtension } from "./visual/cursor";
import { hitThroughOverlay } from "./visual/overlay";
import type { EditDialect } from "./visual/dialect";
import { planSave } from "../convert/capability";
import { withLyricsFrom, withMelodyFirst, withVisibleParts } from "../model/parts";
import { unpackProject } from "./omrproject";
import { dropEmbeddedLayout } from "../model/xmlsurface";
import { CONVERT_TARGETS, isConvertTarget, targetSpec, type ConvertTarget } from "../convert/targets";
import { hasTieSyntax, isXmlShaped, projectForMusicXml } from "../model/xmlproject";
import { assignDegrees } from "../model/jianpu";
import { t } from "../i18n";
import { diagText, targetLabel, type DiagLike } from "../i18n/labels";
import { buildMusicXml, sourceMusicXmlBare } from "./export";
import { scoreDocToMusicXml } from "../model/toxml";
import { jpwToScoreDoc } from "../model/fromjpw";
import { PlaybackController, type PlaybackHost } from "./playback";
import type { PlayPoint } from "./player";
import type { PlaySource } from "../score/timeline";
import { playSourceOf } from "../jianpu/playsong";
import { OmrController, type OmrHost } from "./omrctl";
import { FileSession } from "./filesession";
import { MixedSession } from "./mixedsession";
import { DocFormatSource, FormatSwitch, type FileSwitchHost, type FormatSwitchHost, type OriginFormat } from "./formatswitch";
import type { JianpuLayoutMode, JpProfileName } from "../jianpu/profile";
import {
  loadPersistedSettings, savePersistedSettings,
} from "./settings";
export type { OmrFormat } from "../omr";

export type { PaperEngine, PaperChoice } from "./stylestate";
import type { PaperChoice } from "./stylestate";

/** 谱面区的四档排版模式。见 `App.setViewModeButtons` 的注释：这是两组正交状态的组合。 */
export type ViewMode = JianpuLayoutMode | "staff" | "mixed";

/** 工具栏「分行」三档：照原文 / 按乐句重排 / 每行 N 小节（后两档都重写原文）。 */
export type LineMode = "original" | "phrase" | "bars";

/** 文本谱的扩展名。`.txt` 太泛，靠 sniffDialect 兜底，认不出就不动。 */

export class App implements OmrHost, PlaybackHost, FormatHost, FormatSwitchHost, FileSwitchHost, VisualHost {
  /** 预览排版器（唯一的 `ScorePainter`）：简谱原样 / 展开档、原样文档（文本谱与多声部）、五线谱 / 混排档
   *  都由它排、铺页、高亮。 */
  painter: ScorePainter;
  view!: EditorView;
  scorePane: HTMLElement;
  pageEls: HTMLElement[] = [];
  pageIndex = 0;
  filePath: string | null = null;
  mode: "jp" | "mixed" | "recognize" = "jp";
  /** 当前编辑的是哪种源格式。每种格式的差异全在 `editor/formats.ts` 的适配器表里，
   *  **不要在这里再长出 `docFormat === …` 的三目式**。 */
  docFormat: DocFormatId = "jpwabc";
  /** 文本谱当前的排版输出：`slide` = 展开、`print` = 原样（名字沿用存量设置）。 */
  originalProfile: "print" | "slide" = "slide";
  /** 简谱版面档：`normal` = 当前观感；`pptx` = 排版重构之前的笔画（导出 PPTX 用的那一档）。 */
  jpProfile: JpProfileName = "pptx";
  /** 最近一次排版用的 `.Layout` 分页描述（导出 PPTX 按展开档另排一遍时要用同一份）。 */
  private _breakDesc: string | null = null;
  /** 已解析出的文本谱方言，用于代码区标签（解析前未知）。 */
  private _fanqieDialect: Dialect | null = null;
  /** 上次解析结果的缓存（同一份文本不重复解析）。文本谱的乐句重排也读它（原文区间在模型上，`fanqie/relayout.ts`）。 */
  private _scoreDoc: { text: string; doc: ScoreDoc } | null = null;
  private _highlightCompartment = new Compartment();

  /** 双向定位的谱面一侧（代码区光标 ↔ 谱面元素，`syncview.ts`；索引本身在 `sync.ts`）。 */
  readonly syncView: SyncView = new SyncView(this);
  /** `.jpwabc`：`jpwToScoreDoc` 的结果（试听读它；转不出来为 null） */
  private _jpwDoc: ScoreDoc | null = null;
  /** 试听输入的缓存：同一份模型、同一档只拼一次（`refreshSpeedUi` 每次重排都要取速度） */
  private _playCache: { doc: ScoreDoc; src: PlaySource | null } | null = null;

  /** 五线谱/混排档的模型与它的派生（`mixedsession.ts`）。 */
  readonly mixed: MixedSession = new MixedSession(this);
  /** 五线谱/混排档读的模型（`MixedSession.mixedDoc`）；null = 还没有（或读不出）五线谱视图。 */
  get mixedDoc(): ScoreDoc | null {
    return this.mixed.mixedDoc;
  }
  /** 乐句档的五线谱行首（`MixedSession.staffPhraseLineStarts`）。 */
  staffPhraseLineStarts(doc: ScoreDoc): ReadonlySet<ElementId> | null {
    return this.mixed.staffPhraseLineStarts(doc);
  }
  /** MixedHost：当前源文投成不带版面坐标的 MusicXML（`export.ts::sourceMusicXmlBare`），带源元素 id。 */
  mixedSourceXml(): string {
    return sourceMusicXmlBare(this, { sourceIds: true });
  }
  /** 在途的五线谱 / 混排排版（异步），`whenIdle` 等它。 */
  private _pendingStaff: Promise<void> | null = null;
  /** 排版模式切换（展开 / 原样 / 五线谱 / 混排）的四个按钮，见 `ViewMode`。 */
  private _viewBtns = new Map<ViewMode, HTMLButtonElement>();
  private _viewSwitchEl: HTMLElement | null = null;
  /** `.musicxml` 读不出来时五线谱/混排两档置灰；文本格式一律可点（派生失败在点的时候报）。 */
  private _mixedAvailable = false;
  /** 代码区标题栏的格式下拉：识别结果与打开的文件共用（见 editor/formatswitch.ts）。 */
  readonly formats: FormatSwitch = new FormatSwitch(this);
  /** 简谱 OMR 的那一摊（识别、叠加核对、点选定位、输出格式）——见 editor/omrctl.ts。 */
  readonly omr: OmrController = new OmrController(this);
  // 分行三档：缓存导入时的「原始排版」文本以便无损切回；_lineMode 记当前是哪一档（按乐句 / 每行 N 小节都是重排原文）。
  private _originalLayoutBtnEl: HTMLButtonElement | null = null;
  private _phraseBtnEl: HTMLButtonElement | null = null;
  private _barsBtnEl: HTMLButtonElement | null = null;
  private _barsSelEl: HTMLSelectElement | null = null;
  private _origLayoutText: string | null = null;
  private _lineMode: LineMode = "original";
  /** 文本谱：上一次重排**产出的**那份原文。文本与它不同了就说明用户自己动过手。 */
  private _phraseText: string | null = null;
  /** 当前「每行 N 小节」排的是几小节（不在这一档时 null）。 */
  private _barsAt: number | null = null;
  private _hanziBtnEl: HTMLButtonElement | null = null;
  private _readOnlyCompartment = new Compartment();
  /** 渲染设置（样式层的用户层、诗集样式表、面板读写的字号/纸/配色）：`stylestate.ts`。 */
  readonly style: StyleState = new StyleState(this);

  /** 样式变了：简谱重排，五线谱/混排重铺（`.musicxml` 不经 reload）。 */
  rerender(): void {
    this._applyPageBg();
    this.reload(this.getText());
    if (this.mode === "mixed" && this.docFormat === "musicxml") void this._renderMixedPages();
  }

  /** 用户打开文件之后（打开对话框、拖入）：找诗集样式，单声部 MusicXML 再问要不要转简谱。 */
  async onDocumentOpened(): Promise<void> {
    await this.style.loadBookSheet();
    await this.promptMusicXmlImport();
  }

  /** 原样档换纸（「长图」也是其中一档）。 */
  setJpPaper(paper: string): void {
    this.applyRenderSettings({ jpPaper: paper });
  }

  mixedHideBarNumber = false; // 混排：隐藏小节号
  /** 用户打开单声部 MusicXML 时怎么办：`ask` 每次问；`musicxml` 保持原文进五线谱；其余是转成哪种源格式编辑。 */
  /** MusicXML（打开的 `.musicxml`、五线谱识别结果）落地后用哪种源码格式编辑；`musicxml` = 保持原样（没有代码区） */
  musicXmlImport: "musicxml" | ConvertTarget = "abc";
  mixedShowJianpuLayer = true;
  zoom = 1; // 谱面显示缩放（应用到 #score-pane 的 --score-zoom）
  /** SMuFL 字体元数据。help.ts 渲染记谱法示例时也要用同一份。 */
  readonly meta: MetaData;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private zoomSaveTimer: ReturnType<typeof setTimeout> | undefined;
  statusEl: HTMLElement | null = null;
  /** 试听播放的那一摊（播放器、速度倍率、分声部音量）——见 editor/playback.ts。 */
  readonly playback: PlaybackController = new PlaybackController(this);
  /** 可视化编辑（谱面上选中、光标、快捷键），入口 `app.visual.*` */
  readonly visual: VisualEditController = new VisualEditController(this);
  /** 试听/导出 MIDI 的速度倍率（1 = 谱面标注速度）。持久化。 */
  // Selected note (for "play from here"): its chord + which verse/pass row.
  private _selectedId: ElementId | null = null;
  private _selectedVerse = 0;
  /** 五线谱 / 混排上选中的和弦组（五线谱层与简谱叠层各一个）。 */
  private _staffSelected: SVGGElement[] = [];


  constructor(meta: MetaData, scorePane: HTMLElement) {
    this.meta = meta;
    this.painter = new ScorePainter(PaintResources.fixed(meta));
    this.scorePane = scorePane;
  }

  /** 简谱版面切换（原版 / PPT）。展开档 = 2026-08 排版重构之前的笔画观感，
   *  也是「导出 PPTX」用的那一档，见 style/jianpu.ts 的 `pptx` 预设。 */
  setJpProfile(profile: JpProfileName): void {
    if (this.jpProfile === profile) return;
    this.jpProfile = profile;
    // 换档连字号与配色也换了一套（两档各记各的，排版时按档取样式）；
    // 纸底那层是 CSS 变量、不经排版器，得单独刷一次
    this._applyPageBg();
    this._syncViewModeButtons();
    this.saveSettings();
    if (this.adapter.profileKnob === "jp") this.reload(this.getText());
  }

  /** 面板那几项设置落进**样式层的用户层**（`StyleState.apply`）并重排。签名沿用（回归脚本也走它）。 */
  applyRenderSettings(opts: RenderSettings): void {
    this.style.apply(opts);
    this._applyPageBg();
    this.saveSettings();
    this.reload(this.getText());
    // `.musicxml` 的五线谱/混排不经 reload 重排；谱里没写纸的要跟设置里的纸走
    if (this.mode === "mixed" && this.docFormat === "musicxml") void this._renderMixedPages();
  }

  /** 前景色与纸色（当前档）。设置面板走 `style`；这两个留着给回归脚本（`style-snapshot.mjs` 读 `__app.color`）。 */
  get color(): number {
    return this.style.color;
  }
  get bgColor(): number {
    return this.style.bgColor;
  }

  /** 恢复当前档的主题默认（清掉那一档的用户层）。 */
  resetRenderSettings(): void {
    this.style.resetMode(this.layoutMode);
    this._applyPageBg();
    this.saveSettings();
    this.reload(this.getText());
    // `.musicxml` 的五线谱/混排不经 reload 重排；谱里没写纸的要跟设置里的纸走
    if (this.mode === "mixed" && this.docFormat === "musicxml") void this._renderMixedPages();
  }

  /** Restore persisted render settings; call before mountEditor() so first render uses them.
   *  存取机制在 editor/settings.ts；这里只管「哪个值落到哪个属性」。 */
  loadSettings(): void {
    const s = loadPersistedSettings();
    if (!s) return;
    this.omr.loadSettings(s);
    this.playback.loadSettings(s);
    this.visual.loadSettings(s);
    if (s.mixedHideBarNumber !== undefined) this.mixedHideBarNumber = s.mixedHideBarNumber;
    if (s.mixedShowJianpuLayer !== undefined) this.mixedShowJianpuLayer = s.mixedShowJianpuLayer;
    this.style.load(s);
    if (s.zoom) this.zoom = s.zoom;
    if (s.jpProfile === "normal" || s.jpProfile === "pptx") this.jpProfile = s.jpProfile;
    if (s.originalProfile === "print" || s.originalProfile === "slide") this.originalProfile = s.originalProfile;
    this._applyZoom();
    this._applyPageBg();
  }

  /** 两个控制器也要用（切输出格式 / 改速度后持久化）。 */
  saveSettings(): void {
    savePersistedSettings({
      ...this.style.persisted(),
      zoom: this.zoom,
      mixedHideBarNumber: this.mixedHideBarNumber,
      mixedShowJianpuLayer: this.mixedShowJianpuLayer,
      musicXmlImport: this.musicXmlImport,
      playSpeed: this.playback.speed,
      playMetronome: this.playback.metronome,
      omrFormat: this.omr.format,
      omrFollow: this.omr.follow,
      omrSide: this.omr.side,
      ...(this.omr.compare ? { omrCompare: this.omr.compare } : {}),
      sideHideCode: this.omr.hideCode,
      omrAdjust: this.omr.adjustFirst,
      omrKind: this.omr.kind,
      jpProfile: this.jpProfile,
      originalProfile: this.originalProfile,
      showFormatMarks: this.visual.showFormatMarks,
      beatCheck: this.visual.beatCheck,
      noteSound: this.visual.noteSound,
      showPalette: this.visual.showPalette,
      transcriptionPresets: this.visual.transcriptionPresets,
      transcriptionPreset: this.visual.transcriptionPreset,
    });
  }

  // ---------------- zoom ----------------
  /** 设置谱面缩放（夹在 [0.25, 4]），持久化。 */
  setZoom(z: number): void {
    this.zoom = Math.min(4, Math.max(0.25, z));
    this._applyZoom();
    // 连续缩放（滚轮/捏合）期间不每帧写盘，停止后再持久化一次。
    clearTimeout(this.zoomSaveTimer);
    this.zoomSaveTimer = setTimeout(() => this.saveSettings(), 400);
  }
  zoomBy(factor: number): void {
    this.setZoom(this.zoom * factor);
  }
  resetZoom(): void {
    this.setZoom(1);
  }
  private _applyZoom(): void {
    this.scorePane.style.setProperty("--score-zoom", String(this.zoom));
  }

  /** 背景色灌进 #score-pane 的自定义属性，由 .score-page-wrap 继承。
   *  写在容器上而不是逐页写：页元素每次重排都重建（_renderPagesWith），
   *  写在容器上就不必在每条铺页路径里各记一次。 */
  private _applyPageBg(): void {
    this.scorePane.style.setProperty("--score-page-bg", colorToCss(this.style.bgColor));
  }

  mountEditor(parent: HTMLElement, initialText: string): void {
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        // 识别映射随用户编辑迁移偏移，保持点选仍落在正确 token。
        this.omr.remapMeta((m) => mapMeta(m, u.changes));
        this.omr.remapStaffLinks((pos) => u.changes.mapPos(pos, 1, MapMode.TrackDel));
        this.scheduleReload();
        this.files._scheduleDraft();
      }
      // 光标/选区一动就同步到谱面。文档改了不在这里同步——索引还是旧偏移，
      // 等 reload 重建完索引再由 SyncView.build 刷一次。
      if (u.selectionSet && !u.docChanged) {
        this.syncView.cursorToScore();
        this.visual.refresh();
      }
    });
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          // 双击歌词 / 页眉进来改字时的回车：按格式换行或结束改字（不是文字时照旧插换行）
          Prec.highest(keymap.of([
            { key: "Enter", run: () => this.visual.textEnter(false) },
            { key: "Shift-Enter", run: () => this.visual.textEnter(true) },
          ])),
          this._highlightCompartment.of(this.adapter.highlighter),
          updateListener,
          visualCursorExtension,
          this._readOnlyCompartment.of(EditorState.readOnly.of(false)),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-content": { fontFamily: "ui-monospace, Menlo, Consolas, monospace" },
          }),
        ],
      }),
    });
    this.files._cleanText = initialText; // 启动时的示例不算没存的内容
    this.reload(initialText);
  }

  getText(): string {
    return this.view.state.doc.toString();
  }


  setText(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    });
    // CodeMirror 会把 CRLF 规范成 LF；源位置索引必须按编辑器实际保存的文本建立，
    // 否则每过一行就多偏一位，末行条目会越过文档结尾并中断整个导入流程。
    const editorText = this.getText();
    // dispatch triggers updateListener -> scheduleReload, but reload now for snappiness
    // （防抖那一遍撤掉：同一份文本不必 200ms 后再排一次）
    clearTimeout(this.debounceTimer);
    this.reload(editorText);
  }

  private scheduleReload(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.reload(this.getText()), 200);
  }

  /** parse -> import -> layout -> render. Returns false on parse failure (text kept). */
  reload(text: string): boolean {
    this.formats.refreshNote(); // 改过没有：下拉旁「回到原稿」的提示跟着变
    // 识别模式：谱面区是核对视图，不重排成排版稿；但索引跟着原文重建、叠加层按当前模型重画（改过的标出来）
    if (this.mode === "recognize") {
      if (this.adapter.caps.layout === "jpwabc") this._refreshJpwDoc(text);
      const doc = this.adapter.caps.layout === "jpwabc" ? this._jpwDoc : this.currentScoreDoc();
      if (doc && this.adapter.caps.textEditor) this.syncView.buildIndex(doc);
      this.omr.renderPages();
      return true;
    }
    if (this.mode === "mixed") {
      // `.musicxml`：原文（模型那一路改的、撤销回来的）变了就重读；索引同步建，谱面异步排
      if (this.docFormat === "musicxml") {
        if (this.mixed._mixedXmlText !== text && !this.mixed._setMixedXml(text)) return false;
        if (this.mixedDoc) this.syncView.buildIndex(this.mixedDoc);
        void this._renderMixedPages();
        return true;
      }
      if (this.adapter.caps.layout === "jpwabc") this._refreshJpwDoc(text); // 导出 MIDI 读它
      if (!this.mixed._ensureMixedDoc()) return false;
      // 索引跟原文同步建（可视化编辑按它改原文），谱面元素等五线谱排完再绑（`_layoutStaff`）
      const src = this.adapter.caps.layout === "jpwabc" ? this._jpwDoc : this.currentScoreDoc();
      if (src && this.adapter.caps.textEditor) this.syncView.buildIndex(src);
      void this._renderMixedPages();
      return true;
    }
    const a = this.adapter;
    return a.reload ? a.reload(this, text) : this._reloadScoreDoc(a as ScoreDocAdapter, text);
  }

  /** 混排档下 `.jpwabc` 不走 `reloadJpwabc`，`_jpwDoc` 在这里跟上源文。 */
  private _refreshJpwDoc(text: string): void {
    try {
      const f = JpwFile.fromString(text);
      this._jpwDoc = f ? jpwToScoreDoc(f) : null;
    } catch {
      this._jpwDoc = null;
    }
  }

  /** 简谱视图此刻会排出的各行首音（和弦 id），五线谱自动铺排拿它当优选断点（`xmlproject.ts::applyLineStarts`）。
   *  另造一个排版器按当前档与纸排一遍，不动屏幕上那个（混排档里屏幕上那个可能还是旧文本排的）。
   *  文本谱、MusicXML 与多声部的原样档返回 null：那一路一行就是 `ScoreDoc` 里的一行，不用另给。 */
  jianpuLineStarts(): ReadonlySet<number> | null {
    try {
      let req: SyncPaintRequest | null;
      if (this.adapter.caps.layout === "jpwabc") {
        const f = JpwFile.fromString(this.getText());
        const doc = this.jpwDoc;
        if (!f || !doc) return null;
        req = { view: this.layoutMode, doc, style: this.style.styleOf(this.layoutMode), breakDesc: f.getSection(LayoutSection)?.desc ?? null };
      } else if (this.layoutMode === "expanded") {
        req = this.expandedRequest();
      } else {
        const doc = this.currentScoreDoc();
        if (!doc || this.docFormat === "fanqie" || this.docFormat === "musicxml" || !singleVoice(doc)) return null;
        req = { view: "original", doc, style: this.style.styleOf("original") };
      }
      if (!req) return null;
      // 另一个排版器实例按当前档与纸排一遍，不动屏幕上那个
      const p = new ScorePainter(this.painter.resources);
      p.loadSync(req);
      return new Set(p.result?.jianpuLineStarts ?? []);
    } catch (e) {
      console.warn("量简谱断行失败，按源文换行", e);
      return null;
    }
  }

  /** 「按乐句重排」开着没有。开着时五线谱另按乐句断（`staffPhraseLineStarts`），不跟简谱视图的行。 */
  get phraseOn(): boolean {
    return this._lineMode === "phrase";
  }

  /** `.jpwabc` 当前源文的模型（与简谱排版器、导出同一份，元素 id 对得上）。 */
  get jpwDoc(): ScoreDoc | null {
    return this._jpwDoc;
  }

  /** 五线谱/混排档的纸（键取自 `PAPER_SIZES`），出厂 `STAFF_PAPER_DEFAULT`。 */
  get staffPaper(): string {
    return this.style.staffStyle().page.paper ?? STAFF_PAPER_DEFAULT;
  }

  /** 五线谱/混排档的纸：设置里五线谱那张（谱里写了纸就是谱里那张，见曲内层）；长图按出厂纸宽、`heightPt = null`。
   *  `override`：用户明确选过纸——谱里的 `<page-layout>` 连同版面坐标都不用了，按这张纸重新铺排。 */
  get staffPage(): { widthPt: number; heightPt: number | null; marginsPt?: number[]; override: boolean } {
    const pg = this.style.staffStyle().page;
    const paper = resolvePaper(pg);
    const marginsPt = pageMargins(pg);
    const override = this.style.userSetsPaper("staff");
    return paper
      ? { widthPt: paper.w, heightPt: paper.h, marginsPt, override }
      : { widthPt: STAFF_LONG_IMAGE_WIDTH, heightPt: null, marginsPt, override };
  }

  reloadJpwabc(text: string): boolean {
    let f: JpwFile | null;
    try {
      f = JpwFile.fromString(text);
    } catch {
      return false;
    }
    if (!f) return false;
    let doc: ScoreDoc;
    try {
      doc = jpwToScoreDoc(f);
    } catch (e) {
      console.error("import failed", e);
      this._jpwDoc = null;
      return false;
    }
    this._jpwDoc = doc;
    if (!doc.songs[0]?.parts[0]) return false;
    this._syncPhraseBase(text);

    const breakDesc = f.getSection(LayoutSection)?.desc ?? null;
    this._breakDesc = breakDesc; // 导出 PPTX 时另排一遍要用同一份分页描述
    try {
      this.painter.loadSync({ view: this.layoutMode, doc, style: this.style.styleOf(this.layoutMode), breakDesc });
    } catch (e) {
      console.error("layout failed", e);
      return false;
    }
    this.renderPages();
    this.syncView.build(doc);
    this.playback.refreshSpeedUi(); // 谱面 ♩= 随文本走，速度提示要跟着换（读 `_jpwDoc`）
    return true;
  }



  /** `scoredoc` 那一路（文本谱、123、ABC、jcx、jianpu-ly、MusicXML）的重排：解析 → 闸门 → 排版 → 报诊断。
   *  各格式的差异在适配器的 `reloadSpec`（`formats.ts`），排版都交给同一个旧简谱引擎。 */
  private _reloadScoreDoc(adapter: ScoreDocAdapter, text: string): boolean {
    const spec = adapter.reloadSpec;
    const what = spec.what();
    spec.before?.(this, text);
    let doc: ScoreDoc;
    try {
      doc = adapter.toScoreDoc(text);
    } catch (e) {
      console.error(`${what} 解析失败`, e);
      const error = e instanceof Error ? e.message : String(e);
      this.setStatus(spec.parseFailed?.(error) ?? t("status.parseFailed", { what, error }));
      return false;
    }
    const diagLabel = spec.diagLabel?.(doc) ?? what;
    const rejected = spec.reject(doc);
    if (rejected !== null) {
      if (spec.reportOnReject) this._reportDiagnostics(diagLabel, doc.diagnostics);
      this.setStatus(rejected);
      return false;
    }
    this._scoreDoc = { text, doc };
    this._syncPhraseBase(text);
    // 只有文本谱的解析带方言（代码区标签要它），别的格式归 null
    this._fanqieDialect = (doc.fanqieDialect ?? (adapter.id === "fanqie" ? "tomato" : null)) as Dialect | null;
    this._syncFormatLabel();
    if (!this._layoutScoreDoc(doc, what)) return false;
    // 解析告警不拦排版，但要让用户看得见（谱面往往仍然是对的）
    this._reportDiagnostics(diagLabel, doc.diagnostics);
    return true;
  }

  /** 展开档的排版请求（导出 PPTX 在别的档另排一份用，`export.ts::pptxPainter`）。没有曲行时返回 null。 */
  expandedRequest(): SyncPaintRequest | null {
    const style = this.style.styleOf("expanded");
    const src = this.docFormat === "jpwabc" ? this._jpwDoc : this.currentScoreDoc();
    if (!src || !hasLines(src)) return null;
    if (this.docFormat === "jpwabc") return { view: "expanded", doc: src, style, breakDesc: this._breakDesc };
    return { view: "expanded", doc: this._expandedDoc(src), style };
  }

  /** 原样档的排版请求（导出 PNG/PDF 在别的档——识别模式、混排——另排一份用，`export.ts::originalPainter`）。没有文档时返回 null。 */
  originalRequest(): SyncPaintRequest | null {
    const style = this.style.styleOf("original");
    if (this.docFormat === "jpwabc") return this._jpwDoc ? { view: "original", doc: this._jpwDoc, style, breakDesc: this._breakDesc } : null;
    const doc = this.currentScoreDoc();
    return doc ? { view: "original", doc, style } : null;
  }

  /** 原样档的纸是不是长图（导出给 PNG 还是 PDF 按它分）。 */
  get jpLongImage(): boolean {
    return resolvePaper(this.style.styleOf("original").page) === null;
  }

  /** 展开档排的那份文档：MusicXML 按声部面板换旋律声部与歌词来源（元素 id 不变）。 */
  private _expandedDoc(doc: ScoreDoc): ScoreDoc {
    if (this.docFormat !== "musicxml") return doc;
    const lyr = this.lyricPart !== null ? withLyricsFrom(doc, this.lyricPart, this.melodyPart) : doc;
    return withMelodyFirst(lyr, this.melodyPart);
  }

  /** 经 `ScoreDoc` 排版并铺页（文本谱、123、ABC、jcx、jianpu-ly、MusicXML 共用，同一个旧简谱引擎）。 */
  private _layoutScoreDoc(doc: ScoreDoc, what: string): boolean {
    try {
      if (this.layoutMode === "expanded") {
        if (!hasLines(doc)) {
          this.setStatus(t("status.noLines", { what }));
          return false;
        }
        this.painter.loadSync({ view: "expanded", doc: this._expandedDoc(doc), style: this.style.styleOf("expanded") });
      } else {
        this.painter.loadSync({ view: "original", doc, style: this.style.styleOf("original") });
      }
    } catch (e) {
      console.error(`${what}排版失败`, e);
      this.setStatus(t("status.layoutFailed", { what, error: (e instanceof Error ? e.message : String(e)) }));
      return false;
    }
    this.renderPages();
    this.syncView.build(doc);
    return true;
  }

  // ---- VisualHost（可视化编辑向 App 要的能力，见 `visual/controller.ts`）----
  get sync(): SyncIndex {
    return this.syncView.index;
  }

  visualEnabled(): boolean {
    // 识别核对：要有点选映射（123 / 文本谱产物）才认得出框对着哪个元素
    if (this.mode === "recognize") {
      // 五线谱识别的对照按识别 id 认框，原文是哪种格式都行（文本格式按旁表，`omrlinks.ts`）
      return ((this.adapter.caps.textEditor && this.omr.hasMeta) || (this.visualSource() && this.omr.staffResult !== null)) && this.syncView.index.size > 0;
    }
    return (this.mode === "jp" || this.mode === "mixed") && this.visualSource() && this.syncView.index.size > 0;
  }

  /** 这种格式能不能在谱面上改：有代码区的文本格式改原文，`.musicxml` 改模型（`modelops.ts`）。 */
  visualSource(): boolean {
    return this.adapter.caps.textEditor || this.docFormat === "musicxml";
  }

  modelEditing(): boolean {
    return this.docFormat === "musicxml";
  }

  freshModel(): ScoreDoc | null {
    try {
      return musicXmlFormat.toScoreDoc(this.getText());
    } catch (e) {
      console.error("MusicXML 读取失败", e);
      return null;
    }
  }

  writeModel(doc: ScoreDoc): string {
    return scoreDocToMusicXml(doc);
  }

  /** VisualHost：ABC / 123 借道改模型——原文读成 MusicXML 形状（元素 id 与索引的相同，`projectForMusicXml` 不换 id）。 */
  get bridgeModel(): (() => ScoreDoc | null) | undefined {
    if (this.docFormat !== "abc" && this.docFormat !== "123") return undefined;
    return () => {
      try {
        const doc = this.adapter.toScoreDoc?.(this.getText());
        if (!doc) return null;
        const songs = doc.songs.map((s) => (isXmlShaped(s) ? s : projectForMusicXml(s, { slurTies: !hasTieSyntax(doc) })));
        // 模型那一路改的是音高；123 读进来的唱名留着就是旧的（写出端按唱名写），去掉让写出端按音高重推
        for (const s of songs) for (const p of s.parts) for (const m of p.measures) for (const el of m.elements) {
          if (el.kind === "chord") for (const n of el.notes) if (n.pitch) delete n.degree;
        }
        return { ...doc, songs };
      } catch {
        return null;
      }
    };
  }

  /** VisualHost：借道改完整份写回当前格式（123 / ABC 的写出端） */
  bridgeWrite(doc: ScoreDoc): string | null {
    try {
      // 唱名按改过的音高重推（`bridgeModel` 去掉了旧的；ABC 不用唱名，推了也无妨）
      for (const s of doc.songs) for (const p of s.parts) assignDegrees(p, s.key ?? { fifths: 0 });
      return targetSpec(this.docFormat === "abc" ? "abc" : "123").emit(doc);
    } catch {
      return null;
    }
  }

  /** 谱面是哪一路画的：简谱（旧简谱引擎 / 原样文档）还是五线谱 / 混排。几何命中（减时线、附点）只有简谱那一路有。 */
  surfaceKind(): "jianpu" | "staff" | "recognize" {
    return this.mode === "mixed" ? "staff" : this.mode === "recognize" ? "recognize" : "jianpu";
  }

  /** 五线谱 / 混排：光标竖线的高度取这个音所在系统的谱表带；简谱那一路为 null（按元素框）。 */
  caretBand(entry: SyncEntry): { svg: SVGSVGElement; y: number; h: number } | null {
    if (this.mode === "recognize") return this.omr.rowBand(entry.id);
    if (this.mode !== "mixed") return null;
    const m = this.syncView.mixedIds(entry.id)[0];
    return m === undefined ? null : this.painter.staffBand(m);
  }

  editDialect(): EditDialect | null {
    return this.adapter.editDialect ?? null;
  }

  syncDoc(): ScoreDoc | null {
    return this.syncView.doc;
  }

  playbackBusy(): boolean {
    return this.playback.busy;
  }

  syncFresh(): boolean {
    return this.syncView.fresh();
  }

  reloadNow(): void {
    clearTimeout(this.debounceTimer);
    this.reload(this.getText());
  }

  entryAtTarget(target: EventTarget | null): SyncEntry | null {
    return this.syncView.entryAt(target);
  }

  /** Alt+点原图补漏识：点的位置落在哪两个音之间（`OmrController.sourcePoint`） */
  sourcePoint(ev: MouseEvent): ReturnType<OmrController["sourcePoint"]> {
    return this.omr.sourcePoint(ev);
  }

  /** F8 导航：识别核对的可疑项（`OmrController.doubtStops`） */
  doubtStops(): { at: number; go(): void }[] {
    return this.omr.doubtStops();
  }

  // ---- OmrHost：核对视图里的可视化编辑 ----
  playbackActive(): boolean {
    return this.playback.active;
  }

  visualClick(ev: MouseEvent): void {
    const target = hitThroughOverlay(ev);
    const entry = this.syncView.entryAt(target);
    if (this.visual.handleClick(ev, entry)) return;
    if (entry) this.syncView.scoreToCursor(entry);
  }

  visualDblClick(ev: MouseEvent): void {
    this.visual.handleDoubleClick(ev, this.syncView.entryAt(hitThroughOverlay(ev)));
  }

  recognizeRendered(): void {
    if (this.mode === "recognize" && this.visualSource() && this.syncView.doc) this.syncView.bindEls();
  }

  // 「这个元素画在哪」：SyncView 按当前谱面（简谱 / 五线谱 / 识别核对）取
  entryEl(entry: SyncEntry): SVGGraphicsElement | null {
    return this.syncView.entryEl(entry);
  }
  noteEl(id: ElementId): SVGGraphicsElement | null {
    return this.syncView.noteEl(id);
  }
  chordEls(id: ElementId): SVGGraphicsElement[] {
    return this.syncView.chordEls(id);
  }
  augDotEls(id: ElementId): SVGGraphicsElement[] {
    return this.syncView.augDotEls(id);
  }
  barlineEl(entry: SyncEntry): SVGGraphicsElement | null {
    return this.syncView.barlineEl(entry);
  }
  sustainEl(entry: SyncEntry): SVGGraphicsElement | null {
    return this.syncView.sustainEl(entry);
  }
  slurEl(entry: SyncEntry): SVGGraphicsElement | null {
    return this.syncView.slurEl(entry);
  }
  inlineSustainEls(id: ElementId): SVGGraphicsElement[] {
    return this.syncView.inlineSustainEls(id);
  }
  textEls(entry: SyncEntry): SVGGraphicsElement[] {
    return this.syncView.textEls(entry);
  }

  // ---- 下面三个供脚本化测试（`window.__app`，见 scripts/sync-check.mjs）----
  syncEntries(): Array<{ from: number; to: number; verse: number | null }> {
    return this.syncView.entries();
  }
  syncElAt(from: number, verse: number | null): SVGGraphicsElement | null {
    return this.syncView.elAt(from, verse);
  }
  syncEntryOfEl(el: Element): { from: number; to: number; verse: number | null } | null {
    return this.syncView.entryOfEl(el);
  }

  /** 解析诊断 → 状态栏。不拦排版：谱面往往仍然是对的，但要让用户看得见。 */
  private _reportDiagnostics(
    what: string,
    diags: readonly DiagLike[],
  ): void {
    this.setStatus(
      diags.length === 0
        ? ""
        : t("status.diagnostics", { what, n: diags.length, line: diags[0]!.source.line + 1, message: diagText(diags[0]!) }),
    );
  }

  /** 文本谱版面切换（原版 / PPT）。 */
  setOriginalProfile(profile: "print" | "slide"): void {
    if (this.originalProfile === profile) return;
    this.originalProfile = profile;
    this._applyPageBg(); // 同 setJpProfile：配色两档各记各的，纸底那层不经排版器
    this._syncViewModeButtons();
    this.saveSettings();
    if (this.adapter.profileKnob === "original") this.reload(this.getText());
  }

  /** 当前档下切「展开」/「原样」该做什么——按文档格式分派：文本谱换整套 metrics
   *  （print/slide），简谱只换笔画常量（normal/pptx）。 */
  setProfile(slide: boolean): void {
    if (this.adapter.profileKnob === "original") this.setOriginalProfile(slide ? "slide" : "print");
    else this.setJpProfile(slide ? "pptx" : "normal");
  }

  /** 当前是哪一种排版输出（原样文档布局那几种格式看 originalProfile，简谱看 jpProfile——那两个只是引擎内部的尺寸档名）。 */
  get layoutMode(): JianpuLayoutMode {
    const slide =
      this.adapter.profileKnob === "original" ? this.originalProfile === "slide" : this.jpProfile === "pptx";
    return slide ? "expanded" : "original";
  }

  /** 当前文档的 `ScoreDoc`（文本谱/123/ABC；排版器、引擎输入、同步索引共用同一份对象）。 */
  currentScoreDoc(): ScoreDoc | null {
    const toScoreDoc = this.adapter.toScoreDoc;
    if (!toScoreDoc) return null;
    const text = this.getText();
    if (this._scoreDoc?.text === text) return this._scoreDoc.doc;
    try {
      const doc = toScoreDoc(text);
      this._scoreDoc = { text, doc };
      return doc;
    } catch {
      return null;
    }
  }


  /** 当前文本谱的排版器（播放高亮 / 导出用）。 */
  /** 见 `_breakDesc`。 */
  get breakDesc(): string | null {
    return this._breakDesc;
  }

  /** 当前源格式的适配器（高亮 / 编解码 / 标签 / 档位旋钮 / 能力位全走它）。 */
  get adapter(): FormatAdapter {
    return formatOf(this.docFormat);
  }

  // ---------------- FormatHost ----------------
  /** FormatHost：文本谱方言短名，供代码区标签用。 */
  get fanqieDialectName(): string | null {
    return this._fanqieDialect === null ? null : t(`fmt.short.${this._fanqieDialect}`);
  }

  /** 当前文本谱的方言（非文本谱为 null）。 */
  get fanqieDialect(): Dialect | null {
    return this.docFormat === "fanqie" ? this._fanqieDialect : null;
  }

  /** FormatHost：谱面排版器认得的标题。 */
  get painterTitle(): string {
    return this.painter.title;
  }

  /** 切换编辑的源格式：换高亮、清掉另一路的状态。 */
  private _setDocFormat(format: DocFormatId): void {
    if (this.docFormat === format) return;
    this.docFormat = format;
    this.view.dispatch({
      effects: this._highlightCompartment.reconfigure(this.adapter.highlighter),
    });
    this.mixed._dropMixedDoc(); // 换了格式，五线谱/混排的模型由新格式重新派生（`.musicxml` 由调用方随后读入）
    if (this.adapter.caps.layout === "scoredoc" && this.adapter.caps.textEditor) {
      // 乐句重排各格式各有写回原文的办法（`formats.ts::relayoutText`），可用性由各自的 reload 定。
      this._disablePhrase();
    } else {
      this._fanqieDialect = null;
      this._scoreDoc = null;
      }
    // 没有代码区的格式（`.musicxml`）把代码区收起来
    document.getElementById("body")?.classList.toggle("no-code", !this.adapter.caps.textEditor);
    this.omr.applyCodePane(); // 「源码」复选框跟着有没有代码区
    if (this.mode === "mixed") this._syncMixedReadOnly(); // 混排档里换格式：只读随格式走
    // 两种格式各记一个档位（jpProfile / originalProfile），换格式可能就换了档：下次重排按新档取样式
    this._syncViewModeButtons();
    this._syncFormatLabel();
  }

  /** 把若干页铺进 #score-pane。四种预览（简谱 / 文本谱 / 识别核对 / 混排）共用这一条骨架，
   *  差异全走 opts：各自的容器样式、每页要挂的事件、页码是清零还是夹取。 */
  private _renderPagesWith(
    count: number,
    svgOf: (i: number) => SVGSVGElement,
    opts: {
      /** 容器宽高比（连续长图/混排纸张随谱而变，不能用 CSS 里写死的 960/540）。 */
      aspectRatio?: (i: number) => string;
      /** 容器 position（识别浮窗要相对它绝对定位）。 */
      position?: string;
      /** 每页渲染完的额外处理（挂事件、改样式）。 */
      onPage?: (svg: SVGSVGElement, wrap: HTMLDivElement, i: number) => void;
      /** true = 页码清零（单页视图/换文档），false = 夹到新页数内（重排后保持当前页）。 */
      resetPageIndex?: boolean;
    } = {},
  ): void {
    this.scorePane.replaceChildren();
    this.pageEls = [];
    for (let i = 0; i < count; i++) {
      const svg = svgOf(i);
      const wrap = document.createElement("div");
      wrap.className = "score-page-wrap";
      if (opts.aspectRatio) wrap.style.aspectRatio = opts.aspectRatio(i);
      if (opts.position) wrap.style.position = opts.position;
      wrap.appendChild(svg);
      opts.onPage?.(svg, wrap, i);
      this.scorePane.appendChild(wrap);
      this.pageEls.push(wrap);
    }
    this.pageIndex = opts.resetPageIndex
      ? 0
      : Math.min(this.pageIndex, Math.max(0, this.pageEls.length - 1));
  }

  private renderPages(): void {
    this.playback.stop(); // relayout invalidates chord objects / highlight
    this._renderPagesWith(this.painter.pageCount, (i) => this.painter.renderPage(i), {
      // 连续长纸的宽高比逐页不同（CSS 里写死的 960/540 只对 PPT 那张纸成立）
      aspectRatio: (i) => {
        const { w, h } = this.painter.pageSize(i);
        return `${w} / ${h}`;
      },
      // 原样文档没有几何拾取，双向定位靠事件冒泡找 `<g>`
      onPage: this.painter.renderer === "jianpu"
        ? (svg) => {
          svg.addEventListener("click", (ev) => this._onSyncClick(ev));
          svg.addEventListener("dblclick", (ev) => this._onSyncDblClick(ev));
        }
        : (svg) => {
          svg.addEventListener("click", (e) => this.onPageClick(e));
          svg.addEventListener("dblclick", (e) => this._onSyncDblClick(e));
        },
    });
  }

  // ---------------- picking / selection ----------------
  /** 五线谱档的谱面点击：双向定位按 `<g>` 认（事件冒泡）；可视化编辑没接走就清掉旧的选中。 */
  private onPageClick(ev: MouseEvent): void {
    this._onSyncClick(ev);
    this.deselect();
    this.setStatus("");
  }

  /** 谱面被点击 → 代码区光标跳到对应原文。找不到对应条目就什么都不做
   *  （点在标题、小节线上都算找不到）。 */
  private _onSyncClick(ev: MouseEvent): boolean {
    if (this.mode !== "jp") return false;
    const entry = this.syncView.entryAt(hitThroughOverlay(ev));
    const onNote = entry !== null && (entry.kind === "note" || entry.kind === "lyric" || entry.kind === "sustain");
    // 原样文档没有几何拾取：播放 / 暂停中点音符按同步条目跳过去，不进可视化编辑的选中
    if (onNote && this.painter.renderer === "jianpu" && this.playback.active) {
      this.playback.seekTo({ id: entry.id, pass: entry.verse !== null ? entry.verse + 1 : 1 });
      return true;
    }
    if (this.visual.handleClick(ev, entry)) return true;
    if (entry) this.syncView.scoreToCursor(entry);
    // 原样文档没有几何拾取（`onPageClick` 不走），起播点按命中的同步条目记：点歌词按段（第 n 段 = 第 n 遍）
    if (entry && this.painter.renderer === "jianpu" && (entry.kind === "note" || entry.kind === "lyric" || entry.kind === "sustain")) {
      this._selectedId = entry.id;
      this._selectedVerse = entry.verse !== null ? entry.verse + 1 : 1;
      this.playback.seekTo({ id: entry.id, pass: this._selectedVerse });
    }
    return false;
  }

  /** 五线谱 / 混排被点击：点中和弦就选中它（两层一起描蓝）、记为起播点，播放中直接跳过去。 */
  private _onStaffClick(ev: MouseEvent): void {
    const target = hitThroughOverlay(ev);
    const id = this.painter.noteAt(target as Element | null);
    this.deselectStaff();
    this.deselect();
    // 文本格式：与简谱档同口径走可视化编辑（选中 / 光标 / 文字）；播放、暂停中点音符让给跳播
    if (this.visualEnabled() && !(id !== null && this.playback.active)) {
      if (id !== null) {
        this._selectedId = id;
        this._selectedVerse = 1;
        this.playback.seekTo({ id, pass: 1 });
      }
      const entry = this.syncView.entryAt(target);
      if (this.visual.handleClick(ev, entry)) return;
      if (entry) this.syncView.scoreToCursor(entry);
      return;
    }
    if (id === null) return;
    const els = this.painter.noteEls(id);
    for (const el of els) el.classList.add("selected");
    this._staffSelected = els;
    this._selectedId = id;
    this._selectedVerse = 1;
    this.playback.seekTo({ id, pass: 1 });
    // 文本格式：代码区光标跳到这个音的原文
    const span = this.syncView.index.spanOfNote(this.mixed._mixedToSrc.get(id) ?? -1);
    if (span && this.adapter.caps.textEditor) this.syncView.selectSpan(span);
  }

  private deselectStaff(): void {
    for (const el of this._staffSelected) el.classList.remove("selected");
    this._staffSelected = [];
  }

  /** 谱面被双击 → 文字对象进插入模式（单击只选中，见 `VisualEditController.handleDoubleClick`）。
   *  浏览器先发两次 `click` 再发这一下，所以选中在前、进编辑在后。 */
  private _onSyncDblClick(ev: MouseEvent): void {
    if (this.mode !== "jp" && this.mode !== "mixed") return;
    this.visual.handleDoubleClick(ev, this.syncView.entryAt(hitThroughOverlay(ev)));
  }

  private deselect(): void {
    this._selectedId = null;
    this._selectedVerse = 0;
  }

  setStatus(s: string): void {
    if (!this.statusEl) this.statusEl = document.getElementById("status");
    if (this.statusEl) this.statusEl.textContent = s;
  }

  /** 当前状态栏文本。main.ts 以前直接 getElementById("status").textContent 反读，
   *  两边各自硬编码同一个 DOM id 做通信。 */
  get status(): string {
    if (!this.statusEl) this.statusEl = document.getElementById("status");
    return this.statusEl?.textContent ?? "";
  }

  // ---------------- paging ----------------
  goToPage(i: number): void {
    const np = Math.max(0, Math.min(i, this.pageEls.length - 1));
    this.pageIndex = np;
    this.pageEls[np]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // ---------------- playback（控制器在 editor/playback.ts，这里只留与谱面相关的部分） ----------------
  /** PlaybackHost：三个预览模式都能试听（识别核对播的也是代码区那份，高亮落在识别框上）。 */
  get canPlay(): boolean {
    return this.mode === "jp" || this.mode === "mixed" || this.mode === "recognize";
  }

  /** PlaybackHost：当前该播的谱，由 ScoreDoc 拼。试听与导出 MIDI 都读它。
   *  MusicXML 形状（`.musicxml`、ABC 回落）带全部声部、voice 与力度；简谱形状（文本谱/123/ABC/`.jpwabc`）
   *  **不论屏幕在哪一档都按展开档的口径**（`forExpanded`：带歌词的声部当主旋律、同号歌词顺延）——
   *  唱几遍、每遍唱哪段词不随视图变，导出的 MIDI 在哪一档导都一样。 */
  playable(): PlaySource | null {
    // 五线谱 / 混排播画出来的那份（`mixedDoc`），元素 id 与五线谱上的和弦组对得上
    const staff = this.mode === "mixed";
    const jpw = !staff && this.adapter.caps.layout === "jpwabc";
    const doc = staff ? this.mixedDoc : jpw ? this._jpwDoc : this.currentScoreDoc();
    if (!doc) return null;
    const c = this._playCache;
    if (c && c.doc === doc) return c.src;
    let src: PlaySource | null = null;
    try {
      src = playSourceOf(doc, 0, staff || jpw ? {} : { forExpanded: true });
    } catch (e) {
      console.error("试听输入拼不出", e);
    }
    this._playCache = { doc, src };
    return src;
  }

  /** OmrHost：并排原图上点了某个音 → 排版稿里选中它（可视化编辑的选区；没有就只记起播点并点亮） */
  selectNote(id: ElementId): void {
    const span = this.syncView.index.spanOfNote(id);
    if (span && this.visualEnabled()) {
      this.visual.select(span.from, span.to);
      this.scorePane.focus({ preventScroll: true });
    }
    this._selectedId = this._playIdOf(id);
    this._selectedVerse = 1;
  }

  /** PlaybackHost：循环段——谱面上选中的第一个到最后一个音（可视化编辑的选区；五线谱 / 混排换成画出来那份的 id）。没有选区为 null。 */
  loopPoints(): { first: PlayPoint; last: PlayPoint } | null {
    const ids = this.visual.selectedNoteIds();
    if (!ids.length) return null;
    return { first: { id: this._playIdOf(ids[0]!), pass: 1 }, last: { id: this._playIdOf(ids[ids.length - 1]!), pass: 1 } };
  }

  /** 索引里的音 id → 试听那份谱里的 id（五线谱 / 混排播的是画出来那份 `mixedDoc`）。 */
  private _playIdOf(id: ElementId): ElementId {
    return this.mode === "mixed" ? this.mixed._srcToMixed.get(id)?.[0] ?? id : id;
  }

  /** PlaybackHost：用户在谱面上点了某个音就从那儿起播；没点过就从可视化编辑选区的第一个音起播
   *  （键盘选的、切档后留下的选区也算——选区在代码区，跨档本来就在）。 */
  startPoint(): PlayPoint | undefined {
    const id = this._selectedId;
    if (id !== null) return { id, pass: this._selectedVerse };
    const sel = this.visual.selectedNoteIds()[0];
    return sel === undefined ? undefined : { id: this._playIdOf(sel), pass: 1 };
  }

  /** PlaybackHost：播到某个元素 → 谱面高亮 + 保证可见。
   *  高亮留在 App 而不进控制器：各排版器按 id 找音的办法不同，那属于「谁在画谱面」。 */
  highlightPlaying(id: ElementId | null, pass: number, occ = 0): void {
    if (this.mode === "recognize") {
      this.omr.highlightPlaying(id);
      return;
    }
    const page = this.painter.highlight(id, pass, occ);
    if (id !== null && page !== null) {
      if (page !== this.pageIndex) this.pageIndex = page;
      // keep the sounding note visible (no-op when already in view)
      this.painter.entryEl(id, pass, occ)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  /** Number of parts in the current score (for the mixer UI). */
  get partCount(): number {
    return this.playable()?.parts.length ?? 1;
  }

  /** 换了一份文档（打开、导入、识别落地、转格式）：弱起重新认、简谱旋律回到第一声部、静音独奏作废。 */
  private _documentLoaded(): void {
    this.visual.documentLoaded();
    this.melodyPart = 0;
    this.lyricPart = null;
    this.hiddenParts.clear();
    this.playback.resetMix();
  }

  // ---------------- 声部（声部面板 `editor/parts.ts`） ----------------
  /** 简谱旋律取自第几个声部：混排的简谱叠层、MusicXML 的简谱档用它（会话内，不写文件） */
  melodyPart = 0;

  /** 声部面板要显示的那份模型（文本格式就是代码区原文读的那份，`.jpwabc` 是排版器那份）。 */
  partsDoc(): ScoreDoc | null {
    return this.adapter.caps.layout === "jpwabc" ? this._jpwDoc : this.currentScoreDoc();
  }

  /** 这种格式在声部面板里能改到哪一步：`structure` = 增删排拆合与改名谱号；`playback` = 只有试听与简谱旋律。 */
  partsEditable(): "structure" | "playback" {
    return this.docFormat === "musicxml" || this.docFormat === "123" || this.docFormat === "abc" ? "structure" : "playback";
  }

  /**
   * 改声部：在按当前原文新读的一份模型上改，`.musicxml` 经唯一写出端整份重写，123 / ABC 经各自的写出器整份重出
   * （声部的增删排拆合在原文里牵涉每个 `V:` 段，局部补丁做不干净；原文里的 `%` 注释会丢，调用方先问过）。
   * 只把前后不同的一段放进代码区，撤销照常。返回 false = 没改或改不了。
   */
  editParts(mutate: (doc: ScoreDoc) => boolean | number | void, structural = true): boolean {
    if (this.partsEditable() !== "structure") return false;
    const text = this.getText();
    let doc: ScoreDoc | null;
    try {
      doc = this.adapter.toScoreDoc ? this.adapter.toScoreDoc(text) : null;
    } catch {
      doc = null;
    }
    if (!doc) return false;
    const r = mutate(doc);
    if (r === false || r === -1) return false;
    // MusicXML 增删排拆合了声部：原谱写死的版面坐标对不上了，整曲改由五线谱引擎自动铺排（同谱面上改结构）
    if (structural && this.docFormat === "musicxml") for (const s of doc.songs) dropEmbeddedLayout(s);
    let out: string;
    try {
      out = this.docFormat === "musicxml" ? scoreDocToMusicXml(doc) : targetSpec(this.docFormat === "abc" ? "abc" : "123").emit(doc);
    } catch (e) {
      this.setStatus(t("status.partsFailed", { error: e instanceof Error ? e.message : String(e) }));
      return false;
    }
    return this.replaceText(out, "input.parts");
  }

  /** 整份原文换成 `next`（只放前后不同的那一段进代码区，撤销照常），马上重排。没变返回 false。 */
  replaceText(next: string, userEvent = "input"): boolean {
    const text = this.getText();
    if (next === text) return false;
    let p = 0;
    while (p < text.length && p < next.length && text[p] === next[p]) p++;
    let q = 0;
    while (q < text.length - p && q < next.length - p && text[text.length - 1 - q] === next[next.length - 1 - q]) q++;
    this.view.dispatch({ changes: { from: p, to: text.length - q, insert: next.slice(p, next.length - q) }, userEvent });
    this.reloadNow();
    return true;
  }

  /** 五线谱 / 混排里藏起来的声部（会话内，不写文件；试听照样出声，要不出声用静音） */
  readonly hiddenParts = new Set<number>();
  /** 简谱档的歌词取自哪个声部（MusicXML；null = 跟简谱旋律同一个声部）。会话内 */
  lyricPart: number | null = null;

  /** 声部增删、排序、拆合之后：按声部记的会话设置（隐藏、简谱旋律、歌词来源、静音独奏音量）跟着声部走。
   *  `map` 旧序号 → 新序号，删掉（并走）的为 -1。 */
  remapParts(map: (i: number) => number): void {
    const hidden = [...this.hiddenParts];
    this.hiddenParts.clear();
    for (const i of hidden) if (map(i) >= 0) this.hiddenParts.add(map(i));
    this.melodyPart = Math.max(0, map(this.melodyPart));
    if (this.lyricPart !== null) {
      const j = map(this.lyricPart);
      this.lyricPart = j >= 0 ? j : null;
    }
    this.playback.remapParts(map);
    this.reloadNow();
    if (this.mode === "mixed") void this._renderMixedPages();
  }

  setPartVisible(i: number, on: boolean): void {
    if (on) this.hiddenParts.delete(i);
    else this.hiddenParts.add(i);
    if (this.mode === "mixed") void this._renderMixedPages();
  }

  setLyricPart(i: number | null): void {
    if (this.lyricPart === i) return;
    this.lyricPart = i;
    this.reloadNow();
  }

  /** 改「简谱旋律取自」：混排与 MusicXML 的简谱档跟着重排。 */
  setMelodyPart(i: number): void {
    if (this.melodyPart === i) return;
    this.melodyPart = i;
    this.reloadNow();
    if (this.mode === "mixed") void this._renderMixedPages();
  }

  /** 停止试听。四处铺页前都要调，故留一个短名字在 App 上。 */
  stopPlayback(): void {
    this.playback.stop();
  }

  nextPage(): void {
    this.goToPage(this.pageIndex + 1);
  }
  prevPage(): void {
    this.goToPage(this.pageIndex - 1);
  }

  // ---------------- file I/O ----------------
  /** 按扩展名落地：.abc / .123 / .jcx / 文本谱 / .musicxml（无代码区）各进原生格式；其余按 UTF-16 .jpwabc 读。 */
  importBytes(bytes: Uint8Array, name: string): void {
    // 识别项目：还原整个识别会话（原图、识别结果、在改的原文），不重跑识别
    if (isProjectFile(name)) {
      void this.openProject(bytes, name);
      return;
    }
    // 任何新导入都使上一次的识别叠加产物失效（识别结果由 OmrController 在本调用之后重设）。
    this.omr.clear();
    this._documentLoaded();
    this.formats.use(null);
    this._importBytes(bytes, name);
    this.markClean();
    // 原文是真身：代码区标题栏的格式下拉可以换成别的格式看、切回来逐字还原（`DocFormatSource`）
    const origin = this._originFormat();
    if (origin) this._useDocSource(origin);
  }

  /** 用户**亲手打开** MusicXML 之后调（打开对话框、拖入；重开上次文件与回归脚本不走这里）：按设置转成默认编辑格式
   *  （`openInEditFormat`）；保持 MusicXML 的，单声部进五线谱档。 */
  async promptMusicXmlImport(): Promise<void> {
    if (this.docFormat !== "musicxml") return;
    const note = this.openInEditFormat();
    if (this.docFormat === "musicxml" && this.mode !== "mixed") await this.setViewMode("staff");
    if (note) this.setStatus(note);
  }

  /**
   * MusicXML 落地后（打开的 `.musicxml`、五线谱识别结果）转成设置里的默认编辑格式（缺省 ABC），不弹框：
   * 装不下就改用建议的格式，都装不下留在 MusicXML（`DocFormatSource.autoSwitch`）。MusicXML 原文留在格式下拉里切得回去。
   * 返回给状态栏的说明（保持 MusicXML 的为空串）。
   */
  openInEditFormat(): string {
    const pref = this.musicXmlImport;
    const src = this.formats.source;
    if (pref === "musicxml" || this.docFormat !== "musicxml" || !(src instanceof DocFormatSource)) return "";
    const r = src.autoSwitch(pref);
    this.formats.sync();
    const name = (f: string): string => (f === "musicxml" ? "MusicXML" : targetLabel(f as ConvertTarget));
    const items = r.lost.map((l) => l.name).join("、");
    if (r.to === pref) return t("fs.autoConverted", { format: name(pref) });
    if (r.to === "musicxml") return t("fs.autoStay", { format: name(pref), items });
    return t("fs.autoOther", { format: name(pref), to: name(r.to), items });
  }

  /** OmrHost：一份模型过一遍当前源格式（写出再读回）。 */
  viaCurrentFormat(doc: ScoreDoc): ScoreDoc | null {
    const target = this.formats.source?.current();
    const spec = CONVERT_TARGETS.find((c) => c.id === target);
    if (!spec || !this.adapter.toScoreDoc) return null;
    try {
      return this.adapter.toScoreDoc(spec.emit(doc));
    } catch {
      return null;
    }
  }

  /** OmrHost：现在有没有代码区（`.musicxml` 没有）。 */
  hasCodePane(): boolean {
    return this.adapter.caps.textEditor;
  }

  /**
   * OmrHost：在没有代码区的 `.musicxml`（打开的、五线谱识别出的）上勾「源码」= 转成默认编辑格式来改
   * （设置里「打开 MusicXML」选的文本格式，没选过用 ABC）。与格式下拉同一条路：装不下的先列出来、给出建议格式，
   * MusicXML 原文留在下拉里切得回去。
   */
  async openSourceView(): Promise<void> {
    if (this.adapter.caps.textEditor || this.docFormat !== "musicxml") return;
    await this.convertToTextDoc(isConvertTarget(this.musicXmlImport) ? this.musicXmlImport : "abc");
  }

  /** 装上「真身跟着改动走」的格式来源（打开的文件、五线谱识别结果）。 */
  private _useDocSource(origin: OriginFormat): void {
    const src = new DocFormatSource(this, { format: origin, text: this.getText() });
    src.onSwitched = () => this.formats.sync();
    this.formats.use(src);
  }

  /** 刚打开的原文是哪种格式（下拉里「原文」那一项）。文本谱按嗅探出的方言算。 */
  private _originFormat(): OriginFormat | null {
    switch (this.docFormat) {
      case "musicxml": return "musicxml";
      case "fanqie": return this._fanqieDialect ?? sniffDialect(this.getText()).dialect;
      default: return this.docFormat;
    }
  }

  private _importBytes(bytes: Uint8Array, name: string): void {
    // ABC 记谱：**原文就是源格式**，原生解析直接进编辑器（`formats.ts` 的 ABC 适配器），不再转 MusicXML。
    if (/\.abc$/i.test(name)) {
      this.mixed._dropMixedDoc(); // 原来在五线谱/混排就留在那档：setText → reload 会重新派生
      this._setDocFormat("abc");
      this.setText(formatOf("abc").decode(bytes));
      return;
    }
    // 123（简谱主格式）：原文就是源格式，直接进编辑器，不做任何转换。
    if (is123File(name)) {
      this.mixed._dropMixedDoc();
      this._setDocFormat("123");
      this.setText(formatOf("123").decode(bytes));
      return;
    }
    // jianpu-ly（`.jly`）：**只看扩展名** —— 上游输入里没有版本行 / 签名 / 必需项，
    // 内容嗅探只能靠猜；`.jly` 是它自己 `--export-jly` 写出来的后缀，拿到它就是这个格式
    // （详见 `jly/fromjly.ts` 文件头）。
    if (isJlyFile(name)) {
      this.mixed._dropMixedDoc();
      this._setDocFormat("jly");
      this.setText(formatOf("jly").decode(bytes));
      return;
    }
    // Muse 曲谱软件（`.jcx`）：ABC 方言，原生解析。字节编码（GBK / BIG5 / UTF-8）由 `common/jcxcodec.ts` 判断
    if (isJcxFile(name)) {
      this.mixed._dropMixedDoc();
      this._setDocFormat("jcx");
      this.setText(formatOf("jcx").decode(bytes));
      return;
    }
    // 文本谱（番茄 / 诗歌本）：原文就是源格式，直接进编辑器，不做任何转换。
    if (isFanqieFile(name)) {
      const fanqieText = formatOf("fanqie").decode(bytes);
      const sniffed = sniffDialect(fanqieText);
      if (sniffed.dialect === null) {
        // `.txt` 太泛，认不出宁可不动——硬解只会得到一首乱谱
        this.setStatus(t("status.notFanqie", { reason: sniffed.reason }));
        return;
      }
      this.mixed._dropMixedDoc();
      this._setDocFormat("fanqie");
      this.setText(fanqieText);
      return;
    }
    if (/\.(xml|musicxml)$/i.test(name)) {
      // MusicXML：**没有代码区**，只进谱面视图（五线谱/混排，或由 `ScoreDoc` 排出的简谱）。
      // 编辑器文档里存的就是 XML 原文（不显示）：存回原文件时没改过就是原文，零损耗。
      // 要编辑就「转成文本格式」，那是另一份新文档（`convertToTextDoc`）。
      const xml = formatOf("musicxml").decode(bytes);
      this._setDocFormat("musicxml");
      if (!this.mixed._setMixedXml(xml)) return;
      this._setMixedAvailable(true);
      // 多声部（SATB 等）歌谱默认进入混排模式
      const toMixed = this.mode === "mixed" || isMultiPartXml(xml);
      if (toMixed) this._setMode("mixed");
      else this._setMode("jp");
      this.setText(xml);
      if (toMixed) void this._renderMixedPages();
      return;
    } else {
      this._setDocFormat("jpwabc");
      this.mixed._dropMixedDoc();
      this._disablePhrase();
      this.setText(formatOf("jpwabc").decode(bytes));
    }
  }

  /**
   * 简谱识别产物落地（`OmrHost.importOmrDoc`）：识别直出的模型（`omr/todoc.ts`）写成 123 核对文本，
   * 之后就是一份普通的 123 文档（导出 MusicXML 也由这份文本整份写出）。
   */
  importOmrDoc(doc: ScoreDoc, text: string): void {
    this.omr.clear();
    this._documentLoaded();
    const losses = planSave(doc, "123");
    this.mixed._dropMixedDoc();
    this._setMode("jp"); // omrctl 接着切原样档、按用户选过的核对方式进（没选过就并排原图，`enterAfterRecognize`）
    this._setDocFormat("123");
    this.filePath = null;
    this.setText(text);
    if (losses.length) {
      this.setStatus(t("status.omrLosses", { n: losses.length }));
    }
  }

  /**
   * 五线谱识别产物落地：与打开 `.musicxml` 同一个模式（无代码区、谱面由 XML 出），默认进混排。
   * 五线谱识别的产物带和弦、多声部、slur，`.jpwabc` 装不下，所以不再转简谱文本。
   * `rebuild`：同一次识别按新关联 / 系统切分重建的那份——只重认弱起，声部静音独奏照旧（此前落地漏了这一步，弱起一直按开机那份示例谱认）。
   */
  adoptStaffXml(xml: string, rebuild = false): boolean {
    if (rebuild) this.visual.documentLoaded();
    else this._documentLoaded();
    this._setDocFormat("musicxml");
    if (!this.mixed._setMixedXml(xml)) return false;
    this._setMixedAvailable(true);
    this._setMode("mixed");
    this.filePath = null;
    this.setText(xml);
    // 识别出的 MusicXML 是真身：格式下拉换成 ABC / 123 / 简谱编辑，不重识别、切回来逐字还原
    this._useDocSource("musicxml");
    void this._renderMixedPages();
    return true;
  }

  /** FormatHost：五线谱/混排那份跟上 MusicXML 原文。打开/落地时已按这份原文读过，原文没变就不再读。 */
  syncMixedXml(text: string): void {
    if (!this.mixed.mixedDoc || this.mixed._mixedXmlText !== text) this.mixed._setMixedXml(text);
  }

  /**
   * 改动 `.musicxml` 的模型（五线谱编辑的入口）：改完**整份重写**成 XML 放回文档，谱面跟着重排。
   * 存回原文件写的就是这份——`fromxml.ts` 把读不懂的原样挂在 `raw` 上，全量重写不丢东西
   * （`xml-direct-check.mjs`：568 份十类关键元素一个没掉），所以不再走底本 patch。
   */
  editScoreDoc(mutate: (doc: ScoreDoc) => void): boolean {
    if (this.docFormat !== "musicxml") return false;
    // 改一份新读的，不动 `currentScoreDoc()` 那份共用对象（行视图、投影按对象身份缓存，原地改了它们不知道）
    const doc = this.freshModel();
    if (!doc) return false;
    mutate(doc);
    this.setText(scoreDocToMusicXml(doc)); // `reload` 按新原文重读模型、重排（混排档同）
    return true;
  }

  /**
   * 把当前 `.musicxml` **转成文本格式**再编辑：与代码区标题栏的格式下拉同一条路（`FileFormatSource`）——
   * 先列出目标格式装不下的东西，确认后换成该格式、清掉文件路径（原 `.musicxml` 不动），代码区出现；
   * 下拉里「MusicXML（原文）」切得回来。
   */
  async convertToTextDoc(target: ConvertTarget): Promise<void> {
    if (this.docFormat !== "musicxml") return;
    const src = this.formats.source;
    if (!src) {
      this.setStatus(t("status.xmlUnreadable"));
      return;
    }
    // 谱里写的纸：123/ABC 带得过去（`I:meta page …`）；`.jpwabc`、文本谱没有字段，改记进设置里的纸
    const song = this.currentScoreDoc()?.songs[0];
    const page = song ? songPageDecl(song) : null;
    const staffMm = song ? songStaffSize(song) : null;
    const lyricPt = song ? songLyricSize(song) : null;
    const headerFonts = song ? songHeaderFonts(song) : {};
    const ok = await src.switchTo(target);
    this.formats.sync();
    if (!ok) return;
    // 损失框里可能改用了建议的格式
    const now: DocFormatId = this.docFormat as DocFormatId; // switchTo 之后已不是 musicxml（TS 还按上面的判断收窄着）
    if (now !== "jpwabc" && now !== "fanqie") return;
    if (page && isPaper(page.paper)) {
      const choice: PaperChoice = { paper: page.paper!, orientation: page.orientation ?? "portrait", margin: pageMargins(page) ?? null };
      this.style.setPaper("jianpu", choice);
      this.style.setPaper("staff", choice);
    }
    // 谱表大小与歌词字号也装不下，同样记进五线谱那一档（否则转完五线谱/混排按出厂 7mm，字相对音符小一圈）
    if (staffMm || lyricPt) this.style.setStaffSize({ ...(staffMm ? { mm: staffMm } : {}), ...(lyricPt ? { lyricPt } : {}) });
    this.style.carryHeaderFonts(headerFonts);
    if (!page && !staffMm && !lyricPt && !Object.keys(headerFonts).length) return;
    this.saveSettings();
    this.reload(this.getText());
  }

  /** 每次重排/重渲染后同步乐句重排的基准文本与按钮可用性。
   *
   *  **用户手改过的文本就是新的「原样」基准**（切回按钮要还原到它）。重排后又手改的，
   *  也按「这就是新的原样」算——否则一按「原样」就把用户后来的编辑抹了。 */
  private _syncPhraseBase(text: string): void {
    if (!this.adapter.caps.phraseRelayout) {
      this._disablePhrase();
      return;
    }
    if (this._lineMode !== "original" && text !== this._phraseText) {
      this._lineMode = "original";
      this._setPhraseActive();
    }
    if (this._lineMode === "original") this._origLayoutText = text;
    this._setPhraseAvailable(true);
  }

  private _disablePhrase(): void {
    this._origLayoutText = null;
    this._lineMode = "original";
    this._setPhraseActive();
    this._setPhraseAvailable(false);
  }

  /** OmrHost：上下文相关控件的显隐。 */
  setContextControl(el: Element | null, visible: boolean): void {
    this._setContextControl(el as HTMLElement | null, visible);
  }

  /** OmrHost：所在 context-tool-group 的整体显隐同步。 */
  syncContextGroup(el: Element | null | undefined): void {
    this._syncContextGroup((el ?? null) as HTMLElement | null);
  }

  private _setContextControl(el: HTMLElement | null, visible: boolean): void {
    if (!el) return;
    el.hidden = !visible;
    if (el instanceof HTMLButtonElement) el.disabled = !visible;
    this._syncContextGroup(el);
  }

  private _syncContextGroup(el: HTMLElement | null): void {
    if (!el) return;
    const group = el.closest<HTMLElement>(".context-tool-group");
    if (group) group.hidden = !group.querySelector("[data-context-control]:not([hidden])");
  }

  setPhraseButtons(original: HTMLButtonElement, phrase: HTMLButtonElement, bars: HTMLButtonElement, barsSel: HTMLSelectElement): void {
    this._originalLayoutBtnEl = original;
    this._phraseBtnEl = phrase;
    this._barsBtnEl = bars;
    this._barsSelEl = barsSel;
    this._setPhraseActive();
    this._setPhraseAvailable(false);
  }

  private _setPhraseAvailable(available: boolean): void {
    const switchEl = this._phraseBtnEl?.closest<HTMLElement>(".layout-mode-switch");
    if (!switchEl) return;
    switchEl.hidden = !available;
    for (const el of [this._originalLayoutBtnEl, this._phraseBtnEl, this._barsBtnEl, this._barsSelEl]) {
      if (el) el.disabled = !available;
    }
    this._syncContextGroup(switchEl);
  }

  private _setPhraseActive(): void {
    const pairs: Array<[HTMLElement | null, LineMode]> = [
      [this._originalLayoutBtnEl, "original"], [this._phraseBtnEl, "phrase"], [this._barsBtnEl, "bars"],
    ];
    for (const [el, mode] of pairs) {
      el?.classList.toggle("active", this._lineMode === mode);
      el?.setAttribute("aria-pressed", String(this._lineMode === mode));
    }
    this._barsSelEl?.closest(".bars-per-line")?.classList.toggle("active", this._lineMode === "bars");
  }

  /** 切分行档：原始排版 / 按乐句重排 / 每行 `n` 小节。 */
  setLineMode(mode: LineMode, n?: number): void {
    if (this.adapter.caps.phraseRelayout) this._setLineMode(mode, n);
  }

  /**
   * 「按乐句重排」「每行 N 小节」：**重排的是原文本身**，两档因此同时就位——文本谱一行 `Q:`（123 一个 `$`）
   * 就是谱面一行，展开档的行边界由 `jianpu/jianpuinput.ts` 转成换行条目。怎么写回原文由各格式
   * 的适配器给（`editor/formats.ts::relayoutText`）。
   * 两种重排都从**重排前那份原文**起算（互切、改 N 都不在重排结果上再排）；
   * 切回「原样」= 把那份原文放回去（逐字相同，Ctrl+Z 也能整体撤销）。
   */
  private _setLineMode(mode: LineMode, n?: number): void {
    const bars = n ?? this._barsN;
    if (this._lineMode === mode && (mode !== "bars" || bars === this._barsAt)) return;
    const base = this._lineMode === "original" ? this.getText() : this._origLayoutText;
    if (base === null) return;
    if (mode === "original") {
      this._lineMode = "original";
      this._setPhraseActive();
      this.setText(base);
      return;
    }
    const relayout = this.adapter.relayoutText;
    if (!relayout) return;
    try {
      let overflow: BarsOverflow | null = null;
      const measure = this._fanqiePhraseMeasure();
      const out = relayout(base, mode === "phrase"
        ? { kind: "phrase", measure }
        : { kind: "bars", n: bars, measure, onOverflow: (at) => { overflow ??= at; } });
      // 放不下比「没变」要紧：原文本来就是每行 N 小节、纸却放不下时也得说
      const overflowText = (at: BarsOverflow): string => at.songs > 1
        ? t("status.barsOverflowSong", { n: bars, song: at.song + 1, line: at.line })
        : t("status.barsOverflow", { n: bars, line: at.line });
      if (out === base && this._lineMode === "original") {
        this.setStatus(overflow !== null ? overflowText(overflow)
          : t(mode === "phrase" ? "status.phraseSame" : "status.barsSame", { n: bars }));
        return;
      }
      this._origLayoutText = base;
      this._phraseText = out;
      this._lineMode = mode;
      this._barsAt = mode === "bars" ? bars : null;
      this._setPhraseActive();
      if (out !== this.getText()) this.setText(out);
      if (overflow !== null) this.setStatus(overflowText(overflow));
    } catch (e) {
      console.error("重排失败", e);
      this.setStatus(t("status.phraseFailed", { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  /** 「每行 N 小节」的 N（工具栏下拉，记住上次选的）。 */
  private get _barsN(): number {
    const v = Number(this._barsSelEl?.value);
    return Number.isInteger(v) && v > 0 ? v : 4;
  }

  /**
   * 乐句重排的行长尺子：按当前档的纸、字号与样式量自然宽（`painter.ts::measureDocument`，与真正排版同一个引擎）。
   * 各格式同一把（`.jpwabc`、文本谱也量）——不量的那份乐句行在原样档放不下，排版器整首按宽度重断，乐句全丢，
   * 几种格式就排得不一样了（「脚步」）。
   *
   * 原样档的尺子**只判放不放得下**（`noPairs`）：要的是一句一行，印刷原版就这样；让它并两句的话
   * 会以为「两句并一行还宽绰」，73《我主耶稣是生命源》一行排了 8 小节。多声部的原样档不给尺子（文本谱多声部不重断）。
   */
  private _fanqiePhraseMeasure(): FitMeasure | null {
    const view = this.layoutMode;
    if (view === "original") {
      const doc = this.docFormat === "jpwabc" ? this._jpwDoc : this.currentScoreDoc();
      if (!doc || !singleVoice(doc)) return null;
    }
    const sheet = this.style.styleOf(view);
    const width = this.style.layoutPage.w;
    const noPairs = view === "original";
    return (doc, song) => ({ ...measureDocument(doc, sheet, width, view === "expanded", song), noPairs });
  }

  /** 注册工具栏「简繁」按钮，供转换期间切换加载中状态。 */
  setHanziButton(el: HTMLButtonElement): void {
    this._hanziBtnEl = el;
  }

  /**
   * 整篇简繁转换（`model/hanconv.ts`，以 ScoreDoc 为准，五种格式通用）。
   * 文本格式只改原文里文字所在的位置（单个 CodeMirror transaction，Ctrl+Z 可整体撤销）；
   * `.musicxml` 没有代码区，改模型后整份重写（`editScoreDoc`）。dir = "auto" 时按文字字形自动判定方向。
   */
  async convertHanzi(dir: "auto" | HanDirection): Promise<void> {
    if (this.mode === "recognize") return;
    const parse = this._hanParser();
    const doc = parse ? this._tryParse(parse, this.getText()) : null;
    if (!parse || !doc) {
      this.setStatus(t("status.hanUnparsable"));
      return;
    }
    const btn = this._hanziBtnEl;
    const label = btn?.textContent ?? t("toolbar.hanzi");
    if (btn) {
      btn.disabled = true;
      btn.textContent = t("status.loading");
    }
    try {
      const d = dir === "auto" ? detectHanDirection(doc, await loadConverter("t2s")) : dir;
      const conv = await loadConverter(d);
      const done = t(d === "s2t" ? "status.toTraditional" : "status.toSimplified");
      if (this.docFormat === "musicxml") {
        this.editScoreDoc((doc) => convertScoreDoc(doc, conv));
        this.setStatus(done);
        return;
      }
      const text = this.getText();
      const res = convertSourceText(text, parse, conv);
      // 乐句重排前的原文（切回原样时用）同样转，解析不出来就留着
      if (this._origLayoutText && this._tryParse(parse, this._origLayoutText)) {
        this._origLayoutText = convertSourceText(this._origLayoutText, parse, conv).text;
      }
      if (res.text !== text) this.setText(res.text);
      this.setStatus(res.missed > 0 ? t("status.hanMissed", { done, n: res.missed }) : done);
    } catch (e) {
      console.error("hanzi conversion failed", e);
      this.setStatus(t("status.hanFailed"));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
  }

  /** 简繁转换用的解析：`.jpwabc` 走 `jpwToScoreDoc`，其余用格式自己的 `toScoreDoc`。 */
  private _hanParser(): ((text: string) => ScoreDoc) | null {
    if (this.docFormat !== "jpwabc") return this.adapter.toScoreDoc ?? null;
    return (text) => {
      const f = JpwFile.fromString(text);
      if (!f) throw new Error("jpwabc 解析失败");
      return jpwToScoreDoc(f);
    };
  }

  private _tryParse(parse: (text: string) => ScoreDoc, text: string): ScoreDoc | null {
    try {
      return parse(text);
    } catch {
      return null;
    }
  }

  /** 注册「展开 / 原样 / 五线谱 / 混排」四档排版模式按钮。
   *
   *  这四档是**两组正交状态的组合**，不是四个独立视图：
   *  前两档走简谱/文本谱排版器（`mode = "jp"`），差别只在版面档（`setProfile`）；
   *  后两档走混排排版器（`mode = "mixed"`），差别只在要不要叠简谱层
   *  （`mixedShowJianpuLayer`——「五线谱」= 关，「混排」= 开）。 */
  setViewModeButtons(switchEl: HTMLElement, btns: ReadonlyMap<ViewMode, HTMLButtonElement>): void {
    this._viewSwitchEl = switchEl;
    this._viewBtns = new Map(btns);
    this._syncViewModeButtons();
  }

  /** 当前处于哪一档。识别模式沿用「简谱那一侧」的档（工具条上它不是独立一档）。 */
  get viewMode(): ViewMode {
    if (this.mode === "mixed") return this.mixedShowJianpuLayer ? "mixed" : "staff";
    return this.layoutMode;
  }

  /** 切档。**唯一入口**：两组状态该怎么配由这里说了算。 */
  async setViewMode(mode: ViewMode): Promise<void> {
    if (mode === "staff" || mode === "mixed") {
      if (!this.mixed._ensureMixedDoc()) return;
      // 先定简谱层再进混排：setStaffJianpuLayer 会作废 painter，进去后只排一遍
      await this.setStaffJianpuLayer(mode === "mixed");
      await this.showStaffPreview();
    } else {
      // 反过来：先换版面档（此时 mode 还是 mixed，reload 直接返回、不白排一遍），再回简谱
      this.setProfile(mode === "expanded");
      await this.showJpPreview();
    }
    this._syncViewModeButtons();
  }

  _setMixedAvailable(available: boolean): void {
    this._mixedAvailable = available;
    this._syncViewModeButtons();
  }

  private _syncViewModeButtons(): void {
    if (this._viewSwitchEl) this._viewSwitchEl.hidden = this._viewBtns.size === 0;
    const active = this.viewMode;
    for (const [mode, btn] of this._viewBtns) {
      const needsXml = mode === "staff" || mode === "mixed";
      // 文本格式由源文派生五线谱，一律可点；`.musicxml` 读不出来才置灰
      btn.disabled = needsXml && this.docFormat === "musicxml" && !this._mixedAvailable;
      const on = mode === active;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
  }

  // ---------------- OmrHost：识别控制器要的那几样能力 ----------------
  /** 识别产物有无变了，重算排版档按钮的显隐。 */
  syncViewModes(): void {
    this._syncViewModeButtons();
  }

  /** 混排排版器（导出 PDF/PNG 要）。没进过混排预览就是 null。
   *  以前导出侧靠 `app["_mixedPainter"]` 索引签名绕过 private——字段一改名，编译期静默
   *  通过、运行期直接 return，「导出 PDF 点了没反应」且无报错。 */
  get mixedPainter(): ScorePainter | null {
    return this.mode === "mixed" && this.painter.renderer === "staff" ? this.painter : null;
  }

  /** 清空谱面区与翻页/选中状态。 */
  clearPages(): void {
    this.scorePane.replaceChildren();
    this.pageEls = [];
  }

  /** 铺页（供识别核对视图复用同一条骨架）。 */
  renderPagesWith(
    count: number,
    svgOf: (i: number) => SVGSVGElement,
    opts: Parameters<App["_renderPagesWith"]>[2] = {},
  ): void {
    this._renderPagesWith(count, svgOf, opts);
  }

  /** 进入/退出识别模式：改 mode，并在进入时先退掉混排布局。 */
  setRecognizeMode(on: boolean): void {
    // 五线谱识别的结果（`.musicxml`）退出对照回混排档，简谱识别的回简谱档
    this._setMode(on ? "recognize" : this.docFormat === "musicxml" ? "mixed" : "jp");
    this.playback.refreshSpeedUi(); // 进度条总长跟着能否试听走
  }

  /** OmrHost：点中识别框 → 起播点 / 播放中跳过去。 */
  seekPlayback(point: PlayPoint): void {
    this.playback.seekTo(point);
  }

  /**
   * 换成某种源格式的文本（`OmrHost` / `FileSwitchHost`）：识别产物落地、代码区格式下拉切格式都走这里。
   * 丢掉混排底本、切 docFormat、设文件路径，再设文本（在五线谱/混排档就留在那档）。
   * 切回 `.musicxml` 原文时照打开 `.musicxml` 那样落地（无代码区）；从 `.musicxml` 转出来的回简谱档看代码区对应的谱面。
   */
  adoptText(format: DocFormatId, text: string, filePath: string | null): void {
    // 五线谱识别会话：识别 id 从换之前那份按拍点、音高带过去（原图对照在任何格式下都认得框，`omrlinks.ts`）
    const carry = this.omr.beforeAdoptText();
    this._adoptText(format, format === "musicxml" ? this.omr.stampStaffXml(text, carry, (x) => musicXmlFormat.toScoreDoc(x)) : text, filePath);
    this.omr.afterAdoptText(carry);
  }

  private _adoptText(format: DocFormatId, text: string, filePath: string | null): void {
    this._documentLoaded();
    if (format === "musicxml") {
      this._setDocFormat("musicxml");
      this.filePath = filePath;
      if (!this.mixed._setMixedXml(text)) return;
      this._setMixedAvailable(true);
      this.setText(text);
      if (this.mode === "mixed") void this._renderMixedPages();
      return;
    }
    this.mixed._dropMixedDoc();
    // 五线谱/混排档、原图对照里换成文本格式就留在那档（钢琴谱、合唱谱转到简谱档没法看）
    if (format === "jpwabc") this._disablePhrase();
    this._setDocFormat(format);
    this.filePath = filePath;
    this.setText(text);
  }

  /** 预览模式切换的**唯一**入口：退出当前模式的副作用 + 进入新模式的副作用。
   *
   *  以前这三连（`mode = …` / `_setMixedLayout` / 按钮同步）在五处各写一遍，
   *  漏一处就出「按钮亮着但布局是另一个模式」。识别模式的那套布局由 OmrController 自己接管
   *  （omrctl.ts::setLayout），这里只管 mode 与混排布局。 */
  private _setMode(next: "jp" | "mixed" | "recognize"): void {
    if (this.mode === next) return;
    if (this.mode === "recognize") this.omr.leaveLayout();
    if (this.mode === "mixed") this._setMixedLayout(false);
    // 两边的元素 id 各编各的（五线谱那份是读回来的 `mixedDoc`），选中的音不能带过去当起播点
    this.deselectStaff();
    this.deselect();
    this.mode = next;
    if (next === "mixed") this._setMixedLayout(true);
    // 识别模式沿用「简谱」这个预览档（工具条上它不是独立一档）。
    this._syncViewModeButtons();
  }

  async showJpPreview(): Promise<void> {
    if (this.mode === "jp") return;
    this.stopPlayback();
    this._setMode("jp");
    this.reload(this.getText());
  }

  async showStaffPreview(): Promise<void> {
    if (!this.mixed._ensureMixedDoc()) return;
    if (this.mode === "mixed") return;
    this.stopPlayback();
    this._setMode("mixed");
    await this._renderMixedPages();
  }

  /** 设置混排是否隐藏小节号，持久化；当前处于混排模式时立即重排。 */
  async setMixedHideBarNumber(on: boolean): Promise<void> {
    if (this.mixedHideBarNumber === on) return;
    this.mixedHideBarNumber = on;
    this.saveSettings();
    if (this.mode === "mixed") await this._renderMixedPages();
  }

  async setStaffJianpuLayer(on: boolean): Promise<void> {
    if (this.mixedShowJianpuLayer === on) return;
    this.mixedShowJianpuLayer = on;
    this.saveSettings();
    if (this.mode === "mixed") await this._renderMixedPages();
  }

  /** 进出五线谱/混排的布局。文本格式在这两档仍可编辑源文（`reload` 会重新派生五线谱）；
   *  只读只对没有代码区的格式（`.musicxml`）成立。 */
  private _setMixedLayout(on: boolean): void {
    document.getElementById("body")?.classList.toggle("mixed", on);
    this._syncMixedReadOnly(on);
  }

  private _syncMixedReadOnly(mixed = this.mode === "mixed"): void {
    // `.musicxml` 的代码区本来就收起（`no-code`），不设只读：模型那一路的撤销重做要经它的 history（只读时 `undo` 直接拒绝）
    const ro = mixed && !this.adapter.caps.textEditor && this.docFormat !== "musicxml";
    this.view.dispatch({
      effects: this._readOnlyCompartment.reconfigure(EditorState.readOnly.of(ro)),
    });
    const meta = document.getElementById("code-pane-meta");
    if (meta) {
      meta.textContent = ro ? t("pane.readOnly") : this._formatLabel();
      meta.dataset.readOnly = ro ? "1" : "";
    }
  }

  /** 界面语言变了：各控件里由代码写的文字重出（静态 DOM 由 `applyI18n` 刷）。 */
  relabel(): void {
    this.formats.relabel();
    this.playback.relabel();
    this.visual.relabel();
    this.omr.relabel();
    this._syncMixedReadOnly();
    this._syncFormatLabel();
    this.setStatus("");
  }

  /** 代码区右上角的格式标签。 */
  private _formatLabel(): string {
    return this.adapter.label(this);
  }

  /** `FormatSwitchHost`：格式下拉显隐变了，格式标签跟着让位。 */
  syncFormatLabel(): void {
    this._syncFormatLabel();
  }

  /** 同步代码区右上角：有可切的格式时那儿是格式下拉（`#doc-format-field`），标签让位。 */
  private _syncFormatLabel(): void {
    const meta = document.getElementById("code-pane-meta");
    if (!meta) return;
    if (!meta.dataset.readOnly) meta.textContent = this._formatLabel();
    const field = document.getElementById("doc-format-field");
    meta.hidden = !!field && !field.hidden;
  }

  private _renderMixedPages(): Promise<void> {
    const job = this._layoutStaff();
    this._pendingStaff = job;
    void job.finally(() => {
      if (this._pendingStaff === job) this._pendingStaff = null;
    });
    return job;
  }

  /** 五线谱/混排档的排版请求（屏幕铺页与识别模式下导出 PNG/PDF 共用）。不给 `doc` 就取混排底本、剔掉藏起来的声部；没有底本返回 null。 */
  staffRequest(doc = this.mixedDoc && withVisibleParts(this.mixedDoc, this.hiddenParts)): StaffPaintRequest | null {
    if (!doc) return null;
    return {
      view: this.mixedShowJianpuLayer ? "mixed" : "staff",
      doc,
      style: this.style.staffStyle(),
      page: this.staffPage,
      hideBarNumber: this.mixedHideBarNumber,
      // 声部面板里藏起来的声部不排（会话内）；简谱层取的声部下标跟着往前挪
      jianpuPart: this.hiddenParts.has(this.melodyPart) ? 0 : this.melodyPart - [...this.hiddenParts].filter((i) => i < this.melodyPart).length,
      // ABC 的代码换行与 `%%newpage` 就是谱面换行换页（§6.1）：五线谱照它分，不另按宽度重排（issue 24）
      sourceBreaks: this.docFormat === "abc" && !this.phraseOn,
    };
  }

  private async _layoutStaff(): Promise<void> {
    const req = this.staffRequest();
    if (!req) {
      this._renderPagesWith(0, () => { throw new Error("没有五线谱页"); }, { resetPageIndex: true });
      return;
    }
    const outcome = await this.painter.load(req);
    // 排的时候又来了新请求（快速切档、改设置）：这份作废，由新的那份铺页
    if (outcome === "superseded" || this.mode !== "mixed") return;
    const painter = this.painter;
    this.playback.stop(); // 重排作废了和弦组与播放线；进度条总长跟着新谱
    this._renderPagesWith(painter.pageCount, (i) => painter.renderPage(i), {
      // Portrait paper sized from the MusicXML page dimensions.
      // **纸宽不在这里给**：简谱/五线谱/混排共用 `--score-page-max`（styles.css）。
      // 这里原先单独写 620px，切到混排纸就窄了三分之一。
      aspectRatio: (i) => {
        const { w, h } = painter.pageSize(i);
        return `${w} / ${h}`;
      },
      onPage: (svg) => {
        svg.style.width = "100%";
        svg.style.display = "block";
        svg.addEventListener("click", (ev) => this._onStaffClick(ev));
        svg.addEventListener("dblclick", (ev) => this._onSyncDblClick(ev));
      },
      resetPageIndex: true,
    });
    // 代码区光标所在的音在新画的五线谱上描出来；可视化编辑的叠加层跟着重画
    if (this.visualSource() && this.syncView.doc) this.syncView.bindEls();
    else this.syncView.cursorToScore();
  }

  /** 等在途的异步排版（五线谱 / 混排）落定。简谱这一路是同步的，调用返回时已铺好。无头校验脚本用。 */
  async whenIdle(): Promise<void> {
    while (this._pendingStaff) await this._pendingStaff.catch(() => undefined);
  }

  // ---------------- 文件会话（`filesession.ts`）：打开 / 保存 / 草稿 / 未保存保护，这里只留转发 ----------------
  readonly files: FileSession = new FileSession(this);
  rememberLastFile(path: string): void { this.files.rememberLastFile(path); }
  tryRestoreLastFile(): Promise<boolean> { return this.files.tryRestoreLastFile(); }
  openFile(): Promise<boolean> { return this.files.openFile(); }
  saveFile(): Promise<void> { return this.files.saveFile(); }
  saveFileAs(): Promise<void> { return this.files.saveFileAs(); }
  saveAsFormat(target: ConvertTarget): Promise<void> { return this.files.saveAsFormat(target); }
  isDirty(): boolean { return this.files.isDirty(); }
  confirmReplace(closing = false): Promise<boolean> { return this.files.confirmReplace(closing); }
  markClean(): void { this.files.markClean(); }
  takeDraft(): Promise<Draft | null> { return this.files.takeDraft(); }
  offerDraftRestore(d: Draft | null): Promise<boolean> { return this.files.offerDraftRestore(d); }
  saveProject(asNew: boolean): Promise<boolean> { return this.files.saveProject(asNew); }
  /** FileHost：存到 XML 路径上时写的那份 MusicXML。 */
  musicXmlForSave(): Promise<string> { return buildMusicXml(this); }

  /** 当前文档的 `ScoreDoc`（能力表与丢失清单要用）。拿不到就返回 null。 */
  scoreDoc(): ScoreDoc | null {
    const text = this.getText();
    try {
      if (this.adapter.caps.layout === "scoredoc") return this.currentScoreDoc();
      const f = JpwFile.fromString(text);
      return f ? jpwToScoreDoc(f) : null;
    } catch {
      return null;
    }
  }

  /** 当前文档 → 目标格式的文本（转换目标表 `convert/targets.ts`）。同格式原文照给；转不了返回 null。
   *  换行照简谱视图实际排出的行（`jianpuLineStarts`，与导出 MusicXML 同一口径：小节中间的只留源文写明的），
   *  写在一份克隆上（`breaks.ts::applyBreaks`）；走原样文档布局、量不出来的照源文的行。 */
  convertTo(target: ConvertTarget): string | null {
    const spec = targetSpec(target);
    if (spec.docFormat === this.docFormat && (spec.docFormat !== "fanqie" || this.fanqieDialect === target)) return this.getText();
    // `.jpwabc` 用排版器那份模型，行首音的 id 才对得上（同 `export.ts::sourceMusicXmlBare`）
    let doc = (this.docFormat === "jpwabc" ? this.jpwDoc : null) ?? this.scoreDoc();
    if (!doc) return null;
    const starts = this.jianpuLineStarts();
    if (starts?.size) {
      doc = structuredClone(doc);
      const ls = [...starts].map((id) => ({ id }));
      for (const song of doc.songs) applyBreaks(song, ls, { mid: "source", pages: "keep" });
    }
    try {
      return spec.emit(doc);
    } catch (e) {
      console.error("转换失败", e);
      return null;
    }
  }

  // ---------------- 识别项目 `.dolce`（`omrproject.ts`；存在 `filesession.ts`） ----------------
  /** 打开识别项目：还原识别会话（不重跑识别）。 */
  async openProject(bytes: Uint8Array, name: string, opts: { draft?: boolean } = {}): Promise<boolean> {
    let snap;
    try {
      snap = unpackProject(bytes);
    } catch (e) {
      this.setStatus(t("proj.openFailed", { error: e instanceof Error ? e.message : String(e) }));
      return false;
    }
    this.formats.use(null);
    this._documentLoaded();
    await this.omr.restore(snap);
    this.filePath = isTauriRuntime() && isProjectFile(name) ? name : null;
    if (opts.draft) return true;
    this.markClean();
    this.setStatus(t("proj.opened", { kind: t(snap.kind === "jianpu" ? "recogKind.jianpu" : "recogKind.staff"), n: snap.sources.length }));
    return true;
  }

  /** 当前文档的标题（取法因格式而异，见适配器的 `title`）。 */
  documentTitle(): string {
    return this.adapter.title(this);
  }

  /** Load dropped file content (already decoded). */
  loadText(text: string, path: string | null): void {
    this._documentLoaded();
    this.formats.use(null);
    this.filePath = path;
    this.setText(text);
  }

  /** Set LinesPerPage in the document's .Layout section (empty string clears it). */
  setLinesPerPage(value: string): void {
    this.setText(upsertLayoutLines(this.getText(), value));
  }

  /** Current LinesPerPage value from the document, if any. */
  getLinesPerPage(): string {
    const f = JpwFile.fromString(this.getText());
    return f?.getSection(LayoutSection)?.linesPerPage?.trim() ?? "";
  }
}

/** Insert/update/remove `LinesPerPage = N` within a `.Layout` section. */
function upsertLayoutLines(doc: string, value: string): string {
  const lines = doc.split("\n");
  const isSection = (l: string) => l.startsWith(".");
  let layoutAt = lines.findIndex((l) => l.trim().toLowerCase() === ".layout");

  if (layoutAt < 0) {
    if (!value) return doc;
    const block = lines[lines.length - 1] === "" ? "" : "\n";
    return doc + `${block}.Layout\nLinesPerPage = ${value}\n`;
  }
  // find section body bounds
  let end = layoutAt + 1;
  while (end < lines.length && !isSection(lines[end])) end++;
  let lpIdx = -1;
  for (let i = layoutAt + 1; i < end; i++) {
    if (lines[i].toLowerCase().includes("linesperpage")) lpIdx = i;
  }
  if (!value) {
    if (lpIdx >= 0) lines.splice(lpIdx, 1);
    return lines.join("\n");
  }
  if (lpIdx >= 0) lines[lpIdx] = `LinesPerPage = ${value}`;
  else lines.splice(layoutAt + 1, 0, `LinesPerPage = ${value}`);
  return lines.join("\n");
}

/** 判断 MusicXML 是否多声部（≥2 part、单 part 多谱表、或 ≥2 voice）→ 默认混排。 */
function isMultiPartXml(xml: string): boolean {
  try {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return false;
    if (doc.getElementsByTagName("score-part").length >= 2) return true;
    for (const s of Array.from(doc.getElementsByTagName("staves"))) {
      if (parseInt(s.textContent ?? "1", 10) >= 2) return true;
    }
    const voices = new Set<string>();
    for (const v of Array.from(doc.getElementsByTagName("voice"))) {
      const t = v.textContent?.trim();
      if (t) voices.add(t);
    }
    return voices.size >= 2;
  } catch {
    return false;
  }
}

/** 把识别映射的所有代码区间经 CodeMirror 变更集迁移到新文档位置（保持编辑后点选仍准）。 */
function mapMeta(meta: JpwMeta, ch: { mapPos(pos: number, assoc?: number): number }): JpwMeta {
  const mr = (r: JpwRange): JpwRange => ({ from: ch.mapPos(r.from, 1), to: ch.mapPos(r.to, -1) });
  return {
    noteRanges: meta.noteRanges.map(mr),
    lyricRanges: meta.lyricRanges.map((m) => {
      const nm = new Map<number, JpwRange>();
      for (const [k, v] of m) nm.set(k, mr(v));
      return nm;
    }),
    titleRange: meta.titleRange ? mr(meta.titleRange) : undefined,
    authorRanges: meta.authorRanges.map((a) => ({ text: a.text, range: mr(a.range) })),
  };
}

/** 这份文档有没有可排的曲行（首曲至少一行）。 */
function hasLines(doc: ScoreDoc): boolean {
  return docView(doc).songs[0]?.pages.some((p) => p.groups.length > 0) ?? false;
}

/** 首曲只有一条旋律（单声部）。 */
function singleVoice(doc: ScoreDoc): boolean {
  const song = docView(doc).songs[0];
  return song !== undefined && voiceNumbers(song).length === 1;
}
