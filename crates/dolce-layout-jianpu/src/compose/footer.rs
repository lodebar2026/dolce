//! 页脚（BL/BC/BR 模板）的排版（照 `compose/footer.ts`）。

use dolce_base::js::trim;
use dolce_engrave::Env;
use dolce_scene::Node;
use dolce_style::ss::Region;
use dolce_style::template::{layout_region, FieldValue, FontMetricsLike, Placed, RegionEnv};
use dolce_view::ast::Metadata;

use super::ctx::{font, text};
use crate::grid::JianpuGrid;
use crate::model::PlacedScore;
use crate::util::max;
use crate::view::LDoc;

/// 页脚要的上下文（TS 从 `OriginalCtx` 里取的那几样）
pub struct FootCtx<'a> {
    pub m: &'a JianpuGrid,
    pub env: &'a Env<'a>,
    pub doc: &'a LDoc,
    pub foot: Option<&'a Region>,
    pub page_width: f64,
    pub page_height: f64,
    pub ink: f64,
}

pub struct Footer {
    pub page: usize,
    pub bottom: f64,
    pub items: Vec<Node>,
}

/// 页脚区域：分页时排在本曲末页的页面底部，连续长图跟在本曲最低一行之下
pub fn layout_footers(c: &FootCtx, placed: &PlacedScore, shift_x: f64) -> Vec<Footer> {
    let Some(region) = c.foot else { return vec![] };
    let mut out = vec![];
    for (i, pg) in placed.pages.iter().enumerate() {
        let songs: Vec<usize> = if pg.headers.is_some() {
            let mut s: Vec<usize> = vec![];
            for g in &pg.groups {
                if !s.contains(&g.song) {
                    s.push(g.song);
                }
            }
            s
        } else {
            vec![pg.song]
        };
        for song in songs {
            if pg.headers.is_none() {
                if let Some(next) = placed.pages.get(i + 1) {
                    if next.song == pg.song {
                        continue;
                    }
                }
            }
            let mut low: f64 = 0.0;
            for g in &pg.groups {
                if pg.headers.is_none() || g.song == song {
                    for v in &g.voices {
                        low = max(low, v.y);
                        for &ly in &v.lyric_y {
                            low = max(low, ly);
                        }
                    }
                }
            }
            if pg.headers.is_none() && !c.m.page.long_image {
                let span = footer_at(c, region, song, 0.0, shift_x).map_or(0.0, |f| f.0);
                low = max(low, c.page_height - c.m.page.margin.bottom - span);
            }
            if let Some((bottom, items)) = footer_at(c, region, song, low, shift_x) {
                out.push(Footer { page: i, bottom, items });
            }
        }
    }
    out
}

/// 本曲页脚从最低一行往下占多高（没有页脚为 0）
pub fn footer_span(c: &FootCtx, song: usize) -> f64 {
    let Some(region) = c.foot else { return 0.0 };
    footer_at(c, region, song, 0.0, 0.0).map_or(0.0, |f| f.0)
}

struct FootEnv<'a> {
    m: &'a JianpuGrid,
    env: &'a Env<'a>,
    meta: &'a Metadata,
    content: (f64, f64),
    dy: f64,
}

impl RegionEnv for FootEnv<'_> {
    fn field(&self, path: &str) -> Option<Vec<FieldValue>> {
        let arr = |v: &Vec<String>| Some(v.iter().map(FieldValue::text).collect());
        match path {
            "pageText.bottomLeft" => arr(&self.meta.bottom_left),
            "pageText.bottomCenter" => arr(&self.meta.bottom_center),
            "pageText.bottomRight" => arr(&self.meta.bottom_right),
            _ => None,
        }
    }
    fn page_no(&self) -> f64 {
        1.0
    }
    fn content(&self) -> (f64, f64) {
        self.content
    }
    fn dy(&self) -> Option<f64> {
        Some(self.dy)
    }
    fn size_of(&self, role: &str) -> f64 {
        footer_size(self.m, role)
    }
    fn measure(&self, _role: &str, t: &str, size: f64) -> f64 {
        font(&self.m.style.font.text.family, size, false).measure_text(self.env.mc, t)
    }
    fn font_metrics(&self, _role: &str, size: f64) -> Option<FontMetricsLike> {
        let fm = font(&self.m.style.font.text.family, size, false).metrics(self.env.mc);
        Some(FontMetricsLike { ascent: -fm.ascent, height: size })
    }
}

/// 一首的页脚：区域顶在 `low` 之下一个歌词字高处。没有页脚文字为 None；有则 (底, 图元)
fn footer_at(c: &FootCtx, region: &Region, song: usize, low: f64, shift_x: f64) -> Option<(f64, Vec<Node>)> {
    let m = c.m;
    let meta = &c.doc.songs.get(song)?.metadata;
    let any = meta.bottom_left.iter().chain(&meta.bottom_center).chain(&meta.bottom_right).any(|t| {
        let t = trim(t);
        !t.is_empty() && t != "-"
    });
    if !any {
        return None;
    }
    let fe = FootEnv {
        m,
        env: c.env,
        meta,
        content: (m.page.margin.left, c.page_width - m.page.margin.right - shift_x),
        dy: low + m.style.size.lyric,
    };
    let res = layout_region(Some(region), &fe).unwrap_or_else(|e| panic!("页脚模板排不出：{}", e.message));
    let mut items = vec![];
    for p in &res.items {
        let Placed::Text(p) = p else { continue };
        let f = font(&m.style.font.text.family, p.size, false);
        let w = f.measure_text(c.env.mc, &p.text);
        let x = match p.align.as_str() {
            "center" => p.x - w / 2.0,
            "right" => p.x - w,
            _ => p.x,
        };
        items.push(text(&p.text, x, p.y, f, c.ink, c.env));
    }
    Some((low + m.style.size.lyric + res.span, items))
}

/// 模板角色 → 字号：尺子的 `size` 与页眉四项（角色名与字段同名）
fn footer_size(m: &JianpuGrid, role: &str) -> f64 {
    let st = &m.style;
    match role {
        "note" => st.size.note,
        "lyric" => st.size.lyric,
        "chord" => st.size.chord,
        "keyMeter" => st.size.key_meter,
        "verseNum" => st.size.verse_num,
        "ending" => st.size.ending,
        "sectionWord" => st.size.section_word,
        "words" => st.size.words,
        "header" => st.size.header,
        "grace" => st.size.grace,
        "cue" => st.size.cue,
        "title" => st.header.title.size,
        "subtitle" => st.header.subtitle.size,
        "credit" => st.header.credit.size,
        "scripture" => st.header.scripture.size,
        _ => panic!(
            "原样文档布局的模板认不出角色 {role}（可用：note lyric chord keyMeter verseNum ending sectionWord words header grace cue title subtitle credit scripture）"
        ),
    }
}
