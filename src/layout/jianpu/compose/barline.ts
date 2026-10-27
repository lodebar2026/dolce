// 小节线（含反复点、跳转记号）的绘制。
import { Font } from "../../../pagetree/font";
import { Group } from "../../../pagetree/pageitem";
import { BarlineGlyph } from "../../../engrave/barline";
import { fanqieBarlineSpec } from "../barspec";
import { TIME_SIG_PAD_EM } from "../place/spacing";
import { barlineSpan } from "../metrics";
import type { PlacedItem } from "../place/model";
import type { OriginalCtx } from "./ctx";
import { paintMeter } from "./header";
import { paintOrnaments } from "./note";

/** `spanHeight` > 0 时，这条小节线从 baseline 一直画到 baseline+spanHeight（贯穿多声部）。
 *
 *  **线本身收在一个 `Group` 里**并作为返回值交出去：几条竖线加反复点是好几个图元，散着放
 *  就是几个互不相干的 `<g>`，可视化编辑罩不出一个框、也点不中整条线。挂在线上的记号与
 *  临时拍号不进这个组（它们各自是独立对象）。线不画时返回 null。 */
export function paintBarline(c: OriginalCtx,
  root: Group,
  x: number,
  baseline: number,
  it: PlacedItem,
  spanHeight = 0,
): Group | null {
  const m = c.metrics;
  const el = it.element;
  if (el.kind !== "barline") return null;
  if (el.type === "hidden" || el.type === "invisible" || it.noBarline) {
    // 线本身不画，但挂在它上面的记号与临时拍号仍要画
    if (el.ornaments.length > 0) {
      const g = new Group();
      paintOrnaments(c, g, el, x, baseline);
      root.add(g);
    }
    if (el.temporaryMeter) {
      const font = new Font(m.style.font.text.family, m.style.size.keyMeter * 0.85);
      paintMeter(c, root, x + m.style.size.note * TIME_SIG_PAD_EM, baseline, el.temporaryMeter, font);
    }
    return null;
  }

  // 粗细组合、反复点、线间距**全部走谱面那一路的画法**（engrave/barline.ts::BarlineGlyph）。
  // 原先这里是自成一套：填充 rect 而不是 GraphicLine、粗线 ×2.6、线距 barlineDoubleGap、
  // 反复点在 ±0.18H 且离线 6px——同一件事两种写法，改一处忘一处。
  // 纵向范围与旧简谱引擎同一口径（`barlineSpan`），连谱号跨声部时下缘再加 spanHeight。
  const span = barlineSpan(m);
  const bs = fanqieBarlineSpec(el);
  if (!bs) {
    if (el.ornaments.length > 0) {
      const og = new Group();
      paintOrnaments(c, og, el, x, baseline);
      root.add(og);
    }
    return null;
  }
  const r = new BarlineGlyph(bs.spec, bs.final, {
    top: span.top,
    bot: span.bottom + spanHeight,
    light: m.style.stroke.barline,
    heavy: m.style.stroke.finalBarline,
    dotRadius: m.style.dot.repeat,
    color: c.ink,
  });
  // BarlineGlyph 的 x 从 0 起；文本谱的小节线是**居中于锚点**的
  const ox = x - r.width / 2;
  // 临时拍号：`|"p:2/4"`，画在这条小节线组的右缘之后、前空一格（占位同口径，见 place/spacing.ts::barlineBox / meterAdvance）
  if (el.temporaryMeter) {
    const font = new Font(m.style.font.text.family, m.style.size.keyMeter * 0.85);
    const last = r.lines[r.lines.length - 1]!;
    const right = bs.spec.repeatForward ? r.width + 2 * m.style.dot.repeat : last.x + last.strokeWidth;
    paintMeter(c, root, ox + right + m.style.size.note * TIME_SIG_PAD_EM, baseline, el.temporaryMeter, font);
  }
  if (el.ornaments.length > 0) {
    const og = new Group();
    paintOrnaments(c, og, el, x, baseline);
    root.add(og);
  }
  const g = new Group();
  for (const item of r.items) {
    item.x += ox;
    item.y += baseline;
    g.add(item);
  }
  root.add(g);
  return g;
}
