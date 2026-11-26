//! 混排的简谱叠层（照 `jianpuoverlay.ts`）：压在五线谱第一子谱表上方的那一行简谱（`1=X`、拍号、数字、临时记号、八度点、
//! 附点/增时线、减时线）。**接口约定**：`render::draw_sys_staff` 调。
//!
//! **逐音成柱**：每个音一个组，里面依次是临时记号、数字、八度点、附点或增时线；减时线是跨音的，各柱画完再画。

use dolce_model::base::fraction::Fraction;
use dolce_model::base::js;
use dolce_engrave::accidental::{AccidentalGlyph, AccidentalKind, AccidentalStyle, DigitRef};
use dolce_engrave::augdot::aug_dot_center;
use dolce_engrave::dash::{sustain_dash, DashStyle};
use dolce_engrave::dot::jp_dot;
use dolce_engrave::grace::grace_hook;
use dolce_engrave::keysig::{key_name_of_fifths, KeyLabel, KeyLabelStyle};
use dolce_engrave::prims::text_item;
use dolce_engrave::spacing::{AccidentalSide, AccidentalStyleKind};
use dolce_engrave::stack::{beam_y, high_dot_y, low_dot_y, stack_bottom};
use dolce_engrave::timesig::{TimeSigGlyph, TimeSigStyle};
use dolce_model::base::geom::Matrix33;
use dolce_engrave::scene::build::Env;
use dolce_engrave::scene::Node;
use dolce_engrave::text::Font;

use crate::jprow::{grace_row, main_row, melody_note};
use crate::model::{ChordId, MeasId, NoteId, PmId, PsRef, StaffLayout, SysId};
use crate::prims::{add_line, chord_group, translated};

const BLACK: f64 = 0xff000000u32 as f64;

/// `drawJianpuOverlay(grp, sys, st, m)`：`st` 是系统里第几行谱（`Sys.staves` 的下标）。
/// `grp` 是这个小节在五线谱层里的组（原点在谱表顶线、小节左缘）。
pub fn draw_jianpu_overlay(grp: &mut Node, score: &StaffLayout, sys: SysId, st: usize, m: MeasId) {
    let env = score.env();
    let env = &env;
    let eng = &score.options;
    let sst = &score[sys].staves[st];
    let psr = sst.part_staff;
    let ps = score.part_staff(psr);
    let mi = &score[m];
    let Some(&md) = score[ps.part].measures.get(mi.index) else { return };
    let jp_off_y = sst.min_y - eng.mix_staff_dist - eng.mix_staff_height;
    // TS 先把 grpJp 挂进 grp，再在 grp 里画「1=X」：子节点次序是 [grpJp, 调号]
    let mut grp_jp = translated(0.0, jp_off_y);

    // jianpu key「1=X」at first measure overall or on key change (drawn in main group)
    let key = (eng.show_key_change_jp && (mi.index == 0 || ps.key_change(&mi.offset)) && mi.key_pos.is_some())
        .then(|| draw_jp_key(score, m, psr, st, sys, env));

    // jp 拍号：曲首及任何拍号变更处
    if ps.time_change(&mi.offset) {
        if let Some(tp) = mi.time_pos {
            draw_jp_time_signature(score, &mut grp_jp, m, psr, tp, env);
        }
    }
    // 系统末尾的预告拍号（下一系统起始的新拍号）
    let ms = &score[sys].measures;
    if m == ms[ms.len() - 1] && score[sys].time_change_width > 0.0 && mi.index + 1 < score.measures.len() {
        let next = MeasId(mi.index + 1);
        draw_jp_time_signature(score, &mut grp_jp, next, psr, mi.width - score[sys].time_change_width, env);
    }

    for &c in &score[md].chords {
        for &n in &score[c].notes {
            let mut col = chord_group(score[c].src.id); // 带身份标签：播放线、点选按它认
            if let Some(alt) = accidental_of(score, c, n, ps.sub_index) {
                draw_accidental(score, &mut col, md, c, n, alt, env);
            }
            draw_column(score, &mut col, md, c, n, ps.sub_index, env);
            if !col.k.is_empty() {
                grp_jp.push(col);
            }
        }
    }
    draw_jp_beams(score, &mut grp_jp, md, env);
    grp.push(grp_jp);
    if let Some(k) = key {
        grp.push(k);
    }
}

/// 这个音在简谱层要印的临时记号：语义层按旋律延续算好的（`Degree.accidental`）。
fn accidental_of(score: &StaffLayout, c: ChordId, n: NoteId, sub_staff: usize) -> Option<f64> {
    let ch = &score[c];
    // 与 `drawColumn` 同一组条件：不画数字的音（slash、cue）也不印升降号
    if ch.rest() || ch.slash() || ch.cue() || score.note_staff(n) != sub_staff || !score.note_visible(n) || !score[n].jp_melody || score[n].x < 0.0 {
        return None;
    }
    score[n].jp_accidental()
}

/// 临时记号：画法与定位走公共那一份（csym 字形、贴数字墨迹盒左缘）。数字的落点与 `draw_column` 同一套。
fn draw_accidental(score: &StaffLayout, col: &mut Node, md: PmId, c: ChordId, n: NoteId, alt: f64, env: &Env) {
    let eng = &score.options;
    let font = score.mix_font();
    let s = score.note_number(n);
    let row = if score[c].grace() { grace_row(score, md, c) } else { main_row(score) };
    let x = score.note_cx(n) - font.measure_text(env.mc, &s) / 2.0;
    let digit = DigitRef { font, text: s, x, y: row.y, scale: Some(row.scale) };
    let kind = if alt > 0.0 {
        AccidentalKind::Sharp
    } else if alt < 0.0 {
        AccidentalKind::Flat
    } else {
        AccidentalKind::Natural
    };
    let style = AccidentalStyle {
        music: eng.music_font.clone(),
        color: BLACK,
        meta: true,
        kind: AccidentalStyleKind::parse(&eng.accidental_style),
        scale: Some(eng.accidental_scale),
    };
    col.push(AccidentalGlyph::new(kind, &digit, &style, env).item);
}

fn text_at(text: &str, font: &Font, x: f64, y: f64, env: &Env) -> Node {
    text_item(text, font.clone(), BLACK, x, y, false, env)
}

/// 一个音的数字、八度点、增时线或附点（render.cpp::drawNotesJianPu）。
fn draw_column(score: &StaffLayout, col: &mut Node, md: PmId, c: ChordId, n: NoteId, sub_staff: usize, env: &Env) {
    let ch = &score[c];
    if ch.slash() {
        return;
    }
    if score.note_staff(n) != sub_staff {
        return;
    }
    if !score.note_visible(n) {
        return;
    }
    if !score[n].jp_melody {
        return;
    }
    if ch.cue() {
        return;
    }
    let font = score.mix_font();
    let mif = score[md].measure_info;
    let mi = &score[mif];

    let mut x: f64;
    let mut measure_rest = false;
    if ch.rest() {
        if ch.measure_rest {
            measure_rest = true;
        }
        if ch.dur().compare_to(&mi.dur) == 0 {
            measure_rest = true;
        }
    }

    if measure_rest {
        x = mi.data_pos + 5.0;
        // 宽小节再右移 10（render.cpp:834-839）。
        let data_width = mi.data_end - mi.data_pos;
        let numw = font.measure_text(env.mc, "0") * mi.dur.to_int();
        if data_width > 2.0 * numw {
            x += 10.0;
        }
    } else {
        x = score.note_cx(n);
        if score[n].x < 0.0 {
            return;
        }
    }

    let s = score.note_number(n);
    let nw = font.measure_text(env.mc, &s);
    x -= nw / 2.0;

    // 数字与它那一摞的落点（倚音缩小、整块抬到主音那一摞之上，见 grace_row）
    let row = if ch.grace() { grace_row(score, md, c) } else { main_row(score) };
    let ypos = row.y;
    if ch.grace() {
        let mut g = Node::group();
        g.m = Matrix33::from_affine([row.scale, 0.0, 0.0, row.scale, x, ypos]);
        g.push(text_at(&s, &font, 0.0, 0.0, env));
        col.push(g);
    } else {
        col.push(text_at(&s, &font, x, ypos, env));
    }

    // 八度点：实心矢量圆，横向对准数字的墨迹中心
    let oct = score.note_octave_jp(n);
    if oct != 0.0 {
        let db = font.char_bound(env.mc, &s);
        let cx0 = x + ((db.left + db.right) / 2.0) * row.scale;
        let mut i = 0.0;
        while i < oct.abs() {
            let cy0 = if oct > 0.0 { high_dot_y(row.ink_top, i, &row.st) } else { low_dot_y(row.ink_bottom, ch.jp_beam_count(), i, &row.st) };
            col.push(jp_dot(cx0, cy0, row.st.dot_radius, BLACK));
            i += 1.0;
        }
    }

    if ch.note_type().compare_to(&Fraction::int(1.0)) > 0 {
        // 长于四分音符：增时线（休止写 0）
        let end = ch.dur().plus(&ch.offset);
        let end_pos = score.measure_get_ent_pos(mif, &end);
        // 截断取整，整小节休止用小节时值分子
        let mut cnt = ch.dur().to_int();
        if measure_rest {
            cnt = mi.dur.numerator;
        }
        let dx = if cnt > 0.0 { (end_pos - x) / cnt } else { 0.0 };
        // 增时线墨心对准该拍「数字」的墨心、纵向落在数字墨迹中线上
        let dig = font.char_bound(env.mc, &s);
        let mid_y = ypos + (dig.top + dig.bottom) / 2.0;
        let mut k = 1.0;
        while k < cnt {
            if ch.rest() {
                col.push(text_at("0", &font, x + dx * k, ypos, env));
            } else {
                col.push(sustain_dash(x + dx * k + nw / 2.0, mid_y, &DashStyle { font: font.clone(), color: BLACK }, env));
            }
            k += 1.0;
        }
    } else {
        // 附点：实心矢量圆，与数字墨迹中心等高，离数字墨迹右缘一道空
        let digit_ink = font.char_bound(env.mc, &s).offset(x, ypos);
        let mut d = 0.0;
        while d < ch.dot() {
            let (cx, cy) = aug_dot_center(&digit_ink, d, row.st.dot_radius, row.st.gap);
            col.push(jp_dot(cx, cy, row.st.dot_radius, BLACK));
            d += 1.0;
        }
    }
}

/// 减时线（render.cpp::BeamLevelData::drawJianPu）：跨音的，各柱画完再画。
fn draw_jp_beams(score: &StaffLayout, container: &mut Node, md: PmId, env: &Env) {
    let eng = &score.options;
    let font = score.mix_font();
    let meta = score.meta;

    for &b in &score[md].jp_beams {
        let chords = &score[b].chords;
        if chords.is_empty() {
            continue;
        }
        // skip cue groups
        if chords.iter().any(|&c| score[c].cue()) {
            continue;
        }

        for lev in 0..10usize {
            // 收集本层的连续减时线段——同层可有多段，不能用全局首/尾连成一条。
            let mut runs: Vec<(ChordId, ChordId)> = Vec::new();
            let mut start: Option<ChordId> = None;
            let mut end: Option<ChordId> = None;
            for &c in chords {
                if score[c].jp_beam_count() <= lev as f64 {
                    if let (Some(s), Some(e)) = (start, end) {
                        runs.push((s, e));
                    }
                    start = None;
                    end = None;
                    continue;
                }
                if start.is_none() {
                    start = Some(c);
                }
                end = Some(c);
            }
            if let (Some(s), Some(e)) = (start, end) {
                runs.push((s, e));
            }
            if runs.is_empty() {
                break;
            }

            for &(first, last) in &runs {
                let pick = |c: ChordId| score[c].notes.iter().copied().find(|&n| score[n].jp_melody).unwrap_or(score[c].notes[0]);
                let nt_l = pick(first);
                let nt_r = pick(last);

                let grace = score[first].grace();
                let grace_sc = if grace { eng.jp_grace_scale } else { 1.0 };
                let num_l = score.note_number(nt_l);
                let num_r = score.note_number(nt_r);
                // 端点 = 数字的笔位左缘到右缘（与 draw_column 画数字同一个笔位）
                let lx = score[nt_l].x + score[first].notehead_width(meta) / 2.0 - font.measure_text(env.mc, &num_l) / 2.0;
                let rx = score[nt_r].x + score[last].notehead_width(meta) / 2.0 - font.measure_text(env.mc, &num_r) / 2.0
                    + font.measure_text(env.mc, &num_r) * grace_sc;
                // 纵向：数字墨迹底 →空→ 第 1 层 →空→ 第 2 层…
                let row = if grace { grace_row(score, md, first) } else { main_row(score) };
                let y = beam_y(row.ink_bottom, lev as f64 + 1.0, &row.st);

                add_line(container, lx, y, rx, y, row.st.beam_width);
            }
        }
        if score[chords[0]].grace() {
            draw_grace_hook(score, container, md, chords, env);
        }
    }
}

/// 倚音的尾钩：一串只画一个，挂在离主音最近的那个倚音下面，弯向主音。
fn draw_grace_hook(score: &StaffLayout, container: &mut Node, md: PmId, chords: &[ChordId], env: &Env) {
    let eng = &score.options;
    let after = score[chords[0]].src.grace.as_ref().and_then(|g| g.after) == Some(true);
    let c = if after { chords[0] } else { chords[chords.len() - 1] };
    let ch = &score[c];
    let nt = melody_note(score, c);
    let font = score.mix_font();
    let num = score.note_number(nt);
    let mid = score[nt].x + ch.notehead_width(score.meta) / 2.0 - font.measure_text(env.mc, &num) / 2.0
        + (font.measure_text(env.mc, &num) * eng.jp_grace_scale) / 2.0;
    let row = grace_row(score, md, c);
    let beams = ch.jp_beam_count();
    let low = js::max(0.0, -score.note_octave_jp(nt));
    let from = if low > 0.0 { stack_bottom(row.ink_bottom, beams, low, &row.st) + row.st.gap } else { beam_y(row.ink_bottom, beams, &row.st) };
    let (m, cc) = grace_hook(mid, from, row.ink_bottom - row.ink_top, if after { -1.0 } else { 1.0 });
    let mut hook = Node::path();
    let p = hook.path_mut();
    p.fill = false;
    p.stroke = true;
    p.stroke_color = BLACK;
    p.stroke_width = row.st.beam_width;
    p.move_to(m[0], m[1]);
    p.cubic_to(cc[0], cc[1], cc[2], cc[3], cc[4], cc[5]);
    container.push(hook);
}

/// Draw time signature for jp/mixed staff（render.cpp::drawTime Mixed branch）。
fn draw_jp_time_signature(score: &StaffLayout, container: &mut Node, mif: MeasId, ps: PsRef, x: f64, env: &Env) {
    let eng = &score.options;
    let time = score.part_staff(ps).get_time(&score[mif].offset);
    let staff_height = eng.mix_staff_height;
    let font = score.mix_font();

    let mut grp = translated(x, 0.0);

    // KL2020 兼容档（musicpp 的旧公式）：数字不横向居中，分数线按实际数字 advance 加 2 tenths
    if eng.musicpp_jp_time_sig {
        let sc = staff_height / 40.0;
        // render.cpp 先把 descent 乘 sc，随后整个 (20-dy)/(40+dy) 又乘一次 sc。
        let dy = eng.jianpu_font.metrics(env.mc).descent * sc;
        let top_s = js::num_to_string(time.beats);
        let bottom_s = js::num_to_string(time.beat_type);
        let top = text_at(&top_s, &font, 0.0, sc * (20.0 - dy), env);
        let bottom = text_at(&bottom_s, &font, 0.0, sc * (40.0 + dy), env);
        let mut rule = Node::path();
        let p = rule.path_mut();
        p.fill = false;
        p.stroke = true;
        p.stroke_color = BLACK;
        p.stroke_width = 1.5;
        p.move_to(-1.0, staff_height / 2.0);
        p.line_to(js::max(font.measure_text(env.mc, &top_s), font.measure_text(env.mc, &bottom_s)) + 1.0, staff_height / 2.0);
        grp.push(top);
        grp.push(bottom);
        grp.push(rule);
        container.push(grp);
        return;
    }

    // 拍号走公共那一份（TimeSigGlyph）：两个数字横向居中于分数线，一切长度按小节线高度的比例；
    // 基准高度取这条谱表的高，基线取谱表底。
    let r = TimeSigGlyph::new(
        time.beats,
        time.beat_type,
        &TimeSigStyle {
            height: staff_height,
            center_y: staff_height / 2.0 - staff_height,
            rule_width: 1.5,
            color: BLACK,
            font,
            // 混排的拍号数字保留原大小（0.75 H）
            digit_ratio: Some(0.75),
            // 分数线长度：musicpp 原式 `max(w1,w2) + 2` ≈ 0.48 H
            rule_length_ratio: Some(0.48),
        },
        env,
    );
    for mut item in r.items {
        let y = item.y();
        item.set_y(y + staff_height);
        grp.push(item);
    }
    container.push(grp);
}

/// Draw jianpu key indicator「1=X」for jp/mixed staff（render.cpp::drawKey JianPu/Mixed 分支）。返回要挂进小节组的那个组。
fn draw_jp_key(score: &StaffLayout, mif: MeasId, ps: PsRef, st: usize, sys: SysId, env: &Env) -> Node {
    let eng = &score.options;
    let mi = &score[mif];
    let key = score.part_staff(ps).get_key(&mi.offset);

    let mut x = mi.key_pos.unwrap_or(0.0) - mi.sib_key_offset;
    if let Some(o) = mi.key_offest_jp {
        x += o;
    }
    let mut center = true;
    let msys = mi.system.expect("小节在系统里");
    if mif == score[msys].measures[0] {
        center = false;
        x = 0.0;
    }

    // y relative to main staff top line (negative = above); Mixed branch
    let mut y = -70.0;
    if mi.index == 0 {
        y -= 30.0; // 避开和弦
    } else {
        y = -score[sys].staves[st].harmony_y;
    }

    // 转调记号随谱高等比缩放用 mixFont；升降号是 csym 字形，写在音名之前并抬高。
    let jp_font = if eng.jp_key_jianpu_font { eng.jianpu_font.clone() } else { score.mix_font() };
    let k = KeyLabel::new(
        "1",
        &key_name_of_fifths(key.fifths),
        &KeyLabelStyle {
            font: jp_font,
            music: eng.music_font.clone(),
            color: BLACK,
            prefix: Some(if mi.index != 0 { "转".into() } else { String::new() }),
            side: AccidentalSide::parse(eng.accidental_side.as_deref()),
            classes: Vec::new(),
            eq_pad: None,
        },
        env,
    );
    if center {
        x -= k.width / 2.0;
    }
    let mut grp = translated(x, y);
    for it in k.items {
        grp.push(it);
    }
    grp
}
