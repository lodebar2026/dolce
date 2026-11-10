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

/// OCR + 缓存：先查缓存，未命中再推理并记下；没有模型（只读缓存）时未命中报错。
pub struct CachedOcr {
    pub ocr: Option<Ocr>,
    pub cache: OcrCache,
}

impl CachedOcr {
    fn through<T: Serialize + DeserializeOwned>(&self, key: String, f: impl FnOnce(&Ocr) -> Result<T, String>) -> Result<T, String> {
        if let Some(v) = self.cache.get(&key) {
            return Ok(v);
        }
        let ocr = self.ocr.as_ref().ok_or_else(|| format!("OCR 缓存未命中（{key}），且没有加载模型"))?;
        let v = f(ocr)?;
        self.cache.put(key, &v);
        Ok(v)
    }

    pub fn read_line(&self, strip: &Gray) -> Result<Vec<CharPos>, String> {
        self.through(content_key("L", strip, ""), |o| Ok(o.read_lines(std::slice::from_ref(strip))?.remove(0)))
    }

    pub fn read_cell(&self, cell: &Gray) -> Result<String, String> {
        self.through(content_key("D", cell, ""), |o| Ok(o.read_cells(std::slice::from_ref(cell))?.remove(0)))
    }

    /// 数字格批量：命中的直接取，未命中的一批送检。
    pub fn read_cells(&self, cells: &[Gray]) -> Result<Vec<String>, String> {
        let keys: Vec<String> = cells.iter().map(|c| content_key("D", c, "")).collect();
        let mut out: Vec<Option<String>> = keys.iter().map(|k| self.cache.get(k)).collect();
        let miss: Vec<usize> = (0..cells.len()).filter(|&i| out[i].is_none()).collect();
        if !miss.is_empty() {
            let ocr = self.ocr.as_ref().ok_or_else(|| format!("OCR 缓存未命中 {} 格，且没有加载模型", miss.len()))?;
            let got = ocr.read_cells(&miss.iter().map(|&i| cells[i].clone()).collect::<Vec<_>>())?;
            for (&i, s) in miss.iter().zip(got) {
                self.cache.put(keys[i].clone(), &s);
                out[i] = Some(s);
            }
        }
        Ok(out.into_iter().map(Option::unwrap_or_default).collect())
    }

    pub fn rank_chars(&self, strip: &Gray, k: usize) -> Result<Vec<RankedChar>, String> {
        self.through(content_key("R", strip, &format!("k{k}")), |o| o.rank_chars(strip, k))
    }

    /// 检测整个画面（`detect` 的区域取全图）。
    pub fn detect(&self, src: &Gray) -> Result<Vec<Rect>, String> {
        self.through(content_key("E", src, ""), |o| o.detect(src, Rect::new(0.0, 0.0, src.w as f64, src.h as f64)))
    }

    pub fn detect_tiled(&self, src: &Gray, scale: f64) -> Result<Vec<Rect>, String> {
        self.through(content_key("P", src, &format!("s{scale}")), |o| o.detect_tiled(src, Rect::new(0.0, 0.0, src.w as f64, src.h as f64), scale))
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
        let c = CachedOcr { ocr: None, cache: OcrCache::memory() };
        assert!(c.read_line(&a).is_err());
        c.cache.put(content_key("L", &a, ""), &vec![CharPos { ch: "主".into(), x0: 0.1, x1: 0.4 }]);
        assert_eq!(c.read_line(&a).unwrap()[0].ch, "主");
    }
}
