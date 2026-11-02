//! Windows：DirectWrite。一行字交给 `IDWriteTextLayout` 排：族串的头一个当主字体，其余挂进自建的回退表
//! （`IDWriteFontFallbackBuilder`，后面再接系统回退），OpenType 特性走 `IDWriteTypography`。
//! 排好以后用自己的 `IDWriteTextRenderer` 收每段字形（字体、advance、偏移、cluster 映射），
//! 笔位按 advance 累加，墨迹取字形的设计度量（黑框四边）。
//! `register_font` 按文件建的字体放在单独的字体集合里，同名族解析时优先于系统那份。

use std::cell::RefCell;

use windows::core::{implement, AsImpl, Interface, BOOL, HSTRING, PCWSTR};
use windows::Win32::Graphics::Direct2D::Common::*;
use windows::Win32::Graphics::DirectWrite::*;
use windows_numerics::Vector2;
use windows_core::{IUnknown, Ref};

use crate::{cp_positions, Ink, Measured, Metrics};

struct Dw {
    factory: IDWriteFactory2,
    system: IDWriteFontCollection,
    /// `register_font` 进来的字体文件建成的集合
    custom: Option<IDWriteFontCollection>,
    files: Vec<String>,
}

thread_local! {
    static DW: RefCell<Option<Dw>> = const { RefCell::new(None) };
}

fn with_dw<R>(f: impl FnOnce(&mut Dw) -> R) -> R {
    DW.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            unsafe {
                let factory: IDWriteFactory2 = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED).expect("DWriteCreateFactory");
                let mut system = None;
                factory.GetSystemFontCollection(&mut system, false).expect("GetSystemFontCollection");
                *slot = Some(Dw { factory, system: system.expect("system font collection"), custom: None, files: Vec::new() });
            }
        }
        f(slot.as_mut().unwrap())
    })
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn has_in(coll: &IDWriteFontCollection, family: &str) -> bool {
    let mut index = 0u32;
    let mut exists = BOOL(0);
    unsafe { coll.FindFamilyName(&HSTRING::from(family), &mut index, &mut exists) }.is_ok() && exists.as_bool()
}

/// 族名 → 它所在的集合（先按文件注册的，再系统）。
fn collection_of(dw: &Dw, family: &str) -> Option<IDWriteFontCollection> {
    if let Some(c) = &dw.custom {
        if has_in(c, family) {
            return Some(c.clone());
        }
    }
    has_in(&dw.system, family).then(|| dw.system.clone())
}

fn first_font(coll: &IDWriteFontCollection, family: &str, bold: bool, italic: bool) -> Option<IDWriteFont> {
    unsafe {
        let mut index = 0u32;
        let mut exists = BOOL(0);
        coll.FindFamilyName(&HSTRING::from(family), &mut index, &mut exists).ok()?;
        if !exists.as_bool() {
            return None;
        }
        let fam = coll.GetFontFamily(index).ok()?;
        fam.GetFirstMatchingFont(
            if bold { DWRITE_FONT_WEIGHT_BOLD } else { DWRITE_FONT_WEIGHT_NORMAL },
            DWRITE_FONT_STRETCH_NORMAL,
            if italic { DWRITE_FONT_STYLE_ITALIC } else { DWRITE_FONT_STYLE_NORMAL },
        )
        .ok()
    }
}

/// OpenType 标签（`"chws"`）→ DirectWrite 的特性标签（小端拼）。
fn feature_tag(tag: &str) -> DWRITE_FONT_FEATURE_TAG {
    let b: Vec<u8> = tag.bytes().chain(std::iter::repeat(b' ')).take(4).collect();
    DWRITE_FONT_FEATURE_TAG(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// 一段字形（`DrawGlyphRun` 收来的）。
struct Run {
    origin_x: f32,
    face: IDWriteFontFace,
    em: f32,
    glyphs: Vec<u16>,
    advances: Vec<f32>,
    /// (advanceOffset, ascenderOffset)
    offsets: Vec<(f32, f32)>,
    cluster: Vec<u16>,
    text_pos: u32,
}

#[implement(IDWriteTextRenderer)]
struct Collector {
    runs: RefCell<Vec<Run>>,
}

impl IDWritePixelSnapping_Impl for Collector_Impl {
    fn IsPixelSnappingDisabled(&self, _ctx: *const core::ffi::c_void) -> windows::core::Result<BOOL> {
        Ok(BOOL(1))
    }
    fn GetCurrentTransform(&self, _ctx: *const core::ffi::c_void, transform: *mut DWRITE_MATRIX) -> windows::core::Result<()> {
        unsafe { *transform = DWRITE_MATRIX { m11: 1.0, m12: 0.0, m21: 0.0, m22: 1.0, dx: 0.0, dy: 0.0 } };
        Ok(())
    }
    fn GetPixelsPerDip(&self, _ctx: *const core::ffi::c_void) -> windows::core::Result<f32> {
        Ok(1.0)
    }
}

impl IDWriteTextRenderer_Impl for Collector_Impl {
    fn DrawGlyphRun(
        &self,
        _ctx: *const core::ffi::c_void,
        x: f32,
        _y: f32,
        _mode: DWRITE_MEASURING_MODE,
        run: *const DWRITE_GLYPH_RUN,
        desc: *const DWRITE_GLYPH_RUN_DESCRIPTION,
        _effect: Ref<IUnknown>,
    ) -> windows::core::Result<()> {
        unsafe {
            let run = &*run;
            let desc = &*desc;
            let n = run.glyphCount as usize;
            let Some(face) = run.fontFace.as_ref() else { return Ok(()) };
            let glyphs = std::slice::from_raw_parts(run.glyphIndices, n).to_vec();
            let advances = if run.glyphAdvances.is_null() { vec![0.0; n] } else { std::slice::from_raw_parts(run.glyphAdvances, n).to_vec() };
            let offsets = if run.glyphOffsets.is_null() {
                vec![(0.0, 0.0); n]
            } else {
                std::slice::from_raw_parts(run.glyphOffsets, n).iter().map(|o| (o.advanceOffset, o.ascenderOffset)).collect()
            };
            let cluster = if desc.clusterMap.is_null() {
                Vec::new()
            } else {
                std::slice::from_raw_parts(desc.clusterMap, desc.stringLength as usize).to_vec()
            };
            self.runs.borrow_mut().push(Run {
                origin_x: x,
                face: face.clone(),
                em: run.fontEmSize,
                glyphs,
                advances,
                offsets,
                cluster,
                text_pos: desc.textPosition,
            });
        }
        Ok(())
    }
    fn DrawUnderline(&self, _: *const core::ffi::c_void, _: f32, _: f32, _: *const DWRITE_UNDERLINE, _: Ref<IUnknown>) -> windows::core::Result<()> {
        Ok(())
    }
    fn DrawStrikethrough(&self, _: *const core::ffi::c_void, _: f32, _: f32, _: *const DWRITE_STRIKETHROUGH, _: Ref<IUnknown>) -> windows::core::Result<()> {
        Ok(())
    }
    fn DrawInlineObject(&self, _: *const core::ffi::c_void, _: f32, _: f32, _: Ref<IDWriteInlineObject>, _: BOOL, _: BOOL, _: Ref<IUnknown>) -> windows::core::Result<()> {
        Ok(())
    }
}

/// 排一行：族串头一个当主字体，其余进回退表（再接系统回退）。
fn layout(dw: &Dw, text: &[u16], families: &[String], size: f64, bold: bool, italic: bool, features: &[String]) -> windows::core::Result<IDWriteTextLayout> {
    unsafe {
        let resolved: Vec<(String, IDWriteFontCollection)> =
            families.iter().filter_map(|f| collection_of(dw, f).map(|c| (f.clone(), c))).collect();
        let (primary, primary_coll) = match resolved.first() {
            Some((f, c)) => (f.clone(), Some(c.clone())),
            None => (families.first().cloned().unwrap_or_default(), None),
        };
        let format = dw.factory.CreateTextFormat(
            &HSTRING::from(primary.as_str()),
            primary_coll.as_ref(),
            if bold { DWRITE_FONT_WEIGHT_BOLD } else { DWRITE_FONT_WEIGHT_NORMAL },
            if italic { DWRITE_FONT_STYLE_ITALIC } else { DWRITE_FONT_STYLE_NORMAL },
            DWRITE_FONT_STRETCH_NORMAL,
            size as f32,
            &HSTRING::from("zh-cn"),
        )?;
        format.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
        // 回退表：族串里其余的族（各自所在的集合），全码段；最后接系统回退
        let builder = dw.factory.CreateFontFallbackBuilder()?;
        let all = [DWRITE_UNICODE_RANGE { first: 0, last: 0x10FFFF }];
        for (name, coll) in resolved.iter().skip(1) {
            let w = wide(name);
            builder.AddMapping(&all, &[w.as_ptr()], coll, PCWSTR::null(), PCWSTR::null(), 1.0)?;
        }
        builder.AddMappings(&dw.factory.GetSystemFontFallback()?)?;
        let fallback = builder.CreateFontFallback()?;
        format.cast::<IDWriteTextFormat1>()?.SetFontFallback(&fallback)?;
        let layout = dw.factory.CreateTextLayout(text, &format, 1.0e7, 1.0e6)?;
        if !features.is_empty() {
            let typo = dw.factory.CreateTypography()?;
            for f in features {
                typo.AddFontFeature(DWRITE_FONT_FEATURE { nameTag: feature_tag(f), parameter: 1 })?;
            }
            layout.SetTypography(&typo, DWRITE_TEXT_RANGE { startPosition: 0, length: text.len() as u32 })?;
        }
        Ok(layout)
    }
}

/// 排好一行并收各段字形；给出排出的总宽。
fn draw_runs(dw: &Dw, units: &[u16], families: &[String], size: f64, bold: bool, italic: bool, features: &[String]) -> windows::core::Result<(f64, Vec<Run>)> {
    let layout = layout(dw, units, families, size, bold, italic, features)?;
    let mut tm = DWRITE_TEXT_METRICS::default();
    unsafe { layout.GetMetrics(&mut tm)? };
    let collector: IDWriteTextRenderer = Collector { runs: RefCell::new(Vec::new()) }.into();
    unsafe { layout.Draw(None, &collector, 0.0, 0.0)? };
    let runs = std::mem::take(&mut *unsafe { collector.as_impl() }.runs.borrow_mut());
    Ok((tm.widthIncludingTrailingWhitespace as f64, runs))
}

pub fn measure(text: &str, families: &[String], size: f64, bold: bool, italic: bool, features: &[String]) -> Measured {
    let n = text.chars().count();
    if text.is_empty() {
        return Ink::default().into_measured(0.0, vec![]);
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let got = with_dw(|dw| -> windows::core::Result<(f64, Ink, Vec<(usize, f64)>)> {
        let (width, runs) = draw_runs(dw, &units, families, size, bold, italic, features)?;
        let mut ink = Ink::default();
        let mut glyph_pos: Vec<(usize, f64)> = Vec::new();
        for r in &runs {
            let mut fm = DWRITE_FONT_METRICS::default();
            unsafe { r.face.GetMetrics(&mut fm) };
            let k = r.em as f64 / fm.designUnitsPerEm.max(1) as f64;
            let mut gm = vec![DWRITE_GLYPH_METRICS::default(); r.glyphs.len()];
            unsafe { r.face.GetDesignGlyphMetrics(r.glyphs.as_ptr(), r.glyphs.len() as u32, gm.as_mut_ptr(), false)? };
            // 各字形的笔位（run 内按 advance 累加）
            let mut pens = Vec::with_capacity(r.glyphs.len());
            let mut pen = r.origin_x as f64;
            for (g, m) in gm.iter().enumerate() {
                pens.push(pen);
                let (dx, up) = (r.offsets[g].0 as f64, r.offsets[g].1 as f64);
                let w = m.advanceWidth as i64 - m.leftSideBearing as i64 - m.rightSideBearing as i64;
                let h = m.advanceHeight as i64 - m.topSideBearing as i64 - m.bottomSideBearing as i64;
                if w > 0 && h > 0 {
                    let l = pen + dx + m.leftSideBearing as f64 * k;
                    let t = (m.topSideBearing as f64 - m.verticalOriginY as f64) * k - up;
                    ink.add(l, t, l + w as f64 * k, t + h as f64 * k);
                }
                pen += r.advances[g] as f64;
            }
            for (i, &g) in r.cluster.iter().enumerate() {
                if let Some(&x) = pens.get(g as usize) {
                    glyph_pos.push((r.text_pos as usize + i, x));
                }
            }
        }
        Ok((width, ink, glyph_pos))
    });
    match got {
        Ok((width, ink, glyph_pos)) => ink.into_measured(width, cp_positions(text, &glyph_pos)),
        Err(_) => Ink::default().into_measured(0.0, vec![0.0; n]),
    }
}

pub fn font_metrics(families: &[String], size: f64, bold: bool, italic: bool) -> Metrics {
    with_dw(|dw| {
        for f in families {
            let Some(coll) = collection_of(dw, f) else { continue };
            let Some(font) = first_font(&coll, f, bold, italic) else { continue };
            let mut fm = DWRITE_FONT_METRICS::default();
            unsafe { font.GetMetrics(&mut fm) };
            let k = size / fm.designUnitsPerEm.max(1) as f64;
            return Metrics { ascent: fm.ascent as f64 * k, descent: fm.descent as f64 * k, family: f.clone() };
        }
        Metrics { ascent: size * 0.8, descent: size * 0.2, family: String::new() }
    })
}

pub fn has_family(family: &str) -> bool {
    with_dw(|dw| collection_of(dw, family).is_some())
}

pub fn resolve_name(family: &str) -> String {
    with_dw(|dw| if collection_of(dw, family).is_some() { family.to_string() } else { String::new() })
}

/// 按文件注册：把注册过的文件全部重建成一个字体集合（Windows 10 1703 起有字体集接口）。
pub fn register_font(path: &str) -> bool {
    with_dw(|dw| {
        if !dw.files.iter().any(|p| p == path) {
            dw.files.push(path.to_string());
        }
        let build = || -> windows::core::Result<IDWriteFontCollection> {
            unsafe {
                let f5: IDWriteFactory5 = dw.factory.cast()?;
                let builder: IDWriteFontSetBuilder1 = f5.CreateFontSetBuilder()?;
                for p in &dw.files {
                    let file = f5.CreateFontFileReference(&HSTRING::from(p.as_str()), None)?;
                    builder.AddFontFile(&file)?;
                }
                let set = builder.CreateFontSet()?;
                f5.CreateFontCollectionFromFontSet(&set)?.cast()
            }
        };
        match build() {
            Ok(c) => {
                dw.custom = Some(c);
                true
            }
            Err(_) => false,
        }
    })
}

/// 把 D2D 的几何回调攒成 SVG path（DirectWrite 的轮廓本来就是 y 向下、基线在 0）。
#[implement(ID2D1SimplifiedGeometrySink)]
struct PathSink {
    d: RefCell<String>,
    dx: std::cell::Cell<f32>,
}

impl ID2D1SimplifiedGeometrySink_Impl for PathSink_Impl {
    fn SetFillMode(&self, _: D2D1_FILL_MODE) {}
    fn SetSegmentFlags(&self, _: D2D1_PATH_SEGMENT) {}
    fn BeginFigure(&self, p: &Vector2, _: D2D1_FIGURE_BEGIN) {
        let dx = self.dx.get();
        self.d.borrow_mut().push_str(&format!("M{:.3} {:.3}", p.X + dx, p.Y));
    }
    fn AddLines(&self, points: *const Vector2, count: u32) {
        let dx = self.dx.get();
        let mut d = self.d.borrow_mut();
        for p in unsafe { std::slice::from_raw_parts(points, count as usize) } {
            d.push_str(&format!("L{:.3} {:.3}", p.X + dx, p.Y));
        }
    }
    fn AddBeziers(&self, beziers: *const D2D1_BEZIER_SEGMENT, count: u32) {
        let dx = self.dx.get();
        let mut d = self.d.borrow_mut();
        for b in unsafe { std::slice::from_raw_parts(beziers, count as usize) } {
            d.push_str(&format!(
                "C{:.3} {:.3} {:.3} {:.3} {:.3} {:.3}",
                b.point1.X + dx, b.point1.Y, b.point2.X + dx, b.point2.Y, b.point3.X + dx, b.point3.Y
            ));
        }
    }
    fn EndFigure(&self, _: D2D1_FIGURE_END) {
        self.d.borrow_mut().push('Z');
    }
    fn Close(&self) -> windows::core::Result<()> {
        Ok(())
    }
}

pub fn outline(text: &str, families: &[String], size: f64, bold: bool, italic: bool, features: &[String]) -> String {
    if text.is_empty() {
        return String::new();
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    with_dw(|dw| -> windows::core::Result<String> {
        let (_, runs) = draw_runs(dw, &units, families, size, bold, italic, features)?;
        let sink: ID2D1SimplifiedGeometrySink = PathSink { d: RefCell::new(String::new()), dx: std::cell::Cell::new(0.0) }.into();
        for r in &runs {
            unsafe { sink.as_impl() }.dx.set(r.origin_x);
            let offsets: Vec<DWRITE_GLYPH_OFFSET> =
                r.offsets.iter().map(|&(a, b)| DWRITE_GLYPH_OFFSET { advanceOffset: a, ascenderOffset: b }).collect();
            unsafe {
                r.face.GetGlyphRunOutline(
                    r.em,
                    r.glyphs.as_ptr(),
                    Some(r.advances.as_ptr()),
                    Some(offsets.as_ptr()),
                    r.glyphs.len() as u32,
                    false,
                    false,
                    &sink,
                )?
            };
        }
        let d = unsafe { sink.as_impl() }.d.borrow().clone();
        Ok(d)
    })
    .unwrap_or_default()
}
