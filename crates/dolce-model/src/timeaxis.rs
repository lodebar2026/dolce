//! 各声部**共用的时间轴**（试听、演唱顺序、导出 MusicXML 共用）：轴上一格是一小节，
//! 各声部的小节按「组号 + 组内第几小节」落格。组号取 `Measure.print.system`；有声部的首小节没有它就按小节序号一一对应。

use crate::doc::*;
use crate::helpers::hidden_rest;
use std::borrow::Cow;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub struct AxisGroup {
    pub start: usize,
    pub length: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TimeAxis {
    /// 轴上一共几格
    pub length: usize,
    /// 各声部第 i 小节落在轴上第几格
    pub slot: Vec<Vec<usize>>,
    /// 轴上第 s 格是各声部的第几小节；没有为 -1
    pub local: Vec<Vec<isize>>,
    /// 各组在轴上从第几格起、占几格
    pub groups: Vec<AxisGroup>,
    /// 是不是按组排的
    pub grouped: bool,
}

/// 组号的比较键（组号是 f64，按数值排）
#[derive(Clone, Copy, Debug, PartialEq)]
struct Sys(f64);
impl Eq for Sys {}
impl PartialOrd for Sys {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Sys {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        self.0.partial_cmp(&o.0).unwrap_or(std::cmp::Ordering::Equal)
    }
}

/// 由各声部各小节的组号排时间轴。
pub fn axis_of(systems: &[Vec<Option<f64>>]) -> TimeAxis {
    let grouped = systems.len() > 1 && systems.iter().all(|s| s.is_empty() || s[0].is_some());
    if !grouped {
        let length = systems.iter().map(|s| s.len()).max().unwrap_or(0);
        let slot = systems.iter().map(|s| (0..s.len()).collect()).collect();
        let local = systems.iter().map(|s| (0..length).map(|i| if i < s.len() { i as isize } else { -1 }).collect()).collect();
        return TimeAxis { length, slot, local, groups: vec![AxisGroup { start: 0, length }], grouped };
    }
    let at: Vec<Vec<(f64, usize)>> = systems
        .iter()
        .map(|s| {
            let mut sys = s.first().copied().flatten().unwrap_or(0.0);
            let mut k: isize = -1;
            s.iter()
                .map(|v| {
                    if let Some(v) = *v {
                        if v != sys {
                            sys = v;
                            k = -1;
                        }
                    }
                    k += 1;
                    (sys, k as usize)
                })
                .collect()
        })
        .collect();
    // 组号按数值排（JS 的数组 sort((a,b)=>a-b)；NaN 组号不会出现）
    let mut size: BTreeMap<Sys, usize> = BTreeMap::new();
    for part in &at {
        for &(sys, k) in part {
            let e = size.entry(Sys(sys)).or_insert(0);
            *e = (*e).max(k + 1);
        }
    }
    let mut start: BTreeMap<Sys, usize> = BTreeMap::new();
    let mut groups = vec![];
    let mut length = 0;
    for (sys, n) in &size {
        start.insert(*sys, length);
        groups.push(AxisGroup { start: length, length: *n });
        length += n;
    }
    let slot: Vec<Vec<usize>> = at.iter().map(|part| part.iter().map(|&(sys, k)| start[&Sys(sys)] + k).collect()).collect();
    let local = slot
        .iter()
        .map(|s| {
            let mut out = vec![-1isize; length];
            for (i, &g) in s.iter().enumerate() {
                out[g] = i as isize;
            }
            out
        })
        .collect();
    TimeAxis { length, slot, local, groups, grouped }
}

/// 一首的时间轴（按 `Song.parts` 的次序）。
pub fn axis_of_song(song: &Song) -> TimeAxis {
    let systems: Vec<Vec<Option<f64>>> =
        song.parts.iter().map(|p| p.measures.iter().map(|m| m.print.as_ref().and_then(|pr| pr.system)).collect()).collect();
    axis_of(&systems)
}

/// 一个声部的小节按轴摊开：没有小节的格为 None。
pub fn spread_on_axis<T: Clone>(items: &[T], slots: &[usize], length: usize) -> Vec<Option<T>> {
    let mut out = vec![None; length];
    for (i, it) in items.iter().enumerate() {
        out[slots[i]] = Some(it.clone());
    }
    out
}

/// 某声部在某组缺席的那几格补上整小节**不可见休止**，补完各声部小节一一对应（123 / ABC 写出端用）。不按组排的原样返回。
pub fn fill_absent_groups(song: &Song) -> Cow<'_, Song> {
    let axis = axis_of_song(song);
    if !axis.grouped || axis.local.iter().all(|l| l.iter().all(|&i| i >= 0)) {
        return Cow::Borrowed(song);
    }
    let mut max_id = crate::helpers::max_top_element_id(song);
    let mut lead_at: Vec<(usize, usize)> = vec![];
    for s in 0..axis.length {
        let pi = axis.local.iter().position(|l| l[s] >= 0).expect("每格至少一个声部有小节");
        lead_at.push((pi, axis.local[pi][s] as usize));
    }
    let lead = |s: usize| -> &Measure { &song.parts[lead_at[s].0].measures[lead_at[s].1] };
    let mut time_at: Vec<Option<Time>> = vec![];
    let mut dpq_at: Vec<f64> = vec![];
    let mut time = song.time.clone();
    let mut dpq = SIMPLE_DIVISIONS;
    for s in 0..axis.length {
        if let Some(a) = &lead(s).attrs {
            if let Some(t) = &a.time {
                time = Some(t.clone());
            }
            if let Some(d) = a.divisions.filter(|&d| d != 0.0 && !d.is_nan()) {
                dpq = d;
            }
        }
        time_at.push(time.clone());
        dpq_at.push(dpq);
    }
    let mut out = song.clone();
    for (pi, p) in song.parts.iter().enumerate() {
        if axis.local[pi].iter().all(|&i| i >= 0) {
            continue;
        }
        let mut measures = vec![];
        for s in 0..axis.length {
            let i = axis.local[pi][s];
            if i >= 0 {
                measures.push(p.measures[i as usize].clone());
                continue;
            }
            let ld = lead(s);
            let len = ld.duration.unwrap_or_else(|| {
                ld.elements.iter().fold(0.0, |t, el| match el {
                    Element::Chord(c) if c.grace.is_none() => t + c.duration.divisions,
                    _ => t,
                })
            });
            let beat = match &time_at[s] {
                Some(t) => (dpq_at[s] * 4.0) / t.beat_type,
                None => dpq_at[s],
            };
            let mut elements = vec![];
            let mut left = len;
            while left > 0.0 {
                max_id += 1;
                let dur = Duration { divisions: dolce_base::js::min(beat, left), dots: 0.0, ..Default::default() };
                elements.push(Element::Chord(hidden_rest(max_id, dur, 1.0, 1.0, false)));
                left -= beat;
            }
            let mut m = Measure { number: ld.number.clone(), elements, ..Default::default() };
            if let Some(pr) = &ld.print {
                m.print = Some(Print {
                    new_system: pr.new_system.filter(|&b| b),
                    new_page: pr.new_page.filter(|&b| b),
                    system: pr.system,
                    ..Default::default()
                });
            }
            if let Some(a) = &ld.attrs {
                let div = a.divisions.filter(|&d| d != 0.0 && !d.is_nan());
                if a.time.is_some() || div.is_some() {
                    m.attrs = Some(MeasureAttrs { time: a.time.clone(), divisions: div, ..Default::default() });
                }
            }
            measures.push(m);
        }
        out.parts[pi] = Part { measures, ..p.clone() };
    }
    Cow::Owned(out)
}
