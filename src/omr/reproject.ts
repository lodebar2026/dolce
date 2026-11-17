// 识别核对视图**随编辑重画**：把当前模型（代码区原文读出来的、可能改过的）投回原识别结果的源图坐标上。
//
// 识别框（`RecognizedScore.rows[].nums`）与模型元素一一对应靠 `editor/omrctl.ts::idMapOf`（按随编辑迁移的原文区间认）。
// 这里不改框序——命中层的 `data-i` 仍是原来的框序号，点选、试听高亮照旧——只换每个框里**显示**的东西：
// - 对得上元素的框：唱名、八度、升降号、减时线、附点、增时线、延长号换成当前值；与原识别不同的标 `edited`（叠加层标蓝）。
// - 对不上元素的框（音删了）：标 `deleted`（叠加层划掉、变灰）。
// - 模型里有、框里没有的元素（新插的音）：按同一声部里前后两个有框的音插值定位，另列 `inserted`（叠加层标蓝虚框，命中层带 `data-id`）。
// - 歌词：当前词与原识别不同的，在原位另盖一层新字（`lyricFixes`）。
// - 和弦：源图上的每个和弦框按原识别对回「第几个框的哪个落点」（`chordSlots`：音符本身 / 第几条增时线），当前原文里改了、删了的另记（`chordFixes`）；
//   源图上没有框的（核对时新加的）按宿主音的框插值出位置另列（`chordAdds`，命中层带 `data-id`）。

import type { Chord, ElementId, Harmony, ScoreDoc } from "../model/doc";
import { harmonyText } from "../model/jianpu";
import type { JpNum, RecognizedScore, Rect } from "./types";
import { RHYTHM_DIGIT } from "./types";
import { chordPlacesOf, type ChordPlace } from "./todoc";

export type NumState = "edited" | "deleted";

/** 显示用的框：原框加一个状态。 */
export type ShownNum = JpNum & { state?: NumState };

export interface Reprojected {
  /** 框序不变的一份识别结果（`nums` 换成显示值） */
  score: RecognizedScore;
  /** 新插的音：元素 id 与插值出来的框 */
  inserted: { id: ElementId; num: ShownNum; row: number }[];
  /** 改过的歌词：第几个框（原框序）、第几段、现在的字 */
  lyricFixes: { i: number; verse: number; text: string }[];
  /** 改过 / 删掉的和弦：`chordRegions` 里第几个框、现在的字（删掉了为 null） */
  chordFixes: { k: number; text: string | null }[];
  /** 源图上没有框的和弦（核对时新加的）：挂在哪个音（元素 id）的哪个落点、字、插值出来的框（宿主音上方） */
  chordAdds: { id: ElementId; place: ChordPlace; text: string; bbox: Rect }[];
}

/** 一个音上按原文顺序的和弦及其落点：音符本身的在前，增时线上的（长音中途换的）按增时线顺序在后。
 *  可视化编辑数第几个和弦名按这个序（`App._recognizeElOf`），再按落点对回源图的框。 */
export function harmonyPlacesOf(ch: Chord): { harmony: Harmony; place: ChordPlace }[] {
  return [
    ...(ch.harmony ? [{ harmony: ch.harmony, place: "h" as ChordPlace }] : []),
    ...(ch.sustains ?? []).flatMap((s, k) => (s.harmony ? [{ harmony: s.harmony, place: `s${k}` as ChordPlace }] : [])),
  ];
}

function locateChord(doc: ScoreDoc, id: ElementId): Chord | undefined {
  for (const part of doc.songs[0]?.parts ?? []) for (const m of part.measures) for (const el of m.elements) if (el.kind === "chord" && el.id === id) return el;
  return undefined;
}

/** 落点上现在的和弦（没有为 undefined）。 */
function harmonyAt(ch: Chord, place: ChordPlace): Harmony | undefined {
  if (place === "h") return ch.harmony;
  const k = Number(place.slice(1));
  return place[0] === "s" ? ch.sustains?.[k]?.harmony : ch.laterHarmonies?.[k];
}

/**
 * 源图上的和弦框（`chordRegions`）各是哪个音（框序 `i`）的哪个落点（`place`，`todoc.ts::chordPlacesOf`）；对不上为 null。
 * 识别时和弦挂到音上（`chordline.ts::placeChords`）没记框，这里按字相同、横向最近、在那一行谱上方认回来，一对一。
 */
export function chordSlots(rec: RecognizedScore): ({ i: number; place: ChordPlace } | null)[] {
  const flat = rec.rows.flatMap((row, ri) => row.nums.map((n) => ({ n, ri })));
  const used = new Set<string>();
  let places: ChordPlace[][] | undefined;
  return (rec.chordRegions ?? []).map((r) => {
    let best: { i: number; slot: number } | null = null;
    let bestD = Infinity;
    flat.forEach(({ n, ri }, i) => {
      const toks = n.chord === undefined ? [] : [n.chord, ...(n.extraChords ?? []).map((e) => e.tok)];
      toks.forEach((tok, slot) => {
        if (tok !== r.text || used.has(`${i}:${slot}`)) return;
        const row = rec.rows[ri]!;
        // 横向距离 + 离这一行谱顶的竖向距离（和弦印在所属谱行上方，竖向错一行就远了）
        const d = Math.abs(n.bbox.x - r.bbox.x) + Math.abs(r.bbox.y + r.bbox.h - row.topY) * 2;
        if (d < bestD) {
          bestD = d;
          best = { i, slot };
        }
      });
    });
    if (!best) return null;
    const { i, slot } = best as { i: number; slot: number };
    used.add(`${i}:${slot}`);
    places ??= chordPlacesOf(rec);
    const place = places[i]?.[slot];
    return place === undefined ? null : { i, place };
  });
}

const DIV_OF: Record<string, number> = { eighth: 1, "16th": 2, "32nd": 3, "64th": 4 };

/** 一个和弦在简谱叠加里该怎么画（只取叠加画得出的那几样）。 */
function numOf(ch: Chord, base: JpNum): ShownNum {
  const n = ch.notes[0];
  const deg = n?.degree;
  const digit = ch.rest ? 0 : ch.rhythm ? RHYTHM_DIGIT : deg?.number ?? base.digit;
  const out: ShownNum = {
    ...base,
    digit,
    octave: ch.rest ? 0 : deg?.octaveShift ?? 0,
    div: DIV_OF[ch.duration.type ?? ""] ?? 0,
    dot: ch.duration.dots,
    augment: ch.sustains?.length ?? 0,
    fermata: !!ch.notations?.fermata,
  };
  const acc = deg?.accidental;
  if (acc === "sharp" || acc === "flat" || acc === "natural") out.accidental = acc;
  else delete out.accidental;
  // 增时线条数变了，原来按源图位置画的横块对不上了，改按固定间距画
  if (out.augment !== base.augment) delete out.augmentRects;
  return out;
}

function same(a: JpNum, b: JpNum): boolean {
  return a.digit === b.digit && a.octave === b.octave && a.div === b.div && a.dot === b.dot && a.augment === b.augment &&
    (a.accidental ?? null) === (b.accidental ?? null) && !!a.fermata === !!b.fermata;
}

/**
 * 当前模型 → 显示用的识别结果。`toI` 是元素 id → 原框序（`idMapOf`）。
 * 只投第一首（识别结果就一首）；元素按声部、小节、元素顺序走，新插的音挂在它前面那个有框的音之后。
 */
export function reprojectRecognized(rec: RecognizedScore, doc: ScoreDoc, toI: ReadonlyMap<ElementId, number>): Reprojected {
  const flat: { ri: number; k: number }[] = [];
  rec.rows.forEach((row, ri) => row.nums.forEach((_, k) => flat.push({ ri, k })));
  const rows = rec.rows.map((row) => ({ ...row, nums: row.nums.map((n) => ({ ...n }) as ShownNum) }));
  const seen = new Set<number>();
  const inserted: Reprojected["inserted"] = [];
  const lyricFixes: Reprojected["lyricFixes"] = [];
  const chordAt = new Map<number, Chord>();
  for (const part of doc.songs[0]?.parts ?? []) {
    // 本声部按顺序的「有框的音」与「没框的音」：没框的插在前后两个有框的音之间
    const seq: { ch: Chord; i: number | undefined }[] = [];
    for (const m of part.measures) {
      for (const el of m.elements) {
        if (el.kind !== "chord" || el.grace) continue;
        seq.push({ ch: el, i: toI.get(el.id) });
      }
    }
    for (const [s, { ch, i }] of seq.entries()) {
      if (i !== undefined) {
        const at = flat[i];
        if (!at) continue;
        seen.add(i);
        chordAt.set(i, ch);
        const base = rec.rows[at.ri]!.nums[at.k]!;
        const shown = numOf(ch, base);
        if (!same(shown, base)) shown.state = "edited";
        rows[at.ri]!.nums[at.k] = shown;
        // 歌词：按段号对原框里的那一段
        for (const ly of ch.lyrics ?? []) {
          const v = ly.number - 1;
          const was = base.lyrics?.[v] ?? "";
          if (ly.text && ly.text !== was) lyricFixes.push({ i, verse: v, text: ly.text });
        }
        continue;
      }
      // 新插的音：前一个有框的音之后、后一个有框的音之前（同一行时取中点；跨行了就贴着前一个音往右挪一个音宽）
      const prev = seq.slice(0, s).reverse().find((x) => x.i !== undefined);
      const next = seq.slice(s + 1).find((x) => x.i !== undefined);
      const pa = prev ? flat[prev.i!] : undefined;
      const na = next ? flat[next.i!] : undefined;
      const pb = pa ? rec.rows[pa.ri]!.nums[pa.k]!.bbox : undefined;
      const nb = na ? rec.rows[na.ri]!.nums[na.k]!.bbox : undefined;
      const ref = pb ?? nb;
      if (!ref) continue;
      // 同一位置连插几个音：按已插的个数往右错开
      const already = inserted.filter((x) => x.row === (pa?.ri ?? na!.ri) && Math.abs(x.num.bbox.x - ref.x) < ref.w * 6).length;
      let x: number;
      if (pb && nb && pa!.ri === na!.ri) x = (pb.x + pb.w + nb.x) / 2 - ref.w / 2 + already * ref.w * 0.6;
      else if (pb) x = pb.x + pb.w * 1.6 + already * ref.w * 1.2;
      else x = nb!.x - nb!.w * 1.6 - already * ref.w * 1.2;
      const box: Rect = { x, y: ref.y, w: ref.w, h: ref.h };
      const blank: JpNum = { digit: 0, bbox: box, dot: 0, octave: 0, div: 0, augment: 0 };
      inserted.push({ id: ch.id, num: { ...numOf(ch, blank), bbox: box }, row: pa?.ri ?? na!.ri });
    }
  }
  flat.forEach(({ ri, k }, i) => {
    if (!seen.has(i)) rows[ri]!.nums[k] = { ...rows[ri]!.nums[k]!, state: "deleted" };
  });
  const chordFixes: Reprojected["chordFixes"] = [];
  const covered = new Set<string>();
  chordSlots(rec).forEach((at, k) => {
    if (!at) return;
    covered.add(`${at.i}:${at.place}`);
    const ch = chordAt.get(at.i);
    const h = ch ? harmonyAt(ch, at.place) : undefined;
    const text = h ? h.text ?? harmonyText(h) : null;
    if (text !== rec.chordRegions![k]!.text) chordFixes.push({ k, text });
  });
  // 新加的和弦：框高取源图和弦框的中位数（没有就按音高的八成），落在宿主那行谱顶上方；
  // 横向：音符本身的贴音头，增时线上的贴那条增时线（源图有它的横块就用，没有按两个音宽一格估）
  const hs = (rec.chordRegions ?? []).map((r) => r.bbox.h).sort((a, b) => a - b);
  const chordAdds: Reprojected["chordAdds"] = [];
  const hosts: { ch: Chord; i?: number; num: JpNum; ri: number }[] = [
    ...[...chordAt].map(([i, ch]) => ({ ch, i, num: rec.rows[flat[i]!.ri]!.nums[flat[i]!.k]!, ri: flat[i]!.ri })),
    ...inserted.flatMap((x) => {
      const ch = locateChord(doc, x.id);
      return ch ? [{ ch, num: x.num as JpNum, ri: x.row }] : [];
    }),
  ];
  for (const { ch, i, num, ri } of hosts) {
    for (const { harmony, place } of harmonyPlacesOf(ch)) {
      if (i !== undefined && covered.has(`${i}:${place}`)) continue;
      const text = harmony.text ?? harmonyText(harmony);
      const h = hs.length ? hs[hs.length >> 1]! : num.bbox.h * 0.8;
      const k = place === "h" ? -1 : Number(place.slice(1));
      const x = k < 0 ? num.bbox.x : num.augmentRects?.[k]?.x ?? num.bbox.x + (k + 1) * num.bbox.w * 2;
      const y = Math.min(rec.rows[ri]!.topY, num.bbox.y) - h * 1.2;
      chordAdds.push({ id: ch.id, place, text, bbox: { x, y, w: Math.max(h * 0.62 * [...text].length, h * 0.62), h } });
    }
  }
  return { score: { ...rec, rows }, inserted, lyricFixes, chordFixes, chordAdds };
}
