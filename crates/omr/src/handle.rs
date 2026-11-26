//! 宿主共用的文档句柄：桌面版 Tauri 命令（`src-tauri/src/omr.rs`）与网页版 wasm（`omr-wasm`）都是它外面的一层薄壳，
//! 只管线程 / IPC / 消息。请求与回应的格式两边一样（前端 `src/omrrust/engine.ts` 一份解析）：
//!
//! - 打开：[`split_files`] 的请求体（`u32 个数` + 各 `u32 长度` + 字节，小端）
//! - [`Handle::render_bytes`]：`u32 宽, u32 高` + RGBA
//! - [`Handle::binary_bytes`]：`u32 宽, u32 高, f32 倍数, f32 × 6 底图在页上的框 x y w h 与页宽高` + 每像素一字节 0 / 1
//! - [`Handle::recognize`] / [`Handle::session`]：JSON
//!
//! 文档在锁外（识别时也能渲染），识别结果在锁里。
use crate::{Doc, Opts, Recognition, RegionClass};
use dolce_omr_core::image::{Binary, Rect};
use dolce_omr_core::progress::{Hook, Step, CANCELLED};
use dolce_omr_core::ocr::cache::{CachedOcr, OcrReq};
use dolce_omr_staff::session::{Op, Session};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Mutex;

enum Rec {
    Staff { session: Box<Session>, pages: Vec<usize> },
    Jianpu { binary: Binary },
}

pub struct Handle {
    pub doc: Doc,
    rec: Mutex<Option<Rec>>,
}

/// `u32 个数` + 各个 `u32 长度` + 字节 → 各段。
pub fn split_files(b: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let u32_at = |o: usize| b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize).ok_or("请求体太短");
    let n = u32_at(0)?;
    let mut off = 4;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let len = u32_at(off)?;
        out.push(b.get(off + 4..off + 4 + len).ok_or("请求体太短")?.to_vec());
        off += 4 + len;
    }
    Ok(out)
}

impl Handle {
    /// 按 [`split_files`] 的请求体打开（几个文件合成一份）。
    pub fn open(body: &[u8]) -> Result<Handle, String> {
        Ok(Handle { doc: Doc::open_many(split_files(body)?)?, rec: Mutex::new(None) })
    }

    /// `{pdf, sizes: [[w, h]…]}`（PDF 是点，图片是像素）。
    pub fn info(&self) -> Result<Value, String> {
        let sizes: Vec<[f64; 2]> = (0..self.doc.page_count()).map(|i| self.doc.page_size(i).map(|(w, h)| [w, h])).collect::<Result<_, _>>()?;
        Ok(json!({ "pdf": self.doc.is_pdf(), "sizes": sizes }))
    }

    pub fn render_bytes(&self, page: usize, scale: f64) -> Result<Vec<u8>, String> {
        let r = self.doc.render(page, scale)?;
        let mut out = Vec::with_capacity(8 + r.rgba.len());
        out.extend_from_slice(&(r.w as u32).to_le_bytes());
        out.extend_from_slice(&(r.h as u32).to_le_bytes());
        out.extend_from_slice(&r.rgba);
        Ok(out)
    }

    /// 核对底图：简谱是识别用的二值图（`page` 不看，没有位置），五线谱是第 `page` 页（文档页号）。
    pub fn binary_bytes(&self, page: usize) -> Result<Vec<u8>, String> {
        let (bin, k, at) = match &*self.rec.lock().map_err(|e| e.to_string())? {
            Some(Rec::Jianpu { binary }) => (binary.clone(), 1.0, None),
            _ => {
                let (b, k, at) = crate::staff_binary(&self.doc, page)?;
                (b, k, Some(at))
            }
        };
        let mut out = Vec::with_capacity(36 + bin.data.len());
        out.extend_from_slice(&(bin.w as u32).to_le_bytes());
        out.extend_from_slice(&(bin.h as u32).to_le_bytes());
        out.extend_from_slice(&(k as f32).to_le_bytes());
        let f = at.map_or([0.0; 6], |a| [a.rect.x, a.rect.y, a.rect.w, a.rect.h, a.page_w, a.page_h]);
        for v in f {
            out.extend_from_slice(&(v as f32).to_le_bytes());
        }
        out.extend_from_slice(&bin.data);
        Ok(out)
    }

    /// 识别。回 `{kind: "staff", xml, review, pages}` 或 `{kind: "jianpu", score}`；取消回错误「已取消」。
    pub fn recognize(&self, ocr: &CachedOcr, opts: &Opts, hook: &Hook) -> Result<Value, String> {
        let r = crate::recognize(&self.doc, ocr, opts, hook)?;
        let mut slot = self.rec.lock().map_err(|e| e.to_string())?;
        Ok(match r {
            Recognition::Staff { session, pages } => {
                let (xml, review) = crate::staff_output(&session);
                let v = json!({ "kind": "staff", "xml": xml, "review": review, "pages": pages });
                *slot = Some(Rec::Staff { session: Box::new(session), pages });
                v
            }
            Recognition::Jianpu { score, binary } => {
                *slot = Some(Rec::Jianpu { binary });
                json!({ "kind": "jianpu", "score": score })
            }
        })
    }

    /// 分轮预取地识别（桌面版、命令行）：各轮缺的 OCR 一批分给 `threads` 个线程推理，见 [`CachedOcr::rounds`]。
    /// 进度只往前报（每轮都从头跑一遍，退回去的不报）。
    pub fn recognize_rounds(&self, ocr: &CachedOcr, opts: &Opts, hook: &Hook, threads: usize) -> Result<Value, String> {
        let best = Mutex::new(0.0f64);
        let fwd = |s: Step| {
            let r = s.done as f64 / s.total.max(1) as f64;
            if let Ok(mut b) = best.lock() {
                if r >= *b {
                    *b = r;
                    if let Some(f) = hook.on {
                        f(s);
                    }
                }
            }
        };
        let h = Hook { on: Some(&fwd), cancel: hook.cancel };
        ocr.rounds(
            || self.recognize(ocr, opts, &h),
            |o, reqs| {
                if hook.cancelled() {
                    return Err(CANCELLED.into());
                }
                o.fill_local(reqs, threads)
            },
        )
    }

    /// 分轮预取的一轮（网页版：推理分给几个 Worker，由页面驱动各轮）：缺 OCR 回 `Err(请求)`，不缺回识别结果。
    pub fn recognize_round(&self, ocr: &CachedOcr, opts: &Opts, hook: &Hook) -> Result<Result<Value, Vec<OcrReq>>, String> {
        ocr.begin_defer();
        let r = self.recognize(ocr, opts, hook);
        let reqs = ocr.end_defer();
        if !reqs.is_empty() && !hook.cancelled() {
            return Ok(Err(reqs));
        }
        r.map(Ok)
    }

    /// 会话操作（五线谱）。`op` 除 `omr-staff::session::Op` 的各种外，还有：
    /// `{op: "insert", page, x, y}`（点原图补认，`page` 是结果页下标，坐标是核对坐标）→ 另回 `rid`；
    /// `{op: "region", page, rect: {x, y, w, h}, class: "lyric" | "text"}`（框选重认）→ 另回 `count`。
    /// 回 `{xml, review, …}`。`ocr` 只有框选重认用到（按需取）。
    pub fn session<'a>(&self, op: Value, ocr: impl FnOnce() -> Result<&'a CachedOcr, String>) -> Result<Value, String> {
        let mut slot = self.rec.lock().map_err(|e| e.to_string())?;
        let Some(Rec::Staff { session, pages }) = slot.as_mut() else { return Err("这份文档没有五线谱识别结果".into()) };
        let mut extra = json!({});
        match op.get("op").and_then(Value::as_str) {
            Some("insert") => {
                #[derive(Deserialize)]
                struct A {
                    page: usize,
                    x: f64,
                    y: f64,
                }
                let a: A = serde_json::from_value(op).map_err(|e| e.to_string())?;
                let rid = crate::insert(&self.doc, session, pages, a.page, a.x, a.y)?;
                extra = json!({ "rid": rid.to_string() });
            }
            Some("region") => {
                #[derive(Deserialize)]
                struct A {
                    page: usize,
                    rect: Rect,
                    class: RegionClass,
                }
                let a: A = serde_json::from_value(op).map_err(|e| e.to_string())?;
                let n = crate::region(&self.doc, session, pages, a.page, a.rect, a.class, ocr()?)?;
                extra = json!({ "count": n });
            }
            _ => {
                let op: Op = serde_json::from_value(op).map_err(|e| format!("会话操作不认得：{e}"))?;
                session.apply(op)?;
            }
        }
        let (xml, review) = crate::staff_output(session);
        extra["xml"] = json!(xml);
        extra["review"] = json!(review);
        Ok(extra)
    }
}
