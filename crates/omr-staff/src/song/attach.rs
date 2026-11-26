//! 挂接：拍点的声部与起拍、歌词与记号按 x 挂到拍点、松叶挂到拍点。
use super::*;

/// 一行谱一个小节里各元素（按 x 排好，`(x, y, 份数, 干朝向)`）的 `(起拍时刻, 声部 1 / 2)`。
///
/// 时间线排得通（两个声部排到同一处）的照时间线：并排的两个各归一个声部，共用的干与休止记在声部 1。
/// 排不通的（漏了音、时值读错）不硬套时刻：横向挨着的算一个拍点，拍点依次往后排（每个占其中最短的时值），
/// 并排的第一个（干朝上的）归声部 1、其余归声部 2——次序与各自的时值都照谱面留着。
pub(super) fn voices(items: &[(f64, f64, u32, Option<bool>)], same_dx: f64) -> Vec<(u32, u8)> {
    let line = timeline(items, same_dx);
    if line.even().is_some() {
        return line.place.iter().map(|&(t, v)| (t, if v == SHARED || v == 0 { 1 } else { 2 })).collect();
    }
    let mut out = Vec::with_capacity(items.len());
    let (mut i, mut t) = (0, 0);
    while i < items.len() {
        let mut j = i + 1;
        while j < items.len() && items[j].0 - items[j - 1].0 < same_dx {
            j += 1;
        }
        let rank = |e: &(f64, f64, u32, Option<bool>)| match e.3 {
            Some(true) => 0,
            None => 1,
            Some(false) => 2,
        };
        let first = (i..j).min_by(|&a, &b| rank(&items[a]).cmp(&rank(&items[b])).then(items[a].1.total_cmp(&items[b].1))).unwrap();
        // 朝向相同的并排干是一个和弦，同归一个声部
        out.extend((i..j).map(|n| (t, if n == first || (items[n].3.is_some() && items[n].3 == items[first].3) { 1 } else { 2 })));
        t += items[i..j].iter().map(|e| e.2).min().unwrap();
        i = j;
    }
    out
}

/// 接连这么多个音节所占的拍点上第 1 行都没有字，这一截算只印一遍的共用词。
pub(super) const SHARED_RUN: usize = 3;

/// 文字能挂的一个拍点：和弦的 x 与最上面那个头的 y、所在小节、事件下标、声部。
#[derive(Clone, Copy)]
pub(super) struct Anchor {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) bar: usize,
    pub(super) event: usize,
    pub(super) voice: u8,
}

/// 一行谱的歌词与记号按 x 挂到音上。横向挨着（同一拍点）的几个和弦只留声部 1 的那个。
/// `rests`：这一行谱的休止拍点——整行没有音（只有休止，如器乐声部开头空着）时记号挂到它们上，歌词不挂。
pub(super) fn attach_text(ms: &mut [Measure], mut anchors: Vec<Anchor>, rests: &[Anchor], (staff, text): (usize, &RowText), same_dx: f64, han_lines: u8, ids: &mut Ids) {
    if anchors.is_empty() {
        let marks_only = RowText { lyrics: Vec::new(), marks: text.marks.clone() };
        if rests.is_empty() || marks_only.marks.is_empty() {
            return;
        }
        return attach_text(ms, rests.to_vec(), &[], (staff, &marks_only), same_dx, han_lines, ids);
    }
    anchors.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.voice.cmp(&b.voice)));
    let mut pts: Vec<Anchor> = Vec::new();
    for a in anchors {
        match pts.last_mut() {
            Some(p) if a.x - p.x < same_dx && a.bar == p.bar => {
                if a.voice < p.voice {
                    *p = a;
                }
            }
            _ => pts.push(a),
        }
    }
    if pts.is_empty() {
        return;
    }
    let xs: Vec<f64> = pts.iter().map(|p| p.x).collect();
    // 各行词的音节挂到哪个拍点
    let placed: Vec<Vec<usize>> = text.lyrics.iter().map(|l| align(&l.row.syls.iter().map(|s| s.x).collect::<Vec<_>>(), &xs)).collect();
    // 同种文字第 1 行占着的拍点
    let first_at = |latin: bool| -> Vec<bool> {
        let mut v = vec![false; xs.len()];
        for (l, p) in text.lyrics.iter().zip(&placed) {
            if l.latin == latin && l.number == 1 {
                p.iter().for_each(|&n| v[n] = true);
            }
        }
        v
    };
    let first = [first_at(false), first_at(true)];
    for (li, (line, place)) in text.lyrics.iter().zip(&placed).enumerate() {
        // 拉丁词的行号排在全曲汉字词之后
        let base = if line.latin { han_lines } else { 0 };
        // 只印一遍的词（副歌）排在几行主歌的中间那一行的高度上：这一行里接连三个以上音节所占的那一段拍点，
        // 第 1 行一个字都没有的，是共用的一行，记到第 1 行
        let occupied = &first[line.latin as usize];
        let mut shared = vec![false; place.len()];
        if line.number > 1 {
            let mut k = 0;
            while k < place.len() {
                let mut e = k;
                while e + 1 < place.len() && !(place[e]..=place[e + 1]).any(|n| occupied[n]) {
                    e += 1;
                }
                if !occupied[place[k]] && e - k + 1 >= SHARED_RUN {
                    shared[k..=e].iter_mut().for_each(|v| *v = true);
                }
                k = e + 1;
            }
        }
        for (k, (syl, &n)) in line.row.syls.iter().zip(place).enumerate() {
            let number = base + if shared[k] { 1 } else { line.number };
            let e = &mut ms[pts[n].bar].events[pts[n].event];
            // 行首印的段号并在首字前（汉字 `1.道`，拉丁 `1 Be`）
            let text = match (&line.row.label, k) {
                (Some(l), 0) if l.ends_with('.') && syl.text.chars().next().is_some_and(dolce_omr_core::text::chars::is_han) => format!("{l}{}", syl.text),
                (Some(l), 0) => format!("{l} {}", syl.text),
                _ => syl.text.clone(),
            };
            match e.lyrics.iter_mut().find(|l| l.number == number) {
                // 音不够：多出来的字并进同一个音
                Some(l) => l.text.push_str(&text),
                None => {
                    let rid = ids.syl(staff, li, k);
                    let src = ids.src(rid, RidKind::Lyric, Rect::new(syl.x - syl.w / 2.0, line.y0, syl.w, line.y1 - line.y0));
                    e.lyrics.push(Lyric { number, text, syllabic: syl.syllabic, src })
                }
            }
        }
    }
    for (mi, m) in text.marks.iter().enumerate() {
        let nearest = || (0..xs.len()).min_by(|&a, &b| (xs[a] - m.x).abs().total_cmp(&(xs[b] - m.x).abs())).unwrap();
        let n = match m.dir {
            // 文字指示、节拍器从它的左端起管：取左端右边（容一个拍点宽）第一个音
            Dir::Words { .. } | Dir::Metronome { .. } => xs.iter().position(|&x| x >= m.x - same_dx).unwrap_or(xs.len() - 1),
            _ => nearest(),
        };
        let src = match m.dir {
            Dir::Words { .. } | Dir::Metronome { .. } => ids.src(ids.mark(staff, mi), RidKind::Words, m.rect),
            Dir::Dynamics(_) => ids.src(ids.mark(staff, mi), RidKind::Dynamics, m.rect),
            _ => Src { rid: None, at: Some(ids.at(m.rect)) },
        };
        ms[pts[n].bar].events[pts[n].event].pre.push(Placed { dir: m.dir.clone(), src });
    }
}

/// 松叶的端点离音头心这么远（相对线距）以内算挂在这个音上。
pub(super) const WEDGE_END: f64 = 0.5;

/// 松叶的右端离谱表右端、左端离行首（谱号调号之后）不过这么多（相对线距），算画到行尾 / 从行首接着画（跨行的一条）。
pub(super) const WEDGE_EDGE: f64 = 1.5;

/// 一行谱上画到行尾、等下一个系统同一槽位接着的松叶：(哪个系统, 渐强)。
pub(super) type OpenWedge = Option<(usize, bool)>;

/// 一行谱的松叶挂到事件上：起端记在离左端最近的音前；止端记在右端处或之后的第一个音前，这个音不在右端所在的小节里
/// （松叶收在小节线前）就记在右端之前最后一个音的后面。
/// 跨行：上一个系统同一槽位画到行尾的（`open`）、这一行行首起的同向的一条是它的续段——删掉上一条的止端（在 `prev` 里，那一槽位已拼好的小节）、
/// 这一条不另起；这一行画到行尾的记进 `open`。
#[allow(clippy::too_many_arguments)]
pub(super) fn row_wedges(wedges: &[&Wedge], anchors: &[Anchor], ms: &mut [Measure], bar_of: &dyn Fn(f64) -> usize, sp: f64, (lead, right): (f64, f64), sys: usize, open: &mut OpenWedge, prev: &mut [Measure]) {
    let carried = open.take();
    let mut ws: Vec<&&Wedge> = wedges.iter().collect();
    ws.sort_by(|a, b| a.x0.total_cmp(&b.x0));
    for (k, w) in ws.into_iter().enumerate() {
        let Some(i) = (0..anchors.len()).min_by(|&a, &b| (anchors[a].x - w.x0).abs().total_cmp(&(anchors[b].x - w.x0).abs())) else { continue };
        let next = anchors.iter().position(|a| a.x >= w.x1 - WEDGE_END * sp).filter(|&n| anchors[n].bar == bar_of(w.x1));
        let (j, after) = match next {
            Some(n) => (n, false),
            None => match anchors.iter().rposition(|a| a.x < w.x1 - WEDGE_END * sp) {
                Some(n) => (n, true),
                None => continue,
            },
        };
        if j < i || (j == i && !after) {
            continue;
        }
        let kind = if w.cresc { score::Wedge::Crescendo } else { score::Wedge::Diminuendo };
        let cont = k == 0 && w.x0 <= lead + WEDGE_EDGE * sp && carried.is_some_and(|(s, c)| s + 1 == sys && c == w.cresc) && unstop(prev);
        if !cont {
            ms[anchors[i].bar].events[anchors[i].event].pre.push(Dir::Wedge(kind).into());
        }
        let e = &mut ms[anchors[j].bar].events[anchors[j].event];
        if after { &mut e.post } else { &mut e.pre }.push(Dir::Wedge(score::Wedge::Stop).into());
        if w.x1 >= right - WEDGE_EDGE * sp {
            *open = Some((sys, w.cresc));
        }
    }
}

/// 删掉这一槽位已拼好的小节里最后一个松叶止端（上一行画到行尾的那条，续段接着它）。删到了才回 true。
fn unstop(prev: &mut [Measure]) -> bool {
    for m in prev.iter_mut().rev() {
        for e in m.events.iter_mut().rev() {
            for list in [&mut e.post, &mut e.pre] {
                if let Some(n) = list.iter().rposition(|d| d.dir == Dir::Wedge(score::Wedge::Stop)) {
                    list.remove(n);
                    return true;
                }
            }
        }
    }
    false
}
