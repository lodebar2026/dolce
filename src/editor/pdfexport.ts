// 网页版「导出 PDF」：写出端在 Rust（crates/dolce-export，经按需载入的 dolce-export-wasm）。
// - 矢量：浏览器给了本地字体访问（Chromium 的 `queryLocalFonts`，首次会问用户）就把场景要的那几个族的字体字节交给 wasm，
//   出真文字、嵌子集的 PDF（同桌面 `export_scene_pdf`）；字体不全（有字落不了）退栅格。
// - 栅格：逐页 PNG 铺满（取代 jsPDF）。
import { asset } from "../common/asset";
import { importDolceWasm } from "../common/dolce";
import type { ScorePainter } from "../layout/painter";
import { pageScenes, type Json } from "../layout/scenejson";

interface PdfOut {
  readonly bytes: Uint8Array;
  readonly report: string;
  free(): void;
}
interface PdfFontsW {
  families(css: string): string[];
  addFont(key: string, bytes: Uint8Array): void;
  scenePdf(pagesJson: string, bg: number, title: string): PdfOut;
  free(): void;
}
interface RasterPdfW {
  addPage(png: Uint8Array, w: number, h: number): void;
  finish(title: string): Uint8Array;
  free(): void;
}
interface ExportWasm {
  default(init: { module_or_path: string }): Promise<object>;
  PdfFonts: new (platform: string) => PdfFontsW;
  RasterPdf: new () => RasterPdfW;
  /** 场景 → .pptx（`editor/pptxexport.ts`） */
  pptx(input: string, bravura: Uint8Array): Uint8Array;
}

/** `queryLocalFonts()` 给的一个字体面 */
interface LocalFont {
  family: string;
  fullName: string;
  postscriptName: string;
  blob(): Promise<Blob>;
}

let mod: Promise<ExportWasm> | null = null;

/** 按需载入导出 wasm（PDF 与 PPTX 共用一份）。 */
export function exportWasm(): Promise<ExportWasm> {
  mod ??= importDolceWasm<ExportWasm>(import.meta.env.BASE_URL, "dolce_export_wasm").catch((e: unknown) => {
    mod = null;
    throw e;
  });
  return mod;
}

/** 场景里用到的族串（去重） */
function familyCss(scenes: Json[]): string[] {
  const out = new Set<string>();
  const walk = (n: Json): void => {
    if (!n || typeof n !== "object" || Array.isArray(n)) return;
    const f = n.font;
    if (f && typeof f === "object" && !Array.isArray(f) && typeof f.family === "string") out.add(f.family);
    if (Array.isArray(n.k)) n.k.forEach(walk);
  };
  for (const s of scenes) if (s && typeof s === "object" && !Array.isArray(s)) walk(s.root);
  return [...out];
}

/** 矢量 PDF；浏览器不给本地字体（不支持、用户拒绝）或字体不全时返回 null。 */
export async function vectorPdf(painter: ScorePainter, bg: number, title: string): Promise<Uint8Array | null> {
  const query = (globalThis as { queryLocalFonts?: () => Promise<LocalFont[]> }).queryLocalFonts;
  if (!query) return null;
  let local: LocalFont[];
  try {
    local = await query();
  } catch {
    return null;
  }
  if (!local.length) return null;
  const w = await exportWasm();
  const fonts = new w.PdfFonts(/win/i.test(navigator.platform) ? "win32" : "darwin");
  try {
    const scenes = pageScenes(painter);
    const want = new Set(fonts.families(familyCss(scenes).join("\n")));
    // 同一文件（.ttc）的各面 blob 是同一份字节：按大小去重，一份只加一次
    const added = new Set<number>();
    for (const f of local) {
      if (!want.has(f.family) && !want.has(f.postscriptName) && !want.has(f.fullName)) continue;
      const blob = await f.blob();
      if (added.has(blob.size)) continue;
      added.add(blob.size);
      fonts.addFont(f.postscriptName, new Uint8Array(await blob.arrayBuffer()));
    }
    const r = await fetch(asset("redist/Bravura.otf"));
    if (r.ok) fonts.addFont("Bravura.otf", new Uint8Array(await r.arrayBuffer()));
    const pages = scenes.map((scene, i) => ({ scene, ...painter.pageSize(i) }));
    const out = fonts.scenePdf(JSON.stringify(pages), bg, title);
    try {
      const report = JSON.parse(out.report) as { missing: unknown[] };
      return report.missing.length ? null : out.bytes;
    } finally {
      out.free();
    }
  } finally {
    fonts.free();
  }
}

/** 栅格 PDF：每页一张 PNG 铺满（`w`/`h` 是页面 pt）。 */
export async function rasterPdf(pages: { png: Uint8Array; w: number; h: number }[], title: string): Promise<Uint8Array> {
  const w = await exportWasm();
  const doc = new w.RasterPdf();
  try {
    for (const p of pages) doc.addPage(p.png, p.w, p.h);
    return doc.finish(title);
  } finally {
    doc.free();
  }
}
