//! `.ss` 歌本样式表：文本 ↔ 规则（照 `style/ss.ts`）。语法规范见 docs/格式/ss.md。
//!
//! 手写解析（词法 → 语句），报错带 `行:列`（列按 UTF-16 码元数，同 TS）。只做「形状」：长度表达式、字段插值、
//! 组件调用都原样存成 AST（`template.rs` 在排版时按上下文求值）。成书的 `BookStyle` 由解析结果另算（`bookss.rs`）。
//!
//! 解析结果是一串 [`StyleRule`]，`set` 是与 TS 解析结果逐字段相同的 JSON 形状（数一律 f64）。

use crate::cascade::{StyleContext, StyleRule};
use crate::keys::{keys_of_block, lookup, FLOW_KEYS, TOC_KEYS};
use crate::sheet::is_known_role;
use crate::template::FILTER_NAMES;
use crate::value::{js_json, js_to_string, json_quote, num, to_uint32};
use dolce_base::js::{is_space, num_to_string, number};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

// ───────────────────────── AST ─────────────────────────

/// 表达式。长度、数字、布尔、标识符、函数调用、四则运算、空格序列、逗号列表。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum Expr {
    Num {
        v: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
    },
    Str {
        v: String,
    },
    Id {
        v: String,
    },
    Hash {
        v: String,
    },
    Call {
        name: String,
        args: Vec<Expr>,
    },
    Bin {
        op: String,
        a: Box<Expr>,
        b: Box<Expr>,
    },
    Neg {
        a: Box<Expr>,
    },
    Seq {
        items: Vec<Expr>,
    },
    List {
        items: Vec<Expr>,
    },
}

impl Expr {
    fn num(v: f64, unit: Option<String>) -> Expr {
        Expr::Num { v, unit }
    }
    fn is_id(&self, s: &str) -> bool {
        matches!(self, Expr::Id { v } if v == s)
    }
}

pub const SLOTS: [&str; 5] = ["left", "center", "right", "inner", "outer"];

/// 插值串里的一段：字面文字或 `{路径 | 过滤器 …}`。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TextPart {
    Lit(String),
    Field { path: String, filters: Vec<String> },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Content {
    Text { parts: Vec<TextPart> },
    Component { name: String, args: Vec<Expr> },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CellLine {
    pub content: Content,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<Expr>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Cell {
    pub slot: String,
    pub lines: Vec<CellLine>,
    /// 块形式的其余声明：dx dy line-height avoid …
    pub props: IndexMap<String, Expr>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct Row {
    pub props: IndexMap<String, Expr>,
    pub cells: Vec<Cell>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct Region {
    pub props: IndexMap<String, Expr>,
    pub rows: Vec<Row>,
}

pub const REGION_NAMES: [&str; 5] = ["song-head", "song-foot", "page-header", "page-footer", "toc"];

const REGION_PROPS: [&str; 7] = ["flow", "align-x", "inset", "display", "line-height", "extent", "gap-after"];
const ROW_PROPS: [&str; 5] = ["baseline", "top", "gap-before", "step", "repeat"];
const CELL_PROPS: [&str; 7] = ["content", "role", "at", "dx", "dy", "line-height", "avoid"];
const COMPONENTS: [&str; 2] = ["key-meter", "leader"];
const ROLE_PROPS: [&str; 8] = ["size", "color", "family", "font", "weight", "features", "align-mode", "baseline-adjust"];
const FONT_FACE_PROPS: [&str; 5] = ["family", "file", "face", "mode", "bold"];
const PAGE_PROPS: [&str; 7] = ["paper", "orientation", "size", "margin", "mirror", "ink", "background"];
const MEDIA_DIMS: [&str; 5] = ["mode", "engine", "paged", "page", "verse"];

/// 角色声明里 kebab-case 的属性 → `RoleDecl` 字段。
const ROLE_PROP_FIELD: [(&str, &str); 2] = [("align-mode", "alignMode"), ("baseline-adjust", "baselineAdjust")];

/// 报错：`行:列 说明`（SsError），或不带位置的说明（TS 里抛的普通 Error）。
#[derive(Clone, Debug, PartialEq)]
pub struct SsError {
    pub message: String,
}

impl SsError {
    fn at(msg: impl AsRef<str>, line: u32, col: u32) -> SsError {
        SsError { message: format!("{line}:{col} {}", msg.as_ref()) }
    }
    fn plain(msg: impl Into<String>) -> SsError {
        SsError { message: msg.into() }
    }
}

impl std::fmt::Display for SsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SsError {}

type R<T> = Result<T, SsError>;

// ───────────────────────── 词法 ─────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum T {
    Id,
    Str,
    Num,
    Hash,
    At,
    P,
    Eof,
}

#[derive(Clone, Debug)]
struct Tok {
    t: T,
    /// 非数字记号的值（数字记号是 `raw`）
    v: String,
    n: f64,
    unit: Option<String>,
    raw: String,
    line: u32,
    col: u32,
}

impl Tok {
    /// `JSON.stringify(tok.v)`
    fn v_json(&self) -> String {
        if self.t == T::Num {
            if self.n.is_finite() { num_to_string(self.n) } else { "null".into() }
        } else {
            json_quote(&self.v)
        }
    }
    /// 记号值当对象键（`pos[tok.v]`）
    fn v_key(&self) -> String {
        if self.t == T::Num {
            num_to_string(self.n)
        } else {
            self.v.clone()
        }
    }
    fn is_p(&self, s: &str) -> bool {
        self.t == T::P && self.v == s
    }
}

fn u16len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

fn id_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || c as u32 >= 0x80
}

fn id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' || c as u32 >= 0x80
}

/// `^[+-]?(\d+(\.\d+)?|\.\d+)` 的匹配长度（字符数，都是 ASCII）。
fn match_number(s: &[char]) -> Option<usize> {
    let mut i = 0;
    if matches!(s.first(), Some('+' | '-')) {
        i = 1;
    }
    let digits = |from: usize| s[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let d = digits(i);
    if d > 0 {
        i += d;
        if s.get(i) == Some(&'.') {
            let f = digits(i + 1);
            if f > 0 {
                i += 1 + f;
            }
        }
        Some(i)
    } else if s.get(i) == Some(&'.') {
        let f = digits(i + 1);
        (f > 0).then_some(i + 1 + f)
    } else {
        None
    }
}

fn lex(src: &str) -> R<Vec<Tok>> {
    let s: Vec<char> = src.chars().collect();
    let mut out: Vec<Tok> = vec![];
    let mut i = 0usize;
    let mut line = 1u32;
    let mut col = 1u32;
    let adv = |n: usize, i: &mut usize, line: &mut u32, col: &mut u32| {
        for _ in 0..n {
            if s[*i] == '\n' {
                *line += 1;
                *col = 1;
            } else {
                *col += s[*i].len_utf16() as u32;
            }
            *i += 1;
        }
    };
    let tok = |t: T, v: String, line: u32, col: u32| Tok { t, v, n: 0.0, unit: None, raw: String::new(), line, col };
    while i < s.len() {
        let c = s[i];
        if is_space(c) {
            adv(1, &mut i, &mut line, &mut col);
            continue;
        }
        if c == '/' && s.get(i + 1) == Some(&'*') {
            let end = (i + 2..s.len().saturating_sub(1)).find(|&j| s[j] == '*' && s[j + 1] == '/');
            let Some(end) = end else { return Err(SsError::at("注释没有收尾", line, col)) };
            adv(end + 2 - i, &mut i, &mut line, &mut col);
            continue;
        }
        let (l0, c0) = (line, col);
        if c == '"' || c == '\'' {
            let mut j = i + 1;
            let mut v = String::new();
            while j < s.len() && s[j] != c {
                if s[j] == '\\' && j + 1 < s.len() {
                    let n = s[j + 1];
                    v.push(if n == 'n' { '\n' } else { n });
                    j += 2;
                } else {
                    if s[j] == '\n' {
                        return Err(SsError::at("字符串没有收尾", l0, c0));
                    }
                    v.push(s[j]);
                    j += 1;
                }
            }
            if j >= s.len() {
                return Err(SsError::at("字符串没有收尾", l0, c0));
            }
            out.push(tok(T::Str, v, l0, c0));
            adv(j + 1 - i, &mut i, &mut line, &mut col);
            continue;
        }
        // 数字：`-` 只有紧跟数字、且前一个记号不是能当左操作数的东西时才算负号的一部分
        let prev_is_operand = out.last().is_some_and(|p| matches!(p.t, T::Num | T::Id | T::Str) || p.is_p(")"));
        let next = s.get(i + 1).copied();
        let num_next = |n: Option<char>| n.is_some_and(|n| n.is_ascii_digit() || n == '.');
        if c.is_ascii_digit()
            || (c == '.' && next.is_some_and(|n| n.is_ascii_digit()))
            || ((c == '-' || c == '+') && num_next(next) && !prev_is_operand)
        {
            let Some(len) = match_number(&s[i..]) else {
                // TS 这里是 `regex.exec(...)!` 取 `[0]`：配不上就是运行时错
                return Err(SsError::plain("Cannot read properties of null (reading '0')"));
            };
            let mut raw: String = s[i..i + len].iter().collect();
            let mut unit = None;
            let rest = &s[i + len..];
            for u in ["pt", "em", "sp"] {
                let uc: Vec<char> = u.chars().collect();
                if rest.starts_with(&uc) && !rest.get(2).is_some_and(|&c| id_char(c)) {
                    unit = Some(u.to_string());
                    break;
                }
            }
            let n = number(&raw);
            if let Some(u) = &unit {
                raw.push_str(u);
            }
            let rl = raw.chars().count();
            out.push(Tok { t: T::Num, v: String::new(), n, unit, raw, line: l0, col: c0 });
            adv(rl, &mut i, &mut line, &mut col);
            continue;
        }
        if c == '#' {
            let n = s[i + 1..].iter().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')).count();
            if n == 0 {
                return Err(SsError::at("`#` 后面要跟名字", l0, c0));
            }
            out.push(tok(T::Hash, s[i + 1..i + 1 + n].iter().collect(), l0, c0));
            adv(n + 1, &mut i, &mut line, &mut col);
            continue;
        }
        if c == '@' {
            let ok = s.get(i + 1).is_some_and(|c| c.is_ascii_alphabetic());
            if !ok {
                return Err(SsError::at("`@` 后面要跟规则名", l0, c0));
            }
            let n = 1 + s[i + 2..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == '-').count();
            out.push(tok(T::At, s[i + 1..i + 1 + n].iter().collect(), l0, c0));
            adv(n + 1, &mut i, &mut line, &mut col);
            continue;
        }
        if id_start(c) {
            let mut j = i + 1;
            while j < s.len() && id_char(s[j]) {
                j += 1;
            }
            // 标识符里的 `-` 不能收尾（`a- b`），`.` 也不能收尾
            while j > i + 1 && matches!(s[j - 1], '-' | '.') {
                j -= 1;
            }
            out.push(tok(T::Id, s[i..j].iter().collect(), l0, c0));
            adv(j - i, &mut i, &mut line, &mut col);
            continue;
        }
        if "{}()[];:,+-*/|".contains(c) {
            out.push(tok(T::P, c.to_string(), l0, c0));
            adv(1, &mut i, &mut line, &mut col);
            continue;
        }
        // `JSON.stringify(c)`：c 是一个 UTF-16 码元（到这里的都在 BMP 里）
        return Err(SsError::at(format!("认不出的字符 {}", json_quote(&c.to_string())), l0, c0));
    }
    out.push(Tok { t: T::Eof, v: String::new(), n: 0.0, unit: None, raw: String::new(), line, col });
    Ok(out)
}

fn tok_len(t: &Tok) -> u32 {
    match t.t {
        T::Str => u16len(&t.v) + 2,
        T::Num => t.raw.chars().count() as u32,
        T::Hash | T::At => u16len(&t.v) + 1,
        _ => u16len(&t.v),
    }
}

// ───────────────────────── 语句 ─────────────────────────

type Positions = IndexMap<String, Tok>;

struct Parser {
    toks: Vec<Tok>,
    i: usize,
    rules: Vec<StyleRule>,
}

/// `{ k: v, … }` 的对象。
fn obj(pairs: Vec<(&str, Value)>) -> Value {
    Value::Object(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

impl Parser {
    fn peek(&self) -> &Tok {
        &self.toks[self.i.min(self.toks.len() - 1)]
    }
    fn next(&mut self) -> Tok {
        let t = self.toks.get(self.i).unwrap_or_else(|| self.toks.last().expect("有 eof")).clone();
        self.i += 1;
        t
    }
    fn fail_at<X>(&self, msg: impl AsRef<str>, tok: &Tok) -> R<X> {
        Err(SsError::at(msg, tok.line, tok.col))
    }
    fn fail<X>(&self, msg: impl AsRef<str>) -> R<X> {
        self.fail_at(msg, self.peek())
    }
    fn is_p(&self, v: &str) -> bool {
        self.peek().is_p(v)
    }
    fn expect_p(&mut self, v: &str) -> R<Tok> {
        if !self.is_p(v) {
            return self.fail(format!("这里要 `{v}`，却是 {}", self.peek().v_json()));
        }
        Ok(self.next())
    }
    fn expect_id(&mut self) -> R<String> {
        let t = self.next();
        if t.t != T::Id {
            return self.fail_at(format!("这里要名字，却是 {}", t.v_json()), &t);
        }
        Ok(t.v)
    }

    fn parse_sheet(&mut self) -> R<()> {
        self.stmts(&StyleContext::new(), true)
    }

    /// 语句串，到 eof（`top`）或 `}` 为止。
    fn stmts(&mut self, when: &StyleContext, top: bool) -> R<()> {
        loop {
            let done = if top { self.peek().t == T::Eof } else { self.is_p("}") };
            if done {
                return Ok(());
            }
            let t = self.peek().clone();
            if t.t == T::At {
                self.at_rule(when)?;
            } else if t.t == T::Id {
                self.role_rule(when)?;
            } else if self.is_p(";") {
                self.next();
            } else {
                return self.fail(format!("这里要规则，却是 {}", t.v_json()));
            }
        }
    }

    fn push(&mut self, when: &StyleContext, set: Value) {
        let when = if when.is_empty() { None } else { Some(when.clone()) };
        self.rules.push(StyleRule { when, set });
    }

    fn at_rule(&mut self, when: &StyleContext) -> R<()> {
        let at = self.next();
        match at.v.as_str() {
            "flow" | "toc" => {
                let mut pos = Positions::new();
                let decls = self.decl_block(Some(&mut pos))?;
                for k in decls.keys() {
                    let known = if at.v == "flow" { FLOW_KEYS.iter().any(|(n, _)| n == k) } else { TOC_KEYS.iter().any(|(n, _)| n == k) };
                    if !known {
                        let msg = if at.v == "flow" {
                            format!("@flow 认不出的键 {k}（键名见 src/style/keys.ts::FLOW_KEYS）")
                        } else {
                            format!("@toc 认不出的键 {k}（键名见 src/style/keys.ts::TOC_KEYS）")
                        };
                        return self.fail_at(msg, &pos[k]);
                    }
                }
                self.push(when, obj(vec![("template", obj(vec![(at.v.as_str(), decls_value(&decls))]))]));
                Ok(())
            }
            "font-face" => {
                let name = self.expect_id()?;
                let mut pos = Positions::new();
                let decls = self.decl_block(Some(&mut pos))?;
                let mut face = Map::new();
                for (k, v) in &decls {
                    if !FONT_FACE_PROPS.contains(&k.as_str()) {
                        return self.fail_at(format!("@font-face 认不出属性 {k}"), &pos[k]);
                    }
                    face.insert(k.clone(), expr_value(v)?);
                }
                if !face.get("family").is_some_and(Value::is_string) {
                    return self.fail_at(format!("@font-face {name} 缺 family"), &at);
                }
                let mut fonts = Map::new();
                fonts.insert(name, Value::Object(face));
                self.push(when, obj(vec![("template", obj(vec![("fonts", Value::Object(fonts))]))]));
                Ok(())
            }
            "page" => {
                let mut pos = Positions::new();
                let decls = self.decl_block(Some(&mut pos))?;
                let page = self.page_decl(&decls, &pos)?;
                self.push(when, obj(vec![("page", page)]));
                Ok(())
            }
            "jianpu" | "staff" | "break" => {
                let table = keys_of_block(&at.v);
                let mut pos = Positions::new();
                let decls = self.decl_block(Some(&mut pos))?;
                let mut blk = Map::new();
                let mut overrides = Map::new();
                for (k, v) in &decls {
                    if k == "preset" && at.v != "break" {
                        blk.insert("preset".into(), Value::String(expr_word(v)?));
                        continue;
                    }
                    if lookup(table, k).is_none() {
                        return self.fail_at(
                            format!("@{} 认不出的键 {k}（键名见 src/style/keys.ts；字体写在角色上，如 note {{ font: hei }}）", at.v),
                            &pos[k],
                        );
                    }
                    overrides.insert(k.clone(), expr_length(v)?);
                }
                if !overrides.is_empty() {
                    blk.insert("overrides".into(), Value::Object(overrides));
                }
                self.push(when, obj(vec![(at.v.as_str(), Value::Object(blk))]));
                Ok(())
            }
            "pu" => self.fail_at("`@pu` 已删：简谱各档都读 `@jianpu`", &at),
            "template" => {
                let name_tok = self.peek().clone();
                let name = self.expect_id()?;
                if !REGION_NAMES.contains(&name.as_str()) {
                    return self.fail_at(format!("认不出的模板区域 {name}（区域：{}）", REGION_NAMES.join(" ")), &name_tok);
                }
                let reg = self.region_block()?;
                let mut regions = Map::new();
                regions.insert(name, serde_json::to_value(reg).expect("区域可序列化"));
                self.push(when, obj(vec![("template", obj(vec![("regions", Value::Object(regions))]))]));
                Ok(())
            }
            "media" => {
                let mut w = when.clone();
                loop {
                    self.expect_p("(")?;
                    let dim = self.expect_id()?;
                    if !MEDIA_DIMS.contains(&dim.as_str()) {
                        return self.fail(format!("@media 认不出的维度 {dim}"));
                    }
                    self.expect_p(":")?;
                    let v = self.next();
                    if !matches!(v.t, T::Id | T::Num | T::Str) {
                        return self.fail_at("@media 的值要是名字或数字", &v);
                    }
                    let mut val = if v.t == T::Num { num(v.n) } else { Value::String(v.v.clone()) };
                    if dim == "paged" {
                        if val != json!("true") && val != json!("false") {
                            return self.fail_at("@media (paged: …) 只收 true / false", &v);
                        }
                        val = Value::Bool(val == json!("true"));
                    }
                    w.insert(dim, val);
                    self.expect_p(")")?;
                    if self.peek().t == T::Id && self.peek().v == "and" {
                        self.next();
                        continue;
                    }
                    break;
                }
                self.expect_p("{")?;
                self.stmts(&w, false)?;
                self.expect_p("}")?;
                Ok(())
            }
            "song" => self.fail_at("样式表不做逐曲规则：改谱面内容或逐曲微调位置请改 MusicXML（如 scripts/kl2020-prep.mjs）", &at),
            other => self.fail_at(format!("认不出的规则 @{other}"), &at),
        }
    }

    /// `角色, 角色… { 声明 }`。只认角色名，不做元素级限定。
    fn role_rule(&mut self, when: &StyleContext) -> R<()> {
        let mut roles = vec![];
        loop {
            roles.push(self.expect_id()?);
            if self.is_p("[") {
                return self.fail("样式表不做元素级限定：改谱面内容或逐曲微调位置请改 MusicXML");
            }
            if self.is_p(",") {
                self.next();
                continue;
            }
            break;
        }
        let decls = self.decl_block(None)?;
        for r in &roles {
            if !is_known_role(r) {
                return self.fail(format!("认不出的角色 {r}（角色表见 src/style/sheet.ts::STYLE_ROLES / TEMPLATE_ROLES）"));
            }
        }
        for k in decls.keys() {
            if !ROLE_PROPS.contains(&k.as_str()) {
                return self.fail(format!("角色声明认不出属性 {k}"));
            }
        }
        for role in roles {
            let mut m = Map::new();
            m.insert(role, role_decl(&decls)?);
            self.push(when, obj(vec![("roles", Value::Object(m))]));
        }
        Ok(())
    }

    /// `{ 名: 值; … }`。`pos` 给了就记下每个名字的位置（白名单报错用）。
    fn decl_block(&mut self, mut pos: Option<&mut Positions>) -> R<IndexMap<String, Expr>> {
        self.expect_p("{")?;
        let mut out = IndexMap::new();
        while !self.is_p("}") {
            if self.is_p(";") {
                self.next();
                continue;
            }
            if let Some(p) = pos.as_deref_mut() {
                let t = self.peek().clone();
                p.insert(t.v_key(), t);
            }
            let name = self.expect_id()?;
            self.expect_p(":")?;
            let v = self.expr_list(&[";", "}"])?;
            out.insert(name, v);
            if self.is_p(";") {
                self.next();
            }
        }
        self.expect_p("}")?;
        Ok(out)
    }

    /// `@template` 体：区域属性与 `row(…) { … }`。槽位只能写在 row 里。
    fn region_block(&mut self) -> R<Region> {
        self.expect_p("{")?;
        let mut reg = Region::default();
        while !self.is_p("}") {
            if self.is_p(";") {
                self.next();
                continue;
            }
            let t = self.peek().clone();
            if t.t != T::Id {
                return self.fail(format!("模板里要属性或 row，却是 {}", t.v_json()));
            }
            if t.v == "row" {
                self.next();
                let row = self.row_block()?;
                reg.rows.push(row);
                continue;
            }
            if SLOTS.contains(&t.v.as_str()) {
                return self.fail(format!("槽位 {} 要写在 row {{ }} 里", t.v));
            }
            if !REGION_PROPS.contains(&t.v.as_str()) {
                return self.fail(format!("模板区域认不出属性 {}（区域属性：{}）", t.v, REGION_PROPS.join(" ")));
            }
            let name = self.expect_id()?;
            self.expect_p(":")?;
            let v = self.expr_list(&[";", "}"])?;
            reg.props.insert(name, v);
            if self.is_p(";") {
                self.next();
            }
        }
        self.expect_p("}")?;
        Ok(reg)
    }

    fn row_block(&mut self) -> R<Row> {
        let mut props = IndexMap::new();
        if self.is_p("(") {
            self.next();
            while !self.is_p(")") {
                let name_tok = self.peek().clone();
                let name = self.expect_id()?;
                if !ROW_PROPS.contains(&name.as_str()) {
                    return self.fail_at(format!("row 认不出属性 {name}（行属性：{}）", ROW_PROPS.join(" ")), &name_tok);
                }
                self.expect_p(":")?;
                let v = self.expr_list(&[";", ")"])?;
                props.insert(name, v);
                if self.is_p(";") {
                    self.next();
                }
            }
            self.expect_p(")")?;
        }
        let body = self.row_body()?;
        for (k, v) in body.props {
            props.insert(k, v);
        }
        Ok(Row { props, cells: body.cells })
    }

    fn row_body(&mut self) -> R<Row> {
        self.expect_p("{")?;
        let mut row = Row::default();
        while !self.is_p("}") {
            if self.is_p(";") {
                self.next();
                continue;
            }
            let name_tok = self.peek().clone();
            let name = self.expect_id()?;
            let slot = SLOTS.contains(&name.as_str()).then(|| name.clone());
            if let (Some(slot), true) = (&slot, self.is_p("{")) {
                let mut pos = Positions::new();
                let decls = self.decl_block(Some(&mut pos))?;
                let mut cell = Cell { slot: slot.clone(), lines: vec![], props: IndexMap::new() };
                let mut role: Option<String> = None;
                let mut at: Option<Expr> = None;
                for (k, v) in &decls {
                    if !CELL_PROPS.contains(&k.as_str()) {
                        return self.fail_at(format!("槽位认不出属性 {k}（格属性：{}）", CELL_PROPS.join(" ")), &pos[k]);
                    }
                    if k == "content" {
                        continue;
                    }
                    if k == "role" {
                        let w = expr_word(v)?;
                        role = Some(self.role_name(&w, &pos[k])?);
                    } else if k == "at" {
                        at = Some(v.clone());
                    } else {
                        if k == "avoid" {
                            parse_avoid(v, Some((pos[k].line, pos[k].col)))?;
                        }
                        cell.props.insert(k.clone(), v.clone());
                    }
                }
                let Some(content) = decls.get("content") else {
                    return self.fail_at(format!("槽位 {slot} 的块里要写 content"), &name_tok);
                };
                let items: Vec<Expr> = match content {
                    Expr::List { items } => items.clone(),
                    e => vec![e.clone()],
                };
                let ctok = pos["content"].clone();
                let mut lines = vec![];
                for it in &items {
                    lines.push(self.line_of(it, &ctok)?);
                }
                // `role:` 相当于写在最后一行之后的 `as`，同样往前继承
                inherit_role(&mut lines, role);
                for line in &mut lines {
                    if at.is_some() && line.at.is_none() {
                        line.at = at.clone();
                    }
                }
                cell.lines = lines;
                row.cells.push(cell);
                continue;
            }
            if slot.is_none() && !ROW_PROPS.contains(&name.as_str()) {
                return self.fail_at(format!("row 里要槽位（{}）或行属性，却是 {name}", SLOTS.join(" ")), &name_tok);
            }
            self.expect_p(":")?;
            let v = self.expr_list(&[";", "}"])?;
            if self.is_p(";") {
                self.next();
            }
            if let Some(slot) = slot {
                let items: Vec<Expr> = match &v {
                    Expr::List { items } => items.clone(),
                    e => vec![e.clone()],
                };
                let mut lines = vec![];
                for it in &items {
                    lines.push(self.line_of(it, &name_tok)?);
                }
                inherit_role(&mut lines, None);
                row.cells.push(Cell { slot, lines, props: IndexMap::new() });
            } else {
                row.props.insert(name, v);
            }
        }
        self.expect_p("}")?;
        Ok(row)
    }

    /// 槽位里的一行：`内容 [as 角色] [at 表达式]`。
    fn line_of(&self, e: &Expr, tok: &Tok) -> R<CellLine> {
        let items: Vec<Expr> = match e {
            Expr::Seq { items } => items.clone(),
            e => vec![e.clone()],
        };
        let Some(head) = items.first() else { return self.fail_at("槽位里是空的", tok) };
        let mut line = CellLine { content: content_of(head, tok)?, role: None, at: None };
        if let Content::Component { name, .. } = &line.content {
            if !COMPONENTS.contains(&name.as_str()) {
                return self.fail_at(format!("认不出的组件 {name}()（组件：{}）", COMPONENTS.join(" ")), tok);
            }
        }
        let mut k = 1;
        while k < items.len() {
            let w = &items[k];
            if w.is_id("as") && matches!(items.get(k + 1), Some(Expr::Id { .. })) {
                let Some(Expr::Id { v }) = items.get(k + 1) else { unreachable!() };
                line.role = Some(self.role_name(v, tok)?);
                k += 1;
            } else if w.is_id("at") && items.get(k + 1).is_some() {
                // `at` 后面到下一个关键字为止是表达式
                let mut rest = vec![];
                while let Some(x) = items.get(k + 1) {
                    if x.is_id("as") || x.is_id("at") {
                        break;
                    }
                    k += 1;
                    rest.push(x.clone());
                }
                line.at = Some(if rest.len() == 1 { rest.pop().expect("一项") } else { Expr::Seq { items: rest } });
            } else {
                return self.fail_at("槽位里的一行只能写 `内容 [as 角色] [at 位置]`", tok);
            }
            k += 1;
        }
        Ok(line)
    }

    fn role_name(&self, role: &str, tok: &Tok) -> R<String> {
        if !is_known_role(role) {
            return self.fail_at(format!("认不出的角色 {role}（角色表见 src/style/sheet.ts::STYLE_ROLES / TEMPLATE_ROLES）"), tok);
        }
        Ok(role.to_string())
    }

    /// `@page` 声明 → `PageDecl`：键白名单，值的形状在这里查。
    fn page_decl(&self, decls: &IndexMap<String, Expr>, pos: &Positions) -> R<Value> {
        let mut out = Map::new();
        for (k, v) in decls {
            let where_ = &pos[k];
            if !PAGE_PROPS.contains(&k.as_str()) {
                return self.fail_at(format!("@page 认不出属性 {k}（属性：{}）", PAGE_PROPS.join(" ")), where_);
            }
            let val = expr_value(v)?;
            let nums = |x: &Value| x.as_array().is_some_and(|a| a.iter().all(Value::is_number));
            let arr_len = |x: &Value| x.as_array().map_or(0, Vec::len);
            match k.as_str() {
                "size" if !(nums(&val) && arr_len(&val) == 2) => return self.fail_at("@page size 要写两个数：宽 高", where_),
                "margin" if !(val.is_number() || (nums(&val) && arr_len(&val) == 4)) => {
                    return self.fail_at("@page margin 要写一个数或四个数", where_)
                }
                "mirror" if !val.is_boolean() => return self.fail_at("@page mirror 只收 true / false", where_),
                "orientation" if val != json!("portrait") && val != json!("landscape") => {
                    return self.fail_at("@page orientation 只收 portrait / landscape", where_)
                }
                "ink" | "background" if !val.is_number() => return self.fail_at(format!("@page {k} 要写颜色 #rrggbb / #aarrggbb"), where_),
                "paper" if !val.is_string() => return self.fail_at("@page paper 要写纸名", where_),
                _ => {}
            }
            out.insert(k.clone(), val);
        }
        Ok(Value::Object(out))
    }

    // —— 表达式 ——

    fn stop_at(&self, stops: &[&str]) -> bool {
        stops.iter().any(|s| self.is_p(s))
    }

    fn expr_list(&mut self, stops: &[&str]) -> R<Expr> {
        let mut items = vec![];
        let mut seq_stops: Vec<&str> = stops.to_vec();
        seq_stops.push(",");
        loop {
            items.push(self.expr_seq(&seq_stops)?);
            if self.is_p(",") {
                self.next();
                continue;
            }
            break;
        }
        Ok(if items.len() == 1 { items.pop().expect("一项") } else { Expr::List { items } })
    }

    fn expr_seq(&mut self, stops: &[&str]) -> R<Expr> {
        let mut items = vec![];
        while !self.stop_at(stops) && self.peek().t != T::Eof {
            items.push(self.expr_add()?);
        }
        if items.is_empty() {
            return self.fail("这里缺值");
        }
        Ok(if items.len() == 1 { items.pop().expect("一项") } else { Expr::Seq { items } })
    }

    fn expr_add(&mut self) -> R<Expr> {
        let mut a = self.expr_mul()?;
        while (self.is_p("+") || self.is_p("-")) && self.spaced() {
            let op = self.next().v;
            let b = self.expr_mul()?;
            a = Expr::Bin { op, a: Box::new(a), b: Box::new(b) };
        }
        Ok(a)
    }

    fn expr_mul(&mut self) -> R<Expr> {
        let mut a = self.expr_unary()?;
        while self.is_p("*") || self.is_p("/") {
            let op = self.next().v;
            let b = self.expr_unary()?;
            a = Expr::Bin { op, a: Box::new(a), b: Box::new(b) };
        }
        Ok(a)
    }

    /// `+`/`-` 当二元运算符，要求它和左边隔着空格（CSS calc 的规矩）。
    fn spaced(&self) -> bool {
        let op = self.peek();
        if self.i == 0 {
            return false;
        }
        let Some(prev) = self.toks.get(self.i - 1) else { return false };
        op.line != prev.line || op.col > prev.col + tok_len(prev)
    }

    fn expr_unary(&mut self) -> R<Expr> {
        if self.is_p("-") {
            self.next();
            let a = self.expr_unary()?;
            return Ok(Expr::Neg { a: Box::new(a) });
        }
        self.expr_primary()
    }

    fn expr_primary(&mut self) -> R<Expr> {
        let t = self.next();
        match t.t {
            T::Num => return Ok(Expr::num(t.n, t.unit.clone())),
            T::Str => return Ok(Expr::Str { v: t.v }),
            T::Hash => return Ok(Expr::Hash { v: t.v }),
            T::Id => {
                let follows = self.toks.get(self.i).is_some_and(|n| n.col == t.col + u16len(&t.v) && n.line == t.line);
                if self.is_p("(") && follows {
                    self.next();
                    let mut args = vec![];
                    while !self.is_p(")") {
                        args.push(self.expr_seq(&[",", ")"])?);
                        if self.is_p(",") {
                            self.next();
                        }
                    }
                    self.expect_p(")")?;
                    return Ok(Expr::Call { name: t.v, args });
                }
                return Ok(Expr::Id { v: t.v });
            }
            T::P if t.v == "(" => {
                let e = self.expr_add()?;
                self.expect_p(")")?;
                return Ok(e);
            }
            _ => {}
        }
        self.fail_at(format!("这里要值，却是 {}", t.v_json()), &t)
    }
}

/// 没写 `as` 的行取本槽位**其后**最近的 `as`；其后都没有就取 `fallback`（块写法的 `role:`）。
fn inherit_role(lines: &mut [CellLine], fallback: Option<String>) {
    let mut next = fallback;
    for l in lines.iter_mut().rev() {
        if l.role.is_some() {
            next = l.role.clone();
        } else if next.is_some() {
            l.role = next.clone();
        }
    }
}

/// `avoid: chord note gap 1.5 scan 60` 的形状。
#[derive(Clone, Debug, PartialEq)]
pub struct AvoidSpec {
    pub roles: Vec<String>,
    pub gap: f64,
    pub scan: f64,
}

/// 解开 `avoid`。解析期用它校验（给位置就报 `行:列`），排版时用它取值。
pub fn parse_avoid(e: &Expr, tok: Option<(u32, u32)>) -> R<AvoidSpec> {
    let (line, col) = tok.unwrap_or((0, 0));
    let bad = |msg: String| SsError::at(format!("avoid {msg}（写法：avoid: 角色… [gap 数] [scan 数]）"), line, col);
    let items: Vec<&Expr> = match e {
        Expr::Seq { items } => items.iter().collect(),
        e => vec![e],
    };
    let mut roles: Vec<String> = vec![];
    let mut gap = 0.0;
    let mut scan = f64::INFINITY;
    let mut i = 0;
    while i < items.len() {
        let Expr::Id { v } = items[i] else { return Err(bad(format!("里认不出 {}", print_expr(items[i])))) };
        if v == "gap" || v == "scan" {
            let Some(Expr::Num { v: n, .. }) = items.get(i + 1) else { return Err(bad(format!("的 {v} 后面要跟数"))) };
            if v == "gap" {
                gap = *n;
            } else {
                scan = *n;
            }
            i += 1;
        } else {
            if !is_known_role(v) {
                return Err(bad(format!("里认不出角色 {v}")));
            }
            if !roles.contains(v) {
                roles.push(v.clone());
            }
        }
        i += 1;
    }
    if roles.is_empty() {
        return Err(bad("至少写一个角色".into()));
    }
    Ok(AvoidSpec { roles, gap, scan })
}

/// 槽位里的内容：字符串 = 插值文字；函数调用 = 组件。
fn content_of(e: &Expr, tok: &Tok) -> R<Content> {
    match e {
        Expr::Str { v } => Ok(Content::Text { parts: parse_interp(v, Some((tok.line, tok.col)))? }),
        Expr::Call { name, args } => Ok(Content::Component { name: name.clone(), args: args.clone() }),
        _ => Err(SsError::at("槽位的内容要是字符串或组件调用", tok.line, tok.col)),
    }
}

/// `"前缀{路径 | 过滤器}后缀"` → 段。`{{` / `}}` 是字面花括号。
pub fn parse_interp(s: &str, tok: Option<(u32, u32)>) -> R<Vec<TextPart>> {
    let (line, col) = tok.unwrap_or((0, 0));
    let c: Vec<char> = s.chars().collect();
    let mut parts = vec![];
    let mut lit = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '{' && c.get(i + 1) == Some(&'{') {
            lit.push('{');
            i += 2;
            continue;
        }
        if c[i] == '}' && c.get(i + 1) == Some(&'}') {
            lit.push('}');
            i += 2;
            continue;
        }
        if c[i] == '{' {
            let Some(end) = (i..c.len()).find(|&j| c[j] == '}') else {
                return Err(SsError::at(format!("插值没有收尾：{s}"), line, col));
            };
            if !lit.is_empty() {
                parts.push(TextPart::Lit(std::mem::take(&mut lit)));
            }
            let inner: String = c[i + 1..end].iter().collect();
            let mut segs = inner.split('|').map(|x| dolce_base::js::trim(x).to_string());
            let path = segs.next().unwrap_or_default();
            let mut filters = vec![];
            for f in segs.filter(|f| !f.is_empty()) {
                if !FILTER_NAMES.contains(&f.as_str()) {
                    return Err(SsError::at(format!("认不出的过滤器 {f}（过滤器：{}）", FILTER_NAMES.join(" ")), line, col));
                }
                filters.push(f);
            }
            parts.push(TextPart::Field { path, filters });
            i = end + 1;
            continue;
        }
        lit.push(c[i]);
        i += 1;
    }
    if !lit.is_empty() {
        parts.push(TextPart::Lit(lit));
    }
    Ok(parts)
}

// ───────────────────────── 声明 → 样式表字段 ─────────────────────────

fn expr_word(e: &Expr) -> R<String> {
    match e {
        Expr::Id { v } | Expr::Str { v } => Ok(v.clone()),
        Expr::Num { v, .. } => Ok(num_to_string(*v)),
        _ => Err(SsError::plain(format!("这里要一个词：{}", print_expr(e)))),
    }
}

/// 长度：裸数字 → number，带单位 → `"12pt"` 这类 `Length` 串。
/// TS 的 `exprLength(neg 非数)` ↔ `exprValue` 互相递归到栈溢出；这里照样报那条错。
fn expr_length(e: &Expr) -> R<Value> {
    match e {
        Expr::Num { v, unit: Some(u) } => return Ok(Value::String(format!("{}{u}", num_to_string(*v)))),
        Expr::Num { v, unit: None } => return Ok(num(*v)),
        Expr::Neg { a } => {
            if let Expr::Num { v, unit } = &**a {
                return expr_length(&Expr::num(-v, unit.clone()));
            }
        }
        _ => {}
    }
    if let Some(f) = fold_const(e) {
        return expr_length(&f);
    }
    if matches!(e, Expr::Neg { .. }) {
        return Err(SsError::plain("Maximum call stack size exceeded"));
    }
    expr_value(e)
}

/// 常量四则折成一个长度（`1em / 14`）。乘除最多一边带单位，加减两边单位相同；折不了回 None。
fn fold_const(e: &Expr) -> Option<Expr> {
    match e {
        Expr::Num { .. } => Some(e.clone()),
        Expr::Neg { a } => match fold_const(a)? {
            Expr::Num { v, unit } => Some(Expr::num(-v, unit)),
            _ => None,
        },
        Expr::Bin { op, a, b } => {
            let (Expr::Num { v: av, unit: au }, Expr::Num { v: bv, unit: bu }) = (fold_const(a)?, fold_const(b)?) else { return None };
            match op.as_str() {
                "*" => {
                    if au.is_some() && bu.is_some() {
                        return None;
                    }
                    Some(Expr::num(av * bv, au.or(bu)))
                }
                "/" => {
                    if bu.is_some() || bv == 0.0 {
                        return None;
                    }
                    Some(Expr::num(av / bv, au))
                }
                _ => {
                    if au.as_deref().unwrap_or("") != bu.as_deref().unwrap_or("") {
                        return None;
                    }
                    Some(Expr::num(if op == "+" { av + bv } else { av - bv }, au))
                }
            }
        }
        _ => None,
    }
}

fn expr_value(e: &Expr) -> R<Value> {
    match e {
        Expr::Num { .. } | Expr::Neg { .. } => expr_length(e),
        Expr::Str { v } => Ok(Value::String(v.clone())),
        Expr::Hash { v } => Ok(num(parse_color(v)?)),
        Expr::Id { v } => Ok(match v.as_str() {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            _ => Value::String(v.clone()),
        }),
        Expr::Seq { items } | Expr::List { items } => Ok(Value::Array(items.iter().map(expr_value).collect::<R<Vec<_>>>()?)),
        _ => Ok(serde_json::to_value(e).expect("表达式可序列化")),
    }
}

/// `#rrggbb` / `#aarrggbb` → ARGB 数字。
fn parse_color(hex: &str) -> R<f64> {
    let h = hex.to_lowercase();
    let is_hex = |s: &str| s.bytes().all(|b| b.is_ascii_hexdigit());
    if h.len() == 6 && is_hex(&h) {
        return Ok((0xff000000u32 + u32::from_str_radix(&h, 16).expect("六位十六进制")) as f64);
    }
    if h.len() == 8 && is_hex(&h) {
        return Ok(u32::from_str_radix(&h, 16).expect("八位十六进制") as f64);
    }
    Err(SsError::plain(format!("颜色要写 #rrggbb 或 #aarrggbb：#{hex}")))
}

fn kebab_to_camel(v: &str) -> String {
    let c: Vec<char> = v.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '-' && c.get(i + 1).is_some_and(|x| x.is_ascii_lowercase()) {
            out.push(c[i + 1].to_ascii_uppercase());
            i += 2;
        } else {
            out.push(c[i]);
            i += 1;
        }
    }
    out
}

fn camel_to_kebab(v: &str) -> String {
    let mut out = String::new();
    for ch in v.chars() {
        if ch.is_ascii_uppercase() {
            out.push('-');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

fn role_decl(decls: &IndexMap<String, Expr>) -> R<Value> {
    let mut out = Map::new();
    for (k, v) in decls {
        let field = ROLE_PROP_FIELD.iter().find(|(p, _)| p == k).map_or(k.as_str(), |(_, f)| f);
        let val = if k == "size" || k == "baseline-adjust" { expr_length(v)? } else { expr_value(v)? };
        let val = match (&**k, val) {
            ("align-mode", Value::String(s)) => Value::String(kebab_to_camel(&s)),
            (_, v) => v,
        };
        out.insert(field.to_string(), val);
    }
    Ok(Value::Object(out))
}

fn decls_value(d: &IndexMap<String, Expr>) -> Value {
    serde_json::to_value(d).expect("声明可序列化")
}

// ───────────────────────── 入口 ─────────────────────────

/// 解析一份 `.ss`。
pub fn parse_ss(src: &str) -> R<Vec<StyleRule>> {
    let toks = lex(src)?;
    let mut p = Parser { toks, i: 0, rules: vec![] };
    p.parse_sheet()?;
    Ok(p.rules)
}

// ───────────────────────── 写出 ─────────────────────────

pub fn print_expr(e: &Expr) -> String {
    match e {
        Expr::Num { v, unit } => format!("{}{}", num_to_string(*v), unit.as_deref().unwrap_or("")),
        Expr::Str { v } => json_quote(v),
        Expr::Id { v } => v.clone(),
        Expr::Hash { v } => format!("#{v}"),
        Expr::Call { name, args } => format!("{name}({})", args.iter().map(print_expr).collect::<Vec<_>>().join(", ")),
        Expr::Bin { op, a, b } => {
            let mul = op == "*" || op == "/";
            let wrap = |x: &Expr| match x {
                Expr::Bin { op: xo, .. } if (xo == "+" || xo == "-") && mul => format!("({})", print_expr(x)),
                _ => print_expr(x),
            };
            let right = match &**b {
                Expr::Bin { op: bo, .. } if op == "-" || op == "/" || ((bo == "+" || bo == "-") && op == "*") => format!("({})", print_expr(b)),
                _ => wrap(b),
            };
            format!("{} {op} {right}", wrap(a))
        }
        Expr::Neg { a } => format!("-{}", print_expr(a)),
        Expr::Seq { items } => items.iter().map(print_expr).collect::<Vec<_>>().join(" "),
        Expr::List { items } => items.iter().map(print_expr).collect::<Vec<_>>().join(", "),
    }
}

fn is_length_str(s: &str) -> bool {
    ["pt", "em", "sp"].iter().any(|u| s.strip_suffix(u).is_some_and(is_signed_decimal))
}

/// `-?\d+(\.\d+)?`（整串）
fn is_signed_decimal(s: &str) -> bool {
    let s = s.strip_prefix('-').unwrap_or(s);
    let d = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    match s.split_once('.') {
        None => d(s),
        Some((a, b)) => d(a) && d(b),
    }
}

fn is_plain_word(s: &str) -> bool {
    let mut c = s.chars();
    c.next().is_some_and(|f| f.is_ascii_alphabetic() || f == '_') && c.all(|x| x.is_ascii_alphanumeric() || x == '_' || x == '-')
}

fn print_value(v: &Value, key: Option<&str>) -> String {
    match v {
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            if matches!(key, Some("ink" | "background" | "color")) && x.fract() == 0.0 && x.is_finite() && x > 16777215.0 {
                return format!("#{:08x}", to_uint32(x));
            }
            num_to_string(x)
        }
        Value::Bool(b) => b.to_string(),
        Value::String(s) => {
            if is_length_str(s) || is_plain_word(s) {
                s.clone()
            } else {
                json_quote(s)
            }
        }
        Value::Array(a) => a.iter().map(|x| print_value(x, None)).collect::<Vec<_>>().join(" "),
        Value::Object(o) if o.contains_key("k") => match serde_json::from_value::<Expr>(v.clone()) {
            Ok(e) => print_expr(&e),
            Err(_) => js_json(v),
        },
        _ => js_json(v),
    }
}

fn print_interp(parts: &[TextPart]) -> String {
    let s: String = parts
        .iter()
        .map(|p| match p {
            TextPart::Lit(t) => t.replace('{', "{{").replace('}', "}}"),
            TextPart::Field { path, filters } => {
                let mut v = vec![path.clone()];
                v.extend(filters.iter().cloned());
                format!("{{{}}}", v.join(" | "))
            }
        })
        .collect();
    json_quote(&s)
}

fn print_content(c: &Content) -> String {
    match c {
        Content::Text { parts } => print_interp(parts),
        Content::Component { name, args } => format!("{name}({})", args.iter().map(print_expr).collect::<Vec<_>>().join(", ")),
    }
}

fn print_decls(d: &IndexMap<String, Expr>, ind: &str) -> Vec<String> {
    d.iter().map(|(k, v)| format!("{ind}{k}: {};", print_expr(v))).collect()
}

fn print_region_body(reg: &Region, ind: &str) -> Vec<String> {
    let mut l = print_decls(&reg.props, ind);
    for row in &reg.rows {
        let rp: Vec<String> = row.props.iter().map(|(k, v)| format!("{k}: {}", print_expr(v))).collect();
        l.push(format!("{ind}row{} {{", if rp.is_empty() { String::new() } else { format!("({})", rp.join("; ")) }));
        for cell in &row.cells {
            l.extend(print_cell(cell, &format!("{ind}  ")));
        }
        l.push(format!("{ind}}}"));
    }
    l
}

fn print_line(l: &CellLine, role: bool, at: bool) -> String {
    let mut s = print_content(&l.content);
    if role {
        if let Some(r) = l.role.as_deref().filter(|r| !r.is_empty()) {
            s.push_str(&format!(" as {r}"));
        }
    }
    if at {
        if let Some(a) = &l.at {
            s.push_str(&format!(" at {}", print_expr(a)));
        }
    }
    s
}

/// 块形式里全格一致的 role / at 写成 `role:` / `at:`，逐行不同的写在各行上。
fn print_cell(cell: &Cell, ind: &str) -> Vec<String> {
    if cell.props.is_empty() {
        return vec![format!("{ind}{}: {};", cell.slot, cell.lines.iter().map(|l| print_line(l, true, true)).collect::<Vec<_>>().join(", "))];
    }
    fn same(lines: &[CellLine], f: impl Fn(&CellLine) -> Option<String>) -> Option<String> {
        let v = f(lines.first()?)?;
        lines.iter().all(|l| f(l).as_deref() == Some(v.as_str())).then_some(v)
    }
    let role = same(&cell.lines, |l| l.role.clone());
    let at_str = same(&cell.lines, |l| l.at.as_ref().map(print_expr));
    let mut l = vec![format!("{ind}{} {{", cell.slot)];
    l.push(format!(
        "{ind}  content: {};",
        cell.lines.iter().map(|x| print_line(x, role.is_none(), at_str.is_none())).collect::<Vec<_>>().join(", ")
    ));
    if let Some(r) = role.filter(|r| !r.is_empty()) {
        l.push(format!("{ind}  role: {r};"));
    }
    if let Some(a) = at_str.filter(|a| !a.is_empty()) {
        l.push(format!("{ind}  at: {a};"));
    }
    l.extend(print_decls(&cell.props, &format!("{ind}  ")));
    l.push(format!("{ind}}}"));
    l
}

fn entries(v: Option<&Value>) -> Vec<(&String, &Value)> {
    v.and_then(Value::as_object).map(|o| o.iter().collect()).unwrap_or_default()
}

fn exprs_of(v: &Value) -> R<IndexMap<String, Expr>> {
    serde_json::from_value(v.clone()).map_err(|e| SsError::plain(format!("写不出的表达式：{e}")))
}

/// 一条规则的 `set` → 语句（不含 when 包装）。
fn print_set(set: &Value, ind: &str) -> R<Vec<String>> {
    let mut l = vec![];
    let tpl = set.get("template");
    for (name, f) in entries(tpl.and_then(|t| t.get("fonts"))) {
        l.push(format!("{ind}@font-face {name} {{"));
        for (k, v) in entries(Some(f)) {
            l.push(format!("{ind}  {k}: {};", print_value(v, None)));
        }
        l.push(format!("{ind}}}"));
    }
    if crate::sheet::truthy(set.get("page")) {
        l.push(format!("{ind}@page {{"));
        for (k, v) in entries(set.get("page")) {
            l.push(format!("{ind}  {k}: {};", print_value(v, Some(k))));
        }
        l.push(format!("{ind}}}"));
    }
    for (role, decl) in entries(set.get("roles")) {
        let body: Vec<String> = entries(Some(decl))
            .into_iter()
            .map(|(k, v)| {
                let prop = ROLE_PROP_FIELD.iter().find(|(_, f)| f == k).map_or(k.as_str(), |(p, _)| p);
                let val = match (k.as_str(), v) {
                    ("alignMode", Value::String(s)) => Value::String(camel_to_kebab(s)),
                    _ => v.clone(),
                };
                format!("{prop}: {};", print_value(&val, Some(k)))
            })
            .collect();
        l.push(format!("{ind}{role} {{ {} }}", body.join(" ")));
    }
    for eng in ["jianpu", "staff", "break"] {
        let Some(blk) = set.get(eng).filter(|b| crate::sheet::truthy(Some(b))) else { continue };
        let mut body = vec![];
        if let Some(p) = blk.get("preset").filter(|p| crate::sheet::truthy(Some(p))) {
            body.push(format!("preset: {};", js_to_string(p)));
        }
        for (k, v) in entries(blk.get("overrides")) {
            body.push(format!("{k}: {};", print_value(v, None)));
        }
        l.push(format!("{ind}@{eng} {{ {} }}", body.join(" ")));
    }
    for (name, reg) in entries(tpl.and_then(|t| t.get("regions"))) {
        if !crate::sheet::truthy(Some(reg)) {
            continue;
        }
        let reg: Region = serde_json::from_value(reg.clone()).map_err(|e| SsError::plain(format!("写不出的区域 {name}：{e}")))?;
        l.push(format!("{ind}@template {name} {{"));
        l.extend(print_region_body(&reg, &format!("{ind}  ")));
        l.push(format!("{ind}}}"));
    }
    for blk in ["flow", "toc"] {
        if let Some(d) = tpl.and_then(|t| t.get(blk)).filter(|d| crate::sheet::truthy(Some(d))) {
            l.push(format!("{ind}@{blk} {{"));
            l.extend(print_decls(&exprs_of(d)?, &format!("{ind}  ")));
            l.push(format!("{ind}}}"));
        }
    }
    Ok(l)
}

/// 规则 → `.ss` 文本。`parse_ss(print_ss(r))` 与 `r` 逐字段一致。
pub fn print_ss(rules: &[StyleRule]) -> R<String> {
    let mut l: Vec<String> = vec![];
    for r in rules {
        let conds: Vec<(&String, &Value)> = r.when.as_ref().map(|w| w.iter().collect()).unwrap_or_default();
        let mut ind = String::new();
        let mut close = vec![];
        if !conds.is_empty() {
            l.push(format!("@media {} {{", conds.iter().map(|(k, v)| format!("({k}: {})", js_to_string(v))).collect::<Vec<_>>().join(" and ")));
            close.push("}".to_string());
            ind.push_str("  ");
        }
        l.extend(print_set(&r.set, &ind)?);
        l.extend(close);
    }
    Ok(l.join("\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_basic() {
        let src = "title { size: 12pt; color: #ff0000; }\n@media (mode: original) and (paged: true) {\n  @jianpu { preset: original; barline: 1em / 14; }\n}\n@template song-foot {\n  flow: block;\n  row { left: \"{pageText.bottomLeft | dash-empty}\" as header; }\n}\n";
        let r = parse_ss(src).unwrap();
        let p = print_ss(&r).unwrap();
        let r2 = parse_ss(&p).unwrap();
        assert_eq!(r, r2);
        assert_eq!(print_ss(&r2).unwrap(), p);
    }

    #[test]
    fn errors() {
        assert_eq!(parse_ss("title { size 12pt; }").unwrap_err().message, "1:14 这里要 `:`，却是 12");
        assert!(parse_ss("chord { dx: 20; }").is_err());
    }
}
