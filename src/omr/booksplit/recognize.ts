// 歌本切分 · 逐首识别：转曲矢量歌本按切分出的各段**回原书取矢量对象**认（`outlineomr`，简线混排、五线谱都走它），
// 不拿渲出来的图去认。输出 MusicXML（识别原样），或读回 ScoreDoc 再写成别的可编辑格式。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OutlineGlyphLookup, isOutlinedStaffPdf, recognizeOutlinedDoc, type PageClip } from "../../outlineomr";
import { outlinedLive } from "../../outlineomr/live";
import type { StaffGlyphDict } from "../../staffomr/staffglyphs";
import glyphmap from "../../staffomr/glyphmap.json";
import type { OcrBackend } from "../../omrkit/ocr";
import { loadScoreDoc } from "../../model/fromxml";
import { CONVERT_TARGETS, type ConvertTarget } from "../../convert/targets";
import { encodeJcx } from "../../common/jcxcodec";
import type { BookPlan } from "./index";
import type { PageSource } from "./types";

/** 歌本识别的输出格式：MusicXML 加上各可编辑格式。 */
export type BookFormat = "musicxml" | ConvertTarget;
export const BOOK_FORMATS: readonly BookFormat[] = ["musicxml", ...CONVERT_TARGETS.map((t) => t.id)];
export const isBookFormat = (v: unknown): v is BookFormat => BOOK_FORMATS.includes(v as BookFormat);

const EXT: Record<string, string> = { "123": ".123", abc: ".abc", jpwabc: ".jpwabc", fanqie: ".jps", jly: ".jly", jcx: ".jcx" };

/** 一种格式的扩展名与落盘字节（.jpwabc 照 JP-Word 存 UTF-16LE 带 BOM，.jcx 存 GBK，其余 UTF-8）。 */
function encodeAs(format: BookFormat, xml: string): { ext: string; bytes: Uint8Array } {
  if (format === "musicxml") return { ext: ".musicxml", bytes: new TextEncoder().encode(xml) };
  const spec = CONVERT_TARGETS.find((t) => t.id === format)!;
  const text = spec.emit(loadScoreDoc(xml));
  if (spec.docFormat === "jpwabc") return { ext: EXT.jpwabc, bytes: new Uint8Array(Buffer.from("﻿" + text, "utf16le")) };
  if (spec.docFormat === "jcx") return { ext: EXT.jcx, bytes: encodeJcx(text).bytes };
  return { ext: EXT[spec.docFormat], bytes: new TextEncoder().encode(text) };
}

export interface BookRecognizeReport {
  ok: number;
  failed: { name: string; reason: string }[];
  text: string;
}

/**
 * 逐首识别并写到 `outDir/<names[k]><扩展名>`。各段的范围取切分的摆放（`plan.layouts[k].parts[j].src`，扫描图像素），
 * 按 `src.vector.scale` 换回 PDF 点；页脚页码框剔掉。曲名用切分认出的曲名。
 */
export async function recognizeBookSongs(
  src: PageSource, plan: BookPlan, names: readonly string[], outDir: string, ocr: OcrBackend,
  opts: { format?: BookFormat; onProgress?: (done: number, total: number) => void } = {},
): Promise<BookRecognizeReport> {
  const vec = src.vector;
  if (!vec) throw new Error("逐首识别只收转曲矢量歌本；位图歌本请先切分出图，再用 omr-cli 批量识别图片目录");
  if (!(await isOutlinedStaffPdf(vec.pdf, vec.OPS))) throw new Error("这本矢量 PDF 里没认出五线谱，转曲矢量识别只收五线谱与简线混排谱");
  const format = opts.format ?? "musicxml";
  await mkdir(outDir, { recursive: true });
  const look = new OutlineGlyphLookup(glyphmap as unknown as StaffGlyphDict);
  const live = outlinedLive(ocr);
  const k = 1 / vec.scale;
  const toPt = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k });
  const failed: BookRecognizeReport["failed"] = [];
  let ok = 0;
  for (let s = 0; s < plan.songs.length; s++) {
    const song = plan.songs[s];
    const segments = plan.layouts[s].parts.map((part): { pn: number; clip: PageClip } => {
      const p = plan.pages[part.page];
      // 横向不裁（版心外的曲号、页边小字不碍事），纵向照摆放拷的那一段
      const rect = toPt({ x: 0, y: part.src.y, w: p.layout.w, h: part.src.h });
      return { pn: part.page + 1, clip: { rect, drop: p.footer ? [toPt(p.footer)] : undefined } };
    });
    try {
      const r = await recognizeOutlinedDoc(vec.pdf, vec.OPS, look, { title: song.title || undefined, live, segments });
      if (!r.musicxml) throw new Error("没认出谱表");
      const { ext, bytes } = encodeAs(format, r.musicxml);
      await writeFile(join(outDir, names[s] + ext), bytes);
      ok++;
    } catch (e) {
      failed.push({ name: names[s], reason: e instanceof Error ? e.message : String(e) });
    }
    opts.onProgress?.(s + 1, plan.songs.length);
  }
  const L = [`识别（${format}，取原书矢量）：成功 ${ok} 首` + (failed.length ? `，失败 ${failed.length} 首` : " ✓")];
  for (const f of failed) L.push(`  ${f.name}：${f.reason}`);
  return { ok, failed, text: L.join("\n") + "\n" };
}
