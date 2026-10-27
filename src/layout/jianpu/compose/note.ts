// 音符：数字、升降号、八度点、附点、和弦与注释、倚音、`&xx` 记号。
import type { BarlineElement, MusicElement, NoteElement } from "../../../jianpu/ast";
import type { ElementId } from "../../../model/doc";
import { AccidentalGlyph, type AccidentalKind } from "../../../engrave/accidental";
import { ACCIDENTAL_GLYPH, ACCOMP_BRACKET } from "../../../engrave/jpglyph";
import { Font } from "../../../pagetree/font";
import { GraphicPath, Group } from "../../../pagetree/pageitem";
import { type JpNumber } from "../../../engrave/jpnumber";
import { chordTextSegs, layoutHarmonySegs } from "../../../engrave/chord";
import { highDotY, lowDotY } from "../../../engrave/stack";
import type { Rect } from "../../../common/geom";
import { augDotCenter } from "../../../engrave/augdot";
import { jpTremoloCount, jpTremoloStrokes } from "../../../engrave/jptremolo";
import { breathPath } from "../../../engrave/breath";
import { jpSlideArrow, jpSlideOf } from "../../../engrave/jpslide";
import type { PlacedItem, PlacedText } from "../place/model";
import { accidentalLeadOf, graceLayout, noteBeams, stackedDigits } from "../place/vertical";
import { arpeggioGroup, JP_ARPEGGIO_SIZE } from "../../../engrave/arpeggio";
import { MULTI_REST_WIDTH } from "../place/spacing";
import { type OriginalCtx, digitItem, digitOrigin, dot, octaveDot, rect, stroke, text } from "./ctx";
import { musicText } from "../../../engrave/prims";

/** 音符/增时线上方的和弦：与五线谱共用富文本分段（根音升降号用 SMuFL csym 字形、后缀上标）。位置照定位端（`PlacedText`）。
 *  打 `harmony` 标签给可视化编辑单独点选：音符上的随音符格认；增时线上的不在任何格里，标签带增时线自己的 id（`ownId`）。 */
function paintChord(c: OriginalCtx, g: Group, t: PlacedText, x: number, baseline: number, ownId?: ElementId): void {
  const m = c.metrics;
  const wordFont = new Font(m.style.font.text.family, t.size);
  const musicFont = new Font("Bravura", t.size);
  const grp = layoutHarmonySegs(chordTextSegs(t.text, m.style.look.chordPlain, m.style.look.accidentalSide), wordFont, musicFont, c.ink);
  grp.x = x;
  grp.y = baseline;
  grp.ident = { kind: "harmony", ...(ownId !== undefined ? { id: ownId } : {}) };
  g.add(grp);
}

/** 上方带里挂在 `el` 上的字（和弦、注释、转调标签、力度/术语/跳转字、奏法记号）：y 已在定位端定死（place/band.ts），这里只照画。
 *  `kinds` 给了就只画这几种；`ownId`：挂在增时线上时那条增时线的 id（见 `paintChord`）。 */
export function paintBand(c: OriginalCtx, g: Group, el: MusicElement, kinds?: ReadonlySet<PlacedText["kind"]>, ownId?: ElementId): void {
  const list = c.band?.get(el);
  const o = c.bandOrigin;
  if (!list || !o) return;
  const m = c.metrics;
  for (const t of list) {
    if (kinds && !kinds.has(t.kind)) continue;
    const x = o.x + t.x, y = o.y + t.y;
    if (t.kind === "chord") {
      paintChord(c, g, t, x, y, ownId);
      continue;
    }
    // SMuFL 字形（奏法、力度、跳转字形）挂 `smufl`（`musicText`）：PPTX 按它转曲、成书按它落乐谱字体（同旧简谱引擎的 `SmuflText`）
    const family = t.face === "lyric" ? m.style.font.lyric.family : m.style.font.text.family;
    const tf = t.face === "music" ? musicText(t.text, new Font("Bravura", t.size), c.ink) : text(t.text, x, y, new Font(family, t.size, !!t.bold), c.ink);
    if (t.face === "music") {
      tf.x = x;
      tf.y = y;
    }
    if (t.xs) tf.charXs = t.xs; // 段落词按标点挤压后的笔位画（量宽同一份，`sectionWordRun`）
    if (t.kind === "section-word") {
      tf.classes.add("annotation"); // 可视化编辑认挂载记号用（`notePartEls`）
      tf.classes.add("section-word"); // 成书 line-check 认段落词（`pdflayout/browser.ts::CLS_TAGS`）
      tf.ident = { kind: "annotation" };
    } else if (t.kind === "key-label") tf.classes.add("key-change");
    else tf.classes.add(t.kind); // `artic` / `direction`（成书 line-check 认，`pdflayout/browser.ts::CLS_TAGS`）
    g.add(tf);
    if (t.boxed) {
      // 排练号的方框：`ink` 就是框（place/band.ts）
      const b = t.ink.offset(o.x, o.y);
      const p = stroke(c.ink, 1);
      p.moveTo(b.left, b.top);
      p.lineTo(b.right, b.top);
      p.lineTo(b.right, b.bottom);
      p.lineTo(b.left, b.bottom);
      p.close();
      p.classes.add("rehearsal");
      g.add(p);
    }
  }
}

const NOTE_TEXT = new Set<PlacedText["kind"]>(["chord", "section-word", "key-label"]);
const NOTE_MARKS = new Set<PlacedText["kind"]>(["artic", "direction"]);

/** 多小节休止（GB/T 46845 6.3.7.3「小节休止符」，谱例《豫北叙事曲》├─14─┤）：基线上一道横线、两头竖短线，横线上方居中印小节数。
 *  照谱例量的（数字墨迹高 h）：横线与竖线一样粗 0.12 h，竖线高 0.8 h，数字墨迹底离横线约 0.25 h。
 *  宽见 place/spacing.ts::MULTI_REST_WIDTH，`x` 是中点。 */
function paintMultiRest(c: OriginalCtx, g: Group, bars: number, x: number, baseline: number): void {
  const h = c.metrics.ink.noteHeight;
  const w = h * MULTI_REST_WIDTH;
  const t = h * 0.12;
  g.add(rect(c.ink, x - w / 2, baseline - t / 2, w, t));
  for (const ex of [x - w / 2, x + w / 2 - t]) g.add(rect(c.ink, ex, baseline - h * 0.4, t, h * 0.8));
  // 小节数：数字墨迹底落在横线上方约四分之一个数字墨迹高处，多位数逐位排开
  const label = [...String(bars)];
  const step = c.digitFont.measureText("0");
  label.forEach((ch, k) => {
    const { dx, dy } = digitOrigin(c, ch);
    g.add(digitItem(ch, x + dx + (k - (label.length - 1) / 2) * step, baseline + dy - h * 0.81, c.digitFont, c.ink));
  });
}

export function paintNote(c: OriginalCtx,
  root: Group,
  it: PlacedItem,
  x: number,
  baseline: number,
): JpNumber | null {
  const note = it.element as NoteElement;
  const m = c.metrics;
  const g = new Group();
  g.classes.add("entry");
  g.data = note;

  let num: JpNumber | null = null;
  if (note.multiRest && !note.hidden) paintMultiRest(c, g, note.multiRest, x, baseline);
  else if (!note.hidden) {
    const ch = note.sound === "rhythm" ? "X" : String(note.pitch);
    const { dx, dy } = digitOrigin(c, ch);
    num = digitItem(ch, x + dx, baseline + dy, c.digitFont, c.ink);
    g.add(num);

    // 变音记号：画法与定位走公共那一份（engrave/accidental.ts，照混排：csym 字形、按数字墨迹盒定位）
    const kind = note.accidental as AccidentalKind | undefined;
    if (kind && ACCIDENTAL_GLYPH[kind]) {
      const digit = { font: c.digitFont, text: ch, x: x + dx, y: baseline + dy };
      g.add(new AccidentalGlyph(kind, digit, { music: new Font("Bravura", 20), color: c.ink, kind: m.style.look.accidentalStyle, scale: m.style.look.accidentalScale }).item);
    }

    // 八度点：高音在上、低音在下，同侧多点向外叠。
    // 低音点必须挂在**减时线最下一层之下**（.jpwabc 的 entryBottom 规则：
    // above = max(数字墨迹底, 最低那条减时线的下缘)，再让开一个 stackGap），
    // 否则十六分音符的两条减时线会和低音点叠在一起。
    // 落点走公共那一份（engrave/stack.ts，墨迹到墨迹等距；低音点挂在减时线之下）
    const half = m.ink.noteHeight / 2;
    for (let i = 0; i < note.octave; i++) {
      g.add(octaveDot(c.ink, x, baseline + highDotY(-half, i, m.ink.stack), m.style.dot.octave));
    }
    for (let i = 0; i < -note.octave; i++) {
      g.add(octaveDot(c.ink, x, baseline + lowDotY(half, noteBeams(note), i, m.ink.stack), m.style.dot.octave));
    }

    // 和音：叠在上面的数字（place/vertical.ts::stackedDigits 定落点），各带临时记号、八度点与附点；减时线只在最下面那个下
    for (const sd of stackedDigits(note, m)) {
      const sch = sd.pitch === 9 ? "X" : String(sd.pitch);
      const o = digitOrigin(c, sch);
      const by = baseline + sd.y;
      g.add(digitItem(sch, x + o.dx, by + o.dy, c.digitFont, c.ink));
      const sk = sd.accidental as AccidentalKind | undefined;
      if (sk && ACCIDENTAL_GLYPH[sk]) {
        const digit = { font: c.digitFont, text: sch, x: x + o.dx, y: by + o.dy };
        g.add(new AccidentalGlyph(sk, digit, { music: new Font("Bravura", 20), color: c.ink, kind: m.style.look.accidentalStyle, scale: m.style.look.accidentalScale }).item);
      }
      for (let i = 0; i < sd.octave; i++) g.add(octaveDot(c.ink, x, by + highDotY(-half, i, m.ink.stack), m.style.dot.octave));
      for (let i = 0; i < -sd.octave; i++) g.add(octaveDot(c.ink, x, by + lowDotY(half, 0, i, m.ink.stack), m.style.dot.octave));
      const ink = o.b.offset(x + o.dx, by + o.dy);
      for (let i = 0; i < note.dots; i++) {
        const p = augDotCenter(ink, i, m.style.dot.aug, m.ink.stack.gap);
        g.add(octaveDot(c.ink, p.cx, p.cy, m.style.dot.aug));
      }
      paintTremolo(c, g, note, ink);
    }
  }

  // 琶音：竖波浪线从最低的数字画到最高的，在临时记号左边（画法与五线谱同一份，engrave/arpeggio.ts）
  if (!note.hidden && note.ornaments.some((o) => o.name === "arp")) {
    const H = m.ink.noteHeight;
    const o = digitOrigin(c, String(note.pitch));
    const inkLeft = x + o.dx + o.b.left;
    const sd = stackedDigits(note, m);
    const top = baseline + (sd.length ? sd[sd.length - 1]!.y : 0) - H / 2;
    const accLead = accidentalLeadOf({ ...note, ornaments: [] }, m);
    // 字形转过来后墨迹在定位点右边 0.39–0.84 个 staff space（= 0.12–0.25 H）：墨迹右缘离临时记号/数字左缘 0.25 H
    g.add(arpeggioGroup(inkLeft - accLead - H * 0.5, top, baseline + H / 2, H * JP_ARPEGGIO_SIZE, c.ink));
  }

  // 附点：落点走公共那一份（engrave/augdot.ts：与数字墨迹中心等高，离数字墨迹右缘一道空）
  const { dx: adx, dy: ady, b: ab } = digitOrigin(c, note.sound === "rhythm" ? "X" : String(note.pitch));
  const digitInk = ab.offset(x + adx, baseline + ady);
  for (let i = 0; i < note.dots; i++) {
    const p = augDotCenter(digitInk, i, m.style.dot.aug, m.ink.stack.gap);
    const d = octaveDot(c.ink, p.cx, p.cy, m.style.dot.aug);
    if (num) d.aug = { num, index: i };
    d.classes.add("aug-dot"); // 可视化编辑单独点选附点（`notePartEls`）
    d.ident = { kind: "aug-dot" };
    g.add(d);
  }
  if (!note.hidden && !note.multiRest) paintTremolo(c, g, note, digitInk);
  if (!note.hidden && !note.multiRest) paintSlide(c, g, note, digitInk);

  // 和弦、注释、转调标签（定位端已按墨迹堆好，place/band.ts）
  paintBand(c, g, note, NOTE_TEXT);

  // 倚音：主音左/右侧的小号数字（默认八分，故带一条减时线）
  paintGrace(c, g, note, "before", x, baseline);
  paintGrace(c, g, note, "after", x, baseline);

  // `&xx` 记号
  const before = g.children.length;
  paintOrnaments(c, g, note, x, baseline);
  for (const it of g.children.slice(before)) it.ident = { kind: "deco" };

  root.add(g);
  const id = c.doc?.idOf.get(note);
  if (id !== undefined) g.ident = { kind: "note", id, ...(c.pass !== undefined ? { pass: c.pass } : {}) };
  return num;
}

/** 同音高震音号：数字（连同附点）右下角几道左低右高的细斜线（`engrave/jptremolo.ts`，GB/T 46845 7.8.2.1）；和音每个数字各画 */
function paintTremolo(c: OriginalCtx, g: Group, note: NoteElement, digitInk: Rect): void {
  const n = jpTremoloCount(note.ornaments.map((o) => o.name));
  if (n === 0) return;
  const m = c.metrics;
  const r = m.style.dot.aug;
  const right = note.dots > 0 ? augDotCenter(digitInk, note.dots - 1, r, m.ink.stack.gap).cx + r : digitInk.right;
  const cy = (digitInk.top + digitInk.bottom) / 2;
  for (const s of jpTremoloStrokes(n, m.ink.noteHeight).strokes) {
    // 两端水平截平的平行四边形（规范谱例的字形）
    const p = new GraphicPath();
    p.moveTo(right + s.x0 - s.thick / 2, cy + s.y0);
    p.lineTo(right + s.x0 + s.thick / 2, cy + s.y0);
    p.lineTo(right + s.x1 + s.thick / 2, cy + s.y1);
    p.lineTo(right + s.x1 - s.thick / 2, cy + s.y1);
    p.close();
    p.fill = true;
    p.fillColor = c.ink;
    p.classes.add("artic");
    p.ident = { kind: "deco" };
    g.add(p);
  }
}

/** 上 / 下滑音：数字（连同附点）右侧偏上一根直线短箭头 ↗ / ↘（`engrave/jpslide.ts`，GB/T 46845 7.6.4.3） */
function paintSlide(c: OriginalCtx, g: Group, note: NoteElement, digitInk: Rect): void {
  const dir = jpSlideOf(note.ornaments.map((o) => o.name));
  if (!dir) return;
  const m = c.metrics;
  const r = m.style.dot.aug;
  const right = note.dots > 0 ? augDotCenter(digitInk, note.dots - 1, r, m.ink.stack.gap).cx + r : digitInk.right;
  const a = jpSlideArrow(dir === "up", m.ink.noteHeight);
  const p = stroke(c.ink, a.lineWidth);
  p.moveTo(right + a.x0, digitInk.bottom + a.y0);
  p.lineTo(right + a.x1, digitInk.bottom + a.y1);
  for (const [ax, ay] of a.arms) {
    p.moveTo(right + ax, digitInk.bottom + ay);
    p.lineTo(right + a.x1, digitInk.bottom + a.y1);
  }
  p.classes.add("artic");
  p.ident = { kind: "deco" };
  g.add(p);
}

/**
 * 倚音：dir=-1 前倚音（画在左），dir=1 后倚音（画在右）。
 *
 * **几何走公共那一份**（`engrave/grace.ts`），简谱排版引擎那条路
 * （`layout.ts::addGraceNotes`）用的是同一套比例——两边各自落笔，坐标只算一次。
 */
function paintGrace(c: OriginalCtx,
  g: Group,
  note: NoteElement,
  side: "before" | "after",
  x: number,
  baseline: number,
): void {
  const notes = side === "before" ? note.graceBefore : note.graceAfter;
  if (notes.length === 0) return;
  const m = c.metrics;
  const font = new Font(m.style.font.text.family, c.digitFont.size * m.style.size.grace);
  // 落位与让位同一份（place/vertical.ts::graceLayout）：整块倚音的墨迹底离主音那一摞的顶一道空
  const geom = graceLayout(note, side, m, x, baseline);
  for (const d of geom.digits) {
    // 数字按**墨迹中心**定位（公共几何给的是中心，这里换算成落笔点）
    const b = font.charBound(d.text);
    const t = text(d.text, d.cx - (b.left + b.right) / 2, d.cy - (b.top + b.bottom) / 2, font, c.ink);
    t.classes.add("grace");
    g.add(t);
  }
  for (const o of geom.dots) g.add(dot(c.ink, o.cx, o.cy, o.r));
  // 升降号：与主音同一套画法（Bravura 的 SMuFL 字形、按墨迹定位），只是所有量
  // 都由公共几何按倚音的墨迹给好——字号也是反推出来的，不能照主音那个字号缩。
  for (const acc of geom.accidentals) {
    const glyph = ACCIDENTAL_GLYPH[acc.alter];
    if (!glyph) continue;
    const probe = new Font("Bravura", 100);
    const pb = probe.charBound(glyph);
    const inkAt100 = Math.abs(pb.bottom - pb.top) || 68;
    const accFont = new Font("Bravura", (acc.inkHeight * 100) / inkAt100);
    const ab = accFont.charBound(glyph);
    g.add(text(glyph, acc.inkRight - ab.right, acc.inkCy - (ab.top + ab.bottom) / 2, accFont, c.ink));
  }
  for (const bm of geom.beams) {
    const r = rect(c.ink, bm.x, bm.y, bm.w, bm.h);
    r.classes.add("grace-line");
    g.add(r);
  }
  if (geom.hook) {
    const p = stroke(c.ink, geom.hook.width);
    p.moveTo(geom.hook.m[0], geom.hook.m[1]);
    p.cubicTo(...geom.hook.c);
    p.classes.add("grace-line");
    g.add(p);
  }
}

/** 挂在音符/小节线上的 `&xx` 记号：伴奏括弧、换气贴着音符画；奏法记号、力度、术语、跳转字照上方带的位置画（place/band.ts）。 */
export function paintOrnaments(c: OriginalCtx, g: Group, el: NoteElement | BarlineElement, x: number, baseline: number): void {
  const m = c.metrics;
  for (const orn of el.ornaments) {
    if (ACCOMP_BRACKET.has(orn.name)) {
      // 伴奏括弧：音符外侧的一个大圆括号
      const isLeft = orn.name === "zkh";
      const h = m.ink.noteHeight * 1.5;
      const bx = x + (isLeft ? -m.ink.noteHeight * 0.62 : m.ink.noteHeight * 0.62);
      const p = stroke(c.ink, 1.4);
      const bend = isLeft ? -4.5 : 4.5;
      p.moveTo(bx, baseline - h / 2);
      p.cubicTo(bx + bend, baseline - h / 4, bx + bend, baseline + h / 4, bx, baseline + h / 2);
      p.classes.add("artic");
      g.add(p);
    } else if (orn.name === "hx") {
      // 换气：细笔画的 V 挂在音符右上角（形状与落点走公共那一份，engrave/breath.ts）
      g.add(breathPath(x, baseline, m.ink.noteHeight, 1.1, c.ink)); // 类名 `breath`，不进上方带（同旧简谱引擎）
    }
  }
  paintBand(c, g, el, NOTE_MARKS);
}
