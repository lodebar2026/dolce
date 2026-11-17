//! 成书样式 ↔ 歌本 `.ss`（照 `style/bookss.ts`）。**成书没有 json**：BookStyle 只是内存里的中间对象，由样式表算出。
//!
//! ```text
//!   book_style_of(sheet, id)   computed 样式表 → BookStyle（rebuild / relayout / 各检查脚本的入口）
//!   print_book_ss(style)       BookStyle → 样式表文本（统计脚本生成歌本的实测部分）
//! ```
//!
//! 两个方向读同一张对照表，逐字段往返。**数值原样进出**：`*Em` 字段在样式表里写 `em` 单位，读回时只剥单位、不乘字号；
//! 文本 ↔ double 用 `String(number)` / `Number(raw)` 的口径。**不补默认值**。

use crate::keys::{KeyDef, KeyKind, BREAK_KEYS, FLOW_KEYS, JIANPU_KEYS, TOC_KEYS};
use crate::sheet::{is_style_role, StyleSheet};
use crate::units::is_js_decimal;
use crate::value::{json_quote, num, to_uint32};
use dolce_base::js::{num_to_string, number};
use serde_json::{Map, Value};

type R<T> = Result<T, String>;

// ───────────────────────── 样式表 → BookStyle ─────────────────────────

pub fn book_style_of(sheet: &StyleSheet, id: &str) -> R<Value> {
    let mut out = Map::new();
    out.insert("id".into(), Value::String(id.into()));

    let p = sheet.page();
    let size = p.get("size").and_then(Value::as_array).filter(|a| a.len() == 2).ok_or("成书样式表缺 @page { size: 宽 高 }")?;
    let margin = p.get("margin").and_then(Value::as_array).filter(|a| a.len() == 4).ok_or("成书样式表的 @page margin 要写四个数：上 外 下 内")?;
    let mut page = Map::new();
    page.insert("w".into(), size[0].clone());
    page.insert("h".into(), size[1].clone());
    page.insert("mirror".into(), Value::Bool(p.get("mirror") == Some(&Value::Bool(true))));
    let mut mg = Map::new();
    mg.insert("inner".into(), margin[3].clone());
    mg.insert("outer".into(), margin[1].clone());
    mg.insert("top".into(), margin[0].clone());
    mg.insert("bottom".into(), margin[2].clone());
    page.insert("margin".into(), Value::Object(mg));
    out.insert("page".into(), Value::Object(page));

    out.insert("fonts".into(), sheet.template().and_then(|t| t.get("fonts")).filter(|f| f.is_object()).cloned().unwrap_or_else(|| Value::Object(Map::new())));

    let mut roles = Map::new();
    if let Some(rs) = sheet.roles().and_then(Value::as_object) {
        for (role, d) in rs {
            if !is_style_role(role) || !crate::sheet::truthy(Some(d)) {
                continue;
            }
            let font = d.get("font").filter(|v| !v.is_null());
            let size = d.get("size").filter(|v| v.is_number());
            let align = d.get("alignMode").filter(|v| !v.is_null());
            let (Some(font), Some(size), Some(align)) = (font, size, align) else {
                return Err(format!("成书样式表的角色 {role} 要写 font / size（裸数 pt）/ align-mode"));
            };
            let mut r = Map::new();
            r.insert("font".into(), font.clone());
            r.insert("align".into(), align.clone());
            r.insert("size".into(), size.clone());
            r.insert("baselineAdjust".into(), d.get("baselineAdjust").filter(|v| !v.is_null()).cloned().unwrap_or(num(0.0)));
            if let Some(c) = d.get("color").filter(|v| !v.is_null()) {
                r.insert("color".into(), c.clone());
            }
            roles.insert(role.clone(), Value::Object(r));
        }
    }
    out.insert("roles".into(), Value::Object(roles));

    let mut metrics = Map::new();
    let mut layout = Map::new();
    let mut take = |ov: Option<&Map<String, Value>>, table: &[(&str, KeyDef)], block: &str| -> R<()> {
        for (k, v) in ov.into_iter().flatten() {
            let Some((_, def)) = table.iter().find(|(n, _)| n == k) else { continue };
            let Some(path) = def.book else { continue }; // 纯简谱/混排那一侧的键，成书不读
            let (group, field) = path.split_once('.').expect("键表路径是 组.字段");
            let val = book_value(block, k, def, field, v)?;
            if group == "metrics" { &mut metrics } else { &mut layout }.insert(field.to_string(), val);
        }
        Ok(())
    };
    take(sheet.jianpu_overrides(), JIANPU_KEYS, "jianpu")?;
    take(sheet.break_overrides(), BREAK_KEYS, "break")?;
    out.insert("metrics".into(), Value::Object(metrics));
    out.insert("layout".into(), Value::Object(layout));

    let tmpl = |k: &str| sheet.template().and_then(|t| t.get(k)).and_then(Value::as_object);
    let mut toc = Map::new();
    for (k, e) in tmpl("toc").into_iter().flatten() {
        let field = TOC_KEYS.iter().find(|(n, _)| n == k).map(|(_, f)| *f).ok_or_else(|| format!("@toc 认不出的键 {k}"))?;
        let where_ = format!("@toc {k}");
        let v = if field == "leader" { Value::String(expr_text(e, &where_)?) } else { num(expr_number(e, &where_)?) };
        toc.insert(field.into(), v);
    }
    out.insert("toc".into(), Value::Object(toc));

    let mut title_block = Map::new();
    for (k, e) in tmpl("flow").into_iter().flatten() {
        if let Some(Some(field)) = FLOW_KEYS.iter().find(|(n, _)| n == k).map(|(_, f)| *f) {
            title_block.insert(field.into(), num(expr_number(e, &format!("@flow {k}"))?));
        }
    }
    out.insert("titleBlock".into(), Value::Object(title_block));
    Ok(Value::Object(out))
}

fn book_value(block: &str, key: &str, def: &KeyDef, field: &str, v: &Value) -> R<Value> {
    let where_ = format!("@{block} 的 {key}");
    let shown = || crate::value::js_json(v);
    match def.kind {
        KeyKind::Bool => v.is_boolean().then(|| v.clone()).ok_or(format!("{where_}：开关只收 true / false")),
        KeyKind::Word => v.is_string().then(|| v.clone()).ok_or(format!("{where_}：要一个词")),
        KeyKind::Num => v.is_number().then(|| v.clone()).ok_or(format!("{where_}：要一个数")),
        KeyKind::Len => {
            if field.ends_with("Em") {
                let body = v.as_str().and_then(|s| s.strip_suffix("em")).filter(|b| is_js_decimal(b));
                let Some(body) = body else {
                    return Err(format!("{where_}：成书这一项按字号缩放，要写 em（如 1.2em），却是 {}", shown()));
                };
                return Ok(num(number(body)));
            }
            v.is_number().then(|| v.clone()).ok_or_else(|| format!("{where_}：成书这一项是 pt，写裸数，却是 {}", shown()))
        }
    }
}

fn expr_number(e: &Value, where_: &str) -> R<f64> {
    let k = e.get("k").and_then(Value::as_str);
    let bare = |x: &Value| x.get("k").and_then(Value::as_str) == Some("num") && x.get("unit").is_none_or(Value::is_null);
    if k == Some("num") && bare(e) {
        return e.get("v").and_then(Value::as_f64).ok_or(format!("{where_}：要一个裸数（pt）"));
    }
    if k == Some("neg") {
        if let Some(a) = e.get("a").filter(|a| bare(a)) {
            if let Some(x) = a.get("v").and_then(Value::as_f64) {
                return Ok(-x);
            }
        }
    }
    Err(format!("{where_}：要一个裸数（pt）"))
}

fn expr_text(e: &Value, where_: &str) -> R<String> {
    match e.get("k").and_then(Value::as_str) {
        Some("str") | Some("id") => e.get("v").and_then(Value::as_str).map(str::to_string).ok_or(format!("{where_}：要一个字符串")),
        _ => Err(format!("{where_}：要一个字符串")),
    }
}

// ───────────────────────── BookStyle → 样式表 ─────────────────────────

/// 数值写成文本：`String(number)` 是能还原出同一个 double 的最短写法。词法不认指数形式，遇到就报错。
fn num_text(v: Option<&Value>, where_: &str) -> R<String> {
    let s = match v {
        Some(Value::Number(n)) => num_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(x) => crate::value::js_to_string(x),
        None => "undefined".into(),
    };
    let body = s.strip_prefix('-').unwrap_or(&s);
    let ok = match body.split_once('.') {
        None => !body.is_empty() && body.bytes().all(|b| b.is_ascii_digit()),
        Some((a, b)) => !a.is_empty() && a.bytes().all(|c| c.is_ascii_digit()) && !b.is_empty() && b.bytes().all(|c| c.is_ascii_digit()),
    };
    if !ok {
        return Err(format!("{where_}：{s} 写不成样式表的数字（指数形式或非有限数）"));
    }
    Ok(s)
}

/// `alignMode` 的驼峰写成样式表的短横（`inkCenter` → `ink-center`）。
fn kebab(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// 生成歌本样式表的**实测部分**（纸、字体、角色、间距、断句、起排位置、目录几何）。
/// 模板与手调常量不在这里，写在歌本自己的 `.ss`，加载时排在这份之后。
pub fn print_book_ss(style: &Value) -> R<String> {
    let mut l: Vec<String> = vec![];
    let page = style.get("page").cloned().unwrap_or(Value::Null);
    let m = page.get("margin").cloned().unwrap_or(Value::Null);
    let mirror = crate::value::js_to_string(page.get("mirror").unwrap_or(&Value::Null));
    l.push(format!(
        "@page {{ size: {} {}; margin: {} {} {} {}; mirror: {mirror}; }}",
        num_text(page.get("w"), "page.w")?,
        num_text(page.get("h"), "page.h")?,
        num_text(m.get("top"), "margin.top")?,
        num_text(m.get("outer"), "margin.outer")?,
        num_text(m.get("bottom"), "margin.bottom")?,
        num_text(m.get("inner"), "margin.inner")?,
    ));
    l.push(String::new());

    for (name, f) in style.get("fonts").and_then(Value::as_object).into_iter().flatten() {
        let s = |k: &str| f.get(k).map(crate::value::js_to_string).unwrap_or_else(|| "undefined".into());
        let mut body = vec![format!("family: {};", json_quote(&s("family")))];
        if f.get("file").is_some() {
            body.push(format!("file: {};", json_quote(&s("file"))));
        }
        if f.get("face").is_some() {
            body.push(format!("face: {};", json_quote(&s("face"))));
        }
        if f.get("mode").is_some() {
            body.push(format!("mode: {};", s("mode")));
        }
        if f.get("bold").is_some() {
            body.push(format!("bold: {};", s("bold")));
        }
        l.push(format!("@font-face {name} {{ {} }}", body.join(" ")));
    }
    l.push(String::new());

    for (role, r) in style.get("roles").and_then(Value::as_object).into_iter().flatten() {
        let s = |k: &str| r.get(k).map(crate::value::js_to_string).unwrap_or_else(|| "undefined".into());
        let mut body = vec![format!("font: {};", s("font")), format!("size: {};", num_text(r.get("size"), &format!("{role}.size"))?), format!("align-mode: {};", kebab(&s("align")))];
        let ba = r.get("baselineAdjust");
        if ba.and_then(Value::as_f64) != Some(0.0) {
            body.push(format!("baseline-adjust: {};", num_text(ba, &format!("{role}.baselineAdjust"))?));
        }
        if let Some(c) = r.get("color") {
            body.push(format!("color: #{:08x};", to_uint32(c.as_f64().unwrap_or(f64::NAN))));
        }
        l.push(format!("{role} {{ {} }}", body.join(" ")));
    }
    l.push(String::new());

    // 一块里的键按 BookStyle 的字段顺序写（先 metrics 后 layout）；表里没有的字段说明排版不读，不写
    let mut block = |name: &str, table: &[(&str, KeyDef)]| -> R<()> {
        let mut body: Vec<String> = vec![];
        for group in ["metrics", "layout"] {
            for (field, v) in style.get(group).and_then(Value::as_object).into_iter().flatten() {
                let path = format!("{group}.{field}");
                let Some((key, def)) = table.iter().find(|(_, d)| d.book == Some(path.as_str())) else { continue };
                if def.kind == KeyKind::Bool || def.kind == KeyKind::Word {
                    body.push(format!("  {key}: {};", crate::value::js_to_string(v)));
                } else {
                    let unit = if field.ends_with("Em") { "em" } else { "" };
                    body.push(format!("  {key}: {}{unit};", num_text(Some(v), &path)?));
                }
            }
        }
        if !body.is_empty() {
            l.push(format!("@{name} {{"));
            l.extend(body);
            l.push("}".into());
            l.push(String::new());
        }
        Ok(())
    };
    block("jianpu", JIANPU_KEYS)?;
    block("break", BREAK_KEYS)?;

    let tb = style.get("titleBlock").cloned().unwrap_or(Value::Null);
    let mut flow = vec![];
    for (k, f) in FLOW_KEYS {
        let Some(f) = f else { continue };
        if let Some(v) = tb.get(*f) {
            flow.push(format!("{k}: {};", num_text(Some(v), &format!("titleBlock.{f}"))?));
        }
    }
    if !flow.is_empty() {
        l.push(format!("@flow {{ {} }}", flow.join(" ")));
        l.push(String::new());
    }

    let toc = style.get("toc").cloned().unwrap_or(Value::Null);
    let mut toc_body = vec![];
    for (k, f) in TOC_KEYS {
        let Some(v) = toc.get(*f) else { continue };
        let text = match v {
            Value::String(s) => json_quote(s),
            _ => num_text(Some(v), &format!("toc.{f}"))?,
        };
        toc_body.push(format!("{k}: {text};"));
    }
    if !toc_body.is_empty() {
        l.push(format!("@toc {{ {} }}", toc_body.join(" ")));
        l.push(String::new());
    }
    Ok(l.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cascade::{compute_style, ctx};
    use crate::ss::parse_ss;

    /// 成书样式 → `.ss` → 读回逐字段相同（`*Em` 字段只剥单位、不乘字号；不补默认值）。
    #[test]
    fn roundtrip() {
        let src = "@page { size: 425.197 612.283; margin: 94 52 94.5 52; mirror: true; }\n\
            @font-face times { family: \"Times New Roman\"; mode: path; }\n\
            note { font: times; size: 10.5; align-mode: ink-center; baseline-adjust: -0.02; }\n\
            @jianpu { system-spread: 2.2em; repeat-dot-diameter: 1.6; chord-plain: false; }\n\
            @flow { number-baseline: 77.9; }\n@toc { leader: \"…\"; entry-line-height: 19.4; }\n";
        let rules = parse_ss(src).unwrap();
        let sheet = compute_style(&[&rules], &ctx(&[("engine", Value::String("book".into()))]));
        let a = book_style_of(&sheet, "t").unwrap();
        assert_eq!(a["metrics"]["systemGapEm"], num(2.2));
        assert_eq!(a["roles"]["note"]["align"], "inkCenter");
        let text = print_book_ss(&a).unwrap();
        let back = book_style_of(&compute_style(&[&parse_ss(&text).unwrap()], &ctx(&[("engine", Value::String("book".into()))])), "t").unwrap();
        assert_eq!(a, back, "{text}");
        assert_eq!(print_book_ss(&back).unwrap(), text);
    }
}
