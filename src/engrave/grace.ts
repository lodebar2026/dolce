// 倚音的几何：小号数字 + 八度点 + 减时线 + 连接钩。
// 竖向的点与线走叠层（engrave/stack.ts，墨迹到墨迹等距），支持高、低音点（钩子接在最低那件之下）。
//
// **两条简谱路共用这一份**（文本谱 `layout/jianpu/compose/note.ts::paintGrace`、成书/编辑器
// `src/layout/layout.ts::addGraceNotes`）。两边的绘图原语不一样（一边是 fanqie 自己的
// text/dot/rect/stroke，一边是页面树的 TextFrame/GraphicPath），所以这里只算**坐标**，
// 落笔各自去做。
//
// 横向比例照原版矢量量的，单位 = **主音数字的墨迹高**（`ink`）：
// 倚音墨迹高 0.50、中心在主音墨迹中心上方 0.94、离主音中心 0.665；
// 减时线长 0.388、线宽 0.055、落在倚音中心下方 0.42（原版是 0.36，见 `GRACE_BEAM_DROP`）；
// 连接钩从减时线中点垂下再朝主音弯（水平 0.249、垂直 0.304）。

import { beamY, highDotY, lowDotY, stackBottom, type StackStyle } from "./stack";

/** 主音那一侧的度量。各路把自己的常量折算成这几个数。 */
export interface GraceMetrics {
  /** 主音数字的**墨迹高**——所有比例的基准。 */
  ink: number;
  /** 倚音字号 ÷ 主音字号。 */
  scale: number;
  /** 高音点的 y（相对主音基线，向上为负）与低音点的 y。
   *  **倚音不用这两个**（倚音的八度点按自己的墨迹边缘排，见 `graceGeometry`）——
   *  它们是各路画**主音**八度点用的，留在这里是因为两条路共用同一个度量对象。 */
  octaveUpY: number;
  octaveDownY: number;
  /** 多个八度点之间的间距、点半径。 */
  octaveDotGap: number;
  octaveDotRadius: number;
  /** 减时线之间的层距（主音那一摞用；倚音自己的叠层按 `stackGap` 等距排）。 */
  underlineGap: number;
  /** 叠层的空 ÷ 数字墨迹高（engrave/stack.ts，样式键 `stack-gap`）：倚音里的减时线、八度点按它等距排，
   *  基准换成倚音自己的墨迹高。 */
  stackGap: number;
}

/** 一颗倚音占多宽（单位 = 主音墨迹高 `ink`）。 */
const GRACE_STEP = 0.45;
/** 带升降号的那一颗要额外多占这么一截，数字在格子里跟着右移同样多——
 *  不让位的话升降号会骑到左边那颗倚音上。 */
const GRACE_ACC_INSET = 0.32;

/** 钩子尺寸的基准（÷ 主音墨迹高）：原版倚音的墨迹高。叠层按各路实际的 `GraceMetrics.scale`。 */
const GRACE_INK = 0.5;
/** 减时线线宽（也是钩子的线宽）——这是**墨迹**不是间距，放宽间距时不要跟着动。 */
const GRACE_BEAM_H = 0.055;

/** 倚音的临时升降号。两条路的原始口径不一样（简谱是 `jpAlter` 的 `#/b/n`、
 *  文本谱是 `NoteElement.accidental`），在这里统一成这一套名字。 */
export type GraceAlter = "sharp" | "flat" | "natural" | "double-sharp" | "double-flat";

/** 一颗倚音：数字、八度（正=高音点、负=低音点）、时值（4 = 四分，8 = 八分…）。 */
export interface GraceNote {
  digit: string;
  octave: number;
  /** MusicXML 的 duration 口径：fanqie 那边是 `gn.duration`，4 = 四分。默认 8（八分）。 */
  duration?: number;
  /** 临时升降号。带号的那一颗要多占 `GRACE_ACC_INSET` 一截（见 `graceAdvance`）。 */
  alter?: GraceAlter;
}

export interface GraceGeom {
  /** 数字：按**墨迹中心**定位（调用方按自己的字体度量把中心换算成基线）。 */
  digits: { text: string; cx: number; cy: number; size: number }[];
  dots: { cx: number; cy: number; r: number }[];
  /** 升降号：**按墨迹定位**——两条路各自量自己的 SMuFL 字形，把墨迹右缘贴到 `inkRight`、
   *  墨迹竖向中心对齐 `inkCy`、字号取到墨迹高等于 `inkHeight`。
   *  给的不是字号是因为两边字体度量不同，靠固定偏移放会随字体漂（与 fanqie 主音那套同理）。 */
  accidentals: { alter: GraceAlter; inkRight: number; inkCy: number; inkHeight: number }[];
  /** 减时线（矩形）。**同一层里相邻的倚音连成一条通杠**，不是一颗一小段。 */
  beams: { x: number; y: number; w: number; h: number }[];
  /** 连接钩：一段三次贝塞尔（`m` 起点，`c` 两个控制点 + 终点），`width` 是线宽。 */
  hook: { m: [number, number]; c: [number, number, number, number, number, number]; width: number } | null;
}

/**
 * 算出一组倚音该画在哪儿。
 *
 * @param x        主音数字的**墨迹中心** x
 * @param baseline 主音的基线 y
 * @param dir      -1 = 前倚音（画在左），1 = 后倚音（画在右）
 */
export function graceGeometry(
  notes: readonly GraceNote[],
  m: GraceMetrics,
  x: number,
  baseline: number,
  dir: -1 | 1,
  fontSize: number,
  /** 倚音数字**墨迹中心**的 y。省略 = 番茄原版那套（基线上方 0.94 个墨迹高）。
   *  简谱这一路要按音符的**墨迹栈顶**算：原书实测倚音中心在主音中心上方
   *  1.13~1.77 个音符高，差的那一截正是有没有高音点。 */
  centerY?: number,
): GraceGeom {
  const out: GraceGeom = { digits: [], dots: [], accidentals: [], beams: [], hook: null };
  if (!notes.length) return out;
  const ink = m.ink;
  const size = fontSize * m.scale;
  const nearest = x + dir * ink * 0.665; // 最靠近主音的那个
  const gy = centerY !== undefined ? centerY : baseline - ink * 0.94;
  const halfBeam = ink * 0.194;
  // 横向：每颗占**自己那一格**（带升降号的宽一截），格子里数字居中偏右、升降号占前面
  // 那一截。没有升降号时逐格宽度都是 `GRACE_STEP`，中心距回到从前那个常数 0.45 ink。
  const centers: number[] = [];
  let cursor = 0;
  for (const gn of notes) {
    const inset = gn.alter ? ink * GRACE_ACC_INSET : 0;
    centers.push(cursor + inset + ink * (GRACE_STEP / 2));
    cursor += inset + ink * GRACE_STEP;
  }
  // 贴着主音的那一颗定锚：前倚音是最后一颗，后倚音是第一颗（两种方向都保持读序）
  const anchor = dir < 0 ? notes.length - 1 : 0;
  const shift = nearest - centers[anchor]!;
  const gxs = centers.map((c) => c + shift);
  // 竖向：倚音数字、减时线、八度点按**倚音自己的**叠层排（engrave/stack.ts，墨迹到墨迹等距，
  // 空 = stackGap × 倚音墨迹高），与主音那一摞同一个口径，只是整体缩小。
  // **点半径照主音整体缩小**（倚音墨迹高是主音的 `scale` 倍，点也同比）。
  // 墨迹高按**实际字号比** `m.scale` 算，不按常数：旧简谱引擎的倚音是 0.59，照 0.5 排的话数字墨迹底
  // 比算的低一截，正好吃掉数字与第一条减时线之间那道空（看着贴在一起）。
  const gInk = ink * m.scale;
  const st: StackStyle = { gap: m.stackGap * gInk, dotRadius: m.octaveDotRadius * m.scale, beamWidth: ink * GRACE_BEAM_H };
  const inkTop = gy - gInk / 2;
  const inkBottom = gy + gInk / 2;
  // 倚音默认八分：一条减时线；时值再短就多一层。比主音的细得多。
  const lvCounts = notes.map((gn) => Math.max(1, Math.ceil(Math.log2((gn.duration ?? 8) / 4))));
  const beamTop = (lv: number): number => beamY(inkBottom, lv + 1, st) - st.beamWidth / 2;
  // **同一层里相邻的倚音连成一条通杠**（`3_2_` 这种要画一条横线贯到底，不是两小段）。
  // 层数不齐时按「这一层还有份的连续段」分别连，与主音符的符杠同一个道理。
  const maxLv = Math.max(...lvCounts);
  for (let lv = 0; lv < maxLv; lv++) {
    let runStart = -1;
    for (let i = 0; i <= notes.length; i++) {
      const on = i < notes.length && lvCounts[i]! > lv;
      if (on && runStart < 0) runStart = i;
      if (!on && runStart >= 0) {
        const x1 = gxs[runStart]! - halfBeam;
        const x2 = gxs[i - 1]! + halfBeam;
        out.beams.push({ x: x1, y: beamTop(lv), w: x2 - x1, h: st.beamWidth });
        runStart = -1;
      }
    }
  }
  let hookAt: { mid: number; y: number; low: boolean } | null = null;
  notes.forEach((gn, i) => {
    const gx = gxs[i]!;
    out.digits.push({ text: gn.digit, cx: gx, cy: gy, size });
    // 升降号贴在这一颗数字墨迹的左缘。竖向照 fanqie 主音那一套（墨迹中心在墨迹底上方
    // 0.34 个字高、降号再低 0.08），只是所有量都按倚音的墨迹高。
    if (gn.alter) {
      out.accidentals.push({
        alter: gn.alter,
        inkRight: gx - halfBeam - gInk * 0.1,
        inkCy: gy + gInk * 0.5 - gInk * 0.34 + (gn.alter.includes("flat") ? gInk * 0.08 : 0),
        inkHeight: gInk * 0.78,
      });
    }
    const beams = lvCounts[i]!;
    for (let k = 0; k < gn.octave; k++) out.dots.push({ cx: gx, cy: highDotY(inkTop, k, st), r: st.dotRadius });
    for (let k = 0; k < -gn.octave; k++) out.dots.push({ cx: gx, cy: lowDotY(inkBottom, beams, k, st), r: st.dotRadius });
    if (i === anchor) {
      // 钩子从这一摞的最下一件起笔：有低音点就在最低那个点下面再让一道空（与点之间同一个空），
      // 否则就从最下一条减时线垂下来
      const low = gn.octave < 0;
      hookAt = { mid: gx, y: low ? stackBottom(inkBottom, beams, -gn.octave, st) + st.gap : beamTop(beams - 1), low };
    }
  });
  if (hookAt === null) return out;
  const { mid, y: uy, low } = hookAt as { mid: number; y: number; low: boolean };
  // **有低音点时钩子接在低音点下方**：低音点排在数字正下方（cx = gx），钩子也从那儿
  // 垂下来；起点顺着同一条竖轴下移到最低那个点的下缘之外，中间留一道空（已经算进 `hookAt.y`）。
  const startY = low ? uy : uy + ink * 0.033;
  out.hook = { ...graceHook(mid, startY, ink * GRACE_INK, -dir as -1 | 1), width: ink * GRACE_BEAM_H };
  return out;
}

/** 钩子垂下多深、朝主音伸多远（÷ 倚音墨迹高）。照原版矢量量的（主音墨迹高的 0.304 / 0.249）。 */
const HOOK_DROP = 0.304 / GRACE_INK;
const HOOK_REACH = 0.249 / GRACE_INK;

/**
 * 连接钩的那一笔：从 (mid, startY) 垂下再朝主音弯（`toward` = 1 朝右，即前倚音；−1 朝左）。
 * 三引擎同一个形状（混排的倚音也用它），尺寸按倚音墨迹高 `gInk`。
 */
export function graceHook(mid: number, startY: number, gInk: number, toward: -1 | 1): {
  m: [number, number];
  c: [number, number, number, number, number, number];
} {
  const drop = gInk * HOOK_DROP;
  const reach = gInk * HOOK_REACH * toward;
  return {
    m: [mid, startY],
    c: [mid, startY + drop * 0.6, mid - reach * 0.15, startY + drop * 0.87, mid + reach, startY + drop],
  };
}

/**
 * 一组倚音那一摞的**墨迹底缘**（相对传给 `graceGeometry` 的那个 `centerY`）：数字、减时线、低音点里最低的。
 *
 * **不算连接钩**：钩子是从这一摞垂到主音身旁的那一笔，本来就该比主音顶低。
 * 落位规则「整块倚音的底离主音那一摞的顶一道空」用它——按 `centerY = 0` 排一遍量出底缘，
 * 再回填真正的 `centerY`（两个引擎同一条，见 `compose/note.ts::paintGrace`、混排 `graceRow`）。
 */
export function graceBottom(g: GraceGeom, m: GraceMetrics): number {
  let low = (m.ink * m.scale) / 2; // 数字自己的墨迹底
  for (const b of g.beams) low = Math.max(low, b.y + b.h);
  for (const d of g.dots) low = Math.max(low, d.cy + d.r);
  return low;
}

/** 一组倚音占多宽（主音之外的那一截）——排版要按它给音符前面留位。
 *  带升降号的那几颗宽一截，所以按逐颗累加，不是「颗数 × 常数」。 */
export function graceAdvance(notes: readonly GraceNote[], m: GraceMetrics): number {
  let w = 0;
  for (const gn of notes) w += m.ink * (GRACE_STEP + (gn.alter ? GRACE_ACC_INSET : 0));
  return w;
}
