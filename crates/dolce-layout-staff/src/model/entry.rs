//! NoteEntry 布局（加线/附点/临时记号避碰）。

use std::collections::{HashMap, HashSet};

use dolce_model::base::fraction::Fraction;
use dolce_model::base::js::{self, NumKey};
use dolce_engrave::scene::smufl::MetaData;

use super::*;

#[derive(Clone, Debug, Default)]
pub struct LegerLayout {
    /// 线号 → [左, 右]（JS `Map` 的插入序）
    pub ranges: Vec<(f64, [f64; 2])>,
}

impl LegerLayout {
    pub fn add_note(&mut self, line: f64, left: f64, right: f64) {
        let first: f64;
        let mut last: f64;
        if line > 1.0 {
            last = line;
            if last % 2.0 != 0.0 {
                last -= 1.0;
            }
            first = 2.0;
        } else if line <= -10.0 {
            last = -10.0;
            let mut f = line;
            if f % 2.0 != 0.0 {
                f += 1.0;
            }
            first = f;
        } else {
            return;
        }
        let mut l = first;
        while l <= last {
            if !(-8.0..=0.0).contains(&l) {
                match self.ranges.iter_mut().find(|(k, _)| NumKey::new(*k) == NumKey::new(l)) {
                    Some((_, old)) => *old = [js::min(old[0], left), js::max(old[1], right)],
                    None => self.ranges.push((l, [left, right])),
                }
            }
            l += 2.0;
        }
    }

    pub fn get(&self, l: f64) -> Option<[f64; 2]> {
        self.ranges.iter().find(|(k, _)| NumKey::new(*k) == NumKey::new(l)).map(|(_, v)| *v)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AccSegment {
    pub x: f64,
    pub top: f64,
    pub bottom: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AccItem {
    pub line: f64,
    pub text: String,
    pub symbols: Vec<String>,
    pub up: f64,
    pub down: f64,
    pub width: f64,
    pub scale: f64,
    pub xpos: Option<f64>,
    pub cut_out_ne: Option<XY>,
    pub cut_out_nw: Option<XY>,
    pub cut_out_se: Option<XY>,
    pub cut_out_sw: Option<XY>,
}

impl Default for AccItem {
    fn default() -> Self {
        AccItem {
            line: 0.0,
            text: String::new(),
            symbols: Vec::new(),
            up: 0.0,
            down: 0.0,
            width: 0.0,
            scale: 1.0,
            xpos: None,
            cut_out_ne: None,
            cut_out_nw: None,
            cut_out_se: None,
            cut_out_sw: None,
        }
    }
}

/// 一段纵向轮廓（`profile` 的产物）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AccProfileSeg {
    pub dx: f64,
    pub top: f64,
    pub bottom: f64,
}

/// TS 的 `meta` 字段不在这里存：`add_note` 时传。
#[derive(Clone, Debug, Default)]
pub struct AccidentalLayout {
    pub bound: Vec<AccSegment>,
    pub accidentals: Vec<AccItem>,
}

impl AccidentalLayout {
    pub fn add_note_bound(&mut self, line: f64, x: f64) {
        self.bound.push(AccSegment { x, top: -(line + 1.0) * 5.0, bottom: -(line - 1.0) * 5.0 });
    }

    pub fn add_note(&mut self, m: &MetaData, line: f64, x: f64, acc: &str, paren: bool, scale: f64) {
        self.add_note_bound(line, x);
        let mut item = AccItem { line, scale, ..AccItem::default() };
        if paren {
            let lp = gs("accidentalParensLeft");
            let rp = gs("accidentalParensRight");
            item.text = format!("{lp}{acc}{rp}");
            item.symbols = vec![lp.clone(), acc.to_owned(), rp.clone()];
            // 右括号的挖角从它自己的原点量，挪到整串的坐标里要加上前面两个字形的宽
            let rx = smufl_width(m, &lp) + smufl_width(m, acc);
            let shift = |c: Option<XY>| c.map(|c| XY { x: c.x + rx, y: c.y });
            item.cut_out_ne = shift(smufl_cut_out(m, &rp, "cutOutNE"));
            item.cut_out_se = shift(smufl_cut_out(m, &rp, "cutOutSE"));
            item.cut_out_nw = smufl_cut_out(m, &lp, "cutOutNW");
            item.cut_out_sw = smufl_cut_out(m, &lp, "cutOutSW");
            item.width = smufl_width(m, &lp) + smufl_width(m, &rp) + smufl_width(m, acc);
            item.down = -js_min_of([smufl_bottom(m, &lp), smufl_bottom(m, &rp), smufl_bottom(m, acc)]);
            item.up = -js_max_of([smufl_top(m, &lp), smufl_top(m, &rp), smufl_top(m, acc)]);
        } else {
            item.text = acc.to_owned();
            item.symbols = vec![acc.to_owned()];
            item.cut_out_ne = smufl_cut_out(m, acc, "cutOutNE");
            item.cut_out_se = smufl_cut_out(m, acc, "cutOutSE");
            item.cut_out_nw = smufl_cut_out(m, acc, "cutOutNW");
            item.cut_out_sw = smufl_cut_out(m, acc, "cutOutSW");
            item.down = -smufl_bottom(m, acc);
            item.up = -smufl_top(m, acc);
            item.width = smufl_width(m, acc);
        }
        self.accidentals.push(item);
    }

    /// 一个记号放在左缘 `pos` 时的**纵向分段轮廓**（本坐标 y 向下，基线 `refY = −line·5`）。
    /// SMuFL 挖角锚点（`cutOutNE` 等）从字形原点量、y 向上为正：右上挖角 (cx, cy) 表示 y 高于 cy 的那截墨迹只到 cx。
    /// `right = true` 给每段的右缘离 `pos` 多远（与右边已放的东西比），否则给左缘（登记成后面记号的边界）。
    pub fn profile(acc: &AccItem, right: bool) -> Vec<AccProfileSeg> {
        let sc = acc.scale;
        let ref_y = -acc.line * 5.0;
        let top = ref_y + acc.up * sc;
        let bottom = ref_y + acc.down * sc;
        let hi = if right { acc.cut_out_ne } else { acc.cut_out_nw };
        let lo = if right { acc.cut_out_se } else { acc.cut_out_sw };
        let full = if right { acc.width * sc } else { 0.0 };
        let mut out = Vec::new();
        let mut mid_top = top;
        let mut mid_bottom = bottom;
        if let Some(hi) = hi {
            let y = js::min(bottom, js::max(top, ref_y - hi.y * sc));
            if y > top {
                out.push(AccProfileSeg { dx: hi.x * sc, top, bottom: y });
            }
            mid_top = y;
        }
        if let Some(lo) = lo {
            let y = js::max(mid_top, js::min(bottom, ref_y - lo.y * sc));
            if bottom > y {
                out.push(AccProfileSeg { dx: lo.x * sc, top: y, bottom });
            }
            mid_bottom = y;
        }
        if mid_bottom > mid_top {
            out.push(AccProfileSeg { dx: full, top: mid_top, bottom: mid_bottom });
        }
        out
    }

    /// 这个记号最靠右能放在哪（左缘）：各段右缘不越过同高处已有东西的左缘
    pub fn try_put_item(&self, acc: &AccItem) -> f64 {
        let mut res = f64::INFINITY;
        for s in AccidentalLayout::profile(acc, true) {
            let mut left_most = f64::INFINITY;
            for b in &self.bound {
                if b.top >= s.bottom {
                    continue;
                }
                if s.top >= b.bottom {
                    continue;
                }
                left_most = js::min(left_most, b.x);
            }
            res = js::min(res, left_most - s.dx);
        }
        res
    }

    pub fn put_item(&mut self, pos: f64, i: usize) {
        self.accidentals[i].xpos = Some(pos);
        for s in AccidentalLayout::profile(&self.accidentals[i], false) {
            self.bound.push(AccSegment { x: pos + s.dx, top: s.top, bottom: s.bottom });
        }
    }

    pub fn update(&mut self) {
        js::sort_by(&mut self.accidentals, |a, b| b.line - a.line);
        loop {
            let mut best: Option<usize> = None;
            let mut best_pos = f64::NEG_INFINITY;
            for (i, it) in self.accidentals.iter().enumerate() {
                if it.xpos.is_some() {
                    continue;
                }
                let pos = self.try_put_item(it);
                if pos > best_pos {
                    best = Some(i);
                    best_pos = pos;
                }
            }
            let Some(best) = best else { break };
            self.put_item(best_pos - 1.0, best);
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct DotLayout {
    pub mutiple_voice: bool,
    pub notes: Vec<NoteId>,
    /// 附点所在的线（JS `Set` 的插入序）
    pub dots: Vec<f64>,
    pub dot_pos: f64,
}

impl DotLayout {
    pub fn add_note(&mut self, n: NoteId) {
        self.notes.push(n);
    }
    pub fn has(&self, l: f64) -> bool {
        self.dots.iter().any(|d| NumKey::new(*d) == NumKey::new(l))
    }
    fn add(&mut self, l: f64) {
        if !self.has(l) {
            self.dots.push(l);
        }
    }
}

#[derive(Clone, Debug)]
pub struct NoteEntry {
    pub notes: Vec<NoteId>,
    pub measure: PmId,
    pub leger: LegerLayout,
    pub dot: DotLayout,
    pub acc: AccidentalLayout,
    pub sub_staff: usize,
    pub offset: Fraction,
}

impl NoteEntry {
    pub fn new(measure: PmId) -> NoteEntry {
        NoteEntry {
            notes: Vec::new(),
            measure,
            leger: LegerLayout::default(),
            dot: DotLayout::default(),
            acc: AccidentalLayout::default(),
            sub_staff: 0,
            offset: Fraction::int(0.0),
        }
    }
}

impl<'d> StaffLayout<'d> {
    /// `DotLayout.update`
    pub fn dot_update(&self, d: &mut DotLayout) {
        d.dots.clear();
        d.dot_pos = 0.0;
        let mut done: HashSet<NoteId> = HashSet::new();
        let mut count: HashMap<NumKey, f64> = HashMap::new();
        for n in d.notes.clone() {
            let l = self.note_line(n);
            if l % 2.0 != 0.0 {
                d.add(l);
                done.insert(n);
            } else {
                *count.entry(NumKey::new(l)).or_insert(0.0) += 1.0;
            }
            let w = smufl_width(self.meta, &self[self[n].chord].sym());
            d.dot_pos = js::max(d.dot_pos, self[n].x + w + 3.0);
        }
        let notes = d.notes.clone();
        for &n in &notes {
            if done.contains(&n) {
                continue;
            }
            let l = self.note_line(n);
            if count.get(&NumKey::new(l)).copied().unwrap_or(0.0) > 1.0 {
                d.add(if self[self[n].chord].stem_up { l + 1.0 } else { l - 1.0 });
                done.insert(n);
            }
        }
        for &n in &notes {
            if done.contains(&n) {
                continue;
            }
            let l = self.note_line(n);
            if d.has(l + 1.0) {
                d.add(l - 1.0);
                done.insert(n);
                continue;
            }
            if d.has(l - 1.0) {
                d.add(l + 1.0);
                done.insert(n);
                continue;
            }
            if d.mutiple_voice {
                d.add(if self[self[n].chord].stem_up { l + 1.0 } else { l - 1.0 });
            } else {
                d.add(l + 1.0);
            }
            done.insert(n);
        }
    }

    /// NoteEntry::layout。`stem_clear`：符干朝下（干贴在符头左缘、正在临时记号右边）的和弦，临时记号离干至少再让这么多；
    /// 0 = 照原 C++ 工程只让符头（TS 缺省参数 0）
    pub fn entry_layout(&mut self, e: EntryId, sibelius: bool, stem_clear: f64) {
        self[e].dot = DotLayout::default();
        self[e].leger = LegerLayout::default();
        self[e].acc = AccidentalLayout::default();

        if sibelius {
            self.entry_layout_chords(e); // must before dot.layout
        }

        let mut dot = DotLayout::default();
        let mut leger = LegerLayout::default();
        let mut acc = AccidentalLayout::default();
        let notes = self[e].notes.clone();
        for &n in &notes {
            let line = self.note_line(n);
            let left = self[n].x;
            let ch = &self[self[n].chord];
            if ch.dot() > 0.0 {
                dot.add_note(n);
            }
            if ch.rest() {
                continue;
            }
            let w = smufl_width(self.meta, &ch.sym());
            let right = self[n].x + w;
            leger.add_note(line, left, right);
            let a = self[n].acc();
            if !a.is_empty() {
                acc.add_note(self.meta, line, left, &a, self[n].parentheses_acc(), 1.0);
            } else {
                acc.add_note_bound(line, left);
            }
        }
        if stem_clear > 0.0 {
            let mut chords: Vec<ChordId> = Vec::new();
            for &n in &notes {
                let c = self[n].chord;
                if !chords.contains(&c) {
                    chords.push(c);
                }
            }
            for c in chords {
                let ch = &self[c];
                if ch.rest() || ch.stem_up || f_ge(&ch.note_type(), &Fraction::int(4.0)) || !ch.notes.iter().any(|&n| !self[n].acc().is_empty()) {
                    continue;
                }
                let ys: Vec<f64> = ch.notes.iter().map(|&n| self.note_cy(n)).collect();
                let top = js_min_of(ys.iter().copied()) - 5.0;
                let bottom = js_max_of(std::iter::once(self.chord_tail_y(c, false)).chain(ys.iter().copied()));
                acc.bound.push(AccSegment { x: self.chord_stem_x(c) - stem_clear, top, bottom });
            }
        }
        self.dot_update(&mut dot);
        acc.update();
        let ent = &mut self[e];
        ent.dot = dot;
        ent.leger = leger;
        ent.acc = acc;
    }

    /// Sibelius 同 entry 多 chord 的水平错位修正（NoteEntry::layoutChords）。
    pub fn entry_layout_chords(&mut self, e: EntryId) {
        let mut arr: Vec<ChordId> = Vec::new();
        for i in 0..self[e].notes.len() {
            let c = self[self[e].notes[i]].chord;
            if self[c].rest() || self[c].grace() {
                continue;
            }
            if !arr.contains(&c) {
                arr.push(c);
            }
        }
        let four = Fraction::int(4.0);
        let dir = |sl: &Self, c: ChordId| -> f64 {
            let ch = &sl[c];
            if f_ge(&ch.note_type(), &four) {
                0.0
            } else if ch.stem_up {
                1.0
            } else {
                -1.0
            }
        };
        js::sort_by(&mut arr, |a, b| dir(self, *a) - dir(self, *b));
        for i in 0..arr.len() {
            let ch = arr[i];
            let top = self[*self[ch].notes.last().expect("和弦有音")].written_pitch;
            let bot = self[self[ch].notes[0]].written_pitch;
            let sym = self[ch].sym();
            for &chj in &arr[i + 1..] {
                let top2 = self[*self[chj].notes.last().expect("和弦有音")].written_pitch;
                let bot2 = self[self[chj].notes[0]].written_pitch;
                if top2 < bot - 1.0 {
                    continue;
                }
                if bot2 > top + 1.0 {
                    continue;
                }
                let mut same = bot2 == top || top2 == bot;
                let mut same_nh = sym == self[chj].sym() && self[ch].dot() == self[chj].dot();
                if is_glyph(&sym, "noteheadWhole") {
                    same_nh = false;
                }
                if !same_nh {
                    same = false;
                }
                if same {
                    continue;
                }
                let dw = self[chj].notehead_width(self.meta);
                let dx = self.chord_stem_x(chj) - self.chord_stem_x(ch);
                if self[chj].dot() > self[ch].dot() {
                    if dx > dw {
                        // keep
                    } else {
                        self.chord_offset_x_pos(ch, -dw);
                    }
                } else if dx.abs() < dw {
                    self.chord_offset_x_pos(ch, dw);
                }
            }
        }
    }
}
