// 一行一个声部的符号序列：占位符号、拍位与拍组、减时线分段、歌词音节挂到跟词的符号上。
import { elementQuarters, takesLyric, tupletRatios, type BarlineElement, type LyricLine, type Meter, type MusicElement, type ScoreLine } from "../../../jianpu/ast";
import { jianpuGraceMetrics, jianpuGraceNotes, type JianpuGrid } from "../metrics";
import { graceAdvance } from "../../../engrave/grace";
import { ACCIDENTAL_CLEARANCE } from "../../../engrave/accidental";
import { accidentalLeadOf } from "./vertical";
import { beatGroupIndex, beatGroupSize, pickupOffset } from "../../../engrave/beatgroup";
import type { PlacedItem, PlacedUnderline } from "./model";
import { BRACE_GLYPHS } from "../compose/braceglyphs";

/** 并排块右花括号的字形宽（pt，只按高度缩放，宽不变） */
export const SPLIT_BRACE_W = BRACE_GLYPHS.splitRight.box[2];

/** 音符/增时线的时值（拍）。实现在 ast.ts::elementQuarters（与导出侧共用同一份精确算法）。 */
export function elementBeats(el: MusicElement): number {
  return elementQuarters(el).toFloat();
}

function isBeamed(el: MusicElement): boolean {
  return el.kind === "note" && el.duration > 4;
}

/**
 * 把一行歌词的音节按顺序发给该行「跟词」的符号。
 * 空音节（源码里的 `@` / `/`）本身就代表跳过一个音符，所以照序发即可。
 */
export function assignLyrics(items: PlacedItem[], lyrics: readonly LyricLine[]): void {
  lyrics.forEach((line, verse) => {
    let cursor = 0;
    for (const item of items) {
      if (!takesLyric(item.element)) continue;
      const syl = line.syllables[cursor++] ?? null;
      item.syllables[verse] = syl && syl.text.length > 0 ? syl : null;
    }
  });
}

/**
 * 一行一个声部的符号序列、拍位与拍组。
 *
 * 主旋律的横向位置由 `spacing.ts::placeColumns` 按内容另算；这里按固定步距给的 `x` / `advance`
 * 只剩 `{bz}` 临时伴奏层在用（`layers.ts`，小字号一行自己排）。`pad` 是每个符号**之后**必须硬让出的地方
 * （`&sbf` 连谱号、`{dsb}` 花括号），两种排法都加。
 */
export function layoutVoiceLine(
  voice: ScoreLine,
  m: JianpuGrid,
  ctx: BeatCtx = {},
): { items: PlacedItem[]; width: number; groups: number[]; tail: number; pad: number[] } {
  // 只有音符/增时线/小节线占位；`~`/`^` 与内联层不进步进序列。
  const flat: MusicElement[] = voice.elements.filter(
    (el) => el.kind === "note" || el.kind === "sustain" || el.kind === "barline",
  );
  // 换了样子的小节线（反复起点挪行）不在 voice.elements 里，记号坐标仍按原来那条算
  const srcMap = new Map<MusicElement, number>();
  const srcOf = (el: MusicElement): number => srcMap.get(el) ?? voice.elements.indexOf(el);
  // 反复起点不留在行末（同旧简谱引擎在 `‖:` 前断行）：行末的 `|:` 画成普通线、`:|:` 画成 `:|`，
  // `|:` 挪到下一行行首（`ctx.leadRepeat`，由 layoutSong 按上一行带过来）
  const tailAt = flat.length - 1;
  const tail0 = flat[tailAt];
  if (tail0?.kind === "barline" && forwardRepeatAtEnd(tail0)) {
    const type = tail0.type === "repeat-both" ? "repeat-end" : tail0.type === "repeat-start" ? "normal" : tail0.type;
    const plain: BarlineElement = { ...tail0, type, repeatForwardAfter: false };
    srcMap.set(plain, voice.elements.indexOf(tail0));
    flat[tailAt] = plain;
  }
  if (ctx.leadRepeat) {
    const head = flat[0];
    if (head?.kind === "barline") {
      if (head.type === "normal") {
        const fwd: BarlineElement = { ...head, type: "repeat-start" };
        srcMap.set(fwd, voice.elements.indexOf(head));
        flat[0] = fwd;
      }
    } else {
      // 占位序号、减时线的 `~`/`^` 坐标都按 flat 下标数，补的这条在 computeUnderlines 里扣掉（srcIndex −1）
      flat.unshift({ kind: "barline", type: "repeat-start", ornaments: [], code: "|:", source: { line: 0, column: 0, offset: 0, length: 0 } });
      srcMap.set(flat[0]!, -1);
    }
  }
  // 上一行行末转了拍号（`‖ 3/4` 在行尾）：本行行首再印一遍（行首有线就挂在那条线上，没有就补一条不画的线挂着）
  if (ctx.leadMeter) {
    const head = flat[0];
    if (head?.kind === "barline") {
      if (!head.temporaryMeter) {
        const withMeter: BarlineElement = { ...head, temporaryMeter: ctx.leadMeter };
        srcMap.set(withMeter, srcMap.get(head) ?? voice.elements.indexOf(head));
        flat[0] = withMeter;
      }
    } else {
      flat.unshift({ kind: "barline", type: "invisible", ornaments: [], temporaryMeter: ctx.leadMeter, code: "", source: { line: 0, column: 0, offset: 0, length: 0 } });
      srcMap.set(flat[0]!, -1);
    }
  }
  const ratios = tupletRatios(voice);
  // `{dsb}` 并排块的花括号要挤在前一个符号与并排段之间，得先给它让出位置；
  // 并排段**结束**那头还有一个右括号，同样要让
  const splitAt = new Set<number>();
  const splitEnd = new Set<number>();
  voice.elements.forEach((el, i) => {
    if (el.kind !== "inline-layer" || el.role !== "voice") return;
    splitAt.add(i);
    let total = 0;
    for (const inner of el.elements) total += elementBeats(inner);
    let at = flat.findIndex((f) => srcOf(f) > i);
    if (at < 0) return;
    let acc = 0;
    for (; at < flat.length; at++) {
      acc += elementBeats(flat[at]!);
      if (acc >= total - 1e-6) break;
    }
    // 让位要加在**末个音符之后**（右括号就落在那儿），不是段末小节线之后
    let after = at;
    while (after + 1 < flat.length && flat[after + 1]!.kind === "barline") after += 1;
    if (after < flat.length - 1) splitEnd.add(at);
  });
  const items: PlacedItem[] = [];
  let x = 0;
  let beat = 0;

  flat.forEach((el, i) => {
    const srcIndex = srcOf(el);
    const r = ratios[srcIndex];
    const beats = elementBeats(el) * (r ? r.num / r.den : 1);
    items.push({
      index: i,
      srcIndex,
      x: 0,
      advance: 0,
      element: el,
      beat,
      beats,
      syllables: [],
    });
    if (el.kind === "barline") beat = 0;
    else beat += beats;
  });

  // 紧排的判据就是「同一条减时线下」，与减时线本身同一把尺子：拍组在这里算一次，
  // 连同 items 一起带出去给 computeUnderlines 用，两处不各算一遍。
  const { groups, tail } = beatGroups(items, ctx);

  const pad = new Array<number>(flat.length).fill(0);
  flat.forEach((el, i) => {
    const srcIndex = items[i]!.srcIndex;
    items[i]!.x = x;
    const next = flat[i + 1];
    let advance: number;
    if (next === undefined) {
      advance = el.kind === "barline" ? 0 : m.note.noteStep;
    } else if (el.kind === "barline" || next.kind === "barline") {
      advance = m.note.barlineSpace;
    } else {
      advance = isBeamed(el) && isBeamed(next) && groups[i] === groups[i + 1] ? m.note.beamedNoteStep : m.note.noteStep;
    }
    if (el.kind === "note") advance += m.note.augDotStep * el.dots;
    // `&sbf` 的小节线后面要挤进一个连谱号（它离音符 1.41 个墨迹高），所以额外让出
    // 一个半墨迹高——按倍数加不行，行被压缩后连谱号会压到小节线上
    if (el.kind === "barline" && el.ornaments.some((o) => o.name === "sbf")) {
      pad[i]! += m.ink.noteHeight * 1.5;
    }
    // 变音记号写在数字前，得给它让出位置
    // 让出的宽 = 升降号墨迹宽 + 它与数字的空 + 与前一个音之间的空（engrave/accidental.ts，与画法、旧简谱引擎同一份比例）
    const nextLead = next?.kind === "note" ? accidentalLeadOf(next, m) : 0;
    if (nextLead > 0) advance += nextLead + m.ink.noteHeight * ACCIDENTAL_CLEARANCE;
    // 前倚音也排在数字左边，同样要让位——不让的话倚音会挤在前后两个音符正中间，
    // 看起来像挂在了左边那个音符上（原版给它让出的正是这么多）
    // 宽度走公共那一份（带升降号的倚音要多占一截，不是「颗数 × 常数」）
    if (next?.kind === "note" && next.graceBefore.length > 0) {
      advance += graceAdvance(jianpuGraceNotes(next.graceBefore), jianpuGraceMetrics(m));
    }
    if (el.kind === "note" && el.graceAfter.length > 0) {
      advance += graceAdvance(jianpuGraceNotes(el.graceAfter), jianpuGraceMetrics(m));
    }
    // 右花括号（字形宽 `SPLIT_BRACE_W`，不随字号缩放）前后各要一道空：离末音 1.07、离小节线 0.48 个墨迹高（layers.ts）；
    // 紧排本身已留出约 0.6 个墨迹高，差的补上——只按墨迹高让，小字号下括号就压到小节线上
    if (splitEnd.has(i)) pad[i]! += SPLIT_BRACE_W + m.ink.noteHeight * 0.95;
    // 两个符号之间夹着并排块的话，中间要放得下一个左花括号，口径同右括号：离前面的小节线 0.48、离并排段首音 1.07 个墨迹高
    if (next !== undefined) {
      const nextAt = srcOf(next);
      for (const at of splitAt) {
        if (at > srcIndex && at < nextAt) {
          pad[i]! += SPLIT_BRACE_W + m.ink.noteHeight * 0.95;
          break;
        }
      }
    }
    advance += pad[i]!;
    items[i]!.advance = advance;
    x += advance;
  });

  return { items, width: x, groups, tail, pad };
}

/** 一行的拍组上下文：行首拍号、上一行开口小节已用的拍数、是不是整首的头一行。
 *  三样都只给 beatGroups 用，由 layoutSong 逐行往下带。 */
export interface BeatCtx {
  meter?: Meter;
  /** 跨行小节：上一行那个开口小节已经算到哪个拍位（beatGroups 的 tail） */
  carryIn?: number;
  /** 整首的头一行——首小节不满一小节就是弱起，拍位要按小节末尾对齐 */
  songStart?: boolean;
  /** 整首的末一行——末小节不满不补（musicpp: `this == measures.back()`） */
  songEnd?: boolean;
  /** 上一行以反复起点收尾（`forwardRepeatAtEnd`）：本行行首补一条 `|:` */
  leadRepeat?: boolean;
  /** 上一行行末转了拍号（`lineEndMeter`）：本行行首再印一遍 */
  leadMeter?: Meter;
}

/** 这条小节线带不带「下一小节起反复」（`|:`、`:|:`，或 123 / MusicXML 记在下一小节左线上的那种） */
export function forwardRepeatAtEnd(el: BarlineElement): boolean {
  return el.type === "repeat-start" || el.type === "repeat-both" || el.repeatForwardAfter === true;
}

/** 一行的末个占位符号是带反复起点的小节线 */
export function lineEndsWithForwardRepeat(voice: ScoreLine): boolean {
  for (let i = voice.elements.length - 1; i >= 0; i--) {
    const el = voice.elements[i]!;
    if (el.kind === "note" || el.kind === "sustain") return false;
    if (el.kind === "barline") return forwardRepeatAtEnd(el);
  }
  return false;
}

/** 一行的末个占位符号是带转拍号的小节线：返回那个拍号 */
export function lineEndMeter(voice: ScoreLine): Meter | undefined {
  for (let i = voice.elements.length - 1; i >= 0; i--) {
    const el = voice.elements[i]!;
    if (el.kind === "note" || el.kind === "sustain") return undefined;
    if (el.kind === "barline") return el.temporaryMeter;
  }
  return undefined;
}

/**
 * 谱面拍组：一条减时线连到哪一个音符为止，只由**时值**决定——同一组内连、跨组断。
 * 移植自 musicpp `MusicData::processJpBeam`。减时线的连断与横向紧排（`stepBeamed`）
 * 共用这一份，一行只算一次（`layoutVoiceLine` 算好带出来）。
 *
 * - 组长（以四分音符为 1）：x/4、x/2 是一拍一组；**复拍子**（分母 8、分子是 3 的
 *   倍数：3/8 6/8 9/8 12/8）三个八分为一组，即 1.5 个四分拍。9/8 的一小节九个八分
 *   因此排成 3+3+3，而不是按整四分拍切出的 2+2+2+2+1。简谱那路的
 *   `score.ts::autoBeamGroup` 早有同一条，两边口径要一致。
 * - **残节**（弱起，或被反复切开的那半个小节）按小节末尾对齐：拍位整体加上
 *   `整小节时值 − 本小节时值`，组界才落在谱面该断的地方。两条例外同原文：下一小节的
 *   时值正好等于要补的那一截（首尾配对的两个残节）不补，末小节不补。
 * - 跨行的小节接着上一行算：续行以 `|/` 开头、拍位却从 0 重来（见 layoutVoiceLine），
 *   不接上就会在续行头一个音上错开一组。musicpp 的 measure 本来就是整的，没这一层。
 *
 * 拍号取行首那个，曲中的 `"p:3/4"`（`BarlineElement.temporaryMeter`）逐小节改写。
 */
function beatGroups(items: PlacedItem[], ctx: BeatCtx = {}): { groups: number[]; tail: number } {
  // 先按小节线切段：段 = 一个小节里的占位符号（小节线本身当分隔，不进段）
  const segs: { from: number; to: number; meter: Meter | undefined; carried: boolean }[] = [];
  let cur = ctx.meter;
  let from = 0;
  // 本段是不是上一行那个小节的后半：上一行开口收尾（carryIn > 0）时行首第一段就是续段——
  // 换行本身不断小节；行首写了 `|/` 的写法也照认。carryIn 为 0 时不能当续段，否则曲首弱起不补齐。
  let carried = (ctx.carryIn ?? 0) > 0;
  items.forEach((it, i) => {
    if (it.element.kind !== "barline") return;
    segs.push({ from, to: i, meter: cur, carried });
    if (it.element.temporaryMeter) cur = it.element.temporaryMeter;
    carried = it.element.type === "hidden";
    from = i + 1;
  });
  segs.push({ from, to: items.length, meter: cur, carried });

  const durOf = (seg: { from: number; to: number }): number => {
    let dur = 0;
    for (let i = seg.from; i < seg.to; i++) dur += items[i]!.beats;
    return dur;
  };
  // 整曲末小节 = 最后一个非空段（行以小节线收尾时末段是空的）
  let lastFilled = -1;
  segs.forEach((seg, si) => { if (seg.to > seg.from) lastFilled = si; });
  const out = new Array<number>(items.length).fill(0);
  let tail = 0; // 行末那个开口小节（跨行未收）算到哪个拍位——下一行的续段接着它
  segs.forEach((seg, si) => {
    const size = seg.meter !== undefined ? beatGroupSize(seg.meter.numerator, seg.meter.denominator) : 1;
    let offset = seg.carried ? ctx.carryIn ?? 0 : 0;
    // 残节（弱起、被反复切开的那半个）按小节末尾对齐。两种不补：行末那个开口小节
    // （跨行未收，后半在下一行），以及整曲的末小节（musicpp: `this == measures.back()`）。
    // 曲首那个弱起例外——整行只有它一节时也得补。
    const openTail = si === segs.length - 1 && !(si === 0 && ctx.songStart === true);
    // 判据走公共那一份（engrave/beatgroup.ts）：下一小节正好等于要补的那一截（首尾配对的两个残节）不补
    if (!seg.carried && !openTail && seg.meter !== undefined) {
      const next = segs[si + 1];
      const skip = pickupOffset((seg.meter.numerator * 4) / seg.meter.denominator, durOf(seg),
        ctx.songEnd === true && si === lastFilled, next ? durOf(next) : undefined);
      if (skip > 0) offset = skip;
    }
    for (let i = seg.from; i < seg.to; i++) {
      out[i] = beatGroupIndex(items[i]!.beat, offset, size);
    }
    // 末段非空就是行末的开口小节：行以小节线收尾时它是空的，tail 留 0
    if (si === segs.length - 1 && seg.to > seg.from) tail = offset + durOf(seg);
  });
  return { groups: out, tail };
}

/** 同一拍组内连续的减时线音符连成一条线，跨组断开（`~`/`^` 可强制连断）。 */
export function computeUnderlines(
  voice: ScoreLine,
  items: PlacedItem[],
  m: JianpuGrid,
  groupAt: number[],
): PlacedUnderline[] {
  // 源码里的 `~`（强制连）/`^`（强制断）按它在元素序列里的位置生效
  const forceJoin = new Set<number>();
  const forceSplit = new Set<number>();
  // 行首补的 `|:`（layoutVoiceLine 的 leadRepeat）不在 voice.elements 里，占位序号往后挪一格
  let seen = items[0]?.srcIndex === -1 ? 1 : 0;
  for (const el of voice.elements) {
    if (el.kind === "note" || el.kind === "sustain" || el.kind === "barline") {
      seen += 1;
      continue;
    }
    if (el.kind === "beat-boundary") {
      (el.behavior === "join" ? forceJoin : forceSplit).add(seen - 1);
    }
  }

  const out: PlacedUnderline[] = [];
  // 不可见的音（`x`、补拍位的隐藏休止）下面不画减时线
  const levelOf = (it: PlacedItem): number =>
    it.element.kind === "note" && !it.element.hidden ? Math.max(0, Math.log2(it.element.duration / 4)) : 0;

  const maxLevel = Math.max(0, ...items.map(levelOf));
  for (let level = 1; level <= maxLevel; level++) {
    let runStart: PlacedItem | null = null;
    let runEnd: PlacedItem | null = null;
    const flush = (): void => {
      if (!runStart || !runEnd) return;
      out.push({
        level,
        x0: runStart.x - m.note.beamHalfSpan,
        x1: runEnd.x + m.note.beamHalfSpan,
      });
      runStart = null;
      runEnd = null;
    };
    items.forEach((it, i) => {
      if (levelOf(it) < level) {
        flush();
        return;
      }
      const prev = items[i - 1];
      const breaks =
        prev === undefined ||
        forceSplit.has(i - 1) ||
        (!forceJoin.has(i - 1) && groupAt[i - 1] !== groupAt[i]);
      if (runStart !== null && breaks) flush();
      if (runStart === null) runStart = it;
      runEnd = it;
    });
    flush();
  }
  return out;
}
