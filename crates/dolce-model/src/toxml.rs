//! `ScoreDoc` → MusicXML（同 `src/model/toxml.ts`，**直通**，与 `fromxml` 互逆）。
//!
//! 语义从模型写；MusicXML 独有的表层（坐标、符干、对齐、字体、读不懂的属性与子节点）在 `fromxml` 绑定的原节点上，
//! 写出时**通用回填**：属性——原节点上写出端没写、也不归写出端管（`OWNS[标签].attrs`）的，按原顺序接在后面；
//! 子节点——写出端写了的逐个配对原节点（有绑定的用绑定，其余按「标签 + 同标签第几个」，个别按编号），递归回填；
//! 原节点里没配上的，标签归写出端管就是模型删了它、丢掉，否则原样保留，插在它原先前面最近一个配上的兄弟之后。
//!
//! **元素顺序是硬要求**（`<attributes>` 在音符前、`<harmony>` 在它修饰的音符前、左线最前、右线最后）。

use crate::deconames::rehearsal_bracketed;
use crate::doc::*;
use crate::harmony::harmony_xml as chord_text_xml;
use crate::helpers::SOURCE_ID_PREFIX;
use crate::timeaxis::{axis_of_song, TimeAxis};
use crate::xmlproject::{has_tie_syntax, project_for_music_xml, ProjectOptions};
use crate::xmlsurface::{EngravedLayout, Position, PrintLayout, Slot, Surface, SystemLayout};
use dolce_base::js;
use dolce_base::Msg;
use dolce_xml::{escape_attr, escape_text, NodeId, Tree};
use std::collections::HashMap;

/// 一层缩进两格
fn ind(depth: usize) -> String {
    "  ".repeat(depth)
}

// ───────────────────────── 输出树与表层回填 ─────────────────────────

/// 属性：按写入次序，`None` 的不写
type Attrs = Vec<(&'static str, Option<String>)>;

/// 写出端先建树、最后序列化：回填表层要在子节点齐了之后才能配对。
#[derive(Default)]
struct XNode {
    name: String,
    attrs: Attrs,
    kids: Vec<usize>,
    /// 已转义的文字
    text: Option<String>,
    /// 原样的一段 XML（可多行，按所在层级重新缩进）
    raw: Option<String>,
    /// 子节点与自己写在同一行
    inline: bool,
    /// 原节点（表层）
    sur: Option<NodeId>,
    /// 覆盖 `OWNS[name].attrs`
    own_attrs: Option<Vec<&'static str>>,
}

impl XNode {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| *k == name).and_then(|(_, v)| v.as_deref())
    }
}

enum Kids {
    All,
    Some(&'static [&'static str]),
}

struct Own {
    attrs: &'static [&'static str],
    kids: Option<Kids>,
    same: &'static [(&'static str, &'static str)],
}

/// 写出端管的属性与子节点：原节点上的这些以模型为准，不回填。表里没有的标签：属性子节点一个不管。
/// `same`：写出端管、但模型不记缺省值的属性——原文写的恰是缺省值时照原文带回。
fn owns(tag: &str) -> Option<Own> {
    const N: &[(&str, &str)] = &[];
    let o = |attrs: &'static [&'static str], kids: Option<Kids>| Own { attrs, kids, same: N };
    let k = |v: &'static [&'static str]| Some(Kids::Some(v));
    Some(match tag {
        "score-partwise" => o(&["version"], k(&["work", "movement-title", "identification", "defaults", "credit", "part-list", "part"])),
        "work" => o(&[], k(&["work-number", "work-title"])),
        "identification" => o(&[], k(&["creator", "rights", "encoding", "miscellaneous"])),
        "creator" => o(&["type"], None),
        "encoding" => o(&[], k(&["software"])),
        "miscellaneous" => o(&[], k(&["miscellaneous-field"])),
        "miscellaneous-field" => o(&["name"], None),
        "defaults" => o(&[], k(&["scaling", "page-layout"])),
        "scaling" => o(&[], Some(Kids::All)),
        "page-layout" => o(&[], k(&["page-height", "page-width", "page-margins"])),
        "page-margins" => o(&["type"], Some(Kids::All)),
        "lyric-font" => o(&["font-family", "font-size", "font-weight", "font-style"], None),
        "credit" => o(&["page"], k(&["credit-type", "credit-words"])),
        "credit-words" => o(&["default-x", "default-y", "justify", "halign", "valign", "font-family", "font-size", "font-weight"], None),
        "part-list" => o(&[], k(&["part-group", "score-part"])),
        "part-group" => o(&["type", "number"], k(&["group-symbol", "group-name", "group-abbreviation", "group-barline"])),
        "score-part" => o(&["id"], k(&["part-name", "part-abbreviation"])),
        "part" => o(&["id"], k(&["measure"])),
        "measure" => o(&["number", "implicit"], k(&["print", "barline", "attributes", "direction", "harmony", "note", "backup", "forward", "sound"])),
        "print" => o(&["new-system", "new-page"], None),
        "attributes" => o(&[], k(&["divisions", "key", "time", "staves", "clef", "transpose", "measure-style"])),
        "measure-style" => o(&[], k(&["multiple-rest"])),
        "key" => o(&[], k(&["cancel", "fifths", "mode", "key-step", "key-alter"])),
        "time" => o(&["symbol"], k(&["beats", "beat-type"])),
        "clef" => o(&["number"], k(&["sign", "line", "clef-octave-change"])),
        "transpose" => o(&[], k(&["diatonic", "chromatic", "octave-change"])),
        "note" => Own {
            attrs: &["print-object"],
            kids: k(&[
                "grace", "cue", "chord", "pitch", "unpitched", "rest", "duration", "tie", "voice", "type", "dot", "accidental",
                "time-modification", "notehead", "staff", "beam", "notations", "lyric",
            ]),
            same: &[("print-object", "yes")],
        },
        "grace" => o(&["slash"], None),
        "rest" => o(&["measure"], None),
        "pitch" | "unpitched" => o(&[], Some(Kids::All)),
        "tie" => o(&["type"], None),
        "type" => o(&["size"], None),
        "accidental" => o(&["parentheses"], None),
        "time-modification" => o(&[], k(&["actual-notes", "normal-notes"])),
        "beam" => o(&["number"], None),
        "notations" => o(&[], k(&["slur", "tied", "tuplet", "fermata", "arpeggiate", "articulations", "ornaments", "technical"])),
        "slur" | "tied" => o(&["type", "number", "placement", "orientation"], None),
        "tuplet" => o(&["type", "number", "bracket", "placement"], None),
        "fermata" => Own { attrs: &["type"], kids: None, same: &[("type", "upright")] },
        "articulations" | "ornaments" | "technical" => o(&[], Some(Kids::All)),
        "lyric" => o(&["number", "name", "placement"], k(&["syllabic", "text", "extend", "elision"])),
        "extend" => o(&["type"], None),
        "harmony" => o(&["staff"], k(&["root", "kind", "bass", "degree", "offset"])),
        "root" | "bass" | "degree" => o(&[], Some(Kids::All)),
        "kind" => o(&["text", "use-symbols", "parentheses-degrees"], None),
        "direction" => o(&["placement"], k(&["direction-type", "offset", "staff"])),
        "direction-type" | "dynamics" => o(&[], Some(Kids::All)),
        "wedge" => o(&["type"], None),
        "metronome" => o(&["parentheses"], k(&["beat-unit", "beat-unit-dot", "per-minute"])),
        "bracket" => o(&["type", "line-end", "line-type"], None),
        "pedal" => o(&["type", "line"], None),
        "octave-shift" => o(&["type", "size"], None),
        "sound" => o(&["dacapo", "dalsegno", "fine", "segno", "coda", "tocoda", "tempo"], None),
        "barline" => o(&["location"], k(&["bar-style", "ending", "repeat"])),
        "ending" => Own { attrs: &["number", "type", "print-object"], kids: None, same: &[("print-object", "yes")] },
        "repeat" => o(&["direction", "times"], None),
        _ => return None,
    })
}

/// 子节点按编号配对的标签
fn match_key(tag: &str) -> Option<&'static [&'static str]> {
    Some(match tag {
        "part-group" => &["type", "number"],
        "slur" | "tied" | "tuplet" => &["type", "number"],
        "beam" | "lyric" | "clef" | "staff-layout" => &["number"],
        "page-margins" => &["type"],
        "barline" => &["location"],
        _ => return None,
    })
}

fn leading_spaces(l: &str) -> usize {
    l.bytes().take_while(|&b| b == b' ').count()
}

/// 序列化原节点，去掉它在源文件里的整体缩进（按收尾行的缩进左移），再按所在层级重新缩进
fn serialize_dedented(t: &Tree, el: NodeId) -> String {
    let s = t.serialize(el);
    let lines: Vec<&str> = s.split('\n').collect();
    if lines.len() < 2 {
        return lines[0].to_owned();
    }
    let base = leading_spaces(lines[lines.len() - 1]);
    lines.iter().enumerate().map(|(i, l)| if i == 0 { *l } else { &l[base.min(leading_spaces(l))..] }).collect::<Vec<_>>().join("\n")
}

struct Out<'s> {
    nodes: Vec<XNode>,
    stack: Vec<usize>,
    tree: Option<&'s Tree>,
}

impl<'s> Out<'s> {
    fn new(tree: Option<&'s Tree>) -> Out<'s> {
        Out { nodes: vec![XNode::default()], stack: vec![0], tree }
    }

    fn add(&mut self, n: XNode) -> usize {
        let i = self.nodes.len();
        self.nodes.push(n);
        let top = *self.stack.last().unwrap();
        self.nodes[top].kids.push(i);
        i
    }

    /// 开一个元素（`close` 收口）。`inline`：子节点写在同一行
    fn open(&mut self, name: &str, attrs: Attrs, sur: Option<NodeId>, inline: bool) -> usize {
        let i = self.add(XNode { name: name.into(), attrs, sur, inline, ..XNode::default() });
        self.stack.push(i);
        i
    }

    fn open0(&mut self, name: &str) -> usize {
        self.open(name, vec![], None, false)
    }

    fn close(&mut self) {
        self.stack.pop();
    }

    /// 空元素（原节点有子节点时回填后可能不空）
    fn leaf(&mut self, name: &str, attrs: Attrs, sur: Option<NodeId>) -> usize {
        self.add(XNode { name: name.into(), attrs, sur, ..XNode::default() })
    }

    /// 文字元素（文字已是字符串；数先 `num_to_string`）
    fn text(&mut self, name: &str, text: &str, attrs: Attrs, sur: Option<NodeId>) -> usize {
        self.add(XNode { name: name.into(), attrs, sur, text: Some(escape_text(text)), ..XNode::default() })
    }

    fn num(&mut self, name: &str, v: f64) -> usize {
        self.add(XNode { name: name.into(), text: Some(js::num_to_string(v)), ..XNode::default() })
    }

    fn num_a(&mut self, name: &str, v: f64, attrs: Attrs) -> usize {
        self.add(XNode { name: name.into(), attrs, text: Some(js::num_to_string(v)), ..XNode::default() })
    }

    fn raw(&mut self, xml: String) {
        self.add(XNode { raw: Some(xml), ..XNode::default() });
    }

    /// 原节点上要接在后面的属性
    fn carried_attrs(&self, n: usize, sur: NodeId) -> String {
        let t = self.tree.expect("有原节点必有树");
        let node = &self.nodes[n];
        let own_def = owns(&node.name);
        let own: &[&str] = match &node.own_attrs {
            Some(o) => o,
            None => own_def.as_ref().map_or(&[], |o| o.attrs),
        };
        let same = own_def.as_ref().map_or(&[][..], |o| o.same);
        let mut out = String::new();
        for a in t.attributes(sur) {
            let same_v = same.iter().find(|(k, _)| *k == a.name).map(|(_, v)| *v);
            if node.attr(&a.name).is_some() || (own.contains(&a.name.as_str()) && same_v != Some(a.value.as_str())) {
                continue;
            }
            out += &format!(" {}=\"{}\"", a.name, escape_attr(&a.value));
        }
        out
    }

    /// 子节点配对原节点，并把没配上、不归写出端管的原子节点插回去（回新的子节点表）
    fn merge_kids(&mut self, n: usize, sur: NodeId) -> Vec<usize> {
        let t = self.tree.expect("有原节点必有树");
        let orig: Vec<NodeId> = t.children(sur).collect();
        let kids = self.nodes[n].kids.clone();
        let mut used: HashMap<NodeId, usize> = HashMap::new();
        for &k in &kids {
            if let Some(s) = self.nodes[k].sur {
                if t.parent(s) == Some(sur) && !used.contains_key(&s) {
                    used.insert(s, k);
                }
            }
        }
        for &k in &kids {
            let kn = &self.nodes[k];
            if kn.sur.is_some() || kn.raw.is_some() {
                continue;
            }
            let keys = match_key(&kn.name);
            let key_of = |get: &dyn Fn(&str) -> Option<String>| keys.unwrap().iter().map(|a| get(a).unwrap_or_default()).collect::<Vec<_>>().join("\u{0}");
            let mine = if keys.is_some() { key_of(&|a| kn.attr(a).map(str::to_owned)) } else { String::new() };
            let hit = orig.iter().copied().find(|&c| {
                t.tag(c) == kn.name && !used.contains_key(&c) && (keys.is_none() || key_of(&|a| t.get_attribute(c, a).map(str::to_owned)) == mine)
            });
            if let Some(h) = hit {
                self.nodes[k].sur = Some(h);
                used.insert(h, k);
            }
        }
        let own = owns(&self.nodes[n].name).and_then(|o| o.kids);
        if matches!(own, Some(Kids::All)) {
            return kids;
        }
        let mut out = kids;
        let mut head = 0usize;
        let mut placed: HashMap<NodeId, usize> = used.clone();
        for (i, &c) in orig.iter().enumerate() {
            if used.contains_key(&c) || matches!(own, Some(Kids::Some(l)) if l.contains(&t.tag(c))) {
                continue;
            }
            let node = self.nodes.len();
            self.nodes.push(XNode { raw: Some(serialize_dedented(t, c)), ..XNode::default() });
            let mut at: Option<usize> = None;
            for j in (0..i).rev() {
                if let Some(prev) = placed.get(&orig[j]) {
                    // `out.indexOf(prev) + 1`（找不到时 indexOf 是 -1，+1 落到 0）
                    at = Some(out.iter().position(|x| x == prev).map_or(0, |p| p + 1));
                    break;
                }
            }
            let at = at.unwrap_or_else(|| {
                head += 1;
                head - 1
            });
            out.insert(at, node);
            placed.insert(c, node);
        }
        out
    }

    fn serialize_node(&mut self, n: usize, depth: usize, lines: &mut Vec<String>) {
        if let Some(raw) = &self.nodes[n].raw {
            for line in raw.split('\n') {
                lines.push(ind(depth) + line);
            }
            return;
        }
        let sur = self.nodes[n].sur;
        let mut attrs = String::new();
        for (k, v) in &self.nodes[n].attrs {
            if let Some(v) = v {
                attrs += &format!(" {k}=\"{}\"", escape_attr(v));
            }
        }
        if let Some(s) = sur {
            attrs += &self.carried_attrs(n, s);
        }
        let name = self.nodes[n].name.clone();
        if let Some(text) = &self.nodes[n].text {
            lines.push(format!("{}<{name}{attrs}>{text}</{name}>", ind(depth)));
            return;
        }
        let kids = match sur {
            Some(s) => self.merge_kids(n, s),
            None => self.nodes[n].kids.clone(),
        };
        if kids.is_empty() {
            lines.push(format!("{}<{name}{attrs}/>", ind(depth)));
        } else if self.nodes[n].inline {
            let mut inner = vec![];
            for k in kids {
                self.serialize_node(k, 0, &mut inner);
            }
            lines.push(format!("{}<{name}{attrs}>{}</{name}>", ind(depth), inner.join("")));
        } else {
            lines.push(format!("{}<{name}{attrs}>", ind(depth)));
            for k in kids {
                self.serialize_node(k, depth + 1, lines);
            }
            lines.push(format!("{}</{name}>", ind(depth)));
        }
    }

    fn finish(mut self) -> String {
        let mut lines = vec![];
        for k in self.nodes[0].kids.clone() {
            self.serialize_node(k, 0, &mut lines);
        }
        lines.join("\n")
    }
}

fn n(v: Option<f64>) -> Option<String> {
    v.map(js::num_to_string)
}

/// `x || undefined`（数：0 与 NaN 不写）
fn nz(v: Option<f64>) -> Option<String> {
    v.filter(|x| *x != 0.0 && !x.is_nan()).map(js::num_to_string)
}

/// `s || undefined`（空串不写）
fn ne(v: Option<&str>) -> Option<String> {
    v.filter(|s| !s.is_empty()).map(str::to_owned)
}

fn s(v: &str) -> Option<String> {
    Some(v.to_owned())
}

fn yes(b: Option<bool>) -> Option<String> {
    (b == Some(true)).then(|| "yes".into())
}

/// 版面坐标 → 属性
fn pos_attrs(pos: Option<&Position>) -> Attrs {
    match pos {
        None => vec![],
        Some(p) => vec![("default-x", n(p.default_x)), ("default-y", n(p.default_y)), ("relative-x", n(p.relative_x)), ("relative-y", n(p.relative_y))],
    }
}

fn font_attrs(f: Option<&FontSpec>) -> Attrs {
    match f {
        None => vec![],
        Some(f) => vec![("font-family", f.family.clone()), ("font-size", n(f.size)), ("font-weight", f.weight.clone()), ("font-style", f.style.clone())],
    }
}

/// 写出这一遍的上下文：表层（可无）、导出版面（可无）与是否带源 id
struct Ctx<'a> {
    surface: Option<&'a Surface>,
    layout: Option<&'a EngravedLayout>,
    source_ids: bool,
}

impl Ctx<'_> {
    fn sur(&self, oid: Oid) -> Option<NodeId> {
        self.surface.and_then(|s| s.of0(oid))
    }
    fn sur_at(&self, oid: Oid, slot: Slot) -> Option<NodeId> {
        self.surface.and_then(|s| s.of(oid, slot))
    }
    fn pos(&self, oid: Oid) -> Option<&Position> {
        if oid.is_none() {
            return None;
        }
        self.layout.and_then(|l| l.pos.get(&oid))
    }
}

// ───────────────────────── 头部 ─────────────────────────

fn write_key(o: &mut Out, k: &Key) {
    o.open0("key");
    if let Some(c) = k.cancel {
        o.num("cancel", c);
    }
    o.num("fifths", k.fifths);
    if let Some(m) = k.mode.as_deref().filter(|m| !m.is_empty()) {
        o.text("mode", m, vec![], None);
    }
    for a in k.explicit_accidentals.iter().flatten() {
        o.text("key-step", &a.step, vec![], None);
        o.num("key-alter", a.alter);
    }
    o.close();
}

fn write_time(o: &mut Out, t: &Time) {
    o.open("time", vec![("symbol", ne(t.symbol.as_deref()))], None, false);
    o.num("beats", t.beats);
    o.num("beat-type", t.beat_type);
    o.close();
}

fn write_system_layout(o: &mut Out, sl: &SystemLayout, both_margins: bool) {
    o.open0("system-layout");
    if sl.left_margin.is_some() || sl.right_margin.is_some() {
        o.open0("system-margins");
        if both_margins || sl.left_margin.is_some() {
            o.num("left-margin", sl.left_margin.unwrap_or(0.0));
        }
        if both_margins || sl.right_margin.is_some() {
            o.num("right-margin", sl.right_margin.unwrap_or(0.0));
        }
        o.close();
    }
    if let Some(v) = sl.system_distance {
        o.num("system-distance", v);
    }
    if let Some(v) = sl.top_system_distance {
        o.num("top-system-distance", v);
    }
    o.close();
}

fn write_defaults(o: &mut Out, def: Option<&Defaults>, sl: Option<&SystemLayout>) {
    if def.is_none() && sl.is_none() {
        return;
    }
    o.open0("defaults");
    if let Some(sc) = def.and_then(|d| d.scaling.as_ref()) {
        o.open0("scaling");
        o.num("millimeters", sc.millimeters);
        o.num("tenths", sc.tenths);
        o.close();
    }
    if let Some(pl) = def.and_then(|d| d.page_layout.as_ref()) {
        o.open0("page-layout");
        if let Some(h) = pl.page_height {
            o.num("page-height", h);
        }
        if let Some(w) = pl.page_width {
            o.num("page-width", w);
        }
        for mg in pl.margins.iter().flatten() {
            o.open("page-margins", vec![("type", s(mg.odd_even.as_ref().map_or("both", |x| x.as_str())))], None, false);
            o.num("left-margin", mg.left);
            o.num("right-margin", mg.right);
            o.num("top-margin", mg.top);
            o.num("bottom-margin", mg.bottom);
            o.close();
        }
        o.close();
    }
    if let Some(sl) = sl {
        write_system_layout(o, sl, true);
    }
    if let Some(lf) = def.and_then(|d| d.lyric_font.as_ref()) {
        o.leaf("lyric-font", font_attrs(Some(lf)), None);
    }
    o.close();
}

fn write_credit(o: &mut Out, c: &Credit, cx: &Ctx) {
    let sur = cx.sur(c.oid);
    let page = c.page.filter(|p| *p != 0.0 && !p.is_nan()).unwrap_or(1.0);
    o.open("credit", vec![("page", s(&js::num_to_string(page)))], sur, false);
    if let Some(t) = c.kind.as_deref().filter(|t| !t.is_empty()) {
        o.text("credit-type", t, vec![], None);
    }
    let a: Attrs = vec![
        ("default-x", n(c.x)),
        ("default-y", n(c.y)),
        ("justify", c.justify.as_ref().map(|x| x.as_str()).and_then(|x| ne(Some(x)))),
        ("halign", c.halign.as_ref().map(|x| x.as_str()).and_then(|x| ne(Some(x)))),
        ("valign", c.valign.as_ref().map(|x| x.as_str()).and_then(|x| ne(Some(x)))),
        ("font-family", c.font_family.clone()),
        ("font-size", n(c.font_size)),
        ("font-weight", c.font_weight.clone()),
    ];
    let lines: Vec<String> = match &c.words {
        Some(w) => w.clone(),
        None => c.text.split('\n').map(str::to_owned).collect(),
    };
    for (i, line) in lines.iter().enumerate() {
        // 模型只记首个 `<credit-words>` 的版式；有原节点时第二行起的版式全从原节点来
        if i > 0 && sur.is_some() {
            let k = o.text("credit-words", line, vec![], None);
            o.nodes[k].own_attrs = Some(vec![]);
        } else {
            o.text("credit-words", line, a.clone(), None);
        }
    }
    o.close();
}

// ───────────────────────── 音符 ─────────────────────────

fn harmony_xml(o: &mut Out, h: &Harmony, cx: &Ctx) {
    // 简谱来源只有和弦原文，结构交给和弦文字解析
    if h.kind.is_empty() {
        if let Some(t) = h.text.as_deref().filter(|t| !t.is_empty()) {
            o.raw(chord_text_xml(t, h.offset.unwrap_or(0.0), None));
            return;
        }
    }
    let mut a = pos_attrs(cx.pos(h.oid));
    a.push(("staff", n(h.staff)));
    o.open("harmony", a, cx.sur(h.oid), false);
    o.open0("root");
    o.text("root-step", &h.root.step, vec![("font-size", nz(h.font_size))], None);
    if h.root.alter != 0.0 && !h.root.alter.is_nan() {
        o.num_a("root-alter", h.root.alter, vec![("location", (h.root.alter_left == Some(true)).then(|| "left".into()))]);
    }
    o.close();
    o.text(
        "kind",
        &h.kind,
        vec![("text", h.kind_text.clone()), ("use-symbols", yes(h.use_symbols)), ("parentheses-degrees", yes(h.parentheses_degrees))],
        None,
    );
    if let Some(b) = &h.bass {
        o.open0("bass");
        o.text("bass-step", &b.step, vec![], None);
        if b.alter != 0.0 && !b.alter.is_nan() {
            o.num_a("bass-alter", b.alter, vec![("location", (b.alter_left == Some(true)).then(|| "left".into()))]);
        }
        o.close();
    }
    for g in h.degrees.iter().flatten() {
        o.open0("degree");
        o.num("degree-value", g.value);
        o.num("degree-alter", g.alter);
        o.text("degree-type", g.kind.as_str(), vec![], None);
        o.close();
    }
    if let Some(off) = h.offset.filter(|x| *x != 0.0 && !x.is_nan()) {
        o.num("offset", off);
    }
    o.close();
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn lyric_xml(o: &mut Out, l: &Lyric, cx: &Ctx) {
    let number = match &l.number_text {
        Some(t) => t.clone(),
        None if l.refrain == Some(true) => "chorus".into(),
        None => js::num_to_string(l.number),
    };
    let mut a: Attrs = vec![("number", Some(number)), ("name", l.name.clone()), ("placement", l.placement.as_ref().and_then(|p| ne(Some(p.as_str()))))];
    a.extend(pos_attrs(cx.pos(l.oid)));
    o.open("lyric", a, cx.sur(l.oid), false);
    if let Some(sy) = &l.syllabic {
        if !sy.as_str().is_empty() {
            o.text("syllabic", sy.as_str(), vec![], None);
        }
    }
    // 印刷段号并进首字（只写数字段号，不带点的隔一个空格）
    let label = match &l.verse_label {
        None => String::new(),
        Some(v) => {
            let mut cs = v.chars();
            let last = cs.next_back();
            let head = cs.as_str();
            if last.is_some_and(|c| matches!(c, '.' | '．' | '、')) && is_digits(head) {
                v.clone()
            } else if is_digits(v) {
                format!("{v} ")
            } else {
                String::new()
            }
        }
    };
    let text = format!("{label}{}{}{}", l.leading_punctuation.as_deref().unwrap_or(""), l.text, l.trailing_punctuation.as_deref().unwrap_or(""));
    o.text("text", &text, vec![], None);
    if l.extend == Some(true) {
        o.leaf("extend", vec![("type", l.extend_type.as_ref().and_then(|t| ne(Some(t.as_str()))))], None);
    }
    o.close();
}

fn truthy_len<T>(v: &Option<Vec<T>>) -> bool {
    v.as_ref().is_some_and(|l| !l.is_empty())
}

/// 一个音符元素上要挂的 `<notations>`（含跨元素记号的起止；`starts` / `stops` 是 `song.marks` 的下标）
fn notations_xml(o: &mut Out, nt: Option<&Notations>, starts: &[usize], stops: &[usize], marks: &[Mark], cx: &Ctx) {
    let tremolo = nt.and_then(|x| x.tremolo).filter(|x| *x != 0.0 && !x.is_nan());
    let has = nt.is_some_and(|x| {
        truthy_len(&x.articulations)
            || truthy_len(&x.ornaments)
            || tremolo.is_some()
            || truthy_len(&x.technical)
            || x.fermata == Some(true)
            || x.arpeggiate == Some(true)
            || x.glissando == Some(true)
    }) || !starts.is_empty()
        || !stops.is_empty();
    if !has {
        return;
    }
    // 按类型、编号定序
    let order = |i: &usize| -> f64 {
        let m = &marks[*i];
        let k = match m.kind {
            MarkType::Tied => 0.0,
            MarkType::Slur => 1.0,
            MarkType::Tuplet => 2.0,
            _ => -1.0,
        };
        k * 1000.0 + m.number.unwrap_or(1.0)
    };
    let mut starts = starts.to_vec();
    let mut stops = stops.to_vec();
    js::sort_by(&mut starts, |a, b| order(a) - order(b));
    js::sort_by(&mut stops, |a, b| order(a) - order(b));
    o.open0("notations");
    // 同一个音上先收后起；真·自起自收的收口放最后
    let selfs: Vec<usize> = starts.iter().copied().filter(|m| stops.contains(m)).collect();
    let write_stop = |o: &mut Out, i: usize| {
        let m = &marks[i];
        if matches!(m.kind, MarkType::Slur | MarkType::Tied | MarkType::Tuplet) {
            o.leaf(m.kind.as_str(), vec![("type", s("stop")), ("number", n(Some(m.number.unwrap_or(1.0))))], cx.sur_at(m.oid, Slot::Stop));
        }
    };
    for &m in &stops {
        if !selfs.contains(&m) {
            write_stop(o, m);
        }
    }
    for &i in &starts {
        let m = &marks[i];
        let placement = m.placement.as_ref().and_then(|p| ne(Some(p.as_str())));
        let sur = cx.sur_at(m.oid, Slot::Start);
        let number = n(Some(m.number.unwrap_or(1.0)));
        match m.kind {
            MarkType::Slur | MarkType::Tied => {
                let ori = m.orientation.as_ref().and_then(|p| ne(Some(p.as_str())));
                o.leaf(m.kind.as_str(), vec![("type", s("start")), ("number", number), ("placement", placement), ("orientation", ori)], sur);
            }
            MarkType::Tuplet => {
                let bracket = m.bracket.map(|b| if b { "yes".to_owned() } else { "no".to_owned() });
                o.leaf("tuplet", vec![("type", s("start")), ("number", number), ("bracket", bracket), ("placement", placement)], sur);
            }
            _ => {}
        }
    }
    for &m in &stops {
        if selfs.contains(&m) {
            write_stop(o, m);
        }
    }
    if let Some(nt) = nt {
        if nt.fermata == Some(true) {
            o.leaf("fermata", vec![("type", (nt.fermata_inverted == Some(true)).then(|| "inverted".into()))], None);
        }
        if nt.arpeggiate == Some(true) {
            o.leaf("arpeggiate", vec![], None);
        }
    }
    for (tag, list) in [("articulations", nt.and_then(|x| x.articulations.as_ref())), ("ornaments", nt.and_then(|x| x.ornaments.as_ref())), ("technical", nt.and_then(|x| x.technical.as_ref()))] {
        let trem = if tag == "ornaments" { tremolo } else { None };
        if list.is_none_or(|l| l.is_empty()) && trem.is_none() {
            continue;
        }
        o.open0(tag);
        for a in list.into_iter().flatten() {
            let pl = if tag == "articulations" { nt.and_then(|x| x.artic_placement.as_ref()).and_then(|m| m.get(a)) } else { None };
            o.leaf(a, vec![("placement", pl.and_then(|p| ne(Some(p.as_str()))))], None);
        }
        if let Some(t) = trem {
            let tp = nt.and_then(|x| x.tremolo_pos.as_ref());
            o.num_a("tremolo", t, vec![("type", s("single")), ("default-x", n(tp.map(|p| p.x))), ("default-y", n(tp.map(|p| p.y)))]);
        }
        o.close();
    }
    o.close();
}

/// `Math.max(0, Math.round(x))`
fn dur_int(x: f64) -> f64 {
    js::max(0.0, js::round(x))
}

/// 一个 `Chord` → 一条或多条 `<note>`（和弦音从第二个起带 `<chord/>`）
fn chord_xml(o: &mut Out, ch: &Chord, starts: &[usize], stops: &[usize], marks: &[Mark], cx: &Ctx) {
    let mut k = 0usize;
    let mut write_one = |o: &mut Out, ni: Option<usize>, is_chord_note: bool, with_notations: bool| {
        let note = ni.map(|i| &ch.notes[i]);
        let id = if cx.source_ids {
            let s = format!("{SOURCE_ID_PREFIX}{}{}", ch.id, if k > 0 { format!("-{k}") } else { String::new() });
            k += 1;
            Some(s)
        } else {
            None
        };
        let host_oid = note.map_or(ch.oid, |n| n.oid);
        let mut a: Attrs = vec![("id", id)];
        a.extend(pos_attrs(cx.pos(host_oid)));
        a.push(("print-object", (ch.print_object == Some(false)).then(|| "no".into())));
        o.open("note", a, cx.sur(host_oid), false);
        if let Some(g) = &ch.grace {
            o.leaf("grace", vec![("slash", yes(g.slash))], None);
        }
        if ch.cue == Some(true) {
            o.leaf("cue", vec![], None);
        }
        if is_chord_note {
            o.leaf("chord", vec![], None);
        }
        if let Some(r) = &ch.rest {
            o.leaf("rest", vec![("measure", yes(r.measure))], None);
        } else if let Some(p) = note.and_then(|n| n.pitch.as_ref()) {
            o.open0("pitch");
            o.text("step", p.step.as_str(), vec![], None);
            if p.alter != 0.0 && !p.alter.is_nan() {
                o.num("alter", p.alter);
            }
            o.num("octave", p.octave);
            o.close();
        } else if ch.rhythm == Some(true) {
            let u = note.and_then(|n| n.unpitched.as_ref());
            o.open0("unpitched");
            o.text("display-step", u.and_then(|u| u.step.as_ref()).map_or("B", |s| s.as_str()), vec![], None);
            o.num("display-octave", u.and_then(|u| u.octave).unwrap_or(4.0));
            o.close();
        } else {
            o.leaf("rest", vec![], None);
        }
        // 倚音没有 duration
        if ch.grace.is_none() {
            o.num("duration", dur_int(ch.duration.divisions));
        }
        let tie = note.and_then(|n| n.tie.as_ref());
        if tie.and_then(|t| t.start) == Some(true) {
            o.leaf("tie", vec![("type", s("start"))], None);
        }
        if tie.and_then(|t| t.stop) == Some(true) {
            o.leaf("tie", vec![("type", s("stop"))], None);
        }
        o.num("voice", ch.voice);
        if let Some(ty) = &ch.duration.kind {
            let raw_size = if is_chord_note { note.and_then(|n| n.type_size.clone()) } else { ch.type_size.clone().or_else(|| note.and_then(|n| n.type_size.clone())) };
            let size = if ch.cue == Some(true) && raw_size.as_deref() == Some("cue") { None } else { raw_size };
            o.text("type", ty.as_str(), vec![("size", ne(size.as_deref()))], None);
        }
        let mut i = 0.0;
        while i < ch.duration.dots {
            o.leaf("dot", vec![], None);
            i += 1.0;
        }
        if let Some(acc) = note.and_then(|n| n.accidental.as_ref()).filter(|a| !a.as_str().is_empty()) {
            o.text("accidental", acc.as_str(), vec![("parentheses", yes(note.and_then(|n| n.accidental_parentheses)))], None);
        }
        if let Some(tm) = &ch.duration.time_mod {
            o.open0("time-modification");
            o.num("actual-notes", tm.actual);
            o.num("normal-notes", tm.normal);
            o.close();
        }
        if let Some(stem) = note.filter(|n| !n.oid.is_none()).and_then(|n| cx.layout.and_then(|l| l.stems.get(&n.oid))) {
            o.text("stem", stem, vec![], None);
        }
        // 简谱来源的节奏音符画斜线符头；打击乐谱读进来的照它原来的符头
        if ch.rhythm == Some(true) && !is_chord_note && note.and_then(|n| n.unpitched.as_ref()).and_then(|u| u.step.as_ref()).is_none() {
            o.text("notehead", "slash", vec![], None);
        } else if let Some(nh) = note.and_then(|n| n.notehead.as_deref()).filter(|x| !x.is_empty()) {
            o.text("notehead", nh, vec![], None);
        }
        if ch.staff > 1.0 {
            o.num("staff", ch.staff);
        }
        for (i, b) in ch.beams.iter().flatten().enumerate() {
            o.text("beam", b.as_str(), vec![("number", Some((i + 1).to_string()))], None);
        }
        // 跨元素记号挂回原来那个音，其余记号与歌词挂首音
        let idx = ni.unwrap_or(0) as f64;
        let len = ch.notes.len() as f64;
        let on = |x: Option<f64>| {
            let v = x.unwrap_or(0.0);
            v == idx || (idx == 0.0 && v >= len)
        };
        let st: Vec<usize> = starts.iter().copied().filter(|&i| on(marks[i].start_note)).collect();
        let sp: Vec<usize> = stops.iter().copied().filter(|&i| on(marks[i].end_note)).collect();
        notations_xml(o, if with_notations { ch.notations.as_ref() } else { None }, &st, &sp, marks, cx);
        if with_notations {
            for l in ch.lyrics.iter().flatten() {
                lyric_xml(o, l, cx);
            }
        }
        o.close();
    };
    if ch.notes.is_empty() {
        write_one(o, None, false, true);
        return;
    }
    for i in 0..ch.notes.len() {
        write_one(o, Some(i), i > 0, i == 0);
    }
}

fn sound_attrs(sd: &Sound) -> Attrs {
    vec![
        ("dacapo", yes(sd.dacapo)),
        ("dalsegno", ne(sd.dalsegno.as_deref())),
        ("fine", yes(sd.fine)),
        ("segno", ne(sd.segno.as_deref())),
        ("coda", ne(sd.coda.as_deref())),
        ("tocoda", ne(sd.tocoda.as_deref())),
        ("tempo", n(sd.tempo)),
    ]
}

fn has_attrs(a: &Attrs) -> bool {
    a.iter().any(|(_, v)| v.is_some())
}

/// `Direction` 与 `DirectionPart` 共有的那几项（TS 里 `Direction` 直接当 `DirectionPart` 用）
struct PartView<'a> {
    oid: Oid,
    kind: &'a str,
    text: Option<&'a str>,
    tempo: Option<&'a Metronome>,
    span_type: Option<&'a SpanType>,
    wedge_type: Option<&'a WedgeType>,
    line: Option<bool>,
    shift: Option<&'a OctaveShift>,
}

fn view_of_direction(d: &Direction) -> PartView<'_> {
    PartView {
        oid: d.oid,
        kind: &d.kind,
        text: d.text.as_deref(),
        tempo: d.tempo.as_ref(),
        span_type: d.span_type.as_ref(),
        wedge_type: d.wedge_type.as_ref(),
        line: d.line,
        shift: d.shift.as_ref(),
    }
}

fn view_of_part(d: &DirectionPart) -> PartView<'_> {
    PartView {
        oid: d.oid,
        kind: &d.kind,
        text: d.text.as_deref(),
        tempo: d.tempo.as_ref(),
        span_type: d.span_type.as_ref(),
        wedge_type: d.wedge_type.as_ref(),
        line: d.line,
        shift: d.shift.as_ref(),
    }
}

fn direction_xml(o: &mut Out, dir: &Direction, cx: &Ctx) {
    if dir.kind == "sound" {
        // 小节级 `<sound>`：播放语义从模型写，其余属性与子元素由原节点回填
        let sur = cx.sur(dir.oid);
        if dir.sound.is_some() || sur.is_some() {
            o.leaf("sound", dir.sound.as_ref().map(sound_attrs).unwrap_or_default(), sur);
        }
        return;
    }
    o.open("direction", vec![("placement", dir.placement.as_ref().and_then(|p| ne(Some(p.as_str()))))], cx.sur(dir.oid), false);
    o.open0("direction-type");
    direction_part_xml(o, &view_of_direction(dir), cx.sur_at(dir.oid, Slot::Part), cx);
    for part in dir.more.iter().flatten() {
        direction_part_xml(o, &view_of_part(part), cx.sur(part.oid), cx);
    }
    o.close();
    if let Some(off) = dir.offset {
        o.num("offset", off);
    }
    if let Some(sd) = &dir.sound {
        let a = sound_attrs(sd);
        if has_attrs(&a) {
            o.leaf("sound", a, None);
        }
    }
    if let Some(st) = dir.staff {
        o.num("staff", st);
    }
    o.close();
}

/// `<direction-type>` 下的一个子元素
fn direction_part_xml(o: &mut Out, dir: &PartView, sur: Option<NodeId>, cx: &Ctx) {
    let pos = pos_attrs(cx.pos(dir.oid));
    let mut lay = pos.clone();
    lay.push(("font-size", n(if dir.oid.is_none() { None } else { cx.layout.and_then(|l| l.font_size.get(&dir.oid).copied()) })));
    match dir.kind {
        "dynamics" => {
            o.open("dynamics", lay, sur, true);
            o.leaf(dir.text.filter(|t| !t.is_empty()).unwrap_or("mf"), vec![], None);
            o.close();
        }
        "words" | "rehearsal" => {
            let text = dir.text.unwrap_or("");
            let mut a = lay;
            a.push(("enclosure", (dir.kind == "rehearsal" && rehearsal_bracketed(text)).then(|| "none".into())));
            o.text(dir.kind, text, a, sur);
        }
        "wedge" => {
            let ty = if dir.span_type == Some(&SpanType::Stop) { "stop".to_owned() } else { dir.wedge_type.map_or("crescendo", |w| w.as_str()).to_owned() };
            let mut a: Attrs = vec![("type", Some(ty))];
            a.extend(pos);
            o.leaf("wedge", a, sur);
        }
        "metronome" => {
            let mut a = lay;
            a.push(("parentheses", yes(dir.tempo.and_then(|t| t.parentheses))));
            o.open("metronome", a, sur, false);
            o.text("beat-unit", dir.tempo.and_then(|t| t.beat_unit.as_ref()).map_or("quarter", |b| b.as_str()), vec![], None);
            if dir.tempo.and_then(|t| t.beat_unit_dot) == Some(true) {
                o.leaf("beat-unit-dot", vec![], None);
            }
            match dir.tempo.and_then(|t| t.per_minute_text.as_deref()) {
                Some(t) => {
                    o.text("per-minute", t, vec![], None);
                }
                None => {
                    o.num("per-minute", dir.tempo.and_then(|t| t.per_minute).unwrap_or(90.0));
                }
            }
            o.close();
        }
        "bracket" => {
            // 伴奏括弧（简谱来源才带起止）；MusicXML 读进来的没有 spanType，照旧写空元素
            match dir.span_type {
                Some(st) => o.leaf("bracket", vec![("type", s(st.as_str())), ("line-end", s("down")), ("line-type", s("solid"))], sur),
                None => o.leaf("bracket", vec![], sur),
            };
        }
        "pedal" => {
            let line = dir.line.map(|l| if l { "yes".to_owned() } else { "no".to_owned() });
            let mut a: Attrs = vec![("type", s(dir.span_type.map_or("start", |x| x.as_str()))), ("line", line)];
            a.extend(pos);
            o.leaf("pedal", a, sur);
        }
        "octave-shift" => {
            // MusicXML 的 octave-shift 没有 start：起点写 up / down（读入没记方向的按 8va）
            let stop_like = matches!(dir.span_type, Some(SpanType::Stop | SpanType::Continue));
            let ty = if stop_like { dir.span_type.unwrap().as_str().to_owned() } else { dir.shift.map_or("down", |x| x.dir.as_str()).to_owned() };
            let size = if stop_like { None } else { Some(js::num_to_string(dir.shift.map_or(8.0, |x| x.size))) };
            let mut a: Attrs = vec![("type", Some(ty)), ("size", size)];
            a.extend(pos);
            o.leaf("octave-shift", a, sur);
        }
        _ => {
            o.leaf(dir.kind, pos, sur);
        }
    }
}

fn barline_xml(o: &mut Out, b: &Barline, cx: &Ctx) {
    let sur = cx.sur(b.oid);
    o.open("barline", vec![("location", s(b.location.as_str()))], sur, false);
    if let Some(st) = b.style.as_ref().filter(|x| !x.as_str().is_empty()) {
        o.text("bar-style", st.as_str(), vec![], None);
    }
    if let Some(e) = &b.ending {
        let nums = e.numbers.iter().map(|x| js::num_to_string(*x)).collect::<Vec<_>>().join(",");
        let ea: Attrs = vec![("number", Some(nums.clone())), ("type", s(e.kind.as_str())), ("print-object", (e.print_object == Some(false)).then(|| "no".into()))];
        // 读进来的原文是空的 `<ending/>` 就照写空的；文本格式投影来的照旧写房号
        if e.text.is_none() && sur.is_some() {
            o.leaf("ending", ea, None);
        } else {
            o.text("ending", e.text.as_deref().unwrap_or(&nums), ea, None);
        }
    }
    if let Some(r) = &b.repeat {
        if !r.as_str().is_empty() {
            let times = b.repeat_times.filter(|t| *t > 2.0).map(js::num_to_string);
            o.leaf("repeat", vec![("direction", s(r.as_str())), ("times", times)], None);
        }
    }
    o.close();
}

fn print_xml(o: &mut Out, p: Option<&Print>, lay: Option<&PrintLayout>, cx: &Ctx) {
    if p.is_none() && lay.is_none() {
        return;
    }
    let a: Attrs = vec![("new-system", yes(p.and_then(|p| p.new_system))), ("new-page", yes(p.and_then(|p| p.new_page)))];
    let sur = p.and_then(|p| cx.sur(p.oid));
    // 只剩组号：没有要写的
    if !has_attrs(&a) && lay.is_none() && sur.is_none() {
        return;
    }
    o.open("print", a, sur, false);
    if let Some(sl) = lay.and_then(|l| l.system_layout.as_ref()) {
        write_system_layout(o, sl, false);
    }
    for sl in lay.and_then(|l| l.staff_layouts.as_ref()).into_iter().flatten() {
        let na: Attrs = vec![("number", n(sl.staff))];
        match sl.staff_distance {
            None => {
                o.leaf("staff-layout", na, None);
            }
            Some(d) => {
                o.open("staff-layout", na, None, false);
                o.num("staff-distance", d);
                o.close();
            }
        }
    }
    o.close();
}

/// `shown`：本小节起这个声部的谱表显示与否（`<staff-details print-object>`）
fn attributes_xml(o: &mut Out, attrs: &MeasureAttrs, shown: Option<bool>, cx: &Ctx) {
    o.open("attributes", vec![], cx.sur(attrs.oid), false);
    if let Some(d) = attrs.divisions {
        o.num("divisions", d);
    }
    if let Some(k) = &attrs.key {
        write_key(o, k);
    }
    if let Some(t) = &attrs.time {
        write_time(o, t);
    }
    if let Some(s) = attrs.staves {
        o.num("staves", s);
    }
    for c in attrs.clefs.iter().flatten() {
        o.open("clef", vec![("number", nz(c.staff))], None, false);
        o.text("sign", c.sign.as_str(), vec![], None);
        if let Some(l) = c.line {
            o.num("line", l);
        }
        if let Some(oc) = c.octave_change {
            o.num("clef-octave-change", oc);
        }
        o.close();
    }
    if let Some(sh) = shown {
        o.leaf("staff-details", vec![("print-object", s(if sh { "yes" } else { "no" }))], None);
    }
    if let Some(tr) = &attrs.transpose {
        o.open0("transpose");
        if let Some(d) = tr.diatonic {
            o.num("diatonic", d);
        }
        o.num("chromatic", tr.chromatic);
        if let Some(oc) = tr.octave_change {
            o.num("octave-change", oc);
        }
        o.close();
    }
    if let Some(mr) = attrs.multi_rest.filter(|x| *x != 0.0 && !x.is_nan()) {
        o.open0("measure-style");
        o.num("multiple-rest", mr);
        o.close();
    }
    o.close();
}

/// 共用时间轴上的写法（`part_xml`）：`shown` 见 `attributes_xml`；`number` 按轴上的格编号；`attrs` 顶替小节自己的
/// （`Some(None)` = 顶替成没有）
#[derive(Default)]
pub(crate) struct AxisOpts<'a> {
    pub shown: Option<bool>,
    pub number: Option<String>,
    pub attrs: Option<Option<&'a MeasureAttrs>>,
}

type MarksBy = HashMap<ElementId, Vec<usize>>;

fn measure_xml(o: &mut Out, m: &Measure, by_start: &MarksBy, by_end: &MarksBy, marks: &[Mark], cx: &Ctx, axis: AxisOpts) {
    let width = if m.oid.is_none() { None } else { cx.layout.and_then(|l| l.widths.get(&m.oid).copied()) };
    o.open(
        "measure",
        vec![("number", Some(axis.number.clone().unwrap_or_else(|| m.number.clone()))), ("implicit", yes(m.implicit)), ("width", n(width))],
        cx.sur(m.oid),
        false,
    );
    // 顺序是硬要求：print → 左线 → attributes → direction → (harmony/note)* → 右线
    let lay = if m.oid.is_none() { None } else { cx.layout.and_then(|l| l.prints.get(&m.oid)) };
    print_xml(o, m.print.as_ref(), lay, cx);
    for b in m.barlines.iter().flatten() {
        if b.location == BarLocation::Left {
            barline_xml(o, b, cx);
        }
    }
    let attrs = match axis.attrs {
        None => m.attrs.as_ref(),
        Some(a) => a,
    };
    if attrs.is_some() || axis.shown.is_some() {
        let empty = MeasureAttrs::default();
        attributes_xml(o, attrs.unwrap_or(&empty), axis.shown, cx);
    }
    let count = m.elements.len() as f64;
    let dir_at = |d: &Direction| js::min(d.after_elements.unwrap_or(0.0), count);
    let mut cursor = 0.0f64;
    let mut end = 0.0f64;
    let move_to = |o: &mut Out, cursor: &mut f64, target: f64| {
        if target < *cursor {
            o.open0("backup");
            o.num("duration", *cursor - target);
            o.close();
        } else if target > *cursor {
            o.open0("forward");
            o.num("duration", target - *cursor);
            o.close();
        }
        *cursor = target;
    };
    let write_later_attrs = |o: &mut Out, cursor: &mut f64, end: f64, i: f64| {
        for la in m.later_attrs.iter().flatten() {
            if js::min(la.after_elements, count) != i {
                continue;
            }
            move_to(o, cursor, la.onset.unwrap_or(end));
            attributes_xml(o, &la.attrs, None, cx);
        }
    };
    let write_dir = |o: &mut Out, cursor: &mut f64, end: f64, d: &Direction| {
        if d.kind != "sound" {
            move_to(o, cursor, d.onset.unwrap_or(end));
        }
        direction_xml(o, d, cx);
    };
    let write_harmony = |o: &mut Out, cursor: &mut f64, h: &Harmony, owner: f64| {
        move_to(o, cursor, h.onset.unwrap_or(owner));
        harmony_xml(o, h, cx);
    };
    for d in m.directions.iter().flatten() {
        if dir_at(d) == 0.0 {
            write_dir(o, &mut cursor, end, d);
        }
    }
    let empty: Vec<usize> = vec![];
    for (i, el) in m.elements.iter().enumerate() {
        let fi = i as f64;
        // 小节中间的小节线按 afterElements 插回去
        for b in m.barlines.iter().flatten() {
            if b.location == BarLocation::Middle && b.after_elements == Some(fi) {
                barline_xml(o, b, cx);
            }
        }
        if i > 0 {
            write_later_attrs(o, &mut cursor, end, fi);
            for d in m.directions.iter().flatten() {
                if dir_at(d) == fi {
                    write_dir(o, &mut cursor, end, d);
                }
            }
        }
        let onset = el.onset().unwrap_or(end);
        match el {
            Element::Chord(c) => {
                if let Some(h) = &c.harmony {
                    write_harmony(o, &mut cursor, h, onset);
                }
                for h in c.later_harmonies.iter().flatten() {
                    write_harmony(o, &mut cursor, h, onset);
                }
                // 长音中途换和弦（挂在增时线上）
                for su in c.sustains.iter().flatten() {
                    if let Some(h) = &su.harmony {
                        write_harmony(o, &mut cursor, h, onset);
                    }
                }
                move_to(o, &mut cursor, onset);
                chord_xml(o, c, by_start.get(&c.id).unwrap_or(&empty), by_end.get(&c.id).unwrap_or(&empty), marks, cx);
                if c.grace.is_none() {
                    cursor += dur_int(c.duration.divisions);
                }
                end = cursor;
            }
            Element::Space(sp) => {
                if let (Spacer::X, Some(d)) = (&sp.spacer, &sp.duration) {
                    // 不可见休止：占时值
                    if let Some(h) = &sp.harmony {
                        write_harmony(o, &mut cursor, h, onset);
                    }
                    move_to(o, &mut cursor, onset);
                    cursor += dur_int(d.divisions);
                    end = cursor;
                    o.open("note", vec![("print-object", s("no"))], None, false);
                    o.leaf("rest", vec![], None);
                    o.num("duration", dur_int(d.divisions));
                    o.num("voice", sp.voice);
                    if let Some(t) = &d.kind {
                        o.text("type", t.as_str(), vec![], None);
                    }
                    o.close();
                } else if let Some(h) = &sp.harmony {
                    // `y` 占位符只为挂和弦
                    write_harmony(o, &mut cursor, h, onset);
                }
            }
        }
    }
    if count > 0.0 {
        write_later_attrs(o, &mut cursor, end, count);
        for d in m.directions.iter().flatten() {
            if dir_at(d) == count {
                write_dir(o, &mut cursor, end, d);
            }
        }
    }
    // `<forward>` 撑出来的空拍
    if let Some(d) = m.duration {
        if d > cursor {
            move_to(o, &mut cursor, d);
        }
    }
    for b in m.barlines.iter().flatten() {
        if b.location == BarLocation::Right {
            barline_xml(o, b, cx);
        }
    }
    o.close();
}

fn part_xml(o: &mut Out, pi: usize, part: &Part, song: &Song, cx: &Ctx, axis: Option<&TimeAxis>) {
    let mut by_start: MarksBy = HashMap::new();
    let mut by_end: MarksBy = HashMap::new();
    for (i, m) in song.marks.iter().enumerate() {
        // 只有这三种在 MusicXML 里挂在 `<notations>` 上
        if !matches!(m.kind, MarkType::Slur | MarkType::Tied | MarkType::Tuplet) {
            continue;
        }
        by_start.entry(m.start).or_default().push(i);
        by_end.entry(m.end).or_default().push(i);
    }
    o.open("part", vec![("id", s(&part.id))], cx.sur(part.oid), false);
    match axis {
        Some(ax) if ax.grouped => axis_measures_xml(o, pi, part, song, ax, &by_start, &by_end, cx),
        _ => {
            for m in &part.measures {
                measure_xml(o, m, &by_start, &by_end, &song.marks, cx, AxisOpts::default());
            }
        }
    }
    o.close();
}

/// 按各声部共用的时间轴逐格写：这个声部在某格没有小节就写一个只有 `<forward>`（整小节时长）的空小节；
/// 整组缺席的那几组把谱表藏起来（`<staff-details print-object="no">`），回到有它的组再显示。
#[allow(clippy::too_many_arguments, clippy::needless_range_loop)]
fn axis_measures_xml(o: &mut Out, pi: usize, part: &Part, song: &Song, axis: &TimeAxis, by_start: &MarksBy, by_end: &MarksBy, cx: &Ctx) {
    let local = &axis.local[pi];
    // 轴上这一格排在最前的声部的小节：各 part 的小节号照它；空小节的时长、换行也照它
    let other = |g: usize| -> Option<&Measure> {
        for (k, p) in song.parts.iter().enumerate() {
            let li = axis.local[k][g];
            if li >= 0 {
                return p.measures.get(li as usize);
            }
        }
        None
    };
    let first = part.measures.first();
    let mut shown = true;
    let mut first_written = false;
    // 轴上走到这一格时生效的调号、拍号；这个 part 已经写出的调号、拍号
    let (mut now_key, mut now_time): (Option<&Key>, Option<&Time>) = (None, None);
    let (mut w_key, mut w_time): (Option<Key>, Option<Time>) = (None, None);
    let note = |a: Option<&MeasureAttrs>, wk: &mut Option<Key>, wt: &mut Option<Time>| {
        if let Some(a) = a {
            if let Some(k) = &a.key {
                *wk = Some(k.clone());
            }
            if let Some(t) = &a.time {
                *wt = Some(t.clone());
            }
        }
    };
    for grp in &axis.groups {
        let present = (grp.start..grp.start + grp.length).any(|g| local[g] >= 0);
        for g in grp.start..grp.start + grp.length {
            let toggle = if g == grp.start && present != shown { Some(present) } else { None };
            if let Some(t) = toggle {
                shown = t;
            }
            let li = local[g];
            let rf = other(g);
            if let Some(a) = rf.and_then(|r| r.attrs.as_ref()) {
                if a.key.is_some() {
                    now_key = a.key.as_ref();
                }
                if a.time.is_some() {
                    now_time = a.time.as_ref();
                }
            }
            if li >= 0 {
                // 头一小节的 `<attributes>` 照写，与已写出的相同的那几项去掉
                let m = &part.measures[li as usize];
                let mut replaced: Option<Option<MeasureAttrs>> = None;
                if li == 0 && first_written {
                    if let Some(a) = &m.attrs {
                        let key_new = a.key.as_ref().is_some_and(|k| Some(k.fifths) != w_key.as_ref().map(|w| w.fifths));
                        let time_new = a.time.as_ref().is_some_and(|t| {
                            Some(t.beats) != w_time.as_ref().map(|w| w.beats) || Some(t.beat_type) != w_time.as_ref().map(|w| w.beat_type)
                        });
                        replaced = Some(if key_new || time_new {
                            Some(MeasureAttrs {
                                key: if key_new { a.key.clone() } else { None },
                                time: if time_new { a.time.clone() } else { None },
                                ..Default::default()
                            })
                        } else {
                            None
                        });
                    }
                }
                match &replaced {
                    Some(r) => note(r.as_ref(), &mut w_key, &mut w_time),
                    None => note(m.attrs.as_ref(), &mut w_key, &mut w_time),
                }
                let opts = AxisOpts { shown: toggle, number: rf.map(|r| r.number.clone()), attrs: replaced.as_ref().map(|r| r.as_ref()) };
                measure_xml(o, m, by_start, by_end, &song.marks, cx, opts);
                first_written = true;
                continue;
            }
            let number = rf.map_or_else(|| (g + 1).to_string(), |r| r.number.clone());
            o.open("measure", vec![("number", Some(number))], None, false);
            if let Some(p) = rf.and_then(|r| r.print.as_ref()) {
                let ns = p.new_system == Some(true);
                let np = p.new_page == Some(true);
                if ns || np {
                    let pr = Print { new_system: ns.then_some(true), new_page: np.then_some(true), ..Default::default() };
                    print_xml(o, Some(&pr), None, cx);
                }
            }
            // 声部还没写过小节：先写 divisions、谱号（取头一小节的），调号拍号取轴上此刻生效的；之后的空小节只跟着这一格的拍号、调号走
            let meter = rf.and_then(|r| r.attrs.as_ref()).filter(|a| a.time.is_some() || a.key.is_some()).map(|a| MeasureAttrs {
                key: a.key.clone(),
                time: a.time.clone(),
                ..Default::default()
            });
            let attrs = if !first_written {
                let mut a = first.and_then(|f| f.attrs.clone()).unwrap_or_default();
                a.oid = Oid::NONE;
                if let Some(k) = now_key {
                    a.key = Some(k.clone());
                }
                if let Some(t) = now_time {
                    a.time = Some(t.clone());
                }
                Some(a)
            } else {
                meter
            };
            note(attrs.as_ref(), &mut w_key, &mut w_time);
            if attrs.is_some() || toggle.is_some() {
                attributes_xml(o, attrs.as_ref().unwrap_or(&MeasureAttrs::default()), toggle, cx);
            }
            first_written = true;
            let len = rf.map_or(0.0, measure_length);
            if len > 0.0 {
                o.open0("forward");
                o.num("duration", len);
                o.close();
            }
            o.close();
        }
    }
}

/// 小节时长（divisions），同 `measure_xml` 的游标走法
fn measure_length(m: &Measure) -> f64 {
    let mut end = 0.0;
    let mut max = 0.0;
    for el in &m.elements {
        let onset = el.onset().unwrap_or(end);
        let d = match el {
            Element::Chord(c) if c.grace.is_none() => Some(c.duration.divisions),
            Element::Space(sp) if sp.spacer == Spacer::X => sp.duration.as_ref().map(|d| d.divisions),
            _ => None,
        };
        if let Some(d) = d {
            let cursor = onset + js::max(0.0, js::round(d));
            end = cursor;
            max = js::max(max, cursor);
        }
    }
    js::max(max, m.duration.unwrap_or(0.0))
}

/// 写出选项
#[derive(Clone, Debug, Default)]
pub struct ToXmlOptions<'a> {
    pub project: ProjectOptions,
    /// 取第几首（缺省第一首）
    pub song: usize,
    /// 每个 `<note>` 带 `id="jp<源元素 id>"`（只给内部派生五线谱用）
    pub source_ids: bool,
    /// 导出版面
    pub layout: Option<&'a EngravedLayout>,
}

/// `ScoreDoc` → MusicXML 文本（含 XML 声明与 DOCTYPE）。**MusicXML 的唯一写出端**。
/// `surface`：MusicXML 读进来的那份表层（文本来源、或要清掉表层时给 None）。
pub fn score_doc_to_music_xml(doc: &ScoreDoc, surface: Option<&Surface>, options: &ToXmlOptions) -> Result<String, Msg> {
    let src = doc.songs.get(options.song).ok_or_else(|| Msg::new("err.noSong"))?;
    let mut popts = options.project.clone();
    popts.slur_ties = Some(popts.slur_ties.unwrap_or(!has_tie_syntax(doc)));
    let song = project_for_music_xml(src, &popts)?;
    let projected = matches!(song, std::borrow::Cow::Owned(_));
    let cx = Ctx { surface, layout: options.layout, source_ids: options.source_ids };
    let mut o = Out::new(surface.map(|s| s.tree()));
    o.raw(r#"<?xml version="1.0" encoding="UTF-8"?>"#.into());
    o.raw(r#"<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">"#.into());
    o.open("score-partwise", vec![("version", s("3.1"))], cx.sur(song.oid), false);
    let num = song.work.number.as_deref().filter(|x| !x.is_empty());
    let title = song.work.title.as_deref().filter(|x| !x.is_empty());
    if num.is_some() || title.is_some() {
        o.open0("work");
        if let Some(x) = num {
            o.text("work-number", x, vec![], None);
        }
        if let Some(x) = title {
            o.text("work-title", x, vec![], None);
        }
        o.close();
    }
    if let Some(mt) = song.work.movement_title.as_deref().filter(|x| !x.is_empty()) {
        o.text("movement-title", mt, vec![], None);
    }
    if song.identification.is_some() || song.meta.is_some() || projected {
        o.open0("identification");
        let ident = song.identification.as_ref();
        for c in ident.map(|i| &i.creators).into_iter().flatten() {
            o.text("creator", &c.text, vec![("type", s(&c.kind))], None);
        }
        if let Some(r) = ident.and_then(|i| i.rights.as_deref()).filter(|x| !x.is_empty()) {
            o.text("rights", r, vec![], None);
        }
        o.open0("encoding");
        let dolce = vec!["Dolce".to_owned()];
        for sw in ident.and_then(|i| i.software.as_ref()).unwrap_or(&dolce) {
            o.text("software", sw, vec![], None);
        }
        o.close();
        // 扩展 meta。schema 顺序：creator*, rights*, encoding?, source?, relation*, miscellaneous?
        if let Some(meta) = song.meta.as_ref().filter(|m| !m.is_empty()) {
            o.open0("miscellaneous");
            for (name, vals) in meta {
                for v in vals {
                    o.text("miscellaneous-field", v, vec![("name", s(name))], None);
                }
            }
            o.close();
        }
        o.close();
    }
    write_defaults(&mut o, song.defaults.as_ref(), options.layout.and_then(|l| l.system_layout.as_ref()));
    for c in song.credits.iter().flatten() {
        write_credit(&mut o, c, &cx);
    }

    o.open0("part-list");
    let groups: &[PartGroup] = song.part_groups.as_deref().unwrap_or(&[]);
    // 组的起止夹在它覆盖的那几个 score-part 前后；没写覆盖哪些的罩全部
    let idx: HashMap<&str, usize> = song.parts.iter().enumerate().map(|(i, p)| (p.id.as_str(), i)).collect();
    let span = |g: &PartGroup| -> (isize, isize) {
        let at: Vec<usize> = g.parts.iter().filter_map(|id| idx.get(id.as_str()).copied()).collect();
        if at.is_empty() {
            (0, song.parts.len() as isize - 1)
        } else {
            (*at.iter().min().unwrap() as isize, *at.iter().max().unwrap() as isize)
        }
    };
    for (pi, p) in song.parts.iter().enumerate() {
        for g in groups {
            if span(g).0 != pi as isize {
                continue;
            }
            o.open("part-group", vec![("type", s("start")), ("number", s(&g.number))], None, false);
            if let Some(sym) = g.symbol.as_ref().filter(|x| !x.as_str().is_empty()) {
                o.text("group-symbol", sym.as_str(), vec![], None);
            }
            if let Some(x) = g.name.as_deref().filter(|x| !x.is_empty()) {
                o.text("group-name", x, vec![], None);
            }
            if let Some(x) = g.abbrev.as_deref().filter(|x| !x.is_empty()) {
                o.text("group-abbreviation", x, vec![], None);
            }
            if g.group_barline == Some(true) {
                o.text("group-barline", "yes", vec![], None);
            }
            o.close();
        }
        o.open("score-part", vec![("id", s(&p.id))], cx.sur_at(p.oid, Slot::ScorePart), false);
        // MuseScore 兼容：`<part-name>` 留空并 print-object="no"
        match p.name.as_deref().filter(|x| !x.is_empty()) {
            Some(nm) => {
                o.text("part-name", nm, vec![("font-size", nz(p.name_size))], None);
            }
            None => {
                o.leaf("part-name", vec![("print-object", s("no"))], None);
            }
        }
        if let Some(x) = p.abbrev.as_deref().filter(|x| !x.is_empty()) {
            o.text("part-abbreviation", x, vec![], None);
        }
        o.close();
        for g in groups {
            if span(g).1 == pi as isize {
                o.leaf("part-group", vec![("type", s("stop")), ("number", s(&g.number))], None);
            }
        }
    }
    o.close();

    // 文本谱一组不一定含全部声部：按共用时间轴逐格写
    let axis = if projected { Some(axis_of_song(&song)) } else { None };
    for (pi, p) in song.parts.iter().enumerate() {
        part_xml(&mut o, pi, p, &song, &cx, axis.as_ref());
    }
    o.close();
    Ok(o.finish() + "\n")
}
