// 浏览器侧入口：PDF 字节 → MusicXML。**只有这个文件碰 pdfjs 的浏览器构建**，
// `src/staffomr/` 其余部分一律不碰 DOM（要能进 `src/cli/index.ts` 那条 Node 链）。
//
// 与简谱那条路（`src/omrkit/decode.ts`）的分界：那边把 PDF **光栅化**成位图再走连通域；
// 这边直接读文字层与矢量对象，不栅格化。判「该走哪条路」的是 `isStaffPdf`。
import type { OpsEnum } from "../omrkit/vector";
import { StaffGlyphLookup, type StaffGlyphDict } from "./staffglyphs";
import { TextGlyphLookup, type TextGlyphDict } from "./textglyphs";
import { recognizeStaffDoc, type StaffPdfResult } from "./song";
import type { StaffReviewResult } from "./review";
import { openPdf } from "../omrkit/pdf.browser";

export { isStaffPdf, type StaffPdfResult } from "./song";

/**
 * 打开 PDF。
 *
 * **`disableFontFace: true` 不是可选项**：它让 worker 走 `buildFontPaths`，
 * 把字形轮廓以 commonObjs 送出来——`vectext.ts` 的紧包围盒与形状签名全靠它
 * （理由见 docs/实现/五线谱矢量识别.md）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function openStaffPdf(bytes: Uint8Array, extra: Record<string, unknown> = {}): Promise<{ pdf: any; OPS: OpsEnum }> {
  return openPdf(bytes, { disableFontFace: true, ...extra });
}

/**
 * PDF → MusicXML（整本或指定页范围）。
 *
 * 字形字典（`glyphmap.json` 与 `lyricglyphs.json`）由 Vite 打成单独的 chunk，
 * 只在真跑这条路时才加载。
 */
export async function recognizeStaffPdf(
  src: Uint8Array | StaffPdfDoc,
  opts: { pages?: number[]; title?: string; onProgress?: (done: number, total: number) => void; noteIds?: boolean } = {},
): Promise<StaffPdfResult> {
  const doc = src instanceof Uint8Array ? await openStaffPdf(src) : src;
  const { look, textLookup } = await lookups();
  try {
    return await recognizeStaffDoc(doc.pdf, doc.OPS, look, textLookup, opts);
  } finally {
    if (src instanceof Uint8Array) doc.pdf.destroy?.();
  }
}

/** 打开了的 PDF（`openStaffPdf` 的结果）：判路、识别、渲对照底图共用一份，调用方用完 `destroy`。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StaffPdfDoc = { pdf: any; OPS: OpsEnum };

let lookupsPromise: Promise<{ look: StaffGlyphLookup; textLookup: TextGlyphLookup }> | null = null;
/**
 * 字形字典**动态 import**：Vite 会单独切一个 chunk，只在真跑五线谱识别时加载，
 * 而且永远与 `src/staffomr/*.json` 同步（拷进 public/ 会走味）。查表器建一次全会话共用（构造要解签名；
 * `StaffGlyphLookup.misses` 只是诊断记账，不影响查表结果）。
 */
function lookups(): Promise<{ look: StaffGlyphLookup; textLookup: TextGlyphLookup }> {
  lookupsPromise ??= Promise.all([
    import("./glyphmap.json").then((m) => m.default as unknown as StaffGlyphDict),
    import("./lyricglyphs.json").then((m) => m.default as unknown as TextGlyphDict),
  ]).then(([glyphDict, lyricDict]) => ({ look: new StaffGlyphLookup(glyphDict), textLookup: new TextGlyphLookup(lyricDict) }));
  return lookupsPromise;
}

/** 渲成对照底图的倍数：PDF 点 × 它 = 位图像素（约 144 dpi，五线谱的符头、临时记号看得清） */
const OVERLAY_SCALE = 2;

/**
 * 矢量五线谱 PDF 的原图对照：`noteIds` 识别出的结果 + 各页渲成的位图，拼成位图那一路同形的结果
 * （`review.ts::StaffReviewResult`），对照视图、并排原图、谱表 ↔ 声部关联表照用。框坐标从 PDF 点放大到位图像素；
 * 页面结构（谱线）仍是点，`scale` 告诉用的人乘多少。
 */
export async function vectorOverlayResult(src: Uint8Array | StaffPdfDoc, res: StaffPdfResult): Promise<StaffReviewResult> {
  const d = res.detail;
  if (!d) throw new Error("识别时没开 noteIds，没有对照数据");
  const { pdf } = src instanceof Uint8Array ? await openStaffPdf(src) : src;
  const pages: StaffReviewResult["pages"] = [];
  try {
    for (const p of d.pages) {
      const page = await pdf.getPage(p.pn);
      const vp = page.getViewport({ scale: OVERLAY_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const g = canvas.getContext("2d", { willReadFrequently: true })!;
      g.fillStyle = "#fff";
      g.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      page.cleanup?.();
      // 灰度过半就算墨：与位图那一路的二值图同一种底图（`omrkit/svgkit.ts::baseImage` 按 0/1 画）
      const px = g.getImageData(0, 0, canvas.width, canvas.height).data;
      const data = new Uint8Array(canvas.width * canvas.height);
      // pdf.js 没画到的地方是透明（读出来 RGB 全 0），按纸算，不能当墨
      for (let i = 0; i < data.length; i++) data[i] = px[i * 4 + 3]! >= 128 && px[i * 4]! * 0.3 + px[i * 4 + 1]! * 0.59 + px[i * 4 + 2]! * 0.11 < 160 ? 1 : 0;
      pages.push({
        source: 0, pn: p.pn, scale: OVERLAY_SCALE,
        result: { raster: { bin: { w: canvas.width, h: canvas.height, data } }, page: p.page },
      });
    }
  } finally {
    if (src instanceof Uint8Array) pdf.destroy?.();
  }
  const s = OVERLAY_SCALE;
  const noteBoxes: StaffReviewResult["noteBoxes"] = new Map(
    [...d.noteBoxes].map(([id, b]) => [id, { ...b, box: { left: b.box.left * s, right: b.box.right * s, top: b.box.top * s, bottom: b.box.bottom * s } }]),
  );
  return {
    xml: res.musicxml,
    score: d.score as unknown as StaffReviewResult["score"],
    stats: { notes: res.notes, harmonies: 0, lyricLines: 0, lyricStats: { rows: 0, hit: 0, parity: 0 }, bars: 0, full: 0, unknown: 0, staves: 0, pages: res.pages, halftone: null, kind: "vector", jianpuFix: { pairs: 0, pitch: 0, duration: 0, removed: 0, inserted: 0 }, parts: res.parts },
    pages, noteBoxes,
    assignment: () => d.assignment(),
    rebuild: (slots) => {
      const r = d.rebuild(slots);
      return { xml: r.xml, score: r.score as unknown as NonNullable<StaffReviewResult["score"]> };
    },
  };
}
