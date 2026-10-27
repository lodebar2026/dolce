// 谱行**上方那一带**的定位：弧、连音、奏法记号、和弦、注释、松叶、转调标签、力度/术语/跳转字、临时伴奏行、房号。
// 判据整段从旧简谱引擎搬来（`layout.ts::Line.collectBandItems` / `stackAbove` / `placeDirections` / `addEnding`），
// 堆叠走公共那一份（`engrave/upperband.ts::stackUpperBand`）：按实际墨迹盒一次排清，不再按固定槽位摆。
// y 一律在这里定死（相对声部基线、行坐标 x），`compose/` 只照 `PlacedText` / `PlacedMark` 画。
import type { BarlineElement, MusicElement } from "../../../jianpu/ast";
import { BARLINE_MARKS, DYNAMICS } from "../../../engrave/jpglyph";
import { TERMS } from "../../../model/marknames";
import { Point, Rect } from "../../../common/geom";
import { Slur } from "../../../engrave/arc";
import { bandTop, stackUpperBand, type BandItem } from "../../../engrave/upperband";
import { DYNAMIC_SIZE } from "../../../engrave/dynamics";
import { JP_HAIRPIN, jpHairpinLineWidth } from "../../../engrave/hairpin";
import { tupletDigits } from "../../../engrave/tuplet";
import { jpSlideArrow, jpSlideOf } from "../../../engrave/jpslide";
import { endingDrop, endingLabelDx, labelBaselineOf } from "../../../engrave/ending";
import { stackBottom, stackTop as stackTopOf } from "../../../engrave/stack";
import { barlineSpan, bracketLineWidth, jianpuSlurStyle, keyLabelSize, type JianpuGrid } from "../metrics";
import type { InkMeasurer, PlacedItem, PlacedLayer, PlacedMark, PlacedText } from "./model";
import { articStack, entryTop, noteBeams, noteInkBottom, stackTop } from "./vertical";
import { type ChordSpan, sectionWordLines, sectionWordOf, sectionWordSlot, widestLine } from "./sectionword";
import { barlineBox } from "./spacing";
import { belowArcsBottom } from "./marks";
import { rehearsalBracketed, rehearsalOf } from "../../../model/deconames";

/** 一个声部（或并排块上行）的上方带排完的结果。 */
export interface VoiceBand {
  texts: PlacedText[];
  /** 堆叠完的全部墨迹盒（已含抬升）：房号车道、头顶留空都读它 */
  boxes: BandItem[];
  /** 本行头顶最高的墨迹（相对基线，负为上）：音符那一摞、倚音、带里一切 */
  top: number;
  /** 字（和弦、注释、转调标签、力度/术语/跳转字）里最高的墨迹顶；没有字为 null（组间留空另加一个数字高，见 vertical.ts::groupHeadroom） */
  textTop: number | null;
  /** 器乐谱（`below`）谱行下方那条带（力度、渐强渐弱）的墨迹底（相对基线）；没有为 null */
  bottom: number | null;
}

/** 带里算「字」的那几种（组间让位要多留一截，见 `VoiceBand.textTop`） */
const TEXT_KINDS = new Set(["chord", "section-word", "key", "direction"]);

/** 并排块下行（主旋律下移的那一段）上的东西不为上行让位：它本来就在上行底下 */
const LOWER_ROW = ["split"] as const;

/** 和弦字号（没设就按数字字号的 0.6，同旧简谱引擎 `directionWidth`） */
function textSize(m: JianpuGrid): number {
  return m.style.size.chord > 0 ? m.style.size.chord : m.style.size.note * 0.6;
}

/** 弧（简谱弧，同页 slur 那一条月牙）的墨迹盒与「这一段 x 上多高」：照 `Line.collectBandItems` 的弧那一段 */
function arcBox(mk: PlacedMark, m: JianpuGrid, y: number, gap?: { x0: number; x1: number }): { top: number; bottom: number; flat: boolean } {
  const arc = new Slur();
  const x1 = Math.max(mk.x1, mk.x0 + 6);
  arc.init(new Point(mk.x0, y), new Point(x1, y), { ...jianpuSlurStyle(m, 0), ...(gap ? { gap } : {}) });
  return { top: arc.y, bottom: arc.y + arc.height, flat: arc.flatHx > 0 };
}

/**
 * 上方带：收集 → 堆叠 → 力度/跳转字 → 临时伴奏行 → 房号。`marks` 里弧与连音的 y 已由 `placeMarks` 定好，
 * 这里只按堆叠结果整条抬；松叶、房号的 y 在这里定。`width` 是版心宽（字不出版心）。
 */
export function placeBand(
  items: readonly PlacedItem[],
  marks: PlacedMark[],
  layers: PlacedLayer[],
  m: JianpuGrid,
  ink: InkMeasurer,
  width: number,
  /** 器乐谱：力度记号、渐强渐弱记在谱行下方（GB/T 46845 7.3.8 a、7.3.6.3；声乐谱记上方），见 `placeBelow` */
  below = false,
): VoiceBand {
  const nh = m.ink.noteHeight;
  const gap = m.style.vertical.slurGap;
  const texts: PlacedText[] = [];
  const boxes: BandItem[] = [];
  const lower = (it: { dy?: number }): { skipKinds?: readonly string[] } => (it.dy !== undefined ? { skipKinds: LOWER_ROW } : {});

  // ---- 层 0：并排块的上行（整块是一个障碍：跨过它的弧、房号要抬到它之上，旧 `voltaLift`） ----
  for (const lay of layers) {
    const sp = lay.split;
    if (!sp || lay.items.length === 0) continue;
    const inner = placeBand(lay.items, sp.marks, [], m, ink, width);
    sp.band = inner.texts;
    const xs = lay.items.map((it) => it.x);
    boxes.push({
      key: sp, x0: Math.min(...xs) - nh / 2, x1: Math.max(...xs) + nh / 2,
      top: sp.dy + Math.min(inner.top, sp.braceTop - sp.dy), bottom: sp.dy + nh / 2,
      layer: 0, rank: -1, kind: "split",
    });
  }

  // ---- 层 0：弧、连音（`rank` = 跨度，短的留在下面） ----
  for (const mk of marks) {
    if (mk.y === undefined || mk.below || (mk.mark.type !== "slur" && mk.mark.type !== "tuplet")) continue;
    const dy = mk.dy ?? 0;
    const x0 = mk.x0, x1 = Math.max(mk.x1, mk.x0 + 6);
    if (mk.mark.type === "slur") {
      const b = arcBox(mk, m, mk.y + dy);
      // 弧在某一段里多高：按抛物线近似，端点贴音、中点最高；扁平长连音线整条按顶（同 `Line.collectBandItems`）
      const at = (x: number): number => {
        if (b.flat) return b.top;
        const u = x1 > x0 ? Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : 0;
        return b.bottom - 4 * (b.bottom - b.top) * u * (1 - u);
      };
      const topAt = (a: number, c: number): number => {
        const lo = Math.max(a, x0), hi = Math.min(c, x1);
        if (lo > hi) return b.bottom;
        const mid = (x0 + x1) / 2;
        return lo <= mid && mid <= hi ? b.top : Math.min(at(lo), at(hi));
      };
      boxes.push({ key: mk, x0, x1, top: b.top, bottom: b.bottom, layer: 0, rank: x1 - x0, kind: "slur", topAt, ...lower(mk) });
      continue;
    }
    // 连音：括线（横线那一截只有线宽、数字那一小段高）或两段弧；画法同 compose/marks.ts 的 tuplet 分支
    const n = Number(mk.mark.caption) || mk.mark.end - mk.mark.start + 1;
    const num = ink.smufl(tupletDigits(n), m.style.size.note);
    const halfW = num.width / 2;
    const cx = (x0 + x1) / 2;
    const halfGap = halfW + m.style.size.note * 0.15;
    let lineTop: number;
    let numCy: number;
    if (m.style.look.tupletStyle === "bracket") {
      const foot = m.style.vertical.bracketFoot > 0 ? m.style.vertical.bracketFoot * 0.55 : m.style.size.note * 0.25;
      const lw = bracketLineWidth(m);
      const ly = mk.y + dy - foot;
      lineTop = ly - lw / 2;
      numCy = ly;
    } else {
      const b = arcBox(mk, m, mk.y + dy, { x0: cx - halfGap, x1: cx + halfGap });
      lineTop = b.top;
      numCy = b.top + m.style.stroke.slur / 4;
    }
    const numTop = numCy - num.height / 2;
    const top = Math.min(lineTop, numTop);
    const topAt = (a: number, c: number): number => (c > cx - halfW && a < cx + halfW ? top : lineTop);
    boxes.push({ key: mk, x0, x1, top, bottom: mk.y + dy, layer: 0, rank: x1 - x0, kind: "tuplet", topAt, ...lower(mk) });
  }

  // ---- 层 0：奏法记号字形（延长记号等）。点状标记让弧，不是弧让它：`rank` 最大、层内最后定；不为连音括线让 ----
  // ---- 层 1：和弦、段落词（音符注释，和弦横向让位之后才摆，见下）；层 2：转调标签 ----
  const words: Array<{ it: PlacedItem; i: number; base: number }> = [];
  for (const [itemIndex, it] of items.entries()) {
    const el = it.element;
    const dy = it.dy ?? 0;
    if (el.kind === "note") {
      const art = articStack(el, m, ink, gap);
      for (const g of art.glyphs) {
        const t: PlacedText = {
          kind: "artic", el, text: g.glyph, face: "music", size: g.size, x: it.x + g.x, y: g.y + dy, ink: g.ink.offset(it.x, dy),
        };
        texts.push(t);
        boxes.push({
          key: t, x0: t.ink.left, x1: t.ink.right, top: t.ink.top, bottom: t.ink.bottom,
          layer: 0, rank: Number.MAX_SAFE_INTEGER, kind: "artic", skipKinds: dy ? ["tuplet", ...LOWER_ROW] : ["tuplet"],
        });
      }
      const top = art.top;
      // 和弦/注释/转调标签的起始基线：本音那一摞（含临时记号、倚音、奏法记号）的墨迹顶之上 `chordGap`（`NoteEntry.addHarmony`）
      const base = top - m.style.vertical.chordGap + dy;
      if (el.chord) pushChord(el, it.x, base, el.chord, dy);
      let key: PlacedText | null = null;
      if (el.keyLabel) {
        // 左缘对齐数字左缘、往右写——居中的话行首那个会伸出左边距
        const r = ink.text(el.keyLabel, "key-label");
        const x = it.x - nh * 0.35;
        key = { kind: "key-label", el, text: el.keyLabel, face: "text", size: keyLabelSize(m), x, y: base, ink: r.ink.offset(x, base) };
        texts.push(key);
        // 第 2 层：与和弦同在时转调标记在外（上）、和弦在内贴音（用户定，2026-10-14：全局信息在外、局部信息在内）
        boxes.push({ key, x0: key.ink.left, x1: key.ink.right, top: key.ink.top, bottom: key.ink.bottom, layer: 2, kind: "key", ...lower(it) });
      }
      if (el.annotation) {
        if (key) {
          // 同一个音上还有转调标记：排在它右边同一行（用户定：避开转调，要么在右、要么在上）；
          // 本小节里放不下（越过下一条小节线或出版心）就摞到它之上
          const ann = sectionWordLines(el.annotation).join(" ");
          const r = ink.sectionWord(ann);
          const bar = items.find((o) => o.element.kind === "barline" && o.x > it.x);
          const at = key.ink.right + m.style.size.chord * 0.4 - r.ink.left;
          const fits = at + r.ink.right <= Math.min(bar ? bar.x - nh * 0.3 : Infinity, width || Infinity);
          const x = fits ? at : it.x - nh * 0.35;
          const t = sectionWordText(el, ann, x, base, r);
          texts.push(t);
          // 与转调标记同一行时同类（`key`）不互避
          boxes.push({ key: t, x0: t.ink.left, x1: t.ink.right, top: t.ink.top, bottom: t.ink.bottom, layer: fits ? 2 : 2.2, rank: 1, kind: fits ? "key" : "section-word", ...lower(it) });
        } else words.push({ it, i: itemIndex, base });
      }
    } else if (el.kind === "sustain") {
      // 长音里换的和弦印在增时线上方：增时线比数字矮，基准取数字墨迹顶（同 `addHarmony` 的 min）
      const base = -nh / 2 - m.style.vertical.chordGap + dy;
      if (el.chord) pushChord(el, it.x, base, el.chord, dy);
      if (el.annotation) words.push({ it, i: itemIndex, base });
    }
  }

  function sectionWordText(el: MusicElement, text: string, x: number, base: number, r: ReturnType<InkMeasurer["sectionWord"]>): PlacedText {
    return { kind: "section-word", el, text, face: "lyric", size: m.style.size.sectionWord, x, y: base, ink: r.ink.offset(x, base), xs: r.xs };
  }

  function pushChord(el: MusicElement, cx: number, base: number, chord: string, dy: number): void {
    const r = ink.chord(chord);
    if (!r.ink) return;
    const x = cx - r.advance / 2;
    const t: PlacedText = { kind: "chord", el, text: chord, face: "text", size: m.style.size.chord, x, y: base, ink: r.ink.offset(x, base) };
    texts.push(t);
    // 被同一个下层对象压住的和弦整排取齐（`spread`）
    boxes.push({ key: t, x0: t.ink.left, x1: t.ink.right, top: t.ink.top, bottom: t.ink.bottom, layer: 1, rank: 0, kind: "chord", spread: "chord", ...(dy ? { skipKinds: LOWER_ROW } : {}) });
  }

  spreadChords(items, texts, boxes, m, width);

  // ---- 段落词（用户定：音符注释一律按段落词排）：歌词字、段落词字号，落点搬 `Line.addSectionWords`——
  // 和弦那一行、本小节里横向找不撞和弦的空档（判据 engrave/sectionword.ts，与横向撑开 spacing.ts 同一份换算），
  // 找不到才抬到和弦之上（同层 `rank` 在和弦之后，堆叠自然摞上去）；没抬的与和弦同一条基线（进下面的同基线那一圈），
  // 被弧、连音压住时单独上提（层 0 在下，搬 `liftSectionWordsUnderSlurs`）。行首那一条横向不够由 spacing.ts 先匀过，仍不够才抬
  /** 与和弦同基线的段落词，及各自的起始基线（同基线那一圈只往上取齐，不压回自己那一摞的让位之下） */
  const laneWords = new Map<PlacedText, number>();
  if (words.length > 0 && m.style.size.sectionWord > 0) {
    const itemOf = new Map(items.map((it) => [it.element as MusicElement, it]));
    const spans: ChordSpan[] = [];
    for (const t of texts) {
      const at = t.kind === "chord" ? itemOf.get(t.el) : undefined;
      if (at) spans.push({ x0: t.ink.left, x1: t.ink.right, at });
    }
    for (const w of words) {
      // 几条连写的（ABC §4.19：分行、先写的在上）：横向按最宽那行找空档，最后一行落在和弦那一行，前面的依次往上摞
      const lines = sectionWordLines(sectionWordOf(w.it.element)!);
      if (lines.length === 0) continue;
      const rs = lines.map((l) => ink.sectionWord(l));
      const row = spans.filter((c) => (c.at.dy ?? 0) === (w.it.dy ?? 0));
      const slot = sectionWordSlot(items, w.i, (it) => it.x, row, widestLine(lines, (l) => ink.sectionWord(l)).ink, m, width || Infinity);
      let base = w.base;
      for (let k = lines.length - 1; k >= 0; k--) {
        const t = sectionWordText(w.it.element, lines[k]!, slot.x, base, rs[k]!);
        texts.push(t);
        boxes.push({ key: t, x0: t.ink.left, x1: t.ink.right, top: t.ink.top, bottom: t.ink.bottom, layer: 1, rank: 1, kind: "section-word", ...lower(w.it) });
        if (k === lines.length - 1 && !slot.lifted && w.it.dy === undefined) laneWords.set(t, w.base);
        if (k > 0) base = t.ink.top - m.style.size.sectionWord * 0.2 - rs[k - 1]!.ink.bottom;
      }
    }
  }

  // ---- 层 1.5：松叶（用户定：松叶在和弦之上——起始落点贴音，跨度里有和弦、注释撞上才抬到它们之上） ----
  // 起始落点同旧简谱引擎（`Line.addWedges`）：跨度里音符那一摞的墨迹顶之上一道叠层的空；开口与线宽见 `engrave/hairpin.ts::JP_HAIRPIN`
  const hairpinLw = jpHairpinLineWidth(m.style.stroke.hairpin, nh);
  const hairpinHeight = nh * JP_HAIRPIN.half * 2 + hairpinLw;
  for (const mk of marks) {
    if (mk.mark.type !== "crescendo" && mk.mark.type !== "decrescendo") continue;
    if (below) continue;
    let top = Infinity;
    for (const it of items) {
      if (it.element.kind === "barline" || it.x < mk.x0 - nh || it.x > mk.x1 + nh) continue;
      top = Math.min(top, entryTop(it.element, m) + (it.dy ?? 0));
    }
    if (!Number.isFinite(top)) top = -nh / 2 + (mk.dy ?? 0);
    // `y` 记松叶墨迹的**底边**（compose/marks.ts 照它画）
    mk.y = top - m.ink.stack.gap - (mk.level - 1) * m.note.levelStep;
    const x1 = Math.max(mk.x1, mk.x0 + 6);
    boxes.push({
      key: mk, x0: mk.x0, x1, top: mk.y - hairpinHeight, bottom: mk.y,
      layer: 1.5, rank: x1 - mk.x0, kind: "wedge", ...lower(mk),
    });
  }

  // ---- 堆叠，dy 回填 ----
  // **同一行的和弦在同一条基线上**（用户定）：先都摆到最高的那个起始基线，堆叠里哪个被抬了，整行跟着抬到它那儿再排一遍，到不再变为止。
  // 并排块下行（主旋律下移那一段）上的和弦不算在内
  const boxOf = new Map(boxes.map((b) => [b.key, b]));
  const laneChords = texts.filter((t) => t.kind === "chord" && !boxOf.get(t)?.skipKinds?.includes("split"));
  let lift = new Map<object, number>();
  if (laneChords.length > 0) {
    let lane = Math.min(...laneChords.map((t) => t.y));
    for (let iter = 0; iter < 6; iter++) {
      for (const t of [...laneChords, ...laneWords.keys()]) {
        const d = Math.min(lane, laneWords.get(t) ?? Infinity) - t.y;
        if (d === 0) continue;
        t.y += d;
        t.ink = t.ink.offset(0, d);
        const b = boxOf.get(t)!;
        b.top += d;
        b.bottom += d;
      }
      lift = stackUpperBand(boxes, gap);
      const next = Math.min(...laneChords.map((t) => t.y + (lift.get(t) ?? 0)));
      if (next >= lane - 0.01) break;
      lane = next;
    }
  } else lift = stackUpperBand(boxes, gap);
  const textKeys = new Set<object>(texts);
  const markKeys = new Set<object>(marks);
  for (const b of boxes) {
    const d = lift.get(b.key) ?? 0;
    if (d === 0) continue;
    b.top += d;
    b.bottom += d;
    if (textKeys.has(b.key)) {
      const t = b.key as PlacedText;
      t.y += d;
      t.ink = t.ink.offset(0, d);
    } else if (markKeys.has(b.key)) {
      const mk = b.key as PlacedMark;
      if (mk.y !== undefined) mk.y += d;
    }
    if (b.topAt) {
      const f = b.topAt;
      b.topAt = (a, c) => f(a, c) + d;
    }
  }

  const lowTexts: PlacedText[] = [];
  const groups = placeDirections(items, boxes, texts, m, ink, width, below ? lowTexts : null);
  placeCue(items, layers, boxes, m);
  placeEndings(items, marks, boxes, groups, m, ink);
  // 松叶、房号的 y 上面是按声部基线算的（已含下行的 dy）；compose 画记号时还要再加 `mk.dy`，这里扣回去
  for (const mk of marks) {
    if (mk.y !== undefined && mk.dy !== undefined && mk.mark.type !== "slur" && mk.mark.type !== "tuplet") mk.y -= mk.dy;
  }

  // ---- 头顶：音符那一摞、换气、伴奏括弧、带里一切 ----
  let top = -nh / 2;
  let textTop: number | null = null;
  for (const it of items) {
    const el = it.element;
    const dy = it.dy ?? 0;
    if (el.kind === "note" && !el.hidden) top = Math.min(top, entryTop(el, m) + dy);
    if (el.kind === "note" || el.kind === "sustain" || el.kind === "barline") {
      // 换气的 V（原版放在基线上方约一个墨迹高）、伴奏括弧（1.5 个墨迹高居中于基线）不进带
      for (const orn of el.ornaments) {
        if (orn.name === "hx") top = Math.min(top, -nh * 1.05 + dy);
        else if (orn.name === "zkh" || orn.name === "ykh") top = Math.min(top, -nh * 0.75 + dy);
        else if (jpSlideOf([orn.name])) {
          // 滑音箭头锚在数字墨迹底（compose/note.ts::paintSlide）
          const a = jpSlideArrow(orn.name === "shy", nh);
          top = Math.min(top, nh / 2 + Math.min(a.y0, a.y1, ...a.arms.map((p) => p[1])) - a.lineWidth / 2 + dy);
        }
      }
    }
  }
  for (const b of boxes) {
    top = Math.min(top, b.top);
    if (b.kind && TEXT_KINDS.has(b.kind)) textTop = Math.min(textTop ?? Infinity, b.top);
  }
  const bottom = below ? placeBelow(items, marks, layers, lowTexts, m) : null;
  texts.push(...lowTexts);
  return { texts, boxes, top, textTop, bottom };
}

/**
 * **器乐谱谱行下方那条带**：力度记号与渐强渐弱记在谱行下方（GB/T 46845 7.3.8 a）单行谱表器乐曲谱、7.3.6.3 图形力度符号器乐曲谱记在下方，
 * 谱例《一枝花》《月夜》），声乐谱照旧记上方。整行一条线：竖向中线落在本行最低墨迹（低音点、减时线、并排块下行）之下一道空 + 半个带高，
 * 力度字与松叶同高；松叶起止碰上同一处的力度字就让到字外一道空（`p <`）。返回这条带的墨迹底（相对基线）。
 */
function placeBelow(items: readonly PlacedItem[], marks: PlacedMark[], layers: readonly PlacedLayer[], dyns: PlacedText[], m: JianpuGrid): number | null {
  const wedges = marks.filter((mk) => mk.mark.type === "crescendo" || mk.mark.type === "decrescendo");
  if (wedges.length === 0 && dyns.length === 0) return null;
  const nh = m.ink.noteHeight;
  const gap = m.style.vertical.slurGap;
  let low = nh / 2;
  for (const it of items) {
    if (it.element.kind !== "note" || it.element.hidden) continue;
    low = Math.max(low, noteInkBottom(it.element, m) + (it.dy ?? 0));
  }
  // 并排块（同谱表第二声部排在下行，八段锦小钗）：那一行也在上面，带要排到它之下
  for (const lay of layers) {
    const sp = lay.split;
    if (!sp) continue;
    for (const it of lay.items) {
      if (it.element.kind !== "note" || it.element.hidden) continue;
      low = Math.max(low, noteInkBottom(it.element, m) + sp.dy + (it.dy ?? 0));
    }
  }
  // 叠印下方的延音线（和音最下面那个音单连的）也在带之上
  low = Math.max(low, belowArcsBottom(marks, m));
  const hairpinLw = jpHairpinLineWidth(m.style.stroke.hairpin, nh);
  const hairpinHeight = nh * JP_HAIRPIN.half * 2 + hairpinLw;
  const half = Math.max(hairpinHeight, ...dyns.map((t) => t.ink.bottom - t.ink.top)) / 2;
  const mid = low + gap * 1.5 + half;
  for (const t of dyns) {
    const d = mid - (t.ink.top + t.ink.bottom) / 2;
    t.y += d;
    t.ink = t.ink.offset(0, d);
  }
  for (const mk of wedges) {
    for (const t of dyns) {
      if (t.ink.right <= mk.x0 - gap || t.ink.left >= mk.x1 + gap) continue;
      if (t.ink.left <= mk.x0 + nh) mk.x0 = Math.max(mk.x0, t.ink.right + gap);
      else if (t.ink.right >= mk.x1 - nh) mk.x1 = Math.min(mk.x1, t.ink.left - gap);
    }
    // `y` 记松叶墨迹的**底边**；compose 画时还会再加 `mk.dy`，这里扣回去
    mk.y = mid + hairpinHeight / 2 - (mk.dy ?? 0);
  }
  return mid + half;
}

/**
 * **力度、术语、跳转字的落位**（搬 `Line.addDirections` 的横向 + `placeDirections` / `placeDirection` 的纵向），排在堆叠之后：
 * 与和弦**接近同一行**——基线取离它最近的那个和弦；只有真撞上了才让，先沿 x 往左让（不越过左边那条小节线），
 * 让不开抬到它那一段真正的最高墨迹之上一道空。挂在小节线上的（`Fine` / `D.S.`）右缘对到线的墨迹右缘、抬过线顶。
 * 定完才进带（房号车道要算它们）。
 */
function placeDirections(
  items: readonly PlacedItem[], boxes: BandItem[], texts: PlacedText[], m: JianpuGrid, ink: InkMeasurer, width: number,
  /** 器乐谱：力度字不进上方带，横向定好后收在这里，竖向由 `placeBelow` 定 */
  lowDyns: PlacedText[] | null = null,
): Map<object, PlacedText[]> {
  const out = new Map<object, PlacedText[]>();
  const nh = m.ink.noteHeight;
  const gap = m.style.vertical.slurGap;
  const size = textSize(m);
  const chords = texts.filter((t) => t.kind === "chord").map((t) => ({ x0: t.ink.left, x1: t.ink.right, base: t.y, inkTop: t.ink.top }));
  const bars = items.filter((it) => it.element.kind === "barline").map((it) => {
    const b = barlineBox(it.element as BarlineElement, m);
    return { x: it.x, left: it.x - (b?.left ?? 0), right: it.x + (b?.right ?? 0), dy: it.dy ?? 0 };
  });
  const rehearsals: { it: PlacedItem; mark: string }[] = [];
  for (const it of items) {
    const el = it.element;
    if (el.kind !== "note" && el.kind !== "barline") continue;
    const dy = it.dy ?? 0;
    // 一组记号横排（各段之间空 0.25 个字号），整组一起落位
    const group: PlacedText[] = [];
    let pen = 0;
    let level = 0;
    for (const orn of el.ornaments) {
      let t: PlacedText | null = null;
      const dyn = DYNAMICS[orn.name];
      const term = TERMS[orn.name];
      const bm = BARLINE_MARKS[orn.name];
      const mark = rehearsalOf(orn.name);
      if (mark) {
        // 排练号不进这一组横排：等别的记号都落定再单独摆（见循环后），免得与段落词、调号标签挤在一起
        rehearsals.push({ it, mark });
        continue;
      } else if (dyn) {
        const fs = m.style.size.note * DYNAMIC_SIZE;
        const r = ink.smufl(dyn, fs);
        if (lowDyns) {
          // 器乐谱的力度：居中在音符下（小节线上的贴线右边），竖向等 `placeBelow`
          const x = el.kind === "barline" ? it.x : it.x - (r.right - r.left) / 2 - r.left;
          lowDyns.push({ kind: "direction", el, text: dyn, face: "music", size: fs, x, y: dy, ink: r.offset(x, dy) });
          continue;
        }
        t = { kind: "direction", el, text: dyn, face: "music", size: fs, x: pen - r.left, y: 0, ink: r.offset(pen - r.left, 0) };
      } else if (term || bm?.text) {
        const s = term ?? bm!.text!;
        const r = ink.text(s, bm ? "jump" : "term");
        t = { kind: "direction", el, text: s, face: "text", size: m.style.size.chord, x: pen, y: 0, ink: r.ink.offset(pen, 0) };
        t.ink = new Rect(Math.min(t.ink.left, pen), t.ink.top, Math.max(t.ink.right, pen + r.advance), t.ink.bottom);
      } else if (bm?.glyph) {
        const fs = m.style.size.note * 0.95;
        const r = ink.smufl(bm.glyph, fs);
        t = { kind: "direction", el, text: bm.glyph, face: "music", size: fs, x: pen - r.left, y: 0, ink: r.offset(pen - r.left, 0) };
      }
      if (!t) continue;
      group.push(t);
      pen = t.ink.right + size * 0.25;
      level = Math.max(level, orn.level);
    }
    if (group.length === 0) continue;
    const gw = Math.max(...group.map((t) => t.ink.right)) - Math.min(...group.map((t) => t.ink.left));
    const move = (dx: number, dyy: number): void => {
      for (const t of group) {
        t.x += dx;
        t.y += dyy;
        t.ink = t.ink.offset(dx, dyy);
      }
    };
    const gx = (): number => Math.min(...group.map((t) => t.ink.left));
    const gTop = (): number => Math.min(...group.map((t) => t.ink.top));
    const gBottom = (): number => Math.max(...group.map((t) => t.ink.bottom));
    const atBar = el.kind === "barline";
    const barRight = atBar ? bars.find((b) => Math.abs(b.x - it.x) < 1e-6) : bars.find((b) => b.left > it.x);
    const barLeft = [...bars].reverse().find((b) => b.right <= it.x - (atBar ? 1e-6 : 0));
    // 小节线上的贴着线右对齐（右缘对到整条线墨迹的右缘），音符上的居中在音符上
    let x = atBar && barRight ? barRight.right - gw : it.x - gw / 2;
    x = Math.max(0, Math.min(x, (width || Infinity) - gw));
    move(x - gx(), 0);
    // 纵向：本行没有和弦时退回音符上方（那一摞的墨迹顶之上一个和弦字号，`chordGap` 设了就用它）
    const above = el.kind === "note" ? Math.min(-nh / 2, stackTop(el, m)) : -nh / 2;
    const fallback = above - (m.style.vertical.chordGap > 0 ? m.style.vertical.chordGap : size) + dy;
    // 挂在小节线上的右缘贴着线：线右边下一小节的和弦隔着线，不算挡路（它离线只有和弦让线那道空，按净空判永远撞上，
    // 跳转字就总被抬一层，`BarEndRoom` 撑开本小节也白撑）
    const own = atBar && barRight ? chords.filter((c) => c.x0 < barRight.right) : chords;
    placeDirection(own, boxes, fallback, barLeft ? barLeft.right : 0, size, gap, move, gx, gTop, gBottom, gw);
    if (atBar && barRight) {
      // 线比数字高出一截：照和弦基线摆会压在线头上，整块抬到线顶之上一道空
      const barTop = barlineSpan(m).top + barRight.dy;
      if (gBottom() > barTop - gap) move(0, barTop - gap - gBottom());
    }
    // 定完（含抬过线顶）再查一遍底下那一层：退路落点（本行没有和弦）和抬过线顶这两步都不看弧、松叶，
    // 真压上了就抬到它们之上一道空（`Fine` 压在松叶上）
    {
      const x0 = gx(), x1 = x0 + gw;
      let lowTop = Infinity;
      for (const b of boxes) {
        if (b.layer === 1 || b.layer === 2 || b.x1 <= x0 || b.x0 >= x1) continue;
        const t = b.topAt ? b.topAt(x0, x1) : b.top;
        if (t < gBottom() && b.bottom > gTop()) lowTop = Math.min(lowTop, t);
      }
      // 底下的音符那一摞（高音点、临时记号）：力度字形有下伸（`mp` 的 p），按基线摆会压到音上
      for (const o of items) {
        if (o.element.kind === "barline" || o.x + nh / 2 <= x0 || o.x - nh / 2 >= x1) continue;
        const t = entryTop(o.element, m) + (o.dy ?? 0);
        if (t - gap < gBottom()) lowTop = Math.min(lowTop, t);
      }
      if (Number.isFinite(lowTop)) move(0, lowTop - gap - gBottom());
    }
    if (level > 0) move(0, -level * m.note.levelStep);
    // 先落定的记号（同一小节里挨着的两组）压上了就抬到它之上
    {
      const x0 = gx(), x1 = x0 + gw;
      let prevTop = Infinity;
      for (const b of boxes) {
        if (b.kind !== "direction" || b.x1 <= x0 || b.x0 >= x1) continue;
        if (b.top < gBottom() && b.bottom > gTop()) prevTop = Math.min(prevTop, b.top);
      }
      if (Number.isFinite(prevTop)) move(0, prevTop - gap - gBottom());
    }
    liftTextsOver(boxes, gx(), gx() + gw, gTop(), gBottom(), gap, size * 0.25);
    texts.push(...group);
    boxes.push({ key: group[0]!, x0: gx(), x1: gx() + gw, top: gTop(), bottom: gBottom(), layer: 1, kind: "direction" });
    out.set(group[0]!, group);
  }
  for (const { it, mark } of rehearsals) placeRehearsal(it, mark, items, boxes, texts, m, ink, width);
  return out;
}

/**
 * 力度、术语落定后压着的段落词、转调标签让到它之上一道空（全局信息在外、局部信息在内，同和弦与转调标签的口径）：
 * 它们先排、按和弦那一行摆，与贴音的记号撞上时（曲首「欢快 热烈地」压 `mf`、「转1=G」压 ⊕）整条上提，
 * 再连带把被它顶到的别的段落词/标签一起往上推。
 */
function liftTextsOver(boxes: BandItem[], x0: number, x1: number, top: number, bottom: number, gap: number, pad: number): void {
  // 队列里放框本身、读实时坐标（存快照的话，两行同时被顶到同一高度会来回互推）；次数封顶防万一
  const origin = { x0, x1, top, bottom } as BandItem;
  const queue: BandItem[] = [origin];
  for (let guard = 0; queue.length > 0 && guard < 200; guard++) {
    const o = queue.shift()!;
    const p = o === origin ? pad : 0;
    for (const b of boxes) {
      if (b === o || (b.kind !== "section-word" && b.kind !== "key") || b.x1 <= o.x0 - p || b.x0 >= o.x1 + p) continue;
      // 只推与它同一行或压在它上沿的（中线不低于它的底）；整个在它下面的不动
      if (b.bottom <= o.top - gap + 1e-6 || b.top >= o.bottom || (b.top + b.bottom) / 2 > o.bottom) continue;
      const d = o.top - gap - b.bottom;
      const t = b.key as PlacedText;
      t.y += d;
      t.ink = t.ink.offset(0, d);
      b.top += d;
      b.bottom += d;
      queue.push(b);
    }
  }
}

/**
 * **排练号**（`!rehearsal=A!` / `<rehearsal>`）：大一号的字母套方框，左缘对齐所在那个音的墨迹左缘，
 * 抬到这一段里一切墨迹（和弦、段落词、调号标签、力度、弧、音符那一摞）之上一道空——与五线谱一样印在最上面。
 * 框就是它的 `ink`（compose/note.ts 照它画框），进带后上面的房号等再按它让。
 */
function placeRehearsal(
  it: PlacedItem, mark: string, items: readonly PlacedItem[], boxes: BandItem[], texts: PlacedText[], m: JianpuGrid, ink: InkMeasurer, width: number,
): void {
  // GB/T 46845 5.9.4「段落序号应使用大字号标记出」，5.9.5 谱例是加框粗体、与音符数字差不多高：取音符字号的 0.9、粗体
  const fs = m.style.size.note * 0.9;
  const r = ink.text(mark, "term"); // 按术语字号（= 和弦字号）量的，放大 k 倍
  const k = fs / m.style.size.chord;
  // 自带【】的（八段锦）照原样排字、不套框
  const framed = !rehearsalBracketed(mark);
  const pad = framed ? fs * 0.25 : 0;
  const w = (r.ink.right - r.ink.left) * k + pad * 2;
  const nh = m.ink.noteHeight;
  const x0 = Math.max(0, Math.min(it.x - nh / 2, (width || Infinity) - w));
  const x1 = x0 + w;
  const gap = m.style.vertical.slurGap;
  // 左右各多看半个数字宽：框落在行首休止上方、紧挨着右边和音的上层数字，看着像那个和音的一部分（八段锦二胡 C 段 `0 [61]`）
  const a0 = x0 - nh / 2, a1 = x1 + nh / 2;
  let top = Math.min(-nh / 2, ...items.filter((o) => o.element.kind === "note" && o.x + nh / 2 > a0 && o.x - nh / 2 < a1)
    .map((o) => entryTop(o.element, m) + (o.dy ?? 0)));
  for (const b of boxes) {
    if (b.x1 <= a0 || b.x0 >= a1) continue;
    top = Math.min(top, b.topAt ? b.topAt(x0, x1) : b.top);
  }
  for (const t of texts) if (t.ink.right > x0 && t.ink.left < x1) top = Math.min(top, t.ink.top);
  const bottom = top - gap;
  const boxBottomRel = r.ink.bottom * k + pad; // 框底相对文字基线
  const y = bottom - boxBottomRel;
  const t: PlacedText = {
    kind: "direction", el: it.element, text: mark, face: "text", size: fs, x: x0 + pad - r.ink.left * k, y, boxed: framed, bold: true,
    ink: new Rect(x0, y + r.ink.top * k - pad, x1, bottom),
  };
  texts.push(t);
  boxes.push({ key: t, x0, x1, top: t.ink.top, bottom: t.ink.bottom, layer: 1, kind: "direction" });
}

/**
 * **和弦横向让位**（搬 `Line.spreadChordsHorizontally`，堆叠之前跑）：和弦按音符居中，宽的会压到前面那条小节线
 * （线头比数字高，正好戳进字里）或顶到下一个和弦——沿 x 让，不往上摞（摞起来一高一低更难看）。
 *   - 不压小节线：小节头一个音上的和弦左半截探过前一条线，整块挪到线的右边；
 *   - 挨上前一个和弦就往右挪，挪动量封顶 1.2 个和弦字号（挪过头就成了下一个音的和弦）；
 *   - 一个字都不许出版心：从右往左收回来，收到贴着前一个和弦为止；左缘同理。
 */
function spreadChords(items: readonly PlacedItem[], texts: PlacedText[], boxes: BandItem[], m: JianpuGrid, width: number): void {
  const size = m.style.size.chord;
  if (size <= 0) return;
  const right = width || Infinity;
  const gap = size * 0.28;
  const limit = size * 1.2;
  const chords = texts.filter((t) => t.kind === "chord");
  if (chords.length === 0) return;
  const boxOf = new Map(boxes.map((b) => [b.key, b]));
  const shift = (t: PlacedText, dx: number): void => {
    t.x += dx;
    t.ink = t.ink.offset(dx, 0);
    const b = boxOf.get(t);
    if (b) {
      b.x0 += dx;
      b.x1 += dx;
    }
  };
  const top = barlineSpan(m).top;
  const bars = items.filter((it) => it.element.kind === "barline").map((it) => {
    const b = barlineBox(it.element as BarlineElement, m);
    return b ? { l: it.x - b.left, r: it.x + b.right, top: top + (it.dy ?? 0) } : null;
  }).filter((b): b is { l: number; r: number; top: number } => b !== null);
  for (const c of chords) {
    const hit = bars.find((bar) => bar.r > c.ink.left - gap && bar.l < c.ink.right
      && (bar.l + bar.r) / 2 < (c.ink.left + c.ink.right) / 2 && bar.top < c.ink.bottom);
    if (hit) shift(c, hit.r + gap - c.ink.left);
  }
  chords.sort((a, b) => a.ink.left - b.ink.left);
  // 左缘先收进版心（行首那个居中后探出左边），再逐个让——收在后面的话会把它推到下一个和弦身上（`Cm` 挤着 `E♭/G`）
  if (chords[0]!.ink.left < 0) shift(chords[0]!, -chords[0]!.ink.left);
  for (let i = 1; i < chords.length; i++) {
    const prev = chords[i - 1]!, cur = chords[i]!;
    const need = prev.ink.right + gap - cur.ink.left;
    if (need <= 0) continue;
    const dx = Math.min(need, limit, Math.max(0, right - cur.ink.right));
    if (dx > 0) shift(cur, dx);
  }
  for (let i = chords.length - 1; i >= 0; i--) {
    const cur = chords[i]!;
    const prevX1 = i > 0 ? chords[i - 1]!.ink.right : 0;
    let dx = 0;
    if (cur.ink.right > right) dx = Math.max(right - cur.ink.right, prevX1 + gap - cur.ink.left);
    if (cur.ink.left + dx < 0) dx = -cur.ink.left;
    if (dx !== 0) shift(cur, dx);
  }
}

/** 一组记号的纵向落位（`Line.placeDirection`）。 */
function placeDirection(
  chords: ReadonlyArray<{ x0: number; x1: number; base: number; inkTop: number }>,
  boxes: readonly BandItem[], fallback: number, barLeft: number, size: number, gap: number,
  move: (dx: number, dy: number) => void, gx: () => number, gTop: () => number, gBottom: () => number, gw: number,
): void {
  if (!chords.length) {
    move(0, fallback);
    return;
  }
  // 基线取**离它最近的那个和弦**：同一行的和弦并不总是等高（八度点、被弧抬过的那些）
  const anchorX = gx();
  const near = chords.reduce((a, c) =>
    Math.abs((c.x0 + c.x1) / 2 - anchorX) < Math.abs((a.x0 + a.x1) / 2 - anchorX) ? c : a, chords[0]!);
  move(0, near.base);
  // 撞没撞上按墨迹盒判；力度按数字字号排，比和弦字号估的那一截高——取实际墨迹盒与估值的并
  const top = Math.min(near.base - size * 0.85, gTop()), bot = Math.max(near.base + size * 0.25, gBottom());
  // 底下那一层（弧、连音括线、奏法记号、松叶）也得算
  const low = boxes.filter((b) => b.layer !== 1 && b.layer !== 2);
  const pad = size * 0.35;
  const hitChord = (c: { x0: number; x1: number; base: number; inkTop: number }, x0: number): boolean =>
    c.inkTop < bot && c.base + size * 0.25 > top && c.x1 > x0 - pad && c.x0 < x0 + gw + pad;
  const hits = (x0: number): boolean =>
    chords.some((c) => hitChord(c, x0))
    || low.some((b) => b.top < bot && b.bottom > top && b.x1 > x0 - pad && b.x0 < x0 + gw + pad);
  if (!hits(gx())) return;
  // 沿 x 让：挪到压着它的那些和弦的左边；挡路的按 `hits` 那把尺子筛（含净空容差）
  const left = chords.filter((c) => hitChord(c, gx())).reduce((a, c) => Math.min(a, c.x0), Infinity);
  // 让位不许越过左边那条小节线：`D.S.` / `Fine` 标的是这一小节唱到哪儿为止
  const alt = left - gw - size * 0.3;
  if (Number.isFinite(alt) && alt >= barLeft && alt >= 0 && !hits(alt)) {
    move(alt - gx(), 0);
    return;
  }
  // 本小节里让不开：抬到它那一段真正的最高墨迹（弧、括线、和弦）之上一道空；下面什么都没有才固定抬 1.2 个字号
  const x0 = gx(), x1 = x0 + gw;
  let lowTop = Infinity;
  for (const b of low) {
    if (b.x1 <= x0 || b.x0 >= x1) continue;
    lowTop = Math.min(lowTop, b.topAt ? b.topAt(x0, x1) : b.top);
  }
  for (const c of chords) {
    if (c.x1 <= x0 || c.x0 >= x1) continue;
    lowTop = Math.min(lowTop, c.inkTop);
  }
  move(0, Number.isFinite(lowTop) ? lowTop - gap - gBottom() : -size * 1.2);
}

/** `{bz}` 临时伴奏行：小字号行的墨迹底贴它那一段带顶（或音符那一摞）之上一道空（旧固定槽位 `cueY`）。 */
function placeCue(items: readonly PlacedItem[], layers: PlacedLayer[], boxes: BandItem[], m: JianpuGrid): void {
  const nh = m.ink.noteHeight;
  const cs = m.style.size.cue;
  const h = nh * cs;
  const st = { gap: m.ink.stack.gap * cs, dotRadius: m.ink.stack.dotRadius * cs, beamWidth: m.ink.stack.beamWidth * cs };
  for (const lay of layers) {
    if (lay.split || lay.items.length === 0) continue;
    let cueTop = -h / 2;
    let cueBottom = h / 2;
    for (const it of lay.items) {
      const el = it.element;
      if (el.kind !== "note" || el.hidden) continue;
      cueTop = Math.min(cueTop, stackTopOf(-h / 2, Math.max(0, el.octave), st));
      cueBottom = Math.max(cueBottom, stackBottom(h / 2, noteBeams(el), Math.max(0, -el.octave), st));
    }
    const xs = lay.items.map((it) => it.x);
    const x0 = Math.min(...xs) - h / 2, x1 = Math.max(...xs) + h / 2;
    let above = bandTop(boxes, x0, x1) ?? Infinity;
    for (const it of items) {
      if (it.x < x0 || it.x > x1 || it.element.kind === "barline") continue;
      above = Math.min(above, entryTop(it.element, m) + (it.dy ?? 0));
    }
    if (!Number.isFinite(above)) above = -nh / 2;
    lay.y = above - m.style.vertical.slurGap - cueBottom;
    boxes.push({ key: lay, x0, x1, top: lay.y + cueTop, bottom: lay.y + cueBottom, layer: 2.5, kind: "cue" });
  }
}

/**
 * **房号**：全行同一条车道（一房二房的横线是一条）。按房的各段分别让（旧简谱引擎 `Line.addEnding` 是整段一律让「房号 + 竖脚」，
 * 并排块上行这类高东西一进区间整条就抬得老高——同一首歌二房）：
 *   - 左端房号与左竖脚垂下的那一截（区间左边多看一个房号字号）：下面的墨迹顶之上「0.7 个房号字号 + 竖脚」；
 *   - 其余横线底下：带顶、音符墨迹顶之上一道空；
 *   - 竖脚落在小节线上：线顶之上「竖脚 + 一道空」，区间里的其它小节线同横线。
 * 力度/跳转字不算（房里的 `Fine`、`D.S.` 反过来排到房号线之上，用户定）。
 * 字号、竖脚、房号落点同旧简谱引擎（`size.ending`、`engrave/ending.ts` 的 `endingDrop` / `labelBaselineOf`）；
 * 竖脚下面最深的是竖脚还是房号墨迹底，按更深的那个让（同 `Line.addEnding` 的 `depth`）。
 */
function placeEndings(
  items: readonly PlacedItem[], marks: PlacedMark[], boxes: BandItem[], directions: ReadonlyMap<object, PlacedText[]>,
  m: JianpuGrid, ink: InkMeasurer,
): void {
  const voltas = marks.filter((mk) => mk.mark.type === "volta");
  if (voltas.length === 0) return;
  const labelSize = m.style.size.ending;
  const drop = endingDrop(m.style.vertical.bracketFoot, labelSize);
  const gap = m.style.vertical.slurGap;
  const lw = bracketLineWidth(m);
  const dx = endingLabelDx(lw, labelSize, m.style.vertical.bracketFoot);
  /** 房号墨迹（相对横线左端、横线心 y = 0）；跨行续过来的那一段不印 */
  const labelInk = (mk: PlacedMark): Rect | null => {
    if (mk.openLeft || !mk.mark.caption) return null;
    const r = ink.text(mk.mark.caption, "ending").ink;
    return r.offset(dx, labelBaselineOf(r.top, labelSize, lw));
  };
  const span = barlineSpan(m);
  const band = boxes.filter((b) => b.kind !== "direction");
  /** [x0, x1] 里音符那一摞与带的最高墨迹 */
  const inkTop = (x0: number, x1: number): number => {
    let t = bandTop(band, x0, x1) ?? Infinity;
    for (const it of items) {
      if (it.element.kind === "barline" || it.x < x0 || it.x > x1 || (it.element.kind === "note" && it.element.hidden)) continue;
      t = Math.min(t, entryTop(it.element, m) + (it.dy ?? 0));
    }
    return t;
  };
  let top = Infinity;
  for (const mk of voltas) {
    const leftFoot = !mk.openLeft;
    const rightFoot = !mk.openRight && mk.mark.openEnd !== true;
    if (leftFoot) {
      const label = labelInk(mk);
      const depth = Math.max(drop, label?.bottom ?? 0);
      top = Math.min(top, inkTop(mk.x0 - labelSize, mk.x0 + (label?.right ?? 0)) - labelSize * 0.7 - depth);
    }
    top = Math.min(top, inkTop(mk.x0, mk.x1) - gap - lw / 2);
    for (const it of items) {
      if (it.element.kind !== "barline" || it.x < mk.x0 - 2 || it.x > mk.x1 + 2) continue;
      const barTop = span.top + (it.dy ?? 0);
      const foot = (leftFoot && Math.abs(it.x - mk.x0) <= 2) || (rightFoot && Math.abs(it.x - mk.x1) <= 2);
      top = Math.min(top, barTop - gap - (foot ? drop : lw / 2));
    }
  }
  if (!Number.isFinite(top)) top = -m.ink.noteHeight / 2 - labelSize * 0.7 - drop;
  top -= (Math.max(...voltas.map((mk) => mk.level)) - 1) * m.note.levelStep;
  for (const mk of voltas) {
    mk.y = top;
    const bottom = Math.max(drop, labelInk(mk)?.bottom ?? 0);
    boxes.push({ key: mk, x0: mk.x0, x1: mk.x1, top: top - lw / 2, bottom: top + bottom, layer: 3, kind: "ending" });
  }
  // 房里（含竖脚、房号那一截）的力度/跳转字抬到房号线之上一道空
  for (const b of boxes) {
    if (b.kind !== "direction") continue;
    const group = directions.get(b.key);
    if (!group || !voltas.some((mk) => b.x1 > mk.x0 - labelSize && b.x0 < mk.x1)) continue;
    const d = top - lw / 2 - gap - b.bottom;
    if (d >= 0) continue;
    for (const t of group) {
      t.y += d;
      t.ink = t.ink.offset(0, d);
    }
    b.top += d;
    b.bottom += d;
  }
}

/** 带里属于这个元素的那几件（compose 画音符、小节线时取）。 */
export function bandOf(band: readonly PlacedText[]): Map<MusicElement, PlacedText[]> {
  const out = new Map<MusicElement, PlacedText[]>();
  for (const t of band) {
    const arr = out.get(t.el) ?? [];
    arr.push(t);
    out.set(t.el, arr);
  }
  return out;
}

