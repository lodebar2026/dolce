// 混排 `StaffLayout` 读入的公共部分：纯函数小工具与各声部读完之后的版面 pass。
// `layout.ts` 把各声部读成 `StaffLayout` 后调这里的 `finishMixedScore` 排版。从 musicpp mxml/parser.cpp 移植，判据原样。

import { latinWordBreak } from "../engrave/syllable";
import { Fraction } from "../common/fraction";
import { Font } from "../pagetree/font";
import { GlyphCodes, type MetaData } from "../smufl/smufl";
import { xmlPos } from "../model/xmlsurface";
import {
  BarGlyph,
  Encoder,
  fEq,
  LCR,
  ChordLayout,
  LyricLayout,
  type MeasureLayout,
  type PartLayout,
  StaffLayout,
  MPage,
  Notation,
  PartGroup,
  ScoreCredit,
  Sys,
  SysStaff,
  TimeSig,
  Tuplet,
  ARPEGGIO_RESERVE,
  arcExtent,
  slurEnds,
  smuflBottom,
  smuflTop,
  smuflWidth,
  tiedEnds,
  tightLineHeights,
} from "./model";

// ---------------- Note type ----------------


// ---------------- Barline ----------------

export function barGlyphFromStyle(style: string): BarGlyph | null {
  switch (style) {
    case "regular": return BarGlyph.Single;
    case "light-light": return BarGlyph.Double;
    case "light-heavy": return BarGlyph.Final;
    case "heavy-light": return BarGlyph.ReverseFinal;
    case "heavy-heavy": return BarGlyph.HeavyHeavy;
    case "none": return BarGlyph.None;
    default: return null;
  }
}

/** <beat-unit> 音符类型 → 节拍记号字形，对齐 loader.cpp::makeMetronomeStr（仅四分音符）。 */
export function metNoteGlyph(noteType: string): string {
  // musicpp 只实现了四分音符；其余暂以四分音符字形兜底。
  if (noteType !== "quarter") console.warn("metronome beat-unit not supported:", noteType);
  return GlyphCodes.metNoteQuarterUp;
}

export function parseEndingNums(s: string): Set<number> {
  const res = new Set<number>();
  for (const part of s.split(",")) {
    const n = parseInt(part.trim(), 10);
    if (!isNaN(n)) res.add(n);
  }
  return res;
}

// ---------------- Layout pass ----------------

// ---- 自动版面（无内嵌坐标时，如 OMR 生成的 MusicXML）----
// 真实制谱软件（Sibelius/Finale）导出的 MusicXML 自带 <measure width>、音符 default-x、
// <print new-system/new-page>，本工程默认信任之。识别产出的 MusicXML（staffomr/toxml.ts）
// 只有音高/时值、没有任何版面坐标 → 所有音符坍缩到 x≈0、谱表零宽。此处按节奏自动计算
// 小节宽度、折行、并把音符横向铺开，使无坐标的谱也能正常混排显示。

// 每音符按时值给一个"槽宽"（tenths）。时值越长间距越大（近似 Gould 的次线性增长）。
const AUTO_MIN_SLOT = 22;
const AUTO_END_PAD = 16;   // 末音符到小节线的余量
const AUTO_LEFT_DATA = 16; // 小节左侧到首音符的名义留白（折行用的自然宽）
const AUTO_NOTE_PAD = 8;    // 铺开音符时两端留白
const AUTO_LYRIC_SPACE = 6;  // 相邻两个字之间至少留的空
const AUTO_HARMONY_SPACE = 8; // 相邻两个和弦符号之间至少留的空
/** 源谱版面档过满的行压到这么窄为止（一个符头宽再带一点空；时值撑出来的宽都可以压掉） */
const SQUEEZE_MIN_SLOT = 16;
/** 第二档（连 `SQUEEZE_MIN_SLOT` 都放不下）的音符最小格：符头 11.8 再带一点空 */
const HARD_MIN_SLOT = 13;
/** 第二档相邻两个字之间留的空（第一档 `AUTO_LYRIC_SPACE`） */
const HARD_LYRIC_SPACE = 2;
/** 第二档小节两头的留白（第一档 `AUTO_LEFT_DATA` + `AUTO_END_PAD`） */
const HARD_MEASURE_PAD = 12;
/** 墨迹右缘到下一个音（没有临时记号时）至少留的空 */
const INK_CLEAR = 3;
/** 自动铺排：符干朝下的和弦，临时记号离那根贴在符头左缘的干再多让这么多（只隔 1 时还原号的竖笔与干并成一根粗线） */
const ACC_DOWNSTEM_CLEAR = 2;
/** 压缩时下一个音的临时记号离本拍位墨迹（多是符干）留的空：还原号的竖笔贴着符干像一根粗线（用户要求别太贴） */
const ACC_STEM_CLEAR = 5;
/** 第三档（最紧）：音符最小格只剩一个符头，墨迹之间、临时记号与符干之间留的空，小节两头留白（音符可以挨近小节线） */
const TIGHT_MIN_SLOT = 12;
const TIGHT_INK_CLEAR = 1.5;
const TIGHT_ACC_CLEAR = 3.5;
const TIGHT_MEASURE_PAD = 4;
/** 压紧的行里行首谱号调号右缘到首音的净空（第一档 `AUTO_ATTR_GAP`） */
const TIGHT_ATTR_GAP = 6;
const AUTO_GRACE_STEP = 14;   // 倚音一个占多宽（小号符头 + 符尾 + 间隙；tenths）
const AUTO_GRACE_GAP = 14;    // 最靠近主音的那个倚音与主音之间再多留的空（倚音的符尾朝右伸；8 时单颗倚音的符尾贴到主音符头）

/** 一个和弦前（`after` = 后）挨着的那串倚音：同声部同谱表、在元素流里紧挨着它的 grace 和弦，按离它由远到近排。 */
function gracesOf(md: { chords: readonly ChordLayout[] }, ch: ChordLayout, after: boolean): ChordLayout[] {
  const list = md.chords;
  const i = list.indexOf(ch);
  const out: ChordLayout[] = [];
  const same = (c: ChordLayout): boolean => c.src.voice === ch.src.voice && c.src.staff === ch.src.staff;
  if (!after) {
    for (let k = i - 1; k >= 0; k--) {
      const c = list[k]!;
      if (!same(c)) continue;
      if (!c.grace || c.src.grace?.after) break;
      out.unshift(c);
    }
  } else {
    for (let k = i + 1; k < list.length; k++) {
      const c = list[k]!;
      if (!same(c)) continue;
      if (!c.grace || !c.src.grace?.after) break;
      out.push(c);
    }
  }
  return out;
}

function autoSlotWidth(durQuarters: number): number {
  const d = durQuarters > 0 ? durQuarters : 0.25;
  // 长音每拍至少一格（简谱层的数字 + 增时线一拍占一格）：只按时值的次线性增长给，转调转拍后那小节里的附点二分
  // 只有 58，`5 - -` 两条增时线挤成一条、贴到小节线上
  return Math.max(AUTO_MIN_SLOT, 30 * Math.pow(d, 0.6), Math.floor(d) * AUTO_MIN_SLOT);
}

/** 该 MusicXML 是否自带版面坐标（任一小节有 width 或任一音符有 default-x）。读谱之前就要知道（弧的缺省朝向跟它走），
 *  所以直接看原文的表层（`xmlsurface.ts`）。 */
export { hasEmbeddedLayout } from "../model/xmlsurface";

/** 临时记号左缘离前一个音（符头或附点）右缘至少留这么多（tenths）；首音则是离小节数据区左缘 */
const AUTO_ACC_CLEAR = 4;

/**
 * 本小节各拍位上音符墨迹的横向范围，相对符头列的 x（各谱表各声部取并）：`left` 是临时记号、翻到左侧的符头往左伸出多少（≤ 0），
 * `right` 是符头、翻到右侧的符头、附点伸到哪。槽宽只按时值给的话，首音的升号贴着小节线，后面音的升号压到前一个音的附点上。
 * 量法：把这一拍位的和弦先放在 x = 0，照 `autoPlaceNotes` 同一套（`applyFlipOffset` + `NoteEntry.layout`）排一遍临时记号；
 * 真正落位时 `autoPlaceNotes` 会按最终 x 再排。
 */
function entryReach(score: StaffLayout, mi: number, byStaff?: Map<string, { offset: Fraction; left: number; ink: number }[]>): Map<string, { left: number; right: number; ink: number }> {
  const meta = score.options.meta;
  const out = new Map<string, { left: number; right: number; ink: number }>();
  for (const part of score.parts) {
    const md = part.measures[mi];
    if (!md) continue;
    for (const ent of md.noteEntries) {
      const chords = new Set(ent.notes.map((n) => n.chord));
      for (const ch of chords) {
        for (const nt of ch.notes) nt.x = 0;
        ch.applyFlipOffset(meta);
      }
      ent.layout(meta, true, ACC_DOWNSTEM_CLEAR);
      let left = 0;
      let right = 0;
      /** 连符尾在内的墨迹右缘（不在杠里、符干朝上的符尾往右伸）：只给压缩的最小宽用，自然宽照旧 */
      let ink = 0;
      for (const n of ent.notes) {
        right = Math.max(right, n.x + smuflWidth(meta, n.chord.sym()));
        if (!n.chord.rest) left = Math.min(left, n.x);
        if (n.chord.dot > 0) right = Math.max(right, ent.dot.dotPos + n.chord.dot * AUTO_DOT_STEP);
        const flag = n.chord.beams.length || !n.chord.stemUp ? "" : n.chord.tailSym(true);
        if (flag) ink = Math.max(ink, n.chord.stemX() + smuflWidth(meta, flag));
      }
      for (const a of ent.acc.accidentals) if (a.xpos !== null) left = Math.min(left, a.xpos);
      // 琶音线画在符头、临时记号左边，要让出它的宽（否则首音的琶音压小节线，八段锦钢片琴 m39）
      if (ent.notes.some((n) => n.arpeg)) left -= ARPEGGIO_RESERVE;
      const key = ent.offset.toString();
      const cur = out.get(key);
      out.set(key, { left: Math.min(cur?.left ?? 0, left), right: Math.max(cur?.right ?? 0, right), ink: Math.max(cur?.ink ?? 0, ink, right) });
      if (byStaff) {
        const sk = `${part.pid}:${ent.subStaff}`;
        const list = byStaff.get(sk) ?? [];
        const same = list.find((e) => !e.offset.compareTo(ent.offset));
        if (same) (same.left = Math.min(same.left, left)), (same.ink = Math.max(same.ink, ink, right));
        else list.push({ offset: ent.offset, left, ink: Math.max(ink, right) });
        byStaff.set(sk, list);
      }
    }
  }
  return out;
}
/** 一个附点（连同它前面的空）占的宽，tenths */
const AUTO_DOT_STEP = 6;

/** `min`：槽宽里压不掉的那截（字宽、和弦宽、倚音、音符最小格）；源谱版面档过满的行只压 `slot − min`（`autoJustifySystems`） */
type Slot = {
  offset: Fraction; nat: number; slot: number; min: number;
  /** 再往下压的底（第二档，`justifySourceSystem`）：音符最小格、歌词字距收到下限，墨迹与临时记号仍让开 */
  hard: number;
  /** 最紧的底（第三档）：字可以贴字、音符最小格只剩一个符头，临时记号离前面的符干仍留 `TIGHT_ACC_CLEAR` */
  tight: number;
};
const slotCache = new WeakMap<StaffLayout, Slot[][]>();

/** 某小节内所有声部音符的节奏槽：offset(measure-relative) → 自然累计 x + 该 offset 的槽宽。
 *  槽宽按时值给，但至少放得下挂在这一拍上的歌词（各段取最宽）与和弦符号——否则字挤在一起。 */
function autoMeasureSlots(score: StaffLayout, mi: number): Slot[] {
  let cache = slotCache.get(score);
  if (!cache) slotCache.set(score, (cache = []));
  const hit = cache[mi];
  if (hit) return hit;
  const durAt = new Map<string, { offset: Fraction; dur: number }>();
  const graceLead = new Map<string, number>();
  const graceTail = new Map<string, number>();
  const textAt = new Map<string, number>();
  /** 压缩用：同段相邻两个字（a、b 两个拍位）的中心距至少 `need`——两字之间那几个槽**合起来**放得下就行。
   *  `textAt` 按单字宽撑在字所在的槽上，后面另一声部插进来的十六分音符槽又各占一格最小宽，一个字实际占了一个半字宽；
   *  自然宽照旧用 `textAt`（不动铺得下的行），只有 `Slot.min` 按这个算 */
  const lyricPairs: { a: Fraction; b: Fraction; need: number; hard: number; tight: number }[] = [];
  /** 压缩用：小节里最后一个字所在的槽至少这么宽（半个字宽，另加字距） */
  const lyricTail = new Map<string, number>();
  /** 只算和弦符号要的槽宽（连音段里歌词按各自的行另算） */
  const harmAt = new Map<string, number>();
  const harms: { t: number; w: number }[] = [];
  const minText = (key: string, w: number) => textAt.set(key, Math.max(textAt.get(key) ?? 0, w));
  const minHarm = (key: string, w: number) => {
    minText(key, w);
    harmAt.set(key, Math.max(harmAt.get(key) ?? 0, w));
  };
  const eng = score.options;
  const harmFont = new Font(eng.wordFont, eng.harmonySize / score.scaling);
  for (const part of score.parts) {
    const md = part.measures[mi];
    if (!md) continue;
    for (const ch of md.chords) {
      if (ch.grace) continue;
      const key = ch.offset.toString();
      const dq = ch.dur.toFloat();
      const prev = durAt.get(key);
      // 同 offset 多声部/和弦取最短时值定间距（较密者主导）。
      if (!prev || dq < prev.dur) durAt.set(key, { offset: ch.offset, dur: dq });
      // 倚音要的地方：前倚音占这个音**前面**那一截，后倚音占它后面那一截
      const nb = gracesOf(md, ch, false).length, na = gracesOf(md, ch, true).length;
      const lead = nb ? nb * AUTO_GRACE_STEP + AUTO_GRACE_GAP : 0;
      const tail = na ? na * AUTO_GRACE_STEP + AUTO_GRACE_GAP : 0;
      if (lead) graceLead.set(key, Math.max(graceLead.get(key) ?? 0, lead));
      if (tail) graceTail.set(key, Math.max(graceTail.get(key) ?? 0, tail));
    }
    for (const l of md.lyrics) if (!l.empty) minText(l.offset.toString(), l.width + AUTO_LYRIC_SPACE);
    // 西文词与词之间留一个空格（判据同另两个引擎，engrave/syllable.ts::latinWordBreak）：歌词按音符居中，
    // 相邻两个音节的中心距至少「各半宽之和 + 字距 + 空格」，`十love` 才不粘成一个词
    // 同一段里本小节相邻的两个音节（`LyricLayout.next` 只连一个词内部的音节，词与词之间要自己排）
    const byVerse = new Map<string, typeof md.lyrics>();
    for (const l of md.lyrics) if (!l.empty) byVerse.set(l.num, [...(byVerse.get(l.num) ?? []), l]);
    for (const list of byVerse.values()) {
      list.sort((a, b) => a.offset.compareTo(b.offset));
      for (let k = 0; k + 1 < list.length; k++) {
        const l = list[k]!, n = list[k + 1]!;
        if (!l.offset.compareTo(n.offset)) continue;
        const gap = l.end && latinWordBreak(l.text, n.text) ? AUTO_LYRIC_SPACE + l.font.measureText(" ") : AUTO_LYRIC_SPACE;
        if (gap > AUTO_LYRIC_SPACE) minText(l.offset.toString(), (l.width + n.width) / 2 + gap);
        lyricPairs.push({ a: l.offset, b: n.offset, need: (l.width + n.width) / 2 + gap, hard: (l.width + n.width) / 2 + gap - AUTO_LYRIC_SPACE + HARD_LYRIC_SPACE, tight: (l.width + n.width) / 2 + gap - AUTO_LYRIC_SPACE });
      }
      // 本小节最后一个字：右半个字加字距要在小节里放下（下一小节头一个字的左半边有小节两头的留白兜着）
      const last = list[list.length - 1];
      if (last) lyricTail.set(last.offset.toString(), Math.max(lyricTail.get(last.offset.toString()) ?? 0, last.width / 2));
    }
    for (const h of md.harmonies) {
      harms.push({ t: h.offset.toFloat(), w: harmFont.measureText(h.asPlainText()) });
    }
  }
  const entries = [...durAt.values()].sort((a, b) => a.offset.compareTo(b.offset));
  // 和弦符号：相邻两个的中心距至少各自半宽之和。落在长音中间的（`<offset>`）按拍位在音符之间线性取 x
  //（`getEntPos`），所以要求折到它所在的那个音的槽宽上：slot × 拍位比例 ≥ 中心距
  const onsets = entries.map((e) => e.offset.toFloat());
  const measEnd = score.measures[mi]!.dur.toFloat();
  harms.sort((a, b) => a.t - b.t);
  for (let k = 1; k < harms.length; k++) {
    const a = harms[k - 1]!, b = harms[k]!;
    const need = (a.w + b.w) / 2 + AUTO_HARMONY_SPACE;
    // a 所在的音：起点 ≤ a.t 的最后一个。b 越过了下一个音的（中间隔着音符）不管，那几个槽各自已按字宽撑开
    let ia = onsets.length - 1;
    while (ia > 0 && onsets[ia]! > a.t + 1e-9) ia--;
    if (ia < 0) continue;
    const c0 = onsets[ia]!;
    const c1 = onsets[ia + 1] ?? measEnd;
    if (b.t <= c1 + 1e-9) {
      // a、b 在同一个音的槽里（或 b 正落在下一个音上）：slot × (b − a)/(c1 − c0) ≥ need
      const f = (b.t - a.t) / (c1 - c0 || 1);
      if (f > 0) minHarm(entries[ia]!.offset.toString(), need / f);
    }
  }
  for (const h of harms) {
    const e = entries.find((x) => Math.abs(x.offset.toFloat() - h.t) < 1e-9);
    if (e) minHarm(e.offset.toString(), h.w + AUTO_HARMONY_SPACE);
  }
  const slots: Slot[] = [];
  /** 各谱表（声部:谱表）逐拍位的墨迹：压缩的最小宽按同一谱表相邻两个音算（左手的附点不该撑宽右手的十六分音符槽） */
  const inkByStaff = new Map<string, { offset: Fraction; left: number; ink: number }[]>();
  const reach = entryReach(score, mi, inkByStaff);
  /** 拍位上的音往左伸出去的那截（临时记号、左翻符头），带上离前面东西的净空；没有就是 0 */
  const leadAt = (key: string): number => {
    const l = -(reach.get(key)?.left ?? 0);
    return l > 0 ? l + AUTO_ACC_CLEAR : 0;
  };
  // 首音带前倚音：整串往右让出那截；首音的临时记号也让出来（从前升号贴着小节线）
  let nat = entries.length ? (graceLead.get(entries[0]!.offset.toString()) ?? 0) + leadAt(entries[0]!.offset.toString()) : 0;
  /** 后倚音与**下一个音的前倚音**要的那截（倚音不挤占音符之间的节奏距离） */
  const gracesAfter = (k: number): number => {
    const next = entries[k + 1];
    return (graceTail.get(entries[k]!.offset.toString()) ?? 0) + (next ? graceLead.get(next.offset.toString()) ?? 0 : 0);
  };
  /** 这个槽至少要多宽：本拍位的墨迹右缘 + 下一个音的临时记号那截（槽宽按时值给时，短音后面跟着带升号的音会压上去） */
  const inkNeed = (k: number): number => {
    const next = entries[k + 1];
    if (!next) return 0;
    const lead = leadAt(next.offset.toString());
    return lead ? (reach.get(entries[k]!.offset.toString())?.right ?? 0) + lead : 0;
  };
  const spans = tupletSpans(score, mi);
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k]!;
    const span = spans.find((sp) => !sp.s.compareTo(e.offset));
    if (span) {
      // 连音组（与别的声部重叠的几组并成一段）：段内 x 随时间线性走——组内等分，与外部拍位只在组首组尾对齐。
      // 逐拍位累加槽宽的话，三连音八分（0、⅓、⅔）与另一声部的普通八分（0、½）合成四个槽，三个音排得一疏一密
      let j = k;
      while (j + 1 < entries.length && entries[j + 1]!.offset.compareTo(span.e) < 0) j++;
      const w = tupletSpanWidth(score, mi, span, entries.slice(k, j + 2).map((x) => x.offset), (i) => gracesAfter(k + i), harmAt);
      const s = span.s.toFloat(), len = span.e.toFloat() - s;
      const x0 = nat;
      for (let i = k; i <= j; i++) {
        const at = x0 + (w * (entries[i]!.offset.toFloat() - s)) / len;
        if (i > k) slots[slots.length - 1]!.slot = slots[slots.length - 1]!.min = slots[slots.length - 1]!.hard = slots[slots.length - 1]!.tight = at - slots[slots.length - 1]!.nat;
        slots.push({ offset: entries[i]!.offset, nat: at, slot: 0, min: 0, hard: 0, tight: 0 });
      }
      // 组尾之后：组尾正好是下一个拍位就落在段末；不是（另一声部的长音跨过组尾）就照常按末音的槽宽再取大
      const last = slots[slots.length - 1]!;
      const tail = Math.max(autoSlotWidth(entries[j]!.dur), textAt.get(entries[j]!.offset.toString()) ?? 0) + gracesAfter(j);
      nat = Math.max(x0 + w, last.nat + tail);
      last.slot = last.min = last.hard = last.tight = nat - last.nat;
      k = j;
      continue;
    }
    const key = e.offset.toString();
    const text = textAt.get(key) ?? 0;
    const ink = inkNeed(k);
    const slot = Math.max(autoSlotWidth(e.dur), text, ink) + gracesAfter(k);
    const harm = harmAt.get(key) ?? 0;
    const tail = lyricTail.get(key);
    // 墨迹（符头、附点、符尾、临时记号）在下面按各谱表相邻两个音另算（`inkByStaff`）
    const min = Math.min(slot, Math.max(SQUEEZE_MIN_SLOT, harm, tail === undefined ? 0 : tail + AUTO_LYRIC_SPACE) + gracesAfter(k));
    const hard = Math.min(min, Math.max(HARD_MIN_SLOT, harm, tail === undefined ? 0 : tail + HARD_LYRIC_SPACE) + gracesAfter(k));
    const tight = Math.min(hard, Math.max(TIGHT_MIN_SLOT, harm, tail ?? 0) + gracesAfter(k));
    slots.push({ offset: e.offset, nat, slot, min, hard, tight });
    nat += slot;
  }
  // **墨迹按各谱表相邻两个音算**：本音墨迹右缘（符头、附点、不在杠里的朝上符尾）+ 下一个音往左伸出那截
  //（临时记号离前面的符干留 `ACC_STEM_CLEAR`、最紧一档 `TIGHT_ACC_CLEAR`；没有临时记号留 `INK_CLEAR`），摊到两音之间的各槽上。
  // 从前按拍位跨谱表合起来算在本拍位的槽上：左手附点四分的附点、单独八分音符的符尾把右手同一拍的十六分音符槽撑宽，伴奏一宽一窄（破碎 m84）。
  // 小节末一个音同样要放下它的墨迹（符尾），不然压紧时符尾贴到小节线上。临时记号画在 `xpos − 1`（`render.ts`），伸出那截再多一个单位
  const spreadOver = (ia: number, ib: number, need: { min: number; hard: number; tight: number }) => {
    const span = slots.slice(ia, ib);
    if (!span.length) return;
    const natSum = span.reduce((x, sl) => x + sl.slot, 0) || 1;
    const raise = (key: "min" | "hard" | "tight", want: number, cap: (sl: Slot) => number) => {
      const have = span.reduce((x, sl) => x + sl[key], 0);
      if (have >= want) return;
      for (const sl of span) sl[key] = Math.min(cap(sl), sl[key] + ((want - have) * sl.slot) / natSum);
    };
    raise("min", need.min, (sl) => sl.slot);
    raise("hard", need.hard, (sl) => sl.min);
    raise("tight", need.tight, (sl) => sl.hard);
  };
  for (const list of inkByStaff.values()) {
    list.sort((a, b) => a.offset.compareTo(b.offset));
    list.forEach((a, n) => {
      const b = list[n + 1];
      const ia = slots.findIndex((sl) => !sl.offset.compareTo(a.offset));
      const ib = b ? slots.findIndex((sl) => !sl.offset.compareTo(b.offset)) : slots.length;
      if (ia < 0 || ib <= ia) return;
      const lead = b && b.left < 0 ? -b.left + 1 : 0;
      spreadOver(ia, ib, {
        min: a.ink + (lead ? lead + ACC_STEM_CLEAR : INK_CLEAR),
        hard: a.ink + (lead ? lead + ACC_STEM_CLEAR : INK_CLEAR),
        tight: a.ink + (lead ? lead + TIGHT_ACC_CLEAR : TIGHT_INK_CLEAR),
      });
    });
  }
  // 歌词的中心距折到两字之间的各槽上：不够的差额补在前一个字那个槽的 `min` 上（不超过它的自然宽，超出的部分本来就放不下）
  for (const pr of lyricPairs) {
    const ia = slots.findIndex((sl) => !sl.offset.compareTo(pr.a));
    const ib = slots.findIndex((sl) => !sl.offset.compareTo(pr.b));
    if (ia < 0 || ib <= ia) continue;
    // 差额按各槽自然宽的比例摊到两字之间的每个槽上：全补在前一个字的槽上，一个八分音符的字跨两个十六分音符槽时
    // 伴奏的十六分音符就一宽一窄（用户：钢琴伴奏排得不匀）
    spreadOver(ia, ib, { min: pr.need, hard: pr.hard, tight: pr.tight });
  }
  cache[mi] = slots;
  return slots;
}

/** 本小节里的连音组跨度 [组首, 组尾音的终点)，各声部重叠的并成一段；跨小节、零长的不算。 */
function tupletSpans(score: StaffLayout, mi: number): { s: Fraction; e: Fraction }[] {
  const raw: { s: Fraction; e: Fraction }[] = [];
  for (const part of score.parts) {
    const md = part.measures[mi];
    if (!md) continue;
    for (const t of part.tuplets) {
      if (!t.startNote || !t.endNote) continue;
      const a = t.startChord(), b = t.endChord();
      if (a.measure !== md || b.measure !== md || a.grace || b.grace) continue;
      const e = b.offset.plus(b.dur);
      if (e.compareTo(a.offset) > 0) raw.push({ s: a.offset, e });
    }
  }
  raw.sort((x, y) => x.s.compareTo(y.s));
  const out: { s: Fraction; e: Fraction }[] = [];
  for (const r of raw) {
    const prev = out[out.length - 1];
    if (prev && r.s.compareTo(prev.e) < 0) {
      if (r.e.compareTo(prev.e) > 0) prev.e = r.e;
    } else out.push({ s: r.s, e: r.e });
  }
  return out;
}

/** 两个不同声部的音挨得再近也要留的距离（tenths，约一个符头宽）：段内线性铺开时另一声部的音会插在组内两音之间 */
const AUTO_CROSS_VOICE_GAP = 12;

/**
 * 连音段要多宽：段内 x 随时间线性走，每个音到**同一声部**下一个音的距离要放得下它自己的槽宽、每个字到同一段下一个字
 * 要放得下字宽，整段宽就是各行按比例折算后的最大值（下一件在段外的按时间比例分摊）。别的声部的字不算——
 * 它们排在各自的歌词行上，按拍位合并的字宽只会把组里某一截撑大。
 * `onsets` 是段内各拍位，后面多带一个段后的拍位（没有就到段末为止）；和弦符号与倚音按全体拍位相邻算。
 */
function tupletSpanWidth(
  score: StaffLayout, mi: number, span: { s: Fraction; e: Fraction },
  onsets: Fraction[], gracesAfter: (i: number) => number, harmAt: ReadonlyMap<string, number>,
): number {
  const s = span.s.toFloat(), e = span.e.toFloat(), len = e - s;
  const inSpan = (t: number) => t >= s - 1e-9 && t < e - 1e-9;
  let w = 0;
  /** 拍位 a 到 b 之间要 width 宽：b 在段外时只按段内那截时间的比例分摊（跨过组尾的长音不把整个槽宽压进这一段） */
  const need = (a: number, b: number, width: number) => { if (b > a + 1e-9) w = Math.max(w, (width * len) / (b - a)); };
  // 一行里相邻的两件东西：各声部的音（按时值）、各声部各段的歌词（按字宽）。拍位 → 这一拍要的宽与它的终点
  const rows = new Map<string, Map<number, { width: number; end: number }>>();
  const put = (key: string, t: number, width: number, end: number) => {
    if (!inSpan(t)) return;
    const m = rows.get(key) ?? new Map<number, { width: number; end: number }>();
    rows.set(key, m);
    const cur = m.get(t);
    m.set(t, { width: Math.max(cur?.width ?? 0, width), end: Math.max(cur?.end ?? 0, end) });
  };
  score.parts.forEach((part, pi) => {
    const md = part.measures[mi];
    if (!md) return;
    const endOf = (ch: ChordLayout) => ch.offset.plus(ch.dur).toFloat();
    for (const ch of md.chords) {
      if (!ch.grace) put(`n${pi}/${ch.src.staff}/${ch.voice}`, ch.offset.toFloat(), autoSlotWidth(ch.dur.toFloat()), endOf(ch));
    }
    for (const l of md.lyrics) if (!l.empty) put(`l${pi}/${l.num}`, l.offset.toFloat(), l.width + AUTO_LYRIC_SPACE, endOf(l.chord));
  });
  // 行内下一件也在本小节的就到它为止（段外的照样按比例），最后一件到它那个音的终点
  const after = new Map<string, number>();
  score.parts.forEach((part, pi) => {
    const md = part.measures[mi];
    if (!md) return;
    const near = (key: string, t: number) => { if (t >= e - 1e-9) after.set(key, Math.min(after.get(key) ?? Infinity, t)); };
    for (const ch of md.chords) if (!ch.grace) near(`n${pi}/${ch.src.staff}/${ch.voice}`, ch.offset.toFloat());
    for (const l of md.lyrics) if (!l.empty) near(`l${pi}/${l.num}`, l.offset.toFloat());
  });
  for (const [key, m] of rows) {
    const ts = [...m.keys()].sort((a, b) => a - b);
    ts.forEach((t, i) => need(t, ts[i + 1] ?? after.get(key) ?? m.get(t)!.end, m.get(t)!.width));
  }
  // 全体相邻拍位：不同声部的音不叠在一起，和弦符号、倚音的地方照留
  const ts = onsets.map((o) => o.toFloat());
  ts.forEach((t, i) => {
    if (inSpan(t)) need(t, Math.min(ts[i + 1] ?? e, e), Math.max(AUTO_CROSS_VOICE_GAP, harmAt.get(onsets[i]!.toString()) ?? 0) + gracesAfter(i));
  });
  return w;
}

// 断行的代价（整体最优，见 autoLayoutWidths）。按下面两个用例校准：
//  - 简谱一行 6 小节、五线谱一行只放得下 4 个：拆 3+3（各填 0.74），不拆 4+2（0.96 + 0.51）；
//  - 相邻两行都只填到一半上下（0.5 + 0.5、0.55 + 0.4）：并成一行，免得各自拉伸成稀稀拉拉的两行（长图一行 4 小节常这样）。
/** 在简谱没换行的地方断行 */
const BREAK_OFF_PREFERRED = 0.4;
/** 跨过一处简谱换行（把两行并成一行） */
const BREAK_MERGE = 0.35;
/** 末行最多拉伸到自然宽的几倍（再短就不拉满，右边留空） */
const LAST_LINE_MAX_STRETCH = 1.6;
/** 填不到一半的行（拉伸一倍以上，稀得不成样子）代价加重：简谱那边窄纸大字、小节中间换行，常剩半小节一行 */
const UNDERFULL = 3;
/** 末行不拉伸、短一点无妨，填不到这么多才算代价（免得末了孤零零一个小节） */
const LAST_LINE_MIN_FILL = 0.5;

/** 计算每小节自然宽度 + 按页宽断行，返回起行的小节序号（含 0）。
 *  `<print new-system>`（简谱视图实际排出的行，或识别出的原图分行）是**优选断点**，不是硬断点：
 *  一行放不下就在行内均匀地拆，太短就与邻行合并；`new-page` 是硬断点。
 *  代价 = Σ 非末行 (1 − 填充率)² + 末行过短 + 各处罚分，动态规划取最小（小节数不过几百，O(n²) 足够）。 */
function autoLayoutWidths(score: StaffLayout, input: LayoutInput): Set<number> {
  const n = score.measures.length;
  const w: number[] = [];
  for (let i = 0; i < n; i++) {
    score.measures[i].width = autoNaturalWidth(score, i);
    w[i] = score.measures[i].width + midAttrWidth(score, i); // 折行按带转调转拍号的宽量
  }
  const preferred = new Set<number>();
  const hard = new Set<number>();
  /** 小节中间换行拆出的后半（`implicit` 且起新行）：拆它就是为了在这儿断，不断就在行中间留一道隐藏线缝 */
  const forced = new Set<number>();
  for (const pt of input) {
    pt.forEach((mea, i) => {
      for (const pr of mea.prints) {
        if (pr.newPage) hard.add(i);
        else if (pr.newSystem) (score.measures[i]?.implicit ? forced : preferred).add(i);
      }
    });
  }

  const d = score.defaults;
  const avail = d.pageWidth - d.leftMargin - d.rightMargin;
  const best: number[] = [0];
  const from: number[] = [0];
  const lead = score.measures.map((_, i) => autoLead(score, i));
  for (let j = 1; j <= n; j++) {
    best[j] = Infinity;
    from[j] = j - 1;
    let sum = 0;
    let merged = 0;
    for (let i = j - 1; i >= 0; i--) {
      sum += w[i];
      const width = lead[i] + sum;
      if (width > avail && i < j - 1) break; // 单小节超宽也得放
      const fill = width / avail;
      const slack = j === n ? Math.max(0, LAST_LINE_MIN_FILL - fill) * 3 : 1 - Math.min(fill, 1);
      let cost = best[i] + slack ** 2 * (j < n && fill < 0.5 ? UNDERFULL : 1) + merged * BREAK_MERGE;
      if (i > 0 && !preferred.has(i) && !hard.has(i) && !forced.has(i)) cost += BREAK_OFF_PREFERRED;
      if (cost < best[j]) {
        best[j] = cost;
        from[j] = i;
      }
      if (hard.has(i) || forced.has(i)) break; // 不能跨过换页、拆开的半小节
      if (preferred.has(i)) merged++;
    }
  }
  const breaks = new Set<number>();
  for (let j = n; j > 0; j = from[j]) breaks.add(from[j]);
  breaks.add(0);
  return breaks;
}

/** 小节的自然宽（折行与断句量宽同一把尺子）。 */
function autoNaturalWidth(score: StaffLayout, mi: number): number {
  const slots = autoMeasureSlots(score, mi);
  const span = slots.length ? slots[slots.length - 1].nat + slots[slots.length - 1].slot : AUTO_MIN_SLOT;
  return AUTO_LEFT_DATA + span + AUTO_END_PAD;
}

/** 硬断点（源谱版面档、源文写明的换行）：起行照谱里的 `new-system` / `new-page`，各小节宽仍按自然宽给。 */
function sourceBreaks(score: StaffLayout, input: LayoutInput): Set<number> {
  const breaks = new Set<number>([0]);
  for (let i = 0; i < score.measures.length; i++) score.measures[i]!.width = autoNaturalWidth(score, i);
  for (const pt of input) {
    pt.forEach((mea, i) => {
      if (mea.prints.some((pr) => pr.newPage || pr.newSystem)) breaks.add(i);
    });
  }
  return breaks;
}

/** 源文写明的换行（ABC，`hardBreaks` 而非源谱版面档）：起行照 `sourceBreaks`，源文的行不并。
 *  只有连最紧一档（`Slot.tight`）都压不下的行——多半是源文没写换行、整首一行（没写 `$` 的 123 转出的 ABC 就是这样）——
 *  才在行内按自然宽均分成几行，免得压成墨迹相叠的第四档。 */
function writtenBreaks(score: StaffLayout, input: LayoutInput): Set<number> {
  const breaks = sourceBreaks(score, input);
  const n = score.measures.length;
  const d = score.defaults;
  const avail = d.pageWidth - d.leftMargin - d.rightMargin;
  const tight: Squeeze = { mode: 3, s: 0 };
  const starts = [...breaks].sort((a, b) => a - b);
  starts.forEach((from, k) => {
    const to = starts[k + 1] ?? n;
    const w = (i: number) => score.measures[i]!.width + (i > from ? midAttrWidth(score, i) : 0);
    let min = autoLead(score, from) - AUTO_ATTR_GAP + TIGHT_ATTR_GAP;
    let nat = autoLead(score, from);
    for (let i = from; i < to; i++) {
      min += squeezedWidth(score, i, tight) + (i > from ? midAttrWidth(score, i) : 0);
      nat += w(i);
    }
    if (min <= avail) return;
    const pieces = Math.ceil(nat / avail);
    let acc = autoLead(score, from);
    let m = 1;
    for (let i = from; i < to - 1 && m < pieces; i++) {
      acc += w(i);
      if (acc >= (nat * m) / pieces) {
        breaks.add(i + 1);
        m++;
      }
    }
  });
  return breaks;
}

/** 源谱版面档过满的行：小节 → 怎么压的（`Squeeze`）。没压的小节不在表里 */
const squeezeOf = new WeakMap<MeasureLayout, Squeeze>();

/**
 * **五线谱的断句尺子**（`score/phrase.ts::FitMetric` 的原料）：各和弦在整首连排时的自然横向区间，
 * 与 `autoLayoutWidths` 折行同一套小节自然宽，键是源元素 id（`Chord.srcId`，文本格式派生时 `sourceIds` 写的）。
 * `width` 是一行放得下的跨度：版心减行首谱号调号拍号（`autoLead`），再减首音前、末音后那点小节内留白。
 * 要在自动铺排（`finishMixedScore`）之后调——小节 `offset` 那时才定。
 */
export function staffChordSpans(score: StaffLayout): { width: number; byId: Map<number, { x0: number; x1: number }> } {
  const byId = new Map<number, { x0: number; x1: number }>();
  let x = 0;
  score.measures.forEach((_, mi) => {
    const at = new Map(autoMeasureSlots(score, mi).map((s) => [s.offset.toString(), s] as const));
    const md = score.parts[0]?.measures[mi];
    for (const ch of md?.chords ?? []) {
      const id = ch.src.srcId;
      const s = at.get(ch.offset.toString());
      if (ch.grace || id === undefined || !s || byId.has(id)) continue;
      const x0 = x + AUTO_LEFT_DATA + s.nat;
      byId.set(id, { x0, x1: x0 + s.slot });
    }
    x += autoNaturalWidth(score, mi);
  });
  const d = score.defaults;
  const width = d.pageWidth - d.leftMargin - d.rightMargin - autoLead(score, 0) - AUTO_LEFT_DATA - AUTO_END_PAD;
  return { width, byId };
}

/** 行首小节谱号、调号（拍号变了连拍号）占的宽，与 `layoutAttr` 同一套量法，再加首音前的净空（`autoPlaceNotes`）。
 *  从前写死 60：四个升号带拍号就不够，首音挤到小节线外。 */
function autoLead(score: StaffLayout, mi: number): number {
  const mif = score.measures[mi]!;
  let key = 0;
  let time = 0;
  for (const part of score.parts) {
    for (const ps of part.staves) {
      const ks = ps.getKey(mif.offset);
      key = Math.max(key, keyChangeWidthCalc(ks.cancel, ks.fifths));
      if (mi === 0 || ps.timeChange(mif.offset)) time = Math.max(time, timeSigWidthCalc(ps.getTime(mif.offset), score.options.meta));
    }
  }
  return 5 + 32 + key + time + AUTO_ATTR_GAP;
}

/** 行中（不在行首）的转调、转拍号要占的宽：`layoutAttr` 从数据区里扣，自然宽不算它的话，那一小节留给音符的地方
 *  就被吃掉一大截（转调转拍后的 `5 - -` 两条增时线挤成一条、贴到小节线上）。 */
function midAttrWidth(score: StaffLayout, mi: number): number {
  if (mi === 0) return 0;
  const mif = score.measures[mi]!;
  let key = 0;
  let time = 0;
  for (const part of score.parts) {
    for (const ps of part.staves) {
      if (ps.keyChange(mif.offset)) {
        const ks = ps.getKey(mif.offset);
        key = Math.max(key, keyChangeWidthCalc(ks.cancel, ks.fifths));
      }
      if (ps.timeChange(mif.offset)) time = Math.max(time, timeSigWidthCalc(ps.getTime(mif.offset), score.options.meta));
    }
  }
  return key + time;
}

/** 折行后拉伸每个 system 的小节宽度以铺满页宽（末行保持自然宽，不拉伸）。 */
function autoJustifySystems(score: StaffLayout): void {
  const d = score.defaults;
  for (let si = 0; si < score.systems.length; si++) {
    const sys = score.systems[si];
    if (!sys.measures.length) continue;
    const avail = d.pageWidth - d.leftMargin - d.rightMargin - sys.leftMargin - sys.rightMargin;
    // 行首小节预留谱号/调号/拍号占位，使拉伸后仍有容纳区。
    sys.measures[0].width += autoLead(score, sys.firstMeasure);
    // 行中转调转拍号那一截不拉伸，另加在小节上（行首的已在 autoLead 里）
    const attr = sys.measures.map((m, k) => (k === 0 ? 0 : midAttrWidth(score, m.index)));
    let sum = 0;
    for (const m of sys.measures) sum += m.width;
    if (sum <= 0) continue;
    const attrSum = attr.reduce((a, b) => a + b, 0);
    let scale = Math.max(0, avail - attrSum) / sum;
    // 源文写明的硬断点（`hardBreaks`）过满的行也照源谱版面档压
    if (score.keepBreaks || (score.hardBreaks && scale < 1)) {
      justifySourceSystem(score, sys, avail, attr);
      continue;
    }
    const isLast = si === score.systems.length - 1;
    // 末行也拉满，但最多拉到自然宽的 LAST_LINE_MAX_STRETCH 倍：太短的末行（剩一两个小节）照拉满就稀得不成样子，
    // 拉到上限为止、右边留空
    if (isLast && scale > LAST_LINE_MAX_STRETCH) scale = LAST_LINE_MAX_STRETCH;
    sys.measures.forEach((m, k) => { m.width = m.width * scale + attr[k]!; });
  }
}

/**
 * 源谱版面档的一行：行是原谱定的，末行也铺满（原谱的末行本来多半就是满的，短的由 `system-margins` 留出右空）。
 * 放得下就照常按自然宽等比拉；放不下（本引擎的字比原谱宽、音符格比原谱疏）**只压时值撑出来的那截**，
 * 字宽、和弦宽、倚音与音符最小格不动（`Slot.min`）；连这些都放不下才整体等比压（会贴字）。
 * 行首谱号调号那截（`autoLead`）与行中转调转拍号那截不压。
 */
function justifySourceSystem(score: StaffLayout, sys: Sys, avail: number, attr: readonly number[]): void {
  const lead = autoLead(score, sys.firstMeasure);
  const nat = sys.measures.map((m, k) => m.width - (k === 0 ? lead : 0));
  const sumNat = nat.reduce((a, b) => a + b, 0);
  const room = avail - lead - attr.reduce((a, b) => a + b, 0);
  const set = (k: number, w: number) => { sys.measures[k]!.width = w + (k === 0 ? lead : 0) + attr[k]!; };
  if (sumNat <= 0) return;
  if (room >= sumNat) {
    nat.forEach((w, k) => set(k, (w * room) / sumNat));
    return;
  }
  // 行首谱号调号之后那截净空（`AUTO_ATTR_GAP`）也跟着各档收：压紧的行里它显得空（用户：81 小节开头明显有空）
  const leadOf = (sq: Squeeze) => lead - AUTO_ATTR_GAP + squeezedAttrGap(sq);
  const total = (sq: Squeeze) => sys.measures.reduce((a, m) => a + squeezedWidth(score, m.index, sq), 0) + leadOf(sq) - lead;
  /** 整行共用一个间距系数 `s`，二分到正好铺满（`total` 随 `s` 单调增） */
  const solve = (mode: 1 | 2 | 3): Squeeze => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (total({ mode, s: mid }) > room) hi = mid;
      else lo = mid;
    }
    return { mode, s: lo };
  };
  // 各档都是「整行一个系数 s × 按时值的自然宽（`slot`），夹在本档下限之上」：短音先压到下限，长音仍按时值多留一点，
  // 疏的小节把地方让给密的（用户提的），又不至于把音少的小节压扁（下限一样宽的话四分音符与十六分音符一样窄，破碎 m82 只剩原谱三分之二）。
  // ① 下限 `min`；② 下限 `hard`、小节两头留白跟着收；③ 下限 `tight`：音符可以挨近小节线、字可以贴字（用户定：过密时宁可离小节线近，
  //    空间尽量均分），临时记号仍离符干留空；④ 连 tight 都放不下才整体等比
  let sq: Squeeze;
  if (total({ mode: 1, s: 0 }) <= room) sq = solve(1);
  else if (total({ mode: 2, s: 0 }) <= room) sq = solve(2);
  else if (total({ mode: 3, s: 0 }) <= room) sq = solve(3);
  else sq = { mode: 4, s: 0 };
  const ws = sys.measures.map((m) => squeezedWidth(score, m.index, sq));
  const sumW = ws.reduce((a, b) => a + b, 0);
  const shrink = lead - leadOf(sq);
  ws.forEach((w, k) => {
    squeezeOf.set(sys.measures[k]!, sq);
    set(k, (sq.mode === 4 ? (w * Math.max(0, room + shrink)) / (sumW || 1) : w) - (k === 0 ? shrink : 0));
  });
}

/** 源谱版面档过满的行怎么压：`mode` 1 = 各槽 max(min, s·slot)；2 = 各槽 max(hard, s·slot)、两头留白收；
 *  3 = 各槽 max(tight, s·slot)、两头留白再收；4 = 各槽 tight、整行等比 */
type Squeeze = { mode: 1 | 2 | 3 | 4; s: number };

/** 压过之后一个槽占多宽 */
function squeezedSlot(sl: Slot, sq: Squeeze): number {
  if (sq.mode === 1) return Math.max(sl.min, sq.s * sl.slot);
  if (sq.mode === 2) return Math.max(sl.hard, sq.s * sl.slot);
  if (sq.mode === 3) return Math.max(sl.tight, sq.s * sl.slot);
  return sl.tight;
}

/** 压过之后行首谱号调号右缘到首音的净空（第一档照旧 `AUTO_ATTR_GAP`） */
function squeezedAttrGap(sq: Squeeze): number {
  if (sq.mode === 1) return AUTO_ATTR_GAP;
  if (sq.mode === 2) return TIGHT_ATTR_GAP + (AUTO_ATTR_GAP - TIGHT_ATTR_GAP) * sq.s;
  return TIGHT_ATTR_GAP;
}

/** 压过之后小节两头的留白（第一档照旧 `AUTO_LEFT_DATA + AUTO_END_PAD`，往下收到 `HARD_MEASURE_PAD`、再到 `TIGHT_MEASURE_PAD`） */
function squeezedPad(sq: Squeeze): number {
  const full = AUTO_LEFT_DATA + AUTO_END_PAD;
  if (sq.mode === 1) return full;
  if (sq.mode === 2) return HARD_MEASURE_PAD + (full - HARD_MEASURE_PAD) * sq.s;
  if (sq.mode === 3) return TIGHT_MEASURE_PAD + (HARD_MEASURE_PAD - TIGHT_MEASURE_PAD) * sq.s;
  return TIGHT_MEASURE_PAD;
}

/** 压过之后的小节宽（不含行首谱号调号那截与行中转调） */
function squeezedWidth(score: StaffLayout, mi: number, sq: Squeeze): number {
  const slots = autoMeasureSlots(score, mi);
  if (!slots.length) return Math.min(autoNaturalWidth(score, mi), squeezedPad(sq) + TIGHT_MIN_SLOT);
  return Math.min(autoNaturalWidth(score, mi), squeezedPad(sq) + slots[0]!.nat + slots.reduce((a, sl) => a + squeezedSlot(sl, sq), 0));
}

/** layoutAttr 之后：把每小节音符横向铺到 [dataPos, dataEnd] 内（按节奏槽比例）。 */
function autoPlaceNotes(score: StaffLayout): void {
  for (let i = 0; i < score.measures.length; i++) {
    const mif = score.measures[i];
    const slots = autoMeasureSlots(score, i);
    if (!slots.length) continue;
    // 过满被压的小节：各槽按 `squeezedSlot` 压过的宽，按累计位置比例铺
    const sq = squeezeOf.get(mif);
    const pos = new Map<Slot, number>();
    let acc = slots[0]!.nat;
    for (const sl of slots) {
      pos.set(sl, sq === undefined ? sl.nat : acc);
      acc += sq === undefined ? sl.slot : squeezedSlot(sl, sq);
    }
    const natTotal = sq === undefined ? slots[slots.length - 1].nat + slots[slots.length - 1].slot : acc;
    // 行首小节 dataPos 紧贴谱号/调号/拍号右缘，首音符须再留一段净空，否则贴着拍号。
    // 压到第二档的小节两头留白跟着收（小节宽里那截从 `AUTO_LEFT_DATA + AUTO_END_PAD` 收到 `HARD_MEASURE_PAD`）
    const hasAttr = mif.clefPos !== null || mif.keyPos !== null || mif.timePos !== null;
    const pad = sq === undefined ? AUTO_NOTE_PAD : (AUTO_NOTE_PAD * squeezedPad(sq)) / (AUTO_LEFT_DATA + AUTO_END_PAD);
    const left = mif.dataPos + pad + (hasAttr ? (sq === undefined ? AUTO_ATTR_GAP : squeezedAttrGap(sq)) : 0);
    const right = mif.dataEnd - pad;
    const inner = Math.max(right - left, AUTO_MIN_SLOT);
    const xOf = new Map<string, number>();
    for (const s of slots) {
      xOf.set(s.offset.toString(), left + (natTotal > 0 ? (pos.get(s)! / natTotal) * inner : 0));
    }
    const meta = score.options.meta;
    for (const part of score.parts) {
      const md = part.measures[i];
      if (!md) continue;
      for (const ch of md.chords) {
        if (ch.grace) continue;
        const x = xOf.get(ch.offset.toString());
        if (x === undefined) continue;
        for (const nt of ch.notes) nt.x = x;
        // 和弦里的二度：翻到另一侧的那个头错开一个头宽（不错开两个头叠成一团）
        ch.applyFlipOffset(meta);
        // 倚音挨着主音排：前倚音在左、由近到远一个一个往左数，后倚音在右（地方在槽宽里留过了）
        const before = gracesOf(md, ch, false);
        before.forEach((g, k) => {
          for (const nt of g.notes) nt.x = x - AUTO_GRACE_GAP - (before.length - k) * AUTO_GRACE_STEP;
        });
        gracesOf(md, ch, true).forEach((g, k) => {
          for (const nt of g.notes) nt.x = x + AUTO_GRACE_GAP + (k + 1) * AUTO_GRACE_STEP;
        });
      }
      // NoteEntry（加线/附点/临时记号）在解析期 layoutNotes 时按未定位的 x(-1) 算过一次，
      // 加线会画到谱表最左端而非音符下方；音符 x 定好后按最终位置重排。
      // 同一谱表两个声部同一拍位挨着二度（或符头不同的同度）的和弦也要错开（`layoutChords`），与 Sibelius 原文同一套
      for (const ent of md.noteEntries) ent.layout(meta, true, ACC_DOWNSTEM_CLEAR);
      // 符杠斜率/端点依赖音符 x，解析期(x=-1)算出的是 NaN/退化值 → 重排。
      for (const g of md.beams) g.refresh();
      // 杠中间的休止让开杠（要在符干长定了之后）
      for (const g of md.beams) g.clearRests(meta);
      // 歌词：解析时 lrc.x 取的是尚未定位的音符 x(-1)，此处按音符最终位置补正 x
      //（否则 drawLrc 里 x<0 被跳过，歌词不显示）。y 由 autoPlaceLyricsY 按 system 统一定。
      for (const lrc of md.lyrics) {
        const x = xOf.get(lrc.offset.toString());
        if (x !== undefined) lrc.x = x;
      }
      // 速度/文字记号：无 default-y 时默认落在谱表内（y≈0）与音符重叠，抬到谱表上方；
      // 字号统一到歌词字号（含节拍音符字形），避免 OMR 速度记号偏小。
      const lyrSize = score.defaults.lyricFont.size;
      // 识别稿照原图写了位置、字号的力度（`sourceY` / `sourceSize`）不动
      for (const t of md.textBlocks) {
        if (t.y <= 0 && !t.sourceY) {
          t.y = AUTO_DIRECTION_Y;
          t.autoY = true;
        }
        if (t.sourceSize) continue;
        // 力度字形照它自己的缺省字号（Bravura 16pt）：缩到歌词字号就只剩一半大（破碎 m74 OCR 读出、没量到墨迹框的 f）
        if (t.src && [t.src, ...(t.src.more ?? [])].some((d) => d.type === "dynamics")) continue;
        for (const it of t.data) {
          if (it.font.size > 0) it.font = it.font.scaled(lyrSize / it.font.size);
        }
      }
    }
  }
}

const AUTO_WEDGE_GAP = 8; // 谱表下方最低处到松叶上缘的净空（tenths）

/** 没给 default-y 的松叶（渐强/渐弱）：照五线谱的惯例放在谱表**下方**，起头那一行最低处之下一道空。
 *  缺省的 0 是谱表第一线，松叶的开口正压在线上。只管第一谱表（混排的简谱层在它上方）。 */
function autoPlaceWedges(score: StaffLayout): void {
  for (const part of score.parts) {
    for (const w of part.wedges) {
      if (!w.autoY || w.staff !== 0) continue;
      const sys = score.systems.find((s) => s.contains(w.startTick));
      if (!sys) continue;
      // 只看本声部：`systemLowest` 的坐标相对各声部自己的第一谱表，并上别的声部（长笛下面钢琴左手的低音）松叶就沉到下一行谱上
      w.ypos = systemLowest(score, sys, false, [part]) + AUTO_WEDGE_GAP + w.spread / 2;
    }
  }
}

/** 歌词 y：逐 system、**逐声部逐谱表**取那一谱表往下伸的最低点（`systemLowest`），各 verse 行整齐地排在它下面；
 *  离谱表底线至少 `AUTO_LYRIC_STAFF_GAP`。歌词坐标相对它自己的谱表，一个声部的低音只推它自己的歌词。 */
function autoPlaceLyricsY(score: StaffLayout): void {
  const font = score.defaults.lyricFont;
  const ascent = -font.metrics.ascent;
  const row = Math.max(AUTO_LYRIC_ROW, font.size * 1.1);
  // 源谱版面档照合唱谱的通行排法，歌词贴近谱表（原谱实测字顶离底线约一格）
  const staffGap = score.keepBreaks ? SOURCE_LYRIC_STAFF_GAP : AUTO_LYRIC_STAFF_GAP;
  for (const sys of score.systems) {
    for (const part of score.parts) {
      const byStaff = new Map<number, LyricLayout[]>();
      for (const lrc of systemLyrics(score, sys, [part])) {
        const list = byStaff.get(lrc.staff) ?? [];
        list.push(lrc);
        byStaff.set(lrc.staff, list);
      }
      for (const [staff, all] of byStaff) {
        const lyrics = all.filter((l) => !l.above);
        const above = all.filter((l) => l.above);
        // 本谱表这一行有印在上方的词（两声部共用一行谱、上声部的词在谱表上方）：下方各段从最小的段号起排，
        // 不给分去上方的段号空出行
        const nums = (ls: LyricLayout[]) => [...new Set(ls.map((l) => Math.max(0, (parseInt(l.num, 10) || 1) - 1)))].sort((a, b) => a - b);
        const skip = above.length ? (nums(lyrics)[0] ?? 0) : 0;
        const base = Math.max(systemLowest(score, sys, true, [part], staff) + AUTO_LYRIC_GAP, 40 + staffGap) + ascent;
        // 源谱版面档：原图量了这一段的基线（`<lyric default-y>`，取本行这一段的中位数）就照它，只是不高过让开音符的那条线
        const srcOf = new Map<string, number>();
        if (score.keepBreaks) {
          const byNum = new Map<string, number[]>();
          for (const l of lyrics) if (l.srcY !== null && l.srcY < 0) byNum.set(l.num, [...(byNum.get(l.num) ?? []), l.srcY]);
          for (const [num, ys] of byNum) srcOf.set(num, [...ys].sort((a, b) => a - b)[ys.length >> 1]!);
        }
        for (const lrc of lyrics) {
          const verse = Math.max(0, (parseInt(lrc.num, 10) || 1) - 1) - skip;
          lrc.y = Math.min(-(base + verse * row), srcOf.get(lrc.num) ?? Infinity);
        }
        if (!above.length) continue;
        // 上方各段：段号小的在上，最大的那段贴着谱表最高处（音符、符干、上方的弧）；`lrc.y` 是基线、向上为正
        const st = sys.staves.find((s) => s.part() === part && s.partStaff.subIndex === staff);
        const top = Math.min(st ? st.autoExtent(sys)[0] : 0, -staffGap);
        const order = nums(above);
        const descent = font.metrics.descent;
        for (const lrc of above) {
          const k = order.length - 1 - order.indexOf(Math.max(0, (parseInt(lrc.num, 10) || 1) - 1));
          lrc.y = -top + AUTO_LYRIC_GAP + descent + k * row;
        }
      }
    }
  }
}

/**
 * 带版面坐标的谱：歌词照谱里给的 y 排，但**只许往下让、不许往上提**——某一行里音符低（加线下的音、朝下的符干、
 * 下方的弧）压到首行歌词字顶时，整行歌词一起往下挪到让开为止，净空与自动排版同一个（`AUTO_LYRIC_GAP`）。
 * 出版软件的坐标是按它自己的字体与字号定的，换成本工程的歌词字体后常常贴到音符上（470《出到营外》、260《感恩的泪》）。
 */
function clearLyricsBelowNotes(score: StaffLayout): void {
  const ascent = -score.defaults.lyricFont.metrics.ascent;
  // **逐声部**算：各声部的谱表各自一行，一个声部的低音只该推它自己的歌词（合唱谱分 SATB 几个声部时）
  for (const sys of score.systems) {
    for (const part of score.parts) {
      // 只挪第一谱表的：`systemLowest` 量的是第一谱表，别的谱表的歌词坐标相对它自己的谱表
      // 谱表上方的词（`placement="above"`、正的 default-y）不跟着往下让
      const lyrics = systemLyrics(score, sys, [part]).filter((l) => l.staff === 0 && l.y <= 0);
      if (lyrics.length === 0) continue;
      // 首行歌词字顶（cy 向下为正；lrc.y 是负的，越负越往下）
      let top = Infinity;
      for (const lrc of lyrics) top = Math.min(top, -lrc.y - ascent);
      const need = systemLowest(score, sys, true, [part]) + AUTO_LYRIC_GAP;
      if (top >= need) continue;
      const dy = need - top;
      for (const lrc of lyrics) lrc.y -= dy;
    }
  }
}

/** 这一行的歌词（`parts` 缺省 = 所有声部）。 */
function systemLyrics(score: StaffLayout, sys: Sys, parts: readonly PartLayout[] = score.parts): LyricLayout[] {
  const out: LyricLayout[] = [];
  for (const mif of sys.measures) {
    for (const part of parts) {
      const md = part.measures[mif.index];
      if (md) out.push(...md.lyrics);
    }
  }
  return out;
}

/** 这一行第 `staff` 谱表（缺省第一谱表）往下伸到哪（cy 向下为正，谱表底线 = 40）：符头、朝下符干、下方记号、下方连音数字、下方 slur/tie。
 *  弧取画出来的真实曲线底（`slurEnds`/`tiedEnds` + `arcExtent`，与绘制同一份几何），跨行的弧按本行那一截。
 *  要在 `autoPlaceTuplets` 之后：连音数字的上下在那里才定。 */
function systemLowest(score: StaffLayout, sys: Sys, withWedges = true, parts: readonly PartLayout[] = score.parts, staff = 0): number {
  const four = new Fraction(4);
  const eng = score.options;
  const chordLow = (ch: ChordLayout): number => {
    let low = 0;
    for (const nt of ch.notes) low = Math.max(low, nt.cy() + 6);
    if (!ch.stemUp && ch.noteType.compareTo(four) < 0) low = Math.max(low, ch.tailY(false));
    if (ch.hasNotation(false)) low += 20;
    return low;
  };
  let maxDown = 40; // 谱表底线（cy 向下为正）
  for (const mif of sys.measures) {
    for (const part of parts) {
      const md = part.measures[mif.index];
      if (!md) continue;
      // 倚音也算：低倚音（`{5,,}`）带着加线落到谱表下面，不算的话歌词就排到它身上
      for (const ch of md.chords) {
        if (ch.rest || ch.notes[0]?.staff !== staff) continue;
        maxDown = Math.max(maxDown, chordLow(ch));
      }
    }
  }
  for (const part of parts) {
    // 混排里 slur/tie 画在简谱层上方；这时候谱表记法还没定（formatMixedScore 在后头），按五线谱的画法量，
    // 画在下方的才算数
    const arcs = [
      ...part.slurs.filter((sl) => sl.startNote?.staff === staff).map((sl) => slurEnds(sys, eng, sl, Notation.Normal)),
      ...part.tied.filter((t) => t.startNote?.staff === staff).map((t) => tiedEnds(sys, eng, t, Notation.Normal)),
    ];
    // 弧按声部第一谱表量（`slurTiedPos` 加了 `staffY`），第二谱表起折回本谱表
    const off = staff ? part.measures[sys.firstMeasure]?.staffY(staff) ?? 0 : 0;
    for (const e of arcs) if (e && !e.above) maxDown = Math.max(maxDown, arcExtent(e)[1] - off + 2);
    // 自动放到谱表下方的松叶（`autoPlaceWedges`）：歌词要排在它下面
    if (withWedges) {
      for (const w of part.wedges) {
        if (!w.autoY || w.staff !== staff) continue;
        if (!sys.contains(w.startTick) && !sys.contains(w.endTick)) continue;
        maxDown = Math.max(maxDown, w.ypos + w.spread / 2 + 2);
      }
    }
    const fsScale = eng.musicFont.size / 40;
    for (const t of part.tuplets) {
      if (t.above || !t.startNote || t.startNote.staff !== staff) continue;
      if (!sys.contains(t.startTick) || !sys.contains(t.endTick)) continue;
      const [ly, ry] = t.staffEnds();
      const g0 = Tuplet.makeNumber(t.timeModification.denominator)[0] ?? "";
      const numH = (smuflTop(eng.meta, g0) - smuflBottom(eng.meta, g0)) * fsScale;
      maxDown = Math.max(maxDown, (ly + ry) / 2 + numH / 2 + 2);
    }
  }
  return maxDown;
}

/** 多谱表的谱（合唱 SATB、钢琴）：上一谱表往下伸的（歌词、低音、朝下符干）与本谱表往上伸的（高音、朝上符干）
 *  之间留够净空，缺省 80 只管得了没歌词的谱。只撑大、不缩小。系统之间的距离由装页按包围盒另算（`painter.ts::flowLayout`）。 */
export function autoStaffDistances(score: StaffLayout): void {
  for (const sys of score.systems) {
    let prev: SysStaff | null = null;
    for (const st of sys.staves) {
      if (!st.staffVisible) continue;
      if (prev) {
        const [, bot] = prev.getYBound(sys);
        const [top] = st.getYBound(sys);
        st.minDistance = score.keepBreaks ? skylineGap(prev, st, sys) : -bot - prev.height() + top + AUTO_STAFF_GAP;
        st.srcDistance ??= st.distance;
        st.distance = Math.max(st.distance, st.minDistance);
      }
      prev = st;
    }
  }
}

/**
 * 源谱版面档：写着 `placement="below"` 的力度记号（`autoPlaceNotes` 先一律放到了谱表上方）放回下方。
 * 这一行谱下有歌词：放在歌词行、紧挨这个音的字左边（合唱谱的通行排法，原谱「mp 懷著…」）；没有歌词就放在谱表下方最低处之下。
 * 放上方的话，上一行谱的歌词与这一行的力度挤在两行谱之间，谱表距离白白撑开。
 */
function placeDynamicsBelow(score: StaffLayout): void {
  for (const sys of score.systems) {
    for (const part of score.parts) {
      for (const mif of sys.measures) {
        const md = part.measures[mif.index];
        if (!md) continue;
        for (const t of md.textBlocks) {
          if (!t.autoY || t.src?.placement !== "below") continue;
          if (t.src.type === "words") {
            // 文字记号（「(+ Bass)」）：放在这一谱表下方最低处之下，有歌词就在末行歌词之下
            const eng = score.options;
            const h = tightLineHeights(t, eng.meta, eng.musicFont.size, eng.textLineHeightBySize);
            if (!h.length) continue;
            const lyr = systemLyrics(score, sys, [part]).filter((l) => l.staff === t.staff && l.y < 0 && !l.empty);
            const low = Math.max(systemLowest(score, sys, true, [part], t.staff), ...lyr.map((l) => -l.y + l.font.metrics.descent));
            t.y = -(low + DYNAMIC_BELOW_GAP) - h[0]!;
            continue;
          }
          if (t.src.type !== "dynamics") continue;
          // 同一谱表、这个拍位起最近的那个字（首段）
          const lrc = md.lyrics
            .filter((l) => l.staff === t.staff && !l.empty && l.offset.compareTo(t.offset) >= 0)
            .sort((a, b) => a.offset.compareTo(b.offset) || a.y - b.y)[0];
          if (lrc && lrc.y < 0) {
            // 前一个字（同谱表同段、本行里在它左边最近的）右缘到这个字之间要放得下；放不下就留在谱表上方（谱表距离按轮廓让开）。
            // `x + xOffset` 是字的**左缘**（`LyricLayout.updateWidth` 把居中折进了 xOffset），从前当中心又减半个字宽，力度离字半个字远
            const abs = (l: LyricLayout) => l.measure.xpos() + l.x + l.xOffset;
            const at = abs(lrc);
            const left = at - DYNAMIC_LYRIC_GAP - t.width();
            const prevRight = Math.max(-Infinity, ...systemLyrics(score, sys, [part])
              .filter((l) => l !== lrc && l.staff === lrc.staff && l.num === lrc.num && !l.empty && abs(l) < at)
              .map((l) => abs(l) + l.width));
            if (left < prevRight + DYNAMIC_LYRIC_GAP) continue;
            t.y = lrc.y;
            // 文字块的 x 是相对它自己拍位的偏移（`updateDataXPos` 再加拍位）：字可能落在后面的拍上，按字的位置折回来
            t.x = lrc.x + lrc.xOffset - DYNAMIC_LYRIC_GAP - t.width() - mif.getEntPos(t.offset);
          } else {
            // 不算松叶：力度与松叶同排一行（原谱「mf ＜ f」），算上就摞到松叶下面去了
            t.y = -(systemLowest(score, sys, false, [part], t.staff) + DYNAMIC_BELOW_GAP + DYNAMIC_ASCENT);
          }
        }
      }
    }
  }
}
/**
 * 源谱版面档：照原图位置放的、在谱表下方的力度（`MeasureText.sourceY`）与松叶（原文写了 default-y 的）。
 * 原图上它们不碰歌词，重排后歌词行的高低变了才可能压上去：横向跨过、纵向相交的那几行歌词，挪到它们下面（`SOURCE_MARK_GAP`）。
 * 不碰的照原位不动。纵向坐标：歌词、文字 y 向上为正（基线），松叶 `ypos` 向下为正（中线）。
 */
function settleSourceMarks(score: StaffLayout): void {
  /** 小节内某拍位的横坐标（相对小节）：取落在这一拍上的和弦的符头 x，没有就退回 `getEntPos` */
  const entX = (mif: MeasureLayout, t: Fraction): number => {
    let x = Infinity;
    for (const part of score.parts)
      for (const ch of part.measures[mif.index]?.chords ?? []) if (!ch.grace && !ch.offset.compareTo(t) && ch.notes[0]) x = Math.min(x, ch.notes[0].x);
    return x < Infinity ? x : mif.getEntPos(t);
  };
  for (const sys of score.systems) {
    for (const part of score.parts) {
      const lyr = systemLyrics(score, sys, [part]).filter((l) => !l.empty && l.y < 0);
      if (!lyr.length) continue;
      const ink = lyr.map((l) => {
        const x0 = l.measure.measureInfo.xpos() + l.x + l.xOffset;
        return { staff: l.staff, x0, x1: x0 + l.width, top: l.y + l.font.size * 0.8, bottom: l.y - l.font.metrics.descent };
      });
      /** 与 [x0, x1] × [bottom, top]（向上为正）相交的歌词里最低的字底；没有相交的返回 null */
      const lowestHit = (staff: number, x0: number, x1: number, bottom: number, top: number): number | null => {
        let low: number | null = null;
        for (const k of ink) {
          if (k.staff !== staff || k.x1 <= x0 || k.x0 >= x1 || k.top <= bottom || k.bottom >= top) continue;
          // 挪下去之后可能又碰上更低一行：把同一横向范围里这一行以下的都算上
          low = Math.min(low ?? Infinity, ...ink.filter((q) => q.staff === staff && q.x1 > x0 && q.x0 < x1 && q.top <= k.top).map((q) => q.bottom));
        }
        return low;
      };
      for (const mif of sys.measures) {
        const md = part.measures[mif.index];
        if (!md) continue;
        for (const t of md.textBlocks) {
          if (!t.sourceY || t.y >= 0) continue;
          const size = Math.max(0, ...t.data.map((it) => it.font.size));
          const x0 = mif.xpos() + entX(mif, t.offset) + t.x;
          // Bravura 力度字母的墨迹约在基线下 0.15 em、上 0.45 em（`staffomr/toxml.ts::DYNAMIC_INK`）
          const w = t.width();
          const low = lowestHit(t.staff, x0, x0 + w, t.y - size * 0.15, t.y + size * 0.45);
          if (low === null) continue;
          // 撞上的是同一行（基线差不到半个字号）的字：原谱的力度印在那个字左边（破碎 m33「f 求」），先往左挪到贴着它，
          // 那里放得下（不碰别的字、不出本行左缘）才挪；不行再挪到歌词下面
          const same = ink
            .filter((k) => k.staff === t.staff && k.x1 > x0 && k.x0 < x0 + w && Math.abs(k.bottom + (k.top - k.bottom) * 0.2 - t.y) < size * 0.5)
            .sort((a, b) => a.x0 - b.x0)[0];
          if (same) {
            const nx = same.x0 - DYNAMIC_LYRIC_GAP - w;
            const sysLeft = sys.measures[0]!.xpos() + sys.measures[0]!.dataPos;
            if (nx >= sysLeft && lowestHit(t.staff, nx, nx + w, t.y - size * 0.15, t.y + size * 0.45) === null) {
              t.x += nx - x0;
              continue;
            }
          }
          t.y = low - SOURCE_MARK_GAP - size * 0.45;
        }
      }
      for (const w of part.wedges) {
        if (w.autoY || w.ypos <= 40) continue;
        const mL = w.startMeasure, mR = w.endMeasure;
        if (mL.system !== sys || mR.system !== sys) continue;
        // 拍位的横坐标取那一拍上和弦的实际 x：这时 `getEntPos` 的拍位表还没按铺好的音符更新（量出来左右颠倒，从不判撞，破碎 m81 女低渐弱压字）
        const x0 = mL.xpos() + entX(mL, w.startTick.minus(mL.offset)) + w.dxLeft;
        const x1 = Math.min(mR.xpos() + entX(mR, w.endTick.minus(mR.offset)) + w.dxRight, mR.xpos() + mR.width);
        const low = lowestHit(w.staff, x0, x1, -w.ypos - w.spread / 2, -w.ypos + w.spread / 2);
        if (low !== null) w.ypos = -low + SOURCE_MARK_GAP + w.spread / 2;
      }
    }
  }
}
/** 照原位放的记号让开歌词时，离字底的空（tenths） */
const SOURCE_MARK_GAP = 4;

const DYNAMIC_LYRIC_GAP = 6;  // 力度记号右缘到歌词字左缘
const DYNAMIC_BELOW_GAP = 6;  // 谱表下方最低处到力度记号顶
const DYNAMIC_ASCENT = 14;    // 力度字形基线以上的高（p、f、m 约一格半）

/** 源谱版面档：两行谱按横向轮廓（`SysStaff.skyline`）算不相碰的距离——逐段取上一行伸下去的与本行伸上来的之和，
 *  再留 `AUTO_STAFF_GAP`。上一行的低音与本行的高音错开在不同 x 上时，比整行最低对整行最高（缺省那套）近得多，
 *  原谱正是这么排的（钢琴两行谱实测原谱 61、整行比 106）。 */
function skylineGap(upper: SysStaff, lower: SysStaff, sys: Sys): number {
  const a = upper.skyline(sys);
  const b = lower.skyline(sys);
  let need = 0;
  for (let k = 0; k < a.below.length; k++) need = Math.max(need, a.below[k]! - upper.height() + b.above[k]!);
  return need + AUTO_STAFF_GAP;
}

// 标题/词曲信息：OMR MusicXML 的 <credit> 无 default-x/-y/font-size，且标题只在
// <work-title> 里（未作为 credit）→ 全挤在页首同一位置、无字号区分。此处按页面重排：
// 标题居中大字，作词/作曲逐行靠右小字，堆叠在标题下方。
const AUTO_TITLE_FS = 20;   // pt
const AUTO_CREDIT_FS = 11;  // pt
const AUTO_LYRIC_GAP = 10;   // 音符/符干/弧最低点到首行歌词字顶的净空（tenths）
const AUTO_LYRIC_STAFF_GAP = 20; // 谱表底线到首行歌词字顶至少留的距离（音符都在谱表里时不至于贴着线）
const SOURCE_LYRIC_STAFF_GAP = 10; // 源谱版面档：谱表底线到首行歌词字顶至少留的距离
const AUTO_LYRIC_ROW = 22;   // 相邻 verse 行距的下限（按字号 × 1.1 取大）
const AUTO_DIRECTION_Y = 46; // 速度记号默认高度（谱表上方）
const AUTO_STAFF_GAP = 12;   // 上一谱表最低处到下一谱表最高处的净空
const AUTO_ATTR_GAP = 16;    // 行首小节谱号/调号/拍号右缘到首音符的额外净空

function autoLayoutHeader(score: StaffLayout): void {
  const d = score.defaults;
  const cx = d.pageWidth / 2;
  // credit 字号是 pt（画时除 scaling），纵向累积在 tenths 里，得换算
  const tenths = (pt: number) => pt / score.scaling;
  // 页眉字号：设置面板「页眉」一组给了就用（`style/header.ts`），没给按出厂 20 / 11
  const hf = score.options.headerFonts;
  const titleFs = hf.title?.size ?? AUTO_TITLE_FS;
  const creditFs = hf.credit?.size ?? AUTO_CREDIT_FS;
  const creds: ScoreCredit[] = [];
  let yTop = d.topMargin + 8; // 自上边距向下累积基线（top-down）
  if (score.title) {
    yTop += tenths(titleFs);
    creds.push({
      page: 0, text: score.title, type: "title",
      x: cx, y: d.pageHeight - yTop, justify: LCR.Center, fontSize: titleFs,
    });
    yTop += tenths(titleFs) * 0.4;
  }
  // 标题下依次：副标题 → 题下经文（居中小字）→ 其余 credit（作词/作曲…，**靠右**，右缘对版心右缘），各自按原顺序。
  // 署名靠右与简谱原样档的页眉同一个排法（`layout/jianpu/place/header.ts::placeHeader`，照 500 首）
  const push = (text: string, type: string | null, fs: number, right = false): void => {
    yTop += tenths(fs) * 1.3;
    creds.push({
      page: 0, text, type, x: right ? d.pageWidth - d.rightMargin : cx, y: d.pageHeight - yTop,
      justify: right ? LCR.Right : LCR.Center, fontSize: fs,
    });
  };
  // 标题已按 `score.title` 排了：credit 里的标题那条（带过版面坐标的谱改动后转自动铺排时就有）不再排第二遍
  const norm = (t: string): string => t.replace(/\s+/g, "");
  const rest = score.credits.filter((c) => c.text && !(score.title && (c.type === "title" || norm(c.text) === norm(score.title))));
  for (const c of rest) if (c.type === "subtitle") push(c.text, c.type, hf.subtitle?.size ?? creditFs);
  for (const t of score.scripture) push(t, "scripture", hf.scripture?.size ?? creditFs);
  for (const c of rest) if (c.type !== "subtitle") push(c.text, c.type, creditFs, true);
  score.credits = creds;
}


/** 自动铺排的谱（文本格式转来的、识别出的）：连音的音符全在同一组符杠下、符干同向时，
 *  数字放到符杠那一端、不画方括号（常规制谱做法）。缺省画在符头一侧带括号，
 *  会与同在符头一侧的延音线/圆滑线挤在一起。带版面坐标的 MusicXML 不走这里，仍照 musicpp。 */
function autoPlaceTuplets(score: StaffLayout): void {
  for (const part of score.parts) {
    const groups = part.measures.flatMap((md) => md.beams);
    for (const t of part.tuplets) {
      if (!t.startNote || !t.endNote || t.bracket !== null) continue;
      const chl = t.startChord();
      const chr = t.endChord();
      const g = groups.find((bg) => bg.chords.includes(chl) && bg.chords.includes(chr));
      if (!g || g.doubleDir) continue;
      const span = g.chords.slice(g.chords.indexOf(chl), g.chords.indexOf(chr) + 1);
      if (span.some((c) => !c.rest && c.stemUp !== chl.stemUp)) continue;
      t.above = chl.stemUp;
      t.bracket = false;
    }
  }
}

function layoutAttr(score: StaffLayout): void {
  for (const mif of score.measures) {
    const sys = mif.system;
    const nsys = sys.firstMeasure === mif.index;

    let hasClef = nsys;
    let hasKey = nsys;
    let keyChange = false;
    let timeChange = false;
    let keyWidth = 0;
    let timeWidth = 0;

    for (const st of sys.staves) {
      if (!st.staffVisible) continue;
      const ps = st.partStaff;
      if (ps.keyChange(mif.offset)) {
        if (nsys && mif.index > 0) {
          const prev = score.measures[mif.index - 1];
          const prevStf = prev.system.staves.find((s) => s.partStaff === ps);
          if (prevStf?.staffVisible) keyChange = true;
        } else {
          keyChange = true;
        }
      }
      if (ps.timeChange(mif.offset)) timeChange = true;

      if (hasKey || keyChange) {
        const ks = ps.getKey(mif.offset);
        const w = keyChangeWidthCalc(ks.cancel, ks.fifths);
        if (w > keyWidth) keyWidth = w;
        for (const part of score.parts) {
          const md = part.measures[mif.index];
          if (md) {
            for (const h of md.harmonies) {
              if (fEq(h.offset, new Fraction(0))) mif.keyOffestJP = -20;
            }
          }
        }
      }
      if (timeChange) {
        const ts = ps.getTime(mif.offset);
        const w = timeSigWidthCalc(ts, score.options.meta);
        if (w > timeWidth) timeWidth = w;
      }
    }

    // parser.cpp::layoutAttr 里 `auto xpos = 5` 是 int，累加拍号宽（字形 bbox，带小数）时逐次截断
    let xpos = 5;
    if (hasClef) { mif.clefPos = xpos; xpos += 32; }
    if (hasKey || keyChange) { mif.keyPos = xpos; xpos = Math.trunc(xpos + keyWidth); }
    if (timeChange) { mif.timePos = xpos; xpos = Math.trunc(xpos + timeWidth); }
    if (mif.forward && nsys) { mif.leftBarlinePos = xpos + 20; xpos += 30; }
    mif.dataPos = xpos;
    mif.dataEnd = mif.width;

    if (nsys && mif.index > 0) {
      const prev = score.measures[mif.index - 1];
      const psys = prev.system;
      if (keyChange) {
        psys.keyChangeWidth = keyWidth;
        prev.dataEnd -= keyWidth + 5;
      }
      if (timeChange) {
        psys.timeChangeWidth = timeWidth;
        prev.dataEnd -= timeWidth + 5;
        const last = psys.measures[psys.measures.length - 1];
        if (last) last.width += timeWidth + 5;
      }
    }

    // 宽右小节线（终止线/双线等）占的横向宽度从 dataEnd 扣除，使 ending 括号右端与
    // 反复记号留出间隙（parser.cpp:2828-2848）。
    if (mif.rightBarline !== null) {
      const lws = score.options.lineWidths;
      const dist = score.options.barlineDist;
      let blw = 0;
      switch (mif.rightBarline) {
        case BarGlyph.Final:
          blw = lws.heavyBarline + lws.lightBarline + dist;
          break;
        case BarGlyph.Double:
          blw = lws.lightBarline * 2 + dist;
          break;
        case BarGlyph.HeavyHeavy:
          blw = lws.heavyBarline * 2 + dist;
          break;
        default:
          break;
      }
      mif.dataEnd -= blw;
    }
  }
}

function keyChangeWidthCalc(cancel: number, key: number): number {
  let res = 5;
  if (cancel * key < 0) {
    res += (Math.abs(cancel) + Math.abs(key)) * 10;
  } else {
    res += Math.max(Math.abs(key), Math.abs(cancel)) * 10;
    if (Math.abs(cancel) > 0 && Math.abs(key) > 0 && Math.sign(cancel) !== Math.sign(key)) {
      res += Math.min(Math.abs(key), Math.abs(cancel)) * 10;
    }
  }
  return res;
}

/** parser.cpp::timeChangeWidth：分子、分母各自逐位累加 timeSigN 字形 bbox 宽（TimeSig::width），取大者。 */
function timeSigWidthCalc(ts: TimeSig, meta: MetaData): number {
  if (ts.symbol) return 30;
  const width = (n: number) => {
    let w = 0;
    for (const c of String(n)) {
      const b = meta.getBBoxByName(`timeSig${c}`);
      w += b ? (b.bBoxNE[0] - b.bBoxSW[0]) * 10 : 10;
    }
    return w;
  };
  return Math.max(width(ts.beats), width(ts.beatType));
}

function updateEntPos(score: StaffLayout): void {
  for (let i = 0; i < score.measures.length; i++) {
    const mif = score.measures[i];
    for (const part of score.parts) {
      const md = part.measures[i];
      if (!md) continue;
      for (const ch of md.chords) {
        if (ch.rest && fEq(ch.dur, mif.dur)) continue;
        mif.entPos.set(ch.offset, ch.entX());
      }
    }
  }
}

function updateDataXPos(score: StaffLayout): void {
  score.dataXPlaced = true;
  for (const part of score.parts) {
    for (let i = 0; i < score.measures.length; i++) {
      const mif = score.measures[i];
      const md = part.measures[i];
      if (!md) continue;
      // `<harmony relative-x>`：和弦相对拍位的横向微调（歌本改谱脚本写进 XML 的那种）
      for (const h of md.harmonies) h.x = mif.getEntPos(h.offset) + (xmlPos(h.src)?.relativeX ?? 0);
      for (const t of md.textBlocks) {
        // 右对齐的跳转字（Fine、D.S.、D.C.、To Coda）右缘贴本小节的右小节线（用户定 2026-10-14，018）：
        // 原文的 default-x 是按原排版的小节宽给的，重排后小节宽变了，照它画就探出线外
        if (t.data.length && t.justify === LCR.Right && JUMP_WORD.test(t.data.map((d) => d.text).join(""))) {
          t.x = mif.width - t.width();
          t.justify = LCR.Left;
          continue;
        }
        if (!t.data.length || !t.relative) continue;
        // **写在小节末尾的（`D.S.` / `Fine`）与小节线右对齐**（同简谱 `layout.ts::addDirections`）：
        // 小节末的拍位是最后一个音之后的数据区末端，照它左对齐就从线上探出去。只管自动铺排、
        // 原文没写横坐标的（带版面的谱照原文）
        if (score.autoLayout && fEq(t.offset, mif.dur) && t.justify !== LCR.Center && t.x === 0 && t.src && !xmlPos(t.src)?.relativeX && !xmlPos(t.src)?.defaultX) {
          // 画文字块不按 justify 往左让（Sibelius 那条路是读谱时自己减的宽，`layout.ts::processDirection`），
          // 所以直接给左缘：右缘落在小节线上
          t.x = mif.width - t.width();
          t.justify = LCR.Left;
          continue;
        }
        t.x += mif.getEntPos(t.offset);
      }
    }
  }
}

/** 写在小节末的跳转字 */
const JUMP_WORD = /^\s*(Fine|D\.\s*[CS]\..*|To\s*Coda.*)\s*$/i;

// ---- 系统/分页/谱表间距：读 `<print>` 与 `<staff-details>` 的那三步 ----
// 输入由 `layout.ts` 从 `ScoreDoc` 拼，判据原样。

/** 一个 `<print>`。`systemLayout` / `margins` 为 null 表示元素不在（与「在但没写数」不同）。 */
export interface PrintInput {
  newPage: boolean;
  newSystem: boolean;
  systemLayout: {
    margins: { left: number | null; right: number | null } | null;
    topSystemDistance: number | null;
    systemDistance: number | null;
  } | null;
  /** `<staff-layout>`：`number` 为 1 基谱表号 */
  staffLayouts: { number: number; staffDistance: number | null }[];
}

/** 一个声部的一个小节里，版面那几步要读的东西。 */
export interface MeasureLayoutInput {
  prints: PrintInput[];
  /** `<staff-details>`：`number` 为 1 基谱表号，`printObject` 为属性原文（缺省 null） */
  staffDetails: { number: number; printObject: string | null }[];
}

/** 声部 → 小节 → 版面输入 */
export type LayoutInput = MeasureLayoutInput[][];

/** 分行分页。`autoBreaks`（自动铺排算好的起行小节）给了就只认它与 `new-page`——`new-system` 已被它当优选断点吸收；
 *  带版面的谱逐字认 `<print>`。 */
function buildSystemsAndPages(score: StaffLayout, input: LayoutInput, autoBreaks?: Set<number>): void {
  const newSystem = new Set<number>(autoBreaks ?? []);
  const newPage = new Set<number>();

  for (const pt of input) {
    let mid = 0;
    for (const mea of pt) {
      for (const pr of mea.prints) {
        if (pr.newPage) {
          newPage.add(mid);
          newSystem.add(mid);
        } else if (pr.newSystem && !autoBreaks) {
          newSystem.add(mid);
        }
      }
      mid++;
    }
  }
  for (const i of newSystem) if (i > 0 && !score.measures[i].implicit) score.measures[i].showBarNumber = true;
  for (let i = 0; i < score.measures.length; i++) {
    const mif = score.measures[i];
    const needNewSys = score.systems.length === 0 || newSystem.has(i);
    if (!needNewSys) {
      const sys = score.systems[score.systems.length - 1];
      sys.measures.push(mif);
      mif.system = sys;
    } else {
      const sys = new Sys();
      sys.score = score;
      sys.firstMeasure = i;
      sys.measures.push(mif);
      mif.system = sys;
      sys.index = score.systems.length;
      for (const part of score.parts) {
        for (const ps of part.staves) {
          sys.staves.push(new SysStaff(ps));
        }
      }
      score.systems.push(sys);
    }
  }

  for (const sys of score.systems) {
    const needNewPage = score.pages.length === 0 || newPage.has(sys.firstMeasure);
    if (needNewPage) {
      const pg = new MPage();
      pg.systems.push(sys);
      score.pages.push(pg);
    } else {
      score.pages[score.pages.length - 1].systems.push(sys);
    }
  }
}

/**
 * 空谱表隐藏：MusicXML 用 <attributes><staff-details print-object="no/yes"> 切换某谱表可见性，
 * 状态跨系统延续（loader.cpp::processStaffDetails + updateSystemLayout 的 visPrev）。
 * 在每个 system 的 firstMeasure 处应用累积可见性快照。
 */
function applyStaffVisibility(score: StaffLayout, input: LayoutInput): void {
  // measureIdx → (全局谱表序号 → 可见)
  const changes = new Map<number, Map<number, boolean>>();
  let stfOff = 0;
  let pid = 0;
  for (const pt of input) {
    const part = score.parts[pid++];
    let mid = 0;
    for (const mea of pt) {
      for (const det of mea.staffDetails) {
        const po = det.printObject;
        if (po === null) continue;
        const num = det.number - 1;
        const g = stfOff + num;
        let m = changes.get(mid);
        if (!m) {
          m = new Map();
          changes.set(mid, m);
        }
        m.set(g, po !== "no");
      }
      mid++;
    }
    stfOff += part.staves.length;
  }
  if (changes.size === 0) return;

  const total = stfOff;
  const sysByFirst = new Map<number, Sys>();
  for (const sys of score.systems) sysByFirst.set(sys.firstMeasure, sys);

  const visPrev = new Array<boolean>(total).fill(true);
  for (let mid = 0; mid < score.measures.length; mid++) {
    const ch = changes.get(mid);
    if (ch) for (const [g, v] of ch) visPrev[g] = v;
    const sys = sysByFirst.get(mid);
    if (sys) {
      for (let i = 0; i < sys.staves.length && i < total; i++) {
        sys.staves[i].staffVisible = visPrev[i];
      }
    }
  }
}

function updateLayoutByPrint(score: StaffLayout, input: LayoutInput): void {
  for (const sys of score.systems) {
    let stfOff = 0;
    let pid = 0;
    for (const pt of input) {
      const part = score.parts[pid++];
      const mea = pt[sys.firstMeasure];
      if (!mea) { stfOff += part.staves.length; continue; }
      for (const pr of mea.prints) {
        const sl = pr.systemLayout;
        if (sl) {
          const sm = sl.margins;
          if (sm) {
            sys.leftMargin = sm.left ?? sys.leftMargin;
            sys.rightMargin = sm.right ?? sys.rightMargin;
          }
          const dist = sl.topSystemDistance ?? sl.systemDistance;
          if (dist !== null) sys.distance = dist;
        }
        for (const stfLay of pr.staffLayouts) {
          const num = stfLay.number - 1;
          const dist = stfLay.staffDistance;
          const stfIdx = stfOff + num;
          if (dist !== null && stfIdx < sys.staves.length) {
            sys.staves[stfIdx].distance = dist;
          }
        }
      }
      stfOff += part.staves.length;
    }
  }
  // Default distances
  for (const sys of score.systems) {
    let firstVisible = true;
    for (const st of sys.staves) {
      if (!st.staffVisible) { st.distance = 0; continue; }
      if (firstVisible) { st.distance = 0; firstVisible = false; }
      else if (st.distance === 0) st.distance = 80;
    }
    if (sys.distance === 0) sys.distance = 80;
  }

  // Convert relative system distances to absolute Y positions per page.
  // MusicXML: top-system-distance (first system per page) = absolute from page top margin.
  //           system-distance (subsequent systems) = gap from previous system bottom.
  for (const pg of score.pages) {
    let absY = 0;
    let prevHeight = 0;
    for (let si = 0; si < pg.systems.length; si++) {
      const sys = pg.systems[si];
      if (si === 0) {
        absY = sys.distance; // already absolute
      } else {
        absY = absY + prevHeight + sys.distance;
        sys.distance = absY;
      }
      prevHeight = sys.height();
    }
  }
}

/**
 * 各声部读完之后的收尾：全局 tick、跨小节对象的绝对 tick、简谱符杠、整个版面 pass、声部分组、Sibelius 修正。
 * 与来源无关。
 */
export function finishMixedScore(score: StaffLayout, input: LayoutInput, partGroups: PartGroup[]): void {
  // Staff order
  let ord = 0;
  for (const part of score.parts) for (const st of part.staves) st.order = ord++;

  // Global measure offsets
  let tick = new Fraction(0);
  for (const mif of score.measures) {
    mif.offset = tick;
    tick = tick.plus(mif.dur);
  }

  // 跨小节对象的 startTick/endTick 必须在 mif.offset 赋值后再算：slur/tied 在
  // PartLoader 阶段解析（那时 mif.offset 还是 0），故此处用真实绝对 tick 重算，
  // 否则系统归属判定（drawSlur/drawTied 的 begin/end 比较）全错，slur/tie 会错画到
  // 第一小节。对应 musicpp mxml/loader.cpp::processSlur（在整 part 加载后统一解析）。
  for (const part of score.parts) {
    for (const sl of part.slurs) {
      sl.startTick = sl.startChord().tick();
      sl.endTick = sl.endChord().tick();
    }
    for (const t of part.tied) {
      t.startTick = t.startChord().tick();
      t.endTick = t.endChord().tick();
    }
    // ending 同理：startMeasure/endMeasure 在 PartLoader 阶段就确定，但其绝对 tick
    // 依赖 mif.offset（此处才赋值）。左反复记号 tick = 起始小节 offset，右反复记号
    // tick = 结束小节末端，对齐 musicpp parser.cpp 用 offsets[bl]+mif->offset 配对。
    for (const e of part.endings) {
      e.startTick = e.startMeasure.offset;
      e.endTick = e.endMeasure.endTick();
    }
  }

  // processJpBeam
  for (const part of score.parts) {
    for (const md of part.measures) md.processJpBeam();
  }

  // Layout pass。无内嵌版面坐标（OMR 生成谱）时自动计算小节宽度/折行/音符横向位置。
  const autoLayout = score.autoLayout; // layoutStaff 读谱前已按 hasEmbeddedLayout 定好
  // 源谱版面档的页眉带着原图的位置与字号（`staffomr/toxml.ts::creditsXml`）：照原样排，不重排
  const placedHeader = score.keepBreaks && score.credits.some((c) => c.type === "title") && score.credits.every((c) => c.y > 0);
  if (autoLayout && !placedHeader) autoLayoutHeader(score);
  const autoBreaks = !autoLayout
    ? undefined
    : score.keepBreaks ? sourceBreaks(score, input) : score.hardBreaks ? writtenBreaks(score, input) : autoLayoutWidths(score, input);
  buildSystemsAndPages(score, input, autoBreaks);
  applyStaffVisibility(score, input);
  updateLayoutByPrint(score, input);
  if (autoLayout) autoJustifySystems(score);
  layoutAttr(score);
  if (autoLayout) autoPlaceNotes(score);
  if (autoLayout) autoPlaceTuplets(score);
  if (autoLayout) autoPlaceWedges(score);
  if (autoLayout) autoPlaceLyricsY(score);
  else clearLyricsBelowNotes(score);
  if (score.keepBreaks) placeDynamicsBelow(score);
  if (score.keepBreaks) settleSourceMarks(score);
  if (autoLayout) autoStaffDistances(score);
  updateEntPos(score);
  updateDataXPos(score);

  // Part groups
  score.partGroups = partGroups;

  // Sibelius fixes（parser.cpp:2890-2895，行首调号变更偏移须在 layoutAttr/updateDataXPos 之后）
  if (score.encoder === Encoder.Sibelius) {
    for (const sys of score.systems) sys.fixSibKeyChange();
    for (const part of score.parts) part.fixTieForSib();
  }

}
