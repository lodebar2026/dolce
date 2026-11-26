//! 页眉：标题、副标题、词曲、调号拍号、TL/TR、XL/XR（照 `compose/header.ts`）。位置由 `place/header.rs` 定，这里只照它画。

use dolce_engrave::keysig::{key_name_of, KeyLabel, KeyLabelStyle};
use dolce_engrave::prims::text_item;
use dolce_engrave::spacing::{AccidentalSide, EQ_PAD_EM};
use dolce_engrave::timesig::{TimeSigGlyph, TimeSigStyle};
use dolce_engrave::Env;
use dolce_model::base::geom::Rect;
use dolce_scene::Node;
use dolce_style::jianpustyle::HeaderFace;
use dolce_text::Font;
use dolce_model::view::ast::{Metadata, Meter};

use super::ctx::{font, text, Ctx};
use crate::grid::{barline_span, JianpuGrid};
use crate::place::header::{time_sig_rule, Anchor, HeaderMeasurer, HeaderTextRole, KeyLineInk, PlacedHeader, PlacedHeaderLine};
use crate::util::{max, min};

/// 页眉各角色的字（`scale` 是窄纸缩排倍率，只作用于标题、副标题、经文、署名）
pub fn header_role_font(m: &JianpuGrid, role: HeaderTextRole, scale: f64) -> Font {
    let hs = &m.style.header;
    let fam = &m.style.font.text.family;
    let fam_of = |f: &HeaderFace| f.family.clone().unwrap_or_else(|| fam.clone());
    match role {
        HeaderTextRole::Title => font(&fam_of(&hs.title), hs.title.size * scale, true),
        HeaderTextRole::Subtitle => font(&fam_of(&hs.subtitle), hs.subtitle.size * scale, false),
        HeaderTextRole::Scripture => font(&fam_of(&hs.scripture), hs.scripture.size * scale, false),
        HeaderTextRole::Credit => font(&fam_of(&hs.credit), hs.credit.size * scale, false),
        HeaderTextRole::Top => font(fam, m.style.size.header, false),
        HeaderTextRole::Index => font(fam, hs.title.size * 0.62, false),
        HeaderTextRole::Tempo => font(fam, m.style.size.key_meter * 0.85, false),
        HeaderTextRole::SlideTitle => slide_font(m, &hs.title, hs.title.size),
        HeaderTextRole::SlideSubtitle => slide_font(m, &hs.subtitle, hs.subtitle.size),
        HeaderTextRole::SlideScripture => slide_font(m, &hs.scripture, hs.scripture.size),
        HeaderTextRole::SlideCredit => slide_font(m, &hs.credit, hs.credit.size),
        HeaderTextRole::SlideFooter => font(&m.style.font.lyric.family, m.style.size.lyric * 0.8, false),
    }
}

/// 投影档标题页的字：设置里给了族 / 粗体就用，否则歌词字、不加粗
fn slide_font(m: &JianpuGrid, face: &HeaderFace, size: f64) -> Font {
    font(face.family.as_deref().unwrap_or(&m.style.font.lyric.family), size, face.bold.unwrap_or(false))
}

/// 页眉量具（`headerMeasurer`）
pub struct HeaderInk<'a> {
    pub m: &'a JianpuGrid,
    pub env: &'a Env<'a>,
}

impl HeaderMeasurer for HeaderInk<'_> {
    fn header_text(&self, s: &str, role: HeaderTextRole) -> (f64, Rect) {
        let f = header_role_font(self.m, role, 1.0);
        (f.measure_text(self.env.mc, s), f.char_bound(self.env.mc, s))
    }
    fn key_line(&self, meter: Option<&Meter>) -> KeyLineInk {
        let m = self.m;
        let mc = self.env.mc;
        let head_font = font(&m.style.font.text.family, m.style.size.key_meter, false);
        let f = head_font.char_bound(mc, "F");
        let eq = head_font.char_bound(mc, "=");
        let eq_mid = (eq.top + eq.bottom) / 2.0;
        let (mut top, mut bottom) = (f.top, f.bottom);
        if let Some(meter) = meter {
            let meter_y = eq_mid + time_sig_rule(m) / 2.0;
            let r = TimeSigGlyph::new(
                meter.numerator,
                meter.denominator,
                &TimeSigStyle {
                    height: m.style.vertical.barline_height,
                    center_y: 0.0,
                    rule_width: time_sig_rule(m),
                    color: 0.0,
                    font: head_font.clone(),
                    digit_ratio: None,
                    rule_length_ratio: None,
                },
                self.env,
            )
            .box_();
            top = min(top, meter_y + r.top);
            bottom = max(bottom, meter_y + r.bottom);
        }
        KeyLineInk { top, bottom, eq_mid }
    }
}

/// 投影档的标题页、页脚各行（居中按页宽）。`tag`：文字标 `hdr`
pub fn paint_slide_lines(c: &Ctx, root: &mut Node, lines: &[PlacedHeaderLine], tag: bool) {
    for l in lines {
        let a = match l.anchor {
            Anchor::Left => 0.0,
            Anchor::Center => c.page_width / 2.0,
            Anchor::Right => c.page_width,
        };
        let mut t = text_item(&l.text, header_role_font(c.m, l.role, 1.0), c.ink, a + l.dx, l.baseline, false, c.env);
        if tag {
            t.add_class("hdr");
        }
        root.push(t);
    }
}

pub fn paint_header(c: &Ctx, root: &mut Node, song_index: usize, system_left: f64) {
    let Some(head) = c.heads.get(song_index).or_else(|| c.heads.first()) else { return };
    let before = root.k.len();
    paint_header_items(c, root, head, song_index, system_left);
    for it in &mut root.k[before..] {
        if !it.has_class("hdr-keysig") && !it.has_class("hdr-time") {
            it.add_class("hdr");
        }
    }
}

fn empty_metadata() -> Metadata {
    Metadata {
        version: None,
        titles: vec![],
        authors: vec![],
        scripture: None,
        mode: None,
        tonic: None,
        remarks: vec![],
        meters: vec![],
        time_note: None,
        tempos: vec![],
        tempo_mark: None,
        index_left: None,
        index_right: None,
        top_left: vec![],
        top_right: vec![],
        bottom_left: vec![],
        bottom_center: vec![],
        bottom_right: vec![],
        font_sizes: vec![],
        margins: vec![],
        options: vec![],
    }
}

fn paint_header_items(c: &Ctx, root: &mut Node, head: &PlacedHeader, song_index: usize, system_left: f64) {
    let m = c.m;
    let env = c.env;
    let fallback;
    let meta = match c.doc.songs.get(song_index).or_else(|| c.doc.songs.first()) {
        Some(s) => &s.metadata,
        None => {
            fallback = empty_metadata();
            &fallback
        }
    };
    for l in &head.lines {
        let a = match l.anchor {
            Anchor::Left => system_left,
            Anchor::Center => c.page_width / 2.0 - c.page_shift_x,
            Anchor::Right => c.page_width - m.page.margin.right - c.page_shift_x,
        };
        root.push(text(&l.text, a + l.dx, l.baseline, header_role_font(m, l.role, head.scale), c.ink, env));
    }

    let key_y = head.key_baseline;
    let head_font = font(&m.style.font.text.family, m.style.size.key_meter, false);
    let tonic = meta.tonic.as_deref().unwrap_or("1");
    let mut x = system_left;
    let key_name = meta.mode.as_deref().filter(|s| !s.is_empty()).and_then(key_name_of);
    if let Some(name) = key_name {
        let k = KeyLabel::new(
            tonic,
            &name,
            &KeyLabelStyle {
                font: head_font.clone(),
                music: Font { family: "Bravura".into(), size: head_font.size, bold: false, italic: false },
                color: c.ink,
                prefix: None,
                side: AccidentalSide::parse(m.style.look.accidental_side.as_deref()),
                classes: vec!["hdr-keysig".into()],
                eq_pad: None,
            },
            env,
        );
        let (ink_right, name_ink_left, eq_ink_right) = (k.ink_right, k.name_ink_left, k.eq_ink_right);
        for mut it in k.items {
            it.shift(x, key_y);
            root.push(it);
        }
        x += ink_right + (name_ink_left - eq_ink_right);
    } else if let Some(mode) = meta.mode.as_deref().filter(|s| !s.is_empty()) {
        let pad = head_font.size * EQ_PAD_EM;
        for (i, part) in [tonic, "=", mode].iter().enumerate() {
            if i > 0 {
                x += pad;
            }
            let mut t = text(part, x, key_y, head_font.clone(), c.ink, env);
            t.add_class("hdr-keysig");
            root.push(t);
            x += head_font.measure_text(env.mc, part);
        }
        x += pad;
    }
    let meter_from = root.k.len();
    for meter in &meta.meters {
        x += paint_meter(c, root, x, key_y + head.meter_dy, meter.numerator, meter.denominator, &head_font) + 14.0;
    }
    for it in &mut root.k[meter_from..] {
        it.add_class("hdr-time");
    }
}

/// 分数式拍号。返回占用的宽度
pub fn paint_meter(c: &Ctx, root: &mut Node, x: f64, y: f64, numerator: f64, denominator: f64, f: &Font) -> f64 {
    let (top, bottom) = barline_span(c.m);
    let r = TimeSigGlyph::new(
        numerator,
        denominator,
        &TimeSigStyle {
            height: c.m.style.vertical.barline_height,
            center_y: (top + bottom) / 2.0,
            rule_width: time_sig_rule(c.m),
            color: c.ink,
            font: f.clone(),
            digit_ratio: None,
            rule_length_ratio: None,
        },
        c.env,
    );
    let w = r.width;
    for mut item in r.items {
        item.shift(x, y);
        root.push(item);
    }
    w
}
