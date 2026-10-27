// B 路（从乐谱数据重排）的浏览器侧：样式注入 + 页面树 → DrawList。
//
// **这是唯一碰 measure/DOM 的重排件**，所以不能进 out/cli（见 src/cli/index.ts 的头注释）。
// Node 侧的 scripts/rebuild.mjs 通过 window.__book 调它，拿回纯数据的 DrawPage[]，再交
// scripts/pdfwrite.mjs 出 PDF。
//
// 为什么导出 DrawList 而不是 SVG 字符串：SVG 要在 Node 侧反解嵌套 transform 与字体度量，
// 等于把 painter 再写一遍；而页面树本来就只有三种叶子（GraphicPath / GraphicLine / TextFrame），
// 照着 pagetree/walk.ts 的骨架递归扁平化一次就完事，逻辑一比一对应、不冒回归风险。
import { GraphicPath, PageItem, SmuflText, TextFrame } from "../pagetree/pageitem";
import { JpNumber, JpOctaveDot } from "../engrave/jpnumber";
import { Lyric } from "../engrave/syllable";
import type { DrawItem, DrawPage, DrawText } from "./drawlist";
import type { BookStyle } from "../style/bookstyle";
import type { StyleRole } from "../style/sheet";
import { computeStyle } from "../style/cascade";
import { THEMES } from "../style/themes";
import { walkPageItem, type ItemVisitor } from "../pagetree/walk";
import { Font } from "../pagetree/font";
import type { Direction, DirectionPart, ScoreDoc } from "../model/doc";
import { SECTION_WORD_RE } from "../model/helpers";
import { normEndingText } from "../engrave/ending";
import { loadScoreDoc } from "../model/fromxml";
import { keepFirstPart } from "../model/melodyonly";
import { clearSongBreaks } from "../model/breaks";
import { jianpuStyleOf } from "../style/jianpu";
import type { JianpuStyle } from "../engrave/jianpustyle";
import { layoutJianpu, type JianpuLayout } from "../layout/jianpu/compose";

/** 2D 仿射：[a b c d e f]，与 SVG 的 matrix(a b c d e f) 同序。 */
type Mat6 = [number, number, number, number, number, number];

/** m 之后再作用 n（即先 n 后 m 的坐标变换 = m ∘ n）。 */
function concat(m: Mat6, n: Mat6): Mat6 {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const applyX = (m: Mat6, x: number, y: number) => m[0] * x + m[2] * y + m[4];
const applyY = (m: Mat6, x: number, y: number) => m[1] * x + m[3] * y + m[5];

function matOf(it: PageItem): Mat6 {
  const a = it.matrix.mat;
  // Matrix33.mat 的排布见 common/geom.ts：[scaleX, skewX, transX, skewY, scaleY, transY, …]
  return [a[0], a[3], a[1], a[4], a[2], a[5]];
}

/** 页面树里的一个叶子该按哪个角色落字（决定字体与是否走轮廓）。
 *  用 instanceof 判，不用 classes：排版件本来就有 JpNumber / Lyric / SmuflText 这些类型。 */
/** 增时线要往上挪多少，才能让它的墨迹中心与数字的墨迹中心（＝小节线中点）齐平（按增时线自己的字量）。 */
function dashInkShiftOf(font: Font): number {
  const nb = font.charBound("1");
  const db = font.charBound("-");
  return (nb.top + nb.bottom) / 2 - (db.top + db.bottom) / 2;
}

/** 透到 `DrawText.cls` 的那几个 class（顺序即优先级）。 */
const CLS_TAGS = ["ending", "ending-line", "section-word", "key-change", "chord", "direction", "tuplet-line", "grace", "grace-line", "artic"];

function roleOfItem(it: TextFrame): StyleRole {
  // 和弦是 engrave/chord.ts 造的普通 TextFrame，只有 classes 认得出来（见那边的注释）
  if (it.classes.has("chord-music") || it.classes.has("smufl")) return "smufl";
  if (it.classes.has("chord")) return "chord";
  // 表情/跳转记号：力度记号走乐谱字体；**中文记号**（「结束句」）走歌词那档的报宋
  //（和弦那档是 Times，中文字会一路回退到魏碑上去）；西文的 `rit.`/`Fine` 仍随和弦。
  if (it.classes.has("direction")) {
    if (it instanceof SmuflText) return "smufl";
    return /[\u3400-\u9fff\uf900-\ufaff]/.test(it.text) ? "lyric" : "chord";
  }
  // 房号（1./2.）归 verseNum 那一档：字体与段号同源，**且不能算成 note**——
  // countStaffRows / measureCellsPerLine 数「占一格的音符」时会把 "1." 当成音符，
  // 一个房号就凭空多出一条谱行（010 曾因此每轮都判成折行、迭代六轮都收不住）。
  if (it.classes.has("ending")) return "verseNum";
  // 段落词（「（副歌）」）：字体与 lyric 同源，但**要认得出来**——scripts/line-check.mjs 靠这个角色
  // 检查它有没有挂出版心，混在 lyric 里就找不着了。
  if (it.classes.has("section-word")) return "sectionWord";
  if (it instanceof SmuflText) return "smufl";
  if (it instanceof JpNumber || it instanceof JpOctaveDot) return "note";
  if (it instanceof Lyric) return "lyric";
  // 成书页上没有标题、署名（整本那一层排），剩下的文字（段号等）都随歌词
  return "lyric";
}

/** 简谱引擎排的成书页：文字叶子的角色（`pageItemsToDrawPage` 的 `roleOf`）。 */
export const bookRoleOf = (it: TextFrame): StyleRole =>
  // 段号（`1.`，`compose/lyric.ts::paintLyricAnnotations`）：引擎按西文字（`font.text`）量宽、右对齐到首字，落笔也得是那个字——
  // 归 `verseNum`（成书样式里是 Times），随歌词的话 PDF 换成报宋，宽度对不上、伸出版心
  it.classes.size === 0 && !(it instanceof Lyric) && /^\d+\.$/.test(it.text) ? "verseNum" : roleOfItem(it);

export interface ToDrawOptions {
  style?: BookStyle;
  /** 文字叶子该按哪个角色落字。给了就不走 `roleOfItem`（混排按字体族定角色，见 pdflayout/songbook.ts）。 */
  roleOf?: (it: TextFrame) => string;
  pageNo: number;
  meta: DrawPage["meta"];
  /** 页面树的坐标单位 → pt 的缩放（排版用 px，成书要 pt）。 */
  scale?: number;
  /** 整页平移（pt）。成书首页要给标题块让出位置——**在这里平移**，
   *  而不是回头去改 DrawList：路径的坐标已经烘进 `d` 里，事后平移得重解析一遍。 */
  offset?: { x: number; y: number };
}

/** 页面树 → 扁平 DrawList。展开 matrix、逐字实测笔位、颜色照抄。 */
export function pageItemsToDrawPage(root: PageItem | undefined, w: number, h: number, o: ToDrawOptions): DrawPage {
  const items: DrawItem[] = [];
  const k = o.scale ?? 1;
  const off = o.offset ?? { x: 0, y: 0 };
  const base: Mat6 = [k, 0, 0, k, off.x, off.y];

  const visitor: ItemVisitor<Mat6> = {
    descend: (it, parent) => concat(parent, matOf(it)),
    path: (it, m) => {
      const d = pathData(it, m);
      if (d) {
        const pcls = CLS_TAGS.find((c) => it.classes.has(c));
        items.push({ t: "path", d, fill: it.fill ? argbToRgb(it.fillColor) : null, stroke: it.stroke ? argbToRgb(it.strokeColor) : null, sw: it.stroke ? it.strokeWidth * scaleOf(m) : 0, ...(pcls ? { cls: pcls } : {}) });
      }
    },
    line: (it, m) => {
      const lcls = CLS_TAGS.find((c) => it.classes.has(c));
      items.push({
        t: "line",
        x1: applyX(m, it.p0.x, it.p0.y),
        y1: applyY(m, it.p0.x, it.p0.y),
        x2: applyX(m, it.p1.x, it.p1.y),
        y2: applyY(m, it.p1.x, it.p1.y),
        sw: it.strokeWidth * scaleOf(m),
        color: argbToRgb(it.strokeColor),
        ...(lcls ? { cls: lcls } : {}),
      });
    },
    text: (it, m) => {
      if (!it.text) return;
      const chars = [...it.text];
      // 逐字笔位用**浏览器实测的 advance 前缀和**：落位就是排版器排的那一版，
      // Node 侧字体度量的微差不再影响布局。
      // 歌词带**标点挤压**（`TextFrame.charXs`）时用排版期量好的那串坐标——
      // 挤压是排版的账，PDF 那头只管照着落笔，不必自己再 shaping 一遍。
      // 前缀以空格结尾时 SVG 量宽会把尾部空格去掉，空格后那个字就落在空格上
      //（《我心等候祢》楷体引言「呼求， 听我」印成「呼求，听 我」）：尾部空白单独量了补上。
      const prefixX = (i: number): number => {
        const prefix = chars.slice(0, i).join("");
        const trail = /\s+$/.exec(prefix)?.[0];
        return trail && trail.length < prefix.length ? it.font.measureText(prefix) + it.font.measureText(trail) : it.font.measureText(prefix);
      };
      const xs =
        it.charXs && it.charXs.length === chars.length
          ? it.charXs.map((cx) => applyX(m, cx, 0))
          : chars.map((_, i) => applyX(m, prefixX(i), 0));
      // 增时线**按墨迹与数字（以及小节线中点）对齐**：Times 的连字符墨迹挂得比数字中线低
      //（实测差 1.37pt），照字体基线摆就一排音符里高一道低一道。
      // 只在**画的时候**补这一下——排版度量（entry 高度、纵向栅格、行容量）不能动，
      // 那是「简谱纵向栅格」那把统一的尺子。
      const role0 = (o.roleOf ? o.roleOf(it) : roleOfItem(it)) as StyleRole;
      const dash = role0 === "note" && (it.text === "-" || it.text === "\u2013");
      // 语义标记：**只给 scripts/line-check.mjs 用**，不参与度量。房号与段号同归 verseNum、
      // 转调标记混在 lyric 里，光看 role 分不开（见 DrawText.cls）。
      const cls = CLS_TAGS.find((c) => it.classes.has(c));
      const dy = dash && it.font ? dashInkShiftOf(it.font) : 0;
      const y = applyY(m, 0, 0);
      const t: DrawText = {
        t: "text",
        y,
        ...(dy ? { dy } : {}),
        text: it.text,
        size: (it.font?.size ?? 10) * scaleOf(m),
        role: role0,
        // **表情/跳转记号整段自然排**（`left`），不逐字按笔位落。
        // 逐字笔位是浏览器量的 advance 前缀和，而 PDF 里嵌的字体 advance 与它有微差——
        // 单字符的和弦、音符看不出来，`D.C. al Coda` 这种带空格的多字词就被摆成了
        // 「D.C.a lC oda」。这一类交给 pdfwrite 用**它自己的字体度量**连排。
        align: cls === "direction" ? "left" : "pen",
        xs,
        color: argbToRgb(it.color),
        ...(cls ? { cls } : {}),
        // SMuFL 字形的真实墨迹上缘（`SmuflText.bound` 已经是页面坐标，见那儿的注释）
        ...(it instanceof SmuflText ? { inkTop: it.bound.top * scaleOf(m) } : {}),
      };
      items.push(t);
    },
  };

  if (root) walkPageItem(root, base, visitor);
  return { pageNo: o.pageNo, w: w * k, h: h * k, meta: o.meta, items };
}

/** 等比缩放系数（页面树里只有平移与等比缩放，见 layout.ts 的 SmuflText / harmony）。 */
function scaleOf(m: Mat6): number {
  return Math.hypot(m[0], m[1]) || 1;
}

function argbToRgb(argb: number): number {
  return argb & 0xffffff;
}

/** GraphicPath 的 segs → 变换后的 SVG path（坐标烘进去，DrawPath 不带 transform）。 */
function pathData(p: GraphicPath, m: Mat6): string {
  let d = "";
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  for (const seg of p.segs) {
    if (seg.op === "Z") {
      d += "Z";
      continue;
    }
    const pts: string[] = [];
    for (let i = 0; i + 1 < seg.pts.length; i += 2) {
      pts.push(`${f(applyX(m, seg.pts[i], seg.pts[i + 1]))} ${f(applyY(m, seg.pts[i], seg.pts[i + 1]))}`);
    }
    d += `${seg.op}${pts.join(" ")}`;
  }
  return d;
}

/** 占一格的音符：数字（含**带附点的** `5·`、休止 `0`）与增时线。
 *  八度点（`.`）也是 note 角色，但它在音符上/下方、自成一「行」，不能算格。
 *  **附点必须算进来**——漏掉它会把容量少算三成（012《主我感激祢》量出 15 格、实际放得下 22）。 */
const isCellNote = (t: string): boolean => /^[0-9]/.test(t) || t === "-" || t === "\u2013";

/** 数一份 DrawList 里有几条谱行（按音符的基线分组；只数占一格的数字与增时线）。
 *  **要按页分组**：各页的谱行落在同样几条基线上，把全书的 y 混进一个集合，
 *  第二页起的行就被当成第一页那几行、行数少算（rebuild 的「有没有被二次折行」保险因此漏判）。 */
export function countStaffRows(pages: DrawPage[]): number {
  let n = 0;
  for (const p of pages) {
    const ys = new Set<number>();
    for (const it of p.items)
      // 倚音不占格（`cls === "grace"`，见 layout.ts::addGraceNotes）
      if (it.t === "text" && it.role === "note" && it.cls !== "grace" && isCellNote(it.text)) ys.add(Math.round(it.y));
    n += ys.size;
  }
  return n;
}

/** 一份 DrawList 里**最长的那条谱行**有几格。
 *  容量（`measureCellsPerLine`）是空排量出来的近似，同样的格数、歌词字多的行就更宽；
 *  量偏了排版器会在断点之外又折一刀。折完之后**最长的那条行**才是这一首的真容量，
 *  rebuild 的重排迭代拿它当新的格数上限（按比例收紧会一步收过头：022 曾从 30 收到 15）。 */
export function maxStaffRowCells(pages: DrawPage[]): number {
  let mx = 0;
  for (const p of pages) {
    const per = new Map<number, number>();
    for (const it of p.items) {
      if (it.t !== "text" || it.role !== "note" || it.cls === "grace" || !isCellNote(it.text)) continue;
      const k = Math.round(it.y);
      per.set(k, (per.get(k) ?? 0) + 1);
    }
    for (const v of per.values()) mx = Math.max(mx, v);
  }
  return mx;
}

// ───────────────── 成书 ─────────────────

/** 成书读谱：MusicXML → 文档，只留第一首、第一个声部（主旋律）。 */
export function bookDocOf(xml: string): ScoreDoc {
  const doc = loadScoreDoc(xml);
  doc.songs = doc.songs.slice(0, 1);
  for (const song of doc.songs) {
    keepFirstPart(song);
    // 谱里自带的段落词文字（「（副歌）」）不印：成书的段落词只认书级元数据（`putSectionWords`），同旧简谱引擎 `jianpuinput.ts::directionMarks` 的认法
    for (const part of song.parts) for (const m of part.measures) if (m.directions) m.directions = m.directions.flatMap(dropSectionWords);
    // 歌词字前印的段号（MusicXML 把「1.」写进首字）去掉：段号由引擎按行挂（同旧简谱引擎 `ignoreVerseNumber`）
    for (const part of song.parts) for (const m of part.measures) for (const el of m.elements) {
      if (el.kind !== "chord") continue;
      for (const l of el.lyrics ?? []) {
        const at = l.text.search(/[^0-9.]/);
        if (at > 0) l.text = l.text.slice(at);
      }
    }
    // 房号规整成 `1.2`（原书口径，同旧简谱引擎；原样档照原文印）
    for (const part of song.parts) for (const m of part.measures) for (const b of m.barlines ?? []) if (b.ending?.text) b.ending.text = normEndingText(b.ending.text);
  }
  return doc;
}

/** 一条 `<direction>` 去掉段落词文字（与只有标点的文字）之后剩下的（没剩就整条不要） */
function dropSectionWords(d: Direction): Direction[] {
  const isWord = (p: DirectionPart): boolean => {
    if (p.type !== "words") return false;
    const t = (p.text ?? "").trim();
    const bare = t.replace(/^[（(]\s*/, "").replace(/\s*[）)]$/, "");
    // 只剩标点的（「(副歌)」拆成「(」与「副歌)」两条 `<words>`，006）也不要：同 `jianpuinput.ts::directionMarks`
    return SECTION_WORD_RE.test(t) || SECTION_WORD_RE.test(bare) || !/[\p{L}\p{N}]/u.test(t);
  };
  const more = (d.more ?? []).filter((p) => !isWord(p));
  let out: Direction;
  if (!isWord(d)) out = { ...d };
  else {
    const head = more.shift();
    if (!head) return [];
    // 头一项换成剩下的第一项：子元素那几个字段整套换掉（不留被删那条文字的 text）
    out = { ...d, type: head.type };
    for (const k of ["text", "tempo", "spanType", "wedgeType", "line"] as const) delete out[k];
    Object.assign(out, head);
  }
  if (more.length) out.more = more;
  else delete out.more;
  return [out];
}

/**
 * 成书这一路排一首（简谱引擎）：按 BookStyle 排到宽 `style.page.w`、高 `pageH` 的纸上，没有标题页（书级装饰由整本那一层加）。
 * 断点由调用方先写进 `doc`（`applyPhraseBreaksToDoc`）；单行放不下引擎自己折。`naturalH` 是首页谱行自然叠起来的高（半页起排、紧排用）。
 */
export function layoutBookDoc(doc: ScoreDoc, style: BookStyle, pageH: number, measure = false): JianpuLayout & { naturalH: number } {
  const r = layoutJianpu(doc, {
    style: bookStyleOf(style),
    page: { width: style.page.w, height: pageH, continuous: false },
    userMargins: false,
    foot: null,
    book: true,
    measure,
  });
  return Object.assign(r, { naturalH: r.placed.pages[0]?.natural ?? 0 });
}

/** 成书这一路的尺子（简谱引擎吃的那份 `JianpuStyle`；dev 的 style-snapshot 快照它）。 */
export function bookStyleOf(style: BookStyle): JianpuStyle {
  return jianpuStyleOf(computeStyle([THEMES.book, [{ set: { book: style } }]], { engine: "book" }));
}

/** 真实坐标量一遍（同 `measureChordSpans`）：清掉原谱的换行、整首不折，量每个音（键为元素 id）的自然横向区间与版心宽。 */
export function measureBookSpans(doc: ScoreDoc, style: BookStyle): { width: number; spans: Map<string | number, { x0: number; x1: number; x1b?: number }> } {
  for (const song of doc.songs) clearSongBreaks(song);
  return layoutBookDoc(doc, style, style.page.h, true).spans ?? { width: 0, spans: new Map() };
}

/** 空排一遍量「一行放得下几格」（同 `measureCellsPerLine`：清掉原谱换行、按宽度塞满折行，装得最多的那一行就是容量）。 */
export function bookCellsPerLine(doc: ScoreDoc, style: BookStyle): number {
  for (const song of doc.songs) clearSongBreaks(song);
  const r = layoutBookDoc(doc, style, style.page.h);
  const dps = r.pages.map((g, i) => pageItemsToDrawPage(g, style.page.w, style.page.h, { style, roleOf: bookRoleOf, pageNo: i + 1, meta: { kind: "score", songs: [] } }));
  const cells = maxStaffRowCells(dps);
  const m = r.metrics;
  const cw = m.page.width - m.page.margin.left - m.page.margin.right;
  return Math.max(6, cells || Math.floor(cw / new Font(m.style.font.lyric.family, m.style.size.lyric).measureText("国")));
}
