use tauri::Manager;

/// 编辑器「导出 PDF」的一页：场景（`dolce_scene::Page`，前端 `scenejson.ts::pageScenes` 出的形状）+ 纸的大小（pt）
#[derive(serde::Deserialize)]
struct ScenePageIn {
    scene: dolce_scene::Page,
    w: f64,
    h: f64,
}

/// 场景 → 矢量 PDF（`dolce_export::scene`，krilla 写、字体按系统字体库 + 随包 Bravura 选，嵌不了的转曲并叠不可见文字层）
#[tauri::command]
fn export_scene_pdf(pages: Vec<ScenePageIn>, bg: Option<f64>, title: Option<String>, out_path: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let mut book = dolce_export::fonts::FontBook::system();
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        let bravura = res_dir.join("Bravura.otf");
        if bravura.exists() {
            book.add_file(&bravura).map_err(|e| format!("Bravura：{e}"))?;
        }
    }
    let pages: Vec<dolce_export::scene::ScenePage> = pages.into_iter().map(|p| dolce_export::scene::ScenePage { scene: p.scene, w_pt: p.w, h_pt: p.h }).collect();
    let info = dolce_export::pdf::DocInfo { title, outline: Vec::new() };
    let (bytes, _report) = dolce_export::scene::scene_pdf(&book, &pages, bg, &info)?;
    std::fs::write(&out_path, &bytes).map_err(|e| e.to_string())
}

// ── 识别（`crates/omr-engine`）：Tauri 命令在 omr.rs ─────────────────────────────
mod omr;

// ── 排版（`crates/dolce-session`）：原生排版线程与命令在 layout.rs ─────────────────
mod layout;

// 会话池在 `omr::infer`（每个模型 `DOLCE_OCR_SESS` 个会话 × `DOLCE_OCR_THREADS` 线程，缺省 3 × 3）。
// 实测（10 核 Mac，现跑合唱谱）1×4 → 3×3：宁静 19.2→17.1 s、破碎扫描 37.8→32.1 s；2×4、2×2 介于其间。会话按需建（没争用不建第二个）。

// ---------------- 测速构建（cargo feature `bench`，正式构建不编） ----------------
// 前端启动时试调 `bench_config`：拿到配置（环境变量 DOLCE_BENCH 指的 JSON 文件）就自动逐份识别、
// 把结果写回文件后退出（`src/editor/desktopbench.ts`）。这里给读写文件与退出。
#[cfg(feature = "bench")]
mod bench {
    /// 测速配置（DOLCE_BENCH 指的 JSON 文件内容）；没设为 None。
    #[tauri::command]
    pub fn bench_config() -> Option<String> {
        std::env::var("DOLCE_BENCH").ok().and_then(|p| std::fs::read_to_string(p).ok())
    }
    #[tauri::command]
    pub fn bench_read(path: String) -> Result<tauri::ipc::Response, String> {
        std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| format!("{path}: {e}"))
    }
    #[tauri::command]
    pub fn bench_write(path: String, text: String) -> Result<(), String> {
        std::fs::write(&path, text).map_err(|e| format!("{path}: {e}"))
    }
    #[tauri::command]
    pub fn bench_exit(app: tauri::AppHandle) {
        app.exit(0);
    }
}

// ---------------- MIDI playback (macOS AVMIDIPlayer) ----------------
// Plays a Standard MIDI File (bytes) through AVFoundation's built-in DLS GM sound
// bank — much fuller timbre than a bare Web Audio oscillator. The player must be
// kept alive (held in managed state) or it stops the moment it is dropped.

#[cfg(target_os = "macos")]
struct MidiPlayer(objc2::rc::Retained<objc2_avf_audio::AVMIDIPlayer>);
// AVFoundation objects are safe to drive across threads; Retained<_> is marked
// !Send only out of caution. We only ever create/stop from Tauri command threads.
#[cfg(target_os = "macos")]
unsafe impl Send for MidiPlayer {}
#[cfg(target_os = "macos")]
unsafe impl Sync for MidiPlayer {}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct MidiState(std::sync::Mutex<Option<MidiPlayer>>);

#[cfg(target_os = "macos")]
#[tauri::command]
fn midi_play_cmd(
    bytes: Vec<u8>,
    start_seconds: f64,
    state: tauri::State<MidiState>,
) -> Result<(), String> {
    use objc2::AnyThread;
    use objc2_avf_audio::AVMIDIPlayer;
    use objc2_foundation::NSData;

    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(prev) = guard.take() {
        unsafe { prev.0.stop() };
    }
    let data = NSData::with_bytes(&bytes);
    let player = unsafe {
        AVMIDIPlayer::initWithData_soundBankURL_error(AVMIDIPlayer::alloc(), &data, None)
    }
    .map_err(|e| format!("AVMIDIPlayer init: {e:?}"))?;
    unsafe {
        player.prepareToPlay();
        if start_seconds > 0.0 {
            player.setCurrentPosition(start_seconds); // seek to the selected note
        }
        player.play(std::ptr::null_mut());
    }
    *guard = Some(MidiPlayer(player));
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn midi_stop_cmd(state: tauri::State<MidiState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(prev) = guard.take() {
        unsafe { prev.0.stop() };
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn midi_play_cmd(_bytes: Vec<u8>, _start_seconds: f64) -> Result<(), String> {
    Err("native MIDI playback is only available on macOS".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn midi_stop_cmd() -> Result<(), String> {
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(omr::OmrState::default())
        .setup(|app| {
            omr::setup(app.handle());
            layout::setup(app.handle());
            Ok(())
        });
    #[cfg(target_os = "macos")]
    let builder = builder.manage(MidiState::default());
    #[cfg(not(feature = "bench"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        export_scene_pdf,
        layout::layout_surface,
        layout::layout_surface_gen,
        layout::layout_run,
        layout::layout_get,
        layout::layout_free,
        layout::layout_clear_measure,
        layout::layout_sing_from_lyrics,
        omr::omr_open,
        omr::omr_close,
        omr::omr_render,
        omr::omr_binary,
        omr::omr_recognize,
        omr::omr_cancel,
        omr::omr_session,
        midi_play_cmd,
        midi_stop_cmd
    ]);
    #[cfg(feature = "bench")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        export_scene_pdf,
        layout::layout_surface,
        layout::layout_surface_gen,
        layout::layout_run,
        layout::layout_get,
        layout::layout_free,
        layout::layout_clear_measure,
        layout::layout_sing_from_lyrics,
        omr::omr_open,
        omr::omr_close,
        omr::omr_render,
        omr::omr_binary,
        omr::omr_recognize,
        omr::omr_cancel,
        omr::omr_session,
        midi_play_cmd,
        midi_stop_cmd,
        bench::bench_config,
        bench::bench_read,
        bench::bench_write,
        bench::bench_exit
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
