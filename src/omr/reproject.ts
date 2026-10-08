// 识别核对视图**随编辑重画**：把当前模型（代码区原文读出来的、可能改过的）投回原识别结果的源图坐标上。
//
// 识别框（`RecognizedScore.rows[].nums`）与模型元素一一对应靠 `editor/omrctl.ts::idMapOf`（按随编辑迁移的原文区间认）。
// 这里不改框序——命中层的 `data-i` 仍是原来的框序号，点选、试听高亮照旧——只换每个框里**显示**的东西：
// - 对得上元素的框：唱名、八度、升降号、减时线、附点、增时线、延长号换成当前值；与原识别不同的标 `edited`（叠加层标蓝）。
// - 对不上元素的框（音删了）：标 `deleted`（叠加层划掉、变灰）。
// - 模型里有、框里没有的元素（新插的音）：按同一声部里前后两个有框的音插值定位，另列 `inserted`（叠加层标蓝虚框，命中层带 `data-id`）。
// - 歌词：当前词与原识别不同的，在原位另盖一层新字（`lyricFixes`）。

import type { Chord, ElementId, ScoreDoc } from "../model/doc";
import type { JpNum, RecognizedScore, Rect } from "../omrkit/types";
import { RHYTHM_DIGIT } from "../omrkit/types";

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
  return { score: { ...rec, rows }, inserted, lyricFixes };
}
