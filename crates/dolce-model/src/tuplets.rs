//! 多连音的时值（同 `src/model/tuplets.ts`）：组内各音的 `duration.timeMod` 一律按 `tuplet` Mark 补，各解析端收尾时都调这一份。
//! 组内**所有**占时值的元素（音符、休止）都按比例折算，倚音不算；多连音嵌套时比例相乘。

use crate::doc::*;
use dolce_base::js::{self, NumKey};
use std::collections::HashMap;

/// 默认比例：n 连音占不大于 n 的最大 2 的幂（3→2、5/6/7→4）；二连音、四连音占 3。同 123 §4.1
pub fn default_tuplet_normal(actual: f64) -> f64 {
    if actual == 2.0 || actual == 4.0 {
        return 3.0;
    }
    2f64.powf(js::max(1.0, actual - 1.0).log2().floor())
}

/// 缺省的比例：Mark 上写的显示数字，没写按组内音数 n、`default_tuplet_normal`
pub fn default_ratio(mk: &Mark, n: usize) -> (f64, f64) {
    let actual = mk.tuplet_actual.unwrap_or(n as f64);
    (actual, mk.tuplet_normal.unwrap_or_else(|| default_tuplet_normal(actual)))
}

/// 按 `marks` 里的 tuplet 给 `seq`（同一声部流里按谱面先后排的元素）中组内各音写 `timeMod`。
/// 只认起止都落在 `seq` 里的组。`ratio` 定一组的比例 `(actual, normal)`。
pub fn apply_tuplet_time_mods(marks: &[Mark], seq: &mut [&mut Element], ratio: impl Fn(&Mark, usize) -> (f64, f64)) {
    let mut pos: HashMap<ElementId, usize> = HashMap::new();
    for (i, el) in seq.iter().enumerate() {
        pos.insert(el.id(), i);
    }
    let timed = |el: &Element| matches!(el, Element::Chord(c) if c.grace.is_none());
    let mut acc: HashMap<ElementId, (f64, f64)> = HashMap::new();
    for mk in marks {
        if mk.kind != MarkType::Tuplet || mk.collapsed == Some(true) {
            continue;
        }
        let (Some(&s), Some(&e)) = (pos.get(&mk.start), pos.get(&mk.end)) else { continue };
        if e < s {
            continue;
        }
        // 同一小节里别的声部（ABC `&` 分支）排在本声部之后：只认与起点同声部的
        let voice = NumKey::new(seq[s].voice());
        let members: Vec<ElementId> =
            seq[s..=e].iter().filter(|el| timed(el) && NumKey::new(el.voice()) == voice).map(|el| el.id()).collect();
        if members.is_empty() {
            continue;
        }
        let (ra, rn) = ratio(mk, members.len());
        for id in members {
            let a = acc.get(&id).copied().unwrap_or((1.0, 1.0));
            acc.insert(id, (a.0 * ra, a.1 * rn));
        }
    }
    for el in seq.iter_mut() {
        let id = el.id();
        let Some(&(actual, normal)) = acc.get(&id) else { continue };
        if let Element::Chord(c) = &mut **el {
            let normal_type = c.duration.time_mod.as_ref().and_then(|t| t.normal_type.clone());
            c.duration.time_mod = Some(TimeMod { actual, normal, normal_type });
        }
    }
}

/// `ratio` 用缺省口径的 [`apply_tuplet_time_mods`]
pub fn apply_tuplet_time_mods_default(marks: &[Mark], seq: &mut [&mut Element]) {
    apply_tuplet_time_mods(marks, seq, default_ratio)
}
