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

use serde::Serialize;

use crate::{Dialect, Identity, Node, Page, Shape};

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
}

struct Walk {
    next: i32,
    hits: Vec<Hit>,
    dialect: Dialect,
}

impl Walk {
    fn visit(&mut self, n: &Node, up: i32, shown: bool) {
        let shown = shown && !n.is_invisible();
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
            self.hits.push(Hit { el, up, id: n.id.clone(), hdr, text, data: n.data.clone() });
        }
        // 五线谱 / 混排只递归组：叶子的子级不出元素，但身份照收（TS 索引走整棵页面树）
        let kids_shown = shown && !(self.dialect == Dialect::Mixed && !n.is_group());
        for c in &n.k {
            self.visit(c, up_here, kids_shown);
        }
    }
}

/// 一页的身份表（前序、即页面树顺序）。
pub fn page_hits(page: &Page) -> Vec<Hit> {
    let mut w = Walk { next: 0, hits: Vec::new(), dialect: page.dialect };
    if let Some(root) = &page.root {
        w.visit(root, -1, true);
    }
    w.hits
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
