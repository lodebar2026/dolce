//! 按送检画面内容寻址的 OCR 结果缓存：键 = 用法 + 画面尺寸与像素的指纹（+ 参数），值 = 结果（JSON）。
//! 回归第二次起不推理；识别判据一动、切出的条变了，键自然落空（不会读到过时的结果）。
//! 缓存与识别解耦：[`CachedOcr`] 包在 [`Ocr`] 外面，没有模型时（只读缓存的回归）未命中就报错，不编造。
use crate::surface::Gray;
use crate::{CharPos, Ocr, RankedChar};
use dolce_omr_core::image::Rect;
use serde::{de::DeserializeOwned, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 画面指纹：FNV-1a 64 过尺寸与像素。
pub fn content_key(tag: &str, g: &Gray, extra: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |b: u8| {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    };
    for b in (g.w as u32).to_le_bytes().into_iter().chain((g.h as u32).to_le_bytes()) {
        eat(b);
    }
    for &v in &g.data {
        eat(v);
    }
    format!("{tag}{}x{}-{h:016x}{extra}", g.w, g.h)
}

/// 一份缓存（一个 JSON 文件）。多线程共用，`save` 时整份写回（先写临时文件再改名）。
pub struct OcrCache {
    path: Option<PathBuf>,
    map: Mutex<HashMap<String, serde_json::Value>>,
    dirty: Mutex<bool>,
}

impl OcrCache {
    pub fn memory() -> Self {
        OcrCache { path: None, map: Mutex::new(HashMap::new()), dirty: Mutex::new(false) }
    }

    pub fn open(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let map = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        OcrCache { path: Some(path), map: Mutex::new(map), dirty: Mutex::new(false) }
    }

    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.map.lock().ok()?.get(key).and_then(|v| serde_json::from_value(v.clone()).ok())
    }

    pub fn put<T: Serialize>(&self, key: String, v: &T) {
        if let (Ok(mut m), Ok(val)) = (self.map.lock(), serde_json::to_value(v)) {
            m.insert(key, val);
            if let Ok(mut d) = self.dirty.lock() {
                *d = true;
            }
        }
    }

    pub fn len(&self) -> usize {
        self.map.lock().map(|m| m.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 有新条目才写回。
    pub fn save(&self) -> Result<(), String> {
        let (Some(path), true) = (&self.path, self.dirty.lock().map(|d| *d).unwrap_or(false)) else { return Ok(()) };
        let m = self.map.lock().map_err(|_| "缓存锁中毒")?;
        let ordered: std::collections::BTreeMap<_, _> = m.iter().collect();
        write_atomic(path, serde_json::to_vec(&ordered).map_err(|e| e.to_string())?.as_slice())?;
        *self.dirty.lock().map_err(|_| "缓存锁中毒")? = false;
        Ok(())
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 一次送检请求（缓存未命中时攒下来，分轮一批推理）。
#[derive(Clone, Debug)]
pub enum OcrReq {
    /// 文本条贪心解码（键 `L`）
    Line(Gray),
    /// 同一条的贪心解码与逐字前 k 名（键 `L` + `R…k`，只推理一次）
    LineRank(Gray, usize),
    /// 逐字前 k 名（键 `R…k`）
    Rank(Gray, usize),
    /// 数字格（键 `D`，成批推理）
    Cell(Gray),
    /// 整个画面检测（键 `E`）
    Detect(Gray),
    /// 整页分块检测（键 `P…s`）
    DetectTiled(Gray, f64),
}

impl OcrReq {
    /// 主键（去重用）。
    pub fn key(&self) -> String {
        match self {
            OcrReq::Line(g) => content_key("L", g, ""),
            OcrReq::LineRank(g, k) => content_key("R", g, &format!("k{k}")),
            OcrReq::Rank(g, k) => content_key("R", g, &format!("k{k}")),
            OcrReq::Cell(g) => content_key("D", g, ""),
            OcrReq::Detect(g) => content_key("E", g, ""),
            OcrReq::DetectTiled(g, s) => content_key("P", g, &format!("s{s}")),
        }
    }

    /// 二进制编码（网页版在 Worker 之间传）：`u8 种类` `u32 k` `f64 缩放` `u32 宽` `u32 高` 像素。
    pub fn encode(&self, out: &mut Vec<u8>) {
        let (tag, g, k, s) = match self {
            OcrReq::Line(g) => (0u8, g, 0, 0.0),
            OcrReq::LineRank(g, k) => (1, g, *k, 0.0),
            OcrReq::Rank(g, k) => (2, g, *k, 0.0),
            OcrReq::Cell(g) => (3, g, 0, 0.0),
            OcrReq::Detect(g) => (4, g, 0, 0.0),
            OcrReq::DetectTiled(g, s) => (5, g, 0, *s),
        };
        out.push(tag);
        out.extend((k as u32).to_le_bytes());
        out.extend(s.to_le_bytes());
        out.extend((g.w as u32).to_le_bytes());
        out.extend((g.h as u32).to_le_bytes());
        out.extend(&g.data);
    }

    /// [`OcrReq::encode`] 的逆；回 (请求, 读过的字节数)。
    pub fn decode(b: &[u8]) -> Option<(OcrReq, usize)> {
        let u32_at = |o: usize| Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?) as usize);
        let tag = *b.first()?;
        let k = u32_at(1)?;
        let s = f64::from_le_bytes(b.get(5..13)?.try_into().ok()?);
        let (w, h) = (u32_at(13)?, u32_at(17)?);
        let g = Gray { w, h, data: b.get(21..21 + w * h)?.to_vec() };
        let r = match tag {
            0 => OcrReq::Line(g),
            1 => OcrReq::LineRank(g, k),
            2 => OcrReq::Rank(g, k),
            3 => OcrReq::Cell(g),
            4 => OcrReq::Detect(g),
            5 => OcrReq::DetectTiled(g, s),
            _ => return None,
        };
        Some((r, 21 + w * h))
    }
}

/// 一组请求编成一段字节：`u32 个数` + 各请求。
pub fn encode_reqs(reqs: &[OcrReq]) -> Vec<u8> {
    let mut out = (reqs.len() as u32).to_le_bytes().to_vec();
    for r in reqs {
        r.encode(&mut out);
    }
    out
}

/// [`encode_reqs`] 的逆。
pub fn decode_reqs(b: &[u8]) -> Option<Vec<OcrReq>> {
    let n = u32::from_le_bytes(b.get(0..4)?.try_into().ok()?) as usize;
    let mut off = 4;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let (r, used) = OcrReq::decode(&b[off..])?;
        out.push(r);
        off += used;
    }
    Some(out)
}

/// 数字格批量推理每批多少格（同 `Ocr::read_cells` 内部分批）。
const CELL_BATCH: usize = 8;

/// 推理一组请求，回 (缓存键, 结果) 各条（一条请求可出两条：`LineRank`）。数字格并成批。
pub fn exec(ocr: &Ocr, reqs: &[OcrReq]) -> Result<Vec<(String, serde_json::Value)>, String> {
    let mut out = Vec::new();
    let cells: Vec<&Gray> = reqs.iter().filter_map(|r| if let OcrReq::Cell(g) = r { Some(g) } else { None }).collect();
    for chunk in cells.chunks(CELL_BATCH) {
        let got = ocr.read_cells(&chunk.iter().map(|g| (*g).clone()).collect::<Vec<_>>())?;
        for (g, s) in chunk.iter().zip(got) {
            out.push((content_key("D", g, ""), val(&s)?));
        }
    }
    for r in reqs {
        let full = |g: &Gray| Rect::new(0.0, 0.0, g.w as f64, g.h as f64);
        match r {
            OcrReq::Cell(_) => {}
            OcrReq::Line(g) => out.push((r.key(), val(&ocr.read_lines(std::slice::from_ref(g))?.remove(0))?)),
            OcrReq::LineRank(g, k) => {
                let (l, rk) = ocr.read_rank(g, *k)?;
                out.push((content_key("L", g, ""), val(&l)?));
                out.push((r.key(), val(&rk)?));
            }
            OcrReq::Rank(g, k) => out.push((r.key(), val(&ocr.rank_chars(g, *k)?)?)),
            OcrReq::Detect(g) => out.push((r.key(), val(&ocr.detect(g, full(g))?)?)),
            OcrReq::DetectTiled(g, s) => out.push((r.key(), val(&ocr.detect_tiled(g, full(g), *s)?)?)),
        }
    }
    Ok(out)
}

fn val<T: Serialize>(v: &T) -> Result<serde_json::Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// 未命中时攒请求、不推理（[`CachedOcr::rounds`] 里）回的错误。
pub const DEFERRED: &str = "OCR 待批量推理";

/// 分轮预取最多几轮（再多就退回逐条推理：保证收敛）。
const MAX_ROUNDS: usize = 40;

/// OCR + 缓存：先查缓存，未命中再推理并记下；没有模型（只读缓存）时未命中报错。
pub struct CachedOcr {
    pub ocr: Option<Ocr>,
    pub cache: OcrCache,
    /// 攒请求中（分轮预取的一轮里）：未命中记在这里、回 [`DEFERRED`]
    pending: Mutex<Option<Vec<OcrReq>>>,
}

impl CachedOcr {
    pub fn new(ocr: Option<Ocr>, cache: OcrCache) -> Self {
        CachedOcr { ocr, cache, pending: Mutex::new(None) }
    }

    /// 未命中：攒请求中就记下回 [`DEFERRED`]；否则就地推理写进缓存。
    fn miss(&self, req: OcrReq) -> Result<(), String> {
        if let Ok(mut p) = self.pending.lock() {
            if let Some(v) = p.as_mut() {
                v.push(req);
                return Err(DEFERRED.into());
            }
        }
        let ocr = self.ocr.as_ref().ok_or_else(|| format!("OCR 缓存未命中（{}），且没有加载模型", req.key()))?;
        self.put_all(exec(ocr, std::slice::from_ref(&req))?);
        Ok(())
    }

    fn through<T: DeserializeOwned>(&self, key: String, req: impl FnOnce() -> OcrReq) -> Result<T, String> {
        if let Some(v) = self.cache.get(&key) {
            return Ok(v);
        }
        self.miss(req())?;
        self.cache.get(&key).ok_or_else(|| format!("OCR 结果没写进缓存（{key}）"))
    }

    /// 推理结果写进缓存。
    pub fn put_all(&self, got: Vec<(String, serde_json::Value)>) {
        for (k, v) in got {
            self.cache.put(k, &v);
        }
    }

    pub fn read_line(&self, strip: &Gray) -> Result<Vec<CharPos>, String> {
        self.through(content_key("L", strip, ""), || OcrReq::Line(strip.clone()))
    }

    /// 同一条的贪心解码与逐字前 `k` 名（两样都缺时只推理一次）。
    pub fn read_line_ranked(&self, strip: &Gray, k: usize) -> Result<(Vec<CharPos>, Vec<RankedChar>), String> {
        let (lk, rk) = (content_key("L", strip, ""), content_key("R", strip, &format!("k{k}")));
        if let (Some(l), Some(r)) = (self.cache.get(&lk), self.cache.get(&rk)) {
            return Ok((l, r));
        }
        self.miss(OcrReq::LineRank(strip.clone(), k))?;
        Ok((self.cache.get(&lk).ok_or("OCR 结果没写进缓存")?, self.cache.get(&rk).ok_or("OCR 结果没写进缓存")?))
    }

    pub fn read_cell(&self, cell: &Gray) -> Result<String, String> {
        Ok(self.read_cells(std::slice::from_ref(cell))?.remove(0))
    }

    /// 数字格批量：命中的直接取，未命中的一批送检。
    pub fn read_cells(&self, cells: &[Gray]) -> Result<Vec<String>, String> {
        let keys: Vec<String> = cells.iter().map(|c| content_key("D", c, "")).collect();
        let mut out: Vec<Option<String>> = keys.iter().map(|k| self.cache.get(k)).collect();
        let miss: Vec<usize> = (0..cells.len()).filter(|&i| out[i].is_none()).collect();
        if !miss.is_empty() {
            let reqs: Vec<OcrReq> = miss.iter().map(|&i| OcrReq::Cell(cells[i].clone())).collect();
            if let Ok(mut p) = self.pending.lock() {
                if let Some(v) = p.as_mut() {
                    v.extend(reqs);
                    return Err(DEFERRED.into());
                }
            }
            let ocr = self.ocr.as_ref().ok_or_else(|| format!("OCR 缓存未命中 {} 格，且没有加载模型", miss.len()))?;
            self.put_all(exec(ocr, &reqs)?);
            for &i in &miss {
                out[i] = self.cache.get(&keys[i]);
            }
        }
        Ok(out.into_iter().map(Option::unwrap_or_default).collect())
    }

    pub fn rank_chars(&self, strip: &Gray, k: usize) -> Result<Vec<RankedChar>, String> {
        self.through(content_key("R", strip, &format!("k{k}")), || OcrReq::Rank(strip.clone(), k))
    }

    /// 检测整个画面（`detect` 的区域取全图）。
    pub fn detect(&self, src: &Gray) -> Result<Vec<Rect>, String> {
        self.through(content_key("E", src, ""), || OcrReq::Detect(src.clone()))
    }

    pub fn detect_tiled(&self, src: &Gray, scale: f64) -> Result<Vec<Rect>, String> {
        self.through(content_key("P", src, &format!("s{scale}")), || OcrReq::DetectTiled(src.clone(), scale))
    }

    /// 攒请求中且这一轮已经缺了 OCR：识别在阶段之间查它，前一阶段的结果不全就不往下算（下游拿残缺的结果切出的条
    /// 多半与最后一轮不同，白推理），回 [`DEFERRED`] 等下一轮。
    pub fn stalled(&self) -> bool {
        self.pending.lock().is_ok_and(|p| p.as_ref().is_some_and(|v| !v.is_empty()))
    }

    /// 同 [`CachedOcr::stalled`]，缺了回 `Err(DEFERRED)`（阶段之间 `?` 用）。
    pub fn barrier(&self) -> Result<(), String> {
        if self.stalled() {
            Err(DEFERRED.into())
        } else {
            Ok(())
        }
    }

    /// 开始攒请求：此后未命中不推理，记下来回 [`DEFERRED`]。
    pub fn begin_defer(&self) {
        if let Ok(mut p) = self.pending.lock() {
            *p = Some(Vec::new());
        }
    }

    /// 停止攒请求，交出攒下的（按主键去重）。
    pub fn end_defer(&self) -> Vec<OcrReq> {
        let v = self.pending.lock().ok().and_then(|mut p| p.take()).unwrap_or_default();
        let mut seen = std::collections::HashSet::new();
        v.into_iter().filter(|r| seen.insert(r.key())).collect()
    }

    /// 分轮预取：只查缓存跑一遍 `f`，未命中的送检请求攒起来一批推理（`fill`：原生多线程、网页分给几个 Worker），
    /// 再跑，直到一轮里不再缺。最后一轮全部命中，结果与逐条推理逐字一致（缓存按画面内容寻址）。
    /// 识别各处的 OCR 前后相依（先认出数字行才切得出歌词条），所以要几轮；前几轮的结果丢掉，只为攒请求。
    /// 没有模型时（只读缓存的回归）直接跑。`fill` 出错或轮数过多时退回逐条推理再跑一遍。
    pub fn rounds<R>(&self, mut f: impl FnMut() -> R, mut fill: impl FnMut(&CachedOcr, Vec<OcrReq>) -> Result<(), String>) -> R {
        // `OMR_OCR_SEQ`：不分轮、逐条推理（对照用）
        if self.ocr.is_none() || std::env::var("OMR_OCR_SEQ").is_ok() {
            return f();
        }
        let dbg = std::env::var("OMR_OCR_ROUNDS").is_ok();
        for i in 0..MAX_ROUNDS {
            let t0 = std::time::Instant::now();
            self.begin_defer();
            let r = f();
            let reqs = self.end_defer();
            let t1 = std::time::Instant::now();
            if reqs.is_empty() {
                if dbg {
                    eprintln!("第 {} 轮 识别 {:.0} ms，齐了", i + 1, (t1 - t0).as_secs_f64() * 1e3);
                }
                return r;
            }
            let n = reqs.len();
            let ok = fill(self, reqs).is_ok();
            if dbg {
                eprintln!("第 {} 轮 识别 {:.0} ms，缺 {n} 条，推理 {:.0} ms", i + 1, (t1 - t0).as_secs_f64() * 1e3, t1.elapsed().as_secs_f64() * 1e3);
            }
            if !ok {
                break;
            }
        }
        f()
    }

    /// 本机推理一批请求：分给 `threads` 个线程（各后端自己管会话池），结果写进缓存。
    pub fn fill_local(&self, reqs: Vec<OcrReq>, threads: usize) -> Result<(), String> {
        let ocr = self.ocr.as_ref().ok_or("没有加载模型")?;
        let jobs = jobs(reqs);
        #[cfg(not(target_arch = "wasm32"))]
        if threads > 1 && jobs.len() > 1 {
            use std::sync::atomic::{AtomicUsize, Ordering};
            let next = AtomicUsize::new(0);
            let err: Mutex<Option<String>> = Mutex::new(None);
            std::thread::scope(|s| {
                for _ in 0..threads.min(jobs.len()) {
                    s.spawn(|| loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(j) = jobs.get(i) else { break };
                        let r = exec(ocr, j);
                        match r {
                            Ok(got) => self.put_all(got),
                            Err(e) => {
                                if let Ok(mut x) = err.lock() {
                                    *x = Some(e);
                                }
                                break;
                            }
                        }
                    });
                }
            });
            return match err.into_inner().ok().flatten() {
                Some(e) => Err(e),
                None => Ok(()),
            };
        }
        let _ = threads;
        for j in &jobs {
            self.put_all(exec(ocr, j)?);
        }
        Ok(())
    }
}

/// 一批请求分成各自独立推理的活：数字格按批切，其余一条一份；按估计的算量从大到小排（大活先派，免得落在一轮末尾拖着）。
pub fn jobs(reqs: Vec<OcrReq>) -> Vec<Vec<OcrReq>> {
    let (cells, rest): (Vec<OcrReq>, Vec<OcrReq>) = reqs.into_iter().partition(|r| matches!(r, OcrReq::Cell(_)));
    let mut jobs: Vec<Vec<OcrReq>> = cells.chunks(CELL_BATCH).map(|c| c.to_vec()).collect();
    jobs.extend(rest.into_iter().map(|r| vec![r]));
    jobs.sort_by_key(|j| std::cmp::Reverse(j.iter().map(req_cost).sum::<usize>()));
    jobs
}

/// 一条请求估计的算量（相对单位：一条 320 宽的常规文本条记 320）。rec 的算量随张量宽线性涨；
/// 宽过 320 的长条走符号形状的计划，比定形计划慢四五倍；一个数字格约是常规条的六分之一；检测按像素算。
fn req_cost(r: &OcrReq) -> usize {
    let strip = |g: &Gray| {
        let tw = (48.0 * g.w as f64 / g.h.max(1) as f64).ceil() as usize;
        if tw <= 320 {
            320
        } else {
            tw * 4
        }
    };
    match r {
        OcrReq::Line(g) | OcrReq::LineRank(g, _) | OcrReq::Rank(g, _) => strip(g),
        OcrReq::Cell(_) => 50,
        OcrReq::Detect(g) | OcrReq::DetectTiled(g, _) => g.w * g.h / 100,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_and_roundtrip() {
        let a = Gray::new(3, 2, 255);
        let mut b = a.clone();
        b.data[0] = 0;
        assert_ne!(content_key("L", &a, ""), content_key("L", &b, ""));
        let c = CachedOcr::new(None, OcrCache::memory());
        assert!(c.read_line(&a).is_err());
        c.cache.put(content_key("L", &a, ""), &vec![CharPos { ch: "主".into(), x0: 0.1, x1: 0.4 }]);
        assert_eq!(c.read_line(&a).unwrap()[0].ch, "主");
    }
}
