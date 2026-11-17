//! 歌本模板的排版：`@template` 区域 → 定好位置的文字（和组件产出的原样图元）（照 `style/template.ts`）。
//!
//! **纯函数**：字段取值、文字测量、组件实现都由调用方经 [`RegionEnv`] 注入。
//!
//! 浮点口径：区域基线 = 写死的实测值 + dy，行 = 基线 + 格 dy，多行 = 行 + i × 行距，加法顺序与 TS 一致。

use crate::ss::{Cell, Content, Expr, Region, SsError, TextPart};
use crate::value::js_json;
use dolce_base::js::{is_space, trim};
use dolce_model::doc::Song;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

type R<T> = Result<T, SsError>;

fn err<T>(msg: impl Into<String>) -> R<T> {
    Err(SsError { message: msg.into() })
}

/// 字段的一项值。署名带类型（`label-by-type` 要用）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FieldValue {
    pub text: String,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

impl FieldValue {
    pub fn text(t: impl Into<String>) -> FieldValue {
        FieldValue { text: t.into(), kind: None }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlacedText {
    pub text: String,
    pub role: String,
    pub size: f64,
    pub x: f64,
    pub y: f64,
    pub align: String,
}

/// 排出来的一项：文字，或组件产出的图元（调用方自己的形状，原样透传）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Placed {
    Text(PlacedText),
    Raw { item: Value },
}

/// 组件调用的参数（`env` 即调用方自己）。
pub struct ComponentCall<'a> {
    pub args: &'a [Expr],
    /// 这一格的定位：已加过格 dx/dy 的笔位与基线
    pub x: f64,
    pub y: f64,
    pub role: &'a str,
    pub size: f64,
    pub cell: &'a Cell,
    /// 同一行里文字格已排出的字（组件格总是排在文字格之后）
    pub row: &'a [PlacedText],
}

/// 字体竖向度量（`flow: block` 用）：ascent 取正值，height = 一行的字高。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct FontMetricsLike {
    pub ascent: f64,
    pub height: f64,
}

/// 模板排版的上下文，由调用方实现。
pub trait RegionEnv {
    /// 字段路径 → 值。返回空或 None 都算空。
    fn field(&self, path: &str) -> Option<Vec<FieldValue>>;
    /// 页号（奇数页 = 右手页；`inner`/`outer` 按它换边）。
    fn page_no(&self) -> f64;
    /// 版心左右缘
    fn content(&self) -> (f64, f64);
    fn page_width(&self) -> Option<f64> {
        None
    }
    /// 区域整体下移（半页起排）。
    fn dy(&self) -> Option<f64> {
        None
    }
    fn size_of(&self, role: &str) -> f64;
    fn measure(&self, role: &str, text: &str, size: f64) -> f64;
    /// 组件实现；没有这个组件回 None。
    fn component(&self, _name: &str, _call: &ComponentCall) -> Option<R<Vec<Value>>> {
        None
    }
    /// 字体竖向度量（`flow: block` 要）；不给回 None。
    fn font_metrics(&self, _role: &str, _size: f64) -> Option<FontMetricsLike> {
        None
    }
}

// ───────────────────────── 表达式求值 ─────────────────────────

/// 求值结果（TS 的 `unknown`）。
#[derive(Clone, Debug, PartialEq)]
pub enum EvalVal {
    Num(f64),
    Str(String),
    Bool(bool),
    Undef,
    List(Vec<EvalVal>),
}

impl EvalVal {
    /// `Boolean(v)`
    fn truthy(&self) -> bool {
        match self {
            EvalVal::Num(x) => *x != 0.0 && !x.is_nan(),
            EvalVal::Str(s) => !s.is_empty(),
            EvalVal::Bool(b) => *b,
            EvalVal::Undef => false,
            EvalVal::List(_) => true,
        }
    }
}

pub fn eval_expr(e: &Expr, env: &dyn RegionEnv, role: &str) -> R<EvalVal> {
    Ok(match e {
        Expr::Num { v, unit } => match unit.as_deref() {
            None | Some("pt") => EvalVal::Num(*v),
            Some("em") => EvalVal::Num(v * env.size_of(role)),
            Some(u) => return err(format!("模板里不支持单位 {u}")),
        },
        Expr::Str { v } | Expr::Hash { v } => EvalVal::Str(v.clone()),
        Expr::Id { v } => match v.as_str() {
            "true" => EvalVal::Bool(true),
            "false" => EvalVal::Bool(false),
            "content-left" => EvalVal::Num(env.content().0),
            "content-right" => EvalVal::Num(env.content().1),
            "page-width" => env.page_width().map_or(EvalVal::Undef, EvalVal::Num),
            _ => EvalVal::Str(v.clone()),
        },
        Expr::Call { name, .. } => return err(format!("表达式里认不出函数 {name}()")),
        Expr::Neg { a } => EvalVal::Num(-num(&eval_expr(a, env, role)?, e)?),
        Expr::Bin { op, a, b } => {
            let a = num(&eval_expr(a, env, role)?, e)?;
            let b = num(&eval_expr(b, env, role)?, e)?;
            EvalVal::Num(match op.as_str() {
                "+" => a + b,
                "-" => a - b,
                "*" => a * b,
                _ => a / b,
            })
        }
        Expr::Seq { items } | Expr::List { items } => EvalVal::List(items.iter().map(|x| eval_expr(x, env, role)).collect::<R<_>>()?),
    })
}

fn num(v: &EvalVal, e: &Expr) -> R<f64> {
    match v {
        EvalVal::Num(x) if x.is_finite() => Ok(*x),
        _ => err(format!("这里要数字：{}", js_json(&serde_json::to_value(e).expect("表达式可序列化")))),
    }
}

pub fn eval_num(e: Option<&Expr>, env: &dyn RegionEnv, role: Option<&str>) -> R<Option<f64>> {
    match e {
        None => Ok(None),
        Some(e) => Ok(Some(num(&eval_expr(e, env, role.unwrap_or("note"))?, e)?)),
    }
}

pub fn eval_bool(e: Option<&Expr>, env: &dyn RegionEnv, dflt: bool) -> R<bool> {
    let Some(e) = e else { return Ok(dflt) };
    Ok(match eval_expr(e, env, "note")? {
        EvalVal::Bool(b) => b,
        EvalVal::Str(s) if s == "none" => false,
        v => v.truthy(),
    })
}

// ───────────────────────── 过滤器 ─────────────────────────

const CREDIT_LABEL: [(&str, &str); 7] = [
    ("lyricist", "作词"),
    ("poet", "作词"),
    ("composer", "作曲"),
    ("arranger", "编曲"),
    ("words-and-music", "词曲"),
    ("translator", "译词"),
    ("transcriber", "制谱"),
];

/// 过滤器名，顺序同 TS 的 `Object.keys(FILTERS)`。
pub const FILTER_NAMES: [&str; 9] = [
    "strip-zero",
    "cn-semicolon",
    "unescape-newline",
    "dash-empty",
    "drop-parens",
    "paren-to-line",
    "lines-trim",
    "lines-indent",
    "label-by-type",
];

fn map_text(vals: Vec<FieldValue>, f: impl Fn(&str) -> String) -> Vec<FieldValue> {
    vals.into_iter().map(|v| FieldValue { text: f(&v.text), ..v }).collect()
}

/// `t.replace(/^0+(?=\d)/, "")`
fn strip_zero(t: &str) -> String {
    let z = t.bytes().take_while(|&b| b == b'0').count();
    if z == 0 {
        return t.to_string();
    }
    let next_digit = t.as_bytes().get(z).is_some_and(u8::is_ascii_digit);
    t[if next_digit { z } else { z - 1 }..].to_string()
}

const OPEN: [char; 2] = ['(', '（'];
const CLOSE: [char; 2] = [')', '）'];

/// 反复去掉最左一对 `[(（][^()（）]*[)）]`。
fn drop_parens(t: &str) -> String {
    let mut s: Vec<char> = t.chars().collect();
    'outer: loop {
        for p in 0..s.len() {
            if !OPEN.contains(&s[p]) {
                continue;
            }
            let mut q = p + 1;
            while q < s.len() && !OPEN.contains(&s[q]) && !CLOSE.contains(&s[q]) {
                q += 1;
            }
            if q < s.len() && CLOSE.contains(&s[q]) {
                s.drain(p..=q);
                continue 'outer;
            }
        }
        return s.into_iter().collect();
    }
}

fn is_line_term(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `/^(.+?)[（(](.+?)[）)]$/`
fn paren_split(t: &str) -> Option<(String, String)> {
    let c: Vec<char> = t.chars().collect();
    let n = c.len();
    if n < 4 || c.iter().any(|&x| is_line_term(x)) || !CLOSE.contains(&c[n - 1]) {
        return None;
    }
    // 第二组至少一个字：开括号最晚在 n-3
    let i = (1..n - 2).find(|&i| OPEN.contains(&c[i]))?;
    Some((c[..i].iter().collect(), c[i + 1..n - 1].iter().collect()))
}

/// `s.split(/\r?\n/)`
fn split_lines(s: &str) -> Vec<&str> {
    s.split('\n').map(|x| x.strip_suffix('\r').unwrap_or(x)).collect()
}

pub fn apply_filter(name: &str, vals: Vec<FieldValue>) -> R<Vec<FieldValue>> {
    Ok(match name {
        "strip-zero" => map_text(vals, strip_zero),
        "cn-semicolon" => map_text(vals, |t| t.replace(';', "；")),
        "unescape-newline" => map_text(vals, |t| t.replace("\\n", "\n")),
        "dash-empty" => vals.into_iter().filter(|v| trim(&v.text) != "-").collect(),
        "drop-parens" => map_text(vals, drop_parens),
        "paren-to-line" => vals
            .into_iter()
            .flat_map(|v| match paren_split(&v.text) {
                Some((a, b)) => vec![FieldValue { text: a, ..v.clone() }, FieldValue { text: b, ..v }],
                None => vec![v],
            })
            .collect(),
        "lines-trim" => vals
            .into_iter()
            .flat_map(|v| {
                split_lines(&v.text)
                    .into_iter()
                    .map(trim)
                    .filter(|t| !t.is_empty())
                    .map(|t| FieldValue { text: t.to_string(), kind: v.kind.clone() })
                    .collect::<Vec<_>>()
            })
            .collect(),
        "lines-indent" => vals
            .into_iter()
            .flat_map(|v| {
                split_lines(&v.text)
                    .into_iter()
                    .map(|t| t.trim_end_matches(is_space))
                    .filter(|t| !trim(t).is_empty())
                    .map(|t| FieldValue { text: t.to_string(), kind: v.kind.clone() })
                    .collect::<Vec<_>>()
            })
            .collect(),
        "label-by-type" => vals
            .into_iter()
            .map(|v| {
                if v.text.contains([':', '：']) {
                    return v;
                }
                let ty = v.kind.as_deref().unwrap_or("");
                let label = CREDIT_LABEL.iter().find(|(k, _)| *k == ty).map(|(_, l)| l.to_string()).unwrap_or_else(|| v.kind.clone().unwrap_or_else(|| "undefined".into()));
                FieldValue { text: format!("{label}：{}", v.text), ..v }
            })
            .collect(),
        f => return err(format!("认不出的过滤器 {f}")),
    })
}

// ───────────────────────── 内容 ─────────────────────────

/// 一段插值文字 → 若干行。空值折叠：所有插值字段都空时整行不出。
pub fn expand_text(parts: &[TextPart], env: &dyn RegionEnv) -> R<Vec<String>> {
    let mut resolved: Vec<Option<Vec<FieldValue>>> = vec![];
    for p in parts {
        match p {
            TextPart::Lit(_) => resolved.push(None),
            TextPart::Field { path, filters } => {
                let mut vals = env.field(path).unwrap_or_default();
                for f in filters {
                    vals = apply_filter(f, vals)?;
                }
                resolved.push(Some(vals.into_iter().filter(|v| !v.text.is_empty()).collect()));
            }
        }
    }
    let fields: Vec<&Vec<FieldValue>> = resolved.iter().flatten().collect();
    if !fields.is_empty() && fields.iter().all(|f| f.is_empty()) {
        return Ok(vec![]);
    }
    let n = fields.iter().map(|f| f.len()).max().unwrap_or(0).max(1);
    let mut out = vec![];
    for i in 0..n {
        let mut s = String::new();
        for (k, p) in parts.iter().enumerate() {
            match p {
                TextPart::Lit(t) => s.push_str(t),
                TextPart::Field { .. } => {
                    let vals = resolved[k].as_ref().expect("字段段有值");
                    // 单值字段每行都印；多值字段逐行取
                    let v = if vals.len() == 1 { vals.first() } else { vals.get(i) };
                    if let Some(v) = v {
                        s.push_str(&v.text);
                    }
                }
            }
        }
        if !s.is_empty() {
            out.push(s);
        }
    }
    Ok(out)
}

// ───────────────────────── 区域排版 ─────────────────────────

fn slot_align(slot: &str, odd: bool) -> &'static str {
    match slot {
        "left" => "left",
        "right" => "right",
        "center" => "center",
        "inner" => {
            if odd {
                "left"
            } else {
                "right"
            }
        }
        _ => {
            if odd {
                "right"
            } else {
                "left"
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegionResult {
    pub items: Vec<Placed>,
    /// fixed：首行基线到末行基线；block：区域高
    pub span: f64,
    /// block：内容高
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<f64>,
}

fn is_id(e: Option<&Expr>, v: &str) -> bool {
    matches!(e, Some(Expr::Id { v: x }) if x == v)
}

/// 排一个区域。`display` 为假时返回空。规则见 TS 的 `layoutRegion`。
pub fn layout_region(region: Option<&Region>, env: &dyn RegionEnv) -> R<RegionResult> {
    let Some(region) = region else { return Ok(RegionResult { items: vec![], span: 0.0, content: None }) };
    if !eval_bool(region.props.get("display"), env, true)? {
        return Ok(RegionResult { items: vec![], span: 0.0, content: None });
    }
    let odd = env.page_no() % 2.0 == 1.0;
    let dy = env.dy().unwrap_or(0.0);
    let block = is_id(region.props.get("flow"), "block");
    let align_page = is_id(region.props.get("align-x"), "page");
    let inset = eval_num(region.props.get("inset"), env, None)?;
    let (cl, cr) = env.content();
    let mut left = if align_page { 0.0 } else { cl };
    let mut right = if align_page { env.page_width().unwrap_or(cr) } else { cr };
    if let Some(inset) = inset {
        left += inset;
        right -= inset;
    }
    let mut items: Vec<Placed> = vec![];

    if block {
        let mut cursor = dy;
        let mut content = 0.0;
        for row in &region.rows {
            let gap = eval_num(row.props.get("gap-before"), env, None)?.unwrap_or(0.0);
            let base = eval_num(row.props.get("baseline"), env, None)?;
            let top = eval_num(row.props.get("top"), env, None)?;
            let row_top = match (base, top) {
                (Some(_), _) => dy,
                (None, Some(t)) => dy + t,
                _ => cursor + if content > 0.0 { gap } else { 0.0 },
            };
            let mut row_h: f64 = 0.0;
            for got in in_row_order(&row.cells, |cell, texts| layout_block_cell(region, cell, row_top, base, left, right, odd, env, texts))? {
                items.extend(got.0);
                row_h = dolce_base::js::max(row_h, got.1);
            }
            if row_h == 0.0 {
                continue;
            }
            content += row_h;
            cursor = row_top + row_h;
        }
        let span = match region.props.get("extent") {
            Some(ext) => eval_extent(ext, content, env)?,
            None => content,
        };
        return Ok(RegionResult { items, span, content: Some(content) });
    }

    let mut first_y: Option<f64> = None;
    let mut last_y: Option<f64> = None;
    for row in &region.rows {
        let Some(base) = eval_num(row.props.get("baseline"), env, None)? else {
            return err("flow: fixed 的区域里每行都要写 baseline");
        };
        let row_y = base + dy;
        let mut row_last = row_y;
        let mut any = false;
        for got in in_row_order(&row.cells, |cell, texts| layout_cell(cell, row_y, left, right, odd, env, texts))? {
            if !got.0.is_empty() {
                any = true;
            }
            items.extend(got.0);
            row_last = dolce_base::js::max(row_last, got.1);
        }
        if !any {
            continue;
        }
        first_y.get_or_insert(row_y);
        last_y = Some(row_last);
    }
    let span = match (first_y, last_y) {
        (Some(f), Some(l)) => l - f,
        _ => 0.0,
    };
    Ok(RegionResult { items, span, content: None })
}

/// 一行里的格：先排文字格、再排组件格（组件拿得到同行文字），结果仍按格的书写顺序返回。
fn in_row_order(cells: &[Cell], mut lay: impl FnMut(&Cell, &[PlacedText]) -> R<(Vec<Placed>, f64)>) -> R<Vec<(Vec<Placed>, f64)>> {
    let is_component = |c: &Cell| c.lines.iter().any(|l| matches!(l.content, Content::Component { .. }));
    let mut out: Vec<Option<(Vec<Placed>, f64)>> = vec![None; cells.len()];
    let mut texts: Vec<PlacedText> = vec![];
    for (i, c) in cells.iter().enumerate() {
        if is_component(c) {
            continue;
        }
        let got = lay(c, &texts)?;
        for p in &got.0 {
            if let Placed::Text(t) = p {
                texts.push(t.clone());
            }
        }
        out[i] = Some(got);
    }
    for (i, c) in cells.iter().enumerate() {
        if is_component(c) {
            out[i] = Some(lay(c, &texts)?);
        }
    }
    Ok(out.into_iter().map(|x| x.expect("每格都排过")).collect())
}

/// `extent` 里的 `content` 换成内容高再求值。
fn eval_extent(e: &Expr, content: f64, env: &dyn RegionEnv) -> R<f64> {
    fn sub(x: &Expr, content: f64) -> Expr {
        match x {
            Expr::Id { v } if v == "content" => Expr::Num { v: content, unit: None },
            Expr::Bin { op, a, b } => Expr::Bin { op: op.clone(), a: Box::new(sub(a, content)), b: Box::new(sub(b, content)) },
            Expr::Neg { a } => Expr::Neg { a: Box::new(sub(a, content)) },
            _ => x.clone(),
        }
    }
    Ok(eval_num(Some(&sub(e, content)), env, None)?.expect("给了表达式"))
}

fn font_metrics(env: &dyn RegionEnv, role: &str, size: f64) -> R<FontMetricsLike> {
    match env.font_metrics(role, size) {
        Some(m) => Ok(m),
        None => err("flow: block 要调用方给 fontMetrics"),
    }
}

fn slot_edge(slot: &str, left: f64, right: f64, odd: bool) -> (&'static str, f64) {
    let align = slot_align(slot, odd);
    let edge = match align {
        "left" => left,
        "right" => right,
        _ => (left + right) / 2.0,
    };
    (align, edge)
}

fn call_component(env: &dyn RegionEnv, name: &str, call: &ComponentCall) -> R<Vec<Placed>> {
    match env.component(name, call) {
        Some(r) => Ok(r?.into_iter().map(|item| Placed::Raw { item }).collect()),
        None => err(format!("模板用了组件 {name}()，调用方没给实现")),
    }
}

#[allow(clippy::too_many_arguments)]
fn layout_block_cell(
    region: &Region,
    cell: &Cell,
    row_top: f64,
    base: Option<f64>,
    left: f64,
    right: f64,
    odd: bool,
    env: &dyn RegionEnv,
    row_texts: &[PlacedText],
) -> R<(Vec<Placed>, f64)> {
    let mut items = vec![];
    let (align, edge) = slot_edge(&cell.slot, left, right, odd);
    let lh_expr = cell.props.get("line-height").or_else(|| region.props.get("line-height"));
    let mut y: Option<f64> = None;
    let mut height = 0.0;
    for line in &cell.lines {
        let role = line.role.as_deref().unwrap_or("note");
        let size = env.size_of(role);
        let x0 = match &line.at {
            Some(at) => eval_num(Some(at), env, Some(role))?.expect("有表达式"),
            None => edge,
        };
        let x = match cell.props.get("dx") {
            Some(dx) => x0 + eval_num(Some(dx), env, Some(role))?.expect("有表达式"),
            None => x0,
        };
        match &line.content {
            Content::Component { name, args } => {
                let cy = y.unwrap_or(match base {
                    Some(b) => row_top + b,
                    None => row_top,
                });
                let call = ComponentCall { args, x, y: cy, role, size, cell, row: row_texts };
                items.extend(call_component(env, name, &call)?);
            }
            Content::Text { parts } => {
                let texts: Vec<String> = expand_text(parts, env)?.iter().flat_map(|t| t.split('\n').map(str::to_string).collect::<Vec<_>>()).collect();
                if texts.is_empty() {
                    continue;
                }
                let fm = font_metrics(env, role, size)?;
                let lead = eval_num(lh_expr, env, Some(role))?.unwrap_or(fm.height * 1.2);
                for text in texts {
                    y = Some(match y {
                        None => match base {
                            Some(b) => row_top + b,
                            None => row_top + fm.ascent,
                        },
                        Some(y) => y + lead,
                    });
                    items.push(Placed::Text(PlacedText { text, role: role.to_string(), size, x, y: y.expect("刚赋值"), align: align.to_string() }));
                    height += fm.height;
                }
            }
        }
    }
    Ok((items, height))
}

fn layout_cell(cell: &Cell, row_y: f64, left: f64, right: f64, odd: bool, env: &dyn RegionEnv, texts: &[PlacedText]) -> R<(Vec<Placed>, f64)> {
    let mut items = vec![];
    let (align, edge) = slot_edge(&cell.slot, left, right, odd);
    let cdx = cell.props.get("dx");
    let cdy = cell.props.get("dy");
    let mut i = 0usize;
    let mut last_y = row_y;
    for line in &cell.lines {
        let role = line.role.as_deref().unwrap_or("note");
        let size = env.size_of(role);
        let x0 = match &line.at {
            Some(at) => eval_num(Some(at), env, Some(role))?.expect("有表达式"),
            None => edge,
        };
        let x = match cdx {
            Some(dx) => x0 + eval_num(Some(dx), env, Some(role))?.expect("有表达式"),
            None => x0,
        };
        let y0 = match cdy {
            Some(d) => row_y + eval_num(Some(d), env, Some(role))?.expect("有表达式"),
            None => row_y,
        };
        match &line.content {
            Content::Component { name, args } => {
                let call = ComponentCall { args, x, y: y0, role, size, cell, row: texts };
                items.extend(call_component(env, name, &call)?);
            }
            Content::Text { parts } => {
                for text in expand_text(parts, env)? {
                    let y = if i == 0 { y0 } else { y0 + i as f64 * line_lead(cell, env, role)? };
                    items.push(Placed::Text(PlacedText { text, role: role.to_string(), size, x, y, align: align.to_string() }));
                    last_y = dolce_base::js::max(last_y, y);
                    i += 1;
                }
            }
        }
    }
    Ok((items, last_y))
}

/// 格内换行的行距。`line-height` 是长度：`1.2em` 是字号的倍数，`12pt` 或裸数是绝对值。
fn line_lead(cell: &Cell, env: &dyn RegionEnv, role: &str) -> R<f64> {
    match cell.props.get("line-height") {
        Some(g) => Ok(eval_num(Some(g), env, Some(role))?.expect("有表达式")),
        None => Ok(env.size_of(role) * 1.2),
    }
}

// ───────────────────────── 字段 ─────────────────────────

/// `songFields` 的 `extra`：上下文字段（`page.no`、`toc.seq`…）与调用方特有的字段，优先于模型。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FieldExtra {
    Str(String),
    Vals(Vec<FieldValue>),
}

/// `Song` → 字段取值（`work.*`、`creators.<类型|*>`、`identification.rights`、`pageText.*`、`meta.*`）。
/// `extra` 里有这个键就用它（值为 None = undefined，也不再查模型）。
pub fn song_field(song: Option<&Song>, extra: &IndexMap<String, Option<FieldExtra>>, path: &str) -> Option<Vec<FieldValue>> {
    let one = |t: Option<&str>| -> Vec<FieldValue> {
        match t {
            Some(t) if !t.is_empty() => vec![FieldValue::text(t)],
            _ => vec![],
        }
    };
    if let Some(v) = extra.get(path) {
        return match v {
            Some(FieldExtra::Str(s)) => Some(one(Some(s))),
            Some(FieldExtra::Vals(v)) => Some(v.clone()),
            None => None,
        };
    }
    let song = song?;
    let (head, tail) = path.split_once('.').unwrap_or((path, ""));
    match head {
        "work" => {
            let w = &song.work;
            let v = match tail {
                "subtitles" => return Some(w.subtitles.iter().map(FieldValue::text).collect()),
                "number" => &w.number,
                "title" => &w.title,
                "movementTitle" => &w.movement_title,
                "version" => &w.version,
                _ => return None,
            };
            v.as_deref().map(|s| one(Some(s)))
        }
        "creators" => Some(
            song.identification
                .iter()
                .flat_map(|i| i.creators.iter())
                .filter(|c| tail == "*" || c.kind == tail)
                .map(|c| FieldValue { text: c.text.clone(), kind: Some(c.kind.clone()) })
                .collect(),
        ),
        "identification" => (tail == "rights").then(|| one(song.identification.as_ref().and_then(|i| i.rights.as_deref()))),
        "pageText" => {
            let pt = song.page_text.as_ref()?;
            let arr = |v: &Vec<String>| Some(v.iter().map(FieldValue::text).collect());
            match tail {
                "indexLeft" => pt.index_left.as_deref().map(|s| one(Some(s))),
                "indexRight" => pt.index_right.as_deref().map(|s| one(Some(s))),
                "topLeft" => arr(&pt.top_left),
                "topRight" => arr(&pt.top_right),
                "bottomLeft" => arr(&pt.bottom_left),
                "bottomCenter" => arr(&pt.bottom_center),
                "bottomRight" => arr(&pt.bottom_right),
                _ => None,
            }
        }
        "meta" => Some(song.meta.as_ref().and_then(|m| m.get(tail)).map(|v| v.iter().map(FieldValue::text).collect()).unwrap_or_default()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters() {
        assert_eq!(strip_zero("007"), "7");
        assert_eq!(strip_zero("000"), "0");
        assert_eq!(strip_zero("00a"), "0a");
        assert_eq!(drop_parens("甲(乙)丙（丁）"), "甲丙");
        assert_eq!(drop_parens("a((b)c)"), "a");
        assert_eq!(paren_split("甲（乙）"), Some(("甲".into(), "乙".into())));
        assert_eq!(paren_split("（乙）"), None);
    }

    /// ss-roundtrip §7：空值折叠——插值字段全空整行不出；单值字段每行都印，多值字段逐行取，行数取最大项数。
    #[test]
    fn empty_folding() {
        struct Env;
        impl RegionEnv for Env {
            fn field(&self, path: &str) -> Option<Vec<FieldValue>> {
                Some(match path {
                    "one" => vec![FieldValue::text("甲")],
                    "many" => vec![FieldValue::text("1"), FieldValue::text("2"), FieldValue::text("3")],
                    _ => vec![],
                })
            }
            fn page_no(&self) -> f64 {
                1.0
            }
            fn content(&self) -> (f64, f64) {
                (0.0, 0.0)
            }
            fn size_of(&self, _: &str) -> f64 {
                10.0
            }
            fn measure(&self, _: &str, _: &str, _: f64) -> f64 {
                0.0
            }
        }
        let run = |s: &str| expand_text(&crate::ss::parse_interp(s, None).unwrap(), &Env).unwrap().join("|");
        assert_eq!(run("{one}-{many}"), "甲-1|甲-2|甲-3");
        assert_eq!(run("[{none}]"), "");
        assert_eq!(run("{one}{none}"), "甲");
        assert_eq!(run("{none}{many}"), "1|2|3");
    }
}
