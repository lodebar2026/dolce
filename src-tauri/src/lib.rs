use svg2pdf::{usvg, ConversionOptions, PageOptions};
use lopdf::{Document, Object, ObjectId};
use tauri::Manager;

/// Build usvg options with system fonts + bundled Bravura.otf embedded.
fn build_usvg_options(app_handle: &tauri::AppHandle) -> usvg::Options<'_> {
    let mut options = usvg::Options::default();
    options.fontdb_mut().load_system_fonts();
    // Load bundled Bravura.otf from Tauri resources
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        let bravura = res_dir.join("Bravura.otf");
        if bravura.exists() {
            options.fontdb_mut().load_font_file(&bravura).ok();
        }
    }
    options
}

/// Convert a single SVG string to a single-page PDF (bytes).
fn svg_to_pdf_bytes(svg_str: &str, options: &usvg::Options<'_>) -> Result<Vec<u8>, String> {
    let tree = usvg::Tree::from_str(svg_str, options)
        .map_err(|e| format!("usvg: {e}"))?;
    svg2pdf::to_pdf(&tree, ConversionOptions::default(), PageOptions::default())
        .map_err(|e| format!("svg2pdf: {e}"))
}

/// Merge single-page PDFs into a multi-page PDF using lopdf.
fn merge_pdf_pages(pdfs: Vec<Vec<u8>>) -> Result<Vec<u8>, String> {
    if pdfs.is_empty() {
        return Err("no pages".into());
    }
    if pdfs.len() == 1 {
        return Ok(pdfs.into_iter().next().unwrap());
    }

    // Load all source documents
    let mut docs: Vec<Document> = pdfs
        .iter()
        .map(|b| Document::load_mem(b).map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;

    // Renumber objects in each doc to avoid ID conflicts
    let mut next_id: u32 = 1;
    for doc in &mut docs {
        doc.renumber_objects_with(next_id);
        next_id += doc.max_id + 2;
    }

    // IDs for the merged document's Pages dict and Catalog
    let pages_id: ObjectId = (next_id, 0);
    next_id += 1;
    let catalog_id: ObjectId = (next_id, 0);
    next_id += 1;

    let mut merged = Document::with_version("1.5");
    let mut page_ids: Vec<ObjectId> = Vec::new();

    for doc in &docs {
        // Get the single page's ObjectId
        let page_oid: ObjectId = doc
            .get_pages()
            .get(&1)
            .copied()
            .ok_or("no page in source doc")?;
        page_ids.push(page_oid);

        // Find the old catalog/pages IDs to skip when copying
        let old_catalog_id: Option<ObjectId> = doc
            .trailer
            .get(b"Root")
            .ok()
            .and_then(|r| r.as_reference().ok());

        let old_pages_id: Option<ObjectId> = old_catalog_id
            .and_then(|cid| doc.get_object(cid).ok())
            .and_then(|obj| obj.as_dict().ok())
            .and_then(|d| d.get(b"Pages").ok())
            .and_then(|r| r.as_reference().ok());

        // Copy all objects except old catalog and pages tree
        for (&oid, obj) in &doc.objects {
            let skip = Some(oid) == old_catalog_id || Some(oid) == old_pages_id;
            if !skip {
                merged.objects.insert(oid, obj.clone());
            }
        }
    }

    // Update each page's /Parent to point to our new pages dict
    for &page_oid in &page_ids {
        if let Some(Object::Dictionary(dict)) = merged.objects.get_mut(&page_oid) {
            dict.set("Parent", Object::Reference(pages_id));
        }
    }

    // Build /Pages dictionary
    let kids: Vec<Object> = page_ids.iter().map(|&id| Object::Reference(id)).collect();
    let mut pages_dict = lopdf::Dictionary::new();
    pages_dict.set("Type", Object::Name(b"Pages".to_vec()));
    pages_dict.set("Kids", Object::Array(kids));
    pages_dict.set("Count", Object::Integer(page_ids.len() as i64));
    merged.objects.insert(pages_id, Object::Dictionary(pages_dict));

    // Build /Catalog
    let mut cat_dict = lopdf::Dictionary::new();
    cat_dict.set("Type", Object::Name(b"Catalog".to_vec()));
    cat_dict.set("Pages", Object::Reference(pages_id));
    merged.objects.insert(catalog_id, Object::Dictionary(cat_dict));

    merged.trailer.set("Root", Object::Reference(catalog_id));
    merged.max_id = next_id;

    let mut buf: Vec<u8> = Vec::new();
    merged.save_to(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

#[tauri::command]
fn export_pdf_cmd(
    pages_svg: Vec<String>,
    width_pt: f32,
    height_pt: f32,
    out_path: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let _ = (width_pt, height_pt); // embedded in SVG viewBox
    let options = build_usvg_options(&app_handle);

    let page_pdfs: Result<Vec<Vec<u8>>, String> = pages_svg
        .iter()
        .map(|svg| svg_to_pdf_bytes(svg, &options))
        .collect();
    let page_pdfs = page_pdfs?;

    let merged = merge_pdf_pages(page_pdfs)?;
    std::fs::write(&out_path, &merged).map_err(|e| e.to_string())
}

// ── 识别（`crates/omr-engine`）：Tauri 命令在 omr.rs ─────────────────────────────
mod omr;

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
            Ok(())
        });
    #[cfg(target_os = "macos")]
    let builder = builder.manage(MidiState::default());
    #[cfg(not(feature = "bench"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        export_pdf_cmd,
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
        export_pdf_cmd,
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
