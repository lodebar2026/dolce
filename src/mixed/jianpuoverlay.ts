// 混排的**简谱叠层**：压在五线谱第一子谱表上方的那一行简谱（`1=X`、拍号、数字、临时记号、八度点、附点/增时线、减时线）。
// 从 musicpp model/render.cpp 的 Mixed 分支移植（印哪个音、唱名/八度/临时记号/减时线条数改从语义层 `model/jianpu.ts` 取）；五线谱层在 `render.ts`，两层只经 `SysStaff.minY`（叠层带的位置）相接。
//
// **逐音成柱**：每个音一个 `<g>`，里面依次是临时记号、数字、八度点、附点或增时线；减时线是跨音的，各柱画完再画。
// 原先照 musicpp 按遍画（先整小节的数字、再整小节的临时记号、再减时线），页面树不同、画出来的像素一致
// （`scripts/mixed-pixel-dump.mjs` 基线逐页比过）。

import { Fraction } from "../common/fraction";
import { Matrix33 } from "../common/geom";
import { GraphicPath, Group, TextFrame } from "../pagetree/pageitem";
import { Font } from "../pagetree/font";
import { textItem } from "../engrave/prims";
import { jpDot } from "../engrave/dot";
import { TimeSigGlyph } from "../engrave/timesig";
import { KeyLabel, keyNameOfFifths } from "../engrave/keysig";
import { sustainDash } from "../engrave/dash";
import { AccidentalGlyph } from "../engrave/accidental";
import { beamY, highDotY, lowDotY, stackBottom } from "../engrave/stack";
import { graceRow, mainRow, melodyNote } from "./jprow";
import { graceHook } from "../engrave/grace";
import { augDotCenter } from "../engrave/augdot";
import {
  ChordLayout,
  PartMeasureLayout,
  MeasureLayout,
  MixedOptions,
  NoteLayout,
  PartStaff,
  Sys,
  SysStaff,
} from "./model";
import { addLine, chordGroup, translated } from "./prims";

const BLACK = 0xff000000;

/** 一个小节的简谱叠层。`grp` 是这个小节在五线谱层里的组（原点在谱表顶线、小节左缘）。 */
export function drawJianpuOverlay(grp: Group, sys: Sys, st: SysStaff, m: MeasureLayout): void {
  const scr = sys.score;
  const eng = scr.options;
  const ps = st.partStaff;
  const md = ps.part.measures[m.index];
  if (!md) return;
  const jpOffY = st.minY - eng.mixStaffDist - eng.mixStaffHeight;
  const grpJp = translated(0, jpOffY);
  grp.add(grpJp);

  // jianpu key「1=X」at first measure overall or on key change (drawn in main group)
  if (eng.showKeyChangeJp && (m.index === 0 || ps.keyChange(m.offset)) && m.keyPos !== null) {
    drawJpKey(eng, grp, m, ps, st);
  }

  // jp 拍号：曲首及任何拍号变更处（对齐 render.cpp drawSysStaff mixed 分支，
  // 条件统一为 timeChange——layoutAttr 仅在变更时分配 timePos）。
  if (ps.timeChange(m.offset) && m.timePos !== null) {
    drawJpTimeSignature(eng, grpJp, m, ps, m.timePos);
  }
  // 系统末尾的预告拍号（下一系统起始的新拍号）——与主谱 trailing 一致，
  // 对齐 render.cpp:2361-2363 的 if(mixed) drawTime(...Mixed...)。
  if (
    m === sys.measures[sys.measures.length - 1] &&
    sys.timeChangeWidth > 0 &&
    m.index + 1 < scr.measures.length
  ) {
    const next = scr.measures[m.index + 1];
    drawJpTimeSignature(eng, grpJp, next, ps, m.width - sys.timeChangeWidth);
  }

  for (const ch of md.chords) {
    for (const n of ch.notes) {
      const col = chordGroup(ch.src.id); // 带身份标签：播放线、点选按它认（`prims.ts::chordGroup`）
      const alt = accidentalOf(ch, n, ps.subIndex);
      if (alt !== null) drawAccidental(eng, col, md, ch, n, alt);
      drawColumn(eng, col, md, ch, n, ps.subIndex);
      if (col.children.length) grpJp.add(col);
    }
  }
  drawJpBeams(eng, grpJp, md);
}

/** 这个音在简谱层要印的临时记号：语义层按旋律延续算好的（`Degree.accidental`），不照搬 MusicXML 的 <accidental>。 */
function accidentalOf(ch: ChordLayout, n: NoteLayout, subStaff: number): number | null {
  // 与 `drawColumn` 同一组条件：不画数字的音（slash、cue）也不印升降号
  if (ch.rest || ch.slash || ch.cue || n.staff !== subStaff || !n.visible || !n.jpMelody || n.x < 0) return null;
  return n.jpAccidental();
}

/** 临时记号：画法与定位走公共那一份（engrave/accidental.ts：csym 字形、贴数字墨迹盒左缘）。
 *  数字的落点与 `drawColumn` 同一套（倚音缩小并上移，升降号跟着它的数字走）。 */
function drawAccidental(eng: MixedOptions, col: Group, md: PartMeasureLayout, ch: ChordLayout, n: NoteLayout, alt: number): void {
  const font = eng.mixFont;
  const str = String(n.number());
  const row = ch.grace ? graceRow(eng, md, ch) : mainRow(eng);
  const digit = { font, text: str, x: n.cx(eng.meta) - font.measureText(str) / 2, y: row.y, scale: row.scale };
  const kind = alt > 0 ? "sharp" : alt < 0 ? "flat" : "natural";
  col.add(new AccidentalGlyph(kind, digit, { music: eng.musicFont, color: BLACK, meta: eng.meta, kind: eng.accidentalStyle, scale: eng.accidentalScale }).item);
}

/** 一个音的数字、八度点、增时线或附点（render.cpp::drawNotesJianPu）。 */
function drawColumn(eng: MixedOptions, col: Group, md: PartMeasureLayout, ch: ChordLayout, n: NoteLayout, subStaff: number): void {
  if (ch.slash) return;
  if (n.staff !== subStaff) return;
  if (!n.visible) return;
  if (!n.jpMelody) return;
  if (ch.cue) return;
  const font = eng.mixFont;
  const mif = md.measureInfo;

  let x: number;
  let measureRest = false;
  if (ch.rest) {
    if (ch.measureRest) measureRest = true;
    if (ch.dur.compareTo(mif.dur) === 0) measureRest = true;
  }

  if (measureRest) {
    x = mif.dataPos + 5;
    // 宽小节再右移 10（render.cpp:834-839）。
    const dataWidth = mif.dataEnd - mif.dataPos;
    const numw = font.measureText("0") * mif.dur.toInt();
    if (dataWidth > 2 * numw) x += 10;
  } else {
    x = n.cx(eng.meta);
    if (n.x < 0) return;
  }

  const num = n.number();
  const str = String(num);
  const nw = font.measureText(str);
  x -= nw / 2;

  // 数字与它那一摞的落点（倚音缩小、整块抬到主音那一摞之上，见 graceRow）
  const row = ch.grace ? graceRow(eng, md, ch) : mainRow(eng);
  const ypos = row.y;
  if (ch.grace) {
    const g = new Group();
    const mtx = new Matrix33();
    mtx.setAffine([row.scale, 0, 0, row.scale, x, ypos]);
    g.matrix = mtx;
    g.add(textAt(str, font, 0, 0));
    col.add(g);
  } else {
    col.add(textAt(str, font, x, ypos));
  }

  // 八度点：**实心矢量圆**，落点走公共那一份（engrave/stack.ts：墨迹到墨迹等距，低音点挂在减时线之下），
  // 横向对准数字的墨迹中心
  const oct = n.octaveJp();
  if (oct !== 0) {
    const db = font.charBound(str);
    const cx0 = x + ((db.left + db.right) / 2) * row.scale;
    for (let i = 0; i < Math.abs(oct); i++) {
      const cy0 = oct > 0 ? highDotY(row.inkTop, i, row.st) : lowDotY(row.inkBottom, ch.jpBeamCount(), i, row.st);
      col.add(jpDot(cx0, cy0, row.st.dotRadius, BLACK));
    }
  }

  if (ch.noteType.compareTo(new Fraction(1)) > 0) {
    // 长于四分音符：增时线（休止写 0）
    const end = ch.dur.plus(ch.offset);
    const endPos = mif.getEntPos(end);
    // 截断取整（对齐 boost::rational_cast<int>），整小节休止用小节时值分子（render.cpp:920-923）。
    let cnt = ch.dur.toInt();
    if (measureRest) cnt = mif.dur.numerator;
    const dx = cnt > 0 ? (endPos - x) / cnt : 0;
    // 增时线走公共那一份（engrave/dash.ts）：墨心对准该拍「数字」的墨心、纵向落在数字墨迹中线上
    const dig = font.charBound(str);
    const midY = ypos + (dig.top + dig.bottom) / 2;
    for (let c = 1; c < cnt; c++) {
      if (ch.rest) col.add(textAt("0", font, x + dx * c, ypos));
      else col.add(sustainDash(x + dx * c + nw / 2, midY, { font, color: BLACK }));
    }
  } else {
    // 附点：**实心矢量圆**，落点走公共那一份（engrave/augdot.ts：与数字墨迹中心等高，离数字墨迹右缘一道空）
    const digitInk = font.charBound(str).offset(x, ypos);
    for (let d = 0; d < ch.dot; d++) {
      const p = augDotCenter(digitInk, d, row.st.dotRadius, row.st.gap);
      col.add(jpDot(p.cx, p.cy, row.st.dotRadius, BLACK));
    }
  }
}

const textAt = (text: string, font: Font, x: number, y: number): TextFrame => textItem(text, font, BLACK, x, y);

/** 减时线（render.cpp::BeamLevelData::drawJianPu）：跨音的，各柱画完再画。 */
function drawJpBeams(eng: MixedOptions, container: Group, md: PartMeasureLayout): void {
  const font = eng.mixFont;
  const meta = eng.meta;

  for (const grp of md.jpBeams) {
    if (grp.chords.length === 0) continue;
    // skip cue groups
    if (grp.chords.some((ch) => ch.cue)) continue;

    for (let lev = 0; lev < 10; lev++) {
      // 收集本层的连续减时线段（render.cpp:32-58 processLevelJp）——同层可有多段，
      // 不能用全局首/尾连成一条。
      const runs: [ChordLayout, ChordLayout][] = [];
      let start: ChordLayout | null = null;
      let end: ChordLayout | null = null;
      for (const ch of grp.chords) {
        if (ch.jpBeamCount() <= lev) {
          if (start && end) runs.push([start, end]);
          start = null;
          end = null;
          continue;
        }
        if (!start) start = ch;
        end = ch;
      }
      if (start && end) runs.push([start, end]);
      if (runs.length === 0) break;

      for (const [first, last] of runs) {
        const ntL = first.notes.find((n) => n.jpMelody) ?? first.notes[0];
        const ntR = last.notes.find((n) => n.jpMelody) ?? last.notes[0];

        const grace = first.grace;
        const graceSc = grace ? eng.jpGraceScale : 1;
        const numL = ntL.number();
        const numR = ntR.number();
        // 端点 = 数字的笔位左缘到右缘（与 drawColumn 画数字同一个笔位：拍位中心 − 数字宽/2，倚音从那儿起整体缩放）
        const lx = ntL.x + first.noteheadWidth(meta) / 2 - font.measureText(numL) / 2;
        const rx = ntR.x + last.noteheadWidth(meta) / 2 - font.measureText(numR) / 2 + font.measureText(numR) * graceSc;
        // 纵向走公共那一份（engrave/stack.ts：数字墨迹底 →空→ 第 1 层 →空→ 第 2 层…）
        const row = grace ? graceRow(eng, md, first) : mainRow(eng);
        const y = beamY(row.inkBottom, lev + 1, row.st);

        addLine(container, lx, y, rx, y, row.st.beamWidth);
      }
    }
    if (grp.chords[0]!.grace) drawGraceHook(eng, container, md, grp.chords);
  }
}

/** 倚音的尾钩：一串只画一个，挂在离主音最近的那个倚音下面（前倚音是最后一个、后倚音是第一个），
 *  弯向主音——形状与简谱引擎同一笔（engrave/grace.ts::graceHook）。有低音点就从最低那个点下面再让一道空起笔，
 *  否则从最下一条减时线垂下来。 */
function drawGraceHook(eng: MixedOptions, container: Group, md: PartMeasureLayout, chords: ChordLayout[]): void {
  const after = chords[0]!.src.grace?.after === true;
  const ch = after ? chords[0]! : chords[chords.length - 1]!;
  const nt = melodyNote(ch);
  const font = eng.mixFont;
  const num = nt.number();
  const mid = nt.x + ch.noteheadWidth(eng.meta) / 2 - font.measureText(num) / 2 + (font.measureText(num) * eng.jpGraceScale) / 2;
  const row = graceRow(eng, md, ch);
  const beams = ch.jpBeamCount();
  const low = Math.max(0, -nt.octaveJp());
  const from = low > 0 ? stackBottom(row.inkBottom, beams, low, row.st) + row.st.gap : beamY(row.inkBottom, beams, row.st);
  const h = graceHook(mid, from, row.inkBottom - row.inkTop, after ? -1 : 1);
  const hook = new GraphicPath();
  hook.fill = false;
  hook.stroke = true;
  hook.strokeColor = BLACK;
  hook.strokeWidth = row.st.beamWidth;
  hook.moveTo(h.m[0], h.m[1]);
  hook.cubicTo(...h.c);
  container.add(hook);
}

/** Draw time signature for jp/mixed staff（render.cpp::drawTime Mixed branch）。 */
function drawJpTimeSignature(
  eng: MixedOptions,
  container: Group,
  mif: MeasureLayout,
  ps: PartStaff,
  x: number,
): void {
  const time = ps.getTime(mif.offset);
  const staffHeight = eng.mixStaffHeight;
  const font = eng.mixFont;

  const grp = translated(x, 0);

  // KL2020 参考成品由 musicpp 生成：数字不横向居中，分数线按实际数字 advance
  // 加 2 tenths，基线也沿用 render.cpp::drawTime 的旧公式。此兼容档只由该歌本
  // 的 @staff 打开；其他混排/简谱继续使用下面的共用拍号原语。
  if (eng.musicppJpTimeSig) {
    const sc = staffHeight / 40;
    // render.cpp 先把 descent 乘 sc，随后整个 (20-dy)/(40+dy) 又乘一次 sc。
    const dy = eng.jianpuFont.metrics.descent * sc;
    const top = new TextFrame();
    top.text = String(time.beats);
    top.font = font;
    top.color = BLACK;
    top.y = sc * (20 - dy);
    const bottom = new TextFrame();
    bottom.text = String(time.beatType);
    bottom.font = font;
    bottom.color = BLACK;
    bottom.y = sc * (40 + dy);
    const rule = new GraphicPath();
    rule.fill = false;
    rule.stroke = true;
    rule.strokeColor = BLACK;
    rule.strokeWidth = 1.5;
    rule.moveTo(-1, staffHeight / 2);
    rule.lineTo(Math.max(font.measureText(top.text), font.measureText(bottom.text)) + 1, staffHeight / 2);
    grp.add(top);
    grp.add(bottom);
    grp.add(rule);
    container.add(grp);
    return;
  }

  // 拍号走公共那一份（engrave/timesig.ts::TimeSigGlyph）：两个数字**横向居中**于分数线，
  // 一切长度按**小节线高度**的比例。原先这里两个数字都贴 x=0 左对齐、纵向按 musicpp
  // 的 staff space 常量（`sc*(20−dy)` / `sc*(40+dy)`）给，与谱面、文本谱三处口径各不相同。
  //
  // 基准高度取这条谱表的高（简谱层的小节线就是这么高），基线取谱表底——
  // TimeSigGlyph 里的 y 都是相对基线的，谱表顶 y=0 故基线在 staffHeight。
  const r = new TimeSigGlyph(time.beats, time.beatType, {
    height: staffHeight,
    centerY: staffHeight / 2 - staffHeight,
    ruleWidth: 1.5,
    color: 0xff000000,
    font,
    // 混排的拍号数字**保留原大小**：musicpp 的 mixFont 就是 `30 × mixStaffHeight/40`，
    // 即 0.75 H（谱面那一路是 0.5625 H）。居中与「长度按 H 的比例」照统一那份走，
    // 只有字号与下面三档间距各留各的。
    digitRatio: 0.75,
    // 竖向不必给：`TimeSigGlyph` 按「减时线与音符」那一格排（TIME_SIG_GAP_EM ×
    // 拍值字号，墨迹到墨迹），字号一改自己跟着走。
    //
    // 分数线长度得给：默认那个 0.28125 H 是按谱面档的数字（0.5625 H）反算的，
    // 配 0.75 H 的数字线比数字还窄，整条藏在数字底下。musicpp 原式是
    // `max(w1,w2) + 2`（mixFont 22.5 的数字 advance ≈ 12.4，共 14.4 = 0.48 H），
    // 与参考排版（Praise as One 成书 PDF）量到的 14.4 一致。
    ruleLengthRatio: 0.48,
  });
  for (const item of r.items) {
    item.y += staffHeight;
    grp.add(item);
  }
  container.add(grp);
}

/** Draw jianpu key indicator「1=X」for jp/mixed staff（render.cpp::drawKey JianPu/Mixed 分支）。 */
function drawJpKey(
  eng: MixedOptions,
  container: Group,
  mif: MeasureLayout,
  ps: PartStaff,
  st: SysStaff,
): void {
  const key = ps.getKey(mif.offset);

  let x = (mif.keyPos ?? 0) - mif.sibKeyOffset;
  if (mif.keyOffestJP !== null) x += mif.keyOffestJP;
  let center = true;
  if (mif === mif.system.measures[0]) {
    center = false;
    x = 0;
  }

  // y relative to main staff top line (negative = above); Mixed branch
  let y = -70;
  if (mif.index === 0) y -= 30; // 避开和弦
  else y = -st.harmonyY;

  // 混排谱表上的简谱以 mixFont（按 mixStaffHeight 缩小）排号，转调记号同步用 mixFont，
  // 否则 jianpuFont(30) 比谱面数字(22.5)明显偏大。render.cpp drawKey 用 jianpuFont 是因其
  // 混排谱高为 40；此处随谱高等比缩放。
  // 画法走公共那一份（engrave/keysig.ts）：升降号是 csym 字形（render.cpp::drawKey 的
  // accidentalSym(acc, true)），写在音名之前并抬高。
  const jpFont = eng.jpKeyJianpuFont ? eng.jianpuFont : eng.mixFont;
  const k = new KeyLabel("1", keyNameOfFifths(key.fifths), {
    font: jpFont,
    music: eng.musicFont,
    color: 0xff000000,
    prefix: mif.index !== 0 ? "转" : "",
    side: eng.accidentalSide,
  });
  if (center) x -= k.width / 2;
  const grp = translated(x, y);
  for (const it of k.items) grp.add(it);
  container.add(grp);
}
