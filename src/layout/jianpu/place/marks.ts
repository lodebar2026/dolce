// 跨若干符号的记号（弧线 / 多连音 / 跳房子 / 渐强渐弱）换算成行内坐标，弧按嵌套定层。
import type { Mark, NoteElement, ScoreLine } from "../../../jianpu/ast";
import { Point } from "../../../common/geom";
import { jianpuSlurRise, jianpuSlurStyle, type JianpuGrid } from "../metrics";
import { ARC_CHAIN_INSET_DIV, Slur, arcClearShift, arcRise, jpArcY, type SlurStyle } from "../../../engrave/arc";
import type { InkMeasurer, PlacedItem, PlacedMark } from "./model";
import { articStack, noteInkBottom, stackTop } from "./vertical";
import { barlineLines } from "./spacing";
import { JP_HAIRPIN } from "../../../engrave/hairpin";
import { DYNAMIC_SIZE } from "../../../engrave/dynamics";
import { DYNAMICS } from "../../../engrave/jpglyph";

/** 把记号的元素下标区间换算成行内 x 区间；弧线、多连音的 y 也在这里定（跳房子、松叶的 y 见 band.ts）。 */
export function placeMarks(voice: ScoreLine, items: PlacedItem[], m: JianpuGrid, ink: InkMeasurer): PlacedMark[] {
  if (items.length === 0) return [];
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const at = (srcIndex: number, side: "start" | "end"): PlacedItem => {
    // 记号端点未必正落在占位符号上（例如 `(` 紧跟在 `~` 后），取最近的一个
    let best = side === "start" ? last : first;
    for (const it of items) {
      if (side === "start") {
        if (it.srcIndex >= srcIndex && it.srcIndex < best.srcIndex) best = it;
      } else if (it.srcIndex <= srcIndex && it.srcIndex > best.srcIndex) best = it;
    }
    if (side === "start" && best.srcIndex < srcIndex) best = first;
    return best;
  };
  const out: PlacedMark[] = [];
  for (const mark of voice.marks) {
    const openLeft = mark.continuationFromPrevious === true;
    const openRight = mark.continuationToNext === true;
    // 跨行的弧线/多连音**两截都画**：起头那行从起点画到行末那个音右侧半格，收尾那行从行首那个音左侧半格画到终点
    const a = openLeft ? first : at(mark.start, "start");
    const b = openRight ? last : at(mark.end, "end");
    const level = Math.max(1, mark.level);
    // 弧线/多连音的两端就落在音符的**墨迹中心**上（数字本来就是按墨迹居中排的），
    // 与 .jpwabc 的 addSlurTie 一致——不再往外扩半个音符宽。
    // 端点还挂着别的弧线时各自内缩 dx（= 字号/14），免得两条弧首尾顶在一起。
    const isArc = mark.type === "slur" || mark.type === "tuplet";
    const dx = isArc ? m.ink.noteHeight / 0.7 / ARC_CHAIN_INSET_DIV : 0;
    const chainedLeft = voice.marks.some((o) => o !== mark && o.end === mark.start);
    const chainedRight = voice.marks.some((o) => o !== mark && o.start === mark.end);
    // 跳房子往外扩；弧线相反，端点落在墨迹中心。松叶另算（`wedgeSpan`）
    const isWedge = mark.type === "crescendo" || mark.type === "decrescendo";
    const spread = m.note.beamHalfSpan;
    const padLeft = isArc ? (chainedLeft ? dx : 0) : -spread;
    const padRight = isArc ? (chainedRight ? dx : 0) : -spread;
    // 跳房子的竖脚**对齐小节线的线位**（同旧简谱引擎 `Line.endingSpan`）：起点取房内首音之前那条线的最后一根、
    // 终点取末音之后那条的第一根（`:‖` 与 `‖:` 两房相接时一个落细线、一个落粗线，天然分开）。不画的线按锚点
    let vx0: number | null = null;
    let vx1: number | null = null;
    if (mark.type === "volta") {
      for (const it of items) {
        if (it.element.kind !== "barline") continue;
        const ln = barlineLines(it.element, m);
        if (it.x <= a.x) vx0 = it.x + (ln?.last ?? 0);
        if (it.x >= b.x && vx1 === null) vx1 = it.x + (ln?.first ?? 0);
      }
    }
    const placed: PlacedMark = {
      mark,
      x0: openLeft ? a.x - m.note.noteStep * 0.5 : (vx0 ?? a.x + padLeft),
      x1: openRight ? b.x + m.note.noteStep * 0.5 : (vx1 ?? b.x - padRight),
      level,
      openLeft,
      openRight,
      startEl: a.element,
      endEl: b.element,
    };
    if (isWedge) Object.assign(placed, wedgeSpan(items, a, b, openLeft, openRight, m, ink));
    if (mark.type === "tuplet" && m.style.look.tupletStyle === "bracket") {
      // 连音括线（同 `Line.addTuplet`）：**跨度里每个音**那一摞（含高八度点、临时记号、奏法记号）的墨迹顶之上一道空，
      // 不只看两端（中间那个音带升号时只看两端，括线就压在升号上）。两段弧风格仍按下面的「简谱弧只看起止」
      const gap = m.style.vertical.slurGap;
      let top = Infinity;
      for (const it of items) {
        if (it.srcIndex < a.srcIndex || it.srcIndex > b.srcIndex || it.element.kind !== "note" || it.element.hidden) continue;
        top = Math.min(top, articStack(it.element, m, ink, gap).top);
      }
      if (!Number.isFinite(top)) top = Math.min(stackTop(a.element, m), stackTop(b.element, m));
      placed.y = top - gap - (level - 1) * m.note.levelStep;
    } else if (mark.type === "slur" && tieBelow(mark, a, b, openLeft, openRight)) {
      // 和音最下面那个音单连的延音线（123 `[1~5] [15]`）：顶上那一条已经是整和音的弧的位置，画在那儿就认成连 5，
      // 所以贴着最低的数字画在叠印下方、开口朝上——数字、减时线、低音点之下一道叠层的空（只认真有的那一端）
      const ends = [openLeft ? null : a, openRight ? null : b].filter((it): it is PlacedItem => it?.element.kind === "note");
      placed.below = true;
      placed.y = Math.max(...ends.map((it) => noteInkBottom(it.element as NoteElement, m))) + m.ink.stack.gap;
    } else if (mark.type === "slur" || mark.type === "tuplet") {
      // **按罩住的音符数改扁**（`slur-flat-notes`，同 `Line.slurNoteCount`）：跨度那条阈值是物理宽度，音符密的谱行上够不着
      // （91《我灵镇静》罩着五六个十六分音符的弧）。数的是音符（含两端），增时线不另算
      const flatNotes = m.style.arc.flatNotes;
      if (mark.type === "slur" && flatNotes > 0) {
        let n = 0;
        for (const it of items) if (it.srcIndex >= a.srcIndex && it.srcIndex <= b.srcIndex && it.element.kind === "note") n++;
        if (n >= flatNotes) placed.flat = true;
      }
      // 简谱弧（engrave/arc.ts，三条简谱路同一条；多连音的两段弧也是弧）：只看起止两个音——两摞的墨迹顶
      // （终点算上临时记号）取高者，再往上一道叠层的空；源码里的 `+` 抬高级别照旧按 level 上移
      // 跨行那一截只认真有的那一端（敞口那头借来的行首/行末音不算）
      const topA = stackTop(a.element, m, false);
      const topB = stackTop(b.element, m);
      placed.y = jpArcY(openLeft ? topB : topA, openRight ? topA : topB, m.ink.stack.gap)
        - (level - 1) * m.note.levelStep;
    }
    // 只有**两端都**落在并排块的下行里，这个记号才跟着下移；跨过并排块的（比如
    // 从块前一直画到块后的跳房子）另行处理，见下面的「抬到上行之上」
    if (a.dy !== undefined && b.dy !== undefined) placed.dy = a.dy;
    out.push(placed);
  }
  // **弧套弧**（slur 罩着延音线、同一个音起的两条弧、罩着多连音的弧）：外弧按实际弧线判碰里面那些弧的弧顶
  // （engrave/arc.ts::arcClearShift），碰了才整条抬、高出一道空。从短的排起，外层才看得到里层定下的高度
  // （260《感恩的泪》`2⌒2 3 2` 两条弧原先同一个起点、贴在一起）
  const arcs = out.filter((p) => p.y !== undefined && isArcMark(p.mark) && !p.below);
  arcs.sort((p, q) => (p.mark.end - p.mark.start) - (q.mark.end - q.mark.start));
  // 弧高没有上限的档（展开档的 pptx 预设 `arc.maxHeight` = 0）按各条弧的跨度算，否则一律取上限那一份
  const capped = jianpuSlurRise(m);
  const riseOf = (p: PlacedMark): number => (Number.isFinite(capped) ? capped : arcRise(p.x1 - p.x0, jianpuSlurStyle(m, 0)));
  for (const [i, outer] of arcs.entries()) {
    const inner = arcs.slice(0, i).filter((q) => nests(q.mark, outer.mark))
      .map((q) => ({ x: (q.x0 + q.x1) / 2, y: q.y! - riseOf(q) - m.style.stroke.slur }));
    outer.y = outer.y! + arcClearShift(outer.x0, outer.y!, outer.x1, outer.y!, riseOf(outer), true, inner, m.ink.stack.gap);
  }
  // 跳房子、松叶的 y 按上方带堆叠的结果定（band.ts::placeBand）
  return out;
}

/**
 * 松叶的横向范围（搬 `Line.addWedges`，几何见 `engrave/hairpin.ts::JP_HAIRPIN`）：起止在音符墨迹中心外 0.3 个墨迹高；
 * 跨到下一行的画到行末那个音的右缘，续过来的从行首第一个音左 0.9 个墨迹高起。
 * 起止音上有力度（`9>&mf`）：从力度字右边起、收在力度字左边（同原版 `mf>`；力度字居中在音上，见 band.ts::placeDirections），
 * 让完太短（不足一个墨迹高）就不让。
 */
function wedgeSpan(
  items: readonly PlacedItem[], a: PlacedItem, b: PlacedItem, openLeft: boolean, openRight: boolean, m: JianpuGrid, ink: InkMeasurer,
): { x0: number; x1: number } {
  const nh = m.ink.noteHeight;
  const notes = items.filter((it) => it.element.kind === "note" || it.element.kind === "sustain");
  const firstNote = notes[0] ?? a;
  const lastNote = notes[notes.length - 1] ?? b;
  let x0 = openLeft ? Math.max(0, firstNote.x - nh * JP_HAIRPIN.carryLead) : a.x - nh * JP_HAIRPIN.pad;
  let x1 = openRight ? lastNote.x + ink.digit("1").advance / 2 : b.x + nh * JP_HAIRPIN.pad;
  const dynWidth = (it: PlacedItem): number => {
    const el = it.element;
    if (el.kind !== "note") return 0;
    const fs = m.style.size.note * DYNAMIC_SIZE;
    const ws = el.ornaments.filter((o) => DYNAMICS[o.name]).map((o) => ink.smufl(DYNAMICS[o.name]!, fs).width);
    return ws.length ? Math.max(...ws) : 0;
  };
  const w0 = openLeft ? 0 : dynWidth(a);
  if (w0 > 0) {
    const after = a.x + w0 / 2 + nh * 0.25;
    if (after < x1 - nh) x0 = after;
  }
  const w1 = openRight ? 0 : dynWidth(b);
  if (w1 > 0) {
    const before = b.x - w1 / 2 - nh * 0.25;
    if (before > x0 + nh) x1 = before;
  }
  return { x0, x1 };
}

/** 和音单连一个音的延音线是不是连在最下面那个数字上（两端真有的都是第 0 层、且那个音确是叠印的和音）。
 *  连在顶上那个的照常画在上方；连在中间那层的（三个以上的和音）也画在上方——数字之间只隔两道叠层的空，放不下一条弧 */
function tieBelow(mark: Mark, a: PlacedItem, b: PlacedItem, openLeft: boolean, openRight: boolean): boolean {
  if (!mark.digits) return false;
  const ends: [PlacedItem, number][] = [];
  if (!openLeft) ends.push([a, mark.digits[0]]);
  if (!openRight) ends.push([b, mark.digits[1]]);
  return ends.length > 0 && ends.every(([it, d]) => d === 0 && it.element.kind === "note" && (it.element.stack?.length ?? 0) > 0);
}

/** 叠印下方那几条延音线（`PlacedMark.below`）的墨迹底，相对基线（含并排块的 `dy`）；没有为 -Infinity。
 *  歌词与器乐谱下方那条带据此往下让 */
export function belowArcsBottom(marks: readonly PlacedMark[], m: JianpuGrid): number {
  let bottom = -Infinity;
  for (const mk of marks) {
    if (!mk.below || mk.y === undefined) continue;
    const arc = new Slur();
    arc.init(new Point(mk.x0, mk.y), new Point(Math.max(mk.x1, mk.x0 + 6), mk.y), belowArcStyle(m));
    bottom = Math.max(bottom, arc.y + arc.height + (mk.dy ?? 0));
  }
  return bottom;
}

/** 叠印下方那条延音线的样式：开口朝上；扁平式只会往上画，关掉（相邻两个和音之间的弧本来就短） */
export function belowArcStyle(m: JianpuGrid, color = 0): SlurStyle {
  return { ...jianpuSlurStyle(m, color), side: "down", flatSpan: 0, flatRatio: 0 };
}

export function isArcMark(mk: Mark): boolean {
  return mk.type === "slur" || mk.type === "tuplet";
}

/** `inner` 整条落在 `outer` 的跨度里（不是同一条）。 */
function nests(inner: Mark, outer: Mark): boolean {
  return inner !== outer && inner.start >= outer.start && inner.end <= outer.end
    && (inner.start !== outer.start || inner.end !== outer.end);
}

/** 这条弧外面套着几层（里面每多一层弧，它就得多抬一层）。 */
export function arcNestDepth(mk: Mark, marks: readonly Mark[]): number {
  let depth = 0;
  for (const o of marks) if (isArcMark(o) && nests(o, mk)) depth = Math.max(depth, arcNestDepth(o, marks) + 1);
  return depth;
}
