// Node CLI 侧的简谱 OMR 入口：图片字节 → 123 / 文本谱，**全程不起浏览器**。
// 由 `npm run build:cli` 打成 dist-cli/omr.js，供 scripts/omr-cli.mjs 与 OMR 回归脚本 import。
//
// 与 cli/index.ts 的分工：那个是**矢量 PDF 版面**那一摊（vector/inventory/pdflayout），
// 这个是**位图简谱识别**这一条（decode → jianpu → emit）。PDF 输入不走这里。
import { installNodeDecoder } from "../omr/decode.node";
import { setOmrRuntime } from "../omr/runtime";
import { nodeRuntime, threadInfo } from "../omr/runtime.node";
import { recognizeMusicppDetailed } from "../omr/recognize";
import { OMR_EMITTERS, DEFAULT_OMR_FORMAT, isOmrFormat, omrEmitter, type OmrFormat, type EmittedScore } from "../omr/emit";
import { omrProfile, omrProfileReset, paddleOcrBackend } from "../omr/paddleocr";

setOmrRuntime(nodeRuntime);
installNodeDecoder();

export { OMR_EMITTERS, DEFAULT_OMR_FORMAT, isOmrFormat, omrEmitter, omrProfile, omrProfileReset, threadInfo };
// 整页文字检测（位图五线谱的文字区缓存 `gen-rastertext.mjs` 在 Node 里直接跑 DBNet）
export { paddleOcrBackend };
export type { OmrFormat, EmittedScore };
export { recognizeMusicppDetailed };
// 换解码器用（默认 sharp；要接别的解码库从这里换）。
export { setImageDecoder, decodeToBinary } from "../omr/decode";
export type { ImageDecoder, RgbaImage } from "../omr/decode";
export { recognizedToDoc } from "../omr/todoc";
export { recognizedBeatIssues } from "../omr/beats";
export type { RecognizedBeatIssue } from "../omr/beats";
export { metaFrom123, metaFromPu } from "../omr/meta";
export type { RecognizedScore, Binary, LyricCheck, LyricCheckItem } from "../omr/types";
export { parseRefLyrics, formatLyricCheckItem } from "../omr/reflyrics";

/** 歌词文件字节 → 文本。歌本配套的歌词编码混杂：带 BOM 的 UTF-16LE/UTF-8，否则先按 UTF-8 严格解码、
 *  解不了退 GBK（老 .txt / .lrc 多是 GBK）。 */
export function decodeLyricsBytes(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8").decode(b.subarray(3));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return new TextDecoder("gbk").decode(b);
  }
}

export interface RecognizeResult {
  /** 输出原文（123、.jpwabc、ABC 或文本谱原文）。 */
  text: string;
  /** 产物按哪种源格式打开：`123` / `jpwabc` / `abc` / `pu`（文本谱）。 */
  kind: EmittedScore["kind"];
  format: OmrFormat;
  /** 识别中间产物，回归脚本要拿它算指标。 */
  detail: Awaited<ReturnType<typeof recognizeMusicppDetailed>>;
}

/** 图片字节 → 指定格式的谱面原文。format 默认诗歌本文本谱之外的注册表首项，见 OMR_EMITTERS。
 *  `lyrics`：同一首诗歌的歌词文本（已解码的字符串），给了就词谱互证——形近字按歌词选字、补漏字，
 *  其余不一致只报告，见 `detail.score.lyricCheck`（逐条可读写法用 `formatLyricCheckItem`）。 */
export async function recognizeImage(
  bytes: Uint8Array,
  opts: { mime?: string; format?: OmrFormat; lyrics?: string } = {},
): Promise<RecognizeResult> {
  const format = opts.format && isOmrFormat(opts.format) ? opts.format : DEFAULT_OMR_FORMAT;
  const detail = await recognizeMusicppDetailed(bytes, opts.mime, { refLyrics: opts.lyrics });
  const emitted = omrEmitter(format).emit(detail.score);
  return { text: emitted.text, kind: emitted.kind, format, detail };
}
