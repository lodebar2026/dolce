// 内联层：`{bz…}` 临时伴奏（主旋律上方小字号行）与 `{dsb…}` 并排块。
import type { InlineLayerElement, ScoreLine } from "../../../jianpu/ast";
import type { JianpuGrid } from "../metrics";
import type { InkMeasurer, PlacedItem, PlacedLayer, PlacedSplit } from "./model";
import { type BeatCtx, SPLIT_BRACE_W, computeUnderlines, layoutVoiceLine } from "./voice";
import { splitRise } from "./vertical";
import { placeMarks } from "./marks";

/** 并排块里那一层自己的行（括起的内容）。 */
export function layerLine(voice: ScoreLine, el: InlineLayerElement): ScoreLine {
  return { voice: voice.voice, elements: el.elements, marks: el.marks, lyrics: [], raw: el.code, source: el.source };
}

/** 同一谱表第二声部的并排下行（`below`）：先按自己的节奏排好，与主行一起归列（`spacing.ts::placeColumns`），
 *  这样下行比主行细的拍位（主行八分、下行十六分）也有自己的列，不用按比例硬塞。返回层 → 排好的行与它从第几小节起。 */
export function belowLayerLines(
  voice: ScoreLine,
  items: readonly PlacedItem[],
  m: JianpuGrid,
  ctx: BeatCtx = {},
): Map<InlineLayerElement, ReturnType<typeof layoutVoiceLine> & { barBase: number }> {
  const out = new Map<InlineLayerElement, ReturnType<typeof layoutVoiceLine> & { barBase: number }>();
  voice.elements.forEach((el, srcIndex) => {
    if (el.kind !== "inline-layer" || el.role !== "voice" || !el.below) return;
    const hostAt = items.findIndex((it) => it.srcIndex >= srcIndex);
    if (hostAt < 0) return;
    const laid = layoutVoiceLine(layerLine(voice, el), m, { meter: ctx.meter });
    for (const it of laid.items) it.syllables = [];
    const barBase = items.slice(0, hostAt).filter((it) => it.element.kind === "barline").length;
    out.set(el, { ...laid, barBase });
  });
  return out;
}

/** 内联层：`{bz}` 是上方小字号行，`{dsb}` 是与主旋律并排的一块（见 PlacedLayer）。
 *  `prelaid`：已与主行一起归过列的并排下行（`belowLayerLines`），x 照用。 */
export function placeLayers(
  voice: ScoreLine,
  items: PlacedItem[],
  m: JianpuGrid,
  ink: InkMeasurer,
  ctx: BeatCtx = {},
  prelaid?: ReadonlyMap<InlineLayerElement, ReturnType<typeof layoutVoiceLine>>,
): PlacedLayer[] {
  const out: PlacedLayer[] = [];
  voice.elements.forEach((el, srcIndex) => {
    if (el.kind !== "inline-layer") return;
    // 起点对齐主旋律里紧随其后的那个符号
    const hostAt = items.findIndex((it) => it.srcIndex >= srcIndex);
    const host = hostAt >= 0 ? items[hostAt] : items[items.length - 1];
    const originX = host ? host.x : 0;
    const inner = layerLine(voice, el);
    const pre = prelaid?.get(el);
    const laid = pre ?? layoutVoiceLine(inner, m, { meter: ctx.meter });

    if (el.role !== "voice" || hostAt < 0) {
      // `{bz}`：上方另排一小行，按 layerScale 缩小
      for (const it of laid.items) {
        it.x = originX + it.x * m.style.size.cue;
        it.advance *= m.style.size.cue;
        it.syllables = [];
      }
      out.push({ layer: el, items: laid.items, underlines: computeUnderlines(inner, laid.items, m, laid.groups) });
      return;
    }

    // `{dsb}`：并排块。括起的内容排在上行，主旋律从 host 起**等时长**的一段排在下行，
    // 两行同字号、按拍位对齐（原版里两行结构本就一致）。
    // 同一谱表的第二声部（`below`）上下对调：主旋律在上行、第二声部在下行（照五线谱上下位）
    const split = splitRise(m) * (el.below ? -1 : 1);
    let total = 0;
    for (const it of laid.items) total += it.beats;
    let acc = 0;
    let lastAt = hostAt;
    for (let i = hostAt; i < items.length; i++) {
      lastAt = i;
      acc += items[i]!.beats;
      if (acc >= total - 1e-6) break;
    }
    // 段末紧跟的小节线也算这一段的（`{dsb … |}` 多半以小节线收尾，两行要对到同一条上）
    while (lastAt + 1 < items.length && items[lastAt + 1]!.element.kind === "barline") {
      lastAt += 1;
    }
    // 主旋律这一段的拍位 → x
    const cols: Array<{ beat: number; bar: boolean; x: number }> = [];
    let at = 0;
    for (let i = hostAt; i <= lastAt; i++) {
      const it = items[i]!;
      cols.push({ beat: at, bar: it.element.kind === "barline", x: it.x });
      at += it.beats;
    }
    let beatAt = 0;
    if (!pre) laid.items.forEach((it) => {
      const bar = it.element.kind === "barline";
      const hit =
        cols.find((c) => c.bar === bar && Math.abs(c.beat - beatAt) < 1e-6) ??
        cols.find((c) => Math.abs(c.beat - beatAt) < 1e-6);
      if (hit) it.x = hit.x;
      else {
        // 拍位对不上（两行写法不同）就按比例落在区间里
        const span = cols[cols.length - 1]!.x - cols[0]!.x;
        it.x = cols[0]!.x + (total > 0 ? (beatAt / total) * span : 0);
      }
      it.syllables = [];
      beatAt += it.beats;
    });
    // 并排段之后只剩小节线的话，那就是一直排到行末：末尾那几条线也跟着下行走
    let tailHasNote = false;
    for (let i = lastAt + 1; i < items.length; i++) {
      if (items[i]!.element.kind !== "barline") {
        tailHasNote = true;
        break;
      }
    }
    // 并排段末音（段末紧跟的小节线不算）
    let noteEnd = lastAt;
    while (noteEnd > hostAt && items[noteEnd]!.element.kind === "barline") noteEnd -= 1;
    // 主旋律这一段下移。后面还有音时，段末那条小节线留在主行（原版 `}|` 的线是正常高度，不跟下行走）
    const endAt = tailHasNote ? noteEnd : items.length - 1;
    for (let i = hostAt; i <= endAt; i++) items[i]!.dy = split;
    const underlines = computeUnderlines(inner, laid.items, m, laid.groups);
    for (const u of underlines) u.dy = -split;
    const marks = placeMarks(inner, laid.items, m, ink);
    const placed: PlacedSplit = {
      dy: -split,
      line: inner,
      marks,
      braceTop: -Math.abs(split) - m.ink.noteHeight * 0.64,
      braceBottom: Math.abs(split) + m.ink.noteHeight * 0.64,
    };
    // 花括号画在并排段与单行段的交界上，开口朝着并排的两行；一直排到行末就只有左边那个。
    // 前面只有隐藏线（`|/`，上一行接过来的并排段）也不画左括号（原版如此）
    const before = items.slice(0, hostAt);
    // 同一谱表的第二声部（`below`）从行首起也画左括号：不画的话整行并排时上下两行看着像两行不相干的谱
    if (el.below || before.some((it) => it.element.kind !== "barline" || (it.element.type !== "hidden" && it.element.type !== "invisible"))) {
      // 左括号离前面那条小节线 0.48 个墨迹高（同右括号离线），没有线就按离首音 1.07 个墨迹高往左排
      const prev = items[hostAt - 1];
      placed.braceLeftX = prev?.element.kind === "barline"
        ? prev.x + m.ink.noteHeight * 0.48
        : items[hostAt]!.x - m.ink.noteHeight * 1.07 - SPLIT_BRACE_W;
    }
    if (tailHasNote) {
      // 上行段末自带的小节线（`{dsb 1 - - - | }`）不画：块后那条线只在主行画一条正常高度的（原版 `}|`），
      // 两条都画就在上行与主行之间连成一根长线
      for (let k = laid.items.length - 1; k >= 0 && laid.items[k]!.element.kind === "barline"; k--) laid.items[k]!.noBarline = true;
      // 右花括号收在并排段最后一个音符之后、那条小节线**之前**。间距与左括号对称：
      // 离相邻音符 1.07、离小节线 0.48 个墨迹高（《太阳出来喜洋洋》里多处一致）
      placed.braceRightX = items[noteEnd]!.x + m.ink.noteHeight * 1.07;
      // 后面紧跟小节线时以线为准往回让：括号右缘离线 0.48 个墨迹高（列宽按内容排，末音到线的距离不是定值）
      const bar = items[noteEnd + 1];
      if (bar?.element.kind === "barline") {
        placed.braceRightX = Math.min(placed.braceRightX, bar.x - m.ink.noteHeight * 0.48 - SPLIT_BRACE_W);
      }
    }
    out.push({ layer: el, items: laid.items, underlines, split: placed });
  });
  return out;
}
