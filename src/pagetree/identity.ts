// 图元的身份标签：排版引擎画一个图元时顺手标上「它画的是谁」，播放高亮、点选、可视化编辑
// 一律从标签认（`scoreindex.ts` 收、`playhead.ts` 用），不再各自去认引擎内部的对象（`NoteEntry`、`Barline`…）。
//
// 只挂在 `PageItem.ident` 上，不进 SVG。

import type { ElementId } from "../model/doc";

export type IdentityKind =
  /** 音符格（数字连同挂在它上面的点、记号、和弦） */
  | "note"
  /** 增时线格。`id` 是增时线自己的元素 id；没有自己 id 的（`.jpwabc` 的 `-` 写在音符 token 里）用宿主音符的 id，按 `ord` 认第几条 */
  | "sustain"
  | "barline"
  /** 圆滑线 / 延音线：`id` 起点、`end` 终点 */
  | "slur"
  /** 一个歌词音节。`id` 缺省 = 跟所在音符格（旧简谱引擎把各段歌词收在音符格里） */
  | "syllable"
  /** 一行谱（多声部时是连谱号括起的整组）：播放线的竖向范围按它取 */
  | "system"
  /** 音符格里的部件：和弦名、装饰记号、注记、附点（可视化编辑单独点选） */
  | "harmony"
  | "deco"
  | "annotation"
  | "aug-dot"
  /** 页眉里的一行字（五线谱 / 混排的标题块；可视化编辑按所画的字对回原文字段） */
  | "header";

export interface ItemIdentity {
  kind: IdentityKind;
  id?: ElementId;
  /** 第几遍（展开档同一个音每遍各画一次）；原样档恒为 0 */
  pass?: number;
  /** 歌词：简谱是行内段序（0 起）；五线谱 / 混排是源段号（1 起） */
  verse?: number;
  /** 小节线：画在 `id` 那个音符的哪一侧（小节线没有自己的 id，按相邻音符认）。`id` 缺省 = 按页面树顺序借相邻音符 */
  edge?: "before" | "after";
  /** 五线谱 / 混排的小节线：按小节认（全曲下标），`edge` 是它在这一小节的哪一侧（系统开头那条是首小节的 `before`，
   *  其余是前一小节的 `after`）。一条线每个谱表组画一段，混排的简谱层再一段 */
  measure?: number;
  /** 小节线：同一条线还属于这些音符（多声部贯穿的线挨着各声部各一个音） */
  also?: ElementId[];
  /** 弧的终点 */
  end?: ElementId;
}

/** 同一图元再挂一个「挨着它的音符」（多声部贯穿的小节线）。 */
export function addBarlineOwner(item: { ident?: ItemIdentity }, id: ElementId, edge: "before" | "after"): void {
  const cur = item.ident;
  if (!cur || cur.kind !== "barline" || cur.id === undefined) {
    item.ident = { kind: "barline", id, edge };
    return;
  }
  if (cur.id === id) return;
  (cur.also ??= []).includes(id) || cur.also.push(id);
}
