// 混排渲染器。从 musicpp model/render.cpp 移植。
// 输入：StaffLayout（已排版）；输出：Group（含 GraphicLine/TextFrame）。
// 单位：tenths（与 StaffLayout 一致）。
// SMuFL 字形用 TextFrame + font.family="Bravura"（等价 SmuflText）。

import { Fraction } from "../common/fraction";
import { punctClass } from "../common/cjkpunct";
import { Matrix33, Point } from "../common/geom";
// `Slur` 这个名字在 model.ts 里是**跨度对象**（哪两个音符之间有弧），
// layout.ts 里的是**画出来的那条弧**，所以起个别名区分。
import { GraphicPath, Group, TextFrame } from "../pagetree/pageitem";
import { Slur as SlurArc } from "../engrave/arc";
import { GlyphCodes } from "../smufl/smufl";
import { fillRect } from "../engrave/prims";
import { BarStyle } from "../score/enums";
import {
  LegerLayout,
  BarGlyph,
  BeamVal,
  ClefSig,
  Ending,
  GroupSymbol,
  LCR,
  LrcExtend,
  MeasureLayout,
  PartMeasureLayout,
  MeasureText,
  MixedOptions,
  PartLayout,
  LyricLayout,
  Notation,
  PedalLine,
  OctaveLine,
  Slur,
  Sys,
  SysStaff,
  Tied,
  TimeSig,
  Tuplet,
  Wedge,
  ARPEGGIO_LEAD,
  mixedSlurStyle,
  fGe,
  fLt,
  smuflWidth,
  slurEnds,
  tiedEnds,
  harmonyBand,
  type HarmonyLayout,
  type StaffLayout,
} from "./model";
import { Font } from "../pagetree/font";
import { addEndingBracket } from "../engrave/ending";
import { BarlineGlyph, type BarlineSpec } from "../engrave/barline";
import { TupletGlyph } from "../engrave/tuplet";
import { hairpinPath } from "../engrave/hairpin";
import { arpeggioGroup } from "../engrave/arpeggio";
import { chordTextSegs, harmonyWidth, layoutHarmonySegs } from "../engrave/chord";
import { addLine, addSmufl, addSmuflScaled, chordGroup, STAFF_SYSTEM, translated, type StaffChordData, type StaffSystemData } from "./prims";
import type { ItemIdentity } from "../pagetree/identity";
import { drawJianpuOverlay } from "./jianpuoverlay";

/** SMuFL breathMarkComma（U+E4CE）。 */
const BREATH_COMMA = String.fromCharCode(0xe4ce);

function addFilledQuad(
  g: Group,
  lx: number, ly: number,
  rx: number, ry: number,
  thick: number,
): void {
  const p = new GraphicPath();
  p.fill = true;
  p.stroke = false;
  p.fillColor = 0xff000000;
  p.moveTo(lx, ly);
  p.lineTo(lx, ly + thick);
  p.lineTo(rx, ry + thick);
  p.lineTo(rx, ry);
  p.close();
  g.add(p);
}

/** 断奏楔（staccatissimo）照 Sibelius 出的谱（八段锦二胡、中胡原 PDF）画实心三角：宽 0.54 格、高 0.77 格，尖朝符头。
 *  Bravura 的 articStaccatissimo 是 0.4×1.17 格的瘦高楔，Wedge 变体也一样瘦，排出来像一道竖线。
 *  (`cx`, `y`) 是字形原点口径：朝上（印在音上方）的从 y 往上画、尖在下；朝下的从 y 往下画、尖在上 */
const WEDGE_W = 5.4, WEDGE_H = 7.7;
function drawStaccatissimo(g: Group, cx: number, y: number, above: boolean): void {
  const p = new GraphicPath();
  p.fill = true;
  p.stroke = false;
  p.fillColor = 0xff000000;
  const base = above ? y - WEDGE_H : y + WEDGE_H;
  p.moveTo(cx - WEDGE_W / 2, base);
  p.lineTo(cx + WEDGE_W / 2, base);
  p.lineTo(cx, y);
  p.close();
  g.add(p);
}

// -----------------------------------------------------------------------
/** 多小节休止：谱表中线上一道粗横杠（两头竖线从第二线到第四线），谱表上方印小节数。
 *  数字照 Sibelius 出的谱（八段锦钢片琴原 PDF）用正文衬线体的普通字重、高约 1.8 格，基线在顶线上方 0.4 格；
 *  原来用 SMuFL 拍号数字（粗、矮）。谱表坐标同别处：顶线 y=0、往下每格 10。横杠占满这一小节、两头各让 1.5 格 */
const MULTIREST_NUM_SIZE = 27;
function drawMultiRest(g: Group, mif: MeasureLayout, eng: MixedOptions): void {
  const x0 = mif.dataPos + 15, x1 = mif.getEntPos(mif.dur) - 15;
  if (x1 <= x0) return;
  g.add(fillRect(0xff000000, x0, 15, x1 - x0, 10));
  addLine(g, x0, 10, x0, 30, eng.lineWidths.stem * 1.5);
  addLine(g, x1, 10, x1, 30, eng.lineWidths.stem * 1.5);
  const t = new TextFrame();
  t.text = String(mif.multiRest);
  t.font = new Font(eng.wordFont, MULTIREST_NUM_SIZE);
  t.color = 0xff000000;
  t.x = (x0 + x1) / 2 - t.font.measureText(t.text) / 2;
  t.y = -4;
  g.add(t);
}

/**
 * 全音符的震音斜线，照 Sibelius 出的谱（八段锦扬琴原 PDF 600 dpi 量的，单位 tenths、一个线距 = 10）：
 * 每道是左右两边竖直的平行四边形，横宽 12.4、中心线左低右高升 5.3、竖向厚 3、相邻两道竖向间距 4.5——
 * 比 Bravura 的 tremolo1–4 字形陡、窄（那个只升约 2，排出来几乎是平的）。`x0` 是左缘，(`cy`) 是整块的竖向中心。
 */
/** 全音符震音一道斜线的横宽（tenths） */
const WHOLE_TREMOLO_W = 12.4;
function drawWholeTremolo(g: Group, n: number, x0: number, cy: number): void {
  const W = WHOLE_TREMOLO_W, R = 5.3, T = 3, S = 4.5;
  for (let i = 0; i < n; i++) {
    const y = cy + (i - (n - 1) / 2) * S;
    addFilledQuad(g, x0, y + R / 2 - T / 2, x0 + W, y - R / 2 - T / 2, T);
  }
}

/** 震音字形按墨迹中心摆到 (`cx`, `cy`) */
function drawTremolo(g: Group, meta: { getBBox(glyph: string): { bBoxSW: number[]; bBoxNE: number[] } | null | undefined }, glyph: string, cx: number, cy: number, fs: number): void {
  const bb = meta.getBBox(glyph);
  const ox = bb ? ((bb.bBoxSW[0] + bb.bBoxNE[0]) / 2) * 10 : 0;
  const oy = bb ? -((bb.bBoxSW[1] + bb.bBoxNE[1]) / 2) * 10 : 0;
  addSmufl(g, glyph, cx - ox, cy - oy, fs);
}

// drawNotesNormal（render.cpp:953 drawNotesNormal + drawChord stem/flag）

export function drawNotesNormal(
  eng: MixedOptions,
  container: Group,
  md: PartMeasureLayout,
  subStaff: number,
): void {
  const fs = eng.musicFont.size;
  const meta = eng.meta;

  // ---- noteheads, rests, stems, flags ----
  // 每个和弦收进一个带元素 id 的组（`chordGroup`），编辑器放播放线、认点选用；有东西画才建
  for (const ch of md.chords) {
    const code = ch.sym();
    if (!code) continue;
    let cg: Group | null = null;
    /** 符头中心（`StaffChordData`），画完符头才知道；之后才建的组（只有符干的）建时带上 */
    let head: StaffChordData | null = null;
    const chordGrp = (): Group => {
      if (!cg) {
        cg = chordGroup(ch.src.id);
        cg.data = head;
        container.add(cg);
      }
      return cg;
    };

    let headL = Infinity;
    let headR = -Infinity;
    for (const n of ch.notes) {
      if (n.staff !== subStaff) continue;
      if (!n.visible) continue;

      let x: number;
      const cue = n.size === 1 || ch.cue || ch.grace;
      const scale = ch.grace ? eng.graceSize : cue ? eng.cueSize : 1;

      // 并过的多小节休止那一小节只剩一个休止（123 的 `Z` 带着 `whole` 时值，不算 measureRest，按小节认）
      if (ch.rest && md.measureInfo.multiRest > 1) {
        drawMultiRest(chordGrp(), md.measureInfo, eng);
        continue;
      }
      if (ch.measureRest) {
        const mif = md.measureInfo;
        const endPos = mif.getEntPos(mif.dur);
        x = (mif.dataPos + endPos) / 2 - 7;
      } else {
        x = n.x;
        if (cue) {
          x = ch.stemX();
          if (!n.rightSide()) x -= smuflWidth(meta, code) * scale;
          if (ch.noteType.compareTo(new Fraction(4)) >= 0) x += 5;
        }
        if (x < 0) continue;
      }

      let y = n.cy();
      if (code === GlyphCodes.restWhole) y -= 10;

      if (scale !== 1) {
        addSmuflScaled(chordGrp(), code, x, y, fs, scale, scale);
      } else {
        addSmufl(chordGrp(), code, x, y, fs);
      }
      headL = Math.min(headL, x);
      headR = Math.max(headR, x + smuflWidth(meta, code) * scale);
      // 倚音不进 NoteEntry（不参与同拍对齐），加线在这里按它自己的小号符头补画——
      // 否则 `{5,,}` 这种落到谱表外的倚音悬在半空
      if (ch.grace && !ch.rest) {
        const leg = new LegerLayout();
        leg.addNote(n.line(), x, x + smuflWidth(meta, code) * scale);
        for (const [ledgerLine, [lx1, lx2]] of leg.ranges) {
          const ly = -ledgerLine * 5;
          addLine(chordGrp(), lx1 - 3 * scale, ly, lx2 + 3 * scale, ly, eng.lineWidths.leger);
        }
      }
    }

    // 跨谱表的和弦，这一行谱只画符干、没有符头：按别的谱行上的符头取（横坐标与谱行无关）
    if (!(headR > headL)) {
      for (const n of ch.notes) {
        if (!n.visible || ch.measureRest || n.x < 0) continue;
        headL = Math.min(headL, n.x);
        headR = Math.max(headR, n.x + smuflWidth(meta, code));
      }
    }
    if (headR > headL) head = { cx: (headL + headR) / 2 };
    if (cg && head) (cg as Group).data = head;

    // stem and flag (skip rests, whole notes, half notes with beams)
    if (ch.rest) continue;
    // 单音震音（`<tremolo type="single">`）：tremolo1–4 字形压在符干中段。全音符没有符干：照 Sibelius 出的谱（八段锦原 PDF，用户定照原谱）
    // 画在假想符干那一侧：斜线组中心在符干起端的音头（符干朝下是最高的头，朝上是最低的头）往符干方向 1 格、音头中心右边约 1.7 格；
    // 斜线照原谱自己画（`drawWholeTremolo`）。九份分谱量下来原谱逐处手调过（竖向 −0.5～2 格、横向 1.1～2.3 格），取多数：
    // 二胡/高胡/琵琶在下方 1～1.5 格，和音（中阮 m92）落在两头之间；扬琴几处与音头齐平，对不上。
    // GB/T 46846 7.8.3.3 b) 是居中画在假想符干上（音头正上 / 正下方），没照它
    const strokes = ch.src.notations?.tremolo;
    const tremolo = strokes ? [GlyphCodes.tremolo1, GlyphCodes.tremolo2, GlyphCodes.tremolo3, GlyphCodes.tremolo4][Math.min(4, strokes) - 1]! : "";
    if (ch.noteType.compareTo(new Fraction(4)) >= 0) {
      if (tremolo && headR > headL) {
        // 全音符的 `stemUp` 没按音高算过：照符干方向的通则，离中线（谱表内 y = 20）最远的音在中线之上就朝下
        const ys = ch.notes.map((n) => n.cy() - md.staffY(subStaff));
        const up = 20 - Math.min(...ys) <= Math.max(...ys) - 20;
        // 原文记了位置的（`tremoloPos`，斜线墨迹中心相对符头左缘 / 谱表顶线）照它画
        const at = ch.src.notations?.tremoloPos;
        if (at) drawWholeTremolo(chordGrp(), Math.min(4, strokes!), headL + at.x - WHOLE_TREMOLO_W / 2, -at.y);
        else drawWholeTremolo(chordGrp(), Math.min(4, strokes!), headR + 2.5, up ? Math.max(...ys) - 10 : Math.min(...ys) + 10);
      }
      continue; // whole: no stem
    }

    const sx = ch.stemX();
    // stemY local = stemY() - md.staffY(subStaff) but for sub=0 staffY=0
    const sy = ch.stemY() - md.staffY(subStaff);
    // 符干末端含 stemExtra（render.cpp:401-406：跨谱表符杠延伸符干以接到符杠）。
    const extra = ch.stemUp ? -ch.stemExtra : ch.stemExtra;
    const ty = ch.tailY(true) + extra - md.staffY(subStaff);

    // flag (only if unbeamed)
    if (ch.beams.length === 0) {
      const flagCode = ch.tailSym(ch.stemUp);
      if (flagCode) {
        // 符尾与音符头同一个缩放（倚音也是小号，原先只认 cue，倚音的符尾是整号的、垂过音符头）
        const scale = ch.grace ? eng.graceSize : ch.cue || ch.notes.some((n) => n.size === 1) ? eng.cueSize : 1;
        // 按 SMuFL 锚点接到符干末端（`stemUpNW` / `stemDownSW`），不是拿字形原点硬对
        const anc = meta.getAnchor(flagCode);
        const a = (ch.stemUp ? anc?.stemUpNW : anc?.stemDownSW) ?? [0, 0];
        const sp = (fs / 4) * scale;
        const fx = sx - a[0] * sp;
        const fy = ty + a[1] * sp;
        if (scale !== 1) {
          addSmuflScaled(chordGrp(), flagCode, fx, fy, fs, scale, scale);
        } else {
          addSmufl(chordGrp(), flagCode, fx, fy, fs);
        }
        // 短倚音（`<grace slash="yes">`）：符尾上那道斜线，两端照 SMuFL 锚点 graceNoteSlashSW/NE（向上）、NW/SE（向下）
        if (ch.src.grace?.slash) {
          const p0 = ch.stemUp ? anc?.graceNoteSlashSW : anc?.graceNoteSlashNW;
          const p1 = ch.stemUp ? anc?.graceNoteSlashNE : anc?.graceNoteSlashSE;
          if (p0 && p1) {
            addLine(chordGrp(), fx + p0[0] * sp, fy - p0[1] * sp, fx + p1[0] * sp, fy - p1[1] * sp, eng.lineWidths.stem);
          }
        }
      }
    }

    addLine(chordGrp(), sx, sy, sx, ty, eng.lineWidths.stem);
    // 符干上离符头 3/5 处（偏符干末端，躲开符头与符杠）
    if (tremolo) drawTremolo(chordGrp(), meta, tremolo, sx, sy + (ty - sy) * 0.6, fs);
  }

  // ---- notations (fermata 等) —— render.cpp:328 drawChord 非简谱分支 ----
  for (const ch of md.chords) {
    if ((ch.notations.length === 0 && !ch.breath) || ch.notes.length === 0) continue;
    if (ch.notes[0].staff !== subStaff) continue;
    const stemX = ch.stemX();
    // 换气：SMuFL 逗号（breathMarkComma），符头右边一格、谱表第一线之上半格
    if (ch.breath) {
      const left = ch.stemUp && ch.noteType.compareTo(new Fraction(4)) < 0 ? stemX - ch.noteheadWidth(meta) : stemX;
      addSmufl(container, BREATH_COMMA, left + ch.noteheadWidth(meta) + 8, -5, fs);
    }
    for (const nota of ch.notations) {
      let x = stemX + nota.dx;
      if (ch.stemUp && ch.noteType.compareTo(new Fraction(4)) < 0) {
        x -= ch.noteheadWidth(meta);
      }
      if (nota.symbol === GlyphCodes.articStaccatissimoAbove || nota.symbol === GlyphCodes.articStaccatissimoBelow) {
        drawStaccatissimo(container, x + ch.noteheadWidth(meta) / 2, nota.y, nota.symbol === GlyphCodes.articStaccatissimoAbove);
        continue;
      }
      // **墨迹中心对符头中心**：照原排版程序是字形原点对符头左缘，窄的顿音点就偏到左边、宽的延长号偏到右边
      const bb = meta.getBBox(nota.symbol);
      if (bb) x += ch.noteheadWidth(meta) / 2 - ((bb.bBoxSW[0] + bb.bBoxNE[0]) / 2) * 10;
      addSmufl(container, nota.symbol, x, nota.y, fs);
    }
  }

  // ---- arpeggio（render.cpp:2234 drawMeasureMeta）：竖向波浪线，整 part 画一次 ----
  if (subStaff === 0) {
    for (const arp of md.arpegs) {
      if (arp.notes.length === 0) continue;
      const n0 = arp.notes[0];
      const n1 = arp.notes[arp.notes.length - 1];
      // 照 Sibelius 出的谱（八段锦钢片琴原 PDF）：波浪线上下各伸出符头约 0.3 格，画在临时记号左边；
      // 横向的位由 layoutpass `entryReach` 按 ARPEGGIO_RESERVE 让出
      const y0 = md.staffY(n0.staff) + n0.cy() + 8;
      const y1 = md.staffY(n1.staff) + n1.cy() - 8;
      const left = arp.inkLeft(md.noteEntries);
      const x = (Number.isFinite(left) ? left : md.measureInfo.getEntPos(n0.chord.offset)) - ARPEGGIO_LEAD;
      container.add(arpeggioGroup(x, y1, y0, fs));
    }
  }

  // ---- ledger lines, dots, accidentals from NoteEntries ----
  for (const ent of md.noteEntries) {
    if (ent.subStaff !== subStaff) continue;

    for (const [ledgerLine, [lx1, lx2]] of ent.leger.ranges) {
      const ly = -ledgerLine * 5;
      addLine(container, lx1 - 3, ly, lx2 + 3, ly, eng.lineWidths.leger);
    }

    // 附点无条件照 ent.dot.dots 画（render.cpp:1031）：原先还要求本小节存在「非休止的附点音符」，
    // 小节里只有附点休止时（《那一天正来临》）算好的附点会被整条吞掉。
    for (const dotLine of ent.dot.dots) {
      addSmufl(container, GlyphCodes.augmentationDot, ent.dot.dotPos, -5 * dotLine, fs);
    }

    for (const it of ent.acc.accidentals) {
      if (it.xpos === null) continue;
      let ax = it.xpos - 1;
      const ay = -it.line * 5;
      const sc = it.scale;
      for (const sym of it.symbols) {
        if (sc !== 1) {
          addSmuflScaled(container, sym, ax, ay, fs, sc, sc);
        } else {
          addSmufl(container, sym, ax, ay, fs);
        }
        ax += smuflWidth(meta, sym) * sc;
      }
    }
  }
}

// -----------------------------------------------------------------------
// drawBeams（render.cpp BeamLevelData::drawNormal + drawBeam）

/** One item of a beam run: start/end chord (null = hook), level. */
interface BeamItem {
  start: import("./model").ChordLayout | null;
  end: import("./model").ChordLayout | null;
  level: number;
}

function buildBeamItems(
  chords: import("./model").ChordLayout[],
): BeamItem[] {
  const items: BeamItem[] = [];
  for (let lev = 0; lev < 10; lev++) {
    let start: import("./model").ChordLayout | null = null;
    let last: import("./model").ChordLayout | null = null;
    let found = false;
    for (const ch of chords) {
      if (lev >= ch.beams.length) continue;
      const bv = ch.beams[lev];
      switch (bv) {
        case BeamVal.Continue:
          last = ch;
          break;
        case BeamVal.End:
          items.push({ start, end: ch, level: lev });
          found = true;
          start = null; last = null;
          break;
        case BeamVal.Backward:
          items.push({ start: null, end: ch, level: lev });
          found = true;
          break;
        case BeamVal.Forward:
          items.push({ start: ch, end: null, level: lev });
          found = true;
          break;
        case BeamVal.Begin:
          start = ch;
          break;
      }
    }
    if (!found && start && last) {
      items.push({ start, end: last, level: lev });
      found = true;
    }
    if (!found) break;
  }
  return items;
}

function drawBeamGroup(
  container: Group,
  chords: import("./model").ChordLayout[],
  stfY: number,
  scale: number,
): void {
  const items = buildBeamItems(chords);
  if (items.length === 0) return;

  const first = chords[0];
  const last = chords[chords.length - 1];
  const x1g = first.stemX();
  const y1g = first.tailY(true) - stfY;
  const x2g = last.stemX();
  const y2g = last.tailY(true) - stfY;
  const slope = x2g !== x1g ? (y2g - y1g) / (x2g - x1g) : 0;
  const hookLen = 12;
  const thick = 5.0 * scale;

  for (const it of items) {
    let lx: number, ly: number, rx: number, ry: number;
    const up = it.start?.stemUp ?? it.end?.stemUp ?? true;
    const dy = -(it.level * 8) * (up ? -1 : 1) + (up ? 0 : -5);

    if (it.start) {
      lx = it.start.stemX();
      ly = it.start.tailY(true) - stfY;
    } else {
      rx = it.end!.stemX();
      ry = it.end!.tailY(true) - stfY;
      lx = rx - hookLen;
      ly = ry - hookLen * slope;
    }
    if (it.end) {
      rx = it.end.stemX();
      ry = it.end.tailY(true) - stfY;
    } else {
      rx = lx + hookLen;
      ry = ly + hookLen * slope;
    }

    ly += dy * scale;
    ry += dy * scale;
    addFilledQuad(container, lx, ly, rx, ry, thick);
  }
}

export function drawBeams(
  container: Group,
  md: PartMeasureLayout,
  subStaff: number,
  graceSize: number,
): void {
  const stfY = md.staffY(subStaff);
  for (const grp of md.beams) {
    const relevantChords = grp.chords.filter((ch) =>
      ch.notes.some((n) => n.staff === subStaff),
    );
    if (relevantChords.length === 0) continue;
    drawBeamGroup(container, grp.chords, stfY, 1);
  }
  for (const grp of md.graceBeams) {
    const relevantChords = grp.chords.filter((ch) =>
      ch.notes.some((n) => n.staff === subStaff),
    );
    if (relevantChords.length === 0) continue;
    drawBeamGroup(container, grp.chords, stfY, graceSize);
  }
}

// -----------------------------------------------------------------------
// drawSlurTied / drawTied / drawSlur（render.cpp:1073-1329）

/**
 * 月牙形的 slur/tie（render.cpp::drawSlurTied）。
 *
 * 几何与画法**与谱面那一路共用** `SlurTieBase`（layout/layout.ts）——
 * 这里原本是它的逐行副本（同一个 `xlen = min(dist*0.04+10, dist*0.25)`、
 * 同一个 `log10(dist)*17-16`、同一个「去程 cubic + 回程两个控制点各下压 lw0/2」的
 * 填充月牙 + `lw0/4` 细描边），差别只是把 SlurStyle 全部写死成常量。
 * 现在常量收在 `mixedSlurStyle` 里（见那儿的注释）。
 */
function drawSlurTied(
  container: Group,
  plx: number, ply: number,
  prx: number, pry: number,
  above: boolean,
  obj: Slur | Tied,
): void {
  const arc = new SlurArc();
  arc.init(new Point(plx, ply), new Point(prx, pry), mixedSlurStyle(above));
  // 可视化编辑认弧：起止和弦的元素 id（身份标签，`pagetree/identity.ts`）
  const s = obj.startNote?.chord.src.id;
  const e = obj.endNote?.chord.src.id;
  if (s !== undefined && e !== undefined) arc.ident = { kind: "slur", id: s, end: e };
  container.add(arc);
}

function drawTied(sys: Sys, eng: MixedOptions, container: Group, obj: Tied, forceNota?: Notation): void {
  const e = tiedEnds(sys, eng, obj, forceNota);
  if (e) drawSlurTied(container, e.plx, e.ply, e.prx, e.pry, e.above, obj);
}

function drawSlur(sys: Sys, eng: MixedOptions, container: Group, slur: Slur, forceNota?: Notation): void {
  const e = slurEnds(sys, eng, slur, forceNota);
  if (e) drawSlurTied(container, e.plx, e.ply, e.prx, e.pry, e.above, slur);
}

// -----------------------------------------------------------------------
// drawLrcExtend（render.cpp::drawLrcExtend）

function drawLrcExtend(
  sys: Sys,
  eng: MixedOptions,
  container: Group,
  ext: LrcExtend,
): void {
  const begin = sys.beginTick();
  const end = sys.endTick();
  if (fGe(ext.startTick, end)) return;
  if (fLt(ext.endTick, begin)) return;

  // stop 为空＝melisma 被休止打断，终点取 endNote（休止前最后续腔音）；否则取下一音节。
  if (!ext.start || (!ext.stop && !ext.endNote)) return;

  const hasPrev = fLt(ext.startTick, begin);
  const hasNext = fGe(ext.endTick, end);

  // 跨系统时分段：musicpp render.cpp:1262-1265 留作 //todo，此处补全——
  // 续接段从本系统内容起点画，跨出段画到本系统末尾（对齐 Sibelius 原谱）。
  const m0 = sys.measures[0];
  const mLast = sys.measures[sys.measures.length - 1];
  const sysLeft = m0.xpos() + m0.dataPos;
  const sysRight = mLast.xpos() + mLast.width;

  let left: number;
  let right: number;
  if (hasPrev) {
    left = sysLeft;
  } else {
    const mifL = ext.startChord().measure.measureInfo;
    left = ext.start.x + mifL.xpos() + ext.start.xOffset + ext.start.width;
  }
  if (hasNext) {
    right = sysRight;
  } else {
    const mifR = ext.endChord().measure.measureInfo;
    if (ext.stop) {
      right = ext.stop.x + mifR.xpos() + ext.stop.xOffset;
    } else {
      // 休止打断：止于最后续腔音的右缘
      const en = ext.endNote!;
      right = en.x + smuflWidth(eng.meta, en.chord.sym()) + mifR.xpos();
    }
  }

  const y = -ext.start.y;
  addLine(container, left, y, right, y, 1);
}

// -----------------------------------------------------------------------
// drawTuplet（render.cpp::drawTuplet）

function drawTuplet(eng: MixedOptions, container: Group, obj: Tuplet): void {
  const chl = obj.startChord();
  const chr = obj.endChord();
  const nota = chl.notes[0].partStaff().getNotation(chl.tick());
  const above = obj.above;

  let plx = chl.stemX() + chl.measure.xpos();
  let ply = 0;
  let prx = chr.stemX() + chr.measure.xpos();
  let pry = 0;

  const sign = above ? 1 : -1;
  let bracket = false;

  if (nota === Notation.JianPu) {
    const ntl = chl.notes[0];
    const ntr = chr.notes[0];
    // 端点对齐到简谱数字中心（render.cpp:1393：ntl->x + 数字宽/2）。
    const wl = eng.jianpuFont.measureText(ntl.number());
    const wr = eng.jianpuFont.measureText(ntr.number());
    plx = ntl.x + wl / 2 + chl.measure.xpos();
    prx = ntr.x + wr / 2 + chr.measure.xpos();
    const dot = Math.max(
      ntl.octaveJp(),
      ntr.octaveJp(),
    );
    ply = pry = dot > 0 ? -4 : 3;
  } else {
    // determine bracket: use when stem direction matches above or no beams
    bracket = true;
    if (obj.bracket !== null) {
      bracket = obj.bracket;
    } else if (above === chl.stemUp) {
      bracket = chl.beams.length === 0;
    }
    [ply, pry] = obj.staffEnds();
  }

  // 画法走公共那一份（engrave/tuplet.ts）：括号（横线 + 竖脚，数字坐在断口里）与旧简谱引擎同一套，
  // 数字是 SMuFL 的 tuplet 字形、按墨迹居中。
  const tg = new TupletGlyph(new Point(plx, ply), new Point(prx, pry), obj.timeModification.denominator, {
    kind: bracket ? "bracket" : "number",
    color: 0xff000000,
    music: eng.musicFont,
    meta: eng.meta,
    lineWidth: 1,
    foot: sign * 10,
  });
  for (const it of tg.items) container.add(it);
}

// -----------------------------------------------------------------------
// drawEnding（render.cpp::drawEnding）

/** 混排里房号竖脚底离简谱层原点的空（高音点 + 简谱连音弧）。 */
const MIXED_ENDING_GAP = 16;

/** 一个房在本系统里的横向范围与 `yPos`（`yPos − 30` 是房号基线、竖脚底，再往上 20 是括线；null = 缺省位置 0）。
 *  谱表上方文字避让房号线也用这一份（`staffpages.ts::placeAboveStaff`）。 */
export function endingPlace(obj: Ending, sys: Sys, mixed: boolean): { left: number; right: number; yPos: number | null; startsHere: boolean; endsHere: boolean } {
  // 房跨系统：起点在前面的系统里，这一段从本系统首小节画起、不画左脚不印房号；终点在后面的系统里，画到本系统末小节、不封口
  const startsHere = sys.contains(obj.startTick);
  const endsHere = sys.contains(obj.endTick);
  const mifL = startsHere ? obj.startMeasure : sys.measures[0];
  const mifR = endsHere ? obj.endMeasure : sys.measures[sys.measures.length - 1];
  let left = mifL.xpos() + mifL.dataPos - 5 - mifL.sibKeyOffset;
  let right = mifR.xpos() + mifR.dataEnd;

  const scr = sys.score;
  const idx = mifR.index + 1;
  if (idx < scr.measures.length) {
    right -= scr.measures[idx].sibKeyOffset;
  }

  // yPos − 30 是房号数字的基线、再往上 20 是括线
  let yPos: number | null = null;
  // 带坐标的五线谱档也定：和弦行按谱面内容抬高之后（`placeAboveStaff`），缺省位置的房号线会压在和弦上（018）
  if (sys.staves.length > 0) {
    const eng = scr.options;
    const st = sys.staves[0];
    if (st.hasHarmony) {
      // 和弦按真实字高（约 18 tenths）：数字基线放到和弦顶上方 4；带坐标的混排照 musicpp
      yPos = mixed && !scr.autoLayout ? -st.harmonyY + 12 : -(st.harmonyY + 3 + harmonyBand(scr)[0]) + 26;
    } else if (mixed) {
      // 简谱层的原点是 `st.minY − mixStaffDist − mixStaffHeight`（同 `jianpuoverlay.ts::drawJianpuOverlay`）。
      // 原先这里把 `minY` 的符号写反了：谱表越往上伸（minY 越负）房号反而越往下掉，压进简谱层。
      // 竖脚底（= yPos − 30）停在简谱层之上 16：6 给高音点、10 给简谱层数字上方的连音弧；房号基线就在脚底上下。
      // 系统纵向范围里同一份高度见 `model.ts` 的 `MIXED_ENDING_BAND`。
      yPos = st.minY - eng.mixStaffDist - eng.mixStaffHeight + 30 - MIXED_ENDING_GAP;
    } else {
      yPos = Math.min(20, st.minY + 26); // 20 = 不给 yPos 时的缺省位置；高音、上方弧再往上让
    }
  }

  return { left, right, yPos, startsHere, endsHere };
}

function drawEnding(container: Group, obj: Ending, sys: Sys, mixed: boolean): void {
  const { left, right, yPos, startsHere, endsHere } = endingPlace(obj, sys, mixed);
  const scr = sys.score;
  const eng = scr.options;
  const y0 = -30.0;
  const vlen = 20.0;
  const hlen = 10.0;

  const grp = translated(0, yPos !== null ? yPos - vlen : 0);
  addEndingBracket(grp, {
    x0: left, x1: right, top: y0, drop: vlen,
    leftFoot: startsHere, rightFoot: endsHere && obj.hasStop,
    lineWidth: 1, color: 0xff000000,
    label: startsHere ? { text: obj.number, font: new Font(eng.wordFont, 20), dx: hlen } : undefined,
  });

  container.add(grp);
}

// -----------------------------------------------------------------------
// drawWedge / drawPedalLine（render.cpp::drawWedge / drawPedalLine）
// container 已平移到 part 顶（yposPart(p,0)）；ypos 加上 staff 内偏移。

function partStaffOffset(sys: Sys, p: PartLayout, staff: number): number {
  return sys.yposPart(p, staff) - sys.yposPart(p, 0);
}

// 跨系统截断：musicpp（render.cpp:2196）仅在 start/end 同属本 system 时绘制松叶，
// wedge 跨换行就整条丢弃。这里主动 diverge——把松叶在每个相交 system 内裁到系统
// 左右边界，端点高度按 tick 线性插值，使断开的渐强/渐弱线在两个系统上各画一段。
/** 源谱版面档：松叶止端离小节线至少留的空（tenths） */
const WEDGE_BAR_CLEAR = 3;

function drawWedge(container: Group, obj: Wedge, sys: Sys): void {
  const ypos = partStaffOffset(sys, obj.part, obj.staff) + obj.ypos;
  const mifL = obj.startMeasure;
  const mifR = obj.endMeasure;

  // 端点是否落在当前 system；不在则裁到系统边界。左边界用首小节的数据起点
  // （getEntPos(0)，即谱号/调号之后的音符起始），避免续接段压到行首谱号/调号；
  // 右边界用系统宽（行尾）。
  const startInSys = mifL.system === sys;
  const endInSys = mifR.system === sys;
  const firstMif = sys.measures[0];
  // 端点相对拍位的偏移（`relative-x`）：源谱版面档（识别稿照原图写的）才加，只加在落在本系统的那一端；
  // 带坐标的原文照原 C++ 工程不加
  const dx = sys.score.keepBreaks;
  const xL = startInSys
    ? mifL.getEntPos(obj.startTick.minus(mifL.offset)) + mifL.xpos() + (dx ? obj.dxLeft : 0)
    : firstMif.getEntPos(new Fraction(0));
  let xR = endInSys
    ? mifR.getEntPos(obj.endTick.minus(mifR.offset)) + mifR.xpos() + (dx ? obj.dxRight : 0)
    : sys.width();
  // 源谱版面档的 `relative-x` 是原图上的间距，重排紧了会把止端推过小节线、伸出系统（破碎 m80 钢琴右移 50）：收在止端那个小节里
  if (dx && endInSys) xR = Math.min(xR, mifR.xpos() + mifR.width - WEDGE_BAR_CLEAR);

  const h = obj.spread / 2;
  // 真实端点：渐强尖端在 start（高 0）、宽口在 end（高 h），渐弱相反。
  // 落在系统边界的断点不按 tick 插值（否则尖端附近的续接段开度过小），固定取
  // BREAK_FRAC×h，使断开的松叶在续接系统上有明显开口。
  const BREAK_FRAC = 0.6;
  const realL = obj.crescendo ? 0 : h;
  const realR = obj.crescendo ? h : 0;
  const hL = startInSys ? realL : h * BREAK_FRAC;
  const hR = endInSys ? realR : h * BREAK_FRAC;

  // 画法走公共那一份（engrave/hairpin.ts，与原样文档同一笔）
  container.add(hairpinPath({ x0: xL, x1: xR, y: ypos, half0: hL, half1: hR, lineWidth: 1, color: 0xff000000 }));
}

function drawPedalLine(container: Group, obj: PedalLine, sys: Sys): void {
  const ypos = partStaffOffset(sys, obj.part, obj.staff) + obj.ypos;
  const mifL = obj.startMeasure;
  const mifR = obj.endMeasure;
  const left = mifL.getEntPos(obj.startTick.minus(mifL.offset)) + mifL.xpos();
  const right = mifR.getEntPos(obj.endTick.minus(mifR.offset)) + mifR.xpos();

  const vlen = 10;
  const path = new GraphicPath();
  path.fill = false;
  path.stroke = true;
  path.strokeColor = 0xff000000;
  path.strokeWidth = 1;
  path.moveTo(left, ypos - vlen);
  path.lineTo(left, ypos);
  path.lineTo(right, ypos);
  path.lineTo(right, ypos - vlen);
  container.add(path);
}

/**
 * 八度线：起头印「8va」（15ma；印在下方的 8vb / 15mb），后面一道虚线到止点，止点竖钩朝谱表。
 * 跨系统的照松叶裁到系统边界，续接段起头印加括号的「(8)」。字形基线让开范围里的符头（上方离最高的音一个半间、下方字顶离最低的音一间多），至少离开谱表。
 */
function drawOctaveLine(container: Group, obj: OctaveLine, sys: Sys, eng: MixedOptions): void {
  const off = partStaffOffset(sys, obj.part, obj.staff);
  const startInSys = obj.startMeasure.system === sys;
  const endInSys = obj.endMeasure.system === sys;
  const xL = startInSys
    ? obj.startMeasure.getEntPos(obj.startTick.minus(obj.startMeasure.offset)) + obj.startMeasure.xpos()
    : sys.measures[0].getEntPos(new Fraction(0));
  // 止点是下一个音的拍位：线收在范围里最后一个音的符头右缘（不压到下一个音上）
  let lastHead: number | null = null;
  // 范围里本谱表的符头最高 / 最低（y 向下为正，顶线 0、底线 40）
  let y = obj.above ? -20 : 68;
  for (const md of obj.part.measures) {
    if (md.measureInfo.system !== sys) continue;
    for (const ch of md.chords) {
      const t = ch.tick();
      if (fLt(t, obj.startTick) || !fLt(t, obj.endTick)) continue;
      for (const n of ch.notes) {
        if (n.staff !== obj.staff || n.writtenPitch < 0) continue;
        y = obj.above ? Math.min(y, n.cy() - 15) : Math.max(y, n.cy() + 30);
        const x = md.measureInfo.getEntPos(ch.offset) + md.measureInfo.xpos() + ch.noteheadWidth(eng.meta);
        if (lastHead === null || x > lastHead) lastHead = x;
      }
    }
  }
  const xR = !endInSys ? sys.width() : lastHead ?? obj.endMeasure.getEntPos(obj.endTick.minus(obj.endMeasure.offset)) + obj.endMeasure.xpos();
  const fs = eng.musicFont.size;
  const glyph = !startInSys ? (obj.size >= 15 ? GlyphCodes.quindicesima : GlyphCodes.ottava)
    : obj.above ? (obj.size >= 15 ? GlyphCodes.quindicesimaAlta : GlyphCodes.ottavaAlta)
    : obj.size >= 15 ? GlyphCodes.quindicesimaBassaMb : GlyphCodes.ottavaBassaVb;
  const base = off + y;
  const g = translated(0, 0);
  addSmufl(g, glyph, xL, base, fs);
  const gw = smuflWidth(eng.meta, glyph);
  // 字形立在基线上、高约两间：虚线接在字形半高，钩朝谱表
  const lineY = base - 9;
  const hook = obj.above ? 8 : -8;
  const path = new GraphicPath();
  path.fill = false;
  path.stroke = true;
  path.strokeColor = 0xff000000;
  path.strokeWidth = 1;
  for (let x = xL + gw + 3; x < xR; x += 8) {
    path.moveTo(x, lineY);
    path.lineTo(Math.min(x + 4, xR), lineY);
  }
  if (endInSys && xR > xL + gw + 3) {
    path.moveTo(xR, lineY);
    path.lineTo(xR, lineY + hook);
  }
  g.add(path);
  container.add(g);
}

// -----------------------------------------------------------------------
// drawLrc（render.cpp::drawLrc）

function drawLrcHyphen(
  eng: MixedOptions,
  lrc: LyricLayout,
  container: Group,
  mifXpos: number,
): void {
  const next = lrc.next!;
  const mifL = lrc.measure.measureInfo;
  const mifR = next.measure.measureInfo;

  const l = lrc.x + lrc.xOffset + lrc.width;
  let r = next.x + next.xOffset;
  if (mifR !== mifL) {
    if (mifL.system !== mifR.system) {
      r = mifR.system!.width() - mifXpos;
    } else {
      r += mifR.xpos() - mifXpos;
    }
  }
  const cx = (l + r) / 2;
  const hyp = eng.chineseHyphen ? "—" : "-";
  const t = new TextFrame();
  t.text = hyp;
  t.font = lrc.font;
  t.color = 0xff000000;
  const hypW = lrc.font.measureText(hyp);
  t.x = cx - hypW / 2;
  t.y = -lrc.y;
  container.add(t);
}

export function drawLrc(
  eng: MixedOptions,
  container: Group,
  data: PartMeasureLayout,
  subStaff: number,
): void {
  const mifXpos = data.measureInfo.xpos();
  for (const lrc of data.lyrics) {
    if (lrc.staff !== subStaff) continue;
    if (lrc.empty) continue;
    const x = lrc.x;
    if (x < 0) continue;

    if (lrc.next) {
      drawLrcHyphen(eng, lrc, container, mifXpos);
    }

    const t = new TextFrame();
    t.text = lrc.text;
    t.font = lrc.font;
    t.color = 0xff000000;
    t.x = x + lrc.xOffset;
    t.y = -lrc.y;
    t.ident = { kind: "syllable", id: lrc.chord.src.id, verse: lrc.src.number };
    // 标点挤压：`widthInfo` 量的就是挤压后的宽度，绘制拿同一串笔位（档位同为 `lrc.compress`）。
    if ([...lrc.text].length > 1) {
      const chars = [...lrc.text];
      const run = lrc.font.run(lrc.text, lrc.compress);
      if (eng.musicppHwidGlyphs && lrc.compress === "halfwidth") {
        // musicpp 在字体上真正开 `hwid`，PDF 输出则只有字符和笔位。
        // 不把标点换成 ASCII：保留“，；「《等中文字形，只将其墨迹中心
        // 摆到 `halt` 实测得到的那个 advance 格中心。这也避免全角左括号
        // 按半宽笔位画时被后一字盖住。
        t.charXs = run.xs.map((x0, i) => {
          if (punctClass(chars[i]!) === "none") return x0;
          const x1 = run.xs[i + 1] ?? run.width;
          const ink = lrc.font.charBound(chars[i]!);
          return (x0 + x1) / 2 - (ink.left + ink.right) / 2;
        });
      } else {
        t.charXs = run.xs;
      }
    }
    container.add(t);

    if (lrc.prefix) {
      const pref = new TextFrame();
      pref.text = lrc.prefix;
      pref.font = lrc.font;
      pref.color = 0xff000000;
      const cnt = lrc.prefix.length;
      // 段号按墨迹摆：右缘离首字左缘留 0.3 字号；成书照 musicpp 的固定偏移（逐位不变）
      pref.x = eng.verseLabelByInk
        ? x + lrc.xOffset - lrc.font.run(lrc.prefix, lrc.compress).width - lrc.font.size * 0.3
        : x - (40 + (cnt - 2) * 12);
      pref.y = -lrc.y;
      container.add(pref);
    }
  }
}

// -----------------------------------------------------------------------
// drawHarmony（render.cpp::drawHarmony, simplified: plain text）

/** 一个和弦符号画出来的宽（同 `drawHarmony` 的字体与分段），谱表上方文字避让用 */
export function harmonyWidthOf(score: StaffLayout, h: HarmonyLayout): number {
  const eng = score.options;
  const fontsz = eng.harmonySize / (score.scaling > 0 ? score.scaling : 0.45);
  const segs = eng.chordPlain ? chordTextSegs(h.asPlainText(eng.accidentalSide), true, eng.accidentalSide) : h.asText(eng.accidentalSide);
  return harmonyWidth(segs, new Font(eng.wordFont, fontsz), new Font("Bravura Text", fontsz));
}

export function drawHarmony(
  eng: MixedOptions,
  container: Group,
  data: PartMeasureLayout,
  subStaff: number,
  scaling: number,
  mixed: boolean,
): void {
  const fontsz = eng.harmonySize / (scaling > 0 ? scaling : 0.45);
  const wordFont = new Font(eng.wordFont, fontsz);
  // SMuFL csym 字形（升降号/和弦质量）。musicpp（render.cpp:541）明确使用同字号的
  // "Bravura Text"。不能拿 Bravura 乘一个统一比例代替：两款字体的 csym 升降号等大，
  // diminished/augmented 等质量字形却不是同一比例；只有实际 Text 字体能逐字形对齐。
  const musicFont = new Font("Bravura Text", fontsz);
  // 整小节休止的混排小节，offset==0 的和弦标记右移 15（render.cpp:504-515）。
  const measureRest =
    mixed && data.chords.length === 1 && data.chords[0].measureRest;
  for (const h of data.harmonies) {
    if (h.staff !== subStaff) continue;
    const mixedOffsetForRest =
      measureRest && h.offset.compareTo(new Fraction(0)) === 0 ? 15 : 0;
    const segs = eng.chordPlain ? chordTextSegs(h.asPlainText(eng.accidentalSide), true, eng.accidentalSide) : h.asText(eng.accidentalSide);
    // 分段排版与量宽走公共那一份（engrave/chord.ts）：总宽照 musicpp TextBlock::width，上/下标按 0.75 缩放
    const width = harmonyWidth(segs, wordFont, musicFont);
    const grp = layoutHarmonySegs(segs, wordFont, musicFont, 0xff000000);

    const m = new Matrix33();
    m.setAffine([
      1, 0, 0, 1,
      h.x - width / 2 + 6.5 + mixedOffsetForRest,
      -h.y + wordFont.metrics.descent,
    ]);
    grp.matrix = m;
    container.add(grp);
  }
}

// -----------------------------------------------------------------------
// drawTextBlock（render.cpp::drawTextBlock）— <direction> 文本（如「(副歌)」）

/** 绘制单个 TextBlock（逐行 justify，对齐 render.cpp::drawTextBlock 非 useTextArea 分支）。 */
function drawTextBlock(container: Group, t: MeasureText): void {
  if (t.data.length === 0) return;
  const bySize = t.measure.part.score.options.textLineHeightBySize;

  // 逐行宽/高
  const lineW: number[] = [];
  const lineH: number[] = [];
  let w = 0;
  let h = 0;
  for (const it of t.data) {
    if (it.text === "\n") {
      lineW.push(w);
      lineH.push(h);
      w = 0;
      h = 0;
      continue;
    }
    w += (it.padBefore ?? 0) + it.font.measureText(it.text);
    // 行高与谱行包围盒（model.ts::tightLineHeights）同一口径：歌本按字号（musicpp Font::height()），
    // 否则多行文字块画得比包围盒高，压进下面的简谱与歌词（《那一天正来临》开头的楷体引言）
    const fm = it.font.metrics;
    h = Math.max(h, bySize ? (it.nominalSize ?? it.font.size) : fm.descent - fm.ascent);
  }
  lineW.push(w);
  lineH.push(h);
  const totalW = Math.max(...lineW);

  let line = 0;
  let xpos = 0;
  let ypos = 0;
  let first = true;
  for (const it of t.data) {
    const content = it.text;
    if (content === "\n") {
      line += 1;
      if (line >= lineH.length) break;
      ypos += lineH[line] * 1.444;
    }
    if (first || content === "\n") {
      const diff = totalW - lineW[line];
      xpos = t.justify === LCR.Right ? diff : t.justify === LCR.Center ? diff / 2 : 0;
    }
    first = false;
    if (content === "\n") continue;

    xpos += it.padBefore ?? 0;
    const tf = new TextFrame();
    tf.text = content;
    tf.font = it.font;
    tf.color = 0xff000000;
    const m = new Matrix33();
    m.setAffine([1, 0, 0, 1, t.x + xpos, -t.y + ypos]);
    tf.matrix = m;
    container.add(tf);
    xpos += it.font.measureText(content);
  }
  if (t.boxed && !t.frameless) {
    // 排练号的方框：按首行字的墨迹上下沿、整块宽，四周留 0.25 个字号
    const it0 = t.data.find((it) => it.text !== "\n");
    if (!it0) return;
    const b = it0.font.charBound(it0.text);
    const pad = it0.font.size * 0.25;
    const x0 = t.x - pad, x1 = t.x + totalW + pad;
    const y0 = -t.y + b.top - pad, y1 = -t.y + b.bottom + pad;
    const lw = 1.2;
    addLine(container, x0, y0, x1, y0, lw);
    addLine(container, x1, y0, x1, y1, lw);
    addLine(container, x1, y1, x0, y1, lw);
    addLine(container, x0, y1, x0, y0, lw);
  }
}

function drawTextBlocks(container: Group, data: PartMeasureLayout, subStaff: number): void {
  for (const t of data.textBlocks) {
    if (t.staff !== subStaff) continue;
    drawTextBlock(container, t);
  }
}

// -----------------------------------------------------------------------
// drawLineObjs（render.cpp::drawLineObjs）— span objects per part per system

function drawLineObjs(container: Group, sys: Sys, p: PartLayout): void {
  const scr = sys.score;
  const eng = scr.options;

  const grp = translated(0, sys.yposPart(p));
  container.add(grp);

  const firstStf = p.staves[0];
  const t = sys.measures[0].offset;
  const nota = firstStf.getNotation(t);
  const mixed = nota === Notation.Mixed;

  if (mixed) {
    let miny = 0;
    for (const st of sys.staves) {
      if (st.part() !== p) continue;
      miny = st.minY;
    }
    const grpJp = translated(0, miny - eng.mixStaffDist - eng.mixStaffHeight);
    grp.add(grpJp);

    for (const sl of p.slurs) {
      drawSlur(sys, eng, grp, sl, Notation.Normal);
      const nts = sl.startChord().notes;
      const nt = sl.above ? nts[nts.length - 1] : nts[0];
      if (!nt.jpMelody) continue;
      drawSlur(sys, eng, grpJp, sl, Notation.JianPu);
    }
    for (const obj of p.tied) {
      drawTied(sys, eng, grp, obj, Notation.Normal);
      const nt = obj.startNote;
      if (!nt || !nt.jpMelody) continue;
      drawTied(sys, eng, grpJp, obj, Notation.Mixed);
    }
  } else {
    for (const sl of p.slurs) {
      drawSlur(sys, eng, grp, sl);
    }
    for (const obj of p.tied) {
      drawTied(sys, eng, grp, obj);
    }
  }

  if (nota !== Notation.JianPu) {
    for (const ext of p.lrcExtends) {
      drawLrcExtend(sys, eng, grp, ext);
    }
  }

  for (const obj of p.tuplets) {
    if (!sys.overlap(obj)) continue;
    if (sys.contains(obj.startTick) && sys.contains(obj.endTick)) {
      drawTuplet(eng, grp, obj);
    }
  }

  for (const obj of p.wedges) {
    if (!sys.overlap(obj)) continue;
    // 与 musicpp 不同：相交即绘制，drawWedge 内部按系统边界裁断（跨换行的松叶）。
    drawWedge(grp, obj, sys);
  }

  for (const obj of p.pedalLines) {
    if (!sys.overlap(obj)) continue;
    if (sys.contains(obj.startTick) && sys.contains(obj.endTick)) {
      drawPedalLine(grp, obj, sys);
    }
  }

  for (const obj of p.octaveLines) {
    if (sys.overlap(obj)) drawOctaveLine(grp, obj, sys, eng);
  }

  for (const obj of p.endings) {
    // 跨系统的房按系统裁段画（原先起止不在同一系统就整条丢掉）
    if (sys.overlap(obj)) drawEnding(grp, obj, sys, mixed);
  }
}


// -----------------------------------------------------------------------
// drawStaff

function drawStaff(eng: MixedOptions, container: Group, sysStf: SysStaff, ypos: number, w: number): void {
  const nota = sysStf.partStaff.getNotation(new Fraction(0));
  if (nota === Notation.JianPu) return;

  const grp = translated(0, ypos);
  for (let l = 0; l < sysStf.staffLines; l++) {
    addLine(grp, 0, l * 10, w, l * 10, eng.lineWidths.staff);
  }
  container.add(grp);
}

// -----------------------------------------------------------------------
// drawClef

/** 打击乐谱号照 Sibelius 出的谱（八段锦小钗、小锣原 PDF）画两道细竖线：各粗 0.2 格、相隔 0.3 格，从第二线到第四线。
 *  Bravura 的 unpitchedPercussionClef1 是 1.5 格宽的两道粗条。占位仍按字形宽，竖线画在它中间 */
function drawPercussionClef(container: Group, xpos: number, sc: number): void {
  const w = 2 * sc, gap = 3 * sc, glyphW = 15.28 * sc;
  const x0 = xpos + (glyphW - (2 * w + gap)) / 2;
  const y0 = 20 - 10 * sc, h = 20 * sc;
  container.add(fillRect(0xff000000, x0, y0, w, h));
  container.add(fillRect(0xff000000, x0 + w + gap, y0, w, h));
}

function drawClef(clef: ClefSig, container: Group, xpos: number, fontSize: number, sc = 1): void {
  if (clef.sign === GlyphCodes.unpitchedPercussionClef1) {
    drawPercussionClef(container, xpos, sc);
    return;
  }
  const y = 50 - clef.line * 10;
  if (sc !== 1) {
    addSmuflScaled(container, clef.sign, xpos, y, fontSize, sc, sc);
  } else {
    addSmufl(container, clef.sign, xpos, y, fontSize);
  }
}

// -----------------------------------------------------------------------
// drawKeyAccid

function drawKeyAccid(
  container: Group,
  clef: ClefSig,
  num: number,
  sym: string,
  skip: number,
  xOff: number,
  fontSize: number,
): void {
  const inc = num > 0 ? 4 : 3; // 降号步进为 3（render.cpp drawKeyAccid）
  const initStep = num > 0 ? 52 : 48;
  const maxStep = num > 0 ? 46 : 44;
  const sk = Math.abs(skip);
  for (let i = sk; i < Math.abs(num); i++) {
    let step = initStep + i * inc;
    while (step > maxStep) step -= 7;
    let base = clef.topPitch();
    while (base < 45) base += 7;
    const line = step - base;
    const y = -line * 5.0;
    addSmufl(container, sym, 10.0 * (i - sk) + xOff, y, fontSize);
  }
}

function drawKey(
  eng: MixedOptions,
  container: Group,
  mif: import("./model").MeasureLayout,
  ps: import("./model").PartStaff,
  x: number,
): void {
  const key = ps.getKey(mif.offset);
  const clef = ps.getClef(mif.offset);
  const cancel = key.cancel;
  const cur = key.fifths;
  if (cur === 0 && cancel === 0) return;

  const g = cur > 0 ? GlyphCodes.accidentalSharp : GlyphCodes.accidentalFlat;
  const grp = new Group();
  const fs = eng.musicFont.size;

  if (cancel * cur < 0) {
    drawKeyAccid(grp, clef, cancel, GlyphCodes.accidentalNatural, 0, 0, fs);
    drawKeyAccid(grp, clef, cur, g, 0, Math.abs(cancel) * 10, fs);
  } else {
    if (Math.abs(cur) > Math.abs(cancel)) {
      drawKeyAccid(grp, clef, cur, g, 0, 0, fs);
    } else {
      const skip = Math.abs(cur - cancel);
      drawKeyAccid(grp, clef, cancel, GlyphCodes.accidentalNatural, Math.abs(cur), 0, fs);
      drawKeyAccid(grp, clef, cur, g, 0, skip * 10, fs);
    }
  }
  if (grp.children.length > 0) {
    const m = new Matrix33();
    m.setAffine([1, 0, 0, 1, x, 0]);
    grp.matrix = m;
    container.add(grp);
  }
}

// -----------------------------------------------------------------------
// drawTime

function drawTime(
  eng: MixedOptions,
  container: Group,
  mif: import("./model").MeasureLayout,
  ps: import("./model").PartStaff,
  x: number,
): void {
  const time = ps.getTime(mif.offset);
  const grp = new Group();
  const fs = eng.musicFont.size;

  if (time.symbol) {
    const sym =
      time.beats === 2 ? GlyphCodes.timeSigCutCommon : GlyphCodes.timeSigCommon;
    addSmufl(grp, sym, 0, 20, fs);
  } else {
    addSmufl(grp, TimeSig.makeNumber(time.beats), 0, 10, fs);
    addSmufl(grp, TimeSig.makeNumber(time.beatType), 0, 30, fs);
  }

  if (grp.children.length > 0) {
    const m = new Matrix33();
    m.setAffine([1, 0, 0, 1, x, 0]);
    grp.matrix = m;
    container.add(grp);
  }
}

// -----------------------------------------------------------------------
// drawBarlineItem

function drawBarlineItem(
  eng: MixedOptions,
  container: Group,
  style: BarGlyph,
  x: number,
  top: number,
  bot: number,
  repForBack = false,
  tag: ItemIdentity | null = null,
): number {
  // 整组小节线右缘对齐到 x（向左生长），与谱线右端接齐（render.cpp drawBarlineItem）。
  // 粗细组合与线距走公共那一份（engrave/barline.ts）；反复点按谱表间位另画（drawRepeatDots）。
  const lw = eng.lineWidths;
  const spec = repForBack ? { repeatBackward: true, repeatForward: true } : BAR_GLYPH_SPEC[style];
  const bar = new BarlineGlyph(spec, false, {
    top,
    bot,
    light: lw.lightBarline,
    heavy: lw.heavyBarline,
    gap: eng.barlineDist,
    dots: false,
    color: 0xff000000,
  });
  if (bar.lines.length === 0) return 0;
  const w = bar.inkRight - bar.inkLeft;
  const dx = x - w - bar.inkLeft;
  for (const l of bar.lines) {
    // 混排的线一律写绝对端点（x = 0），页面树与原先逐字节一致
    const cx = l.x + dx;
    l.x = 0;
    l.p0 = new Point(cx, l.p0.y);
    l.p1 = new Point(cx, l.p1.y);
    if (tag) l.ident = tag;
    container.add(l);
  }
  return w;
}

/** 五线谱的小节线样式 → 公共小节线的 spec。 */
const BAR_GLYPH_SPEC: Record<BarGlyph, BarlineSpec> = {
  [BarGlyph.Single]: {},
  [BarGlyph.Double]: { style: BarStyle.LIGHT_LIGHT },
  [BarGlyph.HeavyHeavy]: { style: BarStyle.HEAVY_HEAVY },
  [BarGlyph.Final]: { style: BarStyle.LIGHT_HEAVY },
  [BarGlyph.ReverseFinal]: { style: BarStyle.HEAVY_LIGHT },
  [BarGlyph.None]: { style: BarStyle.NONE },
};

/** 反复双点。主谱画两个 repeatDot（第 2、3 间），混排谱在上方简谱层再画一组缩小版。
 *  对齐 render.cpp::drawRepeatDots（mixStaves 分支）。 */
function drawRepeatDots(
  eng: MixedOptions,
  container: Group,
  sys: Sys,
  x: number,
  mixStaves: Set<number>,
): void {
  for (let i = 0; i < sys.staves.length; i++) {
    const st = sys.staves[i];
    if (!st.staffVisible) continue;
    const y0 = sys.ypos(i);
    if (mixStaves.has(i)) {
      const yoff = st.minY - eng.mixStaffHeight - eng.mixStaffDist;
      const sc = eng.mixStaffHeight / 40;
      const fs = eng.musicFont.size;
      addSmuflScaled(container, GlyphCodes.repeatDot, x, y0 + yoff + 15 * sc, fs, sc, sc);
      addSmuflScaled(container, GlyphCodes.repeatDot, x, y0 + yoff + 25 * sc, fs, sc, sc);
    }
    addSmufl(container, GlyphCodes.repeatDot, x, y0 + 15, eng.musicFont.size);
    addSmufl(container, GlyphCodes.repeatDot, x, y0 + 25, eng.musicFont.size);
  }
}

// -----------------------------------------------------------------------
// drawBarline

function drawBarline(eng: MixedOptions, container: Group, sys: Sys): void {
  const styles: (BarGlyph | null)[] = [];
  const xpos: number[] = [];

  const m0 = sys.measures[0];
  styles.push(null);
  xpos.push(m0.xpos() + m0.leftBarlinePos);

  for (let idx = 0; idx < sys.measures.length; idx++) {
    const m = sys.measures[idx];
    // 小节号（render.cpp:1706-1712）。默认 hideBarNumber=true 时不显示。
    if (m.showBarNumber && !eng.hideBarNumber) {
      const num = new TextFrame();
      num.text = m.number;
      num.font = new Font(eng.wordFont, 20);
      num.color = 0xff000000;
      num.x = m.xpos();
      num.y = -25;
      container.add(num);
    }
    let dx = 0;
    if (idx + 1 < sys.measures.length) dx = -sys.measures[idx + 1].sibKeyOffset;
    styles.push(m.rightBarline ?? BarGlyph.Single);
    xpos.push(m.xpos() + m.width + dx);
  }

  if (sys.timeChangeWidth > 0) xpos[xpos.length - 1] -= sys.timeChangeWidth + 5;
  if (sys.keyChangeWidth > 0) xpos[xpos.length - 1] -= sys.keyChangeWidth + 5;

  // merge left barlines into styles array（lightHeavyLight：左 Final 与右 Final 合并成
  // light-heavy-light 的双向反复，render.cpp drawBarline）。
  const lightHeavyLight = new Set<number>();
  for (let idx = 0; idx < sys.measures.length; idx++) {
    const m = sys.measures[idx];
    if (m.leftBarline !== null) {
      const orig = styles[idx];
      if (orig === null || orig === BarGlyph.Single) styles[idx] = m.leftBarline;
      else if (orig === BarGlyph.Final) lightHeavyLight.add(idx);
    }
  }

  const grps = sys.barlineGroups();
  const scr = sys.score;

  // 混排谱所在的 staff 下标集合 + 其 minY（render.cpp drawBarline）。
  const t0 = sys.measures[0].offset;
  const mixStaves = new Set<number>();
  let miny = 0;
  for (let i = 0; i < sys.staves.length; i++) {
    if (sys.staves[i].partStaff.getNotation(t0) === Notation.Mixed) {
      miny = sys.staves[i].minY;
      mixStaves.add(i);
    }
  }

  for (let i = 0; i < styles.length; i++) {
    const st = styles[i];
    if (st === null) continue;
    let x = xpos[i];
    const rep = lightHeavyLight.has(i);
    let width = 0;
    // 这条小节线的身份：系统开头那条是首小节之前，其余是第 i 小节（系统内从 1 数）之后
    const tag: ItemIdentity = i === 0
      ? { kind: "barline", measure: sys.firstMeasure, edge: "before" }
      : { kind: "barline", measure: sys.firstMeasure + i - 1, edge: "after" };

    for (const [first, last] of grps) {
      const stb = sys.staves[last];
      const top = sys.ypos(first);
      const bot = sys.ypos(last) + stb.height();

      if (rep) x += 15;

      // mixed jp-staff barline segment above main staff
      if (mixStaves.has(first)) {
        const mixTop = miny + top - eng.mixStaffHeight - eng.mixStaffDist;
        const mixBot = mixTop + eng.mixStaffHeight;
        drawBarlineItem(eng, container, st, x, mixTop, mixBot, rep, tag);
      }

      width = drawBarlineItem(eng, container, st, x, top, bot, rep, tag);
    }

    const mid = i + sys.firstMeasure;
    if (i < styles.length - 1 && mid < scr.measures.length && scr.measures[mid].forward) {
      drawRepeatDots(eng, container, sys, x + 7, mixStaves);
    }
    if (i > 0 && mid > 0 && scr.measures[mid - 1].backward) {
      drawRepeatDots(eng, container, sys, x - (width + 7), mixStaves);
    }
  }

  // connecting left vertical line
  if (sys.visibleStaves() > 1) {
    addLine(container, 0.5, 0, 0.5, sys.height(), 1);
  }
}

// -----------------------------------------------------------------------
// drawPartGroups

function drawPartGroups(container: Group, sys: Sys): void {
  const eng = sys.score.options;
  for (const grp of sys.score.partGroups) {
    if (grp.symbol === GroupSymbol.None) continue;
    const [first, last] = sys.visibleStavesOf(grp);
    if (first < 0) continue;
    const y0 = sys.ypos(first);
    const y1 = sys.ypos(last) + sys.staves[last].height();

    if (grp.symbol === GroupSymbol.Bracket) {
      const lw = 5;
      const bx = -10 + lw / 2 - 0.5;
      addLine(container, bx, y0 - 5, bx, y1 + 5, lw);
      addSmufl(container, GlyphCodes.bracketTop, -10, y0 - 4, eng.musicFont.size);
      addSmufl(container, GlyphCodes.bracketBottom, -10, y1 + 4, eng.musicFont.size);
    } else if (grp.symbol === GroupSymbol.Brace) {
      const scaleX = 3.0;
      const scaleY = (y1 - y0) / 40;
      addSmuflScaled(container, GlyphCodes.brace, -14, y1, eng.musicFont.size, scaleX, scaleY);
    }
  }
}

/** 声部名离系统左缘（括号、花括号之外）多远，tenths */
const PART_NAME_GAP = 25;

/**
 * 声部名：首个系统印全名、之后印缩写，右对齐在系统左缘外（行首缩进里），纵向居本声部各可见谱表的中线；多行名逐行排。
 * 只在源谱版面档印（`keepBreaks`）：缩进是照原谱来的，原谱在那里印着名字；自动铺排不留缩进，印了会出版心。
 */
function drawPartNames(container: Group, sys: Sys): void {
  const scr = sys.score;
  const first = scr.systems[0] === sys;
  for (const part of scr.parts) {
    const text = first ? part.name : part.abbrev;
    if (!text) continue;
    const ks = sys.staves.flatMap((st, k) => (st.part() === part && st.staffVisible ? [k] : []));
    if (!ks.length) continue;
    const y0 = sys.ypos(ks[0]!);
    const y1 = sys.ypos(ks[ks.length - 1]!) + sys.staves[ks[ks.length - 1]!]!.height();
    const font = new Font(scr.options.wordFont, part.nameSize > 0 ? part.nameSize / scr.scaling : scr.defaults.wordFont.size);
    const lines = text.split(/\r?\n/);
    const lineH = font.size * 1.2;
    const cap = font.charBound("H");
    // 首行基线：整块（首行字顶到末行基线）居中
    const base = (y0 + y1) / 2 - ((lines.length - 1) * lineH + cap.top) / 2;
    lines.forEach((line, li) => {
      const tf = new TextFrame();
      tf.text = line;
      tf.font = font;
      const m = new Matrix33();
      m.setAffine([1, 0, 0, 1, -PART_NAME_GAP - font.measureText(line), base + li * lineH]);
      tf.matrix = m;
      container.add(tf);
    });
  }
}

// -----------------------------------------------------------------------
// drawSysStaff

function drawSysStaff(container: Group, sys: Sys, st: SysStaff, ypos: number): void {
  const scr = sys.score;
  const eng = scr.options;
  const ps = st.partStaff;

  drawStaff(eng, container, st, ypos, sys.width());

  let xpos = 0;
  for (const m of sys.measures) {
    const grp = translated(xpos, ypos);
    container.add(grp);

    const nota = ps.getNotation(m.offset);
    const isJp = nota === Notation.JianPu;
    const nsys = m === sys.measures[0];

    if (nsys && !isJp && m.clefPos !== null) {
      drawClef(ps.getClef(m.offset), grp, m.clefPos, eng.musicFont.size);
    }
    if (nsys && !isJp && m.keyPos !== null) {
      drawKey(eng, grp, m, ps, m.keyPos - m.sibKeyOffset);
    } else if (!nsys && ps.keyChange(m.offset) && m.keyPos !== null && !isJp) {
      drawKey(eng, grp, m, ps, m.keyPos - m.sibKeyOffset);
    }
    if (ps.timeChange(m.offset) && m.timePos !== null && !isJp) {
      drawTime(eng, grp, m, ps, m.timePos);
    }

    // trailing clef/key/time for next system
    if (m === sys.measures[sys.measures.length - 1]) {
      let endPos = m.width;
      if (sys.timeChangeWidth > 0 && m.index + 1 < scr.measures.length) {
        // 末小节的数据区/小节线已经另留了 5 tenths 间距；预告拍号自身只退它的宽度。
        // musicpp render.cpp::drawSysStaff 同样是 `endPos -= timeChangeWidth`。
        endPos -= sys.timeChangeWidth;
        const next = scr.measures[m.index + 1];
        if (!isJp) drawTime(eng, grp, next, ps, endPos);
      }
      if (sys.keyChangeWidth > 0 && m.index + 1 < scr.measures.length) {
        // 与 musicpp 一致：5 tenths 是小节线与预告属性之间的空隙，不属于调号宽度。
        endPos -= sys.keyChangeWidth;
        const next = scr.measures[m.index + 1];
        if (!isJp) drawKey(eng, grp, next, ps, endPos);
      }
    }

    // notes, beams, lyrics, harmony
    if (!isJp) {
      const md = ps.part.measures[m.index];
      if (md) {
        drawNotesNormal(eng, grp, md, ps.subIndex);
        drawBeams(grp, md, ps.subIndex, eng.graceSize);
        drawLrc(eng, grp, md, ps.subIndex);
        drawHarmony(eng, grp, md, ps.subIndex, scr.scaling, nota === Notation.Mixed);
        drawTextBlocks(grp, md, ps.subIndex);
      }
    }

    // 简谱叠层（混排第一子谱表）：`jianpuoverlay.ts`
    if (nota === Notation.Mixed && ps.subIndex === 0) drawJianpuOverlay(grp, sys, st, m);

    xpos += m.width;
  }
}

// -----------------------------------------------------------------------
// drawSystem

export function drawSystem(container: Group, sys: Sys): Group {
  const scr = sys.score;
  const eng = scr.options;
  const res = new Group();
  container.add(res);

  let ypos = 0;
  let top: number | null = null;
  for (const st of sys.staves) {
    if (!st.staffVisible) continue;
    ypos += st.distance;
    // 谱表带上沿：混排第一子谱表连同上方的简谱层（与 `drawJianpuOverlay` 的 jpOffY 同式）
    const mixedTop = st.partStaff.getNotation(sys.measures[0].offset) === Notation.Mixed && st.partStaff.subIndex === 0
      ? ypos + st.minY - eng.mixStaffDist - eng.mixStaffHeight
      : ypos;
    top ??= mixedTop;
    drawSysStaff(res, sys, st, ypos);
    ypos += st.height();
  }
  res.classes.add(STAFF_SYSTEM);
  res.ident = { kind: "system" };
  res.data = { top: top ?? 0, bottom: ypos } satisfies StaffSystemData;

  drawBarline(eng, res, sys);
  drawPartGroups(res, sys);
  if (scr.keepBreaks) drawPartNames(res, sys);
  for (const p of scr.parts) {
    drawLineObjs(res, sys, p);
  }
  return res;
}
