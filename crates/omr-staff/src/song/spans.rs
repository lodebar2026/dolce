//! 弧：一行谱的弧挂到事件上、跨系统的半条接起来，全曲收尾时分延音线 / 圆滑线并编号；多小节休止展开时弧端跟着顺移。
use super::*;

/// 弧端指认和弦的容差（相对线距；满拍裁决删过头的和弦 x 会挪一点）。
pub(super) const ARC_CHORD: f64 = 0.6;

/// 同时开着的圆滑线最多几条（MusicXML 的编号 1~6）。
pub(super) const SLUR_NUMBERS: u8 = 6;

/// 弧的一端落在哪个事件上（全曲小节下标、小节内事件下标）。
#[derive(Clone)]
pub(super) struct End {
    pub(super) measure: usize,
    pub(super) event: usize,
    pub(super) onset: u32,
    pub(super) voice: u8,
    pub(super) pitches: Vec<Pitch>,
}

/// 一条两端都定了的弧。`adjacent`：两端之间同声部没有别的音（延音线的「时间相邻」）。
pub(super) struct SpanRec {
    pub(super) a: End,
    pub(super) b: End,
    pub(super) above: bool,
    pub(super) adjacent: bool,
    /// 认出时发的号（种类等定了延音线 / 圆滑线再改）与框。
    pub(super) src: Src,
}

/// 画到行尾、等下一个系统接的半条弧。`last`：起端是这一行同声部的最后一个音。
pub(super) struct Pending {
    pub(super) end: End,
    pub(super) above: bool,
    pub(super) sys: usize,
    pub(super) last: bool,
    pub(super) src: Src,
}

/// 多小节休止展开：`extra` 是 (系统内第 j 小节, 要补几个)；补的小节各一个整小节休止，第 j 小节的右线（样式、反复结束）挪到补的最后一个上。
/// 这一行已记下的弧端、等着接的半条弧，小节号在 j 之后的跟着顺移。
pub(super) fn expand_multi_rests(ms: &mut Vec<Measure>, extra: &[(usize, usize)], from: usize, recs: &mut [SpanRec], pending: &mut [Pending]) {
    for &(j, k) in extra.iter().rev() {
        if j >= ms.len() || k == 0 {
            continue;
        }
        let (right, rep_end) = (ms[j].right.take(), std::mem::take(&mut ms[j].repeat_end));
        for n in 0..k {
            let mut m = Measure::default();
            m.events.push(Event::new(vec![], dolce_omr_sheet::score::NoteType::Whole, 0, None));
            if n + 1 == k {
                (m.right, m.repeat_end) = (right, rep_end);
            }
            ms.insert(j + 1 + n, m);
        }
        let at = from + j;
        for r in recs.iter_mut() {
            for e in [&mut r.a, &mut r.b] {
                if e.measure > at {
                    e.measure += k;
                }
            }
        }
        for q in pending.iter_mut().filter(|q| q.end.measure > at) {
            q.end.measure += k;
        }
    }
}

/// 跨谱表弧（两端在不同谱行、合并成大谱表后挂到事件上）。
pub(super) struct CrossSpan {
    pub(super) p1: usize,
    pub(super) m1: usize,
    pub(super) e1: usize,
    pub(super) p2: usize,
    pub(super) m2: usize,
    pub(super) e2: usize,
    pub(super) above: bool,
    pub(super) src: Src,
}

pub(super) fn find_anchor(anchors: &[Anchor], c: ChordRef, sp: f64) -> Option<usize> {
    let off = |i: usize| (anchors[i].x - c.x).abs() + (anchors[i].y - c.y).abs();
    (0..anchors.len()).filter(|&i| (anchors[i].x - c.x).abs() <= ARC_CHORD * sp).min_by(|&a, &b| off(a).total_cmp(&off(b)))
}

pub(super) fn arc_rect(arc: &Arc, sp: f64) -> Rect {
    let (x0, x1) = (arc.a.0.min(arc.b.0), arc.a.0.max(arc.b.0));
    let (y0, y1) = (arc.a.1.min(arc.b.1), arc.a.1.max(arc.b.1));
    let (y0, y1) = if arc.above { (y0 - sp, y1) } else { (y0, y1 + sp) };
    Rect::new(x0, y0, x1 - x0, y1 - y0)
}

/// 一行谱的弧挂到事件上：两端都有的直接记；画到行尾的留给下一个系统同一声部从行首来的那半条接。
#[allow(clippy::too_many_arguments)]
pub(super) fn row_arcs(arcs: &[(usize, &Arc)], anchors: &[Anchor], ms: &[Measure], from: usize, sp: f64, sys: usize, pending: &mut Vec<Pending>, recs: &mut Vec<SpanRec>, ids: &mut Ids) {
    pending.retain(|p| p.sys + 1 >= sys);
    let find = |c: ChordRef| find_anchor(anchors, c, sp);
    let end = |i: usize| {
        let a = &anchors[i];
        let e = &ms[a.bar].events[a.event];
        End { measure: from + a.bar, event: a.event, onset: e.onset, voice: a.voice, pitches: e.pitches.clone() }
    };
    let same = |i: usize, j: usize| anchors[i].bar == anchors[j].bar && anchors[i].event == anchors[j].event;
    // 一段拍点里有没有与第 i 个同声部的别的音
    let voiced = |range: std::ops::Range<usize>, i: usize| range.into_iter().any(|k| anchors[k].voice == anchors[i].voice && !same(k, i));
    for &(ak, arc) in arcs {
        let rect = arc_rect(arc, sp);
        match (arc.start.and_then(find), arc.end.and_then(find)) {
            (Some(i), Some(j)) if i < j && !same(i, j) => {
                let adjacent = !voiced(i + 1..j, i) && !voiced(i + 1..j, j);
                recs.push(SpanRec { a: end(i), b: end(j), above: arc.above, adjacent, src: ids.src(ids.arc(ak), RidKind::Slur, rect) });
            }
            (Some(i), None) if arc.end.is_none() => pending.push(Pending { end: end(i), above: arc.above, sys, last: !voiced(i + 1..anchors.len(), i), src: ids.src(ids.arc(ak), RidKind::Slur, rect) }),
            (None, Some(j)) if arc.start.is_none() => {
                let from_prev = |p: &Pending| p.sys + 1 == sys;
                let Some(n) = pending.iter().position(|p| from_prev(p) && p.above == arc.above).or_else(|| pending.iter().position(from_prev)) else { continue };
                let p = pending.remove(n);
                recs.push(SpanRec { a: p.end, b: end(j), above: arc.above, adjacent: p.last && !voiced(0..j, j), src: p.src });
            }
            _ => {}
        }
    }
}

/// 弧朝的那一侧最外的音高（画在上方的取最高、下方的取最低）。
pub(super) fn outer(e: &End, above: bool) -> Option<Pitch> {
    let k = |p: &&Pitch| (p.octave, p.step, p.alter);
    if above { e.pitches.iter().max_by_key(k).copied() } else { e.pitches.iter().min_by_key(k).copied() }
}

/// 这条弧连的共同音高是不是两端里至少一端朝弧那一侧最外的音：延音线贴着它连的那个头画；
/// 共用一根干的两个声部，上声部换音、下声部不动时罩在上面的是圆滑线——共同音在两端都不是最上面的。
pub(super) fn ties_outer(r: &SpanRec) -> bool {
    [&r.a, &r.b].iter().any(|e| outer(e, r.above).is_some_and(|p| r.a.pitches.contains(&p) && r.b.pitches.contains(&p)))
}

/// 全曲的弧落到事件上：两端同声部相邻、共同音高在朝弧那一侧最外的是延音线（记在那个音上；同两端的其余几条各连一个音），
/// 其余是圆滑线，同时开着的几条各用一个号。
pub(super) fn mark_spans(part: &mut Part, mut recs: Vec<SpanRec>) {
    let key = |e: &End| (e.measure, e.onset, e.voice, e.event);
    // 同两端的几条里，连最外那个音的排前面（和弦里一起连的其余几条跟着它算延音线）
    recs.sort_by_key(|r| (key(&r.a), key(&r.b), !ties_outer(r)));
    // 开着的圆滑线：(号, 止端)
    let mut open: Vec<(u8, (usize, u32, u8, usize))> = Vec::new();
    // 已记的延音线：(起端事件, 止端事件, 起端的音, 止端的音)
    type Tied = ((usize, usize), (usize, usize), Pitch, Pitch);
    let mut tied: Vec<Tied> = Vec::new();
    let mut slurred: Vec<((usize, usize), (usize, usize))> = Vec::new();
    for r in &recs {
        let (ka, kb) = ((r.a.measure, r.a.event), (r.b.measure, r.b.event));
        let mut shared: Vec<Pitch> = r.a.pitches.iter().filter(|p| r.b.pitches.contains(p)).copied().filter(|p| !tied.iter().any(|t| t.0 == ka && t.1 == kb && (t.2 == *p || t.3 == *p))).collect();
        shared.sort_by_key(|p| (p.octave, p.step));
        // 和弦里几个音一起连：同两端已有延音线、这一条又没有剩下的共同音高（有个头音高读偏了），照样是延音线，各记在还空着的音上
        let free = |e: &End, start: bool| {
            let mut v: Vec<Pitch> = e.pitches.iter().copied().filter(|p| !tied.iter().any(|t| t.0 == ka && t.1 == kb && (if start { t.2 } else { t.3 }) == *p)).collect();
            v.sort_by_key(|p| (p.octave, p.step));
            if r.above { v.last().copied() } else { v.first().copied() }
        };
        let grouped = tied.iter().any(|t| t.0 == ka && t.1 == kb);
        let pair = if !r.adjacent {
            None
        } else if !shared.is_empty() && (grouped || ties_outer(r)) {
            // 画在上方的连最高的那个共同音，下方的连最低的
            let p = if r.above { shared[shared.len() - 1] } else { shared[0] };
            Some((p, p))
        } else if grouped {
            free(&r.a, true).zip(free(&r.b, false))
        } else {
            None
        };
        let src = |kind: RidKind| Src { rid: r.src.rid.map(|x| Rid { kind, ..x }), at: r.src.at };
        let (mark, stop_pitch) = if let Some((pa, pb)) = pair {
            tied.push((ka, kb, pa, pb));
            (SpanMark { kind: SpanKind::Tied, start: true, number: 1, above: r.above, pitch: Some(pa), src: src(RidKind::Tie) }, Some(pb))
        } else {
            if slurred.contains(&(ka, kb)) || grouped {
                continue;
            }
            open.retain(|o| o.1 >= key(&r.a));
            let Some(number) = (1..=SLUR_NUMBERS).find(|n| !open.iter().any(|o| o.0 == *n)) else { continue };
            open.push((number, key(&r.b)));
            slurred.push((ka, kb));
            (SpanMark { kind: SpanKind::Slur, start: true, number, above: r.above, pitch: None, src: src(RidKind::Slur) }, None)
        };
        part.measures[r.a.measure].events[r.a.event].spans.push(mark);
        part.measures[r.b.measure].events[r.b.event].spans.push(SpanMark { start: false, pitch: stop_pitch, ..mark });
    }
}
