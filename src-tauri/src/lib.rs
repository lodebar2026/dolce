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

// ── 简谱 OMR 原生 OCR 推理（onnxruntime via ort）─────────────────────────────
// 前端 paddleocr.ts 在 Tauri 下把预处理好的输入张量经二进制 IPC 交来，这里用原生 onnxruntime
// 跑 session.run 再把 logits 传回（CTC 解码/几何仍在前端）。比浏览器 wasm 多线程快 ~3×。
//
// 二进制协议（避开 JSON 序列化大数组的开销）——
//   请求体: [model u8(0=rec,1=det)][ndims u8][dims i32×ndims (LE)][f32 data (LE)]
//   响应体: [ndims u8][dims i32×ndims (LE)][f32 data (LE)]
use std::sync::Mutex;

/// 每个模型一个**会话池**：前端多页并行时各页的 OCR 同时到来，一把锁会让它们排队。
/// 池大小 `DOLCE_OCR_SESS`（缺省 3）、每个会话的算子线程数 `DOLCE_OCR_THREADS`（缺省 3）可调。
/// 实测（10 核 Mac，现跑合唱谱）1×4 → 3×3：宁静 19.2→17.1 s、破碎扫描 37.8→32.1 s；2×4、2×2 介于其间。会话按需建（没争用不建第二个）。
/// 同一模型、同样的线程数，换哪个会话推理结果都一样（各会话独立、不共享状态）。
type SessPool = Vec<Mutex<Option<ort::session::Session>>>;
static REC_SESS: std::sync::OnceLock<SessPool> = std::sync::OnceLock::new();
static DET_SESS: std::sync::OnceLock<SessPool> = std::sync::OnceLock::new();
static POOL_NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn env_usize(name: &str, def: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).filter(|&v| v > 0).unwrap_or(def)
}
fn sess_pool(slot: &'static std::sync::OnceLock<SessPool>) -> &'static SessPool {
    slot.get_or_init(|| (0..env_usize("DOLCE_OCR_SESS", 3)).map(|_| Mutex::new(None)).collect())
}
/// 取一个空闲会话（都忙就按轮转排到其中一个上等）。
fn lock_sess(pool: &'static SessPool) -> Result<std::sync::MutexGuard<'static, Option<ort::session::Session>>, String> {
    for m in pool {
        if let Ok(g) = m.try_lock() {
            return Ok(g);
        }
    }
    let i = POOL_NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % pool.len();
    pool[i].lock().map_err(|e| e.to_string())
}
static ORT_ENV: std::sync::OnceLock<ort::environment::Environment> = std::sync::OnceLock::new();

fn ort_env() -> Result<&'static ort::environment::Environment, String> {
    if let Some(env) = ORT_ENV.get() {
        return Ok(env);
    }
    let env = ort::init().build().map_err(|e| e.to_string())?;
    Ok(ORT_ENV.get_or_init(|| env))
}

fn ocr_model_path(app: &tauri::AppHandle, file: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("ocr").join(file))
}

fn ensure_ocr_session(
    slot: &mut Option<ort::session::Session>,
    app: &tauri::AppHandle,
    file: &str,
) -> Result<(), String> {
    if slot.is_none() {
        let path = ocr_model_path(app, file)?;
        let sess = ort::session::Session::builder(ort_env()?)
            .map_err(|e| e.to_string())?
            .with_intra_threads(env_usize("DOLCE_OCR_THREADS", 3))
            .map_err(|e| e.to_string())?
            .commit_from_file(&path)
            .map_err(|e| format!("加载模型 {} 失败: {}", path.display(), e))?;
        *slot = Some(sess);
    }
    Ok(())
}

#[inline]
fn ri32(b: &[u8], o: usize) -> i32 {
    i32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

/// 跑一次推理。model 0=rec,1=det；mode 0=完整 f32 输出，1=每时间步 argmax 索引 [N,T]（仅 rec，
/// 把 [N,T,18710] logits 的 ~18710× 传输量砍成索引）。返回 (输出维度, 输出数据字节：mode1=int32 索引，mode0=f32)。
fn infer_one(
    app: &tauri::AppHandle,
    model: i32,
    mode: i32,
    dims: Vec<i64>,
    data: Vec<f32>,
) -> Result<(Vec<i32>, Vec<u8>), String> {
    let (pool, file) = if model == 0 {
        (sess_pool(&REC_SESS), "rec.onnx")
    } else {
        (sess_pool(&DET_SESS), "det.onnx")
    };
    let mut guard = lock_sess(pool)?;
    ensure_ocr_session(&mut guard, app, file)?;
    let sess = guard.as_mut().unwrap();
    let iname = sess.inputs()[0].name().to_string();
    let oname = sess.outputs()[0].name().to_string();
    let tensor = ort::value::Tensor::from_array((dims, data)).map_err(|e| e.to_string())?;
    #[cfg(feature = "bench")]
    let t_run = std::time::Instant::now();
    let outputs = sess
        .run(ort::inputs![iname.as_str() => tensor])
        .map_err(|e| e.to_string())?;
    #[cfg(feature = "bench")]
    bench::add_run(model, t_run.elapsed());
    let (shape, out) = outputs[oname.as_str()]
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;

    if mode == 1 {
        let (bn, t, c) = (shape[0] as usize, shape[1] as usize, shape[2] as usize);
        let mut idx: Vec<i32> = Vec::with_capacity(bn * t);
        for i in 0..bn * t {
            let base = i * c;
            let mut best = 0usize;
            let mut bv = f32::NEG_INFINITY;
            for k in 0..c {
                let v = out[base + k];
                if v > bv {
                    bv = v;
                    best = k;
                }
            }
            idx.push(best as i32);
        }
        Ok((vec![bn as i32, t as i32], bytemuck::cast_slice(&idx).to_vec()))
    } else if mode & 0xff == 2 {
        // 2 | K<<8：argmax 索引 [N,T] 之外，再给每段连续非空标签（一个字）各类在段内最大分的前 K 名
        // （`paddleocr.ts::runTops` 同一算式、同一并列次序），候选排序不必回传整份 logits。
        // 输出维度 [N,T,附加字数]；数据 = int32 索引 + 逐行 int32[段数] + 逐段 int32[cls,i0,t1,kk] + kk×(int32 类,f32 分)。
        let k = (mode >> 8) as usize;
        let (bn, t, c) = (shape[0] as usize, shape[1] as usize, shape[2] as usize);
        let mut idx: Vec<i32> = Vec::with_capacity(bn * t);
        for i in 0..bn * t {
            let base = i * c;
            let mut best = 0usize;
            let mut bv = f32::NEG_INFINITY;
            for kk in 0..c {
                let v = out[base + kk];
                if v > bv {
                    bv = v;
                    best = kk;
                }
            }
            idx.push(best as i32);
        }
        let mut extra: Vec<u32> = Vec::new();
        for n in 0..bn {
            run_tops(&out[n * t * c..(n + 1) * t * c], c, &idx[n * t..(n + 1) * t], k, &mut extra);
        }
        let mut bytes: Vec<u8> = bytemuck::cast_slice(&idx).to_vec();
        bytes.extend_from_slice(bytemuck::cast_slice(&extra));
        Ok((vec![bn as i32, t as i32, extra.len() as i32], bytes))
    } else {
        let out_dims: Vec<i32> = shape.iter().map(|&d| d as i32).collect();
        Ok((out_dims, bytemuck::cast_slice(out).to_vec()))
    }
}

/// 一行 argmax `row`（长 T）按连续非空标签切段，每段取各类（1..C）段内最大分的前 `k` 名，追加到 `extra`：
/// int32[段数] + 逐段 int32[cls,i0,t1,kk] + kk×(int32 类, f32 分的位)。与 `paddleocr.ts::runTops` 同一算式：
/// 逐类插入、稳定排序（分降序）、超出弹掉末位——并列时类号小的在前。
fn run_tops(logits: &[f32], c: usize, row: &[i32], k: usize, extra: &mut Vec<u32>) {
    let t = row.len();
    let cnt_pos = extra.len();
    extra.push(0);
    let mut runs = 0u32;
    let (mut prev, mut i0) = (-1i32, 0usize);
    for ti in 0..=t {
        let best = if ti < t { row[ti] } else { -1 };
        if best == prev {
            continue;
        }
        if prev > 0 {
            let mut top: Vec<(u32, f32)> = Vec::with_capacity(k + 1);
            for cls in 1..c {
                let mut mx = f32::NEG_INFINITY;
                for tt in i0..ti {
                    let v = logits[tt * c + cls];
                    if v > mx {
                        mx = v;
                    }
                }
                if top.len() < k || mx > top[top.len() - 1].1 {
                    top.push((cls as u32, mx));
                    top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
                    if top.len() > k {
                        top.pop();
                    }
                }
            }
            extra.extend_from_slice(&[prev as u32, i0 as u32, ti as u32, top.len() as u32]);
            for (cls, v) in top {
                extra.push(cls);
                extra.push(v.to_bits());
            }
            runs += 1;
        }
        i0 = ti;
        prev = best;
    }
    extra[cnt_pos] = runs;
}

#[cfg(test)]
mod run_tops_tests {
    use super::run_tops;

    /// 规范写法：段内各类最大分，按（分降序、类号升序）全排后取前 k
    fn spec(logits: &[f32], c: usize, row: &[i32], k: usize) -> Vec<(i32, usize, usize, Vec<(u32, f32)>)> {
        let mut out = Vec::new();
        let (mut prev, mut i0) = (-1i32, 0usize);
        for ti in 0..=row.len() {
            let best = if ti < row.len() { row[ti] } else { -1 };
            if best == prev {
                continue;
            }
            if prev > 0 {
                let mut all: Vec<(u32, f32)> = (1..c)
                    .map(|cls| (cls as u32, (i0..ti).map(|tt| logits[tt * c + cls]).fold(f32::NEG_INFINITY, f32::max)))
                    .collect();
                all.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap().then(a.0.cmp(&b.0)));
                all.truncate(k);
                out.push((prev, i0, ti, all));
            }
            i0 = ti;
            prev = best;
        }
        out
    }

    #[test]
    fn matches_spec_with_ties() {
        // 伪随机 logits，分值只取少数几档，造大量并列
        let (t, c, k) = (37usize, 53usize, 10usize);
        let mut seed = 12345u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            (seed >> 16) % 7
        };
        let logits: Vec<f32> = (0..t * c).map(|_| rnd() as f32 * 0.5 - 1.0).collect();
        let row: Vec<i32> = (0..t)
            .map(|ti| {
                let mut best = 0usize;
                let mut bv = f32::NEG_INFINITY;
                for cls in 0..c {
                    if logits[ti * c + cls] > bv {
                        bv = logits[ti * c + cls];
                        best = cls;
                    }
                }
                best as i32
            })
            .collect();
        let mut extra = Vec::new();
        run_tops(&logits, c, &row, k, &mut extra);
        let want = spec(&logits, c, &row, k);
        assert_eq!(extra[0] as usize, want.len());
        let mut o = 1;
        for (cls, i0, t1, top) in want {
            assert_eq!((extra[o] as i32, extra[o + 1] as usize, extra[o + 2] as usize, extra[o + 3] as usize), (cls, i0, t1, top.len()));
            o += 4;
            for (cc, v) in top {
                assert_eq!((extra[o], f32::from_bits(extra[o + 1])), (cc, v));
                o += 2;
            }
        }
        assert_eq!(o, extra.len());
    }
}

/// 从字节流按偏移解析一个子请求 int32[model,mode,ndims,dims...] + f32[data]，返回解析结果与推进后的偏移。
fn parse_req(body: &[u8], mut off: usize) -> Result<(i32, i32, Vec<i64>, Vec<f32>, usize), String> {
    if body.len() < off + 12 {
        return Err("omr_onnx 子请求头越界".into());
    }
    let model = ri32(body, off);
    let mode = ri32(body, off + 4);
    let ndims = ri32(body, off + 8) as usize;
    off += 12;
    if body.len() < off + ndims * 4 {
        return Err("omr_onnx 维度越界".into());
    }
    let mut dims: Vec<i64> = Vec::with_capacity(ndims);
    for i in 0..ndims {
        dims.push(ri32(body, off + i * 4) as i64);
    }
    off += ndims * 4;
    let n: usize = dims.iter().map(|&d| d as usize).product();
    if body.len() < off + n * 4 {
        return Err("omr_onnx 数据越界".into());
    }
    let mut data: Vec<f32> = vec![0.0; n];
    for (i, v) in data.iter_mut().enumerate() {
        let b = off + i * 4;
        *v = f32::from_le_bytes([body[b], body[b + 1], body[b + 2], body[b + 3]]);
    }
    off += n * 4;
    Ok((model, mode, dims, data, off))
}

fn write_result(resp: &mut Vec<u8>, out_dims: &[i32], out_bytes: &[u8]) {
    resp.extend_from_slice(&(out_dims.len() as i32).to_le_bytes());
    for &d in out_dims {
        resp.extend_from_slice(&d.to_le_bytes());
    }
    resp.extend_from_slice(out_bytes);
}

fn omr_onnx_impl(app: &tauri::AppHandle, body: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(feature = "bench")]
    let t_cmd = std::time::Instant::now();
    let (model, mode, dims, data, _) = parse_req(body, 0)?;
    let (out_dims, out_bytes) = infer_one(app, model, mode, dims, data)?;
    let mut resp: Vec<u8> = Vec::with_capacity((1 + out_dims.len()) * 4 + out_bytes.len());
    write_result(&mut resp, &out_dims, &out_bytes);
    #[cfg(feature = "bench")]
    bench::add_cmd(t_cmd.elapsed(), body.len() + resp.len());
    Ok(resp)
}

/// DBNet 检测的输入归一化：RGBA 字节 → CHW f32（ImageNet mean/std）。算式照 `paddleocr.ts::detectRegion`：先按 f64 算、再存成 f32，逐位相同。
fn det_normalize(rgba: &[u8], w: usize, h: usize) -> Vec<f32> {
    const MEAN: [f64; 3] = [0.485, 0.456, 0.406];
    const STD: [f64; 3] = [0.229, 0.224, 0.225];
    let mut chw = vec![0f32; 3 * w * h];
    for y in 0..h {
        for x in 0..w {
            let p = (y * w + x) * 4;
            for c in 0..3 {
                chw[c * h * w + y * w + x] = ((rgba[p + c] as f64 / 255.0 - MEAN[c]) / STD[c]) as f32;
            }
        }
    }
    chw
}

/// 概率图 → 连通块（`> 0.3` 为前景、4 邻接，栈式遍历次序与 `paddleocr.ts::detectRegion` 相同，概率按 f64 依次累加）。
/// 每块写出 int32[minX,minY,maxX,maxY,n] + f64 概率和；筛框、外扩、排序留在 TS。
fn det_components(prob: &[f32], w: usize, h: usize, out: &mut Vec<u8>) -> u32 {
    let bm: Vec<bool> = prob.iter().map(|&v| v > 0.3).collect();
    let mut seen = vec![false; w * h];
    let mut stack: Vec<usize> = Vec::new();
    let mut count = 0u32;
    for i0 in 0..w * h {
        if !bm[i0] || seen[i0] {
            continue;
        }
        stack.clear();
        stack.push(i0);
        seen[i0] = true;
        let (mut min_x, mut min_y, mut max_x, mut max_y, mut n, mut sum) = (w, h, 0usize, 0usize, 0i32, 0f64);
        while let Some(idx) = stack.pop() {
            let (x, y) = (idx % w, idx / w);
            n += 1;
            sum += prob[idx] as f64;
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
            if x > 0 && bm[idx - 1] && !seen[idx - 1] {
                seen[idx - 1] = true;
                stack.push(idx - 1);
            }
            if x < w - 1 && bm[idx + 1] && !seen[idx + 1] {
                seen[idx + 1] = true;
                stack.push(idx + 1);
            }
            if y > 0 && bm[idx - w] && !seen[idx - w] {
                seen[idx - w] = true;
                stack.push(idx - w);
            }
            if y < h - 1 && bm[idx + w] && !seen[idx + w] {
                seen[idx + w] = true;
                stack.push(idx + w);
            }
        }
        for v in [min_x as i32, min_y as i32, max_x as i32, max_y as i32, n] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&sum.to_le_bytes());
        count += 1;
    }
    count
}

/// **DBNet 检测（只回连通块）**：请求 int32[W,H] + RGBA 字节（W×H×4，已缩到检测尺寸）；
/// 响应 int32[块数] + 逐块 (int32×5 + f64)。归一化与阈值连通域都在这边做，不再整张回传 f32 概率图。
fn omr_det_impl(app: &tauri::AppHandle, body: &[u8]) -> Result<Vec<u8>, String> {
    if body.len() < 8 {
        return Err("omr_det 请求体过短".into());
    }
    #[cfg(feature = "bench")]
    let t_cmd = std::time::Instant::now();
    let (w, h) = (ri32(body, 0) as usize, ri32(body, 4) as usize);
    if body.len() < 8 + w * h * 4 {
        return Err("omr_det 像素越界".into());
    }
    let chw = det_normalize(&body[8..8 + w * h * 4], w, h);
    let (_, bytes) = infer_one(app, 1, 0, vec![1, 3, h as i64, w as i64], chw)?;
    // Vec<u8> 不保证按 f32 对齐，逐个拼回（cast_slice 遇到不对齐会 panic）
    let prob: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let mut comps: Vec<u8> = Vec::new();
    let n = det_components(&prob, w, h, &mut comps);
    let mut resp = Vec::with_capacity(4 + comps.len());
    resp.extend_from_slice(&n.to_le_bytes());
    resp.extend_from_slice(&comps);
    #[cfg(feature = "bench")]
    bench::add_cmd(t_cmd.elapsed(), body.len() + resp.len());
    Ok(resp)
}

/// 多张量批量推理（一次 IPC 携带 N 个子请求，内部逐个 session.run）——把 Tauri 每次 ~数 ms 的往返开销
/// 从 N 次压到 1 次，同时保持逐个推理的算力最优。请求 int32[count] + count×子请求；
/// 响应 int32[count] + count×(int32[ndims,dims...]+data)。
fn omr_onnx_batch_impl(app: &tauri::AppHandle, body: &[u8]) -> Result<Vec<u8>, String> {
    if body.len() < 4 {
        return Err("omr_onnx_batch 请求体过短".into());
    }
    #[cfg(feature = "bench")]
    let t_cmd = std::time::Instant::now();
    let count = ri32(body, 0) as usize;
    let mut off = 4usize;
    let mut resp: Vec<u8> = Vec::new();
    resp.extend_from_slice(&(count as i32).to_le_bytes());
    for _ in 0..count {
        let (model, mode, dims, data, next) = parse_req(body, off)?;
        off = next;
        let (out_dims, out_bytes) = infer_one(app, model, mode, dims, data)?;
        write_result(&mut resp, &out_dims, &out_bytes);
    }
    #[cfg(feature = "bench")]
    bench::add_cmd(t_cmd.elapsed(), body.len() + resp.len());
    Ok(resp)
}

/// 原始字节请求体（推理命令都走二进制 IPC）。拷一份出来：推理挪到阻塞线程池里跑，借用带不过去。
fn raw_body(request: &tauri::ipc::Request<'_>, cmd: &str) -> Result<Vec<u8>, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(v) => Ok(v.clone()),
        _ => Err(format!("{cmd} 需要原始字节请求体")),
    }
}

/// 推理命令一律 **async + 阻塞线程池**：同步命令跑在主线程上、一个接一个，前端多页并行时各页的 OCR 只能排队；
/// 挪到 `spawn_blocking` 后几条推理可以同时进行（会话池见 `REC_SESS`）。
async fn run_blocking(app: tauri::AppHandle, body: Vec<u8>, f: fn(&tauri::AppHandle, &[u8]) -> Result<Vec<u8>, String>) -> Result<tauri::ipc::Response, String> {
    let resp = tauri::async_runtime::spawn_blocking(move || f(&app, &body)).await.map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(resp))
}

/// 单张量推理。请求 int32[model,mode,ndims,dims...]+f32[data]；响应 int32[ndims,dims...]+data。
#[tauri::command]
async fn omr_onnx(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    run_blocking(app, raw_body(&request, "omr_onnx")?, omr_onnx_impl).await
}

/// DBNet 检测（只回连通块），见 `omr_det_impl`。
#[tauri::command]
async fn omr_det(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    run_blocking(app, raw_body(&request, "omr_det")?, omr_det_impl).await
}

/// 多张量批量推理，见 `omr_onnx_batch_impl`。
#[tauri::command]
async fn omr_onnx_batch(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    run_blocking(app, raw_body(&request, "omr_onnx_batch")?, omr_onnx_batch_impl).await
}

// ---------------- 测速构建（cargo feature `bench`，正式构建不编） ----------------
// 前端启动时试调 `bench_config`：拿到配置（环境变量 DOLCE_BENCH 指的 JSON 文件）就自动逐份识别、
// 量 OCR 各段并把结果写回文件后退出（`src/editor/desktopbench.ts`）。这里给读写文件、推理计时与退出。
#[cfg(feature = "bench")]
mod bench {
    use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
    use std::time::Duration;
    /// [rec 推理 ns, rec 次数, det 推理 ns, det 次数, 命令总 ns, 命令次数, IPC 字节]
    static STATS: [AtomicU64; 7] = [const { AtomicU64::new(0) }; 7];
    pub fn add_run(model: i32, d: Duration) {
        let i = if model == 0 { 0 } else { 2 };
        STATS[i].fetch_add(d.as_nanos() as u64, Relaxed);
        STATS[i + 1].fetch_add(1, Relaxed);
    }
    pub fn add_cmd(d: Duration, bytes: usize) {
        STATS[4].fetch_add(d.as_nanos() as u64, Relaxed);
        STATS[5].fetch_add(1, Relaxed);
        STATS[6].fetch_add(bytes as u64, Relaxed);
    }

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
    /// 取并清零推理计时（毫秒）：rec / det 纯 session.run、命令整段（含解析请求与回包）、IPC 字节数。
    #[tauri::command]
    pub fn bench_ort_stats() -> serde_json::Value {
        let v: Vec<u64> = STATS.iter().map(|a| a.swap(0, Relaxed)).collect();
        let ms = |ns: u64| ns as f64 / 1e6;
        serde_json::json!({ "recRunMs": ms(v[0]), "recRuns": v[1], "detRunMs": ms(v[2]), "detRuns": v[3], "cmdMs": ms(v[4]), "cmds": v[5], "ipcBytes": v[6] })
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
        .plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "macos")]
    let builder = builder.manage(MidiState::default());
    #[cfg(not(feature = "bench"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        export_pdf_cmd,
        omr_onnx,
        omr_onnx_batch,
        omr_det,
        midi_play_cmd,
        midi_stop_cmd
    ]);
    #[cfg(feature = "bench")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        export_pdf_cmd,
        omr_onnx,
        omr_onnx_batch,
        omr_det,
        midi_play_cmd,
        midi_stop_cmd,
        bench::bench_config,
        bench::bench_read,
        bench::bench_write,
        bench::bench_ort_stats,
        bench::bench_exit
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
