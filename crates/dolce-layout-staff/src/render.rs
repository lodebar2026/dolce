//! 画一个系统（照 `render.ts`，原本从 musicpp model/render.cpp 移植）。**接口约定**：装页（`pages`）用下面三个。
//!
//! 输入：排好版的 [`StaffLayout`]；输出：场景节点（线、SMuFL 字形文字、路径）。单位 tenths。
//! TS 里「先 `container.add(x)` 再往 x 里画」的，这里一律先画好 x 再挂上（子节点次序不变）。

use std::collections::HashSet;

use dolce_base::fraction::Fraction;
use dolce_base::js;
use dolce_engrave::arc::{slur_tie, ArcKind};
use dolce_engrave::arpeggio::arpeggio_group;
use dolce_engrave::barline::{BarlineGlyph, BarlineSpec, BarlineStyle};
use dolce_engrave::chord::{chord_text_segs, harmony_width, layout_harmony_segs, HarmonySeg};
use dolce_engrave::ending::{add_ending_bracket, EndingBracket, EndingLabel};
use dolce_engrave::hairpin::{hairpin_path, HairpinSpec};
use dolce_engrave::prims::{fill_rect, text_item};
use dolce_engrave::spacing::AccidentalSide;
use dolce_engrave::tuplet::{TupletGlyph, TupletKind, TupletStyle};
use dolce_geom::{Matrix33, Point};
use dolce_model::doc::BarStyle;
use dolce_scene::build::Env;
use dolce_scene::{Edge, ElementId, Identity, IdentityKind, Node};
use dolce_text::cjkpunct::{punct_class, PunctClass};
use dolce_text::{CompressMode, Font};
use serde_json::{Map, Value};

use crate::model::{
    get_anchor, get_bbox, gs, is_glyph, js_max_of, js_min_of, mixed_slur_style, smufl_width, BarGlyph, BeamVal, ChordId, ClefSig, EndingId,
    GroupSymbol, HarmId, LegerLayout, Lcr, LrcExtId, MeasId, Notation, OctaveId, PartId, PedalId, PmId, PsRef, SlurId, StaffLayout, SysId,
    TextId, TiedId, TimeSig, TupletId, WedgeId, ARPEGGIO_LEAD,
};
use crate::overlay::draw_jianpu_overlay;
use crate::prims::{add_line, add_smufl, add_smufl_scaled, chord_group, translated, STAFF_SYSTEM};

const BLACK: f64 = 0xff000000u32 as f64;

/// 只填 `kind` 的身份标签
fn ident(kind: IdentityKind) -> Identity {
    Identity { kind, id: None, pass: None, verse: None, edge: None, measure: None, also: None, end: None }
}

/// SMuFL breathMarkComma（U+E4CE）。
fn breath_comma() -> String {
    char::from_u32(0xe4ce).expect("码位").to_string()
}

fn accidental_side(score: &StaffLayout) -> Option<AccidentalSide> {
    AccidentalSide::parse(score.options.accidental_side.as_deref())
}

fn add_filled_quad(g: &mut Node, lx: f64, ly: f64, rx: f64, ry: f64, thick: f64) {
    let mut n = Node::path();
    let p = n.path_mut();
    p.fill = true;
    p.stroke = false;
    p.fill_color = BLACK;
    p.move_to(lx, ly);
    p.line_to(lx, ly + thick);
    p.line_to(rx, ry + thick);
    p.line_to(rx, ry);
    p.close();
    g.push(n);
}

/// 断奏楔（staccatissimo）画实心三角：宽 0.54 格、高 0.77 格，尖朝符头。
const WEDGE_W: f64 = 5.4;
const WEDGE_H: f64 = 7.7;
fn draw_staccatissimo(g: &mut Node, cx: f64, y: f64, above: bool) {
    let mut n = Node::path();
    let p = n.path_mut();
    p.fill = true;
    p.stroke = false;
    p.fill_color = BLACK;
    let base = if above { y - WEDGE_H } else { y + WEDGE_H };
    p.move_to(cx - WEDGE_W / 2.0, base);
    p.line_to(cx + WEDGE_W / 2.0, base);
    p.line_to(cx, y);
    p.close();
    g.push(n);
}

// -----------------------------------------------------------------------
/// 多小节休止：谱表中线上一道粗横杠（两头竖线从第二线到第四线），谱表上方印小节数。
const MULTIREST_NUM_SIZE: f64 = 27.0;
fn draw_multi_rest(g: &mut Node, score: &StaffLayout, mif: MeasId, env: &Env) {
    let eng = &score.options;
    let m = &score[mif];
    let x0 = m.data_pos + 15.0;
    let x1 = score.measure_get_ent_pos(mif, &m.dur) - 15.0;
    if x1 <= x0 {
        return;
    }
    g.push(fill_rect(BLACK, x0, 15.0, x1 - x0, 10.0));
    add_line(g, x0, 10.0, x0, 30.0, eng.line_widths.stem * 1.5);
    add_line(g, x1, 10.0, x1, 30.0, eng.line_widths.stem * 1.5);
    let text = js::num_to_string(m.multi_rest);
    let font = Font::new(eng.word_font.as_str(), MULTIREST_NUM_SIZE);
    let x = (x0 + x1) / 2.0 - font.measure_text(env.mc, &text) / 2.0;
    g.push(text_item(&text, font, BLACK, x, -4.0, false, env));
}

/// 全音符震音一道斜线的横宽（tenths）
const WHOLE_TREMOLO_W: f64 = 12.4;
fn draw_whole_tremolo(g: &mut Node, n: f64, x0: f64, cy: f64) {
    let (w, r, t, s) = (WHOLE_TREMOLO_W, 5.3, 3.0, 4.5);
    let mut i = 0.0;
    while i < n {
        let y = cy + (i - (n - 1.0) / 2.0) * s;
        add_filled_quad(g, x0, y + r / 2.0 - t / 2.0, x0 + w, y - r / 2.0 - t / 2.0, t);
        i += 1.0;
    }
}

/// 震音字形按墨迹中心摆到 (`cx`, `cy`)
fn draw_tremolo(g: &mut Node, score: &StaffLayout, glyph: &str, cx: f64, cy: f64, fs: f64, env: &Env) {
    let bb = get_bbox(score.meta, glyph);
    let ox = bb.map_or(0.0, |b| ((b.sw[0] + b.ne[0]) / 2.0) * 10.0);
    let oy = bb.map_or(0.0, |b| -((b.sw[1] + b.ne[1]) / 2.0) * 10.0);
    add_smufl(g, glyph, cx - ox, cy - oy, fs, env);
}

fn f4() -> Fraction {
    Fraction::int(4.0)
}

// drawNotesNormal（render.cpp:953 drawNotesNormal + drawChord stem/flag）

/// 一个和弦的符头、休止、符干、符尾：画进懒建的组（`chordGroup`），有东西画才有
fn draw_chord_normal(score: &StaffLayout, md: PmId, c: ChordId, sub_staff: usize, env: &Env) -> Option<Node> {
    let eng = &score.options;
    let fs = eng.music_font.size;
    let meta = score.meta;
    let ch = &score[c];
    let code = ch.sym();
    if code.is_empty() {
        return None;
    }
    // 懒建的和弦组（TS `chordGrp()`）
    let mut cg: Option<Node> = None;
    macro_rules! grp {
        () => {
            cg.get_or_insert_with(|| chord_group(ch.src.id))
        };
    }

    let mif = score[md].measure_info;
    let mut head_l = f64::INFINITY;
    let mut head_r = f64::NEG_INFINITY;
    for &n in &ch.notes {
        if score.note_staff(n) != sub_staff {
            continue;
        }
        if !score.note_visible(n) {
            continue;
        }
        let mut x: f64;
        let cue = score.note_size(n) == 1.0 || ch.cue() || ch.grace();
        let scale = if ch.grace() {
            eng.grace_size
        } else if cue {
            eng.cue_size
        } else {
            1.0
        };

        // 并过的多小节休止那一小节只剩一个休止
        if ch.rest() && score[mif].multi_rest > 1.0 {
            draw_multi_rest(grp!(), score, mif, env);
            continue;
        }
        if ch.measure_rest {
            let end_pos = score.measure_get_ent_pos(mif, &score[mif].dur);
            x = (score[mif].data_pos + end_pos) / 2.0 - 7.0;
        } else {
            x = score[n].x;
            if cue {
                x = score.chord_stem_x(c);
                if !score.note_right_side(n) {
                    x -= smufl_width(meta, &code) * scale;
                }
                if ch.note_type().compare_to(&f4()) >= 0 {
                    x += 5.0;
                }
            }
            if x < 0.0 {
                continue;
            }
        }

        let mut y = score.note_cy(n);
        if is_glyph(&code, "restWhole") {
            y -= 10.0;
        }

        if scale != 1.0 {
            add_smufl_scaled(grp!(), &code, x, y, fs, scale, scale, env);
        } else {
            add_smufl(grp!(), &code, x, y, fs, env);
        }
        head_l = js::min(head_l, x);
        head_r = js::max(head_r, x + smufl_width(meta, &code) * scale);
        // 倚音不进 NoteEntry，加线在这里按它自己的小号符头补画
        if ch.grace() && !ch.rest() {
            let mut leg = LegerLayout::default();
            leg.add_note(score.note_line(n), x, x + smufl_width(meta, &code) * scale);
            for &(ledger_line, [lx1, lx2]) in &leg.ranges {
                let ly = -ledger_line * 5.0;
                add_line(grp!(), lx1 - 3.0 * scale, ly, lx2 + 3.0 * scale, ly, eng.line_widths.leger);
            }
        }
    }

    // 跨谱表的和弦，这一行谱只画符干、没有符头：按别的谱行上的符头取
    if head_r.partial_cmp(&head_l) != Some(std::cmp::Ordering::Greater) {
        for &n in &ch.notes {
            if !score.note_visible(n) || ch.measure_rest || score[n].x < 0.0 {
                continue;
            }
            head_l = js::min(head_l, score[n].x);
            head_r = js::max(head_r, score[n].x + smufl_width(meta, &code));
        }
    }
    let head = (head_r > head_l).then(|| (head_l + head_r) / 2.0);
    // TS：组建时 `data = head`，符头画完再补一次 `data = head`——终值就是 head
    let finish = |mut cg: Option<Node>| -> Option<Node> {
        if let (Some(g), Some(cx)) = (cg.as_mut(), head) {
            let mut d = Map::new();
            d.insert("cx".into(), Value::from(cx));
            g.data = Some(d);
        }
        cg
    };

    // stem and flag (skip rests, whole notes, half notes with beams)
    if ch.rest() {
        return finish(cg);
    }
    // 单音震音：tremolo1–4 字形压在符干中段；全音符没有符干，斜线照原谱自己画
    let strokes = ch.src.notations.as_ref().and_then(|n| n.tremolo);
    let tremolo = match strokes {
        Some(s) if s != 0.0 && !s.is_nan() => {
            let names = ["tremolo1", "tremolo2", "tremolo3", "tremolo4"];
            gs(names[(js::min(4.0, s) - 1.0) as usize])
        }
        _ => String::new(),
    };
    if ch.note_type().compare_to(&f4()) >= 0 {
        if !tremolo.is_empty() && head_r > head_l {
            let strokes = strokes.unwrap_or(0.0);
            // 全音符的 `stemUp` 没按音高算过：离中线最远的音在中线之上就朝下
            let ys: Vec<f64> = ch.notes.iter().map(|&n| score.note_cy(n) - score.pm_staff_y(md, sub_staff)).collect();
            let up = 20.0 - js_min_of(ys.iter().copied()) <= js_max_of(ys.iter().copied()) - 20.0;
            let at = ch.src.notations.as_ref().and_then(|n| n.tremolo_pos.as_ref());
            if let Some(at) = at {
                draw_whole_tremolo(grp!(), js::min(4.0, strokes), head_l + at.x - WHOLE_TREMOLO_W / 2.0, -at.y);
            } else {
                let cy = if up { js_max_of(ys.iter().copied()) - 10.0 } else { js_min_of(ys.iter().copied()) + 10.0 };
                draw_whole_tremolo(grp!(), js::min(4.0, strokes), head_r + 2.5, cy);
            }
        }
        return finish(cg); // whole: no stem
    }

    let sx = score.chord_stem_x(c);
    let sy = score.chord_stem_y(c) - score.pm_staff_y(md, sub_staff);
    // 符干末端含 stemExtra（跨谱表符杠延伸符干以接到符杠）
    let extra = if ch.stem_up { -ch.stem_extra } else { ch.stem_extra };
    let ty = score.chord_tail_y(c, true) + extra - score.pm_staff_y(md, sub_staff);

    // flag (only if unbeamed)
    if ch.beams.is_empty() {
        let flag_code = ch.tail_sym(ch.stem_up);
        if !flag_code.is_empty() {
            let scale = if ch.grace() {
                eng.grace_size
            } else if ch.cue() || ch.notes.iter().any(|&n| score.note_size(n) == 1.0) {
                eng.cue_size
            } else {
                1.0
            };
            // 按 SMuFL 锚点接到符干末端（`stemUpNW` / `stemDownSW`）
            let anc = get_anchor(meta, &flag_code);
            let pick = |name: &str| anc.and_then(|a| a.get(name).copied());
            let a = (if ch.stem_up { pick("stemUpNW") } else { pick("stemDownSW") }).unwrap_or([0.0, 0.0]);
            let sp = (fs / 4.0) * scale;
            let fx = sx - a[0] * sp;
            let fy = ty + a[1] * sp;
            if scale != 1.0 {
                add_smufl_scaled(grp!(), &flag_code, fx, fy, fs, scale, scale, env);
            } else {
                add_smufl(grp!(), &flag_code, fx, fy, fs, env);
            }
            // 短倚音（`<grace slash="yes">`）：符尾上那道斜线
            if ch.src.grace.as_ref().and_then(|g| g.slash) == Some(true) {
                let p0 = if ch.stem_up { pick("graceNoteSlashSW") } else { pick("graceNoteSlashNW") };
                let p1 = if ch.stem_up { pick("graceNoteSlashNE") } else { pick("graceNoteSlashSE") };
                if let (Some(p0), Some(p1)) = (p0, p1) {
                    add_line(grp!(), fx + p0[0] * sp, fy - p0[1] * sp, fx + p1[0] * sp, fy - p1[1] * sp, eng.line_widths.stem);
                }
            }
        }
    }

    add_line(grp!(), sx, sy, sx, ty, eng.line_widths.stem);
    // 符干上离符头 3/5 处
    if !tremolo.is_empty() {
        draw_tremolo(grp!(), score, &tremolo, sx, sy + (ty - sy) * 0.6, fs, env);
    }
    finish(cg)
}

pub fn draw_notes_normal(score: &StaffLayout, container: &mut Node, md: PmId, sub_staff: usize, env: &Env) {
    let eng = &score.options;
    let fs = eng.music_font.size;
    let meta = score.meta;
    let pm = &score[md];

    // ---- noteheads, rests, stems, flags ----
    for &c in &pm.chords {
        if let Some(g) = draw_chord_normal(score, md, c, sub_staff, env) {
            container.push(g);
        }
    }

    // ---- notations (fermata 等) ----
    for &c in &pm.chords {
        let ch = &score[c];
        if (ch.notations.is_empty() && !ch.breath) || ch.notes.is_empty() {
            continue;
        }
        if score.note_staff(ch.notes[0]) != sub_staff {
            continue;
        }
        let stem_x = score.chord_stem_x(c);
        let short = ch.stem_up && ch.note_type().compare_to(&f4()) < 0;
        // 换气：SMuFL 逗号，符头右边一格、谱表第一线之上半格
        if ch.breath {
            let left = if short { stem_x - ch.notehead_width(meta) } else { stem_x };
            add_smufl(container, &breath_comma(), left + ch.notehead_width(meta) + 8.0, -5.0, fs, env);
        }
        for nota in &ch.notations {
            let mut x = stem_x + nota.dx;
            if short {
                x -= ch.notehead_width(meta);
            }
            let above = is_glyph(&nota.symbol, "articStaccatissimoAbove");
            if above || is_glyph(&nota.symbol, "articStaccatissimoBelow") {
                draw_staccatissimo(container, x + ch.notehead_width(meta) / 2.0, nota.y, above);
                continue;
            }
            // 墨迹中心对符头中心
            if let Some(bb) = get_bbox(meta, &nota.symbol) {
                x += ch.notehead_width(meta) / 2.0 - ((bb.sw[0] + bb.ne[0]) / 2.0) * 10.0;
            }
            add_smufl(container, &nota.symbol, x, nota.y, fs, env);
        }
    }

    // ---- arpeggio：竖向波浪线，整 part 画一次 ----
    if sub_staff == 0 {
        for &a in &pm.arpegs {
            let arp = &score[a];
            if arp.notes.is_empty() {
                continue;
            }
            let n0 = arp.notes[0];
            let n1 = arp.notes[arp.notes.len() - 1];
            let y0 = score.pm_staff_y(md, score.note_staff(n0)) + score.note_cy(n0) + 8.0;
            let y1 = score.pm_staff_y(md, score.note_staff(n1)) + score.note_cy(n1) - 8.0;
            let left = score.arpeggiate_ink_left(a, &pm.note_entries);
            let x = (if left.is_finite() { left } else { score.measure_get_ent_pos(pm.measure_info, &score[score[n0].chord].offset) }) - ARPEGGIO_LEAD;
            container.push(arpeggio_group(x, y1, y0, fs, BLACK, env));
        }
    }

    // ---- ledger lines, dots, accidentals from NoteEntries ----
    for &e in &pm.note_entries {
        let ent = &score[e];
        if ent.sub_staff != sub_staff {
            continue;
        }
        for &(ledger_line, [lx1, lx2]) in &ent.leger.ranges {
            let ly = -ledger_line * 5.0;
            add_line(container, lx1 - 3.0, ly, lx2 + 3.0, ly, eng.line_widths.leger);
        }
        // 附点无条件照 ent.dot.dots 画
        for &dot_line in &ent.dot.dots {
            add_smufl(container, &gs("augmentationDot"), ent.dot.dot_pos, -5.0 * dot_line, fs, env);
        }
        for it in &ent.acc.accidentals {
            let Some(xpos) = it.xpos else { continue };
            let mut ax = xpos - 1.0;
            let ay = -it.line * 5.0;
            let sc = it.scale;
            for sym in &it.symbols {
                if sc != 1.0 {
                    add_smufl_scaled(container, sym, ax, ay, fs, sc, sc, env);
                } else {
                    add_smufl(container, sym, ax, ay, fs, env);
                }
                ax += smufl_width(meta, sym) * sc;
            }
        }
    }
}

// -----------------------------------------------------------------------
// drawBeams（render.cpp BeamLevelData::drawNormal + drawBeam）

/// 一段符杠：起止和弦（None = 短钩）、层
struct BeamItem {
    start: Option<ChordId>,
    end: Option<ChordId>,
    level: f64,
}

fn build_beam_items(score: &StaffLayout, chords: &[ChordId]) -> Vec<BeamItem> {
    let mut items = Vec::new();
    for lev in 0..10usize {
        let mut start: Option<ChordId> = None;
        let mut last: Option<ChordId> = None;
        let mut found = false;
        for &c in chords {
            let ch = &score[c];
            if lev >= ch.beams.len() {
                continue;
            }
            match ch.beams[lev] {
                BeamVal::Continue => last = Some(c),
                BeamVal::End => {
                    items.push(BeamItem { start, end: Some(c), level: lev as f64 });
                    found = true;
                    start = None;
                    last = None;
                }
                BeamVal::Backward => {
                    items.push(BeamItem { start: None, end: Some(c), level: lev as f64 });
                    found = true;
                }
                BeamVal::Forward => {
                    items.push(BeamItem { start: Some(c), end: None, level: lev as f64 });
                    found = true;
                }
                BeamVal::Begin => start = Some(c),
            }
        }
        if !found {
            if let (Some(_), Some(_)) = (start, last) {
                items.push(BeamItem { start, end: last, level: lev as f64 });
                found = true;
            }
        }
        if !found {
            break;
        }
    }
    items
}

fn draw_beam_group(score: &StaffLayout, container: &mut Node, chords: &[ChordId], stf_y: f64, scale: f64) {
    let items = build_beam_items(score, chords);
    if items.is_empty() {
        return;
    }
    let first = chords[0];
    let last = chords[chords.len() - 1];
    let x1g = score.chord_stem_x(first);
    let y1g = score.chord_tail_y(first, true) - stf_y;
    let x2g = score.chord_stem_x(last);
    let y2g = score.chord_tail_y(last, true) - stf_y;
    let slope = if x2g != x1g { (y2g - y1g) / (x2g - x1g) } else { 0.0 };
    let hook_len = 12.0;
    let thick = 5.0 * scale;

    for it in &items {
        let (lx, mut ly);
        let up = it.start.map(|c| score[c].stem_up).or(it.end.map(|c| score[c].stem_up)).unwrap_or(true);
        let dy = -(it.level * 8.0) * (if up { -1.0 } else { 1.0 }) + (if up { 0.0 } else { -5.0 });

        if let Some(s) = it.start {
            lx = score.chord_stem_x(s);
            ly = score.chord_tail_y(s, true) - stf_y;
        } else {
            let e = it.end.expect("短钩有止和弦");
            let rx0 = score.chord_stem_x(e);
            let ry0 = score.chord_tail_y(e, true) - stf_y;
            lx = rx0 - hook_len;
            ly = ry0 - hook_len * slope;
        }
        let (rx, mut ry);
        if let Some(e) = it.end {
            rx = score.chord_stem_x(e);
            ry = score.chord_tail_y(e, true) - stf_y;
        } else {
            rx = lx + hook_len;
            ry = ly + hook_len * slope;
        }
        ly += dy * scale;
        ry += dy * scale;
        add_filled_quad(container, lx, ly, rx, ry, thick);
    }
}

pub fn draw_beams(score: &StaffLayout, container: &mut Node, md: PmId, sub_staff: usize, grace_size: f64) {
    let stf_y = score.pm_staff_y(md, sub_staff);
    let relevant = |g: &[ChordId]| g.iter().any(|&c| score[c].notes.iter().any(|&n| score.note_staff(n) == sub_staff));
    for &b in &score[md].beams {
        let grp = &score[b];
        if !relevant(&grp.chords) {
            continue;
        }
        draw_beam_group(score, container, &grp.chords, stf_y, 1.0);
    }
    for &b in &score[md].grace_beams {
        let grp = &score[b];
        if !relevant(&grp.chords) {
            continue;
        }
        draw_beam_group(score, container, &grp.chords, stf_y, grace_size);
    }
}

// -----------------------------------------------------------------------
// drawSlurTied / drawTied / drawSlur（render.cpp:1073-1329）

/// 月牙形的 slur/tie：几何与画法与谱面那一路共用（`engrave::arc`），样式是 `mixed_slur_style`。
#[allow(clippy::too_many_arguments)]
fn draw_slur_tied(container: &mut Node, plx: f64, ply: f64, prx: f64, pry: f64, above: bool, ends: (Option<ElementId>, Option<ElementId>), env: &Env) {
    let mut arc = slur_tie(ArcKind::Slur, Point::new(plx, ply), Point::new(prx, pry), &mixed_slur_style(above), env);
    // 可视化编辑认弧：起止和弦的元素 id
    if let (Some(s), Some(e)) = ends {
        arc.id = Some(Identity { id: Some(s), end: Some(e), ..ident(IdentityKind::Slur) });
    }
    container.push(arc);
}

fn chord_id_of_note(score: &StaffLayout, n: Option<crate::model::NoteId>) -> Option<ElementId> {
    n.map(|n| score[score[n].chord].src.id)
}

fn draw_tied(score: &StaffLayout, sys: SysId, container: &mut Node, obj: TiedId, force_nota: Option<Notation>, env: &Env) {
    if let Some(e) = score.tied_ends(sys, obj, force_nota) {
        let t = &score[obj].notes;
        let ends = (chord_id_of_note(score, t.start_note), chord_id_of_note(score, t.end_note));
        draw_slur_tied(container, e.plx, e.ply, e.prx, e.pry, e.above, ends, env);
    }
}

fn draw_slur(score: &StaffLayout, sys: SysId, container: &mut Node, slur: SlurId, force_nota: Option<Notation>, env: &Env) {
    if let Some(e) = score.slur_ends(sys, slur, force_nota) {
        let t = &score[slur].notes;
        let ends = (chord_id_of_note(score, t.start_note), chord_id_of_note(score, t.end_note));
        draw_slur_tied(container, e.plx, e.ply, e.prx, e.pry, e.above, ends, env);
    }
}

// -----------------------------------------------------------------------
// drawLrcExtend（render.cpp::drawLrcExtend）

fn draw_lrc_extend(score: &StaffLayout, sys: SysId, container: &mut Node, ext: LrcExtId) {
    let begin = score.sys_begin_tick(sys);
    let end = score.sys_end_tick(sys);
    let x = &score[ext];
    if x.span.start_tick.compare_to(&end) >= 0 {
        return;
    }
    if x.span.end_tick.compare_to(&begin) < 0 {
        return;
    }
    // stop 为空＝melisma 被休止打断，终点取 endNote；否则取下一音节。
    let Some(start) = x.start else { return };
    if x.stop.is_none() && x.notes.end_note.is_none() {
        return;
    }
    let has_prev = x.span.start_tick.compare_to(&begin) < 0;
    let has_next = x.span.end_tick.compare_to(&end) >= 0;

    // 跨系统时分段：续接段从本系统内容起点画，跨出段画到本系统末尾
    let ms = &score[sys].measures;
    let m0 = ms[0];
    let m_last = ms[ms.len() - 1];
    let sys_left = score.measure_xpos(m0) + score[m0].data_pos;
    let sys_right = score.measure_xpos(m_last) + score[m_last].width;

    let st = &score[start];
    let left = if has_prev {
        sys_left
    } else {
        let c = score[x.notes.start_note.expect("续腔有起音")].chord;
        let mif_l = score[score[c].measure].measure_info;
        st.x + score.measure_xpos(mif_l) + st.x_offset + st.width
    };
    let right = if has_next {
        sys_right
    } else {
        let c = score[x.notes.end_note.expect("续腔有止音")].chord;
        let mif_r = score[score[c].measure].measure_info;
        if let Some(stop) = x.stop {
            score[stop].x + score.measure_xpos(mif_r) + score[stop].x_offset
        } else {
            // 休止打断：止于最后续腔音的右缘
            let en = x.notes.end_note.expect("续腔有止音");
            score[en].x + smufl_width(score.meta, &score[score[en].chord].sym()) + score.measure_xpos(mif_r)
        }
    };
    let y = -st.y;
    add_line(container, left, y, right, y, 1.0);
}

// -----------------------------------------------------------------------
// drawTuplet（render.cpp::drawTuplet）

fn draw_tuplet(score: &StaffLayout, container: &mut Node, obj: TupletId, env: &Env) {
    let eng = &score.options;
    let chl = score.tuplet_start_chord(obj);
    let chr = score.tuplet_end_chord(obj);
    let nota = score.note_part_staff(score[chl].notes[0]).get_notation(&score.chord_tick(chl));
    let above = score[obj].span.above;

    let mut plx = score.chord_stem_x(chl) + score.pm_xpos(score[chl].measure);
    let ply;
    let mut prx = score.chord_stem_x(chr) + score.pm_xpos(score[chr].measure);
    let pry;

    let sign = if above { 1.0 } else { -1.0 };
    let mut bracket = false;

    if nota == Notation::JianPu {
        let ntl = score[chl].notes[0];
        let ntr = score[chr].notes[0];
        // 端点对齐到简谱数字中心
        let wl = eng.jianpu_font.measure_text(env.mc, &score.note_number(ntl));
        let wr = eng.jianpu_font.measure_text(env.mc, &score.note_number(ntr));
        plx = score[ntl].x + wl / 2.0 + score.pm_xpos(score[chl].measure);
        prx = score[ntr].x + wr / 2.0 + score.pm_xpos(score[chr].measure);
        let dot = js::max(score.note_octave_jp(ntl), score.note_octave_jp(ntr));
        ply = if dot > 0.0 { -4.0 } else { 3.0 };
        pry = ply;
    } else {
        // determine bracket: use when stem direction matches above or no beams
        bracket = true;
        if let Some(b) = score[obj].bracket {
            bracket = b;
        } else if above == score[chl].stem_up {
            bracket = score[chl].beams.is_empty();
        }
        [ply, pry] = score.tuplet_staff_ends(obj);
    }

    let tg = TupletGlyph::new(
        Point::new(plx, ply),
        Point::new(prx, pry),
        score[obj].time_modification.denominator,
        &TupletStyle {
            kind: if bracket { TupletKind::Bracket } else { TupletKind::Number },
            color: BLACK,
            music: eng.music_font.clone(),
            meta: true,
            line_width: Some(1.0),
            foot: Some(sign * 10.0),
            gap_pad: None,
            arc: None,
        },
        env,
    );
    for it in tg.items {
        container.push(it);
    }
}

// -----------------------------------------------------------------------
// drawEnding（render.cpp::drawEnding）

/// 混排里房号竖脚底离简谱层原点的空（高音点 + 简谱连音弧）。
const MIXED_ENDING_GAP: f64 = 16.0;

/// 一个房在本系统里的横向范围与 `yPos`（`yPos − 30` 是房号基线、竖脚底，再往上 20 是括线；None = 缺省位置 0）。
pub fn ending_place(score: &StaffLayout, e: EndingId, sys: SysId, mixed: bool) -> EndingPlace {
    let obj = &score[e];
    let s = &score[sys];
    // 房跨系统：起点在前面的系统里，这一段从本系统首小节画起、不画左脚不印房号；终点在后面的系统里，画到本系统末小节、不封口
    let starts_here = score.sys_contains(sys, &obj.span.start_tick);
    let ends_here = score.sys_contains(sys, &obj.span.end_tick);
    let mif_l = if starts_here { obj.start_measure } else { s.measures[0] };
    let mif_r = if ends_here { obj.end_measure } else { s.measures[s.measures.len() - 1] };
    let left = score.measure_xpos(mif_l) + score[mif_l].data_pos - 5.0 - score[mif_l].sib_key_offset;
    let mut right = score.measure_xpos(mif_r) + score[mif_r].data_end;

    let idx = score[mif_r].index + 1;
    if idx < score.measures.len() {
        right -= score.measures[idx].sib_key_offset;
    }

    let mut y_pos: Option<f64> = None;
    if !s.staves.is_empty() {
        let eng = &score.options;
        let st = &s.staves[0];
        if st.has_harmony {
            y_pos = Some(if mixed && !score.auto_layout { -st.harmony_y + 12.0 } else { -(st.harmony_y + 3.0 + score.harmony_band()[0]) + 26.0 });
        } else if mixed {
            // 简谱层的原点是 `st.minY − mixStaffDist − mixStaffHeight`；竖脚底停在简谱层之上 16
            y_pos = Some(st.min_y - eng.mix_staff_dist - eng.mix_staff_height + 30.0 - MIXED_ENDING_GAP);
        } else {
            y_pos = Some(js::min(20.0, st.min_y + 26.0)); // 20 = 不给 yPos 时的缺省位置；高音、上方弧再往上让
        }
    }

    EndingPlace { left, right, y_pos, starts_here, ends_here }
}

fn draw_ending(score: &StaffLayout, container: &mut Node, obj: EndingId, sys: SysId, mixed: bool, env: &Env) {
    let EndingPlace { left, right, y_pos, starts_here, ends_here } = ending_place(score, obj, sys, mixed);
    let eng = &score.options;
    let y0 = -30.0;
    let vlen = 20.0;
    let hlen = 10.0;

    let mut grp = translated(0.0, y_pos.map_or(0.0, |y| y - vlen));
    add_ending_bracket(
        &mut grp,
        &EndingBracket {
            x0: left,
            x1: right,
            top: y0,
            drop: vlen,
            left_foot: starts_here,
            right_foot: ends_here && score[obj].has_stop,
            line_width: 1.0,
            color: BLACK,
            label: starts_here.then(|| EndingLabel { text: score[obj].number.clone(), font: Font::new(eng.word_font.as_str(), 20.0), dx: hlen }),
            classes: None,
        },
        env,
    );
    container.push(grp);
}

// -----------------------------------------------------------------------
// drawWedge / drawPedalLine（render.cpp::drawWedge / drawPedalLine）
// container 已平移到 part 顶（yposPart(p,0)）；ypos 加上 staff 内偏移。

fn part_staff_offset(score: &StaffLayout, sys: SysId, p: PartId, staff: usize) -> f64 {
    score[sys].ypos_part(p, staff) - score[sys].ypos_part(p, 0)
}

/// 源谱版面档：松叶止端离小节线至少留的空（tenths）
const WEDGE_BAR_CLEAR: f64 = 3.0;

fn draw_wedge(score: &StaffLayout, container: &mut Node, obj: WedgeId, sys: SysId) {
    let w = &score[obj];
    let ypos = part_staff_offset(score, sys, w.span.part, w.staff) + w.ypos;
    let mif_l = w.start_measure;
    let mif_r = w.end_measure;

    let start_in_sys = score[mif_l].system == Some(sys);
    let end_in_sys = score[mif_r].system == Some(sys);
    let first_mif = score[sys].measures[0];
    // 端点相对拍位的偏移（`relative-x`）：源谱版面档才加，只加在落在本系统的那一端
    let dx = score.keep_breaks;
    let x_l = if start_in_sys {
        score.measure_get_ent_pos(mif_l, &w.span.start_tick.minus(&score[mif_l].offset)) + score.measure_xpos(mif_l) + if dx { w.dx_left } else { 0.0 }
    } else {
        score.measure_get_ent_pos(first_mif, &Fraction::int(0.0))
    };
    let mut x_r = if end_in_sys {
        score.measure_get_ent_pos(mif_r, &w.span.end_tick.minus(&score[mif_r].offset)) + score.measure_xpos(mif_r) + if dx { w.dx_right } else { 0.0 }
    } else {
        score.sys_width(sys)
    };
    // 源谱版面档的 `relative-x` 重排紧了会把止端推过小节线：收在止端那个小节里
    if dx && end_in_sys {
        x_r = js::min(x_r, score.measure_xpos(mif_r) + score[mif_r].width - WEDGE_BAR_CLEAR);
    }

    let h = w.spread / 2.0;
    // 落在系统边界的断点固定取 BREAK_FRAC×h
    const BREAK_FRAC: f64 = 0.6;
    let real_l = if w.crescendo { 0.0 } else { h };
    let real_r = if w.crescendo { h } else { 0.0 };
    let h_l = if start_in_sys { real_l } else { h * BREAK_FRAC };
    let h_r = if end_in_sys { real_r } else { h * BREAK_FRAC };

    container.push(hairpin_path(&HairpinSpec { x0: x_l, x1: x_r, y: ypos, half0: h_l, half1: h_r, line_width: 1.0, color: BLACK }));
}

fn draw_pedal_line(score: &StaffLayout, container: &mut Node, obj: PedalId, sys: SysId) {
    let o = &score[obj];
    let ypos = part_staff_offset(score, sys, o.span.part, o.staff) + o.ypos;
    let mif_l = o.start_measure;
    let mif_r = o.end_measure;
    let left = score.measure_get_ent_pos(mif_l, &o.span.start_tick.minus(&score[mif_l].offset)) + score.measure_xpos(mif_l);
    let right = score.measure_get_ent_pos(mif_r, &o.span.end_tick.minus(&score[mif_r].offset)) + score.measure_xpos(mif_r);

    let vlen = 10.0;
    let mut n = Node::path();
    let p = n.path_mut();
    p.fill = false;
    p.stroke = true;
    p.stroke_color = BLACK;
    p.stroke_width = 1.0;
    p.move_to(left, ypos - vlen);
    p.line_to(left, ypos);
    p.line_to(right, ypos);
    p.line_to(right, ypos - vlen);
    container.push(n);
}

/// 八度线：起头印「8va」（15ma；印在下方的 8vb / 15mb），后面一道虚线到止点，止点竖钩朝谱表。
fn draw_octave_line(score: &StaffLayout, container: &mut Node, obj: OctaveId, sys: SysId, env: &Env) {
    let eng = &score.options;
    let o = &score[obj];
    let above = o.span.above;
    let off = part_staff_offset(score, sys, o.span.part, o.staff);
    let start_in_sys = score[o.start_measure].system == Some(sys);
    let end_in_sys = score[o.end_measure].system == Some(sys);
    let x_l = if start_in_sys {
        score.measure_get_ent_pos(o.start_measure, &o.span.start_tick.minus(&score[o.start_measure].offset)) + score.measure_xpos(o.start_measure)
    } else {
        score.measure_get_ent_pos(score[sys].measures[0], &Fraction::int(0.0))
    };
    // 止点是下一个音的拍位：线收在范围里最后一个音的符头右缘
    let mut last_head: Option<f64> = None;
    let mut y = if above { -20.0 } else { 68.0 };
    for &md in &score[o.span.part].measures {
        let mi = score[md].measure_info;
        if score[mi].system != Some(sys) {
            continue;
        }
        for &c in &score[md].chords {
            let t = score.chord_tick(c);
            if t.compare_to(&o.span.start_tick) < 0 || t.compare_to(&o.span.end_tick) >= 0 {
                continue;
            }
            for &n in &score[c].notes {
                if score.note_staff(n) != o.staff || score[n].written_pitch < 0.0 {
                    continue;
                }
                y = if above { js::min(y, score.note_cy(n) - 15.0) } else { js::max(y, score.note_cy(n) + 30.0) };
                let x = score.measure_get_ent_pos(mi, &score[c].offset) + score.measure_xpos(mi) + score[c].notehead_width(score.meta);
                if last_head.is_none_or(|lh| x > lh) {
                    last_head = Some(x);
                }
            }
        }
    }
    let x_r = if !end_in_sys {
        score.sys_width(sys)
    } else {
        last_head.unwrap_or_else(|| {
            score.measure_get_ent_pos(o.end_measure, &o.span.end_tick.minus(&score[o.end_measure].offset)) + score.measure_xpos(o.end_measure)
        })
    };
    let fs = eng.music_font.size;
    let big = o.size >= 15.0;
    let glyph = gs(if !start_in_sys {
        if big {
            "quindicesima"
        } else {
            "ottava"
        }
    } else if above {
        if big {
            "quindicesimaAlta"
        } else {
            "ottavaAlta"
        }
    } else if big {
        "quindicesimaBassaMb"
    } else {
        "ottavaBassaVb"
    });
    let base = off + y;
    let mut g = translated(0.0, 0.0);
    add_smufl(&mut g, &glyph, x_l, base, fs, env);
    let gw = smufl_width(score.meta, &glyph);
    // 字形立在基线上、高约两间：虚线接在字形半高，钩朝谱表
    let line_y = base - 9.0;
    let hook = if above { 8.0 } else { -8.0 };
    let mut n = Node::path();
    let p = n.path_mut();
    p.fill = false;
    p.stroke = true;
    p.stroke_color = BLACK;
    p.stroke_width = 1.0;
    let mut x = x_l + gw + 3.0;
    while x < x_r {
        p.move_to(x, line_y);
        p.line_to(js::min(x + 4.0, x_r), line_y);
        x += 8.0;
    }
    if end_in_sys && x_r > x_l + gw + 3.0 {
        p.move_to(x_r, line_y);
        p.line_to(x_r, line_y + hook);
    }
    g.push(n);
    container.push(g);
}

// -----------------------------------------------------------------------
// drawLrc（render.cpp::drawLrc）

fn draw_lrc_hyphen(score: &StaffLayout, l: crate::model::LyricId, container: &mut Node, mif_xpos: f64, env: &Env) {
    let eng = &score.options;
    let lrc = &score[l];
    let next = &score[lrc.next.expect("有下一音节")];
    let mif_l = score[lrc.measure].measure_info;
    let mif_r = score[next.measure].measure_info;

    let left = lrc.x + lrc.x_offset + lrc.width;
    let mut r = next.x + next.x_offset;
    if mif_r != mif_l {
        if score[mif_l].system != score[mif_r].system {
            r = score.sys_width(score[mif_r].system.expect("小节在系统里")) - mif_xpos;
        } else {
            r += score.measure_xpos(mif_r) - mif_xpos;
        }
    }
    let cx = (left + r) / 2.0;
    let hyp = if eng.chinese_hyphen { "—" } else { "-" };
    let hyp_w = lrc.font.measure_text(env.mc, hyp);
    container.push(text_item(hyp, lrc.font.clone(), BLACK, cx - hyp_w / 2.0, -lrc.y, false, env));
}

pub fn draw_lrc(score: &StaffLayout, container: &mut Node, data: PmId, sub_staff: usize, env: &Env) {
    let eng = &score.options;
    let mif_xpos = score.pm_xpos(data);
    for &l in &score[data].lyrics {
        if score.lyric_staff(l) != sub_staff as f64 {
            continue;
        }
        let lrc = &score[l];
        if lrc.empty() {
            continue;
        }
        let x = lrc.x;
        if x < 0.0 {
            continue;
        }

        if lrc.next.is_some() {
            draw_lrc_hyphen(score, l, container, mif_xpos, env);
        }

        let text = lrc.text();
        let mut t = text_item(&text, lrc.font.clone(), BLACK, x + lrc.x_offset, -lrc.y, false, env);
        t.id = Some(Identity { id: Some(score[lrc.chord].src.id), verse: Some(lrc.src.number as u32), ..ident(IdentityKind::Syllable) });
        // 标点挤压：`widthInfo` 量的就是挤压后的宽度，绘制拿同一串笔位
        let chars: Vec<char> = text.chars().collect();
        if chars.len() > 1 {
            let run = lrc.font.run(env.mc, &text, lrc.compress);
            let xs = if eng.musicpp_hwid_glyphs && lrc.compress == CompressMode::Halfwidth {
                // 不把标点换成 ASCII：只将其墨迹中心摆到 `halt` 实测得到的那个 advance 格中心
                run.xs
                    .iter()
                    .enumerate()
                    .map(|(i, &x0)| {
                        let ch = chars[i].to_string();
                        if punct_class(&ch) == PunctClass::None {
                            return x0;
                        }
                        let x1 = run.xs.get(i + 1).copied().unwrap_or(run.width);
                        let ink = lrc.font.char_bound(env.mc, &ch);
                        (x0 + x1) / 2.0 - (ink.left + ink.right) / 2.0
                    })
                    .collect()
            } else {
                run.xs
            };
            t.text_mut().char_xs = Some(xs);
        }
        container.push(t);

        let prefix = lrc.prefix();
        if !prefix.is_empty() {
            let cnt = prefix.encode_utf16().count() as f64;
            // 段号按墨迹摆：右缘离首字左缘留 0.3 字号；成书照 musicpp 的固定偏移
            let px = if eng.verse_label_by_ink {
                x + lrc.x_offset - lrc.font.run(env.mc, &prefix, lrc.compress).width - lrc.font.size * 0.3
            } else {
                x - (40.0 + (cnt - 2.0) * 12.0)
            };
            container.push(text_item(&prefix, lrc.font.clone(), BLACK, px, -lrc.y, false, env));
        }
    }
}

// -----------------------------------------------------------------------
// drawHarmony（render.cpp::drawHarmony）

fn harmony_segs(score: &StaffLayout, h: HarmId) -> Vec<HarmonySeg> {
    let side = accidental_side(score);
    if score.options.chord_plain {
        chord_text_segs(&score[h].as_plain_text(side), true, side)
    } else {
        score.harmony_as_text(h, side)
    }
}

/// 一个和弦符号画出来的宽（同 `drawHarmony` 的字体与分段），谱表上方文字避让用
pub fn harmony_width_of(score: &StaffLayout, h: HarmId) -> f64 {
    let eng = &score.options;
    let fontsz = eng.harmony_size / if score.scaling > 0.0 { score.scaling } else { 0.45 };
    let segs = harmony_segs(score, h);
    harmony_width(&segs, &Font::new(eng.word_font.as_str(), fontsz), &Font::new("Bravura Text", fontsz), &score.env())
}

pub fn draw_harmony(score: &StaffLayout, container: &mut Node, data: PmId, sub_staff: usize, scaling: f64, mixed: bool, env: &Env) {
    let eng = &score.options;
    let fontsz = eng.harmony_size / if scaling > 0.0 { scaling } else { 0.45 };
    let word_font = Font::new(eng.word_font.as_str(), fontsz);
    // SMuFL csym 字形用同字号的 "Bravura Text"
    let music_font = Font::new("Bravura Text", fontsz);
    // 整小节休止的混排小节，offset==0 的和弦标记右移 15
    let pm = &score[data];
    let measure_rest = mixed && pm.chords.len() == 1 && score[pm.chords[0]].measure_rest;
    for &h in &pm.harmonies {
        let hl = &score[h];
        if hl.staff() != sub_staff as f64 {
            continue;
        }
        let mixed_offset_for_rest = if measure_rest && hl.offset.compare_to(&Fraction::int(0.0)) == 0 { 15.0 } else { 0.0 };
        let segs = harmony_segs(score, h);
        let width = harmony_width(&segs, &word_font, &music_font, env);
        let mut grp = layout_harmony_segs(&segs, &word_font, &music_font, BLACK, env);
        grp.m = Matrix33::from_affine([1.0, 0.0, 0.0, 1.0, hl.x - width / 2.0 + 6.5 + mixed_offset_for_rest, -hl.y + word_font.metrics(env.mc).descent]);
        container.push(grp);
    }
}

// -----------------------------------------------------------------------
// drawTextBlock（render.cpp::drawTextBlock）— <direction> 文本

/// 绘制单个 TextBlock（逐行 justify）。
fn draw_text_block(score: &StaffLayout, container: &mut Node, t: TextId, env: &Env) {
    let t = &score[t];
    if t.data.is_empty() {
        return;
    }
    let by_size = score.options.text_line_height_by_size;

    let mut line_w: Vec<f64> = Vec::new();
    let mut line_h: Vec<f64> = Vec::new();
    let mut w = 0.0;
    let mut h: f64 = 0.0;
    for it in &t.data {
        if it.text == "\n" {
            line_w.push(w);
            line_h.push(h);
            w = 0.0;
            h = 0.0;
            continue;
        }
        w += it.pad_before.unwrap_or(0.0) + it.font.measure_text(env.mc, &it.text);
        // 行高与谱行包围盒（tightLineHeights）同一口径
        let fm = it.font.metrics(env.mc);
        h = js::max(h, if by_size { it.nominal_size.unwrap_or(it.font.size) } else { fm.descent - fm.ascent });
    }
    line_w.push(w);
    line_h.push(h);
    let total_w = js_max_of(line_w.iter().copied());

    let mut line = 0usize;
    let mut xpos = 0.0;
    let mut ypos = 0.0;
    let mut first = true;
    for it in &t.data {
        let content = it.text.as_str();
        if content == "\n" {
            line += 1;
            if line >= line_h.len() {
                break;
            }
            ypos += line_h[line] * 1.444;
        }
        if first || content == "\n" {
            let diff = total_w - line_w[line];
            xpos = match t.justify {
                Lcr::Right => diff,
                Lcr::Center => diff / 2.0,
                Lcr::Left => 0.0,
            };
        }
        first = false;
        if content == "\n" {
            continue;
        }

        xpos += it.pad_before.unwrap_or(0.0);
        let mut tf = Node::text(content, it.font.clone());
        tf.text_mut().color = BLACK;
        tf.m = Matrix33::from_affine([1.0, 0.0, 0.0, 1.0, t.x + xpos, -t.y + ypos]);
        container.push(tf);
        xpos += it.font.measure_text(env.mc, content);
    }
    if t.boxed && !t.frameless {
        // 排练号的方框：按首行字的墨迹上下沿、整块宽，四周留 0.25 个字号
        let Some(it0) = t.data.iter().find(|it| it.text != "\n") else { return };
        let b = it0.font.char_bound(env.mc, &it0.text);
        let pad = it0.font.size * 0.25;
        let (x0, x1) = (t.x - pad, t.x + total_w + pad);
        let (y0, y1) = (-t.y + b.top - pad, -t.y + b.bottom + pad);
        let lw = 1.2;
        add_line(container, x0, y0, x1, y0, lw);
        add_line(container, x1, y0, x1, y1, lw);
        add_line(container, x1, y1, x0, y1, lw);
        add_line(container, x0, y1, x0, y0, lw);
    }
}

fn draw_text_blocks(score: &StaffLayout, container: &mut Node, data: PmId, sub_staff: usize, env: &Env) {
    for &t in &score[data].text_blocks {
        if score[t].staff != sub_staff {
            continue;
        }
        draw_text_block(score, container, t, env);
    }
}

// -----------------------------------------------------------------------
// drawLineObjs（render.cpp::drawLineObjs）— span objects per part per system

fn draw_line_objs(score: &StaffLayout, container: &mut Node, sys: SysId, p: PartId, env: &Env) {
    let eng = &score.options;
    let s = &score[sys];
    let mut grp = translated(0.0, s.ypos_part(p, 0));

    let part = &score[p];
    let first_stf = &part.staves[0];
    let t = score[s.measures[0]].offset;
    let nota = first_stf.get_notation(&t);
    let mixed = nota == Notation::Mixed;

    if mixed {
        let mut miny = 0.0;
        for st in &s.staves {
            if st.part() != p {
                continue;
            }
            miny = st.min_y;
        }
        // TS 先把简谱层的组挂进 grp（第一个子节点），再往两边画
        let mut grp_jp = translated(0.0, miny - eng.mix_staff_dist - eng.mix_staff_height);

        for &sl in &part.slurs {
            draw_slur(score, sys, &mut grp, sl, Some(Notation::Normal), env);
            let nts = &score[score.slur_start_chord(sl)].notes;
            let nt = if score[sl].span.above { nts[nts.len() - 1] } else { nts[0] };
            if !score[nt].jp_melody {
                continue;
            }
            draw_slur(score, sys, &mut grp_jp, sl, Some(Notation::JianPu), env);
        }
        for &obj in &part.tied {
            draw_tied(score, sys, &mut grp, obj, Some(Notation::Normal), env);
            let Some(nt) = score[obj].notes.start_note else { continue };
            if !score[nt].jp_melody {
                continue;
            }
            draw_tied(score, sys, &mut grp_jp, obj, Some(Notation::Mixed), env);
        }
        grp.k.insert(0, grp_jp);
    } else {
        for &sl in &part.slurs {
            draw_slur(score, sys, &mut grp, sl, None, env);
        }
        for &obj in &part.tied {
            draw_tied(score, sys, &mut grp, obj, None, env);
        }
    }

    if nota != Notation::JianPu {
        for &ext in &part.lrc_extends {
            draw_lrc_extend(score, sys, &mut grp, ext);
        }
    }

    for &obj in &part.tuplets {
        let sp = &score[obj].span;
        if !score.sys_overlap(sys, sp) {
            continue;
        }
        if score.sys_contains(sys, &sp.start_tick) && score.sys_contains(sys, &sp.end_tick) {
            draw_tuplet(score, &mut grp, obj, env);
        }
    }

    for &obj in &part.wedges {
        if !score.sys_overlap(sys, &score[obj].span) {
            continue;
        }
        // 与 musicpp 不同：相交即绘制，drawWedge 内部按系统边界裁断（跨换行的松叶）。
        draw_wedge(score, &mut grp, obj, sys);
    }

    for &obj in &part.pedal_lines {
        let sp = &score[obj].span;
        if !score.sys_overlap(sys, sp) {
            continue;
        }
        if score.sys_contains(sys, &sp.start_tick) && score.sys_contains(sys, &sp.end_tick) {
            draw_pedal_line(score, &mut grp, obj, sys);
        }
    }

    for &obj in &part.octave_lines {
        if score.sys_overlap(sys, &score[obj].span) {
            draw_octave_line(score, &mut grp, obj, sys, env);
        }
    }

    for &obj in &part.endings {
        // 跨系统的房按系统裁段画
        if score.sys_overlap(sys, &score[obj].span) {
            draw_ending(score, &mut grp, obj, sys, mixed, env);
        }
    }
    container.push(grp);
}

// -----------------------------------------------------------------------
// drawStaff

fn draw_staff(score: &StaffLayout, container: &mut Node, ps: PsRef, staff_lines: f64, ypos: f64, w: f64) {
    let nota = score.part_staff(ps).get_notation(&Fraction::int(0.0));
    if nota == Notation::JianPu {
        return;
    }
    let mut grp = translated(0.0, ypos);
    let mut l = 0.0;
    while l < staff_lines {
        add_line(&mut grp, 0.0, l * 10.0, w, l * 10.0, score.options.line_widths.staff);
        l += 1.0;
    }
    container.push(grp);
}

// -----------------------------------------------------------------------
// drawClef

/// 打击乐谱号画两道细竖线：各粗 0.2 格、相隔 0.3 格，从第二线到第四线。占位仍按字形宽，竖线画在它中间
fn draw_percussion_clef(container: &mut Node, xpos: f64, sc: f64) {
    let (w, gap, glyph_w) = (2.0 * sc, 3.0 * sc, 15.28 * sc);
    let x0 = xpos + (glyph_w - (2.0 * w + gap)) / 2.0;
    let (y0, h) = (20.0 - 10.0 * sc, 20.0 * sc);
    container.push(fill_rect(BLACK, x0, y0, w, h));
    container.push(fill_rect(BLACK, x0 + w + gap, y0, w, h));
}

fn draw_clef(clef: &ClefSig, container: &mut Node, xpos: f64, font_size: f64, sc: f64, env: &Env) {
    if is_glyph(&clef.sign, "unpitchedPercussionClef1") {
        draw_percussion_clef(container, xpos, sc);
        return;
    }
    let y = 50.0 - clef.line * 10.0;
    if sc != 1.0 {
        add_smufl_scaled(container, &clef.sign, xpos, y, font_size, sc, sc, env);
    } else {
        add_smufl(container, &clef.sign, xpos, y, font_size, env);
    }
}

// -----------------------------------------------------------------------
// drawKeyAccid

#[allow(clippy::too_many_arguments)]
fn draw_key_accid(container: &mut Node, clef: &ClefSig, num: f64, sym: &str, skip: f64, x_off: f64, font_size: f64, env: &Env) {
    let inc = if num > 0.0 { 4.0 } else { 3.0 }; // 降号步进为 3
    let init_step = if num > 0.0 { 52.0 } else { 48.0 };
    let max_step = if num > 0.0 { 46.0 } else { 44.0 };
    let sk = skip.abs();
    let mut i = sk;
    while i < num.abs() {
        let mut step = init_step + i * inc;
        while step > max_step {
            step -= 7.0;
        }
        let mut base = clef.top_pitch();
        while base < 45.0 {
            base += 7.0;
        }
        let line = step - base;
        let y = -line * 5.0;
        add_smufl(container, sym, 10.0 * (i - sk) + x_off, y, font_size, env);
        i += 1.0;
    }
}

fn draw_key(score: &StaffLayout, container: &mut Node, mif: MeasId, ps: PsRef, x: f64, env: &Env) {
    let ps = score.part_staff(ps);
    let off = &score[mif].offset;
    let key = ps.get_key(off);
    let clef = ps.get_clef(off);
    let cancel = key.cancel;
    let cur = key.fifths;
    if cur == 0.0 && cancel == 0.0 {
        return;
    }

    let g = gs(if cur > 0.0 { "accidentalSharp" } else { "accidentalFlat" });
    let nat = gs("accidentalNatural");
    let mut grp = Node::group();
    let fs = score.options.music_font.size;

    if cancel * cur < 0.0 {
        draw_key_accid(&mut grp, &clef, cancel, &nat, 0.0, 0.0, fs, env);
        draw_key_accid(&mut grp, &clef, cur, &g, 0.0, cancel.abs() * 10.0, fs, env);
    } else if cur.abs() > cancel.abs() {
        draw_key_accid(&mut grp, &clef, cur, &g, 0.0, 0.0, fs, env);
    } else {
        let skip = (cur - cancel).abs();
        draw_key_accid(&mut grp, &clef, cancel, &nat, cur.abs(), 0.0, fs, env);
        draw_key_accid(&mut grp, &clef, cur, &g, 0.0, skip * 10.0, fs, env);
    }
    if !grp.k.is_empty() {
        grp.m = Matrix33::from_affine([1.0, 0.0, 0.0, 1.0, x, 0.0]);
        container.push(grp);
    }
}

// -----------------------------------------------------------------------
// drawTime

fn draw_time(score: &StaffLayout, container: &mut Node, mif: MeasId, ps: PsRef, x: f64, env: &Env) {
    let time = score.part_staff(ps).get_time(&score[mif].offset);
    let mut grp = Node::group();
    let fs = score.options.music_font.size;

    if time.symbol {
        let sym = gs(if time.beats == 2.0 { "timeSigCutCommon" } else { "timeSigCommon" });
        add_smufl(&mut grp, &sym, 0.0, 20.0, fs, env);
    } else {
        add_smufl(&mut grp, &TimeSig::make_number(time.beats), 0.0, 10.0, fs, env);
        add_smufl(&mut grp, &TimeSig::make_number(time.beat_type), 0.0, 30.0, fs, env);
    }

    if !grp.k.is_empty() {
        grp.m = Matrix33::from_affine([1.0, 0.0, 0.0, 1.0, x, 0.0]);
        container.push(grp);
    }
}

// -----------------------------------------------------------------------
// drawBarlineItem

/// 五线谱的小节线样式 → 公共小节线的 spec。
fn bar_glyph_spec(style: BarGlyph) -> BarlineSpec {
    let s = match style {
        BarGlyph::Single => None,
        BarGlyph::Double => Some(BarStyle::LightLight),
        BarGlyph::HeavyHeavy => Some(BarStyle::HeavyHeavy),
        BarGlyph::Final => Some(BarStyle::LightHeavy),
        BarGlyph::ReverseFinal => Some(BarStyle::HeavyLight),
        BarGlyph::None => Some(BarStyle::NoStyle),
    };
    BarlineSpec { style: s, repeat_backward: false, repeat_forward: false }
}

/// 整组小节线右缘对齐到 x（向左生长），与谱线右端接齐。返回墨迹宽。
#[allow(clippy::too_many_arguments)]
fn draw_barline_item(score: &StaffLayout, container: &mut Node, style: BarGlyph, x: f64, top: f64, bot: f64, rep_for_back: bool, tag: Option<&Identity>) -> f64 {
    let lw = &score.options.line_widths;
    let spec = if rep_for_back { BarlineSpec { style: None, repeat_backward: true, repeat_forward: true } } else { bar_glyph_spec(style) };
    let bar = BarlineGlyph::new(
        &spec,
        false,
        &BarlineStyle { top, bot, light: lw.light_barline, heavy: lw.heavy_barline, gap: Some(score.options.barline_dist), dot_radius: None, dots: Some(false), color: BLACK },
    );
    if bar.lines.is_empty() {
        return 0.0;
    }
    let w = bar.ink_right() - bar.ink_left();
    let dx = x - w - bar.ink_left();
    let lines = bar.lines.clone();
    let mut items = bar.items;
    for i in lines {
        let mut l = std::mem::replace(&mut items[i], Node::group());
        // 混排的线一律写绝对端点（x = 0）
        let cx = l.x() + dx;
        l.set_x(0.0);
        let ls = l.line_mut();
        ls.p0 = Point::new(cx, ls.p0.y);
        ls.p1 = Point::new(cx, ls.p1.y);
        if let Some(t) = tag {
            l.id = Some(t.clone());
        }
        container.push(l);
    }
    w
}

/// 反复双点。主谱画两个 repeatDot（第 2、3 间），混排谱在上方简谱层再画一组缩小版。
fn draw_repeat_dots(score: &StaffLayout, container: &mut Node, sys: SysId, x: f64, mix_staves: &HashSet<usize>, env: &Env) {
    let eng = &score.options;
    let s = &score[sys];
    let dot = gs("repeatDot");
    for i in 0..s.staves.len() {
        let st = &s.staves[i];
        if !st.staff_visible {
            continue;
        }
        let y0 = s.ypos(i);
        if mix_staves.contains(&i) {
            let yoff = st.min_y - eng.mix_staff_height - eng.mix_staff_dist;
            let sc = eng.mix_staff_height / 40.0;
            let fs = eng.music_font.size;
            add_smufl_scaled(container, &dot, x, y0 + yoff + 15.0 * sc, fs, sc, sc, env);
            add_smufl_scaled(container, &dot, x, y0 + yoff + 25.0 * sc, fs, sc, sc, env);
        }
        add_smufl(container, &dot, x, y0 + 15.0, eng.music_font.size, env);
        add_smufl(container, &dot, x, y0 + 25.0, eng.music_font.size, env);
    }
}

// -----------------------------------------------------------------------
// drawBarline

fn draw_barline(score: &StaffLayout, container: &mut Node, sys: SysId, env: &Env) {
    let eng = &score.options;
    let s = &score[sys];
    let mut styles: Vec<Option<BarGlyph>> = Vec::new();
    let mut xpos: Vec<f64> = Vec::new();

    let m0 = s.measures[0];
    styles.push(None);
    xpos.push(score.measure_xpos(m0) + score[m0].left_barline_pos);

    for idx in 0..s.measures.len() {
        let mid = s.measures[idx];
        let m = &score[mid];
        // 小节号（render.cpp:1706-1712）
        if m.show_bar_number && !eng.hide_bar_number {
            container.push(text_item(&m.number, Font::new(eng.word_font.as_str(), 20.0), BLACK, score.measure_xpos(mid), -25.0, false, env));
        }
        let mut dx = 0.0;
        if idx + 1 < s.measures.len() {
            dx = -score[s.measures[idx + 1]].sib_key_offset;
        }
        styles.push(Some(m.right_barline.unwrap_or(BarGlyph::Single)));
        xpos.push(score.measure_xpos(mid) + m.width + dx);
    }

    let n = xpos.len();
    if s.time_change_width > 0.0 {
        xpos[n - 1] -= s.time_change_width + 5.0;
    }
    if s.key_change_width > 0.0 {
        xpos[n - 1] -= s.key_change_width + 5.0;
    }

    // merge left barlines into styles array（左 Final 与右 Final 合并成 light-heavy-light 的双向反复）
    let mut light_heavy_light: HashSet<usize> = HashSet::new();
    for idx in 0..s.measures.len() {
        let m = &score[s.measures[idx]];
        if let Some(lb) = m.left_barline {
            let orig = styles[idx];
            if orig.is_none() || orig == Some(BarGlyph::Single) {
                styles[idx] = Some(lb);
            } else if orig == Some(BarGlyph::Final) {
                light_heavy_light.insert(idx);
            }
        }
    }

    let grps = score.sys_barline_groups(sys);

    // 混排谱所在的 staff 下标集合 + 其 minY
    let t0 = &score[s.measures[0]].offset;
    let mut mix_staves: HashSet<usize> = HashSet::new();
    let mut miny = 0.0;
    for (i, st) in s.staves.iter().enumerate() {
        if score.part_staff(st.part_staff).get_notation(t0) == Notation::Mixed {
            miny = st.min_y;
            mix_staves.insert(i);
        }
    }

    for i in 0..styles.len() {
        let Some(st) = styles[i] else { continue };
        let mut x = xpos[i];
        let rep = light_heavy_light.contains(&i);
        let mut width = 0.0;
        // 这条小节线的身份：系统开头那条是首小节之前，其余是第 i 小节（系统内从 1 数）之后
        let tag = if i == 0 {
            Identity { measure: Some(s.first_measure as u32), edge: Some(Edge::Before), ..ident(IdentityKind::Barline) }
        } else {
            Identity { measure: Some((s.first_measure + i - 1) as u32), edge: Some(Edge::After), ..ident(IdentityKind::Barline) }
        };

        for &(first, last) in &grps {
            let stb = &s.staves[last];
            let top = s.ypos(first);
            let bot = s.ypos(last) + stb.height();

            if rep {
                x += 15.0;
            }

            // mixed jp-staff barline segment above main staff
            if mix_staves.contains(&first) {
                let mix_top = miny + top - eng.mix_staff_height - eng.mix_staff_dist;
                let mix_bot = mix_top + eng.mix_staff_height;
                draw_barline_item(score, container, st, x, mix_top, mix_bot, rep, Some(&tag));
            }

            width = draw_barline_item(score, container, st, x, top, bot, rep, Some(&tag));
        }

        let mid = i + s.first_measure;
        if i < styles.len() - 1 && mid < score.measures.len() && score.measures[mid].forward {
            draw_repeat_dots(score, container, sys, x + 7.0, &mix_staves, env);
        }
        if i > 0 && mid > 0 && score.measures[mid - 1].backward {
            draw_repeat_dots(score, container, sys, x - (width + 7.0), &mix_staves, env);
        }
    }

    // connecting left vertical line
    if s.visible_staves() > 1 {
        add_line(container, 0.5, 0.0, 0.5, s.height(), 1.0);
    }
}

// -----------------------------------------------------------------------
// drawPartGroups

fn draw_part_groups(score: &StaffLayout, container: &mut Node, sys: SysId, env: &Env) {
    let eng = &score.options;
    let s = &score[sys];
    for grp in &score.part_groups {
        if grp.symbol == GroupSymbol::None {
            continue;
        }
        let (first, last) = score.sys_visible_staves_of(sys, grp);
        if first < 0 {
            continue;
        }
        let (first, last) = (first as usize, last as usize);
        let y0 = s.ypos(first);
        let y1 = s.ypos(last) + s.staves[last].height();

        if grp.symbol == GroupSymbol::Bracket {
            let lw = 5.0;
            let bx = -10.0 + lw / 2.0 - 0.5;
            add_line(container, bx, y0 - 5.0, bx, y1 + 5.0, lw);
            add_smufl(container, &gs("bracketTop"), -10.0, y0 - 4.0, eng.music_font.size, env);
            add_smufl(container, &gs("bracketBottom"), -10.0, y1 + 4.0, eng.music_font.size, env);
        } else if grp.symbol == GroupSymbol::Brace {
            let scale_x = 3.0;
            let scale_y = (y1 - y0) / 40.0;
            add_smufl_scaled(container, &gs("brace"), -14.0, y1, eng.music_font.size, scale_x, scale_y, env);
        }
    }
}

/// 声部名离系统左缘（括号、花括号之外）多远，tenths
const PART_NAME_GAP: f64 = 25.0;

/// 声部名：首个系统印全名、之后印缩写，右对齐在系统左缘外，纵向居本声部各可见谱表的中线；多行名逐行排。
/// 只在源谱版面档印（`keepBreaks`）。
fn draw_part_names(score: &StaffLayout, container: &mut Node, sys: SysId, env: &Env) {
    let s = &score[sys];
    let first = sys.0 == 0;
    for (pi, part) in score.parts.iter().enumerate() {
        let text = if first { &part.name } else { &part.abbrev };
        if text.is_empty() {
            continue;
        }
        let ks: Vec<usize> = s.staves.iter().enumerate().filter(|(_, st)| st.part() == PartId(pi) && st.staff_visible).map(|(k, _)| k).collect();
        if ks.is_empty() {
            continue;
        }
        let k_last = ks[ks.len() - 1];
        let y0 = s.ypos(ks[0]);
        let y1 = s.ypos(k_last) + s.staves[k_last].height();
        let font = Font::new(score.options.word_font.as_str(), if part.name_size > 0.0 { part.name_size / score.scaling } else { score.defaults.word_font.size });
        let lines: Vec<&str> = split_lines(text);
        let line_h = font.size * 1.2;
        let cap = font.char_bound(env.mc, "H");
        // 首行基线：整块（首行字顶到末行基线）居中
        let base = (y0 + y1) / 2.0 - ((lines.len() as f64 - 1.0) * line_h + cap.top) / 2.0;
        for (li, line) in lines.iter().enumerate() {
            let mut tf = Node::text(*line, font.clone());
            tf.m = Matrix33::from_affine([1.0, 0.0, 0.0, 1.0, -PART_NAME_GAP - font.measure_text(env.mc, line), base + li as f64 * line_h]);
            container.push(tf);
        }
    }
}

/// `text.split(/\r?\n/)`
fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

// -----------------------------------------------------------------------
// drawSysStaff

fn draw_sys_staff(score: &StaffLayout, container: &mut Node, sys: SysId, k: usize, ypos: f64, env: &Env) {
    let eng = &score.options;
    let s = &score[sys];
    let st = &s.staves[k];
    let psr = st.part_staff;
    let ps = score.part_staff(psr);

    draw_staff(score, container, psr, st.staff_lines, ypos, score.sys_width(sys));

    let mut xpos = 0.0;
    let last_m = s.measures[s.measures.len() - 1];
    for &mid in &s.measures {
        let m = &score[mid];
        let mut grp = translated(xpos, ypos);

        let nota = ps.get_notation(&m.offset);
        let is_jp = nota == Notation::JianPu;
        let nsys = mid == s.measures[0];

        if nsys && !is_jp {
            if let Some(cp) = m.clef_pos {
                draw_clef(&ps.get_clef(&m.offset), &mut grp, cp, eng.music_font.size, 1.0, env);
            }
        }
        // TS 两支（行首 / 行中转调）画法相同
        if (nsys && !is_jp && m.key_pos.is_some()) || (!nsys && ps.key_change(&m.offset) && m.key_pos.is_some() && !is_jp) {
            draw_key(score, &mut grp, mid, psr, m.key_pos.unwrap_or(0.0) - m.sib_key_offset, env);
        }
        if ps.time_change(&m.offset) && !is_jp {
            if let Some(tp) = m.time_pos {
                draw_time(score, &mut grp, mid, psr, tp, env);
            }
        }

        // trailing clef/key/time for next system
        if mid == last_m {
            let mut end_pos = m.width;
            if s.time_change_width > 0.0 && m.index + 1 < score.measures.len() {
                // 预告拍号自身只退它的宽度
                end_pos -= s.time_change_width;
                let next = MeasId(m.index + 1);
                if !is_jp {
                    draw_time(score, &mut grp, next, psr, end_pos, env);
                }
            }
            if s.key_change_width > 0.0 && m.index + 1 < score.measures.len() {
                // 5 tenths 是小节线与预告属性之间的空隙，不属于调号宽度
                end_pos -= s.key_change_width;
                let next = MeasId(m.index + 1);
                if !is_jp {
                    draw_key(score, &mut grp, next, psr, end_pos, env);
                }
            }
        }

        // notes, beams, lyrics, harmony
        if !is_jp {
            if let Some(&md) = score[ps.part].measures.get(m.index) {
                draw_notes_normal(score, &mut grp, md, ps.sub_index, env);
                draw_beams(score, &mut grp, md, ps.sub_index, eng.grace_size);
                draw_lrc(score, &mut grp, md, ps.sub_index, env);
                draw_harmony(score, &mut grp, md, ps.sub_index, score.scaling, nota == Notation::Mixed, env);
                draw_text_blocks(score, &mut grp, md, ps.sub_index, env);
            }
        }

        // 简谱叠层（混排第一子谱表）
        if nota == Notation::Mixed && ps.sub_index == 0 {
            draw_jianpu_overlay(&mut grp, score, sys, k, mid);
        }

        container.push(grp);
        xpos += m.width;
    }
}

// -----------------------------------------------------------------------
// drawSystem

/// TS `drawSystem(container, sys)` 先把 `res` 加进 container 再返回它；这里只返回 `res`，由调用方改完矩阵再挂上（树一样）
pub fn draw_system(score: &StaffLayout, sys: SysId) -> Node {
    let env = score.env();
    let env = &env;
    let eng = &score.options;
    let s = &score[sys];
    let mut res = Node::group();

    let mut ypos = 0.0;
    let mut top: Option<f64> = None;
    for (k, st) in s.staves.iter().enumerate() {
        if !st.staff_visible {
            continue;
        }
        ypos += st.distance;
        // 谱表带上沿：混排第一子谱表连同上方的简谱层
        let ps = score.part_staff(st.part_staff);
        let mixed_top = if ps.get_notation(&score[s.measures[0]].offset) == Notation::Mixed && ps.sub_index == 0 {
            ypos + st.min_y - eng.mix_staff_dist - eng.mix_staff_height
        } else {
            ypos
        };
        top.get_or_insert(mixed_top);
        draw_sys_staff(score, &mut res, sys, k, ypos, env);
        ypos += st.height();
    }
    res.add_class(STAFF_SYSTEM);
    res.id = Some(ident(IdentityKind::System));
    let mut d = Map::new();
    d.insert("top".into(), Value::from(top.unwrap_or(0.0)));
    d.insert("bottom".into(), Value::from(ypos));
    res.data = Some(d);

    draw_barline(score, &mut res, sys, env);
    draw_part_groups(score, &mut res, sys, env);
    if score.keep_breaks {
        draw_part_names(score, &mut res, sys, env);
    }
    for pi in 0..score.parts.len() {
        draw_line_objs(score, &mut res, sys, PartId(pi), env);
    }
    res
}

/// `endingPlace` 的结果
#[derive(Clone, Copy, Debug)]
pub struct EndingPlace {
    pub left: f64,
    pub right: f64,
    pub y_pos: Option<f64>,
    pub starts_here: bool,
    pub ends_here: bool,
}
