// 简谱 OMR 的编辑器侧控制器：识别 → 出文本 → 叠加核对视图 → 点选定位。
//
// 从 App 里整体切出来的一块。它自己拿着识别产物（二值图 / RecognizedScore / 代码区间映射 /
// 输出格式）与那几个工具条控件，只通过下面的 OmrHost 向 App 要能力——**故意把这个接口
// 列全**：它就是「识别这摊事到底依赖编辑器多少东西」的清单，越短越好，加东西前先想想。
//
// 识别产物的关键性质：`RecognizedScore` 与输出格式无关，留在内存里；换格式只重走
// omr/emit.ts 的 emitter，绝不重跑识别。输出格式的下拉与打开文件后切格式是同一个
// （`formatswitch.ts`），这里作为它的一种来源（`FormatSource`）。
import { recognizedBeatIssues, type RecognizedBeatIssue } from "../omr/beats";
import { beatTag } from "../model/beatcheck";
import { deleteChords, locate, measureCtx, respellMeasure } from "../model/edit";
import type { SystemOp } from "../staffomr/score";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  recognizeMusicppDetailed, renderRecognitionSvg, renderRowPopup, renderHeaderPopup, renderRowSource,
  OMR_EMITTERS, DEFAULT_OMR_FORMAT, isOmrFormat, omrEmitter,
  type OmrFormat, type RecogView,
} from "../omr";
import type { Binary, JpwMeta, RecognizedScore } from "../omr";
import type { Chord, ElementId, ScoreDoc } from "../model/doc";
import type { StaffBarMark, StaffMark, StaffSourceMark } from "../rasteromr/overlay";
import type { PlayPoint } from "./player";
import type { SyncEntry } from "./sync";
import type { DocFormatId } from "./formats";
import { confirmDiscardEdits, type FormatOption, type FormatSource, type FormatSwitch } from "./formatswitch";
import { harmonyPlacesOf, reprojectRecognized, type Reprojected } from "../omr/reproject";
import { doubtItems } from "../omr/overlay";
import { baseImage } from "../omrkit/svgkit";
import type { ProjectKind, ProjectSnapshot } from "./omrproject";
import { t } from "../i18n";
import { COMPARE_VALUES, type CompareValue } from "./comparemode";
import { isPdf } from "../omrkit/pdf";
import type { StaffReviewResult } from "../staffomr/review";
import { carryIds, COVERED, markEntryKey, pitchAt, stampXmlIds, StaffLinks, staffMarksOf, surfaceIds, textView, xmlShape, type StaffView } from "./omrlinks";
import type { PendingPage } from "../rasteromr/browser";
import { attachPinchZoom } from "./pinchzoom";

/** 一份识别输入（拖进来、选进来的图片或 PDF）。 */
/** 并排原图一页的整页底图：图的地址与它在识别位图坐标里的位置（见 `placePageView`） */
type PageView = { url: string; x: number; y: number; w: number; h: number } | null;

export interface RecogInput {
  bytes: Uint8Array;
  mime?: string;
  name?: string;
}

/** 文件名 → 曲名（去掉目录与扩展名）。 */
function baseTitle(name: string): string {
  return name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
}

/** OmrController 向编辑器要的全部能力。 */
export interface OmrHost {
  /** 当前预览模式。识别模式期间为 "recognize"。 */
  readonly mode: "jp" | "mixed" | "recognize";
  /** 编辑器里的 CodeMirror 视图（点选定位要用）。 */
  readonly view: EditorView;

  getText(): string;
  setText(text: string): void;
  setStatus(text: string): void;
  /** 当前状态栏文本 */
  readonly status: string;
  /** 当前文档的源格式（识别项目存它） */
  readonly docFormat: DocFormatId;
  saveSettings(): void;
  stopPlayback(): void;
  /** 点中识别框：停止中记为起播点，播放中跳过去。 */
  seekPlayback(point: PlayPoint): void;
  /** 正在试听（播放或暂停中）：点音符让给跳播 */
  playbackActive(): boolean;
  /** 当前文本解析出的模型（试听播的就是它；播放高亮按它的元素 id 找识别框）。 */
  currentScoreDoc(): ScoreDoc | null;
  /** 重新解析并排版（退出识别模式时回到排版稿）。 */
  reload(text: string): void;
  /**
   * 五线谱识别产物落地：与打开 `.musicxml` 同一个模式（无代码区），默认进**混排视图**。
   * 不走 `importOmrDoc`：五线谱的和弦、多声部、slur 在 `.jpwabc` 与旧简谱引擎里装不下。
   * 返回 false 表示简谱那一侧转不出来（不影响混排预览）。
   */
  adoptStaffXml(xml: string, rebuild?: boolean): boolean;
  /** 把一份模型过一遍当前源格式（写出再读回）：五线谱对照在文本格式下按同一口径比「改过」。读不出返回 null */
  viaCurrentFormat(doc: ScoreDoc): ScoreDoc | null;
  /** 现在有没有代码区（`.musicxml` 没有）：「源码」复选框按它显示勾没勾。 */
  hasCodePane(): boolean;
  /** 没有代码区时勾「源码」：转成默认编辑格式（`App.openSourceView`）。 */
  openSourceView(): Promise<void>;
  /** MusicXML 落地后转成设置里的默认编辑格式（缺省 ABC，装不下改用建议的；`App.openInEditFormat`）。返回状态栏的说明 */
  openInEditFormat(): string;
  /** 简谱识别产物落地：识别直出的模型与它写成的 123 核对文本。 */
  importOmrDoc(doc: ScoreDoc, text: string): void;
  /** 识别产物有无变了：同步排版档按钮（简谱识别期间不露「五线谱」「混排」两档）。 */
  syncViewModes(): void;
  /** 切排版档（展开 / 原样 / 五线谱 / 混排），`App.setViewMode` */
  setViewMode(mode: "expanded" | "original" | "staff" | "mixed"): Promise<void>;

  /** 清空 #score-pane 与翻页状态（各预览铺页前都要做）。 */
  clearPages(): void;
  /** 铺页（见 App._renderPagesWith）。 */
  renderPagesWith(
    count: number,
    svgOf: (i: number) => SVGSVGElement,
    opts?: {
      aspectRatio?: (i: number) => string;
      position?: string;
      onPage?: (svg: SVGSVGElement, wrap: HTMLDivElement, i: number) => void;
      resetPageIndex?: boolean;
    },
  ): void;

  /** 进入/退出识别模式（改 mode、退混排布局、停播放）。 */
  setRecognizeMode(on: boolean): void;
  /** 123 以外的产物落地：丢掉混排底本、切 docFormat、设文件路径，再设文本。 */
  adoptText(format: DocFormatId, text: string, filePath: string | null): void;
  /** 代码区标题栏的格式下拉（识别结果是它的一种来源） */
  readonly formats: FormatSwitch;
  /** 上下文相关控件的显隐（工具条）。 */
  setContextControl(el: Element | null, on: boolean): void;
  syncContextGroup(el: Element | null | undefined): void;
  /** 核对视图里能不能可视化编辑（有代码区、有点选映射）。能就把点击交给它 */
  visualEnabled(): boolean;
  /** 核对视图上的单击 / 双击交给可视化编辑（选中、落光标、改字） */
  visualClick(ev: MouseEvent): void;
  visualDblClick(ev: MouseEvent): void;
  /** 核对视图重画完了：App 按新的命中框重绑索引条目、重画光标 */
  recognizeRendered(): void;
  /** 排版稿里选中这个音（并排原图上点了它） */
  selectNote(id: ElementId): void;
}

export class OmrController implements FormatSource {
  /** 识别模式：二值图 + 带源图坐标的识别结果，供叠加核对。 */
  private bin: Binary | null = null;
  private score: RecognizedScore | null = null;
  private btnEl: HTMLButtonElement | null = null;
  /** 叠加视图样式（原位叠加 / 附近浮窗 / 仅原图）。 */
  view: RecogView = "floating";
  private viewSelectEl: HTMLSelectElement | null = null;
  private popupEl: HTMLDivElement | null = null;
  /** 「音符/歌词/标题/著作者 → 编辑器代码区间」映射，点选定位用。 */
  private meta: JpwMeta | null = null;
  /** 识别结果的输出格式。产物本身与格式无关，切换只是重出文本，不重跑识别。 */
  format: OmrFormat = DEFAULT_OMR_FORMAT;
  /** 上次由识别产出的文本；与当前文本不同即说明用户手改过。 */
  private emitted: string | null = null;
  /** 小节时值自检报出的小节（识别完算一次，核对视图标红） */
  private beatMarks: RecognizedBeatIssue[] = [];
  /** 元素 id ↔ 识别框序（按 doc 与 meta 身份缓存，见 idMapOf）。 */
  private idMap: { doc: ScoreDoc; meta: JpwMeta; toI: Map<ElementId, number>; toId: ElementId[] } | null = null;
  /** 试听的竖直播放线（`rect.omr-playhead`，见 highlightPlaying）。 */
  private playingEl: SVGRectElement | null = null;
  /** 最近一次画的重投影（核对时改过的值，见 `omr/reproject.ts`）；浮窗用同一份 */
  private shown: Reprojected | null = null;
  /** 第几次重画（浮窗按它判断要不要重建） */
  private renderSeq = 0;

  constructor(private host: OmrHost) {}

  /** 是否有可核对的识别产物。 */
  get hasResult(): boolean {
    return (this.score !== null && this.bin !== null) || this.staffResult !== null;
  }

  // ---------------- 持久化 ----------------
  loadSettings(s: { omrFormat?: unknown; recogView?: unknown; omrFollow?: unknown; omrKind?: unknown; omrSide?: unknown; omrAdjust?: unknown; sideHideCode?: unknown; omrCompare?: unknown }): void {
    if (isOmrFormat(s.omrFormat)) this.format = s.omrFormat;
    if ((COMPARE_VALUES as readonly unknown[]).includes(s.omrCompare)) this.compare = s.omrCompare as CompareValue;
    if (typeof s.omrFollow === "boolean") this.follow = s.omrFollow;
    if (typeof s.omrSide === "boolean") this.side = s.omrSide;
    if (typeof s.sideHideCode === "boolean") this.hideCode = s.sideHideCode;
    this.applyCodePane();
    if (typeof s.omrAdjust === "boolean") this.adjustFirst = s.omrAdjust;
    if (s.omrKind === "auto" || s.omrKind === "jianpu" || s.omrKind === "staff") this.kind = s.omrKind;
    this.syncFollowBtn();
    this.syncKindSelects();
  }

  // ---------------- 识别类型（分流） ----------------
  /** 识别为：自动判断（按有没有五线谱表，`rasteromr/detect.ts`）/ 简谱 / 五线谱。持久化 */
  kind: "auto" | "jianpu" | "staff" = "auto";
  private kindSelects: HTMLSelectElement[] = [];
  /** 上一次识别的输入（改判时拿它重识别，不必再选一次文件） */
  private lastInputs: RecogInput[] = [];
  /** 正在识别（Esc 取消只在这期间有效） */
  private busy = false;
  private cancelRequested = false;
  /**
   * 识别代号：每开始一次识别、每次 `clear()`（打开了别的文档）加一。识别 await 回来代号变了就是过时的——
   * 不落地、不报状态（晚完成的旧识别不能盖掉用户新打开的文档，两次识别只留后一次）。
   */
  private gen = 0;
  /** 五线谱项目重开后补对照数据那一趟（连点两下只跑一遍） */
  private ensuring: Promise<boolean> | null = null;
  /** 补对照数据失败过：并排原图不再自己重试（点「原图对照」仍会再试） */
  private staffLoadFailed = false;

  /** 起始页与工具条各有一个「识别为」下拉，两个同步。工具条那个改了就用上次的图重新识别。 */
  setKindSelects(start: HTMLSelectElement | null, toolbar: HTMLSelectElement | null): void {
    for (const sel of [start, toolbar]) {
      if (!sel) continue;
      this.kindSelects.push(sel);
      sel.addEventListener("change", () => {
        this.kind = sel.value as typeof this.kind;
        this.host.saveSettings();
        this.syncKindSelects();
        if (sel === toolbar && this.lastInputs.length) void this.rerecognize();
      });
    }
    this.syncKindSelects();
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && this.busy) this.cancelRequested = true;
    });
  }

  private syncKindSelects(): void {
    for (const sel of this.kindSelects) sel.value = this.kind;
  }

  /** 用上次的输入按新的识别类型重识别（手改过先问）。 */
  private async rerecognize(): Promise<void> {
    if (this.editedSinceRecognition() && !(await confirmDiscardEdits())) return;
    await this.recognizeFiles(this.lastInputs);
  }

  /** 识别完之后谱面上改过没有（简谱、五线谱两路各记各的「刚识别出来」那份）。 */
  private editedSinceRecognition(): boolean {
    const t = this.host.getText();
    // 五线谱：只是换了格式看（没改过）不算
    return (this.emitted !== null && t !== this.emitted) || (this.staffEmitted !== null && t !== this.staffEmitted && !this.host.formats.source?.pristineOf?.(this.staffEmitted));
  }

  // ---------------- 原图页面板（`omrpages.ts`） ----------------
  private pagesBtn: HTMLButtonElement | null = null;

  setPagesBtn(btn: HTMLButtonElement): void {
    this.pagesBtn = btn;
    btn.addEventListener("click", () => void this.showPages());
  }

  /** 有原图就给「原图页」（识别失败了也给：横着拍的图要先转过来再识别）；有位图结果才给「并排原图」 */
  private syncPagesBtn(): void {
    this.host.setContextControl(this.pagesBtn, this.lastInputs.length > 0);
    this.host.setContextControl(this.sideBtn, this.sessionKind !== null);
    this.syncSide(null);
  }

  /** 这次识别有没有原图（识别失败也算：起始页据此给「调整原图后重试」）。 */
  get hasInputs(): boolean {
    return this.lastInputs.length > 0;
  }

  /** 识别前先调整原图（起始页的选项，持久化） */
  adjustFirst = false;

  /** 新拿到的原图：勾了「识别前先调整原图」就先弹原图页面板，取消返回 null（不识别）；没勾原样返回。 */
  async prepareInputs(files: RecogInput[]): Promise<RecogInput[] | null> {
    if (!this.adjustFirst) return files;
    const { adjustBeforeRecognize } = await import("./omrpages");
    return adjustBeforeRecognize(files);
  }

  /** 打开原图页面板；按新列表重识别后回调 `after(成功没有)`。 */
  async showPages(after?: (ok: boolean) => void): Promise<void> {
    const { showPagesDialog } = await import("./omrpages");
    showPagesDialog(this.lastInputs, (files) => void this.rerunWith(files).then((ok) => after?.(ok)));
  }

  /** 按改过的原图列表重识别（手改过先问）。 */
  async rerunWith(files: RecogInput[]): Promise<boolean> {
    if (this.editedSinceRecognition() && !(await confirmDiscardEdits())) return false;
    const ok = await this.recognizeFiles(files);
    this.syncPagesBtn();
    return ok;
  }

  private progress(text: string): void {
    this.host.setStatus(text);
    const el = document.getElementById("recognition-progress-detail");
    if (el) el.textContent = text;
  }

  /**
   * 识别一份或几份输入（拖进来、选进来的图片 / PDF；几份时按文件名排好、合成一首）。分流：
   * 文字层完整的五线谱 PDF → 矢量路；有五线谱表的位图（`kind` 为自动时按 `detect.ts` 判）→ 位图五线谱路；其余 → 简谱路。
   * 简谱一次识别一张（几张时只认第一张，状态栏说明）。
   */
  async recognizeFiles(files: readonly RecogInput[]): Promise<boolean> {
    const g = ++this.gen;
    const prev = this.lastInputs;
    const ok = await this.recognizeFilesInner(files, g);
    if (!ok && g === this.gen) this.endPending(false);
    // 改过原图列表重识别没成：谱面还是上一次的结果，原图列表也退回去（存项目、重开补对照要的是那一份）。
    // 没有会话（起始页第一次识别失败）就留着新的，好给「调整原图后重试」
    if (!ok && g === this.gen && this.sessionKind !== null) this.lastInputs = prev;
    if (g === this.gen || ok) this.syncPagesBtn();
    return ok;
  }

  private async recognizeFilesInner(files: readonly RecogInput[], g: number): Promise<boolean> {
    if (!files.length) return false;
    this.lastInputs = [...files];
    void this.showPending(files, g); // 判路之前就清掉旧图、铺原图与占位（判路要栅格化第一页，得等一会）
    const first = files[0]!;
    // 文字层完整的五线谱 PDF（矢量）先试：只要不是指定按简谱识别
    if (files.length === 1 && this.kind !== "jianpu" && isPdf(first.bytes, first.mime) && (await this.tryStaffPdf(first.bytes, performance.now(), g))) return true;
    if (g !== this.gen) return false;
    if (this.kind !== "jianpu") {
      const t0 = performance.now();
      try {
        const rb = await import("../rasteromr/browser");
        const pdfs: Uint8Array[] = [];
        for (const f of files) pdfs.push(await rb.asRasterPdf(f.bytes, f.mime));
        // 判路时栅格化过的页交给识别，不再取一遍
        const probe = this.kind === "staff" ? null : await rb.probeRasterStaff(pdfs[0]!);
        if (g !== this.gen) return false;
        if (!probe || probe.isStaff) return await this.recognizeRasterStaff(pdfs, files, t0, g, probe?.pages);
      } catch (e) {
        if (g !== this.gen) return false;
        if (this.kind === "staff") {
          console.error("位图五线谱识别失败", e);
          this.host.setStatus(t("omr.staffFailed", { error: e instanceof Error ? e.message : String(e) }));
          return false;
        }
        console.warn("五线谱判定失败，按简谱识别", e);
      }
    }
    const ok = await this.recognizeJianpu({ bytes: first.bytes, mime: first.mime }, g);
    if (ok && files.length > 1) this.host.setStatus(this.host.status + t("omr.firstOnly", { n: files.length }));
    return ok;
  }

  /** 位图五线谱：在线 OCR 跑整曲识别，产物是 MusicXML，落地同打开 `.musicxml`（无代码区、谱面上改模型）。 */
  private async recognizeRasterStaff(pdfs: Uint8Array[], files: readonly RecogInput[], t0: number, g: number, firstPages?: Map<number, import("../rasteromr/rasterpage").RasterPage | null>): Promise<boolean> {
    const rb = await import("../rasteromr/browser");
    this.busy = true;
    this.cancelRequested = false;
    this.progress(t("omr.staffRunning"));
    this.prerenderOriginals(files); // 并排原图的原样底图不等识别，现在就画起来
    void this.showPending(files, g);
    let res;
    try {
      res = await rb.recognizeRasterPdfs(pdfs, {
        title: files.length === 1 && files[0]!.name ? baseTitle(files[0]!.name) : undefined,
        onPage: (done, total) => {
          if (g !== this.gen) return;
          this.progress(t("omr.staffProgress", { done, total }) + t("omr.escCancel"));
          this.markPendingDone(done);
        },
        // 过时的（又开始了一次识别、打开了别的文档）自己停下
        cancelled: () => g !== this.gen || this.cancelRequested,
        firstPages,
      });
    } catch (e) {
      if (g === this.gen) {
        this.endPending(false);
        this.host.setStatus(this.cancelRequested ? t("omr.cancelled") : t("omr.staffFailed", { error: e instanceof Error ? e.message : String(e) }));
      }
      return false;
    } finally {
      if (g === this.gen) this.busy = false;
    }
    if (g !== this.gen) return false;
    if (!res.xml) {
      this.endPending(false);
      this.host.setStatus(t("omr.noStaffFound"));
      return false;
    }
    this.endPending(true);
    this.clear();
    this.lastInputs = [...files];
    this.staffResult = res;
    this.sessionKind = "staff";
    this.host.adoptStaffXml(res.xml);
    this.staffEmitted = this.host.getText();
    // 用默认编辑格式（ABC）看源码；MusicXML 原文留在格式下拉里（识别 id 按拍点、音高带过去）
    const formatNote = this.host.openInEditFormat();
    this.host.setContextControl(this.kindField(), true);
    // 位图路有页面位图与音符坐标：「原图对照」可用（矢量 PDF 那一路没有位图，不给）
    if (this.btnEl) this.btnEl.textContent = t("omr.compare");
    this.host.setContextControl(this.btnEl, true);
    // 谱表正上方认出了简谱行（简线混排谱，`rasteromr/jianpuband.ts`）进混排档，否则五线谱档
    await this.enterAfterRecognize(res.pages.some((p) => p.result.jianpuStrips.length > 0) ? "mixed" : "staff");
    const s = res.stats;
    this.host.setStatus(
      t("omr.staffDone", { sec: ((performance.now() - t0) / 1000).toFixed(1), pages: s.pages, parts: s.parts ?? 1, notes: s.notes }) +
        (s.bars ? t("omr.fullBars", { pct: Math.round((s.full / s.bars) * 100) }) : "") + t("omr.editOnScore") + (formatNote ? `　${formatNote}` : ""),
    );
    return true;
  }

  /** 这次识别走的哪条路（识别项目按它存与还原）；没有识别会话为 null */
  sessionKind: ProjectKind | null = null;

  /** 识别会话的快照（存 `.dolce` 与自动保存用）；没有会话为 null。 */
  snapshot(): ProjectSnapshot | null {
    if (!this.sessionKind || !this.lastInputs.length) return null;
    const docFormat = this.host.docFormat;
    const base: ProjectSnapshot = {
      kind: this.sessionKind, docFormat, text: this.host.getText(),
      emitted: this.sessionKind === "jianpu" ? this.emitted : this.staffEmitted,
      omrFormat: this.format, recogKind: this.kind, recogView: this.view,
      sources: this.lastInputs.map((f, k) => ({ name: f.name ?? `source-${k + 1}`, ...(f.mime ? { mime: f.mime } : {}), bytes: f.bytes })),
    };
    if (this.sessionKind === "jianpu" && this.score && this.bin) base.jianpu = { score: this.score, bin: this.bin, meta: this.meta };
    const cur = this.host.formats.source?.current();
    if (this.staffSession && docFormat !== "musicxml" && cur) base.staffText = { format: cur, links: this.staffLinks?.entries() ?? [] };
    return base;
  }

  /**
   * 还原一个识别会话（打开 `.dolce`、恢复自动保存）：**不重跑识别**。简谱：识别结果、二值图、点选映射照存的还原，
   * 原文换成存的那份（手改过的）。五线谱：原文落地同打开 `.musicxml`，对照数据等第一次进原图对照时从原图补（`ensureStaffResult`）。
   */
  async restore(s: ProjectSnapshot): Promise<void> {
    this.clear();
    if (s.omrFormat && isOmrFormat(s.omrFormat)) this.format = s.omrFormat;
    if (s.recogKind === "auto" || s.recogKind === "jianpu" || s.recogKind === "staff") this.kind = s.recogKind;
    if (s.recogView === "inplace" || s.recogView === "floating" || s.recogView === "original") this.setRecogView(s.recogView);
    this.syncKindSelects();
    this.lastInputs = s.sources.map((x) => ({ bytes: x.bytes, ...(x.mime ? { mime: x.mime } : {}), name: x.name }));
    if (s.kind === "jianpu" && s.jianpu) {
      this.emit(s.jianpu.score, s.jianpu.bin);
      if (this.host.getText() !== s.text) this.host.setText(s.text);
      this.meta = s.jianpu.meta;
      this.idMap = null;
      this.emitted = s.emitted;
      this.sessionKind = "jianpu";
      this.host.setContextControl(this.kindField(), true);
      this.syncPagesBtn();
      await this.enterAfterRecognize("original"); // 同刚识别完
      return;
    }
    // 五线谱会话：识别原文（`emitted`，MusicXML）是格式下拉的原稿；存的时候换成了文本格式的，接着在那种格式里改、旁表照存的还原
    if (s.docFormat === "musicxml") this.host.adoptStaffXml(s.text);
    else if (s.emitted !== null && s.staffText && this.host.adoptStaffXml(s.emitted) && this.host.formats.source?.resume) {
      this.sessionKind = s.kind; // 换格式时按识别会话带识别 id
      this.host.formats.source.resume(s.staffText.format, s.text);
      this.staffLinks = new StaffLinks(new Map(s.staffText.links));
      this.host.formats.sync();
    } else this.host.adoptText(s.docFormat, s.text, null);
    this.staffEmitted = s.emitted;
    this.sessionKind = s.kind;
    this.fromProject = true;
    this.host.setContextControl(this.kindField(), true);
    this.syncPagesBtn();
    if ((s.kind === "staff" || s.kind === "vector") && this.lastInputs.length) {
      if (this.btnEl) this.btnEl.textContent = t("omr.compare");
      this.host.setContextControl(this.btnEl, true);
      if (s.kind === "staff") this.prerenderOriginals(this.lastInputs); // 并排原图的原样底图先画起来，不等补对照数据
      // 对照方式同刚识别完；档位不动（还没补回对照数据，不知道是不是简线混排谱）。对照数据由并排 / 叠加视图自己从原图补
      await this.enterAfterRecognize(null);
    }
  }

  /** 这个会话是重开的项目（`restore`），对照数据要从原图补；识别出来的会话为 false */
  private fromProject = false;

  /** 五线谱项目重开后第一次进对照：从原图重跑识别补回逐页位图与音符坐标（不动原文）。 */
  private ensureStaffResult(): Promise<boolean> {
    // 只补重开的项目：识别流程里结果还没落地（矢量路落谱面与渲对照底图之间）并排就开着，别当成缺数据再跑一遍识别
    if (this.staffResult || !this.lastInputs.length || !this.fromProject) return Promise.resolve(this.staffResult !== null);
    this.ensuring ??= this.loadStaffResult().then((ok) => {
      this.staffLoadFailed = !ok;
      return ok;
    }).finally(() => { this.ensuring = null; });
    return this.ensuring;
  }

  private async loadStaffResult(): Promise<boolean> {
    const g = this.gen;
    // 补的途中打开了别的文档：补回来的不能挂到新文档上
    const land = (r: import("../staffomr/review").StaffReviewResult): boolean => {
      if (g !== this.gen) return false;
      this.staffResult = r;
      this.host.setStatus("");
      return true;
    };
    if (this.sessionKind === "vector") {
      // 矢量 PDF 项目重开：重跑一遍矢量识别拿框（快，不用 OCR），再渲底图
      this.progress(t("omr.loadingPdf"));
      try {
        const sb = await import("../staffomr/browser");
        const bytes = this.lastInputs[0]!.bytes;
        const doc = await sb.openStaffPdf(bytes);
        try {
          // 转曲的矢量谱（`outlineomr/`）重跑要带 OCR（文字是路径），慢一些
          const res = (await sb.isStaffPdf(doc.pdf, doc.OPS))
            ? await sb.recognizeStaffPdf(doc, { noteIds: true })
            : await (await import("../outlineomr/browser")).recognizeOutlinedPdf(doc, { noteIds: true });
          return land(await sb.vectorOverlayResult(doc, res));
        } finally {
          doc.pdf.destroy?.();
        }
      } catch (e) {
        if (g === this.gen) this.host.setStatus(t("omr.loadFailed", { error: e instanceof Error ? e.message : String(e) }));
        return false;
      }
    }
    if (this.sessionKind !== "staff") return false;
    const rb = await import("../rasteromr/browser");
    this.progress(t("omr.loadingImg"));
    try {
      const pdfs: Uint8Array[] = [];
      for (const f of this.lastInputs) pdfs.push(await rb.asRasterPdf(f.bytes, f.mime));
      return land(await rb.recognizeRasterPdfs(pdfs, {
        // 与第一次识别同口径（关联表重建出的 MusicXML 要有曲名）
        title: this.lastInputs.length === 1 && this.lastInputs[0]!.name ? baseTitle(this.lastInputs[0]!.name) : undefined,
        onPage: (done, total) => g === this.gen && this.progress(t("omr.loadingImgPages", { done, total })),
        cancelled: () => g !== this.gen,
      }));
    } catch (e) {
      if (g === this.gen) this.host.setStatus(t("omr.loadFailed", { error: e instanceof Error ? e.message : String(e) }));
      return false;
    }
  }

  /** 位图五线谱的识别结果（各页位图与音符坐标），对照视图用；简谱识别或清掉后为 null */
  staffResult: StaffReviewResult | null = null;

  private kindField(): Element | null {
    return this.kindSelects[1]?.closest(".toolbar-select-field") ?? null;
  }

  // ---------------- 原图片段跟随 ----------------
  /** 排版稿（简谱 / 五线谱 / 混排档）里选中音符时，右下角小窗显示原图上那一行并框出这个音。持久化 */
  follow = false;
  private followBtn: HTMLButtonElement | null = null;
  private followEl: HTMLElement | null = null;

  setFollowBtn(btn: HTMLButtonElement, box: HTMLElement | null): void {
    this.followBtn = btn;
    this.followEl = box;
    this.host.setContextControl(btn, false);
    btn.addEventListener("click", () => {
      this.follow = !this.follow;
      this.host.saveSettings();
      this.syncFollowBtn();
      if (!this.follow) this.followSelection(null);
    });
    this.syncFollowBtn();
  }

  private syncFollowBtn(): void {
    this.followBtn?.classList.toggle("active", this.follow);
    this.followBtn?.setAttribute("aria-pressed", String(this.follow));
  }

  /** 排版稿里选中了元素 `id`（源模型的 id）：小窗换到它那一行；null / 关着 / 没有识别结果 / 对不上框 → 收起。 */
  followSelection(id: ElementId | null): void {
    this.syncSide(id);
    const box = this.followEl;
    if (!box) return;
    const i = id !== null && this.follow && this.bin && this.score && this.host.mode !== "recognize"
      ? this.idMapOf(this.host.currentScoreDoc())?.toI.get(id)
      : undefined;
    if (i === undefined || !this.bin || !this.score) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const ri = this.rowIndexOfFlat(i);
    const svg = renderRowSource(this.bin, this.score, ri);
    // 框出这个音（坐标就是源图像素，与浮窗同一坐标系）
    const flat = this.score.rows.flatMap((r) => r.nums);
    const b = flat[i]?.bbox;
    if (b) {
      const pad = Math.max(3, b.h * 0.25);
      const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      r.setAttribute("class", "omr-follow-hit");
      r.setAttribute("x", String(b.x - pad));
      r.setAttribute("y", String(b.y - pad));
      r.setAttribute("width", String(b.w + pad * 2));
      r.setAttribute("height", String(b.h + pad * 2));
      r.setAttribute("rx", String(pad));
      svg.appendChild(r);
    }
    // 以这个音为中心横向裁一段（约 8 个行高宽），整行太宽缩下来字就看不清了
    const vb = svg.getAttribute("viewBox")?.split(/\s+/).map(Number);
    if (b && vb && vb.length === 4) {
      const w = Math.min(this.bin.w, vb[3]! * 8);
      const x = Math.max(0, Math.min(this.bin.w - w, b.x + b.w / 2 - w / 2));
      svg.setAttribute("viewBox", `${x} ${vb[1]} ${w} ${vb[3]}`);
    }
    box.replaceChildren(svg);
    box.hidden = false;
  }

  // ---------------- 识别途中先给看得到的 ----------------
  /** 识别一开始就能给界面了（离开开始页、撤掉整块遮罩）：`main.ts` 接上 */
  onEarlyView: (() => void) | null = null;
  /** 识别途中：并排面板先放原图（不带框），谱面区每页一张「识别中」占位，识别完换成结果 */
  private pending: { g: number; side: boolean; pages: SVGTextElement[] } | null = null;

  /** 开始识别（`recognizeFilesInner` 一进来就调，不等判路）：旧图当场清掉，能看的先给——原图（并排，按用户的核对方式）与逐页的识别进度占位。
   *  同一次识别只铺一次（各路里再调是空操作） */
  private async showPending(files: readonly RecogInput[], g: number): Promise<void> {
    if (this.pending?.g === g) return;
    this.pending = { g, side: this.side, pages: [] };
    this.onEarlyView?.();
    // 上一份文档留下的状态栏说明、试听、可疑项计数当场撤掉（各路判完再换成自己的进度）
    this.host.stopPlayback();
    this.host.setStatus(t("omr.running"));
    this.syncDoubtEl(0);
    // 旧谱面、旧原图当场清掉（占位与原图等量完页数再铺）
    this.host.clearPages();
    this.sideEl?.replaceChildren();
    this.sideKey = null;
    // 代码区还是上一份文档（开始页进来是示例谱）：识别期间盖住，别让人以为那就是结果
    const code = document.getElementById("code-pane");
    code?.classList.add("omr-pending");
    code?.setAttribute("data-pending", t("omr.codePending"));
    if ((this.compare ?? "side") === "side") {
      this.side = true;
      this.syncSide(null);
    }
    // 占位的页数与比例按原图（PDF 各页先量大小，图片读自然大小），不等识别
    const sizes: { w: number; h: number }[] = [];
    for (const src of this.prerenderOriginals(files).sources) {
      const got = await src.catch(() => null);
      if (got === null) continue;
      if (typeof got === "string") sizes.push(await imageSize(got));
      else sizes.push(...got.map((p) => ({ w: p.w, h: p.h })));
    }
    const pend = this.pending;
    if (!pend || pend.g !== g || g !== this.gen || !sizes.length) return;
    const NS = "http://www.w3.org/2000/svg";
    this.host.renderPagesWith(sizes.length, (i) => {
      const { w, h } = sizes[i]!;
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "omr-pending-page");
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      const text = document.createElementNS(NS, "text");
      text.setAttribute("x", String(w / 2));
      text.setAttribute("y", String(h / 2));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("font-size", String(Math.round(w * 0.03)));
      text.textContent = t("omr.pagePending", { n: i + 1 });
      svg.appendChild(text);
      pend.pages.push(text);
      return svg;
    }, { aspectRatio: (i) => `${sizes[i]!.w} / ${sizes[i]!.h}`, resetPageIndex: true });
  }

  /** 识别进度：前 `done` 页的占位改成「已识别」 */
  private markPendingDone(done: number): void {
    const pend = this.pending;
    if (!pend) return;
    pend.pages.forEach((el, i) => {
      if (i < done && !el.classList.contains("done")) {
        el.classList.add("done");
        el.textContent = t("omr.pageDone", { n: i + 1 });
      }
    });
  }

  /** 识别结束：成功的接着进结果（`enterAfterRecognize` 会重摆并排）；没成的（`recognizeFiles` 收尾）把并排开关还原、谱面按原文重排 */
  private endPending(ok: boolean): void {
    const pend = this.pending;
    if (!pend) return;
    this.pending = null;
    document.getElementById("code-pane")?.classList.remove("omr-pending");
    if (ok) return;
    this.side = pend.side;
    this.syncSide(null);
    this.host.reload(this.host.getText());
    const score = this.shown?.score ?? this.score;
    if (score) this.syncDoubtEl(doubtItems(score, this.shown?.lyricFixes ?? []).length);
  }

  // ---------------- 识别完进哪儿 ----------------
  /** 用户在状态栏「核对」下拉里亲手选过的那一项（持久化 `omrCompare`，`comparemode.ts` 的六个值）；
   *  null = 没选过，识别完按**并排原图**。程序自己切的（识别完自动进、重开项目）不算 */
  compare: CompareValue | null = null;
  /** 让「核对」下拉选中某一项并照它切（`main.ts` 接上 `comparemode.ts::apply`）；无头环境里没有，退到只开并排 */
  applyCompare: ((value: CompareValue) => void) | null = null;

  /** 「核对」下拉上的用户选择 → 记下来 */
  setComparePreference(value: string): void {
    if (!(COMPARE_VALUES as readonly string[]).includes(value)) return;
    this.compare = value as CompareValue;
    this.host.saveSettings();
  }

  /**
   * 识别完（含重开识别项目）进视图：先切档——简谱进**原样**、五线谱进**五线谱**、简线混排谱进**混排**；
   * 再按用户在「核对」下拉里选过的方式进核对（没选过就并排原图）。`tier` 为 null 不切档。
   */
  private async enterAfterRecognize(tier: "original" | "staff" | "mixed" | null): Promise<void> {
    const pref = this.compare ?? "side";
    // 「并排原图」「原图页」按会话显出来（识别流程里它本在更晚处同步，「核对」下拉按它判这一项能不能选）
    this.syncPagesBtn();
    // 切档要在排版稿里切（核对视图里档位按钮不管用）
    if (this.host.mode === "recognize") await this.toggle();
    if (tier) await this.host.setViewMode(tier);
    if (this.applyCompare) this.applyCompare(pref);
    else {
      this.side = pref === "side";
      this.syncSide(null);
    }
  }

  // ---------------- 并排原图 ----------------
  /** 排版稿（简谱 / 五线谱 / 混排档）左边铺整页原图：选中的音框出来并滚到眼前，点原图上的音反选到排版稿。持久化 */
  side = false;
  private sideBtn: HTMLButtonElement | null = null;
  private sideEl: HTMLElement | null = null;
  /** 并排面板现在画的是哪份（换了识别结果、改了谱才重画底图与命中框） */
  private sideKey: unknown = null;

  /** 收起代码区（`#body.hide-code`），任何模式下都生效；并排时原图与排版稿各占一半。持久化（设置键沿用 `sideHideCode`） */
  hideCode = false;
  private codeCheck: HTMLInputElement | null = null;

  /** 状态栏「源码」复选框：勾着显示代码区。 */
  setCodeCheckbox(chk: HTMLInputElement): void {
    this.codeCheck = chk;
    chk.addEventListener("change", () => {
      const on = chk.checked;
      this.hideCode = !on;
      this.host.saveSettings();
      this.applyCodePane();
      // `.musicxml` 没有代码区：勾上就转成文本格式来改（取消了转换，复选框拨回没勾）
      if (on && !this.host.hasCodePane()) void this.host.openSourceView().then(() => this.applyCodePane());
    });
    this.applyCodePane();
  }

  /** 按 `hideCode` 收起 / 放出代码区，复选框跟着。 */
  applyCodePane(): void {
    document.getElementById("body")?.classList.toggle("hide-code", this.hideCode);
    if (this.codeCheck) this.codeCheck.checked = !this.hideCode && this.host.hasCodePane();
  }

  setSideBtn(btn: HTMLButtonElement, box: HTMLElement | null): void {
    this.sideBtn = btn;
    this.sideEl = box;
    this.host.setContextControl(btn, false);
    btn.addEventListener("click", () => {
      this.side = !this.side;
      this.host.saveSettings();
      this.syncSide(null);
    });
    if (!box) return;
    // 鼠标拖动平移的状态（见下面 pointer* 三个监听）
    let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;
    let dragged = false;
    box.addEventListener("click", (e) => {
      if (dragged) return void (dragged = false); // 刚拖过：这次不当点选
      const r = e.target instanceof Element ? e.target.closest<SVGRectElement>("rect.omr-side-hit") : null;
      const id = r ? Number(r.dataset.id) : NaN;
      if (Number.isFinite(id)) this.host.selectNote(id);
    });
    // 捏合 / Ctrl·⌘+滚轮缩放：1 = 铺满栏宽
    attachPinchZoom(box, {
      get: () => this.sideZoom,
      set: (z) => this.setSideZoom(z),
      pages: () => box.querySelectorAll(".omr-side-page"),
      touch: true,
    });
    // 双击空白处回到铺满栏宽
    box.addEventListener("dblclick", (e) => {
      if (e.target instanceof Element && e.target.closest("rect.omr-side-hit")) return;
      this.setSideZoom(1);
    });
    // 鼠标按住拖动 = 滚动（触屏单指本来就原生滚动）；动过 4px 才算拖，随后的 click 不选音
    box.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch" || e.button !== 0) return;
      // 按在面板自己的滚动条上：交给浏览器
      const rc = box.getBoundingClientRect();
      if (e.clientX - rc.left >= box.clientLeft + box.clientWidth || e.clientY - rc.top >= box.clientTop + box.clientHeight) return;
      e.preventDefault(); // 不起 <img> 的原生拖图、不选文字
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop };
      dragged = false;
    });
    box.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!dragged && Math.hypot(dx, dy) < 4) return;
      if (!dragged) {
        dragged = true;
        box.setPointerCapture(e.pointerId);
        box.classList.add("dragging");
      }
      box.scrollLeft = drag.left - dx;
      box.scrollTop = drag.top - dy;
    });
    const endDrag = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      box.classList.remove("dragging");
    };
    box.addEventListener("pointerup", endDrag);
    box.addEventListener("pointercancel", (e) => {
      endDrag(e);
      dragged = false;
    });
  }

  /** 并排原图的缩放（1 = 铺满栏宽，至多 8 倍）：写进 `#omr-side` 的 `--side-zoom`。不持久化，换一份识别结果复位 */
  private sideZoom = 1;
  private setSideZoom(z: number): void {
    this.sideZoom = Math.min(8, Math.max(1, z));
    this.sideEl?.style.setProperty("--side-zoom", String(this.sideZoom));
  }

  /** 并排面板：开关、底图、框出 `id`。排版稿选区一变就调（`followSelection` 顺带调）。 */
  syncSide(id: ElementId | null): void {
    this.sideBtn?.classList.toggle("active", this.side);
    this.sideBtn?.setAttribute("aria-pressed", String(this.side));
    const box = this.sideEl;
    if (!box) return;
    const on = this.side && this.host.mode !== "recognize" && (this.bin !== null && this.score !== null || this.staffResult !== null || this.sessionKind === "staff" || this.sessionKind === "vector" || this.pending !== null);
    box.hidden = !on;
    document.getElementById("score-pane")?.classList.toggle("with-omr-side", on);
    // 原图｜排版之间的分隔条（editor/splitters.ts）跟着原图栏显隐
    const split = document.getElementById("split-side");
    if (split) split.hidden = !on;
    if (!on) {
      box.replaceChildren();
      this.sideKey = null;
      return;
    }
    const pane = document.getElementById("score-pane");
    if (pane) {
      box.style.top = `${pane.offsetTop}px`;
      if (split) split.style.top = box.style.top;
    }
    void this.drawSide(id);
  }

  private async drawSide(id: ElementId | null): Promise<void> {
    const box = this.sideEl!;
    // 识别途中：先放这次的原图（不带框；上一次的结果还没清，别画回旧图），识别完 `enterAfterRecognize` 再摆一次
    if (this.pending) {
      if (this.sideKey === "plain") return;
      this.sideKey = "plain";
      this.setSideZoom(1); // 新的一份识别：原图从铺满栏宽看起
      const pages = await this.plainOriginalPages();
      if (this.sideKey === "plain" && this.pending) box.replaceChildren(...pages);
      return;
    }
    // 五线谱项目重开后还没有对照数据：先从原图补
    if (!this.staffResult && (this.sessionKind === "staff" || this.sessionKind === "vector") && !(this.bin && this.score)) {
      // 补的途中先放原图（不带框），别让面板黑着等几十秒
      if (this.sessionKind === "staff" && this.sideKey !== "plain") {
        this.sideKey = "plain";
        const pages = await this.plainOriginalPages();
        if (this.sideKey === "plain" && !this.staffResult) box.replaceChildren(...pages);
        this.setSideZoom(1);
      }
      if (this.staffLoadFailed || !(await this.ensureStaffResult())) return;
    }
    const doc = this.host.currentScoreDoc();
    const key = [this.score, this.staffResult, doc];
    const fresh = !Array.isArray(this.sideKey) || (this.sideKey as unknown[]).some((x, i) => x !== key[i]);
    if (fresh) {
      // 换了一份识别结果才复位缩放；同一份里改谱重画不动
      const prev = this.sideKey;
      if (!Array.isArray(prev) || prev[0] !== key[0] || prev[1] !== key[1]) this.setSideZoom(1);
      this.sideKey = key;
      box.replaceChildren(...(await this.sidePages(doc)));
    }
    for (const r of box.querySelectorAll("rect.omr-side-hit.on")) r.classList.remove("on");
    if (id === null) return;
    const hit = box.querySelector<SVGRectElement>(`rect.omr-side-hit[data-id="${id}"]`);
    hit?.classList.add("on");
    hit?.scrollIntoView({ block: "center", inline: "nearest" });
  }

  /** 并排面板的各页：原图 + 每个音一个框（`data-id` = 排版稿里的元素 id）。 */
  private async sidePages(doc: ScoreDoc | null): Promise<SVGSVGElement[]> {
    const page = (bin: Binary, boxes: { id: ElementId; x: number; y: number; w: number; h: number }[], view?: Promise<PageView>): SVGSVGElement => {
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "omr-side-page");
      svg.setAttribute("viewBox", `0 0 ${bin.w} ${bin.h}`);
      if (view) {
        // 整页原图（见 `placePageView`）画好之前先铺白纸（不然面板黑着），画好了换上：框仍按位图坐标，viewBox 把页面伸出去的那截框进来
        const paper = document.createElementNS(NS, "rect");
        for (const [k, v] of [["x", 0], ["y", 0], ["width", bin.w], ["height", bin.h]] as const) paper.setAttribute(k, String(v));
        paper.setAttribute("fill", "#fff");
        svg.appendChild(paper);
        void view.then((v) => {
          if (!v) return void paper.replaceWith(baseImage(bin));
          svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
          const img = document.createElementNS(NS, "image");
          for (const [k, n] of [["x", v.x], ["y", v.y], ["width", v.w], ["height", v.h]] as const) img.setAttribute(k, String(n));
          img.setAttribute("href", v.url);
          img.setAttribute("preserveAspectRatio", "none");
          img.style.setProperty("image-orientation", "none"); // 识别时 JPEG 原样包进 PDF、不认 EXIF 方向，底图也不转
          paper.replaceWith(img);
        });
      } else {
        svg.appendChild(baseImage(bin));
      }
      for (const b of boxes) {
        const pad = Math.max(3, b.h * 0.25);
        const r = document.createElementNS(NS, "rect");
        r.setAttribute("class", "omr-side-hit");
        r.dataset.id = String(b.id);
        r.setAttribute("x", String(b.x - pad));
        r.setAttribute("y", String(b.y - pad));
        r.setAttribute("width", String(b.w + pad * 2));
        r.setAttribute("height", String(b.h + pad * 2));
        r.setAttribute("rx", String(pad));
        svg.appendChild(r);
      }
      return svg;
    };
    if (this.staffResult) {
      const res = this.staffResult;
      const ids = await this.staffIds(doc);
      const byOmr = new Map([...ids].map(([k, v]) => [v, k]));
      const views = this.staffPageViews(res);
      return res.pages.map((p, i) => page(p.result.raster!.bin, [...res.noteBoxes].filter(([oid, b]) => b.page === i && byOmr.has(oid))
        .map(([oid, b]) => ({ id: byOmr.get(oid)!, x: b.box.left, y: b.box.top, w: b.box.right - b.box.left, h: b.box.bottom - b.box.top })), views[i]));
    }
    if (!this.bin || !this.score) return [];
    const bin = this.bin;
    const map = this.idMapOf(doc);
    const flat = this.score.rows.flatMap((r) => r.nums);
    const boxes = map ? map.toId.flatMap((id, i) => {
      const b = flat[i]?.bbox;
      return id !== undefined && b ? [{ id, x: b.x, y: b.y, w: b.w, h: b.h }] : [];
    }) : [];
    // 简谱的位图就是整张原图（PDF 是第一页整页）等比缩放来的、没纠斜：原图铺满位图范围就对得上
    return [page(bin, boxes, this.wholePageView(0, 1, bin))];
  }

  /** 原图各份的原样底图（`renderPdfPages`），按输入列表缓存：开始识别时就画起来（`prerenderOriginals`），不等识别。
   *  图片输入直接是原图的地址；PDF 是逐页的 promise（外层知道页数时给出）。 */
  private originals: { inputs: readonly RecogInput[]; sources: Promise<PendingPage[] | string>[] } | null = null;
  private prerenderOriginals(inputs: readonly RecogInput[]): NonNullable<OmrController["originals"]> {
    const cur = this.originals;
    if (cur && cur.inputs.length === inputs.length && cur.inputs.every((x, i) => x.bytes === inputs[i]!.bytes)) return cur;
    this.releaseOriginals();
    // 一份一份接着画：PDF 各页在 `renderPdfPages` 里已按页序排队，几份之间也排队，免得同时开几个画布
    let prev: Promise<unknown> = Promise.resolve();
    const sources = inputs.map((src) => {
      const s: Promise<PendingPage[] | string> = isPdf(src.bytes, src.mime)
        ? prev.then(async () => (await import("../rasteromr/browser")).renderPdfPages(src.bytes))
        : Promise.resolve(URL.createObjectURL(new Blob([src.bytes as BlobPart], src.mime ? { type: src.mime } : {})));
      prev = s.then((pages) => (typeof pages === "string" ? null : Promise.all(pages.map((p) => p.rendered)))).catch(() => null);
      return s;
    });
    this.originals = { inputs: [...inputs], sources };
    return this.originals;
  }

  private releaseOriginals(): void {
    const revoke = (u: string | undefined): void => void (u?.startsWith("blob:") && URL.revokeObjectURL(u));
    for (const s of this.originals?.sources ?? []) {
      void s.then((v) => (typeof v === "string" ? revoke(v) : v.forEach((p) => void p.rendered.then((r) => revoke(r?.url))))).catch(() => undefined);
    }
    this.originals = null;
  }

  /** 还没有对照数据时（项目重开、正从原图补）并排面板先放的原图：不带框，按各份各页的顺序，画好一页换上一页（之前铺白纸）。 */
  private async plainOriginalPages(): Promise<Element[]> {
    const NS = "http://www.w3.org/2000/svg";
    const out: Element[] = [];
    for (const src of this.prerenderOriginals(this.lastInputs).sources) {
      const got = await src.catch(() => null);
      if (got === null) continue;
      if (typeof got === "string") {
        const img = document.createElement("img");
        img.className = "omr-side-page";
        img.src = got;
        img.style.setProperty("image-orientation", "none");
        out.push(img);
        continue;
      }
      for (const pg of got) {
        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("class", "omr-side-page");
        svg.setAttribute("viewBox", `0 0 ${pg.w} ${pg.h}`);
        void pg.rendered.then((r) => {
          if (!r) return;
          const img = document.createElementNS(NS, "image");
          for (const [k, v] of [["x", 0], ["y", 0], ["width", pg.w], ["height", pg.h]] as const) img.setAttribute(k, String(v));
          img.setAttribute("href", r.url);
          img.setAttribute("preserveAspectRatio", "none");
          svg.appendChild(img);
        });
        out.push(svg);
      }
    }
    return out;
  }

  /** 第 `si` 份原图第 `pn` 页**整页**铺满位图 `bin`（简谱：位图就是整页缩放来的）；画不出为 null */
  private async wholePageView(si: number, pn: number, bin: Binary): Promise<PageView> {
    const src = this.prerenderOriginals(this.lastInputs).sources[si];
    const got = src ? await src.catch(() => null) : null;
    if (got === null) return null;
    const url = typeof got === "string" ? got : (await (got[pn - 1]?.rendered ?? Promise.resolve(null)))?.url;
    return url ? { url, x: 0, y: 0, w: bin.w, h: bin.h } : null;
  }

  /** 并排原图各页的整页底图：原样底图（`prerenderOriginals`）按识别位图摆好（`placePageView`）。逐页一个 promise，画好一页先给一页；
   *  取不到的页为 null（照旧画位图）。图片直接画原图：识别时它被包成一页与图同大的 PDF，位图与原图一一对应（彩色放大过的按位图宽高拉伸）。 */
  private staffPageViews(res: StaffReviewResult): Promise<PageView>[] {
    // 只有位图路：矢量 PDF 的位图本就是整页渲出来的
    if (this.sessionKind !== "staff") return res.pages.map(() => Promise.resolve(null));
    const { sources } = this.prerenderOriginals(this.lastInputs);
    return res.pages.map(async (p): Promise<PageView> => {
      const bin = p.result.raster?.bin;
      const src = sources[p.source];
      if (!bin || !src) return null;
      const got = await src.catch(() => null);
      if (got === null) return null;
      if (typeof got === "string") return { url: got, x: 0, y: 0, w: bin.w, h: bin.h };
      const r = await (got[p.pn - 1]?.rendered ?? Promise.resolve(null));
      return r ? (await import("../rasteromr/browser")).placePageView(r, bin) : null;
    });
  }

  /** 五线谱：模型和弦 id → 识别时写进 `<note id>` 的编号（按当前原文读，改过的谱也认得回来）。 */
  private async staffIds(doc: ScoreDoc | null): Promise<Map<ElementId, string>> {
    const out = new Map<ElementId, string>();
    const view = this.staffViewOf(doc);
    for (const part of view?.song.parts ?? []) {
      for (const m of part.measures) {
        for (const el of m.elements) {
          if (el.kind !== "chord") continue;
          const oid = view!.idsOf(el).find((x) => x);
          if (oid && this.staffResult?.noteBoxes.has(oid)) out.set(el.id, oid);
        }
      }
    }
    return out;
  }

  // ---------------- 识别 id ↔ 文档里的音（任何源格式，`omrlinks.ts`） ----------------
  /** 文本格式的旁表（原文起点 → 识别 id）；`.musicxml` 不用（id 在 `<note>` 上） */
  private staffLinks: StaffLinks | null = null;

  /** 这份文档（当前格式）各和弦的识别 id：MusicXML 读 `<note id>`，文本格式查旁表。 */
  private staffViewOf(doc: ScoreDoc | null, format: DocFormatId = this.host.docFormat, links: StaffLinks | null = this.staffLinks): StaffView | null {
    if (!doc?.songs[0]) return null;
    if (format === "musicxml") return { song: doc.songs[0], idsOf: surfaceIds };
    return textView(doc, links ?? new StaffLinks(new Map()));
  }

  /** 是五线谱识别会话（原图对照按识别 id 认框）。 */
  get staffSession(): boolean {
    return this.sessionKind === "staff" || this.sessionKind === "vector";
  }

  /** App 换原文格式之前（`adoptText`）：记下现在各音的识别 id，换完照拍点、音高带过去（`afterAdoptText`）。 */
  beforeAdoptText(): StaffView | null {
    if (!this.staffSession) return null;
    const view = this.staffViewOf(this.host.currentScoreDoc());
    // 投影出来的是新对象，原文模型（MusicXML 那份）换掉之后也还在：直接留着用
    return view;
  }

  /** 要落地成 `.musicxml` 的原文（从文本格式转回来的没有识别 id）：按换之前的谱写回 `<note id>`。 */
  stampStaffXml(xml: string, from: StaffView | null, load: (xml: string) => ScoreDoc): string {
    if (!from || !this.staffSession) return xml;
    if (/<note\b[^>]*\bid="omr/.test(xml)) return xml;
    return stampXmlIds(xml, from, load);
  }

  /** App 换完原文格式：文本格式按换之前的谱建旁表。 */
  afterAdoptText(from: StaffView | null): void {
    this.staffLinks = null;
    if (!from || this.host.docFormat === "musicxml") return;
    const doc = this.host.currentScoreDoc();
    const song = doc ? xmlShape(doc) : null;
    if (!doc || !song) return;
    this.staffLinks = StaffLinks.of(doc, carryIds(from, song));
    this.staffBase = null;
  }

  /** 原文改了：旁表的起点跟着挪（`App` 的 updateListener）。 */
  remapStaffLinks(mapPos: (pos: number) => number | null): void {
    if (this.staffLinks) this.staffLinks = this.staffLinks.remap(mapPos);
  }

  /** 编辑器改动时同步代码区间映射（CodeMirror 的 changes 映射）。 */
  remapMeta(map: (m: JpwMeta) => JpwMeta): void {
    if (this.meta) this.meta = map(this.meta);
  }

  // ---------------- 工具条绑定 ----------------
  /** Register the #btn-recognize element so App can enable/disable it. */
  setRecognizeBtn(el: HTMLButtonElement): void {
    this.btnEl = el;
    this.host.setContextControl(el, false);
  }

  /** Register the #sel-recog-view dropdown (识别视图切换)。 */
  setRecogViewSelect(el: HTMLSelectElement): void {
    this.viewSelectEl = el;
    el.value = this.view;
  }

  // ---------------- 输出格式（代码区标题栏的格式下拉） ----------------
  options(): readonly FormatOption[] {
    return OMR_EMITTERS.map(({ id, label }) => ({ value: id, label }));
  }

  current(): string {
    return this.format;
  }

  switchTo(value: string): Promise<boolean> {
    return isOmrFormat(value) ? this.setFormat(value) : Promise.resolve(false);
  }

  /** 切换识别视图（原位叠加/附近浮窗/仅原图）。识别模式下即时重渲。 */
  setRecogView(v: RecogView): void {
    this.view = v;
    if (this.viewSelectEl) this.viewSelectEl.value = v;
    if (this.host.mode === "recognize") this.renderPages();
  }

  /** 切换识别输出格式：有识别结果就地重出文本（不重跑识别），并持久化选择。
   *  @returns 是否切了（用户取消手改确认时为 false） */
  async setFormat(format: OmrFormat): Promise<boolean> {
    if (this.format === format) return true;
    const rec = this.score;
    const bin = this.bin;
    if (rec && bin && this.emitted !== null && this.host.getText() !== this.emitted) {
      if (!(await confirmDiscardEdits())) return false;
    }
    this.format = format;
    this.host.saveSettings();
    if (rec && bin) {
      // 保持当前预览模式（对照 / 简谱），只换文本——切格式不该把用户踢出正在看的视图。
      const wasRecognize = this.host.mode === "recognize";
      this.emit(rec, bin);
      if (wasRecognize && this.host.mode !== "recognize") await this.toggle();
      this.host.setStatus(t("omr.formatSwitched", { format: omrEmitter(format).label }));
    }
    return true;
  }

  // ---------------- 识别 ----------------
  /** 已取得图片字节后的识别核心（供拖拽识别复用）。
   *  保留二值图+识别结果，完成后进原样档，核对方式按用户在「核对」下拉里选过的（没选过就并排原图，`enterAfterRecognize`）。 */
  async recognizeBytes(picked: { bytes: Uint8Array; mime?: string }, jianpuOnly = false): Promise<boolean> {
    // 外部直接调（回归脚本、旧入口）走完整分流
    if (!jianpuOnly) return this.recognizeFiles([picked]);
    this.lastInputs = [{ ...picked }];
    const ok = await this.recognizeJianpu(picked, ++this.gen);
    this.syncPagesBtn();
    return ok;
  }

  /** 简谱识别（`recognizeFiles` 判完了走这里）。 */
  private async recognizeJianpu(picked: { bytes: Uint8Array; mime?: string }, g: number): Promise<boolean> {
    this.host.setStatus(t("omr.running"));
    void this.showPending([this.lastInputs[0] ?? picked], g);
    try {
      const t0 = performance.now();
      const { bin, score } = await recognizeMusicppDetailed(picked.bytes, picked.mime);
      if (g !== this.gen) return false;
      this.endPending(true);
      this.emit(score, bin);
      this.host.setContextControl(this.kindField(), true);
      await this.enterAfterRecognize("original"); // 简谱进原样档，对照方式按用户上次的选择（没选过就并排）
      const n = this.beatMarks.length;
      this.host.setStatus(t("omr.done", { sec: ((performance.now() - t0) / 1000).toFixed(1) })
        + (n ? t("omr.beatIssues", { n }) : ""));
      return true;
    } catch (e) {
      console.error("OMR failed", e);
      if (g !== this.gen) return false;
      this.host.setStatus(t("omr.failed", { error: (e instanceof Error ? e.message : String(e)) }));
      return false;
    }
  }

  /**
   * 五线谱 PDF 那条路：识别 → MusicXML → 走导入路径落地。
   *
   * 与简谱那条路的分工写在 `staffomr/browser.ts` 开头。识别不出谱表就返回 false，
   * 让调用方继续走简谱那条（该 PDF 多半是扫描件或简谱）。
   */
  private async tryStaffPdf(bytes: Uint8Array, t0: number, g: number): Promise<boolean> {
    const { openStaffPdf, isStaffPdf, recognizeStaffPdf, vectorOverlayResult } = await import("../staffomr/browser");
    // 一份 PDF 只打开一次：判路、识别、渲对照底图共用
    let doc: Awaited<ReturnType<typeof openStaffPdf>>;
    try {
      doc = await openStaffPdf(bytes);
    } catch {
      return false;
    }
    try {
      return await this.adoptStaffPdf(doc, t0, g, isStaffPdf, recognizeStaffPdf, vectorOverlayResult);
    } finally {
      doc.pdf.destroy?.();
    }
  }

  private async adoptStaffPdf(
    doc: import("../staffomr/browser").StaffPdfDoc, t0: number, g: number,
    isStaffPdf: typeof import("../staffomr/browser").isStaffPdf,
    recognizeStaffPdf: typeof import("../staffomr/browser").recognizeStaffPdf,
    vectorOverlayResult: typeof import("../staffomr/browser").vectorOverlayResult,
  ): Promise<boolean> {
    let ok = false;
    // 文字层完整的走矢量路；没有文字层、路径里有五线谱的（文字与音乐字形都转了曲）走 `outlineomr/`，不再落到简谱识别
    let outlined: typeof import("../outlineomr/browser") | null = null;
    try {
      ok = await isStaffPdf(doc.pdf, doc.OPS);
      if (!ok) {
        const ob = await import("../outlineomr/browser");
        if (await ob.isOutlinedStaffPdf(doc.pdf, doc.OPS)) (outlined = ob), (ok = true);
      }
    } catch {
      return false;
    }
    if (!ok || g !== this.gen) return false;
    void this.showPending(this.lastInputs, g);
    const onProgress = (done: number, total: number) => {
      if (g !== this.gen) return;
      this.host.setStatus(t("omr.staffProgress", { done, total }));
      this.markPendingDone(done);
    };
    const res = outlined ? await outlined.recognizeOutlinedPdf(doc, { onProgress, noteIds: true }) : await recognizeStaffPdf(doc, { onProgress, noteIds: true });
    if (g !== this.gen) return true; // 过时：不落地，也不让调用方再按简谱试
    if (!res.notes) {
      this.host.setStatus(t("omr.noStaff"));
      return false;
    }
    // 五线谱只出 MusicXML，且只进混排视图（理由见 OmrHost.adoptStaffXml）。
    const inputs = this.lastInputs;
    this.endPending(true);
    this.clear();
    this.lastInputs = inputs;
    this.sessionKind = "vector";
    this.host.setContextControl(this.kindField(), true);
    const jpOk = this.host.adoptStaffXml(res.musicxml);
    this.staffEmitted = this.host.getText();
    const formatNote = jpOk ? this.host.openInEditFormat() : "";
    const g2 = this.gen; // 上面 clear() 换了代号
    // 原图对照：页面渲成位图、框放大到像素（`vectorOverlayResult`），之后与位图那一路同一套对照视图与关联表
    try {
      const overlay = await vectorOverlayResult(doc, res);
      if (g2 !== this.gen) return true;
      this.staffResult = overlay;
      if (this.btnEl) this.btnEl.textContent = t("omr.compare");
      this.host.setContextControl(this.btnEl, true);
    } catch (e) {
      console.warn("矢量 PDF 渲不出对照底图", e);
    }
    // 转曲的简线混排谱（认出了简谱行）进混排档，同位图路
    if (g2 === this.gen) await this.enterAfterRecognize(outlined && "jianpu" in res && res.jianpu ? "mixed" : "staff");
    this.host.setStatus(
      t("omr.staffDone", { sec: ((performance.now() - t0) / 1000).toFixed(1), pages: res.pages, parts: res.parts, notes: res.notes }) +
        (res.skipped ? t("omr.staffSkipped", { n: res.skipped }) : "") +
        (jpOk ? "" : t("omr.staffNoJp")) + (formatNote ? `　${formatNote}` : ""),
    );
    return true;
  }

  /**
   * 把一份识别结果按当前输出格式出成编辑器文本。格式清单与各自的产出在 omr/emit.ts 的
   * 注册表里，这里只管把产物落到编辑器（123 按 123 文档落地，文本谱直接设文本）。
   * **不重跑识别。**
   *
   * 各 emitter 的 meta 都按同一套音符序（flatten(rows[].nums)）编号，
   * 所以「原图对照」的点选定位对所有格式通用（见 rangeOfHit）。
   */
  private emit(rec: RecognizedScore, bin: Binary): void {
    const out = omrEmitter(this.format).emit(rec);
    // importOmrDoc 开头会 clear()，故必须先落地、后回填本次产物。
    if (out.kind === "123") {
      this.host.importOmrDoc(out.doc, out.text);
    } else {
      this.clear();
      this.host.adoptText(out.kind, out.text, null);
    }
    this.beatMarks = recognizedBeatIssues(rec);
    this.sessionKind = "jianpu";
    this.meta = out.meta; // 点选映射按写出文本的源区间生成（`omr/meta.ts`）；.jpwabc / ABC 没有
    this.bin = bin;
    this.score = rec;
    this.emitted = this.host.getText();
    if (this.btnEl) this.btnEl.textContent = t("omr.compare");
    this.host.setContextControl(this.btnEl, true);
    this.host.setContextControl(this.followBtn, true);
    this.host.formats.use(this);
    this.host.syncViewModes();
  }

  /** 界面语言变了：对照按钮文字跟着换。 */
  relabel(): void {
    if (this.btnEl) this.btnEl.textContent = t(this.host.mode === "recognize" ? "omr.back" : "omr.compare");
  }

  // ---------------- 核对视图 ----------------
  /** 在「简谱模式」与「识别模式」（二值图+半透明识别叠加）之间切换。需先有 OMR 识别结果。 */
  async toggle(): Promise<void> {
    if (this.host.mode !== "recognize" && !this.staffResult && (this.sessionKind === "staff" || this.sessionKind === "vector")) {
      // 补数据期间连点：只进一次（前一下已经进了核对视图）
      if (!(await this.ensureStaffResult()) || (this.host.mode as string) === "recognize") return;
    }
    if (!this.hasResult) return;
    this.host.stopPlayback();
    if (this.host.mode === "recognize") {
      this.host.setRecognizeMode(false);
      this.setLayout(false);
      if (this.btnEl) this.btnEl.textContent = t("omr.compare");
      this.host.reload(this.host.getText());
      this.syncSide(null); // 回到排版稿：并排原图（开着的话）铺回来
      this.syncDoubtEl(0);
    } else {
      this.followSelection(null); // 核对视图本身就是原图，小窗收起
      this.host.setRecognizeMode(true);
      this.setLayout(true);
      if (this.btnEl) this.btnEl.textContent = t("omr.back");
      this.renderPages();
      this.syncSide(null); // 核对视图本身就是原图：并排面板收起
    }
  }

  /** 识别模式布局钩子：打 body.recognize 类 + 显示/隐藏视图下拉。 */
  private setLayout(on: boolean): void {
    document.getElementById("body")?.classList.toggle("recognize", on);
    const field = this.viewSelectEl?.closest<HTMLElement>("label"); // 状态栏里那个（`status-select-field`）
    if (field) field.hidden = !on;
    else if (this.viewSelectEl) this.viewSelectEl.hidden = !on;
    this.host.syncContextGroup(this.btnEl ?? field ?? this.viewSelectEl);
    if (!on) this.hidePopup();
  }

  /** 退出识别模式时的布局收尾（App 从别的入口切走预览模式时调用）。 */
  leaveLayout(): void {
    this.setLayout(false);
  }

  /** 渲染识别视图：二值图 + 识别结果 → 一张 SVG，沿用 score-page-wrap + zoom 容器。 */
  renderPages(): void {
    // 核对时改一下就整张重画：保住滚动位置（清空谱面会把它归零）
    const pane = document.getElementById("score-pane");
    const scroll = pane ? { top: pane.scrollTop, left: pane.scrollLeft } : null;
    this.host.clearPages();
    if (this.staffResult) {
      void this.renderStaffPages().then(() => {
        if (pane && scroll) {
          pane.scrollTop = scroll.top;
          pane.scrollLeft = scroll.left;
        }
        this.host.recognizeRendered();
      });
      return;
    }
    this.popupEl = null;
    this.playingEl = null;
    if (!this.bin || !this.score) return;
    const bin = this.bin;
    // 代码区改过：把当前模型投回原识别框（改过的标蓝、删掉的划灰、新插的插值定位）
    const doc = this.host.currentScoreDoc();
    const map = this.idMapOf(doc);
    this.shown = doc && map ? reprojectRecognized(this.score, doc, map.toI) : null;
    this.renderSeq++;
    const score = this.shown?.score ?? this.score;
    // 可视化编辑开着时拍数红框由它按当前模型画（随改随变）；识别完那一份只在不能编辑时画
    const marks = this.host.visualEnabled() ? [] : this.beatMarks.map((m) => ({ ...m, tag: beatTag(m.issue) }));
    this.host.renderPagesWith(1, () => renderRecognitionSvg(bin, score, this.view, marks, this.shown ?? undefined), {
      aspectRatio: () => `${bin.w} / ${bin.h}`,
      position: "relative", // 浮窗绝对定位相对此容器
      onPage: (svg, wrap) => this.wireInteraction(svg, wrap),
      resetPageIndex: false,
    });
    if (pane && scroll) {
      pane.scrollTop = scroll.top;
      pane.scrollLeft = scroll.left;
    }
    this.syncDoubtEl(doubtItems(score, this.shown?.lyricFixes ?? []).length);
    this.host.recognizeRendered();
  }

  // ---------------- 可疑项（复核标黄，`JpNum.doubt` / `lyricDoubt`） ----------------
  private doubtEl: HTMLButtonElement | null = null;
  /** 「下一处」上次跳到第几个 */
  private doubtAt = -1;

  setDoubtEl(el: HTMLButtonElement): void {
    this.doubtEl = el;
    el.addEventListener("click", () => this.nextDoubt());
    this.syncDoubtEl(0);
  }

  private syncDoubtEl(n: number): void {
    const el = this.doubtEl;
    if (!el) return;
    el.hidden = n === 0 || this.host.mode !== "recognize" || !!this.staffResult;
    el.textContent = t("omr.doubts", { n });
  }

  /** F8 导航用：各处可疑项在原文的位置（按点选映射）与跳过去的办法（同点命中框）。不在核对视图、没有映射时为空 */
  doubtStops(): { at: number; go(): void }[] {
    const score = this.shown?.score ?? this.score;
    if (!score || this.host.mode !== "recognize" || !this.meta) return [];
    const items = doubtItems(score, this.shown?.lyricFixes ?? []);
    const pane = document.getElementById("score-pane");
    const out: { at: number; go(): void }[] = [];
    items.forEach((it, k) => {
      const sel = it.verse === null
        ? `.omr-hits rect[data-kind="note"][data-i="${it.i}"]`
        : `.omr-hits rect[data-kind="lyric"][data-i="${it.i}"][data-verse="${it.verse}"]`;
      const hit = pane?.querySelector<SVGRectElement>(sel);
      const range = hit ? this.rangeOfHit(hit) : null;
      if (!hit || !range) return;
      out.push({ at: range.from, go: () => this.jumpDoubt(hit, k, items.length, it) });
    });
    return out;
  }

  private jumpDoubt(hit: SVGRectElement, k: number, n: number, it: { i: number; verse: number | null }): void {
    hit.scrollIntoView({ block: "center", inline: "nearest" });
    const r = hit.getBoundingClientRect();
    hit.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    this.host.setStatus(t("omr.doubtAt", { i: k + 1, n }) + `${hit.closest("svg")?.querySelector(`.omr-doubt-box[data-i="${it.i}"]${it.verse === null ? ":not([data-verse])" : `[data-verse="${it.verse}"]`} title`)?.textContent ?? ""}`);
  }

  /** 跳到下一处标黄的音 / 字：选中它（同点命中框）并滚到眼前。 */
  nextDoubt(): void {
    const score = this.shown?.score ?? this.score;
    if (!score) return;
    const items = doubtItems(score, this.shown?.lyricFixes ?? []);
    if (!items.length) return;
    this.doubtAt = (this.doubtAt + 1) % items.length;
    const it = items[this.doubtAt]!;
    const sel = it.verse === null
      ? `.omr-hits rect[data-kind="note"][data-i="${it.i}"]`
      : `.omr-hits rect[data-kind="lyric"][data-i="${it.i}"][data-verse="${it.verse}"]`;
    const hit = document.querySelector<SVGRectElement>(`#score-pane ${sel}`);
    if (!hit) return;
    hit.scrollIntoView({ block: "center", inline: "nearest" });
    const r = hit.getBoundingClientRect();
    hit.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    this.host.setStatus(t("omr.doubtAt", { i: this.doubtAt + 1, n: items.length }) + `${hit.closest("svg")?.querySelector(`.omr-doubt-box[data-i="${it.i}"]${it.verse === null ? ":not([data-verse])" : `[data-verse="${it.verse}"]`} title`)?.textContent ?? ""}`);
  }

  // ---------------- 五线谱识别的对照（位图路，`rasteromr/overlay.ts`） ----------------
  /** 当前模型的和弦 id → 它写在 `<note id>` 里的识别 id（对照框按它认） */
  private staffIdOf = new Map<ElementId, string>();
  /** 识别 id（和弦里每个音各一个）→ 现在是哪个和弦的第几个音（Alt+点补音按它取参照音高） */
  private staffNoteOfOmr = new Map<string, { chord: ElementId; k: number }>();

  /** 识别（或上次重建）刚落地时各音的样子（识别 id → 音高 + 时值的签名）：对照视图按它判「改过」。按原文缓存 */
  private staffBase: { text: string; format: DocFormatId; sig: Map<string, string>; noId: number; marks: StaffMarkBase } | null = null;
  /** 索引条目（`omrlinks.ts::markEntryKey`）→ 它现在对的那个歌词 / 弧 / 力度 / 文字的识别 id */
  private staffMarkOf = new Map<string, { id: string; stopId?: string }>();

  /**
   * 识别落地时那份（`staffEmitted`，MusicXML）各音的签名。当前是文本格式时，基准也先过一遍同一种格式（写出再读回、投影），
   * 两边在同一个口径上比：简谱把二分休止拆成几拍、时值类型换算，不该都算成「改过」。
   */
  private staffBaseSig(loadDoc: (xml: string) => ScoreDoc): Map<string, string> | null {
    return this.staffBaseOf(loadDoc)?.sig ?? null;
  }

  /** 同 `staffBaseSig`，连歌词字、弧、力度、文字的落地样子（`StaffMarkBase`）一起 */
  private staffBaseOf(loadDoc: (xml: string) => ScoreDoc): NonNullable<OmrController["staffBase"]> | null {
    const text = this.staffEmitted;
    if (text === null) return null;
    const format = this.host.docFormat;
    if (this.staffBase?.text !== text || this.staffBase.format !== format) {
      const sig = new Map<string, string>();
      let noId = 0;
      try {
        const xmlDoc = loadDoc(text);
        let view: StaffView = { song: xmlDoc.songs[0]!, idsOf: surfaceIds };
        if (format !== "musicxml") {
          const via = this.host.viaCurrentFormat(xmlDoc);
          const song = via ? xmlShape(via) : null;
          if (song) {
            const ids = carryIds(view, song);
            view = { song, idsOf: (el) => ids.get(el.id) ?? [] };
          }
        }
        for (const part of view.song.parts) for (const m of part.measures) for (const el of m.elements) {
          if (el.kind !== "chord") continue;
          const id = view.idsOf(el).find((x) => x);
          if (id) sig.set(id, chordSig(el));
          else if (!el.grace && !(el.rest && el.printObject === false) && !view.idsOf(el).includes(COVERED)) noId++;
        }
        // 歌词字、弧、力度、文字：id 从 MusicXML 那份读（元素上的 `id`），签名按当前格式那份的同一位置取（同上，两边一个口径）
        const xmlMarks = staffMarksOf({ song: xmlDoc.songs[0]!, idsOf: surfaceIds }, true);
        const viaSig = new Map<string, string>();
        if (format !== "musicxml") for (const mk of staffMarksOf(view, false)) for (const k of [mk.key, mk.alt]) if (k) viaSig.set(k, mk.sig);
        const marks: StaffMarkBase = { sig: new Map(), idsByKey: new Map() };
        for (const mk of xmlMarks) {
          for (const id of mk.ids) marks.sig.set(id, (mk.key && viaSig.get(mk.key)) || (mk.alt && viaSig.get(mk.alt)) || mk.sig);
          if (mk.ids.length) for (const k of [mk.key, mk.alt]) if (k) marks.idsByKey.set(k, mk.ids);
        }
        this.staffBase = { text, format, sig, noId, marks };
      } catch {
        return null;
      }
    }
    return this.staffBase;
  }

  /** 逐页画：页面位图 + 每个识别出的音一个框，框上标它现在的音名（改过标青、删掉划掉、新插的插值画虚框）；小节线一条竖线。 */
  private async renderStaffPages(): Promise<void> {
    const res = this.staffResult;
    if (!res) return;
    const { renderStaffRecognitionPage } = await import("../rasteromr/overlay");
    const { loadScoreDoc } = await import("../model/fromxml");
    const sv = this.staffViewOf(this.host.currentScoreDoc());
    const base0 = this.staffBaseOf(loadScoreDoc);
    const base = base0?.sig ?? null;
    const now = new Map<string, { label: string; changed: boolean }>();
    const pitchLabel = (p: { step: string; alter: number; octave: number } | undefined): string =>
      p ? `${p.step}${p.alter > 0 ? "♯".repeat(p.alter) : "♭".repeat(-p.alter)}${p.octave}` : t("omr.restLabel");
    this.staffIdOf.clear();
    this.staffNoteOfOmr.clear();
    /** 和弦 id → 全曲第几小节（小节线按它认）；识别 id（和弦里每个音各一个）→ 和弦 id */
    const measureOf = new Map<ElementId, number>();
    const chordOfOmr = new Map<string, ElementId>();
    /** 没有识别 id 的（新插的）：按前后有框的音插值画 */
    const inserted: { id: ElementId; label: string; prev: string | null; next: string | null; nth: number; diat: number | null }[] = [];
    const DIAT: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
    const diatOf = (p: { step: string; octave: number } | undefined): number | null => (p ? p.octave * 7 + DIAT[p.step]! : null);
    for (const part of sv?.song.parts ?? []) {
      const lastWithId = new Map<number, string>();
      const pending = new Map<number, typeof inserted>();
      part.measures.forEach((m, mi) => {
        for (const el of m.elements) {
          if (el.kind !== "chord") continue;
          measureOf.set(el.id, mi);
          const ids = sv!.idsOf(el);
          // 简谱拆开的休止接着前一个识别休止：不对应框、也不是新插的
          if (ids.includes(COVERED) && !ids.some((x) => x)) continue;
          let first: string | null = null;
          ids.forEach((id, k) => {
            if (!id || !res.noteBoxes.has(id)) return;
            if (first === null) first = id;
            if (k === 0) this.staffIdOf.set(el.id, id);
            chordOfOmr.set(id, el.id);
            this.staffNoteOfOmr.set(id, { chord: el.id, k });
            const orig = res.noteBoxes.get(id)!;
            const p = el.notes[k]?.pitch;
            const label = el.rest ? t("omr.restLabel") : pitchLabel(p);
            // 有识别落地时的样子就整个和弦比（音高、时值、附点、连音、倚音、和弦音数）；没有（项目重开）只比音高
            const was = k === 0 ? base?.get(id) : undefined;
            const changed = was !== undefined ? soundSig(was) !== soundSig(chordSig(el))
              : el.rest ? !orig.rest : !p || orig.rest || p.step !== orig.step || p.octave !== orig.octave || p.alter !== orig.alter;
            if (!now.has(id)) now.set(id, { label, changed });
          });
          const voice = el.voice;
          if (first !== null) {
            for (const x of pending.get(voice) ?? []) x.next = first;
            pending.delete(voice);
            lastWithId.set(voice, first);
          } else if (!el.grace && !(el.rest && el.printObject === false)) {
            // 不可见休止（ABC 第二支 `&` 补齐用的 `x`）识别里本来没有，不当新插的画
            const list = pending.get(voice) ?? [];
            const it = { id: el.id, label: el.rest ? t("omr.restLabel") : pitchLabel(el.notes[0]?.pitch), prev: lastWithId.get(voice) ?? null, next: null, nth: list.length, diat: diatOf(el.notes[0]?.pitch) };
            list.push(it);
            pending.set(voice, list);
            inserted.push(it);
          }
        }
      });
    }
    // 新插的音的框：同页前后两个有框的音之间等分（不在同一行时接在前一个后面）；纵向按与前一个音的音级差、本行谱线间距挪
    const omrPitch = new Map<string, number | null>();
    for (const part of sv?.song.parts ?? []) for (const m of part.measures) for (const el of m.elements) {
      if (el.kind === "chord" && this.staffIdOf.has(el.id)) omrPitch.set(this.staffIdOf.get(el.id)!, diatOf(el.notes[0]?.pitch));
    }
    const insertedByPage = new Map<number, StaffMark[]>();
    for (const it of inserted) {
      const pb = it.prev ? res.noteBoxes.get(it.prev) : undefined;
      const nb = it.next ? res.noteBoxes.get(it.next) : undefined;
      const ref = pb ?? nb;
      if (!ref) continue;
      const w = ref.box.right - ref.box.left;
      const hgt = ref.box.bottom - ref.box.top;
      const sameRow = pb && nb && pb.page === nb.page && Math.abs((pb.box.top + pb.box.bottom) / 2 - (nb.box.top + nb.box.bottom) / 2) < hgt * 6 && nb.box.left > pb.box.right;
      const count = inserted.filter((x) => x.prev === it.prev && x.next === it.next).length;
      const cx = sameRow ? pb!.box.right + ((nb!.box.left - pb!.box.right) * (it.nth + 1)) / (count + 1)
        : pb ? pb.box.right + w * (1.6 + it.nth * 1.4) : nb!.box.left - w * (1.6 + (count - 1 - it.nth) * 1.4);
      const refDiat = omrPitch.get((pb ? it.prev : it.next)!) ?? null;
      const k = res.pages[ref.page]?.scale ?? 1;
      const cyRef = (ref.box.top + ref.box.bottom) / 2;
      const st = (res.pages[ref.page]?.result.page.staves ?? []).find((s) => s.lineYs.length >= 5 && cyRef / k > s.lineYs[0]! - (s.lineYs[4]! - s.lineYs[0]!) && cyRef / k < s.lineYs[4]! + (s.lineYs[4]! - s.lineYs[0]!));
      const half = st ? ((st.lineYs[4]! - st.lineYs[0]!) / 8) * k : hgt / 2;
      const cy = it.diat !== null && refDiat !== null ? cyRef - (it.diat - refDiat) * half : cyRef;
      const list = insertedByPage.get(ref.page) ?? [];
      list.push({ id: "", elementId: it.id, box: { left: cx - w / 2, right: cx + w / 2, top: cy - hgt / 2, bottom: cy + hgt / 2 }, label: it.label, state: "inserted" });
      insertedByPage.set(ref.page, list);
    }
    // 小节线：识别出的每一小节的右端。按小节里最后一个音现在落在第几小节认；它与下一小节的第一个音落在同一小节 = 这条线删掉了（并小节）
    const boxKey = (pg: number, b: { left: number; top: number }): string => `${pg}:${Math.round(b.left)}:${Math.round(b.top)}`;
    const idAt = new Map<string, string>();
    for (const [id, b] of res.noteBoxes) idAt.set(boxKey(b.page, b.box), id);
    const measureOfSym = (pg: number, k: number, box: { left: number; top: number } | undefined): number | undefined => {
      const id = box ? idAt.get(boxKey(pg, { left: box.left * k, top: box.top * k })) ?? idAt.get(boxKey(pg, box)) : undefined;
      const ch = id ? chordOfOmr.get(id) : undefined;
      return ch === undefined ? undefined : measureOf.get(ch);
    };
    const barsByPage = new Map<number, StaffBarMark[]>();
    res.pages.forEach((pg, i) => {
      const k = pg.scale ?? 1;
      const out: StaffBarMark[] = [];
      for (const st of pg.result.page.staves) {
        if (st.lineYs.length < 5) continue;
        // 小节里的音按横坐标取最右 / 最左那个（`Bar.notes` 不按横坐标排）
        const edge = (bar: (typeof st.bars)[number] | undefined, right: boolean): { left: number; top: number } | undefined =>
          bar?.notes.reduce<(typeof bar.notes)[number] | undefined>((a, b) => (!a || (right ? b.box.left > a.box.left : b.box.left < a.box.left) ? b : a), undefined)?.box;
        st.bars.forEach((bar, bi) => {
          const last = measureOfSym(i, k, edge(bar, true));
          if (last === undefined) return;
          const nextFirst = measureOfSym(i, k, edge(st.bars[bi + 1], false));
          out.push({ x: bar.right * k, top: st.lineYs[0]! * k, bottom: st.lineYs[4]! * k, measure: nextFirst !== undefined && nextFirst === last ? null : last });
        });
      }
      barsByPage.set(i, out);
    });
    // 歌词字、弧、力度、文字：MusicXML 按元素上的 id 认（挪了跟着走），文本格式按宿主音的位置反查；与落地时的签名不同 = 改过
    const markNow = new Map<string, string>();
    this.staffMarkOf.clear();
    if (sv) {
      const xml = this.host.docFormat === "musicxml";
      for (const mk of staffMarksOf(sv, xml)) {
        const ids = xml ? mk.ids : (mk.key && base0?.marks.idsByKey.get(mk.key)) || (mk.alt && base0?.marks.idsByKey.get(mk.alt)) || [];
        for (const id of ids) if (!markNow.has(id)) markNow.set(id, mk.sig);
        if (!ids[0]) continue;
        // 跨行接上的弧：止端那半截另有 id。文本格式按位置反查得到的是 [起端, 止端] 两个
        const stopId = xml ? mk.stopId : ids[1];
        for (const k of [mk.entry, mk.alsoEntry]) if (k && !this.staffMarkOf.has(k)) this.staffMarkOf.set(k, { id: ids[0], ...(stopId ? { stopId } : {}) });
      }
    }
    const othersByPage = new Map<number, StaffSourceMark[]>();
    for (const [id, b] of res.markBoxes ?? []) {
      const was = base0?.marks.sig.get(id);
      const cur = markNow.get(id);
      // 落地时就没写出来的（接不上的半截弧、和弦里被并掉的）不画；没有落地样子（项目重开前）只画还在的
      if (was === undefined && (base0 || cur === undefined)) continue;
      const state = cur === undefined ? "deleted" as const : was !== undefined && was !== cur ? "edited" as const : undefined;
      const list = othersByPage.get(b.page) ?? [];
      list.push({ id, kind: b.kind, box: b.box, ...(state ? { state } : {}) });
      othersByPage.set(b.page, list);
    }
    const pages = res.pages;
    const view = this.view;
    this.host.renderPagesWith(pages.length, (i) => {
      const bin = pages[i]!.result.raster!.bin;
      const marks: StaffMark[] = [...res.noteBoxes].filter(([, b]) => b.page === i).map(([id, b]) => {
        const cur = now.get(id);
        return cur
          ? { id, box: b.box, label: cur.label, ...(cur.changed ? { state: "edited" as const } : {}) }
          : { id, box: b.box, label: b.rest ? t("omr.restLabel") : `${b.step}${b.octave}`, state: "deleted" as const };
      });
      const svg = renderStaffRecognitionPage(bin, [...marks, ...(insertedByPage.get(i) ?? [])], view, barsByPage.get(i) ?? [], othersByPage.get(i) ?? []);
      svg.dataset.page = String(i);
      return svg;
    }, {
      aspectRatio: (i) => `${pages[i]!.result.raster!.bin.w} / ${pages[i]!.result.raster!.bin.h}`,
      onPage: (svg) => this.wireStaffInteraction(svg),
      resetPageIndex: false,
    });
  }

  private wireStaffInteraction(svg: SVGSVGElement): void {
    // 悬停：指针下的命中框描橙（同简谱核对）
    let hovered: Element | null = null;
    svg.addEventListener("mousemove", (e) => {
      const r = e.target instanceof Element ? e.target.closest(".omr-hits rect") : null;
      if (r === hovered) return;
      hovered?.classList.remove("omr-hover");
      hovered = r;
      hovered?.classList.add("omr-hover");
    });
    svg.addEventListener("mouseleave", () => {
      hovered?.classList.remove("omr-hover");
      hovered = null;
    });
    svg.addEventListener("click", (e) => {
      const r = e.target instanceof Element ? e.target.closest<SVGRectElement>(".omr-hits rect") : null;
      const omrId = r?.getAttribute("data-omr");
      if (omrId && this.host.playbackActive()) {
        const id = [...this.staffIdOf].find(([, v]) => v === omrId)?.[0];
        if (id !== undefined) this.host.seekPlayback({ id, pass: 1 });
        return;
      }
      if (this.host.visualEnabled()) this.host.visualClick(e);
    });
    svg.addEventListener("dblclick", (e) => {
      if (this.host.visualEnabled()) this.host.visualDblClick(e);
    });
    // 右键谱行的空白处：改系统切分 / 忽略这一行 / 改归属（识谱软件在谱表上右键改结构的那一套）；点在命中框上照常弹编辑菜单
    svg.addEventListener("contextmenu", (e) => {
      if (e.target instanceof Element && e.target.closest(".omr-hits rect")) return;
      const at = this.staffRowAt(svg, e.clientX, e.clientY);
      if (!at) return;
      e.preventDefault();
      e.stopPropagation();
      this.showRowMenu(e.clientX, e.clientY, at);
    });
  }

  /** 点的位置落在哪个系统（全曲序）的第几行谱；系统总数一并给（菜单判能不能并下一个）。 */
  private staffRowAt(svg: SVGSVGElement, cx: number, cy: number): { si: number; ri: number; rows: number; nextSamePage: boolean } | null {
    const res = this.staffResult;
    const m = svg.getScreenCTM();
    if (!res?.score || !m) return null;
    const page = Number(svg.dataset.page ?? -1);
    const pg = res.pages[page];
    if (!pg) return null;
    const k = pg.scale ?? 1;
    const y = new DOMPoint(cx, cy).matrixTransform(m.inverse()).y / k;
    const st = pg.result.page.staves.find((s) => s.lineYs.length >= 5 && y > s.lineYs[0]! - (s.lineYs[4]! - s.lineYs[0]!) / 2 && y < s.lineYs[4]! + (s.lineYs[4]! - s.lineYs[0]!) / 2);
    if (!st) return null;
    const systems = res.score.systems;
    const si = systems.findIndex((e) => e.page === pg.result.page && e.sys.staves.includes(st));
    if (si < 0) return null;
    return { si, ri: systems[si]!.sys.staves.indexOf(st), rows: systems[si]!.sys.staves.length, nextSamePage: systems[si + 1]?.page === pg.result.page };
  }

  private showRowMenu(x: number, y: number, at: { si: number; ri: number; rows: number; nextSamePage: boolean }): void {
    document.querySelector(".omr-row-menu")?.remove();
    const menu = document.createElement("div");
    menu.className = "visual-menu omr-row-menu";
    menu.setAttribute("role", "menu");
    const close = (): void => {
      menu.remove();
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", away, true);
    };
    const away = (e: Event): void => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.target instanceof Node && menu.contains(e.target)) return;
      close();
    };
    const item = (label: string, enabled: boolean, run: () => void): void => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "visual-menu-item";
      b.textContent = label;
      b.disabled = !enabled;
      b.setAttribute("role", "menuitem");
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        close();
        run();
      });
      menu.appendChild(b);
    };
    item(t("omr.row.merge"), at.nextSamePage, () => void this.restructureStaff({ merge: at.si }));
    item(t("omr.row.split"), at.ri > 0, () => void this.restructureStaff({ split: { system: at.si, row: at.ri } }));
    item(t("omr.row.ignore"), true, () => {
      const res = this.staffResult;
      if (!res) return;
      const slots = res.assignment().map((r) => [...r]);
      if (slots[at.si]) slots[at.si]![at.ri] = -1;
      void this.rebuildStaff(slots);
    });
    item(t("omr.row.assign"), true, () => document.getElementById("btn-parts")?.click());
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", away, true);
  }

  /** 五线谱对照：和弦所在那行谱表的竖向范围（插入光标照它画）。 */
  private staffBand(id: ElementId, el: SVGGraphicsElement): { svg: SVGSVGElement; y: number; h: number } | null {
    const res = this.staffResult;
    const omrId = this.staffIdOf.get(id);
    const nb = omrId ? res?.noteBoxes.get(omrId) : undefined;
    const svg = el.ownerSVGElement;
    if (!res || !nb || !svg) return null;
    // 矢量 PDF 的谱线坐标是点、底图放大过（`scale`），先换回点再比
    const k = res.pages[nb.page]?.scale ?? 1;
    const cy = (nb.box.top + nb.box.bottom) / 2 / k;
    const staves = res.pages[nb.page]?.result.page.staves ?? [];
    const st = staves.find((s) => s.lineYs.length >= 5 && cy > s.lineYs[0]! - (s.lineYs[4]! - s.lineYs[0]!) && cy < s.lineYs[4]! + (s.lineYs[4]! - s.lineYs[0]!));
    if (!st) return null;
    const sp = (st.lineYs[4]! - st.lineYs[0]!) / 4;
    return { svg, y: (st.lineYs[0]! - sp * 2) * k, h: sp * 8 * k };
  }

  get hasStaffResult(): boolean {
    return this.staffResult !== null;
  }

  /** 关联表要显示的：各系统（第几页）各谱行现在指派到第几个声部行。没有位图五线谱结果为 null */
  staffAssignment(): { systems: { page: number }[]; slots: number[][] } | null {
    const res = this.staffResult;
    if (!res?.score) return null;
    const pageOf = new Map(res.pages.map((p, i) => [p.result.page, i]));
    return { systems: res.score.systems.map((e) => ({ page: pageOf.get(e.page) ?? 0 })), slots: res.assignment() };
  }

  /**
   * 按新的「谱表 ↔ 声部」指派重建 MusicXML，不重跑识别。手改过的按识别 id 回放到重建后的谱上（`captureStaffEdits`）；
   * 有回放不了的（新插的音、小节结构改动）先问一声。
   */
  async rebuildStaff(slots: number[][]): Promise<boolean> {
    const res = this.staffResult;
    if (!res) return false;
    return this.rebuildStaffWith(() => res.rebuild(slots));
  }

  /** 改系统切分（识谱软件「与下一系统合并 / 从这一行拆开」）后重建，不重跑识别；手改照上回放。 */
  async restructureStaff(op: SystemOp): Promise<boolean> {
    const res = this.staffResult;
    if (!res?.restructure) return false;
    return this.rebuildStaffWith(() => {
      const r = res.restructure!(op);
      if (!r) throw new Error(t("omr.restructureNo"));
      return r;
    });
  }

  private async rebuildStaffWith(make: () => { xml: string; score: NonNullable<import("../staffomr/review").StaffReviewResult["score"]> }): Promise<boolean> {
    const edits = await this.captureStaffEdits();
    if (edits && edits.lost > 0 && !(await confirmDiscardEdits())) return false;
    const inRecognize = this.host.mode === "recognize";
    let xml: string;
    try {
      const r = make();
      xml = r.xml;
      // 系统、谱行的结构跟着换（关联表、右键谱行按它认系统）
      if (this.staffResult) this.staffResult.score = r.score;
    } catch (e) {
      this.host.setStatus(t("omr.rebuildFailed", { error: e instanceof Error ? e.message : String(e) }));
      return false;
    }
    const base = xml;
    const replay = edits && edits.chords.size + edits.deleted.size ? await this.replayStaffEdits(xml, edits) : null;
    if (replay) xml = replay.xml;
    const format = this.host.formats.source?.current();
    this.host.adoptStaffXml(xml, true);
    // 「改过」照重建出来的样子比（回放上去的手改照样标改过）
    this.staffEmitted = base;
    this.staffBase = null;
    // 原来在文本格式里改：重建完切回那种格式（识别 id 照拍点、音高带过去）
    if (format && format !== "musicxml") {
      await this.host.formats.source?.switchTo(format);
      this.host.formats.sync();
    }
    if (inRecognize && (this.host.mode as string) !== "recognize") await this.toggle();
    this.host.setStatus(replay ? t("omr.rebuiltReplayed", { n: replay.replayed, lost: replay.missed + (edits?.lost ?? 0) }) : t("omr.rebuilt"));
    return true;
  }

  /** 识别（或上次重建）落地之后的手改：按识别 id 记下改过的和弦（音高、休止、时值、连音、倚音、歌词）与删掉的；`lost` 是回放不了的处数（新插的音、记下的回放不出现在的谱）。 */
  private async captureStaffEdits(): Promise<StaffEdits | null> {
    if (this.staffEmitted === null || this.host.getText() === this.staffEmitted || this.host.formats.source?.pristineOf?.(this.staffEmitted)) return null;
    const { loadScoreDoc } = await import("../model/fromxml");
    const base = this.staffBaseSig(loadScoreDoc);
    const doc = this.host.currentScoreDoc();
    const sv = this.staffViewOf(doc);
    if (!base || !doc || !sv) return { chords: new Map(), deleted: new Set(), lost: 1 };
    const out: StaffEdits = { chords: new Map(), deleted: new Set(), lost: 0 };
    const seen = new Set<string>();
    // 没有识别 id 的音：重建自己补的占位休止也没有，比识别落地时多出来的才是手插的
    let noId = 0;
    for (const part of sv.song.parts) {
      for (const m of part.measures) for (const el of m.elements) {
        if (el.kind !== "chord") continue;
        const ids = sv.idsOf(el);
        const id = ids.find((x) => x);
        if (!id || !base.has(id)) {
          if (!el.grace && !ids.includes(COVERED)) noId++;
          continue;
        }
        seen.add(id);
        if (base.get(id) === chordSig(el)) continue;
        out.chords.set(id, {
          rest: !!el.rest, pitches: el.notes.map((n) => n.pitch).filter((p): p is NonNullable<typeof p> => !!p),
          type: el.duration.type, dots: el.duration.dots, ...(el.duration.timeMod ? { timeMod: { ...el.duration.timeMod } } : {}),
          grace: !!el.grace, lyrics: el.lyrics?.map((l) => ({ ...l })) ?? [],
        });
      }
    }
    for (const id of base.keys()) if (!seen.has(id)) out.deleted.add(id);
    out.lost += Math.max(0, noId - (this.staffBase?.noId ?? 0));
    // 记下的只有各音自己的改动；连线、力度文字、和弦名、奏法、调号谱号、小节线、小节增删都不在里面。
    // 把记下的回放到识别落地时那份上，与现在的谱按语义比：对不上就是有回放不了的改动，重建前要问
    const replayedBase = await this.replayStaffEdits(this.staffEmitted, out);
    // 文本格式：回放出来的那份也过一遍同一种格式再比（两边同一口径）
    const replayedNow = this.host.docFormat === "musicxml" ? replayedBase.doc : this.host.viaCurrentFormat(replayedBase.doc);
    if (!replayedNow || semanticSig(replayedNow) !== semanticSig(doc)) out.lost++;
    return out;
  }

  /** 把记下的手改按识别 id 放回重建出来的谱上；对不上的（那一行谱忽略掉了）算没回放上。 */
  private async replayStaffEdits(xml: string, edits: StaffEdits): Promise<{ xml: string; doc: ScoreDoc; replayed: number; missed: number }> {
    const { dropEmbeddedLayout } = await import("../model/xmlsurface");
    const { loadScoreDoc } = await import("../model/fromxml");
    const { scoreDocToMusicXml } = await import("../model/toxml");
    const doc = loadScoreDoc(xml);
    const song = doc.songs[0];
    if (!song) return { xml, doc, replayed: 0, missed: edits.chords.size + edits.deleted.size };
    const QUARTERS: Record<string, number> = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25, "32nd": 0.125, "64th": 0.0625 };
    let replayed = 0;
    const found = new Set<string>();
    const gone: ElementId[] = [];
    for (const part of song.parts) {
      for (const [mi, m] of part.measures.entries()) {
        for (const el of m.elements) {
          if (el.kind !== "chord") continue;
          // 记下的按和弦里哪个音的 id 都认（文本格式里和音的音序与 MusicXML 的不同，记的未必是第一个音的）
          const all = surfaceIds(el).filter((x): x is string => !!x);
          const id = all.find((x) => edits.deleted.has(x) || edits.chords.has(x));
          if (!id) continue;
          if (edits.deleted.has(id)) {
            gone.push(el.id);
            found.add(id);
            continue;
          }
          const snap = edits.chords.get(id);
          if (!snap) continue;
          found.add(id);
          if (snap.rest) {
            el.notes = [];
            el.rest = {};
          } else if (snap.pitches.length) {
            el.notes = snap.pitches.map((p, k) => ({ ...(el.notes[k] ?? {}), pitch: { ...p } }));
            delete el.rest;
          }
          const tm = snap.timeMod;
          const tmSame = (tm?.actual ?? 1) === (el.duration.timeMod?.actual ?? 1) && (tm?.normal ?? 1) === (el.duration.timeMod?.normal ?? 1);
          if (snap.type && (snap.type !== el.duration.type || snap.dots !== el.duration.dots || !tmSame) && QUARTERS[snap.type]) {
            const { dpq } = measureCtx(song, part, mi);
            const div = (QUARTERS[snap.type]! * dpq * (2 - Math.pow(0.5, snap.dots)) * (tm?.normal ?? 1)) / (tm?.actual ?? 1);
            if (Number.isInteger(div)) {
              el.duration = { ...el.duration, divisions: div, type: snap.type, dots: snap.dots };
              if (tm) el.duration.timeMod = { ...tm };
              else delete el.duration.timeMod;
            }
          }
          if (snap.grace && !el.grace) el.grace = snap.type === "eighth" ? { slash: true } : {};
          if (!snap.grace) delete el.grace;
          // 歌词照记下的整份放回（空 = 删掉了）
          if (snap.lyrics.length) el.lyrics = snap.lyrics.map((l) => ({ ...l }));
          else delete el.lyrics;
          respellMeasure(m, measureCtx(song, part, mi).key);
          replayed++;
        }
      }
    }
    if (gone.length) deleteChords(doc, gone);
    replayed += gone.length;
    dropEmbeddedLayout(song);
    const missed = [...edits.chords.keys(), ...edits.deleted].filter((id) => !found.has(id)).length;
    return { xml: scoreDocToMusicXml(doc), doc, replayed, missed };
  }

  /** 位图五线谱识别（或上次重建）刚落地时的原文：与当前原文不同即手改过 */
  private staffEmitted: string | null = null;

  /** 这份结果有没有点选映射（123 / 文本谱 / Muse `.jcx` 产物有，`.jpwabc` / ABC 没有）。 */
  get hasMeta(): boolean {
    return this.meta !== null;
  }

  /** 索引条目 → 核对视图上的命中框：音符按框序（新插的按元素 id）、歌词按框序与段、页眉另认（`headerHits`）。 */
  /** 五线谱对照：歌词字、弧、力度、文字的索引条目 → 源图上它的命中框（没有识别框的、不是五线谱会话的为 null） */
  staffMarkHit(entry: SyncEntry): SVGGraphicsElement | null {
    if (!this.staffResult) return null;
    const key = markEntryKey(entry);
    const hit = key ? this.staffMarkOf.get(key) : undefined;
    if (!hit) return null;
    // 弧的 `)` 那一端（成对条目里靠后的那条）对止端那半截的框
    const id = hit.stopId && entry.pair && entry.pair.from < entry.from ? hit.stopId : hit.id;
    return document.getElementById("score-pane")?.querySelector<SVGRectElement>(`.omr-hits rect[data-omr="${id}"]`) ?? null;
  }

  /** 五线谱对照：和弦里每个音的命中框（`hitFor` 只给第一个音的）；不是五线谱会话返回 null */
  chordHits(id: ElementId): SVGGraphicsElement[] | null {
    if (!this.staffResult) return null;
    const pane = document.getElementById("score-pane");
    const ids = [...this.staffNoteOfOmr].filter(([, v]) => v.chord === id).map(([k]) => k);
    const els = ids.flatMap((o) => [...(pane?.querySelectorAll<SVGRectElement>(`.omr-hits rect[data-omr="${o}"]`) ?? [])]);
    const ins = pane?.querySelector<SVGRectElement>(`.omr-hits rect[data-kind="note"][data-id="${id}"]`);
    return ins ? [...els, ins] : els;
  }

  /** `verse`：歌词是第几段；和弦名是这个音的第几个和弦（`reproject.ts::harmonyPlacesOf` 的序），按它的落点对回源图的框。 */
  hitFor(kind: "note" | "lyric" | "chord", id: ElementId, verse = 0): SVGGraphicsElement | null {
    const pane = document.getElementById("score-pane");
    if (this.staffResult) {
      if (kind !== "note") return null;
      const omrId = this.staffIdOf.get(id);
      return omrId ? pane?.querySelector<SVGRectElement>(`.omr-hits rect[data-omr="${omrId}"]`) ?? null
        : pane?.querySelector<SVGRectElement>(`.omr-hits rect[data-kind="note"][data-id="${id}"]`) ?? null;
    }
    const doc = this.host.currentScoreDoc();
    const i = this.idMapOf(doc)?.toI.get(id);
    if (kind === "lyric") {
      return i === undefined ? null : pane?.querySelector<SVGRectElement>(`.omr-hits rect[data-kind="lyric"][data-i="${i}"][data-verse="${verse}"]`) ?? null;
    }
    if (kind === "chord") {
      const ch = doc ? locate(doc, id)?.chord : undefined;
      const place = ch ? harmonyPlacesOf(ch)[verse]?.place : undefined;
      if (place === undefined) return null;
      // 源图上有框的按框序认，核对时新加的（`chordAdds`）按元素 id 认
      return (i === undefined ? null : pane?.querySelector<SVGRectElement>(`.omr-hits rect[data-kind="chord"][data-i="${i}"][data-slot="${place}"]`)) ??
        pane?.querySelector<SVGRectElement>(`.omr-hits rect[data-kind="chord"][data-id="${id}"][data-slot="${place}"]`) ?? null;
    }
    if (i !== undefined) return pane?.querySelector<SVGRectElement>(`.omr-hits rect[data-kind="note"][data-i="${i}"]`) ?? null;
    return pane?.querySelector<SVGRectElement>(`.omr-hits rect[data-kind="note"][data-id="${id}"]`) ?? null;
  }

  /**
   * Alt+点原图（识别核对）：点的位置落在哪两个识别出的音之间（同一行谱表 / 同一行简谱），五线谱另按与最近那个音的纵向距离、
   * 本行谱线间距推出音高（参照音现在的音高，谱号调号就都算进去了）。不在核对视图、点在谱行外为 null。
   */
  sourcePoint(ev: MouseEvent): { after: ElementId | null; before: ElementId | null; pitch?: { step: "A" | "B" | "C" | "D" | "E" | "F" | "G"; octave: number } } | null {
    if (this.host.mode !== "recognize") return null;
    const svg = ev.target instanceof Element ? ev.target.closest<SVGSVGElement>("svg.omr-recognize") : null;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return null;
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    const res = this.staffResult;
    if (res) {
      const page = Number(svg.dataset.page ?? -1);
      const k = res.pages[page]?.scale ?? 1;
      const st = (res.pages[page]?.result.page.staves ?? []).find((s) => s.lineYs.length >= 5 &&
        p.y / k > s.lineYs[0]! - (s.lineYs[4]! - s.lineYs[0]!) / 2 && p.y / k < s.lineYs[4]! + (s.lineYs[4]! - s.lineYs[0]!) / 2);
      if (!st) return null;
      const half = ((st.lineYs[4]! - st.lineYs[0]!) / 8) * k;
      const top = (st.lineYs[0]! - half * 6 / k) * k;
      const bottom = (st.lineYs[4]! + half * 6 / k) * k;
      const doc = this.host.currentScoreDoc();
      const cands = [...res.noteBoxes].filter(([id, b]) => b.page === page && this.staffNoteOfOmr.has(id) && (b.box.top + b.box.bottom) / 2 > top && (b.box.top + b.box.bottom) / 2 < bottom)
        .map(([id, b]) => ({ id, b, cx: (b.box.left + b.box.right) / 2, cy: (b.box.top + b.box.bottom) / 2, ...this.staffNoteOfOmr.get(id)! }));
      const left = cands.filter((c) => c.cx < p.x).sort((a, b) => b.cx - a.cx)[0];
      const right = cands.filter((c) => c.cx >= p.x).sort((a, b) => a.cx - b.cx)[0];
      // 参照音高：横向最近、有音高的那个
      const DIAT = "CDEFGAB";
      let pitch: { step: "A" | "B" | "C" | "D" | "E" | "F" | "G"; octave: number } | undefined;
      for (const c of [...cands].sort((a, b) => Math.abs(a.cx - p.x) - Math.abs(b.cx - p.x))) {
        const ref = doc ? pitchAt(doc, c.chord, c.k) : undefined;
        if (!ref) continue;
        const d = ref.octave * 7 + DIAT.indexOf(ref.step) + Math.round((c.cy - p.y) / half);
        pitch = { step: DIAT[((d % 7) + 7) % 7] as "C", octave: Math.floor(d / 7) };
        break;
      }
      if (!left && !right) return null;
      return { after: left?.chord ?? null, before: right?.chord ?? null, ...(pitch ? { pitch } : {}) };
    }
    const score = this.shown?.score ?? this.score;
    const map = this.idMapOf(this.host.currentScoreDoc());
    if (!score || !map) return null;
    let i0 = 0;
    for (const row of score.rows) {
      const n = row.nums.length;
      if (p.y >= row.topY && p.y <= row.bottomY) {
        const ids = row.nums.map((num, j) => ({ cx: num.bbox.x + num.bbox.w / 2, id: map.toId[i0 + j] })).filter((x): x is { cx: number; id: ElementId } => x.id !== undefined);
        const left = ids.filter((x) => x.cx < p.x).sort((a, b) => b.cx - a.cx)[0];
        const right = ids.filter((x) => x.cx >= p.x).sort((a, b) => a.cx - b.cx)[0];
        return left || right ? { after: left?.id ?? null, before: right?.id ?? null } : null;
      }
      i0 += n;
    }
    return null;
  }

  /** 五线谱对照：第 `mi` 小节收尾那条小节线的命中框（几个谱表各一条，取第一条）。 */
  barlineHit(mi: number): SVGGraphicsElement | null {
    if (!this.staffResult) return null;
    return document.getElementById("score-pane")?.querySelector<SVGRectElement>(`.omr-hits rect[data-kind="barline"][data-measure="${mi}"]`) ?? null;
  }

  /** 页眉命中框（标题、著作者），按字对上索引里的页眉条目（同 `App._bindHeader`）。 */
  headerHits(): { el: SVGGraphicsElement; text: string; role: "text" }[] {
    const pane = document.getElementById("score-pane");
    const out: { el: SVGGraphicsElement; text: string; role: "text" }[] = [];
    for (const r of pane?.querySelectorAll<SVGRectElement>('.omr-hits rect[data-kind="title"], .omr-hits rect[data-kind="author"]') ?? []) {
      const text = r.getAttribute("data-kind") === "title" ? (this.score?.title ?? "") : (r.getAttribute("data-text") ?? "");
      out.push({ el: r, text, role: "text" });
    }
    return out;
  }

  /** 元素所在谱行的竖向范围（源图像素 = 核对 SVG 的用户坐标）：插入光标照这一行的高度画。 */
  rowBand(id: ElementId): { svg: SVGSVGElement; y: number; h: number } | null {
    const score = this.score;
    const el = this.hitFor("note", id);
    if (this.staffResult) return el ? this.staffBand(id, el) : null;
    const svg = el?.ownerSVGElement;
    if (!score || !el || !svg) return null;
    const i = this.idMapOf(this.host.currentScoreDoc())?.toI.get(id);
    const row = i !== undefined ? score.rows[this.rowIndexOfFlat(i)] : this.shown?.inserted.find((x) => x.id === id) && score.rows[this.shown.inserted.find((x) => x.id === id)!.row];
    if (!row) return null;
    const pad = (row.bottomY - row.topY) * 0.15;
    return { svg, y: row.topY - pad, h: row.bottomY - row.topY + pad * 2 };
  }

  /** 识别 SVG 交互：点选命中对象→选中对应代码；悬停高亮；floating 视图弹行/页眉浮窗。 */
  private wireInteraction(svg: SVGSVGElement, wrap: HTMLDivElement): void {
    const hitOf = (t: EventTarget | null): SVGRectElement | null =>
      (t instanceof Element ? t.closest(".omr-hits rect") : null) as SVGRectElement | null;

    let hovered: SVGRectElement | null = null;
    const setHover = (r: SVGRectElement | null): void => {
      if (hovered === r) return;
      hovered?.classList.remove("omr-hover");
      hovered = r;
      hovered?.classList.add("omr-hover");
    };

    svg.addEventListener("click", (e) => {
      // 能编辑：点选交给可视化编辑（选中、落光标、拍数红框透过）；播放中点音符仍让给跳播
      if (this.host.visualEnabled()) {
        const r0 = hitOf(e.target);
        const i0 = r0?.getAttribute("data-kind") === "note" ? r0.getAttribute("data-i") : null;
        if (i0 !== null && i0 !== undefined && this.host.playbackActive()) {
          const id = this.idOfNote(Number(i0));
          if (id !== undefined) this.host.seekPlayback({ id, pass: 1 });
          return;
        }
        this.host.visualClick(e);
        return;
      }
      const r = hitOf(e.target);
      if (!r) return;
      const range = this.rangeOfHit(r);
      if (range) this.selectCode(range);
      svg.querySelectorAll(".omr-hits rect.selected").forEach((x) => x.classList.remove("selected"));
      r.classList.add("selected");
      if (r.getAttribute("data-kind") === "note") {
        const id = this.idOfNote(Number(r.getAttribute("data-i")));
        if (id !== undefined) this.host.seekPlayback({ id, pass: 1 });
      }
    });

    svg.addEventListener("dblclick", (e) => {
      if (this.host.visualEnabled()) this.host.visualDblClick(e);
    });
    svg.addEventListener("mousemove", (e) => {
      const r = hitOf(e.target);
      setHover(r);
      if (this.view === "floating") this.updateFloatingPopup(r, wrap);
    });
    svg.addEventListener("mouseleave", () => {
      setHover(null);
      if (this.view === "floating") this.hidePopup();
    });
  }

  // ---------------- 试听高亮 ----------------
  /**
   * 元素 id ↔ 识别框序（`data-i`）。两层：
   * - **id ↔ meta 序**靠源区间：`meta.noteRanges[k].from`（随编辑经 CodeMirror 变更迁移）对元素的 `source.offset`，
   *   所以在识别模式下改了文本也对得上；对不上的按 `omr/meta.ts::elementMeta` 同样的遍历序号兜底（未编辑时两者一致）。
   * - **meta 序 → 框序**见 `flatOrder`：多声部时两者不同。
   * 没有 meta（`.jpwabc` / ABC 产物）返回 null：只播不高亮。
   */
  private idMapOf(doc: ScoreDoc | null): { toI: Map<ElementId, number>; toId: ElementId[] } | null {
    const meta = this.meta;
    if (!doc || !meta || !this.score) return null;
    if (this.idMap?.doc === doc && this.idMap.meta === meta) return this.idMap;
    const toFlat = flatOrder(this.score);
    const byFrom = new Map<number, number>();
    meta.noteRanges.forEach((r, k) => { if (r.to > r.from && !byFrom.has(r.from)) byFrom.set(r.from, k); });
    const toI = new Map<ElementId, number>();
    const toId: ElementId[] = [];
    let seq = 0;
    for (const part of doc.songs[0]?.parts ?? []) {
      for (const m of part.measures) {
        for (const el of m.elements) {
          if (el.kind === "chord" && el.grace) continue;
          if (el.kind === "space" && el.spacer === "y") continue;
          const k = el.source && el.source.length > 0 ? byFrom.get(el.source.offset) : undefined;
          const i = toFlat[k ?? seq];
          seq++;
          if (i === undefined || toId[i] !== undefined) continue;
          toI.set(el.id, i);
          toId[i] = el.id;
        }
      }
    }
    this.idMap = { doc, meta, toI, toId };
    return this.idMap;
  }

  private idOfNote(i: number): ElementId | undefined {
    return this.idMapOf(this.host.currentScoreDoc())?.toId[i];
  }

  /** 框序 → meta 序（点选定位查 `noteRanges` / `lyricRanges` 用）。 */
  private metaIndex(i: number): number {
    if (!this.score) return i;
    const k = flatOrder(this.score).indexOf(i);
    return k < 0 ? i : k;
  }

  /**
   * 播到某个元素：同五线谱（`layout/playhead.ts`），放一条竖直播放线——横向取这个音的识别框，
   * 纵向贯穿它所在的系统（多声部是连谱号括起的几行，连同夹在中间的歌词带；单声部就是这一行）。null = 撤掉。
   * 这份谱里对不上框的音（没有 meta 的格式）不挪，留在上一处。
   */
  highlightPlaying(id: ElementId | null): void {
    if (this.staffResult) {
      // 五线谱对照：发声的那个音的框加亮
      document.querySelectorAll("#score-pane .omr-hits rect.omr-playing").forEach((r) => r.classList.remove("omr-playing"));
      const el = id === null ? null : this.hitFor("note", id);
      el?.classList.add("omr-playing");
      el?.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    if (id === null) {
      this.playingEl?.remove();
      this.playingEl = null;
      return;
    }
    const score = this.score;
    const i = score ? this.idMapOf(this.host.currentScoreDoc())?.toI.get(id) : undefined;
    const box = i === undefined ? null : document.querySelector<SVGRectElement>(`#score-pane .omr-hits rect[data-kind="note"][data-i="${i}"]`);
    const svg = box?.ownerSVGElement;
    if (!score || i === undefined || !box || !svg) return;
    const row = score.rows[this.rowIndexOfFlat(i)]!;
    const sys = row.system === undefined ? [row] : score.rows.filter((r) => r.system === row.system);
    const pad = (row.bottomY - row.topY) * 0.25;
    const bx = Number(box.getAttribute("x"));
    const bw = Number(box.getAttribute("width"));
    const y0 = Math.min(...sys.map((r) => r.topY)) - pad;
    const y1 = Math.max(...sys.map((r) => r.bottomY)) + pad;
    let line = this.playingEl;
    if (!line) {
      line = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      line.setAttribute("class", "omr-playhead");
      this.playingEl = line;
    }
    line.setAttribute("rx", String(Math.round(pad / 2)));
    line.setAttribute("x", String(bx - pad));
    line.setAttribute("width", String(bw + pad * 2));
    line.setAttribute("y", String(y0));
    line.setAttribute("height", String(y1 - y0));
    if (line.ownerSVGElement !== svg) svg.appendChild(line);
    line.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** 命中 rect → 编辑器代码区间（据 data-kind 查 meta）。 */
  private rangeOfHit(r: SVGRectElement): { from: number; to: number } | null {
    const meta = this.meta;
    if (!meta) return null;
    const kind = r.getAttribute("data-kind");
    if (kind === "note") {
      return meta.noteRanges[this.metaIndex(Number(r.getAttribute("data-i")))] ?? null;
    }
    if (kind === "lyric") {
      const v = Number(r.getAttribute("data-verse"));
      return meta.lyricRanges[this.metaIndex(Number(r.getAttribute("data-i")))]?.get(v) ?? null;
    }
    if (kind === "title") return meta.titleRange ?? null;
    if (kind === "author") {
      const text = (r.getAttribute("data-text") ?? "").trim();
      const a = meta.authorRanges.find((x) => x.text.trim() === text)
        ?? meta.authorRanges.find((x) => text.includes(x.text.trim()) || x.text.trim().includes(text));
      return a?.range ?? null;
    }
    return null;
  }

  /** 选中并滚动到编辑器里的代码区间。 */
  private selectCode(range: { from: number; to: number }): void {
    const view = this.host.view;
    const len = view.state.doc.length;
    const from = Math.max(0, Math.min(range.from, len));
    const to = Math.max(from, Math.min(range.to, len));
    view.dispatch({
      selection: EditorSelection.single(from, to),
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    view.focus();
  }

  /** floating 视图：悬停对象所在行→在该行相邻固定位置弹整行浮窗；页眉命中→弹整块页眉。 */
  private updateFloatingPopup(r: SVGRectElement | null, wrap: HTMLDivElement): void {
    if (!this.bin || !this.score) { this.hidePopup(); return; }
    // 停在音符/歌词间隙（无命中）时保持当前浮窗，不隐藏——否则同 system 内移动光标会反复隐现闪烁。
    // 真正离开谱面由 svg 的 mouseleave 负责隐藏。
    if (!r) return;
    const bin = this.bin, score = this.score;
    const kind = r.getAttribute("data-kind");
    let key: string;
    let r2: { svg: SVGSVGElement; srcTop: number; srcBottom: number };
    if (kind === "title" || kind === "author") {
      key = "header";
      r2 = renderHeaderPopup(bin, score);
    } else {
      const i = Number(r.getAttribute("data-i"));
      const id = r.getAttribute("data-id");
      const ri = id !== null ? (this.shown?.inserted.find((x) => String(x.id) === id)?.row ?? 0) : this.rowIndexOfFlat(i);
      key = "row" + ri;
      r2 = renderRowPopup(bin, this.shown?.score ?? score, ri, this.shown ?? undefined);
    }
    // 同一行/页眉不重复重建（改过谱就换一份 key，重画）
    key += `@${this.renderSeq}`;
    if (this.popupEl?.dataset.key !== key) {
      this.showPopup(r2.svg, key, wrap, bin, r2.srcTop, r2.srcBottom);
    }
  }

  private showPopup(content: SVGSVGElement, key: string, wrap: HTMLDivElement, bin: Binary, srcTop: number, srcBottom: number): void {
    let el = this.popupEl;
    if (!el) {
      el = document.createElement("div");
      el.className = "omr-popup";
      wrap.appendChild(el);
      this.popupEl = el;
    }
    el.dataset.key = key;
    el.replaceChildren(content);
    el.style.display = "block";
    // 定位到**当前 system 之下**（srcBottom 已含本行歌词带底，故浮窗不盖当前行歌词）；
    // 靠近底部则翻到当前行之上。浮窗整幅宽、列与源图对齐，便于逐音对比。
    const topPct = (srcBottom / bin.h) * 100;
    const botPct = (srcTop / bin.h) * 100;
    if (topPct < 82) {
      el.style.top = `${topPct}%`;
      el.style.bottom = "auto";
    } else {
      el.style.bottom = `${100 - botPct}%`;
      el.style.top = "auto";
    }
  }

  private hidePopup(): void {
    if (this.popupEl) { this.popupEl.style.display = "none"; delete this.popupEl.dataset.key; }
  }

  /** flatten 音符下标 → 所属行下标。 */
  private rowIndexOfFlat(i: number): number {
    if (!this.score) return 0;
    let acc = 0;
    for (let ri = 0; ri < this.score.rows.length; ri++) {
      const n = this.score.rows[ri].nums.length;
      if (i < acc + n) return ri;
      acc += n;
    }
    return this.score.rows.length - 1;
  }

  /** 清掉本次 OMR 的识别叠加产物并禁用识别按钮；若正处识别模式则退回简谱模式。 */
  clear(): void {
    this.gen++;
    this.fromProject = false;
    this.bin = null;
    this.score = null;
    this.beatMarks = [];
    this.meta = null;
    this.idMap = null;
    this.playingEl = null;
    this.emitted = null;
    this.staffEmitted = null;
    this.staffLinks = null;
    this.staffLoadFailed = false;
    if (this.host.formats.source === this) this.host.formats.use(null);
    this.hidePopup();
    if (this.btnEl) this.btnEl.textContent = t("omr.compare");
    this.host.setContextControl(this.btnEl, false);
    this.host.setContextControl(this.followBtn, false);
    this.host.setContextControl(this.pagesBtn, false);
    this.host.setContextControl(this.sideBtn, false);
    this.sideKey = null;
    this.doubtAt = -1;
    this.syncDoubtEl(0);
    this.host.setContextControl(this.kindField(), false);
    this.staffResult = null;
    this.sessionKind = null;
    this.followSelection(null);
    if (this.host.mode === "recognize") {
      this.host.setRecognizeMode(false);
      this.setLayout(false);
    }
    this.host.syncViewModes();
    this.syncSide(null);
  }
}

/** 重建前记下的手改（按识别 id）：`chords` 改过的和弦、`deleted` 删掉的、`lost` 回放不了的处数 */
interface StaffEdits {
  chords: Map<string, {
    rest: boolean; pitches: { step: "A" | "B" | "C" | "D" | "E" | "F" | "G"; alter: number; octave: number }[];
    type?: Chord["duration"]["type"]; dots: number; timeMod?: Chord["duration"]["timeMod"]; grace: boolean; lyrics: NonNullable<Chord["lyrics"]>;
  }>;
  deleted: Set<string>;
  lost: number;
}

/**
 * 整份谱的语义签名（不看版面坐标、符干、临时记号印不印）：各声部各小节的调号拍号谱号、小节线、记号文字、每个和弦（`chordSig` + 声线谱表、
 * 奏法装饰、和弦名、延音线），以及跨音记号（按「第几声部第几小节第几个元素」认端点）。重建前判手改能不能全回放用。
 */
function semanticSig(doc: ScoreDoc): string {
  const song = doc.songs[0];
  if (!song) return "";
  const where = new Map<ElementId, string>();
  const parts = song.parts.map((p, pi) => p.measures.map((m, mi) => {
    m.elements.forEach((e, i) => where.set(e.id, `${pi}.${mi}.${i}`));
    const a = m.attrs;
    return {
      attrs: a ? [a.key?.fifths, a.time && `${a.time.beats}/${a.time.beatType}`, (a.clefs ?? []).map((c) => `${c.sign}${c.line ?? ""}${c.octaveChange ?? ""}@${c.staff ?? 1}`).join(",")] : null,
      later: (m.laterAttrs ?? []).map((la) => [la.afterElements, la.attrs.key?.fifths, (la.attrs.clefs ?? []).map((c) => `${c.sign}${c.line ?? ""}`).join(",")]),
      bars: (m.barlines ?? []).map((b) => [b.location, b.style ?? "", b.repeat ?? "", b.ending ? `${b.ending.numbers.join(",")}${b.ending.type}` : ""]).sort(),
      dirs: (m.directions ?? []).map((d) => [d.type, d.text ?? "", d.spanType ?? "", d.wedgeType ?? "", d.afterElements ?? 0, d.staff ?? 1, d.tempo?.perMinute ?? ""].join("|")).sort(),
      els: m.elements.map((e) => e.kind !== "chord" ? e.kind
        : [chordSig(e), e.voice, e.staff, JSON.stringify(e.notations ?? {}), e.harmony?.text ?? (e.harmony ? `${e.harmony.root.step}${e.harmony.root.alter}${e.harmony.kind}` : ""),
          e.notes.map((n) => `${n.tie?.start ? "s" : ""}${n.tie?.stop ? "e" : ""}`).join(",")].join("|")),
    };
  }));
  const marks = song.marks.map((mk) => `${mk.type}:${where.get(mk.start)}-${where.get(mk.end)}`).sort();
  return JSON.stringify({ parts, marks });
}

/** 识别落地时歌词字、弧、力度、文字的样子：识别 id → 签名；位置（`StaffMarkNow.key`）→ 识别 id（文本格式按它反查） */
interface StaffMarkBase {
  sig: Map<string, string>;
  idsByKey: Map<string, string[]>;
}

/** `chordSig` 去掉歌词那一段：歌词有自己的框（`staffMarksOf`），改字只标那个字，不再把音标成改过 */
const soundSig = (sig: string): string => sig.split("/").slice(0, 4).join("/");

/** 一个和弦在对照视图里算不算「改过」的签名：音高（各音）、休止、时值、附点、连音、倚音、各段歌词。 */
function chordSig(c: Chord): string {
  // 各音按音高排：123 的和音自下而上写，读回的音序与 MusicXML 的不同
  const ps = c.rest ? "r" : c.notes.map((n) => (n.pitch ? `${n.pitch.step}${n.pitch.alter}${n.pitch.octave}` : "?")).sort().join(",");
  const tm = c.duration.timeMod ? `${c.duration.timeMod.actual}:${c.duration.timeMod.normal}` : "";
  const ly = (c.lyrics ?? []).map((l) => `${l.number}:${l.text}`).join(",");
  return `${ps}/${c.duration.type ?? ""}${c.duration.dots}/${tm}/${c.grace ? "g" : ""}/${ly}`;
}

const flatOrderCache = new WeakMap<RecognizedScore, number[]>();

/**
 * meta 序 → 框序。框（`omr/overlay.ts` 的 `data-i`）按 `flatten(rows[].nums)` 编号，即谱面**逐行**；
 * 模型（`omr/todoc.ts`）按声部建 part——声部 0 的各行、再声部 1 的各行……，`meta.ts` 按 part 序编号。
 * 单声部两者相同；四声部一个系统四行交错，不换算就整片对错框。
 */
function flatOrder(score: RecognizedScore): number[] {
  let out = flatOrderCache.get(score);
  if (out) return out;
  const starts: number[] = [];
  let acc = 0;
  for (const r of score.rows) { starts.push(acc); acc += r.nums.length; }
  const order: number[] = [];
  const voices = [...new Set(score.rows.map((r) => r.voice ?? 0))].sort((a, b) => a - b);
  for (const v of voices) {
    score.rows.forEach((r, ri) => {
      if ((r.voice ?? 0) === v) for (let k = 0; k < r.nums.length; k++) order.push(starts[ri]! + k);
    });
  }
  flatOrderCache.set(score, order);
  return order;
}

/** 图片地址 → 自然大小（读不出给 A4 比例，只用来定占位页的比例） */
function imageSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 595, h: img.naturalHeight || 842 });
    img.onerror = () => resolve({ w: 595, h: 842 });
    img.src = url;
  });
}
