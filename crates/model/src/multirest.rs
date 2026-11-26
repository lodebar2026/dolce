//! 多小节休止（`MeasureAttrs.multiRest`）在**谱面上**并成一个小节（同 `src/model/multirest.ts`）。
//! 模型里那 n 个小节一个不少，只有排版视图先过这一道；并不了的照常排、`multiRest` 摘掉免得误画。

use crate::doc::*;
use crate::helpers::break_after;
use std::borrow::Cow;
use std::collections::HashMap;

/// 整小节都是休止、没挂别的东西（第一个小节可以带记号与文字）
fn rest_only(m: &Measure, head: bool) -> bool {
    !m.elements.is_empty()
        && m.elements.iter().all(|el| match el {
            Element::Chord(c) => {
                c.rest.is_some()
                    && c.grace.is_none()
                    && c.lyrics.as_ref().is_none_or(|l| l.is_empty())
                    && c.sustains.as_ref().is_none_or(|s| s.is_empty())
                    && (head
                        || (c.notations.is_none()
                            && c.ornaments.as_ref().is_none_or(|o| o.is_empty())
                            && c.section_word.as_deref().is_none_or(str::is_empty)
                            && c.harmony.is_none()))
            }
            Element::Space(_) => false,
        })
}

/// 并好的歌（没有可并的原样借出；有的拷一份，不动原件）。多声部要各声部同一串都是休止才并。
pub fn compress_multi_rests(song: &Song) -> Cow<'_, Song> {
    let Some(lead) = song.parts.first() else { return Cow::Borrowed(song) };
    if !lead.measures.iter().any(|m| m.attrs.as_ref().and_then(|a| a.multi_rest).is_some_and(|n| n != 0.0 && !n.is_nan())) {
        return Cow::Borrowed(song);
    }
    let len = lead.measures.len();
    let mut keep = vec![true; len];
    let mut runs: HashMap<usize, usize> = HashMap::new(); // 首小节下标 → n
    let mut i = 0usize;
    while i < len {
        let n = lead.measures[i].attrs.as_ref().and_then(|a| a.multi_rest).unwrap_or(0.0);
        if n.is_nan() || n < 2.0 || i as f64 + n > len as f64 {
            i += 1;
            continue;
        }
        // n 是整数时 j 走 i..i+n；小数时 `j < i + n` 多走到 ceil
        let end = (i as f64 + n).ceil() as usize;
        let ok = song.parts.iter().all(|p| {
            for j in i..end {
                let Some(x) = p.measures.get(j) else { return false };
                if !rest_only(x, j == i) {
                    return false;
                }
                if j > i
                    && (x.attrs.is_some()
                        || x.later_attrs.as_ref().is_some_and(|l| !l.is_empty())
                        || x.print.as_ref().is_some_and(|p| p.new_system == Some(true) || p.new_page == Some(true))
                        || x.directions.as_ref().is_some_and(|d| !d.is_empty())
                        || x.barlines.iter().flatten().any(|b| b.location == BarLocation::Left))
                {
                    return false;
                }
                if (j as f64) < i as f64 + n - 1.0
                    && (break_after(p, j).is_some()
                        || x.barlines.iter().flatten().any(|b| {
                            b.location == BarLocation::Right
                                && (b.style != Some(BarStyle::Regular)
                                    || b.repeat.is_some()
                                    || b.ending.is_some()
                                    || b.ornaments.as_ref().is_some_and(|o| !o.is_empty()))
                        }))
                {
                    return false;
                }
            }
            true
        });
        if !ok {
            i += 1;
            continue;
        }
        runs.insert(i, end - i);
        for k in keep.iter_mut().take(end).skip(i + 1) {
            *k = false;
        }
        i = end;
    }
    let mut out = song.clone();
    for p in &mut out.parts {
        let src = std::mem::take(&mut p.measures);
        let last_rights: HashMap<usize, Vec<Barline>> = runs
            .iter()
            .map(|(&i, &n)| (i, src.get(i + n - 1).map(|l| l.barlines.iter().flatten().filter(|b| b.location == BarLocation::Right).cloned().collect()).unwrap_or_default()))
            .collect();
        for (i, mut m) in src.into_iter().enumerate() {
            if !keep.get(i).copied().unwrap_or(false) {
                continue;
            }
            match runs.get(&i) {
                None => {
                    if let Some(a) = &mut m.attrs {
                        if a.multi_rest.is_some_and(|n| n != 0.0 && !n.is_nan()) {
                            a.multi_rest = None;
                        }
                    }
                }
                Some(&n) => {
                    let a = m.attrs.get_or_insert_with(MeasureAttrs::default);
                    a.multi_rest = Some(n as f64);
                    m.elements.truncate(1);
                    let mut bl: Vec<Barline> = m.barlines.take().unwrap_or_default().into_iter().filter(|b| b.location != BarLocation::Right).collect();
                    bl.extend(last_rights[&i].iter().cloned());
                    m.barlines = Some(bl);
                }
            }
            p.measures.push(m);
        }
    }
    Cow::Owned(out)
}
