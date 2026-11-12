//! 大谱表：花括号括着的上下两个槽位合成一个两谱表的声部（钢琴）。各槽位照常按「一行谱一个槽位」拼完、标完弧，最后一步才合：
//! 下谱表的事件记第 2 谱表、声部号加 4（同 MusicXML 惯例的 5、6），圆滑线号加 [`SLUR_NUMBERS`]（两行各开一条长弧时号不撞），
//! 下谱表小节起头的谱号进 `staff_attrs`、行中换的谱号进 `mid`（都记第 2 谱表）；调号、拍号两谱表共用，上面那行没读出的取下面那行的。
use super::*;
use dolce_omr_sheet::music::ClefSign;

/// 哪几对相邻槽位（上面那个的下标）合成大谱表：同时印着这两个槽位的系统里，过半认出了花括号的；
/// 全曲一处花括号都没认出时，退到「相邻两槽位一个 G 谱号一个 F 谱号、都不带歌词」（花括号没认出的钢琴伴奏）。
pub(super) fn grand_pairs(pages: &[Page], slots_all: &[Vec<usize>], profiles: &[Vec<StaffProfile>], nparts: usize) -> Vec<usize> {
    let mut braced = vec![0usize; nparts];
    let mut both = vec![0usize; nparts];
    let mut sys_no = 0;
    for page in pages {
        for sys in &page.layout.systems {
            let slots = &slots_all[sys_no];
            for k in 0..slots.len().saturating_sub(1) {
                if slots[k + 1] == slots[k] + 1 {
                    both[slots[k]] += 1;
                    if sys.braces.contains(&k) {
                        braced[slots[k]] += 1;
                    }
                }
            }
            sys_no += 1;
        }
    }
    if braced.iter().any(|&b| b > 0) {
        return (0..nparts.saturating_sub(1)).filter(|&u| braced[u] * 2 > both[u]).collect();
    }
    // 各槽位的谱号（众数）与有没有词（过半）
    let mut clefs: Vec<Vec<Clef>> = vec![Vec::new(); nparts];
    let mut lyric = vec![(0usize, 0usize); nparts];
    for (rows, slots) in profiles.iter().zip(slots_all) {
        for (t, &u) in rows.iter().zip(slots) {
            clefs[u].extend(t.clef);
            lyric[u].0 += t.lyric as usize;
            lyric[u].1 += 1;
        }
    }
    let sign = |u: usize| {
        let mut c: Vec<(ClefSign, usize)> = Vec::new();
        for x in &clefs[u] {
            match c.iter_mut().find(|e| e.0 == x.sign) {
                Some(e) => e.1 += 1,
                None => c.push((x.sign, 1)),
            }
        }
        c.into_iter().max_by_key(|e| e.1).map(|e| e.0)
    };
    let sung = |u: usize| lyric[u].0 * 2 > lyric[u].1;
    let mut out = Vec::new();
    let mut u = 0;
    while u + 1 < nparts {
        if sign(u) == Some(ClefSign::G) && sign(u + 1) == Some(ClefSign::F) && !sung(u) && !sung(u + 1) {
            out.push(u);
            u += 2;
        } else {
            u += 1;
        }
    }
    out
}

/// 合并：`pairs` 是上面那个槽位的下标。回合并后的声部，与各槽位落到（第几声部, 第几谱表）。
pub(super) fn merge(parts: Vec<Part>, pairs: &[usize]) -> (Vec<Part>, Vec<(usize, u8)>) {
    let n = parts.len();
    let mut out: Vec<Part> = Vec::new();
    let mut at = vec![(0usize, 1u8); n];
    let mut it = parts.into_iter().enumerate().peekable();
    while let Some((u, mut upper)) = it.next() {
        at[u] = (out.len(), 1);
        upper.staves = 1;
        if pairs.contains(&u) {
            if let Some((l, lower)) = it.next() {
                at[l] = (out.len(), 2);
                upper.staves = 2;
                for (m, low) in upper.measures.iter_mut().zip(lower.measures) {
                    // 调号、拍号两谱表共用：上面那行没读出、下面那行读出了的取下面的（不然合成大谱表后丢了）
                    m.attrs.key = m.attrs.key.or(low.attrs.key);
                    m.attrs.time = m.attrs.time.or(low.attrs.time);
                    if let Some(c) = low.attrs.clef {
                        m.staff_attrs.push(Attrs { clef: Some(c), staff: 2, ..Attrs::default() });
                    }
                    m.mid.extend(low.mid.into_iter().filter_map(|a| a.clef.map(|c| Attrs { clef: Some(c), staff: 2, ..Attrs::default() })));
                    m.events.extend(low.events.into_iter().map(|mut e| {
                        e.staff = 2;
                        e.voice += 4;
                        for s in e.spans.iter_mut().filter(|s| s.kind == SpanKind::Slur) {
                            s.number += SLUR_NUMBERS;
                        }
                        e
                    }));
                }
            }
        }
        out.push(upper);
    }
    (out, at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dolce_omr_sheet::score::NoteType;

    #[test]
    fn merge_moves_lower_staff() {
        let ev = |v: u8| Event { voice: v, ..Event::new(vec![], NoteType::Quarter, 0, None) };
        let m = |e: Event, c: Clef| Measure { attrs: Attrs { clef: Some(c), ..Attrs::default() }, events: vec![e], ..Measure::default() };
        let parts = vec![
            Part { measures: vec![m(ev(1), Clef::TREBLE)], staves: 1 },
            Part { measures: vec![m(ev(1), Clef::TREBLE)], staves: 1 },
            Part { measures: vec![m(ev(2), Clef::BASS)], staves: 1 },
        ];
        let (out, at) = merge(parts, &[1]);
        assert_eq!(out.len(), 2);
        assert_eq!(at, vec![(0, 1), (1, 1), (1, 2)]);
        assert_eq!(out[1].staves, 2);
        let low = &out[1].measures[0].events[1];
        assert_eq!((low.staff, low.voice), (2, 6));
        assert_eq!(out[1].measures[0].staff_attrs[0].clef, Some(Clef::BASS));
        let x = Score { parts: out, ..Score::default() }.to_musicxml();
        assert!(x.contains("<staves>2</staves>") && x.contains("<clef number=\"2\"><sign>F</sign>") && x.contains("<staff>2</staff>"));
    }
}
