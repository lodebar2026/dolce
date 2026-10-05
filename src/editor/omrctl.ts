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
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  recognizeMusicppDetailed, renderRecognitionSvg, renderRowPopup, renderHeaderPopup, renderRowSource,
  OMR_EMITTERS, DEFAULT_OMR_FORMAT, isOmrFormat, omrEmitter,
  type OmrFormat, type RecogView,
} from "../omr";
import type { Binary, JpwMeta, RecognizedScore } from "../omr";
import type { ElementId, ScoreDoc } from "../model/doc";
import type { PlayPoint } from "./player";
import type { DocFormatId } from "./formats";
import { confirmDiscardEdits, type FormatOption, type FormatSource, type FormatSwitch } from "./formatswitch";
import { reprojectRecognized, type Reprojected } from "../omr/reproject";
import { baseImage, doubtItems } from "../omr/overlay";
import type { ProjectKind, ProjectSnapshot } from "./omrproject";
import { t } from "../i18n";

/** 是否 PDF 字节（mime 或 `%PDF-` 魔数）。与 `omr/decode.ts` 里那份同判据。 */
function isPdfBytes(bytes: Uint8Array, mime?: string): boolean {
  if (mime === "application/pdf") return true;
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/** 一份识别输入（拖进来、选进来的图片或 PDF）。 */
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
   * 不走 `importOmrDoc`：五线谱的和弦、多声部、slur 在 `.jpwabc` 与简谱引擎里装不下。
   * 返回 false 表示简谱那一侧转不出来（不影响混排预览）。
   */
  adoptStaffXml(xml: string): boolean;
  /** 简谱识别产物落地：识别直出的模型与它写成的 123 核对文本。 */
  importOmrDoc(doc: ScoreDoc, text: string): void;
  /** 识别产物有无变了：同步排版档按钮（简谱识别期间不露「五线谱」「混排」两档）。 */
  syncViewModes(): void;

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
  loadSettings(s: { omrFormat?: unknown; recogView?: unknown; omrFollow?: unknown; omrKind?: unknown; omrSide?: unknown; omrAdjust?: unknown; sideHideCode?: unknown }): void {
    if (isOmrFormat(s.omrFormat)) this.format = s.omrFormat;
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
    return (this.emitted !== null && t !== this.emitted) || (this.staffEmitted !== null && t !== this.staffEmitted);
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
    // 改过原图列表重识别没成：谱面还是上一次的结果，原图列表也退回去（存项目、重开补对照要的是那一份）。
    // 没有会话（起始页第一次识别失败）就留着新的，好给「调整原图后重试」
    if (!ok && g === this.gen && this.sessionKind !== null) this.lastInputs = prev;
    if (g === this.gen || ok) this.syncPagesBtn();
    return ok;
  }

  private async recognizeFilesInner(files: readonly RecogInput[], g: number): Promise<boolean> {
    if (!files.length) return false;
    this.lastInputs = [...files];
    const first = files[0]!;
    // 文字层完整的五线谱 PDF（矢量）先试：只要不是指定按简谱识别
    if (files.length === 1 && this.kind !== "jianpu" && isPdfBytes(first.bytes, first.mime) && (await this.tryStaffPdf(first.bytes, performance.now(), g))) return true;
    if (g !== this.gen) return false;
    if (this.kind !== "jianpu") {
      const t0 = performance.now();
      try {
        const rb = await import("../rasteromr/browser");
        const pdfs: Uint8Array[] = [];
        for (const f of files) pdfs.push(await rb.asRasterPdf(f.bytes, f.mime));
        const isStaff = this.kind === "staff" || (await rb.looksLikeStaffBytes(pdfs[0]!));
        if (g !== this.gen) return false;
        if (isStaff) return await this.recognizeRasterStaff(pdfs, files, t0, g);
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
  private async recognizeRasterStaff(pdfs: Uint8Array[], files: readonly RecogInput[], t0: number, g: number): Promise<boolean> {
    const rb = await import("../rasteromr/browser");
    this.busy = true;
    this.cancelRequested = false;
    this.progress(t("omr.staffRunning"));
    let res;
    try {
      res = await rb.recognizeRasterPdfs(pdfs, {
        title: files.length === 1 && files[0]!.name ? baseTitle(files[0]!.name) : undefined,
        onPage: (done, total) => g === this.gen && this.progress(t("omr.staffProgress", { done, total }) + t("omr.escCancel")),
        // 过时的（又开始了一次识别、打开了别的文档）自己停下
        cancelled: () => g !== this.gen || this.cancelRequested,
      });
    } catch (e) {
      if (g === this.gen) this.host.setStatus(this.cancelRequested ? t("omr.cancelled") : t("omr.staffFailed", { error: e instanceof Error ? e.message : String(e) }));
      return false;
    } finally {
      if (g === this.gen) this.busy = false;
    }
    if (g !== this.gen) return false;
    if (!res.xml) {
      this.host.setStatus(t("omr.noStaffFound"));
      return false;
    }
    this.clear();
    this.lastInputs = [...files];
    this.staffResult = res;
    this.sessionKind = "staff";
    this.host.adoptStaffXml(res.xml);
    this.staffEmitted = this.host.getText();
    this.host.setContextControl(this.kindField(), true);
    // 位图路有页面位图与音符坐标：「原图对照」可用（矢量 PDF 那一路没有位图，不给）
    if (this.btnEl) this.btnEl.textContent = t("omr.compare");
    this.host.setContextControl(this.btnEl, true);
    const s = res.stats;
    this.host.setStatus(
      t("omr.staffDone", { sec: ((performance.now() - t0) / 1000).toFixed(1), pages: s.pages, parts: s.parts ?? 1, notes: s.notes }) +
        (s.bars ? t("omr.fullBars", { pct: Math.round((s.full / s.bars) * 100) }) : "") + t("omr.editOnScore"),
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
      await this.toggle(); // 进原图对照，同刚识别完
      return;
    }
    // 五线谱会话只出 MusicXML；万一存的是别的格式（旧包、手工拼的包），照原格式落地，对照数据仍按原图补
    if (s.docFormat === "musicxml") this.host.adoptStaffXml(s.text);
    else this.host.adoptText(s.docFormat, s.text, null);
    this.staffEmitted = s.emitted;
    this.sessionKind = s.kind;
    this.host.setContextControl(this.kindField(), true);
    this.syncPagesBtn();
    if ((s.kind === "staff" || s.kind === "vector") && this.lastInputs.length) {
      if (this.btnEl) this.btnEl.textContent = t("omr.compare");
      this.host.setContextControl(this.btnEl, true);
    }
  }

  /** 五线谱项目重开后第一次进对照：从原图重跑识别补回逐页位图与音符坐标（不动原文）。 */
  private ensureStaffResult(): Promise<boolean> {
    if (this.staffResult || !this.lastInputs.length) return Promise.resolve(this.staffResult !== null);
    this.ensuring ??= this.loadStaffResult().then((ok) => {
      this.staffLoadFailed = !ok;
      return ok;
    }).finally(() => { this.ensuring = null; });
    return this.ensuring;
  }

  private async loadStaffResult(): Promise<boolean> {
    const g = this.gen;
    // 补的途中打开了别的文档：补回来的不能挂到新文档上
    const land = (r: import("../rasteromr/song").RasterSongResult): boolean => {
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
        return land(await sb.vectorOverlayResult(bytes, await sb.recognizeStaffPdf(bytes, { noteIds: true })));
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
  staffResult: import("../rasteromr/song").RasterSongResult | null = null;

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
      this.hideCode = !chk.checked;
      this.host.saveSettings();
      this.applyCodePane();
    });
    this.applyCodePane();
  }

  /** 按 `hideCode` 收起 / 放出代码区，复选框跟着。 */
  applyCodePane(): void {
    document.getElementById("body")?.classList.toggle("hide-code", this.hideCode);
    if (this.codeCheck) this.codeCheck.checked = !this.hideCode;
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
    box?.addEventListener("click", (e) => {
      const r = e.target instanceof Element ? e.target.closest<SVGRectElement>("rect.omr-side-hit") : null;
      const id = r ? Number(r.dataset.id) : NaN;
      if (Number.isFinite(id)) this.host.selectNote(id);
    });
  }

  /** 并排面板：开关、底图、框出 `id`。排版稿选区一变就调（`followSelection` 顺带调）。 */
  syncSide(id: ElementId | null): void {
    this.sideBtn?.classList.toggle("active", this.side);
    this.sideBtn?.setAttribute("aria-pressed", String(this.side));
    const box = this.sideEl;
    if (!box) return;
    const on = this.side && this.host.mode !== "recognize" && (this.bin !== null && this.score !== null || this.staffResult !== null || this.sessionKind === "staff" || this.sessionKind === "vector");
    box.hidden = !on;
    document.getElementById("score-pane")?.classList.toggle("with-omr-side", on);
    if (!on) {
      box.replaceChildren();
      this.sideKey = null;
      return;
    }
    const pane = document.getElementById("score-pane");
    if (pane) box.style.top = `${pane.offsetTop}px`;
    void this.drawSide(id);
  }

  private async drawSide(id: ElementId | null): Promise<void> {
    const box = this.sideEl!;
    // 五线谱项目重开后还没有对照数据：先从原图补
    if (!this.staffResult && (this.sessionKind === "staff" || this.sessionKind === "vector") && !(this.bin && this.score)) {
      if (this.staffLoadFailed || !(await this.ensureStaffResult())) return;
    }
    const doc = this.host.currentScoreDoc();
    const key = [this.score, this.staffResult, doc];
    const fresh = !Array.isArray(this.sideKey) || (this.sideKey as unknown[]).some((x, i) => x !== key[i]);
    if (fresh) {
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
    const page = (bin: Binary, boxes: { id: ElementId; x: number; y: number; w: number; h: number }[]): SVGSVGElement => {
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "omr-side-page");
      svg.setAttribute("viewBox", `0 0 ${bin.w} ${bin.h}`);
      svg.appendChild(baseImage(bin));
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
      return res.pages.map((p, i) => page(p.result.raster!.bin, [...res.noteBoxes].filter(([oid, b]) => b.page === i && byOmr.has(oid))
        .map(([oid, b]) => ({ id: byOmr.get(oid)!, x: b.box.left, y: b.box.top, w: b.box.right - b.box.left, h: b.box.bottom - b.box.top }))));
    }
    if (!this.bin || !this.score) return [];
    const map = this.idMapOf(doc);
    const flat = this.score.rows.flatMap((r) => r.nums);
    const boxes = map ? map.toId.flatMap((id, i) => {
      const b = flat[i]?.bbox;
      return id !== undefined && b ? [{ id, x: b.x, y: b.y, w: b.w, h: b.h }] : [];
    }) : [];
    return [page(this.bin, boxes)];
  }

  /** 五线谱：模型和弦 id → 识别时写进 `<note id>` 的编号（按当前原文读，改过的谱也认得回来）。 */
  private async staffIds(doc: ScoreDoc | null): Promise<Map<ElementId, string>> {
    const { surfaceOf } = await import("../model/xmlsurface");
    const out = new Map<ElementId, string>();
    for (const part of doc?.songs[0]?.parts ?? []) {
      for (const m of part.measures) {
        for (const el of m.elements) {
          if (el.kind !== "chord") continue;
          const node = (el.notes[0] && surfaceOf(el.notes[0])) ?? surfaceOf(el);
          const oid = node?.getAttribute("id");
          if (oid && this.staffResult?.noteBoxes.has(oid)) out.set(el.id, oid);
        }
      }
    }
    return out;
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
   *  保留二值图+识别结果，完成后默认进入叠加核对视图（先核对；「原图对照」可切回排版稿）。 */
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
    try {
      const t0 = performance.now();
      const { bin, score } = await recognizeMusicppDetailed(picked.bytes, picked.mime);
      if (g !== this.gen) return false;
      this.emit(score, bin);
      this.host.setContextControl(this.kindField(), true);
      if (this.host.mode !== "recognize") await this.toggle(); // 识别后默认进叠加核对（本仓库「先核对」取向）
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
    const { openStaffPdf, isStaffPdf, recognizeStaffPdf } = await import("../staffomr/browser");
    let ok = false;
    try {
      const { pdf, OPS } = await openStaffPdf(bytes);
      ok = await isStaffPdf(pdf, OPS);
      pdf.destroy?.();
    } catch {
      return false;
    }
    if (!ok || g !== this.gen) return false;
    const res = await recognizeStaffPdf(bytes, {
      onProgress: (done, total) => g === this.gen && this.host.setStatus(t("omr.staffProgress", { done, total })),
      noteIds: true,
    });
    if (g !== this.gen) return true; // 过时：不落地，也不让调用方再按简谱试
    if (!res.notes) {
      this.host.setStatus(t("omr.noStaff"));
      return false;
    }
    // 五线谱只出 MusicXML，且只进混排视图（理由见 OmrHost.adoptStaffXml）。
    const inputs = this.lastInputs;
    this.clear();
    this.lastInputs = inputs;
    this.sessionKind = "vector";
    this.host.setContextControl(this.kindField(), true);
    const jpOk = this.host.adoptStaffXml(res.musicxml);
    this.staffEmitted = this.host.getText();
    const g2 = this.gen; // 上面 clear() 换了代号
    // 原图对照：页面渲成位图、框放大到像素（`vectorOverlayResult`），之后与位图那一路同一套对照视图与关联表
    try {
      const { vectorOverlayResult } = await import("../staffomr/browser");
      const overlay = await vectorOverlayResult(bytes, res);
      if (g2 !== this.gen) return true;
      this.staffResult = overlay;
      if (this.btnEl) this.btnEl.textContent = t("omr.compare");
      this.host.setContextControl(this.btnEl, true);
    } catch (e) {
      console.warn("矢量 PDF 渲不出对照底图", e);
    }
    this.host.setStatus(
      t("omr.staffDone", { sec: ((performance.now() - t0) / 1000).toFixed(1), pages: res.pages, parts: res.parts, notes: res.notes }) +
        (res.skipped ? t("omr.staffSkipped", { n: res.skipped }) : "") +
        (jpOk ? "" : t("omr.staffNoJp")),
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
    const marks = this.host.visualEnabled() ? [] : this.beatMarks;
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

  /** 逐页画：页面位图 + 每个识别出的音一个框，框上标它现在的音名（改过标青、删掉划掉）。 */
  private async renderStaffPages(): Promise<void> {
    const res = this.staffResult;
    if (!res) return;
    const { renderStaffRecognitionPage } = await import("../rasteromr/overlay");
    const { surfaceOf } = await import("../model/xmlsurface");
    const doc = this.host.currentScoreDoc();
    const now = new Map<string, { label: string; changed: boolean }>();
    this.staffIdOf.clear();
    for (const part of doc?.songs[0]?.parts ?? []) {
      for (const m of part.measures) {
        for (const el of m.elements) {
          if (el.kind !== "chord") continue;
          const nodes: (Element | undefined)[] = el.notes.length ? el.notes.map((n) => surfaceOf(n) ?? surfaceOf(el)) : [surfaceOf(el)];
          nodes.forEach((node, k) => {
            const id = node?.getAttribute("id");
            if (!id || !res.noteBoxes.has(id)) return;
            if (k === 0) this.staffIdOf.set(el.id, id);
            const orig = res.noteBoxes.get(id)!;
            const p = el.notes[k]?.pitch;
            const label = el.rest || !p ? t("omr.restLabel") : `${p.step}${p.alter > 0 ? "♯".repeat(p.alter) : "♭".repeat(-p.alter)}${p.octave}`;
            const changed = el.rest ? !orig.rest : !p || orig.rest || p.step !== orig.step || p.octave !== orig.octave || p.alter !== orig.alter;
            if (!now.has(id)) now.set(id, { label, changed });
          });
        }
      }
    }
    const pages = res.pages;
    const view = this.view;
    this.host.renderPagesWith(pages.length, (i) => {
      const bin = pages[i]!.result.raster!.bin;
      const marks = [...res.noteBoxes].filter(([, b]) => b.page === i).map(([id, b]) => {
        const cur = now.get(id);
        return cur
          ? { id, box: b.box, label: cur.label, ...(cur.changed ? { state: "edited" as const } : {}) }
          : { id, box: b.box, label: b.rest ? t("omr.restLabel") : `${b.step}${b.octave}`, state: "deleted" as const };
      });
      return renderStaffRecognitionPage(bin, marks, view);
    }, {
      aspectRatio: (i) => `${pages[i]!.result.raster!.bin.w} / ${pages[i]!.result.raster!.bin.h}`,
      onPage: (svg) => this.wireStaffInteraction(svg),
      resetPageIndex: false,
    });
  }

  private wireStaffInteraction(svg: SVGSVGElement): void {
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

  /** 按新的「谱表 ↔ 声部」指派重建 MusicXML，不重跑识别；手改过先问一声（重建会丢掉改动）。 */
  async rebuildStaff(slots: number[][]): Promise<boolean> {
    const res = this.staffResult;
    if (!res) return false;
    if (this.staffEmitted !== null && this.host.getText() !== this.staffEmitted && !(await confirmDiscardEdits())) return false;
    let xml: string;
    try {
      xml = res.rebuild(slots).xml;
    } catch (e) {
      this.host.setStatus(t("omr.rebuildFailed", { error: e instanceof Error ? e.message : String(e) }));
      return false;
    }
    this.host.adoptStaffXml(xml);
    this.staffEmitted = this.host.getText();
    this.host.setStatus(t("omr.rebuilt"));
    return true;
  }

  /** 位图五线谱识别（或上次重建）刚落地时的原文：与当前原文不同即手改过 */
  private staffEmitted: string | null = null;

  /** 这份结果有没有点选映射（123 / 文本谱 / Muse `.jcx` 产物有，`.jpwabc` / ABC 没有）。 */
  get hasMeta(): boolean {
    return this.meta !== null;
  }

  /** 索引条目 → 核对视图上的命中框：音符按框序（新插的按元素 id）、歌词按框序与段、页眉另认（`headerHits`）。 */
  hitFor(kind: "note" | "lyric", id: ElementId, verse = 0): SVGGraphicsElement | null {
    const pane = document.getElementById("score-pane");
    if (this.staffResult) {
      const omrId = kind === "note" ? this.staffIdOf.get(id) : undefined;
      return omrId ? pane?.querySelector<SVGRectElement>(`.omr-hits rect[data-omr="${omrId}"]`) ?? null : null;
    }
    const i = this.idMapOf(this.host.currentScoreDoc())?.toI.get(id);
    if (kind === "lyric") {
      return i === undefined ? null : pane?.querySelector<SVGRectElement>(`.omr-hits rect[data-kind="lyric"][data-i="${i}"][data-verse="${verse}"]`) ?? null;
    }
    if (i !== undefined) return pane?.querySelector<SVGRectElement>(`.omr-hits rect[data-kind="note"][data-i="${i}"]`) ?? null;
    return pane?.querySelector<SVGRectElement>(`.omr-hits rect[data-kind="note"][data-id="${id}"]`) ?? null;
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
   * 播到某个元素：同五线谱（`painter.ts::movePlayhead`），放一条竖直播放线——横向取这个音的识别框，
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
    this.bin = null;
    this.score = null;
    this.beatMarks = [];
    this.meta = null;
    this.idMap = null;
    this.playingEl = null;
    this.emitted = null;
    this.staffEmitted = null;
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
