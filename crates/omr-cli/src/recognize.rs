//! 一档语料的一首曲子 → 识别产物。五线谱走 `omr-staff`，简谱走 `omr-jianpu`。
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_ocr::native::NativeInfer;
use dolce_omr_ocr::{Ocr, OcrCache};
use dolce_omr_source::raster::{image_file, page_image, SourceImage};
use dolce_omr_source::{ContentOpts, PdfDoc};
use dolce_omr_staff::page::{recognize_page, Page};
use dolce_omr_staff::song::assemble;
use rayon::prelude::*;
use std::path::Path;

/// 识别产物：判分脚本 `--from` 读的那几样文件的内容。
pub enum RecOutput {
    /// 五线谱：MusicXML 与版面摘要（形状见私有仓库 `chorus-opslib.mjs::recLayoutOf`；独唱谱只要 `notes` / `rowSp`）
    Staff { musicxml: String, layout: String },
    /// 简谱：识别结果（形状同 web `omrkit/types.ts::RecognizedScore`），由私有仓库 `rec-to-123.mjs` 转 123 再判
    Jianpu { recognized: String },
}

/// 一个输入文件的各页原图（PDF 逐页取内嵌图；图片一张一页）。
pub fn sources(p: &Path) -> Result<Vec<SourceImage>, String> {
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let bytes = std::fs::read(p).map_err(|e| format!("读 {}：{e}", p.display()))?;
    if ext == "pdf" {
        let doc = PdfDoc::open(bytes)?;
        Ok((0..doc.page_count()).filter_map(|i| page_image(&doc.content(i, ContentOpts { images: true, paths: false, text: false, outlines: false }).ok()?)).collect())
    } else {
        Ok(vec![image_file(&bytes)?])
    }
}

pub fn recognize(kind: &str, inputs: &[String], ocr: &CachedOcr) -> Result<RecOutput, String> {
    let mut srcs = Vec::new();
    for f in inputs {
        srcs.extend(sources(Path::new(f))?);
    }
    if kind == "jianpu" {
        let score = dolce_omr_jianpu::recognize(&srcs, ocr)?;
        return Ok(RecOutput::Jianpu { recognized: serde_json::to_string(&score).map_err(|e| e.to_string())? });
    }
    let pages: Vec<Page> = srcs.par_iter().filter_map(|s| recognize_page(s, Some(ocr))).collect();
    if pages.is_empty() {
        return Err("没有找到谱表（矢量页尚未接）".into());
    }
    let song = assemble(&pages, None);
    Ok(RecOutput::Staff { musicxml: song.score.to_musicxml(), layout: song.layout_json() })
}

/// 回归用的 OCR：模型取本检出的 `public/redist/ocr`，结果缓存落在 `cache`（按送检画面内容寻址，第二次起不推理）。
pub fn open_ocr(cache: &Path) -> Result<CachedOcr, String> {
    let dir = crate::sibling("web-rust/public/redist/ocr");
    let dict = std::fs::read_to_string(dir.join("ppocrv6_dict.txt")).map_err(|e| format!("读 OCR 字典：{e}"))?;
    Ok(CachedOcr { ocr: Some(Ocr::new(Box::new(NativeInfer::new(&dir, 8, 1)), &dict)), cache: OcrCache::open(cache) })
}
