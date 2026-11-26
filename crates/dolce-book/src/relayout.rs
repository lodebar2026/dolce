//! A 路 relayout（原位替换，照 `src/pdflayout/drawlist.ts` 的 `specToDrawPage` / `chordLineRole` / `bodyHeight`）：
//! `PageSpec` + BookStyle → DrawPage。位置照原件，字号取同类型中位数（偏差 25% 以上才留原字号）。

use crate::draw::{DrawItem, DrawPage, DrawPath, DrawRect, DrawText, InkSpan, PageMeta, PageSong};
use crate::spec::{PageSpec, SChar, SRect, TextRun};
use dolce_model::base::js;
use dolce_engrave::style::bookstyle::role_of;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `specToDrawPage` 的选项
pub struct SpecToDrawOptions<'a> {
    /// 该角色样本字（`ink_sample_of`）的「墨迹高 ÷ 字号」
    pub ink_ratio: &'a dyn Fn(&str) -> f64,
    /// 读不出的字形（PageSpec 里是 "�"）按形状键回填
    pub fallback_char: Option<&'a FallbackFn<'a>>,
    /// 次号歌词的分档阈值（墨迹高，pt）；缺省 lyric 墨迹高 − 0.6
    pub lyric2_cut: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UnreadKey {
    pub key: String,
    pub role: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecToDrawResult {
    pub page: DrawPage,
    /// 回填成功数 / 仍然读不出的字数
    pub filled: usize,
    pub unread: usize,
    /// 字号偏离同类型中位数太多、保留了原字号的 run 数
    pub kept_own_size: usize,
    pub unread_keys: Vec<UnreadKey>,
}

/// 按形状键回填一个读不出的字
pub type FallbackFn<'a> = dyn Fn(&str) -> Option<String> + 'a;

const UNREAD: &str ="\u{fffd}";

/// 谱行上方那一带既有和弦也有署名，按非 ASCII 占比分开（`chordLineRole`；与 stats 的同名判据一致）。
/// 照 TS：分子按码点数（`[...t]` 逐码点看首码元），分母是 UTF-16 码元数（`t.length`）。
pub fn chord_line_role(run: &TextRun) -> &'static str {
    let t: String = run.text.chars().filter(|c| !js::is_space(*c)).collect();
    let len = t.encode_utf16().count();
    if len == 0 {
        return "chord";
    }
    let cjk = t.chars().filter(|c| *c as u32 > 0x2e7f).count();
    if cjk as f64 / len as f64 > 0.4 {
        "credit"
    } else {
        "chord"
    }
}

use crate::meta::median;

/// 一行的主字高（剔掉标点与上标）（`bodyHeight`；与 stats 的 `runBodyHeight` 同义）
pub fn body_height(run: &TextRun) -> f64 {
    let hs: Vec<f64> = run.chars.iter().filter(|c| c.h > 0.0).map(|c| c.h).collect();
    if hs.is_empty() {
        return 0.0;
    }
    let m = median(&hs);
    let top: Vec<f64> = hs.iter().copied().filter(|h| *h >= m).collect();
    let v = median(&top);
    if v != 0.0 && !v.is_nan() {
        v
    } else {
        m
    }
}

fn num(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(f64::NAN)
}

struct Acc<'a, 'b> {
    style: &'a Value,
    opt: &'a SpecToDrawOptions<'b>,
    items: Vec<DrawItem>,
    filled: usize,
    unread: usize,
    kept_own_size: usize,
    unread_keys: Vec<UnreadKey>,
}

impl Acc<'_, '_> {
    fn add_run(&mut self, run: Option<&TextRun>, role: &str, song_id: Option<&str>) {
        let Some(run) = run else { return };
        if run.chars.is_empty() {
            return;
        }
        let rs = role_of(self.style, role);
        let body = body_height(run);
        let mut size = num(rs.and_then(|r| r.get("size")));
        let ratio = (self.opt.ink_ratio)(role);
        let ink = size * ratio;
        if body > 0.0 && (body - ink).abs() / ink > 0.25 {
            size = js::number(&js::to_fixed(body / ratio, 2));
            self.kept_own_size += 1;
        }
        let mut text = String::new();
        for c in &run.chars {
            let mut ch = c.ch.clone();
            // 控制字符当作没读出来
            if ch.encode_utf16().next().is_some_and(|u| u < 0x20) {
                ch = UNREAD.into();
            }
            if ch == UNREAD || ch.is_empty() {
                let got = self.opt.fallback_char.and_then(|f| f(&c.key)).filter(|s| !s.is_empty());
                if let Some(g) = got {
                    ch = g;
                    self.filled += 1;
                } else {
                    ch = " ".into(); // 读不出的字留空位
                    self.unread += 1;
                    self.unread_keys.push(UnreadKey { key: c.key.clone(), role: role.into() });
                }
            }
            text.push_str(&ch);
        }
        if js::trim(&text).is_empty() {
            return;
        }
        let x0 = run.chars.iter().map(|c| c.x).fold(f64::INFINITY, js::min);
        let x1 = run.chars.iter().map(|c| c.x + c.w).fold(f64::NEG_INFINITY, js::max);
        let baseline_adjust = num(rs.and_then(|r| r.get("baselineAdjust")));
        let align = rs.and_then(|r| r.get("align")).and_then(Value::as_str).unwrap_or("").to_string();
        self.items.push(DrawItem::Text(DrawText {
            y: run.baseline_y - baseline_adjust * size,
            dy: None,
            text,
            size,
            role: role.into(),
            align,
            xs: run.chars.iter().map(|c| c.x).collect(),
            ws: Some(run.chars.iter().map(|c| c.w).collect()),
            ink_box: Some(InkSpan { x: x0, w: x1 - x0 }),
            color: None,
            song_id: song_id.map(str::to_string),
            cls: None,
            ink_top: None,
        }));
    }
}

/// `specToDrawPage`
pub fn spec_to_draw_page(spec: &PageSpec, style: &Value, opt: &SpecToDrawOptions) -> SpecToDrawResult {
    let mut a = Acc { style, opt, items: vec![], filled: 0, unread: 0, kept_own_size: 0, unread_keys: vec![] };
    let lyric2_cut = opt.lyric2_cut.unwrap_or_else(|| num(role_of(style, "lyric").and_then(|r| r.get("size"))) * (opt.ink_ratio)("lyric") - 0.6);

    // 线框：image / shading 不还原
    for f in &spec.frames {
        if f.kind == "image" || f.kind == "shading" {
            continue;
        }
        a.items.push(DrawItem::Rect(DrawRect { x: f.bx.x, y: f.bx.y, w: f.bx.w, h: f.bx.h, fill: Some(0), stroke: None, sw: None }));
    }
    // 乐谱记号：曲线类照原路径画，直线类按包围盒画
    for m in &spec.marks {
        match m.d.as_deref().filter(|d| !d.is_empty()) {
            Some(d) => a.items.push(DrawItem::Path(DrawPath { d: d.into(), fill: Some(0), stroke: None, sw: None, dash: m.dash.clone(), cls: None })),
            None => a.items.push(DrawItem::Rect(DrawRect {
                x: m.bx.x,
                y: m.bx.y,
                w: js::max(m.bx.w, 0.15),
                h: js::max(m.bx.h, 0.15),
                fill: Some(0),
                stroke: None,
                sw: None,
            })),
        }
    }

    a.add_run(spec.header.as_ref(), "header", None);
    a.add_run(spec.footer.as_ref(), "footer", None);
    let text_role = if spec.kind == "toc" || spec.kind == "index" { "toc" } else { "story" };
    for t in &spec.text_lines {
        a.add_run(Some(t), text_role, None);
    }
    for b in &spec.story_boxes {
        for l in &b.lines {
            a.add_run(Some(l), "story", None);
        }
    }
    for s in &spec.songs {
        let id = s.id.as_deref();
        a.add_run(s.number_run.as_ref(), "songNumber", id);
        a.add_run(s.title_run.as_ref(), "title", id);
        a.add_run(s.key_meter_run.as_ref(), "keyMeter", id);
        a.add_run(s.category_run.as_ref(), "category", id);
        for c in &s.credit_runs {
            a.add_run(Some(c), "credit", id);
        }
        for y in &s.systems {
            for c in &y.chord_lines {
                a.add_run(Some(c), chord_line_role(c), id);
            }
            for l in &y.lyric_lines {
                a.add_run(Some(l), if body_height(l) < lyric2_cut { "lyric2" } else { "lyric" }, id);
            }
            // 音符合成一个 run 交给同一条路
            let hs: Vec<f64> = y.notes.iter().filter(|n| n.h > 0.0).map(|n| n.h).collect();
            let note_med = median(&hs);
            let is_small = |n: &SChar| note_med > 0.0 && n.h < note_med * 0.72;
            let small: Vec<SChar> = y.notes.iter().filter(|n| is_small(n)).cloned().collect();
            let big: Vec<SChar> = y.notes.iter().filter(|n| !is_small(n)).cloned().collect();
            let as_run = |ns: Vec<SChar>| -> Option<TextRun> {
                if ns.is_empty() {
                    return None;
                }
                Some(TextRun {
                    text: ns.iter().map(|n| n.ch.as_str()).collect(),
                    bx: SRect::default(),
                    baseline_y: median(&ns.iter().map(|n| n.y + n.h).collect::<Vec<_>>()),
                    size: median(&ns.iter().map(|n| n.h).collect::<Vec<_>>()),
                    chars: ns,
                })
            };
            a.add_run(as_run(big).as_ref(), "note", id);
            a.add_run(as_run(small).as_ref(), "tuplet", id);
        }
    }

    // 文字按阅读顺序（先上后下、再左到右）
    let (mut texts, others): (Vec<DrawItem>, Vec<DrawItem>) = a.items.into_iter().partition(|i| matches!(i, DrawItem::Text(_)));
    let key = |i: &DrawItem| match i {
        DrawItem::Text(t) => (t.y, t.xs[0]),
        _ => unreachable!(),
    };
    js::sort_by(&mut texts, |p, q| {
        let ((ya, xa), (yb, xb)) = (key(p), key(q));
        let d = ya - yb;
        if d != 0.0 && !d.is_nan() {
            d
        } else {
            xa - xb
        }
    });
    let mut items = others;
    items.extend(texts);
    let meta = PageMeta {
        kind: spec.kind.clone(),
        songs: spec
            .songs
            .iter()
            .map(|s| PageSong {
                id: s.id.clone(),
                title: s.gt_title.clone().or_else(|| s.title_run.as_ref().map(|r| r.text.clone())),
                first: s.starts_here,
                y_from: None,
                y_to: None,
            })
            .collect(),
        page_label: spec.footer.as_ref().map(|f| f.text.clone()),
    };
    let mut page = DrawPage::new(spec.page, spec.size[0], spec.size[1], meta);
    page.items = items;
    SpecToDrawResult { page, filled: a.filled, unread: a.unread, kept_own_size: a.kept_own_size, unread_keys: a.unread_keys }
}
