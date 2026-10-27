// 成书那一份尺子：`BookStyle`（原书实测，字号已由生成脚本从墨迹高换成 font-size）→ `JianpuStyle`。
//
// 由 `style/jianpu.ts::jianpuStyleOf` 的 `book` 预设调用。
import { Font } from "../pagetree/font";
import { STACK_GAP_DEFAULT } from "../engrave/stack";
import type { JianpuStyle } from "../engrave/jianpustyle";
import type { BookStyle } from "./bookstyle";
import type { StyleRole } from "./sheet";
import { defaultJianpuStyle } from "./jianpudefault";

/** 减时线宽 ÷ 小节线宽。取自混排简谱层的 `MixedOptions.lineWidths`（jpBeam 1 : lightBarline 1.5）。 */
const JP_BEAM_TO_BARLINE = 2 / 3;

/**
 * 书籍样式 → 简谱尺子。要量字体（附点大小），所以**只能在浏览器里跑**。
 *
 * 数字上下的叠层（八度点、减时线）与各引擎同一套等距（`stack-gap`，用户定：成书也不照原书那三个不等的层距）。
 */
export function bookJianpuStyle(s: BookStyle): JianpuStyle {
  const note = s.roles.note.size;
  const lyric = s.roles.lyric.size;
  const em = (v: number) => v * note;

  // 起点与其余几档同一份出厂值，按歌词字号派生（排版器的构造字号取歌词那一档）
  const st = defaultJianpuStyle(lyric);
  const face = (role: StyleRole) => ({ family: fontFamilyOf(s, role), bold: false, italic: false });
  st.font.lyric = face("lyric");
  st.font.note = face("note");
  st.font.smufl = face("smufl");
  // 和弦、段号、转调标签量宽用的西文字取 `chord` 那档（Times）：PDF 按角色落字就是它，量宽用缺省中文字的话行首和弦收进版心时差出零点几
  st.font.text = face("chord");
  st.size.lyric = lyric;
  st.size.note = note;
  st.vertical.barlineHeight = (note * 4) / 3; // 成书小节线照字号推（−1 em / +1/3 em），不跟构造字号（歌词）
  // 成书是逐像素复刻印刷底本，字重由 BookStyle 的 roles.note 说了算，不跟编辑器那档加粗
  st.look.noteBold = false;
  st.header.title.size = s.roles.title.size;
  st.header.credit.size = s.roles.credit.size;
  st.header.subtitle.size = st.header.scripture.size = s.roles.credit.size;

  const m = s.metrics;
  st.page.margin = { left: s.page.margin.inner, right: s.page.margin.outer, top: s.page.margin.top, bottom: s.page.margin.bottom };
  // 弧 / 上方带离叠层顶的空照原书量的；叠层本身（八度点、减时线）与各引擎同一套等距（`stack-gap`）
  st.vertical.slurGap = em(m.stackGapEm);
  st.vertical.stackGap = m.stackGap ?? STACK_GAP_DEFAULT;
  // 附点也按原书那个大小：引擎默认让它与八度点同大（`.` 的墨迹高折半），
  // 而原书印的是 `·`，墨迹高出一截——照默认排全书会差出两页。
  st.dot.aug = new Font(st.font.note.family, note).charBound("·").height / 2;
  // 减时线宽**按小节线宽折算**，比例照混排的简谱层（`MixedOptions.lineWidths`：
  // jpBeam 1 : lightBarline 1.5 = 2/3）。用户口径：「成书重排减时线太细了」
  // ——原来取的是原书**实测的墨迹宽**（0.19pt 上下），那是扫描件里的一条细线，
  // 排出来几乎看不见；小节线本来就是按字号等比缩的，拿它当基准，两条线的粗细关系才稳定。
  st.stroke.beam = m.barlineWidthEm * lyric * JP_BEAM_TO_BARLINE;
  st.stroke.slur = m.slurThicknessEm * lyric;
  // 弧高：**按物理目标反算**，不是按字号等比缩。
  // 引擎的 `log10(dist)*17−16` 是 fontSize≈28 下的绝对像素，等比缩到成书的小字号
  // 会把弧压成一条平线（实测 0.42 倍时几乎看不出弧度）。
  // 这里让「典型跨度（3 个音符步距）的弧」达到 slurArcEm × 音符字号。
  {
    const noteSize = note;
    const typicalDist = m.noteStepEm * noteSize * 3;
    const rawH = Math.max(Math.log10(Math.max(typicalDist, 2)) * 17 - 16, 1.2);
    st.arc.heightScale = (m.slurArcEm * noteSize) / (rawH * 0.75);
    // 弧高的上下限按**原书实测**给（× 音符字号），再换算回引擎那个「控制点高」的口径：
    // 弧顶 ≈ 0.75 × 控制点高 × heightScale。实测 1205 条（页 40-240）：
    // 跨度 0-25pt 的弧高恒为 0.41 × 音符墨迹高（最短两桶完全相同 → 原书短弧是**定高**的），
    // 25-40 是 0.53、40-60 是 0.59、60-90 才 0.66（× 0.674 折成字号口径）。对数公式两头都失控：
    // 长跨度一路长高去顶和弦，短跨度塌成一条直线。
    // ⚠️ 这几个是**手调常量**，而歌本样式表的实测部分是 stats 生成的——生成物里
    // 可能没有这些键，不兜底的话 `rawH * undefined` = NaN（等于不封顶）、
    // `undefined > 0` = false（等于关掉扁平），整条改动会静悄悄地不生效。
    const toRaw = (pt: number): number => pt / (0.75 * st.arc.heightScale);
    st.arc.maxHeight = toRaw((m.slurMaxArcEm ?? 0.445) * noteSize);
    st.arc.minHeight = toRaw((m.slurMinArcEm ?? 0.276) * noteSize);
    const flatSteps = m.slurFlatSpanSteps ?? 4;
    st.arc.flatSpan = flatSteps > 0 ? m.noteStepEm * noteSize * flatSteps : -1;
    // 跨度那条阈值是物理宽度，音符密的谱行上够不着（91《我灵镇静》罩着五六个十六分音符
    // 的弧，跨度还不到 4 个音符步距）。再按**音符个数**兜一条。
    st.arc.flatNotes = m.slurFlatNotes ?? 0;
    // 「看着扁不扁」按宽高比判（跨度 ÷ 弧顶高）——绝对跨度那条阈值跟不上字号与弧高上限
    st.arc.flatRatio = m.slurFlatRatio ?? 7;
    // 扁平长连音线的中段厚度取**小节线宽**：按弧厚折算（× 0.45）在成书的小字号下
    // 显得太肥，长长一条粗线很扎眼。
    st.stroke.slurFlat = m.barlineWidthEm * lyric;
  }
  st.stroke.slurOutline = 0.7 * (lyric / 28);
  st.stroke.barline = m.barlineWidthEm * lyric;
  st.stroke.finalBarline = m.finalBarlineWidthEm * lyric;
  // 谱行净距：layout 用 staffDist（行间额外间距）与 maxLineDist（页内均分上限）表达
  st.vertical.staffDist = 0;
  st.vertical.systemSpread = em(m.systemGapEm);
  st.spacing.maxHorizontalScale = s.layout.maxHorizontalScale;
  st.size.chord = s.roles.chord.size;
  st.vertical.lyricBaseline = 0; // 歌词基线交给引擎自算（覆盖它会把带减时线的行推歪）
  st.vertical.lyricStack = em(m.lyricToLyricEm); // 多段歌词叠排，段间距取原书的行距
  st.spacing.lyricGap = (m.lyricGapEm ?? 0) * lyric; // 歌词字距（排版器自己只保证不重叠）
  // 反复点与房号：原书的谱面本来就有 `‖:`、`:‖`、1./2. 房，重排要照画
  st.dot.repeat = m.repeatDotDiam > 0 ? m.repeatDotDiam / 2 : 0;
  // 房号数字用**三连音那一档**：原书房号与三连音数字同号（墨迹高 4.92pt，
  // 对应 musicxml 里 `<ending font-size="6.25">`）。verseNum 是歌词那么大的段号，会大三倍。
  st.size.ending = s.roles.tuplet.size;
  // 房号/三连音括线：线宽与「脚」长都用原书量到的（inventory 的 bracket 那一类，n=233）
  st.stroke.bracket = m.bracketWidth && m.bracketWidth > 0 ? m.bracketWidth : st.stroke.barline;
  // 转拍号的分数线：与书首那个拍号同一根尺子（bookparts.ts::keyMeterItems 画的 rect h=0.3）
  st.stroke.timeSigRule = 0.3;
  st.look.verseNumbers = s.layout.verseNumbers ?? "auto";
  st.vertical.bracketFoot = m.bracketFootEm && m.bracketFootEm > 0 ? em(m.bracketFootEm) : 0;
  st.vertical.chordGap = em(m.chordToNoteEm);
  // 原书的和弦是纯文本（见 engrave/chord.ts）；样式表没写 `chord-plain` 时缺省即为真
  st.look.chordPlain = m.chordPlain !== false;
  // 临时记号照原书的样子（五线谱升降号挂在数字左上），样式表没写 `accidental-style` 时缺省即为 classic
  st.look.accidentalStyle = m.accidentalStyle ?? "classic";
  st.look.accidentalSide = m.accidentalSide;
  st.size.sectionWord = s.roles.sectionWord.size;
  return st;
}

function fontFamilyOf(s: BookStyle, role: StyleRole): string {
  const id = s.roles[role]?.font;
  return s.fonts[id]?.family ?? "serif";
}
