//! 书籍样式（照 `style/bookstyle.ts`）：一本书「长什么样」的完整参数集——页面 / 版心、各角色的字体与字号、各处间距。
//!
//! 内存形态是 JS 对象（由歌本 `.ss` 算出，[`crate::bookss::book_style_of`]），**不补默认值**：没写的字段就不出现，
//! 由消费端原来的 `??` 兜底。所以这里也用 `Value` 承载，字段与单位约定见 TS 原文头注释
//! （`size` 是字号不是墨迹高；`*Em` 随音符字号缩放；线宽、点直径、页面尺寸、页边距存 pt）。

use crate::sheet::STYLE_ROLES;
use crate::value::{get_path, merge_style};
use serde_json::{json, Map, Value};

/// 本机可用的一套默认字体（原书是转曲的，PDF 里没有字体资源，只能按面貌配同族替代）。
pub fn default_fonts() -> Value {
    let fz = format!("{}/Library/Fonts", std::env::var("HOME").unwrap_or_default());
    json!({
        "wei": { "family": "FZWeiBei-S03S", "file": format!("{fz}/方正魏碑简体.ttf") },
        "serif": { "family": "FZBaoSong-Z04", "file": format!("{fz}/方正报宋_GBK.TTF") },
        "kai": { "family": "FZKai-Z03", "file": format!("{fz}/方正楷体_GBK.TTF") },
        "hei": { "family": "FZHei-B01S", "file": format!("{fz}/方正黑体简体.TTF") },
        "xingkai": { "family": "FZXingKai-S04", "file": format!("{fz}/方正行楷_GBK.ttf") },
        "times": { "family": "Times New Roman", "file": "/System/Library/Fonts/Supplemental/Times New Roman.ttf" },
        // 兜底：方正那四款字表不含「祂」「衪」「啰」这些，只在主字体缺字时才用得上
        "fallbackCjk": { "family": "Songti SC", "file": "/System/Library/Fonts/Supplemental/Songti.ttc", "face": "Songti SC Regular" },
        "music": { "family": "Bravura", "file": "public/redist/Bravura.otf", "mode": "path" },
    })
}

/// 各角色量墨迹高用的样本字（`INK_SAMPLE`）；没列的角色（汉字档）一律用「国」。
pub const INK_SAMPLE: [(&str, &str); 6] = [("note", "5"), ("tuplet", "3"), ("chord", "G"), ("keyMeter", "4"), ("footer", "8"), ("verseNum", "1")];

pub fn ink_sample_of(role: &str) -> &'static str {
    INK_SAMPLE.iter().find(|(r, _)| *r == role).map_or("国", |(_, s)| s)
}

/// 各角色默认引用哪个字体与对齐口径（`ROLE_FONT`），顺序同 `STYLE_ROLES`。
pub const ROLE_FONT: [(&str, &str, &str); 20] = [
    ("title", "wei", "center"),
    ("songNumber", "hei", "outer"),
    ("category", "hei", "outer"),
    ("credit", "kai", "right"),
    ("keyMeter", "times", "left"),
    ("note", "times", "inkCenter"),
    ("tuplet", "times", "inkCenter"),
    ("verseNum", "times", "left"),
    ("chord", "times", "inkCenter"),
    ("lyric", "serif", "inkCenter"),
    ("lyric2", "serif", "inkCenter"),
    ("sectionWord", "serif", "left"),
    ("story", "serif", "left"),
    // 目录：歌名用楷体、分类标题用行楷（原书就是这么排的）
    ("toc", "kai", "left"),
    ("tocHeading", "xingkai", "center"),
    ("tocSub", "xingkai", "center"),
    ("frontTitle", "wei", "center"),
    ("header", "hei", "outer"),
    ("footer", "times", "outer"),
    // SMuFL 走轮廓（fonts.music.mode = "path"）
    ("smufl", "music", "pen"),
];

/// `roleFontDefaults()`：角色 → `{ font, align }`。
pub fn role_font_defaults() -> Value {
    let mut m = Map::new();
    for (r, font, align) in ROLE_FONT {
        m.insert(r.into(), json!({ "font": font, "align": align }));
    }
    Value::Object(m)
}

/// 一份可用的默认样式（A4 之外的值都是占位，实际由统计覆盖）。
pub fn default_book_style() -> Value {
    let mut roles = Map::new();
    for r in STYLE_ROLES {
        let (_, font, align) = ROLE_FONT.iter().find(|(x, _, _)| *x == r).expect("每个角色都有默认字体");
        roles.insert(r.into(), json!({ "font": font, "size": 10.0, "baselineAdjust": 0.0, "align": align }));
    }
    json!({
        "id": "default",
        "page": { "w": 425.197, "h": 612.283, "mirror": true, "margin": { "inner": 52.0, "outer": 52.0, "top": 94.0, "bottom": 94.0 } },
        "fonts": default_fonts(),
        "roles": roles,
        "metrics": {
            "systemGapEm": 2.2,
            "noteStepEm": 1.5,
            "lyricGapEm": 0.1,
            "bracketWidth": 0.0,
            "bracketFootEm": 0.0,
            "repeatDotDiam": 1.6,
            "chordToNoteEm": 1.3,
            "chordPlain": true,
            "lyricToLyricEm": 1.5,
            // 原是 × 音符墨迹高的 0.9 / 0.66 / 0.41，× 0.674（Times 数字墨迹占字号）折成字号口径
            "slurArcEm": 0.607,
            "slurMaxArcEm": 0.445,
            "slurMinArcEm": 0.276,
            "slurFlatSpanSteps": 4.0,
            "slurFlatNotes": 0.0,
            "slurFlatRatio": 7.0,
            "slurThicknessEm": 6.0 / 28.0,
            "barlineWidthEm": 2.0 / 28.0,
            "finalBarlineWidthEm": 3.5 / 28.0,
            "stackGapEm": 0.1667,
        },
        "layout": {
            // 0 = 一页装多少行交给排版器按页高定
            "linesPerPage": 0.0,
            "phrase": true,
            "phraseTargetMeas": 0.0,
            "phraseLenWeight": 0.25,
            "phraseBreakWeight": 3.0,
            "phraseMidBreak": true,
            "phraseMergeShort": true,
            // 断句那几个开关的默认值要写在这儿：统计脚本每次按这份默认值生成歌本的实测样式表
            "phraseEvenWeight": 1.0,
            "phraseTailWeight": 1.0,
            "phraseContentOnly": true,
            "phraseParallelWeight": 6.0,
            // 2026-08-27/28 调好的成书口径，同样只能写在这儿
            "phraseTailLongWeight": 3.0,
            "phraseMoreRowsSlack": 4.0,
            "phraseFitSlack": 0.0,
            "verseNumbers": "auto",
            "maxHorizontalScale": 2.0,
        },
        "toc": {
            "leader": "…",
            "lineGap": 19.4,
            "firstBaseline": 109.0,
            "left": 52.0,
            "right": 361.5,
            "indexColumns": 2.0,
            "indexLineGap": 15.8,
            "indexFirstBaseline": 116.0,
            "titleBaseline": 78.5,
        },
        "titleBlock": {
            "numberBaseline": 77.9,
            "firstSystemTop": 139.95,
            "contSystemTop": 106.0,
            "midStartGap": 40.0,
            "footerBaseline": 556.5,
        },
    })
}

/// 校验：缺角色、缺字体引用、量值不合理都列出来（不报错，让调用方决定）。
pub fn validate_book_style(s: &Value) -> (Value, Vec<String>) {
    let mut errors = vec![];
    let patch = if s.is_null() { json!({}) } else { s.clone() };
    let style = merge_style(&default_book_style(), &patch);
    for r in STYLE_ROLES {
        let Some(rs) = get_path(&style, &["roles", r]).filter(|v| crate::sheet::truthy(Some(v))) else {
            errors.push(format!("缺角色 {r}"));
            continue;
        };
        let size = rs.get("size").cloned().unwrap_or(Value::Null);
        if !size.as_f64().is_some_and(|x| x > 0.0) {
            errors.push(format!("角色 {r} 字号无效：{}", crate::value::js_to_string(&size)));
        }
        let font = rs.get("font").map(crate::value::js_to_string).unwrap_or_else(|| "undefined".into());
        if !crate::sheet::truthy(get_path(&style, &["fonts", &font])) {
            errors.push(format!("角色 {r} 引用了不存在的字体 {font}"));
        }
    }
    let pw = get_path(&style, &["page", "w"]).and_then(Value::as_f64);
    let ph = get_path(&style, &["page", "h"]).and_then(Value::as_f64);
    if !(pw.is_some_and(|w| w > 0.0) && ph.is_some_and(|h| h > 0.0)) {
        errors.push("页面尺寸无效".into());
    }
    if let Some(m) = style.get("metrics").and_then(Value::as_object) {
        for (k, v) in m {
            match v {
                Value::Bool(_) | Value::String(_) => continue, // chordPlain、accidentalStyle 这类开关
                Value::Number(n) if n.as_f64().is_some_and(f64::is_finite) => {}
                _ => errors.push(format!("metrics.{k} 无效：{}", crate::value::js_to_string(v))),
            }
        }
    }
    (style, errors)
}

/// 该页的四边留白 `(left, right, top, bottom)`。mirror 为真时按页奇偶把 inner 放到左/右（奇数页在右手边，装订边在左）。
pub fn page_margins(s: &Value, page_no: i64) -> (f64, f64, f64, f64) {
    let g = |k: &str| get_path(s, &["page", "margin", k]).and_then(Value::as_f64).unwrap_or(f64::NAN);
    let (inner, outer, top, bottom) = (g("inner"), g("outer"), g("top"), g("bottom"));
    if get_path(s, &["page", "mirror"]) != Some(&Value::Bool(true)) {
        return (inner, outer, top, bottom);
    }
    let odd = page_no % 2 == 1;
    (if odd { inner } else { outer }, if odd { outer } else { inner }, top, bottom)
}

/// 角色的样式；缺了退到 `lyric`。
pub fn role_of<'a>(s: &'a Value, role: &str) -> Option<&'a Value> {
    get_path(s, &["roles", role]).filter(|v| crate::sheet::truthy(Some(v))).or_else(|| get_path(s, &["roles", "lyric"]))
}

/// em → pt（基准：音符字号）。
pub fn em_to_pt(s: &Value, em: f64) -> f64 {
    em * get_path(s, &["roles", "note", "size"]).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// 该角色实际用哪个字体；引用不到取第一款。
pub fn font_of<'a>(s: &'a Value, role: &str) -> Option<&'a Value> {
    let id = role_of(s, role).and_then(|r| r.get("font")).map(crate::value::js_to_string);
    id.and_then(|id| get_path(s, &["fonts", &id]).filter(|v| crate::sheet::truthy(Some(v))))
        .or_else(|| s.get("fonts")?.as_object()?.values().next())
}
