// 谱面上的**文字指示**（rit. / a tempo / cresc. / dim. / 速度语 / Fine / D.S. al Coda / unis. …）与节拍器记号：切条、算指纹、归位。
//
// 与声部标签（`stafflabel.ts`）同一套架构：**只按固定几何裁带**（两行谱之间的整段空当、页首行上方、页末行下方），
// 定位与认字交给 DBNet + rec，离线按条的内容指纹落盘（`gen-rasterwords.mjs` → `rasterwords.json`），识别时查缓存。
// 带里还压着歌词、和弦字母、力度字母、小节号——这里按内容分开：只留拉丁文的词句，歌词行、纯数字、力度字母不要。
import type { Binary, Rect } from "../omr/types";
import type { SPage, Staff } from "../staffomr/model";
import type { StaffNote } from "../staffomr/notedata";
import { CHORD_TOKEN_RE } from "../staffomr/textanalyze";
import type { RasterUnit } from "./staffline";

/** 一条文字带：裸像素 + 它在页面上的盒。 */
export interface WordStrip {
  w: number;
  h: number;
  /** 逐像素 0/1，长 `w*h`，1 = 墨。 */
  data: Uint8Array;
  box: Rect;
}

/** OCR 读出来的一行字（带内坐标）。 */
export interface WordLine {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 页首行上方、页末行下方各取这么多格；两行谱之间取整段空当，上下各让开谱线这么多格。 */
const EDGE_BAND = 7;
const LINE_CLEAR = 0.15;
/** 带的左右：谱行左缘往左这么多格（行首上方的速度语常比谱号还靠左）到右缘往右这么多格。 */
const SIDE = 2;

/**
 * 裁出各条文字带。**几何是死的**（只看谱行的盒），同一页跑几次裁出来一模一样，指纹才稳。
 */
export function findWordStrips(bin: Binary, staves: { box: { left: number; right: number; top: number; bottom: number } }[], unit: RasterUnit): WordStrip[] {
  const sp = unit.space;
  const rows = [...staves].sort((a, b) => a.box.top - b.box.top);
  const out: WordStrip[] = [];
  const cut = (y0: number, y1: number, left: number, right: number) => {
    const box = {
      x: Math.max(0, Math.round(left - sp * SIDE)),
      y: Math.max(0, Math.round(y0)),
      w: 0,
      h: 0,
    };
    box.w = Math.min(bin.w, Math.round(right + sp * SIDE)) - box.x;
    box.h = Math.min(bin.h, Math.round(y1)) - box.y;
    if (box.w < 8 || box.h < sp * 1.2) return;
    const data = new Uint8Array(box.w * box.h);
    let ink = 0;
    for (let y = 0; y < box.h; y++)
      for (let x = 0; x < box.w; x++) {
        const v = bin.data[(box.y + y) * bin.w + box.x + x];
        data[y * box.w + x] = v;
        ink += v;
      }
    if (ink) out.push({ w: box.w, h: box.h, data, box });
  };
  rows.forEach((st, i) => {
    const prev = rows[i - 1];
    // 左右并排的两行谱（同一高度）不算上下邻行
    const above = prev && prev.box.bottom < st.box.top ? prev : undefined;
    if (above) cut(above.box.bottom + sp * LINE_CLEAR, st.box.top - sp * LINE_CLEAR, Math.min(above.box.left, st.box.left), Math.max(above.box.right, st.box.right));
    else cut(st.box.top - sp * EDGE_BAND, st.box.top - sp * LINE_CLEAR, st.box.left, st.box.right);
    if (i === rows.length - 1) cut(st.box.bottom + sp * LINE_CLEAR, st.box.bottom + sp * EDGE_BAND, st.box.left, st.box.right);
  });
  return out;
}

/**
 * **页眉带**（曲首页）：页顶 → 首行谱上方文字指示带（`EDGE_BAND`）的上沿，整页宽——标题、副标题、词曲作者、译者。
 * 下沿从文字指示带上沿往上找第一条空白行（墨不过两点），免得把一行字拦腰切开；几何只看谱行与像素，指纹稳。
 * 与文字指示带同一套认字（DBNet + rec），缓存另放（`gen-rasterheader.mjs` → `rasterheader.json`）：那边只留拉丁行，这边中文也要。
 */
export function findHeaderStrip(bin: Binary, staves: { box: { top: number } }[], unit: RasterUnit): WordStrip | null {
  if (!staves.length) return null;
  const sp = unit.space;
  let y1 = Math.min(bin.h - 1, Math.round(Math.min(...staves.map((s) => s.box.top)) - sp * EDGE_BAND));
  const inkOf = (y: number) => {
    let n = 0;
    for (let x = 0; x < bin.w && n <= HEADER_BLANK; x++) n += bin.data[y * bin.w + x];
    return n;
  };
  while (y1 > 0 && inkOf(y1) > HEADER_BLANK) y1--;
  if (y1 < sp * 2) return null;
  const box = { x: 0, y: 0, w: bin.w, h: y1 };
  const data = new Uint8Array(box.w * box.h);
  let ink = 0;
  for (let i = 0; i < data.length; i++) ink += data[i] = bin.data[i];
  return ink ? { w: box.w, h: box.h, data, box } : null;
}
/** 页眉带下沿的「空白行」：一行墨不过这么多点（扫描件的零星噪点）。 */
const HEADER_BLANK = 2;

/** 页眉里值得留的行：有汉字，或有两个以上拉丁字母（页码、噪点、单个字母不要）。 */
export function keepHeaderLine(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text) || (text.match(/[A-Za-z]/g)?.length ?? 0) >= 2;
}

/** 页眉的一行（页面坐标）与它的角色（MusicXML `<credit-type>`）、对齐。 */
export interface HeaderCredit {
  text: string;
  type?: "title" | "subtitle" | "composer" | "lyricist";
  justify: "left" | "center" | "right";
  box: Rect;
}

/**
 * 页眉带读出来的行 → 页眉各条：最高的一行是标题；居中的行里与标题差不多高（八成以上）的也算标题（中英两个标题上下排），
 * 其余居中的是副标题；靠左的是作词 / 译者、靠右的是作曲（诗歌本、合唱谱的通行排法）。居中 = 行心离页心不过页宽一成半。
 */
export function headerCredits(lines: readonly WordLine[], strip: WordStrip): HeaderCredit[] {
  const ls = lines.filter((l) => keepHeaderLine(l.t)).sort((a, b) => a.y - b.y || a.x - b.x);
  if (!ls.length) return [];
  const H = Math.max(...ls.map((l) => l.h));
  const mid = strip.box.x + strip.box.w / 2;
  return ls.map((l) => {
    const cx = strip.box.x + l.x + l.w / 2;
    const justify = Math.abs(cx - mid) <= strip.box.w * 0.15 ? "center" : cx < mid ? "left" : "right";
    const type = justify === "center" ? (l.h >= H * 0.8 ? "title" : "subtitle") : justify === "left" ? "lyricist" : "composer";
    // 标题字距拉得开（「望 十 架」），按列投影补出来的空格夹在两个汉字之间的不要
    const text = l.t.trim().replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "");
    return { text, type, justify, box: { x: strip.box.x + l.x, y: strip.box.y + l.y, w: l.w, h: l.h } };
  });
}

/** 条的内容指纹（与 `stafflabel.ts::labelKey` 同一套：尺寸 + FNV-1a）。 */
export function wordKey(s: WordStrip): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.data.length; i++) {
    h1 ^= s.data[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `W${s.w}x${s.h}-${h1.toString(36)}`;
}

/** 值得存进缓存的行：有拉丁字母（力度只有一个字母），或者像节拍器记号（`= 86`）。纯中文行（歌词、署名）、纯数字不存。 */
export function keepWordLine(text: string): boolean {
  return /[A-Za-z]/.test(text) || METRO_RE.test(text);
}

/**
 * rec 不出空格：按字行的**列投影**补——行盒里连着这么宽（行高的 `WORD_GAP` 倍）没有墨的一段就是词界，
 * 空格插在这段空白右边的头一个字之前。逐字位置（`recognizeRegion` 回来的 `cx`，各字的左缘）只有六分之一行高的精度，
 * 拿相邻两字的边界间隙判词界分不开（词内 0~0.34、词间 0.33~0.5），所以只用它定「哪个字在空白右边」。
 */
export function spaceWordText(
  text: string,
  chars: { text: string; cx: number }[] | undefined,
  strip: { w: number; h: number; data: ArrayLike<number> },
  box: { x: number; y: number; w: number; h: number },
): string {
  if (!chars?.length) return text;
  const y0 = Math.max(0, Math.round(box.y));
  const y1 = Math.min(strip.h, Math.round(box.y + box.h));
  const x0 = Math.max(0, Math.round(box.x));
  const x1 = Math.min(strip.w, Math.round(box.x + box.w));
  const gaps: number[] = [];
  let run = 0;
  let seenInk = false;
  for (let x = x0; x < x1; x++) {
    let ink = false;
    for (let y = y0; y < y1 && !ink; y++) ink = strip.data[y * strip.w + x] === 1;
    if (ink) {
      if (seenInk && run >= box.h * WORD_GAP) gaps.push(x - run / 2);
      run = 0;
      seenInk = true;
    } else run++;
  }
  let out = "";
  let g = 0;
  chars.forEach((c, i) => {
    let space = false;
    while (g < gaps.length && gaps[g] < c.cx + box.h * 0.1) {
      space = i > 0;
      g++;
    }
    out += (space ? " " : "") + c.text;
  });
  return out;
}
const WORD_GAP = 0.17;

/** 力度（另有一路按字形认，`dynamics.ts`；它漏掉的由这里读出来的补）。字行以力度字母起头、后面跟着别的（歌词的头一个字）也算。 */
const DYNAMIC_RE = /^(ppp|pp|p|mp|mf|fff|ff|f|sfz|sf|fz|fp)(?![a-z])/;
/** 文字指示的术语：歌词行里夹着的字行，含这些词的才留。 */
const DIRECTION_RE = /\b(rit|rall|riten|accel|tempo|cresc|decresc|dim|poco|molto|dolce|legato|unis|unison|solo|tutti|div|sim|sub|piu|meno|mosso|espress|cantabile|sost|marc|stacc|fine|coda|segno|slower|faster|broadly|d\. ?[sc])\b/i;
/** 同一高度上有这么多段拉丁文就是一行歌词（歌词带里的门槛低一档）。 */
const LYRIC_ROW = 3;
const LYRIC_ROW_IN_ZONE = 2;
/** 和弦页的门槛：一页里至少这么多行整行是和弦记号、其中至少一行带后缀（`m7`、`/F`…），才把和弦记号从文字里分出去。 */
const CHORD_PAGE_MIN = 3;
/** 两个字母以内也算文字指示的那几样（声部缩写、管风琴键盘名）。 */
const SHORT_RE = /^(S|A|T|B|SA|TB|ST|AB|Ch|Sw|Gt)\.?$/;
/** 上下两行字叠成一条指示：左端对齐（格）、行距不过行高的这么多倍。 */
const STACK_X = 1.5;
const STACK_GAP = 0.6;
/** 节拍器记号：`♩= 86`（音符那个字形 OCR 读不出，只认等号后的数）。 */
const METRO_RE = /=\s*(\d ?\d ?\d?)(?!\d)/;
/** 一行字离它那行谱的距离上限（格）。 */
const REACH = 7;

export interface PlacedWord {
  text: string;
  above: boolean;
  box: Rect;
  note: StaffNote;
}

/**
 * 把缓存里的字行归位：定谱行（离哪行近）、定音符（字行左端右边最近的那个音）、落到 `StaffNote.words` / `metronome` 上。
 * 读出来的力度不在这里挂，交回去（`dynamics`）由调用方按力度那一路的判据补。
 *
 * @param skip 已经另有身份的文字盒（歌词行、和弦字母）：中心落在里面的行不要。
 * @param lyricZones 歌词带（切出来的歌词条，不论认没认下来）：判「这一行是英文歌词」时门槛低一档。
 */
export function attachWordLines(
  pg: SPage,
  notes: StaffNote[],
  strips: WordStrip[],
  ocr: Map<string, WordLine[]>,
  unit: RasterUnit,
  skip: Rect[],
  lyricZones: Rect[],
): { words: PlacedWord[]; dynamics: { px: number; py: number; text: string }[]; chords: { text: string; box: Rect }[] } {
  const sp = unit.space;
  const words: PlacedWord[] = [];
  const dynamics: { px: number; py: number; text: string }[] = [];
  const inside = (q: Rect, x: number, y: number) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h;
  // 先收齐各行（页面坐标），同一处被上下两条带各读一遍的只留一份
  const lines: { text: string; box: Rect }[] = [];
  for (const strip of strips)
    for (const l of ocr.get(wordKey(strip)) ?? []) {
      const box = { x: strip.box.x + l.x, y: strip.box.y + l.y, w: l.w, h: l.h };
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      if (lines.some((q) => inside(q.box, cx, cy))) continue;
      lines.push({ text: l.t.replace(/\s+/g, " ").trim(), box });
    }
  lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  // 叠着的两行并成一条（`1st time SA Unison` / `2nd time Parts`）
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i];
    const j = lines.findIndex((b, k) => k > i && Math.abs(b.box.x - a.box.x) <= sp * STACK_X && b.box.y - (a.box.y + a.box.h) <= a.box.h * STACK_GAP && b.box.y > a.box.y + a.box.h * 0.5);
    if (j < 0) continue;
    const b = lines[j];
    if (DYNAMIC_RE.test(a.text) || DYNAMIC_RE.test(b.text)) continue;
    const r = Math.max(a.box.x + a.box.w, b.box.x + b.box.w);
    a.text += "\n" + b.text;
    a.box = { x: Math.min(a.box.x, b.box.x), y: a.box.y, w: r - Math.min(a.box.x, b.box.x), h: b.box.y + b.box.h - a.box.y };
    lines.splice(j, 1);
    i--;
  }
  // 和弦记号（是爱那种谱表上方印和弦的）：整行去掉空格后正好是一个或几个和弦记号。一页里够多才认，
  // 不然单个大写字母（排练号 `A`、`B`，或者把谱号读成的字母）都成了和弦
  const chordOf = (text: string): string[] | null => {
    const toks = text.split(/\s+/).filter(Boolean);
    const whole = text.replace(/\s+/g, "");
    const full = (t: string) => (CHORD_TOKEN_RE.exec(t)?.[0].length ?? 0) === t.length;
    if (full(whole)) return [whole];
    return toks.length > 1 && toks.every(full) ? toks : null;
  };
  const chordLines = lines.filter((l) => chordOf(l.text));
  const chordPage = chordLines.length >= CHORD_PAGE_MIN && chordLines.some((l) => l.text.replace(/\s+/g, "").length > 1);
  const chords: { text: string; box: Rect }[] = [];
  for (const l of lines) {
    const box = l.box;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    let text = l.text;
    // 力度：起头那一两个字母。歌词行行首的力度会与头一个字读成一行（`mf夫`），所以先于「歌词行不要」判，位置取行首
    const dyn = DYNAMIC_RE.exec(text);
    const rest = dyn ? text.slice(dyn[0].length).trimStart() : "";
    if (dyn && (!rest || /^[\u4e00-\u9fff]/.test(rest))) {
      dynamics.push({ px: box.x + Math.min(box.w, box.h * 0.6 * dyn[0].length) / 2, py: cy, text: dyn[0] });
      continue;
    }
    if (skip.some((q) => inside(q, cx, cy))) continue;
    if (chordPage) {
      // 和弦后面跟着文字的（`G7 cresc.`）：前头的和弦摘走，剩下的照文字走
      const toks = text.split(/\s+/).filter(Boolean);
      const whole = chordOf(text);
      let n = whole ? toks.length : 0;
      // 带后缀的才算（`A tempo` 的 `A` 不是和弦）
      const isChord = (t: string) => t.length > 1 && (CHORD_TOKEN_RE.exec(t)?.[0].length ?? 0) === t.length;
      if (!whole) while (n < toks.length - 1 && isChord(toks[n])) n++;
      if (n > 0) {
        const parts = whole ?? toks.slice(0, n);
        const span = whole ? box.w : box.w * (toks.slice(0, n).join(" ").length / text.length);
        parts.forEach((t, i) => chords.push({ text: t, box: { x: box.x + (span * i) / parts.length, y: box.y, w: span / parts.length, h: box.h } }));
        if (whole) continue;
        text = toks.slice(n).join(" ");
      }
    }
    // 英文歌词：一行歌词被 DBNet 切成好几段，同一高度上排着三段以上；文字指示一行里顶多一两处。
    // 这样的行里只留含术语的（歌词行中间夹着的 `rit.`）。歌词带里的行两段就算
    const peers = lines.filter((o) => Math.abs(o.box.y + o.box.h / 2 - cy) <= box.h * 0.6 && /[A-Za-z]{2}/.test(o.text)).length;
    const crowded = peers >= (lyricZones.some((q) => inside(q, cx, cy)) ? LYRIC_ROW_IN_ZONE : LYRIC_ROW);
    // rec 偶尔给元音添上重音符（`póco`、`dím.`），术语里没有这种写法，一律去掉
    text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const term = DIRECTION_RE.exec(text);
    if (crowded && !term) continue;
    // 歌词与紧跟着的术语被框成一行（`paid so willingly poco rit.`）：从头一个术语起才是文字指示
    if (crowded && term) text = text.slice(term.index);
    // 头尾粘着的力度字母（`ff unis.`、`unis. mp`）不算在文字里
    text = text.replace(/^(?:[pmf]{1,3}|s?fz?)\s+(?=\S)/, "").replace(/\s+(?:[pmf]{1,3}|s?fz?)$/, "");
    const metro = METRO_RE.exec(text);
    if (metro) text = text.slice(0, metro.index).replace(/[\s(（♩J]+$/, "").trim();
    const letters = (text.match(/[A-Za-z]/g) ?? []).length;
    // 夹着汉字的是歌词或署名；字母太少的多半是把符头、弧线读成了字
    const isWord = !/[\u4e00-\u9fff]/.test(text) && (letters >= 3 || SHORT_RE.test(text)) && !/^[pmfsz]+$/i.test(text.replace(/[^A-Za-z]/g, ""));
    if (!isWord && !metro) continue;
    // 定谱行：上下最近的那行（按谱表边到字心的距离比）
    let stf: Staff | undefined;
    let bd = sp * REACH;
    let above = true;
    for (const st of pg.staves) {
      if (cx < st.box.left - sp * SIDE || cx > st.box.right + sp * SIDE) continue;
      const d = cy < st.box.top ? st.box.top - cy : cy > st.box.bottom ? cy - st.box.bottom : 0;
      if (d < bd) {
        bd = d;
        stf = st;
        above = cy < (st.box.top + st.box.bottom) / 2;
      }
    }
    if (!stf) continue;
    // 定音符：字行左端对着它起作用的那个音——取左端往左让一格之后、右边最近的；没有就取这一行最后一个
    const row = notes.filter((n) => n.staff === stf && !n.chordExtra && !n.grace).sort((a, b) => a.x - b.x);
    const note = row.find((n) => n.x >= box.x - sp) ?? row[row.length - 1];
    if (!note) continue;
    if (metro) note.metronome = `quarter=${metro[1].replace(/ /g, "")}`;
    if (isWord && text) {
      (note.words ??= []).push({ text, above });
      words.push({ text, above, box, note });
    }
  }
  return { words, dynamics, chords };
}
