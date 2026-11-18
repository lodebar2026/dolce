//! 花括号（连谱号、并排块、词括号）的轮廓路径（照 `compose/brace.ts` 与 `braceglyphs.ts`）。

use dolce_engrave::jpglyph::bracket;
use dolce_base::geom::Matrix33;
use dolce_scene::{Node, PathOp, PathSeg};

use super::ctx::{font, rect, text, Ctx};

/// 花括号字形轮廓：`d`、路径原点相对锚点的平移、墨迹包围盒 (x, y, w, h)
struct BraceGlyph {
    d: &'static str,
    shift: f64,
    bx: [f64; 4],
}

const SPLIT_LEFT: BraceGlyph = BraceGlyph {
    d: "m55.35585,12.01287l0,-1.51213c-1.92115,0.64801 -3.47848,2.57401 -4.67193,5.77811s-1.79017,6.75013 -1.79017,10.6382c0,2.01608 0.13099,4.37409 0.39296,7.07414s0.39296,4.80609 0.39296,6.31813c0,2.01607 -0.3493,3.90611 -1.04791,5.6701s-1.65918,2.86206 -2.88175,3.29407l0,1.72803c1.22255,0.432 2.18314,1.51202 2.88175,3.24006s1.04791,3.6361 1.04791,5.72411c0,1.51203 -0.13099,3.60004 -0.39296,6.26411s-0.39296,5.04015 -0.39296,7.12814c0,3.81605 0.59673,7.32613 1.79017,10.53022s2.75078,5.13011 4.67193,5.77811l0,-1.51202c-1.339,-0.79198 -2.32142,-2.08801 -2.94724,-3.88807s-0.93877,-3.74411 -0.93877,-5.83212c0,-1.72803 0.1237,-3.96011 0.37113,-6.69612s0.37112,-5.04004 0.37112,-6.91203c0,-2.88009 -0.42207,-5.67011 -1.26622,-8.37016s-2.09582,-4.77013 -3.755,-6.21012c1.63006,-1.51202 2.87447,-3.6361 3.73318,-6.37212s1.28804,-5.54407 1.28804,-8.42416c0,-1.94404 -0.12368,-4.26609 -0.37112,-6.96614s-0.37113,-4.9141 -0.37113,-6.64213c0,-2.16004 0.31294,-4.12211 0.93877,-5.88611s1.60823,-3.07806 2.94724,-3.94208l0,-0.00002z",
    shift: -50.0,
    bx: [-4.25, -39.5, 9.61, 79.17],
};

const SPLIT_RIGHT: BraceGlyph = BraceGlyph {
    d: "m45.35585,12.01287l0,-1.51213c1.97881,0.64801 3.58288,2.57401 4.81215,5.77811s1.8439,6.75013 1.8439,10.6382c0,2.01608 -0.13492,4.37409 -0.40475,7.07414s-0.40475,4.80609 -0.40475,6.31813c0,2.01607 0.35978,3.90611 1.07936,5.6701s1.70898,2.86206 2.96824,3.29407l0,1.72803c-1.25925,0.432 -2.24866,1.51202 -2.96824,3.24006s-1.07936,3.6361 -1.07936,5.72411c0,1.51203 0.13492,3.60004 0.40475,6.26411s0.40475,5.04015 0.40475,7.12814c0,3.81605 -0.61464,7.32613 -1.8439,10.53022s-2.83334,5.13011 -4.81215,5.77811l0,-1.51202c1.37919,-0.79198 2.39109,-2.08801 3.03569,-3.88807s0.96694,-3.74411 0.96694,-5.83212c0,-1.72803 -0.12741,-3.96011 -0.38227,-6.69612s-0.38226,-5.04004 -0.38226,-6.91203c0,-2.88009 0.43474,-5.67011 1.30422,-8.37016s2.15872,-4.77013 3.86771,-6.21012c-1.67899,-1.51202 -2.96074,-3.6361 -3.84523,-6.37212s-1.3267,-5.54407 -1.3267,-8.42416c0,-1.94404 0.12739,-4.26609 0.38226,-6.96614s0.38227,-4.9141 0.38227,-6.64213c0,-2.16004 -0.32233,-4.12211 -0.96694,-5.88611s-1.6565,-3.07806 -3.03569,-3.94208l0,-0.00002z",
    shift: -50.0,
    bx: [-4.64, -39.5, 9.61, 79.17],
};

const LYRIC_LEFT: BraceGlyph = BraceGlyph {
    d: "m3.4619,4.82551l0,0.19085c-1.38966,-0.08178 -2.51615,-0.32487 -3.37943,-0.72928s-1.29492,-0.85197 -1.29492,-1.34269c0,-0.25446 0.09476,-0.55207 0.28425,-0.89286s0.28425,-0.6066 0.28425,-0.79744c0,-0.25446 -0.25266,-0.49301 -0.758,-0.71564s-1.20017,-0.36124 -2.08452,-0.41576l0,-0.2181c0.88433,-0.05453 1.57917,-0.19085 2.08452,-0.40894s0.758,-0.45893 0.758,-0.72247c0,-0.19085 -0.09476,-0.45438 -0.28425,-0.79063s-0.28425,-0.63614 -0.28425,-0.89967c0,-0.48164 0.43165,-0.92466 1.29492,-1.32907s1.98977,-0.64749 3.37943,-0.72928l0,0.19083c-0.96857,0.09997 -1.67919,0.26355 -2.13188,0.49074s-0.67905,0.47256 -0.67905,0.7361c0,0.21809 0.08948,0.49982 0.26846,0.84515s0.26844,0.63613 0.26844,0.8724c0,0.36351 -0.30531,0.71564 -0.91592,1.05643s-1.516,0.60207 -2.71616,0.78382c1.1791,0.19084 2.07924,0.45893 2.70038,0.80425s0.93171,0.69975 0.93171,1.06326c0,0.24535 -0.08947,0.53844 -0.26844,0.87922s-0.26846,0.62024 -0.26846,0.83833c0,0.27263 0.22637,0.52027 0.67905,0.74292s1.16331,0.38848 2.13188,0.49754l0,0l0,0.00003l0,-0.00001l-0.00001,-0.00001z",
    shift: 0.0,
    bx: [-3.19, -4.98, 6.94, 9.99],
};

const LYRIC_RIGHT: BraceGlyph = BraceGlyph {
    d: "m-3.75,4.82566l0,0.19085c1.38775,-0.08179 2.5127,-0.32488 3.37479,-0.72928s1.29314,-0.85197 1.29314,-1.3427c0,-0.25446 -0.09463,-0.55207 -0.28386,-0.89286s-0.28386,-0.6066 -0.28386,-0.79744c0,-0.25446 0.25232,-0.49301 0.75696,-0.71565s1.19851,-0.36123 2.08165,-0.41576l0,-0.2181c-0.88312,-0.05453 -1.577,-0.19084 -2.08165,-0.40894s-0.75696,-0.45893 -0.75696,-0.72247c0,-0.19084 0.09463,-0.45438 0.28386,-0.79062s0.28386,-0.63614 0.28386,-0.89968c0,-0.48164 -0.43105,-0.92466 -1.29314,-1.32907s-1.98704,-0.64749 -3.37479,-0.72928l0,0.19084c0.96723,0.09996 1.67688,0.26354 2.12895,0.49073s0.67812,0.47256 0.67812,0.7361c0,0.2181 -0.08935,0.49982 -0.26809,0.84515s-0.26808,0.63613 -0.26808,0.8724c0,0.36351 0.30489,0.71565 0.91466,1.05644s1.51392,0.60206 2.71244,0.78381c-1.17749,0.19084 -2.07639,0.45893 -2.69668,0.80425s-0.93042,0.69974 -0.93042,1.06325c0,0.24537 0.08935,0.53844 0.26808,0.87923s0.26809,0.62023 0.26809,0.83833c0,0.27263 -0.22606,0.52027 -0.67812,0.74291s-1.16172,0.38849 -2.12895,0.49755l0,0l0,0.00002l0,-0.00001z",
    shift: 0.0,
    bx: [-3.75, -4.98, 6.94, 9.99],
};

/// 记号串：`[MmLlHhVvCcSsZz]|-?\d*\.?\d+(?:e-?\d+)?`
fn tokens(d: &str) -> Vec<String> {
    let re = regex::Regex::new(r"[MmLlHhVvCcSsZz]|-?\d*\.?\d+(?:e-?\d+)?").expect("正则");
    re.find_iter(d).map(|m| m.as_str().to_string()).collect()
}

/// SVG path 的 `d` → 路径段（只认 m/l/h/v/c/s/z）
fn parse_path_d(d: &str) -> Vec<PathSeg> {
    let toks = tokens(d);
    let mut segs = vec![];
    let mut i = 0usize;
    let (mut cx, mut cy, mut sx, mut sy, mut p2x, mut p2y) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    let mut last = String::new();
    let num = |i: &mut usize| -> f64 {
        let v = toks.get(*i).map_or(f64::NAN, |t| dolce_base::js::number(t));
        *i += 1;
        v
    };
    while i < toks.len() {
        let mut cmd = toks[i].clone();
        if cmd.chars().next().is_some_and(|ch| ch.is_ascii_alphabetic()) {
            i += 1;
        } else {
            cmd = match last.as_str() {
                "M" => "L".into(),
                "m" => "l".into(),
                s => s.into(),
            };
        }
        last = cmd.clone();
        let rel = cmd == cmd.to_lowercase();
        let (ox, oy) = if rel { (cx, cy) } else { (0.0, 0.0) };
        let up = cmd.to_uppercase();
        match up.as_str() {
            "M" => {
                cx = num(&mut i) + ox;
                cy = num(&mut i) + oy;
                sx = cx;
                sy = cy;
                segs.push(PathSeg { op: PathOp::M, pts: vec![cx, cy] });
            }
            "L" => {
                cx = num(&mut i) + ox;
                cy = num(&mut i) + oy;
                segs.push(PathSeg { op: PathOp::L, pts: vec![cx, cy] });
            }
            "H" => {
                cx = num(&mut i) + ox;
                segs.push(PathSeg { op: PathOp::L, pts: vec![cx, cy] });
            }
            "V" => {
                cy = num(&mut i) + oy;
                segs.push(PathSeg { op: PathOp::L, pts: vec![cx, cy] });
            }
            "C" => {
                let c1x = num(&mut i) + ox;
                let c1y = num(&mut i) + oy;
                let c2x = num(&mut i) + ox;
                let c2y = num(&mut i) + oy;
                cx = num(&mut i) + ox;
                cy = num(&mut i) + oy;
                segs.push(PathSeg { op: PathOp::C, pts: vec![c1x, c1y, c2x, c2y, cx, cy] });
                p2x = c2x;
                p2y = c2y;
            }
            "S" => {
                let c1x = 2.0 * cx - p2x;
                let c1y = 2.0 * cy - p2y;
                let c2x = num(&mut i) + ox;
                let c2y = num(&mut i) + oy;
                cx = num(&mut i) + ox;
                cy = num(&mut i) + oy;
                segs.push(PathSeg { op: PathOp::C, pts: vec![c1x, c1y, c2x, c2y, cx, cy] });
                p2x = c2x;
                p2y = c2y;
            }
            "Z" => {
                segs.push(PathSeg { op: PathOp::Z, pts: vec![] });
                cx = sx;
                cy = sy;
            }
            _ => i += 1,
        }
        if up != "C" && up != "S" {
            p2x = cx;
            p2y = cy;
        }
    }
    segs
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BraceKind {
    Split,
    Lyric,
}

/// 花括号：横向轮廓固定、纵向按跨度拉伸。`x_left` 是墨迹左缘
pub fn brace_item(color: f64, x_left: f64, y0: f64, y1: f64, dir: i32, kind: BraceKind) -> Node {
    let g = match (kind, dir < 0) {
        (BraceKind::Split, true) => &SPLIT_LEFT,
        (BraceKind::Split, false) => &SPLIT_RIGHT,
        (BraceKind::Lyric, true) => &LYRIC_LEFT,
        (BraceKind::Lyric, false) => &LYRIC_RIGHT,
    };
    let [bx, by, _, bh] = g.bx;
    let sy = (y1 - y0) / bh;
    let mut path = Node::path();
    {
        let p = path.path_mut();
        p.segs = parse_path_d(g.d);
        p.offset(g.shift, g.shift);
        p.fill = true;
        p.fill_color = color;
    }
    let mut holder = Node::item();
    holder.m = Matrix33::from_affine([1.0, 0.0, 0.0, sy, x_left - bx, y0 - by * sy]);
    holder.push(path);
    holder
}

/// 连谱号：一粗一细两条竖线，粗线两端各一个 SMuFL 花头
pub fn paint_brace(c: &Ctx, root: &mut Node, x: f64, top: f64, bottom: f64) {
    let m = c.m;
    let ink = m.ink.note_height;
    let size = ink * 2.2;
    let f = font("Bravura", size, false);
    let thick = size * 0.115;
    let thin = m.style.stroke.barline;
    let gap = ink * 0.55;
    let y0 = top - ink * 0.85;
    let y1 = bottom + ink * 0.85;
    root.push(rect(c.ink, x - thick / 2.0, y0, thick, y1 - y0));
    let inset = ink * 0.42;
    root.push(rect(c.ink, x + gap - thin / 2.0, top - inset, thin, bottom - top + inset * 2.0));
    let g = |cp: u32| char::from_u32(cp).expect("码位").to_string();
    root.push(text(&g(bracket::TOP), x - thick / 2.0, y0, f.clone(), c.ink, c.env));
    root.push(text(&g(bracket::BOTTOM), x - thick / 2.0, y1, f, c.ink, c.env));
}
