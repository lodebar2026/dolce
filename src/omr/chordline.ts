// 和弦文本行：按源图 x 切出记号、落到谱行音符上（文法在 `omrkit/chordgrammar.ts`，三路共用）。
//
// 吉他和弦（C / G/B / Am / Gsus4）印在**谱行音符的上方**，与段落方框（Intro/Verse/Chorus）
// 同处「上一谱行下缘 → 本谱行上缘」这条带里。识别侧先按整行文本形态把和弦行与歌词行分开
// （isAnnotationLine），再由 splitChordTokens 切出逐个记号、placeChords 落位。
//
// 判据一律**不依赖 OCR 大小写正确**（PP-OCR 常把 C 读成 c），也不依赖记号之间有空格
// （整行和弦常被连写成 "C#mF#mBmBm7E"）。
import { blankNonChord, normalizeChord, splitChordTokens } from "../omrkit/chordgrammar";
import type { JpNum, Rect, StaffRow, TextRegion } from "../omrkit/types";

/** 一个待落位的和弦记号：归一后的文本 + 源图起始 x + 源图框。 */
export type ChordCand = { tok: string; x: number; bbox: Rect };

/** 从一行和弦文本里切出记号并换算源图坐标。
 *  `srcX(charIndex)` 把原串字符下标映到源图 x（下标可越界，返回该行右缘）；
 *  `mkBbox(x0,x1)` 由记号首尾 x 造源图框（供识别模式叠加）。
 *  对齐点取记号**起始 x**，与歌词单元同一基准。 */
export function chordCandidates(
  rawText: string, srcX: (charIndex: number) => number, mkBbox: (x0: number, x1: number) => Rect,
): ChordCand[] {
  return splitChordTokens(blankNonChord(rawText), srcX)
    .map(({ tok, index }) => {
      const x0 = srcX(index), x1 = srcX(index + tok.length);
      return { tok: normalizeChord(tok), x: x0, bbox: mkBbox(x0, Math.max(x1, x0 + 1)) };
    })
    // 归一后仍须是合法根音开头（可带前置升降号，`chordTextSegs`/`harmonyXml` 的最低要求），否则下游只能整段原样排字。
    .filter((c) => /^[#b]?[A-G]/.test(c.tok));
}

/** 把一批带源图 x 的和弦落到某谱行的音符上（含拍内偏移）。
 *
 *  与 sectionMark 的落位**刻意不同**：段落总从整小节起、要回退到本小节首音；和弦不回退——
 *  它可落在小节内任意一拍。和弦也**不一定对着音符**：印在两音符之间时按 x 线性插值出
 *  `chordOffset`（本音符时值内的比例，0..1），由 todoc.ts 决定挂音符还是挂增时线。 */
export function placeChords(
  row: StaffRow, cands: ChordCand[], regions: TextRegion[],
): void {
  const nums = row.nums;
  if (!nums.length) return;
  // 比较基准取**左缘**而非中心：和弦记号的左缘习惯对齐所辖音符的左缘，用中心比会给行首和弦
  // 凭空算出 0.35~0.40 的假偏移（音符半宽在密排行里就占相邻间距的近四成）。
  const lefts = nums.map((n) => n.bbox.x);
  const extraY = new Map<JpNum, number[]>();   // 每个 extraChords 项的来源 y（并行编配撞车时取低的那排）
  for (const c of [...cands].sort((a, b) => a.x - b.x)) {
    const x = c.x;
    let i = 0;
    while (i + 1 < lefts.length && lefts[i + 1] <= x) i++;
    let frac = 0;
    if (i + 1 < lefts.length && x > lefts[i]) {
      const gap = lefts[i + 1] - lefts[i];
      if (gap > 1) {
        const t = (x - lefts[i]) / gap;
        if (t >= 0.65) { i += 1; }        // 明显更贴右邻 → 归右邻、正对音符
        else if (t >= 0.35) frac = t;     // 夹在两音符之间 → 挂左音符 + 拍内偏移
      }
    }
    // 同一音符已有和弦：顺延到右邻空位（限一格）。两个和弦挤在同一音符上多半是印刷字距紧，
    // 直接丢掉会静默少一个记号。但**同名**的不顺延——同一拍点不会连着奏两个相同和弦，那只是
    // OCR 把一个记号读了两遍（跨 rec 块边界时常见），顺延会在谱上凭空多一个 G。
    if (nums[i].chord === c.tok) continue;
    // 已有和弦、而本记号又**明明落在本音符时值之内**（frac>0，多半印在增时线上方）：
    // 那是长音里换和弦（「世上所有的民族」第二行 `1 - - 0` 的第三拍上另有一个 C/G），
    // 不是字距挤在一起。顺延给右邻会把它挪后一整拍，故改挂 extraChords + 拍位。
    if (frac > 0 && nums[i].chord !== undefined) {
      const extra = nums[i].extraChords ??= [];
      const ys = extraY.get(nums[i]) ?? [];
      extraY.set(nums[i], ys);
      // 同一拍位上撞车 = 谱面印了**两套并行编配**（「爱是不保留」上排括号里是另一套配法）。
      // 两个都留的话，文本谱那边一条增时线只挂得住一个，还会静默丢掉后来的那个；只留贴着
      // 谱行的下排（bbox 更低的那个）——那才是主编配，上排是备选。
      const clash = extra.findIndex((e) => Math.abs(e.offset - frac) < 0.1);
      if (clash >= 0) {
        if (c.bbox.y > ys[clash]) {
          extra[clash] = { tok: c.tok, offset: frac };
          ys[clash] = c.bbox.y;
          regions.push({ text: c.tok, bbox: c.bbox });
        }
      } else if (!extra.some((e) => e.tok === c.tok)) {
        extra.push({ tok: c.tok, offset: frac });
        ys.push(c.bbox.y);
        regions.push({ text: c.tok, bbox: c.bbox });
      }
      continue;
    }
    if (nums[i].chord !== undefined && i + 1 < nums.length && nums[i + 1].chord === undefined) { i += 1; frac = 0; }
    if (nums[i].chord !== undefined) continue;
    nums[i].chord = c.tok;
    if (frac > 0) nums[i].chordOffset = frac;
    regions.push({ text: c.tok, bbox: c.bbox });
  }
}

