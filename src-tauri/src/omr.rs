//! Rust 识别接进桌面版（迁移计划 P12）：文档、识别（进度经 Channel、可取消）、五线谱会话、核对底图。
//! 识别、会话都在 `crates/omr-engine`；这里只管句柄表、线程与 IPC。重活一律 `spawn_blocking`，二进制走 `ipc::Response`。
//!
//! OCR 与 TS 识别路的推理命令（`omr_onnx*` / `omr_det`，P13 随 TS 识别删）共用一套原生会话池（[`infer`]）。
use dolce_omr_core::progress::{Hook, Step};
use dolce_omr_engine::{Handle, Opts};
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_ocr::native::{NativeInfer, DET_FILE, REC_FILE};
use dolce_omr_ocr::{Infer, Model, Ocr, OcrCache};
use serde::Serialize;
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

struct Entry {
    h: Handle,
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

/// 打开文档（几个文件合成一份）。请求体见 `omr-engine::split_files`；回 `{id, pdf, sizes}`。
#[tauri::command]
pub async fn omr_open(state: tauri::State<'_, OmrState>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(v) => v.clone(),
        _ => return Err("omr_open 需要原始字节请求体".into()),
    };
    let h = blocking(move || Handle::open(&body)).await?;
    let mut info = h.info()?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    state.docs.lock().map_err(|e| e.to_string())?.insert(id, Arc::new(Entry { h, cancel: AtomicBool::new(false) }));
    info["id"] = json!(id);
    Ok(info)
}

#[tauri::command]
pub fn omr_close(state: tauri::State<'_, OmrState>, id: u32) -> Result<(), String> {
    state.docs.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

/// 整页渲染（格式见 `omr-engine::Handle::render_bytes`）。
#[tauri::command]
pub async fn omr_render(state: tauri::State<'_, OmrState>, id: u32, page: usize, scale: f64) -> Result<Response, String> {
    let e = entry(&state, id)?;
    Ok(Response::new(blocking(move || e.h.render_bytes(page, scale)).await?))
}

/// 核对底图（格式见 `omr-engine::Handle::binary_bytes`）。
#[tauri::command]
pub async fn omr_binary(state: tauri::State<'_, OmrState>, id: u32, page: usize) -> Result<Response, String> {
    let e = entry(&state, id)?;
    Ok(Response::new(blocking(move || e.h.binary_bytes(page)).await?))
}

#[derive(Clone, Serialize)]
pub struct Progress {
    done: usize,
    total: usize,
    stage: String,
}

/// 识别：进度逐步发到 `on_progress`；回应见 `omr-engine::Handle::recognize`。
#[tauri::command]
pub async fn omr_recognize(app: tauri::AppHandle, state: tauri::State<'_, OmrState>, id: u32, opts: Opts, on_progress: Channel<Progress>) -> Result<Value, String> {
    let e = entry(&state, id)?;
    e.cancel.store(false, Ordering::Relaxed);
    blocking(move || {
        let send = |s: Step| {
            let _ = on_progress.send(Progress { done: s.done, total: s.total, stage: s.stage.to_string() });
        };
        e.h.recognize(ocr(&app)?, &opts, &Hook { on: Some(&send), cancel: Some(&e.cancel) })
    })
    .await
}

#[tauri::command]
pub fn omr_cancel(state: tauri::State<'_, OmrState>, id: u32) -> Result<(), String> {
    entry(&state, id)?.cancel.store(true, Ordering::Relaxed);
    Ok(())
}

/// 会话操作（五线谱；各操作见 `omr-engine::Handle::session`）。
#[tauri::command]
pub async fn omr_session(app: tauri::AppHandle, state: tauri::State<'_, OmrState>, id: u32, op: Value) -> Result<Value, String> {
    let e = entry(&state, id)?;
    blocking(move || e.h.session(op, || ocr(&app))).await
}
