// 文本谱的小节线类型 → 谱面那一路的 `BarlineSpec`（两边的表达力一一对上）。定位（量宽）与绘制共用。
import type { BarlineSpec } from "../../engrave/barline";
import type { BarlineElement } from "../../jianpu/ast";
import { BarStyle } from "../../score/enums";

/** 文本谱的小节线类型 → 谱面那一路的 `BarlineSpec`（两边的表达力一一对上）。 */
const FANQIE_BARLINE_SPEC: Record<string, BarlineSpec | undefined> = {
  normal: {},
  double: { style: BarStyle.LIGHT_LIGHT },
  end: { style: BarStyle.LIGHT_HEAVY },
  "repeat-start": { repeatForward: true },
  "repeat-end": { repeatBackward: true },
  "repeat-both": { repeatBackward: true, repeatForward: true },
};

/** 一条小节线画成什么样；`null` = 不画线（隐藏线、认不出的类型）。
 *  下一小节左线上起反复（`repeatForwardAfter`）：这条线画成 `|:` / `:|:`（终止线、双线后接的也画成 `|:`）。 */
export function fanqieBarlineSpec(el: BarlineElement): { spec: BarlineSpec; final: boolean } | null {
  // 终止线、双线后紧接起反复（MusicXML 分谱常见：前一小节 `light-heavy`、下一小节左线 `<repeat forward>`）也画成 `|:`，
  // 否则反复点丢了、`:|` 看着像是跳回曲首
  const type = el.repeatForwardAfter && (el.type === "normal" || el.type === "end" || el.type === "double") ? "repeat-start"
    : el.repeatForwardAfter && el.type === "repeat-end" ? "repeat-both" : el.type;
  const spec = FANQIE_BARLINE_SPEC[type];
  return spec ? { spec, final: type === "end" } : null;
}
