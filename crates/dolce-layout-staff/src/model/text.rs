//! 歌词 / 和弦记号 / 文本块。

use dolce_model::base::fraction::Fraction;
use dolce_model::base::js;
use dolce_engrave::chord::HarmonySeg;
use dolce_engrave::spacing::AccidentalSide;
use dolce_model::doc::{DegreeType, Direction as DocDirection, Harmony as DocHarmony, HAlign, Lyric as DocLyric, Placement, Syllabic};
use dolce_text::syllable::syllable_run;
use dolce_text::{CompressMode, Font, MeasureCtx};

use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Lcr {
    #[default]
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug)]
pub struct LyricLayout<'d> {
    pub measure: PmId,
    /// `ScoreDoc` 里对应的歌词
    pub src: &'d DocLyric,
    pub chord: ChordId,
    pub offset: Fraction,
    /// TS `font!`（读入后由 `setLyricFont` 等定）；造节点时给空族名、0 号
    pub font: Font,
    /// 标点挤压档（`MixedOptions.punctCompress`）：量宽与绘制共用这一个，绝不能各走各的。
    pub compress: CompressMode,
    pub extend: Option<Fraction>,
    pub x: f64,
    pub y: f64,
    /// 原文写的基线（`<lyric default-y>`）：自动铺排把 `y` 重算掉，源谱版面档拿它对照原图
    pub src_y: Option<f64>,
    pub x_offset: f64,
    pub width: f64,
    pub prev: Option<LyricId>,
    pub next: Option<LyricId>,
    /// 源里没写、排版时补的段号（`autoVerseNumbers`）；画法同源里写的
    pub auto_prefix: String,
}

impl<'d> LyricLayout<'d> {
    pub fn new(measure: PmId, src: &'d DocLyric, chord: ChordId) -> LyricLayout<'d> {
        LyricLayout {
            measure,
            src,
            chord,
            offset: Fraction::int(0.0),
            font: Font::new("", 0.0),
            compress: CompressMode::Halfwidth,
            extend: None,
            x: -1.0,
            y: -1.0,
            src_y: None,
            x_offset: 0.0,
            width: 0.0,
            prev: None,
            next: None,
            auto_prefix: String::new(),
        }
    }

    // ---- 语义：一律从 ScoreDoc 取 ----
    /// 段号原文（分段按它）
    pub fn num(&self) -> String {
        self.src.number_text.clone().unwrap_or_else(|| js::num_to_string(self.src.number))
    }
    pub fn name(&self) -> String {
        self.src.name.clone().unwrap_or_default()
    }
    /// 印在谱表上方（`<lyric placement="above">`）
    pub fn above(&self) -> bool {
        self.src.placement == Some(Placement::Above)
    }
    /// 印在首字前的段落号（`1.圣` 的 `1.`）与去掉它的正文：`(prefix, text)`
    pub fn split(&self) -> (String, String) {
        let text = js::trim(&self.src.text);
        if text.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            if let Some(dot) = text.find('.') {
                return (text[..dot + 1].to_owned(), text[dot + 1..].to_owned());
            }
        }
        (String::new(), text.to_owned())
    }
    pub fn text(&self) -> String {
        self.split().1
    }
    /// 首字前印的段号：源里的（`verseLabel`；没拆开的 `1.圣` 也认），没有才用补的
    pub fn prefix(&self) -> String {
        if let Some(v) = &self.src.verse_label {
            return v.clone();
        }
        let p = self.split().0;
        if p.is_empty() {
            self.auto_prefix.clone()
        } else {
            p
        }
    }
    /// 词首 / 词尾（`<syllabic>`）
    pub fn begin(&self) -> bool {
        let s = self.src.syllabic.clone().unwrap_or(Syllabic::Single);
        s == Syllabic::Single || s == Syllabic::Begin
    }
    pub fn end(&self) -> bool {
        let s = self.src.syllabic.clone().unwrap_or(Syllabic::Single);
        s == Syllabic::Single || s == Syllabic::End
    }
    pub fn empty(&self) -> bool {
        self.text().is_empty()
    }

    /// [前导非CJK宽, CJK段宽, 尾随非CJK宽]（Lyric::widthInfo 移植）。
    /// 注意：前缀（段落号）不计入，由 drawLrc 单独按固定偏移摆放。
    pub fn width_info(&self, mc: &MeasureCtx) -> [f64; 3] {
        let text = self.text();
        if text.is_empty() {
            return [0.0, 0.0, 0.0];
        }
        // 三段切分与挤压后的笔位走公共那一份（syllable），绘制端拿的是同一串坐标
        let r = syllable_run(&text, &self.font, mc, self.compress);
        [r.lead, r.body, r.tail]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HarmonyDegreeType {
    Add,
    Alter,
    Subtract,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HarmonyStepAlter {
    pub step: String,
    pub alter: f64,
    /// 升降号印在字母前面（`<root-alter location="left">`，中文简谱的 `#Fm`）
    pub alter_left: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HarmonyDegreeItem {
    pub value: f64,
    pub alter: f64,
    pub r#type: HarmonyDegreeType,
}

#[derive(Clone, Debug)]
pub struct HarmonyLayout<'d> {
    pub measure: PmId,
    /// `ScoreDoc` 里对应的和弦符号
    pub src: &'d DocHarmony,
    pub offset: Fraction,
    pub x: f64,
    pub y: f64,
}

impl<'d> HarmonyLayout<'d> {
    pub fn new(measure: PmId, src: &'d DocHarmony) -> HarmonyLayout<'d> {
        HarmonyLayout { measure, src, offset: Fraction::int(0.0), x: 0.0, y: 0.0 }
    }

    // ---- 语义：一律从 ScoreDoc 取 ----
    pub fn root(&self) -> HarmonyStepAlter {
        let r = &self.src.root;
        HarmonyStepAlter { step: r.step.clone(), alter: r.alter, alter_left: r.alter_left }
    }
    pub fn bass(&self) -> Option<HarmonyStepAlter> {
        self.src.bass.as_ref().map(|b| HarmonyStepAlter { step: b.step.clone(), alter: b.alter, alter_left: b.alter_left })
    }
    pub fn degree(&self) -> Vec<HarmonyDegreeItem> {
        self.src
            .degrees
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(|g| HarmonyDegreeItem {
                value: g.value,
                alter: g.alter,
                r#type: match g.kind {
                    DegreeType::Subtract => HarmonyDegreeType::Subtract,
                    DegreeType::Alter => HarmonyDegreeType::Alter,
                    _ => HarmonyDegreeType::Add,
                },
            })
            .collect()
    }
    pub fn kind(&self) -> String {
        js::trim(&self.src.kind).to_owned()
    }
    pub fn kind_text(&self) -> Option<String> {
        self.src.kind_text.clone()
    }
    pub fn use_symbols(&self) -> bool {
        self.src.use_symbols == Some(true)
    }
    pub fn staff(&self) -> f64 {
        self.src.staff.unwrap_or(1.0) - 1.0
    }

    /// 纯文本形式（仅用于 calcMixedStaffY 的宽度粗估）。
    pub fn as_plain_text(&self, side: Option<AccidentalSide>) -> String {
        let acc = |alter: f64| -> &'static str {
            if alter == 1.0 {
                "#"
            } else if alter == -1.0 {
                "b"
            } else {
                ""
            }
        };
        let left = |sa: &HarmonyStepAlter| -> bool {
            match side {
                Some(s) => s == AccidentalSide::Before,
                None => sa.alter_left == Some(true),
            }
        };
        let sa_text = |sa: &HarmonyStepAlter| -> String {
            if left(sa) {
                format!("{}{}", acc(sa.alter), sa.step)
            } else {
                format!("{}{}", sa.step, acc(sa.alter))
            }
        };
        let root = self.root();
        let mut res = sa_text(&root);
        res += &harmony_kind_suffix(&self.kind(), self.kind_text().as_deref());
        for d in self.degree() {
            if d.r#type == HarmonyDegreeType::Add {
                res += "add";
                res += &js::num_to_string(d.value);
            }
        }
        if let Some(b) = self.bass() {
            res += "/";
            res += &sa_text(&b);
        }
        res
    }
}

/// MusicXML kind → 缩写（Harmony::abbrKindText 移植）。
pub fn abbr_kind_text(kind: &str) -> &'static str {
    match kind {
        "minor-seventh" => "m7",
        "major-seventh" => "maj7",
        "major-ninth" => "maj9",
        "diminished-seventh" => "dim7",
        "suspended-fourth" => "(sus4)",
        "dominant" => "7",
        "dominant-ninth" => "9",
        "major-sixth" => "6",
        "minor" => "m",
        "minor-ninth" => "m9",
        "minor-sixth" => "m6",
        _ => "",
    }
}

pub fn is_sus4(degree: &[HarmonyDegreeItem]) -> bool {
    if degree.len() < 2 {
        return false;
    }
    degree[0].r#type == HarmonyDegreeType::Add && degree[0].value == 4.0 && degree[1].r#type == HarmonyDegreeType::Subtract && degree[1].value == 3.0
}

/// MusicXML harmony kind → 习惯后缀（覆盖语料常见 kind，未知的回退 kindText）。
pub fn harmony_kind_suffix(kind: &str, kind_text: Option<&str>) -> String {
    match kind {
        "major" | "" => "",
        "minor" => "m",
        "augmented" => "aug",
        "diminished" => "dim",
        "dominant" => "7",
        "major-seventh" => "maj7",
        "minor-seventh" => "m7",
        "diminished-seventh" => "dim7",
        "half-diminished" => "m7b5",
        "major-sixth" => "6",
        "minor-sixth" => "m6",
        "suspended-fourth" => "sus4",
        "suspended-second" => "sus2",
        "dominant-ninth" => "9",
        "major-ninth" => "maj9",
        "minor-ninth" => "m9",
        "power" => "5",
        _ => {
            if let Some(t) = kind_text {
                return t.to_owned();
            }
            // TS console.warn("unknown harmony kind")
            return kind.to_owned();
        }
    }
    .to_owned()
}

fn seg(text: impl Into<String>, music: bool, superscript: i8, dy: f64) -> HarmonySeg {
    HarmonySeg { text: text.into(), music, superscript, dy, scale: None }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TextBlockItem {
    pub font: Font,
    pub text: String,
    pub dy: f64,
    pub music: bool,
    pub superscript: f64,
    /// 原程序里这项的字号（换了字体、画的字号跟着换算时记下原值；歌本按字号算行高用它）
    pub nominal_size: Option<f64>,
    /// 这项之前额外空出的宽（速度标记「♩ = 120」里「=」两侧的空）
    pub pad_before: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextBlock {
    pub data: Vec<TextBlockItem>,
    pub x: f64,
    pub y: f64,
    pub justify: Lcr,
    pub title: bool,
}

impl TextBlock {
    /// 文字里的换行拆成「项 + 换行项」（TextBlock::add 的 boost::split）：`<words>` 原文带换行就是多行
    pub fn add(&mut self, text: &str, font: &Font, music: bool, nominal_size: Option<f64>, pad_before: Option<f64>) {
        for (i, s) in text.split('\n').enumerate() {
            if i > 0 {
                self.data.push(TextBlockItem { font: font.clone(), text: "\n".into(), dy: 0.0, music, superscript: 0.0, nominal_size: None, pad_before: None });
            }
            if !s.is_empty() {
                // `i === 0 && padBefore`：0 / NaN 不算给了
                let pad = pad_before.filter(|p| i == 0 && *p != 0.0 && !p.is_nan());
                self.data.push(TextBlockItem { font: font.clone(), text: s.to_owned(), dy: 0.0, music, superscript: 0.0, nominal_size, pad_before: pad });
            }
        }
    }

    pub fn width(&self, mc: &MeasureCtx) -> f64 {
        let mut res = 0.0;
        for it in &self.data {
            if it.text == "\n" {
                continue;
            }
            res += it.pad_before.unwrap_or(0.0) + it.font.measure_text(mc, &it.text);
        }
        res
    }

    /// 总高度；vec 收集每行行高（TextBlock::height(vector&)）。
    pub fn height(&self, mc: &MeasureCtx, mut vec: Option<&mut Vec<f64>>) -> f64 {
        let mut line_h: f64 = 0.0;
        let mut res = 0.0;
        for it in &self.data {
            if it.text == "\n" {
                if let Some(v) = vec.as_deref_mut() {
                    v.push(line_h);
                }
                res += line_h;
                line_h = 0.0;
                continue;
            }
            let fm = it.font.metrics(mc);
            line_h = js::max(line_h, fm.descent - fm.ascent);
        }
        if line_h > 0.0 {
            if let Some(v) = vec {
                v.push(line_h);
            }
            res += line_h;
        }
        res
    }

    pub fn text(&self) -> String {
        self.data.iter().map(|d| d.text.as_str()).collect()
    }
}

/// 小节文字块（`MeasureText extends TextBlock`）：块本身在 `block`。
#[derive(Clone, Debug)]
pub struct MeasureText<'d> {
    pub block: TextBlock,
    pub measure: PmId,
    pub offset: Fraction,
    pub staff: usize,
    /// x 是否相对拍位（updateDataXPos 再加拍位 x）；false 时 x 就是小节内坐标（只写 default-x 的 `<words>`）
    pub relative: bool,
    /// y 是自动铺排给的缺省高度（原文没写 default-y）：混排时要让到简谱层之上（`formatMixedScore`）
    pub auto_y: bool,
    /// 力度记号原文写了 `default-y`（识别稿照原图的位置）：自动铺排不改成缺省高度，只在撞上东西时推开
    pub source_y: bool,
    /// 力度记号原文写了字号：自动铺排不统一成歌词字号
    pub source_size: bool,
    /// segno / coda 原文写了 `default-x` / `default-y`：不挪到小节线上、不贴轮廓
    pub sign_placed: bool,
    /// `ScoreDoc` 里对应的 `<direction>`
    pub src: Option<&'d DocDirection>,
    /// 排练号（`<rehearsal>`）：粗体字外面套方框
    pub boxed: bool,
    /// 排练号自带【】（`rehearsalBracketed`）：不画方框
    pub frameless: bool,
}

impl<'d> MeasureText<'d> {
    pub fn new(measure: PmId) -> MeasureText<'d> {
        MeasureText {
            block: TextBlock::default(),
            measure,
            offset: Fraction::int(0.0),
            staff: 0,
            relative: true,
            auto_y: false,
            source_y: false,
            source_size: false,
            sign_placed: false,
            src: None,
            boxed: false,
            frameless: false,
        }
    }
}

impl<'d> std::ops::Deref for MeasureText<'d> {
    type Target = TextBlock;
    fn deref(&self) -> &TextBlock {
        &self.block
    }
}
impl<'d> std::ops::DerefMut for MeasureText<'d> {
    fn deref_mut(&mut self) -> &mut TextBlock {
        &mut self.block
    }
}

impl<'d> StaffLayout<'d> {
    // ───────── LyricLayout ─────────

    pub fn lyric_staff(&self, l: LyricId) -> f64 {
        self[self[l].chord].src.staff - 1.0
    }

    pub fn lyric_halign(&self, l: LyricId) -> Lcr {
        let justify = self.surface.and_then(|s| {
            let oid = self[l].src.oid;
            if oid.is_none() {
                None
            } else {
                s.xml_align(oid).0
            }
        });
        match justify {
            Some(HAlign::Right) => Lcr::Right,
            Some(HAlign::Left) => Lcr::Left,
            _ => Lcr::Center,
        }
    }

    /// 解析后计算 xOffset/width（parser.cpp processLrc 尾部）。
    pub fn lyric_update_width(&mut self, l: LyricId) {
        let w_arr = self[l].width_info(self.mc);
        let mut dx = 0.0;
        let halign = self.lyric_halign(l);
        if halign == Lcr::Center {
            dx = -(w_arr[0] + w_arr[1] / 2.0);
            dx += self[self[l].chord].notehead_width(self.meta) / 2.0;
        } else if halign == Lcr::Right {
            dx = -(w_arr[0] + w_arr[1] + w_arr[2]);
        }
        let ly = &mut self[l];
        ly.x_offset = dx;
        ly.width = w_arr[0] + w_arr[1] + w_arr[2];
    }

    // ───────── HarmonyLayout ─────────

    /// 加音加括号（Sibelius 导出一律加，照 musicpp）
    pub fn harmony_parentheses_degrees(&self, h: HarmId) -> bool {
        self[h].src.parentheses_degrees == Some(true) || self.encoder() == Encoder::Sibelius
    }

    /// 富文本分段（Harmony::asText 移植）：升降号用 SMuFL csym 字形，后缀上标。
    pub fn harmony_as_text(&self, h: HarmId, side: Option<AccidentalSide>) -> Vec<HarmonySeg> {
        let hl = &self[h];
        let mut segs: Vec<HarmonySeg> = Vec::new();
        let step_alter = |segs: &mut Vec<HarmonySeg>, sa: &HarmonyStepAlter| {
            let glyph = if sa.alter == 1.0 {
                gs("csymAccidentalSharp")
            } else if sa.alter == -1.0 {
                gs("csymAccidentalFlat")
            } else {
                String::new()
            };
            let left = match side {
                Some(s) => s == AccidentalSide::Before,
                None => sa.alter_left == Some(true),
            };
            if !glyph.is_empty() && left {
                segs.push(seg(glyph.clone(), true, 0, 0.0));
            }
            segs.push(seg(sa.step.clone(), false, 0, 0.0));
            if !glyph.is_empty() && !left {
                segs.push(seg(glyph, true, 0, 0.0));
            }
        };
        step_alter(&mut segs, &hl.root());

        // MuseScore 把 A7sus4 输出成 kind=suspended-fourth + text="74" + <degree>add 7</degree>，
        // 直接采用 text "74" 会排成错乱的 A⁷⁴add7。此时忽略 kindText，规范展示成 A7(sus4)。
        // 仅针对 MuseScore：其它软件（Sibelius/Finale）对 sus 和弦的记法不同，勿动。
        let all_degrees = hl.degree();
        let add_seventh = all_degrees.iter().position(|d| d.r#type == HarmonyDegreeType::Add && d.value == 7.0);
        let kind = hl.kind();
        let sus_fourth_seventh = self.encoder() == Encoder::MuseScore && kind == "suspended-fourth" && add_seventh.is_some();
        // susFourthSeventh 时把 add 7 度并入后缀，剩余度数照常渲染。
        let degrees: Vec<HarmonyDegreeItem> = if sus_fourth_seventh {
            all_degrees.iter().enumerate().filter(|(i, _)| Some(*i) != add_seventh).map(|(_, d)| *d).collect()
        } else {
            all_degrees.clone()
        };

        let mut kt = String::new();
        let mut use_sym = false;
        let mut sym = String::new();
        let kind_text = hl.kind_text();
        if sus_fourth_seventh {
            kt = "7(sus4)".into();
        } else if let Some(t) = kind_text.as_ref().filter(|t| !t.is_empty()) {
            kt = t.clone();
        } else if kind == "half-diminished" {
            use_sym = true;
            sym = gs("csymHalfDiminished");
        } else if kind == "augmented" {
            use_sym = true;
            sym = gs("csymAugmented");
        } else if kind == "diminished-seventh" || kind == "diminished" {
            use_sym = true;
            sym = gs("csymDiminished");
        } else if kind == "power" {
            kt = "5".into();
        } else {
            let abbr = abbr_kind_text(&kind);
            if !abbr.is_empty() {
                kt = abbr.into();
            } else if kind == "major" || kind.is_empty() {
                // no suffix
            } else {
                kt = format!("<{kind}>");
                // TS console.warn("unknown harmony kind")
            }
        }

        // 前导 m 留在基线，其余后缀上标
        if kt == "m" || kt == "m7" || kt == "m9" || kt == "m6" {
            segs.push(seg("m", false, 0, 0.0));
            kt = kt[1..].to_owned();
        }
        if !kt.is_empty() {
            segs.push(seg(kt.clone(), false, 1, 0.0));
        } else if use_sym {
            segs.push(seg(sym, true, 1, 0.0));
            if kind == "diminished-seventh" || kind == "half-diminished" {
                segs.push(seg("7", false, 1, 0.0));
            }
        }

        let paren = self.harmony_parentheses_degrees(h);
        // degrees（add / alter / sus4）
        if degrees.len() > 1 {
            let mut deg = "";
            if is_sus4(&degrees) {
                deg = "sus4";
            }
            if !deg.is_empty() {
                if paren {
                    segs.push(seg("(", false, 1, 0.0));
                }
                segs.push(seg(deg, false, 1, 0.0));
                if paren {
                    segs.push(seg(")", false, 1, 0.0));
                }
            }
        } else if degrees.len() == 1 {
            let d = degrees[0];
            let mut deg = String::new();
            if d.r#type == HarmonyDegreeType::Add {
                deg = "add".into();
            } else if d.r#type == HarmonyDegreeType::Alter {
                if paren {
                    segs.push(seg("(", false, 0, 0.0));
                }
                if d.alter == -1.0 {
                    segs.push(seg(gs("csymAccidentalFlat"), true, 0, 7.5));
                } else if d.alter == 1.0 {
                    segs.push(seg(gs("csymAccidentalSharp"), true, 0, 7.5));
                }
                segs.push(seg(js::num_to_string(d.value), false, 0, 0.0));
                if paren {
                    segs.push(seg(")", false, 0, 0.0));
                }
            }
            if kt == "6" && d.r#type == HarmonyDegreeType::Add && d.value == 9.0 {
                // 6/9：合并到上一段后缀
                if let Some(last) = segs.last_mut() {
                    last.text += "/9";
                }
            } else if !deg.is_empty() {
                deg += &js::num_to_string(d.value);
                if paren {
                    deg = format!("({deg})");
                }
                segs.push(seg(deg, false, 1, 0.0));
            }
        }

        if let Some(b) = hl.bass() {
            segs.push(seg("/", false, 0, 0.0));
            step_alter(&mut segs, &b);
        }
        segs
    }
}
