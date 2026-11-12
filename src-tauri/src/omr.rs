//! Rust 识别接进桌面版（迁移计划 P12）：文档、识别（进度经 Channel、可取消）、五线谱会话、核对底图。
//! 识别、会话都在 `crates/omr-engine`；这里只管句柄表、线程与 IPC。重活一律 `spawn_blocking`，二进制走 `ipc::Response`。
//!
//! OCR 与 TS 识别路的推理命令（`omr_onnx*` / `omr_det`，P13 随 TS 识别删）共用一套原生会话池（[`infer`]）。
use dolce_omr_core::image::Rect;
use dolce_omr_core::progress::{Hook, Step};
use dolce_omr_engine::{Doc, Opts, Recognition, RegionClass};
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_ocr::native::{NativeInfer, DET_FILE, REC_FILE};
use dolce_omr_ocr::{Infer, Model, Ocr, OcrCache};
use dolce_omr_staff::session::{Op, Session};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::{Channel, Response};
use tauri::Manager;

static INFER: OnceLock<Arc<NativeInfer>> = OnceLock::new();
static OCR: OnceLock<Result<CachedOcr, String>> = OnceLock::new();

fn env_usize(name: &str, def: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).filter(|&v| v > 0).unwrap_or(def)
}

fn res(app: &tauri::AppHandle, rel: &str) -> Result<std::path::PathBuf, String> {
    Ok(app.path().resource_dir().map_err(|e| e.to_string())?.join(rel))
}

/// 原生推理的会话池（每个模型 `DOLCE_OCR_SESS` 个会话 × `DOLCE_OCR_THREADS` 线程，缺省 3 × 3）。
pub fn infer(app: &tauri::AppHandle) -> Result<Arc<NativeInfer>, String> {
    if let Some(i) = INFER.get() {
        return Ok(i.clone());
    }
    let i = Arc::new(NativeInfer::with_paths(&res(app, &format!("ocr/{REC_FILE}"))?, &res(app, &format!("ocr/{DET_FILE}"))?, env_usize("DOLCE_OCR_SESS", 3), env_usize("DOLCE_OCR_THREADS", 3)));
    Ok(INFER.get_or_init(|| i).clone())
}

struct Shared(Arc<NativeInfer>);
impl Infer for Shared {
    fn run(&self, model: Model, input: Vec<f32>, dims: &[usize]) -> Result<(Vec<f32>, Vec<usize>), String> {
        self.0.run(model, input, dims)
    }
}

/// 识别用的 OCR：会话池 + 字典，结果缓存在内存里（同一进程里重认同一份不再推理）。
fn ocr(app: &tauri::AppHandle) -> Result<&'static CachedOcr, String> {
    OCR.get_or_init(|| {
        let dict = std::fs::read_to_string(res(app, "ocr/ppocrv6_dict.txt")?).map_err(|e| format!("读 OCR 字典：{e}"))?;
        Ok(CachedOcr { ocr: Some(Ocr::new(Box::new(Shared(infer(app)?)), &dict)), cache: OcrCache::memory() })
    })
    .as_ref()
    .map_err(|e| e.clone())
}

/// 启动时调：PDFium 动态库指到资源目录里那份（开发时资源目录里没有就按 omr-source 的老顺序找）。
pub fn setup(app: &tauri::AppHandle) {
    if let Ok(dir) = res(app, "pdfium") {
        for name in ["libpdfium.dylib", "pdfium.dll", "libpdfium.so"] {
            let p = dir.join(name);
            if p.exists() {
                dolce_omr_source::set_library_path(p);
                break;
            }
        }
    }
}

enum Rec {
    Staff { session: Session, pages: Vec<usize> },
    Jianpu { binary: dolce_omr_core::image::Binary },
}

struct Entry {
    doc: Doc,
    rec: Mutex<Option<Rec>>,
    cancel: AtomicBool,
}

#[derive(Default)]
pub struct OmrState {
    next: AtomicU32,
    docs: Mutex<HashMap<u32, Arc<Entry>>>,
}

fn entry(state: &OmrState, id: u32) -> Result<Arc<Entry>, String> {
    state.docs.lock().map_err(|e| e.to_string())?.get(&id).cloned().ok_or_else(|| format!("没有文档 {id}"))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// 打开文档（请求体是文件原始字节）：回 `{id, pdf, sizes: [[w, h]…]}`（PDF 是点，图片是像素）。
#[tauri::command]
pub async fn omr_open(state: tauri::State<'_, OmrState>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(v) => v.clone(),
        _ => return Err("omr_open 需要原始字节请求体".into()),
    };
    let doc = blocking(move || Doc::open(bytes)).await?;
    let sizes: Vec<[f64; 2]> = (0..doc.page_count()).map(|i| doc.page_size(i).map(|(w, h)| [w, h])).collect::<Result<_, _>>()?;
    let pdf = doc.is_pdf();
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    state.docs.lock().map_err(|e| e.to_string())?.insert(id, Arc::new(Entry { doc, rec: Mutex::new(None), cancel: AtomicBool::new(false) }));
    Ok(json!({ "id": id, "pdf": pdf, "sizes": sizes }))
}

#[tauri::command]
pub fn omr_close(state: tauri::State<'_, OmrState>, id: u32) -> Result<(), String> {
    state.docs.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

/// 整页渲染：回 `u32 宽, u32 高`（小端）+ RGBA。
#[tauri::command]
pub async fn omr_render(state: tauri::State<'_, OmrState>, id: u32, page: usize, scale: f64) -> Result<Response, String> {
    let e = entry(&state, id)?;
    let r = blocking(move || e.doc.render(page, scale)).await?;
    let mut out = Vec::with_capacity(8 + r.rgba.len());
    out.extend_from_slice(&(r.w as u32).to_le_bytes());
    out.extend_from_slice(&(r.h as u32).to_le_bytes());
    out.extend_from_slice(&r.rgba);
    Ok(Response::new(out))
}

/// 核对底图：简谱是识别用的二值图（`page` 不看），五线谱是第 `page` 页（文档页号）。
/// 回 `u32 宽, u32 高, f32 倍数`（核对坐标乘它是底图像素）+ 每像素一字节 0 / 1。
#[tauri::command]
pub async fn omr_binary(state: tauri::State<'_, OmrState>, id: u32, page: usize) -> Result<Response, String> {
    let e = entry(&state, id)?;
    let (bin, k) = blocking(move || {
        if let Some(Rec::Jianpu { binary }) = &*e.rec.lock().map_err(|e| e.to_string())? {
            return Ok((binary.clone(), 1.0));
        }
        dolce_omr_engine::staff_binary(&e.doc, page)
    })
    .await?;
    let mut out = Vec::with_capacity(12 + bin.data.len());
    out.extend_from_slice(&(bin.w as u32).to_le_bytes());
    out.extend_from_slice(&(bin.h as u32).to_le_bytes());
    out.extend_from_slice(&(k as f32).to_le_bytes());
    out.extend_from_slice(&bin.data);
    Ok(Response::new(out))
}

#[derive(Clone, Serialize)]
pub struct Progress {
    done: usize,
    total: usize,
    stage: String,
}

/// 识别：进度逐步发到 `on_progress`。回 `{kind: "staff", xml, review, pages}` 或 `{kind: "jianpu", score}`；取消回错误「已取消」。
#[tauri::command]
pub async fn omr_recognize(app: tauri::AppHandle, state: tauri::State<'_, OmrState>, id: u32, opts: Opts, on_progress: Channel<Progress>) -> Result<Value, String> {
    let e = entry(&state, id)?;
    e.cancel.store(false, Ordering::Relaxed);
    blocking(move || {
        let ocr = ocr(&app)?;
        let send = |s: Step| {
            let _ = on_progress.send(Progress { done: s.done, total: s.total, stage: s.stage.to_string() });
        };
        let hook = Hook { on: Some(&send), cancel: Some(&e.cancel) };
        let r = dolce_omr_engine::recognize(&e.doc, ocr, &opts, &hook)?;
        let mut slot = e.rec.lock().map_err(|e| e.to_string())?;
        Ok(match r {
            Recognition::Staff { session, pages } => {
                let (xml, review) = dolce_omr_engine::staff_output(&session);
                let v = json!({ "kind": "staff", "xml": xml, "review": review, "pages": pages });
                *slot = Some(Rec::Staff { session, pages });
                v
            }
            Recognition::Jianpu { score, binary } => {
                *slot = Some(Rec::Jianpu { binary });
                json!({ "kind": "jianpu", "score": score })
            }
        })
    })
    .await
}

#[tauri::command]
pub fn omr_cancel(state: tauri::State<'_, OmrState>, id: u32) -> Result<(), String> {
    entry(&state, id)?.cancel.store(true, Ordering::Relaxed);
    Ok(())
}

/// 会话操作（五线谱）。`op` 除 `omr-staff::session::Op` 的各种外，还有：
/// `{op: "insert", page, x, y}`（点原图补认，`page` 是结果页下标，坐标是核对坐标）→ 另回 `rid`；
/// `{op: "region", page, rect: {x, y, w, h}, class: "lyric" | "text"}`（框选重认）→ 另回 `count`。
/// 回 `{xml, review, …}`。
#[tauri::command]
pub async fn omr_session(app: tauri::AppHandle, state: tauri::State<'_, OmrState>, id: u32, op: Value) -> Result<Value, String> {
    let e = entry(&state, id)?;
    blocking(move || {
        let mut slot = e.rec.lock().map_err(|e| e.to_string())?;
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
                let rid = dolce_omr_engine::insert(&e.doc, session, pages, a.page, a.x, a.y)?;
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
                let n = dolce_omr_engine::region(&e.doc, session, pages, a.page, a.rect, a.class, ocr(&app)?)?;
                extra = json!({ "count": n });
            }
            _ => {
                let op: Op = serde_json::from_value(op).map_err(|e| format!("会话操作不认得：{e}"))?;
                session.apply(op)?;
            }
        }
        let (xml, review) = dolce_omr_engine::staff_output(session);
        extra["xml"] = json!(xml);
        extra["review"] = json!(review);
        Ok(extra)
    })
    .await
}
