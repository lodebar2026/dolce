// 浏览器侧打开 PDF：pdf.js 动态加载、worker 与 wasm 目录（`?url` / BASE_URL 下的 redist）。三路共用这一份。
import type { OpsEnum } from "./vector";

/**
 * 打开 PDF（`extra` 原样交给 `getDocument`：矢量路要 `disableFontFace: true`，位图路要关掉图像解码优化）。
 * pdf.js v6 的位图解码器（jbig2.wasm 兼管 CCITTFax G4、openjpeg 管 JPEG2000）要显式指明 wasm 目录，
 * 否则内嵌位图（扫描版乐谱的 1-bit ImageMask）会被静默丢弃。目录随 public/redist/ 一起部署，离线自包含。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function openPdf(bytes: Uint8Array, extra: Record<string, unknown> = {}): Promise<{ pdf: any; OPS: OpsEnum }> {
  const pdfjs = await import("pdfjs-dist");
  // worker 由 Vite `?url` 解析为同源资源 URL（离线自包含，dev/build 一致）。
  const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const wasmUrl = `${import.meta.env.BASE_URL}redist/pdfjs/`;
  // getDocument 会 detach 传入的 buffer，复制一份避免污染调用方字节。
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), wasmUrl, ...extra }).promise;
  return { pdf, OPS: pdfjs.OPS as unknown as OpsEnum };
}
