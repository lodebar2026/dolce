//! 混排上方带、分页、画页（照 `staffpages.ts`）：混排简谱层与谱表上方那一摞（`formatMixedScore` / `placeAboveStaff`），
//! 以及分页 + 标题块（paoSingleScore 的 getFrames / flowLayout / drawFrames 移植）。
//! 页面尺寸/边距以 MusicXML `<defaults>` 为准，单位 tenths。只产页面树。
//!
//! TS 里按对象作键的 `Set<ScoreCredit>` / `Set<PartLayout>` / `Map<Sys, …>` 换成下标；
//! 页眉块（`FrameItem.credits`）记 `score.credits` 的下标——长图改写 credit 的 y 之后画页眉要看到改过的（TS 是同一对象）。
//! `contentLimit` 的闭包换成带缓存的结构，`sourceFlow` 的闭包换成 `SourceFlow` 的方法（它要边改谱表距离边量）。

// 照 TS 的写法（先声明后分支赋值、按下标走），便于逐行对照
#![allow(clippy::needless_range_loop, clippy::too_many_arguments)]

use crate::model::{
    get_bbox, js_max_of, js_min_of, Lcr, MeasId, Notation, PartId, ScoreCredit, StaffLayout, SysId, TextBlock, TextId, SKYLINE_BIN,
};
use crate::pass::auto_staff_distances;
use crate::render::{draw_system, ending_place, harmony_width_of};
use dolce_model::base::fraction::Fraction;
use dolce_model::base::js;
use dolce_engrave::header::header_role_font;
use dolce_engrave::upperband::{stack_upper_band, BandItem};
use dolce_model::base::geom::Matrix33;
use dolce_model::doc::Placement;
use dolce_model::pagemeta::header_role_of_credit;
use dolce_engrave::scene::{Identity, IdentityKind, Node};
use dolce_engrave::text::{Font, MeasureCtx};
use std::collections::HashMap;

// -----------------------------------------------------------------------
// formatMixedScore（formatScorePAO port, without per-song hacks）

/// 混排简谱层顶（数字顶）到自动放置的文字记号基线的净空：留给简谱层上方的弧与高音点（tenths）
const MIXED_TEXT_CLEAR: f64 = 16.0;

/// 文字块的高（避让用）：乐谱字体按字号的 0.6 估墨迹，文字照字体盒（`textInkHeight`）。
fn text_ink_height(t: &TextBlock, mc: &MeasureCtx) -> f64 {
    let mut h = 0.0;
    for it in &t.data {
        if it.text == "\n" {
            continue;
        }
        let fm = it.font.metrics(mc);
        h = js::max(h, if it.music { it.font.size * 0.6 } else { fm.descent - fm.ascent });
    }
    h
}

/// 文字块墨迹的横向范围（相对块左缘，`textInkSpan`）
fn text_ink_span(t: &TextBlock, mc: &MeasureCtx) -> [f64; 2] {
    let w = t.width(mc);
    if t.data.iter().any(|it| it.text == "\n") {
        return [0.0, w];
    }
    let mut x = 0.0;
    let mut l: Option<f64> = None;
    let mut r = 0.0;
    for it in &t.data {
        x += it.pad_before.unwrap_or(0.0);
        let adv = it.font.measure_text(mc, &it.text);
        if !js::trim(&it.text).is_empty() {
            let (bl, br) = if it.music {
                (0.0, adv)
            } else {
                let b = it.font.char_bound(mc, &it.text);
                (b.left, b.right)
            };
            if l.is_none() {
                l = Some(x + bl);
            }
            r = x + br;
        }
        x += adv;
    }
    match l {
        None => [0.0, w],
        Some(l) => [l, r],
    }
}

/// 五线谱档：谱表内容上沿到和弦符号墨迹底的净空（tenths）
const HARMONY_STAFF_GAP: f64 = 6.0;

pub fn format_mixed_score(score: &mut StaffLayout, jianpu_part: usize) {
    if score.parts.is_empty() {
        return;
    }
    // 简谱层叠在哪个声部上（缺省第一声部）
    let p = if jianpu_part < score.parts.len() { PartId(jianpu_part) } else { PartId(0) };
    if score[p].staves.is_empty() {
        return;
    }
    score[p].staves[0].notation.set(Fraction::int(0.0), Notation::Mixed);
    let hosts = mixed_hosts_by_system(score, p);

    place_above_staff(score, true, &hosts);

    // P2 lyric font × 0.8
    let last = PartId(score.parts.len() - 1);
    if last != p && score[last].pid == "P2" {
        let fnt2 = score.defaults.lyric_font.scaled(0.8);
        score.part_set_lyric_font(last, &fnt2);
    }
}

/// 简谱层所在声部的谱表在某个系统里藏着：这一系统的简谱层改叠在第一个可见谱表上（`mixedHostsBySystem`）。
/// 返回借去叠简谱层的声部（不含 `p`，插入序）。
fn mixed_hosts_by_system(score: &mut StaffLayout, p: PartId) -> Vec<PartId> {
    let mut hosts: Vec<PartId> = Vec::new();
    for si in 0..score.systems.len() {
        let s = SysId(si);
        let sys = &score[s];
        let Some(own) = sys.staves.iter().find(|st| st.part() == p && st.part_staff.sub == 0) else { continue };
        if own.staff_visible {
            continue;
        }
        let Some(alt) = sys.staves.iter().find(|st| st.staff_visible && st.part_staff.sub == 0) else { continue };
        let alt_ps = alt.part_staff;
        let t0 = score[sys.measures[0]].offset;
        let t1 = score[*sys.measures.last().expect("系统里有小节")].end_tick();
        // 后面的系统按次序再设，同一 tick 后设的覆盖
        score[p].staves[0].notation.set(t0, Notation::Normal);
        score[p].staves[0].notation.set(t1, Notation::Mixed);
        score.parts[alt_ps.part.0].staves[alt_ps.sub].notation.set(t0, Notation::Mixed);
        score.parts[alt_ps.part.0].staves[alt_ps.sub].notation.set(t1, Notation::Normal);
        if !hosts.contains(&alt_ps.part) {
            hosts.push(alt_ps.part);
        }
    }
    hosts
}

/// 排练号框右缘到并排的速度记号墨迹左缘（tenths）
const AFTER_REHEARSAL: f64 = 6.0;
/// 排练号后面接成一行的文字与速度记号之间再多空的（tenths）
const WORDS_GAP: f64 = 4.0;
/// segno / coda 墨迹底到下面谱面内容（或顶线）的空（tenths）
const SIGN_CLEAR: f64 = 8.0;
/// 文字记号横向判撞的余量（tenths）
const TOUCH_TOL: f64 = 0.5;
/// 行首 segno / coda 离小节号右缘（tenths）
const AFTER_BAR_NUMBER: f64 = 3.0;

/// 第一声部谱表上方那一摞（`placeAboveStaff`）：混排与五线谱档共用。
pub fn place_above_staff(score: &mut StaffLayout, mixed: bool, hosts: &[PartId]) {
    let ps: Vec<PartId> = if score.keep_breaks {
        (0..score.parts.len()).map(PartId).collect()
    } else {
        (0..score.parts.len().min(1)).map(PartId).collect()
    };
    for &p in &ps {
        place_part_above_staff(score, p, mixed, false);
    }
    for &p in hosts {
        if !ps.contains(&p) {
            place_part_above_staff(score, p, mixed, true);
        }
    }
    if score.keep_breaks {
        auto_staff_distances(score);
    }
}

#[derive(Clone, Copy)]
struct PBox {
    x0: f64,
    x1: f64,
    y0: f64,
    y1: f64,
}

#[derive(Clone, Copy)]
struct RBox {
    x1: f64,
    y0: f64,
    y1: f64,
}

/// 一条文字（墨迹横跨 `[x0, x1]`、底在 `y`、高 `h`，y 向上为正）让开已排好的 `placed`，返回让完的 y。
/// 走上方带共用求解器（`dolce_engrave::upperband`）：已排好的同在第 0 层、同一种类，彼此不动；
/// 这条在第 1 层，压着谁就抬到谁的顶上再空 `MIXED_TEXT_CLEAR / 2`。
/// 横向判撞照混排口径：各盒右缘多让 `MIXED_TEXT_CLEAR / 2`、两边各收 `TOUCH_TOL / 2`（交叠不过 `TOUCH_TOL` 不算撞）。
fn rise_clear_of(placed: &[PBox], x0: f64, x1: f64, y: f64, h: f64) -> f64 {
    let item = |key: usize, x0: f64, x1: f64, y0: f64, y1: f64, layer: f64, kind: Option<String>| BandItem {
        key,
        x0: x0 + TOUCH_TOL / 2.0,
        x1: x1 + MIXED_TEXT_CLEAR / 2.0 - TOUCH_TOL / 2.0,
        top: -y1,
        bottom: -y0,
        layer,
        rank: None,
        kind,
        spread: None,
        top_at: None,
        gap_scale: None,
        skip_kinds: Vec::new(),
    };
    let mut items: Vec<BandItem> =
        placed.iter().enumerate().map(|(i, b)| item(i, b.x0, b.x1, b.y0, b.y1, 0.0, Some("placed".into()))).collect();
    let me = placed.len();
    items.push(item(me, x0, x1, y, y + h, 1.0, None));
    let dy = stack_upper_band(&items, MIXED_TEXT_CLEAR / 2.0);
    let d = dy.get(&me).copied().unwrap_or(0.0);
    if d == 0.0 {
        y
    } else {
        -(-y + d)
    }
}

/// 轮廓上 `[x0, x1]` 那几段的最高（`localFloor` 里的循环；下标按浮点走，同 JS）
fn sky_top(sky: &[f64], x0: f64, x1: f64) -> f64 {
    let mut top = 0.0;
    let mut b = js::max(0.0, (x0 / SKYLINE_BIN).floor());
    let end = js::min(sky.len() as f64 - 1.0, (x1 / SKYLINE_BIN).floor());
    while b <= end {
        top = js::max(top, sky[b as usize]);
        b += 1.0;
    }
    top
}

fn place_part_above_staff(score: &mut StaffLayout, p: PartId, mixed: bool, hosting_only: bool) {
    if score[p].staves.is_empty() {
        return;
    }
    let mc = score.mc;
    let hosting = |score: &StaffLayout, s: SysId| -> bool {
        let t = score[score[s].measures[0]].offset;
        score[p].staves[0].get_notation(&t) == Notation::Mixed
    };
    if !hosting_only {
        score.part_calc_mixed_staff_y(p);
    } else {
        for si in 0..score.systems.len() {
            let s = SysId(si);
            if hosting(score, s) {
                for k in 0..score[s].staves.len() {
                    if score[s].staves[k].part() == p {
                        score.sys_staff_calc_mixed_staff_y(s, k);
                    }
                }
            }
        }
    }

    let [harm_top, harm_bot] = score.harmony_band();
    for si in 0..score.systems.len() {
        let s = SysId(si);
        if hosting_only && !hosting(score, s) {
            continue;
        }
        let sys_measures = score[s].measures.clone();
        for k in 0..score[s].staves.len() {
            if score[s].staves[k].part() != p {
                continue;
            }
            if !mixed {
                let st = &mut score.systems[si].staves[k];
                st.harmony_y = -st.min_y + HARMONY_STAFF_GAP - harm_bot - 3.0;
            }
            let harmony_y = score[s].staves[k].harmony_y;
            for &m in &sys_measures {
                let hs = score[p].measures.get(score[m].index).map(|&pm| score[pm].harmonies.clone()).unwrap_or_default();
                for h in hs {
                    score[h].y = harmony_y + 3.0;
                }
            }
            if score[s].staves[k].part_staff.sub != 0 {
                continue;
            }
            let (min_y, has_harmony) = (score[s].staves[k].min_y, score[s].staves[k].has_harmony);
            let (mix_staff_dist, mix_staff_height, hide_bar_number) =
                (score.options.mix_staff_dist, score.options.mix_staff_height, score.options.hide_bar_number);
            let mut floor = if mixed { -min_y + mix_staff_dist + mix_staff_height + MIXED_TEXT_CLEAR } else { -min_y + MIXED_TEXT_CLEAR };
            let mut placed: Vec<PBox> = Vec::new();
            if has_harmony {
                if score.auto_layout {
                    floor = js::max(floor, harmony_y + 3.0 + harm_top + MIXED_TEXT_CLEAR / 2.0);
                } else {
                    floor = js::max(floor, harmony_y + 3.0);
                    for &m in &sys_measures {
                        let hs = score[p].measures.get(score[m].index).map(|&pm| score[pm].harmonies.clone()).unwrap_or_default();
                        for h in hs {
                            let w = harmony_width_of(score, h);
                            let cx = score.measure_xpos(m) + score[h].x + 6.5;
                            placed.push(PBox { x0: cx - w / 2.0, x1: cx + w / 2.0, y0: score[h].y + harm_bot, y1: score[h].y + harm_top });
                        }
                    }
                }
            }
            // 房号线（连同房号）
            for e in score[p].endings.clone() {
                if !score.sys_overlap(s, &score[e].span) {
                    continue;
                }
                let ep = ending_place(score, e, s, mixed);
                let y = ep.y_pos.unwrap_or(0.0);
                placed.push(PBox { x0: ep.left, x1: ep.right, y0: 30.0 - y - 20.0, y1: 50.0 - y });
            }
            // 谱表上方的词
            for &m in &sys_measures {
                let ls = score[p].measures.get(score[m].index).map(|&pm| score[pm].lyrics.clone()).unwrap_or_default();
                for l in ls {
                    if score.lyric_staff(l) != 0.0 || score[l].y <= 0.0 || score[l].empty() {
                        continue;
                    }
                    let ll = &score[l];
                    let lx = score.measure_xpos(m) + ll.x + ll.x_offset;
                    placed.push(PBox { x0: lx, x1: lx + ll.width, y0: ll.y - ll.font.metrics(mc).descent, y1: ll.y + ll.font.size });
                }
            }
            // 速度记号最后排
            let is_tempo = |score: &StaffLayout, t: TextId| -> bool {
                score[t].src.is_some_and(|d| d.kind == "metronome" || d.more.as_ref().is_some_and(|ms| ms.iter().any(|x| x.kind == "metronome")))
            };
            let is_sign = |score: &StaffLayout, t: TextId| -> bool { score[t].src.is_some_and(|d| d.kind == "segno" || d.kind == "coda") };
            let is_words = |score: &StaffLayout, t: TextId| -> bool { score[t].src.is_some_and(|d| d.kind == "words") && !score[t].boxed };
            let mut blocks: Vec<(MeasId, TextId)> = Vec::new();
            for &m in &sys_measures {
                if let Some(&pm) = score[p].measures.get(score[m].index) {
                    for &t in &score[pm].text_blocks {
                        blocks.push((m, t));
                    }
                }
            }
            blocks.sort_by_key(|&(_, t)| is_tempo(score, t));
            // 同一拍上的几条文字先写的在上：在各自占的位子里倒过来
            let key_of = |score: &StaffLayout, m: MeasId, t: TextId| format!("{}@{}", score[m].index, score[t].offset);
            let mut same_beat: Vec<(String, Vec<usize>)> = Vec::new();
            for (i, &(m, t)) in blocks.iter().enumerate() {
                if !is_words(score, t) {
                    continue;
                }
                let k = key_of(score, m, t);
                match same_beat.iter_mut().find(|(kk, _)| *kk == k) {
                    Some((_, v)) => v.push(i),
                    None => same_beat.push((k, vec![i])),
                }
            }
            for (_, idx) in &same_beat {
                if idx.len() < 2 {
                    continue;
                }
                let picked: Vec<(MeasId, TextId)> = idx.iter().rev().map(|&i| blocks[i]).collect();
                for (k, &i) in idx.iter().enumerate() {
                    blocks[i] = picked[k];
                }
            }
            // 排练号那一拍上的文字、速度记号接在框右边排成一行
            let mut boxed_beats: Vec<String> = Vec::new();
            for &(m, t) in &blocks {
                if score[t].boxed {
                    let k = key_of(score, m, t);
                    if !boxed_beats.contains(&k) {
                        boxed_beats.push(k);
                    }
                }
            }
            let in_row = |score: &StaffLayout, m: MeasId, t: TextId| -> bool {
                boxed_beats.contains(&key_of(score, m, t))
                    && (score[t].boxed
                        || is_tempo(score, t)
                        || (is_words(score, t) && score[t].src.and_then(|d| d.placement.clone()) != Some(Placement::Below)))
            };
            let rank = |score: &StaffLayout, t: TextId| -> f64 {
                if score[t].boxed {
                    0.0
                } else if is_tempo(score, t) {
                    2.0
                } else {
                    1.0
                }
            };
            let mut first_at: Vec<(String, usize)> = Vec::new();
            for (i, &(m, t)) in blocks.iter().enumerate() {
                if in_row(score, m, t) {
                    let k = key_of(score, m, t);
                    if !first_at.iter().any(|(kk, _)| *kk == k) {
                        first_at.push((k, i));
                    }
                }
            }
            let order: Vec<f64> = blocks
                .iter()
                .enumerate()
                .map(|(i, &(m, t))| {
                    if in_row(score, m, t) {
                        let k = key_of(score, m, t);
                        let f = first_at.iter().find(|(kk, _)| *kk == k).expect("已记").1;
                        f as f64 + rank(score, t) / 10.0
                    } else {
                        i as f64
                    }
                })
                .collect();
            let mut sorted: Vec<((MeasId, TextId), f64)> = blocks.iter().copied().zip(order).collect();
            sorted.sort_by(|a, b| js::ordering(a.1 - b.1));
            let blocks: Vec<(MeasId, TextId)> = sorted.into_iter().map(|x| x.0).collect();
            // 源谱版面档：文字按它横向跨过的那一段音符与弧贴
            let sky: Option<Vec<f64>> = (score.keep_breaks && !mixed && !has_harmony).then(|| score.sys_staff_skyline(s, k, true).above);
            let mut sky_all: Option<Vec<f64>> = None;
            let mut rehearsal_at: Vec<(String, RBox)> = Vec::new();
            for &(m, t) in &blocks {
                let tt = &score[t];
                if tt.staff != 0 || (!tt.auto_y && tt.y.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)) {
                    continue;
                }
                if tt.auto_y && tt.y < 0.0 && tt.src.and_then(|d| d.placement.clone()) == Some(Placement::Below) {
                    continue;
                }
                let keep_source = tt.source_y && sky.is_some();
                let sign = is_sign(score, t);
                let tempo = is_tempo(score, t);
                let sign_low = sign && !mixed && !has_harmony && !score[t].sign_placed;
                if !keep_source && !sign_low && (score[t].y < floor || (!score.auto_layout && has_harmony && !tempo)) {
                    score[t].y = floor;
                }
                let tt = &score[t];
                let w = tt.width(mc);
                let mx = score.measure_xpos(m);
                let left = mx + tt.x - (if tt.justify == Lcr::Center { w / 2.0 } else if tt.justify == Lcr::Right { w } else { 0.0 });
                let [ink_l, ink_r] = text_ink_span(tt, mc);
                let mut x0 = left + ink_l;
                let mut x1 = left + ink_r;
                if sign && !score[t].sign_placed {
                    let me = &score[m];
                    let offset = score[t].offset;
                    let at_end = offset.compare_to(&me.dur) >= 0 && me.dur.to_float() > 0.0;
                    let at_start = offset.to_float() == 0.0 && sys_measures[0] != m;
                    if sign_low && offset.to_float() == 0.0 && sys_measures[0] == m && me.show_bar_number && !hide_bar_number {
                        let shift = mx + Font::new(score.options.word_font.clone(), 20.0).measure_text(mc, &me.number) + AFTER_BAR_NUMBER - x0;
                        score[t].x += shift;
                        x0 += shift;
                        x1 += shift;
                    }
                    if at_end || at_start {
                        let mi = sys_measures.iter().position(|&x| x == m).expect("小节在系统里");
                        let last = mi == sys_measures.len() - 1;
                        let sys = &score[s];
                        let trail = if last {
                            (if sys.time_change_width > 0.0 { sys.time_change_width + 5.0 } else { 0.0 })
                                + (if sys.key_change_width > 0.0 { sys.key_change_width + 5.0 } else { 0.0 })
                        } else {
                            0.0
                        };
                        let me = &score[m];
                        let bar_x = if at_end {
                            mx + me.width - sys_measures.get(mi + 1).map_or(0.0, |&n| score[n].sib_key_offset) - trail
                        } else {
                            mx - me.sib_key_offset
                        };
                        let shift = bar_x - (x0 + x1) / 2.0;
                        score[t].x += shift;
                        x0 += shift;
                        x1 += shift;
                    }
                }
                if sign_low {
                    let it = score[t].data.iter().find(|d| d.music);
                    let bb = it.and_then(|it| get_bbox(score.meta, &it.text));
                    let descent = match (bb, it) {
                        (Some(bb), Some(it)) => js::max(0.0, -bb.sw[1]) * (it.font.size / 4.0),
                        _ => 0.0,
                    };
                    let sa = sky_all.get_or_insert_with(|| score.sys_staff_skyline(s, k, true).above);
                    let local = sky_top(sa, x0, x1) + MIXED_TEXT_CLEAR;
                    score[t].y = js::max(local - MIXED_TEXT_CLEAR, 0.0) + SIGN_CLEAR + descent;
                } else if let (Some(sk), true, false) = (&sky, score[t].auto_y, tempo) {
                    score[t].y = sky_top(sk, x0, x1) + MIXED_TEXT_CLEAR;
                } else if keep_source {
                    let sk = sky.as_ref().expect("keepSource 有轮廓");
                    score[t].y = js::max(score[t].y, sky_top(sk, x0, x1) + MIXED_TEXT_CLEAR - MIXED_TEXT_CLEAR / 2.0);
                }
                let h = text_ink_height(&score[t], mc);
                let beat_key = key_of(score, m, t);
                let host: Option<RBox> = if !score[t].boxed && in_row(score, m, t) {
                    rehearsal_at.iter().find(|(kk, _)| *kk == beat_key).map(|x| x.1)
                } else {
                    None
                };
                if let Some(host) = host {
                    let shift = host.x1 + AFTER_REHEARSAL - x0;
                    score[t].x += shift;
                    x0 += shift;
                    x1 += shift;
                    score[t].y = host.y0 + (host.y1 - host.y0 - h) / 2.0;
                }
                score[t].y = rise_clear_of(&placed, x0, x1, score[t].y, h);
                let ty = score[t].y;
                placed.push(PBox { x0, x1, y0: ty, y1: ty + h });
                let set = |ra: &mut Vec<(String, RBox)>, v: RBox| match ra.iter_mut().find(|(kk, _)| *kk == beat_key) {
                    Some(e) => e.1 = v,
                    None => ra.push((beat_key.clone(), v)),
                };
                let tt = &score[t];
                if tt.boxed {
                    let rx1 = if tt.frameless {
                        x1 + MIXED_TEXT_CLEAR / 2.0 - AFTER_REHEARSAL
                    } else {
                        left + w + tt.data.iter().find(|it| it.text != "\n").map_or(0.0, |it| it.font.size) * 0.25
                    };
                    set(&mut rehearsal_at, RBox { x1: rx1, y0: ty, y1: ty + h });
                } else if let Some(host) = host {
                    set(&mut rehearsal_at, RBox { x1: x1 + WORDS_GAP, ..host });
                }
            }
        }
    }
}

// -----------------------------------------------------------------------
// M5: 分页+标题块（paoSingleScore 的 getFrames/flowLayout/drawFrames 移植）

pub const PAGE_HEIGHT_FALLBACK: f64 = 1870.0;
const FRAME_GAP: f64 = 20.0;
const TITLE_OFFSET: f64 = 170.0; // hh(150) + 20
/// 自动铺排：标题块最低一行的基线到首行谱内容顶的余量
const TITLE_GAP: f64 = 30.0;
/// 页眉墨迹底到首行谱内容顶的最小净空
const HEADER_GAP: f64 = 12.0;
/// 源谱版面档：上下两个系统按轮廓判碰后至少留的空
const SOURCE_SYSTEM_GAP: f64 = 12.0;
/// 源谱版面档：没有页眉的页，首个系统最高上探到离纸边这么远（pt，5mm）
const SOURCE_MIN_TOP_PT: f64 = (5.0 * 72.0) / 25.4;

#[derive(Clone, Debug)]
struct FrameItem {
    system: SysId,
    top_y: f64,
    bottom_y: f64,
    height: f64,
    music_y_offset: f64,
    /// `score.credits` 的下标
    credits: Vec<usize>,
}

#[derive(Clone, Copy, Debug)]
struct LayoutFrame {
    height: f64,
    ypos: f64,
    new_page: bool,
}

fn get_frames(score: &StaffLayout) -> Vec<FrameItem> {
    (0..score.systems.len())
        .map(|i| {
            let [top_y, bottom_y] = score.sys_get_y_bound(SysId(i));
            FrameItem { system: SysId(i), top_y, bottom_y, height: top_y - bottom_y, music_y_offset: 0.0, credits: Vec::new() }
        })
        .collect()
}

/// `page_starts`：写明了换页的系统，到它必换页
fn flow_layout(items: &[FrameItem], ph: f64, page_starts: &[SysId]) -> Vec<LayoutFrame> {
    let mut result = Vec::new();
    let mut ypos = 0.0;
    let mut last_mrg: f64 = 0.0;
    for (i, frm) in items.iter().enumerate() {
        let mrg = js::max(last_mrg, FRAME_GAP);
        let bot = ypos + frm.height;
        let np = i == 0 || bot + mrg > ph || page_starts.contains(&frm.system);
        let mut lf = LayoutFrame { height: frm.height, ypos: 0.0, new_page: np };
        if np {
            ypos = 0.0;
        } else {
            ypos += mrg;
        }
        lf.ypos = ypos;
        ypos += frm.height;
        last_mrg = FRAME_GAP;
        result.push(lf);
    }
    result
}

struct SysSky {
    top: Vec<f64>,
    bot: Vec<f64>,
    x0: f64,
}

/// `a[b] = Math.max(a[b], v)`，越界的那格是 `undefined` → NaN（同 JS）
fn js_max_at(a: &mut Vec<f64>, b: usize, v: f64) {
    if b < a.len() {
        a[b] = js::max(a[b], v);
    } else {
        a.resize(b, f64::NAN);
        a.push(f64::NAN);
    }
}

/// 一个系统的横向轮廓（各可见谱表并起来，`systemSkyline`）
fn system_skyline(score: &StaffLayout, s: SysId) -> SysSky {
    let mut top: Vec<f64> = Vec::new();
    let mut bot: Vec<f64> = Vec::new();
    let sys = &score[s];
    for (k, st) in sys.staves.iter().enumerate() {
        if !st.staff_visible {
            continue;
        }
        let sk = score.sys_staff_skyline(s, k, false);
        let y = sys.ypos(k);
        if top.is_empty() {
            top = vec![f64::NEG_INFINITY; sk.above.len()];
            bot = vec![f64::NEG_INFINITY; sk.below.len()];
        }
        for (b, &v) in sk.above.iter().enumerate() {
            js_max_at(&mut top, b, v - y);
        }
        for (b, &v) in sk.below.iter().enumerate() {
            js_max_at(&mut bot, b, y + v);
        }
    }
    SysSky { top, bot, x0: js::round(sys.left_margin / SKYLINE_BIN) }
}

/// 上下两个系统首谱表顶线之间至少多远才不相碰（`systemGap`）
fn system_gap(score: &StaffLayout, a: SysId, b: SysId) -> f64 {
    let pa = system_skyline(score, a);
    let pb = system_skyline(score, b);
    let mut need = f64::NEG_INFINITY;
    for k in 0..pa.bot.len() {
        let j = k as f64 + pa.x0 - pb.x0;
        if j >= 0.0 && j < pb.top.len() as f64 {
            need = js::max(need, pa.bot[k] + pb.top[j as usize]);
        }
    }
    if need == f64::NEG_INFINITY {
        need = js_max_of(pa.bot.iter().copied()) + js_max_of(pb.top.iter().copied());
    }
    need + SOURCE_SYSTEM_GAP
}

/// `trial` 的回值
struct Trial {
    ls: Vec<f64>,
    over: f64,
    gap_excess: Vec<f64>,
    total: f64,
}

/// 源谱版面档的装页（`sourceFlow`）：TS 的闭包换成方法
struct SourceFlow<'a, 'b, 'd> {
    score: &'a mut StaffLayout<'d>,
    items: &'a mut [FrameItem],
    limit: &'b mut ContentLimit,
    ph: f64,
    rise: f64,
    result: Vec<LayoutFrame>,
    want: Vec<f64>,
    moved: Vec<bool>,
}

impl SourceFlow<'_, '_, '_> {
    /// 系统内可压的谱表（首个可见谱表之后的）：系统里的下标
    fn slack(&self, i: usize) -> Vec<usize> {
        let sys = &self.score[self.items[i].system];
        (0..sys.staves.len()).filter(|&k| k > 0 && sys.staves[k].staff_visible && sys.staves[k].distance > sys.staves[k].min_distance).collect()
    }
    fn staff_excess(&self, i: usize) -> f64 {
        let sys = &self.score[self.items[i].system];
        self.slack(i).into_iter().fold(0.0, |a, k| a + sys.staves[k].distance - sys.staves[k].min_distance)
    }
    fn growth(&self, i: usize) -> f64 {
        let sys = &self.score[self.items[i].system];
        sys.staves.iter().enumerate().fold(0.0, |a, (k, st)| {
            a + if k > 0 && st.staff_visible { st.distance - st.src_distance.unwrap_or(st.distance) } else { 0.0 }
        })
    }
    fn floor_of(&self, i: usize, lo: f64) -> f64 {
        lo + self.items[i].top_y + self.items[i].music_y_offset
    }
    fn refresh(&mut self, i: usize) {
        let [top, bot] = self.score.sys_get_y_bound(self.items[i].system);
        let it = &mut self.items[i];
        it.top_y = top;
        it.bottom_y = bot;
        it.height = top - bot + it.music_y_offset;
        self.result[i].height = it.height;
    }
    fn gap(&self, a: usize, b: usize) -> f64 {
        system_gap(self.score, self.items[a].system, self.items[b].system)
    }
    fn trial(&self, list: &[usize], lo: f64) -> Trial {
        let gaps: Vec<f64> = list.iter().enumerate().map(|(k, &i)| if k == 0 { 0.0 } else { self.gap(list[k - 1], i) }).collect();
        let mut ls: Vec<f64> = Vec::new();
        for (k, &i) in list.iter().enumerate() {
            let floor = if k == 0 { self.floor_of(i, lo) } else { ls[k - 1] + gaps[k] };
            let target = if self.moved[i] {
                floor
            } else if k == 0 || self.moved[list[k - 1]] {
                self.want[i]
            } else {
                let prev = list[k - 1];
                ls[k - 1] + self.want[i] - self.want[prev] + self.growth(prev)
            };
            ls.push(js::max(target, floor));
        }
        let last_i = list[list.len() - 1];
        let over = ls[ls.len() - 1] - self.items[last_i].bottom_y - self.ph;
        let gap_excess: Vec<f64> =
            ls.iter().enumerate().map(|(k, &l)| l - (if k == 0 { self.floor_of(list[0], lo) } else { ls[k - 1] + gaps[k] })).collect();
        let total = gap_excess.iter().fold(0.0, |a, &b| a + b) + list.iter().fold(0.0, |a, &i| a + self.staff_excess(i));
        Trial { ls, over, gap_excess, total }
    }
    fn lo_of(&self, list: &[usize]) -> f64 {
        if !self.items[list[0]].credits.is_empty() {
            0.0
        } else {
            -self.rise
        }
    }
    /// 排一页；排不下的末几行挪出来交回
    fn place(&mut self, mut list: Vec<usize>) -> Vec<usize> {
        let mut out: Vec<usize> = Vec::new();
        if list.is_empty() {
            return out;
        }
        let lo = self.lo_of(&list);
        loop {
            let Trial { mut ls, over, gap_excess, total } = self.trial(&list, lo);
            if over > 0.0 {
                if total < over && list.len() > 1 {
                    let last = list.pop().expect("非空");
                    self.moved[last] = true;
                    out.insert(0, last);
                    continue;
                }
                let keep = if total > 0.0 { js::max(0.0, 1.0 - over / total) } else { 0.0 };
                for &i in &list {
                    let sts = self.slack(i);
                    if sts.is_empty() {
                        continue;
                    }
                    let s = self.items[i].system;
                    for k in sts {
                        let st = &mut self.score.systems[s.0].staves[k];
                        st.distance = st.min_distance + (st.distance - st.min_distance) * keep;
                    }
                    self.refresh(i);
                }
                for k in 0..list.len() {
                    let i = list[k];
                    ls[k] = if k == 0 {
                        self.floor_of(i, lo) + gap_excess[0] * keep
                    } else {
                        ls[k - 1] + self.gap(list[k - 1], i) + gap_excess[k] * keep
                    };
                }
            }
            for (k, &i) in list.iter().enumerate() {
                let it = &self.items[i];
                self.result[i].ypos = ls[k] - it.top_y - it.music_y_offset;
                self.result[i].new_page = k == 0;
            }
            return out;
        }
    }
}

fn source_flow(score: &mut StaffLayout, items: &mut [FrameItem], limit: &mut ContentLimit) -> Vec<LayoutFrame> {
    let ph = limit.get(score, 0.0);
    let rise = js::max(0.0, score.defaults.top_margin - SOURCE_MIN_TOP_PT / score.scaling);
    let result: Vec<LayoutFrame> = items.iter().map(|it| LayoutFrame { height: it.height, ypos: 0.0, new_page: false }).collect();
    let index: HashMap<SysId, usize> = items.iter().enumerate().map(|(i, it)| (it.system, i)).collect();
    let pages: Vec<Vec<usize>> = score.pages.iter().map(|pg| pg.systems.iter().filter_map(|s| index.get(s).copied()).collect()).collect();
    let want: Vec<f64> = items.iter().map(|it| score[it.system].distance).collect();
    let moved = vec![false; items.len()];
    let mut f = SourceFlow { score, items, limit, ph, rise, result, want, moved };
    let mut carry: Vec<usize> = Vec::new();
    let mut p = 0usize;
    while p < pages.len() || !carry.is_empty() {
        f.ph = f.limit.get(f.score, p as f64);
        let own: &[usize] = pages.get(p).map_or(&[], |v| v.as_slice());
        if !carry.is_empty() && !own.is_empty() {
            let both: Vec<usize> = carry.iter().chain(own.iter()).copied().collect();
            let t = f.trial(&both, f.lo_of(&both));
            if t.over > t.total {
                let mut rest = carry;
                while !rest.is_empty() {
                    rest = f.place(rest);
                }
                carry = Vec::new();
            }
        }
        let list: Vec<usize> = carry.iter().chain(own.iter()).copied().collect();
        carry = f.place(list);
        p += 1;
    }
    f.result
}

struct HeadLine {
    tf: Node,
    x: f64,
    y: f64,
    ink_top: f64,
    ink_bottom: f64,
}

fn header_ident() -> Identity {
    Identity { kind: IdentityKind::Header, id: None, pass: None, verse: None, edge: None, measure: None, also: None, end: None, slot: None }
}

/// `split(/\r?\n/)`
fn split_lines(s: &str) -> Vec<&str> {
    let parts: Vec<&str> = s.split('\n').collect();
    let n = parts.len();
    parts.into_iter().enumerate().map(|(i, p)| if i + 1 < n { p.strip_suffix('\r').unwrap_or(p) } else { p }).collect()
}

/// 一页的页眉（credit）逐行排好：落笔点与墨迹上下沿（`headerLines`）。`footer`：页脚那几条，不做 Sibelius 整块重排的检测
fn header_lines(
    score: &StaffLayout,
    credits: &[&ScoreCredit],
    top_margin: f64,
    page_height: f64,
    page_width_tenths: f64,
    footer: bool,
) -> Vec<HeadLine> {
    let mc = score.mc;
    let credit_max_y = if !credits.is_empty() { js_max_of(credits.iter().map(|c| c.y)) } else { 0.0 };
    let reanchor_top = !footer && !credits.is_empty() && page_height - credit_max_y > page_height / 2.0;
    let title_credit = credits.iter().find(|c| c.y == credit_max_y);
    let title_font_sz = match title_credit {
        Some(c) if c.font_size > 0.0 => c.font_size / score.scaling,
        _ => 20.0,
    };
    let max_credit_size = credits.iter().fold(0.0, |a, c| js::max(a, c.font_size));
    let mut head_lines: Vec<HeadLine> = Vec::new();
    for cr in credits {
        let justify = match cr.justify {
            Lcr::Right => "right",
            Lcr::Center => "center",
            Lcr::Left => "left",
        };
        let role = header_role_of_credit(cr.r#type.as_deref(), Some(justify), max_credit_size > 0.0 && cr.font_size == max_credit_size);
        let hf = role.and_then(|r| score.options.header_fonts.get(r.as_str()));
        let hf_size = hf.and_then(|h| h.size).filter(|v| *v != 0.0 && !v.is_nan());
        let fnt_sz = if score.keep_breaks && cr.font_size > 0.0 {
            cr.font_size / score.scaling
        } else if let Some(sz) = hf_size {
            sz / score.scaling
        } else if cr.font_size > 0.0 {
            cr.font_size / score.scaling
        } else {
            20.0
        };
        let family = match &cr.family {
            Some(f) => f.clone(),
            None if cr.font_size > 0.0 => score.defaults.lyric_font.family.clone(),
            None => "PingFang SC".to_string(),
        };
        let base = Font { family, size: fnt_sz, bold: cr.bold.unwrap_or(false), italic: false };
        let font = header_role_font(hf, fnt_sz, &base);
        let anchor_x = if cr.x > 0.0 { cr.x } else { page_width_tenths / 2.0 };
        let line_h = fnt_sz * 1.2;
        let lines = split_lines(&cr.text);
        let first = font.char_bound(mc, lines[0]);
        let last = font.char_bound(mc, lines[lines.len() - 1]);
        let nl = (lines.len() - 1) as f64;
        let vshift = match cr.valign.as_deref() {
            Some("top") => -first.top,
            Some("middle") => -(first.top + last.bottom + nl * line_h) / 2.0,
            Some("bottom") => -last.bottom - nl * line_h,
            _ => 0.0,
        };
        let base_y = (if reanchor_top { top_margin + title_font_sz + (credit_max_y - cr.y) } else { page_height - cr.y }) + vshift;
        let block_w = if cr.justify == Lcr::Right { js_max_of(lines.iter().map(|l| font.measure_text(mc, l))) } else { 0.0 };
        for (li, line) in lines.iter().enumerate() {
            let mut tf = Node::text(*line, font.clone());
            tf.id = Some(header_ident());
            let mut x = anchor_x;
            let w = font.measure_text(mc, line);
            if cr.justify == Lcr::Center {
                x -= w / 2.0;
            } else if cr.justify == Lcr::Right {
                x -= block_w;
            }
            let y = base_y + li as f64 * line_h;
            tf.m = Matrix33::from_affine([1.0, 0.0, 0.0, 1.0, x, y]);
            let cb = font.char_bound(mc, line);
            head_lines.push(HeadLine { tf, x, y, ink_top: cb.top, ink_bottom: cb.bottom });
        }
    }
    // 页眉整块不得高过上边距
    let over = top_margin - js_min_of(std::iter::once(f64::INFINITY).chain(head_lines.iter().map(|h| h.y + h.ink_top)));
    if over > 0.0 {
        for h in &mut head_lines {
            h.tf.m = Matrix33::from_affine([1.0, 0.0, 0.0, 1.0, h.x, h.y + over]);
            h.y += over;
        }
    }
    head_lines
}

fn draw_frames(
    score: &StaffLayout,
    items: &[FrameItem],
    lf: &[LayoutFrame],
    left_margin: f64,
    top_margin: f64,
    page_height: f64,
    page_width_tenths: f64,
    footers: &[usize],
) -> Vec<Node> {
    let mut pages: Vec<Node> = Vec::new();
    for i in 0..items.len() {
        let data = &items[i];
        let it = &lf[i];
        let s = data.system;
        if it.new_page || pages.is_empty() {
            pages.push(Node::group());
        }
        let page = pages.last_mut().expect("刚建");
        let crs: Vec<&ScoreCredit> = data.credits.iter().map(|&c| &score.credits[c]).collect();
        for h in header_lines(score, &crs, top_margin, page_height, page_width_tenths, false) {
            page.push(h.tf);
        }
        let mut sys_grp = draw_system(score, s);
        sys_grp.m = Matrix33::from_affine([
            1.0,
            0.0,
            0.0,
            1.0,
            left_margin + score[s].left_margin,
            top_margin + it.ypos + data.top_y + data.music_y_offset,
        ]);
        page.push(sys_grp);
    }
    // 页脚：照原坐标画在各自那一页
    for (p, pg) in pages.iter_mut().enumerate() {
        let own: Vec<&ScoreCredit> = footers.iter().map(|&c| &score.credits[c]).filter(|c| c.page == p as f64).collect();
        for h in header_lines(score, &own, top_margin, page_height, page_width_tenths, true) {
            pg.push(h.tf);
        }
    }
    pages
}

/// 每页内容（从上边距量）最多能排多深（`contentLimit`，按页缓存）
struct ContentLimit {
    footers: Vec<usize>,
    page_height: f64,
    cache: Vec<(f64, f64)>,
}

impl ContentLimit {
    fn get(&mut self, score: &StaffLayout, page: f64) -> f64 {
        if let Some(&(_, v)) = self.cache.iter().find(|(p, _)| *p == page) {
            return v;
        }
        let d = &score.defaults;
        let full = self.page_height - d.top_margin - d.bottom_margin;
        let own: Vec<&ScoreCredit> = self.footers.iter().map(|&c| &score.credits[c]).filter(|c| c.page == page).collect();
        let lines = if !own.is_empty() { header_lines(score, &own, d.top_margin, self.page_height, d.page_width, true) } else { Vec::new() };
        let top = js_min_of(lines.iter().map(|h| h.y + h.ink_top));
        let v = if top.is_finite() { js::min(full, top - d.top_margin - HEADER_GAP) } else { full };
        self.cache.push((page, v));
        v
    }
}

/// 页脚 credit：落在页面下四分之一的（`footerCredits`）；整页 credit 全都落在那里的首页不算。回 `score.credits` 的下标
fn footer_credits(credits: &[ScoreCredit], page_height: f64) -> Vec<usize> {
    let mut out: Vec<usize> = Vec::new();
    let low = |c: &ScoreCredit| c.y < page_height / 4.0;
    let mut pages: Vec<f64> = Vec::new();
    for c in credits {
        if !pages.iter().any(|p| *p == c.page || (p.is_nan() && c.page.is_nan())) {
            pages.push(c.page);
        }
    }
    for p in pages {
        let own: Vec<usize> = (0..credits.len()).filter(|&i| credits[i].page == p).collect();
        if own.iter().all(|&i| low(&credits[i])) && p == 0.0 {
            continue;
        }
        for i in own {
            if low(&credits[i]) && !out.contains(&i) {
                out.push(i);
            }
        }
    }
    out
}

/// `StaffPages.placed` 的一条
#[derive(Clone, Copy, Debug)]
pub struct Placed {
    pub sys: SysId,
    /// 第几页（0 基）。TS 的 `pageNo` 从 −1 起、首帧必开新页，这里不会是 −1
    pub page: usize,
    pub top: f64,
}

/// 一份已读入的 `StaffLayout` 排成页（`mixed` = 混排叠简谱层）。长图会改写 `score.defaults.page_height`。
/// 回各页根节点与各系统落在哪页、页内 top
pub fn layout_staff_pages(score: &mut StaffLayout, mixed: bool, jianpu_part: usize) -> (Vec<Node>, Vec<Placed>) {
    if mixed {
        format_mixed_score(score, jianpu_part);
    } else {
        place_above_staff(score, false, &[]);
    }

    let mut items = get_frames(score);
    let footers: Vec<usize> = if score.long_image { Vec::new() } else { footer_credits(&score.credits, score.defaults.page_height) };
    if !items.is_empty() {
        items[0].credits = (0..score.credits.len()).filter(|&i| score.credits[i].page == 0.0 && !footers.contains(&i)).collect();
        let d = &score.defaults;
        let lowest = js_min_of(items[0].credits.iter().map(|&i| score.credits[i].y));
        let mut offset = if score.keep_breaks {
            0.0
        } else if score.auto_layout && !items[0].credits.is_empty() {
            js::max(TITLE_OFFSET, d.page_height - lowest - d.top_margin + TITLE_GAP)
        } else {
            TITLE_OFFSET
        };
        let crs: Vec<&ScoreCredit> = items[0].credits.iter().map(|&i| &score.credits[i]).collect();
        let heads = header_lines(score, &crs, d.top_margin, d.page_height, d.page_width, false);
        if !heads.is_empty() {
            offset = js::max(offset, js_max_of(heads.iter().map(|h| h.y + h.ink_bottom)) - d.top_margin + HEADER_GAP);
        }
        items[0].music_y_offset = offset;
        items[0].height += offset;
    }
    let mut page_height = score.defaults.page_height;
    let mut limit = ContentLimit { footers: footers.clone(), page_height, cache: Vec::new() };
    let layout = if score.keep_breaks {
        source_flow(score, &mut items, &mut limit)
    } else {
        let ph = if score.long_image {
            f64::INFINITY
        } else {
            let mut fpages: Vec<f64> = Vec::new();
            for &c in &footers {
                let p = score.credits[c].page;
                if !fpages.iter().any(|x| *x == p || (x.is_nan() && p.is_nan())) {
                    fpages.push(p);
                }
            }
            let mut vals: Vec<f64> = fpages.into_iter().map(|p| limit.get(score, p)).collect();
            vals.push(limit.get(score, -1.0));
            js_min_of(vals)
        };
        let starts: Vec<SysId> =
            if score.hard_breaks && !score.long_image { score.pages.iter().skip(1).filter_map(|pg| pg.systems.first().copied()).collect() } else { Vec::new() };
        flow_layout(&items, ph, &starts)
    };
    if score.long_image {
        let d = &score.defaults;
        let content_h = layout.last().map_or(0.0, |l| l.ypos + l.height);
        let h = js::max(content_h + d.top_margin + d.bottom_margin, d.top_margin + d.bottom_margin + TITLE_OFFSET);
        for c in &mut score.credits {
            c.y += h - page_height;
        }
        page_height = h;
        score.defaults.page_height = h;
    }
    let d = score.defaults.clone();
    let mut page_no: isize = -1;
    let placed: Vec<Placed> = items
        .iter()
        .enumerate()
        .map(|(i, it)| {
            if layout[i].new_page {
                page_no += 1;
            }
            Placed { sys: it.system, page: page_no.max(0) as usize, top: d.top_margin + layout[i].ypos + it.top_y + it.music_y_offset }
        })
        .collect();
    let pages = draw_frames(score, &items, &layout, d.left_margin, d.top_margin, page_height, d.page_width, &footers);
    (pages, placed)
}
