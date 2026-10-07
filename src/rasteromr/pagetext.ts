// 位图五线谱的**文字区**：找谱线之前先用文本检测（DBNet，只检测、不认字）把整页的文字行圈出来，
// 后面各路判据据此避开文字，不让字的笔画混进谱线、符头这些识别里。
//
// 为什么要它：密排的中文段落（破碎扫描版曲首页四行序言）每行横笔连成一片，过了「几乎整行有墨」的谱线门槛，
// 四行字里抽出五条等距的「线」凑成一行假谱表——页眉带被截在标题下面，那一「行谱」还占掉一个系统。
// 纯像素判据分不开：左右端之间有墨列的占比（假的 0.60、耶和华是我的牧者首行真谱表 0.64）、
// 线间墨密度（假的 0.28、破碎 p6 一行真谱表 0.27）都挨着。文字框是直接的证据。
//
// 检测结果按**页的内容指纹**缓存（`gen-rastertext.mjs` → `rastertext.json`，回归不起模型）；编辑器在线识别走
// `song.ts` 的 `live.textDet`。两边的位图都是 `rasterizePage` 交出来的那一张、没动过的。
import type { Binary, Rect } from "../omr/types";
import type { RasterUnit, StaffGroup } from "./staffline";

/** 页的内容指纹（尺寸 + FNV-1a，同 `wordKey` 一套）。 */
export function pageTextKey(bin: Binary): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bin.data.length; i++) {
    h ^= bin.data[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `P${bin.w}x${bin.h}-${h.toString(36)}`;
}

/** 送检前的缩放：线距缩到 `DET_SPACE` 像素（歌词字高一格半到两格，缩完十几像素，DBNet 检得最稳）。 */
export function textDetScale(unit: RasterUnit): number {
  return Math.min(1, Math.max(0.25, DET_SPACE / unit.space));
}
const DET_SPACE = 8;

/**
 * 落在文字里的「谱表」：五条线里至少 `TEXT_LINES` 条，各自左右端之间过半落在**横穿这条线**的文字行框里。
 * 只认**一行字高**的框（不过 `TEXT_BOX_MAX` 格）：DBNet 在谱面上常把几段歌词连同中间的谱表、密排的十六分音符整团框成一个大框
 *（宁静 p9、高举主大能、齐来称颂伟大之神，框高 7~20 格），照收就把真谱表当字删了；序言一行字的框不到三格。
 */
export function isTextStaff(g: StaffGroup, boxes: readonly Rect[]): boolean {
  const lineBoxes = boxes.filter((b) => b.h <= g.space * TEXT_BOX_MAX);
  let n = 0;
  for (const l of g.lines) {
    const len = l.right - l.left;
    if (len <= 0) continue;
    const spans = lineBoxes
      .filter((b) => b.y <= l.y && b.y + b.h >= l.y)
      .map((b) => [Math.max(l.left, b.x), Math.min(l.right, b.x + b.w)] as const)
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    let cov = 0;
    let end = l.left;
    for (const [a, b] of spans) {
      if (b <= end) continue;
      cov += b - Math.max(a, end);
      end = b;
    }
    if (cov >= len * TEXT_COVER) n++;
  }
  return n >= TEXT_LINES;
}
const TEXT_COVER = 0.5;
const TEXT_LINES = 3;
const TEXT_BOX_MAX = 3.5;
