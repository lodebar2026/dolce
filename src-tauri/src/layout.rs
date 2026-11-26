//! 排版接进桌面版（迁移计划 H 期）：简谱 / 五线谱排版在 Tauri 进程里跑原生 Rust（`crates/layout/src/layout.rs`），
//! 量字走系统文字引擎（`dolce_engrave::text::native`，外包浏览器口径层，与 WebView 画字对齐）。
//!
//! - **一条专用线程**：系统量字的字体注册与缓存是线程局部的（CoreText / DirectWrite），量字上下文、表层、排好的结果都归这条线程，
//!   命令把活儿递过去、等回话（[`run`]）。排版途中 panic 只丢这一单，线程照常接着干。
//! - **表层**：五线谱排版要 MusicXML 表层，它在网页侧 wasm 的句柄表里；网页按「句柄 + 代号」把快照送来（[`layout_surface`]），
//!   这里按句柄缓存（只留最近用的 [`SURFACE_KEEP`] 份）。
//! - **结果**：排好的一份留在这里（按号），概要、各页 SVG、身份表一次回给网页；场景等按需取（[`layout_get`]）。
use dolce_engrave::Env;
use dolce_model::doc::ScoreDoc;
use dolce_model::xmlsurface::Surface;
use dolce_layout::layout::{self, JianpuRequest, Laid, StaffRequest};
use dolce_engrave::scene::smufl::MetaData;
use dolce_engrave::text::MeasureCtx;
use serde_json::json;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::Manager;

/// 原生缓存的表层份数（按最近用到的淘汰）
const SURFACE_KEEP: usize = 8;

struct Host {
    mc: MeasureCtx<'static>,
    meta: MetaData,
    /// 句柄 → (代号, 表层, 最近用到的时刻)
    surfaces: HashMap<u32, (u32, Surface, u64)>,
    laid: HashMap<u32, Laid>,
    next: u32,
    tick: u64,
}

impl Host {
    fn env(&self) -> Env<'_> {
        Env { mc: &self.mc, meta: Some(&self.meta) }
    }
    /// 记下表层 `h` 用过（0 = 不要表层）；没有这份报错。
    fn touch(&mut self, h: u32) -> Result<(), String> {
        if h == 0 {
            return Ok(());
        }
        self.tick += 1;
        let tick = self.tick;
        self.surfaces.get_mut(&h).ok_or_else(|| format!("没有表层 {h}（网页侧应先送快照）"))?.2 = tick;
        Ok(())
    }
}

type Job = Box<dyn FnOnce(&mut Host) + Send>;

static WORKER: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();

/// 启动时调：起排版线程（量字注册随包的 Bravura 字体）。
pub fn setup(app: &tauri::AppHandle) {
    let redist = app.path().resource_dir().ok();
    let (tx, rx) = channel::<Job>();
    std::thread::Builder::new()
        .name("dolce-layout".into())
        .spawn(move || {
            let backend = Box::leak(Box::new(dolce_engrave::text::native::webview_measure(redist.as_deref(), &[])));
            let meta = MetaData::from_json(include_str!("../../public/redist/bravura_metadata.json")).expect("bravura_metadata.json");
            let mut host = Host { mc: MeasureCtx::new(backend), meta, surfaces: HashMap::new(), laid: HashMap::new(), next: 0, tick: 0 };
            for job in rx {
                // 一单 panic 不连累线程（缓存的借用随栈展开放掉）
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(&mut host)));
            }
        })
        .expect("起排版线程");
    let _ = WORKER.set(Mutex::new(tx));
}

/// 把活儿交给排版线程，等它回话。
async fn run<R: Send + 'static>(f: impl FnOnce(&mut Host) -> Result<R, String> + Send + 'static) -> Result<R, String> {
    let (tx, rx) = channel::<Result<R, String>>();
    let job: Job = Box::new(move |h| {
        let _ = tx.send(f(h));
    });
    WORKER.get().ok_or("排版线程没起")?.lock().map_err(|e| e.to_string())?.send(job).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or_else(|_| Err("排版出错（线程里 panic）".into())))
        .await
        .map_err(|e| e.to_string())?
}

fn header<'a>(req: &'a Request<'_>, name: &str) -> Result<&'a str, String> {
    req.headers().get(name).and_then(|v| v.to_str().ok()).ok_or_else(|| format!("缺头 {name}"))
}

/// 收一份表层快照（请求体是 wasm `modelSurfaceSnapshot` 的字节，头 `h` / `gen`）。
#[tauri::command]
pub async fn layout_surface(request: Request<'_>) -> Result<(), String> {
    let h: u32 = header(&request, "h")?.parse().map_err(|_| "头 h 不是数")?;
    let gen: u32 = header(&request, "gen")?.parse().map_err(|_| "头 gen 不是数")?;
    let InvokeBody::Raw(bytes) = request.body() else { return Err("表层快照要二进制请求体".into()) };
    let surface: Surface = bincode::deserialize(bytes).map_err(|e| format!("表层快照：{e}"))?;
    run(move |host| {
        host.tick += 1;
        host.surfaces.insert(h, (gen, surface, host.tick));
        while host.surfaces.len() > SURFACE_KEEP {
            let Some((&old, _)) = host.surfaces.iter().filter(|(&k, _)| k != h).min_by_key(|(_, x)| x.2) else { break };
            host.surfaces.remove(&old);
        }
        Ok(())
    })
    .await
}

/// 原生这边有的表层代号（没有回 null）：网页按它判断要不要重送快照。
#[tauri::command]
pub async fn layout_surface_gen(h: u32) -> Result<Option<u32>, String> {
    run(move |host| Ok(host.surfaces.get(&h).map(|x| x.0))).await
}

/// 排一份：`kind` 是 `jianpu` / `staff`，`doc` 是 `ScoreDoc` JSON、`req` 是对应的请求 JSON，`surface` 是表层句柄（0 = 没有）。
/// 回 JSON 字节 `{id, info, svgs: [...], hits: [[...]...]}`。
#[tauri::command]
pub async fn layout_run(kind: String, doc: String, surface: u32, req: String) -> Result<Response, String> {
    run(move |host| {
        let doc: ScoreDoc = serde_json::from_str(&doc).map_err(|e| format!("ScoreDoc：{e}"))?;
        let laid = match kind.as_str() {
            "jianpu" => {
                let req: JianpuRequest = serde_json::from_str(&req).map_err(|e| format!("JianpuRequest：{e}"))?;
                layout::layout_jianpu_doc(&doc, &req, &host.env())?
            }
            "staff" => {
                let req: StaffRequest = serde_json::from_str(&req).map_err(|e| format!("StaffRequest：{e}"))?;
                host.touch(surface)?;
                let s = if surface == 0 { None } else { host.surfaces.get(&surface).map(|x| &x.1) };
                layout::layout_staff_doc(&doc, s, &req, &host.env())?
            }
            k => return Err(format!("不认得的排版路 {k}")),
        };
        let n = laid.pages.len();
        let svgs: Vec<String> = (0..n).map(|i| laid.svg(i).unwrap_or_default()).collect();
        let hits: Vec<_> = (0..n).map(|i| laid.hits(i).unwrap_or_default()).collect();
        host.next += 1;
        let id = host.next;
        let body = json!({ "id": id, "info": laid.info(), "svgs": svgs, "hits": hits });
        host.laid.insert(id, laid);
        Ok(Response::new(serde_json::to_vec(&body).map_err(|e| e.to_string())?))
    })
    .await
}

/// 取排好那份的一样：`scene`（第 `i` 页场景）、`grid`（简谱定稿栅格）、`placed`（简谱定位结构）。回 JSON 字节（没有为 `null`）。
#[tauri::command]
pub async fn layout_get(id: u32, what: String, i: u32) -> Result<Response, String> {
    run(move |host| {
        let laid = host.laid.get(&id).ok_or_else(|| format!("没有排版结果 {id}"))?;
        let v = match what.as_str() {
            "scene" => laid.pages.get(i as usize).map(|p| serde_json::to_value(p).expect("场景可序列化")),
            "grid" => laid.jianpu.as_ref().map(|j| j.metrics.to_json()),
            "placed" => laid.jianpu.as_ref().map(|j| dolce_layout_jianpu::placedjson::placed_json(&j.placed)),
            w => return Err(format!("不认得的取法 {w}")),
        };
        Ok(Response::new(serde_json::to_vec(&v).map_err(|e| e.to_string())?))
    })
    .await
}

/// 放掉排好的一份。
#[tauri::command]
pub async fn layout_free(id: u32) -> Result<(), String> {
    run(move |host| {
        host.laid.remove(&id);
        Ok(())
    })
    .await
}

/// 清量字缓存（网页字体载完、换了字体时，同 wasm `clearMeasureCache`）。
#[tauri::command]
pub async fn layout_clear_measure() -> Result<(), String> {
    run(|host| {
        host.mc.clear();
        Ok(())
    })
    .await
}

/// 按参照歌词生成段落标记与 `%%sing`（同 wasm `singFromLyrics`；试排投影档要量字，所以也在排版线程上跑）。回 JSON 字节。
#[tauri::command]
pub async fn layout_sing_from_lyrics(doc: String, song: u32, lyrics: String, req: String) -> Result<Response, String> {
    run(move |host| {
        let v = dolce_layout::sing::sing_from_lyrics_json(&doc, song as usize, &lyrics, &req, &host.env())?;
        Ok(Response::new(serde_json::to_vec(&v).map_err(|e| e.to_string())?))
    })
    .await
}
