//! 自有的 XML 树（照 `src/score/xmltree.ts` 逐条搬）：MusicXML 读写用，网页、桌面、命令行同一份。
//!
//! - 认：元素、属性（保原序）、文本、CDATA、注释、处理指令、`<!DOCTYPE>`（内部子集里的一般实体声明 `<!ENTITY x "…">` 也认）；
//!   五个预定义实体与数字实体。**不认命名空间**，`xml:lang` 之类当普通属性名。
//! - 不合法就回 [`XmlError`]：标签不配对、没闭合、多个根、属性没引号或重名、属性值里有 `<`、不认得的实体。
//! - 换行按 XML 规定归一（`\r\n`、`\r` → `\n`；属性值里的空白字符 → 空格）。
//! - 每个读进来的元素记下它在原文里的区间 `start`/`end`（开标签的 `<` 到闭标签的 `>` 之后），**按 UTF-16 码元**
//!   （与 TS 的字符串下标相同，`editor/sync.ts` 按它对原文位置）；新建、克隆的元素没有区间（-1）。
//! - 树是 arena：节点按 [`NodeId`] 存在 [`Tree`] 里，摘下来的节点仍在 arena 里（可以再接回去）。
//!
//! 与 TS 的出入（JS 字符串能装、Rust `String` 装不了的）：数字实体指向代理区码位（`&#xD800;`）时 TS 得到孤立代理，
//! 这里换成 U+FFFD；指向负数（`&#x-41;`，`parseInt` 认负号）时 TS 抛 `RangeError`，这里回 `XmlError`。
//!
//! 序列化 [`Tree::serialize`] / [`XmlDoc::serialize`]：转义口径同浏览器的 `XMLSerializer`（文字转 `& < >`，属性再转 `"`；
//! 另剔掉 XML 1.0 不许的控制字符），空元素写 `<x/>`；整份文档把根前根后的原文（声明、DOCTYPE、注释）原样带上。

use crate::base::js;
use crate::base::Utf16Index;
use std::collections::HashMap;
use std::fmt;

/// 解析错误：说明与位置（UTF-16 码元）。显示成 `说明 @位置`（同 TS 的 `message`）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct XmlError {
    pub message: String,
    pub at: u32,
}

impl fmt::Display for XmlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} @{}", self.message, self.at)
    }
}

impl std::error::Error for XmlError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
pub struct NodeId(pub u32);

/// 元素之外的节点种类（`data` 是正文；处理指令是 `<?` 与 `?>` 之间的原文）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TextKind {
    Text,
    Cdata,
    Comment,
    Pi,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Attr {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Element {
    pub tag: String,
    pub attrs: Vec<Attr>,
    /// 全部子节点（元素与文字等），按文档序
    pub child_nodes: Vec<NodeId>,
    /// 原文区间（UTF-16；读进来的才有，新建、克隆的为 -1）
    pub start: i64,
    pub end: i64,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub enum NodeData {
    Element(Element),
    Text { kind: TextKind, data: String },
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Node {
    pub parent: Option<NodeId>,
    pub data: NodeData,
}

/// 建树时的子节点：现成节点或一段文字（数字先用 `js::num_to_string` 转成文字）。
pub enum Kid {
    Node(NodeId),
    Text(String),
}

impl From<NodeId> for Kid {
    fn from(n: NodeId) -> Kid {
        Kid::Node(n)
    }
}
impl From<&str> for Kid {
    fn from(s: &str) -> Kid {
        Kid::Text(s.into())
    }
}
impl From<String> for Kid {
    fn from(s: String) -> Kid {
        Kid::Text(s)
    }
}

/// 节点 arena。
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Tree {
    nodes: Vec<Node>,
}

impl Tree {
    pub fn new() -> Tree {
        Tree::default()
    }

    fn push(&mut self, data: NodeData) -> NodeId {
        let id = NodeId(self.nodes.len() as u32);
        self.nodes.push(Node { parent: None, data });
        id
    }

    /// 新元素（没有区间、没挂上）。
    pub fn create_element(&mut self, tag: impl Into<String>) -> NodeId {
        self.push(NodeData::Element(Element { tag: tag.into(), attrs: Vec::new(), child_nodes: Vec::new(), start: -1, end: -1 }))
    }

    pub fn create_text(&mut self, kind: TextKind, data: impl Into<String>) -> NodeId {
        self.push(NodeData::Text { kind, data: data.into() })
    }

    pub fn node(&self, id: NodeId) -> &Node {
        &self.nodes[id.0 as usize]
    }

    fn el(&self, id: NodeId) -> &Element {
        match &self.nodes[id.0 as usize].data {
            NodeData::Element(e) => e,
            NodeData::Text { .. } => panic!("节点 {} 不是元素", id.0),
        }
    }

    fn el_mut(&mut self, id: NodeId) -> &mut Element {
        match &mut self.nodes[id.0 as usize].data {
            NodeData::Element(e) => e,
            NodeData::Text { .. } => panic!("节点 {} 不是元素", id.0),
        }
    }

    pub fn element(&self, id: NodeId) -> Option<&Element> {
        match &self.nodes[id.0 as usize].data {
            NodeData::Element(e) => Some(e),
            NodeData::Text { .. } => None,
        }
    }

    pub fn is_element(&self, id: NodeId) -> bool {
        self.element(id).is_some()
    }

    pub fn tag(&self, id: NodeId) -> &str {
        &self.el(id).tag
    }

    /// 文字类节点的种类与正文（元素为 None）。
    pub fn text_node(&self, id: NodeId) -> Option<(TextKind, &str)> {
        match &self.nodes[id.0 as usize].data {
            NodeData::Text { kind, data } => Some((*kind, data)),
            NodeData::Element(_) => None,
        }
    }

    pub fn set_text_data(&mut self, id: NodeId, s: impl Into<String>) {
        if let NodeData::Text { data, .. } = &mut self.nodes[id.0 as usize].data {
            *data = s.into();
        }
    }

    pub fn parent(&self, id: NodeId) -> Option<NodeId> {
        self.nodes[id.0 as usize].parent
    }

    pub fn start(&self, id: NodeId) -> i64 {
        self.el(id).start
    }
    pub fn end(&self, id: NodeId) -> i64 {
        self.el(id).end
    }

    /// 全部子节点，按文档序。
    pub fn child_nodes(&self, id: NodeId) -> &[NodeId] {
        &self.el(id).child_nodes
    }

    /// 子元素（只含元素），按文档序。
    pub fn children(&self, id: NodeId) -> impl Iterator<Item = NodeId> + '_ {
        self.el(id).child_nodes.iter().copied().filter(move |&c| self.is_element(c))
    }

    pub fn first_element_child(&self, id: NodeId) -> Option<NodeId> {
        self.children(id).next()
    }

    /// 属性，按原文次序。
    pub fn attributes(&self, id: NodeId) -> &[Attr] {
        &self.el(id).attrs
    }

    pub fn get_attribute(&self, id: NodeId, name: &str) -> Option<&str> {
        self.el(id).attrs.iter().find(|a| a.name == name).map(|a| a.value.as_str())
    }

    pub fn has_attribute(&self, id: NodeId, name: &str) -> bool {
        self.el(id).attrs.iter().any(|a| a.name == name)
    }

    /// 有就改值（位置不动），没有接到最后。
    pub fn set_attribute(&mut self, id: NodeId, name: &str, value: impl Into<String>) {
        let value = value.into();
        let e = self.el_mut(id);
        match e.attrs.iter_mut().find(|a| a.name == name) {
            Some(a) => a.value = value,
            None => e.attrs.push(Attr { name: name.into(), value }),
        }
    }

    pub fn remove_attribute(&mut self, id: NodeId, name: &str) {
        let e = self.el_mut(id);
        if let Some(i) = e.attrs.iter().position(|a| a.name == name) {
            e.attrs.remove(i);
        }
    }

    /// 文字与 CDATA 按文档序拼起来（含后代；注释、处理指令不算）。
    pub fn text_content(&self, id: NodeId) -> String {
        let mut s = String::new();
        self.text_into(id, &mut s);
        s
    }

    fn text_into(&self, id: NodeId, s: &mut String) {
        for &c in &self.el(id).child_nodes {
            match &self.nodes[c.0 as usize].data {
                NodeData::Element(_) => self.text_into(c, s),
                NodeData::Text { kind: TextKind::Text | TextKind::Cdata, data } => s.push_str(data),
                NodeData::Text { .. } => {}
            }
        }
    }

    /// 后代里的 `tag` 元素（不含自己），按文档序。
    pub fn get_elements_by_tag_name(&self, id: NodeId, tag: &str) -> Vec<NodeId> {
        let mut out = Vec::new();
        self.collect(id, tag, &mut out);
        out
    }

    fn collect(&self, id: NodeId, tag: &str, out: &mut Vec<NodeId>) {
        for c in self.children(id) {
            if self.tag(c) == tag {
                out.push(c);
            }
            self.collect(c, tag, out);
        }
    }

    fn detach(&mut self, node: NodeId) {
        if let Some(p) = self.nodes[node.0 as usize].parent.take() {
            let kids = &mut self.el_mut(p).child_nodes;
            if let Some(i) = kids.iter().position(|&k| k == node) {
                kids.remove(i);
            }
        }
    }

    /// 接到最后（原先挂在别处的先摘下来）。
    pub fn append_child(&mut self, parent: NodeId, node: NodeId) -> NodeId {
        self.detach(node);
        self.nodes[node.0 as usize].parent = Some(parent);
        self.el_mut(parent).child_nodes.push(node);
        node
    }

    /// 插到 `reference` 之前（None 接到最后）；原先挂在别处的先摘下来。
    pub fn insert_before(&mut self, parent: NodeId, node: NodeId, reference: Option<NodeId>) -> NodeId {
        let Some(r) = reference else {
            return self.append_child(parent, node);
        };
        self.detach(node);
        self.nodes[node.0 as usize].parent = Some(parent);
        let kids = &mut self.el_mut(parent).child_nodes;
        // TS `splice(indexOf(ref), 0, …)`：ref 不在里头时 indexOf 为 -1，插到倒数第一个之前
        let at = match kids.iter().position(|&k| k == r) {
            Some(i) => i,
            None => kids.len().saturating_sub(1),
        };
        kids.insert(at, node);
        node
    }

    /// 从父元素上摘下来。
    pub fn remove(&mut self, node: NodeId) {
        self.detach(node);
    }

    /// 深拷贝（不带原文区间，没挂上）。
    pub fn clone_node(&mut self, id: NodeId) -> NodeId {
        self.copy_from(None, id)
    }

    /// 从另一棵树深拷一份进来（不带原文区间，没挂上）。
    pub fn import_node(&mut self, from: &Tree, id: NodeId) -> NodeId {
        self.copy_from(Some(from), id)
    }

    fn copy_from(&mut self, from: Option<&Tree>, id: NodeId) -> NodeId {
        let src = from.unwrap_or(self).node(id).data.clone();
        match src {
            NodeData::Text { kind, data } => self.create_text(kind, data),
            NodeData::Element(e) => {
                let el = self.create_element(e.tag);
                self.el_mut(el).attrs = e.attrs;
                for c in e.child_nodes {
                    let k = self.copy_from(from, c);
                    self.append_child(el, k);
                }
                el
            }
        }
    }

    /// 建一个元素：`t.h("note", &[("id", "n1")], [t.h("pitch", &[], [...]).into(), "文字".into()])`。
    /// 属性给 None 的不写（同 TS 的 `undefined` / `null` / `false`）。
    pub fn h<K: Into<Kid>>(&mut self, tag: &str, attrs: &[(&str, Option<&str>)], kids: impl IntoIterator<Item = K>) -> NodeId {
        let el = self.create_element(tag);
        for (k, v) in attrs {
            if let Some(v) = v {
                self.set_attribute(el, k, *v);
            }
        }
        for k in kids {
            let n = match k.into() {
                Kid::Node(n) => n,
                Kid::Text(s) => self.create_text(TextKind::Text, s),
            };
            self.append_child(el, n);
        }
        el
    }

    /// 元素 → XML 文本。
    pub fn serialize(&self, id: NodeId) -> String {
        let mut out = String::new();
        self.write_node(id, &mut out);
        out
    }

    fn write_node(&self, id: NodeId, out: &mut String) {
        match &self.nodes[id.0 as usize].data {
            NodeData::Text { kind, data } => match kind {
                TextKind::Text => esc_text(data, out),
                TextKind::Cdata => {
                    out.push_str("<![CDATA[");
                    out.push_str(data);
                    out.push_str("]]>");
                }
                TextKind::Comment => {
                    out.push_str("<!--");
                    out.push_str(data);
                    out.push_str("-->");
                }
                TextKind::Pi => {
                    out.push_str("<?");
                    out.push_str(data);
                    out.push_str("?>");
                }
            },
            NodeData::Element(e) => {
                out.push('<');
                out.push_str(&e.tag);
                for a in &e.attrs {
                    out.push(' ');
                    out.push_str(&a.name);
                    out.push_str("=\"");
                    esc_attr(&a.value, out);
                    out.push('"');
                }
                if e.child_nodes.is_empty() {
                    out.push_str("/>");
                    return;
                }
                out.push('>');
                for &c in &e.child_nodes {
                    self.write_node(c, out);
                }
                out.push_str("</");
                out.push_str(&e.tag);
                out.push('>');
            }
        }
    }
}

/// XML 1.0 不许出现的控制字符：识别从音乐字体里取到的文字会带，写进去整份文件读不开。
#[inline]
fn banned(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{fffe}' | '\u{ffff}')
}

fn esc_text(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c if banned(c) => {}
            c => out.push(c),
        }
    }
}

fn esc_attr(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c if banned(c) => {}
            c => out.push(c),
        }
    }
}

/// 文字转义（`<>&` 转实体、剔掉 XML 1.0 不许出现的控制字符）
pub fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    esc_text(s, &mut out);
    out
}

/// 属性值转义（另转 `"`）
pub fn escape_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    esc_attr(s, &mut out);
    out
}

/// 整份文档：树、根、根前根后的原文。
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct XmlDoc {
    pub tree: Tree,
    pub root: NodeId,
    /// 根元素之前的原文（`<?xml …?>`、`<!DOCTYPE …>`、注释、空白），序列化原样写回
    pub prolog: String,
    /// 根元素之后的原文
    pub epilog: String,
}

impl XmlDoc {
    /// 全文档里的 `tag` 元素（含根），按文档序。
    pub fn get_elements_by_tag_name(&self, tag: &str) -> Vec<NodeId> {
        let mut out = Vec::new();
        if self.tree.tag(self.root) == tag {
            out.push(self.root);
        }
        self.tree.collect(self.root, tag, &mut out);
        out
    }

    /// 整份文档 → XML 文本（根前根后的原文原样带上）。
    pub fn serialize(&self) -> String {
        let mut out = String::with_capacity(self.prolog.len() + self.epilog.len());
        out.push_str(&self.prolog);
        self.tree.write_node(self.root, &mut out);
        out.push_str(&self.epilog);
        out
    }
}

// ───────────────────────── 解析 ─────────────────────────

/// 正则 `[^\s<>/=!?"'&;]` 里的字符（标签名、属性名）。
#[inline]
fn name_char(c: char) -> bool {
    !js::is_space(c) && !matches!(c, '<' | '>' | '/' | '=' | '!' | '?' | '"' | '\'' | '&' | ';')
}

/// `\r\n`、`\r` → `\n`。
fn newlines(s: &str) -> std::borrow::Cow<'_, str> {
    if !s.contains('\r') {
        return s.into();
    }
    s.replace("\r\n", "\n").replace('\r', "\n").into()
}

/// 一般实体声明 `<!ENTITY 名 "值">`（同 TS 的粘连正则 `/<!ENTITY\s+([^\s%]+)\s+("([^"]*)"|'([^']*)')\s*>/y`）。
/// 在 `k` 处认得出就回（名、值、声明之后的位置）。
fn entity_decl(t: &str, k: usize) -> Option<(&str, &str, usize)> {
    t.get(k..)?.strip_prefix("<!ENTITY")?;
    let mut p = k + 8;
    let spaces = |p: &mut usize| {
        let st = *p;
        while let Some(c) = t[*p..].chars().next().filter(|&c| js::is_space(c)) {
            *p += c.len_utf8();
        }
        *p > st
    };
    if !spaces(&mut p) {
        return None;
    }
    let ns = p;
    while let Some(c) = t[p..].chars().next().filter(|&c| !js::is_space(c) && c != '%') {
        p += c.len_utf8();
    }
    if p == ns {
        return None;
    }
    let name = &t[ns..p];
    if !spaces(&mut p) {
        return None;
    }
    let q = t[p..].chars().next().filter(|&c| c == '"' || c == '\'')?;
    let vs = p + 1;
    let ve = vs + t[vs..].find(q)?;
    p = ve + 1;
    spaces(&mut p);
    if !t[p..].starts_with('>') {
        return None;
    }
    Some((name, &t[vs..ve], p + 1))
}

struct Parser<'a> {
    text: &'a str,
    /// 当前位置（字节）
    i: usize,
    ix: Utf16Index,
    entities: HashMap<String, String>,
}

type R<T> = Result<T, XmlError>;

impl<'a> Parser<'a> {
    fn fail<T>(&self, what: impl Into<String>, at_byte: usize) -> R<T> {
        Err(XmlError { message: what.into(), at: self.ix.to_u16(at_byte) })
    }

    fn byte(&self, at: usize) -> Option<u8> {
        self.text.as_bytes().get(at).copied()
    }

    fn starts(&self, at: usize, s: &str) -> bool {
        self.text.as_bytes().get(at..).is_some_and(|b| b.starts_with(s.as_bytes()))
    }

    fn skip_space(&mut self) {
        while let Some(c) = self.text[self.i..].chars().next().filter(|&c| js::is_space(c)) {
            self.i += c.len_utf8();
        }
    }

    fn name_at(&self, at: usize) -> R<&'a str> {
        let rest = self.text.get(at..).unwrap_or("");
        let end = rest.find(|c: char| !name_char(c)).unwrap_or(rest.len());
        if end == 0 {
            return self.fail("缺标签名或属性名", at);
        }
        Ok(&rest[..end])
    }

    fn until(&self, close: &str, what: &str) -> R<usize> {
        match self.text[self.i..].find(close) {
            Some(e) => Ok(self.i + e),
            None => self.fail(format!("{what}没收口"), self.i),
        }
    }

    /// 实体解码。`s` 是（换行归一后的）正文，`at` 是它在原文里起点的 UTF-16 位置；报错位置 = `at` + 在 `s` 里的 UTF-16 偏移。
    fn decode(&self, s: &str, at: u32) -> R<String> {
        if !s.contains('&') {
            return Ok(s.to_string());
        }
        let err = |what: String, off: usize| -> R<String> { Err(XmlError { message: what, at: at + s[..off].encode_utf16().count() as u32 }) };
        let mut out = String::with_capacity(s.len());
        let mut last = 0;
        while let Some(rel) = s[last..].find('&') {
            let amp = last + rel;
            out.push_str(&s[last..amp]);
            let body_end = s[amp + 1..].find(|c: char| c == ';' || c == '&' || js::is_space(c)).map_or(s.len(), |k| amp + 1 + k);
            let e = &s[amp + 1..body_end];
            let semi = s[body_end..].starts_with(';');
            let m_end = if semi { body_end + 1 } else { body_end };
            let m = &s[amp..m_end];
            if !semi {
                return err("实体没写分号".into(), amp);
            }
            if let Some(num) = e.strip_prefix('#') {
                let code = if let Some(hex) = num.strip_prefix('x') {
                    js::parse_int(hex, 16)
                } else if !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit()) {
                    js::number(num)
                } else {
                    f64::NAN
                };
                if !code.is_finite() || code > 0x10ffff as f64 || code < 0.0 {
                    return err(format!("坏的字符引用 {m}"), amp);
                }
                out.push(char::from_u32(code as u32).unwrap_or('\u{fffd}'));
            } else {
                let v = match e {
                    "lt" => Some("<"),
                    "gt" => Some(">"),
                    "amp" => Some("&"),
                    "quot" => Some("\""),
                    "apos" => Some("'"),
                    _ => self.entities.get(e).map(|s| s.as_str()),
                };
                match v {
                    Some(v) => out.push_str(v),
                    None => return err(format!("不认得的实体 {m}"), amp),
                }
            }
            last = m_end;
        }
        out.push_str(&s[last..]);
        Ok(out)
    }

    /// `<!DOCTYPE …>`：跳过（引号里与内部子集里的 `>` 不算收口），顺手记下一般实体声明。
    fn doctype(&mut self) -> R<()> {
        let t = self.text;
        let b = t.as_bytes();
        let n = b.len();
        let mut depth = 0i32;
        let mut j = self.i + 9;
        while j < n {
            let c = b[j];
            if c == b'"' || c == b'\'' {
                match t[j + 1..].find(c as char) {
                    Some(e) => j = j + 1 + e,
                    None => return self.fail("DOCTYPE 引号没收口", j),
                }
            } else if c == b'[' {
                depth += 1;
                let mut k = j + 1;
                while k < n && b[k] != b']' {
                    if let Some((name, val, next)) = entity_decl(t, k) {
                        if !self.entities.contains_key(name) {
                            self.entities.insert(name.to_string(), val.to_string());
                        }
                        k = next;
                    } else {
                        k += t[k..].chars().next().map_or(1, |c| c.len_utf8());
                    }
                }
            } else if c == b']' {
                depth -= 1;
            } else if c == b'>' && depth <= 0 {
                break;
            }
            j += 1;
        }
        if j >= n {
            return self.fail("DOCTYPE 没收口", self.i);
        }
        self.i = j + 1;
        Ok(())
    }

    /// 根前根后的那些：空白、注释、处理指令（`doctype_ok` 时还有 DOCTYPE）。
    fn misc(&mut self, doctype_ok: bool) -> R<()> {
        loop {
            self.skip_space();
            if self.starts(self.i, "<!--") {
                self.i = self.until("-->", "注释")? + 3;
            } else if self.starts(self.i, "<?") {
                self.i = self.until("?>", "处理指令")? + 2;
            } else if doctype_ok && self.starts(self.i, "<!DOCTYPE") {
                self.doctype()?;
            } else {
                return Ok(());
            }
        }
    }

    fn parse(mut self) -> R<XmlDoc> {
        let t = self.text;
        let n = t.len();
        let mut tree = Tree::new();
        let mut root: Option<NodeId> = None;
        if t.starts_with('\u{feff}') {
            self.i = 3;
        }
        let prolog_from = self.i;
        self.misc(true)?;
        if self.i >= n {
            return self.fail("没有根元素", self.i);
        }
        if self.byte(self.i) != Some(b'<') {
            return self.fail("根元素前有文字", self.i);
        }
        let prolog = t[prolog_from..self.i].to_string();

        let mut stack: Vec<NodeId> = Vec::new();
        loop {
            let i = self.i;
            if i >= n {
                let top = *stack.last().expect("根已开");
                return self.fail(format!("<{}> 没闭合", tree.tag(top)), i);
            }
            if self.byte(i) != Some(b'<') {
                let end = t[i..].find('<').map_or(n, |k| i + k);
                let Some(&top) = stack.last() else { break };
                let data = self.decode(&newlines(&t[i..end]), self.ix.to_u16(i))?;
                let node = tree.create_text(TextKind::Text, data);
                tree.append_child(top, node);
                self.i = end;
                continue;
            }
            if self.starts(i, "<!--") {
                let Some(&top) = stack.last() else { break };
                let e = self.until("-->", "注释")?;
                let node = tree.create_text(TextKind::Comment, &t[i + 4..e]);
                tree.append_child(top, node);
                self.i = e + 3;
                continue;
            }
            if self.starts(i, "<![CDATA[") {
                let Some(&top) = stack.last() else { return self.fail("CDATA 在根元素外", i) };
                let e = self.until("]]>", "CDATA")?;
                let node = tree.create_text(TextKind::Cdata, newlines(&t[i + 9..e]));
                tree.append_child(top, node);
                self.i = e + 3;
                continue;
            }
            if self.starts(i, "<?") {
                let Some(&top) = stack.last() else { break };
                let e = self.until("?>", "处理指令")?;
                let node = tree.create_text(TextKind::Pi, &t[i + 2..e]);
                tree.append_child(top, node);
                self.i = e + 2;
                continue;
            }
            if self.byte(i + 1) == Some(b'!') {
                return self.fail("元素里不能有声明", i);
            }
            if self.byte(i + 1) == Some(b'/') {
                let name = self.name_at(i + 2)?;
                let Some(el) = stack.pop() else { return self.fail(format!("多余的 </{name}>"), i) };
                if tree.tag(el) != name {
                    return self.fail(format!("</{name}> 与 <{}> 不配对", tree.tag(el)), i);
                }
                self.i = i + 2 + name.len();
                self.skip_space();
                if self.byte(self.i) != Some(b'>') {
                    return self.fail(format!("</{name}> 没收口"), self.i);
                }
                self.i += 1;
                tree.el_mut(el).end = self.ix.to_u16(self.i) as i64;
                if stack.is_empty() {
                    break;
                }
                continue;
            }
            // 根闭合后就跳出了，「不止一个根元素」走不到（同 TS）
            let start = i;
            let tag = self.name_at(i + 1)?;
            let el = tree.create_element(tag);
            tree.el_mut(el).start = self.ix.to_u16(start) as i64;
            self.i = i + 1 + tag.len();
            loop {
                let before = self.i;
                self.skip_space();
                if self.starts(self.i, "/>") || self.byte(self.i) == Some(b'>') {
                    break;
                }
                if self.i == before {
                    return self.fail(format!("<{tag}> 里属性之间缺空白"), self.i);
                }
                if self.i >= n {
                    return self.fail(format!("<{tag}> 没收口"), self.i);
                }
                let name = self.name_at(self.i)?;
                self.i += name.len();
                self.skip_space();
                if self.byte(self.i) != Some(b'=') {
                    return self.fail(format!("属性 {name} 缺 ="), self.i);
                }
                self.i += 1;
                self.skip_space();
                let q = self.byte(self.i);
                if q != Some(b'"') && q != Some(b'\'') {
                    return self.fail(format!("属性 {name} 没加引号"), self.i);
                }
                let q = q.unwrap() as char;
                let Some(e) = t[self.i + 1..].find(q).map(|k| self.i + 1 + k) else {
                    return self.fail(format!("属性 {name} 引号没收口"), self.i);
                };
                let raw = &t[self.i + 1..e];
                if raw.contains('<') {
                    return self.fail(format!("属性 {name} 的值里有 <"), self.i);
                }
                if tree.has_attribute(el, name) {
                    return self.fail(format!("属性 {name} 重复"), self.i);
                }
                // `/\r\n|[\t\n\r]/g → " "`
                let spaced = if raw.contains(['\t', '\n', '\r']) { raw.replace("\r\n", " ").replace(['\t', '\n', '\r'], " ") } else { raw.to_string() };
                let value = self.decode(&spaced, self.ix.to_u16(self.i + 1))?;
                tree.set_attribute(el, name, value);
                self.i = e + 1;
            }
            match stack.last() {
                Some(&top) => {
                    tree.append_child(top, el);
                }
                None => root = Some(el),
            }
            if self.byte(self.i) == Some(b'/') {
                self.i += 2;
                tree.el_mut(el).end = self.ix.to_u16(self.i) as i64;
                if stack.is_empty() {
                    break;
                }
            } else {
                self.i += 1;
                stack.push(el);
            }
        }
        let epilog_from = self.i;
        self.misc(false)?;
        if self.i < n {
            return self.fail("根元素后还有内容", self.i);
        }
        Ok(XmlDoc { tree, root: root.expect("跳出时根已建"), prolog, epilog: t[epilog_from..].to_string() })
    }
}

/// MusicXML 文本 → 树。不合法回 [`XmlError`]。
pub fn parse(text: &str) -> Result<XmlDoc, XmlError> {
    Parser { text, i: 0, ix: Utf16Index::new(text), entities: HashMap::new() }.parse()
}

#[cfg(test)]
mod tests;
