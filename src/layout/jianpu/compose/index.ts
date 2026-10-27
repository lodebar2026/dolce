// 原样文档布局的构图：定位结构（`place/`）→ PageItem 页面树。原先 `PuPainter`（已退役）的绘制方法
// 原样搬来（`docs/实现/PuPainter退役.md` P4/P5），`this` 换成一次排版的上下文 `OriginalCtx`；
// 加载、DOM、渲染与高亮归唯一的 `layout/painter.ts::ScorePainter`，这里只产出页面与身份索引。
//
// 复用本项目的 PageItem/Group/GraphicPath/GraphicLine/TextFrame，
// 所以「导出 PPTX」那条路（collectShapes 认这几种图元）不用改就能吃这些页面。
//
// 数字用系统字体按**墨迹居中**于步进锚点（字号取样式值 size.note），
// 圆点与线段自绘——位置逐点对齐原版，字形则是规范字形。
//
// 入口只收 `ScoreDoc`：先经 `jianpu/slots.ts::docView` 线性化成排版行（排版几何都按行写成），再定位、绘制。
//
// 播放逐字高亮与双向定位：绘制时把每个音符与每个歌词音节的 PageItem 按**元素 id** 记进索引，
// 由 ScorePainter 直接按 id 取用，不必反查 SVG，也不依赖对象身份（重新解析一遍 id 不变）。
import { applyDocOptions, contentWidth, gridOf, keyLabelSize, type GridPage, type JianpuGrid } from "../metrics";
import { Font } from "../../../pagetree/font";
import { Group } from "../../../pagetree/pageitem";
import { syllableRun } from "../../../engrave/syllable";
import { sectionWordRun } from "../../../engrave/sectionword";
import { Rect } from "../../../common/geom";
import { chordTextSegs, harmonyInk, harmonyWidth } from "../../../engrave/chord";
import type { Region } from "../../../style/ss";
import type { JianpuStyle } from "../../../engrave/jianpustyle";
import type { ElementId, ScoreDoc } from "../../../model/doc";
import type { DocView } from "../../../jianpu/slots";
import { originalInputOf } from "../input";
import { applyBreaks } from "../../../model/breaks";
import type { InkMeasurer, InkTextRole, PlacedPage, PlacedScore } from "../place/model";
import { layoutDocument } from "../place/song";
import { foldLineStarts, naturalSpans, reflowLineStarts } from "../place/reflow";
import type { OriginalCtx } from "./ctx";
import { paintPage, systemLeft } from "./page";
import { footerSpan, layoutFooters } from "./footer";
import { headerMeasurer, paintSlideLines } from "./header";
import { placeHeader, placeSlideFooter, placeTitlePage } from "../place/header";
import { expandView } from "../place/expand";
import { playDataOfSong } from "../../../jianpu/playsong";
import type { PlayItem } from "../../../score/playorder";

/** 原样文档排版的外部配置：尺子（`style/jianpu.ts::jianpuStyleOf`，与旧简谱引擎同一份）、纸、页脚模板。 */
export interface JianpuLayoutConfig {
  readonly style: JianpuStyle;
  readonly page: GridPage;
  /** 面板上给了边距：谱面自带的 `Margin:` 不再生效（用户说了算） */
  readonly userMargins: boolean;
  readonly foot: Region | null;
  /** 已经按窄纸重新断过行（`reflowLineStarts`），不再断第二次 */
  readonly noReflow?: boolean;
  /** 内部用：连谱号、段号伸出音符起点的那一截（pt），版心左缘让出这么多再排（见 layoutJianpu 末尾） */
  readonly leftIndent?: number;
  /** 内部用：重断行之前的那份文档（缩进那一遍要从它重新断行） */
  readonly reflowSource?: ScoreDoc;
  /** 展开档：反复与多段歌词逐遍展开、一遍一页起头、逐行装满（`place/expand.ts`），只排带歌词的声部；不叠页眉、不按窄纸重断 */
  readonly expanded?: boolean;
  /** 展开档：`.jpwabc` 的 `.Layout` 分页描述 */
  readonly breakDesc?: string | null;
  /** 成书（`pdflayout/browser.ts::layoutBookDoc`）：原样档的内容，成行与纵向同展开档——照源断点成行、单行放不下才折（`foldLineStarts`），
   *  谱行占位盒紧挨着码、放不满摊开，数字共基线、增时线「-」字；不放页眉、页脚、标题页（书级装饰由整本那一层加） */
  readonly book?: boolean;
  /** 成书量宽：不折行，另给第一首的自然横向区间（`JianpuLayout.spans`，调用方先清掉换行） */
  readonly measure?: boolean;
  /** 只排谱行：不放页眉、页脚，首组贴着上边距起（帮助页的谱例片段） */
  readonly snippet?: boolean;
  /** 覆盖墨色（帮助页的谱例画在压暗的纸上），缺省取尺子的 `page.color` */
  readonly ink?: number;
}

/** 一份文档排好的原样页面与身份索引。 */
export interface JianpuLayout {
  readonly pages: Group[];
  /** 页宽高（排版坐标，即 pt）。连续长图时随内容而定。 */
  readonly width: number;
  readonly height: number;
  readonly metrics: JianpuGrid;
  /** 当前音符数字的字号（pt）。面板上的「基础字号」显示的就是它。 */
  readonly digitFontSize: number;
  readonly view: DocView;
  readonly placed: PlacedScore;
  /** 展开档各首实际走的演唱顺序（`page-check` 的 P5 按它数遍数）；原样档为 null */
  readonly plans: ReadonlyArray<readonly PlayItem[] | null> | null;
  /** 各行（每组第一个声部）首个音符的元素 id，按排出来的行序（展开档一个音每遍各出现一次，用的人自己去重）。
   *  五线谱自动铺排拿它当优选断点（`App.jianpuLineStarts`） */
  readonly lineStarts: ElementId[];
  /** `measure` 时：第一首各音（键为元素 id）的自然横向区间与版心宽 */
  readonly spans?: { width: number; spans: Map<string | number, { x0: number; x1: number; x1b?: number }> };
}

/** 排一份文档并生成全部页面（原 `PuPainter.load`）。 */
export function layoutJianpu(source: ScoreDoc, cfg: JianpuLayoutConfig): JianpuLayout {
  const input = originalInputOf(source);
  // 谱面自带的 `FontSize:` / `Margin:` 也要生效（真实语料里 `all=` 用得最多）：乘在尺子上
  const meta0 = input.songs[0]?.metadata;
  const style = applyDocOptions(cfg.style, meta0?.fontSizes ?? [], meta0?.margins ?? [], cfg.userMargins);
  const m = gridOf(style, cfg.page);
  if (cfg.leftIndent) m.page.margin.left += cfg.leftIndent;
  // 展开档、成书的谱页不叠页眉：首组贴着上边距起（同旧简谱引擎 `fromScore`）
  const slide = !!(cfg.expanded || cfg.book);
  if (slide || cfg.snippet) m.page.firstSystemTop = 0;
  // 展开档的演唱顺序：同旧简谱引擎展开档那一份（`forExpanded`：带歌词的声部在前、同号歌词顺延）
  const plays = cfg.expanded ? source.songs.map((_, i) => playDataOfSong(source, i, { forExpanded: true })) : null;
  const plans = plays ? plays.map((pd) => pd?.measures ?? null) : null;
  const c: OriginalCtx = {
    metrics: m,
    doc: input,
    placed: null,
    digitFont: new Font(m.style.font.note.family, m.style.size.note, m.style.look.noteBold),
    pageWidth: m.page.width,
    pageHeight: m.page.height,
    _pageShiftX: 0,
    ink: cfg.ink ?? style.page.color,
    lyricInk: cfg.ink ?? style.page.color,
    foot: cfg.snippet ? null : cfg.foot,
    ...(slide ? { slide: true } : {}),
  };
  // 展开档的谱页不叠页眉（标题另起一页）
  const headMeasure = headerMeasurer(m);
  c.heads = slide || cfg.snippet ? [] : input.songs.map((song) => placeHeader(song.metadata, m, headMeasure));
  const headerBottoms = c.heads.map((h) => h.bottom);
  // 量具注入给排版（它不碰字体）。歌词量的是**画出来的**那串：与 paintSyllables 同一串挤压后的笔位，
  // 首尾留白的口径同旧简谱引擎的 `Lyric.headBlank / tailBlank`（横向避让的判据从那边整段搬来，见 place/spacing.ts）
  const lyricFont = new Font(m.style.font.lyric.family, m.style.size.lyric);
  const chordWord = new Font(m.style.font.text.family, m.style.size.chord);
  const chordMusic = new Font("Bravura", m.style.size.chord);
  const roleFont: Record<InkTextRole, Font> = {
    "section-word": new Font(m.style.font.lyric.family, m.style.size.sectionWord),
    term: chordWord,
    jump: chordWord,
    "key-label": new Font(m.style.font.text.family, keyLabelSize(m)),
    ending: c.digitFont.makeWithSize(m.style.size.ending), // 同 compose/marks.ts 画房号的那个字
    words: new Font(m.style.font.text.family, m.style.size.words),
  };
  const ink: InkMeasurer = {
    lyric(syl) {
      const text = syl.text + (syl.trailingPunctuation ?? "");
      const run = syllableRun(text, lyricFont, m.style.look.punctCompress);
      const chars = [...text];
      const first = chars[0] ?? "";
      const last = chars[chars.length - 1] ?? "";
      const pen0 = run.xs?.[0] ?? 0;
      const upto = run.xs ? run.xs[chars.length - 1]! : lyricFont.measureText(text.slice(0, text.length - last.length));
      return {
        text,
        width: run.width,
        lead: run.lead,
        body: run.body,
        headBlank: first ? Math.max(0, pen0 + lyricFont.charBound(first).left) : 0,
        tailBlank: last ? Math.max(0, run.width - (upto + lyricFont.charBound(last).right)) : 0,
      };
    },
    lyricSpace: lyricFont.measureText(" "),
    digit: (ch) => ({ advance: c.digitFont.measureText(ch), ink: c.digitFont.charBound(ch) }),
    chord(text) {
      const segs = chordTextSegs(text, m.style.look.chordPlain, m.style.look.accidentalSide);
      return { advance: harmonyWidth(segs, chordWord, chordMusic), ink: harmonyInk(segs, chordWord, chordMusic) };
    },
    text: (str, role) => ({ advance: roleFont[role].measureText(str), ink: roleFont[role].charBound(str) }),
    sectionWord(str) {
      const font = roleFont["section-word"];
      const run = sectionWordRun(font, str, m.style.look.punctCompress);
      // 墨迹逐字按挤压后的笔位量：半身档下开括号「（」左挪了半格，墨落在笔位右边约半个字身处，照字面盒算左缘就差出这一截
      const chars = [...str];
      const ink = new Rect(Infinity, Infinity, -Infinity, -Infinity);
      chars.forEach((ch, i) => {
        const b = font.charBound(ch);
        const x = run.xs?.[i] ?? (i === 0 ? 0 : font.measureText(chars.slice(0, i).join("")));
        ink.left = Math.min(ink.left, x + b.left);
        ink.right = Math.max(ink.right, x + b.right);
        ink.top = Math.min(ink.top, b.top);
        ink.bottom = Math.max(ink.bottom, b.bottom);
      });
      return { advance: run.width, xs: run.xs, ink: chars.length ? ink : new Rect(0, 0, 0, 0) };
    },
    fontBox: (face) => {
      const fm = (face === "note" ? c.digitFont : lyricFont).metrics;
      return { top: fm.ascent, bottom: fm.descent };
    },
    smufl: (glyph, size) => new Font("Bravura", size).charBound(glyph),
  };
  // **源里的行放不下就整首重新断行**（用户定：原样档按排得下的位置断、中间不要短行）：断点写进文档克隆的换行位、
  // 整份重排一遍。元素 id 不变，编辑器的点选、高亮照旧对得上。多声部文本谱（各声部小节对不齐）`applyBreaks` 不重断
  // 展开档：按演唱顺序逐遍切出、逐行装满（已按版心宽断好，不再走窄纸重断）
  const doc = plays ? expandView(input, plays, m, ink, cfg.breakDesc ?? null) : input;
  c.doc = doc;
  // 成书：只折放不下的那几行，折点原位记（小节中间折的是一行里一条小节线都没有的长行）
  if (!cfg.noReflow && !cfg.measure && !plans) {
    const starts = cfg.book ? foldLineStarts(doc.songs, doc.idOf, m, ink) : reflowLineStarts(doc.songs, doc.idOf, m, ink);
    if (starts) {
      const clone = structuredClone(source);
      let changed = false;
      clone.songs.forEach((song, i) => {
        const ls = starts[i];
        if (ls && applyBreaks(song, ls.map((id) => ({ id: id as ElementId })), { mid: cfg.book ? "inline" : "source", pages: "keep" })) changed = true;
      });
      if (changed) return layoutJianpu(clone, { ...cfg, noReflow: true, reflowSource: cfg.reflowSource ?? source });
    }
  }
  const placed = layoutDocument(doc.songs, m, headerBottoms, ink, doc.songs.map((_, i) => footerSpan(c, i)), slide);
  // 展开档：每首前面一页标题页（谱页从它后面起，页码不含它；一份多首的各首各自起标题页、各自计页）
  if (plans) {
    const withTitles: PlacedPage[] = [];
    for (const pg of placed.pages) {
      if (pg.firstOfSong) withTitles.push({ groups: [], song: pg.song, firstOfSong: false, titlePage: true });
      withTitles.push(pg);
    }
    placed.pages = withTitles;
  }
  c.placed = placed;
  // **连谱号、段号也在版心里**（用户定）：音符起点贴版心左缘时它们伸进左边距、左右留白不等。
  // 量出最靠左的系统左缘（连谱号粗线另有半个线宽），版心左缘让出这一截、整份再排一遍（断行按变窄的版心重求）
  if (cfg.leftIndent === undefined && placed.pages.length > 0) {
    const thick = m.ink.noteHeight * 2.2 * 0.115; // compose/brace.ts::paintBrace 的粗线
    const inkLeft = Math.min(...placed.pages.map((p) => systemLeft(c, p) - (p.groups.some((g) => g.hasBrace) ? thick / 2 : 0)));
    const indent = m.page.margin.left - inkLeft;
    if (indent > 0.01) {
      const again = cfg.reflowSource
        ? { ...cfg, noReflow: false, reflowSource: undefined, leftIndent: indent }
        : { ...cfg, leftIndent: indent };
      return layoutJianpu(cfg.reflowSource ?? source, again);
    }
  }
  // 页脚（BL/BC/BR）：每首末页，分页贴页底、连续长图在最低一行之下。先排一遍拿到占高，连续长图的页高要把它算进去
  const footers = layoutFooters(c, 0);
  const footerBottom = Math.max(0, ...footers.map((f) => f.bottom));
  // 连续长图：页面尺寸随内容走，不受纸张尺寸约束（短曲子不该拖着一大片空白）
  if (m.page.longImage) {
    c.pageHeight = Math.max(
      m.page.margin.top + m.page.firstSystemTop,
      placed.contentBottom + m.ink.noteHeight + m.page.margin.bottom,
      footerBottom > 0 ? footerBottom + m.page.margin.bottom : 0,
    );
    // 页宽按**实际墨迹**裁紧并左右等距留白：连谱号会探进左边距，
    // 直接用 marginLeft 会左右不对称（实测 14 / 81）。
    const inkLeft = Math.min(...placed.pages.map((p) => systemLeft(c, p)));
    const inkRight =
      m.page.margin.left + placed.contentRight + m.ink.noteHeight * 0.6;
    // **纸宽固定**（用户定：长图与分页纸同宽，各曲一样宽）：墨迹那一段在纸宽里左右居中；
    // 放不下（单个小节就比版心宽）才按墨迹撑宽
    // 墨迹段本来就是「版心 + 两侧伸出的一点」，不再另加长图留白（加了就总比纸宽）
    const span = inkRight - inkLeft;
    c.pageWidth = Math.max(m.page.width, span);
    c._pageShiftX = (c.pageWidth - span) / 2 - inkLeft;
  }
  const footerItems = layoutFooters(c, c._pageShiftX);
  // 展开档各首的标题页在第几页、谱页共几页（页脚的「i/n」按各首自己计）
  const titleAt = new Map<number, number>();
  const pagesOf = new Map<number, number>();
  placed.pages.forEach((pg, i) => {
    if (pg.titlePage) titleAt.set(pg.song, i);
    else pagesOf.set(pg.song, (pagesOf.get(pg.song) ?? 0) + 1);
  });
  const pages = placed.pages.map((pg, i) => {
    const meta = doc.songs[pg.song]?.metadata;
    if (pg.titlePage) {
      const g = new Group();
      if (meta) paintSlideLines(c, g, placeTitlePage(meta, m, headMeasure), true);
      return g;
    }
    const g = paintPage(c, pg, i);
    for (const f of footerItems) if (f.page === i) for (const it of f.items) g.add(it);
    // 展开档每个谱页的页脚：曲名 + 「i/n」
    if (plans) {
      const title = (meta?.titles[0] ?? "").split("\n")[0] ?? "";
      paintSlideLines(c, g, placeSlideFooter(title, i - (titleAt.get(pg.song) ?? -1), pagesOf.get(pg.song) ?? 0, m, headMeasure), false);
    }
    g.x += c._pageShiftX;
    return g;
  });
  for (const p of pages) p.update();
  return {
    pages,
    width: c.pageWidth,
    height: c.pageHeight,
    metrics: m,
    digitFontSize: c.digitFont.size,
    view: doc,
    placed,
    plans,
    lineStarts: lineStartsOf(placed, doc.idOf),
    ...(cfg.measure && doc.songs[0] ? { spans: { width: contentWidth(m), spans: naturalSpans(doc.songs[0], doc.idOf, m, ink) } } : {}),
  };
}

/** 各行首个音符的元素 id（每组取第一个声部） */
function lineStartsOf(placed: PlacedScore, idOf: ReadonlyMap<unknown, ElementId>): ElementId[] {
  const out: ElementId[] = [];
  for (const page of placed.pages) {
    for (const g of page.groups) {
      const v = g.voices[0];
      const it = v?.items.find((x) => x.element.kind === "note" && idOf.has(x.element));
      if (it) out.push(idOf.get(it.element)!);
    }
  }
  return out;
}
