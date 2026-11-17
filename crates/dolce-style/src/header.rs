//! 页眉四项（标题、副标题、经文、词曲作者）的字体与字号（照 `style/header.ts`）。三档排版器共用一份。
//!
//! **没写的项不报**，各排版器保留自己的出厂值。

use crate::cascade::StyleRule;
use crate::fonts::{family_of_role, FamilyMap};
use crate::sheet::StyleSheet;
use crate::units::{resolve_length, LengthContext};
use crate::value::num;
use dolce_model::doc::Song;
use dolce_model::pagemeta::{song_header_fonts, HEADER_ROLES};
use dolce_model::xmlsurface::Surface;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 一项页眉文字的字体：族、字号（pt）、粗体。字段序同 TS 写入序（family → bold → size）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct HeaderFont {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
}

pub type HeaderFonts = IndexMap<String, HeaderFont>;

/// 样式表 → 页眉四项。只报写了的。
pub fn header_fonts_of(sheet: &StyleSheet) -> HeaderFonts {
    let mut out = HeaderFonts::new();
    for role in HEADER_ROLES {
        let role = role.as_str();
        let mut f = HeaderFont::default();
        if let Some((family, bold)) = family_of_role(sheet, role, &FamilyMap::new()) {
            if !family.is_empty() {
                f.family = Some(family);
            }
            if bold {
                f.bold = Some(true);
            }
        }
        if let Some(v) = sheet.role_prop(role, "size").filter(|v| !v.is_null()) {
            let pt = resolve_length(v, LengthContext { em: f64::NAN, sp: f64::NAN, pt: None });
            if let Some(pt) = pt.filter(|p| p.is_finite() && *p > 0.0) {
                f.size = Some(pt);
            }
        }
        if f != HeaderFont::default() {
            out.insert(role.to_string(), f);
        }
    }
    out
}

/// 曲内层：谱里写的页眉字体。`sizes: false` 只要族与字重；`title_family: false` 标题不跟谱里的字体族。
pub fn header_layer_of_song(song: Option<&Song>, surface: Option<&Surface>, sizes: bool, title_family: bool) -> Vec<StyleRule> {
    let Some(song) = song else { return vec![] };
    let mut roles = Map::new();
    for (role, f) in song_header_fonts(song, surface) {
        let mut d = Map::new();
        if let Some(fam) = f.family.as_deref().filter(|s| !s.is_empty()) {
            if title_family || role.as_str() != "title" {
                d.insert("family".into(), Value::String(fam.to_string()));
            }
        }
        if let Some(sz) = f.size.filter(|s| sizes && *s != 0.0 && !s.is_nan()) {
            d.insert("size".into(), num(sz));
        }
        if f.bold {
            d.insert("weight".into(), Value::String("bold".into()));
        }
        if !d.is_empty() {
            roles.insert(role.as_str().to_string(), Value::Object(d));
        }
    }
    if roles.is_empty() {
        return vec![];
    }
    let mut set = Map::new();
    set.insert("roles".into(), Value::Object(roles));
    vec![StyleRule { when: None, set: Value::Object(set) }]
}
