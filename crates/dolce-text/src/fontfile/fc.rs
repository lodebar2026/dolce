//! Linux：照 Chromium 的规则问 fontconfig 选字体（运行时 dlopen `libfontconfig.so.1`，没有就不用，见 [`available`]）。
//!
//! Linux 上 Chromium 画字前选字体的两条路，这里各照一条：
//! - **族名 → 字体**（[`match_family`]，照 Skia `SkFontConfigInterfaceDirect::matchFamilyName`）：族名连同粗细斜正交 fontconfig
//!   替换（读系统与用户的配置：度量兼容替身、别名）、排序，取第一个可用的面；fontconfig 总会给出「某支字」，所以还要判这支算不算要的那个族——
//!   它的族名等于替换后排第一的族名、或等于要的族名、或两者在同一组度量兼容字体里（Arial / Arimo / Liberation Sans 这类），才算；
//!   不然当这个族没装（CSS 族串接着往下找）。`sans` / `serif` / `monospace` 这类泛称不判，落到什么都算。
//! - **缺字回退**（[`fallback`]，照 Chromium `gfx::GetFallbackFontForChar`）：带上这个字与语言排序，取第一个有这个字、可用的面。
//!
//! fontconfig 不保证多线程同时调安全，调用都过一把全局锁。

use std::ffi::{c_char, CStr, CString};
use std::sync::{Mutex, OnceLock};

use fontconfig_sys::constants::{FC_CHARSET, FC_FAMILY, FC_FILE, FC_FONTFORMAT, FC_INDEX, FC_LANG, FC_SCALABLE, FC_SLANT, FC_SLANT_ITALIC, FC_SLANT_ROMAN, FC_WEIGHT, FC_WEIGHT_BOLD, FC_WEIGHT_REGULAR};
use fontconfig_sys::statics::LIB_RESULT;
use fontconfig_sys::{Fc, FcChar8, FcFontSet, FcMatchPattern, FcPattern, FcResultMatch};

static LOCK: Mutex<()> = Mutex::new(());

/// fontconfig 选中的一个面：文件 + `.ttc` 里的序号。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FcFont {
    pub file: String,
    pub index: u32,
}

/// 载得到 fontconfig 且初始化成功
fn lib() -> Option<&'static Fc> {
    static INIT: OnceLock<bool> = OnceLock::new();
    let lib = LIB_RESULT.as_ref().ok()?;
    INIT.get_or_init(|| unsafe { (lib.FcInit)() != 0 }).then_some(lib)
}

/// 本机有没有可用的 fontconfig（极简服务器上可能没有，调用方退回 fontdb 扫目录）。
pub fn available() -> bool {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    lib().is_some()
}

struct Pattern(&'static Fc, *mut FcPattern);

impl Drop for Pattern {
    fn drop(&mut self) {
        unsafe { (self.0.FcPatternDestroy)(self.1) }
    }
}

struct FontSet(&'static Fc, *mut FcFontSet);

impl Drop for FontSet {
    fn drop(&mut self) {
        if !self.1.is_null() {
            unsafe { (self.0.FcFontSetDestroy)(self.1) }
        }
    }
}

impl FontSet {
    fn fonts(&self) -> &[*mut FcPattern] {
        if self.1.is_null() {
            return &[];
        }
        unsafe {
            let s = &*self.1;
            if s.fonts.is_null() || s.nfont <= 0 {
                &[]
            } else {
                std::slice::from_raw_parts(s.fonts, s.nfont as usize)
            }
        }
    }
}

fn get_string(lib: &Fc, p: *mut FcPattern, object: &CStr, n: i32) -> Option<String> {
    let mut s: *mut FcChar8 = std::ptr::null_mut();
    let r = unsafe { (lib.FcPatternGetString)(p, object.as_ptr(), n, &mut s) };
    (r == FcResultMatch && !s.is_null()).then(|| unsafe { CStr::from_ptr(s as *const c_char) }.to_string_lossy().into_owned())
}

fn get_int(lib: &Fc, p: *mut FcPattern, object: &CStr) -> Option<i32> {
    let mut v = 0;
    (unsafe { (lib.FcPatternGetInteger)(p, object.as_ptr(), 0, &mut v) } == FcResultMatch).then_some(v)
}

fn get_bool(lib: &Fc, p: *mut FcPattern, object: &CStr) -> Option<bool> {
    let mut v = 0;
    (unsafe { (lib.FcPatternGetBool)(p, object.as_ptr(), 0, &mut v) } == FcResultMatch).then_some(v != 0)
}

/// 带粗细斜正、只要可缩放字体的查询样式
fn base_pattern(lib: &'static Fc, bold: bool, italic: bool) -> Pattern {
    unsafe {
        let p = Pattern(lib, (lib.FcPatternCreate)());
        (lib.FcPatternAddInteger)(p.1, FC_WEIGHT.as_ptr(), if bold { FC_WEIGHT_BOLD } else { FC_WEIGHT_REGULAR });
        (lib.FcPatternAddInteger)(p.1, FC_SLANT.as_ptr(), if italic { FC_SLANT_ITALIC } else { FC_SLANT_ROMAN });
        (lib.FcPatternAddBool)(p.1, FC_SCALABLE.as_ptr(), 1);
        p
    }
}

/// 套配置替换、补缺省后排序（不裁剪）
fn sort(lib: &'static Fc, p: &Pattern) -> FontSet {
    unsafe {
        (lib.FcConfigSubstitute)(std::ptr::null_mut(), p.1, FcMatchPattern);
        (lib.FcDefaultSubstitute)(p.1);
        let mut r = 0;
        FontSet(lib, (lib.FcFontSort)(std::ptr::null_mut(), p.1, 0, std::ptr::null_mut(), &mut r))
    }
}

/// 能用的面：可缩放、TrueType / CFF 轮廓（本 crate 解析得了）、文件读得到
fn usable(lib: &Fc, font: *mut FcPattern) -> Option<FcFont> {
    if get_bool(lib, font, FC_SCALABLE) == Some(false) {
        return None;
    }
    if let Some(fmt) = get_string(lib, font, FC_FONTFORMAT, 0) {
        if fmt != "TrueType" && fmt != "CFF" {
            return None;
        }
    }
    let file = get_string(lib, font, FC_FILE, 0)?;
    std::fs::metadata(&file).ok()?;
    // 高 16 位是可变字体的命名实例号，实例由调用方按粗斜另取
    let index = (get_int(lib, font, FC_INDEX).unwrap_or(0) as u32) & 0xffff;
    Some(FcFont { file, index })
}

/// 泛称：落到什么字体都算（Skia `IsFallbackFontAllowed`）
fn fallback_allowed(family: &str) -> bool {
    ["sans", "serif", "monospace"].iter().any(|g| family.eq_ignore_ascii_case(g))
}

/// 度量兼容的字体组（Skia `SkFontConfigInterface_direct.cpp` 的 `FontEquivClass` 表）：同组的互为可接受的替身。
const METRIC_GROUPS: &[&[&str]] = &[
    &["Arial", "Arimo", "Liberation Sans"],
    &["Times New Roman", "Tinos", "Liberation Serif"],
    &["Courier New", "Cousine", "Liberation Mono"],
    &["Arial Narrow", "Liberation Sans Narrow"],
    &["Symbol", "Symbol Neu"],
    &["MS PGothic", "ＭＳ Ｐゴシック", "Noto Sans CJK JP", "IPAPGothic", "MotoyaG04Gothic"],
    &["MS Gothic", "ＭＳ ゴシック", "Noto Sans Mono CJK JP", "IPAGothic", "MotoyaG04GothicMono"],
    &["MS PMincho", "ＭＳ Ｐ明朝", "IPAPMincho", "MotoyaG04Mincho"],
    &["MS Mincho", "ＭＳ 明朝", "IPAMincho", "MotoyaG04MinchoMono"],
    &["SimSun", "宋体", "MSung GB18030", "Song ASC"],
    &["NSimSun", "新宋体", "MSung GB18030", "N Song ASC"],
    &["SimHei", "黑体", "MYingHeiGB18030", "MYingHeiB5HK"],
    &["PMingLiU", "新細明體", "MSung B5HK"],
    &["MingLiU", "細明體", "MSung B5HK"],
    &["Cambria", "Caladea"],
    &["Calibri", "Carlito"],
];

fn metric_compatible(a: &str, b: &str) -> bool {
    METRIC_GROUPS.iter().any(|g| g.iter().any(|x| x.eq_ignore_ascii_case(a)) && g.iter().any(|x| x.eq_ignore_ascii_case(b)))
}

/// 具体族名 + 粗斜 → 字体面；这个族算没装时 None。
pub fn match_family(family: &str, bold: bool, italic: bool) -> Option<FcFont> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let lib = lib()?;
    let name = CString::new(family).ok()?;
    let p = base_pattern(lib, bold, italic);
    unsafe { (lib.FcPatternAddString)(p.1, FC_FAMILY.as_ptr(), name.as_ptr() as *const FcChar8) };
    let set = sort(lib, &p);
    let post_config = get_string(lib, p.1, FC_FAMILY, 0).unwrap_or_default();
    let (font, hit) = set.fonts().iter().find_map(|&f| usable(lib, f).map(|hit| (f, hit)))?;
    if fallback_allowed(family) {
        return Some(hit);
    }
    let ok = (0..255).map_while(|i| get_string(lib, font, FC_FAMILY, i)).any(|got| {
        got.eq_ignore_ascii_case(&post_config) || got.eq_ignore_ascii_case(family) || metric_compatible(family, &got)
    });
    ok.then_some(hit)
}

/// 族串里都没有这个字时的回退：带上这个字与语言（`zh-cn` 这类，空串不带）排序，第一个有这个字的可用面。
pub fn fallback(ch: char, bold: bool, italic: bool, lang: &str) -> Option<FcFont> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let lib = lib()?;
    let p = base_pattern(lib, bold, italic);
    unsafe {
        let cs = (lib.FcCharSetCreate)();
        (lib.FcCharSetAddChar)(cs, ch as u32);
        (lib.FcPatternAddCharSet)(p.1, FC_CHARSET.as_ptr(), cs);
        (lib.FcCharSetDestroy)(cs);
        if !lang.is_empty() {
            if let Ok(l) = CString::new(lang) {
                (lib.FcPatternAddString)(p.1, FC_LANG.as_ptr(), l.as_ptr() as *const FcChar8);
            }
        }
    }
    let set = sort(lib, &p);
    set.fonts().iter().find_map(|&f| {
        let mut cs = std::ptr::null_mut();
        let has = unsafe { (lib.FcPatternGetCharSet)(f, FC_CHARSET.as_ptr(), 0, &mut cs) } == FcResultMatch && unsafe { (lib.FcCharSetHasChar)(cs, ch as u32) } != 0;
        if has {
            usable(lib, f)
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metric_groups() {
        assert!(metric_compatible("Arial", "Liberation Sans"));
        assert!(metric_compatible("times new roman", "Tinos"));
        assert!(!metric_compatible("Arial", "DejaVu Sans"));
        assert!(fallback_allowed("Monospace") && !fallback_allowed("Arial"));
    }
}
