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
import { rright } from "../omrkit/types";
import { probe } from "./probe";

/** 一个待落位的和弦记号：归一后的文本 + 源图起始 x + 源图框。 */
export type ChordCand = { tok: string; x: number; bbox: Rect; /** 块首括号里的（`(C)3`）：可能是与前一块主和弦拆开的备选，见 dropAltChords */ paren?: boolean };

/** 从一行和弦文本里切出记号并换算源图坐标。
 *  `srcX(charIndex)` 把原串字符下标映到源图 x（下标可越界，返回该行右缘）；
 *  `mkBbox(x0,x1)` 由记号首尾 x 造源图框（供识别模式叠加）。
 *  对齐点取记号**起始 x**，与歌词单元同一基准。 */
export function chordCandidates(
  rawText: string, srcX: (charIndex: number) => number, mkBbox: (x0: number, x1: number) => Rect,
): ChordCand[] {
  rawText = trailingSharpMinor(rawText, srcX);
  return splitChordTokens(blankNonChord(blankAltChords(splitFarJump(rawText, srcX, mkBbox(0, 1).h))), srcX)
    .map(({ tok, index }) => {
      const x0 = srcX(index), x1 = srcX(index + tok.length);
      const paren = /^\s*[(（]\s*$/.test(rawText.slice(0, index));
      return { tok: normalizeChord(tok), x: x0, bbox: mkBbox(x0, Math.max(x1, x0 + 1)), ...(paren ? { paren } : {}) };
    })
    // 归一后仍须是合法根音开头（可带前置升降号，`chordTextSegs`/`harmonyXml` 的最低要求），否则下游只能整段原样排字。
    .filter((c) => /^[#b]?[A-G]/.test(c.tok));
}

/** 升号印在小写 m 后面的小调和弦（青年诗歌 77《永远的锡安山》「Fm♯」= F♯m）：读成 `Fm#G` 就切成 `Fm` 与前置升号的 `#G`。
 *  ♯ 紧挨着 m（字距不过根音到 m 的 1.5 倍）、离后面的字远（3 倍以上，或在行末）才算后置，原地换成 `#m`（下标不动）。 */
function trailingSharpMinor(s: string, srcX: (charIndex: number) => number): string {
  // i 指向 m：根音 i-1、♯ i+1、后面的字 i+2（srcX 取各字起点）
  return s.replace(/(?<=[A-G])m[#♯]/g, (m, i: number) => {
    const pitch = srcX(i) - srcX(i - 1), toSharp = srcX(i + 1) - srcX(i);
    const after = i + 2 >= s.length ? Infinity : srcX(i + 2) - srcX(i + 1);
    if (pitch <= 0 || toSharp > pitch * 1.5 || after < pitch * 3) return m;
    probe("chord.trailingSharpMinor");
    return "#m";
  });
}

/** 紧跟在和弦后面、括号里的**备选和弦**（青年诗歌 5《第一声呼求》`C(A)` `G7(E7)` `Am(F#m)`：页眉 `C/A4/4`，括号里是移到 A 调的
 *  另一套）：不抹的话切成两个和弦，备选那个挂到下一个音上。只留主编配（与页眉取 `C/A` 的 C 同一口径），抹成等长空格保住下标。 */
const blankAltChords = (s: string): string =>
  s.replace(/(?<=[A-Za-z0-9#♯♭])[(（]\s*[#♯b♭]?[A-G][^()（）]*[)）]/g, (m) => " ".repeat(m.length));

/** 备选和弦与主和弦**互斥**：检测把 `A(C)` 拆成了两块（青年诗歌 21 `A` | `(C)`），括号那块单看分不出是备选还是独立的括号和弦
 *  （爱是不保留 `(G7)C` 就是后者）。同一行里紧挨在它左边（缝 < 半个字高）已有一个和弦的，这个位置归主和弦，括号的让出。 */
export function dropAltChords(cands: ChordCand[]): ChordCand[] {
  return cands.filter((c) => !c.paren || !cands.some((o) => o !== c && !o.paren &&
    rright(o.bbox) <= c.bbox.x + 2 && c.bbox.x - rright(o.bbox) < c.bbox.h * 1.2 &&
    Math.min(o.bbox.y + o.bbox.h, c.bbox.y + c.bbox.h) > Math.max(o.bbox.y, c.bbox.y)));
}

/** 读成 `D·S·` 的两个字母在源图上隔得远（三个字高以上）：不是跳转记号，是和弦 D 与远处的 segno `·S·`
 *  被 rec 压成了一条（青年诗歌 4《陪我生活》第 2 谱行 `A7 A7 D … ·S·`）。整串当 D.S. 抹掉就丢了 D——
 *  这里只把 D 之后的那截抹成等长空格，D 留给切词。真 `D.S.` 两字母挨着，不受影响。 */
function splitFarJump(s: string, srcX: (charIndex: number) => number, h: number): string {
  if (!(h > 0)) return s;
  return s.replace(/D(\s*[.,·]\s*[CS]\s*[.,·]?)/g, (m, tail: string, at: number) => {
    const k = at + 1 + tail.search(/[CS]/);
    return srcX(k) - srcX(at) > h * 3 ? "D" + " ".repeat(tail.length) : m;
  });
}

/** 把一批带源图 x 的和弦落到某谱行的音符上（含拍内偏移）。
 *
 *  与 sectionMark 的落位**刻意不同**：段落多从整小节起、要回退到本小节首音（弱起进段的回退到休止为止）；和弦不回退——
 *  它可落在小节内任意一拍。和弦也**不一定对着音符**：印在两音符之间时按 x 线性插值出
 *  `chordOffset`（本音符时值内的比例，0..1），由 todoc.ts 决定挂音符还是挂增时线。 */
/** 和弦左缘 `x` 落在本音的第几条增时线上方 → 本音时值内的比例；对不上增时线返回 undefined。 */
function dashBeat(n: JpNum, x: number): number | undefined {
  const rs = n.augmentRects;
  if (!rs || !rs.length || rs.length !== n.augment || n.div || n.dot || x <= n.bbox.x + n.bbox.w) return undefined;
  for (let k = rs.length - 1; k >= 0; k--) {
    const r = rs[k]!;
    // 左缘到横块右四分之一以内才算；再往右是下一个音的和弦往左探出来（277《从前所珍爱》`6- C 5_` 的 C 左缘在横块 95% 处，
    // 《真爱》两处挂增时线的在 59% 与 −40%）
    if (x >= r.x - r.w * 0.5 && x <= r.x + r.w * 0.75) return (1 + k) / (1 + n.augment);
  }
  return undefined;
}

export function placeChords(
  row: StaffRow, cands: ChordCand[], regions: TextRegion[],
): void {
  const nums = row.nums;
  if (!nums.length) return;
  // 比较基准取**左缘**而非中心：和弦记号的左缘习惯对齐所辖音符的左缘，用中心比会给行首和弦
  // 凭空算出 0.35~0.40 的假偏移（音符半宽在密排行里就占相邻间距的近四成）。
  const lefts = nums.map((n) => n.bbox.x);
  const extraY = new Map<JpNum, number[]>();   // 每个 extraChords 项的来源 y（并行编配撞车时取低的那排）
  const sorted = [...cands].sort((a, b) => a.x - b.x);
  const placedX = new Map<JpNum, number>();   // 每个音上主和弦的左缘 x
  for (const [ci, c] of sorted.entries()) {
    const x = c.x;
    let i = 0;
    while (i + 1 < lefts.length && lefts[i + 1] <= x) i++;
    let frac = 0;
    // 印在增时线上方的（青年诗歌 2《真爱》`2 - - 7 5` 第三拍的 D）：按增时线的源图位置定拍，不在两音符之间插值——
    // 后面跟的是减时音时，插值把它推过「贴右邻」的门槛挂到下一个音上。横块与增时线数对得上、本音是四分音才用
    // （一条线一拍，第 k 条在 (1+k)/(1+augment) 处）。
    const dash = dashBeat(nums[i], x);
    if (dash !== undefined) frac = dash;
    else if (i + 1 < lefts.length && x > lefts[i]) {
      const gap = lefts[i + 1] - lefts[i];
      if (gap > 1) {
        const t = (x - lefts[i]) / gap;
        // 两音之间隔着小节线、和弦左缘已到线前 0.3 字号以内：是下一小节的强拍和弦，不是上一小节末音的半拍换和弦。
        // 青年诗歌 12《大好信息》`4 3̲ 2̲|5̣ 4` 的 E7(D7) 左缘在线后（0.63 处）、`3 2|1 -` 的 A(G) 在线前 10px（0.2 字号，0.57 处），
        // 括号备选和弦整组居中印在音上，主和弦左缘就探到了前一个音那边。线内的不动（青年诗歌 5 `5·1̲ 2` 的 G 在 1̲ 上）；
        // 下一小节首音另有自己的和弦也不动（世上所有的民族 `… Dsus4 1̲|D7 5 - - -`，Dsus4 贴着线印在末音上）
        const bar = row.barlineXs.find((bx) => bx > rright(nums[i].bbox) && bx < lefts[i + 1]);
        const nx = sorted[ci + 1]?.x ?? Infinity;
        const nextOwn = i + 2 < lefts.length ? nx < lefts[i + 2] - (lefts[i + 2] - lefts[i + 1]) * 0.35 : nx < Infinity;
        if (t >= 0.65 || (t >= 0.35 && bar !== undefined && x >= bar - nums[i].bbox.h * 0.3 && !nextOwn)) { i += 1; }        // 明显更贴右邻 → 归右邻、正对音符
        else if (t >= 0.35) frac = t;     // 夹在两音符之间 → 挂左音符 + 拍内偏移
      }
    }
    // 同一音符已有和弦：顺延到右邻空位（限一格）。两个和弦挤在同一音符上多半是印刷字距紧，
    // 直接丢掉会静默少一个记号。但**同名**的不顺延——同一拍点不会连着奏两个相同和弦，那只是
    // OCR 把一个记号读了两遍（跨 rec 块边界时常见），顺延会在谱上凭空多一个 G。
    // 隔开一个字号以上的同名和弦是两个记号（16《神圣罗曼史》副歌 `2 - - -` 上的 `D D`），照挂到增时线上
    const prevX = placedX.get(nums[i]);
    if (nums[i].chord === c.tok && !(prevX !== undefined && x - prevX > nums[i].bbox.h && nums[i].augment > 0)) continue;
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
    // 长音上方挤着几个和弦（青年诗歌 16《神圣罗曼史》副歌 `5 - - -` 上印着 `G D Em`、`3 - - -` 上 `Em D C`、`2 - - -` 上 `D D`）：
    // 没越过下一个音的，依次挂到本音的增时线上，不顺延给下一个音（那就推到下一小节了）
    const n0 = nums[i];
    if (n0.chord !== undefined && n0.augment > 0 && !n0.div && !n0.dot && x > n0.bbox.x && (i + 1 >= nums.length || x < lefts[i + 1]!)) {
      const extra = n0.extraChords ??= [];
      if (extra.length < n0.augment) {
        probe("chord.stackedOnSustain");
        extra.push({ tok: c.tok, offset: (1 + extra.length) / (1 + n0.augment) });
        regions.push({ text: c.tok, bbox: c.bbox });
      }
      continue;
    }
    if (nums[i].chord !== undefined && i + 1 < nums.length && nums[i + 1].chord === undefined) { i += 1; frac = 0; }
    if (nums[i].chord !== undefined) continue;
    nums[i].chord = c.tok;
    placedX.set(nums[i], x);
    if (frac > 0) nums[i].chordOffset = frac;
    regions.push({ text: c.tok, bbox: c.bbox });
  }
}

