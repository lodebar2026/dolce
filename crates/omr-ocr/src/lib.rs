//! OCR：PP-OCR 识别（rec，CTC）与检测（DBNet det）。
//!
//! - [`surface`]：灰度画面与缩放（缩小面积平均、放大双线性）
//! - 推理经 [`Infer`] 注入：原生（`native` 特性，onnxruntime）/ 纯 Rust（`tract` 特性，网页版 wasm）/ 回归用的缓存
//! - [`Ocr`]：文本条带位置识别、数字格批量识别、逐字候选、文本检测（单块与整页分块）
//! - [`cache`]：按送检画面内容寻址的结果缓存（回归第二次起不推理）
//!
//! 模型：rec = PP-OCRv6_small（18708 字），det = PP-OCRv4（已把 `GlobalAveragePool` 换成等价的 `ReduceMean`，
//! 桌面版静态链的 onnxruntime 1.31 算错前者，见 web 模块页「识别-共享层」）。
pub mod cache;
mod ctc;
mod det;
#[cfg(feature = "native")]
pub mod native;
pub mod surface;
#[cfg(feature = "tract")]
pub mod tract;

pub use cache::OcrCache;
pub use ctc::{CharPos, RankedChar};
use dolce_omr_core::image::Rect;
use surface::{blit, Gray};

/// 哪个模型。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Model {
    Rec,
    Det,
}

/// 推理后端：输入 NCHW 的 f32 张量，回输出张量与维度。要能多线程调（各后端自己管会话池）。
pub trait Infer: Send + Sync {
    fn run(&self, model: Model, input: Vec<f32>, dims: &[usize]) -> Result<(Vec<f32>, Vec<usize>), String>;
}

/// rec 输入高、常规宽上限、长条宽上限。
const REC_H: usize = 48;
const REC_MAXW: usize = 320;
const REC_MAXW_LONG: usize = 2048;
/// 数字格送检的宽（近方形单字，48×48 一批堆起来）。
const DIGIT_W: usize = 48;
/// 数字格批量推理每批多少格。
const DIGIT_BATCH: usize = 64;

/// 一份 OCR：推理后端 + 字典。
pub struct Ocr {
    infer: Box<dyn Infer>,
    /// CTC 类表：0 号是空白，其后是字典。
    chars: Vec<String>,
}

impl Ocr {
    /// `dict`：字典文本（一行一字；兼容 CRLF——Windows 检出常把换行改成 CRLF，`\r` 会粘在每个字后面）。
    pub fn new(infer: Box<dyn Infer>, dict: &str) -> Self {
        let mut chars = vec![String::new()];
        chars.extend(dict.split('\n').map(|l| l.trim_end_matches('\r')).filter(|l| !l.is_empty()).map(str::to_string));
        Ocr { infer, chars }
    }

    /// 文本条带位置识别：每条交出逐字 `{字, 左缘, 右缘}`（占条内容宽的比例）。宽上限按条自己的宽：
    /// 常规条 ≤ 320，压不进的长条（整串英文音节）放宽到 2048，免得压扁。
    pub fn read_lines(&self, strips: &[Gray]) -> Result<Vec<Vec<CharPos>>, String> {
        strips
            .iter()
            .map(|s| {
                let max_w = (REC_H as f64 * s.w as f64 / s.h as f64).ceil().clamp(REC_MAXW as f64, REC_MAXW_LONG as f64) as usize;
                let (t, w, tw) = prep_strip(s, max_w);
                let (out, dims) = self.infer.run(Model::Rec, t, &[1, 3, REC_H, tw])?;
                Ok(ctc::decode(&out, dims[1], dims[2], &self.chars, w, tw))
            })
            .collect()
    }

    /// 逐字候选：每字前 `k` 名（分降序）。字的划分同 [`Ocr::read_lines`]。
    pub fn rank_chars(&self, strip: &Gray, k: usize) -> Result<Vec<RankedChar>, String> {
        Ok(self.read_rank(strip, k)?.1)
    }

    /// 同一条的 [`Ocr::read_lines`] 与 [`Ocr::rank_chars`]：张量相同，只推理一次。
    pub fn read_rank(&self, strip: &Gray, k: usize) -> Result<(Vec<CharPos>, Vec<RankedChar>), String> {
        let max_w = (REC_H as f64 * strip.w as f64 / strip.h as f64).ceil().clamp(REC_MAXW as f64, REC_MAXW_LONG as f64) as usize;
        let (t, w, tw) = prep_strip(strip, max_w);
        let (out, dims) = self.infer.run(Model::Rec, t, &[1, 3, REC_H, tw])?;
        Ok((ctc::decode(&out, dims[1], dims[2], &self.chars, w, tw), ctc::rank(&out, dims[1], dims[2], &self.chars, k)))
    }

    /// 数字格批量识别：每格缩到 48×48，一批 64 格。交出每格贪心解码的字串（上层自己挑数字）。
    pub fn read_cells(&self, cells: &[Gray]) -> Result<Vec<String>, String> {
        let mut out = Vec::with_capacity(cells.len());
        for chunk in cells.chunks(DIGIT_BATCH) {
            let n = chunk.len();
            let plane = REC_H * DIGIT_W;
            let mut t = vec![0f32; n * 3 * plane];
            for (i, c) in chunk.iter().enumerate() {
                let mut tmp = Gray::new(DIGIT_W, REC_H, 255);
                blit(&mut tmp, c, Rect::new(0.0, 0.0, c.w as f64, c.h as f64), Rect::new(0.0, 0.0, DIGIT_W as f64, REC_H as f64));
                for (p, &v) in tmp.data.iter().enumerate() {
                    let f = norm(v);
                    for ch in 0..3 {
                        t[i * 3 * plane + ch * plane + p] = f;
                    }
                }
            }
            let (o, dims) = self.infer.run(Model::Rec, t, &[n, 3, REC_H, DIGIT_W])?;
            let (tt, cc) = (dims[1], dims[2]);
            for i in 0..n {
                let row = &o[i * tt * cc..(i + 1) * tt * cc];
                out.push(ctc::decode(row, tt, cc, &self.chars, DIGIT_W, DIGIT_W).into_iter().map(|c| c.ch).collect());
            }
        }
        Ok(out)
    }

    /// 文本检测：`region` 里的文本行框（原图坐标，已外扩、按阅读序排好）。子图缩到边长 960 以内送检。
    pub fn detect(&self, src: &Gray, region: Rect) -> Result<Vec<Rect>, String> {
        det::detect_region(self.infer.as_ref(), src, region)
    }

    /// 整页分块检测：按 `scale` 定块（每块原图边长 960 / scale，缩完正好 960），块间叠两成；被块边切断的长行并回。
    pub fn detect_tiled(&self, src: &Gray, region: Rect, scale: f64) -> Result<Vec<Rect>, String> {
        det::detect_tiled(self.infer.as_ref(), src, region, scale)
    }
}

/// rec 的归一化：(v / 255 − 0.5) / 0.5。
#[inline]
fn norm(v: u8) -> f32 {
    (v as f32 / 255.0 - 0.5) / 0.5
}

/// 文本条 → rec 输入张量：等比缩到高 48、宽不过 `max_w`，零填充到张量宽（常规条一律 320）。回 (张量, 内容宽, 张量宽)。
fn prep_strip(s: &Gray, max_w: usize) -> (Vec<f32>, usize, usize) {
    let w = ((REC_H as f64 * s.w as f64 / s.h as f64).ceil() as usize).clamp(1, max_w);
    let tw = if max_w <= REC_MAXW { REC_MAXW } else { w };
    let mut tmp = Gray::new(w, REC_H, 255);
    blit(&mut tmp, s, Rect::new(0.0, 0.0, s.w as f64, s.h as f64), Rect::new(0.0, 0.0, w as f64, REC_H as f64));
    let plane = REC_H * tw;
    let mut t = vec![0f32; 3 * plane];
    for y in 0..REC_H {
        for x in 0..w {
            let f = norm(tmp.data[y * w + x]);
            for ch in 0..3 {
                t[ch * plane + y * tw + x] = f;
            }
        }
    }
    (t, w, tw)
}
