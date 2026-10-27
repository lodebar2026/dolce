// 混排渲染的落笔小工具（线、SMuFL 字形、平移组）。五线谱层（`render.ts`）与简谱叠层（`jianpuoverlay.ts`）共用。

import { Matrix33 } from "../common/geom";
import { type GraphicLine, Group } from "../pagetree/pageitem";
import { lineItem, textItem } from "../engrave/prims";
import { Font } from "../pagetree/font";
import type { ElementId } from "../model/doc";

/** 一个和弦画出来的那一组（五线谱层的符头、符干、符尾；简谱叠层的那一柱）的类名（`.selected` 描蓝挂在它上面）。
 *  身份走标签（`pagetree/identity.ts`，`note` + 元素 id），播放线、点选、可视化编辑都经 `layout/scoreindex.ts` 认。 */
export const STAFF_CHORD = "staff-chord";
/** 一行系统的组的类名。身份标签 `system`；`data` 是 `StaffSystemData`：谱表带（混排连同简谱层）的上下沿，系统坐标（tenths）。 */
export const STAFF_SYSTEM = "staff-system";
export interface StaffSystemData {
  readonly top: number;
  readonly bottom: number;
}

/** 和弦组的 `data`：符头（休止符）那一列的中心 x，和弦组坐标（tenths）。播放线按它居中、定宽（`layout/playhead.ts`），
 *  不随符尾、二度错开的头、整小节休止撑宽。 */
export interface StaffChordData {
  readonly cx: number;
}

/** 和弦 `id` 的组（见 `STAFF_CHORD`）。 */
export function chordGroup(id: ElementId): Group {
  const g = new Group();
  g.classes.add(STAFF_CHORD);
  g.ident = { kind: "note", id };
  return g;
}

export function addLine(g: Group, x1: number, y1: number, x2: number, y2: number, lw: number): GraphicLine {
  const l = lineItem(x1, y1, x2, y2, lw, 0xff000000);
  g.add(l);
  return l;
}

/** SMuFL glyph via TextFrame with Bravura family. */
export function addSmufl(g: Group, glyph: string, x: number, y: number, size: number): void {
  g.add(textItem(glyph, new Font("Bravura", size), 0xff000000, x, y));
}

/** SMuFL glyph with scale transform. */
export function addSmuflScaled(
  g: Group,
  glyph: string,
  x: number,
  y: number,
  size: number,
  scx: number,
  scy: number,
): void {
  const grp = new Group();
  const m = new Matrix33();
  m.setAffine([scx, 0, 0, scy, x, y]);
  grp.matrix = m;
  addSmufl(grp, glyph, 0, 0, size);
  g.add(grp);
}

export function translated(x: number, y: number): Group {
  const g = new Group();
  const m = new Matrix33();
  m.setAffine([1, 0, 0, 1, x, y]);
  g.matrix = m;
  return g;
}
