//! 识别 id：**整曲拼接前按识别产物发号**（页序 → 页内谱行自上而下 → x；各种类各自编号），拼接时只取号。
//! 这样号码只取决于识别产物——满拍裁决删了哪个头、改关联表、钉住事实后重拼，别的元素号码都不变（删掉的留空号）。
//! 拼接里新造的元素（混排互证补的音）没有预发的号，接着往后续发。
use super::*;

pub(super) struct Ids {
    seq: RidSeq,
    /// 现在拼到第几页（1 起）与这一页的工作坐标放大倍数（源框折回原图像素用）。
    pub(super) page: usize,
    pub(super) up: f64,
    /// 各页各行谱的音符（头与休止带上号）：拼接从这里取，不从 `Page::notes` 取。
    pub(super) notes: Vec<Vec<RowNotes>>,
    /// 各页各行谱：各行歌词各音节的号。
    syls: Vec<Vec<Vec<Vec<Rid>>>>,
    /// 各页各行谱：各条记号的号（文字指示、节拍器、力度才有）。
    marks: Vec<Vec<Vec<Option<Rid>>>>,
    /// 各页：各条弧的号（与 `Page::spans.arcs` 同序）。
    arcs: Vec<Vec<Option<Rid>>>,
}

impl Ids {
    pub(super) fn new(pages: &[Page]) -> Ids {
        let mut seq = RidSeq::default();
        let mut notes = Vec::new();
        let (mut syls, mut marks, mut arcs) = (Vec::new(), Vec::new(), Vec::new());
        for page in pages {
            let ns = page.layout.staves.len();
            let mut pn: Vec<RowNotes> = page.notes.clone();
            let mut ps: Vec<Vec<Vec<Rid>>> = vec![Vec::new(); ns];
            let mut pm: Vec<Vec<Option<Rid>>> = vec![Vec::new(); ns];
            let mut pa: Vec<Option<Rid>> = vec![None; page.spans.arcs.len()];
            // 按页内全部谱行自上而下编，不经系统表：改系统切分、拿掉不要的行，号码都不变
            {
                for i in 0..ns {
                    // 头与休止按 x 合成一条（和弦里的头自上而下）
                    let row = &mut pn[i];
                    let mut items: Vec<(f64, usize, bool)> = row.chords.iter().enumerate().map(|(k, c)| (c.x, k, true)).chain(row.rests.iter().enumerate().map(|(k, r)| (r.x, k, false))).collect();
                    items.sort_by(|a, b| a.0.total_cmp(&b.0));
                    for (_, k, chord) in items {
                        if chord {
                            for h in row.chords[k].heads.iter_mut() {
                                h.rid = Some(seq.take(RidKind::Note));
                            }
                        } else {
                            row.rests[k].rid = Some(seq.take(RidKind::Note));
                        }
                    }
                    let text = &page.text.rows[i];
                    ps[i] = text.lyrics.iter().map(|l| l.row.syls.iter().map(|_| seq.take(RidKind::Lyric)).collect()).collect();
                    pm[i] = text
                        .marks
                        .iter()
                        .map(|m| match m.dir {
                            Dir::Words { .. } | Dir::Metronome { .. } => Some(seq.take(RidKind::Words)),
                            Dir::Dynamics(_) => Some(seq.take(RidKind::Dynamics)),
                            _ => None,
                        })
                        .collect();
                    for (k, a) in page.spans.arcs.iter().enumerate() {
                        if a.staff == i {
                            pa[k] = Some(seq.take(RidKind::Slur));
                        }
                    }
                }
            }
            notes.push(pn);
            syls.push(ps);
            marks.push(pm);
            arcs.push(pa);
        }
        Ids { seq, page: 1, up: 1.0, notes, syls, marks, arcs }
    }

    /// 页内工作坐标的框折成原图像素。
    pub(super) fn at(&self, r: Rect) -> SrcBox {
        SrcBox { page: self.page, rect: Rect::new(r.x / self.up, r.y / self.up, r.w / self.up, r.h / self.up) }
    }

    /// 预发的号（没有的——拼接里新造的元素——接着往后续发）与框。
    pub(super) fn src(&mut self, rid: Option<Rid>, kind: RidKind, r: Rect) -> Src {
        let rid = rid.unwrap_or_else(|| self.seq.take(kind));
        Src { rid: Some(rid), at: Some(self.at(r)) }
    }

    /// 第 `staff` 行谱第 `line` 行词第 `k` 个音节的号。
    pub(super) fn syl(&self, staff: usize, line: usize, k: usize) -> Option<Rid> {
        self.syls[self.page - 1].get(staff)?.get(line)?.get(k).copied()
    }

    /// 第 `staff` 行谱第 `m` 条记号的号。
    pub(super) fn mark(&self, staff: usize, m: usize) -> Option<Rid> {
        self.marks[self.page - 1].get(staff)?.get(m).copied().flatten()
    }

    /// 这一页第 `k` 条弧的号。
    pub(super) fn arc(&self, k: usize) -> Option<Rid> {
        self.arcs[self.page - 1].get(k).copied().flatten()
    }
}

/// 符头的源框（中心 ± 半个头；头宽按 1.3 格、头高 1 格估）。
pub(super) fn head_rect(x: f64, y: f64, sp: f64) -> Rect {
    Rect::new(x - 0.65 * sp, y - 0.5 * sp, 1.3 * sp, sp)
}
