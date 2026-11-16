//! MusicXML → `ScoreDoc`（同 `src/model/fromxml.ts`，**直通**读进唯一的语义模型）。
//!
//! 这里只读**语义**进模型，同时把每个模型对象绑到它的原始节点（[`Surface`]）。版面坐标、符干、对齐、字体、
//! 读不懂的属性与子节点都留在原节点上。**新读一个语义字段时，记得在 `toxml::OWNS` 里认领它**。

use crate::doc::*;
use crate::helpers::{empty_doc, empty_song, IdGen, SOURCE_ID_PREFIX};
use crate::jianpu::{assign_degrees, c_major};
use crate::metakeys::add_meta;
use crate::xmlsurface::{attr_num, child, child_num as num, child_text, children, read_font, split_face_name, Slot, Surface};
use dolce_base::js;
use dolce_base::Msg;
use dolce_xml::{NodeId, Tree, XmlDoc};
use std::collections::HashMap;

/// 读好的一份：模型与它的表层（原树 + 绑定）
pub struct LoadedXml {
    pub doc: ScoreDoc,
    pub surface: Surface,
}

/// MusicXML 文本 → `ScoreDoc`。读不出（XML 坏）回 `err.xmlParse`。
pub fn load_score_doc(xml_text: &str) -> Result<LoadedXml, Msg> {
    let xml = dolce_xml::parse(xml_text).map_err(|_| Msg::new("err.xmlParse"))?;
    let mut r = score_doc_from_xml(xml);
    r.doc.source = Some(xml_text.to_owned());
    Ok(r)
}

/// 建好的 MusicXML 树 → `ScoreDoc`，表层绑在树上。
pub fn score_doc_from_xml(xml: XmlDoc) -> LoadedXml {
    let root = xml.root;
    let mut rd = Reader { s: Surface::new(xml), ids: IdGen::new(), marks: MarkSink::default() };
    let doc = rd.read(root);
    LoadedXml { doc, surface: rd.s }
}

struct Reader {
    s: Surface,
    ids: IdGen,
    marks: MarkSink,
}

fn elems(t: &Tree, el: NodeId) -> Vec<NodeId> {
    t.children(el).collect()
}

fn attr<'a>(t: &'a Tree, el: NodeId, name: &str) -> Option<&'a str> {
    t.get_attribute(el, name)
}

/// 非空属性（TS 的 `if (x)` 判真）
fn attr_truthy<'a>(t: &'a Tree, el: NodeId, name: &str) -> Option<&'a str> {
    attr(t, el, name).filter(|v| !v.is_empty())
}

fn child_text_truthy(t: &Tree, el: NodeId, tag: &str) -> Option<String> {
    child_text(t, el, tag).filter(|v| !v.is_empty())
}

fn read_align(t: &Tree, el: NodeId, name: &str) -> Option<HAlign> {
    attr(t, el, name).and_then(HAlign::known)
}

// ───────────────────────── 头部 ─────────────────────────

fn read_key(t: &Tree, el: NodeId) -> Key {
    let mut k = c_major();
    k.fifths = num(t, Some(el), "fifths").unwrap_or(0.0);
    k.cancel = num(t, Some(el), "cancel");
    k.mode = child_text_truthy(t, el, "mode");
    let steps = children(t, el, "key-step");
    let alters = children(t, el, "key-alter");
    if !steps.is_empty() {
        k.explicit_accidentals = Some(
            steps
                .iter()
                .enumerate()
                .map(|(i, &s)| ExplicitAccidental {
                    step: t.text_content(s),
                    alter: alters.get(i).map_or(0.0, |&a| js::number(&t.text_content(a))),
                })
                .collect(),
        );
    }
    k
}

fn read_time(t: &Tree, el: NodeId) -> Time {
    Time {
        beats: num(t, Some(el), "beats").unwrap_or(4.0),
        beat_type: num(t, Some(el), "beat-type").unwrap_or(4.0),
        symbol: attr_truthy(t, el, "symbol").map(str::to_owned),
        parenthesized: None,
    }
}

fn read_clef(t: &Tree, el: NodeId) -> Clef {
    Clef {
        sign: ClefSign::parse(&child_text(t, el, "sign").unwrap_or_else(|| "G".into())),
        line: num(t, Some(el), "line"),
        octave_change: num(t, Some(el), "clef-octave-change"),
        staff: attr_truthy(t, el, "number").map(js::number),
    }
}

fn read_transpose(t: &Tree, el: NodeId) -> Transpose {
    Transpose {
        chromatic: num(t, Some(el), "chromatic").unwrap_or(0.0),
        diatonic: num(t, Some(el), "diatonic"),
        octave_change: num(t, Some(el), "octave-change"),
    }
}

fn read_defaults(t: &Tree, el: NodeId) -> Defaults {
    let mut d = Defaults::default();
    if let Some(sc) = child(t, el, "scaling") {
        d.scaling = Some(Scaling {
            millimeters: num(t, Some(sc), "millimeters").unwrap_or(7.0),
            tenths: num(t, Some(sc), "tenths").unwrap_or(40.0),
        });
    }
    if let Some(pl) = child(t, el, "page-layout") {
        let mut page = PageLayout { page_width: num(t, Some(pl), "page-width"), page_height: num(t, Some(pl), "page-height"), margins: None };
        let margins: Vec<PageMargins> = children(t, pl, "page-margins")
            .into_iter()
            .map(|mg| PageMargins {
                left: num(t, Some(mg), "left-margin").unwrap_or(0.0),
                right: num(t, Some(mg), "right-margin").unwrap_or(0.0),
                top: num(t, Some(mg), "top-margin").unwrap_or(0.0),
                bottom: num(t, Some(mg), "bottom-margin").unwrap_or(0.0),
                odd_even: attr(t, mg, "type").and_then(OddEven::known),
            })
            .collect();
        if !margins.is_empty() {
            page.margins = Some(margins);
        }
        d.page_layout = Some(page);
    }
    if let Some(lf) = child(t, el, "lyric-font") {
        d.lyric_font = Some(read_font(t, lf));
    }
    d
}

impl Reader {
    fn t(&self) -> &Tree {
        self.s.tree()
    }

    fn bind(&mut self, el: NodeId, slot: Slot) -> Oid {
        let o = self.s.fresh_oid();
        self.s.bind(o, el, slot);
        o
    }

    fn read_credits(&mut self, root: NodeId) -> Vec<Credit> {
        let mut out = vec![];
        for c in children(self.t(), root, "credit") {
            let t = self.t();
            let words = children(t, c, "credit-words");
            if words.is_empty() {
                continue;
            }
            let texts: Vec<String> = words.iter().map(|&w| t.text_content(w)).collect();
            let first = words[0];
            let font = split_face_name(FontSpec {
                family: attr_truthy(t, first, "font-family").map(str::to_owned),
                weight: attr_truthy(t, first, "font-weight").map(str::to_owned),
                ..FontSpec::default()
            });
            let mut cr = Credit {
                oid: Oid::NONE,
                kind: child_text_truthy(t, c, "credit-type"),
                text: texts.join("\n"),
                words: texts.iter().any(|w| w.contains('\n')).then(|| texts.clone()),
                x: attr_truthy(t, first, "default-x").map(js::number),
                y: attr_truthy(t, first, "default-y").map(js::number),
                font_size: attr_truthy(t, first, "font-size").map(js::number),
                font_family: font.family.filter(|s| !s.is_empty()),
                font_weight: font.weight.filter(|s| !s.is_empty()),
                justify: read_align(t, first, "justify"),
                halign: read_align(t, first, "halign"),
                valign: attr(t, first, "valign").and_then(VAlign::known),
                page: attr_truthy(t, c, "page").map(js::number),
            };
            cr.oid = self.bind(c, Slot::Default);
            out.push(cr);
        }
        out
    }
}

struct PartName {
    name: Option<String>,
    abbrev: Option<String>,
    size: Option<f64>,
}

fn read_part_groups(t: &Tree, part_list: NodeId) -> (Vec<PartGroup>, HashMap<String, PartName>) {
    let mut groups: Vec<PartGroup> = vec![];
    let mut names: HashMap<String, PartName> = HashMap::new();
    // 开着的组：在 `groups` 里的下标
    let mut open: Vec<usize> = vec![];
    for c in elems(t, part_list) {
        match t.tag(c) {
            "part-group" => {
                let kind = attr(t, c, "type");
                let number = attr(t, c, "number").unwrap_or("1").to_owned();
                if kind == Some("start") {
                    let g = PartGroup {
                        number,
                        symbol: child_text_truthy(t, c, "group-symbol").map(|s| GroupSymbol::parse(&s)),
                        name: child_text_truthy(t, c, "group-name"),
                        abbrev: child_text_truthy(t, c, "group-abbreviation"),
                        group_barline: (child_text(t, c, "group-barline").as_deref() == Some("yes")).then_some(true),
                        parts: vec![],
                    };
                    groups.push(g);
                    open.push(groups.len() - 1);
                } else if let Some(i) = open.iter().position(|&g| groups[g].number == number) {
                    open.remove(i);
                }
            }
            "score-part" => {
                let id = attr(t, c, "id").unwrap_or("").to_owned();
                let sz = js::number(child(t, c, "part-name").and_then(|p| attr(t, p, "font-size")).map_or("", |s| s));
                // `Number(undefined)` 是 NaN、`Number(null)` 是 0：两者都不 > 0
                names.insert(id.clone(), PartName { name: child_text(t, c, "part-name"), abbrev: child_text(t, c, "part-abbreviation"), size: (sz > 0.0).then_some(sz) });
                for &g in &open {
                    groups[g].parts.push(id.clone());
                }
            }
            _ => {}
        }
    }
    (groups, names)
}

// ───────────────────────── 音符 ─────────────────────────

fn read_pitch(t: &Tree, el: NodeId) -> Pitch {
    Pitch {
        step: Step::parse(&child_text(t, el, "step").unwrap_or_else(|| "C".into())),
        alter: num(t, Some(el), "alter").unwrap_or(0.0),
        octave: num(t, Some(el), "octave").unwrap_or(4.0),
    }
}

/// `<root-alter location="left">`：升降号印在字母前面
fn alter_left(t: &Tree, parent: NodeId, tag: &str) -> bool {
    child(t, parent, tag).and_then(|c| attr(t, c, "location")) == Some("left")
}

/// `/^(\d+(?:\s*[-–—~]\s*\d+)?[.．、]|\d+(?=\s))\s*(\S.*)$/su`：首字前的印刷段号 → (段号, 正文)
fn split_verse_label(text: &str) -> Option<(String, String)> {
    let digits = |s: &str| s.bytes().take_while(u8::is_ascii_digit).count();
    let d = digits(text);
    if d == 0 {
        return None;
    }
    let rest_of = |label_end: usize| -> Option<(String, String)> {
        let r = text[label_end..].trim_start_matches(js::is_space);
        (!r.is_empty()).then(|| (text[..label_end].to_owned(), r.to_owned()))
    };
    let is_dot = |c: char| matches!(c, '.' | '．' | '、');
    // 第一种：数字（可带区间）+ 句点
    let mut alt1: Option<usize> = None;
    {
        let after = &text[d..];
        let s1 = after.trim_start_matches(js::is_space);
        let mut cs = s1.chars();
        if let Some(dash) = cs.next().filter(|c| matches!(c, '-' | '–' | '—' | '~')) {
            let s2 = s1[dash.len_utf8()..].trim_start_matches(js::is_space);
            let d2 = digits(s2);
            if d2 > 0 {
                if let Some(c) = s2[d2..].chars().next().filter(|&c| is_dot(c)) {
                    alt1 = Some(text.len() - s2.len() + d2 + c.len_utf8());
                }
            }
        }
        if alt1.is_none() {
            if let Some(c) = after.chars().next().filter(|&c| is_dot(c)) {
                alt1 = Some(d + c.len_utf8());
            }
        }
    }
    if let Some(end) = alt1 {
        if let Some(r) = rest_of(end) {
            return Some(r);
        }
    }
    // 第二种：数字后面紧跟空白
    if text[d..].chars().next().is_some_and(js::is_space) {
        return rest_of(d);
    }
    None
}

/// `<lyric number>` 里最后一串数字（`/\d+(?=\D*$)/`），`|| 1`
fn lyric_number(n: &str) -> f64 {
    let b = n.as_bytes();
    let Some(end) = b.iter().rposition(u8::is_ascii_digit) else { return 1.0 };
    let start = b[..end].iter().rposition(|c| !c.is_ascii_digit()).map_or(0, |i| i + 1);
    let v = js::number(&n[start..=end]);
    if v == 0.0 || v.is_nan() {
        1.0
    } else {
        v
    }
}

impl Reader {
    fn read_harmony(&mut self, el: NodeId) -> Harmony {
        let t = self.t();
        let root_el = child(t, el, "root");
        let kind_el = child(t, el, "kind");
        let mut h = Harmony {
            oid: Oid::NONE,
            root: HarmonyStep {
                step: root_el.map_or_else(|| "C".into(), |r| child_text(t, r, "root-step").unwrap_or_else(|| "C".into())),
                alter: root_el.map_or(0.0, |r| num(t, Some(r), "root-alter").unwrap_or(0.0)),
                alter_left: None,
            },
            kind: kind_el.map_or_else(String::new, |k| t.text_content(k)),
            kind_text: None,
            bass: None,
            degrees: None,
            text: None,
            font_size: None,
            offset: None,
            use_symbols: None,
            parentheses_degrees: None,
            staff: None,
            onset: None,
        };
        if let Some(r) = root_el {
            if alter_left(t, r, "root-alter") {
                h.root.alter_left = Some(true);
            }
            let fs = attr_num(t, Some(child(t, r, "root-step").unwrap_or(r)), "font-size");
            if let Some(fs) = fs.filter(|&f| f > 0.0) {
                h.font_size = Some(fs);
            }
        }
        // `text=""` 是「不印 kind 后缀」，与缺省不同，空串也要留
        h.kind_text = kind_el.and_then(|k| attr(t, k, "text")).map(str::to_owned);
        if let Some(b) = child(t, el, "bass") {
            h.bass = Some(HarmonyStep {
                step: child_text(t, b, "bass-step").unwrap_or_else(|| "C".into()),
                alter: num(t, Some(b), "bass-alter").unwrap_or(0.0),
                alter_left: alter_left(t, b, "bass-alter").then_some(true),
            });
        }
        let degs = children(t, el, "degree");
        if !degs.is_empty() {
            h.degrees = Some(
                degs.into_iter()
                    .map(|d| HarmonyDegree {
                        value: num(t, Some(d), "degree-value").unwrap_or(0.0),
                        alter: num(t, Some(d), "degree-alter").unwrap_or(0.0),
                        kind: DegreeType::parse(&child_text(t, d, "degree-type").unwrap_or_else(|| "add".into())),
                    })
                    .collect(),
            );
        }
        h.offset = num(t, Some(el), "offset");
        if kind_el.and_then(|k| attr(t, k, "use-symbols")) == Some("yes") {
            h.use_symbols = Some(true);
        }
        if kind_el.and_then(|k| attr(t, k, "parentheses-degrees")) == Some("yes") {
            h.parentheses_degrees = Some(true);
        }
        h.staff = attr_num(t, Some(el), "staff");
        h.oid = self.bind(el, Slot::Default);
        h
    }

    fn read_lyrics(&mut self, note_el: NodeId) -> Vec<Lyric> {
        let mut out: Vec<Lyric> = vec![];
        for l in children(self.t(), note_el, "lyric") {
            let t = self.t();
            let raw: String = children(t, l, "text").into_iter().map(|x| t.text_content(x)).collect();
            // 软连字符是词内分音节，不当字
            let shy = raw.ends_with('\u{ad}');
            let text = raw.replace('\u{ad}', "");
            let n = attr(t, l, "number");
            let syl0 = child_text(t, l, "syllabic");
            let lm = match syl0.as_deref() {
                None | Some("") | Some("single") | Some("begin") => split_verse_label(&text),
                _ => None,
            };
            let syl = child_text_truthy(t, l, "syllabic");
            let ext = child(t, l, "extend");
            let mut lr = Lyric {
                oid: Oid::NONE,
                number: match n {
                    Some(n) if !n.is_empty() => lyric_number(n),
                    _ => 1.0,
                },
                number_to: None,
                text: lm.as_ref().map_or_else(|| text.clone(), |(_, r)| r.clone()),
                syllabic: syl.as_deref().map(Syllabic::parse),
                extend: ext.map(|_| true),
                extend_type: ext.and_then(|e| attr(t, e, "type")).and_then(SpanType::known),
                number_text: n.filter(|n| n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit())).map(str::to_owned),
                name: attr(t, l, "name").map(str::to_owned),
                placement: attr(t, l, "placement").and_then(Placement::known),
                elision: child_text(t, l, "elision"),
                refrain: None,
                trailing_punctuation: None,
                verse_label: lm.map(|(lab, _)| lab),
                leading_punctuation: None,
                line_index: None,
                source: None,
            };
            if shy {
                lr.syllabic = Some(if matches!(syl.as_deref(), Some("middle" | "end")) { Syllabic::Middle } else { Syllabic::Begin });
            }
            lr.oid = self.bind(l, Slot::Default);
            // 同一个音上段号重复：按出现次序往后排
            while out.iter().any(|x| x.number == lr.number) {
                lr.number += 1.0;
            }
            out.push(lr);
        }
        out
    }

    /// `<notations>` 读进 `into`（和弦音的记号并进同一个 `Chord`）。
    fn read_notations(&mut self, note_el: NodeId, id: ElementId, into: Option<Notations>, note_index: f64) -> Option<Notations> {
        let t = self.s.tree();
        let Some(nots) = child(t, note_el, "notations") else { return into };
        let mut n = into.unwrap_or_default();
        if let Some(art) = child(t, nots, "articulations") {
            let list: Vec<String> = t.children(art).map(|c| t.tag(c).to_owned()).collect();
            if !list.is_empty() {
                n.articulations = Some(list);
            }
            for c in t.children(art) {
                if let Some(pl) = attr(t, c, "placement").and_then(Placement::known) {
                    n.artic_placement.get_or_insert_with(Default::default).insert(t.tag(c).to_owned(), pl);
                }
            }
        }
        if let Some(orn) = child(t, nots, "ornaments") {
            // 单音震音单收道数；双音震音（start/stop）照旧按元素名记
            let trem = t.children(orn).find(|&c| t.tag(c) == "tremolo" && attr(t, c, "type").unwrap_or("single") == "single");
            if let Some(tr) = trem {
                let text = t.text_content(tr);
                let s = js::trim(&text);
                let v = if s.is_empty() { 3.0 } else { js::number(s) };
                let v = if v == 0.0 || v.is_nan() { 3.0 } else { v };
                n.tremolo = Some(js::min(4.0, js::max(1.0, v)));
                if let (Some(tx), Some(ty)) = (attr(t, tr, "default-x"), attr(t, tr, "default-y")) {
                    let (x, y) = (js::number(tx), js::number(ty));
                    if x.is_finite() && y.is_finite() {
                        n.tremolo_pos = Some(XY { x, y });
                    }
                }
            }
            let list: Vec<String> = t.children(orn).filter(|&c| Some(c) != trem).map(|c| t.tag(c).to_owned()).collect();
            if !list.is_empty() {
                n.ornaments = Some(list);
            }
        }
        if let Some(tech) = child(t, nots, "technical") {
            let list: Vec<String> = t.children(tech).map(|c| t.tag(c).to_owned()).collect();
            if !list.is_empty() {
                n.technical = Some(list);
            }
        }
        if let Some(fer) = child(t, nots, "fermata") {
            n.fermata = Some(true);
            if attr(t, fer, "type") == Some("inverted") {
                n.fermata_inverted = Some(true);
            }
        }
        if child(t, nots, "arpeggiate").is_some() {
            n.arpeggiate = Some(true);
        }
        if child(t, nots, "glissando").is_some() {
            n.glissando = Some(true);
        }
        // 跨元素记号：slur / tied / tuplet，按 number 配对
        for (tag, kind) in [("slur", MarkType::Slur), ("tied", MarkType::Tied), ("tuplet", MarkType::Tuplet)] {
            for s in children(t, nots, tag) {
                let ty = attr(t, s, "type");
                let number = js::number(attr(t, s, "number").unwrap_or("1"));
                if let Some(start) = match ty {
                    Some("start") => Some(true),
                    Some("stop") => Some(false),
                    _ => None,
                } {
                    self.marks.push(start, kind.clone(), number, id, s, note_index);
                }
            }
        }
        (n != Notations::default()).then_some(n)
    }
}

// ───────────────────────── 跨元素记号的配对池 ─────────────────────────

#[derive(Clone)]
struct Open {
    id: ElementId,
    el: NodeId,
    note: f64,
    staff: f64,
    voice: f64,
}

#[derive(Clone)]
struct Pending {
    t: f64,
    staff: f64,
    voice: f64,
    start: bool,
    kind: MarkType,
    number: f64,
    id: ElementId,
    el: NodeId,
    note: f64,
}

/// MusicXML 用 `number` 属性配对，同类可重叠；**按声部配**（换声部时 `next_part`）。
/// slur / tuplet 同号未收口又起一个：后起点顶掉前起点（slur 只顶同谱表同声部的）；slur 止端先配同谱表同声部，再同谱表，再别的谱表。
/// tied 仍按栈配（和弦里几个音同时起），几条同时收时按音高配。
#[derive(Default)]
struct MarkSink {
    marks: Vec<Mark>,
    open: HashMap<String, Vec<Open>>,
    /// 当前音的时刻（小节内 divisions）、谱表、声部
    at: f64,
    staff: f64,
    voice: f64,
    pending: Vec<Pending>,
}

impl MarkSink {
    fn next_part(&mut self) {
        self.open.clear();
    }

    fn push(&mut self, start: bool, kind: MarkType, number: f64, id: ElementId, el: NodeId, note: f64) {
        self.pending.push(Pending { t: self.at, staff: self.staff, voice: self.voice, start, kind, number, id, el, note });
    }
}

/// `<tied>`/`<slur>` 所在那个 `<note>` 的音高键（step + alter + octave，缺的子元素 TS 拼成 "null"）
fn pitch_key_of(t: &Tree, notation: NodeId) -> Option<String> {
    let mut note = Some(notation);
    while let Some(n) = note {
        if t.tag(n) == "note" {
            break;
        }
        note = t.parent(n);
    }
    let p = child(t, note?, "pitch")?;
    let s = |tag: &str| child_text(t, p, tag).unwrap_or_else(|| "null".into());
    Some(format!("{}{}{}", s("step"), child_text(t, p, "alter").unwrap_or_default(), s("octave")))
}

impl Reader {
    /// 小节读完按**时刻**配 slur（同一时刻保持文档序）；tied / tuplet 按文档序
    fn flush_marks(&mut self) {
        let pending = std::mem::take(&mut self.marks.pending);
        let mut evs: Vec<Pending> = pending.iter().filter(|e| e.kind != MarkType::Slur).cloned().collect();
        let mut slurs: Vec<(usize, Pending)> = pending.iter().cloned().enumerate().filter(|(_, e)| e.kind == MarkType::Slur).collect();
        js::sort_by(&mut slurs, |a, b| {
            let d = a.1.t - b.1.t;
            if d != 0.0 && !d.is_nan() {
                d
            } else {
                a.0 as f64 - b.0 as f64
            }
        });
        evs.extend(slurs.into_iter().map(|(_, e)| e));
        for e in evs {
            if e.start {
                self.open_mark(&e);
            } else {
                self.close_mark(&e);
            }
        }
    }

    fn open_mark(&mut self, e: &Pending) {
        let k = format!("{}#{}", e.kind.as_str(), js::num_to_string(e.number));
        let mut list = match e.kind {
            MarkType::Tied => self.marks.open.get(&k).cloned().unwrap_or_default(),
            MarkType::Slur => self.marks.open.get(&k).cloned().unwrap_or_default().into_iter().filter(|o| o.staff != e.staff || o.voice != e.voice).collect(),
            _ => vec![],
        };
        list.push(Open { id: e.id, el: e.el, note: e.note, staff: e.staff, voice: e.voice });
        self.marks.open.insert(k, list);
    }

    fn close_mark(&mut self, e: &Pending) {
        let k = format!("{}#{}", e.kind.as_str(), js::num_to_string(e.number));
        let t = self.s.tree();
        let started = {
            let Some(list) = self.marks.open.get_mut(&k) else { return };
            let mut at: isize = list.len() as isize - 1;
            if e.kind == MarkType::Tied && list.len() > 1 {
                if let Some(pitch) = pitch_key_of(t, e.el) {
                    if let Some(i) = list.iter().rposition(|o| pitch_key_of(t, o.el).as_deref() == Some(pitch.as_str())) {
                        at = i as isize;
                    }
                }
            }
            if e.kind == MarkType::Slur {
                let pick = |ok: &dyn Fn(&Open) -> bool| list.iter().rposition(ok);
                if let Some(i) = pick(&|o| o.staff == e.staff && o.voice == e.voice).or_else(|| pick(&|o| o.staff == e.staff)) {
                    at = i as isize;
                }
            }
            if at < 0 {
                return;
            }
            list.remove(at as usize)
        };
        let se = started.el;
        let mut m = Mark {
            oid: Oid::NONE,
            kind: e.kind.clone(),
            number: Some(e.number),
            start: started.id,
            end: e.id,
            start_note: (started.note != 0.0 && !started.note.is_nan()).then_some(started.note),
            end_note: (e.note != 0.0 && !e.note.is_nan()).then_some(e.note),
            level: None,
            placement: attr(t, se, "placement").and_then(Placement::known),
            orientation: attr(t, se, "orientation").and_then(Orientation::known),
            bracket: match attr(t, se, "bracket") {
                Some("yes") => Some(true),
                Some("no") => Some(false),
                _ => None,
            },
            dashed: None,
            wedge_type: None,
            continuation_levels: None,
            start_lead: None,
            end_trail: None,
            collapsed: None,
            lead_in_previous_line: None,
            lead_back: None,
            tuplet_actual: None,
            tuplet_normal: None,
            continues_to_next: None,
            continues_from_previous: None,
            source: None,
            open_source: None,
            close_source: None,
        };
        if e.kind == MarkType::Tuplet {
            m.tuplet_actual = num(t, child(t, se, "tuplet-actual"), "tuplet-number");
            m.tuplet_normal = num(t, child(t, se, "tuplet-normal"), "tuplet-number");
        }
        m.oid = self.s.fresh_oid();
        self.s.bind(m.oid, se, Slot::Start);
        self.s.bind(m.oid, e.el, Slot::Stop);
        self.marks.marks.push(m);
    }
}

// ───────────────────────── 小节 ─────────────────────────

impl Reader {
    fn read_barline(&mut self, el: NodeId, element_count: usize) -> Barline {
        let t = self.t();
        let location = match attr(t, el, "location") {
            Some("left") => BarLocation::Left,
            Some("middle") => BarLocation::Middle,
            _ => BarLocation::Right,
        };
        let mut b = Barline {
            oid: Oid::NONE,
            location,
            style: child_text_truthy(t, el, "bar-style").and_then(|s| BarStyle::known(&s)),
            repeat: None,
            repeat_times: None,
            ending: None,
            jump: None,
            also_forward: None,
            no_width: None,
            ornaments: None,
            time: None,
            annotation: None,
            before: None,
            line_break_after: None,
            after_elements: None,
            source: None,
        };
        if let Some(rep) = child(t, el, "repeat") {
            b.repeat = attr(t, rep, "direction").and_then(RepeatDir::known);
            b.repeat_times = attr_truthy(t, rep, "times").map(js::number);
        }
        if let Some(end) = child(t, el, "ending") {
            let kind = match attr(t, end, "type") {
                Some("start") => EndingType::Start,
                Some("discontinue") => EndingType::Discontinue,
                _ => EndingType::Stop,
            };
            let text = t.text_content(end);
            let text = js::trim(&text);
            b.ending = Some(Ending {
                numbers: attr(t, end, "number").unwrap_or("").split(',').map(|s| js::number(js::trim(s))).filter(|n| n.is_finite() && *n > 0.0).collect(),
                text: (!text.is_empty()).then(|| text.to_owned()),
                kind,
                level: None,
                continuation_levels: None,
                lead_in_previous_line: None,
                start_offset: None,
                end_offset: None,
                pair: None,
                dangling_lead: None,
                captionless: None,
                collapsed: None,
                print_object: (attr(t, end, "print-object") == Some("no")).then_some(false),
            });
        }
        if b.location == BarLocation::Middle {
            b.after_elements = Some(element_count as f64);
        }
        b.oid = self.bind(el, Slot::Default);
        b
    }

    fn read_direction(&mut self, el: NodeId) -> Option<Direction> {
        let t = self.t();
        let items: Vec<NodeId> = children(t, el, "direction-type").into_iter().flat_map(|dt| t.children(dt).collect::<Vec<_>>()).collect();
        let first = *items.first()?;
        let p = read_direction_part(t, first);
        let mut d = Direction {
            oid: Oid::NONE,
            offset: num(t, Some(el), "offset"),
            after_elements: None,
            kind: p.kind,
            text: p.text,
            tempo: p.tempo,
            span_type: p.span_type,
            wedge_type: p.wedge_type,
            shift: p.shift,
            placement: attr(t, el, "placement").and_then(Placement::known),
            sound: None,
            voice: None,
            staff: num(t, Some(el), "staff"),
            line: p.line,
            more: None,
            onset: None,
            source: None,
        };
        let sound = child(t, el, "sound");
        if items.len() > 1 {
            let mut more = vec![];
            for &it in &items[1..] {
                let mut part = read_direction_part(self.t(), it);
                part.oid = self.bind(it, Slot::Default);
                more.push(part);
            }
            d.more = Some(more);
        }
        d.oid = self.bind(el, Slot::Default);
        self.s.bind(d.oid, first, Slot::Part);
        if let Some(sound) = sound {
            d.sound = read_sound(self.t(), sound);
        }
        Some(d)
    }
}

/// `<direction-type>` 下的一个子元素（words / dynamics / wedge…）。
fn read_direction_part(t: &Tree, first: NodeId) -> DirectionPart {
    let tag = t.tag(first);
    let mut d = DirectionPart { oid: Oid::NONE, kind: tag.to_owned(), text: None, tempo: None, span_type: None, wedge_type: None, line: None, shift: None };
    let span = |ty: Option<&str>| match ty {
        Some("stop") => SpanType::Stop,
        Some("continue") => SpanType::Continue,
        _ => SpanType::Start,
    };
    match tag {
        "dynamics" => d.text = Some(t.first_element_child(first).map_or_else(String::new, |c| t.tag(c).to_owned())),
        "words" | "rehearsal" => d.text = Some(t.text_content(first)),
        "wedge" => {
            let ty = attr(t, first, "type");
            d.wedge_type = ty.and_then(WedgeType::known);
            d.span_type = Some(span(ty));
        }
        "metronome" => {
            let bu = child_text_truthy(t, first, "beat-unit");
            let pm = num(t, Some(first), "per-minute");
            let mut tempo = Metronome { beat_unit: bu.map(|b| NoteType::parse(&b)), ..Metronome::default() };
            if !t.get_elements_by_tag_name(first, "beat-unit-dot").is_empty() {
                tempo.beat_unit_dot = Some(true);
            }
            tempo.per_minute = pm;
            if let Some(pm_text) = child_text(t, first, "per-minute") {
                if pm.is_none_or(|pm| js::num_to_string(pm) != js::trim(&pm_text)) {
                    tempo.per_minute_text = Some(pm_text);
                }
            }
            if attr(t, first, "parentheses") == Some("yes") {
                tempo.parentheses = Some(true);
            }
            d.tempo = Some(tempo);
        }
        "pedal" | "octave-shift" => {
            let ty = attr(t, first, "type");
            d.span_type = Some(span(ty));
            if tag == "octave-shift" {
                if let Some(dir) = ty.and_then(ShiftDir::known) {
                    let size = js::number(attr(t, first, "size").unwrap_or(""));
                    // `Number(null)` 是 0：`|| 8`
                    let size = if attr(t, first, "size").is_none() || size == 0.0 || size.is_nan() { 8.0 } else { size };
                    d.shift = Some(OctaveShift { dir, size });
                }
            }
            if tag == "pedal" {
                if let Some(l) = attr(t, first, "line") {
                    d.line = Some(l == "yes");
                }
            }
        }
        _ => {}
    }
    d
}

/// `<sound>` 的播放语义
fn read_sound(t: &Tree, sound: NodeId) -> Option<Sound> {
    let s = Sound {
        dacapo: (attr(t, sound, "dacapo") == Some("yes")).then_some(true),
        dalsegno: attr_truthy(t, sound, "dalsegno").map(str::to_owned),
        fine: attr_truthy(t, sound, "fine").map(|_| true),
        segno: attr_truthy(t, sound, "segno").map(str::to_owned),
        coda: attr_truthy(t, sound, "coda").map(str::to_owned),
        tocoda: attr_truthy(t, sound, "tocoda").map(str::to_owned),
        tempo: attr_truthy(t, sound, "tempo").map(js::number),
    };
    (s != Sound::default()).then_some(s)
}

/// 后来的 `<attributes>` 并进前面的（有的字段覆盖）
fn merge_attrs(base: &mut MeasureAttrs, a: MeasureAttrs) {
    macro_rules! over {
        ($($f:ident),*) => { $( if a.$f.is_some() { base.$f = a.$f; } )* };
    }
    over!(divisions, key, time, clefs, staves, transpose, multi_rest);
}

fn source_id_of(attr: Option<&str>) -> Option<ElementId> {
    let rest = attr?.strip_prefix(SOURCE_ID_PREFIX)?;
    if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // TS `Number(m[1])`：超出 u32 的大数这里截不下（语料里没有）
    rest.parse::<u64>().ok().map(|v| v as ElementId)
}

impl Reader {
    /// 一个 `<measure>` → `Measure`。`<backup>`/`<forward>` 按声部分轨，解析后消失。
    fn read_measure(&mut self, el: NodeId) -> Measure {
        let t = self.t();
        let mut m = Measure {
            oid: Oid::NONE,
            number: attr(t, el, "number").unwrap_or("").to_owned(),
            implicit: (attr(t, el, "implicit") == Some("yes")).then_some(true),
            duration: None,
            attrs: None,
            later_attrs: None,
            elements: vec![],
            barlines: None,
            directions: None,
            print: None,
            trailing: None,
            source: None,
        };
        m.oid = self.bind(el, Slot::Default);
        let mut first_attrs: Option<NodeId> = None;
        let mut pending_harmonies: Vec<Harmony> = vec![];
        let mut pending_onsets: Vec<f64> = vec![];
        // 上一个和弦在 m.elements 里的下标（`<chord>` 音并进它）
        let mut last: Option<usize> = None;
        let mut cursor = 0.0f64;
        let mut end = 0.0f64;
        let mut reach = 0.0f64;
        let mut max_end = 0.0f64;
        // 上一个元素之后读到的 `<direction>`（m.directions 里的下标）
        let mut dirs_since_last: Vec<usize> = vec![];
        let mut last_start = 0.0f64;
        let mut prev_end = 0.0f64;

        for c in elems(self.t(), el) {
            let tag = self.t().tag(c).to_owned();
            match tag.as_str() {
                "backup" => cursor = js::max(0.0, cursor - num(self.t(), Some(c), "duration").unwrap_or(0.0)),
                "forward" => {
                    cursor += num(self.t(), Some(c), "duration").unwrap_or(0.0);
                    reach = js::max(reach, cursor);
                }
                "attributes" => {
                    let t = self.t();
                    let ms = child(t, c, "measure-style");
                    let mr = num(t, Some(ms.unwrap_or(c)), "multiple-rest");
                    let clefs = children(t, c, "clef");
                    let a = MeasureAttrs {
                        oid: Oid::NONE,
                        divisions: num(t, Some(c), "divisions"),
                        key: child(t, c, "key").map(|k| read_key(t, k)),
                        time: child(t, c, "time").map(|k| read_time(t, k)),
                        clefs: (!clefs.is_empty()).then(|| clefs.into_iter().map(|k| read_clef(t, k)).collect()),
                        staves: num(t, Some(c), "staves"),
                        transpose: child(t, c, "transpose").map(|k| read_transpose(t, k)),
                        multi_rest: if ms.is_some() { mr.filter(|&v| v > 1.0) } else { None },
                    };
                    if m.elements.is_empty() {
                        merge_attrs(m.attrs.get_or_insert_with(MeasureAttrs::default), a);
                        match first_attrs {
                            None => first_attrs = Some(c),
                            Some(fa) => {
                                let kids: Vec<NodeId> = self.t().children(c).collect();
                                let tm = self.s.tree_mut();
                                for k in kids {
                                    let cl = tm.clone_node(k);
                                    tm.append_child(fa, cl);
                                }
                            }
                        }
                    } else {
                        let mut a = a;
                        a.oid = self.bind(c, Slot::Default);
                        let later = LaterAttrs { after_elements: m.elements.len() as f64, onset: (cursor != end).then_some(cursor), attrs: a };
                        m.later_attrs.get_or_insert_with(Vec::new).push(later);
                    }
                }
                "harmony" => {
                    let h = self.read_harmony(c);
                    pending_harmonies.push(h);
                    pending_onsets.push(cursor);
                }
                "print" => {
                    let t = self.t();
                    let ns = attr(t, c, "new-system") == Some("yes");
                    let np = attr(t, c, "new-page") == Some("yes");
                    match &mut m.print {
                        Some(p) => {
                            if ns {
                                p.new_system = Some(true);
                            }
                            if np {
                                p.new_page = Some(true);
                            }
                        }
                        None => {
                            let mut p = Print { new_system: ns.then_some(true), new_page: np.then_some(true), ..Print::default() };
                            p.oid = self.bind(c, Slot::Default);
                            m.print = Some(p);
                        }
                    }
                }
                "direction" => {
                    if let Some(mut d) = self.read_direction(c) {
                        if !m.elements.is_empty() {
                            d.after_elements = Some(m.elements.len() as f64);
                        }
                        if cursor != end {
                            d.onset = Some(cursor);
                        }
                        let ds = m.directions.get_or_insert_with(Vec::new);
                        ds.push(d);
                        dirs_since_last.push(ds.len() - 1);
                    }
                }
                "sound" => {
                    // 小节级 `<sound>`（不在 `<direction>` 里）
                    let mut d = Direction {
                        oid: Oid::NONE,
                        offset: None,
                        after_elements: None,
                        kind: "sound".into(),
                        text: None,
                        tempo: None,
                        span_type: None,
                        wedge_type: None,
                        shift: None,
                        placement: None,
                        sound: None,
                        voice: None,
                        staff: None,
                        line: None,
                        more: None,
                        onset: None,
                        source: None,
                    };
                    d.oid = self.bind(c, Slot::Default);
                    d.sound = read_sound(self.t(), c);
                    if !m.elements.is_empty() {
                        d.after_elements = Some(m.elements.len() as f64);
                    }
                    m.directions.get_or_insert_with(Vec::new).push(d);
                }
                "barline" => {
                    let b = self.read_barline(c, m.elements.len());
                    m.barlines.get_or_insert_with(Vec::new).push(b);
                }
                "note" => {
                    let t = self.t();
                    let is_chord_note = child(t, c, "chord").is_some();
                    let pitch_el = child(t, c, "pitch");
                    let mut note = Note { pitch: pitch_el.map(|p| read_pitch(t, p)), ..Note::default() };
                    let unp_el = if pitch_el.is_some() { None } else { child(t, c, "unpitched") };
                    if let Some(u) = unp_el {
                        let ds = child_text(t, u, "display-step");
                        let dov = child_text(t, u, "display-octave");
                        note.unpitched = Some(Unpitched {
                            step: ds.filter(|d| d.len() == 1 && (b'A'..=b'G').contains(&d.as_bytes()[0])).map(|d| Step::parse(&d)),
                            octave: dov.filter(|d| !d.is_empty() && !js::number(d).is_nan()).map(|d| js::number(&d)),
                        });
                    }
                    let acc_el = child(t, c, "accidental");
                    if let Some(a) = acc_el.map(|a| t.text_content(a)).filter(|a| !a.is_empty()) {
                        note.accidental = Some(Accidental::parse(&a));
                    }
                    if acc_el.and_then(|a| attr(t, a, "parentheses")) == Some("yes") {
                        note.accidental_parentheses = Some(true);
                    }
                    note.notehead = child_text_truthy(t, c, "notehead");
                    let ties = children(t, c, "tie");
                    if !ties.is_empty() {
                        let mut tie = Tie::default();
                        for &x in &ties {
                            match attr(t, x, "type") {
                                Some("start") => tie.start = Some(true),
                                Some("stop") => tie.stop = Some(true),
                                _ => {}
                            }
                        }
                        note.tie = Some(tie);
                    }
                    let note_size = child(t, c, "type")
                        .and_then(|ty| attr(t, ty, "size"))
                        .map(str::to_owned)
                        .or_else(|| child(t, c, "cue").map(|_| "cue".to_owned()));
                    if let Some(sz) = note_size.filter(|s| !s.is_empty()) {
                        note.type_size = Some(sz);
                    }
                    let has_pitch_or_unp = pitch_el.is_some() || unp_el.is_some();
                    if has_pitch_or_unp {
                        note.oid = self.bind(c, Slot::Default);
                    }
                    if let (true, Some(li)) = (is_chord_note, last) {
                        let len = m.elements.len();
                        for &di in &dirs_since_last {
                            let d = &mut m.directions.as_mut().unwrap()[di];
                            if d.onset.is_some() || d.after_elements != Some(len as f64) {
                                continue;
                            }
                            if len > 1 {
                                d.after_elements = Some((len - 1) as f64);
                            } else {
                                d.after_elements = None;
                            }
                            if last_start != prev_end {
                                d.onset = Some(last_start);
                            }
                        }
                        dirs_since_last.clear();
                        let more = self.read_lyrics(c);
                        let Element::Chord(lc) = &mut m.elements[li] else { unreachable!() };
                        lc.notes.push(note);
                        // 和弦里后面那几个音上的歌词并到和弦上（同段号已有的不收）
                        let more: Vec<Lyric> = more.into_iter().filter(|l| !lc.lyrics.iter().flatten().any(|k| k.number == l.number)).collect();
                        if !more.is_empty() {
                            lc.lyrics.get_or_insert_with(Vec::new).extend(more);
                        }
                        self.marks.at = last_start;
                        self.marks.staff = lc.staff;
                        self.marks.voice = lc.voice;
                        let (id, into, idx) = (lc.id, lc.notations.take(), (lc.notes.len() - 1) as f64);
                        let nots = self.read_notations(c, id, into, idx);
                        let Element::Chord(lc) = &mut m.elements[li] else { unreachable!() };
                        lc.notations = nots;
                        continue;
                    }
                    let new_id = self.ids.next();
                    let t = self.t();
                    let type_el = child(t, c, "type");
                    let mut ch = Chord {
                        oid: Oid::NONE,
                        id: new_id,
                        src_id: source_id_of(attr(t, c, "id")),
                        // 节奏音符也留着这个音
                        notes: if has_pitch_or_unp { vec![note] } else { vec![] },
                        rest: None,
                        grace: None,
                        duration: Duration {
                            divisions: num(t, Some(c), "duration").unwrap_or(0.0),
                            kind: child_text_truthy(t, c, "type").map(|s| NoteType::parse(&s)),
                            dots: children(t, c, "dot").len() as f64,
                            time_mod: child(t, c, "time-modification").map(|tm| TimeMod {
                                actual: num(t, Some(tm), "actual-notes").unwrap_or(3.0),
                                normal: num(t, Some(tm), "normal-notes").unwrap_or(2.0),
                                normal_type: None,
                            }),
                        },
                        sustains: None,
                        voice: num(t, Some(c), "voice").unwrap_or(1.0),
                        staff: num(t, Some(c), "staff").unwrap_or(1.0),
                        beams: None,
                        beam_group: None,
                        harmony: None,
                        later_harmonies: None,
                        lyrics: None,
                        notations: None,
                        section_word: None,
                        rhythm: (pitch_el.is_none() && child(t, c, "unpitched").is_some()).then_some(true),
                        print_object: (attr(t, c, "print-object") == Some("no")).then_some(false),
                        placeholder: None,
                        lyric_anchor: None,
                        ornaments: None,
                        continued: None,
                        before: None,
                        line_break_after: None,
                        cue: child(t, c, "cue").map(|_| true),
                        type_size: type_el.and_then(|ty| attr_truthy(t, ty, "size")).map(str::to_owned),
                        onset: None,
                        attached_sources: None,
                        source: None,
                    };
                    if let Some(r) = child(t, c, "rest") {
                        let mut rest = RestInfo { measure: (attr(t, r, "measure") == Some("yes")).then_some(true), ..RestInfo::default() };
                        if let Some(ds) = child_text_truthy(t, r, "display-step") {
                            rest.display_pitch = Some(Pitch { step: Step::parse(&ds), alter: 0.0, octave: num(t, Some(r), "display-octave").unwrap_or(4.0) });
                        }
                        ch.rest = Some(rest);
                    }
                    if let Some(g) = child(t, c, "grace") {
                        ch.grace = Some(GraceInfo { slash: (attr(t, g, "slash") == Some("yes")).then_some(true), ..GraceInfo::default() });
                    }
                    let beams = children(t, c, "beam");
                    if !beams.is_empty() {
                        ch.beams = Some(beams.into_iter().map(|b| BeamVal::parse(&t.text_content(b))).collect());
                    }
                    ch.oid = self.bind(c, Slot::Default);
                    let lyr = self.read_lyrics(c);
                    if !lyr.is_empty() {
                        ch.lyrics = Some(lyr);
                    }
                    self.marks.at = cursor;
                    self.marks.staff = ch.staff;
                    self.marks.voice = ch.voice;
                    ch.notations = self.read_notations(c, ch.id, None, 0.0);
                    if cursor != end {
                        ch.onset = Some(cursor);
                    }
                    if !pending_harmonies.is_empty() {
                        for (h, &o) in pending_harmonies.iter_mut().zip(&pending_onsets) {
                            if o != cursor {
                                h.onset = Some(o);
                            }
                        }
                        let mut hs = std::mem::take(&mut pending_harmonies).into_iter();
                        ch.harmony = hs.next();
                        let later: Vec<Harmony> = hs.collect();
                        if !later.is_empty() {
                            ch.later_harmonies = Some(later);
                        }
                        pending_onsets.clear();
                    }
                    prev_end = end;
                    last_start = cursor;
                    let d = ch.duration.divisions;
                    m.elements.push(Element::Chord(ch));
                    last = Some(m.elements.len() - 1);
                    dirs_since_last.clear();
                    cursor += d;
                    end = cursor;
                    reach = js::max(reach, cursor);
                    max_end = js::max(max_end, cursor);
                }
                _ => {}
            }
        }
        // 小节末尾还欠着的和弦：给下一小节的预置和弦，挂在 `y` 占位符上
        for (harmony, o) in std::mem::take(&mut pending_harmonies).into_iter().zip(pending_onsets) {
            let id = self.ids.next();
            m.elements.push(Element::Space(Space {
                id,
                spacer: Spacer::Y,
                duration: None,
                beams: None,
                voice: 1.0,
                staff: 1.0,
                harmony: Some(harmony),
                lyrics: None,
                notations: None,
                onset: (o != end).then_some(o),
                attached_sources: None,
                source: None,
            }));
        }
        if reach > max_end {
            m.duration = Some(reach);
        }
        if let (Some(a), Some(fa)) = (m.attrs.as_mut(), first_attrs) {
            a.oid = self.s.fresh_oid();
            self.s.bind(a.oid, fa, Slot::Default);
        }
        self.flush_marks();
        m
    }

    fn read(&mut self, root: NodeId) -> ScoreDoc {
        let mut doc = empty_doc(SourceFormat::MusicXml);
        let mut song = empty_song();
        song.oid = self.bind(root, Slot::Default);

        let t = self.t();
        if let Some(work) = child(t, root, "work") {
            song.work.number = child_text_truthy(t, work, "work-number");
            song.work.title = child_text_truthy(t, work, "work-title");
        }
        if let Some(mt) = child_text_truthy(t, root, "movement-title") {
            if song.work.title.is_none() {
                song.work.title = Some(mt.clone());
            }
            song.work.movement_title = Some(mt);
        }

        if let Some(ident) = child(t, root, "identification") {
            let creators = children(t, ident, "creator")
                .into_iter()
                .map(|c| Creator { kind: attr(t, c, "type").unwrap_or("composer").to_owned(), text: t.text_content(c) })
                .collect();
            let enc = child(t, ident, "encoding");
            let sw: Vec<String> = enc.map(|e| children(t, e, "software").into_iter().map(|s| t.text_content(s)).collect()).unwrap_or_default();
            song.identification = Some(Identification { creators, rights: child_text_truthy(t, ident, "rights"), software: (!sw.is_empty()).then_some(sw) });
            // `<miscellaneous-field name>` → 扩展 meta（同名多个 = 多项）
            if let Some(misc) = child(t, ident, "miscellaneous") {
                let fields: Vec<(String, String)> = children(t, misc, "miscellaneous-field")
                    .into_iter()
                    .filter_map(|f| attr_truthy(t, f, "name").map(|n| (n.to_owned(), t.text_content(f))))
                    .collect();
                for (n, v) in fields {
                    add_meta(&mut song, &n, &v);
                }
            }
        }

        let credits = self.read_credits(root);
        if !credits.is_empty() {
            song.credits = Some(credits);
        }
        let t = self.t();
        if let Some(d) = child(t, root, "defaults") {
            song.defaults = Some(read_defaults(t, d));
        }

        let part_list = child(t, root, "part-list");
        let (groups, names) = part_list.map(|pl| read_part_groups(t, pl)).unwrap_or_default();
        if !groups.is_empty() {
            song.part_groups = Some(groups);
        }
        let mut score_parts: HashMap<String, NodeId> = HashMap::new();
        for sp in part_list.map(|pl| children(t, pl, "score-part")).unwrap_or_default() {
            score_parts.insert(attr(t, sp, "id").unwrap_or("").to_owned(), sp);
        }

        for p in children(self.t(), root, "part") {
            let id = attr(self.t(), p, "id").unwrap_or("").to_owned();
            let mut part = Part {
                oid: Oid::NONE,
                id: id.clone(),
                name: None,
                abbrev: None,
                name_size: None,
                staff_count: None,
                staff_of: None,
                measures: vec![],
                end_break: None,
                break_sources: None,
                muse_attrs: None,
            };
            part.oid = self.bind(p, Slot::Default);
            if let Some(&sp) = score_parts.get(&id) {
                self.s.bind(part.oid, sp, Slot::ScorePart);
            }
            self.marks.next_part();
            if let Some(nm) = names.get(&id) {
                part.name = nm.name.clone().filter(|s| !s.is_empty());
                part.abbrev = nm.abbrev.clone().filter(|s| !s.is_empty());
                part.name_size = nm.size;
            }
            let mut staves: Option<f64> = None;
            for m_el in children(self.t(), p, "measure") {
                let m = self.read_measure(m_el);
                if let Some(s) = m.attrs.as_ref().and_then(|a| a.staves) {
                    staves = Some(s);
                }
                part.measures.push(m);
            }
            part.staff_count = staves;
            song.parts.push(part);
        }

        // 全曲共用的调号/拍号：取第一个声部第一次出现的那个
        if let Some(first) = song.parts.first().and_then(|p| p.measures.iter().find(|m| m.attrs.as_ref().is_some_and(|a| a.key.is_some() || a.time.is_some()))) {
            let a = first.attrs.as_ref().unwrap();
            song.key = a.key.clone();
            song.time = a.time.clone();
        }
        // 简谱度数与面上的临时记号：整个声部读完再按小节内延续规则算
        let key = song.key.clone().unwrap_or_else(c_major);
        for part in &mut song.parts {
            assign_degrees(part, &key);
        }
        song.marks = std::mem::take(&mut self.marks.marks);
        doc.songs.push(song);
        doc
    }
}

impl Default for PartName {
    fn default() -> Self {
        PartName { name: None, abbrev: None, size: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verse_labels() {
        let f = |s: &str| split_verse_label(s);
        assert_eq!(f("1.道"), Some(("1.".into(), "道".into())));
        assert_eq!(f("1-3.这"), Some(("1-3.".into(), "这".into())));
        assert_eq!(f("1 – 3、这"), Some(("1 – 3、".into(), "这".into())));
        assert_eq!(f("1 Be"), Some(("1".into(), "Be".into())));
        assert_eq!(f("1 - 2"), Some(("1".into(), "- 2".into())));
        assert_eq!(f("1. "), None);
        assert_eq!(f("12"), None);
        assert_eq!(f("道"), None);
        assert_eq!(lyric_number("part1verse2"), 2.0);
        assert_eq!(lyric_number("chorus"), 1.0);
        assert_eq!(lyric_number("0"), 1.0);
    }
}
