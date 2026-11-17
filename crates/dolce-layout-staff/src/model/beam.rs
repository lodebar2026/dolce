//! 符杠组（`BeamGroup`）。组本身只存和弦表，计算都要查表，写成 `StaffLayout::beam_*`。

use dolce_base::js;

use super::*;

/// 照原图端点画的符杠组，最短的干至少这么长（tenths；一层符杠时，每多一层加 8）
pub const SOURCE_BEAM_MIN_STEM: f64 = 25.0;

/// 符杠组里的休止离杠内缘至少这么远（tenths）
pub const REST_BEAM_CLEAR: f64 = 2.0;
/// 让杠时最多挪几个线距
pub const REST_BEAM_STEPS: usize = 4;

#[derive(Clone, Debug, Default)]
pub struct BeamGroup {
    pub chords: Vec<ChordId>,
    pub jp: bool,
    pub double_dir: bool,
}

#[derive(Clone, Copy, Debug)]
struct Pt {
    x: f64,
    y: f64,
}

/// 最小二乘斜率（styler.cpp::leastSquare）。
fn least_square(pts: &[Pt]) -> f64 {
    let (mut t1, mut t2, mut t3, mut t4) = (0.0, 0.0, 0.0, 0.0);
    for p in pts {
        t1 += p.x * p.x;
        t2 += p.x;
        t3 += p.x * p.y;
        t4 += p.y;
    }
    let n = pts.len() as f64;
    (t3 * n - t2 * t4) / (t1 * n - t2 * t2)
}

impl<'d> StaffLayout<'d> {
    /// 新的符杠组（放进表，不挂到任何小节上）。
    pub fn new_beam(&mut self, g: BeamGroup) -> BeamId {
        let id = BeamId(self.beams.len());
        self.beams.push(g);
        id
    }

    /// 源谱没写符干方向时，整组**一起**定一个方向：离中线（line = −4）最远的音在上方就朝下、在下方就朝上；
    /// 上下一样远看哪边的音多，还一样就朝下（常规制谱）。逐和弦各猜会让同一根符杠两头符干反向。
    pub fn beam_unify_stem_dir(&mut self, g: BeamId) {
        let (mut above, mut below, mut n_above, mut n_below) = (0.0f64, 0.0f64, 0, 0);
        for &c in &self[g].chords {
            if self[c].rest() {
                continue;
            }
            for &nt in &self[c].notes {
                let dev = self.note_line(nt) + 4.0; // > 0 在中线之上
                if dev > 0.0 {
                    above = js::max(above, dev);
                    n_above += 1;
                } else if dev < 0.0 {
                    below = js::max(below, -dev);
                    n_below += 1;
                }
            }
        }
        let up = below > above || (below == above && n_below > n_above);
        for i in 0..self[g].chords.len() {
            let c = self[g].chords[i];
            self[c].stem_up = up;
        }
    }

    /// 符杠组中间的休止（`F E 𝄾 F` 一根杠跨过八分休止）让开符杠：休止按单声部摆在谱表中间，杠穿过它或压在它上面。
    /// 杠在上方（符干朝上）就把休止往下挪、杠在下方往上挪，一次一个线距，直到字形离杠内缘 `REST_BEAM_CLEAR`。
    /// 杠的几何同 `render.ts::drawBeamGroup`：首尾两根干端连线，每层 8、厚 5，朝上时往下长、朝下时往上长。
    /// 只管单谱表的组；要在音符横坐标与符干长都定了之后调。
    pub fn beam_clear_rests(&mut self, g: BeamId) {
        let chords = self[g].chords.clone();
        let real: Vec<ChordId> = chords.iter().copied().filter(|&c| !self[c].rest()).collect();
        if real.len() < 2 || self[g].double_dir {
            return;
        }
        let first = chords[0];
        let last = chords[chords.len() - 1];
        if self[first].rest() || self[last].rest() {
            return;
        }
        let staff = self.note_staff(self[first].notes[0]);
        if chords.iter().any(|&c| self[c].notes.iter().any(|&n| self.note_staff(n) != staff)) {
            return;
        }
        let up = self[first].stem_up;
        let (x1, y1, x2, y2) = (self.chord_stem_x(first), self.chord_tail_y(first, false), self.chord_stem_x(last), self.chord_tail_y(last, false));
        let beam_at = |x: f64| if x2 != x1 { y1 + ((y2 - y1) * (x - x1)) / (x2 - x1) } else { y1 };
        // 杠底下的休止：读入时休止不带 `<beam>`、不进组，按本小节同声部同谱表、拍位落在组首尾之间的找
        let md = self[first].measure;
        let rests: Vec<ChordId> = self[md]
            .chords
            .iter()
            .copied()
            .filter(|&c| {
                let ch = &self[c];
                ch.rest()
                    && !ch.grace()
                    && ch.voice() == self[first].voice()
                    && ch.notes.len() == 1
                    && self.note_staff(ch.notes[0]) == staff
                    && ch.offset.compare_to(&self[first].offset) > 0
                    && ch.offset.compare_to(&self[last].offset) < 0
            })
            .collect();
        for ch in rests {
            let nt = self[ch].notes[0];
            let sym = self[ch].sym();
            let prev = real.iter().rev().copied().find(|&r| self[r].offset.compare_to(&self[ch].offset) < 0);
            let next = real.iter().copied().find(|&r| self[r].offset.compare_to(&self[ch].offset) > 0);
            let levels = js_max_of([1.0, prev.map_or(1.0, |p| self[p].beams.len() as f64), next.map_or(1.0, |p| self[p].beams.len() as f64)]);
            let yb = beam_at(self[nt].x + smufl_width(self.meta, &sym) / 2.0);
            let inner = if up { yb + (levels - 1.0) * 8.0 + 5.0 + REST_BEAM_CLEAR } else { yb - (levels - 1.0) * 8.0 - 5.0 - REST_BEAM_CLEAR };
            // 字形上下沿（本坐标 y 向下）：基线在 cy
            let st = smufl_top(self.meta, &sym);
            let sb = smufl_bottom(self.meta, &sym);
            let mut i = 0;
            while i < REST_BEAM_STEPS && (if up { self.note_cy(nt) - st < inner } else { self.note_cy(nt) - sb > inner }) {
                self[nt].written_pitch += if up { -2.0 } else { 2.0 };
                i += 1;
            }
        }
    }

    /// 方向定好之后（或音符 x 变了）重排：休止（不画符干）跟本组首个实音，再标 `doubleDir`、按斜率算各符干长。
    pub fn beam_refresh(&mut self, g: BeamId) {
        if self[g].chords.is_empty() {
            return;
        }
        // beam-over-rest：符杠内的休止符无 <stem>，stemUp 取默认 true。若两侧音符均为
        // stem-down，会被误判 doubleDir；而 doubleDir 的 calcSlopeLen 分支不做「下符头避让」
        // （非 doubleDir 分支才有 +35 最小符干），导致八度等宽和弦的符杠穿过下符头。
        let chords = self[g].chords.clone();
        let rf = chords.iter().copied().find(|&c| !self[c].rest()).unwrap_or(chords[0]);
        let ref_up = self[rf].stem_up;
        for &c in &chords {
            if self[c].rest() {
                self[c].stem_up = ref_up;
            }
        }
        self[g].double_dir = chords.iter().any(|&c| self[c].stem_up != ref_up);
        if !self.beam_fit_source_tips(g) {
            self.beam_format(g, 0.0);
        }
    }

    /// 源谱版面档（识别稿）：组里每个音都带原图的符干端点时，符杠照原图——首尾两根干的端点连一条线（斜率同样截在 ±0.3），
    /// 各干补到这条线上；整条线太贴符头（最短的干不到 `SOURCE_BEAM_MIN_STEM`，按层数加长）就整条平移出去。
    /// 音的横向位置重排过，首尾端点照旧、斜度随之变化。两个方向混排、跨谱表的组仍按原公式（`format`）。
    pub fn beam_fit_source_tips(&mut self, g: BeamId) -> bool {
        let chords = self[g].chords.clone();
        let sounding: Vec<ChordId> = chords.iter().copied().filter(|&c| !self[c].rest()).collect();
        if self[g].double_dir || sounding.len() < 2 || self.beam_cross_staff(g) || sounding.iter().any(|&c| self[c].src_tip_y.is_none()) {
            return false;
        }
        let a = sounding[0];
        let b = sounding[sounding.len() - 1];
        let (ya, yb) = (self[a].src_tip_y.expect("上面查过"), self[b].src_tip_y.expect("上面查过"));
        let xa = self.chord_stem_x(a);
        let xb = self.chord_stem_x(b);
        let mut slope = if xb - xa > 1e-6 { (yb - ya) / (xb - xa) } else { 0.0 };
        slope = js::max(-0.3, js::min(0.3, slope));
        let xm = (xa + xb) / 2.0;
        let ym = (ya + yb) / 2.0;
        let up = self[a].stem_up;
        let inc = if up { -1.0 } else { 1.0 };
        let min_len = SOURCE_BEAM_MIN_STEM + js::max(0.0, self.beam_levels(g) - 1.0) * 8.0;
        let mut short: f64 = 0.0;
        for &c in &chords {
            let y = ym + slope * (self.chord_stem_x(c) - xm);
            let cy = self.note_cy(self[c].tail_note());
            self[c].stem_len = inc * (y - cy);
            short = js::max(short, min_len - self[c].stem_len);
        }
        if short > 0.0 {
            for &c in &chords {
                self[c].stem_len += short;
            }
        }
        true
    }

    /// 组里最多几层符杠
    pub fn beam_levels(&self, g: BeamId) -> f64 {
        js_max_of(std::iter::once(1.0).chain(self[g].chords.iter().map(|&c| self[c].beams.len() as f64)))
    }

    /// 音高走向位掩码（styler.cpp::pitchDirection）：bit0=同高 bit1=降 bit2=升。
    pub fn beam_pitch_direction(&self, g: BeamId) -> u32 {
        let chords = &self[g].chords;
        let mut note_cnt: Vec<usize> = Vec::new();
        for &c in chords {
            let n = self[c].notes.len();
            if !note_cnt.contains(&n) {
                note_cnt.push(n);
            }
        }
        let mut res: u32 = 0;
        if note_cnt.len() == 1 {
            let first = chords[0];
            let mut nts = self[first].notes.clone();
            self.sort_by_pitch_wr(&mut nts);
            for &c in chords {
                if c == first {
                    continue;
                }
                let mut nts2 = self[c].notes.clone();
                self.sort_by_pitch_wr(&mut nts2);
                for i in 0..nts.len() {
                    let n2 = nts2[i];
                    let n1 = nts[i];
                    let bit = if self[n1].written_pitch == self[n2].written_pitch {
                        0
                    } else if self[n1].written_pitch < self[n2].written_pitch {
                        2
                    } else {
                        1
                    };
                    res |= 1 << bit;
                    if res == 7 {
                        return res;
                    }
                }
                nts = nts2;
            }
            return res;
        }

        let mut ref_chords = vec![chords[0]];
        if chords.len() >= 3 {
            ref_chords.push(chords[chords.len() - 1]);
        }
        for &ref_ch in &ref_chords {
            let mut nts = self[ref_ch].notes.clone();
            self.sort_by_pitch_wr(&mut nts);
            let mut refs = vec![nts[0]];
            if nts.len() > 1 {
                refs.push(nts[nts.len() - 1]);
            }
            for &rf in &refs {
                for &c in chords {
                    if c == ref_ch {
                        continue;
                    }
                    for &nt in &self[c].notes {
                        let mut bit = if self[nt].written_pitch == self[rf].written_pitch {
                            0
                        } else if self[nt].written_pitch < self[rf].written_pitch {
                            1
                        } else {
                            2
                        };
                        if self[c].offset.compare_to(&self[ref_ch].offset) > 0 {
                            // keep
                        } else if bit == 1 {
                            bit = 2;
                        } else if bit == 2 {
                            bit = 1;
                        }
                        res |= 1 << bit;
                        if res == 7 {
                            return res;
                        }
                    }
                }
            }
        }
        res
    }

    /// 是否跨谱表（styler.cpp::crossStaff）。
    pub fn beam_cross_staff(&self, g: BeamId) -> bool {
        let mut first: Option<usize> = None;
        for &c in &self[g].chords {
            for &nt in &self[c].notes {
                let s = self.note_staff(nt);
                match first {
                    None => first = Some(s),
                    Some(f) if f != s => return true,
                    _ => {}
                }
            }
        }
        false
    }

    /// 按斜率求各和弦符干长（styler.cpp::calcSlopeLen）。
    pub fn beam_calc_slope_len(&mut self, g: BeamId, dy: f64) {
        let chords = self[g].chords.clone();
        let mut pts: Vec<Pt> = Vec::new();
        for &c in &chords {
            let nt = self[c].tail_note();
            let mut y = self.note_cy(nt);
            if self.note_staff(nt) == 1 {
                y += dy;
            }
            pts.push(Pt { x: self.chord_stem_x(c), y });
        }
        let mut slope = least_square(&pts);
        // 横向位置还没排（自动铺排的谱这会儿各符干 x 都一样）时最小二乘是 0/0：按平的算，别让符干长成 NaN
        if !slope.is_finite() {
            slope = 0.0;
        }
        let thres = 0.3;
        if slope > thres {
            slope = thres;
        } else if slope < -thres {
            slope = -thres;
        }

        if self[g].double_dir {
            let (mut min_y_up, mut max_y_down) = (f64::INFINITY, f64::NEG_INFINITY);
            let (mut down_id, mut up_id): (isize, isize) = (-1, -1);
            for (idx, &c) in chords.iter().enumerate() {
                let up = self[c].stem_up;
                let y = pts[idx].y;
                if up {
                    if y < min_y_up {
                        min_y_up = y;
                        up_id = idx as isize;
                    }
                } else if y > max_y_down {
                    max_y_down = y;
                    down_id = idx as isize;
                }
            }
            let cy = (max_y_down + min_y_up) / 2.0 - 2.5;
            // TS `pts[-1]` 是 undefined、取 `.x` 抛错；这里 panic
            let cx = (pts[up_id as usize].x + pts[down_id as usize].x) / 2.0;
            let first_up = self[chords[0]].stem_up;
            for _tr in 0..2 {
                let mut min_len = f64::INFINITY;
                for (idx, &c) in chords.iter().enumerate() {
                    let up = self[c].stem_up;
                    let inc = if up { -1.0 } else { 1.0 };
                    let flipped = up != first_up;
                    if flipped {
                        self[c].stem_extra = inc * self[c].beams.len() as f64 * 8.0 - 3.0;
                    }
                    let ypos = (pts[idx].x - cx) * slope + cy;
                    self[c].stem_len = inc * (ypos - pts[idx].y);
                    min_len = js::min(min_len, self[c].stem_len);
                }
                if min_len < 35.0 {
                    slope = 0.0;
                } else {
                    break;
                }
            }
        } else {
            let mut min_len = f64::INFINITY;
            for (idx, &c) in chords.iter().enumerate() {
                let up = self[c].stem_up;
                let inc = if up { -1.0 } else { 1.0 };
                let dx = pts[idx].x - pts[0].x;
                let ypos = dx * slope + pts[0].y;
                let len = inc * (ypos - pts[idx].y) + 35.0;
                if len < min_len {
                    min_len = len;
                }
                self[c].stem_len = len;
            }
            let diff = 35.0 - min_len;
            for &c in &chords {
                self[c].stem_len += diff;
            }
        }
    }

    /// 计算符杠组各符干长度与延伸（styler.cpp::BeamGroup::format）。
    pub fn beam_format(&mut self, g: BeamId, mut dy: f64) {
        let dir = self.beam_pitch_direction(g);
        if !self.beam_cross_staff(g) {
            dy = 0.0;
        }
        let n = self[g].chords.len();
        if self[g].double_dir || dir == 2 || dir == 4 || ((dir == 3 || dir == 5) && n == 2) {
            self.beam_calc_slope_len(g, dy);
        } else {
            // 水平符杠
            let chords = self[g].chords.clone();
            let (mut min_p, mut max_p) = (1000.0, -1.0);
            for &c in &chords {
                for &nt in &self[c].notes {
                    let wp = self[nt].written_pitch;
                    if wp < min_p {
                        min_p = wp;
                    }
                    if wp > max_p {
                        max_p = wp;
                    }
                }
            }
            let up = self[chords[0]].stem_up;
            for &c in &chords {
                let tn = self[c].tail_note();
                let wp = self[tn].written_pitch;
                self[c].stem_len = if up { (max_p + 7.0 - wp) * 5.0 } else { (wp - (min_p - 7.0)) * 5.0 };
            }
        }
    }
}
