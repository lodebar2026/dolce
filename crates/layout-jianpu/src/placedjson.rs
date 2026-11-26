//! 定位结构的规范化 JSON（对拍用，TS 那份在 `src/cli/layoutref.ts::placedJson`，两边同一口径）：
//!
//! ```text
//! score: {pages:[P], contentBottom, contentRight}
//! P: {song, firstOfSong, titlePage, natural|null, headers:[[song,dy]]|null, groups:[G]}
//! G: {system, textY, braceTop, braceBottom, hasBrace, braceFromX|null, song, voices:[V]}
//! V: {y, top, textTop|null, bottom|null, lyricY:[..], items:[I], underlines:[U], marks:[M], layers:[L], band:[T]}
//! I: {i, s, x, a, b, n, e:元素, id|null, dy|null, nb, syl:[null | [text, trailingPunctuation|null, owner|null]]}
//! U: [level, x0, x1, dy|null]
//! M: {mark, x0, x1, y|null, flat, below, level, ol, or, dy|null, ends, sid|null, eid|null}
//! L: {at, items:[I], underlines:[U], y|null, split: null | {dy, braceLeftX|null, braceRightX|null, braceTop, braceBottom, marks:[M], band:[T]|null}}
//! T: {k, at, text, face, size, x, y, ink:[l,t,r,b], xs|null, boxed, bold}
//! ```
//! 非有限数写成 `"NaN"` / `"Inf"` / `"-Inf"`。

use serde_json::{json, Value};

use crate::model::{PlacedItem, PlacedMark, PlacedScore, PlacedText, PlacedUnderline};

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

fn oid(x: Option<i64>) -> Value {
    x.map_or(Value::Null, |v| json!(v))
}

fn item(it: &PlacedItem) -> Value {
    json!({
        "i": it.index,
        "s": it.src_index,
        "x": n(it.x),
        "a": n(it.advance),
        "b": n(it.beat),
        "n": n(it.beats),
        "e": serde_json::to_value(&it.element).expect("元素可序列化"),
        "id": oid(it.id),
        "dy": on(it.dy),
        "nb": it.no_barline,
        "syl": it.syllables.iter().map(|s| match s {
            None => Value::Null,
            Some(s) => json!([s.syl.text, s.syl.trailing_punctuation, oid(s.owner)]),
        }).collect::<Vec<_>>(),
    })
}

fn ul(u: &PlacedUnderline) -> Value {
    json!([n(u.level), n(u.x0), n(u.x1), on(u.dy)])
}

fn mark(m: &PlacedMark) -> Value {
    json!({
        "mark": serde_json::to_value(&m.mark).expect("记号可序列化"),
        "x0": n(m.x0),
        "x1": n(m.x1),
        "y": on(m.y),
        "flat": m.flat,
        "below": m.below,
        "level": n(m.level),
        "ol": m.open_left,
        "or": m.open_right,
        "dy": on(m.dy),
        "ends": m.has_ends,
        "sid": oid(m.start_id),
        "eid": oid(m.end_id),
    })
}

fn text(t: &PlacedText) -> Value {
    json!({
        "k": t.kind.as_str(),
        "at": t.at,
        "text": t.text,
        "face": t.face.as_str(),
        "size": n(t.size),
        "x": n(t.x),
        "y": n(t.y),
        "ink": [n(t.ink.left), n(t.ink.top), n(t.ink.right), n(t.ink.bottom)],
        "xs": t.xs.as_ref().map_or(Value::Null, |xs| Value::Array(xs.iter().map(|x| n(*x)).collect())),
        "boxed": t.boxed,
        "bold": t.bold,
    })
}

fn arr<T>(xs: &[T], f: impl Fn(&T) -> Value) -> Value {
    Value::Array(xs.iter().map(f).collect())
}

/// `PlacedScore` → 规范化 JSON
pub fn placed_json(p: &PlacedScore) -> Value {
    let pages = arr(&p.pages, |pg| {
        json!({
            "song": pg.song,
            "firstOfSong": pg.first_of_song,
            "titlePage": pg.title_page,
            "natural": on(pg.natural),
            "headers": pg.headers.as_ref().map_or(Value::Null, |h| arr(h, |(s, dy)| json!([s, n(*dy)]))),
            "groups": arr(&pg.groups, |g| json!({
                "system": n(g.group.system),
                "textY": n(g.text_y),
                "braceTop": n(g.brace_top),
                "braceBottom": n(g.brace_bottom),
                "hasBrace": g.has_brace,
                "braceFromX": on(g.brace_from_x),
                "song": g.song,
                "voices": arr(&g.voices, |v| json!({
                    "y": n(v.y),
                    "top": n(v.top),
                    "textTop": on(v.text_top),
                    "bottom": on(v.bottom),
                    "lyricY": arr(&v.lyric_y, |y| n(*y)),
                    "items": arr(&v.items, item),
                    "underlines": arr(&v.underlines, ul),
                    "marks": arr(&v.marks, mark),
                    "layers": arr(&v.layers, |l| json!({
                        "at": l.at,
                        "items": arr(&l.items, item),
                        "underlines": arr(&l.underlines, ul),
                        "y": on(l.y),
                        "split": l.split.as_ref().map_or(Value::Null, |s| json!({
                            "dy": n(s.dy),
                            "braceLeftX": on(s.brace_left_x),
                            "braceRightX": on(s.brace_right_x),
                            "braceTop": n(s.brace_top),
                            "braceBottom": n(s.brace_bottom),
                            "marks": arr(&s.marks, mark),
                            "band": s.band.as_ref().map_or(Value::Null, |b| arr(b, text)),
                        })),
                    })),
                    "band": arr(&v.band, text),
                })),
            })),
        })
    });
    json!({ "pages": pages, "contentBottom": n(p.content_bottom), "contentRight": n(p.content_right) })
}
