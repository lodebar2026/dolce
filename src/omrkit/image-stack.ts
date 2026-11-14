import { t } from "../i18n";

export interface ImageInput { bytes: Uint8Array; mime?: string; name?: string }
const MAX_PIXELS = 25_000_000;
const MAX_SIDE = 30_000;
const GAP = 32;

/** Keep caller order: the picker sorts new selections, the page panel owns manual order. */
export function imageStackLayout(sizes: readonly { width: number; height: number }[]) {
  if (!sizes.length || sizes.length > 10) throw new Error(t("omr.stackLimit"));
  const width = Math.min(2200, Math.max(...sizes.map(s => s.width)));
  let height = 0;
  const pages = sizes.map(s => {
    if (!s.width || !s.height || s.width * s.height > MAX_PIXELS) throw new Error(t("omr.stackPixels"));
    const h = Math.max(1, Math.round(s.height * width / s.width));
    const page = { y: height, width, height: h };
    height += h + GAP;
    return page;
  });
  height -= GAP;
  if (height > MAX_SIDE || height * width > MAX_PIXELS) throw new Error(t("omr.stackPixels"));
  return { width, height, pages };
}

/** One bounded white-backed image lets the existing recognizer retain one coordinate space. */
export async function stackImages(files: readonly ImageInput[]): Promise<Uint8Array> {
  if (files.length > 10 || files.reduce((n, f) => n + f.bytes.byteLength, 0) > 30 * 1024 * 1024)
    throw new Error(t("omr.stackLimit"));
  const sizes: { width: number; height: number }[] = [];
  for (const f of files) {
    const bmp = await createImageBitmap(new Blob([f.bytes as BlobPart], { type: f.mime || "application/octet-stream" }));
    sizes.push({ width: bmp.width, height: bmp.height });
    bmp.close();
  }
  const layout = imageStackLayout(sizes);
  const canvas = new OffscreenCanvas(layout.width, layout.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t("omr.stackCanvas"));
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, layout.width, layout.height);
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const bmp = await createImageBitmap(new Blob([f.bytes as BlobPart], { type: f.mime || "application/octet-stream" }));
    const p = layout.pages[i]!;
    ctx.drawImage(bmp, 0, p.y, p.width, p.height);
    bmp.close();
  }
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}
