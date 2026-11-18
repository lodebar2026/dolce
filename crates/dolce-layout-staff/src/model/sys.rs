//! 系统里的一行谱（`SysStaff`）与系统（`Sys`）。

use std::collections::HashMap;

use dolce_base::fraction::Fraction;
use dolce_base::js;
use dolce_engrave::arc::calc_slur_points;
use dolce_base::geom::Point;

use super::*;
use crate::jprow::grace_block_top;

/// 三次贝塞尔 B(t)（t∈[0,1]）在一个坐标分量上的最小值：比较端点与 B'(t)=0 的内部极值点。
pub fn cubic_min_y(p0: f64, p1: f64, p2: f64, p3: f64) -> f64 {
    let mut min = js::min(p0, p3);
    // B'(t)/3 = a t² + b t + c
    let a = -p0 + 3.0 * p1 - 3.0 * p2 + p3;
    let b = 2.0 * (p0 - 2.0 * p1 + p2);
    let c = p1 - p0;
    let mut at = |t: f64| {
        if t <= 0.0 || t >= 1.0 {
            return;
        }
        let u = 1.0 - t;
        min = js::min(min, u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3);
    };
    if a.abs() < 1e-12 {
        if b.abs() > 1e-12 {
            at(-c / b);
        }
    } else {
        let d = b * b - 4.0 * a * c;
        if d >= 0.0 {
            let s = d.sqrt();
            at((-b + s) / (2.0 * a));
            at((-b - s) / (2.0 * a));
        }
    }
    min
}

/// 同上，最大值。
pub fn cubic_max_y(p0: f64, p1: f64, p2: f64, p3: f64) -> f64 {
    -cubic_min_y(-p0, -p1, -p2, -p3)
}

/// 谱表横向轮廓的分段宽（tenths，约一个符头）
pub const SKYLINE_BIN: f64 = 8.0;

/// 谱表横向轮廓（`skyline` 的产物）。
#[derive(Clone, Debug, PartialEq)]
pub struct Skyline {
    pub above: Vec<f64>,
    pub below: Vec<f64>,
}

#[derive(Clone, Debug)]
pub struct SysStaff {
    pub part_staff: PsRef,
    pub distance: f64,
    /// 与上一可见谱表不相碰的最小距离（自动铺排 `autoStaffDistances` 量的）；源谱版面档一页排不下时压到它为止
    pub min_distance: f64,
    /// 原谱的谱表距离（`autoStaffDistances` 头一次撑开之前的 `distance`）：装页时按它算这个系统比原谱长高了多少
    pub src_distance: Option<f64>,
    pub staff_lines: f64,
    pub staff_scale: f64,
    pub staff_visible: bool,
    // for mix
    pub min_y: f64,
    pub harmony_y: f64,
    pub has_harmony: bool,
}

impl SysStaff {
    pub fn new(part_staff: PsRef) -> SysStaff {
        SysStaff {
            part_staff,
            distance: 0.0,
            min_distance: 0.0,
            src_distance: None,
            staff_lines: 5.0,
            staff_scale: 1.0,
            staff_visible: true,
            min_y: 0.0,
            harmony_y: 0.0,
            has_harmony: false,
        }
    }
    pub fn height(&self) -> f64 {
        self.staff_scale * (self.staff_lines - 1.0) * 10.0
    }
    pub fn part(&self) -> PartId {
        self.part_staff.part
    }
    pub fn sub_index(&self) -> usize {
        self.part_staff.sub
    }
}

#[derive(Clone, Debug, Default)]
pub struct Sys {
    pub index: usize,
    pub distance: f64,
    pub first_measure: usize,
    pub left_margin: f64,
    pub right_margin: f64,
    pub key_change_width: f64,
    pub time_change_width: f64,
    pub measures: Vec<MeasId>,
    pub staves: Vec<SysStaff>,
}

impl Sys {
    pub fn top(&self) -> f64 {
        self.distance
    }

    pub fn ypos(&self, stf: usize) -> f64 {
        let mut res = 0.0;
        for i in 0..=stf {
            if self.staves[i].staff_visible {
                res += self.staves[i].distance;
                if i < stf {
                    res += self.staff_height(i);
                }
            }
        }
        res
    }

    /// TS `yposPart(p, sub = 0)`
    pub fn ypos_part(&self, p: PartId, sub: usize) -> f64 {
        let mut res = 0.0;
        for stf in &self.staves {
            if !stf.staff_visible {
                continue;
            }
            res += stf.distance;
            if stf.part() == p && sub == stf.sub_index() {
                break;
            }
            res += stf.height();
        }
        res
    }

    pub fn height(&self) -> f64 {
        let mut res = 0.0;
        for i in 0..self.staves.len() {
            if self.staves[i].staff_visible {
                res += self.staff_height(i);
                res += self.staves[i].distance;
            }
        }
        res
    }

    pub fn staff_height(&self, i: usize) -> f64 {
        let stf = &self.staves[i];
        stf.staff_scale * (stf.staff_lines - 1.0) * 10.0
    }

    pub fn visible_staves(&self) -> usize {
        self.staves.iter().filter(|s| s.staff_visible).count()
    }
}

/// 一段 `put`（`skyline` 里的闭包）。
fn sky_put(above: &mut [f64], below: &mut [f64], n: usize, x0: f64, x1: f64, top: f64, bot: f64) {
    let b0 = js::max(0.0, (x0 / SKYLINE_BIN).floor());
    let b1 = js::min(n as f64 - 1.0, (x1 / SKYLINE_BIN).floor());
    let mut b = b0;
    while b <= b1 {
        let i = b as usize;
        above[i] = js::max(above[i], -top);
        below[i] = js::max(below[i], bot);
        b += 1.0;
    }
}

impl<'d> StaffLayout<'d> {
    pub fn new_system(&mut self, s: Sys) -> SysId {
        let id = SysId(self.systems.len());
        self.systems.push(s);
        id
    }

    // ───────── Sys ─────────

    pub fn sys_ypos(&self, s: SysId, stf: usize) -> f64 {
        self[s].ypos(stf)
    }

    pub fn sys_visible_staves_of(&self, s: SysId, grp: &PartGroup) -> (isize, isize) {
        let mut first: isize = -1;
        let mut last: isize = -1;
        for &p in &grp.parts {
            for (k, st) in self[p].staves.iter().enumerate() {
                if let Some((a, b)) = grp.staff_range {
                    if k < a || k > b {
                        continue;
                    }
                }
                let stf = st.order;
                if !self[s].staves[stf].staff_visible {
                    continue;
                }
                if first < 0 {
                    first = stf as isize;
                }
                last = stf as isize;
            }
        }
        (first, last)
    }

    pub fn sys_width(&self, s: SysId) -> f64 {
        let mut res = 0.0;
        for &m in &self[s].measures {
            res += self[m].width;
        }
        res
    }

    pub fn sys_overlap(&self, s: SysId, obj: &SpanObj) -> bool {
        let start = self.sys_begin_tick(s);
        let end = self.sys_end_tick(s);
        if f_ge(&obj.start_tick, &end) {
            return false;
        }
        if f_le(&obj.end_tick, &start) {
            return false;
        }
        true
    }

    pub fn sys_contains(&self, s: SysId, t: &Fraction) -> bool {
        let start = self.sys_begin_tick(s);
        let end = self.sys_end_tick(s);
        f_ge(t, &start) && f_le(t, &end)
    }

    pub fn sys_begin_tick(&self, s: SysId) -> Fraction {
        self[self[s].measures[0]].offset
    }
    pub fn sys_end_tick(&self, s: SysId) -> Fraction {
        let last = &self[*self[s].measures.last().expect("系统里有小节")];
        last.offset.plus(&last.dur)
    }

    /// 跨 part 小节线分组（System::barlineGroups）：`(首行, 末行)`，次序同 TS 的 Map（先各组、再落单的行）。
    pub fn sys_barline_groups(&self, s: SysId) -> Vec<(usize, usize)> {
        let sys = &self[s];
        let mut single: Vec<usize> = Vec::new();
        let mut part_start: HashMap<PartId, usize> = HashMap::new();
        let mut part_end: HashMap<PartId, usize> = HashMap::new();
        let mut stf = 0usize;
        for (i, p) in self.parts.iter().enumerate() {
            part_start.insert(PartId(i), stf);
            stf += p.staves.len();
            part_end.insert(PartId(i), stf);
        }
        let mut pool: Vec<(usize, usize)> = Vec::new();
        let overlap_r = |a: (usize, usize), b: (usize, usize)| a.0 < b.1 && b.0 < a.1;
        for grp in &self.part_groups {
            if !grp.barline {
                continue;
            }
            let pa = grp.parts[0];
            let pb = grp.parts[grp.parts.len() - 1];
            let mut p = (part_start[&pa], part_end[&pb]);
            let mut i = pool.len();
            while i > 0 {
                i -= 1;
                if overlap_r(pool[i], p) {
                    p = (pool[i].0.min(p.0), pool[i].1.max(p.1));
                    pool.remove(i);
                }
            }
            pool.push(p);
        }
        for i in 0..sys.staves.len() {
            if sys.staves[i].staff_visible {
                single.push(i);
            }
        }
        let mut groups: Vec<(usize, usize)> = Vec::new();
        let set = |groups: &mut Vec<(usize, usize)>, k: usize, v: usize| match groups.iter_mut().find(|g| g.0 == k) {
            Some(g) => g.1 = v,
            None => groups.push((k, v)),
        };
        for p in &pool {
            let mut first: isize = -1;
            let mut last: isize = -1;
            for i in p.0..p.1 {
                single.retain(|&x| x != i);
                // TS `this.staves[i].staffVisible`：越界取不到、抛错
                if sys.staves[i].staff_visible {
                    if first < 0 {
                        first = i as isize;
                    }
                    last = i as isize;
                }
            }
            if first < 0 {
                continue;
            }
            set(&mut groups, first as usize, last as usize);
        }
        for it in single {
            set(&mut groups, it, it);
        }
        groups
    }

    /// Sibelius 行首调号变更的偏移（System::fixSibKeyChange）。
    pub fn sys_fix_sib_key_change(&mut self, s: SysId) {
        for i in 1..self[s].measures.len() {
            let m = self[s].measures[i];
            let cur = &mut self[m];
            if cur.key_pos.is_none() {
                continue;
            }
            let mut end_pos = 0.0;
            if let Some(c) = cur.clef_pos {
                end_pos = c;
            }
            let mut next_pos = cur.data_pos;
            if let Some(t) = cur.time_pos {
                next_pos = t;
            }
            cur.sib_key_offset = next_pos - end_pos;
        }
    }

    /// System::getYBound：[top, bot]。
    pub fn sys_get_y_bound(&self, s: SysId) -> [f64; 2] {
        let mut first: isize = -1;
        let mut last: isize = -1;
        for (idx, st) in self[s].staves.iter().enumerate() {
            if !st.staff_visible {
                continue;
            }
            if first < 0 {
                first = idx as isize;
            }
            last = idx as isize;
        }
        // TS `this.staves[-1]` 取不到、抛错；这里 panic
        let [top, _] = self.sys_staff_get_y_bound(s, first as usize);
        let [_, mut bot] = self.sys_staff_get_y_bound(s, last as usize);
        bot -= self[s].ypos(last as usize);
        [top, bot]
    }

    // ───────── SysStaff（`k` 是它在 `sys.staves` 里的下标） ─────────

    /// 和弦符号画出来的上下沿，相对 `HarmonyLayout.y`（向上为正）：`drawHarmony` 把基线放在 `y − descent`。
    pub fn harmony_band(&self) -> [f64; 2] {
        let eng = &self.options;
        let m = Font::new(eng.word_font.clone(), eng.harmony_size / self.scaling).metrics(self.mc);
        [-m.ascent - m.descent, -2.0 * m.descent]
    }

    /// 第一个字形（`makeNumber(...)[0] ?? ""`）。
    fn first_glyph(s: &str) -> String {
        s.chars().next().map(String::from).unwrap_or_default()
    }

    /// SysStaff::calcMixedStaffY（model.cpp:2849）。
    pub fn sys_staff_calc_mixed_staff_y(&mut self, s: SysId, k: usize) {
        let first = self[s].first_measure;
        let cnt = self[s].measures.len();
        let ps = self[s].staves[k].part_staff;
        let pt = ps.part;
        let nota = self.part_staff(ps).get_notation(&self[self[s].measures[0]].offset);
        let mixed = nota == Notation::Mixed;
        let music_size = self.options.music_font.size;
        // 防止混排简谱离五线谱太近；纯五线谱（自动铺排的五线谱档）就从顶线量起
        let mut miny = if mixed { -10.0 } else { 0.0 };
        let four = Fraction::int(4.0);
        for m in first..first + cnt {
            let mea = self[pt].measures[m];
            for &c in &self[mea].chords {
                let ch = &self[c];
                if f_lt(&ch.note_type(), &four) && ch.stem_up {
                    let mut y = self.chord_tail_y(c, true);
                    if !ch.notations.is_empty() {
                        y -= 20.0;
                    }
                    if y < miny {
                        miny = y;
                    }
                }
                // 谱表上方的记号（延长记号、重音…）按**画出来的**字形墨迹顶算：混排时简谱层摞在这个上沿之上，
                // 只按符干估会让延长记号压到简谱数字上（044《真神妙爱》末音）
                for nota in &ch.notations {
                    if !nota.above || !nota.y.is_finite() {
                        continue;
                    }
                    if let Some(bb) = get_bbox(self.meta, &nota.symbol) {
                        miny = js::min(miny, nota.y - bb.ne[1] * (music_size / 4.0) - 5.0);
                    }
                }
            }
        }
        for &sl in &self[pt].slurs {
            if !self.sys_overlap(s, &self[sl].span) {
                continue;
            }
            if !self[sl].span.above {
                continue;
            }
            if self.sys_contains(s, &self[sl].span.start_tick) && self.sys_contains(s, &self[sl].span.end_tick) {
                let (pl, pr) = self.slur_tied_pos(Some(self.slur_start_chord(sl)), Some(self.slur_end_chord(sl)), true);
                let (pt0, pt1, _) = calc_slur_points(Point::new(pl.x, pl.y), Point::new(pr.x, pr.y), &mixed_slur_style(true));
                // 曲线紧包围盒上沿（照 CGPathGetPathBoundingBox；控制点不在曲线上，取控制点最小值会偏高）
                let top = cubic_min_y(pl.y, pt0.y, pt1.y, pr.y);
                miny = js::min(miny, top - 1.0);
            }
        }

        // 放到上方的连音数字（自动铺排：符杠在上时数字随符杠，见 autoPlaceTuplets）
        let fs_scale = music_size / 40.0;
        for &t in &self[pt].tuplets {
            let tp = &self[t];
            if !tp.span.above || !self.sys_contains(s, &tp.span.start_tick) || !self.sys_contains(s, &tp.span.end_tick) {
                continue;
            }
            let [ly, ry] = self.tuplet_staff_ends(t);
            let g0 = Self::first_glyph(&Tuplet::make_number(tp.time_modification.denominator));
            let num_h = (smufl_top(self.meta, &g0) - smufl_bottom(self.meta, &g0)) * fs_scale;
            miny = js::min(miny, (ly + ry) / 2.0 - num_h / 2.0 - 2.0);
        }

        // 自动铺排（原谱没坐标）再看几样 musicpp 不看的上沿：符头（朝下符干的高音）、上方记号、上方延音线、
        // 跨行的上方弧。五线谱档的和弦也靠这个 minY 定高（`placeAboveStaff`）
        if self.auto_layout {
            miny = js::min(miny, self.sys_staff_auto_extent(s, k)[0]);
        }

        self.systems[s.0].staves[k].min_y = miny;

        let cnt_m = self[s].measures.len();
        let mut dy = 5.0;
        let mut has_harmony = self[s].staves[k].has_harmony;
        for i in 0..cnt_m {
            let mid = first + i;
            let md = self[pt].measures[mid];
            let mif = self[md].measure_info;
            let mut harmony_texts: HashMap<String, String> = HashMap::new();
            for &h in &self[md].harmonies {
                has_harmony = true;
                let t = self[mif].offset.plus(&self[h].offset);
                harmony_texts.insert(frac_key(&t), self[h].as_plain_text(None));
            }
            for &c in &self[md].chords {
                let t = self[mif].offset.plus(&self[c].offset);
                let Some(ht) = harmony_texts.get(&frac_key(&t)) else { continue };
                let mut slur_end = false;
                let mut slur_middle = false;
                for &sl in &self[pt].slurs {
                    let sp = &self[sl].span;
                    if f_eq(&sp.start_tick, &t) || f_eq(&sp.end_tick, &t) {
                        slur_end = true;
                    } else if f_lt(&sp.start_tick, &t) && f_gt(&sp.end_tick, &t) {
                        slur_middle = true;
                        break;
                    }
                }
                let mut tied_end = false;
                let mut tied_middle = false;
                for &sl in &self[pt].tied {
                    let sp = &self[sl].span;
                    if f_eq(&sp.start_tick, &t) || f_eq(&sp.end_tick, &t) {
                        tied_end = true;
                    } else if f_lt(&sp.start_tick, &t) && f_gt(&sp.end_tick, &t) {
                        tied_middle = true;
                        break;
                    }
                }
                let mut yy = 5.0;
                for &nt in &self[c].notes {
                    if !self[nt].jp_melody {
                        continue;
                    }
                    let oct = self.note_octave_jp(nt);
                    if oct > 0.0 {
                        yy += 5.0;
                    }
                }
                // `ht.length`：UTF-16 长度
                let offset = if ht.encode_utf16().count() > 1 { 10.0 } else { 5.0 };
                if slur_middle {
                    yy += 15.0;
                } else if slur_end {
                    yy += offset;
                }
                if tied_middle {
                    yy += 15.0;
                } else if tied_end {
                    yy += offset;
                }
                if yy > dy {
                    dy = yy;
                }
            }
            // 倚音整块抬在主音之上（`jprow::grace_row`），这一小节有和弦时和弦行要让开它的墨迹顶
            //（和弦基线 = 简谱层原点之上 dy + 3，见 placeAboveStaff）。260《感恩的泪》的倚音 6 原先顶着 Bm
            if mixed && !self[md].harmonies.is_empty() {
                for &c in &self[md].chords {
                    if !self[c].grace() || self[c].rest() {
                        continue;
                    }
                    let top = grace_block_top(self, md, c);
                    dy = js::max(dy, -top - 3.0 + MIXED_GRACE_CHORD_GAP);
                }
            }
        }

        let eng = &self.options;
        let mut yval = miny - eng.mix_staff_dist - eng.mix_staff_height;
        if !mixed {
            yval = miny - eng.mix_staff_dist;
        }
        if dy < 8.0 {
            dy = 8.0;
        }
        let st = &mut self.systems[s.0].staves[k];
        st.has_harmony = has_harmony;
        st.harmony_y = -yval + dy;
    }

    /// 自动铺排（原谱没坐标）时本谱表在这一行的内容上下沿 [top, bottom]（cy 口径，向下为正）：符头（含加线）、符干端、
    /// 上下方记号、画出来的弧（`slurEnds`/`tiedEnds` + `arcExtent`，跨行的按本行那一截）、连音数字。
    /// musicpp 的 `getYBound` 只看朝上/朝下符干端和最低的符头，朝下符干的高音、上方弧与连音数字都不算，
    /// 行距就按它排、高音压到上一行谱上（issue 9）。
    pub fn sys_staff_auto_extent(&self, s: SysId, k: usize) -> [f64; 2] {
        let ps = self[s].staves[k].part_staff;
        let pt = ps.part;
        let sub = ps.sub;
        let four = Fraction::int(4.0);
        let mut top: f64 = 0.0;
        let mut bot: f64 = 40.0;
        for &mif in &self[s].measures {
            let Some(&md) = self[pt].measures.get(self[mif].index) else { continue };
            for &c in &self[md].chords {
                let ch = &self[c];
                if ch.rest() || ch.notes.first().map(|&n| self.note_staff(n)) != Some(sub) {
                    continue;
                }
                let mut hi = f64::INFINITY;
                let mut lo = f64::NEG_INFINITY;
                for &nt in &ch.notes {
                    hi = js::min(hi, self.note_cy(nt) - 6.0);
                    lo = js::max(lo, self.note_cy(nt) + 6.0);
                }
                if f_lt(&ch.note_type(), &four) {
                    if ch.stem_up {
                        hi = js::min(hi, self.chord_tail_y(c, true));
                    } else {
                        lo = js::max(lo, self.chord_tail_y(c, false));
                    }
                }
                if ch.has_notation(true) {
                    hi -= 20.0;
                }
                if ch.has_notation(false) {
                    lo += 20.0;
                }
                top = js::min(top, hi);
                bot = js::max(bot, lo);
            }
        }
        let mut arcs: Vec<Option<ArcEnds>> = Vec::new();
        for &t in &self[pt].tied {
            if self[t].notes.start_note.map(|n| self.note_staff(n)) == Some(sub) {
                arcs.push(self.tied_ends(s, t, Some(Notation::Normal)));
            }
        }
        for &sl in &self[pt].slurs {
            if self[sl].notes.start_note.map(|n| self.note_staff(n)) == Some(sub) {
                arcs.push(self.slur_ends(s, sl, Some(Notation::Normal)));
            }
        }
        // 弧的坐标按声部第一谱表量（`slurTiedPos` 加了 `staffY`）：第二谱表起要折回本谱表（钢琴低音谱表的弧从前被当成在谱表下方
        // 一整个谱表距离处，谱表间距撑开两三倍）
        let off = if sub != 0 { self[pt].measures.get(self[s].first_measure).map_or(0.0, |&md| self.pm_staff_y(md, sub)) } else { 0.0 };
        for e in arcs.into_iter().flatten() {
            let [a, b] = arc_extent(&e);
            if e.above {
                top = js::min(top, a - off - 2.0);
            } else {
                bot = js::max(bot, b - off + 2.0);
            }
        }
        let fs_scale = self.options.music_font.size / 40.0;
        for &t in &self[pt].tuplets {
            let tp = &self[t];
            if tp.notes.start_note.map(|n| self.note_staff(n)) != Some(sub) || !self.sys_contains(s, &tp.span.start_tick) || !self.sys_contains(s, &tp.span.end_tick) {
                continue;
            }
            let [ly, ry] = self.tuplet_staff_ends(t);
            let g0 = Self::first_glyph(&Tuplet::make_number(tp.time_modification.denominator));
            let half = (smufl_top(self.meta, &g0) - smufl_bottom(self.meta, &g0)) * fs_scale / 2.0 + 2.0;
            if tp.span.above {
                top = js::min(top, (ly + ry) / 2.0 - half);
            } else {
                bot = js::max(bot, (ly + ry) / 2.0 + half);
            }
        }
        [top, bot]
    }

    /// 本谱表在这一行的**横向轮廓**：按 `SKYLINE_BIN` 宽分段，每段记墨迹伸到谱表顶线以上多高（`above`，≥0）、
    /// 以下多深（`below`，≥ 谱表高）。源谱版面档定谱表距离用（`autoStaffDistances`）：上一行的低音与
    /// 下一行的高音错开在不同 x 上时，整行最低点对整行最高点要白白多留一大截。
    /// 认的东西与 `getYBound` / `autoExtent` 同一份；横向位置拿不准的（文字指示、和弦）按所在小节整宽算。
    /// `notes_only`：只量音符、弧、连音数字（不量歌词、文字、和弦）——谱表上方的文字按它贴（`placePartAboveStaff`）。
    pub fn sys_staff_skyline(&self, s: SysId, k: usize, notes_only: bool) -> Skyline {
        let eng = &self.options;
        let stf = &self[s].staves[k];
        let pt = stf.part_staff.part;
        let sub = stf.part_staff.sub;
        let four = Fraction::int(4.0);
        let width = self[s].measures.iter().fold(0.0, |a, &m| a + self[m].width);
        let nf = js::max(1.0, (width / SKYLINE_BIN).ceil());
        // TS `new Array(n)`：n 非整数 / NaN 抛 RangeError；这里按 usize 截
        let n = nf as usize;
        let mut above = vec![0.0; n];
        let mut below = vec![stf.height(); n];
        // y 为 cy 口径（向下为正、顶线 0）
        let band = self.harmony_band()[0];
        let meta = self.meta;
        for &mif in &self[s].measures {
            let Some(&md) = self[pt].measures.get(self[mif].index) else { continue };
            let x0 = self.measure_xpos(mif);
            let x1 = x0 + self[mif].width;
            for &c in &self[md].chords {
                let ch = &self[c];
                if ch.rest() || ch.notes.first().map(|&n| self.note_staff(n)) != Some(sub) {
                    continue;
                }
                let mut hi = f64::INFINITY;
                let mut lo = f64::NEG_INFINITY;
                for &nt in &ch.notes {
                    hi = js::min(hi, self.note_cy(nt) - 6.0);
                    lo = js::max(lo, self.note_cy(nt) + 6.0);
                }
                if f_lt(&ch.note_type(), &four) {
                    if ch.stem_up {
                        hi = js::min(hi, self.chord_tail_y(c, true));
                    } else {
                        lo = js::max(lo, self.chord_tail_y(c, false));
                    }
                }
                if ch.has_notation(true) {
                    hi -= 20.0;
                }
                if ch.has_notation(false) {
                    lo += 20.0;
                }
                let x = x0 + self[ch.notes[0]].x;
                // 临时记号在符头左边，符尾在右边：左让一个半符头、右让一个
                sky_put(&mut above, &mut below, n, x - 18.0, x + 14.0, hi, lo);
            }
            if notes_only {
                continue;
            }
            for &l in &self[md].lyrics {
                let lrc = &self[l];
                if self.lyric_staff(l) != sub as f64 || lrc.x < 0.0 {
                    continue;
                }
                let lx = x0 + lrc.x + lrc.x_offset; // 字的左缘（`updateWidth` 把居中折进了 xOffset）
                // 谱表上方的词（`lrc.y` 是基线、向上为正）：字顶约在基线上一个字号
                if lrc.y > 0.0 {
                    sky_put(&mut above, &mut below, n, lx - 2.0, lx + lrc.width + 2.0, -(lrc.y + lrc.font.size), 40.0);
                } else {
                    // 下沿取字体的下伸（汉字墨迹只沉到基线下一点，从前一律 +10 把谱表间距撑大，破碎 49 小节那行）
                    let desc = lrc.font.metrics(self.mc).descent;
                    sky_put(&mut above, &mut below, n, lx - 2.0, lx + lrc.width + 2.0, 40.0, -lrc.y + js::min(10.0, desc));
                }
            }
            for &ti in &self[md].text_blocks {
                let t = &self[ti];
                if t.staff != sub {
                    continue;
                }
                let h = tight_line_heights(t, meta, self.mc, eng.music_font.size, eng.text_line_height_by_size);
                if h.is_empty() {
                    continue;
                }
                let hh = h.iter().fold(0.0, |a, b| a + b);
                // 文字块的横坐标：`updateDataXPos` 之前是相对拍位的偏移，之后已加上拍位
                let tx = x0 + t.x + if t.relative && !self.data_x_placed { self.measure_get_ent_pos(mif, &t.offset) } else { 0.0 };
                sky_put(&mut above, &mut below, n, tx - 2.0, tx + t.width(self.mc) + 2.0, -(t.y + h[0]), -(t.y - hh));
            }
            for &h in &self[md].harmonies {
                sky_put(&mut above, &mut below, n, x0, x1, -(self[h].y + band), 40.0);
            }
        }
        let off = if sub != 0 { self[pt].measures.get(self[s].first_measure).map_or(0.0, |&md| self.pm_staff_y(md, sub)) } else { 0.0 };
        let mut arcs: Vec<Option<ArcEnds>> = Vec::new();
        for &t in &self[pt].tied {
            if self[t].notes.start_note.map(|n| self.note_staff(n)) == Some(sub) {
                arcs.push(self.tied_ends(s, t, Some(Notation::Normal)));
            }
        }
        // 跨谱表的弧（两端不在同一谱表：钢琴左手琶音连进右手谱表）两端跟着谱表走，不是谱表之间要让开的东西
        for &sl in &self[pt].slurs {
            let sn = self[sl].notes.start_note.map(|n| self.note_staff(n));
            let en = self[sl].notes.end_note;
            if sn == Some(sub) && en.is_none_or(|e| self.note_staff(e) == sub) {
                arcs.push(self.slur_ends(s, sl, Some(Notation::Normal)));
            }
        }
        for e in arcs.into_iter().flatten() {
            let [a, b] = arc_extent(&e);
            sky_put(
                &mut above,
                &mut below,
                n,
                js::min(e.plx, e.prx),
                js::max(e.plx, e.prx),
                if e.above { a - off - 2.0 } else { 40.0 },
                if e.above { 0.0 } else { b - off + 2.0 },
            );
        }
        for &w in &self[pt].wedges {
            let wd = &self[w];
            if wd.staff != sub || (!self.sys_contains(s, &wd.span.start_tick) && !self.sys_contains(s, &wd.span.end_tick)) {
                continue;
            }
            let xs: Vec<MeasId> = self[s]
                .measures
                .iter()
                .copied()
                .filter(|&m| m == wd.start_measure || m == wd.end_measure || (f_gt(&self[m].offset, &wd.span.start_tick) && f_lt(&self[m].offset, &wd.span.end_tick)))
                .collect();
            let (Some(&a), Some(&b)) = (xs.first(), xs.last()) else { continue };
            sky_put(&mut above, &mut below, n, self.measure_xpos(a), self.measure_xpos(b) + self[b].width, wd.ypos - 9.5, wd.ypos + 9.5);
        }
        let fs_scale = eng.music_font.size / 40.0;
        for &t in &self[pt].tuplets {
            let tp = &self[t];
            if tp.notes.start_note.map(|n| self.note_staff(n)) != Some(sub) || !self.sys_contains(s, &tp.span.start_tick) || !self.sys_contains(s, &tp.span.end_tick) {
                continue;
            }
            let [ly, ry] = self.tuplet_staff_ends(t);
            let g0 = Self::first_glyph(&Tuplet::make_number(tp.time_modification.denominator));
            let half = (smufl_top(meta, &g0) - smufl_bottom(meta, &g0)) * fs_scale / 2.0 + 2.0;
            let y = (ly + ry) / 2.0;
            sky_put(&mut above, &mut below, n, 0.0, width, if tp.span.above { y - half } else { 40.0 }, if tp.span.above { 0.0 } else { y + half });
        }
        Skyline { above, below }
    }

    /// SysStaff::getYBound（model.cpp:2745）。返回 [top, bot]（top 为上方延伸量，向上为正）。
    /// 自动铺排再并上 `autoExtent`。
    pub fn sys_staff_get_y_bound(&self, s: SysId, k: usize) -> [f64; 2] {
        let mut min_y = -60.0;
        let mut max_y = f64::NEG_INFINITY;
        let sys = &self[s];
        let stf = &sys.staves[k];
        let pt = stf.part_staff.part;
        let sub = stf.part_staff.sub;
        let t0 = self[sys.measures[0]].offset;
        let t1 = self[*sys.measures.last().expect("系统里有小节")].end_tick();
        let nota = self.part_staff(stf.part_staff).get_notation(&t0);
        let mixed = nota == Notation::Mixed;
        if mixed {
            max_y = -stf.min_y + 35.0;
        }
        let mut has_ending = false;
        for &e in &self[pt].endings {
            let sp = &self[e].span;
            if f_ge(&sp.start_tick, &t1) {
                continue;
            }
            if f_le(&sp.end_tick, &t0) {
                continue;
            }
            has_ending = true;
        }
        let mut has_slur = false;
        for &sl in &self[pt].slurs {
            let sp = &self[sl].span;
            if f_ge(&sp.start_tick, &t1) {
                continue;
            }
            if f_le(&sp.end_tick, &t0) {
                continue;
            }
            if self.note_staff(self[sl].notes.start_note.expect("圆滑线有起音")) != sub {
                continue;
            }
            has_slur = true;
        }
        for &sl in &self[pt].tied {
            let sp = &self[sl].span;
            if f_ge(&sp.start_tick, &t1) {
                continue;
            }
            if f_le(&sp.end_tick, &t0) {
                continue;
            }
            if self.note_staff(self[sl].notes.start_note.expect("延音线有起音")) != sub {
                continue;
            }
            has_slur = true;
        }
        if has_slur && mixed {
            max_y += 15.0;
        }
        // 混排的房号排在简谱层之上（`drawEnding`：竖脚 20 + 离简谱层 16 + 房号与横线的余量），行距要给它留出来
        if has_ending && mixed {
            max_y += MIXED_ENDING_BAND;
        }
        let first = sys.first_measure;
        let cnt = sys.measures.len();
        let four = Fraction::int(4.0);
        for m in first..first + cnt {
            let mea = self[pt].measures[m];
            for &h in &self[mea].harmonies {
                // 自动铺排按真实字高（和弦字号按 scaling 折算后约 18 tenths）；带坐标的谱照 musicpp 的 10
                let mut y = self[h].y + if self.auto_layout { self.harmony_band()[0] } else { 10.0 };
                if has_ending {
                    y += 25.0;
                }
                if y > max_y {
                    max_y = y;
                }
            }
            for &l in &self[mea].lyrics {
                let lrc = &self[l];
                // 谱表上方的词往上撑
                if lrc.y > 0.0 {
                    if lrc.y + lrc.font.size > max_y {
                        max_y = lrc.y + lrc.font.size;
                    }
                    continue;
                }
                let y = lrc.y - 10.0;
                if y < min_y {
                    min_y = y;
                }
            }
            for &ti in &self[mea].text_blocks {
                // 文本垂直延伸：音乐字形（力度/节拍记号）用真实包围盒，避免 Bravura 字体 em 框
                // 虚高（descent-ascent 可达 ~14 个 staff space）把谱表间距撑大；文本用字体度量。
                let t = &self[ti];
                let h = tight_line_heights(t, self.meta, self.mc, self.options.music_font.size, self.options.text_line_height_by_size);
                if h.is_empty() {
                    continue;
                }
                let hh = h.iter().fold(0.0, |a, b| a + b);
                let mut y = t.y + h[0];
                if y > max_y {
                    max_y = y;
                }
                y = t.y - hh;
                if y < min_y {
                    min_y = y;
                }
            }
            for &c in &self[mea].chords {
                let ch = &self[c];
                let mut y: f64;
                if f_lt(&ch.note_type(), &four) {
                    if ch.stem_up {
                        y = -self.chord_tail_y(c, false);
                        if ch.has_notation(true) {
                            y += 20.0;
                        }
                        if y > max_y {
                            max_y = y;
                        }
                    } else {
                        y = -self.chord_tail_y(c, false);
                        if ch.has_notation(false) {
                            y -= 20.0;
                        }
                        if y < min_y {
                            min_y = y;
                        }
                    }
                }
                if !ch.notes.is_empty() {
                    y = -self.note_cy(ch.notes[0]) - 5.0;
                    if y < min_y {
                        min_y = y;
                    }
                }
            }
        }
        if max_y == f64::NEG_INFINITY {
            max_y = 0.0;
        }
        if self.auto_layout {
            let [top, bot] = self.sys_staff_auto_extent(s, k);
            max_y = js::max(max_y, -top);
            min_y = js::min(min_y, -bot);
        }
        [max_y, min_y]
    }
}
