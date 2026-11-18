//! MusicXML **表层**（同 `src/model/xmlsurface.ts`）：`ScoreDoc` 之外的旁表，装 MusicXML 独有、别的格式与排版器都不读的东西。
//!
//! 读入时每个模型对象按身份（[`Oid`]）**绑**到原节点；五线谱引擎要的坐标、符干、对齐、字体经下面的查询函数从原节点现读；
//! 写出端 `toxml` 按「写出端认得的属性/子节点」之外，把原节点其余的属性与子节点通用回填。
//! 没有身份的对象（文本来源、克隆出来的）一律照常。表层是会话里的文档附件，不进 `ScoreDoc`。

use crate::doc::*;
use dolce_base::js;
use dolce_xml::{NodeId, Tree, XmlDoc};
use std::collections::HashMap;

/// 绑定槽位：缺省 `""`；`Part` 另有 `"score-part"`；`Mark` 有 `"start"` / `"stop"`；`Direction` 另有 `"part"`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum Slot {
    Default,
    ScorePart,
    Start,
    Stop,
    Part,
}

impl Slot {
    pub fn name(self) -> &'static str {
        match self {
            Slot::Default => "",
            Slot::ScorePart => "score-part",
            Slot::Start => "start",
            Slot::Stop => "stop",
            Slot::Part => "part",
        }
    }
    pub const ALL: [Slot; 5] = [Slot::Default, Slot::ScorePart, Slot::Start, Slot::Stop, Slot::Part];
}

/// 一份 MusicXML 的表层：原树与「对象 → 槽位 → 原节点」旁表。
/// 可序列化（桌面版网页侧 wasm 里的表层整份快照给原生排版，`dolce-wasm::modelSurfaceSnapshot`）；旁表写成键值对数组。
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Surface {
    pub xml: XmlDoc,
    #[serde(with = "table_pairs")]
    table: HashMap<(Oid, Slot), NodeId>,
    next_oid: u32,
}

mod table_pairs {
    use super::{NodeId, Oid, Slot};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::collections::HashMap;
    pub fn serialize<S: Serializer>(m: &HashMap<(Oid, Slot), NodeId>, s: S) -> Result<S::Ok, S::Error> {
        m.iter().collect::<Vec<_>>().serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<HashMap<(Oid, Slot), NodeId>, D::Error> {
        Ok(Vec::<((Oid, Slot), NodeId)>::deserialize(d)?.into_iter().collect())
    }
}

impl Surface {
    pub fn new(xml: XmlDoc) -> Surface {
        Surface { xml, table: HashMap::new(), next_oid: 1 }
    }

    pub fn tree(&self) -> &Tree {
        &self.xml.tree
    }

    pub fn tree_mut(&mut self) -> &mut Tree {
        &mut self.xml.tree
    }

    /// 发一个新身份
    pub fn fresh_oid(&mut self) -> Oid {
        let o = Oid(self.next_oid);
        self.next_oid += 1;
        o
    }

    /// 绑定（同一对象同一槽位只认第一次）
    pub fn bind(&mut self, oid: Oid, el: NodeId, slot: Slot) {
        if oid.is_none() {
            return;
        }
        self.table.entry((oid, slot)).or_insert(el);
    }

    pub fn of(&self, oid: Oid, slot: Slot) -> Option<NodeId> {
        if oid.is_none() {
            return None;
        }
        self.table.get(&(oid, slot)).copied()
    }

    /// 缺省槽位
    pub fn of0(&self, oid: Oid) -> Option<NodeId> {
        self.of(oid, Slot::Default)
    }

    /// 全部绑定（对拍用）
    pub fn bindings(&self) -> impl Iterator<Item = (Oid, Slot, NodeId)> + '_ {
        self.table.iter().map(|(&(o, s), &n)| (o, s, n))
    }
}

// ───────────────────────── 树读取的小工具（同 `score/xmldom.ts`）─────────────────────────

/// 直接子元素中第一个 `tag`
pub fn child(t: &Tree, el: NodeId, tag: &str) -> Option<NodeId> {
    t.children(el).find(|&c| t.tag(c) == tag)
}

/// 直接子元素中全部 `tag`，按文档序
pub fn children(t: &Tree, el: NodeId, tag: &str) -> Vec<NodeId> {
    t.children(el).filter(|&c| t.tag(c) == tag).collect()
}

/// 子元素 `tag` 的文本，无该子元素则 None
pub fn child_text(t: &Tree, el: NodeId, tag: &str) -> Option<String> {
    child(t, el, tag).map(|c| t.text_content(c))
}

/// 有限数才算（`Number(x)` 后 `Number.isFinite`）
pub fn finite(v: f64) -> Option<f64> {
    v.is_finite().then_some(v)
}

/// 属性的数值（空串、读不成有限数的不算）
pub fn attr_num(t: &Tree, el: Option<NodeId>, name: &str) -> Option<f64> {
    let v = t.get_attribute(el?, name)?;
    if v.is_empty() {
        return None;
    }
    finite(js::number(v))
}

/// 子元素文字的数值
pub fn child_num(t: &Tree, el: Option<NodeId>, tag: &str) -> Option<f64> {
    finite(js::number(&child_text(t, el?, tag)?))
}

// ───────────────────────── 查询层 ─────────────────────────

/// 版面坐标（tenths，口径同 MusicXML 的 `default-x/-y`、`relative-x/-y`）。
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Position {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_y: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SystemLayout {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_distance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_system_distance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_margin: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_margin: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StaffLayout {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staff: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staff_distance: Option<f64>,
}

/// `<print>` 里的版式（系统与谱表间距）。
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrintLayout {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_layout: Option<SystemLayout>,
    /// `<staff-layout number>`：本系统各谱表离上一谱表的距离
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staff_layouts: Option<Vec<StaffLayout>>,
}

impl Surface {
    /// 版面坐标元素：`DirectionPart` 取它那条 direction-type 子元素，其余取绑定的节点本身。
    fn pos_host(&self, oid: Oid) -> Option<NodeId> {
        self.of(oid, Slot::Part).or_else(|| self.of0(oid))
    }

    fn read_pos(&self, el: Option<NodeId>) -> Option<Position> {
        let el = el?;
        let t = self.tree();
        let p = Position {
            default_x: attr_num(t, Some(el), "default-x"),
            default_y: attr_num(t, Some(el), "default-y"),
            relative_x: attr_num(t, Some(el), "relative-x"),
            relative_y: attr_num(t, Some(el), "relative-y"),
        };
        (p != Position::default()).then_some(p)
    }

    /// 原文的版面坐标：`Note`、无音的 `Chord`、`Lyric`、`Harmony`、`DirectionPart`。
    pub fn xml_pos(&self, oid: Oid) -> Option<Position> {
        self.read_pos(self.pos_host(oid))
    }

    /// `<wedge spread>`
    pub fn wedge_spread(&self, oid: Oid) -> Option<f64> {
        attr_num(self.tree(), self.pos_host(oid), "spread")
    }

    /// `<measure width>`（tenths）
    pub fn measure_width(&self, m: Oid) -> Option<f64> {
        attr_num(self.tree(), self.of0(m), "width")
    }

    /// `<stem>` 的方向与 `default-y`
    pub fn note_stem(&self, note: Oid) -> Option<(String, Option<f64>)> {
        let t = self.tree();
        let st = child(t, self.of0(note)?, "stem")?;
        let text = t.text_content(st);
        let dir = js::trim(&text);
        if !matches!(dir, "up" | "down" | "none" | "double") {
            return None;
        }
        Some((dir.to_owned(), attr_num(t, Some(st), "default-y")))
    }

    /// `justify` / `halign` / `valign`（`Lyric`、`DirectionPart`）
    pub fn xml_align(&self, oid: Oid) -> (Option<HAlign>, Option<HAlign>, Option<String>) {
        let t = self.tree();
        let el = self.pos_host(oid);
        let align = |name: &str| el.and_then(|e| t.get_attribute(e, name)).and_then(HAlign::known);
        let v = el.and_then(|e| t.get_attribute(e, "valign")).filter(|v| !v.is_empty()).map(str::to_owned);
        (align("justify"), align("halign"), v)
    }

    /// 文字的字体属性：`Lyric` 取首个 `<text>`，`DirectionPart` 取它那条子元素。
    pub fn xml_font(&self, oid: Oid) -> Option<FontSpec> {
        let t = self.tree();
        if let Some(own) = self.of(oid, Slot::Part) {
            return read_font_opt(t, Some(own));
        }
        let el = self.of0(oid)?;
        read_font_opt(t, if t.tag(el) == "lyric" { child(t, el, "text") } else { Some(el) })
    }

    /// `<attributes>` 里的 `<staff-details number print-object>`
    pub fn staff_details_of(&self, attrs: Option<Oid>) -> Vec<(Option<f64>, Option<bool>)> {
        let t = self.tree();
        let Some(el) = attrs.and_then(|a| self.of0(a)) else { return vec![] };
        children(t, el, "staff-details")
            .into_iter()
            .map(|sd| {
                let n = t.get_attribute(sd, "number").filter(|n| !n.is_empty()).map(js::number);
                let po = t.get_attribute(sd, "print-object").filter(|p| !p.is_empty()).map(|p| p != "no");
                (n, po)
            })
            .collect()
    }

    /// `<attributes>` 里的 `<part-symbol top-staff bottom-staff>`
    pub fn part_symbol_of(&self, attrs: Option<Oid>) -> Option<(String, Option<f64>, Option<f64>)> {
        let t = self.tree();
        let ps = child(t, self.of0(attrs?)?, "part-symbol")?;
        let text = t.text_content(ps);
        let sym = js::trim(&text);
        let num = |n: &str| t.get_attribute(ps, n).filter(|v| !v.is_empty()).map(js::number);
        Some((if sym.is_empty() { "brace".into() } else { sym.to_owned() }, num("top-staff"), num("bottom-staff")))
    }

    /// 原文 `<print>` 的系统与谱表间距
    pub fn print_layout(&self, p: Option<Oid>) -> Option<PrintLayout> {
        let t = self.tree();
        let el = self.of0(p?)?;
        let mut out = PrintLayout::default();
        if let Some(sl) = child(t, el, "system-layout") {
            let mg = child(t, sl, "system-margins");
            let sys = SystemLayout {
                system_distance: child_num(t, Some(sl), "system-distance"),
                top_system_distance: child_num(t, Some(sl), "top-system-distance"),
                left_margin: child_num(t, mg, "left-margin"),
                right_margin: child_num(t, mg, "right-margin"),
            };
            if sys != SystemLayout::default() {
                out.system_layout = Some(sys);
            }
        }
        let sls: Vec<StaffLayout> = children(t, el, "staff-layout")
            .into_iter()
            .map(|s| StaffLayout { staff: attr_num(t, Some(s), "number"), staff_distance: child_num(t, Some(s), "staff-distance") })
            .collect();
        if !sls.is_empty() {
            out.staff_layouts = Some(sls);
        }
        (out != PrintLayout::default()).then_some(out)
    }

    /// `<defaults>` 里模型不存的两种字体（记号字号、文字缺省字体）：`(music-font, word-font)`
    pub fn defaults_fonts(&self, song: Oid) -> (Option<FontSpec>, Option<FontSpec>) {
        let t = self.tree();
        let Some(def) = self.of0(song).and_then(|r| child(t, r, "defaults")) else { return (None, None) };
        // 元素在就算（属性全缺也要）
        let f = |tag: &str| child(t, def, tag).map(|e| read_font_opt(t, Some(e)).unwrap_or_default());
        (f("music-font"), f("word-font"))
    }

    /// 这份 MusicXML 是否自带版面坐标（任一小节有 width 或任一音符有 default-x）
    pub fn has_embedded_layout(&self, song: &Song) -> bool {
        for part in &song.parts {
            for m in &part.measures {
                if self.measure_width(m.oid).is_some_and(|w| w > 0.0) {
                    return true;
                }
                for el in &m.elements {
                    let Element::Chord(c) = el else { continue };
                    let has = if c.notes.is_empty() {
                        self.xml_pos(c.oid).and_then(|p| p.default_x).is_some()
                    } else {
                        c.notes.iter().any(|n| self.xml_pos(n.oid).and_then(|p| p.default_x).is_some())
                    };
                    if has {
                        return true;
                    }
                }
            }
        }
        false
    }

    // ───────────── 编辑后作废的表层 ─────────────

    /// 音高变了：这个和弦各音原文的符干方向与纵坐标作废
    pub fn forget_note_layout(&mut self, chord: &Chord) {
        let mut nodes: Vec<NodeId> = vec![];
        let mut push = |n: Option<NodeId>| {
            if let Some(n) = n {
                if !nodes.contains(&n) {
                    nodes.push(n);
                }
            }
        };
        push(self.of0(chord.oid));
        for n in &chord.notes {
            push(self.of0(n.oid));
        }
        let t = self.tree_mut();
        for el in nodes {
            t.remove_attribute(el, "default-y");
            for st in children(t, el, "stem") {
                t.remove(st);
            }
        }
    }

    /// 小节内容变了：整曲的版面坐标作废（小节宽与音符横坐标一律去掉）
    pub fn drop_embedded_layout(&mut self, song: &Song) {
        let mut todo: Vec<(NodeId, &str)> = vec![];
        for part in &song.parts {
            for m in &part.measures {
                if let Some(n) = self.of0(m.oid) {
                    todo.push((n, "width"));
                }
                for el in &m.elements {
                    let Element::Chord(c) = el else { continue };
                    if let Some(n) = self.of0(c.oid) {
                        todo.push((n, "default-x"));
                    }
                    for n in &c.notes {
                        if let Some(x) = self.of0(n.oid) {
                            todo.push((x, "default-x"));
                        }
                    }
                }
            }
        }
        let t = self.tree_mut();
        for (n, a) in todo {
            t.remove_attribute(n, a);
        }
    }
}

// ───────────────────────── 字体 ─────────────────────────

/// 中文字面名结尾词 → (字重, 字形)；常规体只去掉不记。
fn face_word(w: &str) -> Option<(Option<&'static str>, Option<&'static str>)> {
    Some(match w {
        "常规体" | "常规" | "标准" => (None, None),
        "细体" => (Some("300"), None),
        "中等" | "中黑" => (Some("500"), None),
        "半粗体" => (Some("600"), None),
        "粗体" => (Some("bold"), None),
        "特粗" => (Some("900"), None),
        "斜体" => (None, Some("italic")),
        _ => return None,
    })
}

/// 把「族名 + 字面名」的全名（`宋体-简 常规体`）拆回族名与字重/字形。逗号分开的每一项各拆；属性里已写的优先；只有一个词不拆。
pub fn split_face_name(f: FontSpec) -> FontSpec {
    let Some(family) = f.family.clone().filter(|s| !s.is_empty()) else { return f };
    let mut out = f;
    let items: Vec<String> = family
        .split(',')
        .map(|item| {
            let name = js::trim(item);
            let sp = name.rfind(' ');
            let face = sp.filter(|&sp| sp > 0).and_then(|sp| face_word(&name[sp + 1..]));
            let Some((w, st)) = face else { return name.to_owned() };
            if let Some(w) = w {
                if out.weight.is_none() {
                    out.weight = Some(w.into());
                }
            }
            if let Some(st) = st {
                if out.style.is_none() {
                    out.style = Some(st.into());
                }
            }
            js::trim(&name[..sp.unwrap()]).to_owned()
        })
        .collect();
    out.family = Some(items.join(","));
    out
}

/// `font-family` / `font-size` / `font-weight` / `font-style` 四个属性（一个都没有时也返回空的）
pub fn read_font(t: &Tree, el: NodeId) -> FontSpec {
    let f = FontSpec {
        family: t.get_attribute(el, "font-family").map(str::to_owned),
        size: attr_num(t, Some(el), "font-size"),
        weight: t.get_attribute(el, "font-weight").map(str::to_owned),
        style: t.get_attribute(el, "font-style").map(str::to_owned),
    };
    split_face_name(f)
}

/// 同上，一个属性都没有时回 None（表层查询口径）
fn read_font_opt(t: &Tree, el: Option<NodeId>) -> Option<FontSpec> {
    let el = el?;
    let raw = FontSpec {
        family: t.get_attribute(el, "font-family").map(str::to_owned),
        size: attr_num(t, Some(el), "font-size"),
        weight: t.get_attribute(el, "font-weight").map(str::to_owned),
        style: t.get_attribute(el, "font-style").map(str::to_owned),
    };
    (raw != FontSpec::default()).then(|| split_face_name(raw))
}

// ───────────────────────── 导出版面 ─────────────────────────

/// 五线谱引擎给导出排出来的版面，经 `ToXmlOptions.layout` 交给写出端（按对象身份）。
#[derive(Clone, Debug, Default)]
pub struct EngravedLayout {
    /// `<defaults><system-layout>`
    pub system_layout: Option<SystemLayout>,
    /// 各小节宽（tenths）
    pub widths: HashMap<Oid, f64>,
    /// 行首小节的 `<print>` 版式
    pub prints: HashMap<Oid, PrintLayout>,
    /// `Note` / 无音 `Chord` / `Lyric` / `Harmony` / `DirectionPart` 的坐标
    pub pos: HashMap<Oid, Position>,
    /// 排出来的符干方向（原文没写的）
    pub stems: HashMap<Oid, String>,
    /// 自动放置的文字记号统一过的字号（pt）
    pub font_size: HashMap<Oid, f64>,
}
