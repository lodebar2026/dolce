//! **临时记号与附点**（3.5）。
//!
//! - 临时记号：谱表带里的字形单元按竖笔认升 / 降 / 还原（与调号同一套判据，[`crate::attrs::lead::acc_kind`]），
//!   它指着的音级位置右边紧挨着的头归它。挂不上头的不要（行中调号、别的记号）。
//! - 附点：头（或休止）右边的小圆点，落在间里——头在线上时点在上面（偶尔下面）那个间，头在间里时点与头同高。
//!   反复记号的两点（紧挨着带反复点的小节线）不算。
use super::heads::{band, POS_MAX, POS_MIN};
use super::RowNotes;
use crate::attrs::lead::{acc_kind, acc_pos, Acc};
use super::bridged;
use crate::attrs::units::{merged, single, units_in};
use crate::page::PageFrame;

/// 记号指的音级与头的音级最多差这么多（半格为 1）。
const ACC_POS_TOL: f64 = 0.8;
/// 记号右缘到头左缘（头心往左 `HEAD_HALF` 格）的空隙范围（相对线距）：和弦的几个记号错开排，远的隔着两三格。
const ACC_GAP: (f64, f64) = (-0.4, 3.0);
const HEAD_HALF: f64 = 0.6;
/// 记号断成两块时，两块之间隔着的那截谱线最长这么多（相对线距）。
const ACC_SLIT: f64 = 0.4;
/// 附点的宽高范围（相对线距）、宽高比、占包围盒的比例。
const DOT_SIZE: (f64, f64) = (0.18, 0.6);
const DOT_ASPECT: (f64, f64) = (0.6, 1.7);
const DOT_FILL: f64 = 0.6;
/// 点心在头心右边多远（相对线距；第二个点再远半格多）。
const DOT_DX: (f64, f64) = (0.7, 2.6);
/// 点离最近的间心最多差这么多、离头的音级最多差这么多（半格为 1）。
const DOT_IN_SPACE: f64 = 0.6;
const DOT_NEAR_HEAD: f64 = 1.4;
/// 休止的点：点心在休止右缘之右多远（相对线距）。
const REST_DOT_DX: (f64, f64) = (0.1, 1.3);
/// 反复点：离带反复点的小节线不到这么多（相对线距）。
const REPEAT_NEAR: f64 = 1.3;

/// 给一行谱的头挂临时记号、给和弦与休止数附点。
pub fn marks(f: &PageFrame, si: usize, x_from: f64, row: &mut RowNotes) {
    let s = &f.staves[si];
    let sp = s.space();
    // 临时记号
    // 候选：单个墨块在先（干净的记号各是一块）；并过碎块的单元在后（扫描件断成几截的）。并块会把记号与正上、正下方的别的墨并到一起，所以不只看单元
    let (lo, hi) = band(f, si);
    let singles = f.blobs.iter().filter(|b| b.cx >= x_from && b.cx <= s.right && b.cy >= lo && b.cy < hi).map(|b| single(s, b.rect, b.id as i32, b.area as f64));
    let mut cands: Vec<_> = singles.collect();
    // 隔着线带断开的（降号肚子的上沿、下端正贴着谱线，被当成线，竖笔与肚子分成两块）
    let slit = ((ACC_SLIT * sp).round() as usize).max(2);
    for b in f.blobs.iter().filter(|b| b.cx >= x_from && b.cx <= s.right && b.cy >= lo && b.cy < hi && b.rect.h <= 3.7 * sp && b.rect.w <= 1.45 * sp) {
        let mut u = single(s, b.rect, b.id as i32, b.area as f64);
        let before = u.ids.len();
        for pid in bridged(f, b, slit) {
            if let Some(o) = f.blobs.iter().find(|o| o.id as i32 == pid) {
                u = merged(s, &u, &single(s, o.rect, pid, o.area as f64));
            }
        }
        if u.ids.len() > before {
            cands.push(u);
        }
    }
    cands.extend(units_in(f, s, x_from, s.right, POS_MIN as f64, POS_MAX as f64).into_iter().filter(|u| u.ids.len() > 1));
    // 已经认成记号的墨块不再进后面的候选
    let mut used: Vec<i32> = Vec::new();
    for u in cands {
        let r = u.rect;
        if u.ids.iter().any(|i| used.contains(i)) {
            continue;
        }
        // 含着头的单元是音符自己
        if row.chords.iter().any(|c| c.heads.iter().any(|h| h.x >= r.x && h.x <= r.right() && h.y >= r.y && h.y <= r.bottom())) {
            continue;
        }
        let Some(kind) = acc_kind(f, &u, sp) else { continue };
        let pos = acc_pos(&u, kind);
        let mut best: Option<(f64, usize, usize)> = None;
        for (ci, c) in row.chords.iter().enumerate() {
            for (hi, h) in c.heads.iter().enumerate() {
                let gap = (h.x - HEAD_HALF * sp - r.right()) / sp;
                // 先挑音级对得最准的（挨着的二度两个头都在容差里），再挑近的
                let off = (h.pos as f64 - pos).abs();
                let key = (off > 0.5) as u8 as f64 * 100.0 + gap;
                if off <= ACC_POS_TOL && gap >= ACC_GAP.0 && gap <= ACC_GAP.1 && best.is_none_or(|b| key < b.0) {
                    best = Some((key, ci, hi));
                }
            }
        }
        if let Some((_, ci, hi)) = best {
            let h = &mut row.chords[ci].heads[hi];
            used.extend(u.ids.iter().copied());
            if h.acc.is_none() {
                h.acc = Some(match kind {
                    Acc::Sharp => 1,
                    Acc::Flat => -1,
                    Acc::Natural => 0,
                });
            }
        }
    }
    // 附点：一个和弦里各头的点上下排成一列，点数 = 同一个间里横排着几个
    let repeat = |x: f64| f.bars.get(si).is_some_and(|bs| bs.iter().any(|b| (b.repeat_left && b.x > x && b.x - x < REPEAT_NEAR * sp) || (b.repeat_right && b.x < x && x - b.x < REPEAT_NEAR * sp)));
    let mut chord_dots: Vec<Vec<i32>> = vec![Vec::new(); row.chords.len()];
    for b in &f.blobs {
        let (w, h) = (b.rect.w / sp, b.rect.h / sp);
        let (cx, cy) = (b.rect.x + b.rect.w / 2.0, b.rect.y + b.rect.h / 2.0);
        if cx < x_from || cx > s.right || cy < lo || cy >= hi || w < DOT_SIZE.0 || w > DOT_SIZE.1 || h < DOT_SIZE.0 || h > DOT_SIZE.1 {
            continue;
        }
        if w / h < DOT_ASPECT.0 || w / h > DOT_ASPECT.1 || (b.area as f64) < DOT_FILL * b.rect.w * b.rect.h || repeat(cx) {
            continue;
        }
        let pos = s.pos(cx, cy);
        let space = ((pos - 1.0) / 2.0).round() * 2.0 + 1.0;
        if (pos - space).abs() > DOT_IN_SPACE {
            continue;
        }
        // 最近的头
        let mut best: Option<(f64, usize)> = None;
        for (ci, c) in row.chords.iter().enumerate() {
            for hd in &c.heads {
                let dx = (cx - hd.x) / sp;
                if dx >= DOT_DX.0 && dx <= DOT_DX.1 && (pos - hd.pos as f64).abs() <= DOT_NEAR_HEAD && best.is_none_or(|b| dx < b.0) {
                    best = Some((dx, ci));
                }
            }
        }
        if let Some((_, ci)) = best {
            chord_dots[ci].push(space as i32);
            continue;
        }
        if let Some(r) = row.rests.iter_mut().find(|r| {
            let dx = (cx - (r.rect.0 + r.rect.2)) / sp;
            dx >= REST_DOT_DX.0 && dx <= REST_DOT_DX.1 && cy >= r.rect.1 && cy <= r.rect.1 + r.rect.3
        }) {
            r.dots = (r.dots + 1).min(2);
        }
    }
    for (c, ds) in row.chords.iter_mut().zip(chord_dots) {
        c.dots = ds.iter().map(|d| ds.iter().filter(|e| *e == d).count()).max().unwrap_or(0).min(2) as u8;
    }
}
