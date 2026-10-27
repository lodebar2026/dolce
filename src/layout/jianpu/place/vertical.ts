// 纵向量：头顶让位（读上方带的结果）、倚音落位、音符叠层的顶与底、连谱号伸出量。
import { jpTremoloCount } from "../../../engrave/jptremolo";
import { jpSlideOf } from "../../../engrave/jpslide";
import type { MusicElement, NoteElement, StackedNote } from "../../../jianpu/ast";
import { jianpuGraceMetrics, jianpuGraceNotes, type JianpuGrid } from "../metrics";
import { graceBottom, graceGeometry, type GraceGeom } from "../../../engrave/grace";
import { lowDotY, stackBottom, stackTop as stackTopOf } from "../../../engrave/stack";
import { accidentalLead, accidentalRise, type AccidentalKind } from "../../../engrave/accidental";
import { JP_ARPEGGIO_LEAD } from "../../../engrave/arpeggio";
import { ORNAMENTS } from "../../../engrave/jpglyph";
import type { Rect } from "../../../common/geom";
import type { InkMeasurer, PlacedItem, PlacedVoice } from "./model";

/**
 * 一组倚音画在哪（相对锚点 x、基线 baseline）。**画（compose/note.ts::paintGrace）与让位共用这一份**：
 * 整块倚音（不含钩）的墨迹底离主音那一摞的顶一道空，与旧简谱引擎、混排同一条规则。
 */
export function graceLayout(note: NoteElement, side: "before" | "after", m: JianpuGrid, x: number, baseline: number): GraceGeom {
  const list = side === "before" ? note.graceBefore : note.graceAfter;
  const dir = side === "before" ? -1 : 1;
  const gn = jianpuGraceNotes(list);
  const gm = jianpuGraceMetrics(m);
  const probe = graceGeometry(gn, gm, x, 0, dir, m.style.size.note, 0);
  const centerY = baseline + stackTop(note, m) - m.ink.stack.gap - graceBottom(probe, gm);
  return graceGeometry(gn, gm, x, baseline, dir, m.style.size.note, centerY);
}

/** 这个音符上倚音那几块的墨迹顶（相对基线，负为上）；没有倚音返回 null。 */
export function graceTop(el: MusicElement, m: JianpuGrid): number | null {
  if (el.kind !== "note" || (el.graceBefore.length === 0 && el.graceAfter.length === 0)) return null;
  const gInk = m.ink.noteHeight * 0.5;
  let top = Infinity;
  for (const side of ["before", "after"] as const) {
    const g = graceLayout(el, side, m, 0, 0);
    for (const d of g.digits) top = Math.min(top, d.cy - gInk / 2);
    for (const d of g.dots) top = Math.min(top, d.cy - d.r);
    for (const a of g.accidentals) top = Math.min(top, a.inkCy - a.inkHeight / 2);
  }
  return Number.isFinite(top) ? top : null;
}

/** 上一组末行与本组头顶之间至少留几个歌词字号（`layoutSong` 的组间让位）。 */
export const GROUP_CLEAR = 0.75;

/**
 * 一组曲行头顶需要留多少空间（相对首声部基线）——记号是往上画的（弧线、房号、松叶、和弦、倚音、临时伴奏），
 * 不预留就会压到上一组的歌词。读上方带排完的结果（`band.ts::placeBand`）：各声部头顶最高的墨迹；
 * 字（和弦、注释、力度…）再往上让一个数字高——只让到墨迹顶是「不打架」，两组之间还得看得出是两组。
 */
export function groupHeadroom(voices: readonly PlacedVoice[], texts: number, textTop: number | null, m: JianpuGrid): number {
  let top = 0;
  for (const v of voices) {
    top = Math.min(top, v.top);
    if (v.textTop !== null) top = Math.min(top, v.textTop - m.ink.noteHeight);
  }
  // `W:` 文字行（首声部头顶之上，见 song.ts::wordsBaseline）
  if (texts > 0 && textTop !== null) top = Math.min(top, textTop - m.ink.noteHeight);
  // 多声部的连谱号：上花头伸出首声部基线 `braceReach`（见 layoutSong 末尾、compose/brace.ts::paintBrace）
  if (voices.length > 1) top = Math.min(top, -braceReach(m));
  return -top;
}

/** 多条 `W:` 文字行的行距（compose/page.ts 逐行画，place/song.ts 让位，同此） */
export function wordsLead(m: JianpuGrid): number {
  return m.style.size.words * 1.35;
}

/** `{dsb}` 并排块里上行比主旋律抬高多少（下行主旋律同量下移）。 */
export function splitRise(m: JianpuGrid): number {
  return m.ink.noteHeight * 1.552;
}

/** 连谱号上下花头伸出首/末声部基线多少：粗线探出 0.85 个墨迹高，花头字形高 1.18 线距（= 1.18/4 em × 字号 2.2 墨迹高）。 */
export function braceReach(m: JianpuGrid): number {
  return m.ink.noteHeight * (0.85 + (1.18 / 4) * 2.2);
}

/**
 * 一个声部**自己头顶**需要多少空间（上方带排完的最高墨迹）。组间用 groupHeadroom，组内声部之间用这个——
 * 否则四声部谱里第 3 声部的弧线会画进它上方的歌词块。
 */
export function voiceHeadroom(voice: PlacedVoice): number {
  return -Math.min(0, voice.top);
}

/**
 * 音符「上方堆叠」的顶端（相对基线，负为上）：没有高八度点时就是数字墨迹顶，
 * 有几个高八度点就抬到最上面那个点的上缘。弧线据此定位——与 .jpwabc 谱面同一规则
 * （见 layout.ts 的 NoteEntry.entryTop / slurRung），固定槽位会离音符太远。
 */
export function stackTop(el: MusicElement | undefined, m: JianpuGrid, withAccidental = true): number {
  const inkTop = -m.ink.noteHeight / 2;
  if (el?.kind !== "note") return inkTop;
  // 临时记号比数字高出一截（engrave/accidental.ts），弧与连音要让开它（简谱弧的起点除外：那个临时记号在弧外侧）
  const rise = (acc: string | undefined): number =>
    withAccidental && acc !== undefined ? accidentalRise(acc as AccidentalKind, m.ink.noteHeight, m.style.look.accidentalScale) : 0;
  let top = Math.min(inkTop - rise(el.accidental), digitsTop(el, m));
  for (const d of stackedDigits(el, m)) top = Math.min(top, d.y + inkTop - rise(d.accidental));
  return top;
}

/** 和音里叠上去的那几个数字：各自的基线（相对本音基线，负为上），自下而上。 */
export interface StackedDigit extends StackedNote {
  y: number;
}

/**
 * 和音的竖向落点（`NoteElement.stack`，123 的 `[13]`）：数字上下叠，最低的音在基线上（减时线、低音点照它画），
 * 往上每个数字的墨迹底（连同它的低音点）离下面那个数字那一摞的顶（连同高音点）一道叠层空的两倍——
 * 番茄临时多声部那样两行全尺寸数字上下叠，只是两行共用一套时值。
 */
export function stackedDigits(el: NoteElement, m: JianpuGrid): StackedDigit[] {
  if (!el.stack?.length) return [];
  const half = m.ink.noteHeight / 2;
  const st = m.ink.stack;
  const out: StackedDigit[] = [];
  let below = stackTopOf(-half, Math.max(0, el.octave), st);
  for (const n of el.stack) {
    const bottom = n.octave < 0 ? lowDotY(half, 0, -n.octave - 1, st) + st.dotRadius : half;
    const y = below - st.gap * 2 - bottom;
    out.push({ ...n, y });
    below = y + stackTopOf(-half, Math.max(0, n.octave), st);
  }
  return out;
}

/** 数字连同高八度点那一摞的顶（不含临时记号；和音算到最上面那个数字） */
export function digitsTop(el: NoteElement, m: JianpuGrid): number {
  const half = m.ink.noteHeight / 2;
  const ds = stackedDigits(el, m);
  const top = ds[ds.length - 1];
  return top ? top.y + stackTopOf(-half, Math.max(0, top.octave), m.ink.stack) : stackTopOf(-half, Math.max(0, el.octave), m.ink.stack);
}


/** 音符那一摞（数字、高八度点、临时记号、倚音）的墨迹顶，相对基线（不含 dy） */
export function entryTop(el: MusicElement, m: JianpuGrid): number {
  let top = Math.min(-m.ink.noteHeight / 2, stackTop(el, m));
  // 多小节休止的小节数印在横线上方（compose/note.ts::paintMultiRest：数字中线在基线上 0.81 个墨迹高）
  if (el.kind === "note" && el.multiRest) top = Math.min(top, -m.ink.noteHeight * 1.31);
  const g = graceTop(el, m);
  if (g !== null) top = Math.min(top, g);
  return top;
}

/** 音符上的一个奏法记号字形：落笔点 `x`/`y` 与墨迹 `ink` 都相对基线、x 相对音符墨迹中心 */
export interface ArticGlyph {
  glyph: string;
  size: number;
  x: number;
  y: number;
  ink: Rect;
}

/**
 * 音符上的奏法记号（延长记号等）往上摞的落点，与它们连同那一摞的墨迹顶（相对基线，不含 dy）。
 * 起始落点照 `NoteEntry.notationTop`：叠层顶（数字 + 高八度点）之上 `gap`，有临时记号再让它 1.6 道；
 * 同一个音上几个记号各隔一道叠层的空，源码里的 `+` 抬高级别照旧按级预抬。
 * 上方带（band.ts）按它摆字形，连音括线（marks.ts）按 `top` 让开跨度里每个音（同 `Line.addTuplet`）。
 */
export function articStack(el: MusicElement, m: JianpuGrid, ink: InkMeasurer, gap: number): { glyphs: ArticGlyph[]; top: number } {
  let top = entryTop(el, m);
  const glyphs: ArticGlyph[] = [];
  if (el.kind !== "note") return { glyphs, top };
  const nh = m.ink.noteHeight;
  let artBottom = digitsTop(el, m) - gap;
  const ds = stackedDigits(el, m);
  const topDigit = ds[ds.length - 1];
  const acc = topDigit ? topDigit.accidental : el.accidental;
  if (acc !== undefined) {
    artBottom = Math.min(artBottom, (topDigit?.y ?? 0) - nh / 2 - accidentalRise(acc as AccidentalKind, nh, m.style.look.accidentalScale) - gap * 1.6);
  }
  for (const orn of el.ornaments) {
    // 换气是挂在右上角的 V、震音号记在右下角、滑音是右侧偏上的箭头（compose/note.ts 贴着音符画，`engrave/jptremolo.ts`、`jpslide.ts`），不进带
    const g = orn.name === "hx" || jpTremoloCount([orn.name]) || jpSlideOf([orn.name]) ? undefined : ORNAMENTS[orn.name];
    if (!g) continue;
    const size = m.style.size.note * g.scale;
    const r = ink.smufl(g.glyph, size);
    const y = artBottom - r.bottom - orn.level * m.note.levelStep;
    const x = -(r.left + r.right) / 2;
    const box = r.offset(x, y);
    glyphs.push({ glyph: g.glyph, size, x, y, ink: box });
    artBottom = box.top - m.ink.stack.gap;
    top = Math.min(top, box.top);
  }
  return { glyphs, top };
}

/**
 * 一个音符**最低的墨迹**（相对基线）：数字墨迹底、减时线最下一层、低音点，取最低的那个。
 * 落点走公共那一份（engrave/stack.ts），与画点、旧简谱引擎的 entryBottom 同一套。
 */
export function noteInkBottom(note: NoteElement, m: JianpuGrid): number {
  return stackBottom(m.ink.noteHeight / 2, noteBeams(note), Math.max(0, -note.octave), m.ink.stack);
}

/** 音符下面有几层减时线（按时值：八分 1、十六分 2……）。 */
export function noteBeams(note: NoteElement): number {
  return Math.max(0, Math.round(Math.log2(note.duration / 4)));
}

/** 一行里最低的墨迹（歌词要据此下推，免得贴到低音点上）。 */
export function lineInkBottom(items: readonly PlacedItem[], m: JianpuGrid): number {
  let bottom = m.ink.noteHeight / 2;
  for (const it of items) {
    if (it.element.kind !== "note" || it.element.hidden) continue;
    const b = noteInkBottom(it.element, m);
    if (b > bottom) bottom = b;
  }
  return bottom;
}

/** 音符前临时记号伸出多宽：和音取几个数字里最宽的那个（叠在一列，左缘取齐）；没有临时记号为 0。 */
export function accidentalLeadOf(el: NoteElement, m: JianpuGrid): number {
  let w = 0;
  for (const a of [el.accidental, ...(el.stack ?? []).map((n) => n.accidental)]) {
    if (a !== undefined) w = Math.max(w, accidentalLead(a as AccidentalKind, m.ink.noteHeight, m.style.look.accidentalScale));
  }
  // 琶音线画在临时记号左边（`compose/note.ts`）
  if (el.ornaments.some((o) => o.name === "arp")) w += m.ink.noteHeight * JP_ARPEGGIO_LEAD;
  return w;
}
