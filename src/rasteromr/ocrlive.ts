// 位图五线谱的**在线 OCR**：把识别切出来的几种条（和弦带、歌词条、声部标签条、简谱行）送 PP-OCR，结果整理成识别吃的那几张表
// （`recognizeRasterPage` 的 `harmonyOcr` / `lyricOcr` / `labelOcr` / `jianpuOcr`，按条的内容指纹寻址）。
//
// 编辑器里在线识别用它；私有仓库生成离线缓存的脚本（`gen-raster*.mjs`）也调这一份——**两边必须是同一个实现**：
// 条怎么垫边、送哪种接口、结果怎么挑，差一点指纹相同而内容不同，读数就会两样（那几个脚本里都记着这样踩过的坑）。
// 只在浏览器里跑（PP-OCR 走 onnxruntime-web）。

import type { OcrBackend } from "../omrkit/ocr";
import type { Binary, Rect } from "../omrkit/types";
import { recognizeJianpu } from "../omr/jianpu";
import { harmonyKey, type HarmonyStrip } from "./harmony";
import { stripKey, type LyricStrip, type OcrChar } from "./lyric";
import { labelKey, normalizeLabel, type LabelStrip } from "./stafflabel";
import { jianpuKey, type JianpuStrip } from "./jianpuband";
import { timeKey, type TimeStrip } from "./timesig";
import { keepWordLine, spaceWordText, wordKey, type WordStrip } from "./words";
import { keepHeaderLine, type WordLine } from "../omrkit/headertext";
import type { JianpuRow } from "./jianpufuse";
import { surfaceFromGray, surfaceFromInk, type Surface } from "../omrkit/surface";

/** 条子按批送 rec（整条带字位），每批 `BATCH` 条；`key` 给结果寻址，`surface` 造送检的图。 */
async function recStripsPos<S>(ocr: OcrBackend, strips: readonly S[], key: (s: S) => string, surface: (s: S) => Surface): Promise<Map<string, OcrChar[]>> {
  const out = new Map<string, OcrChar[]>();
  if (!ocr.recognizeTextsPos || strips.length === 0) return out;
  const BATCH = 24;
  for (let i = 0; i < strips.length; i += BATCH) {
    const chunk = strips.slice(i, i + BATCH);
    const got = await ocr.recognizeTextsPos(chunk.map(surface));
    got.forEach((chars, k) => out.set(key(chunk[k]!), chars.map((c) => ({ ch: c.ch, xFrac: c.xFrac }))));
  }
  return out;
}

/** 和弦带：整条送 rec（带字位），左右各垫 6 白——短串（`C`、`F`）贴边会被当成半个字。 */
export async function ocrHarmonyStrips(ocr: OcrBackend, strips: readonly HarmonyStrip[]): Promise<Map<string, OcrChar[]>> {
  return recStripsPos(ocr, strips, harmonyKey, (s) => surfaceFromInk(s.w, s.h, s.data, 6));
}

/** 歌词条：整条送 rec（序列模型靠上下文救单字），不垫边；去过网的页送灰度（细笔画在二值图上被吃了）。 */
export async function ocrLyricStrips(ocr: OcrBackend, strips: readonly LyricStrip[]): Promise<Map<string, OcrChar[]>> {
  return recStripsPos(ocr, strips, stripKey, (s) => (s.gray ? surfaceFromGray(s.w, s.h, s.gray) : surfaceFromInk(s.w, s.h, s.data, 0)));
}

/**
 * 声部标签：定位交给 DBNet（带里还压着上一行谱的歌词、弧、力度，几何闸分不开），逐框 rec；
 * 框右边孤立的窄数字（`Soprano 1` 的分部号，词距宽时进不了框）另交 `recognizeDigits` 捡回来。
 * 取最靠近谱行（带下沿）的那一行、认得出声部名的才存。
 */
export async function ocrLabelStrips(ocr: OcrBackend, strips: readonly LabelStrip[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ocr.recognizeRegion) return out;
  for (const it of strips) {
    const bin: Binary = { w: it.w, h: it.h, data: it.data };
    let lines: { text: string; bbox: { x: number; y: number; w: number; h: number } }[] = [];
    try {
      lines = await ocr.recognizeRegion(bin, { x: 0, y: 0, w: it.w, h: it.h });
    } catch {
      lines = [];
    }
    const digitOf = async (bb: { x: number; y: number; w: number; h: number }): Promise<string> => {
      const x0 = Math.round(bb.x + bb.w);
      const xEnd = Math.min(it.w, Math.round(x0 + bb.h * 3));
      const yA = Math.max(0, Math.round(bb.y));
      const yB = Math.min(it.h, Math.round(bb.y + bb.h));
      const col: number[] = [];
      for (let x = x0; x < xEnd; x++) {
        let ink = 0;
        for (let y = yA; y < yB; y++) if (bin.data[y * it.w + x]) ink++;
        col.push(ink);
      }
      const a = col.findIndex((v) => v > 0);
      if (a < 0) return "";
      let b = a;
      while (b + 1 < col.length && (col[b + 1] || col[b + 2])) b++;
      const w = b - a + 1;
      if (w < bb.h * 0.1 || w > bb.h * 0.8) return ""; // 不像一个数字
      // 还要够高：框右边常跟着逗号、连音点、力度的残笔
      let tall = 0;
      for (let x = a; x <= b; x++) tall = Math.max(tall, col[x]!);
      if (tall < (yB - yA) * 0.4) return "";
      try {
        const [d] = await ocr.recognizeDigits(bin, [{ x: x0 + a - 1, y: yA, w: w + 2, h: yB - yA }]);
        return d !== undefined && d >= 0 && d <= 9 ? String(d) : "";
      } catch {
        return "";
      }
    };
    const withNum: { text: string; y: number; x: number }[] = [];
    for (const l of lines) {
      const d = /[0-9]\s*$/.test(l.text) ? "" : await digitOf(l.bbox);
      withNum.push({ text: l.text + d, y: l.bbox.y + l.bbox.h / 2, x: l.bbox.x });
    }
    const pick = withNum.filter((l) => normalizeLabel(l.text)).sort((a, b) => b.y - a.y || a.x - b.x)[0];
    if (pick) out.set(labelKey(it), pick.text);
  }
  return out;
}

/** 文字指示带：DBNet 找行、逐行 rec，只留像文字指示的行（`keepWordLine`），词界按列投影补空格。空带也回一条空表。 */
export function ocrWordStrips(ocr: OcrBackend, strips: readonly WordStrip[]): Promise<Map<string, WordLine[]>> {
  return ocrLineStrips(ocr, strips, keepWordLine);
}

/** 页眉带：同文字指示带，但中文行也留（`keepHeaderLine`）。 */
export function ocrHeaderStrips(ocr: OcrBackend, strips: readonly WordStrip[]): Promise<Map<string, WordLine[]>> {
  return ocrLineStrips(ocr, strips, keepHeaderLine);
}

/** 文字带（文字指示 / 页眉）：DBNet 找行、逐行 rec，留 `keep` 认的行，词界按列投影补空格。 */
async function ocrLineStrips(ocr: OcrBackend, strips: readonly WordStrip[], keep: (text: string) => boolean): Promise<Map<string, WordLine[]>> {
  const out = new Map<string, WordLine[]>();
  if (!ocr.recognizeRegion) return out;
  for (const it of strips) {
    let lines: Awaited<ReturnType<NonNullable<OcrBackend["recognizeRegion"]>>> = [];
    try {
      lines = await ocr.recognizeRegion({ w: it.w, h: it.h, data: it.data }, { x: 0, y: 0, w: it.w, h: it.h });
    } catch {
      lines = [];
    }
    out.set(wordKey(it), lines.filter((l) => keep(l.text)).map((l) => {
      const box = { x: Math.round(l.bbox.x), y: Math.round(l.bbox.y), w: Math.round(l.bbox.w), h: Math.round(l.bbox.h) };
      return { t: spaceWordText(l.text, l.chars, it, box), ...box };
    }));
  }
  return out;
}

/** 整页文字检测（只检测、不认字）：文字区见 `pagetext.ts`。框取整、检不了（没有 det 模型）回空。 */
export async function detectPageTexts(ocr: OcrBackend, bin: Binary, scale: number): Promise<Rect[]> {
  if (!ocr.detectTexts) return [];
  try {
    return (await ocr.detectTexts(bin, { x: 0, y: 0, w: bin.w, h: bin.h }, { scale })).map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }));
  } catch {
    return [];
  }
}

/** 简线混排谱的简谱行：走简谱那条路本身（`recognizeJianpu`），四周垫 40 白（数字、高音点贴边时行切分吃亏），只留互证用得上的几样。 */
export async function ocrJianpuStrips(ocr: OcrBackend, strips: readonly JianpuStrip[]): Promise<Map<string, JianpuRow[]>> {
  const out = new Map<string, JianpuRow[]>();
  const PAD = 40;
  for (const it of strips) {
    const w = it.w + PAD * 2;
    const h = it.h + PAD * 2;
    const data = new Uint8Array(w * h);
    for (let y = 0; y < it.h; y++) for (let x = 0; x < it.w; x++) data[(y + PAD) * w + x + PAD] = it.data[y * it.w + x]!;
    try {
      const score = await recognizeJianpu({ w, h, data }, ocr);
      out.set(jianpuKey(it), score.rows.map((r) => ({
        bars: r.barlineXs.map((x) => x - PAD),
        nums: r.nums.map((n) => ({
          d: n.digit,
          x: Math.round(n.bbox.x + n.bbox.w / 2 - PAD),
          oct: n.octave,
          div: n.div,
          dot: n.dot,
          aug: n.augment,
          ...(n.slurStart ? { ss: n.slurStart } : {}),
          ...(n.slurStop ? { se: n.slurStop } : {}),
          ...(n.tieStart ? { ts: 1 } : {}),
          ...(n.tieStop ? { te: 1 } : {}),
        })),
      })));
    } catch {
      // 认不出就不互证，五线谱照自己读的
    }
  }
  return out;
}

/** 拍号数字条：一条一个数字（12、16 是两位）。先走单字数字格那一路（居中放进方格，与简谱数字同一条；
 *  新编赞美诗 59 首试样 75 行读对、0 行读错）；没读出的再整条当一行字送 rec（多读出一成，两位数也靠它）。
 *  只存纯数字串，别的存空串；合不合法由 `timesig.ts::timeDigit` 判。 */
export async function ocrTimeStrips(ocr: OcrBackend, strips: readonly TimeStrip[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (strips.length === 0 || !ocr.recognizeNumerals) return out;
  const miss: TimeStrip[] = [];
  for (const s of strips) {
    const bin: Binary = { w: s.w, h: s.h, data: s.data };
    const [d] = await ocr.recognizeNumerals(bin, [{ x: 0, y: 0, w: s.w, h: s.h }]);
    out.set(timeKey(s), d === undefined ? "" : String(d));
    if (d === undefined) miss.push(s);
  }
  if (miss.length && ocr.recognizeTexts) {
    const got = await ocr.recognizeTexts(miss.map((s) => surfaceFromInk(s.w, s.h, s.data, 6)));
    got.forEach((t, k) => {
      if (/^\d{1,2}$/.test(t.trim())) out.set(timeKey(miss[k]!), t.trim());
    });
  }
  return out;
}
