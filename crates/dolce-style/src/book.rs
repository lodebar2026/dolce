//! 成书那一份尺子（照 `style/book.ts`）：BookStyle（原书实测，字号已由生成脚本从墨迹高换成 font-size）→ [`JianpuStyle`]。
//!
//! BookStyle 是内存里的中间对象、形状不补默认值（[`crate::bookss`]），这里照 TS 按字段读、缺了照 `??` 兜底；
//! 原样缺省（TS 里得 `undefined` / `NaN`）的字段读成 NaN。

use crate::jianpudefault::{default_jianpu_style, STACK_GAP_DEFAULT};
use crate::jianpustyle::{FaceSpec, JianpuStyle, Margin};
use crate::value::get_path;
use dolce_text::{Font, MeasureCtx};
use serde_json::Value;

/// 减时线宽 ÷ 小节线宽。取自混排简谱层的 `MixedOptions.lineWidths`（jpBeam 1 : lightBarline 1.5）。
const JP_BEAM_TO_BARLINE: f64 = 2.0 / 3.0;

fn f(v: &Value, path: &[&str]) -> Option<f64> {
    get_path(v, path).and_then(Value::as_f64)
}

/// 书籍样式 → 简谱尺子。要量字（附点大小）。
///
/// 数字上下的叠层（八度点、减时线）与各引擎同一套等距（`stack-gap`，用户定：成书也不照原书那三个不等的层距）。
pub fn book_jianpu_style(s: &Value, mc: &MeasureCtx) -> JianpuStyle {
    let nan = f64::NAN;
    let note = f(s, &["roles", "note", "size"]).unwrap_or(nan);
    let lyric = f(s, &["roles", "lyric", "size"]).unwrap_or(nan);
    let em = |v: f64| v * note;
    let m = s.get("metrics").cloned().unwrap_or(Value::Null);
    let mf = |k: &str| f(&m, &[k]);

    // 起点与其余几档同一份出厂值，按歌词字号派生（排版器的构造字号取歌词那一档）
    let mut st = default_jianpu_style(lyric);
    let face = |role: &str| FaceSpec::plain(&font_family_of(s, role));
    st.font.lyric = face("lyric");
    st.font.note = face("note");
    st.font.smufl = face("smufl");
    // 和弦、段号、转调标签量宽用的西文字取 `chord` 那档（Times）
    st.font.text = face("chord");
    st.size.lyric = lyric;
    st.size.note = note;
    st.vertical.barline_height = (note * 4.0) / 3.0; // 成书小节线照字号推，不跟构造字号（歌词）
    // 成书是逐像素复刻印刷底本，字重由 BookStyle 的 roles.note 说了算，不跟编辑器那档加粗
    st.look.note_bold = false;
    st.header.title.size = f(s, &["roles", "title", "size"]).unwrap_or(nan);
    let credit = f(s, &["roles", "credit", "size"]).unwrap_or(nan);
    st.header.credit.size = credit;
    st.header.subtitle.size = credit;
    st.header.scripture.size = credit;

    let mg = |k: &str| f(s, &["page", "margin", k]).unwrap_or(nan);
    st.page.margin = Margin { left: mg("inner"), right: mg("outer"), top: mg("top"), bottom: mg("bottom") };
    // 弧 / 上方带离叠层顶的空照原书量的；叠层本身与各引擎同一套等距
    st.vertical.slur_gap = em(mf("stackGapEm").unwrap_or(nan));
    st.vertical.stack_gap = mf("stackGap").unwrap_or(STACK_GAP_DEFAULT);
    // 附点按原书那个大小：原书印的是 `·`，墨迹高出八度点一截——照默认排全书会差出两页
    st.dot.aug = Font::new(st.font.note.family.clone(), note).char_bound(mc, "·").height() / 2.0;
    let barline_w = mf("barlineWidthEm").unwrap_or(nan);
    // 减时线宽按小节线宽折算（比例照混排简谱层 2/3）。用户口径：「成书重排减时线太细了」
    st.stroke.beam = barline_w * lyric * JP_BEAM_TO_BARLINE;
    st.stroke.slur = mf("slurThicknessEm").unwrap_or(nan) * lyric;
    // 弧高：按物理目标反算，让「典型跨度（3 个音符步距）的弧」达到 slurArcEm × 音符字号
    {
        let note_size = note;
        let note_step = mf("noteStepEm").unwrap_or(nan);
        let typical_dist = note_step * note_size * 3.0;
        let raw_h = js_max(js_max(typical_dist, 2.0).log10() * 17.0 - 16.0, 1.2);
        st.arc.height_scale = (mf("slurArcEm").unwrap_or(nan) * note_size) / (raw_h * 0.75);
        // 弧高上下限按原书实测（× 音符字号）给，换算回引擎「控制点高」的口径（手调常量，生成物里可能没有，故兜底）
        let hs = st.arc.height_scale;
        let to_raw = |pt: f64| pt / (0.75 * hs);
        st.arc.max_height = to_raw(mf("slurMaxArcEm").unwrap_or(0.445) * note_size);
        st.arc.min_height = to_raw(mf("slurMinArcEm").unwrap_or(0.276) * note_size);
        let flat_steps = mf("slurFlatSpanSteps").unwrap_or(4.0);
        st.arc.flat_span = if flat_steps > 0.0 { note_step * note_size * flat_steps } else { -1.0 };
        // 跨度阈值在音符密的谱行上够不着，再按音符个数兜一条
        st.arc.flat_notes = mf("slurFlatNotes").unwrap_or(0.0);
        // 「看着扁不扁」按宽高比判
        st.arc.flat_ratio = mf("slurFlatRatio").unwrap_or(7.0);
        // 扁平长连音线的中段厚度取小节线宽
        st.stroke.slur_flat = barline_w * lyric;
    }
    st.stroke.slur_outline = 0.7 * (lyric / 28.0);
    st.stroke.barline = barline_w * lyric;
    st.stroke.final_barline = mf("finalBarlineWidthEm").unwrap_or(nan) * lyric;
    st.vertical.staff_dist = 0.0;
    st.vertical.system_spread = em(mf("systemGapEm").unwrap_or(nan));
    st.spacing.max_horizontal_scale = f(s, &["layout", "maxHorizontalScale"]).unwrap_or(nan);
    st.size.chord = f(s, &["roles", "chord", "size"]).unwrap_or(nan);
    st.vertical.lyric_baseline = 0.0; // 歌词基线交给引擎自算
    st.vertical.lyric_stack = em(mf("lyricToLyricEm").unwrap_or(nan)); // 多段歌词叠排，段间距取原书的行距
    st.spacing.lyric_gap = mf("lyricGapEm").unwrap_or(0.0) * lyric;
    // 反复点与房号：原书的谱面本来就有 `‖:`、`:‖`、1./2. 房，重排要照画
    st.dot.repeat = match mf("repeatDotDiam") {
        Some(d) if d > 0.0 => d / 2.0,
        _ => 0.0,
    };
    // 房号数字用三连音那一档（原书房号与三连音数字同号）
    st.size.ending = f(s, &["roles", "tuplet", "size"]).unwrap_or(nan);
    st.stroke.bracket = match mf("bracketWidth") {
        Some(w) if w > 0.0 => w,
        _ => st.stroke.barline,
    };
    // 转拍号的分数线：与书首那个拍号同一根尺子
    st.stroke.time_sig_rule = 0.3;
    st.look.verse_numbers = get_path(s, &["layout", "verseNumbers"]).and_then(Value::as_str).unwrap_or("auto").to_string();
    st.vertical.bracket_foot = match mf("bracketFootEm") {
        Some(x) if x > 0.0 => em(x),
        _ => 0.0,
    };
    st.vertical.chord_gap = em(mf("chordToNoteEm").unwrap_or(nan));
    // 原书的和弦是纯文本；样式表没写 `chord-plain` 时缺省即为真
    st.look.chord_plain = m.get("chordPlain") != Some(&Value::Bool(false));
    // 临时记号照原书的样子；样式表没写 `accidental-style` 时缺省即为 classic
    st.look.accidental_style = m.get("accidentalStyle").and_then(Value::as_str).unwrap_or("classic").to_string();
    st.look.accidental_side = m.get("accidentalSide").and_then(Value::as_str).map(str::to_string);
    st.size.section_word = f(s, &["roles", "sectionWord", "size"]).unwrap_or(nan);
    st
}

/// JS `Math.max`（有 NaN 即 NaN）。
fn js_max(a: f64, b: f64) -> f64 {
    dolce_base::js::max(a, b)
}

/// 角色引用的字体族；缺 = `serif`。
fn font_family_of(s: &Value, role: &str) -> String {
    let id = get_path(s, &["roles", role, "font"]).map(crate::value::js_to_string);
    id.and_then(|id| get_path(s, &["fonts", &id, "family"]).filter(|v| !v.is_null()).map(crate::value::js_to_string))
        .unwrap_or_else(|| "serif".to_string())
}
