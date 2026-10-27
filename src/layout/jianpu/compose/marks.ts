// 记号层：弧线、多连音、跳房子、渐强渐弱（内联层在 page.ts，与 paintVoice 互相调用）。
import { Font } from "../../../pagetree/font";
import { Point } from "../../../common/geom";
import { Group } from "../../../pagetree/pageitem";
import { Slur } from "../../../engrave/arc";
import { addEndingBracket, endingDrop, endingLabelDx } from "../../../engrave/ending";
import { TupletGlyph } from "../../../engrave/tuplet";
import { hairpinPath, JP_HAIRPIN, jpHairpinHalves, jpHairpinLineWidth } from "../../../engrave/hairpin";
import { bracketLineWidth, jianpuSlurStyle } from "../metrics";
import type { PlacedMark } from "../place/model";
import { belowArcStyle } from "../place/marks";
import type { OriginalCtx } from "./ctx";

/** 弧线：直接用简谱谱面那套 SlurTieBase（月牙形，中间厚两端尖），两处观感一致。
 *  弧高（含超长跨度改扁平的阈值）由 jianpuSlurStyle 定，与 layout 的纵向预留同源。 */
function paintArc(c: OriginalCtx, root: Group, x0: number, x1: number, y: number, flat = false, below = false): Slur {
  const arc = new Slur();
  const style = below ? belowArcStyle(c.metrics, c.ink) : jianpuSlurStyle(c.metrics, c.ink);
  arc.init(new Point(x0, y), new Point(x1, y), flat ? { ...style, forceFlat: true } : style);
  arc.update();
  root.add(arc);
  return arc;
}

export function paintMark(c: OriginalCtx, root: Group, mk: PlacedMark, left: number, baseline: number): void {
  const m = c.metrics;
  const x0 = left + mk.x0;
  const x1 = Math.max(left + mk.x1, x0 + 6);
  switch (mk.mark.type) {
    case "slur": {
      const y = baseline + (mk.y ?? -m.ink.noteHeight / 2);
      const arc = paintArc(c, root, x0, x1, y, mk.flat === true, mk.below === true);
      // 弧没有自己的 id，可视化编辑按「起点:终点」认它（同 `Tie.startId`）。
      // **不能用 `mk.mark.start/end`**——那是行内下标，元素 id 要从两端实际落在的符号上取
      const sid = mk.startEl && c.doc?.idOf.get(mk.startEl);
      const eid = mk.endEl && c.doc?.idOf.get(mk.endEl);
      if (sid !== undefined && eid !== undefined) arc.ident = { kind: "slur", id: sid, end: eid };
      break;
    }
    case "tuplet": {
      // 多连音：括线或两段弧（样式键 `tuplet-style`，出厂括线同 500 首；番茄、诗歌本风格是弧），在正中**被连音数字断开**。
      // 画法走公共那一份（engrave/tuplet.ts，与旧简谱引擎同一套）：弧与同页 slur 同一条月牙挖掉数字那一截；
      // 括线的脚落在弧端那条线上（`mk.y`），横线在它之上一个脚长。数字是 SMuFL 的 tuplet 字形、按墨迹坐在线上。
      const y = baseline + (mk.y ?? -m.ink.noteHeight / 2);
      // 连音数取模型里的实际数（`caption` = tupletActual），没有才按跨了几个符号数
      const n = Number(mk.mark.caption) || mk.mark.end - mk.mark.start + 1;
      const bracket = m.style.look.tupletStyle === "bracket";
      const foot = m.style.vertical.bracketFoot > 0 ? m.style.vertical.bracketFoot * 0.55 : m.style.size.note * 0.25;
      const ly = bracket ? y - foot : y;
      const tg = new TupletGlyph(new Point(x0, ly), new Point(x1, ly), n, {
        kind: bracket ? "bracket" : "arc",
        color: c.ink,
        music: new Font("Bravura", c.digitFont.size),
        lineWidth: bracketLineWidth(m),
        foot,
        arc: jianpuSlurStyle(m, c.ink),
      });
      for (const it of tg.items) root.add(it);
      break;
    }
    case "crescendo":
    case "decrescendo": {
      // 横向范围（含让开起止音上的力度字）与 `mk.y`（松叶墨迹底边）都在定位端定好（place/marks.ts::wedgeSpan、place/band.ts）；
      // 开口与线宽同旧简谱引擎（engrave/hairpin.ts::JP_HAIRPIN），跨行那两截各张到几成见 `jpHairpinHalves`
      const nh = m.ink.noteHeight;
      const lw = jpHairpinLineWidth(m.style.stroke.hairpin, nh);
      const y = baseline + (mk.y ?? -nh / 2) - lw / 2 - nh * JP_HAIRPIN.half;
      const [half0, half1] = jpHairpinHalves(mk.mark.type === "crescendo" ? "crescendo" : "diminuendo", nh, mk.openLeft, mk.openRight);
      // 画法走公共那一份（engrave/hairpin.ts，与五线谱同一笔）
      const hp = hairpinPath({ x0, x1, y, half0, half1, lineWidth: lw, color: c.ink });
      hp.classes.add("hairpin"); // 同旧简谱引擎（`Line.addWedges`）；叶子的类名不进 SVG，只给页面树上的检查脚本认
      root.add(hp);
      break;
    }
    case "volta": {
      const y = baseline + (mk.y ?? -m.ink.noteHeight / 2);
      // 画法走公共那一份（engrave/ending.ts，与旧简谱引擎、混排同一套）；字号、竖脚、房号离左脚的距离同旧简谱引擎（尺子的 `size.ending`、`bracketFoot`）
      const size = m.style.size.ending;
      const foot = m.style.vertical.bracketFoot;
      const lw = bracketLineWidth(m);
      // 房号照原文印（`1,2` 就是 `1,2`，用户定：原样档不规整；旧简谱引擎才按 `normEndingText` 统一成 `1.2`）。跨行续过来的房子不再重复房号
      const showLabel = !!mk.mark.caption && !mk.openLeft;
      addEndingBracket(root, {
        x0, x1, top: y, drop: endingDrop(foot, size),
        leftFoot: !mk.openLeft,
        // `]/`（诗歌本）与 `[…/`（番茄）表示右端不封口
        rightFoot: !mk.openRight && mk.mark.openEnd !== true,
        lineWidth: lw, color: c.ink,
        label: showLabel
          ? { text: mk.mark.caption!, font: c.digitFont.makeWithSize(size), dx: endingLabelDx(lw, size, foot) }
          : undefined,
        classes: { line: "ending-line", label: "ending" },
      });
      break;
    }
  }
}
