//! slur / tied 几何（SpanObj 静态方法，model.cpp:2582-2740）与「画在哪」（绘制与避让共用）。

use dolce_model::base::fraction::Fraction;
use dolce_model::base::js;
use dolce_engrave::accidental::{accidental_rise, AccidentalKind};
use dolce_engrave::arc::{arc_clear_shift, arc_rise, calc_slur_points, jp_arc_y, ArcObstacle, SlurStyle};
use dolce_engrave::stack::stack_top;
use dolce_model::base::geom::Point;

use super::*;
use crate::jprow::main_row;

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Pt2 {
    pub x: f64,
    pub y: f64,
}

/// 混排（五线谱层与简谱层）的弧线样式。
///
/// 这几个数原先是 `drawSlurTied` 里的字面量（`lw0 = 6`、纯黑、描边 0.7）——musicpp render.cpp:1076-1104 就是这么写死的。
/// 弧的几何与画法**与谱面那一路共用**，差别全在这个 style 上：
///
///   - `maxHeight`/`minHeight`/`flatSpan`/`flatRatio` **一律不设** → 退化成 musicpp 的
///     裸对数公式（那几条上下限与扁平长连音线是本项目为简谱加的，五线谱不要）。
///   - `side` 跟着符干走；简谱层恒为 `above = true`。
pub fn mixed_slur_style(above: bool) -> SlurStyle {
    SlurStyle { thickness: 6.0, color: 0xff000000u32 as f64, outline_width: Some(0.7), side_down: !above, ..SlurStyle::default() }
}

/// 一条弧在本系统里的两端（系统内坐标，y 相对第一谱表顶线、向下为正）与朝向。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArcEnds {
    pub plx: f64,
    pub ply: f64,
    pub prx: f64,
    pub pry: f64,
    pub above: bool,
}

/// 五线谱弧离跨度里符头、符干尖留的空（tenths，半个谱线间距）。
pub const STAFF_ARC_GAP: f64 = 5.0;

/// 弧（连同月牙的厚度）画出来的纵向范围 [顶, 底]：几何与 `drawSlurTied` 同一份。
pub fn arc_extent(e: &ArcEnds) -> [f64; 2] {
    let style = mixed_slur_style(e.above);
    let pl = Point::new(e.plx, e.ply);
    let pr = Point::new(e.prx, e.pry);
    let (p0, p1, cos) = calc_slur_points(pl, pr, &style);
    let lw = style.thickness / cos / 2.0; // 回程两个控制点下压的量
    let top = js::min(cubic_min_y(pl.y, p0.y, p1.y, pr.y), cubic_min_y(pl.y, p0.y + lw, p1.y + lw, pr.y));
    let bot = js::max(cubic_max_y(pl.y, p0.y, p1.y, pr.y), cubic_max_y(pl.y, p0.y + lw, p1.y + lw, pr.y));
    [top, bot]
}

impl<'d> StaffLayout<'d> {
    /// 五线谱 slur/tied 锚点（SpanObj::slurTiedPos）。
    pub fn slur_tied_pos(&self, chl: Option<ChordId>, chr: Option<ChordId>, above: bool) -> (Pt2, Pt2) {
        let eng = &self.options;
        let mut pl = Pt2::default();
        let mut pr = Pt2::default();
        if let Some(c) = chl {
            pl.x = self.chord_stem_x(c) + self.pm_xpos(self[c].measure);
        }
        if let Some(c) = chr {
            pr.x = self.chord_stem_x(c) + self.pm_xpos(self[c].measure);
        }

        let mut near = false;
        if let (Some(l), Some(r)) = (chl, chr) {
            let dt = self.chord_tick(r).minus(&self.chord_tick(l));
            if f_eq(&dt, &self[l].dur()) {
                near = true;
            }
        }

        let mut yoff = 5.0;
        let mut inc = 1.0;
        if above {
            inc = -1.0;
            yoff *= -1.0;
        }
        let stem_dist_dx = 3.0;
        let four = Fraction::int(4.0);
        if let Some(l) = chl {
            let ch = &self[l];
            if ch.stem_up == above {
                pl.y = self.chord_tail_y(l, true) + yoff;
                if f_lt(&ch.note_type(), &four) && ch.beams.is_empty() && near {
                    pl.y -= eng.slur_stem_dy * inc;
                    pl.x += stem_dist_dx;
                }
            } else {
                if !above {
                    pl.x -= 13.0;
                }
                pl.y = self.chord_stem_y(l) + yoff * 2.0;
            }
        }
        if let Some(r) = chr {
            let ch = &self[r];
            if ch.stem_up == above {
                pr.y = self.chord_tail_y(r, true) + yoff;
                if f_lt(&ch.note_type(), &four) && ch.beams.is_empty() && near {
                    pr.y -= eng.slur_stem_dy * inc;
                    pr.x -= stem_dist_dx;
                }
            } else {
                pr.y = self.chord_stem_y(r) + yoff * 2.0;
            }
        }
        if let (Some(l), Some(r)) = (chl, chr) {
            if self[l].stem_up != above || f_ge(&self[l].note_type(), &four) {
                if pl.y < pr.y && !above {
                    pl.y += inc * 3.0;
                }
                if self[r].stem_up != above {
                    pl.x += 5.0;
                }
            }
            if self[r].stem_up != above {
                if above {
                    pr.x += 7.0;
                } else {
                    pr.x -= 5.0;
                }
            }
        }
        if chl.is_none() {
            pl.y = pr.y;
        }
        if chr.is_none() {
            pr.y = pl.y;
        }
        (pl, pr)
    }

    /// 简谱层一个弧端点：数字墨心 x（系统坐标）与那一摞的墨迹顶（数字、高音点；`is_end` 时再算上临时记号——
    /// 起点的临时记号在弧外侧）。口径同另两条简谱路（engrave/arc）。返回 `(x, top)`。
    pub fn jp_arc_end(&self, ch: ChordId, is_end: bool) -> (f64, f64) {
        let x = self.note_cx(self[ch].stem_note()) + self.pm_xpos(self[ch].measure);
        let mut dot: f64 = 0.0;
        let mut acc: Option<f64> = None;
        for &nt in &self[ch].notes {
            if !self[nt].jp_melody {
                continue;
            }
            dot = js::max(dot, self.note_octave_jp(nt));
            if is_end && acc.is_none() {
                acc = self[nt].jp_accidental();
            }
        }
        let row = main_row(self);
        let mut top = stack_top(row.ink_top, dot, &row.st);
        if let Some(acc) = acc {
            let kind = if acc > 0.0 {
                AccidentalKind::Sharp
            } else if acc < 0.0 {
                AccidentalKind::Flat
            } else {
                AccidentalKind::Natural
            };
            top = js::min(top, row.ink_top - accidental_rise(kind, row.ink_bottom - row.ink_top, self.options.accidental_scale));
        }
        (x, top)
    }

    /// 简谱层 slur/tied 锚点（SpanObj::slurTiedPosForJp）：简谱弧只看起止两个音，往上一道叠层的空（jpArcY）。
    /// `chl` 缺省 = 跨系统续过来的后半条、`chr` 缺省 = 接到下一系统的前半条（敞口那端的 x 由调用方给）。
    pub fn slur_tied_pos_for_jp(&self, chl: Option<ChordId>, chr: Option<ChordId>) -> (Pt2, Pt2) {
        let l0 = chl.map(|c| self.jp_arc_end(c, false));
        let r0 = chr.map(|c| self.jp_arc_end(c, true));
        let l = l0.or(r0).expect("两端至少有一个和弦");
        let r = r0.or(l0).expect("两端至少有一个和弦");
        let y = jp_arc_y(l.1, r.1, main_row(self).st.gap);
        (Pt2 { x: l.0, y }, Pt2 { x: r.0, y })
    }

    /// Tie（render.cpp::drawTied）在本系统里画出来的两端。本系统画不出来返回 None。
    pub fn tied_ends(&self, sys: SysId, obj: TiedId, force_nota: Option<Notation>) -> Option<ArcEnds> {
        let begin = self.sys_begin_tick(sys);
        let end = self.sys_end_tick(sys);
        let o = &self[obj];
        if f_ge(&o.span.start_tick, &end) {
            return None;
        }
        if f_lt(&o.span.end_tick, &begin) {
            return None;
        }

        let has_prev = f_lt(&o.span.start_tick, &begin);
        let has_next = f_ge(&o.span.end_tick, &end);

        let chl = self.tied_start_chord(obj);
        let chr = self.tied_end_chord(obj);
        let mut ntl = o.notes.start_note;
        let mut ntr = o.notes.end_note;

        if has_prev {
            ntl = None;
        } else if has_next {
            ntr = None;
        }

        let mut nota = self.note_part_staff(self[chl].notes[0]).get_notation(&self.chord_tick(chl));
        if let Some(f) = force_nota {
            nota = f;
        }

        let mut above = o.span.above;
        let (mut plx, mut prx) = (0.0, 0.0);
        let (mut ply, mut pry);

        if nota == Notation::JianPu || nota == Notation::Mixed {
            above = true;
            // 简谱弧跨系统两截都画（同另两条简谱路），敞口那端在下面补
            if self[chr].voice() > 1.0 && has_prev {
                return None;
            }
            let (pl, pr) = self.slur_tied_pos_for_jp(if has_prev { None } else { Some(chl) }, if has_next { None } else { Some(chr) });
            plx = pl.x;
            ply = pl.y;
            prx = pr.x;
            pry = pr.y;
        } else {
            if let Some(n) = ntl {
                let rx = self.note_right_x_for_tie(n) + 3.0;
                plx = rx + self.pm_xpos(self[chl].measure);
            }
            if let Some(n) = ntr {
                prx = self[n].x - 3.0 + self.pm_xpos(self[chr].measure);
            }

            let nt = ntl.or(ntr).expect("延音线两端至少画一端");
            let ch = if ntl.is_some() { chl } else { chr };
            let stf_y = self.pm_staff_y(self[ch].measure, self.note_staff(nt));
            ply = self.note_cy(nt) + stf_y;
            pry = ply;

            if o.y_offset_type != 0.0 {
                ply -= o.y_offset_type * 8.0;
                pry = ply;
                let four = Fraction::int(4.0);
                let x_off_left = if f_lt(&self[chl].note_type(), &four) { self[chl].stem_up != above } else { true };
                if let Some(n) = ntl.filter(|_| x_off_left) {
                    plx = self.note_cx(n) + self.pm_xpos(self[chl].measure);
                }
                let x_off_right = if f_lt(&self[chr].note_type(), &four) { self[chr].stem_up } else { true };
                if let Some(n) = ntr.filter(|_| x_off_right) {
                    prx = self.note_cx(n) + self.pm_xpos(self[chr].measure);
                }
            }
        }

        let ms = &self[sys].measures;
        if has_prev {
            plx = self[ms[0]].data_pos;
        }
        if has_next {
            let last = ms[ms.len() - 1];
            prx = self.measure_xpos(last) + self[last].data_end;
        }

        Some(ArcEnds { plx, ply, prx, pry, above })
    }

    /// slur 在本系统里画出来的两端（render.cpp::drawSlur）。本系统画不出来返回 None。
    pub fn slur_ends(&self, sys: SysId, slur: SlurId, force_nota: Option<Notation>) -> Option<ArcEnds> {
        let begin = self.sys_begin_tick(sys);
        let end = self.sys_end_tick(sys);
        let sl = &self[slur];
        if f_ge(&sl.span.start_tick, &end) {
            return None;
        }
        if f_lt(&sl.span.end_tick, &begin) {
            return None;
        }
        let start_note = sl.notes.start_note?;

        let has_prev = f_lt(&sl.span.start_tick, &begin);
        let has_next = f_ge(&sl.span.end_tick, &end);

        let chl = if has_prev { None } else { Some(self.slur_start_chord(slur)) };
        let chr = if has_next { None } else { Some(self.slur_end_chord(slur)) };

        let ref_ch = chl.or(chr).expect("起止至少一端在本系统");
        let mut nota = self.note_part_staff(self[ref_ch].notes[0]).get_notation(&self.chord_tick(ref_ch));
        if let Some(f) = force_nota {
            nota = f;
        }

        let mut above = sl.span.above;
        let (plx, mut ply, prx, mut pry);
        let ms = &self[sys].measures;
        let last = ms[ms.len() - 1];
        let start_staff = self.note_staff(start_note);

        if nota == Notation::JianPu {
            above = true; // 简谱层 slur 一律朝上（render.cpp::drawSlur）
            // 简谱弧跨系统两截都画：起头那一系统画到系统末、收尾那一系统从系统开头起弧（敞口那端在下面补）
            let (pl, pr) = self.slur_tied_pos_for_jp(chl, chr);
            plx = pl.x;
            ply = pl.y;
            prx = pr.x;
            pry = pr.y;
            // **弧套弧**：套在它里面的延音线与更短的 slur 当障碍，按实际弧线判碰（arcClearShift），
            // 碰了才整条抬、高出一道叠层的空（260《感恩的泪》`2⌒2 3 2` 两条弧同一个起点）
            let x0 = if has_prev { self[ms[0]].data_pos } else { plx };
            let x1 = if has_next { self.measure_xpos(last) + self[last].data_end } else { prx };
            let mut inner: Vec<ArcObstacle> = Vec::new();
            let part = self[self[ref_ch].measure].part;
            let within = |a: &Fraction, b: &Fraction| !f_lt(a, &sl.span.start_tick) && !f_gt(b, &sl.span.end_tick);
            // 只认简谱层上真画出来的延音线（同谱表、旋律音，与画简谱层延音线同一条件）：
            // 别的谱表、别的声部的延音线不在这一层，当障碍会把弧无故抬高
            for &t in &self[part].tied {
                let tt = &self[t];
                let Some(sn) = tt.notes.start_note else { continue };
                if !self[sn].jp_melody || self.note_staff(sn) != start_staff || !within(&tt.span.start_tick, &tt.span.end_tick) {
                    continue;
                }
                if let Some(te) = self.tied_ends(sys, t, Some(Notation::JianPu)) {
                    inner.push(ArcObstacle { x: (te.plx + te.prx) / 2.0, y: arc_extent(&te)[0] });
                }
            }
            for &o in &self[part].slurs {
                let os = &self[o];
                let Some(sn) = os.notes.start_note else { continue };
                if o == slur || !self[sn].jp_melody || self.note_staff(sn) != start_staff || !within(&os.span.start_tick, &os.span.end_tick) {
                    continue;
                }
                if f_eq(&os.span.start_tick, &sl.span.start_tick) && f_eq(&os.span.end_tick, &sl.span.end_tick) {
                    continue;
                }
                if let Some(oe) = self.slur_ends(sys, o, Some(Notation::JianPu)) {
                    inner.push(ArcObstacle { x: (oe.plx + oe.prx) / 2.0, y: arc_extent(&oe)[0] });
                }
            }
            let shift = arc_clear_shift(x0, ply, x1, pry, arc_rise(x1 - x0, &mixed_slur_style(true)), true, &inner, main_row(self).st.gap);
            ply += shift;
            pry += shift;
        } else {
            let (pl, pr) = self.slur_tied_pos(chl, chr, above);
            plx = pl.x;
            ply = pl.y;
            prx = pr.x;
            pry = pr.y;
            // 五线谱弧**看整个跨度**（用户定；简谱弧只看起止）：跨度里的符头、弧那一侧的符干尖都是障碍，
            // 弧线（抛物线近似）碰了就整条往外挪，留 `STAFF_ARC_GAP`（arcClearShift）
            let x0 = if has_prev { self[ms[0]].data_pos } else { plx };
            let x1 = if has_next { self.measure_xpos(last) + self[last].data_end } else { prx };
            let obstacles = self.staff_arc_obstacles(sys, ref_ch, start_staff, &sl.span.start_tick, &sl.span.end_tick, above);
            let shift = arc_clear_shift(x0, ply, x1, pry, arc_rise(x1 - x0, &mixed_slur_style(above)), above, &obstacles, STAFF_ARC_GAP);
            ply += shift;
            pry += shift;
        }

        let plx = if has_prev { self[ms[0]].data_pos } else { plx };
        let prx = if has_next { self.measure_xpos(last) + self[last].data_end } else { prx };

        Some(ArcEnds { plx, ply, prx, pry, above })
    }

    /// 五线谱弧跨度里（起止之间、本系统内、同一谱表）弧那一侧的墨迹点：符头外缘，与朝弧那一侧的符干尖。
    pub fn staff_arc_obstacles(&self, sys: SysId, rf: ChordId, staff: usize, t0: &Fraction, t1: &Fraction, above: bool) -> Vec<ArcObstacle> {
        let mut out = Vec::new();
        let four = Fraction::int(4.0);
        let part = self[self[rf].measure].part;
        for &mif in &self[sys].measures {
            let Some(&md) = self[part].measures.get(self[mif].index) else { continue };
            for &c in &self[md].chords {
                let ch = &self[c];
                if ch.rest() || ch.grace() || ch.notes.is_empty() {
                    continue;
                }
                let t = self.chord_tick(c);
                if !f_gt(&t, t0) || !f_lt(&t, t1) {
                    continue;
                }
                let xpos = self.measure_xpos(mif);
                for &n in &ch.notes {
                    if self.note_staff(n) != staff || !self.note_visible(n) {
                        continue;
                    }
                    out.push(ArcObstacle {
                        x: self.note_cx(n) + xpos,
                        y: self.note_cy(n) + self.pm_staff_y(ch.measure, self.note_staff(n)) + if above { -5.0 } else { 5.0 },
                    });
                }
                // 符干尖在弧那一侧才挡（朝上的弧挡朝上的符干）
                if f_lt(&ch.note_type(), &four) && ch.stem_up == above && self.note_staff(ch.notes[0]) == staff {
                    out.push(ArcObstacle { x: self.chord_stem_x(c) + xpos, y: self.chord_tail_y(c, true) });
                }
            }
        }
        out
    }
}
