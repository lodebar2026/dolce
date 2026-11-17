//! 规范化 dump 与比对（`dolce diff-scene`，排版两道门的工具）：
//! 一页拍平成前序的节点记录，每条拆成**骨架**（形、角色、类、身份、字、字体族与粗斜、路径命令序列、描边填充开关、颜色）
//! 与**数**（矩阵、宽高、盒、字号、路径坐标、线端点、逐字笔位）两半，另算节点原点的页面绝对坐标。
//! 比对先骨架（必须一字不差），再看数的最大差与页面绝对坐标的最大差。

use dolce_geom::Matrix33;

use crate::{Node, Page, Shape};

/// 一个节点的规范化记录。
#[derive(Clone, Debug, PartialEq)]
pub struct NodeRec {
    /// 深度 + 骨架（可读文本）
    pub skeleton: String,
    pub nums: Vec<f64>,
    /// 节点原点与盒四角换到页面坐标（x, y 交替）
    pub abs: Vec<f64>,
}

fn push_shape(n: &Node, sk: &mut String, nums: &mut Vec<f64>) {
    match &n.shape {
        Shape::Group => sk.push('g'),
        Shape::Item => sk.push('i'),
        Shape::Path(p) => {
            sk.push_str("p[");
            for s in &p.segs {
                sk.push_str(match s.op {
                    crate::PathOp::M => "M",
                    crate::PathOp::L => "L",
                    crate::PathOp::C => "C",
                    crate::PathOp::Z => "Z",
                });
                sk.push_str(&s.pts.len().to_string());
                nums.extend_from_slice(&s.pts);
            }
            sk.push_str(&format!("] s{} f{} sc{} fc{}", p.stroke as u8, p.fill as u8, p.stroke_color, p.fill_color));
            nums.push(p.stroke_width);
        }
        Shape::Line(l) => {
            sk.push_str(&format!("l sc{}", l.stroke_color));
            nums.extend_from_slice(&[l.p0.x, l.p0.y, l.p1.x, l.p1.y, l.stroke_width]);
        }
        Shape::Text(t) | Shape::Smufl(crate::SmuflShape { text: t, .. }) => {
            let tag = if matches!(n.shape, Shape::Smufl(_)) { "s" } else { "x" };
            sk.push_str(&format!(
                "{tag} {:?} {:?}{}{} c{} xs{} ink{}",
                t.text,
                t.font.family,
                if t.font.bold { " bold" } else { "" },
                if t.font.italic { " italic" } else { "" },
                t.color,
                t.char_xs.as_ref().map_or(0, |v| v.len()),
                t.ink_bound as u8
            ));
            if let Shape::Smufl(s) = &n.shape {
                sk.push_str(&format!(" path{}", s.as_path as u8));
            }
            nums.push(t.font.size);
            if let Some(xs) = &t.char_xs {
                nums.extend_from_slice(xs);
            }
        }
    }
}

fn walk(n: &Node, depth: usize, parent: &Matrix33, out: &mut Vec<NodeRec>) {
    let mut sk = format!("{depth} ");
    let mut nums: Vec<f64> = n.m.mat[..6].to_vec();
    nums.extend_from_slice(&[n.w, n.h]);
    push_shape(n, &mut sk, &mut nums);
    if let Some(r) = &n.role {
        // 角色只比种类（字段是数，进数那半）
        let v = serde_json::to_value(r).unwrap_or_default();
        sk.push_str(&format!(" role={}", v.get("k").and_then(|k| k.as_str()).unwrap_or("?")));
        if let Some(obj) = v.as_object() {
            for (k, x) in obj {
                if k == "k" {
                    continue;
                }
                match x {
                    serde_json::Value::Number(num) => nums.push(num.as_f64().unwrap_or(f64::NAN)),
                    serde_json::Value::Array(a) => nums.extend(a.iter().map(|y| y.as_f64().unwrap_or(f64::NAN))),
                    other => sk.push_str(&format!(" {k}={other}")),
                }
            }
        }
    }
    if !n.cls.is_empty() {
        sk.push_str(&format!(" cls={}", n.cls.join(".")));
    }
    if let Some(id) = &n.id {
        sk.push_str(&format!(" id={}", serde_json::to_string(id).unwrap_or_default()));
    }
    if n.sel {
        sk.push_str(" sel");
    }
    match &n.b {
        Some(b) => {
            sk.push_str(" b");
            nums.extend_from_slice(&[b.left, b.top, b.right, b.bottom]);
        }
        None => sk.push_str(" b-"),
    }
    let m = parent.concat(&n.m);
    let mut abs = Vec::with_capacity(10);
    let o = m.map_point(0.0, 0.0);
    abs.extend_from_slice(&[o.x, o.y]);
    if let Some(b) = &n.b {
        for (x, y) in [(b.left, b.top), (b.right, b.bottom)] {
            let p = m.map_point(x, y);
            abs.extend_from_slice(&[p.x, p.y]);
        }
    }
    out.push(NodeRec { skeleton: sk, nums, abs });
    for c in &n.k {
        walk(c, depth + 1, &m, out);
    }
}

/// 一页拍平。
pub fn normalize(page: &Page) -> Vec<NodeRec> {
    let mut out = Vec::new();
    if let Some(root) = &page.root {
        walk(root, 0, &Matrix33::IDENTITY, &mut out);
    }
    out
}

/// 两页的比对结果。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PageDiff {
    /// 骨架头一处不同：(节点序号, 左, 右)；节点数不同时缺的一边是空串
    pub skeleton: Option<(usize, String, String)>,
    /// 数的最大差（骨架一致时才有意义）与所在节点
    pub max_num: f64,
    pub max_num_at: usize,
    /// 页面绝对坐标的最大差
    pub max_abs: f64,
    pub max_abs_at: usize,
}

fn delta(a: f64, b: f64) -> f64 {
    if a == b || (a.is_nan() && b.is_nan()) {
        0.0
    } else if a.is_finite() && b.is_finite() {
        (a - b).abs()
    } else {
        f64::INFINITY
    }
}

pub fn diff_pages(a: &Page, b: &Page) -> PageDiff {
    let mut d = PageDiff::default();
    if a.dialect != b.dialect || a.cls != b.cls {
        d.skeleton = Some((0, format!("{:?} {}", a.dialect, a.cls), format!("{:?} {}", b.dialect, b.cls)));
        return d;
    }
    for (i, x) in [a.w, a.h].iter().zip([b.w, b.h]).map(|(x, y)| delta(*x, y)).enumerate() {
        let _ = i;
        if x > d.max_abs {
            d.max_abs = x;
        }
    }
    let ra = normalize(a);
    let rb = normalize(b);
    for i in 0..ra.len().max(rb.len()) {
        let (x, y) = (ra.get(i), rb.get(i));
        let (sx, sy) = (x.map_or("", |r| r.skeleton.as_str()), y.map_or("", |r| r.skeleton.as_str()));
        if sx != sy || x.map(|r| r.nums.len()) != y.map(|r| r.nums.len()) || x.map(|r| r.abs.len()) != y.map(|r| r.abs.len()) {
            d.skeleton = Some((i, sx.to_string(), sy.to_string()));
            return d;
        }
        let (x, y) = (x.unwrap(), y.unwrap());
        for (p, q) in x.nums.iter().zip(&y.nums) {
            let e = delta(*p, *q);
            if e > d.max_num {
                d.max_num = e;
                d.max_num_at = i;
            }
        }
        for (p, q) in x.abs.iter().zip(&y.abs) {
            let e = delta(*p, *q);
            if e > d.max_abs {
                d.max_abs = e;
                d.max_abs_at = i;
            }
        }
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(x: f64, text: &str) -> Page {
        let json = format!(
            r#"{{"dialect":"jianpu","cls":"score-page","w":100,"h":100,"root":{{"t":"g","m":[1,0,{x},0,1,5],"b":[0,0,10,10],"k":[
              {{"t":"x","m":[1,0,2,0,1,3],"text":"{text}","font":{{"family":"F","size":12}},"color":0,"b":[0,-9,7,3]}}]}}}}"#
        );
        serde_json::from_str(&json).unwrap()
    }

    #[test]
    fn diffs() {
        let d = diff_pages(&page(1.0, "1"), &page(1.0, "1"));
        assert_eq!(d, PageDiff::default());
        let d = diff_pages(&page(1.0, "1"), &page(1.25, "1"));
        assert!(d.skeleton.is_none());
        assert_eq!(d.max_num, 0.25);
        assert_eq!(d.max_abs, 0.25);
        assert_eq!(d.max_abs_at, 0);
        let d = diff_pages(&page(1.0, "1"), &page(1.0, "2"));
        assert_eq!(d.skeleton.map(|s| s.0), Some(1));
    }
}
