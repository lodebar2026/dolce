// 小节线的样式与反复记号。移植自 musicpp `qtomr/system.cpp::System::analyzeMeasures`
// 里定 `BarLineStyle` 的那一段，另加**反复点**的判定（musicpp 没做这一档）。
//
// 坐标一律设备坐标、y 向下。
import { SPage, Staff, Sym } from "./model";

/** 一处小节线（可能由好几笔组成：细+粗、反复点+细+粗）。 */
export interface BarlineMark {
  /** 这一处的 x（取最右一笔，音符按它归小节）。 */
  x: number;
  /** 最左一笔的 x（判反复点在哪一侧用）。 */
  left: number;
  /** MusicXML 的 `<bar-style>`；普通细线返回 null（不必写）。 */
  style: string | null;
  /** 反复方向：`forward` = `|:`、`backward` = `:|`、`both` = `:|:`。 */
  repeat: "forward" | "backward" | "both" | null;
}

/**
 * 把一行谱上的小节线笔画归成「处」，并定样式。
 *
 * 三条判据：
 *   1. **挨得比两个线距还近的几笔是同一处**（细+粗的终止线、反复线的两笔）。
 *      同一笔常常被重描好几遍（实测 p205 的终止线画了 8 遍），先按 x 去重。
 *   2. 一处里有**粗**笔（线宽超过三分之一线距）就是 `light-heavy`（终止/反复），
 *      否则两笔就是 `light-light`（复纵线），单笔是普通线。
 *   3. **反复点**：谱表第二、三间里上下两枚圆点。点在这一处**左边**是 `:|`（收）、
 *      右边是 `|:`（起）、两边都有是 `:|:`。本书的反复点用的是 `augmentationDot` 字形
 *      （Maestro 一路）或 `repeatDots`（Anastasia 一路），两种都要认。
 */
export function classifyBarlines(pg: SPage, stf: Staff): BarlineMark[] {
  const sp = pg.normalStaffSpace || pg.space;
  // 这一行谱上的所有小节线笔画（路径段 + 字形）
  const xs: { x: number; lw: number }[] = [];
  for (const s of pg.segsWithTag("BarLine")) {
    if (s.box.top > stf.box.bottom || s.box.bottom < stf.box.top) continue;
    xs.push({ x: s.cx, lw: s.lw });
  }
  for (const s of pg.symbols) {
    if (!s.hasTag("BarLine")) continue;
    if (s.box.top > stf.box.bottom || s.box.bottom < stf.box.top) continue;
    // Anastasia 的 `barlineFinal` 一个字形就是「细+粗」，按粗笔算
    xs.push({ x: (s.box.left + s.box.right) / 2, lw: s.code === "barlineSingle" ? 0 : sp });
  }
  xs.sort((a, b) => a.x - b.x);

  // 去重 + 归组
  const groups: { xs: number[]; lw: number }[] = [];
  for (const it of xs) {
    const g = groups[groups.length - 1];
    if (g && it.x - g.xs[g.xs.length - 1] < sp * 2) {
      // 同一笔的重描不算新笔。位图路一笔常断成上下两截、x 差一两个像素（扫描件歪斜，望十架 p5 m42 689 / 690），
      // 按 0.3 个单位算成复纵线；真复纵线两笔隔半格上下，门槛取四分之一格
      if (it.x - g.xs[g.xs.length - 1] > Math.max(0.3, sp * 0.25)) g.xs.push(it.x);
      g.lw = Math.max(g.lw, it.lw);
    } else {
      groups.push({ xs: [it.x], lw: it.lw });
    }
  }

  // 反复点：落在谱表内、上下成对的圆点
  const dots = pg.symbols.filter(
    (s) =>
      (s.code === "augmentationDot" || s.code === "repeatDots") &&
      !s.hasTag("Augmentation") &&
      s.py > stf.box.top &&
      s.py < stf.box.bottom,
  );

  // 粗笔的门槛：三分之一线距；整页小节线本来就粗的（低分辨率的粗线扫描件，线宽过线距三成）按**整页**小节线笔画中位线宽的 1.8 倍。
  // 不按本行取：曲末的短行只有一两处小节线，中位数就是终止线自己。偶数个取偏小的那个，同一个道理
  const lws = pg.segsWithTag("BarLine").map((s) => s.lw).sort((p, q) => p - q);
  const heavy = Math.max(sp / 3, (lws[(lws.length - 1) >> 1] ?? 0) * 1.8);
  const out: BarlineMark[] = [];
  for (const g of groups) {
    const left = g.xs[0];
    const x = g.xs[g.xs.length - 1];
    const style = g.lw > heavy ? "light-heavy" : g.xs.length > 1 ? "light-light" : null;
    let before = false;
    let after = false;
    // 只有一道细线的一处，反复点要贴着它（一格内）：附点二分和弦的两个点离后面的小节线两格，
    // 位置又正好在第二、三间（我灵镇静 B♭4/G4），按两格开窗全被当成反复点
    const reach = g.lw > sp / 3 || g.xs.length > 1 ? sp * 2 : sp * 1.0;
    for (const d of dots) {
      const dx = d.px - (left + x) / 2;
      if (Math.abs(dx) > reach) continue;
      // `repeatDots` 一个字形就是上下两点；`augmentationDot` 要两枚才算，而且**夹着第三线**
      // （在第二、三间，两点中点落在谱表中线上）：三度和弦的两个附点也是上下隔一格，但在别的间
      // （我灵镇静 A4/F4 附点二分，点在第一、二间，右边两格就是小节线，被当成反复点，附点整批丢了）
      const mid = (stf.box.top + stf.box.bottom) / 2;
      const pair =
        d.code === "repeatDots" ||
        dots.some((o) => o !== d && Math.abs(o.px - d.px) < sp * 0.4 && Math.abs(o.py - d.py) > sp * 0.5 && Math.abs(o.py - d.py) < sp * 1.5 && Math.abs((o.py + d.py) / 2 - mid) < sp * 0.3);
      if (!pair) continue;
      if (dx < 0) before = true;
      else after = true;
    }
    const repeat = before && after ? "both" : before ? "backward" : after ? "forward" : null;
    out.push({ x, left, style: repeat && !style ? "light-heavy" : style, repeat });
  }
  return out;
}

/** 反复点用掉之后打个标，免得被别处（附点、演奏法）再认一遍。 */
export function tagRepeatDots(pg: SPage, stf: Staff, marks: BarlineMark[]): void {
  const sp = pg.normalStaffSpace || pg.space;
  const xs = marks.filter((m) => m.repeat).map((m) => (m.left + m.x) / 2);
  if (!xs.length) return;
  for (const s of pg.symbols) {
    if (s.code !== "augmentationDot" && s.code !== "repeatDots") continue;
    if (s.hasAnyTag()) continue;
    if (s.py < stf.box.top || s.py > stf.box.bottom) continue;
    if (!xs.some((x) => Math.abs(s.px - x) < sp * 2)) continue;
    (s as Sym).addTag("BarLine");
  }
}
