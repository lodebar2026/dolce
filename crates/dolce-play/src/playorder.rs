//! 演唱顺序（TS `score/playorder.ts` 照搬）：反复、房号、D.C./D.S./Coda、多段歌词逐段一遍，推成 [`PlayItem`] 序列；
//! 另有按头部 `P:` 排（[`section_play_order`]）、按逐遍演唱顺序排（123 `%%sing`，[`sing_play_order`]）、
//! 照 `.Repeat` 排（[`play_order_from_spec`]）与按段数整曲逐遍（[`play_order_by_verses`]）。
//!
//! 判据从 mp/score 移植。只经下面这组输入形状读谱，`ScoreDoc` 两侧在 TS 拼：MusicXML 形状 `model/playdoc.ts`、
//! 简谱形状 `jianpu/playsong.ts`。产物的消费者：试听/MIDI（[`crate::timeline`]）、投影档（`jianpu/expand.ts::walkPlay`）、断句。
//!
//! 小节下标、遍号一律用 f64：TS 里跳转落点可能是 `parseInt(名字) - 1`（NaN），NaN 一路传到取小节时才抛错——
//! 这里同样到取小节时回 `Err`，中间的比较照 JS 的 NaN 口径。

use dolce_base::{js, Fraction};
use serde::{Deserialize, Serialize};

use crate::{err, PlayResult};

// ───────────────────────── 输入形状 ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PlayLyric {
    pub number: f64,
    /// 字面（行首可能带印刷段号「1.2.」，见 `label_passes`）
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PlayNote {
    pub tie_start: bool,
    pub tie_end: bool,
    pub lyrics: Vec<PlayLyric>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PlayChord {
    pub notes: Vec<PlayNote>,
    /// 小节内位置（四分音符为 1）
    pub position: Fraction,
    pub slur_start: bool,
    pub slur_ends: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PlayMeasure {
    /// 小节里的和弦（TS 只取 `isPlayChord` 的那些，次序不变）
    pub chords: Vec<PlayChord>,
    /// 小节时值（末和弦的位置 + 时值）。None = 没有和弦（TS 取它会抛错）
    #[serde(default)]
    pub duration: Option<Fraction>,
    pub repeat_backward: bool,
    pub repeat_forward: bool,
    pub ending_left: bool,
    /// 房号；None = TS 的 null
    #[serde(default)]
    pub ending_num: Option<Vec<f64>>,
    /// "start" / "stop" / "discontinue"；None = TS 的 null
    #[serde(default)]
    pub ending_right: Option<String>,
    /// 小节右边的小节线样式（MusicXML token；没写 = 普通细线）
    #[serde(default)]
    pub barline: Option<String>,
}

impl PlayMeasure {
    fn duration(&self) -> PlayResult<Fraction> {
        match self.duration {
            Some(d) => Ok(d),
            None => err("measure has no chord"),
        }
    }
    fn has_ending(&self, n: f64) -> bool {
        self.ending_num.as_ref().is_some_and(|v| v.contains(&n))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PlayPart {
    /// 按各声部共用的时间轴排：这一声部在某格没有小节就是 None。`parts[0]` 读反复、房号、小节线，须每格都有
    pub measures: Vec<Option<PlayMeasure>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TimePosition {
    pub mid: f64,
    pub offset: Fraction,
}

impl TimePosition {
    pub fn new(mid: f64, offset: Fraction) -> PlayResult<TimePosition> {
        if mid < 0.0 {
            return err("TimePosition: mid < 0");
        }
        Ok(TimePosition { mid, offset })
    }
    fn compare_to(&self, a: &TimePosition) -> f64 {
        let diff = self.mid - a.mid;
        if diff != 0.0 {
            return diff;
        }
        self.offset.minus(&a.offset).compare_to(&Fraction::int(0.0)) as f64
    }
}

/// TS `PlaySpecKind`（数值同 TS 枚举）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(try_from = "u8", into = "u8")]
pub enum PlaySpecKind {
    Dacapo,
    DalSegno,
    ToCoda,
    Fine,
}

impl TryFrom<u8> for PlaySpecKind {
    type Error = String;
    fn try_from(v: u8) -> Result<Self, String> {
        Ok(match v {
            0 => PlaySpecKind::Dacapo,
            1 => PlaySpecKind::DalSegno,
            2 => PlaySpecKind::ToCoda,
            3 => PlaySpecKind::Fine,
            _ => return Err(format!("PlaySpecKind {v}")),
        })
    }
}

impl From<PlaySpecKind> for u8 {
    fn from(k: PlaySpecKind) -> u8 {
        k as u8
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct JumpSpec {
    pub kind: PlaySpecKind,
    /// D.S. / To Coda 的落点名（TS `value`）
    #[serde(default)]
    pub value: Option<String>,
}

/// 跳转记号与其落点。各表的**插入次序**有意义（同一小节几个记号按它先后判），名字不重复（TS 是 `Map`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PlayJumps {
    pub coda: Vec<(String, TimePosition)>,
    pub segno: Vec<(String, TimePosition)>,
    pub jump_to: Vec<(TimePosition, JumpSpec)>,
}

fn lookup<'a>(map: &'a [(String, TimePosition)], key: Option<&str>) -> Option<&'a TimePosition> {
    let key = key?;
    map.iter().find(|(k, _)| k == key).map(|(_, t)| t)
}

/// 曲内段落标记：从第 `mid` 小节第 `skip` 个和弦起（`skip` 大于 0 = 写在小节中间）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct SectionMark {
    pub name: String,
    pub mid: f64,
    pub skip: f64,
}

/// 逐遍演唱顺序的一遍（`model/doc.ts::SingPass`）：段落名、配第几行词（版面在 `%%layout`，不在这里）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct SingPassSpec {
    pub items: Vec<SingItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct SingItem {
    pub section: String,
    #[serde(default)]
    pub verse: Option<f64>,
}

/// `.Repeat` 的一条（TS `RepeatSpecItem`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RepeatSpecItem {
    pub first: f64,
    pub last: f64,
    pub verse: f64,
    /// 首小节跳过的和弦个数
    pub skip: f64,
    /// 段末换页
    pub page: bool,
    /// 末小节只取前 n 个和弦（-1 = 整节）
    pub limit: f64,
}

// ───────────────────────── 产物 ─────────────────────────

/// 演唱顺序的一项：第 `pass` 遍唱 `[mid, end)` 这几小节。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PlayItem {
    pub mid: f64,
    pub pass: f64,
    pub offset: Fraction,
    pub end: f64,
    pub end_of_pass: bool,
    /// 首小节要跳过的和弦个数（弱起式接入）
    pub skip: f64,
    /// 末小节只取前这么多个和弦（-1 = 整节）
    pub limit: f64,
    /// 从这一小节起接在前面同一行末尾、不另起一行（-1 = 不接）
    pub glue_from: f64,
    /// 按 `P:` 排的：这一项所在段落的小节（[`PlayOrder::scopes`] 的下标；同一段落的项共用一份）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<usize>,
    /// 按 `P:` 排的：这一项是进入一个段落
    #[serde(default, skip_serializing_if = "is_false")]
    pub section_entry: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl Default for PlayItem {
    fn default() -> Self {
        PlayItem {
            mid: 0.0,
            pass: 0.0,
            offset: Fraction::int(0.0),
            end: 0.0,
            end_of_pass: false,
            skip: 0.0,
            limit: -1.0,
            glue_from: -1.0,
            scope: None,
            section_entry: false,
        }
    }
}

impl PlayItem {
    fn span(mid: f64, end: f64, pass: f64) -> PlayItem {
        PlayItem { mid, end, pass, ..PlayItem::default() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PlayOrder {
    pub measures: Vec<PlayItem>,
    /// 没有反复、只是多段歌词逐段一遍
    pub is_simple: bool,
    /// 谱面有 `:|`
    pub has_repeat: bool,
    /// 第一处封口却没写 `:|`、紧跟着下一房的房（小节下标），按反复回头唱；没有为 -1
    pub implied_repeat: f64,
    /// `PlayItem::scope` 指的段落小节表（按 `P:` 排时才有）
    #[serde(default)]
    pub scopes: Vec<Vec<f64>>,
}

// ───────────────────────── 小工具 ─────────────────────────

/// JS 的 `arr[i]`：i 不是落在范围里的整数就取不到。
fn at<T>(v: &[T], i: f64) -> Option<&T> {
    if i >= 0.0 && i.fract() == 0.0 && i < v.len() as f64 {
        v.get(i as usize)
    } else {
        None
    }
}

fn at_mut<T>(v: &mut [T], i: f64) -> Option<&mut T> {
    if i >= 0.0 && i.fract() == 0.0 && i < v.len() as f64 {
        v.get_mut(i as usize)
    } else {
        None
    }
}

/// `part.measures[i]!` 后接着读字段：取不到（没有这一格、这一格没有小节）时 TS 抛 TypeError。
fn measure(part: &PlayPart, i: f64) -> PlayResult<&PlayMeasure> {
    match at(&part.measures, i) {
        Some(Some(m)) => Ok(m),
        _ => err("measure out of range"),
    }
}

fn opt_measure(part: &PlayPart, i: f64) -> Option<&PlayMeasure> {
    at(&part.measures, i).and_then(|m| m.as_ref())
}

fn first_part(parts: &[PlayPart]) -> PlayResult<&PlayPart> {
    match parts.first() {
        Some(p) => Ok(p),
        None => err("no part"),
    }
}

/// 不重复、按插入次序的数集（TS 的 `Set<number>`）。
#[derive(Debug, Clone, Default)]
struct NumSet(Vec<f64>);

impl NumSet {
    fn add(&mut self, v: f64) {
        if !self.has(v) {
            self.0.push(v);
        }
    }
    fn has(&self, v: f64) -> bool {
        // `Set.has` 是 SameValueZero：NaN 认得出自己
        self.0.iter().any(|&x| x == v || (x.is_nan() && v.is_nan()))
    }
    fn size(&self) -> usize {
        self.0.len()
    }
}

/// `Math.max(0, ...xs)`
fn max0(xs: impl Iterator<Item = f64>) -> f64 {
    let mut m = 0.0f64;
    for x in xs {
        if x.is_nan() {
            return f64::NAN;
        }
        if x > m {
            m = x;
        }
    }
    m
}

fn verse_numbers(part: &PlayPart, beg: f64, end: f64) -> NumSet {
    let mut num = NumSet::default();
    for (idx, m) in part.measures.iter().enumerate() {
        let idx = idx as f64;
        if idx < beg || idx >= end {
            continue;
        }
        let Some(m) = m else { continue };
        for c in &m.chords {
            for n in &c.notes {
                for l in &n.lyrics {
                    num.add(l.number);
                }
            }
        }
    }
    num
}

/// 歌词段号的种数（原 `Part.getVerseCount`）。
fn verse_count(part: &PlayPart, beg: f64, end: f64) -> f64 {
    verse_numbers(part, beg, end).size() as f64
}

/// 跳过 `skip` 个和弦后的小节内时值位置（`PlayItem::offset` 用，试听/MIDI 侧靠它裁剪）。
fn skip_offset(m: &PlayMeasure, skip: f64) -> Fraction {
    let mut n = 0.0;
    for c in &m.chords {
        if n == skip {
            return c.position;
        }
        n += 1.0;
    }
    Fraction::int(0.0)
}

// ───────────────────────── 推理 ─────────────────────────

/// 由谱面结构推演唱顺序（反复记号、房号、跳转）。反复与跳转只看 `parts[0]`，歌词段数取各声部最大值。
pub fn play_order_of(parts: &[PlayPart], jumps: &PlayJumps) -> PlayResult<PlayOrder> {
    let p0 = first_part(parts)?;
    let mut rep = RepeatProcessor::new(parts.to_vec(), jumps.clone(), false);
    let mut pos = Pos { mid: 0.0, pass: 1.0 };
    let measures = &p0.measures;
    let n = measures.len() as f64;
    while pos.mid < n {
        let end = rep.process(&mut pos)?;
        if end || pos.pass > 10.0 || rep.result.len() > 20 {
            break;
        }
    }
    let mut repeat_by_verse = true;
    for m in &rep.result {
        let mut rep_start = m.mid;
        let mut mid = m.mid;
        while mid < m.end {
            if measure(p0, mid)?.repeat_forward {
                rep_start = mid;
            }
            mid += 1.0;
        }
        if !measure(p0, m.end - 1.0)?.repeat_backward {
            continue;
        }
        let verse_cnt = rep.pass_count_by_lrc(rep_start, m.end);
        if verse_cnt > 1.0 {
            repeat_by_verse = false;
        }
    }
    // 谱面写明了 2 号以上的房（1.2.3.5./4./6.）时，演唱遍数由房号显式给定、RepeatProcessor
    // 已按房展开；不能再按歌词段数把整份结果整体乘一遍（沧海一声笑会被乘成 6 倍）。
    let has_volta = measures.iter().flatten().any(|m| m.ending_num.as_ref().is_some_and(|v| v.iter().any(|&x| x > 1.0)));
    // D.C./D.S. 同理：跳转记号本身就把曲子展开成了多遍（`D.C. al Fine`＝全曲唱一遍、回头唱到 Fine 为止，
    // 两遍正好配两段词），再按歌词段数整体乘一遍就成了四遍。
    let has_jump = !jumps.jump_to.is_empty();
    if let Some(by_verse) = jump_by_verse(parts, jumps)? {
        return Ok(PlayOrder { measures: by_verse, is_simple: false, has_repeat: false, implied_repeat: -1.0, scopes: vec![] });
    }
    let is_simple = rep.result.len() == 1;
    if repeat_by_verse && !has_volta && !has_jump {
        rep.repeat_by_lyric();
    }
    let mut out = if has_jump {
        per_verse(&rep.result, rep.pass_count_by_lrc(0.0, n))
    } else {
        match expand_volta_by_verse(p0, &rep.result)? {
            Some(v) => v,
            None => rep.result.clone(),
        }
    };
    if has_jump {
        label_passes(parts, &mut out);
    }
    if !has_volta && !has_jump {
        implicit_voltas(parts, &mut out)?;
    }
    if !has_jump {
        last_verse_tail(parts, &mut out)?;
    }
    if !has_jump {
        glue_coda(parts, &mut out)?;
    }
    Ok(PlayOrder {
        measures: out,
        is_simple,
        has_repeat: measures.iter().flatten().any(|m| m.repeat_backward),
        implied_repeat: rep.implied_repeat,
        scopes: vec![],
    })
}

/// 一段：按谱面先后的小节（同名多处拼成一段），首尾可能是被标记切开的半小节
struct Section {
    mids: Vec<f64>,
    /// 被标记切开的小节：小节下标 → 从第几个和弦起 / 到第几个和弦
    skips: Vec<(f64, f64)>,
    limits: Vec<(f64, f64)>,
    used: f64,
    scope: NumSet,
}

fn map_get(m: &[(f64, f64)], k: f64) -> Option<f64> {
    m.iter().find(|(x, _)| *x == k).map(|(_, v)| *v)
}

fn map_set(m: &mut Vec<(f64, f64)>, k: f64, v: f64) {
    match m.iter_mut().find(|(x, _)| *x == k) {
        Some(e) => e.1 = v,
        None => m.push((k, v)),
    }
}

/// 曲内段落标记切出各段：段名 → 按谱面先后的小节（同名多处拼成一段），按插入次序。
/// 空串是第一个标记之前的那几小节（段落名不会是空的）。
fn sections_of(marks: &[SectionMark], count: f64) -> Vec<(String, Section)> {
    let mut sorted: Vec<&SectionMark> = marks.iter().collect();
    js::sort_by(&mut sorted, |a, b| {
        let d = a.mid - b.mid;
        if d != 0.0 && !d.is_nan() {
            d
        } else {
            a.skip - b.skip
        }
    });
    let mut by_name: Vec<(String, Section)> = vec![];
    let mut add = |name: &str, from: (f64, f64), to: (f64, f64)| {
        let end = if to.1 > 0.0 { to.0 + 1.0 } else { to.0 };
        if from.0 >= end {
            return;
        }
        let i = match by_name.iter().position(|(n, _)| n == name) {
            Some(i) => i,
            None => {
                by_name.push((name.to_string(), Section { mids: vec![], skips: vec![], limits: vec![], used: 0.0, scope: NumSet::default() }));
                by_name.len() - 1
            }
        };
        let s = &mut by_name[i].1;
        let mut mid = from.0;
        while mid < end {
            s.mids.push(mid);
            s.scope.add(mid);
            mid += 1.0;
        }
        if from.1 > 0.0 {
            map_set(&mut s.skips, from.0, from.1);
        }
        if to.1 > 0.0 {
            map_set(&mut s.limits, to.0, to.1);
        }
    };
    let first = sorted.first().map(|m| (m.mid, m.skip)).unwrap_or((count, 0.0));
    add("", (0.0, 0.0), first);
    for (i, m) in sorted.iter().enumerate() {
        let next = sorted.get(i + 1).map(|m| (m.mid, m.skip)).unwrap_or((count, 0.0));
        add(&m.name, (m.mid, m.skip), next);
    }
    by_name
}

/// 按头部 `P:` 排的演唱顺序（ABC §3.1.9）。每次进入一段都**新跑一遍** `RepeatProcessor`：段内的反复、房号、D.C./D.S. 从头算，
/// 它的遍号只用来挑房；交出去的 `pass` 是这一段的第几行词（§5.2 按段落各自计遍，段内反复也算行，下一次进入接着往下）。
/// 第一个标记之前的小节在最前面唱一次（标准没规定，不丢内容）。`seq` 里的段落一个都不存在时返回 None，交回 [`play_order_of`]。
pub fn section_play_order(parts: &[PlayPart], jumps: &PlayJumps, seq: &[String], marks: &[SectionMark]) -> PlayResult<Option<PlayOrder>> {
    let p0 = first_part(parts)?;
    let mut by_name = sections_of(marks, p0.measures.len() as f64);
    let find = |by_name: &[(String, Section)], n: &str| by_name.iter().position(|(k, _)| k == n);
    let names: Vec<&String> = seq.iter().filter(|n| find(&by_name, n).is_some()).collect();
    if names.is_empty() {
        return Ok(None);
    }
    let mut order: Vec<usize> = vec![];
    if let Some(i) = find(&by_name, "") {
        order.push(i);
    }
    for n in &names {
        order.push(find(&by_name, n).expect("上面滤过"));
    }
    let mut out: Vec<PlayItem> = vec![];
    let mut implied = -1.0;
    for si in order {
        let (mut items, implied_repeat) = section_run(parts, jumps, &by_name[si].1)?;
        if implied < 0.0 {
            implied = implied_repeat;
        }
        let s = &mut by_name[si].1;
        let mut top = 0.0f64;
        for it in &mut items {
            top = js_max(top, it.pass);
            it.pass += s.used;
            it.scope = Some(si);
        }
        s.used += top;
        if let Some(f) = items.first_mut() {
            f.section_entry = true;
        }
        if let Some(l) = items.last_mut() {
            l.end_of_pass = false;
        }
        out.extend(items);
    }
    Ok(Some(PlayOrder {
        measures: out,
        is_simple: false,
        has_repeat: p0.measures.iter().flatten().any(|m| m.repeat_backward),
        implied_repeat: implied,
        scopes: by_name.into_iter().map(|(_, s)| s.scope.0).collect(),
    }))
}

/// `Math.max(a, b)`（有 NaN 得 NaN）
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// 按逐遍演唱顺序（123 `%%sing`）排的演唱顺序：每项是一段（`[P:x]` 切出来的，同 `P:`）**直着唱**——段内的反复、房号、跳转都不走；
/// `pass` 是这一段的第几行词（`@段`）；一遍末项带 `end_of_pass`。不存在的段跳过（读入时已报诊断）。
/// 断行换页不在这里（`%%layout`，排版自己按段落落）。
pub fn sing_play_order(parts: &[PlayPart], marks: &[SectionMark], pages: &[SingPassSpec]) -> PlayResult<Vec<PlayItem>> {
    let p0 = first_part(parts)?;
    let by_name = sections_of(marks, p0.measures.len() as f64);
    let mut out: Vec<PlayItem> = vec![];
    for pg in pages {
        let head = out.len();
        for it in &pg.items {
            let Some((_, s)) = by_name.iter().find(|(k, _)| *k == it.section) else { continue };
            // 同名多处拼成的段：下标连续的才是一项
            let mut from = 0usize;
            for (i, &mid) in s.mids.iter().enumerate() {
                if i + 1 < s.mids.len() && s.mids[i + 1] == mid + 1.0 {
                    continue;
                }
                let mut p = PlayItem { mid: s.mids[from], end: mid + 1.0, pass: it.verse.unwrap_or(1.0), ..PlayItem::default() };
                let skip = map_get(&s.skips, p.mid);
                if let (Some(skip), Some(m)) = (skip, opt_measure(p0, p.mid)) {
                    p.skip = skip;
                    p.offset = skip_offset(m, skip);
                }
                if let Some(limit) = map_get(&s.limits, mid) {
                    p.limit = limit;
                }
                out.push(p);
                from = i + 1;
            }
        }
        if out.len() > head {
            out.last_mut().expect("非空").end_of_pass = true;
        }
    }
    Ok(out)
}

/// 一段走一遍：把这一段切成一份只有这几小节的谱交给 `RepeatProcessor`，产物的小节下标换回全曲。
fn section_run(parts: &[PlayPart], jumps: &PlayJumps, s: &Section) -> PlayResult<(Vec<PlayItem>, f64)> {
    let local: Vec<(f64, f64)> = s.mids.iter().enumerate().map(|(i, &mid)| (mid, i as f64)).collect();
    // 被标记切开的小节：反复起、房头算前半截的，`:|`、收房算后半截的
    let slice = |m: Option<&PlayMeasure>, mid: f64| -> Option<PlayMeasure> {
        let m = m?;
        let tail = map_get(&s.limits, mid).is_some();
        let head = map_get(&s.skips, mid).is_some();
        let mut c = m.clone();
        if tail {
            c.repeat_backward = false;
            c.ending_right = None;
        }
        if head {
            c.repeat_forward = false;
        }
        Some(c)
    };
    let cut: Vec<PlayPart> = parts
        .iter()
        .map(|p| PlayPart { measures: s.mids.iter().map(|&mid| slice(opt_measure(p, mid), mid)).collect() })
        .collect();
    let mut rep = RepeatProcessor::new(cut, local_jumps(jumps, &local)?, true);
    let mut pos = Pos { mid: 0.0, pass: 1.0 };
    let n = s.mids.len() as f64;
    while pos.mid < n {
        if rep.process(&mut pos)? || pos.pass > 10.0 || rep.result.len() > 20 {
            break;
        }
    }
    let p0 = first_part(parts)?;
    let mids = |i: f64| -> PlayResult<f64> {
        match at(&s.mids, i) {
            Some(&v) => Ok(v),
            None => err("section index out of range"),
        }
    };
    let mut items = vec![];
    for r in &rep.result {
        // 同名多处拼起来的段：下标连续的才是一项
        let mut from = r.mid;
        let mut i = r.mid;
        while i < r.end {
            if i + 1.0 < r.end && at(&s.mids, i + 1.0).copied() == Some(mids(i)? + 1.0) {
                i += 1.0;
                continue;
            }
            let mut it = r.clone();
            it.mid = mids(from)?;
            it.end = mids(i)? + 1.0;
            if from != r.mid {
                it.offset = Fraction::int(0.0);
            }
            let skip = map_get(&s.skips, it.mid);
            if let (Some(skip), Some(m)) = (skip, opt_measure(p0, it.mid)) {
                it.skip = skip;
                it.offset = skip_offset(m, skip);
            }
            if let Some(limit) = map_get(&s.limits, it.end - 1.0) {
                it.limit = limit;
            }
            items.push(it);
            from = i + 1.0;
            i += 1.0;
        }
    }
    let implied = if rep.implied_repeat < 0.0 { -1.0 } else { mids(rep.implied_repeat)? };
    Ok((items, implied))
}

/// 跳转表换成段内下标。落点不在这一段的 D.S. / To Coda 不算（跨段跳转没有定义），D.C. 回段首。
fn local_jumps(jumps: &PlayJumps, local: &[(f64, f64)]) -> PlayResult<PlayJumps> {
    let inside = |t: &TimePosition| -> PlayResult<Option<TimePosition>> {
        match map_get(local, t.mid) {
            None => Ok(None),
            Some(mid) => Ok(Some(TimePosition::new(mid, t.offset)?)),
        }
    };
    let marks = |from: &[(String, TimePosition)]| -> PlayResult<Vec<(String, TimePosition)>> {
        let mut out = vec![];
        for (k, t) in from {
            if let Some(at) = inside(t)? {
                out.push((k.clone(), at));
            }
        }
        Ok(out)
    };
    let segno = marks(&jumps.segno)?;
    let coda = marks(&jumps.coda)?;
    let mut jump_to = vec![];
    for (t, v) in &jumps.jump_to {
        let Some(at) = inside(t)? else { continue };
        if v.kind == PlaySpecKind::DalSegno && lookup(&segno, v.value.as_deref()).is_none() {
            continue;
        }
        if v.kind == PlaySpecKind::ToCoda && lookup(&coda, v.value.as_deref()).is_none() {
            continue;
        }
        jump_to.push((at, v.clone()));
    }
    Ok(PlayJumps { coda, segno, jump_to })
}

/// 接到末行的结尾最多几小节（「阿们」一两小节）
const CODA_MAX: f64 = 2.0;

fn nums_at(parts: &[PlayPart], i: f64) -> NumSet {
    let mut s = NumSet::default();
    for p in parts {
        for v in verse_numbers(p, i, i + 1.0).0 {
            s.add(v);
        }
    }
    s
}

/// 曲尾只有末段写了词的那几小节（文本谱《圣哉三一歌》末段后的「(阿们)」）只在最后一遍唱：前几遍唱到它前面为止；
/// 最后一遍里它接在前面那行末尾（`glue_from`）。
fn last_verse_tail(parts: &[PlayPart], items: &mut [PlayItem]) -> PlayResult<()> {
    let p0 = first_part(parts)?;
    let n = p0.measures.len() as f64;
    let mut last = 0.0f64;
    for it in items.iter() {
        last = js_max(last, it.pass);
    }
    if last < 2.0 {
        return Ok(());
    }
    let mut t = n;
    let mut sung = false;
    while t > 0.0 {
        let s = nums_at(parts, t - 1.0);
        if s.0.iter().any(|&v| v != last) {
            break;
        }
        if s.has(last) {
            sung = true;
        }
        t -= 1.0;
    }
    if !sung || t == 0.0 || t == n {
        return Ok(());
    }
    // 还得是终止线隔开的（`|||`）：只看词的话，末段多写一句的普通结尾也会被截
    if measure(p0, t - 1.0)?.barline.as_deref() != Some("light-heavy") {
        return Ok(());
    }
    for i in (0..items.len()).rev() {
        if items[i].end <= t {
            continue;
        }
        // 从结尾起头的一项：紧接着前一项唱下来的才是「阿们」，跳过一房接上的是二房（爱是不保留 `13-19:2 21-23:2`），不动
        let short = n - t <= CODA_MAX;
        if items[i].mid >= t {
            if short && i > 0 && items[i - 1].end == items[i].mid {
                items[i].glue_from = items[i].mid;
            }
            continue;
        }
        // 用户定 2026-10-14：「阿们」接在最后一遍末行的末尾，不单独成行
        let it = &mut items[i];
        if it.pass == last {
            if short {
                it.glue_from = t;
            }
        } else {
            it.end = t;
        }
    }
    Ok(())
}

/// 各遍之后只唱一次的结尾（148《求圣灵教导》、255、494 终止线后的「阿们」，`… 0-16:4 16-17:1`）：
/// 别的遍都没唱到这几小节、紧接前一项唱下来、前面是终止线——接在前一行末尾，不单独成行（用户定 2026-10-14）。
fn glue_coda(parts: &[PlayPart], items: &mut [PlayItem]) -> PlayResult<()> {
    let len = items.len();
    if len < 2 {
        return Ok(());
    }
    let tail = &items[len - 1];
    if tail.mid == 0.0 || tail.glue_from >= 0.0 {
        return Ok(());
    }
    if items[..len - 1].iter().any(|it| it.end > tail.mid) {
        return Ok(());
    }
    if items[len - 2].end != tail.mid {
        return Ok(()); // 跳过一房接上的二房不算
    }
    if tail.end - tail.mid > CODA_MAX {
        return Ok(()); // 反复之后的整段 B 段（111、137、237）不是「阿们」
    }
    if measure(first_part(parts)?, tail.mid - 1.0)?.barline.as_deref() != Some("light-heavy") {
        return Ok(());
    }
    let tail = &mut items[len - 1];
    tail.glue_from = tail.mid;
    Ok(())
}

/// 没画房号、按词看出来的一房二房（testdata《爱是不保留》）：`:|` 前末 k 小节只写了第 1 段（第 p 遍不唱），
/// `:|` 后紧接的 k 小节只写了第 p 段、没有第 1 段——第 p 遍唱到 `:|` 前 k 小节就跳过去唱后面那 k 小节（二房），
/// 再往后才回到第 1 遍。曲尾 `:|` 后只写末段的结尾同理。
fn implicit_voltas(parts: &[PlayPart], items: &mut Vec<PlayItem>) -> PlayResult<()> {
    let n = first_part(parts)?.measures.len();
    let nums: Vec<NumSet> = (0..n).map(|i| nums_at(parts, i as f64)).collect();
    let num = |i: f64| -> PlayResult<&NumSet> {
        match at(&nums, i) {
            Some(s) => Ok(s),
            None => err("measure out of range"),
        }
    };
    let mut i = 0;
    while i + 1 < items.len() {
        let (a_mid, a_end, p, a_limit) = (items[i].mid, items[i].end, items[i].pass, items[i].limit);
        let b = items[i + 1].clone();
        let e = a_end;
        if p < 2.0 || b.mid != e || b.pass == p || a_limit != -1.0 || b.skip > 0.0 {
            i += 1;
            continue;
        }
        let mut k = 0.0;
        while k + 1.0 < a_end - a_mid && e + k < b.end && {
            let x = num(e - k - 1.0)?;
            let y = num(e + k)?;
            !x.has(p) && x.has(1.0) && y.has(p) && !y.has(1.0)
        } {
            k += 1.0;
        }
        if k == 0.0 {
            i += 1;
            continue;
        }
        items[i].end = e - k;
        let mut v = PlayItem::span(e, e + k, p);
        if b.mid + k >= b.end {
            v.end_of_pass = b.end_of_pass;
            items[i + 1] = v;
        } else {
            items[i + 1].mid += k;
            items.insert(i + 1, v);
        }
        i += 1;
    }
    Ok(())
}

/// `D.C. al Fine` / `D.S. al Fine` 碰上多段词（用户定 2026-10-14：每段一遍、各自回到 Fine）。
///
/// 谱面 A（到 Fine）+ B（到 D.C./D.S.），B 写了 V 段词、A 段数比它少（096《哈利路亚！感谢主》：副歌在前只一行、
/// 主歌四段）：A B₁ → 跳回唱 A 到 Fine → B₂ → 跳回 A 到 Fine … → B_V → 跳回 A 到 Fine 收。
/// A 的那几遍取 A 自己的词：A 只有一行就每遍都用第 1 段，A 也写了几段就用对应那段（不够的退回第 1 段）。
/// 每段唱完 Fine 那一遍换页（`end_of_pass`）。
/// 只管最简单的形态：一处 D.C. 或 D.S.、一处 Fine、没有 To Coda、谱里没有 `:|` 与房号；不满足返回 None，交给 `RepeatProcessor`。
fn jump_by_verse(parts: &[PlayPart], jumps: &PlayJumps) -> PlayResult<Option<Vec<PlayItem>>> {
    let measures = &first_part(parts)?.measures;
    if measures.iter().flatten().any(|m| m.repeat_backward || m.ending_num.is_some()) {
        return Ok(None);
    }
    let mut back: Option<(&TimePosition, &JumpSpec)> = None;
    let mut fine: Option<&TimePosition> = None;
    for (t, v) in &jumps.jump_to {
        if v.kind == PlaySpecKind::ToCoda {
            return Ok(None);
        }
        if v.kind == PlaySpecKind::Fine {
            if fine.is_some() {
                return Ok(None);
            }
            fine = Some(t);
        } else {
            if back.is_some() {
                return Ok(None);
            }
            back = Some((t, v));
        }
    }
    let (Some((back_at, back_spec)), Some(fine)) = (back, fine) else { return Ok(None) };
    let mut target = TimePosition::new(0.0, Fraction::int(0.0))?;
    if back_spec.kind == PlaySpecKind::DalSegno {
        let Some(seg) = lookup(&jumps.segno, back_spec.value.as_deref()) else { return Ok(None) };
        target = *seg;
    }
    let fine_mid = fine.mid;
    let back_mid = back_at.mid;
    if !(target.mid <= fine_mid && fine_mid < back_mid) {
        return Ok(None);
    }
    let verses_of = |beg: f64, end: f64| max0(parts.iter().map(|p| verse_count(p, beg, end)));
    let b = verses_of(fine_mid + 1.0, back_mid + 1.0);
    let a = verses_of(target.mid, fine_mid + 1.0);
    let v = js_max(a, b);
    if v <= 1.0 || v.is_nan() {
        return Ok(None);
    }
    let mut out: Vec<PlayItem> = vec![];
    if a < b {
        // A 的词比 B 少（副歌在前）：下一段接在 Fine 后面，不再从头唱 A
        out.push(PlayItem::span(0.0, back_mid + 1.0, 1.0));
        let mut k = 1.0;
        while k <= v {
            let mut p = PlayItem::span(target.mid, fine_mid + 1.0, if k <= a { k } else { 1.0 });
            p.offset = target.offset;
            if k < v {
                p.end_of_pass = true;
                out.push(p);
                out.push(PlayItem::span(fine_mid + 1.0, back_mid + 1.0, k + 1.0));
            } else {
                out.push(p);
            }
            k += 1.0;
        }
        return Ok(Some(out));
    }
    // A 也写了各段的词（236《同享主餐》、250《主，差遣我》）：每段从曲首唱到 D.C./D.S.、跳回唱到 Fine，下一段再从曲首起
    let mut k = 1.0;
    while k <= v {
        out.push(PlayItem::span(0.0, back_mid + 1.0, k));
        let mut p = PlayItem::span(target.mid, fine_mid + 1.0, k);
        p.offset = target.offset;
        if k < v {
            p.end_of_pass = true;
        }
        out.push(p);
        k += 1.0;
    }
    Ok(Some(out))
}

/// 有跳转、又有反复的谱：`RepeatProcessor` 推出的一遍里遍号只用来挑房，段数比它多（094《哈利路亚，祂已复活》三段、
/// 一房里的 D.S. 只回 segno 再唱一次）时，整套按段数逐段各唱一遍，遍号换成段号。
fn per_verse(items: &[PlayItem], verses: f64) -> Vec<PlayItem> {
    let mut max_pass = 0.0f64;
    for it in items {
        max_pass = js_max(max_pass, it.pass);
    }
    if verses <= max_pass {
        return items.to_vec();
    }
    let mut out = vec![];
    let mut k = 1.0;
    while k <= verses {
        for (i, it) in items.iter().enumerate() {
            let mut c = it.clone();
            c.pass = k;
            c.end_of_pass = i == items.len() - 1 && k < verses;
            out.push(c);
        }
        k += 1.0;
    }
    out
}

/// `/^\s*(\d+(?:\s*[.,，、]\s*\d+)+)\s*[.,，、]/` 的第 1 组里的各个数字串（取不到为 None）。
fn verse_label(text: &str) -> Option<Vec<f64>> {
    let is_sep = |c: char| matches!(c, '.' | ',' | '，' | '、');
    let cs: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < cs.len() && js::is_space(cs[i]) {
        i += 1;
    }
    let digits = |i: &mut usize| -> Option<String> {
        let s = *i;
        while *i < cs.len() && cs[*i].is_ascii_digit() {
            *i += 1;
        }
        (*i > s).then(|| cs[s..*i].iter().collect())
    };
    // `\s*[sep]`，成了回跳过后的位置
    let sep = |mut i: usize| -> Option<usize> {
        while i < cs.len() && js::is_space(cs[i]) {
            i += 1;
        }
        (i < cs.len() && is_sep(cs[i])).then_some(i + 1)
    };
    let mut runs = vec![digits(&mut i)?];
    // `\s*[sep]\s*\d+`
    while let Some(mut j) = sep(i) {
        while j < cs.len() && js::is_space(cs[j]) {
            j += 1;
        }
        let Some(d) = digits(&mut j) else { break };
        runs.push(d);
        i = j;
    }
    // 第 1 组贪心吃到最后一串数字；后面跟不上 `\s*[sep]` 就退一串（前一串后面必定跟着分隔符）
    if sep(i).is_none() {
        runs.pop();
    }
    if runs.len() < 2 {
        return None;
    }
    Some(runs.iter().map(|d| js::number(d)).collect())
}

/// 歌词行首印着几个段号（018《伟大的主》副歌第 1 行是「1.2.伟大的主」）：这一行唱那几遍，后面的行依次往后挪
/// （第 2 行唱第 3 遍——D.S. 回来那一遍）。按这张表把遍号换成该唱的那一行；没有这种段号时不动。
fn label_passes(parts: &[PlayPart], items: &mut [PlayItem]) {
    let mut labels: Vec<(f64, Vec<f64>)> = vec![];
    for part in parts {
        for m in part.measures.iter().flatten() {
            for c in &m.chords {
                for n in &c.notes {
                    for l in &n.lyrics {
                        if labels.iter().any(|(k, _)| *k == l.number) {
                            continue;
                        }
                        if let Some(ps) = verse_label(l.text.as_deref().unwrap_or("")) {
                            labels.push((l.number, ps));
                        }
                    }
                }
            }
        }
    }
    if !labels.iter().any(|(_, ps)| ps.len() > 1) {
        return;
    }
    let mut line_of: Vec<(f64, f64)> = vec![];
    let mut next = 1.0f64;
    let lines = max0(parts.iter().map(|p| verse_count(p, 0.0, p.measures.len() as f64)));
    let mut line = 1.0;
    while line <= lines {
        let ps = labels.iter().find(|(k, _)| *k == line).map(|(_, v)| v.clone()).unwrap_or_else(|| vec![next]);
        for &p in &ps {
            map_set(&mut line_of, p, line);
        }
        let mut m = next;
        for &p in &ps {
            m = js_max(m, p);
        }
        next = m + 1.0;
        line += 1.0;
    }
    for it in items {
        if let Some(l) = map_get(&line_of, it.pass) {
            it.pass = l;
        }
    }
}

/// 演唱顺序里一遍都没有的小节（下标升序）。
pub fn unplayed_measures(items: &[PlayItem], measure_count: usize) -> Vec<usize> {
    let mut played = vec![false; measure_count];
    for it in items {
        let mut mid = it.mid;
        while mid < it.end && mid < measure_count as f64 {
            if let Some(p) = at_mut(&mut played, mid) {
                *p = true;
            }
            mid += 1.0;
        }
    }
    (0..measure_count).filter(|&i| !played[i]).collect()
}

/// 不推、按段数整曲逐遍（没有反复信息时的退路）。`passes` 为 0 时返回空表。
pub fn play_order_by_verses(measure_count: f64, passes: f64) -> Vec<PlayItem> {
    let mut out = vec![];
    let mut p = 0.0;
    while p < passes {
        out.push(PlayItem::span(0.0, measure_count, p + 1.0));
        p += 1.0;
    }
    out
}

/// 显式给定的演唱顺序（`.Repeat` 段）。`part0` 用来把 skip 换成小节内位置。
pub fn play_order_from_spec(items: &[RepeatSpecItem], part0: Option<&PlayPart>) -> Vec<PlayItem> {
    items
        .iter()
        .map(|it| {
            let mut p = PlayItem {
                mid: it.first,
                end: it.last + 1.0,
                pass: it.verse,
                skip: it.skip,
                limit: it.limit,
                end_of_pass: it.page,
                ..PlayItem::default()
            };
            // 跳过起头几个音时，试听/MIDI 侧用 offset 裁掉同样的部分（时间轴只认 offset）。
            if it.skip > 0.0 {
                if let Some(m) = part0.and_then(|p| opt_measure(p, it.first)) {
                    p.offset = skip_offset(m, it.skip);
                }
            }
            p
        })
        .collect()
}

/// 「一房只有第 1 段 + 歌词段数多于房数」的赞美诗谱（如《我心等候祢》）补救展开。
///
/// 这类谱：A 段有 V 行歌词，一房只写第 1 行（第 1 段唱完回头、不进副歌），
/// 二房起的行整体上移一行（行 k ↔ 第 k+1 段，谱面常在行首标「2./3./4.」），
/// 末尾多出来的行则是收尾再唱一遍的副歌。RepeatProcessor 只按房数推 2 遍，
/// 第 3、4 段会整个丢掉；这里按歌词行数重排。条件不满足时返回 None（普通两房两段谱不受影响）。
fn expand_volta_by_verse(part: &PlayPart, items: &[PlayItem]) -> PlayResult<Option<Vec<PlayItem>>> {
    let n = part.measures.len();
    if items.is_empty() {
        return Ok(None);
    }
    let m = |i: usize| measure(part, i as f64);
    // 唯一一个 backward 反复，且带房号；其后须紧跟二房（ending_left）。
    let mut back_idx: Option<usize> = None;
    for i in 0..n {
        if !m(i)?.repeat_backward {
            continue;
        }
        if back_idx.is_some() {
            return Ok(None); // 多处反复，不处理
        }
        back_idx = Some(i);
    }
    let Some(back_idx) = back_idx else { return Ok(None) };
    let volta1_end = back_idx + 1; // 一房尾后一格
    if m(back_idx)?.ending_right.is_none() {
        return Ok(None);
    }
    let mut volta1_beg: Option<usize> = None;
    for i in (0..=back_idx).rev() {
        if m(i)?.ending_left {
            volta1_beg = Some(i);
            break;
        }
    }
    let Some(volta1_beg) = volta1_beg else { return Ok(None) };
    let tail_beg = volta1_end;
    if tail_beg >= n || !m(tail_beg)?.ending_left {
        return Ok(None);
    }
    // 反复起点（无 forward 记号则从头）。
    let mut rep_start = 0;
    for i in 0..volta1_beg {
        if m(i)?.repeat_forward {
            rep_start = i;
        }
    }
    if rep_start >= volta1_beg {
        return Ok(None);
    }
    let verses = verse_count(part, 0.0, n as f64);
    let mut max_pass = 0.0f64;
    for it in items {
        if it.pass > max_pass {
            max_pass = it.pass;
        }
    }
    if verses <= max_pass {
        return Ok(None); // 段数没有多出来，交给原逻辑
    }
    if verse_count(part, volta1_beg as f64, volta1_end as f64) != 1.0 {
        return Ok(None); // 一房不止第 1 段，形态不符
    }
    let tail_verses = verse_count(part, tail_beg as f64, n as f64);
    let mut out: Vec<PlayItem> = vec![];
    // 二房开头那几个音是这一段的结束音（与一房同位），断句上归主歌、不归副歌，
    // 这样「…惟靠祢恩典我站立。」不会被拆到副歌那页去。
    let lead = volta_lead(part, volta1_beg, volta1_end, tail_beg)?;
    let tail_m = m(tail_beg)?;
    let tail_start = |p: &mut PlayItem| {
        p.skip = lead;
        if lead > 0.0 {
            p.offset = skip_offset(tail_m, lead);
        }
    };
    let (tb, nf) = (tail_beg as f64, n as f64);
    // 第 1 遍：反复前的小节 + A 段 + 一房（连续，合成一项），唱完回头、不进副歌。
    let mut first = PlayItem::span(0.0, volta1_end as f64, 1.0);
    first.end_of_pass = true;
    out.push(first);
    // 第 2..V 遍：A 段用第 k 行，二房+副歌用第 k-1 行（整体上移一行）。
    let mut k = 2.0;
    while k <= verses {
        out.push(PlayItem::span(rep_start as f64, volta1_beg as f64, k));
        let tv = k - 1.0;
        if tv <= tail_verses && lead > 0.0 {
            let mut p = PlayItem::span(tb, tb + 1.0, tv);
            p.limit = lead; // 结束音，仍归主歌那页
            out.push(p);
        }
        out.last_mut().expect("非空").end_of_pass = true; // 主歌段末
        if tv <= tail_verses {
            let mut p = PlayItem::span(tb, nf, tv);
            tail_start(&mut p);
            p.end_of_pass = true; // 副歌段末
            out.push(p);
        }
        k += 1.0;
    }
    // 二房+副歌里没用掉的行 = 收尾再唱的副歌，每行追加一遍（同样从副歌起拍接入）。
    let mut v = verses;
    while v <= tail_verses {
        let mut p = PlayItem::span(tb, nf, v);
        tail_start(&mut p);
        p.end_of_pass = true;
        out.push(p);
        v += 1.0;
    }
    out.last_mut().expect("非空").end_of_pass = false; // 末遍不额外换页
    Ok(Some(out))
}

/// 二房开头「与一房同位的结束音」个数：按一房的和弦数算，封顶到二房首节留一个音给副歌起拍。
/// 这几个音属于本段主歌（一房/二房各写一次的段末音），断句、分页都跟主歌走。跨连线/延音时返回 0。
fn volta_lead(part: &PlayPart, volta1_beg: usize, volta1_end: usize, tail_beg: usize) -> PlayResult<f64> {
    let mut n = 0.0f64;
    for i in volta1_beg..volta1_end {
        n += measure(part, i as f64)?.chords.len() as f64;
    }
    let tail = &measure(part, tail_beg as f64)?.chords;
    n = n.min(tail.len() as f64 - 1.0);
    if n <= 0.0 {
        return Ok(0.0);
    }
    for c in tail.iter().take(n as usize) {
        if c.slur_start || c.slur_ends > 0.0 {
            return Ok(0.0);
        }
        if c.notes.iter().any(|nt| nt.tie_start || nt.tie_end) {
            return Ok(0.0);
        }
    }
    Ok(n)
}

/// 推演唱顺序时走到哪一小节、第几遍（TS 里与 `PlayItem` 同类的 `TimePosition`，只用这两个字段）
struct Pos {
    mid: f64,
    pass: f64,
}

struct RepeatProcessor {
    parts: Vec<PlayPart>,
    jumps: PlayJumps,
    /// 只看谱面记号、不看歌词（按 `P:` 排时遍数由记号定，`|: :|` 恒两遍；行数另算）
    structure_only: bool,
    in_ending: bool,
    ending_active: bool,
    loop_start: f64,
    pass_count: f64,
    in_jump: bool,
    /// 本小节的 D.C./D.S. 被当作「房内回头记号」处理过（见 `play`）：外层据此跳过收房/反复判定。
    looped_back: bool,
    result: Vec<PlayItem>,
    implied_repeat: f64,
}

/// 名字查不到落点时按小节号读（`parseInt(名, 10) - 1`）。
fn fallback_target(name: &str) -> PlayResult<TimePosition> {
    TimePosition::new(js::parse_int(name, 10) - 1.0, Fraction::int(0.0))
}

impl RepeatProcessor {
    fn new(parts: Vec<PlayPart>, jumps: PlayJumps, structure_only: bool) -> RepeatProcessor {
        RepeatProcessor {
            parts,
            jumps,
            structure_only,
            in_ending: false,
            ending_active: false,
            loop_start: 0.0,
            pass_count: -1.0,
            in_jump: false,
            looped_back: false,
            result: vec![],
            implied_repeat: -1.0,
        }
    }

    fn p0(&self) -> &PlayPart {
        &self.parts[0]
    }

    fn do_jump(&mut self, m: &mut Pos, t: &TimePosition) {
        self.in_jump = true;
        m.mid = t.mid;
        let mut cur = PlayItem::span(t.mid, t.mid + 1.0, m.pass);
        cur.offset = t.offset;
        self.result.push(cur);
    }

    fn target_of(&self, name: &str, table: &[(String, TimePosition)]) -> PlayResult<TimePosition> {
        match lookup(table, Some(name)) {
            Some(t) => Ok(*t),
            None => fallback_target(name),
        }
    }

    fn play(&mut self, m: &mut Pos) -> PlayResult<bool> {
        let mid = m.mid;
        let mea = measure(self.p0(), mid)?.clone();
        let tbeg = TimePosition::new(mid, Fraction::int(0.0))?;
        let tend = TimePosition::new(mid, mea.duration()?)?;
        let mut res = false;
        let mut seg: Option<String> = None;
        let mut tocoda: Option<String> = None;
        let mut dacapo = false;
        for (t, v) in &self.jumps.jump_to {
            if t.compare_to(&tbeg) < 0.0 {
                continue;
            }
            if t.compare_to(&tend) > 0.0 {
                continue;
            }
            // TS 的 `seg = v.value as string`：值缺省（null）时等于没写 D.S.，且会盖掉前面记下的
            if !self.in_jump && v.kind == PlaySpecKind::DalSegno {
                seg = v.value.clone();
            }
            // 跳回之后再遇到 D.C. 不再跳（同 D.S.），否则没有 Fine 的 D.C. 会一直绕到 pass 上限
            if !self.in_jump && v.kind == PlaySpecKind::Dacapo {
                dacapo = true;
            }
            if self.in_jump && v.kind == PlaySpecKind::ToCoda {
                tocoda = v.value.clone();
            }
            if self.in_jump && v.kind == PlaySpecKind::Fine {
                res = true;
            }
        }
        // 同一房里 D.S. 与 D.C. 都写了（064《啊！圣善夜》一二房 `:|` 上两个都有）：各管一遍——下一遍的词在 segno 之前
        // 就有就回曲首（D.C.），只从 segno 起才有就回 segno（D.S.，第 3 段词只从 segno 写起）
        if let (Some(s), true) = (&seg, dacapo) {
            let t = self.target_of(s, &self.jumps.segno)?;
            if self.pass_count_by_lrc(0.0, t.mid) > m.pass {
                seg = None;
            } else {
                dacapo = false;
            }
        }
        let new_item = match self.result.last_mut() {
            None => true,
            Some(last) => {
                if mid != last.end || m.pass != last.pass {
                    true
                } else {
                    last.end += 1.0;
                    false
                }
            }
        };
        if new_item {
            self.result.push(PlayItem::span(mid, mid + 1.0, m.pass));
        }
        // 一房里写在 `:|` 上的 D.S.（094《哈利路亚，祂已复活》）：不是跳转，是这次反复回到 segno 而不是曲首
        if seg.is_some() && mea.repeat_backward && self.in_ending {
            let t = self.target_of(seg.as_deref().expect("上面判过"), &self.jumps.segno)?;
            self.loop_start = t.mid;
            seg = None;
        }
        if let Some(s) = &seg {
            let t = self.target_of(s, &self.jumps.segno)?;
            // 跳回 segno 是新的一遍（同 D.C.）：018《伟大的主》D.S. 回来唱副歌第 2 行
            m.pass += 1.0;
            self.do_jump(m, &t);
        }
        if let Some(c) = &tocoda {
            let t = self.target_of(c, &self.jumps.coda)?;
            self.do_jump(m, &t);
            self.in_jump = false;
        }
        // 写在 `:|` 小节上的 D.C.（小兔子乖乖 `:|&dc`）：先把反复唱完，最后一遍才跳回曲首
        if dacapo && !self.in_ending && mea.repeat_backward {
            if self.pass_count < 0.0 {
                self.pass_count = self.pass_count_by_lrc(self.loop_start, mid + 1.0);
                if self.pass_count <= 1.0 {
                    self.pass_count = 2.0;
                }
            }
            if m.pass < self.pass_count {
                dacapo = false;
            }
        }
        if dacapo {
            // 房内的 D.C.（沧海一声笑的「4.」房：1.2.3.5 房带 :||、4 房改用 D.C.、6 房收尾）：
            // 房号已经把遍数列全了，这里的 D.C. 只是这一遍的回头记号，与 :|| 等价——回到曲首后
            // **后续反复照常生效**，故不进 in_jump 抑制模式。房外的 D.C. 仍按老规矩（跳回后不再反复）。
            let inside_volta = self.in_ending && m.pass < self.pass_count;
            m.pass += 1.0;
            m.mid = -1.0;
            if inside_volta {
                self.looped_back = true;
                self.in_ending = false;
                self.ending_active = false;
            } else {
                self.in_jump = true;
            }
        }
        Ok(res)
    }

    fn pass_count_by_ending(&self, mid: f64) -> PlayResult<f64> {
        let mut res = 0.0f64;
        let meas = &self.p0().measures;
        let mut idx = mid;
        while idx < meas.len() as f64 {
            let mif = measure(self.p0(), idx)?;
            idx += 1.0;
            let Some(nums) = &mif.ending_num else { continue };
            for &n in nums {
                if n > res {
                    res = n;
                }
            }
            if mif.ending_right.as_deref() == Some("discontinue") && !mif.repeat_backward {
                break;
            }
        }
        Ok(res)
    }

    fn on_start_ending(&mut self, mif: &PlayMeasure, pass: f64) {
        if self.in_jump {
            return;
        }
        self.in_ending = true;
        self.ending_active = mif.has_ending(pass);
    }

    fn on_right_ending(&mut self, m: &mut Pos, reset_pass: bool) {
        if self.in_jump {
            return;
        }
        self.ending_active = false;
        self.in_ending = false;
        // 收房之后的小节只写了当前这一遍的词、没有第 1 段（064 三房之后的结尾只写第 3 段）：遍号不归 1
        if reset_pass && !self.tail_keeps_pass(m) {
            m.pass = 1.0;
            self.pass_count = -1.0;
        }
    }

    fn tail_keeps_pass(&self, m: &Pos) -> bool {
        if m.pass <= 1.0 || self.structure_only {
            return false;
        }
        let mut nums = NumSet::default();
        for p in &self.parts {
            for n in verse_numbers(p, m.mid + 1.0, p.measures.len() as f64).0 {
                nums.add(n);
            }
        }
        !nums.has(1.0) && nums.has(m.pass)
    }

    fn on_forward(&mut self, mid: f64, pass: f64) {
        if self.in_jump || pass > 1.0 {
            return;
        }
        self.loop_start = mid;
    }

    fn on_backward(&mut self, m: &mut Pos, mif: &PlayMeasure) {
        if self.in_jump {
            return;
        }
        if m.pass < self.pass_count {
            m.mid = self.loop_start;
            m.pass += 1.0;
        } else {
            m.mid += 1.0;
            if mif.ending_right.is_none() {
                m.pass = 1.0;
            }
        }
    }

    fn update(&mut self, m: &mut Pos) -> PlayResult<bool> {
        let active = if self.in_ending { self.ending_active } else { true };
        if active {
            return self.play(m);
        }
        Ok(false)
    }

    /// 段数取各声部的最大值：合唱谱的歌词常只挂在某一个声部上（圣哉三一歌挂在 Q2）。
    fn pass_count_by_lrc(&self, beg: f64, end: f64) -> f64 {
        if self.structure_only {
            return 0.0;
        }
        max0(self.parts.iter().map(|p| verse_count(p, beg, end)))
    }

    fn process(&mut self, m: &mut Pos) -> PlayResult<bool> {
        if m.mid < 0.0 {
            return err("process: mid < 0");
        }
        let mif = measure(self.p0(), m.mid)?.clone();
        if mif.ending_left {
            if self.pass_count < 0.0 {
                self.pass_count = self.pass_count_by_ending(m.mid)?;
            }
            self.on_start_ending(&mif, m.pass);
        }
        if mif.repeat_forward {
            self.on_forward(m.mid, m.pass);
        }
        // 本遍不唱这一房（房号不含当前 pass）。它右边界上的 :|| 属于这一房、不该照唱——三房以上的谱
        // （1.2.3.5. / 4. / 6.）里，第 4 遍要跳过一房落到「4.」房，若照跳 :|| 就永远到不了后面的房。
        // 两房谱不受影响：那里 pass 已到 pass_count，on_backward 本就走 m.mid++ 落到二房。
        let skipped_ending = self.in_ending && !self.ending_active;
        let fine = self.update(m)?;
        if fine {
            return Ok(true);
        }
        let len = self.p0().measures.len() as f64;
        if self.looped_back {
            // 房内 D.C. 已把 mid 拨回曲首、pass 进位，收房/反复判定一概跳过。
            self.looped_back = false;
            m.mid += 1.0;
            return Ok(m.mid == len);
        }
        // 封口的房没写 `:|`、下一小节就是下一遍的房（`[2 … |] [3`）：那一房只有回头才进得去，当漏写了 `:|`
        let next = opt_measure(self.p0(), m.mid + 1.0).cloned();
        let implied = !self.in_jump
            && !skipped_ending
            && !mif.repeat_backward
            && mif.ending_right.as_deref() == Some("stop")
            && next.as_ref().is_some_and(|n| n.ending_left && n.has_ending(m.pass + 1.0));
        if implied && self.implied_repeat < 0.0 {
            self.implied_repeat = m.mid;
        }
        if mif.ending_right.is_some() {
            // 第一房通常在右边界同时带 backward repeat，必须保留当前 pass 让 on_backward 进入下一遍；
            // 最后一房右边界没有 backward repeat，它结束了这一组独立反复，此处要把 pass/pass_count 重置，
            // 否则紧随其后的下一组 ||: 会因 pass>1 被 on_forward 忽略、错误跳回上一组反复起点。
            // 「最后一房」须按房号判：多房谱中间的房（如「4.」）右边界同样没有 backward，按「无 backward
            // 即收组」会在半途把 pass 归 1，剩下的房永远唱不到、并陷入死循环。
            // 不封口的房也收组（pass_count 可能是前一组按词数定的、大于本组房号，单按房号判收不了组），
            // 但带 :|| 的不封口房（番茄 `["1." … :|]/`）是一房，照常回头唱下一房（#30）。
            let last_volta = match &mif.ending_num {
                None => true,
                Some(v) => {
                    // `Math.max(...set)`：空集为 -Infinity
                    let mut mx = f64::NEG_INFINITY;
                    for &x in v {
                        mx = if x.is_nan() || mx.is_nan() { f64::NAN } else { mx.max(x) };
                    }
                    mx >= self.pass_count
                }
            };
            let open_end = mif.ending_right.as_deref() == Some("discontinue") && !mif.repeat_backward;
            // 下一小节还有这一遍要唱的房（第三遍跳过 `[2 … |] [3` 的二房）：组还没收
            let next_has = next.as_ref().is_some_and(|n| n.ending_left && n.has_ending(m.pass));
            let closes_repeat_group = !mif.repeat_backward && last_volta && !implied && !next_has;
            self.on_right_ending(m, open_end || closes_repeat_group);
        }
        if implied || (!self.in_jump && mif.repeat_backward && !skipped_ending) {
            if self.pass_count < 0.0 {
                let beg = self.result.last().map(|r| r.mid);
                let Some(beg) = beg else { return err("no result") };
                self.pass_count = self.pass_count_by_lrc(beg, m.mid + 1.0);
                if self.pass_count <= 1.0 {
                    self.pass_count = 2.0;
                }
            }
            self.on_backward(m, &mif);
        } else {
            m.mid += 1.0;
        }
        if m.mid < 0.0 {
            // TS 打「BAD Repeat Info」后收工
            return Ok(true);
        }
        Ok(m.mid == len)
    }

    fn repeat_by_lyric(&mut self) -> bool {
        let pass = self.pass_count_by_lrc(0.0, self.p0().measures.len() as f64);
        if pass <= 1.0 {
            return false;
        }
        let item_cnt = self.result.len();
        let mut cur = 1.0;
        let mut i = 1.0;
        while i < pass {
            cur += 1.0;
            for idx in 0..item_cnt {
                let mut it = self.result[idx].clone();
                it.pass = cur;
                self.result.push(it);
            }
            if let Some(l) = self.result.last_mut() {
                l.end_of_pass = true;
            }
            i += 1.0;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chord(lyrics: &[f64]) -> PlayChord {
        PlayChord {
            notes: vec![PlayNote { tie_start: false, tie_end: false, lyrics: lyrics.iter().map(|&n| PlayLyric { number: n, text: Some("字".into()) }).collect() }],
            position: Fraction::int(0.0),
            slur_start: false,
            slur_ends: 0.0,
        }
    }

    fn meas(lyrics: &[f64]) -> Option<PlayMeasure> {
        Some(PlayMeasure {
            chords: vec![chord(lyrics)],
            duration: Some(Fraction::int(4.0)),
            repeat_backward: false,
            repeat_forward: false,
            ending_left: false,
            ending_num: None,
            ending_right: None,
            barline: None,
        })
    }

    #[test]
    fn verses_without_repeat() {
        let part = PlayPart { measures: vec![meas(&[1.0, 2.0]), meas(&[1.0, 2.0])] };
        let o = play_order_of(&[part], &PlayJumps::default()).unwrap();
        assert!(o.is_simple);
        let got: Vec<(f64, f64, f64, bool)> = o.measures.iter().map(|p| (p.mid, p.end, p.pass, p.end_of_pass)).collect();
        assert_eq!(got, vec![(0.0, 2.0, 1.0, false), (0.0, 2.0, 2.0, true)]);
    }

    #[test]
    fn simple_repeat() {
        let mut ms = vec![meas(&[1.0]), meas(&[1.0]), meas(&[1.0])];
        ms[1].as_mut().unwrap().repeat_backward = true;
        let o = play_order_of(&[PlayPart { measures: ms }], &PlayJumps::default()).unwrap();
        let got: Vec<(f64, f64, f64)> = o.measures.iter().map(|p| (p.mid, p.end, p.pass)).collect();
        assert_eq!(got, vec![(0.0, 2.0, 1.0), (0.0, 2.0, 2.0), (2.0, 3.0, 1.0)]);
        assert!(o.has_repeat);
    }

    #[test]
    fn chordless_measure_errors() {
        let mut ms = vec![meas(&[1.0])];
        ms[0].as_mut().unwrap().duration = None;
        assert!(play_order_of(&[PlayPart { measures: ms }], &PlayJumps::default()).is_err());
    }

    #[test]
    fn verse_label_regex() {
        assert_eq!(verse_label("1.2.伟大"), Some(vec![1.0, 2.0]));
        assert_eq!(verse_label(" 1 , 2 、3，x"), Some(vec![1.0, 2.0, 3.0]));
        assert_eq!(verse_label("1.2.3"), Some(vec![1.0, 2.0]));
        assert_eq!(verse_label("1.2"), None);
        assert_eq!(verse_label("1.伟大"), None);
    }

    #[test]
    fn unplayed() {
        let items = vec![PlayItem::span(0.0, 2.0, 1.0)];
        assert_eq!(unplayed_measures(&items, 4), vec![2, 3]);
    }
}
