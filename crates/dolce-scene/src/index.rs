//! 身份表：一页里带身份标签（或页眉类名）的节点，各自对上 SVG 里画出来的那个元素。
//!
//! 编辑器拿到的是 SVG 字符串，不再持有页面树；播放高亮、点选、可视化编辑要从「谁」找到「画出来的元素」，
//! 靠这张表：每项记节点在 [`svg::page_svg`](crate::svg::page_svg) 输出里的**元素先序号**（`<svg>` 之下第一个元素记 0，
//! 挂载后 `svg.getElementsByTagName("*")` 的下标），与最近一个也在表里的祖先（`up`）。SVG 一个字节不改。
//!
//! 哪个节点对哪个元素，照两种方言的出法（同 TS `svgVisitor` 的 `nodeMap` 与 `mixedVisitor` 的 `nodeMap` / `leafMap`）：
//! - 简谱：每个可见节点一个 `<g>`（自身图形在 `<g>` 里面，排在子级之前），节点对它的 `<g>`；
//! - 五线谱 / 混排：组出 `<g>`、叶子自己就是那个元素，只递归组；裸项不出元素。
//!
//! 不可见节点（`invisible` 类）连同子树都不出元素，`el` 记 -1（TS 里查不到 DOM 元素）。
//!
//! 带量字环境（[`page_hits_geom`]）时每项另给几何，编辑器不再回 DOM 量（`getBBox` / `getScreenCTM`）：
//! `m` 本地 → 页面（SVG 用户坐标）的仿射，`bound` 子树各图元排版盒的并（文字取字体盒，同 DOM `getBBox` 的口径），
//! `ink` 子树墨迹的并（文字按字形实量、SMuFL 字按元数据紧盒、线与路径同 `bound`），都是页面坐标。

use dolce_base::geom::{Matrix33, Rect};
use serde::Serialize;

use crate::build::{bound, Env};
use crate::{Dialect, Identity, Node, Page, Role, Shape, TextShape};

/// 简谱页眉项的类名（TS `render.ts::headerPartsOf`）：文字、调号、拍号。
const HEADER_CLASSES: [&str; 3] = ["hdr", "hdr-keysig", "hdr-time"];

/// 表里一项。
#[derive(Clone, Debug, Serialize)]
pub struct Hit {
    /// 元素先序号；没画出来（不可见）为 -1
    pub el: i32,
    /// 最近一个也在表里的祖先在本表的下标；没有为 -1
    pub up: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Identity>,
    /// 简谱页眉项的类名（`hdr` / `hdr-keysig` / `hdr-time`）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hdr: Option<&'static str>,
    /// 文字节点的字（页眉按字对回原文字段）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 附带数值（五线谱系统的谱表带、和弦组的 `cx`）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Map<String, serde_json::Value>>,
    /// 本地坐标 → 页面坐标（`[a c e b d f]`）；没给量字环境时不出
    #[serde(skip_serializing_if = "Option::is_none")]
    pub m: Option<Matrix33>,
    /// 页面坐标的排版盒（子树画出来的各图元 `bound` 的并；什么都没画为 None）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bound: Option<Rect>,
    /// 页面坐标的墨迹盒
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ink: Option<Rect>,
}

/// 两个盒的并（None 是「没有」；零宽或零高的线也算数）
fn join(a: Option<Rect>, b: Option<Rect>) -> Option<Rect> {
    match (a, b) {
        (Some(a), Some(b)) => Some(Rect::new(a.left.min(b.left), a.top.min(b.top), a.right.max(b.right), a.bottom.max(b.bottom))),
        (a, None) => a,
        (None, b) => b,
    }
}

/// 本地盒四角经 `m` 换到页面后的外接盒
fn mapped(m: &Matrix33, r: Rect) -> Rect {
    let pts = [m.map_point(r.left, r.top), m.map_point(r.right, r.top), m.map_point(r.left, r.bottom), m.map_point(r.right, r.bottom)];
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in pts {
        x0 = x0.min(p.x);
        y0 = y0.min(p.y);
        x1 = x1.max(p.x);
        y1 = y1.max(p.y);
    }
    Rect::new(x0, y0, x1, y1)
}

/// 有没有画出东西（宽高都为 0 的不算；一条线零宽或零高照算）
fn drawn(r: Rect) -> Option<Rect> {
    let ok = r.left.is_finite() && r.top.is_finite() && r.right.is_finite() && r.bottom.is_finite();
    (ok && (r.width() > 0.0 || r.height() > 0.0)).then_some(r)
}

/// 文字的墨迹（本地坐标，基线 y = 0）：逐字笔位的逐字量、连排的整串量
fn text_ink(t: &TextShape, env: &Env) -> Option<Rect> {
    if t.text.trim().is_empty() {
        return None;
    }
    let one = |s: &str| drawn(t.font.char_bound(env.mc, s));
    match &t.char_xs {
        Some(xs) => {
            let mut out = None;
            for (ch, x) in t.text.chars().zip(xs) {
                out = join(out, one(ch.encode_utf8(&mut [0; 4])).map(|r| r.offset(*x, 0.0)));
            }
            out
        }
        None => one(&t.text),
    }
}

/// 文字的排版盒（本地坐标）：横向从首字落笔到末字 advance 尽头（同 SVG `<text>` 的 `getBBox`），竖向取字体盒
fn text_bound(t: &TextShape, env: &Env) -> Option<Rect> {
    if t.text.is_empty() {
        return None;
    }
    let (x0, x1) = match &t.char_xs {
        // 逐字笔位不一定递增（起始类标点挤压后往左挪），各字取并
        Some(xs) if !xs.is_empty() => t.text.chars().zip(xs).fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), (c, &x)| {
            (a.min(x), b.max(x + t.font.measure_text(env.mc, c.encode_utf8(&mut [0; 4]))))
        }),
        _ => (0.0, t.measure(env.mc)),
    };
    let fm = t.font.metrics(env.mc);
    drawn(Rect::new(x0, fm.ascent, x1, fm.descent))
}

/// 一个图元自身的（排版盒，墨迹盒），本地坐标。按形直接算（场景节点的 `w` / `h` 只有走过 `update` 的才填）
fn own_boxes(n: &Node, env: &Env) -> (Option<Rect>, Option<Rect>) {
    match &n.shape {
        Shape::Group | Shape::Item => (None, None),
        Shape::Path(p) => {
            let b = match n.role {
                Some(Role::JpOctaveDot { radius, .. }) => Some(Rect::wh(2.0 * radius, 2.0 * radius)),
                _ => drawn(p.tight_bounds(env.mc)),
            };
            (b, b)
        }
        Shape::Line(l) => {
            let b = drawn(Rect::new(l.p0.x.min(l.p1.x), l.p0.y.min(l.p1.y), l.p0.x.max(l.p1.x), l.p0.y.max(l.p1.y)));
            (b, b)
        }
        Shape::Text(t) => (text_bound(t, env), text_ink(t, env)),
        Shape::Smufl(s) => {
            // 元数据紧盒就是墨迹（字体盒约 4 em，不拿来当排版盒）；码位不认识的退回按字量
            let b = bound(n, env).and_then(drawn);
            (b.or_else(|| text_bound(&s.text, env)), b.or_else(|| text_ink(&s.text, env)))
        }
    }
}

struct Walk<'e> {
    next: i32,
    hits: Vec<Hit>,
    dialect: Dialect,
    env: Option<&'e Env<'e>>,
}

impl Walk<'_> {
    /// 返回子树画出来的（排版盒，墨迹盒），页面坐标（没给量字环境时都是 None）
    fn visit(&mut self, n: &Node, up: i32, shown: bool, outer: &Matrix33) -> (Option<Rect>, Option<Rect>) {
        let shown = shown && !n.is_invisible();
        let m = outer.concat(&n.m);
        // 本节点对应的元素
        let el = if !shown {
            -1
        } else {
            match self.dialect {
                Dialect::Jianpu => {
                    let g = self.next;
                    self.next += 1; // <g>
                    if matches!(n.shape, Shape::Path(_) | Shape::Line(_) | Shape::Text(_) | Shape::Smufl(_)) {
                        self.next += 1; // 自身图形
                    }
                    g
                }
                Dialect::Mixed => match n.shape {
                    Shape::Item => -1,
                    _ => {
                        let e = self.next;
                        self.next += 1;
                        e
                    }
                },
            }
        };
        let hdr = HEADER_CLASSES.into_iter().find(|c| n.has_class(c));
        let mut up_here = up;
        if n.id.is_some() || hdr.is_some() {
            let text = match &n.shape {
                Shape::Text(t) => Some(t.text.clone()),
                Shape::Smufl(s) => Some(s.text.text.clone()),
                _ => None,
            };
            up_here = self.hits.len() as i32;
            self.hits.push(Hit { el, up, id: n.id.clone(), hdr, text, data: n.data.clone(), m: None, bound: None, ink: None });
        }
        // 五线谱 / 混排只递归组：叶子的子级不出元素，但身份照收（TS 索引走整棵页面树）
        let kids_shown = shown && !(self.dialect == Dialect::Mixed && !n.is_group());
        let (mut b, mut ink) = match (self.env, shown) {
            (Some(env), true) => {
                let (b, i) = own_boxes(n, env);
                (b.map(|r| mapped(&m, r)), i.map(|r| mapped(&m, r)))
            }
            _ => (None, None),
        };
        for c in &n.k {
            let (cb, ci) = self.visit(c, up_here, kids_shown, &m);
            // 叶子底下的子级不画（混排方言），几何不并
            if kids_shown {
                b = join(b, cb);
                ink = join(ink, ci);
            }
        }
        if self.env.is_some() && up_here != up {
            let h = &mut self.hits[up_here as usize];
            h.m = Some(m);
            h.bound = b;
            h.ink = ink;
        }
        (b, ink)
    }
}

/// 一页的身份表（前序、即页面树顺序），不带几何。
pub fn page_hits(page: &Page) -> Vec<Hit> {
    hits_of(page, None).0
}

/// 一页的身份表，每项带页面几何（`m` / `bound` / `ink`）；另回整页画出来的墨迹盒（页面坐标，空页为 None）。
pub fn page_hits_geom(page: &Page, env: &Env) -> (Vec<Hit>, Option<Rect>) {
    hits_of(page, Some(env))
}

fn hits_of(page: &Page, env: Option<&Env>) -> (Vec<Hit>, Option<Rect>) {
    let mut w = Walk { next: 0, hits: Vec::new(), dialect: page.dialect, env };
    let ink = page.root.as_ref().and_then(|root| w.visit(root, -1, true, &Matrix33::IDENTITY).1);
    (w.hits, ink)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::svg::page_svg;

    /// 元素先序号与 SVG 输出里的元素次序对得上（两种方言各一份）。
    #[test]
    fn ordinals_match_svg() {
        let json = r#"{"dialect":"jianpu","cls":"score-page","w":100,"h":100,"root":
          {"t":"g","k":[
            {"t":"x","text":"T","font":{"family":"A","size":10},"color":0,"cls":["hdr"]},
            {"t":"g","id":{"kind":"system"},"k":[
              {"t":"g","id":{"kind":"note","id":7},"k":[
                {"t":"x","text":"1","font":{"family":"A","size":10},"color":0},
                {"t":"i","id":{"kind":"aug-dot"}}
              ]},
              {"t":"i","cls":["invisible"],"k":[{"t":"g","id":{"kind":"note","id":8}}]},
              {"t":"l","p0":[0,0],"p1":[1,0],"strokeWidth":1,"strokeColor":0,"id":{"kind":"barline","edge":"after"}}
            ]}
          ]}}"#;
        let page: Page = serde_json::from_str(json).unwrap();
        let svg = page_svg(&page);
        let tags = element_tags(&svg);
        let hits = page_hits(&page);
        let el = |i: usize| hits[i].el;
        assert_eq!(hits.len(), 6);
        assert_eq!(hits[0].hdr, Some("hdr"));
        assert_eq!(hits[0].text.as_deref(), Some("T"));
        assert_eq!(tags[el(0) as usize], "g");
        assert_eq!(tags[el(0) as usize + 1], "text");
        assert_eq!(hits[2].up, 1); // note 在 system 之下
        assert_eq!(hits[3].up, 2); // 附点在 note 之下
        assert_eq!(el(4), -1); // 不可见
        assert_eq!(tags[el(5) as usize], "g");
        assert_eq!(tags[el(5) as usize + 1], "line");

        let mut mixed = page.clone();
        mixed.dialect = Dialect::Mixed;
        let tags = element_tags(&page_svg(&mixed));
        let hits = page_hits(&mixed);
        assert_eq!(tags[hits[0].el as usize], "text");
        assert_eq!(tags[hits[1].el as usize], "g");
        assert_eq!(tags[hits[2].el as usize], "g");
        assert_eq!(hits[3].el, -1); // 裸项不出元素
        assert_eq!(hits[4].el, -1);
        assert_eq!(tags[hits[5].el as usize], "line");
        // 叶子底下的子级：身份照收、不出元素
        let leafy: Page = serde_json::from_str(r#"{"dialect":"mixed","cls":"x","w":1,"h":1,"root":
          {"t":"g","k":[{"t":"l","p0":[0,0],"p1":[1,0],"strokeWidth":1,"strokeColor":0,"k":[{"t":"g","id":{"kind":"slur"}}]},
                        {"t":"g","id":{"kind":"system"}}]}}"#).unwrap();
        let hits = page_hits(&leafy);
        assert_eq!((hits[0].el, hits[1].el), (-1, 2));
    }

    /// 带量字环境时各项给出本地 → 页面矩阵、排版盒与墨迹盒（页面坐标；文字墨迹按字量、不是字体盒）。
    #[test]
    fn geometry() {
        use crate::build::Env;
        use dolce_text::{MeasureCtx, ReplayMeasurer};
        let r = ReplayMeasurer::from_jsonl(
            r#"{"op":"glyph","text":"1","family":"A","size":10,"weight":"normal","features":[],"style":"normal","width":6,"bbox":[1,-7,5,0]}
{"op":"fontMetrics","family":"A","size":10,"weight":"normal","style":"normal","ascent":-9,"descent":3}"#,
        )
        .unwrap();
        let mc = MeasureCtx::new(&r);
        let env = Env { mc: &mc, meta: None };
        let page: Page = serde_json::from_str(r#"{"dialect":"jianpu","cls":"score-page","w":100,"h":100,"root":
          {"t":"g","m":[1,0,10,0,1,20],"k":[
            {"t":"g","id":{"kind":"note","id":7},"m":[2,0,5,0,2,0],"k":[
              {"t":"x","text":"1","font":{"family":"A","size":10},"color":0,"w":6,"h":12}
            ]},
            {"t":"l","p0":[0,0],"p1":[0,8],"strokeWidth":1,"strokeColor":0,"w":0,"h":8,"m":[1,0,30,0,1,0],"id":{"kind":"barline","edge":"after"}},
            {"t":"i","cls":["invisible"],"k":[{"t":"g","id":{"kind":"note","id":8}}]}
          ]}}"#)
        .unwrap();
        let (hits, ink) = page_hits_geom(&page, &env);
        assert_eq!(ink, Some(Rect::new(17.0, 6.0, 40.0, 28.0)));
        let note = &hits[0];
        // 本地 (x, y) → (2x + 15, 2y + 20)
        assert_eq!(note.m.unwrap().map_point(1.0, 1.0), dolce_base::geom::Point::new(17.0, 22.0));
        assert_eq!(note.bound, Some(Rect::new(15.0, 2.0, 27.0, 26.0))); // 字体盒 [0,-9,6,3]
        assert_eq!(note.ink, Some(Rect::new(17.0, 6.0, 25.0, 20.0))); // 墨迹 [1,-7,5,0]
        let bar = &hits[1];
        assert_eq!(bar.bound, Some(Rect::new(40.0, 20.0, 40.0, 28.0)));
        assert_eq!(bar.ink, bar.bound);
        // 不可见的不出几何
        assert_eq!((hits[2].bound, hits[2].ink), (None, None));
        // 不给环境时不出几何
        assert!(page_hits(&page).iter().all(|h| h.m.is_none() && h.bound.is_none()));
    }

    /// `<svg>` 之下各元素的标签名（先序）
    fn element_tags(svg: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut rest = svg;
        let mut first = true;
        while let Some(i) = rest.find('<') {
            rest = &rest[i + 1..];
            if rest.starts_with('/') {
                continue;
            }
            let end = rest.find([' ', '>']).unwrap();
            if !first {
                out.push(rest[..end].to_string());
            }
            first = false;
        }
        out
    }
}
