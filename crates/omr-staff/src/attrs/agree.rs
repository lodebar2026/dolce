//! 同系统互证：一个系统里各行的调号相同、拍号相同（打击乐行除外）。把握不大的行照同系统里把握大的多数改。
use super::RowAttrs;
use crate::page::PageFrame;
use dolce_omr_sheet::music::{ClefSign, Key, Time};

pub fn system_agree(f: &PageFrame, rows: &mut [RowAttrs]) {
    for sys in &f.systems {
        let g = &sys.staves;
        if g.len() < 2 {
            continue;
        }
        let pitched: Vec<usize> = g.iter().copied().filter(|&i| rows[i].clef.is_none_or(|c| c.sign != ClefSign::Percussion)).collect();
        // 调号：读数相同的行数最多、不并列、至少两行的那个；其余行照它
        let mut tally: Vec<(Key, usize, usize)> = Vec::new(); // (调号, 行数, 把握大的行数)
        for &i in &pitched {
            if let Some(k) = rows[i].key {
                match tally.iter_mut().find(|t| t.0 == k) {
                    Some(t) => {
                        t.1 += 1;
                        t.2 += rows[i].key_sure as usize;
                    }
                    None => tally.push((k, 1, rows[i].key_sure as usize)),
                }
            }
        }
        // 行数多的；并列取把握大的行多的、再取记号多的（少读比多读常见：位置对不上的不会算进来）
        tally.sort_by(|a, b| (b.1, b.2, b.0.fifths.unsigned_abs()).cmp(&(a.1, a.2, a.0.fifths.unsigned_abs())));
        if let Some(&(k, _, sure)) = tally.first() {
            for &i in &pitched {
                rows[i].key = Some(k);
                rows[i].key_sure = sure > 0;
            }
        }
        // 拍号：有行读出来的，同系统别的行照补（拍号各行同时印）；读数不同取多的
        let mut tt: Vec<(Time, usize)> = Vec::new();
        for &i in g {
            if let Some(t) = rows[i].time {
                match tt.iter_mut().find(|x| x.0 == t) {
                    Some(x) => x.1 += 1,
                    None => tt.push((t, 1)),
                }
            }
        }
        tt.sort_by(|a, b| b.1.cmp(&a.1));
        if let Some(&(t, n)) = tt.first() {
            let tie = tt.get(1).is_some_and(|x| x.1 == n);
            if !tie {
                for &i in g {
                    rows[i].time = Some(t);
                }
            }
        }
    }
}
