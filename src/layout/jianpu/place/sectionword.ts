// 段落词（音符注释，「（副歌）」）的横向落点：判据是 `engrave/sectionword.ts::placeSectionWord`（与旧简谱引擎同一份），
// 这里只把一行里的符号换算成它要的几何——横向撑开（spacing.ts，justify 前预演、行首那条 justify 后匀）
// 与真正摆（band.ts）用同一个换算，两边不会错配。
import type { MusicElement } from "../../../jianpu/ast";
import { placeSectionWord, sectionWordHangLeft, type SectionWordSlot } from "../../../engrave/sectionword";
import type { JianpuGrid } from "../metrics";
import type { PlacedItem } from "./model";

/** 挂得住段落词的符号（音符、增时线）上的那条注释 */
export function sectionWordOf(el: MusicElement): string | undefined {
  return el.kind === "note" || el.kind === "sustain" ? el.annotation : undefined;
}

/** 一个音上的几条段落词（ABC §4.19：同方位连写几条注记就分几行、先写的在上；模型里按换行隔开） */
export function sectionWordLines(text: string): string[] {
  return text.split("\n").filter((l) => l !== "");
}

/** 几行里最宽那一行（横向让位、撑开按它算） */
export function widestLine<T extends { ink: { left: number; right: number } }>(lines: readonly string[], measure: (s: string) => T): T {
  return lines.map(measure).reduce((a, b) => (b.ink.right - b.ink.left > a.ink.right - a.ink.left ? b : a));
}

/** 一行里第一个音符/增时线：行首那一条段落词不往右让、不撑开，justify 之后从行内匀（`nudgeForSectionWords`） */
export function lineStartIndex(items: readonly PlacedItem[]): number {
  return items.findIndex((it) => it.element.kind === "note" || it.element.kind === "sustain");
}

/** 和弦在行里的横向范围（按墨迹） */
export interface ChordSpan {
  x0: number;
  x1: number;
  /** 挂在哪个符号上 */
  at: PlacedItem;
}

/**
 * 第 `i` 个符号上那条段落词落在哪儿（返回落笔点 x）。`xOf` 给符号的锚点 x（数字墨迹中心）——撑开预演时是试算的列坐标，真正摆时是定好的 `it.x`。
 * 锚点取数字墨迹左缘（同旧简谱引擎 `anchorX`），本小节界取前后两条小节线；和弦都当作在同一条基线上（用户定：同一行和弦同基线）。
 * **按墨迹摆**：段落词墨迹左缘对锚点、与和弦墨迹之间留和弦与和弦之间那道空（`spreadChords` 的 0.28 个和弦字号）。
 * 旧简谱引擎按字面盒、净空 0.6 个字号——半身档下开括号「（」的墨迹在笔位右边约半个字身，两笔叠起来就离左边的和弦老远（审图定改）。
 * `word` 是段落词墨迹的左右缘（相对落笔点）。
 */
export function sectionWordSlot(
  items: readonly PlacedItem[],
  i: number,
  xOf: (it: PlacedItem) => number,
  chords: readonly ChordSpan[],
  word: { left: number; right: number },
  m: JianpuGrid,
  lineRight: number,
): SectionWordSlot & { anchorX: number } {
  const it = items[i]!;
  const anchorX = xOf(it) - m.ink.noteHeight * 0.35;
  const bars = items.filter((o) => o.element.kind === "barline").map(xOf).sort((a, b) => a - b);
  const barLeftAt = [...bars].reverse().find((bx) => bx <= anchorX);
  let own: number | undefined;
  for (const c of chords) if (c.at === it) own = Math.max(own ?? -Infinity, c.x1);
  const slot = placeSectionWord({
    anchorX,
    width: word.right - word.left,
    size: m.style.size.sectionWord,
    gap: m.style.size.chord * 0.28,
    baseY: 0,
    chords: chords.map((c) => ({ x0: c.x0, x1: c.x1, y: 0 })),
    barLeft: barLeftAt ?? 0,
    barRight: bars.find((bx) => bx > anchorX) ?? lineRight,
    hangLeft: sectionWordHangLeft(barLeftAt),
    rightLimit: lineRight,
    atLineStart: lineStartIndex(items) === i,
    ...(own !== undefined ? { ownChordRight: own } : {}),
  });
  return { ...slot, x: slot.x - word.left, anchorX };
}
