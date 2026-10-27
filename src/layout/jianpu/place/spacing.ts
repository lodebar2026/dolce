// 横向排列：同一拍位的符号归成一列，列宽按内容定，再做歌词避让与两端对齐，解出每个符号的最终 x。
//
// 单声部、多声部同一份代码。判据整段搬自旧简谱引擎（`layout.ts::Line.calcXPos` 的紧排与歌词避让、
// `Line.adjust` 的水位法两端对齐、`adjustLastBarline`），那边的阈值与注释里的曲例都是对过原书的；
// 这里只是把「一个条目」换成「一列」：列的左右占位取各声部里最大的那个，歌词按声部各自避让。
//
// 锚点 x 是数字**墨迹中心**（compose 按墨迹居中落笔）；占位按数字**字面宽**算（同旧简谱引擎 `entryWidth`），
// 所以列的左占位 = 锚点到落笔原点（墨迹中心偏移），右占位 = 字面宽 − 它（+ 附点占位）。
import { jpTremoloCount, jpTremoloStrokes } from "../../../engrave/jptremolo";
import { jpSlideArrow, jpSlideOf } from "../../../engrave/jpslide";
import type { BarlineElement, Meter, NoteElement } from "../../../jianpu/ast";
import { barlineSpan, jianpuGraceMetrics, jianpuGraceNotes, type JianpuGrid } from "../metrics";
import { latinWordBreak } from "../../../engrave/syllable";
import { graceAdvance } from "../../../engrave/grace";
import { ACCIDENTAL_CLEARANCE } from "../../../engrave/accidental";
import { BarlineGlyph } from "../../../engrave/barline";
import { timeSigWidth } from "../../../engrave/timesig";
import { fanqieBarlineSpec } from "../barspec";
import { BARLINE_MARKS } from "../../../engrave/jpglyph";
import type { InkMeasurer, PlacedItem } from "./model";
import { accidentalLeadOf } from "./vertical";
import { type ChordSpan, lineStartIndex, sectionWordLines, sectionWordOf, sectionWordSlot, widestLine } from "./sectionword";

/** 一列：同一拍位（或同一条小节线）上各声部的符号。 */
interface Column {
  /** 各声部落在这一列的符号（`v` = 第几个声部） */
  members: Array<{ it: PlacedItem; v: number }>;
  /** 小节线那一列 */
  bar: boolean;
  /** 锚点到占位左缘 / 右缘 */
  left: number;
  right: number;
  /** 占位之前硬让出的地方：前倚音（旧简谱引擎 `Entry.leadSpace`）、小节线前那一小格 */
  lead: number;
  /** 临时记号伸到数字左边那一截再加一道空：紧排时硬让（与前倚音 `lead` 取大者）；旧简谱引擎那边是软让位（`Entry.leadWant`） */
  want: number;
  /** 临时记号伸出落笔原点左边多少（行首那一列要整个让出来：旧简谱引擎行首贴的是条目最左的内容） */
  over: number;
  /** 占位之后硬让出的地方（`&sbf` 连谱号、`{dsb}` 花括号，见 `voice.ts::layoutVoiceLine`） */
  pad: number;
}

/** 行中转拍：拍号前后各留的那一格 ÷ 音符字号（同旧简谱引擎 `TimeSig`：「拍号前后要有间距」）。 */
export const TIME_SIG_PAD_EM = 1 / 4;

/**
 * 小节线的占位（相对锚点的左右），口径同旧简谱引擎：那边小节线条目的占位是组的包围盒——竖线的盒从线心起、宽一个线宽，
 * 反复点按墨迹。compose/barline.ts 把 `BarlineGlyph` 居中于锚点画（原点 = 锚点 − 宽/2）。
 * 另给出线前那一小格要按的「组里第一个图元的高」（普通线是线高，`:‖` 先画点，是点径）。隐藏线 null。
 */
export function barlineBox(el: BarlineElement, m: JianpuGrid): { left: number; right: number; first: number } | null {
  const bs = fanqieBarlineSpec(el);
  if (!bs) return null;
  const span = barlineSpan(m);
  const g = new BarlineGlyph(bs.spec, bs.final, {
    top: span.top,
    bot: span.bottom,
    light: m.style.stroke.barline,
    heavy: m.style.stroke.finalBarline,
    dotRadius: m.style.dot.repeat,
    color: 0,
  });
  const first = g.lines[0];
  const last = g.lines[g.lines.length - 1];
  if (!first || !last) return null;
  const r = m.style.dot.repeat;
  const lo = bs.spec.repeatBackward ? 0 : first.x;
  const hi = bs.spec.repeatForward ? g.width + 2 * r : last.x + last.strokeWidth;
  return { left: g.width / 2 - lo, right: hi - g.width / 2, first: bs.spec.repeatBackward ? 2 * r : span.bottom - span.top };
}

/** 小节线第一根、最后一根竖线的线心（相对锚点）：房号竖脚对齐线位（`band.ts` / `marks.ts`，同旧简谱引擎 `Line.endingSpan`）。隐藏线 null。 */
export function barlineLines(el: BarlineElement, m: JianpuGrid): { first: number; last: number } | null {
  const bs = fanqieBarlineSpec(el);
  if (!bs) return null;
  const span = barlineSpan(m);
  const g = new BarlineGlyph(bs.spec, bs.final, {
    top: span.top,
    bot: span.bottom,
    light: m.style.stroke.barline,
    heavy: m.style.stroke.finalBarline,
    dotRadius: m.style.dot.repeat,
    color: 0,
  });
  const first = g.lines[0];
  const last = g.lines[g.lines.length - 1];
  if (!first || !last) return null;
  return { first: first.x - g.width / 2, last: last.x - g.width / 2 };
}

/** 行中转拍的拍号占位（含前后两格），与 compose/barline.ts 画的同一个宽。 */
export function meterAdvance(meter: Meter, m: JianpuGrid): number {
  const pad = m.style.size.note * TIME_SIG_PAD_EM;
  return pad + timeSigWidth(meter.numerator, meter.denominator, m.style.vertical.barlineHeight) + pad;
}

/** 一个符号的占位（相对锚点），口径见文件头。 */
/** 多小节休止那道横杠的宽（数字墨迹高的倍数） */
export const MULTI_REST_WIDTH = 3.2;

function itemBox(it: PlacedItem, m: JianpuGrid, ink: InkMeasurer): { left: number; right: number; lead: number; want: number; over: number } {
  const el = it.element;
  if (el.kind === "barline") {
    const meter = el.temporaryMeter ? meterAdvance(el.temporaryMeter, m) : 0;
    const b = barlineBox(el, m);
    if (!b) return { left: 0, right: meter, lead: 0, want: 0, over: 0 };
    // 小节线前空一小格：旧简谱引擎是「条目项高度的 1/5」，条目项是组里第一个图元。照搬，两边才对得上。
    // 旧简谱引擎的拍号是小节线后的单独一个条目，那条线前面不空这一格
    return { left: b.left, right: b.right + meter, lead: el.temporaryMeter ? 0 : b.first / 5, want: 0, over: 0 };
  }
  const ch = el.kind === "sustain" ? "-" : (el as NoteElement).sound === "rhythm" ? "X" : String((el as NoteElement).pitch);
  const d = ink.digit(ch);
  const center = (d.ink.left + d.ink.right) / 2;
  let right = d.advance - center;
  let lead = 0;
  let want = 0;
  let over = 0;
  // 多小节休止：一道粗横杠（compose/note.ts::paintMultiRest），宽 MULTI_REST_WIDTH 个数字墨迹高，落笔点在中间
  if (el.kind === "note" && el.multiRest) {
    const half = (m.ink.noteHeight * MULTI_REST_WIDTH) / 2;
    return { left: half, right: half + (d.advance - (d.ink.right - d.ink.left)) / 2, lead: 0, want: 0, over: 0 };
  }
  if (el.kind === "note") {
    // 附点是画上去的圆，占位照旧按 `·` 的字面宽留（同旧简谱引擎 `JpNumber.augDotAdvance`）
    if (el.dots > 0) right += ink.digit("·").advance * el.dots;
    // 震音号记在右下角、附点之后（`engrave/jptremolo.ts`）
    const trem = jpTremoloCount(el.ornaments.map((o) => o.name));
    if (trem > 0 && !el.hidden) right += jpTremoloStrokes(trem, m.ink.noteHeight).width;
    // 滑音箭头记在数字（连同附点）右侧偏上（`engrave/jpslide.ts`）；尽量少占：只补出伸出字面宽之外的那截
    const slide = jpSlideOf(el.ornaments.map((o) => o.name));
    if (slide && !el.hidden) {
      const inkEnd = d.ink.right - center + (el.dots > 0 ? ink.digit("·").advance * el.dots : 0);
      right = Math.max(right, inkEnd + jpSlideArrow(slide === "up", m.ink.noteHeight).width);
    }
    if (el.graceBefore.length > 0) lead = graceAdvance(jianpuGraceNotes(el.graceBefore), jianpuGraceMetrics(m));
    if (el.graceAfter.length > 0) right += graceAdvance(jianpuGraceNotes(el.graceAfter), jianpuGraceMetrics(m));
    // 临时记号软让位：伸出落笔原点左边多少、再多留一道空（`NoteEntry.addAccidental`）；`classic`（成书照原书）不让
    const lead0 = accidentalLeadOf(el, m);
    if (lead0 > 0 && m.style.look.accidentalStyle !== "classic") {
      const h = m.ink.noteHeight;
      over = Math.max(0, lead0 - d.ink.left);
      want = over + h * ACCIDENTAL_CLEARANCE;
    }
  }
  return { left: center, right, lead, want, over };
}

/** 各声部的符号按「小节:拍位」归列（小节线按「第几条」），列按先后排好。键法同旧的多声部对齐。 */
/** 参加归列的一行：各声部的主行，外加同一谱表第二声部的并排下行（`barBase` = 它从主行第几小节起）。 */
export interface SpacedLine {
  items: PlacedItem[];
  pad: number[];
  barBase?: number;
}

function columnsOf(lines: ReadonlyArray<SpacedLine>, m: JianpuGrid, ink: InkMeasurer): Column[] {
  const byKey = new Map<string, { bar: number; beat: number; occ: number; col: Column }>();
  lines.forEach((l, v) => {
    let bar = l.barBase ?? 0;
    const seen = new Map<string, number>();
    l.items.forEach((it, i) => {
      const isBar = it.element.kind === "barline";
      const beat = isBar ? Infinity : Math.round(it.beat * 1e4) / 1e4;
      const base = `${bar}:${beat}`;
      const occ = seen.get(base) ?? 0;
      seen.set(base, occ + 1);
      const key = `${base}:${occ}`;
      let e = byKey.get(key);
      if (!e) {
        e = { bar, beat, occ, col: { members: [], bar: isBar, left: 0, right: 0, lead: 0, want: 0, over: 0, pad: 0 } };
        byKey.set(key, e);
      }
      const b = itemBox(it, m, ink);
      const c = e.col;
      c.members.push({ it, v });
      c.left = Math.max(c.left, b.left);
      c.right = Math.max(c.right, b.right);
      c.lead = Math.max(c.lead, b.lead);
      c.want = Math.max(c.want, b.want);
      c.over = Math.max(c.over, b.over);
      c.pad = Math.max(c.pad, l.pad[i] ?? 0);
      if (isBar) bar += 1;
    });
  });
  return [...byKey.values()]
    .sort((a, b) => a.bar - b.bar || a.beat - b.beat || a.occ - b.occ)
    .map((e) => e.col);
}

/** 紧排 + 歌词避让后的列锚点（还没两端对齐），以及每列歌词伸到的最右处。 */
function packColumns(cols: readonly Column[], voices: number, m: JianpuGrid, ink: InkMeasurer): { X: number[]; lyricRight: number[]; lyricLeft: number[] } {
  const gap = m.style.spacing.lyricGap;
  // 紧排：落笔原点挨着上一列的占位右缘（+ 硬让位）；行首那一列的倚音、临时记号整个让出来
  const N: number[] = [];
  let cur = 0;
  // 临时记号**硬**让位（伸出 + 一道空，`want`）：软让位只在两端对齐有余量时才填，行一挤满升降号就压到前面的音与小节线上
  //（原样分页《同一首歌》）。旧简谱引擎那边仍是软的（硬让会把 .jpwabc 定死的行挤折）；这边放不下由重断行收
  cols.forEach((c, i) => {
    cur += i === 0 ? Math.max(c.lead, c.over) : Math.max(c.lead, c.want);
    N.push(cur + c.left);
    cur = N[i]! + c.right + c.pad;
  });
  // 歌词避让：各声部各自一道游标（同 `Line.calcXPos` 的第二遍）。各段一起算——叠排时一个音符底下摞着好几段，
  // 取各段里最靠左的左缘、最靠右的右缘；推开一列，后面的列整体跟着右移
  const X: number[] = [];
  const lyricRight: number[] = cols.map(() => -Infinity);
  const lyricLeft: number[] = cols.map(() => Infinity);
  // 游标从行首起（0）：行首那个字的左缘也不出行首
  const state = Array.from({ length: voices }, () => ({ curX: 0, prevBlank: 0, prevLatin: [] as string[] }));
  let offset = 0;
  cols.forEach((c, ci) => {
    let x = N[ci]! + offset;
    const runs = new Map<number, ReturnType<InkMeasurer["lyric"]>[]>();
    c.members.forEach(({ it, v }) => {
      const rs = it.syllables.filter((s) => s !== null && s.text.length > 0).map((s) => ink.lyric(s!));
      if (rs.length) runs.set(v, rs);
    });
    for (const [v, rs] of runs) {
      const st = state[v]!;
      // **前置标点悬挂**：`“凡` 这种带前引号的字，避让只看主体，让引号伸进左边的空档里；
      // 悬挂多少由墨迹说了算（标点挤压），且只许吃掉字与字之间那道呼吸（`hang ≤ lyricGap`）。
      // 判据与曲例（190 首、376《将心给我》）见 `layout.ts::Line.calcXPos`
      const room = st.prevBlank + gap + Math.min(...rs.map((r) => r.headBlank));
      const hang = Math.max(0, Math.min(Math.min(...rs.map((r) => r.lead)), room, gap));
      const leftMost = Math.min(...rs.map((r) => -(r.lead + r.body / 2))) + hang;
      // 西文的词与词之间要留一个空格（`love, and joy?` 照中文挨排就成了 `love,andjoy?`）
      const wordGap = rs.some((r, k) => latinWordBreak(st.prevLatin[k] ?? st.prevLatin[0] ?? "", r.text)) ? ink.lyricSpace : 0;
      x = Math.max(x, st.curX + wordGap - leftMost);
    }
    offset = x - N[ci]!;
    X.push(x);
    for (const [v, rs] of runs) {
      const st = state[v]!;
      const rightMost = Math.max(...rs.map((r) => r.width - r.lead - r.body / 2));
      st.curX = x + rightMost + gap;
      // 各段里**留白最少**的那一段说了算（有一段挤不下就是挤不下）
      st.prevBlank = Math.min(...rs.map((r) => r.tailBlank));
      st.prevLatin = rs.map((r) => r.text);
      lyricRight[ci] = Math.max(lyricRight[ci]!, x + rightMost);
      lyricLeft[ci] = Math.min(lyricLeft[ci]!, x + Math.min(...rs.map((r) => -(r.lead + r.body / 2))));
    }
  });
  return { X, lyricRight, lyricLeft };
}

/**
 * 水位法两端对齐（`Line.adjust`）：把 `extra` 摊进各列之间的空档，空档按「已有宽 ÷ 权重」从窄到宽依次灌平。
 * 权重：音符到音符 2，挨着小节线的 1。临时记号的让位已在紧排里硬留（packColumns），这里不再另算。
 */
function justify(cols: readonly Column[], X: number[], extra: number): void {
  const infos: Array<{ i: number; dist: number; rate: number }> = [];
  for (let i = 0; i + 1 < cols.length; i++) {
    const a = cols[i]!;
    const b = cols[i + 1]!;
    const dist = X[i + 1]! - b.left - (X[i]! + a.right);
    infos.push({ i, dist, rate: !a.bar && !b.bar ? 2 : 1 });
  }
  infos.sort((p, q) => {
    const diff = p.dist * q.rate - q.dist * p.rate;
    return diff < 0 ? -1 : diff > 0 ? 1 : p.rate - q.rate;
  });
  let totalDist = 0;
  let totalRate = 0;
  let end = 0;
  for (; end < infos.length; end++) {
    const it = infos[end]!;
    const share = (extra + totalDist + it.dist) / (totalRate + it.rate);
    if (share < it.dist / it.rate) break;
    totalDist += it.dist;
    totalRate += it.rate;
  }
  if (totalRate === 0) return;
  const share = (extra + totalDist) / totalRate;
  const add = new Array<number>(cols.length).fill(0);
  for (let k = 0; k < end; k++) {
    const it = infos[k]!;
    add[it.i] = share * it.rate - it.dist;
  }
  let offset = 0;
  for (let i = 0; i < cols.length; i++) {
    X[i] = X[i]! + offset;
    offset += add[i]!;
  }
}

/**
 * 一组（system）各声部的横向排列：归列 → 紧排 → 歌词避让 → 两端对齐，写回每个符号的 `x` 与 `advance`。
 *
 * `width` 是这一行能用的宽（占位右缘最多到这里）。每行都两端对齐，末行也一样；往空档里加的总量最多是
 * 自然宽的 `maxHorizontalScale` 倍（同旧简谱引擎，短行因此不会被扯得满行都是）。放不下不压缩（紧排已是最紧），
 * 由窄纸重断行（`reflow.ts`）保证放得下。
 * 返回自然宽（占位右缘，含歌词）。
 */
export function placeColumns(
  lines: ReadonlyArray<SpacedLine>,
  m: JianpuGrid,
  ink: InkMeasurer,
  width: number,
): number {
  const cols = columnsOf(lines, m, ink);
  if (cols.length === 0) return 0;
  const { X, lyricRight } = packColumns(cols, lines.length, m, ink);
  // 行右缘：从末列往回，到最后一个带歌词的列为止，取占位与歌词右缘里最靠右的（同 `Line.adjust`）
  const rightOf = (): number => {
    let r = 0;
    for (let i = cols.length - 1; i >= 0; i--) {
      r = Math.max(r, X[i]! + cols[i]!.right, lyricRight[i]!);
      if (lyricRight[i]! > -Infinity) break;
    }
    return r;
  };
  // 往空档里加的总量最多是自然宽的 `maxHorizontalScale` 倍
  const extraOf = (r: number): { extra: number; capped: boolean } => {
    const cap = m.style.spacing.maxHorizontalScale * r;
    return width - r > cap ? { extra: cap, capped: true } : { extra: width - r, capped: false };
  };
  const justified = (xs: number[]): void => {
    const r = rightOf();
    if (width > r) justify(cols, xs, extraOf(r).extra);
  };
  const words = new SectionWordRoom(lines, cols, m, ink, width);
  words.spread(X, lyricRight, rightOf, justified);
  new BarEndRoom(lines, cols, m, ink, width).spread(X, lyricRight, rightOf, justified);
  const right = rightOf();
  if (width > right) {
    const { extra, capped } = extraOf(right);
    justify(cols, X, extra);
    // 末一条小节线贴到版心右缘（`Line.adjustLastBarline`）：离前一个音最多三个字号
    const n = cols.length;
    if (!capped && n >= 2 && cols[n - 1]!.bar && !cols[n - 2]!.bar) {
      const last = cols[n - 1]!;
      const prev = cols[n - 2]!;
      const dx = X[n - 1]! - last.left - (X[n - 2]! + prev.right);
      const space = width - (X[n - 1]! + last.right);
      if (space > 0) X[n - 1] = X[n - 1]! + Math.max(0, Math.min(space, m.style.size.note * 3 - dx));
    }
  }
  words.nudge(X);
  cols.forEach((c, i) => {
    for (const { it } of c.members) {
      it.x = X[i]!;
      it.advance = i + 1 < cols.length ? X[i + 1]! - X[i]! : c.right;
    }
  });
  return right;
}

/**
 * 段落词要的横向地方（搬 `Line.spreadForSectionWords` / `nudgeForSectionWords`）。落点判据与真正摆的 band.ts 同一份
 * （`sectionword.ts::sectionWordSlot`），这里只问「要撑多少才不用抬」：
 *   - 行中那几条（justify 前）：先问 justify 之后放不放得下，放得下就不撑（撑出来的空档 justify 收不回去）；
 *     放不下就把本小节撑开——锚点之后、下一条小节线之前的各列按份右移，小节线及其后整体右移，按判据二分求最小撑开量；
 *     撑完整行出版心就不撑，维持抬到和弦之上。
 *   - 行首那一条（justify 后）：差的那点从锚点之后的各列里线性衰减地匀出来（行末不动，行长不变）。
 * 和弦按各自锚点居中、没做横向让位（`spreadChords` 在带里才跑），同旧简谱引擎的预演。
 */
class SectionWordRoom {
  private readonly colOf = new Map<PlacedItem, number>();
  private readonly words: Array<{ items: PlacedItem[]; i: number; ink: { left: number; right: number }; start: boolean }> = [];

  constructor(
    lines: ReadonlyArray<{ items: PlacedItem[] }>,
    private readonly cols: readonly Column[],
    private readonly m: JianpuGrid,
    private readonly ink: InkMeasurer,
    private readonly width: number,
  ) {
    if (m.style.size.sectionWord <= 0) return;
    cols.forEach((c, ci) => { for (const { it } of c.members) this.colOf.set(it, ci); });
    for (const l of lines) {
      const start = lineStartIndex(l.items);
      l.items.forEach((it, i) => {
        const w = sectionWordOf(it.element);
        if (w && sectionWordLines(w).length) this.words.push({ items: l.items, i, ink: widestLine(sectionWordLines(w), (x) => ink.sectionWord(x)).ink, start: i === start });
      });
    }
  }

  private slot(w: { items: PlacedItem[]; i: number; ink: { left: number; right: number } }, X: readonly number[]) {
    const xOf = (it: PlacedItem): number => X[this.colOf.get(it)!]!;
    return sectionWordSlot(w.items, w.i, xOf, previewChords(w.items, xOf, this.ink), w.ink, this.m, this.width);
  }

  spread(X: number[], lyricRight: number[], rightOf: () => number, justified: (xs: number[]) => void): void {
    const size = this.m.style.size.sectionWord;
    for (const w of this.words) {
      if (w.start) continue;
      const probe = [...X];
      justified(probe);
      if (!this.slot(w, probe).lifted) continue;
      const now = this.slot(w, X);
      if (!now.lifted) continue;
      const ca = this.colOf.get(w.items[w.i]!)!;
      let cb = ca + 1;
      while (cb < this.cols.length && !this.cols[cb]!.bar) cb++;
      const steps = cb - ca;
      const frac = (k: number): number => (k <= ca ? 0 : k >= cb ? 1 : (k - ca) / steps);
      const shifted = (s: number): number[] => X.map((x, k) => x + s * frac(k));
      // 上界：末尾那个空档只分到 1/steps，shortfall × steps 一定够；撑到上界仍让不开（左右都是密和弦）就别白撑
      let hi = now.shortfall * steps + size;
      if (this.slot(w, shifted(hi)).lifted) continue;
      let lo = 0;
      while (hi - lo > 0.25) {
        const mid = (lo + hi) / 2;
        if (this.slot(w, shifted(mid)).lifted) lo = mid;
        else hi = mid;
      }
      // 撑完整行出版心就不撑（120《耶稣是我亲爱救主》曾整行越出右缘 57pt），维持抬起
      if (rightOf() + hi > this.width) continue;
      X.forEach((x, k) => {
        const d = hi * frac(k);
        X[k] = x + d;
        if (lyricRight[k]! > -Infinity) lyricRight[k] = lyricRight[k]! + d;
      });
    }
  }

  nudge(X: number[]): void {
    const n = this.cols.length;
    for (const w of this.words) {
      if (!w.start) continue;
      const slot = this.slot(w, X);
      if (!slot.lifted || slot.shortfall <= 0) continue;
      const ca = this.colOf.get(w.items[w.i]!)!;
      const denom = n - 2 - ca;
      if (denom <= 0) continue;
      for (let k = ca + 1; k < n; k++) X[k] = X[k]! + (slot.shortfall * (n - 1 - k)) / denom;
    }
  }
}

/** 撑开预演用的和弦墨迹范围：按各自锚点居中、没做横向让位（`band.ts::spreadChords` 在带里才跑），同旧简谱引擎的预演。 */
function previewChords(items: readonly PlacedItem[], xOf: (it: PlacedItem) => number, ink: InkMeasurer): ChordSpan[] {
  const chords: ChordSpan[] = [];
  for (const it of items) {
    const el = it.element;
    const text = el.kind === "note" || el.kind === "sustain" ? el.chord : undefined;
    if (!text) continue;
    const r = ink.chord(text);
    if (!r.ink) continue;
    const x = xOf(it) - r.advance / 2;
    chords.push({ x0: x + r.ink.left, x1: x + r.ink.right, at: it });
  }
  return chords;
}

/**
 * 小节线上的跳转字（`Fine` / `D.S.` / `D.C.`）要的横向地方（搬 `Line.spreadForBarEndMarks`）：跳转字右缘贴着小节线墨迹右缘
 * （`band.ts::placeDirections`），本小节末尾有和弦挤着就让不开，原书是并排印的——用户口径「需要的话把小节撑宽」。
 * 净空用带里判撞那把尺子（`placeDirection` 的 0.35 个和弦字号），撑够了带里就不会再抬。
 * 同段落词：先问 justify 之后放不放得下，放得下不撑；放不下把本小节最后一个音之后的各列按份右移、小节线及其后整体右移；
 * 撑出版心就不撑（维持抬一层）。
 */
class BarEndRoom {
  private readonly colOf = new Map<PlacedItem, number>();
  private readonly marks: Array<{ items: PlacedItem[]; bar: PlacedItem; width: number; barRight: number }> = [];
  private readonly size: number;

  constructor(
    lines: ReadonlyArray<{ items: PlacedItem[] }>,
    private readonly cols: readonly Column[],
    m: JianpuGrid,
    private readonly ink: InkMeasurer,
    private readonly width: number,
  ) {
    this.size = m.style.size.chord > 0 ? m.style.size.chord : m.style.size.note * 0.6;
    cols.forEach((c, ci) => { for (const { it } of c.members) this.colOf.set(it, ci); });
    for (const l of lines) {
      for (const it of l.items) {
        const el = it.element;
        if (el.kind !== "barline" || it.dy !== undefined) continue;
        const texts = el.ornaments.map((o) => BARLINE_MARKS[o.name]?.text).filter((t): t is string => !!t);
        if (texts.length === 0) continue;
        // 一组横排、各段之间 0.25 个字号（同 `placeDirections`）
        const w = texts.reduce((a, t) => a + Math.max(ink.text(t, "jump").advance, ink.text(t, "jump").ink.right), 0)
          + (texts.length - 1) * this.size * 0.25;
        this.marks.push({ items: l.items, bar: it, width: w, barRight: barlineBox(el, m)?.right ?? 0 });
      }
    }
  }

  /** 跳转字离左边的和弦还差多少（≤ 0 = 放得下） */
  private shortfall(k: { items: PlacedItem[]; bar: PlacedItem; width: number; barRight: number }, X: readonly number[]): number {
    const xOf = (it: PlacedItem): number => X[this.colOf.get(it)!]!;
    const barX = xOf(k.bar);
    let rightMost = -Infinity;
    // 和弦挨上了会被 `band.ts::spreadChords` 往右挪（0.28 个字号的空、最多挪 1.2 个字号）——小节末那个和弦常被前一个顶过去，
    // 按居中算就以为放得下、不撑，带里照样撞上抬一层。这里照那条挪一遍再量
    const chords = previewChords(k.items, xOf, this.ink).sort((a, b) => a.x0 - b.x0);
    for (let i = 1; i < chords.length; i++) {
      const need = chords[i - 1]!.x1 + this.size * 0.28 - chords[i]!.x0;
      if (need <= 0) continue;
      const dx = Math.min(need, this.size * 1.2);
      chords[i] = { ...chords[i]!, x0: chords[i]!.x0 + dx, x1: chords[i]!.x1 + dx };
    }
    for (const c of chords) if (xOf(c.at) < barX) rightMost = Math.max(rightMost, c.x1);
    return rightMost + this.size * 0.35 + k.width - (barX + k.barRight);
  }

  spread(X: number[], lyricRight: number[], rightOf: () => number, justified: (xs: number[]) => void): void {
    for (const k of this.marks) {
      const probe = [...X];
      justified(probe);
      if (this.shortfall(k, probe) <= 0) continue;
      const need = this.shortfall(k, X);
      if (need <= 0) continue;
      if (rightOf() + need > this.width) continue;
      const cb = this.colOf.get(k.bar)!;
      // 本小节最后一个音：它之后（长音的增时线）到小节线按份分
      let ca = cb - 1;
      while (ca > 0 && !this.cols[ca]!.members.some(({ it }) => it.element.kind === "note")) ca--;
      const steps = cb - ca;
      X.forEach((x, i) => {
        const d = i <= ca ? 0 : i >= cb ? need : (need * (i - ca)) / steps;
        X[i] = x + d;
        if (d > 0 && lyricRight[i]! > -Infinity) lyricRight[i] = lyricRight[i]! + d;
      });
    }
  }
}

/**
 * 整组的**自然**列锚点（紧排 + 歌词避让，不两端对齐）：窄纸重断行按它量每小节要多宽（`reflow.ts`）。
 * 返回各符号的自然 x 与这一组的自然宽。
 */
export function naturalColumns(
  lines: ReadonlyArray<SpacedLine>,
  m: JianpuGrid,
  ink: InkMeasurer,
): { xOf: Map<PlacedItem, number>; leftOf: Map<PlacedItem, number>; rightOf: Map<PlacedItem, number>; width: number } {
  const cols = columnsOf(lines, m, ink);
  const { X, lyricRight, lyricLeft } = packColumns(cols, lines.length, m, ink);
  const xOf = new Map<PlacedItem, number>();
  // 各列占到的最左 / 最右处（占位与歌词字取并集，同旧简谱引擎条目的 `entryBounds`）：展开档逐行装满按它判放不放得下（place/expand.ts::fillLines）
  const leftOf = new Map<PlacedItem, number>();
  const rightOf = new Map<PlacedItem, number>();
  let width = 0;
  cols.forEach((c, i) => {
    for (const { it } of c.members) {
      xOf.set(it, X[i]!);
      leftOf.set(it, Math.min(X[i]! - c.left, lyricLeft[i]!));
      rightOf.set(it, Math.max(X[i]! + c.right, lyricRight[i]!));
    }
    width = Math.max(width, X[i]! + c.right + c.pad, lyricRight[i]!);
  });
  return { xOf, leftOf, rightOf, width };
}

