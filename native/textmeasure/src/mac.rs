//! macOS：CoreText。族名按序解析成字体，排在后面的挂进首个字体的回退表（kCTFontCascadeListAttribute），
//! 之后 CTLine 自己做逐字回退（先回退表，再系统缺省），WebKit 也是这么排的。
//! 墨迹取 `CTFontCreatePathForGlyph` 的路径紧包围盒（不含控制点）。

use std::cell::RefCell;
use std::collections::HashMap;
use std::ptr::{self, NonNull};

use objc2_core_foundation::{
    CFArray, CFAttributedString, CFDictionary, CFMutableAttributedString, CFIndex, CFNumber, CFRange, CFRetained, CFString, CFType, CFURL, CGAffineTransform, CGPoint,
    CGSize,
};
use objc2_core_graphics::{CGPath, CGPathElement, CGPathElementType};
use objc2_core_text::{
    kCTFontAttributeName, kCTFontCascadeListAttribute, kCTFontFamilyNameAttribute, kCTFontFeatureSettingsAttribute,
    kCTFontOpenTypeFeatureTag, kCTFontOpenTypeFeatureValue, CTFont, CTFontDescriptor, CTFontManagerCreateFontDescriptorsFromURL, CTFontSymbolicTraits, CTLine, CTRun,
};

use crate::{cp_positions, Ink, Measured, Metrics};

thread_local! {
    /// (族, 粗, 斜) → 解析到的字体（字号 1，用时按字号复制）；None = 系统里没有这个族
    static BASE: RefCell<HashMap<(String, bool, bool), Option<CFRetained<CTFont>>>> = RefCell::new(HashMap::new());
    /// (族串, 字号, 粗, 斜, 特性) → 挂好回退表与特性的那支字
    /// `register_font` 按文件建的字体：族名（小写）→ 各字面（字号 1）
    static FILE_FONTS: RefCell<HashMap<String, Vec<CFRetained<CTFont>>>> = RefCell::new(HashMap::new());
    static FONTS: RefCell<HashMap<String, Option<CFRetained<CTFont>>>> = RefCell::new(HashMap::new());
}

fn cfstr(s: &str) -> CFRetained<CFString> {
    CFString::from_str(s)
}

/// 按某个名字属性（族名 / 字体名）建字体。CoreText 找不到时给缺省字体（Helvetica）。
fn by_attr(attr: &CFString, name: &str) -> CFRetained<CTFont> {
    unsafe {
        let v = cfstr(name);
        let attrs = CFDictionary::<CFString, CFType>::from_slices(&[attr], &[v.as_ref()]);
        let desc = CTFontDescriptor::with_attributes(attrs.as_opaque());
        CTFont::with_font_descriptor(&desc, 1.0, ptr::null())
    }
}

/// 族名 → 系统里的字体；没有就 None。认本地化族名（「魏碑-简」= Weibei SC），
/// 不认全名、PostScript 名（「楷体-简 常规体」不算）——浏览器的 font-family 也只按族名配，全名只在 `local()` 里认。
/// CoreText 找不到时不报错而是给缺省字体，所以拿「一个肯定不存在的名字」解析出的那支当参照：
/// 解析结果就是它、而要的又不是它，就算没有。
fn lookup(name: &str) -> Option<CFRetained<CTFont>> {
    let fallback = unsafe { by_attr(kCTFontFamilyNameAttribute, "\u{1}dolce-no-such-font").post_script_name() }.to_string();
    let named = |f: &CTFont| unsafe {
        f.family_name().to_string().eq_ignore_ascii_case(name)
    };
    let f = by_attr(unsafe { kCTFontFamilyNameAttribute }, name);
    (named(&f) || unsafe { f.post_script_name() }.to_string() != fallback).then_some(f)
}

/// 族名 → 字体（字号 1）。
fn base_font(family: &str, bold: bool, italic: bool) -> Option<CFRetained<CTFont>> {
    let key = (family.to_lowercase(), bold, italic);
    if let Some(hit) = BASE.with(|m| m.borrow().get(&key).cloned()) {
        return hit;
    }
    let want = |f: &CTFont| {
        let t = unsafe { f.symbolic_traits() };
        t.contains(CTFontSymbolicTraits::TraitBold) == bold && t.contains(CTFontSymbolicTraits::TraitItalic) == italic
    };
    if let Some(faces) = FILE_FONTS.with(|m| m.borrow().get(&key.0).cloned()) {
        let font = faces.iter().find(|f| want(f)).or(faces.first()).cloned();
        BASE.with(|m| m.borrow_mut().insert(key, font.clone()));
        return font;
    }
    let font = lookup(family).map(|f| unsafe {
        let mut traits = CTFontSymbolicTraits::empty();
        if bold {
            traits |= CTFontSymbolicTraits::TraitBold;
        }
        if italic {
            traits |= CTFontSymbolicTraits::TraitItalic;
        }
        // 没有对应字面时保留常规体（浏览器此时合成粗/斜，advance 不变）
        if traits.is_empty() {
            f
        } else {
            f.copy_with_symbolic_traits(1.0, ptr::null(), traits, traits).unwrap_or(f)
        }
    });
    BASE.with(|m| m.borrow_mut().insert(key, font.clone()));
    font
}

fn feature_settings(features: &[String]) -> CFRetained<CFArray> {
    let dicts: Vec<CFRetained<CFDictionary<CFString, CFType>>> = features
        .iter()
        .map(|f| unsafe {
            let tag = cfstr(f);
            let one = CFNumber::new_i32(1);
            let kt: &CFString = kCTFontOpenTypeFeatureTag;
            let kv: &CFString = kCTFontOpenTypeFeatureValue;
            CFDictionary::<CFString, CFType>::from_slices(&[kt, kv], &[tag.as_ref(), one.as_ref()])
        })
        .collect();
    let arr = CFArray::<CFDictionary<CFString, CFType>>::from_retained_objects(&dicts);
    unsafe { CFRetained::cast_unchecked(arr) }
}

/// 族串 → 带回退表与特性的字体。首个可用的族当主字体；一个都没有就用系统缺省（交给 CTLine 回退）。
fn font_for(families: &[String], size: f64, bold: bool, italic: bool, features: &[String]) -> Option<CFRetained<CTFont>> {
    let key = format!("{}\x01{size}\x01{bold}\x01{italic}\x01{}", families.join(","), features.join(","));
    if let Some(hit) = FONTS.with(|m| m.borrow().get(&key).cloned()) {
        return hit;
    }
    let resolved: Vec<CFRetained<CTFont>> = families.iter().filter_map(|f| base_font(f, bold, italic)).collect();
    let font = resolved.first().map(|primary| unsafe {
        let cascade: Vec<CFRetained<CTFontDescriptor>> = resolved[1..].iter().map(|f| f.font_descriptor()).collect();
        let mut keys: Vec<&CFString> = Vec::new();
        let mut vals: Vec<CFRetained<CFType>> = Vec::new();
        if !cascade.is_empty() {
            keys.push(kCTFontCascadeListAttribute);
            let arr = CFArray::<CTFontDescriptor>::from_retained_objects(&cascade);
            vals.push(CFRetained::cast_unchecked(arr));
        }
        if !features.is_empty() {
            keys.push(kCTFontFeatureSettingsAttribute);
            vals.push(CFRetained::cast_unchecked(feature_settings(features)));
        }
        let vrefs: Vec<&CFType> = vals.iter().map(|v| v.as_ref()).collect();
        let attrs = CFDictionary::<CFString, CFType>::from_slices(&keys, &vrefs);
        let desc = CTFontDescriptor::with_attributes(attrs.as_opaque());
        primary.copy_with_attributes(size, ptr::null(), Some(&desc))
    });
    FONTS.with(|m| m.borrow_mut().insert(key, font.clone()));
    font
}

fn line_for(text: &str, font: &CTFont, features: &[String]) -> CFRetained<CTLine> {
    unsafe {
        let s = cfstr(text);
        let k: &CFString = kCTFontAttributeName;
        let attrs = CFDictionary::<CFString, CFType>::from_slices(&[k], &[font.as_ref()]);
        let astr = CFAttributedString::new(None, Some(&s), Some(attrs.as_opaque())).expect("CFAttributedStringCreate");
        let line = CTLine::with_attributed_string(&astr);
        if features.is_empty() {
            return line;
        }
        // 字体描述里的特性只管主字体；回退出来的那几段（Times New Roman 里的中文落到 PingFang）也要开，
        // 浏览器是给实际排这个字的字体开特性。所以按第一遍排出的各段字体，逐段换成开了特性的那支再排一遍。
        let feat = feature_settings(features);
        let fk: &CFString = kCTFontFeatureSettingsAttribute;
        let fattrs = CFDictionary::<CFString, CFType>::from_slices(&[fk], &[feat.as_ref()]);
        let fdesc = CTFontDescriptor::with_attributes(fattrs.as_opaque());
        let Some(m) = CFMutableAttributedString::new_copy(None, 0, Some(&astr)) else { return line };
        let runs = line.glyph_runs();
        let runs: &CFArray<CTRun> = runs.cast_unchecked();
        for i in 0..runs.len() {
            let run = runs.get_unchecked(i as CFIndex);
            let ra = run.attributes();
            let ra: &CFDictionary<CFString, CTFont> = ra.cast_unchecked();
            let Some(rf) = ra.get(k) else { continue };
            let with_feat = rf.copy_with_attributes(rf.size(), ptr::null(), Some(&fdesc));
            CFMutableAttributedString::set_attribute(Some(&m), run.string_range(), Some(k), Some(with_feat.as_ref()));
        }
        CTLine::with_attributed_string(&m)
    }
}

pub fn measure(text: &str, families: &[String], size: f64, bold: bool, italic: bool, features: &[String]) -> Measured {
    let n = text.chars().count();
    let Some(font) = font_for(families, size, bold, italic, features) else {
        return Ink::default().into_measured(0.0, vec![0.0; n]);
    };
    if text.is_empty() {
        return Ink::default().into_measured(0.0, vec![]);
    }
    let line = line_for(text, &font, features);
    let mut ink = Ink::default();
    let mut glyph_pos: Vec<(usize, f64)> = Vec::new();
    // 逐字笔位按 base advance 累加（同浏览器 getStartPositionOfChar）：run 的 position 含 GPOS 的定位偏移
    //（`halt` 下的「（」画在 −0.5 em 处、笔位仍是 0），那是画的位置，不是笔位；
    // `CTRunGetAdvances` 给的又是名义 advance（「（」仍报一个字宽），与排出来的总宽对不上
    let mut pen = 0.0;
    let width = unsafe {
        let w = line.typographic_bounds(ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
        let runs = line.glyph_runs();
        let runs: &CFArray<CTRun> = runs.cast_unchecked();
        for i in 0..runs.len() {
            let run = runs.get_unchecked(i as CFIndex);
            let count = run.glyph_count();
            if count <= 0 {
                continue;
            }
            let all = CFRange { location: 0, length: count };
            let mut glyphs = vec![0u16; count as usize];
            let mut pos = vec![CGPoint { x: 0.0, y: 0.0 }; count as usize];
            let mut idx = vec![0 as CFIndex; count as usize];
            let mut adv = vec![CGSize { width: 0.0, height: 0.0 }; count as usize];
            run.base_advances_and_origins(all, adv.as_mut_ptr(), ptr::null_mut());
            run.glyphs(all, NonNull::new_unchecked(glyphs.as_mut_ptr()));
            run.positions(all, NonNull::new_unchecked(pos.as_mut_ptr()));
            run.string_indices(all, NonNull::new_unchecked(idx.as_mut_ptr()));
            // 这一段实际用的字（回退后的）
            let attrs = run.attributes();
            let attrs: &CFDictionary<CFString, CTFont> = attrs.cast_unchecked();
            let k: &CFString = kCTFontAttributeName;
            let run_font = attrs.get(k).unwrap_or_else(|| font.clone());
            for g in 0..count as usize {
                glyph_pos.push((idx[g] as usize, pen));
                pen += adv[g].width;
                if let Some(path) = run_font.path_for_glyph(glyphs[g], ptr::null()) {
                    let r = CGPath::path_bounding_box(Some(&path));
                    if r.size.width > 0.0 || r.size.height > 0.0 {
                        // CG 坐标 y 向上，翻成向下
                        let l = pos[g].x + r.origin.x;
                        let b = -(pos[g].y + r.origin.y);
                        ink.add(l, b - r.size.height, l + r.size.width, b);
                    }
                }
            }
        }
        w
    };
    let xs = cp_positions(text, &glyph_pos);
    ink.into_measured(width, xs)
}

pub fn font_metrics(families: &[String], size: f64, bold: bool, italic: bool) -> Metrics {
    let first = families.iter().find_map(|f| base_font(f, bold, italic).map(|font| (f.clone(), font)));
    match first {
        Some((family, font)) => unsafe {
            Metrics { ascent: font.ascent() * size, descent: font.descent() * size, family }
        },
        None => Metrics { ascent: size * 0.8, descent: size * 0.2, family: String::new() },
    }
}

pub fn has_family(family: &str) -> bool {
    base_font(family, false, false).is_some()
}

/// 按文件建字体，记在族名下；同名族解析时优先于系统里的那份（系统可能装着别的版本）。
pub fn register_font(path: &str) -> bool {
    let Some(url) = CFURL::from_file_path(path) else { return false };
    let Some(descs) = (unsafe { CTFontManagerCreateFontDescriptorsFromURL(&url) }) else { return false };
    let descs: &CFArray<CTFontDescriptor> = unsafe { descs.cast_unchecked() };
    let mut any = false;
    for i in 0..descs.len() {
        let font = unsafe { CTFont::with_font_descriptor(&descs.get_unchecked(i as CFIndex), 1.0, ptr::null()) };
        let family = unsafe { font.family_name() }.to_string().to_lowercase();
        FILE_FONTS.with(|m| m.borrow_mut().entry(family).or_default().push(font));
        any = true;
    }
    // 之前按系统解析、缓存下来的结果作废
    BASE.with(|m| m.borrow_mut().clear());
    FONTS.with(|m| m.borrow_mut().clear());
    any
}

pub fn resolve_name(family: &str) -> String {
    match lookup(family) {
        Some(f) => unsafe { format!("{} / {}", f.post_script_name(), f.family_name()) },
        None => String::new(),
    }
}

unsafe extern "C-unwind" fn push_element(info: *mut std::ffi::c_void, el: NonNull<CGPathElement>) {
    let d = &mut *(info as *mut String);
    let el = el.as_ref();
    let p = el.points.as_ptr();
    let pt = |i: usize| {
        let q = *p.add(i);
        format!("{:.3} {:.3}", q.x, q.y)
    };
    match el.r#type {
        CGPathElementType::MoveToPoint => d.push_str(&format!("M{}", pt(0))),
        CGPathElementType::AddLineToPoint => d.push_str(&format!("L{}", pt(0))),
        CGPathElementType::AddQuadCurveToPoint => d.push_str(&format!("Q{} {}", pt(0), pt(1))),
        CGPathElementType::AddCurveToPoint => d.push_str(&format!("C{} {} {}", pt(0), pt(1), pt(2))),
        CGPathElementType::CloseSubpath => d.push('Z'),
        _ => {}
    }
}

pub fn outline(text: &str, families: &[String], size: f64, bold: bool, italic: bool, features: &[String]) -> String {
    let Some(font) = font_for(families, size, bold, italic, features) else { return String::new() };
    if text.is_empty() {
        return String::new();
    }
    let line = line_for(text, &font, features);
    let mut d = String::new();
    unsafe {
        let runs = line.glyph_runs();
        let runs: &CFArray<CTRun> = runs.cast_unchecked();
        for i in 0..runs.len() {
            let run = runs.get_unchecked(i as CFIndex);
            let count = run.glyph_count();
            if count <= 0 {
                continue;
            }
            let all = CFRange { location: 0, length: count };
            let mut glyphs = vec![0u16; count as usize];
            let mut pos = vec![CGPoint { x: 0.0, y: 0.0 }; count as usize];
            run.glyphs(all, NonNull::new_unchecked(glyphs.as_mut_ptr()));
            run.positions(all, NonNull::new_unchecked(pos.as_mut_ptr()));
            let attrs = run.attributes();
            let attrs: &CFDictionary<CFString, CTFont> = attrs.cast_unchecked();
            let k: &CFString = kCTFontAttributeName;
            let run_font = attrs.get(k).unwrap_or_else(|| font.clone());
            for g in 0..count as usize {
                // 字形坐标 y 向上：翻成向下并挪到这个字形的落点
                let m = CGAffineTransform { a: 1.0, b: 0.0, c: 0.0, d: -1.0, tx: pos[g].x, ty: -pos[g].y };
                if let Some(path) = run_font.path_for_glyph(glyphs[g], &m) {
                    CGPath::apply(Some(&path), &mut d as *mut String as *mut std::ffi::c_void, Some(push_element));
                }
            }
        }
    }
    d
}
