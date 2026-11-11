//! JM6 满拍裁决与可疑清单（计划 §2.8）：按小节线把各行的音切成小节（行末劈开的半截与下一行行首的半截拼成一个），
//! 时值和不合拍号的小节在**落选候选**（[`crate::result::Alt`]：差一点没收的减时线、附点、增时线，收得勉强的反过来）里
//! 挑一组使它满拍；挑得出唯一的一组就改、记可疑，挑不出的保持原判、记可疑。把握大的元素不为凑满拍而改。
use crate::notes::RowNotes;
use crate::result::{Alt, AltKind, Doubt, JpNum, RecognizedScore};
use dolce_omr_core::image::Rect;

/// 一个四分音符的时值单位（容得下四条减时线、两个附点、三连音）。
const QUARTER: i64 = 192;
/// 一个小节里最多同时改几处。
const MAX_PICK: usize = 2;

/// 一个音的时值。
pub fn dur(n: &JpNum) -> i64 {
    let base = QUARTER >> n.div.min(4);
    let dotted = match n.dot {
        0 => base,
        1 => base * 3 / 2,
        _ => base * 7 / 4,
    };
    let own = match &n.tuplet {
        Some(t) if t.actual > 0 => dotted * t.normal as i64 / t.actual as i64,
        _ => dotted,
    };
    own + QUARTER * n.augment as i64
}

/// 小节：各行里的一段音（行号、起止下标，止不含）。跨行的有两段。
#[derive(Clone, Debug, Default)]
pub struct Bar {
    pub parts: Vec<(usize, usize, usize)>,
    /// 可以不满（弱起、曲末、反复线与复纵线 / 终止线边上、行末劈开却没拼上的）
    pub partial_ok: bool,
}

/// 满拍情况（回归统计与排查用）。
#[derive(Clone, Copy, Debug, Default)]
pub struct Tally {
    pub bars: usize,
    pub full: usize,
    pub fixed: usize,
    pub bad: usize,
}

fn apply(n: &mut JpNum, k: AltKind) -> bool {
    match k {
        AltKind::DivPlus if n.div < 4 => n.div += 1,
        AltKind::DivMinus if n.div > 0 => n.div -= 1,
        AltKind::DotPlus if n.dot < 2 && n.augment == 0 => n.dot += 1,
        AltKind::DotMinus if n.dot > 0 => n.dot -= 1,
        AltKind::AugPlus => n.augment += 1,
        AltKind::AugMinus if n.augment > 0 => n.augment -= 1,
        _ => return false,
    }
    true
}

/// 一行里按小节线切出的各段（起止下标）与每段右端有没有小节线。
fn segments(rn: &RowNotes) -> Vec<(usize, usize, bool)> {
    let mut xs = rn.barline_xs.clone();
    xs.sort_by(f64::total_cmp);
    let mut out = Vec::new();
    let mut a = 0;
    for &x in &xs {
        let b = rn.nums.iter().position(|n| n.bbox.cx() > x).unwrap_or(rn.nums.len());
        if b > a {
            out.push((a, b, true));
        }
        a = b.max(a);
    }
    if a < rn.nums.len() {
        out.push((a, rn.nums.len(), false));
    }
    out
}

/// 各声部的行链：连谱号括着的按声部各成一条（系统从上到下），没括着的行合成一条。
fn chains(sys: &[Option<(u32, u32)>]) -> Vec<Vec<usize>> {
    let mut out: Vec<(Option<u32>, Vec<usize>)> = Vec::new();
    for (i, s) in sys.iter().enumerate() {
        let key = s.map(|s| s.1);
        match out.iter_mut().find(|c| c.0 == key) {
            Some(c) => c.1.push(i),
            None => out.push((key, vec![i])),
        }
    }
    out.into_iter().map(|c| c.1).collect()
}

/// 切小节。行末没有小节线的那一段：自己就满拍的是印刷省了行末线，单独成小节；否则与下一行行首的一段拼起来。
/// 行末有小节线却不满的一段，与下一行行首不满的一段正好凑满的也拼（弱起的曲子逐行这样劈）。`targets`：容许的小节时值（混合拍有几个）。
pub fn bars(notes: &[RowNotes], sys: &[Option<(u32, u32)>], targets: &[i64]) -> Vec<Bar> {
    let max = targets.iter().copied().max().unwrap_or(0);
    let sum = |bar: &Bar| total(notes, bar);
    let mut out: Vec<Bar> = Vec::new();
    for chain in chains(sys) {
        let first = out.len();
        // 行末还没收口的一段，与它右端有没有小节线
        let mut open: Option<(Bar, bool)> = None;
        for &r in &chain {
            let rn = &notes[r];
            let near_special = |a: usize, b: usize| {
                let (x0, x1) = (rn.nums[a].bbox.x, rn.nums[b - 1].bbox.right());
                let lo = if a > 0 { rn.nums[a - 1].bbox.right() } else { f64::MIN };
                let hi = if b < rn.nums.len() { rn.nums[b].bbox.x } else { f64::MAX };
                rn.nums[a].repeat_forward
                    || rn.nums[b - 1].repeat_backward
                    || (a > 0 && rn.nums[a - 1].repeat_backward)
                    || (b < rn.nums.len() && rn.nums[b].repeat_forward)
                    || rn.double_bar_xs.iter().chain(&rn.end_bar_xs).any(|&x| (x > lo && x < x0) || (x > x1 && x < hi))
            };
            let segs = segments(rn);
            for (k, &(a, b, closed)) in segs.iter().enumerate() {
                let mut bar = Bar { parts: vec![(r, a, b)], partial_ok: near_special(a, b) };
                if let Some((mut prev, prev_closed)) = open.take() {
                    let joined = sum(&prev) + sum(&bar);
                    if !prev_closed || targets.contains(&joined) {
                        prev.parts.push((r, a, b));
                        prev.partial_ok |= bar.partial_ok;
                        bar = prev;
                    } else {
                        out.push(prev);
                    }
                }
                let t = sum(&bar);
                let last = k + 1 == segs.len();
                if last && t < max && !targets.contains(&t) && bar.parts.len() == 1 {
                    open = Some((bar, closed));
                } else if closed || t >= max || targets.contains(&t) {
                    out.push(bar);
                } else {
                    open = Some((bar, false));
                }
            }
        }
        if let Some((mut bar, _)) = open {
            bar.partial_ok = true;
            out.push(bar);
        }
        if out.len() > first {
            // 弱起与曲末
            out[first].partial_ok = true;
            out.last_mut().unwrap().partial_ok = true;
        }
    }
    out
}

fn total(notes: &[RowNotes], bar: &Bar) -> i64 {
    bar.parts.iter().map(|&(r, a, b)| notes[r].nums[a..b].iter().map(dur).sum::<i64>()).sum()
}

fn bbox(notes: &[RowNotes], part: (usize, usize, usize)) -> Rect {
    let ns = &notes[part.0].nums[part.1..part.2];
    let x0 = ns.iter().map(|n| n.bbox.x).fold(f64::MAX, f64::min);
    let y0 = ns.iter().map(|n| n.bbox.y).fold(f64::MAX, f64::min);
    let x1 = ns.iter().map(|n| n.bbox.right()).fold(f64::MIN, f64::max);
    let y1 = ns.iter().map(|n| n.bbox.bottom()).fold(f64::MIN, f64::max);
    Rect::new(x0, y0, x1 - x0, y1 - y0)
}

/// 满拍裁决。拍号与多数小节对不上时（读错的拍号、混合拍）不裁决：没读到拍号的按多数小节的时值和定一个，读到了的只记可疑。
pub fn settle(notes: &mut [RowNotes], sys: &[Option<(u32, u32)>], score: &mut RecognizedScore) -> Tally {
    let of = |beats: u32, beat_type: u32| QUARTER * 4 * beats as i64 / beat_type.max(1) as i64;
    let mut targets: Vec<i64> = vec![of(score.beats, score.beat_type)];
    for m in &score.meters {
        let t = of(m.beats, m.beat_type);
        if !targets.contains(&t) {
            targets.push(t);
        }
    }
    let mut all = bars(notes, sys, &targets);
    let share = |all: &[Bar], notes: &[RowNotes], ts: &[i64]| {
        let inner: Vec<&Bar> = all.iter().filter(|b| !b.partial_ok).collect();
        (inner.iter().filter(|b| ts.contains(&total(notes, b))).count(), inner.len())
    };
    let (ok, n) = share(&all, notes, &targets);
    if n >= 4 && ok * 2 < n {
        // 多数小节的时值和
        let mut hist: Vec<(i64, usize)> = Vec::new();
        for b in all.iter().filter(|b| !b.partial_ok) {
            let t = total(notes, b);
            match hist.iter_mut().find(|h| h.0 == t) {
                Some(h) => h.1 += 1,
                None => hist.push((t, 1)),
            }
        }
        hist.sort_by_key(|h| std::cmp::Reverse(h.1));
        let meter = hist.first().filter(|h| h.1 * 5 >= n * 3).and_then(|h| match h.0 {
            t if t % QUARTER == 0 && (2..=6).contains(&(t / QUARTER)) => Some((t, (t / QUARTER) as u32, 4)),
            t if t % (QUARTER / 2) == 0 && [3, 9].contains(&(t / (QUARTER / 2))) => Some((t, (t / (QUARTER / 2)) as u32, 8)),
            _ => None,
        });
        match meter {
            Some((t, beats, beat_type)) if !score.meter_read => {
                score.beats = beats;
                score.beat_type = beat_type;
                score.doubts.push(Doubt { row: 0, note: None, bbox: Rect::new(0.0, 0.0, 0.0, 0.0), reason: "meter.inferred".into() });
                targets = vec![t];
                all = bars(notes, sys, &targets);
            }
            _ => {
                score.doubts.push(Doubt { row: 0, note: None, bbox: Rect::new(0.0, 0.0, 0.0, 0.0), reason: "meter.mismatch".into() });
                if std::env::var("OMR_JP_DEBUG").is_ok() {
                    eprintln!("拍号与多数小节对不上：{:?}", hist);
                }
                return Tally { bars: n, full: ok, ..Default::default() };
            }
        }
    }
    let debug = std::env::var("OMR_JP_DEBUG").is_ok();
    let mut tally = Tally::default();
    // 改线会挪同一行后面各音的下标：从后往前走
    for bar in all.iter().rev() {
        let t0 = total(notes, bar);
        tally.bars += 1;
        let max = targets.iter().copied().max().unwrap_or(0);
        if targets.contains(&t0) || (bar.partial_ok && t0 < max) {
            tally.full += 1;
            continue;
        }
        // 候选：(行, 音, 候选)
        let mut cands: Vec<(usize, usize, Alt)> = Vec::new();
        for &(r, a, b) in &bar.parts {
            for i in a..b {
                for alt in &notes[r].nums[i].alts {
                    if !cands.iter().any(|c| c.0 == r && c.1 == i && c.2.kind == alt.kind) {
                        cands.push((r, i, *alt));
                    }
                }
            }
        }
        // 试各组（至多 MAX_PICK 处），留满拍的
        let mut hits: Vec<(f64, Vec<usize>)> = Vec::new();
        let try_set = |set: &[usize], hits: &mut Vec<(f64, Vec<usize>)>| {
            let mut delta = 0;
            for &(r, a, b) in &bar.parts {
                for i in a..b {
                    let mine: Vec<&(usize, usize, Alt)> = set.iter().map(|&k| &cands[k]).filter(|c| c.0 == r && c.1 == i).collect();
                    if mine.is_empty() {
                        continue;
                    }
                    let mut n = notes[r].nums[i].clone();
                    let before = dur(&n);
                    if !mine.iter().all(|c| apply(&mut n, c.2.kind)) {
                        return;
                    }
                    delta += dur(&n) - before;
                }
            }
            if targets.contains(&(t0 + delta)) {
                hits.push((set.iter().map(|&k| cands[k].2.cost).sum(), set.to_vec()));
            }
        };
        for i in 0..cands.len() {
            try_set(&[i], &mut hits);
            if MAX_PICK >= 2 {
                for j in i + 1..cands.len() {
                    // 同一个音上相反的两样不同时改
                    if cands[i].0 == cands[j].0 && cands[i].1 == cands[j].1 {
                        continue;
                    }
                    try_set(&[i, j], &mut hits);
                }
            }
        }
        hits.sort_by(|a, b| a.0.total_cmp(&b.0));
        let first = bar.parts[0];
        // 超拍又没有时值候选可改：里面读成「1」的光竖条也许是小节线——把它们当线切开，各段都满拍（弱起、曲末的头尾一段可以不满）就认
        if hits.is_empty() && t0 > max && bar.parts.len() == 1 {
            let (r, a, b) = first;
            let likes: Vec<usize> = (a..b).filter(|&i| notes[r].nums[i].bar_like && notes[r].nums[i].div == 0 && notes[r].nums[i].dot == 0).collect();
            let mut sets: Vec<Vec<usize>> = Vec::new();
            for m in 1u32..(1 << likes.len().min(6)) {
                let pick: Vec<usize> = likes.iter().enumerate().filter(|(k, _)| m >> k & 1 == 1).map(|(_, &i)| i).collect();
                // 各段：以挑中的音为界
                let mut ok = true;
                let mut from = a;
                let n_seg = pick.len() + 1;
                for (k, &cut) in pick.iter().chain(std::iter::once(&b)).enumerate() {
                    // 竖条后面跟着的增时线归前一段的末音不成立（线后不该有增时线）
                    let t: i64 = notes[r].nums[from..cut].iter().map(dur).sum();
                    let edge = bar.partial_ok && (k == 0 || k + 1 == n_seg);
                    if cut < b && notes[r].nums[cut].augment > 0 {
                        ok = false;
                    }
                    if !(targets.contains(&t) || (edge && t < max && t > 0)) {
                        ok = false;
                    }
                    from = cut + 1;
                }
                if ok {
                    sets.push(pick);
                }
            }
            if sets.len() == 1 {
                let rn = &mut notes[r];
                for &i in sets[0].iter().rev() {
                    let gone = rn.nums.remove(i);
                    rn.barline_xs.push(gone.bbox.cx());
                    // 挂在它上面的词、反复记号交给右邻
                    if let Some(next) = rn.nums.get_mut(i) {
                        if !gone.lyrics.is_empty() && next.lyrics.iter().all(|l| l.is_empty()) {
                            next.lyrics = gone.lyrics;
                        }
                        next.repeat_forward |= gone.repeat_forward;
                    }
                    score.doubts.push(Doubt { row: r, note: None, bbox: gone.bbox, reason: "beat.fix.bar".into() });
                }
                rn.barline_xs.sort_by(f64::total_cmp);
                tally.fixed += 1;
                tally.full += 1;
                if debug {
                    eprintln!("小节 行{r}：超拍 {t0}，{} 根读成 1 的竖条改成小节线 → 改线", sets[0].len());
                }
                continue;
            }
        }
        let unique = hits.first().is_some_and(|h| hits.get(1).is_none_or(|g| g.0 - h.0 >= 0.25));
        if unique {
            for &k in &hits[0].1 {
                let (r, i, alt) = cands[k];
                let n = &mut notes[r].nums[i];
                apply(n, alt.kind);
                let reason = format!("beat.fix.{}", alt.kind.code());
                n.doubt.push(reason.clone());
                score.doubts.push(Doubt { row: r, note: Some(i), bbox: n.bbox, reason });
            }
            tally.fixed += 1;
            tally.full += 1;
        } else {
            let reason = if !hits.is_empty() { "beat.ambiguous" } else if t0 < max { "beat.short" } else { "beat.over" };
            notes[first.0].nums[first.1].doubt.push(reason.into());
            score.doubts.push(Doubt { row: first.0, note: Some(first.1), bbox: bbox(notes, first), reason: reason.into() });
            tally.bad += 1;
        }
        if debug {
            let toks: Vec<String> = bar.parts.iter().flat_map(|&(r, a, b)| notes[r].nums[a..b].iter()).map(|n| format!("{}{}{}{}", n.digit, "_".repeat(n.div as usize), ".".repeat(n.dot as usize), "-".repeat(n.augment as usize))).collect();
            let b = bbox(notes, first);
            eprintln!("小节 行{} x{:.0}-{:.0}：{}/{} {} 候选{} → {}", first.0, b.x, b.right(), t0, targets[0], toks.join(" "), cands.len(), if unique { "改了" } else if hits.is_empty() { "凑不满" } else { "两可" });
        }
    }
    tally
}
