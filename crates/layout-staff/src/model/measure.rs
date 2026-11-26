//! 声部内单小节（`PartMeasureLayout`，dolce::MusicData）与全局小节（`MeasureLayout`，dolce::Measure）。

use std::collections::HashMap;

use dolce_model::base::fraction::Fraction;
use dolce_model::base::js;
use dolce_engrave::beatgroup::{beat_group_index, beat_group_size, pickup_offset};
use dolce_model::doc::{Chord as DocChord, Harmony as DocHarmony, Lyric as DocLyric};

use super::*;

#[derive(Clone, Debug)]
pub struct PartMeasureLayout {
    pub measure_info: MeasId,
    pub part: PartId,
    pub chords: Vec<ChordId>,
    pub lyrics: Vec<LyricId>,
    pub harmonies: Vec<HarmId>,
    pub text_blocks: Vec<TextId>,
    pub arpegs: Vec<ArpegId>,
    pub beams: Vec<BeamId>,
    pub grace_beams: Vec<BeamId>,
    pub jp_beams: Vec<BeamId>,
    pub note_entries: Vec<EntryId>,
}

impl PartMeasureLayout {
    pub fn new(part: PartId, measure_info: MeasId) -> PartMeasureLayout {
        PartMeasureLayout {
            measure_info,
            part,
            chords: Vec::new(),
            lyrics: Vec::new(),
            harmonies: Vec::new(),
            text_blocks: Vec::new(),
            arpegs: Vec::new(),
            beams: Vec::new(),
            grace_beams: Vec::new(),
            jp_beams: Vec::new(),
            note_entries: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum EndingType {
    #[default]
    None,
    Start,
    Stop,
    Discontinue,
}

/// 小节线样式（musicpp 用 SMuFL 字形枚举，这里独立枚举；实际用线绘制）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BarGlyph {
    Single,
    Double,
    HeavyHeavy,
    Final,
    ReverseFinal,
    /// bar-style none：占位且不可见
    None,
}

#[derive(Clone, Debug, Default)]
pub struct MeasureLayout {
    /// TS `system!`：分系统之前为 None
    pub system: Option<SysId>,
    pub number: String,
    /// 多小节休止：这一小节代表几个小节（并过的；0 = 普通小节）。整小节休止画成 H 形横杠加小节数
    pub multi_rest: f64,
    /// 房号（JS `Set` 的插入序）
    pub ending_num: Vec<f64>,
    pub left_ending_type: EndingType,
    pub right_ending_type: EndingType,
    pub index: usize,
    pub dur: Fraction,
    pub offset: Fraction,
    pub width: f64,
    pub forward: bool,
    pub backward: bool,
    pub clef_pos: Option<f64>,
    pub key_pos: Option<f64>,
    pub time_pos: Option<f64>,
    pub key_offest_jp: Option<f64>,
    pub left_barline_pos: f64,
    pub data_pos: f64,
    pub data_end: f64,
    pub show_bar_number: bool,
    /// `<measure implicit="yes">`：不计小节号（小节中间换行拆出的后半、弱起）
    pub implicit: bool,
    pub sib_key_offset: f64,
    pub ent_pos: TickMap<f64>,
    pub left_barline: Option<BarGlyph>,
    pub right_barline: Option<BarGlyph>,
}

impl MeasureLayout {
    pub fn end_tick(&self) -> Fraction {
        self.dur.plus(&self.offset)
    }
}

impl<'d> StaffLayout<'d> {
    // ───────── MeasureLayout ─────────

    /// 小节内 tick → x（Measure::getEntPos，相邻插值）。
    pub fn measure_get_ent_pos(&self, m: MeasId, t: &Fraction) -> f64 {
        let me = &self[m];
        let mut offset = 0.0;
        if f_eq(t, &me.dur) && me.index + 1 < self.measures.len() {
            offset = -self.measures[me.index + 1].sib_key_offset;
        }
        if me.ent_pos.size() == 0 {
            if t.equals_int(0.0) {
                return js::max(me.data_pos, 10.0);
            }
            if f_eq(t, &me.dur) {
                return me.width + offset;
            }
            return me.data_pos;
        }
        if f_eq(t, &me.dur) {
            return me.data_end + offset;
        }
        // lower_bound(t)
        let entries = &me.ent_pos.entries;
        let idx = entries.iter().position(|e| e.t.compare_to(t) >= 0).unwrap_or(entries.len());
        let next: f64;
        let next_tick: Fraction;
        if idx == entries.len() {
            next = me.width;
            next_tick = me.dur;
        } else if f_eq(&entries[idx].t, t) {
            return entries[idx].v;
        } else {
            next = entries[idx].v;
            next_tick = entries[idx].t;
        }
        let Some(prev_e) = idx.checked_sub(1).map(|i| &entries[i]) else { return me.data_pos };
        let dt = next_tick.minus(&prev_e.t).to_float();
        let dt_sub = t.minus(&prev_e.t).to_float();
        let k = (next - prev_e.v) / dt;
        prev_e.v + dt_sub * k
    }

    /// 小节在 system 内的 x 起点（Measure::xpos）。
    pub fn measure_xpos(&self, m: MeasId) -> f64 {
        let sys = self[m].system.expect("小节已分到系统里");
        let mut res = 0.0;
        for &mm in &self[sys].measures {
            if mm == m {
                return res;
            }
            res += self[mm].width;
        }
        res
    }

    // ───────── PartMeasureLayout ─────────

    pub fn pm_new_chord(&mut self, md: PmId, src: &'d DocChord, divisions: f64) -> ChordId {
        let id = ChordId(self.chords.len());
        self.chords.push(ChordLayout::new(md, src, divisions));
        self[md].chords.push(id);
        id
    }
    pub fn pm_new_lyric(&mut self, md: PmId, src: &'d DocLyric, chord: ChordId) -> LyricId {
        let id = LyricId(self.lyrics.len());
        self.lyrics.push(LyricLayout::new(md, src, chord));
        self[md].lyrics.push(id);
        id
    }
    pub fn pm_new_harmony(&mut self, md: PmId, src: &'d DocHarmony) -> HarmId {
        let id = HarmId(self.harmonies.len());
        self.harmonies.push(HarmonyLayout::new(md, src));
        self[md].harmonies.push(id);
        id
    }
    pub fn pm_new_text(&mut self, md: PmId) -> TextId {
        let id = TextId(self.texts.len());
        self.texts.push(MeasureText::new(md));
        self[md].text_blocks.push(id);
        id
    }

    pub fn pm_system(&self, md: PmId) -> SysId {
        self[self[md].measure_info].system.expect("小节已分到系统里")
    }

    /// 该 part 内 subStaff 的 y 偏移（MusicData::staffY）。
    pub fn pm_staff_y(&self, md: PmId, stf: usize) -> f64 {
        if stf == 0 {
            return 0.0;
        }
        let sys = self.pm_system(md);
        let part = self[md].part;
        let mut res = 0.0;
        for st in &self[sys].staves {
            let ps = st.part_staff;
            if ps.part == part {
                if ps.sub == stf {
                    res += st.distance;
                    break;
                } else if st.staff_visible {
                    res += st.height();
                }
            }
        }
        res
    }

    pub fn pm_xpos(&self, md: PmId) -> f64 {
        self.measure_xpos(self[md].measure_info)
    }

    /// 和弦按起点、和弦内的音按记谱音高排好（musicpp splitLayer 的前半；分层那半由语义层的旋律取音代替）
    pub fn pm_sort_chords(&mut self, md: PmId) {
        let mut v = self[md].chords.clone();
        self.sort_by_offset(&mut v);
        self[md].chords = v.clone();
        for c in v {
            self.chord_sort(c);
        }
    }

    /// 简谱减时线分组（MusicData::processJpBeam）。
    pub fn pm_process_jp_beam(&mut self, md: PmId) {
        let mut layer: Vec<ChordId> = Vec::new();
        let mut stf: Option<usize> = None;
        for &c in &self[md].chords {
            for &nt in &self[c].notes {
                if self[nt].jp_melody {
                    layer.push(c);
                    stf = Some(self.note_staff(nt));
                    break;
                }
            }
        }
        let Some(stf) = stf else { return };
        self.sort_by_offset(&mut layer);
        let part = self[md].part;
        let mi = self[md].measure_info;
        let pstf = &self[part].staves[stf];
        let t0 = self[mi].offset;
        let ts = pstf.get_time(&t0);
        // 拍位判据走公共那一份（beatgroup，与旧简谱引擎、原样文档同一条）：残节按小节末尾对齐
        let measures = &self[part].measures;
        let is_last = measures.last() == Some(&md);
        let next = if is_last { None } else { measures.get(self[mi].index + 1).copied() };
        let skip = pickup_offset((ts.beats * 4.0) / ts.beat_type, self[mi].dur.to_float(), is_last, next.map(|n| self[self[n].measure_info].dur.to_float()));
        let beat_size = beat_group_size(ts.beats, ts.beat_type);

        let mut prev_beat = f64::NEG_INFINITY;
        for c in layer {
            if self[c].jp_beam_count() < 1.0 {
                continue;
            }
            let b = beat_group_index(self[c].offset.to_float(), skip, beat_size);
            if prev_beat != b {
                let g = self.new_beam(BeamGroup { chords: vec![c], jp: true, double_dir: false });
                self[md].jp_beams.push(g);
                prev_beat = b;
            } else {
                let g = *self[md].jp_beams.last().expect("上一拍建过组");
                self[g].chords.push(c);
            }
        }
    }

    /// 建 NoteEntry + Sibelius 翻转修正（MusicData::layoutNotes）。
    pub fn pm_layout_notes(&mut self, md: PmId, sibelius: bool) {
        let chords = self[md].chords.clone();
        for &c in &chords {
            self.chord_sort(c);
            self.chord_auto_flip(c);
            if sibelius {
                self.chord_apply_flip_offset(c);
            }
        }

        let staves = self[self[md].part].staves.len();
        let mut entries: Vec<HashMap<String, EntryId>> = (0..staves).map(|_| HashMap::new()).collect();
        for &c in &chords {
            if self[c].grace() {
                continue;
            }
            let t = self[c].offset;
            for i in 0..self[c].notes.len() {
                let nt = self[c].notes[i];
                // TS `entries[nt.staff]`：谱表号越界时取不到、抛错
                let sidx = self.note_staff(nt);
                let key = frac_key(&t);
                let ent = match entries[sidx].get(&key) {
                    Some(&e) => e,
                    None => {
                        let e = EntryId(self.entries.len());
                        let mut ne = NoteEntry::new(md);
                        ne.sub_staff = sidx;
                        ne.offset = t;
                        self.entries.push(ne);
                        self[md].note_entries.push(e);
                        entries[sidx].insert(key, e);
                        e
                    }
                };
                self[nt].entry = Some(ent);
                self[ent].notes.push(nt);
            }
        }

        self.pm_fix_pitch_for_rest(md);
        for i in 0..self[md].note_entries.len() {
            let e = self[md].note_entries[i];
            self.entry_layout(e, sibelius, 0.0);
        }
    }

    /// 记号（fermata 等）上/下与纵向位置（model.cpp:968 MusicData::layoutNotations）。
    /// 须在 stem/beam 信息就绪后调用。
    pub fn pm_layout_notations(&mut self, md: PmId) {
        let all = self[md].chords.clone();
        let nota_chords: Vec<ChordId> = all.iter().copied().filter(|&c| !self[c].notations.is_empty()).collect();
        let part2 = self[self[md].part].pid == "P2";
        let four = Fraction::int(4.0);

        for c in nota_chords {
            let mut minv = f64::INFINITY;
            let mut maxv = f64::NEG_INFINITY;
            for &ch2 in &all {
                if !self.chord_overlape(ch2, c) {
                    continue;
                }
                minv = js::min(minv, self[ch2].voice());
                maxv = js::max(maxv, self[ch2].voice());
            }
            let single = minv == maxv;
            let stem_up = self[c].stem_up;
            let above = if single { !stem_up } else { self[c].voice() == minv };

            let mut note_side = single;
            let notes = self[c].notes.clone();
            let nt = if above { notes[notes.len() - 1] } else { notes[0] };
            let has_stem = f_lt(&self[c].note_type(), &four);
            if !(has_stem && stem_up == above) {
                note_side = true;
            }

            // 谱表上方那一摞（波音、颤音、弓法）：从这个和弦最高的墨迹（符干朝上取符干顶）往上摞，至少在谱表顶线之上
            let top_note = notes[notes.len() - 1];
            let mut outside_y = js::min(if has_stem && stem_up { self.chord_tail_y(c, false) } else { self.note_cy(top_note) - 5.0 }, 0.0) - 10.0;
            let tail_y = self.chord_tail_y(c, false);
            let cy_top = self.note_cy(notes[notes.len() - 1]);
            let cy_bot = self.note_cy(notes[0]);
            let nt_cy = self.note_cy(nt);
            let nt_line = self.note_line(nt);
            for i in 0..self[c].notations.len() {
                let it = &mut self.chords[c.0].notations[i];
                if it.outside {
                    it.above = true;
                    it.y = outside_y;
                    outside_y -= 14.0;
                    continue;
                }
                if let Some(placed) = it.placed {
                    it.set_above(placed);
                    let inc = if it.above { -1.0 } else { 1.0 };
                    let stem_side = has_stem && stem_up == it.above;
                    let head_cy = if it.above { cy_top } else { cy_bot };
                    it.y = (if stem_side { tail_y } else { head_cy + 5.0 * inc }) + 5.0 * inc;
                    continue;
                }
                // musicpp 以「原始字形是否 fermataAbove」判定，setAbove 之前取值。
                let fermata = is_glyph(&it.symbol, "fermataAbove");
                if fermata {
                    it.set_above(if single { !part2 } else { above });
                    note_side = it.above != stem_up;
                } else {
                    it.set_above(above);
                }

                let inc = if it.above { -1.0 } else { 1.0 };
                let mut y = if note_side { nt_cy + 5.0 * inc } else { tail_y };
                let tenuto = is_glyph(&it.symbol, "articTenutoBelow") || is_glyph(&it.symbol, "articTenutoAbove");
                y += 5.0 * inc;
                if tenuto && y % 10.0 == 0.0 && note_side {
                    let ln = nt_line;
                    if ln < 0.0 && ln > -8.0 {
                        y += 5.0 * inc;
                    }
                }
                if fermata {
                    // staff 外
                    if it.above {
                        if y > -10.0 {
                            y = -10.0;
                        }
                    } else if !note_side {
                        it.dx -= 5.0;
                    }
                }
                it.y = y;
            }
        }
    }

    /// 休止符纵向位置（MusicData::fixPitchForRest）。
    pub fn pm_fix_pitch_for_rest(&mut self, md: PmId) {
        for ei in 0..self[md].note_entries.len() {
            let ent = self[md].note_entries[ei];
            let notes = self[ent].notes.clone();
            for &nt in &notes {
                if self[nt].written_pitch >= 0.0 {
                    continue;
                }
                let top = self.note_clef_sig(nt).top_pitch();
                if notes.len() == 1 {
                    self[nt].written_pitch = top - 4.0;
                } else {
                    let mut min_voice = f64::INFINITY;
                    let mut max_voice = f64::NEG_INFINITY;
                    let mut min_pitch = f64::INFINITY;
                    let mut max_pitch = f64::NEG_INFINITY;
                    for &n2 in &notes {
                        let v = self[self[n2].chord].voice();
                        if v < min_voice {
                            min_voice = v;
                        }
                        if v > max_voice {
                            max_voice = v;
                        }
                        let p = self[n2].written_pitch;
                        if p < 0.0 {
                            continue;
                        }
                        if p < min_pitch {
                            min_pitch = p;
                        }
                        if p > max_pitch {
                            max_pitch = p;
                        }
                    }
                    let v = self[self[nt].chord].voice();
                    let mut res: f64;
                    max_pitch += 5.0;
                    min_pitch -= 5.0;
                    if v == min_voice {
                        res = top - 2.0;
                        if res < max_pitch {
                            res = max_pitch;
                        }
                        if (res - top) % 2.0 != 0.0 {
                            res += 1.0;
                        }
                    } else {
                        res = top - 8.0;
                        if res > min_pitch {
                            res = min_pitch;
                        }
                        if (res - top) % 2.0 != 0.0 {
                            res -= 1.0;
                        }
                    }
                    self[nt].written_pitch = res;
                }
            }
        }
    }
}
