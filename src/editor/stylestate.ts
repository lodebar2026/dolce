// 渲染设置（应用级，不属于文档）：一律经样式层（`src/style/`）。
//
// 级联：内置主题 → 诗集样式表（歌本 `.ss`）→ 曲内层（谱里自带的纸与页眉字体）→ 用户层（设置面板）。
// 用户层每个主题一层规则，展开 / 原样 / 五线谱各记一套，页眉四项各档共用一层。
// 这里只管「样式表怎么算、面板的值落到哪条规则」；重排、持久化、纸底色这些副作用在 App（`applyRenderSettings` 等）。

import type { ScoreDoc } from "../model/doc";
import { songLyricSize, songStaffSize } from "../model/pagemeta";
import { computeStyle, sanitizeLayer, upsertRule, type StyleRule } from "../style/cascade";
import type { Length } from "../style/units";
import { NOTE_FONTS } from "../style/fonts";
import { docPageLayer, resolvePaper, songPageDecl } from "../style/paper";
import { headerFontsOf, headerLayerOfSong, type HeaderFonts, type HeaderRole } from "../style/header";
import type { DeepPartial, PageDecl, StyleSheet } from "../style/sheet";
import { jianpuSizes } from "../style/jianpu";
import { LONG_IMAGE_WIDTH, PAGE_RATIOS, THEMES, computeStyleForPaper, isPaper, themeOfMode } from "../style/themes";
import { replaceStyleRef } from "../abcfamily/metaedit";
import type { JianpuLayoutMode } from "../jianpu/profile";
import { t } from "../i18n";
import { dirOf, editorRules, findBookSheet, registerFontFaces, relativePath, type BookSheet, type BookSheetMap } from "./booksheet";
import { isTauriRuntime } from "./fileio";
import type { DocFormatId, FormatAdapter } from "./formats";

/** 有纸张设置的两把尺子：简谱原样档、五线谱/混排。 */
export type PaperEngine = "jianpu" | "staff";
/** 纸张栏的一次选择：纸名 + 方向 + 边距（`[上, 右, 下, 左]` pt，null = 自动），或跟随文件。 */
export type PaperChoice = "follow" | { paper: string; orientation: "portrait" | "landscape"; margin: number[] | null };

/** 设置面板一次提交的那几项（`App.applyRenderSettings` 的参数，回归脚本也走它）。 */
export interface RenderSettings {
  pageW?: number; pageH?: number; jpPaper?: string; staffPaper?: string;
  /** 纸张栏（纸 + 方向 + 边距，或跟随文件）。给了就盖过上面三个只换纸名的。 */
  paper?: Partial<Record<PaperEngine, PaperChoice>>;
  /** 五线谱/混排的谱表大小（mm）与歌词字号（pt）；null = 跟随文件 / 出厂。 */
  staffSize?: { mm?: number | null; lyricPt?: number | null };
  fontSize?: number; titleSize?: number; creditSize?: number; color?: number; bgColor?: number;
  /** 原样档的音符字体（`NOTE_FONTS` 的 id，空串 = 默认）、和弦升降号写在前后（空串 = 照原文）。 */
  noteFont?: string; chordAccidental?: "" | "before" | "after";
}

/** StyleState 向 App 要的东西。 */
export interface StyleStateHost {
  readonly adapter: FormatAdapter;
  readonly docFormat: DocFormatId;
  readonly filePath: string | null;
  readonly mode: "jp" | "mixed" | "recognize";
  readonly layoutMode: JianpuLayoutMode;
  currentScoreDoc(): ScoreDoc | null;
  getText(): string;
  setText(text: string): void;
  setStatus(text: string): void;
  saveSettings(): void;
  /** 样式变了：重排并重铺 */
  rerender(): void;
}

export class StyleState {
  constructor(private readonly host: StyleStateHost) {}

  /** 用户层：每个主题一层规则，**两档各记一套**（用户口径：「区分 展开/原样的字号设置」）。
   *  同一档里各格式共用一套（字号、纸、配色），规则不带限定。 */
  layers: Record<"projection" | "print" | "staff" | "header", StyleRule[]> = { projection: [], print: [], staff: [], header: [] };
  // `header`：页眉四项（标题/副标题/经文/词曲作者）的字体字号，**各档共用一份**，叠在各档用户层之上（`style/header.ts`）

  /** 某一档、某把尺子看到的 computed 样式表（内置主题 → 曲内层 → 用户层）。
   *  曲内层（谱里自带的纸，`style/paper.ts`）只垫在原样档下面：展开档是投影片，不认纸。 */
  styleOf(mode: JianpuLayoutMode): StyleSheet {
    const theme = themeOfMode(mode);
    const page = theme === "print" && !this.userSetsPaper("jianpu") ? this._docLayer() : [];
    return computeStyleForPaper(
      [THEMES[theme], this._bookLayer, page, this._docHeaderLayer(theme === "print", theme !== "print"), this.layers[theme], this.layers.header],
      { mode, engine: "jianpu" },
    );
  }

  /** 五线谱/混排看到的 computed 样式表（主题 staff → 曲内层 → 它自己那层用户规则）。
   *  **纸不借简谱原样档的**：那边出厂是长图，五线谱排成长图就是一张 1000pt 宽的扁图。 */
  staffStyle(): StyleSheet {
    const page = this.userSetsPaper("staff") ? [] : this._docLayer();
    return computeStyleForPaper(
      [THEMES.staff, this._bookLayer, page, this._docHeaderLayer(), this.layers.staff, this.layers.header],
      { mode: "staff", engine: "staff" },
    );
  }

  /** 曲内层：当前文档自带的纸（MusicXML `<page-layout>`、123/ABC `I:meta page …`）。`.jpwabc` 与文本谱没有。
   *  **用户在这一档明确选过纸就整层不用**（`styleOf` / `staffStyle` 判）：选了 A4、边距留空是要排版器自己的边距，
   *  不是「A4 + 文件里那组边距」。目前曲内层只有纸，将来放别的东西要改成按键剔。 */
  private _docLayer(): StyleRule[] {
    if (!this.host.adapter.toScoreDoc) return [];
    return docPageLayer(this.host.currentScoreDoc()?.songs[0]);
  }

  // ---- 诗集样式表（歌本 `.ss`，`editor/booksheet.ts`）：级联里在内置主题之后、曲内层之前 ----
  /** 当前生效的诗集样式表（null = 没有）。 */
  bookSheet: BookSheet | null = null;
  private _bookLayer: StyleRule[] = [];
  /** 手动指定：目录 → 样式表路径（空串 = 这个目录不用）。持久化。 */
  bookSheets: BookSheetMap = {};
  /** 浏览器版手动选的样式表（拿不到目录，存原文）。持久化。 */
  browserBookSheet: { name: string; text: string } | null = null;

  /** 按当前文件找诗集样式表并装上（见 `booksheet.ts` 的查找顺序），装完重排。 */
  async loadBookSheet(): Promise<void> {
    let found: BookSheet | null = null;
    if (isTauriRuntime()) {
      const ref = this.host.docFormat === "123" || this.host.docFormat === "abc" ? this.host.currentScoreDoc()?.songs[0]?.style?.sheetRef : undefined;
      found = this.host.filePath ? await findBookSheet(this.host.filePath, ref, this.bookSheets) : null;
    } else if (this.browserBookSheet) {
      found = { path: this.browserBookSheet.name, source: "manual", text: this.browserBookSheet.text, others: 0 };
    }
    const before = this.bookSheet?.path ?? null;
    this._useBookSheet(found);
    if (!found && !before) return; // 本来就没有，现在也没有：不必重排
    if (this.bookSheet) await registerFontFaces(this._bookLayer, this.bookSheet.path);
    if (found && this.bookSheet && found.path !== before) {
      const where = t(found.source === "ref" ? "status.bookSheet.ref" : found.source === "manual" ? "status.bookSheet.manual" : "status.bookSheet.auto");
      this.host.setStatus(t("status.bookSheet.using", { where, name: found.path.split(/[\\/]/).pop() ?? "" }) + (found.others ? t("status.bookSheet.others", { n: found.others }) : ""));
    }
    this.host.rerender();
  }

  private _useBookSheet(found: BookSheet | null): void {
    this.bookSheet = null;
    this._bookLayer = [];
    if (!found) return;
    try {
      this._bookLayer = editorRules(found.text);
      this.bookSheet = found;
    } catch (e) {
      this.host.setStatus(t("status.bookSheet.bad", { name: found.path.split(/[\\/]/).pop() ?? "", error: e instanceof Error ? e.message : String(e) }));
    }
  }

  /** 设置面板「诗集样式 → 选择…」：记到当前谱所在目录（浏览器版存原文）。 */
  async chooseBookSheet(): Promise<void> {
    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({ multiple: false, filters: [{ name: t("filter.bookSheet"), extensions: ["ss"] }] });
      if (typeof sel !== "string") return;
      const dir = this.host.filePath ? dirOf(this.host.filePath) : dirOf(sel);
      this.bookSheets = { ...this.bookSheets, [dir]: sel };
    } else {
      const file = await new Promise<File | null>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".ss";
        input.onchange = () => resolve(input.files?.[0] ?? null);
        input.click();
      });
      if (!file) return;
      this.browserBookSheet = { name: file.name, text: await file.text() };
    }
    this.host.saveSettings();
    await this.loadBookSheet();
  }

  /** 「不用样式表」：当前谱所在目录记一个空值（屏蔽自动发现）。 */
  async disableBookSheet(): Promise<void> {
    if (isTauriRuntime() && this.host.filePath) this.bookSheets = { ...this.bookSheets, [dirOf(this.host.filePath)]: "" };
    this.browserBookSheet = null;
    this.host.saveSettings();
    await this.loadBookSheet();
  }

  /** 「恢复自动查找」：清掉当前目录的手动指定。 */
  async resetBookSheet(): Promise<void> {
    if (this.host.filePath) {
      const dir = dirOf(this.host.filePath);
      const next = { ...this.bookSheets };
      delete next[dir];
      this.bookSheets = next;
      this.host.saveSettings();
    }
    await this.loadBookSheet();
  }

  /** 123 / ABC：把当前样式表写成 `I:style 相对路径`（查找顺序的第 1 条就成立了）。 */
  writeBookSheetRef(): boolean {
    if (!this.bookSheet || !this.host.filePath || (this.host.docFormat !== "123" && this.host.docFormat !== "abc")) return false;
    const next = replaceStyleRef(this.host.getText(), relativePath(dirOf(this.host.filePath), this.bookSheet.path));
    if (next !== this.host.getText()) this.host.setText(next);
    return true;
  }

  /** 曲内层的页眉字体：MusicXML `<credit-words>` 自带的、123/ABC 的 `I:meta font-*`（打开自动跟随）。 */
  private _docHeaderLayer(sizes = true, titleFamily = true): StyleRule[] {
    if (!this.host.adapter.toScoreDoc) return [];
    return headerLayerOfSong(this.host.currentScoreDoc()?.songs[0], { sizes, titleFamily });
  }

  /** 页眉四项现在的字体：谱里自带的（「跟随文件」显示用）、用户设的、算出来实际用的（当前档）。 */
  headerState(): { doc: HeaderFonts; user: HeaderFonts } {
    // 按当前档看：转换带来的字号只记在原样与五线谱两档（见 `carryHeaderFonts`），展开档看不到
    const mode = this.host.mode === "mixed" ? "staff" : this.host.layoutMode;
    const doc = this._docHeaderLayer(mode !== "expanded");
    return {
      doc: headerFontsOf(computeStyle([doc], {})),
      user: headerFontsOf(computeStyle([this.layers.header], { mode })),
    };
  }

  /** 转成 `.jpwabc` / 文本谱（没有页眉字体字段）时把谱里的页眉字体记进设置：族各档共用；
   *  字号只记原样与五线谱两档——印刷纸上的字号搬到展开档的投影片上太小（与「跟随文件」同一口径）。 */
  carryHeaderFonts(fonts: Partial<Record<HeaderRole, { family?: string; size?: number; bold?: boolean }>>): void {
    const roles = Object.entries(fonts) as [HeaderRole, { family?: string; size?: number; bold?: boolean }][];
    if (!roles.length) return;
    let layer: StyleRule[] = this.layers.header;
    const fam: Record<string, { family?: string; weight?: string }> = {};
    const size: Record<string, { size: number }> = {};
    for (const [role, f] of roles) {
      if (f.family || f.bold) fam[role] = { ...(f.family ? { family: f.family } : {}), ...(f.bold ? { weight: "bold" } : {}) };
      if (f.size) size[role] = { size: f.size };
    }
    if (Object.keys(fam).length) layer = upsertRule(layer, undefined, { roles: fam });
    if (Object.keys(size).length) {
      layer = upsertRule(layer, { mode: "original" }, { roles: size });
      layer = upsertRule(layer, { mode: "staff" }, { roles: size });
    }
    this.layers.header = layer;
  }

  /** 设页眉一项：`null` 的字段清掉（回到跟随文件 / 出厂）。 */
  setHeaderFont(role: HeaderRole, f: { family: string | null; size: number | null }): void {
    const rules = this.layers.header.map((r) => ({ ...r, set: { ...r.set, roles: { ...(r.set.roles ?? {}) } } }));
    let rule = rules.find((r) => !r.when);
    if (!rule) rules.push((rule = { set: { roles: {} } }));
    const decl = { ...(rule.set.roles?.[role] ?? {}) };
    if (f.family) decl.family = f.family;
    else delete decl.family;
    if (f.size) decl.size = f.size;
    else delete decl.size;
    rule.set.roles![role] = decl;
    // 面板改的是各档共用那条；转换时按档记的字号（`carryHeaderFonts`）一并清掉，免得它在原样/五线谱档盖过面板
    for (const r of rules) {
      if (r === rule || !r.set.roles?.[role]) continue;
      const { size: _s, ...rest } = r.set.roles[role]!;
      r.set.roles[role] = rest;
    }
    this.layers.header = rules;
  }

  /** 五线谱/混排的谱表大小（mm）与歌词字号（pt）：谱里的（「跟随文件」显示用）与用户设的。 */
  staffSizeState(): { doc: { mm: number | null; lyricPt: number | null }; user: { mm: number | null; lyricPt: number | null } } {
    const song = this.host.adapter.toScoreDoc ? this.host.currentScoreDoc()?.songs[0] : undefined;
    const u = computeStyle([this.layers.staff], { mode: "staff", engine: "staff" }).staff;
    return {
      doc: { mm: song ? songStaffSize(song) : null, lyricPt: song ? songLyricSize(song) : null },
      user: { mm: u.size ?? null, lyricPt: u.lyricSize ?? null },
    };
  }

  /** 设谱表大小 / 歌词字号：`null` = 清掉（跟随文件或出厂）。 */
  setStaffSize(v: { mm?: number | null; lyricPt?: number | null }): void {
    const rules = this.layers.staff.map((r) => ({ ...r, set: { ...r.set, staff: { ...(r.set.staff ?? {}) } } }));
    let rule = rules.find((r) => !r.when);
    if (!rule) rules.push((rule = { set: { staff: {} } }));
    const st = rule.set.staff!;
    if (v.mm !== undefined) {
      if (v.mm) st.size = v.mm;
      else delete st.size;
    }
    if (v.lyricPt !== undefined) {
      if (v.lyricPt) st.lyricSize = v.lyricPt;
      else delete st.lyricSize;
    }
    this.layers.staff = rules;
  }

  /** 设置面板的纸张那一栏：谱里自带的纸（「跟随文件」显示用）、用户层有没有明确选过纸、算出来实际用的那张。 */
  paperState(engine: PaperEngine): { doc: PageDecl | null; userSet: boolean; page: PageDecl } {
    const song = this.host.adapter.toScoreDoc ? this.host.currentScoreDoc()?.songs[0] : undefined;
    const doc = song ? songPageDecl(song) : null;
    const page = engine === "staff" ? this.staffStyle().page : this.styleOf("original").page;
    return { doc, userSet: this.userSetsPaper(engine), page };
  }

  /** 用户层有没有明确选过纸/方向/边距（五线谱/混排据此决定要不要盖过谱里的 `<page-layout>`）。 */
  userSetsPaper(engine: PaperEngine): boolean {
    const layer = engine === "staff" ? this.layers.staff : this.layers.print;
    const pg = computeStyle([layer], { mode: engine === "staff" ? "staff" : "original", engine }).page;
    return pg.paper !== undefined || pg.orientation !== undefined || pg.margin !== undefined;
  }

  /** 设纸：`follow` = 跟随文件（清掉用户层里的纸、方向、边距；谱里没写纸就回到出厂那张）。 */
  setPaper(engine: PaperEngine, choice: PaperChoice): void {
    const key = engine === "staff" ? "staff" : "print";
    if (choice === "follow") {
      this.layers[key] = this.layers[key].map((r) => {
        if (!r.set.page) return r;
        const { paper: _p, orientation: _o, margin: _m, ...rest } = r.set.page;
        return { ...r, set: { ...r.set, page: rest } };
      });
      return;
    }
    if (!isPaper(choice.paper)) return;
    const page: DeepPartial<PageDecl> = { paper: choice.paper, orientation: choice.orientation };
    this.layers[key] = upsertRule(this.layers[key], undefined, { page });
    // 边距整组替换（深合并会把数组整体换掉）；null = 清掉，回到各排版器自己的缺省
    const hit = this.layers[key].find((r) => !r.when);
    if (hit?.set.page) {
      if (choice.margin) hit.set.page.margin = [...choice.margin];
      else delete hit.set.page.margin;
    }
  }

  /** 原样档用户层里的音符字体（`NOTE_FONTS` 的 id；空串 = 没设、按主题默认）。 */
  get noteFont(): string {
    const fam = computeStyle([this.layers.print], { mode: "original", engine: "jianpu" }).roles.note?.family;
    return NOTE_FONTS.find((f) => f.family === fam)?.id ?? "";
  }

  /** 原样档用户层里和弦升降号的写法（空串 = 没设、照原文）。 */
  get chordAccidental(): "" | "before" | "after" {
    const v: unknown = computeStyle([this.layers.print], { mode: "original", engine: "jianpu" }).jianpu.overrides?.["accidental-side"];
    return v === "before" || v === "after" ? v : "";
  }

  /** 设音符字体：字体族写在 `note` 角色上，加不加粗写 `note-bold`；空串 = 两样都清掉。 */
  private _setNoteFont(id: string): void {
    const f = NOTE_FONTS.find((x) => x.id === id);
    const rules = this.layers.print.map((r) => ({ ...r, set: { ...r.set, roles: { ...(r.set.roles ?? {}) } } }));
    for (const r of rules) {
      if (!r.set.roles!.note) continue;
      const { family: _f, ...rest } = r.set.roles!.note;
      r.set.roles!.note = rest;
    }
    this.layers.print = rules;
    this._setPrintOverride("note-bold", f ? f.bold : undefined);
    if (f) this._setStyle("original", { roles: { note: { family: f.family } } });
  }

  /** 原样档用户层的一个 `@jianpu` 键：给值就写，`undefined` 就从各条规则里删掉。 */
  private _setPrintOverride(key: string, v: string | boolean | undefined): void {
    this.layers.print = this.layers.print.map((r) => {
      const ov = r.set.jianpu?.overrides;
      if (!ov || !(key in ov)) return r;
      const { [key]: _drop, ...rest } = ov;
      return { ...r, set: { ...r.set, jianpu: { ...r.set.jianpu, overrides: rest } } };
    });
    // 词类键（`accidental-side` 等）在样式表里和长度同存一个字段（同 `themes.ts` 的 `lrc-punct-compress`）
    if (v !== undefined) this._setStyle("original", { jianpu: { overrides: { [key]: v as Length | boolean } } });
  }

  /** 往某一档的用户层写一条规则（限定相同的就地合并）。 */
  private _setStyle(mode: JianpuLayoutMode, set: DeepPartial<StyleSheet>): void {
    const theme = themeOfMode(mode);
    this.layers[theme] = upsertRule(this.layers[theme], undefined, set);
  }

  /** 展开档的投影片尺寸（`PAGE_RATIOS` 那几张）。 */
  get pageW(): number {
    return this.styleOf("expanded").page.size?.[0] ?? PAGE_RATIOS["16:9"][0];
  }
  get pageH(): number {
    return this.styleOf("expanded").page.size?.[1] ?? PAGE_RATIOS["16:9"][1];
  }
  /** 当前档的简谱字号（展开档三个都能调；原样档**只调基础字号**，标题与词曲按出厂比例派生，见 `style/jianpu.ts`）。
   *  排版器、设置面板、帮助示例都只认「当前档」。 */
  get fontSize(): number {
    return jianpuSizes(this.styleOf(this.host.layoutMode)).fontSize;
  }
  get titleSize(): number {
    return jianpuSizes(this.styleOf(this.host.layoutMode)).titleSize;
  }
  get creditSize(): number {
    return jianpuSizes(this.styleOf(this.host.layoutMode)).creditSize;
  }
  /** 当前档实际排版用的那张纸。展开档就是 `pageW`/`pageH` 那张投影片；原样档宽度锁定、
   *  原样档取 `PAPER_SIZES` 里那张实际纸（长图那一档不分页，返回的高度只是个占位）。
   *  排版、分行度量（`_phraseFit`）都认它——两处若各用各的纸，行长会按 A 张纸算、
   *  按 B 张纸排。 */
  get layoutPage(): { w: number; h: number } {
    if (this.host.layoutMode === "expanded") return { w: this.pageW, h: this.pageH };
    const paper = resolvePaper(this.styleOf("original").page);
    // 长图：宽固定，高度由内容说了算（传进去的只是个不参与分页的占位）
    if (!paper) return { w: LONG_IMAGE_WIDTH, h: LONG_IMAGE_WIDTH };
    return paper;
  }

  /** 前景色（谱面笔画/文字）与背景色（纸张）。档指的是「展开 / 原样」那一对排版方式，
   *  跨文档格式——`.jpwabc` 与文本谱在同一档下共用同一份色。
   *  背景色只作用于「纸」（预览页的底、导出 PNG 的底、PPTX 的幻灯片底），排版器不认识它。 */
  get color(): number {
    return this.colorsOf(this.host.layoutMode).fg;
  }
  get bgColor(): number {
    return this.colorsOf(this.host.layoutMode).bg;
  }
  /** 某一档的配色。导出 PPTX 要按 **展开档**另排一遍，用的就得是那一档的色。 */
  colorsOf(mode: JianpuLayoutMode): { fg: number; bg: number } {
    const page = this.styleOf(mode).page;
    return { fg: page.ink ?? 0xff000000, bg: page.background ?? 0xffffffff };
  }
  /** 原样档的纸（键取自 `PAPER_SIZES`，「长图」是其中一档）。 */
  get jpPaper(): string {
    return this.styleOf("original").page.paper ?? "长图";
  }
  /** 字号落到**当前档**那一套里。原样档只收基础字号——那一档的标题/词曲是派生的，
   *  面板上根本不显示（见 editor/dialogs.ts），收了也只会被下一次派生覆盖掉。 */
  private _applySizes(mode: JianpuLayoutMode, opts: { fontSize?: number; titleSize?: number; creditSize?: number }): void {
    if (mode === "original") {
      if (opts.fontSize) this._setStyle("original", { roles: { note: { size: opts.fontSize } } });
      return;
    }
    const roles: DeepPartial<StyleSheet["roles"]> = {};
    if (opts.fontSize) roles.note = { size: opts.fontSize };
    if (opts.titleSize !== undefined) roles.title = { size: opts.titleSize };
    if (opts.creditSize !== undefined) roles.credit = { size: opts.creditSize };
    if (Object.keys(roles).length) this._setStyle("expanded", { roles });
  }

  /** 面板那几项设置落进**样式层的用户层**（重排、持久化由 `App.applyRenderSettings` 接着做）。
   *  纸与字号按档、按格式分开记；配色按档记；投影片比例只归展开档。 */
  apply(opts: RenderSettings): void {
    const mode = this.host.layoutMode;
    if (opts.pageW || opts.pageH) {
      this._setStyle("expanded", { page: { size: [opts.pageW || this.pageW, opts.pageH || this.pageH] } });
    }
    // 原样档的纸要在重排之前定好——排版时按长图灌 continuousPage
    if (opts.jpPaper && isPaper(opts.jpPaper)) this._setStyle("original", { page: { paper: opts.jpPaper } });
    if (opts.staffPaper && isPaper(opts.staffPaper)) this.layers.staff = upsertRule(this.layers.staff, undefined, { page: { paper: opts.staffPaper } });
    for (const [engine, choice] of Object.entries(opts.paper ?? {}) as [PaperEngine, PaperChoice][]) this.setPaper(engine, choice);
    if (opts.staffSize) this.setStaffSize(opts.staffSize);
    if (opts.noteFont !== undefined) this._setNoteFont(opts.noteFont);
    if (opts.chordAccidental !== undefined) this._setPrintOverride("accidental-side", opts.chordAccidental || undefined);
    if (opts.color !== undefined) this._setStyle(mode, { page: { ink: opts.color } });
    if (opts.bgColor !== undefined) this._setStyle(mode, { page: { background: opts.bgColor } });
    this._applySizes(mode, opts);
  }

  /** 清掉某一档的用户层（回到主题默认）。 */
  resetMode(mode: JianpuLayoutMode): void {
    this.layers[themeOfMode(mode)] = [];
  }

  /** 从持久化设置读回：用户层、诗集样式表的手动指定（旧版散存的字号/纸/配色字段不读——不做存量迁移）。 */
  load(s: { styleLayers?: unknown; bookSheets?: unknown; browserBookSheet?: unknown }): void {
    if (s.bookSheets && typeof s.bookSheets === "object") {
      this.bookSheets = Object.fromEntries(
        Object.entries(s.bookSheets as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"),
      );
    }
    const bb = s.browserBookSheet as { name?: unknown; text?: unknown } | null | undefined;
    if (bb && typeof bb.name === "string" && typeof bb.text === "string") this.browserBookSheet = { name: bb.name, text: bb.text };
    const layers = (s.styleLayers ?? {}) as Record<string, unknown>;
    this.layers = {
      projection: sanitizeLayer(layers.projection),
      print: sanitizeLayer(layers.print),
      staff: sanitizeLayer(layers.staff),
      header: sanitizeLayer(layers.header),
    };
  }

  /** 要持久化的那几项（`App.saveSettings` 合进总设置）。 */
  persisted(): { styleLayers: StyleState["layers"]; bookSheets: BookSheetMap; browserBookSheet: StyleState["browserBookSheet"] } {
    return { styleLayers: this.layers, bookSheets: this.bookSheets, browserBookSheet: this.browserBookSheet };
  }
}
