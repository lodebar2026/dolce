//! 按参照歌词切段落、排逐遍演唱顺序（123 `[P:x]` + `%%sing`）。
//!
//! 歌词网站、歌本配套的歌词按实际唱法逐段写全（空行分段），谱面只印一遍、靠反复 / 房 / 跳转表达。
//! 这里拿整篇参照歌词去「走」谱面：把谱面在结构处切成原子（反复号、房、跳转、双纵线、谱面默认走向里跳过去的地方），
//! 每个原子的每条 `w:` 是一串字；动态规划找一条「原子 × 词行」的路，使串起来的字与参照逐字最像——
//! 顺着谱面默认演唱顺序走的转移不罚，不照谱面的（参照的段落顺序与反复对不上）罚一点，所以与谱面一致时照谱面、
//! 对不上时照参照（用户定：以歌词页为准，差异只报告、不改音符）。
//!
//! 走出来的路再按参照的段界切开（弱起句头切在弱起音前的休止处、优先切在小节线上），所有切点合成谱面上的段落；
//! 总是前后相连、配同一条词的相邻段并成一段；段落名按角色（主歌 `V`、副歌 `C`、桥段 `B`、没唱到的 `X`），同角色多段 `V2`、`V3`…；
//! 分遍按投影行数密排（一页缺省 4 行），副歌唱完优先换页，段界处 `/` 换行。判据与限制见 docs/模块/播放.md「按参照歌词生成段落与 `%%sing`」。

use std::collections::{HashMap, HashSet};

use dolce_base::hanvariant::simplified_of;
use dolce_model::{Element, ElementId, ScoreDoc, SectionMark, SingItem, SingPass, Song};
use dolce_play::walk::{walk_play, Step, WalkItem};
use serde::Serialize;

use crate::playsong::{play_data_of_song, song_measures, PlaySongOptions};
use crate::reflyrics::{is_hanzi, ref_lines};
use crate::slots::doc_view;

/// 投影一页缺省最多几行（同投影档 `MAX_ROWS`）
pub const DEFAULT_ROWS: usize = 4;

// 代价：逐字配对一处不同 / 参照多出一字 / 谱面多出一字 1 分；不照谱面走向的一次转移 2 分，从原子中间接入、跳进房再加；
// 每经过一个整格没词的音（前奏、间奏的休止）加一点，同分时少带无词的小节
const SUB: f64 = 1.0;
const SKIP_REF: f64 = 1.0;
const SKIP_SCORE: f64 = 1.0;
const JUMP: f64 = 2.0;
const MID_ENTRY: f64 = 0.5;
/// 不照谱面跳进一个房：歌词一样时宁可走本段自己的房（别段的房旋律多半不同）
const ENDING_JUMP: f64 = 1.0;
const SILENT: f64 = 0.02;
const INF: f64 = f64::INFINITY;

/// 报告的一条
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FitNote {
    pub kind: FitKind,
    /// 谱面第几小节（1 起，按第一声部的小节序）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bar: Option<usize>,
    /// 参照里的字
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub ref_: Option<String>,
    /// 谱面上的字
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<String>,
    /// 参照里所在那一句
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// 跳转：从第几小节（接到 `bar`）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_bar: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FitKind {
    /// 参照有、谱上没唱到的字
    RefExtra,
    /// 谱上有、参照没有的字
    ScoreExtra,
    /// 字不同
    Mismatch,
    /// 这里不照谱面的反复 / 跳转走
    OffScore,
    /// 整篇对不上（没有生成）
    NoMatch,
}

impl FitNote {
    fn new(kind: FitKind) -> Self {
        FitNote { kind, bar: None, ref_: None, score: None, context: None, from_bar: None }
    }

    /// 命令行打到 stderr 的写法
    pub fn format(&self) -> String {
        let at = self.bar.map(|b| format!("第{b}小节")).unwrap_or_else(|| "全曲".into());
        let ctx = self.context.as_deref().map(|c| format!("  〔{c}〕")).unwrap_or_default();
        match self.kind {
            FitKind::RefExtra => format!("[谱上没有] {at}：歌词多出「{}」{ctx}", self.ref_.as_deref().unwrap_or("")),
            FitKind::ScoreExtra => format!("[歌词没有] {at}：谱面多出「{}」{ctx}", self.score.as_deref().unwrap_or("")),
            FitKind::Mismatch => format!("[不一致] {at}：谱面「{}」→ 歌词「{}」{ctx}", self.score.as_deref().unwrap_or(""), self.ref_.as_deref().unwrap_or("")),
            FitKind::OffScore => format!("[不照谱面] 第{}小节之后接第{}小节{ctx}", self.from_bar.unwrap_or(0), self.bar.unwrap_or(0)),
            FitKind::NoMatch => "[对不上] 参照歌词与谱面歌词对不上，没有生成演唱顺序".into(),
        }
    }
}

/// 生成结果
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SingFit {
    pub marks: Vec<SectionMark>,
    pub order: Vec<SingPass>,
    pub notes: Vec<FitNote>,
    /// 参照字数、对上的字数
    pub ref_chars: usize,
    pub matched: usize,
}

impl SingFit {
    /// `%%sing` 的写法（预览与报告用；正式写出走格式写出端）
    pub fn sing_text(&self) -> String {
        self.order
            .iter()
            .map(|p| {
                let mut s = String::from("%%sing ");
                if let Some(r) = p.rows {
                    s.push_str(&format!("[rows={r}] "));
                }
                let items: Vec<String> = p
                    .items
                    .iter()
                    .map(|it| {
                        let v = it.verse.filter(|&v| v != 1.0).map(|v| format!("@{v}")).unwrap_or_default();
                        let br = if it.line_after == Some(true) { " /" } else { "" };
                        format!("{}{v}{br}", it.section)
                    })
                    .collect();
                s.push_str(&items.join(" "));
                s
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// 把生成结果写进这一首：段落标记整套换掉，演唱顺序换成生成的；头部 `P:` 去掉（写了 `%%sing` 它也不起作用，留着反而指向旧段名）
pub fn apply_sing_fit(song: &mut Song, fit: &SingFit) {
    song.section_marks = Some(fit.marks.clone());
    song.sing_order = Some(fit.order.clone());
    song.section_order = None;
}

// ───────────────────────── 谱面侧 ─────────────────────────

/// 谱面上一个音（按第一声部印的次序编号）
#[derive(Clone, Debug)]
struct Slot {
    mid: usize,
    id: Option<ElementId>,
    rest: bool,
    /// (词号, 这格的汉字)
    lyrics: Vec<(u32, Vec<char>)>,
    /// 谱面文字注记（`"^【Chorus】"`）
    word: Option<String>,
}

impl Slot {
    fn silent(&self) -> bool {
        self.lyrics.iter().all(|(_, cs)| cs.is_empty())
    }
}

/// 原子里一条词：(归一字, 原字, 第几个音) 逐字
type LineToks = Vec<(char, char, usize)>;

/// 回溯出的每步：(层, 状态, 到达这一状态的那一步)
type Steps = Vec<(usize, usize, Pred)>;

/// 一个原子：印的次序里一段连续的音 [s, e)
#[derive(Clone, Debug)]
struct Atom {
    s: usize,
    e: usize,
    /// 各条词：(词号, 逐字 (归一字, 原字, 第几个音))；整段没词的原子只有一条词号 0 的空串
    lines: Vec<(u32, LineToks)>,
    /// 是房（开头那小节带房号）
    ending: bool,
}

fn norm(c: char) -> char {
    simplified_of(c).unwrap_or(c)
}

const DOUBLE_BARS: [&str; 4] = ["light-light", "light-heavy", "heavy-light", "heavy-heavy"];

struct Score {
    slots: Vec<Slot>,
    /// 每小节第一个音的编号
    measure_start: Vec<usize>,
    atoms: Vec<Atom>,
    /// 谱面默认演唱顺序里出现的跳转（前一个音 → 后一个音，不是相邻的）
    edges: HashSet<(usize, usize)>,
    start: usize,
}

fn read_score(doc: &ScoreDoc, song_idx: usize) -> Option<Score> {
    // 默认演唱顺序要看谱面本身的反复与跳转：去掉已有的 `%%sing` / `P:` 再推
    let mut plain = doc.clone();
    {
        let s = plain.songs.get_mut(song_idx)?;
        s.sing_order = None;
        s.section_order = None;
    }
    let view = doc_view(&plain, None);
    let opts = PlaySongOptions { for_expanded: true };
    let sm = song_measures(&plain, &view, song_idx, opts, false).ok()??;
    let pd = play_data_of_song(&plain, &view, song_idx, opts).ok()??;
    let measures = sm.parts.first()?;
    let words: HashMap<ElementId, String> = doc.songs[song_idx]
        .parts
        .iter()
        .flat_map(|p| p.measures.iter())
        .flat_map(|m| m.elements.iter())
        .filter_map(|e| match e {
            Element::Chord(c) => c.section_word.clone().map(|w| (c.id, w)),
            _ => None,
        })
        .collect();

    let mut slots: Vec<Slot> = vec![];
    let mut measure_start = vec![];
    for (mid, m) in measures.iter().enumerate() {
        measure_start.push(slots.len());
        for ch in &m.entries {
            let mut lyrics: Vec<(u32, Vec<char>)> = vec![];
            for l in ch.notes.first().map_or(&[][..], |n| n.lyrics.as_slice()) {
                if l.number < 1.0 || l.number.fract() != 0.0 {
                    continue;
                }
                let cs: Vec<char> = l.text.chars().filter(|&c| is_hanzi(c)).collect();
                lyrics.push((l.number as u32, cs));
            }
            slots.push(Slot { mid, id: ch.id, rest: ch.rest, lyrics, word: ch.id.and_then(|id| words.get(&id).cloned()) });
        }
    }
    measure_start.push(slots.len());
    let n = slots.len();
    if n == 0 {
        return None;
    }
    let at = |mid: usize, idx: usize| -> Option<usize> {
        let s = *measure_start.get(mid)?;
        (s + idx < measure_start[mid + 1]).then_some(s + idx)
    };

    // 默认演唱顺序逐音走一遍，记下不相邻的转移
    let items: Vec<WalkItem> = pd.measures.iter().map(WalkItem::from).collect();
    let mut seq: Vec<usize> = vec![];
    for step in walk_play(&items, false) {
        let Step::Measure { mid, skip, limit, .. } = step else { continue };
        if mid < 0.0 {
            continue;
        }
        let mid = mid as usize;
        let Some(m) = measures.get(mid) else { continue };
        let to = if limit >= 0.0 { (limit as usize).min(m.entries.len()) } else { m.entries.len() };
        for idx in (skip.max(0.0) as usize)..to {
            if let Some(g) = at(mid, idx) {
                seq.push(g);
            }
        }
    }
    let mut edges = HashSet::new();
    for w in seq.windows(2) {
        if w[1] != w[0] + 1 {
            edges.insert((w[0], w[1]));
        }
    }
    let start = seq.first().copied().unwrap_or(0);
    // 谱面结构本身的转移也算顺路（推出的默认顺序遇到反复套跳转时会走不全）：`:|` 回到前面最近的 `|:`（没有就回到上一个 `:|` 之后、或曲首），
    // D.S. / D.C. 跳回记号处；房前一音 → 同一组里的各房在切好原子后补
    let last_of = |mid: usize| -> Option<usize> { (measure_start[mid + 1] > measure_start[mid]).then(|| measure_start[mid + 1] - 1) };
    for mid in 0..measures.len() {
        let m = &measures[mid];
        if m.repeat_backward {
            let back = (0..=mid).rev().find(|&k| measures[k].repeat_forward).or_else(|| (0..mid).rev().find(|&k| measures[k].repeat_backward).map(|k| k + 1)).unwrap_or(0);
            if let Some(x) = last_of(mid) {
                edges.insert((x, measure_start[back]));
            }
        }
    }
    let segno = sm.jumps.iter().find(|j| j.name == "hs").map(|j| j.measure);
    for j in &sm.jumps {
        let target = match j.name.as_str() {
            "ds" => segno,
            "dc" => Some(0),
            _ => None,
        };
        if let (Some(t), Some(x)) = (target, last_of(j.measure)) {
            edges.insert((x, measure_start[t]));
        }
    }

    // 切点：结构处、跳转两端、已有段落标记
    let mut cuts: HashSet<usize> = HashSet::from([0, n]);
    for mid in 1..measures.len() {
        let (m, p) = (&measures[mid], &measures[mid - 1]);
        let new_ending = m.ending_num.is_some() && (m.ending_left || m.ending_num != p.ending_num);
        if m.repeat_forward || new_ending || p.repeat_backward || p.ending_right.is_some() || p.barline.as_deref().is_some_and(|b| DOUBLE_BARS.contains(&b)) {
            cuts.insert(measure_start[mid]);
        }
    }
    for j in &sm.jumps {
        match j.name.as_str() {
            "hs" | "ty" => {
                cuts.insert(measure_start.get(j.measure).copied().unwrap_or(n));
            }
            _ => {
                cuts.insert(measure_start.get(j.measure + 1).copied().unwrap_or(n));
            }
        }
    }
    for &(a, b) in &edges {
        cuts.insert(a + 1);
        cuts.insert(b);
    }
    let by_id: HashMap<ElementId, usize> = slots.iter().enumerate().filter_map(|(g, s)| s.id.map(|id| (id, g))).collect();
    for m in doc.songs[song_idx].section_marks.iter().flatten() {
        if let Some(&g) = by_id.get(&m.before) {
            cuts.insert(g);
        }
    }
    let mut cuts: Vec<usize> = cuts.into_iter().filter(|&c| c <= n).collect();
    cuts.sort_unstable();
    let atoms = cuts
        .windows(2)
        .filter(|w| w[0] < w[1])
        .map(|w| {
            let mut a = atom_of(&slots, w[0], w[1]);
            a.ending = measures.get(slots[w[0]].mid).is_some_and(|m| m.ending_num.is_some());
            a
        })
        .collect::<Vec<Atom>>();
    // 相连的一串房是一组，组前那个原子的末音接到组里每一房
    let mut i = 0;
    while i < atoms.len() {
        if !atoms[i].ending || i == 0 {
            i += 1;
            continue;
        }
        let body_end = atoms[i - 1].e - 1;
        while i < atoms.len() && atoms[i].ending {
            if atoms[i].s != body_end + 1 {
                edges.insert((body_end, atoms[i].s));
            }
            i += 1;
        }
    }
    Some(Score { slots, measure_start, atoms, edges, start })
}

fn atom_of(slots: &[Slot], s: usize, e: usize) -> Atom {
    let mut by: Vec<(u32, LineToks)> = vec![];
    for (g, sl) in slots.iter().enumerate().take(e).skip(s) {
        for (num, cs) in &sl.lyrics {
            if cs.is_empty() {
                continue;
            }
            let i = match by.iter().position(|(k, _)| k == num) {
                Some(i) => i,
                None => {
                    by.push((*num, vec![]));
                    by.len() - 1
                }
            };
            by[i].1.extend(cs.iter().map(|&c| (norm(c), c, g)));
        }
    }
    by.sort_by_key(|(k, _)| *k);
    if by.is_empty() {
        by.push((0, vec![]));
    }
    Atom { s, e, lines: by, ending: false }
}

// ───────────────────────── 参照侧 ─────────────────────────

#[derive(Clone, Debug)]
struct RefTok {
    norm: char,
    ch: char,
    para: usize,
    line: usize,
}

// ───────────────────────── 动态规划 ─────────────────────────

/// 路上的一步（回溯用）
#[derive(Clone, Copy, Debug, PartialEq)]
enum Pred {
    None,
    Start,
    /// 跳过谱面一字（同一层，前一状态）
    SkipScore(u32),
    /// 原子末尾接到另一原子（同一层，前一状态是那个原子的末尾）
    Enter(u32),
    /// 本条词唱完、同一原子里接着唱另一条词还有字的地方（一段副歌只印一行词、每遍都唱它）
    Switch(u32),
    /// 配对（上一层）
    Match(u32),
    /// 跳过参照一字（上一层同一状态）
    SkipRef(u32),
}

/// 状态 = (原子, 第几条词, 词里第几个字)，压成一个下标
struct States {
    /// (原子, 词条) → 起始下标；该词条有 len+1 个状态
    base: Vec<Vec<usize>>,
    total: usize,
    /// 下标 → (原子, 词条, 位置)
    of: Vec<(usize, usize, usize)>,
}

impl States {
    fn new(atoms: &[Atom]) -> States {
        let mut base = vec![];
        let mut of = vec![];
        let mut total = 0;
        for (a, at) in atoms.iter().enumerate() {
            let mut b = vec![];
            for (k, (_, toks)) in at.lines.iter().enumerate() {
                b.push(total);
                for j in 0..=toks.len() {
                    of.push((a, k, j));
                }
                total += toks.len() + 1;
            }
            base.push(b);
        }
        States { base, total, of }
    }
    fn id(&self, a: usize, k: usize, j: usize) -> usize {
        self.base[a][k] + j
    }
}

struct Fit<'a> {
    sc: &'a Score,
    st: States,
    /// (原子, 词条, 位置) 起到原子末尾经过的无词音数
    silent_from: Vec<usize>,
    /// 原子 a 的末尾按谱面能接到哪些原子的开头
    next: Vec<Vec<usize>>,
}

impl<'a> Fit<'a> {
    fn new(sc: &'a Score) -> Fit<'a> {
        let st = States::new(&sc.atoms);
        let mut silent_from = vec![0; st.total];
        for (sid, &(a, k, j)) in st.of.iter().enumerate() {
            let at = &sc.atoms[a];
            let from = at.lines[k].1.get(j).map_or(if j == 0 { at.s } else { at.e }, |t| t.2);
            let from = if j == 0 { at.s } else { from };
            silent_from[sid] = (from..at.e).filter(|&g| sc.slots[g].silent()).count();
        }
        let first_of: HashMap<usize, usize> = sc.atoms.iter().enumerate().map(|(i, a)| (a.s, i)).collect();
        let next = sc
            .atoms
            .iter()
            .map(|a| {
                let mut v: Vec<usize> = vec![];
                if let Some(&b) = first_of.get(&a.e) {
                    v.push(b);
                }
                for &(x, y) in &sc.edges {
                    if x + 1 == a.e {
                        if let Some(&b) = first_of.get(&y) {
                            if !v.contains(&b) {
                                v.push(b);
                            }
                        }
                    }
                }
                v
            })
            .collect();
        Fit { sc, st, silent_from, next }
    }

    fn len(&self, a: usize, k: usize) -> usize {
        self.sc.atoms[a].lines[k].1.len()
    }

    /// 进入状态的代价（不含转移本身）：经过的无词音
    fn entry_cost(&self, sid: usize) -> f64 {
        SILENT * self.silent_from[sid] as f64
    }

    /// 同一层里不吃参照字的松弛：跳过谱面字、原子末尾转进别的原子。代价都为正，反复松弛到不动
    fn relax(&self, cost: &mut [f64], pred: &mut [Pred]) {
        let atoms = &self.sc.atoms;
        for _ in 0..64 {
            let mut changed = false;
            // 词条内往后跳字
            for (a, at) in atoms.iter().enumerate() {
                for k in 0..at.lines.len() {
                    for j in 0..self.len(a, k) {
                        let (x, y) = (self.st.id(a, k, j), self.st.id(a, k, j + 1));
                        let c = cost[x] + SKIP_SCORE;
                        if c < cost[y] {
                            cost[y] = c;
                            pred[y] = Pred::SkipScore(x as u32);
                            changed = true;
                        }
                    }
                }
            }
            // 一条词在原子里唱完了、后面还有音：接着唱别的词条在这之后的字，照谱面不罚
            for (a, at) in atoms.iter().enumerate() {
                for k in 0..at.lines.len() {
                    let n = self.len(a, k);
                    let x = self.st.id(a, k, n);
                    if cost[x] == INF {
                        continue;
                    }
                    let after = if n == 0 { at.s } else { at.lines[k].1[n - 1].2 + 1 };
                    for (k2, (_, toks)) in at.lines.iter().enumerate() {
                        if k2 == k {
                            continue;
                        }
                        let j2 = toks.partition_point(|t| t.2 < after);
                        if j2 == 0 || j2 >= toks.len() {
                            continue;
                        }
                        let y = self.st.id(a, k2, j2);
                        if cost[x] < cost[y] {
                            cost[y] = cost[x];
                            pred[y] = Pred::Switch(x as u32);
                            changed = true;
                        }
                    }
                }
            }
            // 原子末尾：最好的一个（不照谱面的跳转用它）与各原子按谱面接得上的
            let mut best_end = (INF, 0usize);
            let mut ends: Vec<(f64, usize)> = vec![(INF, 0); atoms.len()];
            for a in 0..atoms.len() {
                for k in 0..atoms[a].lines.len() {
                    let e = self.st.id(a, k, self.len(a, k));
                    if cost[e] < ends[a].0 {
                        ends[a] = (cost[e], e);
                    }
                }
                if ends[a].0 < best_end.0 {
                    best_end = ends[a];
                }
                // 半中间离开（后半没唱，如反复里只唱前一段就回头）：只给不照谱面的跳转用，与从中间进同罚
                for k in 0..atoms[a].lines.len() {
                    for j in 1..self.len(a, k) {
                        let x = self.st.id(a, k, j);
                        if cost[x] + MID_ENTRY < best_end.0 {
                            best_end = (cost[x] + MID_ENTRY, x);
                        }
                    }
                }
            }
            if best_end.0 == INF {
                if !changed {
                    break;
                }
                continue;
            }
            // 按谱面接得上的：a 的末尾 → b 的开头
            let mut by_default: Vec<(f64, usize)> = vec![(INF, 0); atoms.len()];
            for a in 0..atoms.len() {
                if ends[a].0 == INF {
                    continue;
                }
                for &b in &self.next[a] {
                    if ends[a].0 < by_default[b].0 {
                        by_default[b] = ends[a];
                    }
                }
            }
            for b in 0..atoms.len() {
                for k in 0..atoms[b].lines.len() {
                    for j in 0..=self.len(b, k) {
                        // 从中间接入只接在字上（弱起句头）；接在末尾没有意义
                        if j > 0 && j == self.len(b, k) {
                            continue;
                        }
                        let y = self.st.id(b, k, j);
                        let ec = self.entry_cost(y);
                        let (dc, dfrom) = by_default[b];
                        let mut cand = (INF, 0usize);
                        if j == 0 && dc < INF {
                            cand = (dc + ec, dfrom);
                        }
                        let jc = best_end.0 + JUMP + if j > 0 { MID_ENTRY } else { 0.0 } + if atoms[b].ending { ENDING_JUMP } else { 0.0 } + ec;
                        if jc < cand.0 {
                            cand = (jc, best_end.1);
                        }
                        if cand.0 < cost[y] && cand.1 != y {
                            cost[y] = cand.0;
                            pred[y] = Pred::Enter(cand.1 as u32);
                            changed = true;
                        }
                    }
                }
            }
            if !changed {
                break;
            }
        }
    }

    /// 整篇对齐，回溯出逐层的状态与每步
    fn run(&self, refs: &[RefTok]) -> Option<(f64, Steps)> {
        let n = self.st.total;
        let k = refs.len();
        let mut preds: Vec<Vec<Pred>> = Vec::with_capacity(k + 1);
        let mut cost = vec![INF; n];
        let mut pred = vec![Pred::None; n];
        // 起点：谱面开头不罚，别处当一次跳转
        let start_atom = self.sc.atoms.iter().position(|a| a.s <= self.sc.start && self.sc.start < a.e).unwrap_or(0);
        for (sid, &(a, kk, j)) in self.st.of.iter().enumerate() {
            if j > 0 && j == self.len(a, kk) {
                continue;
            }
            let c = if a == start_atom && j == 0 { 0.0 } else { JUMP + if j > 0 { MID_ENTRY } else { 0.0 } } + self.entry_cost(sid);
            if c < cost[sid] {
                cost[sid] = c;
                pred[sid] = Pred::Start;
            }
        }
        self.relax(&mut cost, &mut pred);
        preds.push(pred);
        for r in refs {
            let mut nc = vec![INF; n];
            let mut np = vec![Pred::None; n];
            for (sid, &(a, kk, j)) in self.st.of.iter().enumerate() {
                let c = cost[sid];
                if c == INF {
                    continue;
                }
                // 跳过参照字
                if c + SKIP_REF < nc[sid] {
                    nc[sid] = c + SKIP_REF;
                    np[sid] = Pred::SkipRef(sid as u32);
                }
                // 配对
                if j < self.len(a, kk) {
                    let t = self.sc.atoms[a].lines[kk].1[j];
                    let y = sid + 1;
                    let cc = c + if t.0 == r.norm { 0.0 } else { SUB };
                    if cc < nc[y] {
                        nc[y] = cc;
                        np[y] = Pred::Match(sid as u32);
                    }
                }
            }
            self.relax(&mut nc, &mut np);
            cost = nc;
            preds.push(np);
        }
        // 终点：某原子某词条唱到末尾
        let mut best = (INF, 0usize);
        for (sid, &(a, kk, j)) in self.st.of.iter().enumerate() {
            if j == self.len(a, kk) && cost[sid] < best.0 {
                best = (cost[sid], sid);
            }
        }
        if best.0 == INF {
            return None;
        }
        // 回溯：(层, 状态, 到达这一状态的那一步)
        let mut out = vec![];
        let (mut layer, mut sid) = (k, best.1);
        loop {
            let p = preds[layer][sid];
            out.push((layer, sid, p));
            match p {
                Pred::Start | Pred::None => break,
                Pred::SkipScore(x) | Pred::Enter(x) | Pred::Switch(x) => sid = x as usize,
                Pred::Match(x) | Pred::SkipRef(x) => {
                    sid = x as usize;
                    layer -= 1;
                }
            }
        }
        out.reverse();
        Some((best.0, out))
    }
}

// ───────────────────────── 走出来的路 ─────────────────────────

/// 路上进一次原子：[s, e) 这几个音，配第几条词（0 = 无词）
#[derive(Clone, Debug)]
struct Visit {
    s: usize,
    e: usize,
    line: u32,
    /// 这一次唱到的参照字下标（按先后）与它落在的音
    toks: Vec<(usize, usize)>,
}

/// 生成。`rows_of`：试排一份演唱顺序、回这一首每遍占几行（投影档；拿不到排版时给 None，按角色分遍）。
pub fn fit_sing(doc: &ScoreDoc, song_idx: usize, ref_text: &str, rows_of: &dyn Fn(&ScoreDoc) -> Option<Vec<usize>>) -> SingFit {
    let no_match = |ref_chars: usize| SingFit { marks: vec![], order: vec![], notes: vec![FitNote::new(FitKind::NoMatch)], ref_chars, matched: 0 };
    let lines = ref_lines(ref_text);
    let mut refs: Vec<RefTok> = vec![];
    for (li, l) in lines.iter().enumerate() {
        for c in l.text.chars().filter(|&c| is_hanzi(c)) {
            refs.push(RefTok { norm: norm(c), ch: c, para: l.para, line: li });
        }
    }
    let Some(sc) = read_score(doc, song_idx) else { return no_match(refs.len()) };
    if refs.is_empty() || sc.atoms.iter().all(|a| a.lines.iter().all(|(_, t)| t.is_empty())) {
        return no_match(refs.len());
    }
    let fit = Fit::new(&sc);
    let Some((_, steps)) = fit.run(&refs) else { return no_match(refs.len()) };

    // ── 回溯出的每步 → 进出原子、逐字配对与报告
    let bar = |g: usize| sc.slots.get(g.min(sc.slots.len() - 1)).map(|s| s.mid + 1);
    let mut visits: Vec<Visit> = vec![];
    let mut notes: Vec<FitNote> = vec![];
    let mut matched = 0usize;
    // 参照多出的字、谱面多出的字按连续一串报
    let mut ref_run: Vec<usize> = vec![];
    let mut score_run: Vec<usize> = vec![];
    let flush_ref = |run: &mut Vec<usize>, notes: &mut Vec<FitNote>, at: Option<usize>| {
        if run.is_empty() {
            return;
        }
        let mut n = FitNote::new(FitKind::RefExtra);
        n.ref_ = Some(run.iter().map(|&i| refs[i].ch).collect());
        n.context = Some(lines[refs[run[0]].line].text.clone());
        n.bar = at;
        notes.push(n);
        run.clear();
    };
    let flush_score = |run: &mut Vec<usize>, notes: &mut Vec<FitNote>| {
        if run.is_empty() {
            return;
        }
        let mut n = FitNote::new(FitKind::ScoreExtra);
        n.score = Some(run.iter().map(|&g| sc.slots[g].lyrics.iter().flat_map(|(_, c)| c.first()).next().copied().unwrap_or(' ')).collect());
        n.bar = bar(run[0]);
        notes.push(n);
        run.clear();
    };
    // 进原子：从开头进；从中间（弱起句头）或不照谱面跳进来的，从第一个字退过休止、切在小节线上（不带上前面整小节的间奏休止）
    let enter = |visits: &mut Vec<Visit>, sid: usize, jumped: bool| {
        let (a, k, j) = fit.st.of[sid];
        let at = &sc.atoms[a];
        let s = match at.lines[k].1.get(j) {
            Some(t) if j > 0 || jumped => cut_before(&sc, t.2, at.s),
            _ => at.s,
        };
        visits.push(Visit { s, e: at.e, line: at.lines[k].0, toks: vec![] });
    };
    let mut prev_end: Option<usize> = None;
    for &(layer, sid, p) in &steps {
        match p {
            Pred::Start => {
                let start_atom = sc.atoms.iter().position(|a| a.s <= sc.start && sc.start < a.e);
                enter(&mut visits, sid, start_atom != Some(fit.st.of[sid].0));
            }
            Pred::Enter(from) => {
                let (fa, fk, fj) = fit.st.of[from as usize];
                // 从半中间离开：上一次进的原子唱到第 fj 个字前为止
                if let Some(&t) = sc.atoms[fa].lines[fk].1.get(fj) {
                    if let Some(v) = visits.last_mut() {
                        v.e = cut_before(&sc, t.2, v.s).max(v.s);
                    }
                }
                let exit_mid = fj < fit.len(fa, fk);
                let (b, _, j) = fit.st.of[sid];
                let default = !exit_mid && j == 0 && fit.next[fa].contains(&b);
                enter(&mut visits, sid, !default);
                if !default {
                    let mut n = FitNote::new(FitKind::OffScore);
                    n.from_bar = bar(if exit_mid { visits[visits.len() - 2].e } else { sc.atoms[fa].e }.saturating_sub(1));
                    n.bar = bar(visits.last().unwrap().s);
                    n.context = refs.get(layer).map(|r| lines[r.line].text.clone());
                    notes.push(n);
                }
                prev_end = None;
            }
            Pred::Switch(_) => {
                let (a, k, j) = fit.st.of[sid];
                let at = &sc.atoms[a];
                let mut s = at.s;
                if let Some(v) = visits.last_mut() {
                    s = cut_before(&sc, at.lines[k].1[j].2, v.s);
                    v.e = s;
                }
                visits.push(Visit { s, e: at.e, line: at.lines[k].0, toks: vec![] });
                prev_end = None;
            }
            Pred::SkipScore(from) => {
                let (a, k, j) = fit.st.of[from as usize];
                score_run.push(sc.atoms[a].lines[k].1[j].2);
                flush_ref(&mut ref_run, &mut notes, prev_end.and_then(bar));
            }
            Pred::SkipRef(_) => {
                ref_run.push(layer - 1);
                flush_score(&mut score_run, &mut notes);
            }
            Pred::Match(from) => {
                let (a, k, j) = fit.st.of[from as usize];
                let t = sc.atoms[a].lines[k].1[j];
                let i = layer - 1;
                flush_ref(&mut ref_run, &mut notes, bar(t.2));
                flush_score(&mut score_run, &mut notes);
                if t.0 == refs[i].norm {
                    matched += 1;
                } else {
                    let mut n = FitNote::new(FitKind::Mismatch);
                    n.ref_ = Some(refs[i].ch.to_string());
                    n.score = Some(t.1.to_string());
                    n.bar = bar(t.2);
                    n.context = Some(lines[refs[i].line].text.clone());
                    notes.push(n);
                }
                if let Some(v) = visits.last_mut() {
                    v.toks.push((i, t.2));
                }
                prev_end = Some(t.2);
            }
            Pred::None => {}
        }
    }
    flush_ref(&mut ref_run, &mut notes, prev_end.and_then(bar));
    flush_score(&mut score_run, &mut notes);
    // 一半以上的字都没对上：认为不是这首的词
    if matched * 2 < refs.len() {
        let mut f = no_match(refs.len());
        f.matched = matched;
        return f;
    }

    // ── 按参照段界切开
    let visits = split_at_paragraphs(&sc, &refs, visits);

    // ── 所有切点 → 谱面上的小段（piece），路 = 小段 × 词号
    let mut bounds: Vec<usize> = sc.atoms.iter().flat_map(|a| [a.s, a.e]).chain(visits.iter().flat_map(|v| [v.s, v.e])).collect();
    bounds.sort_unstable();
    bounds.dedup();
    let piece_of = |g: usize| bounds.partition_point(|&b| b <= g) - 1;
    let npieces = bounds.len() - 1;
    // 路上逐项：小段、词号（无词 0）、这一项唱到的参照字的首末段号
    struct Step {
        piece: usize,
        line: u32,
        first: Option<usize>,
        last: Option<usize>,
    }
    let mut path: Vec<Step> = vec![];
    for v in &visits {
        let (p0, p1) = (piece_of(v.s), piece_of(v.e - 1));
        for p in p0..=p1 {
            let has = (bounds[p]..bounds[p + 1]).any(|g| sc.slots[g].lyrics.iter().any(|(k, c)| *k == v.line && !c.is_empty()));
            let paras: Vec<usize> = v.toks.iter().filter(|&&(_, g)| bounds[p] <= g && g < bounds[p + 1]).map(|&(i, _)| refs[i].para).collect();
            path.push(Step { piece: p, line: if has { v.line } else { 0 }, first: paras.first().copied(), last: paras.last().copied() });
        }
    }

    // ── 并段：p 与 p+1 在路上总是前后紧挨、配同一条词（无词的随旁边）就并
    let mut follows: Vec<Option<Option<usize>>> = vec![None; npieces];
    let mut precedes: Vec<Option<Option<usize>>> = vec![None; npieces];
    let mut used = vec![false; npieces];
    for w in 0..path.len() {
        let p = path[w].piece;
        used[p] = true;
        let nx = path.get(w + 1).filter(|x| x.piece == p + 1 && compatible(path[w].line, x.line)).map(|x| x.piece);
        follows[p] = Some(match follows[p] {
            None => nx,
            Some(prev) if prev == nx => nx,
            _ => None,
        });
        let pv = if w > 0 { Some(&path[w - 1]).filter(|x| x.piece + 1 == p && compatible(x.line, path[w].line)).map(|x| x.piece) } else { None };
        precedes[p] = Some(match precedes[p] {
            None => pv,
            Some(prev) if prev == pv => pv,
            _ => None,
        });
    }
    // 段 = 连续的小段；没唱到的相邻小段也并成一段
    let mut section_of = vec![0usize; npieces];
    let mut sec = 0usize;
    for p in 0..npieces {
        if p > 0 {
            let both_unused = !used[p - 1] && !used[p];
            let glued = used[p - 1] && used[p] && follows[p - 1] == Some(Some(p)) && precedes[p] == Some(Some(p - 1));
            if !(both_unused || glued) {
                sec += 1;
            }
        }
        section_of[p] = sec;
    }
    let nsec = sec + 1;

    // ── 路上的项：同段相连的并成一项
    struct Item {
        sec: usize,
        line: u32,
        first: Option<usize>,
        last: Option<usize>,
    }
    let mut items: Vec<Item> = vec![];
    for (w, st) in path.iter().enumerate() {
        let s = section_of[st.piece];
        let cont = w > 0 && path[w - 1].piece + 1 == st.piece && section_of[path[w - 1].piece] == s;
        match items.last_mut() {
            Some(it) if cont && it.sec == s => {
                if it.line == 0 {
                    it.line = st.line;
                }
                it.first = it.first.or(st.first);
                it.last = st.last.or(it.last);
            }
            _ => items.push(Item { sec: s, line: st.line, first: st.first, last: st.last }),
        }
    }

    // ── 分组：项的交界正是参照段界的地方另起一组（组内接着唱、组间 `/` 换行）；没词的项随后面那组
    let mut groups: Vec<Vec<usize>> = vec![];
    let mut pending: Vec<usize> = vec![];
    let mut cur_last: Option<usize> = None;
    for (i, it) in items.iter().enumerate() {
        if it.first.is_none() {
            pending.push(i);
            continue;
        }
        let new_group = groups.is_empty() || cur_last.is_some_and(|l| Some(l) != it.first);
        if new_group {
            groups.push(std::mem::take(&mut pending));
        } else {
            groups.last_mut().unwrap().append(&mut pending);
        }
        groups.last_mut().unwrap().push(i);
        cur_last = it.last;
    }
    match groups.last_mut() {
        Some(g) => g.append(&mut pending),
        None if !pending.is_empty() => groups.push(pending),
        None => {}
    }

    // ── 角色：先定各组的角色，再给谱面上的段起名
    let sig_of = |g: &[usize]| -> Vec<(usize, u32)> { g.iter().map(|&i| (items[i].sec, items[i].line)).collect() };
    let paras_of = |g: &[usize]| -> Vec<usize> { g.iter().flat_map(|&i| [items[i].first, items[i].last]).flatten().collect() };
    let is_chorus_word = |s: &str| {
        let s = s.to_lowercase();
        s.contains("chorus") || s.contains("refrain") || s.contains("副歌") || s == "副" || s == "合" || s == "和"
    };
    // 谱面上的副歌标注只认段开头那一小节里的；「接 Chorus」这类跳转提示不算
    let sec_starts_chorus = |sec: usize| -> bool {
        let Some(p) = (0..npieces).find(|&p| section_of[p] == sec) else { return false };
        let g0 = bounds[p];
        let mid = sc.slots[g0].mid;
        (g0..sc.measure_start[mid + 1].min(bounds[p + 1])).any(|g| sc.slots[g].word.as_deref().is_some_and(|w| is_chorus_word(w) && !w.contains('接') && !w.to_lowercase().contains("to ")))
    };
    let mut chorus_sigs: Vec<Vec<(usize, u32)>> = vec![];
    for g in &groups {
        let sig = sig_of(g);
        let labelled = paras_of(g).iter().any(|&pa| lines.iter().find(|l| l.para == pa).and_then(|l| l.label.as_deref()).is_some_and(is_chorus_word));
        let marked = g.iter().find(|&&i| items[i].first.is_some()).is_some_and(|&i| sec_starts_chorus(items[i].sec));
        if (labelled || marked) && !chorus_sigs.contains(&sig) {
            chorus_sigs.push(sig);
        }
    }
    if chorus_sigs.is_empty() {
        // 没有标注：同词同谱唱得最多（至少两遍）的那组，同票取最早的
        let mut best: Option<(usize, Vec<(usize, u32)>)> = None;
        for g in &groups {
            let sig = sig_of(g);
            let n = groups.iter().filter(|h| sig_of(h) == sig).count();
            if n >= 2 && best.as_ref().is_none_or(|b| n > b.0) {
                best = Some((n, sig));
            }
        }
        chorus_sigs.extend(best.map(|b| b.1));
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Role {
        V,
        C,
        B,
    }
    let mut roles: Vec<Role> = vec![];
    let mut seen_chorus = false;
    let mut verse_secs: HashSet<usize> = HashSet::new();
    for g in &groups {
        let sig = sig_of(g);
        let role = if chorus_sigs.contains(&sig) {
            seen_chorus = true;
            Role::C
        } else if !seen_chorus || sig.iter().any(|(s, _)| verse_secs.contains(s)) {
            Role::V
        } else {
            Role::B
        };
        if role == Role::V {
            verse_secs.extend(sig.iter().map(|(s, _)| *s));
        }
        roles.push(role);
    }
    // 段名：段的角色取第一次唱它的那组的角色；同角色按谱面先后 V、V2…；没唱到的 X
    let mut sec_role: Vec<Option<Role>> = vec![None; nsec];
    for (g, r) in groups.iter().zip(&roles) {
        for &i in g {
            sec_role[items[i].sec].get_or_insert(*r);
        }
    }
    // 标得上记号的段（段首那块有音）；标不上的段不占编号
    let mut markable = vec![false; nsec];
    {
        let mut last = usize::MAX;
        for p in 0..npieces {
            if section_of[p] != last {
                last = section_of[p];
                markable[last] |= (bounds[p]..bounds[p + 1]).any(|g| sc.slots[g].id.is_some());
            }
        }
    }
    let mut counts: HashMap<&str, usize> = HashMap::new();
    let names: Vec<String> = (0..nsec)
        .map(|s| {
            if !markable[s] {
                return format!("_{s}");
            }
            let base = match sec_role[s] {
                Some(Role::V) => "V",
                Some(Role::C) => "C",
                Some(Role::B) => "B",
                None => "X",
            };
            let n = counts.entry(base).or_insert(0);
            *n += 1;
            if *n == 1 {
                base.to_string()
            } else {
                format!("{base}{n}")
            }
        })
        .collect();

    // ── 段落标记：每段第一个音前
    let mut marks: Vec<SectionMark> = vec![];
    let mut last_sec = usize::MAX;
    for p in 0..npieces {
        let s = section_of[p];
        if s == last_sec {
            continue;
        }
        last_sec = s;
        if let Some(id) = (bounds[p]..bounds[p + 1]).find_map(|g| sc.slots[g].id) {
            marks.push(SectionMark { name: names[s].clone(), before: id });
        }
    }

    // ── 分遍：一组为单位，按投影行数密排，副歌唱完优先换页
    let sing_groups: Vec<Vec<SingItem>> = groups
        .iter()
        .map(|g| {
            g.iter()
                .map(|&i| {
                    let it = &items[i];
                    let verse = (it.line > 1 || (it.line == 1 && multi_line(&sc, &bounds, &section_of, it.sec))).then_some(it.line as f64);
                    SingItem { section: names[it.sec].clone(), verse, line_after: None }
                })
                .collect()
        })
        .collect();
    let trial = |order: Vec<SingPass>| -> Option<Vec<usize>> {
        let mut d = doc.clone();
        let s = &mut d.songs[song_idx];
        s.section_marks = Some(marks.clone());
        s.sing_order = Some(order);
        s.section_order = None;
        rows_of(&d)
    };
    let rows: Option<Vec<usize>> = trial(sing_groups.iter().map(|g| SingPass { items: g.clone(), rows: Some(99.0) }).collect()).filter(|r| r.len() == sing_groups.len());
    let order = paginate(&sing_groups, &roles.iter().map(|r| *r == Role::C).collect::<Vec<_>>(), rows.as_deref(), DEFAULT_ROWS);

    SingFit { marks, order, notes, ref_chars: refs.len(), matched }
}

/// 两项的词号能否接成一段（无词的随旁边）
fn compatible(a: u32, b: u32) -> bool {
    a == 0 || b == 0 || a == b
}

/// 这一段里有没有不止一条词（只有一条时 `@1` 省掉）
fn multi_line(sc: &Score, bounds: &[usize], section_of: &[usize], sec: usize) -> bool {
    let mut nums: HashSet<u32> = HashSet::new();
    for p in 0..section_of.len() {
        if section_of[p] != sec {
            continue;
        }
        for sl in &sc.slots[bounds[p]..bounds[p + 1]] {
            nums.extend(sl.lyrics.iter().filter(|(_, c)| !c.is_empty()).map(|(k, _)| *k));
        }
    }
    nums.len() > 1
}

/// 参照新的一段从哪个音起：段首字落在的音往前退过休止（不退过上一段末字），退到的那串休止里有小节线就切在最后一条小节线上
fn cut_before(sc: &Score, first: usize, floor: usize) -> usize {
    let mut c = first;
    while c > floor && sc.slots[c - 1].rest {
        c -= 1;
    }
    (c..=first).rev().find(|&g| sc.measure_start.binary_search(&g).is_ok()).unwrap_or(c)
}

/// 在参照段界处把进原子的那一次切开
fn split_at_paragraphs(sc: &Score, refs: &[RefTok], visits: Vec<Visit>) -> Vec<Visit> {
    let mut out: Vec<Visit> = vec![];
    for v in visits {
        let mut cur = Visit { s: v.s, e: v.e, line: v.line, toks: vec![] };
        let mut last_g: Option<usize> = None;
        for &(i, g) in &v.toks {
            let new_para = cur.toks.last().is_some_and(|&(pi, _)| refs[pi].para != refs[i].para);
            if new_para {
                let floor = last_g.map_or(cur.s, |x| x + 1);
                let c = cut_before(sc, g, floor).max(floor);
                if c > cur.s && c < cur.e {
                    let rest = Visit { s: c, e: cur.e, line: cur.line, toks: vec![] };
                    cur.e = c;
                    out.push(std::mem::replace(&mut cur, rest));
                }
            }
            cur.toks.push((i, g));
            last_g = Some(g);
        }
        out.push(cur);
    }
    out
}

/// 分遍。`rows`：每段参照单独一遍时占几行（拿不到时每个角色单位一遍）。段与段之间 `/` 换行。
fn paginate(groups: &[Vec<SingItem>], chorus: &[bool], rows: Option<&[usize]>, max_rows: usize) -> Vec<SingPass> {
    let mut passes: Vec<Vec<usize>> = vec![];
    let mut used = 0usize;
    for g in 0..groups.len() {
        let start_new = match (passes.last(), rows) {
            (None, _) => true,
            (Some(cur), Some(rows)) => {
                let need = rows[g];
                let last = *cur.last().unwrap();
                if used + need > max_rows {
                    true
                } else if chorus[last] && !chorus[g] {
                    // 副歌唱完：下一个角色单位整个装得进本页才接着排
                    let unit: usize = (g..groups.len()).take_while(|&x| chorus[x] == chorus[g]).map(|x| rows[x]).sum();
                    used + unit > max_rows
                } else {
                    false
                }
            }
            // 没有排版：副歌唱完就换遍
            (Some(cur), None) => chorus[*cur.last().unwrap()] && !chorus[g],
        };
        if start_new {
            passes.push(vec![g]);
            used = rows.map_or(0, |r| r[g]);
        } else {
            passes.last_mut().unwrap().push(g);
            used += rows.map_or(0, |r| r[g]);
        }
    }
    passes
        .into_iter()
        .map(|gs| {
            let mut items: Vec<SingItem> = vec![];
            for (n, &g) in gs.iter().enumerate() {
                let mut its = groups[g].clone();
                if n + 1 < gs.len() {
                    if let Some(last) = its.last_mut() {
                        last.line_after = Some(true);
                    }
                }
                items.extend(its);
            }
            SingPass { items, rows: None }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use dolce_formats::abc::emit::emit_123;
    use dolce_formats::abc::parse::parse_123;

    /// 一段主歌（两段词）+ 副歌（一条词），整首 `|: :|`
    const SONG: &str = "X:1\nT:例\nK:1=C\nM:4/4\n|: 1 2 3 4 | 5 6 5 - | 3 3 2 2 | 1 - - - |\nw:甲 乙 丙 丁 戊 己 庚 辛 壬 癸 子 丑\nw:天 地 玄 黄 宇 宙 洪 荒 日 月 盈 昃\n\"^副歌\"5 5 6 6 | 5 6 3 - | 2 2 3 2 | 1 - - - :|\nw:春 夏 秋 冬 东 南 西 北 金 木 水 火\n";

    fn fit(lyrics: &str) -> (SingFit, String) {
        let mut doc = parse_123(SONG);
        let f = fit_sing(&doc, 0, lyrics, &|_| None);
        if !f.order.is_empty() {
            apply_sing_fit(&mut doc.songs[0], &f);
        }
        (f, emit_123(&doc))
    }

    #[test]
    fn follows_score_when_lyrics_agree() {
        let (f, text) = fit("甲乙丙丁\n戊己庚辛\n壬癸子丑\n\n春夏秋冬\n东南西北金木水火\n\n天地玄黄\n宇宙洪荒日月盈昃\n\n春夏秋冬东南西北金木水火");
        assert_eq!(f.matched, f.ref_chars);
        assert!(f.notes.iter().all(|n| n.kind != FitKind::OffScore), "{:?}", f.notes);
        assert_eq!(f.sing_text(), "%%sing V / C\n%%sing V@2 / C");
        assert!(text.contains("[P:V]") && text.contains("[P:C]"), "{text}");
    }

    #[test]
    fn lyrics_order_wins_and_is_reported() {
        // 两段主歌连着唱、副歌只唱一遍：与谱面反复对不上，照歌词排
        let (f, _) = fit("甲乙丙丁戊己庚辛壬癸子丑\n\n天地玄黄宇宙洪荒日月盈昃\n\n春夏秋冬东南西北金木水火");
        assert_eq!(f.matched, f.ref_chars);
        assert!(f.notes.iter().any(|n| n.kind == FitKind::OffScore), "{:?}", f.notes);
        let items: Vec<String> = f.order.iter().flat_map(|p| p.items.iter().map(|i| format!("{}@{}", i.section, i.verse.unwrap_or(1.0)))).collect();
        assert_eq!(items, vec!["V@1", "V@2", "C@1"]);
    }

    #[test]
    fn reports_differences() {
        let (f, _) = fit("甲乙丙丁戊己庚辛壬癸子\n\n春夏秋冬东南西北金木水火\n\n天地玄黄宇宙洪荒日月盈昃\n\n春夏秋冬东南西北金木水土");
        assert!(f.notes.iter().any(|n| n.kind == FitKind::ScoreExtra && n.score.as_deref() == Some("丑")), "{:?}", f.notes);
        assert!(f.notes.iter().any(|n| n.kind == FitKind::Mismatch && n.score.as_deref() == Some("火") && n.ref_.as_deref() == Some("土")), "{:?}", f.notes);
    }

    #[test]
    fn unrelated_lyrics_give_nothing() {
        let (f, _) = fit("完全不相干的一段文字\n再来一行");
        assert!(f.order.is_empty());
        assert_eq!(f.notes.first().map(|n| n.kind), Some(FitKind::NoMatch));
    }

    #[test]
    fn paginate_prefers_break_after_chorus() {
        let g = |n: &str| vec![SingItem { section: n.into(), verse: None, line_after: None }];
        let groups = vec![g("V"), g("C"), g("V2"), g("C")];
        // 主歌 2 行、副歌 1 行，一页 4 行：V+C 3 行后，下一段主歌 2 行装不下 → 副歌后换页
        let order = paginate(&groups, &[false, true, false, true], Some(&[2, 1, 2, 1]), 4);
        let names: Vec<Vec<&str>> = order.iter().map(|p| p.items.iter().map(|i| i.section.as_str()).collect()).collect();
        assert_eq!(names, vec![vec!["V", "C"], vec!["V2", "C"]]);
        assert_eq!(order[0].items[0].line_after, Some(true));
    }
}
