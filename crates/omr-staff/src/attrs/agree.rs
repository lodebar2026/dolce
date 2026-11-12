//! 同系统互证：一个系统里各行的调号相同、拍号相同（打击乐行除外）。把握不大的行照同系统里把握大的多数改。
//! 全页共享（[`page_share`]）：同种记号读少了的行补成本页最长的那串。
use super::RowAttrs;
use crate::page::Layout;
use dolce_omr_sheet::music::{ClefSign, Key, Time};

pub fn system_agree(f: &Layout, rows: &mut [RowAttrs]) {
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
                    rows[i].time_votes = n as u8;
                }
            }
        }
    }
}

/// **全页共享调号**（同 TS `shareKeySignature`）：按块、按笔画读出来的调号记号只会少不会多（扫描件升号竖笔断光、降号碎成两块，
/// 新编 035 一个升号读成 0、147 三个降号读成两个）。取本页至少两行自己（互证前）读到的、记号最多的那个调号，同种记号更少（含读成 0 个）的行补成它。
/// 只一行读到的最长那串不取（TS 取）：多半是把调号后贴着的临时记号并了进去（新编 093 两个降号读成三个推给全页）。
/// 只在全页系统都不过两行时做（大谱表一个系统只有两票，两行一起少读就补不回来）：合唱谱多行系统里系统内互证够票，
/// 曲中转调又多，全页共享会抹掉转调、把 C 大调曲子个别行多读的记号推给全页（合唱扫描 +88 步）。
pub fn page_share(f: &Layout, raw: &[Option<Key>], rows: &mut [RowAttrs]) {
    if f.systems.iter().any(|s| s.staves.len() > 2) {
        return;
    }
    let keys: Vec<(usize, Key)> = rows.iter().enumerate().filter(|(_, r)| r.clef.is_none_or(|c| c.sign != ClefSign::Percussion)).filter_map(|(i, r)| r.key.map(|k| (i, k))).collect();
    // 至少两行**自己**读到（互证前）：两行的系统互证后两行必然一样，平票时又偏向记号多的
    let count = |k: Key| raw.iter().filter(|&&x| x == Some(k)).count();
    let best = keys.iter().map(|x| x.1).filter(|&k| k.fifths != 0 && count(k) >= 2).max_by_key(|k| k.fifths.unsigned_abs());
    let Some(best) = best else { return };
    for (i, k) in keys {
        let fewer = k.fifths == 0 || (k.fifths.signum() == best.fifths.signum() && k.fifths.unsigned_abs() < best.fifths.unsigned_abs());
        if fewer {
            rows[i].key = Some(best);
        }
    }
}
