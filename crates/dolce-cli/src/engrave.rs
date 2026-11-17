//! `dolce engrave-check <cases.jsonl> <measure.jsonl>`：图元层迁 Rust（L2）的对拍。
//! 夹具由 dev `engrave-rs-diff.mjs` 让 TS（`src/engrave/`）逐元素现算；这里在量字回放下用 `dolce-engrave` 重算，
//! 场景节点先读进 [`Node`] 再写回（两边同一口径），然后逐字段比：结构（键、类型、串、布尔、数组长）要一样，数差 ≤ 1e-6。
//!
//! 用例种类（`kind`）与参数（`a`，TS 原字段名）见脚本；非有限数在 JSON 里写成 `"NaN"` / `"Inf"` / `"-Inf"`。

use crate::layout::{flag, lines, positional, show_n};
use dolce_engrave as el;
use dolce_engrave::accidental::{AccidentalGlyph, AccidentalKind, AccidentalStyle, DigitRef};
use dolce_engrave::arc::{ArcKind, ArcObstacle, SlurStyle};
use dolce_engrave::barline::{BarlineGlyph, BarlineSpec, BarlineStyle};
use dolce_engrave::chord::HarmonySeg;
use dolce_engrave::ending::{EndingBracket, EndingLabel};
use dolce_engrave::grace::{GraceGeom, GraceMetrics, GraceNote};
use dolce_engrave::keysig::{KeyLabel, KeyLabelStyle, KeyName};
use dolce_engrave::sectionword::{SectionChord, SectionWordGeom};
use dolce_engrave::spacing::{AccidentalSide, AccidentalStyleKind};
use dolce_engrave::timesig::{TimeSigGlyph, TimeSigStyle};
use dolce_engrave::tuplet::{TupletGlyph, TupletKind, TupletStyle};
use dolce_engrave::upperband::BandItem;
use dolce_engrave::Env;
use dolce_geom::{Point, Rect};
use dolce_scene::build::{freeze, update};
use dolce_scene::Node;
use dolce_smufl::MetaData;
use dolce_text::cjkpunct::CompressMode;
use dolce_text::ReplayMeasurer;
use dolce_text::{Font, MeasureCtx};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const TOL: f64 = 1e-6;

// ── 读参数 ──

fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) if s == "Inf" => f64::INFINITY,
        Value::String(s) if s == "-Inf" => f64::NEG_INFINITY,
        Value::Null => f64::NAN,
        _ => f64::NAN,
    }
}
fn f(a: &Value, k: &str) -> f64 {
    num(&a[k])
}
fn of(a: &Value, k: &str) -> Option<f64> {
    a.get(k).filter(|v| !v.is_null()).map(num)
}
fn b(a: &Value, k: &str) -> bool {
    a[k].as_bool().unwrap_or(false)
}
fn ob(a: &Value, k: &str) -> Option<bool> {
    a.get(k).and_then(Value::as_bool)
}
fn s<'v>(a: &'v Value, k: &str) -> &'v str {
    a[k].as_str().unwrap_or("")
}
fn os<'v>(a: &'v Value, k: &str) -> Option<&'v str> {
    a.get(k).and_then(Value::as_str)
}
fn font(v: &Value) -> Font {
    serde_json::from_value(v.clone()).expect("字体读不进")
}
fn pt(v: &Value) -> Point {
    Point::new(num(&v[0]), num(&v[1]))
}
fn strs(v: &Value) -> Vec<&str> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

// ── 写结果 ──

/// 数 → JSON（非有限数同脚本的写法）
fn n(x: f64) -> Value {
    if x.is_nan() {
        json!("NaN")
    } else if x.is_infinite() {
        json!(if x > 0.0 { "Inf" } else { "-Inf" })
    } else {
        json!(x)
    }
}
fn on(x: Option<f64>) -> Value {
    x.map_or(Value::Null, n)
}
fn rect(r: Rect) -> Value {
    json!([n(r.left), n(r.top), n(r.right), n(r.bottom)])
}
fn orect(r: Option<Rect>) -> Value {
    r.map_or(Value::Null, rect)
}
fn p2(p: Point) -> Value {
    json!([n(p.x), n(p.y)])
}
/// 场景节点：先定盒（TS 的 `bound` 是取时现算），再写成 JSON
fn node(mut nd: Node, env: &Env) -> Value {
    freeze(&mut nd, env);
    serde_json::to_value(&nd).expect("节点可序列化")
}
fn nodes(v: Vec<Node>, env: &Env) -> Value {
    Value::Array(v.into_iter().map(|x| node(x, env)).collect())
}
fn upd(nd: &mut Node, env: &Env) {
    update(nd, env).unwrap_or_else(|e| panic!("update：{}", e.0));
}
/// 「原样」与「update 之后」两份
fn raw_upd(nd: Node, env: &Env) -> Value {
    let raw = node(nd.clone(), env);
    let mut u = nd;
    upd(&mut u, env);
    json!({ "raw": raw, "upd": node(u, env) })
}

// ── 期望值的口径 ──

/// 期望里的场景节点读进 `Node` 再写回，与 Rust 那边同一口径（键缺省、数的写法）。
/// 认法：带 `t`（g/i/p/l/x/s）与 `m` 的对象。
fn canon(v: &Value) -> Value {
    match v {
        Value::Object(o) => {
            if o.get("t").and_then(Value::as_str).is_some_and(|t| matches!(t, "g" | "i" | "p" | "l" | "x" | "s")) && o.contains_key("m") {
                if let Ok(nd) = serde_json::from_value::<Node>(v.clone()) {
                    return serde_json::to_value(&nd).expect("节点可序列化");
                }
            }
            Value::Object(o.iter().map(|(k, x)| (k.clone(), canon(x))).collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(canon).collect()),
        _ => v.clone(),
    }
}

struct Diff {
    skeleton: Vec<String>,
    max_num: f64,
    num_over: Vec<String>,
}

fn diff(path: &str, a: &Value, b: &Value, d: &mut Diff) {
    let numish = |v: &Value| match v {
        Value::Number(_) => true,
        Value::String(s) => matches!(s.as_str(), "NaN" | "Inf" | "-Inf"),
        _ => false,
    };
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for k in x.keys().chain(y.keys().filter(|k| !x.contains_key(*k))) {
                match (x.get(k), y.get(k)) {
                    (Some(va), Some(vb)) => diff(&format!("{path}.{k}"), va, vb, d),
                    (va, vb) => d.skeleton.push(format!("{path}.{k}：{} → {}", short(va), short(vb))),
                }
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                diff(&format!("{path}[{i}]"), p, q, d);
            }
        }
        _ if numish(a) && numish(b) => {
            let (p, q) = (num(a), num(b));
            if p.is_finite() && q.is_finite() {
                let e = (p - q).abs();
                if e > d.max_num {
                    d.max_num = e;
                }
                if e > TOL {
                    d.num_over.push(format!("{path}：{p} → {q}（差 {e:e}）"));
                }
            } else if !(p.is_nan() && q.is_nan()) && p != q {
                d.skeleton.push(format!("{path}：{p} → {q}"));
            }
        }
        _ => {
            if a != b {
                d.skeleton.push(format!("{path}：{} → {}", short(Some(a)), short(Some(b))));
            }
        }
    }
}

fn short(v: Option<&Value>) -> String {
    match v {
        None => "(无)".into(),
        Some(v) => {
            let t = v.to_string();
            if t.chars().count() > 240 {
                format!("{}…", t.chars().take(240).collect::<String>())
            } else {
                t
            }
        }
    }
}

// ── 参数 → 元素的样式结构 ──

fn slur_style(a: &Value) -> SlurStyle {
    SlurStyle {
        thickness: f(a, "thickness"),
        color: f(a, "color"),
        height_scale: of(a, "heightScale"),
        outline_width: of(a, "outlineWidth"),
        max_height: of(a, "maxHeight"),
        min_height: of(a, "minHeight"),
        flat_span: of(a, "flatSpan"),
        force_flat: b(a, "forceFlat"),
        flat_ratio: of(a, "flatRatio"),
        flat_line_width: of(a, "flatLineWidth"),
        side_down: os(a, "side") == Some("down"),
        gap: a.get("gap").filter(|g| g.is_object()).map(|g| (f(g, "x0"), f(g, "x1"))),
    }
}

fn acc_kind(s: &str) -> AccidentalKind {
    AccidentalKind::parse(s).unwrap_or_else(|| panic!("升降号种类 {s}"))
}

fn bar_spec(a: &Value) -> BarlineSpec {
    BarlineSpec {
        style: a.get("style").filter(|v| !v.is_null()).map(|v| serde_json::from_value(v.clone()).expect("小节线式样")),
        repeat_backward: b(a, "repeatBackward"),
        repeat_forward: b(a, "repeatForward"),
    }
}

fn harmony_segs(v: &Value) -> Vec<HarmonySeg> {
    v.as_array()
        .expect("分段")
        .iter()
        .map(|x| HarmonySeg {
            text: s(x, "text").to_string(),
            music: b(x, "music"),
            superscript: f(x, "superscript") as i8,
            dy: f(x, "dy"),
            scale: of(x, "scale"),
        })
        .collect()
}
fn harmony_json(segs: &[HarmonySeg]) -> Value {
    Value::Array(
        segs.iter()
            .map(|x| {
                let mut o = json!({ "text": x.text, "music": x.music, "superscript": x.superscript as f64, "dy": n(x.dy) });
                if let Some(sc) = x.scale {
                    o["scale"] = n(sc);
                }
                o
            })
            .collect(),
    )
}

fn key_name_json(k: &KeyName) -> Value {
    json!({ "letter": k.letter.to_string(), "alter": k.alter as f64 })
}

fn grace_json(g: &GraceGeom) -> Value {
    json!({
        "digits": g.digits.iter().map(|d| json!({ "text": d.text, "cx": n(d.cx), "cy": n(d.cy), "size": n(d.size) })).collect::<Vec<_>>(),
        "dots": g.dots.iter().map(|d| json!({ "cx": n(d.cx), "cy": n(d.cy), "r": n(d.r) })).collect::<Vec<_>>(),
        "accidentals": g.accidentals.iter().map(|d| json!({ "alter": d.alter.as_str(), "inkRight": n(d.ink_right), "inkCy": n(d.ink_cy), "inkHeight": n(d.ink_height) })).collect::<Vec<_>>(),
        "beams": g.beams.iter().map(|d| json!({ "x": n(d.x), "y": n(d.y), "w": n(d.w), "h": n(d.h) })).collect::<Vec<_>>(),
        "hook": g.hook.as_ref().map_or(Value::Null, |h| json!({ "m": h.m.iter().map(|x| n(*x)).collect::<Vec<_>>(), "c": h.c.iter().map(|x| n(*x)).collect::<Vec<_>>(), "width": n(h.width) })),
    })
}

// ── 一个用例 ──

fn run(kind: &str, a: &Value, env: &Env) -> Result<Value, String> {
    Ok(match kind {
        "dot" => node(el::dot::jp_dot(f(a, "cx"), f(a, "cy"), f(a, "r"), f(a, "color")), env),
        "octaveDot" => raw_upd(el::jpnumber::jp_octave_dot(f(a, "r"), f(a, "color")), env),
        "jpNumber" => {
            let mut it = el::jpnumber::jp_number(s(a, "text"), font(&a["font"]));
            if let Some(dolce_scene::Role::JpNumber { aug_dot_advance }) = &mut it.role {
                *aug_dot_advance = f(a, "augDotAdvance");
            }
            upd(&mut it, env);
            json!({
                "node": node(it.clone(), env),
                "left": n(el::jpnumber::jp_number_left(&it, env)),
                "right": n(el::jpnumber::jp_number_right(&it, env)),
                "cx": n(el::jpnumber::jp_number_cx(&it, env)),
                "numberPos": n(el::jpnumber::jp_number_pos(&it, env)),
                "bound": rect(el::jpnumber::jp_number_bound(&it, env)),
            })
        }
        "beamLine" => raw_upd(el::jpnumber::beam_line(f(a, "level"), f(a, "x0"), f(a, "x1"), f(a, "y"), f(a, "width"), f(a, "color")), env),
        "musicText" => node(el::prims::music_text(s(a, "glyphs"), font(&a["font"]), f(a, "color")), env),
        "musicInk" => rect(el::prims::music_ink(s(a, "glyphs"), &font(&a["font"]), b(a, "meta"), env)),
        "textItem" => node(el::prims::text_item(s(a, "str"), font(&a["font"]), f(a, "color"), f(a, "x"), f(a, "y"), b(a, "compress"), env), env),
        "lineItem" => node(el::prims::line_item(f(a, "x1"), f(a, "y1"), f(a, "x2"), f(a, "y2"), f(a, "lineWidth"), f(a, "color")), env),
        "fillRect" => node(el::prims::fill_rect(f(a, "color"), f(a, "x1"), f(a, "y1"), f(a, "w"), f(a, "h")), env),
        "strokePath" => node(el::prims::stroke_path(f(a, "color"), f(a, "lineWidth")), env),
        "breath" => raw_upd(el::breath::breath_path(f(a, "cx"), f(a, "baseline"), f(a, "H"), f(a, "lineWidth"), f(a, "color")), env),
        "dash" => {
            let st = el::dash::DashStyle { font: font(&a["font"]), color: f(a, "color") };
            raw_upd(el::dash::sustain_dash(f(a, "cx"), f(a, "cy"), &st, env), env)
        }
        "hairpin" => {
            let h = el::hairpin::HairpinSpec {
                x0: f(a, "x0"),
                x1: f(a, "x1"),
                y: f(a, "y"),
                half0: f(a, "half0"),
                half1: f(a, "half1"),
                line_width: f(a, "lineWidth"),
                color: f(a, "color"),
            };
            raw_upd(el::hairpin::hairpin_path(&h), env)
        }
        "hairpinNums" => {
            let (h0, h1) = el::hairpin::jp_hairpin_halves(b(a, "crescendo"), f(a, "inkHeight"), b(a, "openLeft"), b(a, "openRight"));
            json!({ "lineWidth": n(el::hairpin::jp_hairpin_line_width(f(a, "width"), f(a, "inkHeight"))), "halves": [n(h0), n(h1)] })
        }
        "arpeggio" => raw_upd(el::arpeggio::arpeggio_group(f(a, "x"), f(a, "top"), f(a, "bottom"), f(a, "size"), f(a, "color"), env), env),
        "names" => {
            let name = s(a, "name");
            let orn = el::jpglyph::ornament(name).map_or(Value::Null, |o| {
                json!({ "glyph": o.glyph, "placement": match o.placement { el::jpglyph::OrnamentPlacement::Above => "above", el::jpglyph::OrnamentPlacement::Below => "below" }, "scale": n(o.scale), "label": o.label })
            });
            let bm = el::jpglyph::barline_mark(name).map_or(Value::Null, |(text, glyph, label)| {
                let mut o = json!({ "label": label });
                if let Some(t) = text {
                    o["text"] = json!(t);
                }
                if let Some(g) = glyph {
                    o["glyph"] = json!(g);
                }
                o
            });
            json!({
                "artic": [el::articulation::artic_glyph(name, true), el::articulation::artic_glyph(name, false)],
                "dynamic": el::dynamics::dynamic_glyphs(name),
                "ornament": orn,
                "dynamics": el::jpglyph::dynamic(name),
                "barlineMark": bm,
                "accidentalGlyph": el::jpglyph::accidental_glyph(name),
                "accomp": el::jpglyph::is_accomp_bracket(name),
                "tremolo": el::jptremolo::jp_tremolo_count(&[name]) as f64,
                "slide": el::jpslide::jp_slide_of(&[name]).map(|u| if u { "up" } else { "down" }),
                "accidentalKind": el::accidental::accidental_kind_of(name).map(AccidentalKind::as_str),
            })
        }
        "names2" => {
            let names = strs(&a["names"]);
            json!({
                "tremolo": el::jptremolo::jp_tremolo_count(&names) as f64,
                "slide": el::jpslide::jp_slide_of(&names).map(|u| if u { "up" } else { "down" }),
            })
        }
        "tables" => {
            use el::jpglyph::bracket;
            let c = |u: u32| char::from_u32(u).unwrap().to_string();
            json!({
                "BRACKET": { "top": c(bracket::TOP), "bottom": c(bracket::BOTTOM), "brace": c(bracket::BRACE), "braceSmall": c(bracket::BRACE_SMALL) },
                "ornamentKeys": el::jpglyph::ORNAMENT_NAMES,
                "dynamicKeys": dolce_model::marknames::DYNAMIC_NAMES,
                "barlineKeys": ["fine", "dc", "ds", "ty", "hs", "sbf"],
                "accidentalKeys": ["flat", "natural", "sharp", "double-sharp", "double-flat"],
                "LYRIC_EDGE_PUNCT": dolce_text::syllable::lyric_edge_punct(),
            })
        }
        "tremolo" => {
            let (st, w) = el::jptremolo::jp_tremolo_strokes(f(a, "n") as usize, f(a, "H"));
            json!({
                "strokes": st.iter().map(|x| json!({ "x0": n(x.x0), "y0": n(x.y0), "x1": n(x.x1), "y1": n(x.y1), "thick": n(x.thick) })).collect::<Vec<_>>(),
                "width": n(w),
            })
        }
        "slide" => {
            let s = el::jpslide::jp_slide_arrow(b(a, "up"), f(a, "H"));
            json!({
                "x0": n(s.x0), "y0": n(s.y0), "x1": n(s.x1), "y1": n(s.y1),
                "arms": s.arms.iter().map(|p| json!([n(p[0]), n(p[1])])).collect::<Vec<_>>(),
                "lineWidth": n(s.line_width), "width": n(s.width),
            })
        }
        "stack" => {
            let st = &a["s"];
            let st = el::stack::StackStyle { gap: f(st, "gap"), dot_radius: f(st, "dotRadius"), beam_width: f(st, "beamWidth") };
            use el::stack::*;
            json!({
                "highDotY": n(high_dot_y(f(a, "inkTop"), f(a, "i"), &st)),
                "beamY": n(beam_y(f(a, "inkBottom"), f(a, "level"), &st)),
                "beamsBottom": n(beams_bottom(f(a, "inkBottom"), f(a, "n"), &st)),
                "lowDotY": n(low_dot_y(f(a, "inkBottom"), f(a, "beams"), f(a, "i"), &st)),
                "stackTop": n(stack_top(f(a, "inkTop"), f(a, "oct"), &st)),
                "stackBottom": n(stack_bottom(f(a, "inkBottom"), f(a, "beams"), f(a, "lowDots"), &st)),
            })
        }
        "augdot" => {
            let d = &a["digit"];
            let r = Rect::new(num(&d[0]), num(&d[1]), num(&d[2]), num(&d[3]));
            let (cx, cy) = el::augdot::aug_dot_center(&r, f(a, "i"), f(a, "r"), f(a, "gap"));
            json!({ "center": { "cx": n(cx), "cy": n(cy) }, "reach": n(el::augdot::aug_dots_reach(f(a, "n"), f(a, "r"), f(a, "gap"))) })
        }
        "beatgroup" => {
            use dolce_model::beatgroup::*;
            let (bt, ty) = (f(a, "beats"), f(a, "beatType"));
            let offs = [(1.0, 0.5, false, None), (1.0, 0.5, true, Some(0.5)), (1.0, 1.0, false, None), (0.75, 0.25, true, Some(0.5)), (1.0, 0.25, true, None)];
            let idx = [(0.0, 0.0, 0.25), (0.3, 0.1, 0.25), (0.75, 0.25, 0.375), (1.5, 0.0, 0.5)];
            json!({
                "size": n(beat_group_size(bt, ty)),
                "offsets": offs.iter().map(|&(e, ac, l, nx)| n(pickup_offset(e, ac, l, nx))).collect::<Vec<_>>(),
                "index": idx.iter().map(|&(p, o, z)| n(beat_group_index(p, o, z))).collect::<Vec<_>>(),
            })
        }
        "accidental" => {
            let d = &a["digit"];
            let digit = DigitRef { font: font(&d["font"]), text: s(d, "text").to_string(), x: f(d, "x"), y: f(d, "y"), scale: of(d, "scale") };
            let st = &a["style"];
            let style = AccidentalStyle {
                music: font(&st["music"]),
                color: f(st, "color"),
                meta: b(st, "meta"),
                kind: AccidentalStyleKind::parse(os(st, "kind").unwrap_or("csym")),
                scale: of(st, "scale"),
            };
            let g = AccidentalGlyph::new(acc_kind(s(a, "kind")), &digit, &style, env);
            json!({ "item": node(g.item, env), "box": rect(g.box_) })
        }
        "accidentalNums" => {
            let k = acc_kind(s(a, "kind"));
            json!({
                "lead": n(el::accidental::accidental_lead(k, f(a, "h"), f(a, "scale"))),
                "rise": n(el::accidental::accidental_rise(k, f(a, "h"), f(a, "scale"))),
            })
        }
        "slur" | "tie" => {
            let st = slur_style(&a["style"]);
            let id = |k: &str| a.get(k).and_then(Value::as_f64).map(|x| x as u32);
            let kind = if kind == "slur" { ArcKind::Slur } else { ArcKind::Tie { start_id: id("startId"), end_id: id("endId") } };
            node(el::arc::slur_tie(kind, pt(&a["pl"]), pt(&a["pr"]), &st, env), env)
        }
        "arcNums" => {
            let st = slur_style(&a["style"]);
            let (pl, pr) = (pt(&a["pl"]), pt(&a["pr"]));
            let dist = (pr.x - pl.x).abs();
            let (c1, c2, h) = el::arc::calc_slur_points(pl, pr, &st);
            json!({
                "height": n(el::arc::arc_height(dist, &st)),
                "rise": n(el::arc::arc_rise(dist, &st)),
                "points": [p2(c1), p2(c2), n(h)],
                "jpArcY": n(el::arc::jp_arc_y(pl.y, pr.y, st.thickness)),
            })
        }
        "arcClear" => {
            let obs: Vec<ArcObstacle> = a["obstacles"].as_array().unwrap().iter().map(|o| ArcObstacle { x: f(o, "x"), y: f(o, "y") }).collect();
            n(el::arc::arc_clear_shift(f(a, "x0"), f(a, "y0"), f(a, "x1"), f(a, "y1"), f(a, "rise"), b(a, "above"), &obs, f(a, "gap")))
        }
        "barline" => {
            let spec = bar_spec(&a["spec"]);
            let st = &a["style"];
            let style = BarlineStyle {
                top: f(st, "top"),
                bot: f(st, "bot"),
                light: f(st, "light"),
                heavy: f(st, "heavy"),
                gap: of(st, "gap"),
                dot_radius: of(st, "dotRadius"),
                dots: ob(st, "dots"),
                color: f(st, "color"),
            };
            let fin = b(a, "final");
            let g = BarlineGlyph::new(&spec, fin, &style);
            let (il, ir) = (g.ink_left(), g.ink_right());
            json!({
                "items": nodes(g.items, env),
                "lines": g.lines.iter().map(|&i| i as f64).collect::<Vec<_>>(),
                "width": n(g.width),
                "isPlain": g.is_plain,
                "inkLeft": n(il),
                "inkRight": n(ir),
                "widths": el::barline::barline_widths(&spec, fin, style.light, style.heavy).into_iter().map(n).collect::<Vec<_>>(),
            })
        }
        "chordSegs" => harmony_json(&el::chord::chord_text_segs(s(a, "text"), b(a, "plain"), AccidentalSide::parse(os(a, "side")))),
        "harmony" => {
            let segs = harmony_segs(&a["segs"]);
            let (wf, mf) = (font(&a["wordFont"]), font(&a["musicFont"]));
            json!({
                "width": n(el::chord::harmony_width(&segs, &wf, &mf, env)),
                "ink": orect(el::chord::harmony_ink(&segs, &wf, &mf, env)),
                "node": node(el::chord::layout_harmony_segs(&segs, &wf, &mf, f(a, "color"), env), env),
            })
        }
        "endingText" => json!(el::ending::norm_ending_text(s(a, "text"))),
        "endingNums" => {
            let (sz, lw, foot) = (f(a, "size"), f(a, "lineWidth"), f(a, "bracketFoot"));
            json!({
                "labelBaseline": n(el::ending::label_baseline(&font(&a["font"]), s(a, "text"), lw, env)),
                "labelBaselineOf": n(el::ending::label_baseline_of(f(a, "inkTop"), sz, lw)),
                "endingDrop": n(el::ending::ending_drop(foot, sz)),
                "endingLabelDx": n(el::ending::ending_label_dx(lw, sz, foot)),
            })
        }
        "ending" => {
            let br = EndingBracket {
                x0: f(a, "x0"),
                x1: f(a, "x1"),
                top: f(a, "top"),
                drop: f(a, "drop"),
                left_foot: b(a, "leftFoot"),
                right_foot: b(a, "rightFoot"),
                line_width: f(a, "lineWidth"),
                color: f(a, "color"),
                label: a.get("label").map(|l| EndingLabel { text: s(l, "text").to_string(), font: font(&l["font"]), dx: f(l, "dx") }),
                classes: a.get("classes").map(|c| (s(c, "line").to_string(), s(c, "label").to_string())),
            };
            let mut g = Node::group();
            let lab = el::ending::add_ending_bracket(&mut g, &br, env);
            json!({ "g": node(g, env), "label": lab.map(|i| i as f64) })
        }
        "grace" => {
            let mj = &a["m"];
            let m = GraceMetrics {
                ink: f(mj, "ink"),
                scale: f(mj, "scale"),
                octave_up_y: f(mj, "octaveUpY"),
                octave_down_y: f(mj, "octaveDownY"),
                octave_dot_gap: f(mj, "octaveDotGap"),
                octave_dot_radius: f(mj, "octaveDotRadius"),
                underline_gap: f(mj, "underlineGap"),
                stack_gap: f(mj, "stackGap"),
            };
            let notes: Vec<GraceNote> = a["notes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| GraceNote { digit: s(x, "digit").to_string(), octave: f(x, "octave"), duration: of(x, "duration"), alter: os(x, "alter").map(acc_kind) })
                .collect();
            let g = el::grace::grace_geometry(&notes, &m, f(a, "x"), f(a, "baseline"), f(a, "dir"), f(a, "fontSize"), of(a, "centerY"));
            let (hm, hc) = el::grace::grace_hook(f(a, "x"), f(a, "baseline"), m.ink, f(a, "dir"));
            json!({
                "geom": grace_json(&g),
                "bottom": n(el::grace::grace_bottom(&g, &m)),
                "advance": n(el::grace::grace_advance(&notes, &m)),
                "hook": { "m": hm.iter().map(|x| n(*x)).collect::<Vec<_>>(), "c": hc.iter().map(|x| n(*x)).collect::<Vec<_>>() },
            })
        }
        "header" => {
            let hf: Option<dolce_style::header::HeaderFont> = a.get("hf").map(|v| serde_json::from_value(v.clone()).expect("页眉字体"));
            let fo = el::header::header_role_font(hf.as_ref(), f(a, "size"), &font(&a["base"]));
            json!({ "family": fo.family, "size": n(fo.size), "bold": fo.bold, "italic": fo.italic })
        }
        "keyFifths" => key_name_json(&el::keysig::key_name_of_fifths(f(a, "fifths"))),
        "keyName" => el::keysig::key_name_of(s(a, "text")).as_ref().map_or(Value::Null, key_name_json),
        "keyLabel" => {
            let nm = &a["name"];
            let name = KeyName { letter: s(nm, "letter").chars().next().unwrap_or('C'), alter: f(nm, "alter") as i8 };
            let st = &a["style"];
            let style = KeyLabelStyle {
                font: font(&st["font"]),
                music: font(&st["music"]),
                color: f(st, "color"),
                prefix: os(st, "prefix").map(str::to_string),
                side: AccidentalSide::parse(os(st, "side")),
                classes: strs(&st["classes"]).into_iter().map(str::to_string).collect(),
                eq_pad: of(st, "eqPad"),
            };
            let k = KeyLabel::new(s(a, "tonic"), &name, &style, env);
            let bx = k.box_();
            json!({
                "items": nodes(k.items, env),
                "width": n(k.width), "eqInkRight": n(k.eq_ink_right), "nameInkLeft": n(k.name_ink_left), "inkRight": n(k.ink_right),
                "box": rect(bx),
            })
        }
        "timeSig" => {
            let st = &a["style"];
            let style = TimeSigStyle {
                height: f(st, "height"),
                center_y: f(st, "centerY"),
                rule_width: f(st, "ruleWidth"),
                color: f(st, "color"),
                font: font(&st["font"]),
                digit_ratio: of(st, "digitRatio"),
                rule_length_ratio: of(st, "ruleLengthRatio"),
            };
            let (bt, ty) = (f(a, "beats"), f(a, "beatType"));
            let g = TimeSigGlyph::new(bt, ty, &style, env);
            let bx = g.box_();
            let w = g.width;
            json!({
                "items": nodes(g.items, env), "rule": 2.0, "width": n(w), "box": rect(bx),
                "w": n(el::timesig::time_sig_width(bt, ty, style.height, style.digit_ratio, style.rule_length_ratio)),
            })
        }
        "lyric" => {
            let mut it = el::syllable::lyric(s(a, "text"), font(&a["font"]), CompressMode::parse(s(a, "compress")), f(a, "verse"));
            upd(&mut it, env);
            json!({
                "node": node(it.clone(), env),
                "leadWidth": n(el::syllable::lyric_lead_width(&it)),
                "left": n(el::syllable::lyric_left(&it)),
                "right": n(el::syllable::lyric_right(&it)),
                "tailBlank": n(el::syllable::lyric_tail_blank(&it, env)),
                "headBlank": n(el::syllable::lyric_head_blank(&it, env)),
            })
        }
        "wordBreak" => json!(el::syllable::latin_word_break(s(a, "prev"), s(a, "next"))),
        "sectionRun" => {
            let (w, xs) = el::sectionword::section_word_run(&font(&a["font"]), s(a, "text"), CompressMode::parse(s(a, "mode")), env);
            json!({ "width": n(w), "xs": xs.map(|v| v.into_iter().map(n).collect::<Vec<_>>()) })
        }
        "sectionHang" => n(el::sectionword::section_word_hang_left(of(a, "barLeft"))),
        "section" => {
            let g = SectionWordGeom {
                anchor_x: f(a, "anchorX"),
                width: f(a, "width"),
                size: f(a, "size"),
                gap: of(a, "gap"),
                base_y: f(a, "baseY"),
                chords: a["chords"].as_array().unwrap().iter().map(|c| SectionChord { x0: f(c, "x0"), x1: f(c, "x1"), y: f(c, "y") }).collect(),
                bar_left: f(a, "barLeft"),
                bar_right: f(a, "barRight"),
                hang_left: f(a, "hangLeft"),
                right_limit: f(a, "rightLimit"),
                at_line_start: b(a, "atLineStart"),
                straddle: b(a, "straddle"),
                own_chord_right: of(a, "ownChordRight"),
            };
            let r = el::sectionword::place_section_word(&g);
            json!({ "x": n(r.x), "lifted": r.lifted, "shortfall": n(r.shortfall) })
        }
        "tupletDigits" => json!(el::tuplet::tuplet_digits(f(a, "n"))),
        "tuplet" => {
            let st = &a["style"];
            let style = TupletStyle {
                kind: TupletKind::parse(s(st, "kind")),
                color: f(st, "color"),
                music: font(&st["music"]),
                meta: b(st, "meta"),
                line_width: of(st, "lineWidth"),
                foot: of(st, "foot"),
                gap_pad: of(st, "gapPad"),
                arc: st.get("arc").map(slur_style),
            };
            let g = TupletGlyph::new(pt(&a["p0"]), pt(&a["p1"]), f(a, "n"), &style, env);
            json!({ "items": nodes(g.items, env), "halfGap": n(g.half_gap), "lineTop": n(g.line_top), "numBox": rect(g.num_box) })
        }
        "upperBand" => {
            let arr = a["items"].as_array().unwrap();
            let items: Vec<BandItem> = arr
                .iter()
                .map(|it| BandItem {
                    key: f(it, "key") as usize,
                    x0: f(it, "x0"),
                    x1: f(it, "x1"),
                    top: f(it, "top"),
                    bottom: f(it, "bottom"),
                    layer: f(it, "layer"),
                    rank: of(it, "rank"),
                    kind: os(it, "kind").map(str::to_string),
                    spread: os(it, "spread").map(str::to_string),
                    top_at: it.get("topAt").map(|t| {
                        let (c, sl) = (num(&t[0]), num(&t[1]));
                        Box::new(move |x0: f64, x1: f64| c + sl * (x0 + x1) / 2.0) as Box<dyn Fn(f64, f64) -> f64>
                    }),
                    gap_scale: of(it, "gapScale"),
                    skip_kinds: strs(&it["skipKinds"]).into_iter().map(str::to_string).collect(),
                })
                .collect();
            let dy = el::upperband::stack_upper_band(&items, f(a, "gap"));
            let lifted: Vec<BandItem> = items
                .iter()
                .map(|it| {
                    let d = dy[&it.key];
                    BandItem { key: it.key, x0: it.x0, x1: it.x1, top: it.top + d, bottom: it.bottom + d, layer: it.layer, rank: None, kind: None, spread: None, top_at: None, gap_scale: None, skip_kinds: vec![] }
                })
                .collect();
            let bt = |x0, x1| on(el::upperband::band_top(&lifted, x0, x1));
            json!({ "dy": items.iter().map(|it| n(dy[&it.key])).collect::<Vec<_>>(), "bandTop": [bt(0.0, 100.0), bt(100.0, 250.0), bt(500.0, 600.0)] })
        }
        _ => return Err(format!("认不出的用例种类 {kind}")),
    })
}

pub fn engrave_check(args: &[String]) -> i32 {
    let pos = positional(args);
    let (Some(path), Some(mpath)) = (pos.first(), pos.get(1)) else {
        eprintln!("用法：dolce engrave-check <cases.jsonl> <measure.jsonl> [--redist=<目录>] [--show=N]");
        return 2;
    };
    let redist = std::path::PathBuf::from(flag(args, "redist").unwrap_or("public/redist"));
    let meta = MetaData::from_json(&std::fs::read_to_string(redist.join("bravura_metadata.json")).expect("读 SMuFL 元数据")).expect("SMuFL 元数据");
    let backend = ReplayMeasurer::from_jsonl(&std::fs::read_to_string(mpath).expect("读量字录制")).expect("量字录制").with_path_fallback();
    let mc = MeasureCtx::new(&backend);
    let env = Env { mc: &mc, meta: Some(&meta) };
    let show = show_n(args);
    let mut by_kind: BTreeMap<String, (usize, usize, f64)> = BTreeMap::new();
    let mut shown = 0;
    let mut max_all: f64 = 0.0;
    for l in lines(path) {
        let case: Value = serde_json::from_str(&l).unwrap_or_else(|e| panic!("{path} 读不进：{e}"));
        let kind = case["kind"].as_str().unwrap_or("?").to_string();
        let key = case["key"].as_str().unwrap_or("?").to_string();
        let got = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&kind, &case["a"], &env))).unwrap_or_else(|p| {
            Err(format!("panic：{}", p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()))
        });
        let mut d = Diff { skeleton: vec![], max_num: 0.0, num_over: vec![] };
        match (&got, case.get("error").and_then(Value::as_str), case.get("expect")) {
            (Ok(v), None, Some(want)) => diff("", &canon(want), v, &mut d),
            (Err(e), Some(want), _) => {
                // TS 抛的是 JS 运行时报错原文，Rust 报自己的；两边都报错即算一致
                let _ = (e, want);
            }
            (Ok(v), Some(want), _) => d.skeleton.push(format!("TS 报错「{want}」，Rust 得 {}", short(Some(v)))),
            (Err(e), None, _) => d.skeleton.push(format!("Rust 报错：{e}")),
            (Ok(_), None, None) => d.skeleton.push("用例缺 expect".into()),
        }
        let e = by_kind.entry(kind.clone()).or_default();
        e.0 += 1;
        e.2 = e.2.max(d.max_num);
        max_all = max_all.max(d.max_num);
        if !d.skeleton.is_empty() || !d.num_over.is_empty() {
            e.1 += 1;
            if shown < show {
                shown += 1;
                println!("✗ [{kind}] {key}（骨架 {} 处、超差 {} 处）", d.skeleton.len(), d.num_over.len());
                for x in d.skeleton.iter().chain(d.num_over.iter()).take(12) {
                    println!("    {x}");
                }
            }
        }
    }
    let misses = backend.misses();
    for m in misses.iter().take(10) {
        println!("  缺键：{m}");
    }
    let (mut total, mut bad) = (0, 0);
    for (k, (t, b, m)) in &by_kind {
        total += t;
        bad += b;
        println!("{k:<16} {t:>5} 例  不一致 {b:>4}  最大数差 {m:e}");
    }
    println!(
        "合计 {total} 例，不一致 {bad}；最大数差 {max_all:e}；量字缺键 {}、路径盒现算 {}",
        misses.len(),
        backend.path_fallbacks()
    );
    i32::from(bad > 0 || !misses.is_empty())
}
