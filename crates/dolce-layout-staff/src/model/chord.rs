//! Note / Chord（`NotationItem`、`NoteLayout`、`ChordLayout`）。

use dolce_model::base::fraction::Fraction;
use dolce_model::base::js;
use dolce_model::doc::{Chord as DocChord, Element, Note as DocNote};
use dolce_model::jianpu::beam_count;
use dolce_scene::smufl::MetaData;

use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BeamVal {
    Begin,
    Continue,
    End,
    Forward,
    Backward,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NotationItem {
    /// SMuFL 字形
    pub symbol: String,
    pub dx: f64,
    pub y: f64,
    pub above: bool,
    /// 一律印在谱表上方、谱表之外（波音、颤音、弓法），不随符干翻到下面；`layoutNotations` 摞在符头/符干顶之上
    pub outside: bool,
    /// 原文写明的上下（`placement`，true = 上方）：不按通则翻；落在符干一侧的贴着符干端
    pub placed: Option<bool>,
}

impl Default for NotationItem {
    fn default() -> Self {
        NotationItem { symbol: String::new(), dx: 0.0, y: 0.0, above: true, outside: false, placed: None }
    }
}

/// `NotationItem.revertMap`：上 / 下两款字形互换。
const REVERT_PAIRS: [(&str, &str); 6] = [
    ("fermataAbove", "fermataBelow"),
    ("articAccentAbove", "articAccentBelow"),
    ("articStaccatoAbove", "articStaccatoBelow"),
    ("articTenutoAbove", "articTenutoBelow"),
    ("articStaccatissimoAbove", "articStaccatissimoBelow"),
    ("articMarcatoAbove", "articMarcatoBelow"),
];

impl NotationItem {
    /// model.cpp:1096 NotationItem::isFermata
    pub fn is_fermata(&self) -> bool {
        is_glyph(&self.symbol, "fermataBelow") || is_glyph(&self.symbol, "fermataAbove")
    }

    /// model.cpp:1100 NotationItem::setAbove —— 翻转上/下时同时换字形。
    pub fn set_above(&mut self, ab: bool) {
        if self.above == ab {
            return;
        }
        self.above = ab;
        for (a, b) in REVERT_PAIRS {
            if is_glyph(&self.symbol, a) {
                self.symbol = gs(b);
                return;
            }
            if is_glyph(&self.symbol, b) {
                self.symbol = gs(a);
                return;
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct NoteLayout<'d> {
    pub chord: ChordId,
    pub entry: Option<EntryId>,
    /// `ScoreDoc` 里对应的音（读入时挂上；休止与无音高的节奏音符为 None）。简谱叠层的唱名/八度/临时记号从它的 `degree` 取
    pub src: Option<&'d DocNote>,
    /// 简谱叠层印的就是这个音（语义层 `melodyChords` 那一路的 `topNote`，休止也算）
    pub jp_melody: bool,
    /// 谱表上的位置（记谱音高按调式音级计，含移调）。**休止由 `fixPitchForRest` 排到谱表上**，所以它是版面坐标
    pub written_pitch: f64,
    /// 延音线起止（读入时照 `<tie>`，Sibelius 不成对的由 `fixTieForSib` 补）
    pub tie_begin: bool,
    pub tie_end: bool,
    pub flipped: bool,
    /// 所属琶音组
    pub arpeg: Option<ArpegId>,
    pub x: f64,
}

impl<'d> NoteLayout<'d> {
    pub fn new(chord: ChordId) -> NoteLayout<'d> {
        NoteLayout {
            chord,
            entry: None,
            src: None,
            jp_melody: false,
            written_pitch: -1.0,
            tie_begin: false,
            tie_end: false,
            flipped: false,
            arpeg: None,
            x: -1.0,
        }
    }

    pub fn parentheses_acc(&self) -> bool {
        match self.src {
            Some(s) if s.accidental.is_some() => s.accidental_parentheses == Some(true),
            _ => false,
        }
    }

    /// 面上印的临时记号（SMuFL 字形，"" 表示无）。
    pub fn acc(&self) -> String {
        let Some(a) = self.src.and_then(|s| s.accidental.as_ref()) else { return String::new() };
        match js::trim(a.as_str()) {
            "flat" => gs("accidentalFlat"),
            "sharp" => gs("accidentalSharp"),
            "natural" => gs("accidentalNatural"),
            "double-sharp" => gs("accidentalDoubleSharp"),
            "flat-flat" => gs("accidentalDoubleFlat"),
            _ => String::new(),
        }
    }

    /// 简谱面上要印的临时记号（1 升 / -1 降 / 0 还原），不印为 None。延续规则在语义层（`AccidentalCarry`）
    pub fn jp_accidental(&self) -> Option<f64> {
        let acc = self.src.and_then(|s| s.degree.as_ref()).and_then(|d| d.accidental.as_ref())?;
        let a = acc.as_str();
        if a.is_empty() {
            return None;
        }
        Some(if a.contains("sharp") {
            1.0
        } else if a.contains("flat") {
            -1.0
        } else {
            0.0
        })
    }
}

#[derive(Clone, Debug)]
pub struct ChordLayout<'d> {
    pub measure: PmId,
    /// `ScoreDoc` 里对应的和弦
    pub src: &'d DocChord,
    /// 所在小节的 divisions（时值换算用）
    pub divisions: f64,
    /// 小节内起点（四分音符为 1）：`<backup>`/`<forward>` 游标折算好的，引擎一切按它定时间
    pub offset: Fraction,
    /// 整小节休止（读到时按那一刻的小节长判；无 `<type>` 的休止也算）
    pub measure_rest: bool,
    pub double_side: bool,
    /// 无符干（全音符）默认 0，与 musicpp 一致；有符干者在 calcStemLen 赋值
    pub stem_len: f64,
    pub stem_up: bool,
    /// 源谱版面档：原图符干末端的 y（与 `note_cy` 同一坐标，来自 `<stem default-y>`）
    pub src_tip_y: Option<f64>,
    /// 跨谱表符杠时符干延伸量（model.hpp stemExtra / styler.cpp calcSlopeLen）
    pub stem_extra: f64,
    pub notes: Vec<NoteId>,
    /// 符杠逐层状态（照 `<beam>`，整声部没写时由自动符杠补）
    pub beams: Vec<BeamVal>,
    pub notations: Vec<NotationItem>,
    /// 换气记号（`breath-mark`）
    pub breath: bool,
    /// 简谱减时线条数（`beamCount(src, divisions)`；src 与 divisions 都不变，造节点时算好）
    pub jp_beams: f64,
}

impl<'d> ChordLayout<'d> {
    pub fn new(measure: PmId, src: &'d DocChord, divisions: f64) -> ChordLayout<'d> {
        let jp_beams = beam_count(&Element::Chord(src.clone()), divisions);
        ChordLayout {
            measure,
            src,
            divisions,
            offset: Fraction::int(0.0),
            measure_rest: src.duration.kind.is_none(),
            double_side: false,
            stem_len: 0.0,
            stem_up: true,
            src_tip_y: None,
            stem_extra: 0.0,
            notes: Vec::new(),
            beams: Vec::new(),
            notations: Vec::new(),
            breath: false,
            jp_beams,
        }
    }

    // ---- 语义：一律从 ScoreDoc 取 ----
    pub fn rest(&self) -> bool {
        self.src.rest.is_some()
    }
    pub fn grace(&self) -> bool {
        self.src.grace.is_some()
    }
    pub fn cue(&self) -> bool {
        self.src.cue == Some(true)
    }
    /// 声部（0 基）
    pub fn voice(&self) -> f64 {
        self.src.voice - 1.0
    }
    pub fn dot(&self) -> f64 {
        self.src.duration.dots
    }
    /// 斜线符头（节奏记谱）
    pub fn slash(&self) -> bool {
        self.src.notes.iter().any(|n| n.notehead.as_deref().map(js::trim) == Some("slash"))
    }
    /// 叉形 / 圈叉符头（整个和弦同一形状才换，打击乐谱的单音）：`"x"` / `"circle-x"`
    pub fn cross_head(&self) -> Option<&'static str> {
        let h = self.src.notes.first().and_then(|n| n.notehead.as_deref()).map(js::trim)?;
        if (h == "x" || h == "circle-x" || h == "cross") && self.src.notes.iter().all(|n| n.notehead.as_deref().map(js::trim) == Some(h)) {
            Some(if h == "circle-x" { "circle-x" } else { "x" })
        } else {
            None
        }
    }
    /// 实际时值（四分音符为 1）
    pub fn dur(&self) -> Fraction {
        Fraction::new(self.src.duration.divisions, self.divisions)
    }
    /// 符号时值（四分音符为 1，纯由 `<type>` 决定；没有 `<type>` 按全音符字形）
    pub fn note_type(&self) -> Fraction {
        match &self.src.duration.kind {
            Some(t) => note_type_fraction(t.as_str()),
            None => Fraction::int(4.0),
        }
    }
    /// 连音比（normal / actual）
    pub fn time_modification(&self) -> Fraction {
        match &self.src.duration.time_mod {
            Some(tm) => Fraction::new(tm.normal, tm.actual),
            None => Fraction::int(1.0),
        }
    }

    pub fn has_notation(&self, above: bool) -> bool {
        self.notations.iter().any(|it| it.above == above)
    }

    /// 简谱减时线条数（语义层 `jianpuShape`）。
    pub fn jp_beam_count(&self) -> f64 {
        self.jp_beams
    }

    /// 音符头/休止符 SMuFL 字形（Chord::sym，model.cpp:1696）。
    pub fn sym(&self) -> String {
        let nt = self.note_type();
        let one = Fraction::int(1.0);
        if self.rest() {
            if self.measure_rest {
                return gs("restWhole");
            }
            if f_eq(&nt.times_int(4.0), &one) {
                return gs("rest16th");
            }
            if f_eq(&nt.times_int(2.0), &one) {
                return gs("rest8th");
            }
            if nt.equals_int(1.0) {
                return gs("restQuarter");
            }
            if nt.equals_int(2.0) {
                return gs("restHalf");
            }
            if nt.equals_int(4.0) {
                return gs("restWhole");
            }
            if f_eq(&nt.times_int(8.0), &one) {
                return gs("rest32nd");
            }
            // TS console.error("unknown rest type")
            return gs("restQuarter");
        }
        if self.slash() {
            if f_le(&nt, &one) {
                return gs("noteheadSlashVerticalEnds");
            }
            return gs("noteheadSlashDiamondWhite"); // half/whole slash
        }
        if let Some(cross) = self.cross_head() {
            let circle = cross == "circle-x";
            if f_le(&nt, &one) {
                return gs(if circle { "noteheadCircleX" } else { "noteheadXBlack" });
            }
            if nt.equals_int(2.0) {
                return gs(if circle { "noteheadCircleXHalf" } else { "noteheadXHalf" });
            }
            return gs(if circle { "noteheadCircleXWhole" } else { "noteheadXWhole" });
        }
        if f_le(&nt, &one) {
            return gs("noteheadBlack");
        }
        if nt.equals_int(2.0) {
            return gs("noteheadHalf");
        }
        if nt.equals_int(4.0) {
            return gs("noteheadWhole");
        }
        // TS console.error("unknown note type")
        gs("noteheadBlack")
    }

    /// 符尾旗字形（Chord::tailSym），四分及以上无旗返回 ""。
    pub fn tail_sym(&self, up: bool) -> String {
        let nt = self.note_type();
        let one = Fraction::int(1.0);
        if self.rest() || f_ge(&nt, &one) {
            return String::new();
        }
        if f_eq(&nt.times_int(8.0), &one) {
            return gs(if up { "flag32ndUp" } else { "flag32ndDown" });
        }
        if f_eq(&nt.times_int(4.0), &one) {
            return gs(if up { "flag16thUp" } else { "flag16thDown" });
        }
        if f_eq(&nt.times_int(2.0), &one) {
            return gs(if up { "flag8thUp" } else { "flag8thDown" });
        }
        String::new()
    }

    pub fn notehead_width(&self, meta: &MetaData) -> f64 {
        smufl_width(meta, &self.sym())
    }

    /// 符干末端那个音（朝上取最高）
    pub fn tail_note(&self) -> NoteId {
        if self.stem_up {
            self.notes[self.notes.len() - 1]
        } else {
            self.notes[0]
        }
    }
    /// 符头侧那个音
    pub fn stem_note(&self) -> NoteId {
        if self.stem_up {
            self.notes[0]
        } else {
            self.notes[self.notes.len() - 1]
        }
    }
}

impl<'d> StaffLayout<'d> {
    // ───────── NoteLayout ─────────

    /// 发音音高（MIDI 口径，休止与无音高为 0）
    pub fn note_sound_pitch(&self, n: NoteId) -> f64 {
        let nt = &self[n];
        let p = nt.src.and_then(|s| s.pitch.as_ref());
        match p {
            Some(p) if !self[nt.chord].rest() => {
                (p.octave + 1.0) * 12.0 + step_chromatic(p.step.as_str()).unwrap_or(0.0) + js::round(p.alter)
            }
            _ => 0.0,
        }
    }
    pub fn note_alter(&self, n: NoteId) -> f64 {
        let nt = &self[n];
        if self[nt.chord].rest() {
            0.0
        } else {
            nt.src.and_then(|s| s.pitch.as_ref()).map_or(0.0, |p| p.alter)
        }
    }
    /// 所在谱表（0 基；TS 的 `(chord.src.staff ?? 1) − 1`，负数饱和到 0）
    pub fn note_staff(&self, n: NoteId) -> usize {
        (self[self[n].chord].src.staff - 1.0) as usize
    }
    /// 显示尺寸：1=cue（小符头），0=正常（MusicXML <type size="cue">）。
    pub fn note_size(&self, n: NoteId) -> f64 {
        let nt = &self[n];
        let ts = nt.src.and_then(|s| s.type_size.as_deref()).or(self[nt.chord].src.type_size.as_deref());
        if ts == Some("cue") {
            1.0
        } else {
            0.0
        }
    }
    pub fn note_visible(&self, n: NoteId) -> bool {
        self[self[n].chord].src.print_object != Some(false)
    }
    pub fn note_end_tick(&self, n: NoteId) -> Fraction {
        let c = self[n].chord;
        self[c].offset.plus(&self[c].dur())
    }
    pub fn note_right_side(&self, n: NoteId) -> bool {
        let res = !self[self[n].chord].stem_up;
        if self[n].flipped {
            !res
        } else {
            res
        }
    }
    pub fn note_part_staff(&self, n: NoteId) -> &PartStaff {
        let pm = self[self[n].chord].measure;
        &self[self[pm].part].staves[self.note_staff(n)]
    }
    pub fn note_clef_sig(&self, n: NoteId) -> ClefSig {
        let t = self.chord_tick(self[n].chord);
        self.note_part_staff(n).get_clef(&t)
    }
    pub fn note_line(&self, n: NoteId) -> f64 {
        let t = self.chord_tick(self[n].chord);
        self[n].written_pitch - self.note_part_staff(n).get_top_pitch(&t)
    }
    pub fn note_cy(&self, n: NoteId) -> f64 {
        -self.note_line(n) * 5.0
    }
    pub fn note_cx(&self, n: NoteId) -> f64 {
        self[n].x + self[self[n].chord].notehead_width(self.meta) / 2.0
    }
    pub fn note_right_x_for_tie(&self, n: NoteId) -> f64 {
        let ch = &self[self[n].chord];
        let mut res = self[n].x + ch.notehead_width(self.meta);
        if ch.dot() != 0.0 {
            res += 3.0 + ch.dot() * 4.0;
        }
        res
    }

    // ---- 简谱写法：一律取语义层给的度数（`model/jianpu.ts::assignDegrees`，读 MusicXML 时已算好）----
    pub fn note_number(&self, n: NoteId) -> String {
        if self[self[n].chord].rest() {
            return "0".into();
        }
        js::num_to_string(self[n].src.and_then(|s| s.degree.as_ref()).map_or(0.0, |d| d.number))
    }
    /// 简谱八度点数（>0 上加点，<0 下加点）。
    pub fn note_octave_jp(&self, n: NoteId) -> f64 {
        if self[self[n].chord].rest() {
            return 0.0;
        }
        self[n].src.and_then(|s| s.degree.as_ref()).map_or(0.0, |d| d.octave_shift)
    }

    pub fn sort_by_pitch_wr(&self, v: &mut [NoteId]) {
        js::sort_by(v, |a, b| self[*a].written_pitch - self[*b].written_pitch);
    }
    pub fn sort_by_pitch_snd(&self, v: &mut [NoteId]) {
        js::sort_by(v, |a, b| {
            if self[*a].written_pitch != self[*b].written_pitch {
                self[*a].written_pitch - self[*b].written_pitch
            } else {
                self[self[*a].chord].voice() - self[self[*b].chord].voice()
            }
        });
    }

    // ───────── ChordLayout ─────────

    pub fn new_note(&mut self, c: ChordId) -> NoteId {
        let id = NoteId(self.notes.len());
        self.notes.push(NoteLayout::new(c));
        self[c].notes.push(id);
        id
    }

    pub fn chord_tick(&self, c: ChordId) -> Fraction {
        let mi = self[self[c].measure].measure_info;
        self[mi].offset.plus(&self[c].offset)
    }

    /// 时值区间是否相交（model.cpp:1825 Chord::overlape）。
    pub fn chord_overlape(&self, a: ChordId, ch: ChordId) -> bool {
        let t0 = self.chord_tick(a);
        let t1 = t0.plus(&self[a].dur());
        let t2 = self.chord_tick(ch);
        let t3 = t2.plus(&self[ch].dur());
        if t0.compare_to(&t3) >= 0 {
            return false;
        }
        if t1.compare_to(&t2) <= 0 {
            return false;
        }
        true
    }

    /// 符干 x（Chord::stemX，常量音头宽 11 与源一致）。
    pub fn chord_stem_x(&self, c: ChordId) -> f64 {
        let ch = &self[c];
        let nt = &self[ch.notes[0]];
        let nw = 11.0;
        if ch.stem_up {
            return nt.x + nw;
        }
        if nt.flipped {
            return self[ch.notes[1]].x;
        }
        nt.x
    }

    pub fn chord_ent_x(&self, c: ChordId) -> f64 {
        self[self[c].notes[0]].x
    }

    /// 符干末端 y（Chord::tailY）。
    pub fn chord_tail_y(&self, c: ChordId, add_mea_y: bool) -> f64 {
        let ch = &self[c];
        let tn = ch.tail_note();
        let mut res = self.note_cy(tn);
        if add_mea_y {
            res += self.pm_staff_y(ch.measure, self.note_staff(tn));
        }
        if ch.stem_up {
            res - ch.stem_len
        } else {
            res + ch.stem_len
        }
    }

    /// 符干起点 y（音符头侧，Chord::stemY）。
    pub fn chord_stem_y(&self, c: ChordId) -> f64 {
        let tn = self[c].stem_note();
        self.pm_staff_y(self[c].measure, self.note_staff(tn)) + self.note_cy(tn)
    }

    pub fn chord_offset_x_pos(&mut self, c: ChordId, dx: f64) {
        for i in 0..self[c].notes.len() {
            let n = self[c].notes[i];
            self[n].x += dx;
        }
    }

    pub fn chord_sort(&mut self, c: ChordId) {
        let mut v = self[c].notes.clone();
        self.sort_by_pitch_wr(&mut v);
        self[c].notes = v;
    }

    /// 二度音程翻转音符头（Chord::autoFlip）。
    pub fn chord_auto_flip(&mut self, c: ChordId) {
        let mut arr = self[c].notes.clone();
        let mut inc = 1.0;
        if !self[c].stem_up {
            inc = -1.0;
            arr.reverse();
        }
        let mut last_flipped = false;
        let mut last: Option<NoteId> = None;
        for n in arr {
            if self[n].written_pitch <= 0.0 {
                continue;
            }
            let Some(l) = last.filter(|_| !last_flipped) else {
                last = Some(n);
                last_flipped = false;
                continue;
            };
            let diff = self[n].written_pitch - self[l].written_pitch;
            if diff == inc || diff == 0.0 {
                last_flipped = true;
                self[c].double_side = true;
                self[n].flipped = true;
            } else {
                last_flipped = false;
            }
            last = Some(n);
        }
    }

    /// 二度翻到符干另一侧的符头横移一个符头宽（朝上的往右、朝下的往左）。音符 x 要先定好：
    /// Sibelius 原文在读入时（它的 default-x 不含这一截），自动铺排在 `autoPlaceNotes` 定好 x 之后。
    pub fn chord_apply_flip_offset(&mut self, c: ChordId) {
        let width = smufl_width(self.meta, &self[c].sym());
        let up = self[c].stem_up;
        for i in 0..self[c].notes.len() {
            let n = self[c].notes[i];
            if self[n].flipped {
                self[n].x += if up { width } else { -width };
            }
        }
    }

    /// `ChordLayout.sortByOffset`
    pub fn sort_by_offset(&self, arr: &mut [ChordId]) {
        js::sort_by(arr, |a, b| self[*a].offset.compare_to(&self[*b].offset) as f64);
    }
}
