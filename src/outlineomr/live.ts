// 转曲矢量谱的在线 OCR 接线：一个 OCR 后端 → 识别要的那组字条识别器（`RasterLiveOcr`）。编辑器（`browser.ts`）与
// 命令行歌本识别（`omr/booksplit/recognize.ts`）共用。
import type { OcrBackend } from "../omrkit/ocr";
import type { RasterLiveOcr } from "../rasteromr/recognize";
import { ocrHarmonyStrips, ocrHeaderStrips, ocrJianpuStrips, ocrLabelStrips, ocrLyricStrips, ocrTimeStrips, ocrWordStrips } from "../rasteromr/ocrlive";

export function outlinedLive(ocr: OcrBackend): RasterLiveOcr {
  return {
    harmony: (s) => ocrHarmonyStrips(ocr, s),
    lyric: (s) => ocrLyricStrips(ocr, s),
    label: (s) => ocrLabelStrips(ocr, s),
    time: (s) => ocrTimeStrips(ocr, s),
    jianpu: (s) => ocrJianpuStrips(ocr, s),
    word: (s) => ocrWordStrips(ocr, s),
    header: (s) => ocrHeaderStrips(ocr, s),
  };
}
