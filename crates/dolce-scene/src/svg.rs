//! 场景 → SVG 字符串，照 TS `layout/render.ts`（`renderPageSvg` + `svgVisitor` / `mixedVisitor`）
//! 与 `layout/svgnode.ts` 的 `outerHTML` 序列化（浏览器 HTML 文档里的写法：属性按设置先后、不补 xmlns、
//! 每个元素都写结束标签；文字转义 `& < >` 与不换行空格，属性值另转 `"`）。逐字节相同是 L0 的验收门。
//!
//! 属性次序有一处要留神：文字先设 `x="0"`，有逐字笔位时再**改** `x`——`Map.set` 改已有键不挪位置，
//! 所以 `x` 仍排第一个。

use dolce_model::base::js::{num_to_string, to_fixed};
use dolce_model::base::geom::color_to_css;

use crate::{Dialect, Node, Page, Shape, TextShape};

fn esc_text(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            _ => out.push(c),
        }
    }
}

fn esc_attr(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            _ => out.push(c),
        }
    }
}

/// 一个元素的开标签累加器。
struct El<'a> {
    out: &'a mut String,
}

impl<'a> El<'a> {
    fn open(out: &'a mut String, tag: &str) -> Self {
        out.push('<');
        out.push_str(tag);
        El { out }
    }
    fn attr(&mut self, k: &str, v: &str) -> &mut Self {
        self.out.push(' ');
        self.out.push_str(k);
        self.out.push_str("=\"");
        esc_attr(v, self.out);
        self.out.push('"');
        self
    }
    fn close(&mut self) {
        self.out.push('>');
    }
}

fn path_attrs(el: &mut El, p: &crate::PathShape, mixed: bool) {
    el.attr("d", &p.d());
    if p.fill {
        el.attr("fill", &color_to_css(p.fill_color));
    } else {
        el.attr("fill", "none");
    }
    if p.stroke {
        el.attr("stroke", &color_to_css(p.stroke_color));
        el.attr("stroke-width", &num_to_string(p.stroke_width));
    } else if mixed {
        el.attr("stroke", "none");
    }
}

fn text_x(t: &TextShape) -> String {
    match &t.char_xs {
        Some(xs) if xs.len() > 1 => xs.iter().map(|&v| to_fixed(v, 2)).collect::<Vec<_>>().join(" "),
        _ => "0".into(),
    }
}

fn text_el(out: &mut String, t: &TextShape, family: &str, fill: &str, transform: Option<String>) {
    let mut el = El::open(out, "text");
    el.attr("x", &text_x(t)).attr("y", "0").attr("font-family", family).attr("font-size", &num_to_string(t.font.size));
    if t.font.bold {
        el.attr("font-weight", "bold");
    }
    if t.font.italic {
        el.attr("font-style", "italic");
    }
    el.attr("fill", fill);
    if let Some(tr) = transform {
        el.attr("transform", &tr);
    }
    el.close();
    esc_text(&t.text, out);
    out.push_str("</text>");
}

fn line_el(out: &mut String, l: &crate::LineShape, stroke: &str, transform: Option<String>) {
    let mut el = El::open(out, "line");
    el.attr("x1", &num_to_string(l.p0.x))
        .attr("y1", &num_to_string(l.p0.y))
        .attr("x2", &num_to_string(l.p1.x))
        .attr("y2", &num_to_string(l.p1.y))
        .attr("stroke", stroke)
        .attr("stroke-width", &num_to_string(l.stroke_width))
        .attr("stroke-linecap", "butt");
    if let Some(tr) = transform {
        el.attr("transform", &tr);
    }
    el.close();
    out.push_str("</line>");
}

/// 简谱方言：每个节点一个 `<g>`（矩阵在 `<g>` 上），自身图形与子级都在里面。
fn jianpu_node(n: &Node, out: &mut String) {
    if n.is_invisible() {
        return;
    }
    {
        let mut g = El::open(out, "g");
        if !n.m.is_identity() {
            g.attr("transform", &n.m.to_svg());
        }
        g.close();
    }
    match &n.shape {
        Shape::Path(p) => {
            let mut el = El::open(out, "path");
            path_attrs(&mut el, p, false);
            el.close();
            out.push_str("</path>");
        }
        Shape::Line(l) => line_el(out, l, &color_to_css(l.stroke_color), None),
        Shape::Text(t) => text_el(out, t, &t.font.family, &color_to_css(t.color), None),
        Shape::Smufl(s) => text_el(out, &s.text, "Bravura", &color_to_css(s.text.color), None),
        Shape::Group | Shape::Item => {}
    }
    for c in &n.k {
        jianpu_node(c, out);
    }
    out.push_str("</g>");
}

/// 五线谱 / 混排方言：只有组出 `<g>`（带 class），叶子自带 transform、落在父级 `<g>` 里；只递归组。
fn mixed_node(n: &Node, out: &mut String) {
    if n.is_invisible() {
        return;
    }
    let tr = || (!n.m.is_identity()).then(|| n.m.to_svg());
    match &n.shape {
        Shape::Group => {
            {
                let mut g = El::open(out, "g");
                if !n.m.is_identity() {
                    g.attr("transform", &n.m.to_svg());
                }
                if !n.cls.is_empty() {
                    g.attr("class", &n.cls.join(" "));
                }
                g.close();
            }
            for c in &n.k {
                mixed_node(c, out);
            }
            out.push_str("</g>");
        }
        Shape::Line(l) => line_el(out, l, "black", tr()),
        // 文字无条件带 transform（矩阵里就含 x / y）；字体照节点（SMuFL 字也不改族名）
        Shape::Text(t) => text_el(out, t, &t.font.family, "black", Some(n.m.to_svg())),
        Shape::Smufl(s) => text_el(out, &s.text, &s.text.font.family, "black", Some(n.m.to_svg())),
        Shape::Path(p) => {
            let mut el = El::open(out, "path");
            path_attrs(&mut el, p, true);
            if let Some(t) = tr() {
                el.attr("transform", &t);
            }
            el.close();
            out.push_str("</path>");
        }
        Shape::Item => {}
    }
}

/// 一页 → `<svg>` 的 `outerHTML`。
pub fn page_svg(page: &Page) -> String {
    let mut out = String::new();
    {
        let mut svg = El::open(&mut out, "svg");
        svg.attr("class", &page.cls).attr("viewBox", &format!("0 0 {} {}", num_to_string(page.w), num_to_string(page.h)));
        svg.close();
    }
    if let Some(root) = &page.root {
        match page.dialect {
            Dialect::Jianpu => jianpu_node(root, &mut out),
            Dialect::Mixed => mixed_node(root, &mut out),
        }
    }
    out.push_str("</svg>");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_page() {
        let json = r#"{"dialect":"jianpu","cls":"score-page","w":425,"h":612.5,"root":
          {"t":"g","m":[1,0,10,0,1,20],"k":[
            {"t":"x","m":[1,0,0,0,1,0],"text":"1 <&> ","font":{"family":"PingFang SC","size":12.08,"bold":true},"color":4278190080,"charXs":[0,3.456]},
            {"t":"l","p0":[0,0],"p1":[5,0],"strokeWidth":0.5,"strokeColor":4278190080},
            {"t":"p","segs":[["M",0,0],["L",1.5,2],["Z"]],"strokeWidth":1,"strokeColor":0,"fillColor":4278190080,"stroke":false,"fill":true},
            {"t":"i","cls":["invisible"]}
          ]}}"#;
        let page: Page = serde_json::from_str(json).unwrap();
        assert_eq!(
            page_svg(&page),
            concat!(
                r#"<svg class="score-page" viewBox="0 0 425 612.5"><g transform="matrix(1 0 0 1 10 20)">"#,
                r#"<g><text x="0.00 3.46" y="0" font-family="PingFang SC" font-size="12.08" font-weight="bold" fill="rgb(0,0,0)">1 &lt;&amp;&gt;&nbsp;</text></g>"#,
                r#"<g><line x1="0" y1="0" x2="5" y2="0" stroke="rgb(0,0,0)" stroke-width="0.5" stroke-linecap="butt"></line></g>"#,
                r#"<g><path d="M0 0 L1.5 2 Z" fill="rgb(0,0,0)"></path></g>"#,
                r#"</g></svg>"#
            )
        );
        let mut mixed = page.clone();
        mixed.dialect = Dialect::Mixed;
        mixed.cls = "score-page mixed-page".into();
        assert_eq!(
            page_svg(&mixed),
            concat!(
                r#"<svg class="score-page mixed-page" viewBox="0 0 425 612.5"><g transform="matrix(1 0 0 1 10 20)">"#,
                r#"<text x="0.00 3.46" y="0" font-family="PingFang SC" font-size="12.08" font-weight="bold" fill="black" transform="matrix(1 0 0 1 0 0)">1 &lt;&amp;&gt;&nbsp;</text>"#,
                r#"<line x1="0" y1="0" x2="5" y2="0" stroke="black" stroke-width="0.5" stroke-linecap="butt"></line>"#,
                r#"<path d="M0 0 L1.5 2 Z" fill="rgb(0,0,0)" stroke="none"></path>"#,
                r#"</g></svg>"#
            )
        );
    }
}
