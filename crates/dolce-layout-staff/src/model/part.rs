//! 跨小节对象（Span）与声部（`PartLayout`）、声部组。

use std::collections::HashMap;

use dolce_base::fraction::Fraction;
use dolce_base::js::{self, NumKey};
use dolce_model::doc::Mark as DocMark;

use super::*;

// ---------------- Span objects（跨小节对象） ----------------

/// `SpanObj` 的公共字段。
#[derive(Clone, Debug, Default)]
pub struct SpanObj {
    pub part: PartId,
    pub start_tick: Fraction,
    pub end_tick: Fraction,
    pub above: bool,
}


/// `SpanOverNotes`：起止两个音。
#[derive(Clone, Debug, Default)]
pub struct SpanNotes {
    pub start_note: Option<NoteId>,
    pub end_note: Option<NoteId>,
}

#[derive(Clone, Debug, Default)]
pub struct Slur<'d> {
    pub span: SpanObj,
    pub notes: SpanNotes,
    /// 源谱没写朝向：等符干定好后由 `guessTiedPlacement` 定
    pub auto_dir: bool,
    /// 源标记（导出时把排出来的方向写回去）
    pub mark: Option<&'d DocMark>,
}

#[derive(Clone, Debug, Default)]
pub struct Tied {
    pub span: SpanObj,
    pub notes: SpanNotes,
    /// 0 middle, 1 up, -1 below
    pub y_offset_type: f64,
    /// 源谱写了朝向（`<tied orientation>`）：`above` 照它，`guessTiedPlacement` 不再猜
    pub src_dir: bool,
}

#[derive(Clone, Debug)]
pub struct Tuplet {
    pub span: SpanObj,
    pub notes: SpanNotes,
    pub time_modification: Fraction,
    pub bracket: Option<bool>,
}

impl Default for Tuplet {
    fn default() -> Self {
        Tuplet { span: SpanObj::default(), notes: SpanNotes::default(), time_modification: Fraction::int(1.0), bracket: None }
    }
}

impl Tuplet {
    pub fn make_number(t: f64) -> String {
        glyph_digits(gc("tuplet0"), t)
    }
}

/// 倚音墨迹顶到其上和弦基线的净空（tenths）。
pub const MIXED_GRACE_CHORD_GAP: f64 = 5.0;

/// 混排里房号在简谱层之上占的高度（tenths）：竖脚 20 + 离简谱层 16 + 横线上方余量 4。
pub const MIXED_ENDING_BAND: f64 = 40.0;

#[derive(Clone, Debug, Default)]
pub struct Ending {
    pub span: SpanObj,
    /// TS `startMeasure!`
    pub start_measure: MeasId,
    pub end_measure: MeasId,
    pub number: String,
    pub has_stop: bool,
}


/// 渐强/渐弱松叶（model.hpp:860 Wedge）。
#[derive(Clone, Debug)]
pub struct Wedge {
    pub span: SpanObj,
    pub start_measure: MeasId,
    pub end_measure: MeasId,
    pub crescendo: bool,
    pub staff: usize,
    pub ypos: f64,
    /// 原文没给 default-y：自动铺排时由 `autoPlaceWedges` 定到谱表下方（歌词再让开它）
    pub auto_y: bool,
    pub dx_left: f64,
    pub dx_right: f64,
    /// 开口高（tenths，`<wedge spread>`；缺省 15，同原 C++ 工程）
    pub spread: f64,
}

impl Default for Wedge {
    fn default() -> Self {
        Wedge {
            span: SpanObj::default(),
            start_measure: MeasId(0),
            end_measure: MeasId(0),
            crescendo: false,
            staff: 0,
            ypos: 0.0,
            auto_y: false,
            dx_left: 0.0,
            dx_right: 0.0,
            spread: 15.0,
        }
    }
}

/// 踏板线（model.hpp:873 PedalLine）。
#[derive(Clone, Debug, Default)]
pub struct PedalLine {
    pub span: SpanObj,
    pub start_measure: MeasId,
    pub end_measure: MeasId,
    pub sign: bool,
    pub line: bool,
    pub staff: usize,
    pub ypos: f64,
}

/// 八度线（`<octave-shift>`）：`above` = 8va / 15ma 印在谱上方，否则 8vb / 15mb 印在下方。
#[derive(Clone, Debug)]
pub struct OctaveLine {
    pub span: SpanObj,
    pub start_measure: MeasId,
    pub end_measure: MeasId,
    pub staff: usize,
    pub size: f64,
}

impl Default for OctaveLine {
    fn default() -> Self {
        OctaveLine { span: SpanObj::default(), start_measure: MeasId(0), end_measure: MeasId(0), staff: 0, size: 8.0 }
    }
}

/// 琶音线（`arpeggioGroup` 的 x）在和弦墨迹左缘（符头、临时记号取最左）往左这么多（tenths）；
/// 波浪线墨迹在 x 右边 3.9～8.4，离符头约 0.36 格（照八段锦钢片琴原 PDF 量的约 0.3 格）
pub const ARPEGGIO_LEAD: f64 = 12.0;
/// 排版给琶音在和弦左边让出的宽：线的墨迹左缘到和弦墨迹左缘
pub const ARPEGGIO_RESERVE: f64 = ARPEGGIO_LEAD - 3.9;

/// 琶音（model.hpp:435 Arpeggiate）：同一 offset 上的一组音符。
#[derive(Clone, Debug, Default)]
pub struct Arpeggiate {
    pub notes: Vec<NoteId>,
}

#[derive(Clone, Debug, Default)]
pub struct LrcExtend {
    pub span: SpanObj,
    pub notes: SpanNotes,
    pub start: Option<LyricId>,
    pub stop: Option<LyricId>,
}

// ---------------- Part ----------------

#[derive(Clone, Debug, Default)]
pub struct PartLayout {
    pub pid: String,
    /// 声部名与缩写（`<part-name>` / `<part-abbreviation>`），字号 pt（没给为 0）。只在源谱版面档印
    pub name: String,
    pub abbrev: String,
    pub name_size: f64,
    pub measures: Vec<PmId>,
    pub staves: Vec<PartStaff>,

    pub slurs: Vec<SlurId>,
    pub tied: Vec<TiedId>,
    pub tuplets: Vec<TupletId>,
    pub endings: Vec<EndingId>,
    pub wedges: Vec<WedgeId>,
    pub pedal_lines: Vec<PedalId>,
    pub octave_lines: Vec<OctaveId>,
    pub lrc_extends: Vec<LrcExtId>,
}

// ---------------- PartGroup ----------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum GroupSymbol {
    #[default]
    None,
    Bracket,
    Brace,
}

#[derive(Clone, Debug, Default)]
pub struct PartGroup {
    pub parts: Vec<PartId>,
    pub number: String,
    pub barline: bool,
    pub symbol: GroupSymbol,
    /// 单个多谱表声部的 `<part-symbol top-staff bottom-staff>`：符号只括声部内这几行谱（0 基，含两端）
    pub staff_range: Option<(usize, usize)>,
}

/// `guessTiedPlacement` 里的端点（TS 的 `Pt`）；`other` 是另一端在表里的下标。
#[derive(Clone, Debug)]
struct ArcPt {
    note: NoteId,
    up: bool,
    has_dir: bool,
    owner: Option<TiedId>,
    other: usize,
}

/// 按 `NoteEntry | null` 分组的端点表（JS `Map` 的插入序）。
type PtMap = Vec<(Option<EntryId>, Vec<usize>)>;

fn pt_push(m: &mut PtMap, k: Option<EntryId>, v: usize) {
    match m.iter_mut().find(|(e, _)| *e == k) {
        Some((_, arr)) => arr.push(v),
        None => m.push((k, vec![v])),
    }
}

fn pt_get(m: &PtMap, k: Option<EntryId>) -> &[usize] {
    m.iter().find(|(e, _)| *e == k).map_or(&[], |(_, v)| v.as_slice())
}

impl<'d> StaffLayout<'d> {
    // ───────── 跨度 ─────────

    pub fn slur_start_chord(&self, s: SlurId) -> ChordId {
        self[self[s].notes.start_note.expect("圆滑线有起音")].chord
    }
    pub fn slur_end_chord(&self, s: SlurId) -> ChordId {
        self[self[s].notes.end_note.expect("圆滑线有止音")].chord
    }
    pub fn tied_start_chord(&self, s: TiedId) -> ChordId {
        self[self[s].notes.start_note.expect("延音线有起音")].chord
    }
    pub fn tied_end_chord(&self, s: TiedId) -> ChordId {
        self[self[s].notes.end_note.expect("延音线有止音")].chord
    }
    pub fn tuplet_start_chord(&self, s: TupletId) -> ChordId {
        self[self[s].notes.start_note.expect("连音有起音")].chord
    }
    pub fn tuplet_end_chord(&self, s: TupletId) -> ChordId {
        self[self[s].notes.end_note.expect("连音有止音")].chord
    }

    /// 五线谱上括号/数字两端的 y（render.cpp::drawTuplet：在符杠一侧贴符尾，在符头一侧离符干端 15，再外推 10）。
    pub fn tuplet_staff_ends(&self, t: TupletId) -> [f64; 2] {
        let above = self[t].span.above;
        let sign = if above { 1.0 } else { -1.0 };
        let end_y = |c: ChordId| {
            (if above == self[c].stem_up { self.chord_tail_y(c, true) - 10.0 * sign } else { self.chord_stem_y(c) - 15.0 * sign }) - sign * 10.0
        };
        [end_y(self.tuplet_start_chord(t)), end_y(self.tuplet_end_chord(t))]
    }

    /// 和弦墨迹左缘（与音符同一坐标）：这组音所在各 entry 的符头与临时记号取最左
    pub fn arpeggiate_ink_left(&self, a: ArpegId, entries: &[EntryId]) -> f64 {
        let mut left = f64::INFINITY;
        for &e in entries {
            let ent = &self[e];
            if !ent.notes.iter().any(|&n| self[n].arpeg == Some(a)) {
                continue;
            }
            for &n in &ent.notes {
                if !self[self[n].chord].rest() {
                    left = js::min(left, self[n].x);
                }
            }
            for acc in &ent.acc.accidentals {
                if let Some(x) = acc.xpos {
                    left = js::min(left, x);
                }
            }
        }
        left
    }

    // ───────── PartLayout ─────────

    /// 没写朝向的弧画在音符上方让开下面的歌词：`StaffLayout.arcsAbove` 的谱，且本声部有歌词。
    /// 没歌词的照常规制谱：延音线与符干反向，圆滑线所跨符干全朝上时在下方。
    pub fn part_arcs_above(&self, p: PartId) -> bool {
        self.arcs_above() && self[p].measures.iter().any(|&md| !self[md].lyrics.is_empty())
    }

    pub fn part_new_measure(&mut self, p: PartId, measure_info: MeasId) -> PmId {
        let id = PmId(self.part_measures.len());
        self.part_measures.push(PartMeasureLayout::new(p, measure_info));
        self[p].measures.push(id);
        id
    }
    fn span_of(p: PartId) -> SpanObj {
        SpanObj { part: p, ..SpanObj::default() }
    }
    pub fn part_new_slur(&mut self, p: PartId) -> SlurId {
        let id = SlurId(self.slurs.len());
        self.slurs.push(Slur { span: Self::span_of(p), ..Slur::default() });
        self[p].slurs.push(id);
        id
    }
    pub fn part_new_tied(&mut self, p: PartId) -> TiedId {
        let id = TiedId(self.tieds.len());
        self.tieds.push(Tied { span: Self::span_of(p), ..Tied::default() });
        self[p].tied.push(id);
        id
    }
    pub fn part_new_tuplet(&mut self, p: PartId) -> TupletId {
        let id = TupletId(self.tuplets.len());
        self.tuplets.push(Tuplet { span: Self::span_of(p), ..Tuplet::default() });
        self[p].tuplets.push(id);
        id
    }
    pub fn part_new_ending(&mut self, p: PartId) -> EndingId {
        let id = EndingId(self.endings.len());
        self.endings.push(Ending { span: Self::span_of(p), ..Ending::default() });
        self[p].endings.push(id);
        id
    }
    pub fn part_new_wedge(&mut self, p: PartId) -> WedgeId {
        let id = WedgeId(self.wedges.len());
        self.wedges.push(Wedge { span: Self::span_of(p), ..Wedge::default() });
        self[p].wedges.push(id);
        id
    }
    pub fn part_new_pedal_line(&mut self, p: PartId) -> PedalId {
        let id = PedalId(self.pedal_lines.len());
        self.pedal_lines.push(PedalLine { span: Self::span_of(p), ..PedalLine::default() });
        self[p].pedal_lines.push(id);
        id
    }
    pub fn part_new_octave_line(&mut self, p: PartId) -> OctaveId {
        let id = OctaveId(self.octave_lines.len());
        self.octave_lines.push(OctaveLine { span: Self::span_of(p), ..OctaveLine::default() });
        self[p].octave_lines.push(id);
        id
    }
    pub fn part_new_lrc_extend(&mut self, p: PartId) -> LrcExtId {
        let id = LrcExtId(self.lrc_extends.len());
        self.lrc_extends.push(LrcExtend { span: Self::span_of(p), ..LrcExtend::default() });
        self[p].lrc_extends.push(id);
        id
    }
    /// 新的琶音组（TS 由读入处 `new Arpeggiate()` 再挂到小节上）。
    pub fn new_arpeggiate(&mut self) -> ArpegId {
        let id = ArpegId(self.arpeggiates.len());
        self.arpeggiates.push(Arpeggiate::default());
        id
    }

    pub fn part_set_lyric_font(&mut self, p: PartId, f: &Font) {
        for i in 0..self[p].measures.len() {
            let md = self[p].measures[i];
            for j in 0..self[md].lyrics.len() {
                let l = self[md].lyrics[j];
                self[l].font = f.clone();
            }
        }
    }

    pub fn part_calc_mixed_staff_y(&mut self, p: PartId) {
        for s in 0..self.systems.len() {
            for k in 0..self.systems[s].staves.len() {
                if self.systems[s].staves[k].part_staff.part != p {
                    continue;
                }
                self.sys_staff_calc_mixed_staff_y(SysId(s), k);
            }
        }
    }

    /// 圆滑线起止之间（含两端）同声部的实音符干是否全朝上
    pub fn part_slur_stems_all_up(&self, p: PartId, sl: SlurId) -> bool {
        let a = self.slur_start_chord(sl);
        let b = self.slur_end_chord(sl);
        let t0 = self.chord_tick(a);
        let t1 = self.chord_tick(b);
        for &md in &self[p].measures {
            for &c in &self[md].chords {
                let ch = &self[c];
                if ch.rest() || ch.notes.is_empty() || ch.voice() != self[a].voice() {
                    continue;
                }
                let t = self.chord_tick(c);
                if t.compare_to(&t0) < 0 || t.compare_to(&t1) > 0 {
                    continue;
                }
                if !ch.stem_up {
                    return false;
                }
            }
        }
        self[a].stem_up && self[b].stem_up
    }

    /// Part::guessTiedPlacement（连音线方向推断）。
    pub fn part_guess_tied_placement(&mut self, p: PartId) {
        let arcs_above = self.part_arcs_above(p);
        let score_arcs_above = self.arcs_above();
        let slurs = self[p].slurs.clone();
        let tied = self[p].tied.clone();
        for &sl in &slurs {
            if !self[sl].auto_dir {
                continue;
            }
            if arcs_above {
                self[sl].span.above = true;
            } else if score_arcs_above {
                self[sl].span.above = !self.part_slur_stems_all_up(p, sl);
            }
        }
        let mut pts: Vec<ArcPt> = Vec::new();
        let mut pts_begin: PtMap = Vec::new();
        let mut pts_end: PtMap = Vec::new();

        for &sl in &slurs {
            let above = self[sl].span.above;
            let start_notes = &self[self.slur_start_chord(sl)].notes;
            let end_notes = &self[self.slur_end_chord(sl)].notes;
            let na = if above { start_notes[start_notes.len() - 1] } else { start_notes[0] };
            let nb = if above { end_notes[end_notes.len() - 1] } else { end_notes[0] };
            let ia = pts.len();
            pts.push(ArcPt { note: na, up: above, has_dir: true, owner: None, other: ia + 1 });
            pt_push(&mut pts_begin, self[na].entry, ia);
            pts.push(ArcPt { note: nb, up: above, has_dir: true, owner: None, other: ia });
            pt_push(&mut pts_end, self[nb].entry, ia + 1);
        }
        for &sl in &tied {
            let t = &self[sl];
            let na = t.notes.start_note.expect("延音线有起音");
            let nb = t.notes.end_note.expect("延音线有止音");
            let ia = pts.len();
            pts.push(ArcPt { note: na, up: t.span.above, has_dir: t.src_dir, owner: Some(sl), other: ia + 1 });
            pt_push(&mut pts_begin, self[na].entry, ia);
            pts.push(ArcPt { note: nb, up: t.span.above, has_dir: t.src_dir, owner: Some(sl), other: ia });
            pt_push(&mut pts_end, self[nb].entry, ia + 1);
        }

        let update_dir_by_voice = |sl: &Self, pts: &mut Vec<ArcPt>, m: &PtMap| {
            for (ent, vec) in m {
                let Some(ent) = ent else { continue };
                let mut min_voice = f64::INFINITY;
                let mut max_voice = f64::NEG_INFINITY;
                let mut has_unknown = false;
                for &nt in &sl[*ent].notes {
                    let v = sl[sl[nt].chord].voice();
                    if v > max_voice {
                        max_voice = v;
                    }
                    if v < min_voice {
                        min_voice = v;
                    }
                }
                for &pt in vec {
                    if !pts[pt].has_dir {
                        has_unknown = true;
                    }
                }
                if !has_unknown {
                    continue;
                }
                if min_voice != max_voice {
                    for &pt in vec {
                        if pts[pt].has_dir {
                            continue;
                        }
                        let o = pts[pt].other;
                        pts[pt].has_dir = true;
                        pts[o].has_dir = true;
                        let up = sl[sl[pts[pt].note].chord].voice() == min_voice;
                        pts[pt].up = up;
                        pts[o].up = up;
                    }
                }
            }
        };
        let update_dir_by_pitch = |sl: &Self, pts: &mut Vec<ArcPt>, m: &mut PtMap| {
            for (_, vec) in m.iter_mut() {
                if vec.len() < 2 {
                    continue;
                }
                js::sort_by(vec, |a, b| sl[pts[*a].note].written_pitch - sl[pts[*b].note].written_pitch);
                let mid = vec.len() / 2;
                // 同一个单音上起的弧（圆滑线带着延音线）：没有上下之分，弧朝上的谱都朝上
                let one_note = arcs_above && vec.iter().all(|&pt| pts[pt].note == pts[vec[0]].note);
                for (i, &pt) in vec.iter().enumerate() {
                    if pts[pt].has_dir {
                        continue;
                    }
                    let o = pts[pt].other;
                    pts[pt].has_dir = true;
                    pts[o].has_dir = true;
                    let up = one_note || i >= mid;
                    pts[pt].up = up;
                    pts[o].up = up;
                }
            }
        };
        update_dir_by_voice(self, &mut pts, &pts_begin);
        update_dir_by_voice(self, &mut pts, &pts_end);
        update_dir_by_pitch(self, &mut pts, &mut pts_begin);
        update_dir_by_pitch(self, &mut pts, &mut pts_end);

        let four = Fraction::int(4.0);
        for &sl in &tied {
            let sn = self[sl].notes.start_note.expect("延音线有起音");
            let en = self[sl].notes.end_note.expect("延音线有止音");
            let mut ent = self[sn].entry;
            let mut single_note = ent.map_or(0, |e| self[e].notes.len()) == 1;
            let vec_b = pt_get(&pts_begin, ent);
            if vec_b.len() != 1 {
                continue;
            }
            let pta = vec_b[0];
            ent = self[en].entry;
            if ent.map_or(0, |e| self[e].notes.len()) != 1 {
                single_note = false;
            }
            let vec_e = pt_get(&pts_end, ent);
            if vec_e.len() != 1 {
                continue;
            }
            let ptb = vec_e[0];
            if pts[pta].has_dir {
                self[sl].span.above = pts[pta].up;
            } else {
                let mut ch = self[sn].chord;
                if f_ge(&self[ch].note_type(), &four) {
                    ch = self[en].chord;
                }
                let up = arcs_above || !self[ch].stem_up;
                self[sl].span.above = up;
                pts[pta].up = up;
                pts[ptb].up = up;
                pts[pta].has_dir = true;
                pts[ptb].has_dir = true;
            }

            let sym = self[self[sn].chord].sym();
            let mif_l = self[self[self.tied_start_chord(sl)].measure].measure_info;
            let mif_r = self[self[self.tied_end_chord(sl)].measure].measure_info;
            let lx = self[sn].x + smufl_width(self.meta, &sym);
            let rx = self[en].x;
            let mut dx = rx - lx;
            if mif_l != mif_r {
                dx += self[mif_l].width;
            }
            if single_note || dx < 20.0 {
                self[sl].y_offset_type = if self[sl].span.above { 1.0 } else { -1.0 };
            }
        }
        for (_, vec) in &pts_end {
            for &pt in vec {
                let Some(owner) = pts[pt].owner else { continue };
                if !pts[pt].has_dir {
                    continue;
                }
                self[owner].span.above = pts[pt].up;
            }
        }
    }

    /// Sibelius tie 元素不成对的修正（Part::fixTieForSib + TieProcessor）。
    pub fn part_fix_tie_for_sib(&mut self, p: PartId) {
        let mut start_notes: HashMap<String, Vec<NoteId>> = HashMap::new();
        let mut stop_notes: HashMap<String, Vec<NoteId>> = HashMap::new();
        let mut ticks: Vec<Fraction> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for &md in &self[p].measures {
            for &c in &self[md].chords {
                let ch = &self[c];
                if ch.rest() {
                    continue;
                }
                let t = self.chord_tick(c);
                for &nt in &ch.notes {
                    if self[nt].tie_begin {
                        let e = t.plus(&ch.dur());
                        let k = frac_key(&e);
                        if seen.insert(k.clone()) {
                            ticks.push(e);
                        }
                        start_notes.entry(k).or_default().push(nt);
                    }
                    if self[nt].tie_end {
                        let k = frac_key(&t);
                        if seen.insert(k.clone()) {
                            ticks.push(t);
                        }
                        stop_notes.entry(k).or_default().push(nt);
                    }
                }
            }
        }
        let connect = |sl: &mut Self, va: &mut Vec<NoteId>, vb: &mut Vec<NoteId>| -> bool {
            if va.len() != vb.len() {
                return false;
            }
            sl.sort_by_pitch_snd(va);
            sl.sort_by_pitch_snd(vb);
            for i in 0..va.len() {
                if sl.note_sound_pitch(va[i]) != sl.note_sound_pitch(vb[i]) {
                    return false;
                }
            }
            for i in 0..va.len() {
                sl[va[i]].tie_begin = true;
                sl[vb[i]].tie_end = true;
            }
            true
        };
        js::sort_by(&mut ticks, |a, b| a.compare_to(b) as f64);
        for t in ticks {
            let k = frac_key(&t);
            // 每个 tick 只走一遍（`seen`），Map 里那份数组就地排序之后不再用，直接取走
            let mut va = start_notes.remove(&k).unwrap_or_default();
            let mut vb = stop_notes.remove(&k).unwrap_or_default();
            let ok = connect(self, &mut va, &mut vb);
            if ok {
                continue;
            }
            if vb.is_empty() {
                // TS console.warn("bad tie at")
                continue;
            }
            let md = self[self[vb[0]].chord].measure;
            let mut vb2: Vec<NoteId> = Vec::new();
            let mut pitches: Vec<NumKey> = Vec::new();
            for &nt in &va {
                let k = NumKey::new(self.note_sound_pitch(nt));
                if !pitches.contains(&k) {
                    pitches.push(k);
                }
            }
            for &c in &self[md].chords {
                if !f_eq(&self.chord_tick(c), &t) || self[c].rest() {
                    continue;
                }
                for &nt in &self[c].notes {
                    if pitches.contains(&NumKey::new(self.note_sound_pitch(nt))) {
                        vb2.push(nt);
                    }
                }
            }
            connect(self, &mut va, &mut vb2);
        }
    }
}
