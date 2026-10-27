// 五线谱 / 混排的版面：混排简谱层与谱表上方那一摞（formatMixedScore / placeAboveStaff），
// 以及分页 + 标题块（paoSingleScore 的 getFrames / flowLayout / drawFrames 移植）。
// 页面尺寸/边距以 MusicXML <defaults> 为准（不固定画布），单位 tenths。只产页面树，不碰 DOM。
// 从 musicpp util/pao.cpp 移植（formatScorePAO + paoSingleScore，不含 fixPaoScore 逐曲 hack）。

import { headerRoleOfCredit } from "../style/header";
import { headerRoleFont } from "../engrave/header";
import { Fraction } from "../common/fraction";
import { Matrix33 } from "../common/geom";
import { Font } from "../pagetree/font";
import { Group, TextFrame } from "../pagetree/pageitem";
import { harmonyBand, LCR, SKYLINE_BIN, StaffLayout, Notation, ScoreCredit, Sys, type MeasureText, type PartLayout, type TextBlock } from "./model";
import { autoStaffDistances } from "./layoutpass";
import { drawSystem, endingPlace, harmonyWidthOf } from "./render";

// -----------------------------------------------------------------------
// formatMixedScore（formatScorePAO port, without per-song hacks）

/**
 * Post-process the loaded StaffLayout to set up Mixed notation on the first part:
 * - Set staves[0].notation[0] = Mixed
 * - Run calcMixedStaffY (needs notes already in place)
 * - Move harmonies to harmonyY
 * - Scale P2 lyric font × 0.8
 */
/** 混排简谱层顶（数字顶）到自动放置的文字记号基线的净空：留给简谱层上方的弧与高音点（tenths） */
const MIXED_TEXT_CLEAR = 16;

/** 文字块的高（避让用）：乐谱字体（力度、速度记号里的音符）**不能按字体度量算**——Bravura 的全局
 *  ascent−descent 约 4 个字号，一个 `mp` 就把块撑成好几行高；按字号的 0.6 估它的墨迹，文字照字体盒。 */
function textInkHeight(t: TextBlock): number {
  let h = 0;
  for (const it of t.data) {
    if (it.text === "\n") continue;
    const fm = it.font.metrics;
    h = Math.max(h, it.music ? it.font.size * 0.6 : fm.descent - fm.ascent);
  }
  return h;
}
/** 文字块墨迹的横向范围（相对块左缘）：单行逐段累计前进宽、首尾段取字形墨迹；多行与乐谱字体段照前进宽 */
function textInkSpan(t: TextBlock): [number, number] {
  const w = t.width();
  if (t.data.some((it) => it.text === "\n")) return [0, w];
  let x = 0;
  let l: number | null = null;
  let r = 0;
  for (const it of t.data) {
    x += it.padBefore ?? 0;
    const adv = it.font.measureText(it.text);
    if (it.text.trim()) {
      const b = it.music ? { left: 0, right: adv } : it.font.charBound(it.text);
      if (l === null) l = x + b.left;
      r = x + b.right;
    }
    x += adv;
  }
  return l === null ? [0, w] : [l, r];
}

/** 五线谱档：谱表内容上沿到和弦符号墨迹底的净空（tenths） */
const HARMONY_STAFF_GAP = 6;

export function formatMixedScore(score: StaffLayout, jianpuPart = 0): void {
  if (score.parts.length === 0) return;

  // 简谱层叠在哪个声部上（声部面板「简谱旋律取自」，缺省第一声部）
  const p = score.parts[jianpuPart] ?? score.parts[0]!;
  if (p.staves.length === 0) return;

  // Set Mixed notation for first staff from tick 0
  p.staves[0].notation.set(new Fraction(0), Notation.Mixed);
  const hosts = mixedHostsBySystem(score, p);

  placeAboveStaff(score, true, hosts);

  // P2 lyric font × 0.8
  const lastPart = score.parts[score.parts.length - 1];
  if (lastPart !== p && lastPart.pid === "P2") {
    const refFont = score.defaults.lyricFont;
    const fnt2 = refFont.scaled(0.8);
    lastPart.setLyricFont(fnt2);
  }
  // 谱表间距照 MusicXML 的 staff-distance，不按包围盒抬高（formatScorePAO 没有这一步；
  // 成品《受苦圣徒，到基督前》各行谱表间距正是 staff-distance 原值）
}

/**
 * 简谱层所在声部的谱表在某个系统里藏着（单行谱的系统只印了另一个声部）：这一系统的简谱层改叠在**第一个可见谱表**上，
 * 不然整行简谱层是空的（识别的简线混排谱，单行与两行谱表交替）。`notation` 是按 tick 的表，在系统首拍切过去、下一系统首拍切回来。
 * 返回借去叠简谱层的声部（不含 `p`）。
 */
function mixedHostsBySystem(score: StaffLayout, p: PartLayout): PartLayout[] {
  const hosts = new Set<PartLayout>();
  for (const sys of score.systems) {
    const own = sys.staves.find((st) => st.part() === p && st.partStaff.subIndex === 0);
    if (!own || own.staffVisible) continue;
    const alt = sys.staves.find((st) => st.staffVisible && st.partStaff.subIndex === 0);
    if (!alt) continue;
    const t0 = sys.measures[0].offset;
    const t1 = sys.measures[sys.measures.length - 1].endTick();
    // 后面的系统按次序再设，同一 tick 后设的覆盖：连着几个系统都借时不会被切回去
    p.staves[0].notation.set(t0, Notation.Normal);
    p.staves[0].notation.set(t1, Notation.Mixed);
    alt.partStaff.notation.set(t0, Notation.Mixed);
    alt.partStaff.notation.set(t1, Notation.Normal);
    hosts.add(alt.part());
  }
  return [...hosts];
}

/** 第一声部谱表上方那一摞：量上沿（`calcMixedStaffY`）→ 和弦 y → 自动放置的速度/文字记号抬过去。
 *  混排（`formatMixedScore`）与五线谱档共用。带坐标的五线谱档也走：原文和弦的 default-y 常贴着谱表上沿
 *  （Finale 出的 500 首是 9），朝上符干、符杠一高就压上去（007、008），和弦行一律让开谱面内容。 */
/** 排练号框右缘到并排的速度记号墨迹左缘（tenths，半个线距多一点） */
const AFTER_REHEARSAL = 6;
/** 排练号后面接成一行的文字与速度记号之间再多空的（tenths；加上 `AFTER_REHEARSAL` 约一个字宽） */
const WORDS_GAP = 4;
/** segno / coda 墨迹底到下面谱面内容（或顶线）的空（tenths） */
const SIGN_CLEAR = 8;
/** 行首 segno / coda 离小节号右缘（tenths） */
const AFTER_BAR_NUMBER = 3;

export function placeAboveStaff(score: StaffLayout, mixed: boolean, hosts: readonly PartLayout[] = []): void {
  // 源谱版面档逐个声部摞：首个声部常整行不印（合唱谱人声进来之前），文字记号挂在下面的声部上（望十架曲首的速度与「unis.」叠成一团）
  const ps = score.keepBreaks ? score.parts : score.parts.slice(0, 1);
  for (const p of ps) placePartAboveStaff(score, p, mixed);
  // 借去叠简谱层的声部（`mixedHostsBySystem`）：只在它叠着简谱层的那几个系统里摞
  for (const p of hosts) if (!ps.includes(p)) placePartAboveStaff(score, p, mixed, true);
  // 文字往上摞过后与上一谱表的不碰距离要重量（谱表距离是排行时按当时的文字高量的）
  if (score.keepBreaks) autoStaffDistances(score);
}

function placePartAboveStaff(score: StaffLayout, p: PartLayout, mixed: boolean, hostingOnly = false): void {
  if (!p || p.staves.length === 0) return;
  const hosting = (sys: Sys): boolean => p.staves[0]!.getNotation(sys.measures[0].offset) === Notation.Mixed;
  // Calculate mixed staff y positions (needs chords/slurs in place)
  if (!hostingOnly) p.calcMixedStaffY();
  else for (const sys of score.systems) if (hosting(sys)) for (const st of sys.staves) if (st.part() === p) st.calcMixedStaffY(sys);

  const eng = score.options;
  const [harmTop, harmBot] = harmonyBand(score);
  for (const sys of score.systems) {
    if (hostingOnly && !hosting(sys)) continue;
    for (const st of sys.staves) {
      if (st.part() !== p) continue;
      // 纯五线谱：和弦底贴着谱表上沿（高音、朝上符干、上方弧）再留一点空。`calcMixedStaffY` 的 harmonyY
      // 是给混排算的——里头按简谱层的高音点、弧中段再往上加，放到五线谱上就离得太远
      if (!mixed) st.harmonyY = -st.minY + HARMONY_STAFF_GAP - harmBot - 3;
      // Move harmony y to harmonyY
      for (const m of sys.measures) {
        for (const h of p.measures[m.index]?.harmonies ?? []) h.y = st.harmonyY + 3;
      }
      if (st.partStaff !== p.staves[0]) continue;
      // 自动铺排的速度/文字记号：缺省高度只让开了五线谱。混排时简谱层（连同其上的弧、高音点）在它上面，抬过去；
      // 自动铺排时和弦行也在它下面，再抬过和弦。带 default-y 的原文不动（照 musicpp）。
      let floor = mixed ? -st.minY + eng.mixStaffDist + eng.mixStaffHeight + MIXED_TEXT_CLEAR : -st.minY + MIXED_TEXT_CLEAR;
      // 横向撞上的（曲首的速度记号与 `mp` 落在同一拍上）往上摞：y 是谱表之上的高度，大的在上
      const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
      if (st.hasHarmony) {
        if (score.autoLayout) floor = Math.max(floor, st.harmonyY + 3 + harmTop + MIXED_TEXT_CLEAR / 2);
        else {
          // 带坐标的谱：文字与和弦同一基线（005「（副歌）」用户定 2026-10-14：贴近音符、约与和弦同高），
          // 横向撞上和弦才往上摞
          floor = Math.max(floor, st.harmonyY + 3);
          for (const m of sys.measures) {
            for (const h of p.measures[m.index]?.harmonies ?? []) {
              const w = harmonyWidthOf(score, h);
              const cx = m.xpos() + h.x + 6.5;
              placed.push({ x0: cx - w / 2, x1: cx + w / 2, y0: h.y + harmBot, y1: h.y + harmTop });
            }
          }
        }
      }
      // 房号线（连同房号）：文字摞到它上面（018 的 Fine、D.S. 原先压在一房二房的括线上）
      for (const e of p.endings) {
        if (!sys.overlap(e)) continue;
        const { left, right, yPos } = endingPlace(e, sys, mixed);
        const y = yPos ?? 0;
        placed.push({ x0: left, x1: right, y0: 30 - y - 20, y1: 50 - y });
      }
      // 谱表上方的词（`placement="above"`）：文字记号摞到它上面
      for (const m of sys.measures) {
        for (const l of p.measures[m.index]?.lyrics ?? []) {
          if (l.staff !== 0 || l.y <= 0 || l.empty) continue;
          const lx = m.xpos() + l.x + l.xOffset; // 字的左缘
          placed.push({ x0: lx, x1: lx + l.width, y0: l.y - l.font.metrics.descent, y1: l.y + l.font.size });
        }
      }
      // **速度记号最后排**（摞在最上面）：力度、文字记号贴着谱面，速度是整段的标题性记号，
      // 按出现先后摞的话曲首的 `♩=88` 会被同一拍上的 `mp` 压到下面去
      const isTempo = (t: MeasureText): boolean => !!t.src && [t.src, ...(t.src.more ?? [])].some((d) => d.type === "metronome");
      const blocks = sys.measures.flatMap((m) => (p.measures[m.index]?.textBlocks ?? []).map((t) => ({ m, t })));
      const isSign = (t: MeasureText): boolean => t.src?.type === "segno" || t.src?.type === "coda";
      blocks.sort((a, b) => Number(isTempo(a.t)) - Number(isTempo(b.t)));
      // 同一拍上的几条文字（`<words>`，曲首「欢快 热烈地」与「pizz」）**先写的在上**（ABC §4.19 连写注记的口径）：
      // 下面按先后往上摞，所以这几条在各自占的位子里倒过来
      const isWords = (t: MeasureText): boolean => !!t.src && t.src.type === "words" && !t.boxed;
      const sameBeat = new Map<string, number[]>();
      blocks.forEach(({ m, t }, i) => {
        if (!isWords(t)) return;
        const k = `${m.index}@${t.offset.toString()}`;
        sameBeat.set(k, [...(sameBeat.get(k) ?? []), i]);
      });
      for (const idx of sameBeat.values()) {
        if (idx.length < 2) continue;
        const picked = idx.map((i) => blocks[i]!).reverse();
        idx.forEach((i, k) => (blocks[i] = picked[k]!));
      }
      // 排练号那一拍上的文字、速度记号接在框右边排成一行（原谱「【A】欢快 热烈地 ♩=144」）：
      // 这一拍的几条挪到一起、按「框 → 文字 → 速度」的次序排（小钗的 GT 是三条 direction，别的分谱文字与速度合一条）
      const keyOf = (b: { m: { index: number }; t: MeasureText }) => `${b.m.index}@${b.t.offset.toString()}`;
      const boxedBeats = new Set(blocks.filter((b) => b.t.boxed).map(keyOf));
      const inRow = (b: { m: { index: number }; t: MeasureText }) =>
        boxedBeats.has(keyOf(b)) && (b.t.boxed || isTempo(b.t) || (isWords(b.t) && b.t.src?.placement !== "below"));
      const rank = (t: MeasureText) => (t.boxed ? 0 : isTempo(t) ? 2 : 1);
      const firstAt = new Map<string, number>();
      blocks.forEach((b, i) => {
        if (inRow(b) && !firstAt.has(keyOf(b))) firstAt.set(keyOf(b), i);
      });
      const order = blocks.map((b, i) => (inRow(b) ? firstAt.get(keyOf(b))! + rank(b.t) / 10 : i));
      const sorted = blocks.map((b, i) => ({ b, o: order[i]! })).sort((a, b) => a.o - b.o).map((x) => x.b);
      blocks.splice(0, blocks.length, ...sorted);
      // 源谱版面档：文字按它横向跨过的那一段音符与弧贴（原谱「unis.」「dim.」落在低音处、离谱表近），不按整行最高的音一律抬
      const sky = score.keepBreaks && !mixed && !st.hasHarmony ? st.skyline(sys, true).above : null;
      // segno / coda 不论版面档都按轮廓贴（`signLow`）：轮廓按需量一次
      let skyAll: number[] | null = null;
      const localFloorAt = (x0: number, x1: number): number => {
        skyAll ??= st.skyline(sys, true).above;
        let top = 0;
        for (let b = Math.max(0, Math.floor(x0 / SKYLINE_BIN)); b <= Math.min(skyAll.length - 1, Math.floor(x1 / SKYLINE_BIN)); b++) top = Math.max(top, skyAll[b]!);
        return top + MIXED_TEXT_CLEAR;
      };
      const localFloor = (x0: number, x1: number): number => {
        let top = 0;
        for (let b = Math.max(0, Math.floor(x0 / SKYLINE_BIN)); b <= Math.min(sky!.length - 1, Math.floor(x1 / SKYLINE_BIN)); b++) top = Math.max(top, sky![b]!);
        return top + MIXED_TEXT_CLEAR;
      };
      /** 已摆好的排练号框（小节@拍位 → 墨迹范围） */
      const rehearsalAt = new Map<string, { x1: number; y0: number; y1: number }>();
      for (const { m, t } of blocks) {
        // 原文带 default-y 的谱表上方文字（「（副歌）」）也只往上抬不往下压：混排时简谱层插在谱表与它之间，
        // 五线谱档和弦被抬离符干后原高度会压在和弦行上（006）
        if (t.staff !== 0 || (!t.autoY && !(t.y > 0))) continue;
        // 源谱版面档已放到下方的（`placement="below"` 的力度、文字记号，`placeDynamicsBelow`）不抬回上方
        if (t.autoY && t.y < 0 && t.src?.placement === "below") continue;
        // 识别稿照原图写了高度的力度（`sourceY`）：源谱版面档里只按它横向跨过的那段轮廓让开，不抬到整行最高处
        const keepSource = t.sourceY && !!sky;
        // segno / coda 照原谱贴着谱表（按它横向跨过那段轮廓让），不随整行文字抬高（八段锦各分谱 m32、m78 的 ⊕ 就在顶线上方）
        // 有和弦行的不贴：和弦在谱表与它之间（500 首 018）
        // 原文写了坐标的（Finale 出的 500 首）照原样，不挪
        const signLow = isSign(t) && !mixed && !st.hasHarmony && !t.signPlaced;
        // 带坐标的谱：原文高过和弦行的文字也落回和弦那一层（005「（副歌）」用户定：与和弦大致同高），撞上再摞；速度记号不动
        if (!keepSource && !signLow && (t.y < floor || (!score.autoLayout && st.hasHarmony && !isTempo(t)))) t.y = floor;
        const w = t.width();
        const left = m.xpos() + t.x - (t.justify === LCR.Center ? w / 2 : t.justify === LCR.Right ? w : 0);
        // 横向按墨迹量：全角括号「（」「）」前进宽里一半是空白，按前进宽量「（副歌）」就把旁边的和弦也算成撞上了（008）
        const [inkL, inkR] = textInkSpan(t);
        let x0 = left + inkL;
        let x1 = left + inkR;
        // segno / coda 记在小节头、小节末的，居中骑在那根小节线上（原谱 m77|m78、m32 末的 ⊕；【E】在它右边）
        if (isSign(t) && !t.signPlaced) {
          const atEnd = t.offset.compareTo(m.dur) >= 0 && m.dur.toFloat() > 0;
          // 行首小节不骑系统起始线：那样压住小节号与括号（500 首 018 m9 的 𝄋）；
          // 贴谱表的（`signLow`）照原谱接在行首小节号右边、谱号上方（钢片琴 m33 的 ⊕）
          const atStart = t.offset.toFloat() === 0 && sys.measures[0] !== m;
          if (signLow && t.offset.toFloat() === 0 && sys.measures[0] === m && m.showBarNumber && !eng.hideBarNumber) {
            const shift = m.xpos() + new Font(eng.wordFont, 20).measureText(m.number) + AFTER_BAR_NUMBER - x0;
            t.x += shift;
            x0 += shift;
            x1 += shift;
          }
          if (atEnd || atStart) {
            // 小节线的 x 同 `render.ts` 画小节线：下一小节的 `sibKeyOffset` 往回让，行末再扣掉预告拍号/调号（各连 5 的空）
            const mi = sys.measures.indexOf(m);
            const last = mi === sys.measures.length - 1;
            const trail = last ? (sys.timeChangeWidth > 0 ? sys.timeChangeWidth + 5 : 0) + (sys.keyChangeWidth > 0 ? sys.keyChangeWidth + 5 : 0) : 0;
            const barX = atEnd ? m.xpos() + m.width - (sys.measures[mi + 1]?.sibKeyOffset ?? 0) - trail : m.xpos() - m.sibKeyOffset;
            const shift = barX - (x0 + x1) / 2;
            t.x += shift;
            x0 += shift;
            x1 += shift;
          }
        }
        // 原谱 ⊕ 底离下面的谱面约 0.8 格（m32 行末）到 1.7 格（m78）：贴轮廓留 `SIGN_CLEAR`。
        // y 是字形基线，⊕ 有一截落在基线下（Bravura 字形盒下沿 −0.632 格 / 字号 4 格），按字形盒补回
        if (signLow) {
          const it = t.data.find((d) => d.music);
          const bb = it ? eng.meta.getBBox(it.text) : null;
          const descent = bb ? Math.max(0, -bb.bBoxSW[1]) * (it!.font.size / 4) : 0;
          t.y = Math.max(localFloorAt(x0, x1) - MIXED_TEXT_CLEAR, 0) + SIGN_CLEAR + descent;
        }
        else if (sky && t.autoY && !isTempo(t)) t.y = localFloor(x0, x1);
        else if (keepSource) t.y = Math.max(t.y, localFloor(x0, x1) - MIXED_TEXT_CLEAR / 2);
        const h = textInkHeight(t);
        // 同一拍上排练号后面的文字、速度记号：接在前一块右边、对排练号框竖向居中，不往上摞（八段锦扬琴、小钗 m1）
        const beatKey = `${m.index}@${t.offset.toString()}`;
        const host = !t.boxed && inRow({ m, t }) ? rehearsalAt.get(beatKey) : undefined;
        if (host) {
          const shift = host.x1 + AFTER_REHEARSAL - x0;
          t.x += shift;
          x0 += shift;
          x1 += shift;
          t.y = host.y0 + (host.y1 - host.y0 - h) / 2;
        }
        for (let again = true; again; ) {
          again = false;
          for (const b of placed) {
            if (b.x1 + MIXED_TEXT_CLEAR / 2 <= x0 || b.x0 >= x1 + MIXED_TEXT_CLEAR / 2) continue;
            if (t.y + h <= b.y0 || t.y >= b.y1) continue;
            t.y = b.y1 + MIXED_TEXT_CLEAR / 2;
            again = true;
          }
        }
        placed.push({ x0, x1, y0: t.y, y1: t.y + h });
        // 框比整块前进宽再往外扩 0.25 个字号（`render.ts::drawTextBlock`），并排的记号从框线外量；接上的块把右缘往后推。
        // 不套框的「【A】」从墨迹右缘量，接上的字离它 MIXED_TEXT_CLEAR / 2（再近就算撞上、被摞到上面去）
        if (t.boxed) rehearsalAt.set(beatKey, { x1: (t.frameless ? x1 + MIXED_TEXT_CLEAR / 2 - AFTER_REHEARSAL : left + w + (t.data.find((it) => it.text !== "\n")?.font.size ?? 0) * 0.25), y0: t.y, y1: t.y + h });
        else if (host) rehearsalAt.set(beatKey, { ...host, x1: x1 + WORDS_GAP });
      }
    }
  }
}

// -----------------------------------------------------------------------
// M5: 分页+标题块（paoSingleScore 的 getFrames/flowLayout/drawFrames 移植）

// 页面高度/边距来自 MusicXML <defaults>（score.defaults）；以下仅作未提供时的回退。
export const PAGE_HEIGHT_FALLBACK = 1870;
const FRAME_GAP = 20;
const TITLE_OFFSET = 170; // hh(150) + 20
/** 自动铺排：标题块最低一行的基线到首行谱内容顶的余量（含该行字的下伸） */
const TITLE_GAP = 30;
/** 页眉墨迹底到首行谱内容（和弦、高音、符干）顶的最小净空 */
const HEADER_GAP = 12;
/** 源谱版面档：上下两个系统按轮廓判碰后至少留的空（tenths，同谱表之间的 `AUTO_STAFF_GAP`）。按整块框比的 `FRAME_GAP` 要松些 */
const SOURCE_SYSTEM_GAP = 12;
/** 源谱版面档：没有页眉的页，首个系统最高上探到离纸边这么远（pt，5mm；同识别写出的最小页边距） */
const SOURCE_MIN_TOP_PT = (5 * 72) / 25.4;

interface FrameItem {
  system: Sys;
  topY: number;
  bottomY: number;
  height: number;
  musicYOffset: number;
  credits: ScoreCredit[];
}

interface LayoutFrame {
  height: number;
  ypos: number;
  newPage: boolean;
}

function getFrames(score: StaffLayout): FrameItem[] {
  const items: FrameItem[] = [];
  for (const sys of score.systems) {
    // System::getYBound（model.ts）：忠实移植，topY 为上方延伸量，bottomY 为下方（负）。
    const [topY, bottomY] = sys.getYBound();
    items.push({
      system: sys,
      topY,
      bottomY,
      height: topY - bottomY,
      musicYOffset: 0,
      credits: [],
    });
  }
  return items;
}

/** `pageStarts`：写明了换页的系统（源文的 `%%newpage`，`StaffLayout.hardBreaks`），到它必换页 */
function flowLayout(items: FrameItem[], ph: number, pageStarts: ReadonlySet<Sys> = new Set()): LayoutFrame[] {
  const result: LayoutFrame[] = [];
  let ypos = 0;
  let lastMrg = 0;
  for (const [i, frm] of items.entries()) {
    const mrg = Math.max(lastMrg, FRAME_GAP);
    const bot = ypos + frm.height;
    // 首帧总是开新页；长图（ph = Infinity）此后不再分页
    const np = i === 0 || bot + mrg > ph || pageStarts.has(frm.system);
    const lf: LayoutFrame = { height: frm.height, ypos: 0, newPage: np };
    if (np) {
      lastMrg = 0;
      ypos = 0;
    } else {
      ypos += mrg;
    }
    lf.ypos = ypos;
    ypos += frm.height;
    lastMrg = FRAME_GAP;
    result.push(lf);
  }
  return result;
}

/** 一个系统的横向轮廓（各可见谱表 `SysStaff.skyline` 并起来）：首谱表顶线为 0、向下为正，`top` 是伸上去的高（正数）、
 *  `bot` 是伸下去的深；`x0` 是它在版心里起头的那一段（行首缩进不同的系统按版心对齐） */
function systemSkyline(sys: Sys): { top: number[]; bot: number[]; x0: number } {
  let top: number[] = [];
  let bot: number[] = [];
  sys.staves.forEach((st, k) => {
    if (!st.staffVisible) return;
    const sk = st.skyline(sys);
    const y = sys.ypos(k);
    if (!top.length) {
      top = sk.above.map(() => -Infinity);
      bot = sk.below.map(() => -Infinity);
    }
    sk.above.forEach((v, b) => { top[b] = Math.max(top[b]!, v - y); });
    sk.below.forEach((v, b) => { bot[b] = Math.max(bot[b]!, y + v); });
  });
  return { top, bot, x0: Math.round(sys.leftMargin / SKYLINE_BIN) };
}

/** 上下两个系统首谱表顶线之间至少多远才不相碰：逐段取上系统伸下去的与下系统伸上来的之和，留 `SOURCE_SYSTEM_GAP` */
function systemGap(a: Sys, b: Sys): number {
  const pa = systemSkyline(a);
  const pb = systemSkyline(b);
  let need = -Infinity;
  for (let k = 0; k < pa.bot.length; k++) {
    const j = k + pa.x0 - pb.x0;
    if (j >= 0 && j < pb.top.length) need = Math.max(need, pa.bot[k]! + pb.top[j]!);
  }
  // 横向一段都不重叠（行很短）：按整行最深对最高
  if (need === -Infinity) need = Math.max(...pa.bot) + Math.max(...pb.top);
  return need + SOURCE_SYSTEM_GAP;
}

/**
 * 源谱版面档（`score.keepBreaks`）的装页：页照原谱分（`score.pages` 由 `new-page` 建），各系统尽量落在原谱的位置
 * （`sys.distance`：`updateLayoutByPrint` 折好的首谱表顶线离上边距的距离），只在会与上一系统相碰时往下让。
 * 相碰按**横向轮廓**判（`systemGap`）：原谱上下两个系统是咬合着排的（上一行的低音与下一行的高音错开），拿整块框比
 * 满页的原谱一页就排不下。
 * 一页排不下：按比例压**各系统多出不碰距离的那截**（页首那截压到页首能到的最高处）与**系统内各谱表距离多出不碰距离的那截**
 * （`SysStaff.minDistance`）；压到底仍排不下才把末行挪到下一页，挪下去的行不再有原位，与下一页的行一起照同一规则排。
 * 并进去会把下一页原有的行再挤出去时不并，挪下去的行单独成页：不然一处排不下逐页往后挤（扫描件望十架十页挪了 15 行），
 * 单独成页只多一页，后面各页仍照原谱。
 * 上边距是按识别出的墨迹框量的（弧、符杠不在里面），原谱页首那一行的弧与高音常伸进这片地方：
 * 没有页眉的页，首个系统可以上探到离纸边 `SOURCE_MIN_TOP` 为止。
 */
function sourceFlow(score: StaffLayout, items: FrameItem[], phOf: (page: number) => number): LayoutFrame[] {
  /** 当前这一页内容能用的高度（有页脚的页到页脚顶为止，`contentLimit`） */
  let ph = phOf(0);
  const rise = Math.max(0, score.defaults.topMargin - SOURCE_MIN_TOP_PT / score.scaling);
  const result: LayoutFrame[] = items.map((it) => ({ height: it.height, ypos: 0, newPage: false }));
  const index = new Map(items.map((it, i) => [it.system, i]));
  const pages = score.pages.map((pg) => pg.systems.map((sys) => index.get(sys)!).filter((i) => i !== undefined));
  /** 原位：首谱表顶线离上边距多远；挪过页的没有 */
  const want = items.map((it) => it.system.distance);
  const moved = new Set<number>();
  /** 系统内可压的谱表（首个可见谱表之后的）与各自可压的量 */
  const slack = (i: number) => items[i]!.system.staves.filter((st, k) => k > 0 && st.staffVisible && st.distance > st.minDistance);
  const staffExcess = (i: number) => slack(i).reduce((a, st) => a + st.distance - st.minDistance, 0);
  /** 系统内各谱表距离比原谱多出来的总和 */
  const growth = (i: number) =>
    items[i]!.system.staves.reduce((a, st, k) => a + (k > 0 && st.staffVisible ? st.distance - (st.srcDistance ?? st.distance) : 0), 0);
  /** 首谱表顶线最高能到哪（页首：框顶不高过 `lo`，首页还要让开页眉 `musicYOffset`） */
  const floorOf = (i: number, lo: number) => lo + items[i]!.topY + items[i]!.musicYOffset;
  const refresh = (i: number) => {
    const it = items[i]!;
    const [top, bot] = it.system.getYBound();
    it.topY = top;
    it.bottomY = bot;
    it.height = top - bot + it.musicYOffset;
    result[i]!.height = it.height;
  };
  /** 照原位、只往下让排一页：首谱表顶线的位置、上下相邻两行的不碰距离、末行压到底还超出多少（`over`、可压的总量 `total`） */
  const trial = (list: number[], lo: number) => {
    const gaps = list.map((i, k) => (k === 0 ? 0 : systemGap(items[list[k - 1]!]!.system, items[i]!.system)));
    const ls: number[] = [];
    list.forEach((i, k) => {
      const floor = k === 0 ? floorOf(i, lo) : ls[k - 1]! + gaps[k]!;
      // 上一行比原谱长高了（谱表间距按轮廓撑开、上一行自己又往下让过）：这一行跟着往下顺延，保住原谱两行之间的空；
      // 从前只照原位，长高的那截吃掉两行之间的空、贴到 `SOURCE_SYSTEM_GAP`（破碎 p5 49 小节那行与下一行）
      const prev = k > 0 ? list[k - 1]! : -1;
      const target = moved.has(i) ? floor : k === 0 || moved.has(prev) ? want[i]! : ls[k - 1]! + want[i]! - want[prev]! + growth(prev);
      ls.push(Math.max(target, floor));
    });
    const lastI = list[list.length - 1]!;
    const over = ls[ls.length - 1]! - items[lastI]!.bottomY - ph;
    const gapExcess = ls.map((l, k) => l - (k === 0 ? floorOf(list[0]!, lo) : ls[k - 1]! + gaps[k]!));
    const total = gapExcess.reduce((a, b) => a + b, 0) + list.reduce((a, i) => a + staffExcess(i), 0);
    return { ls, over, gapExcess, total };
  };
  const loOf = (list: number[]) => (items[list[0]!]!.credits.length ? 0 : -rise);
  /** 排一页；排不下的末几行挪出来交回 */
  const place = (list: number[]): number[] => {
    const out: number[] = [];
    if (!list.length) return out;
    const lo = loOf(list);
    for (;;) {
      const { ls, over, gapExcess, total } = trial(list, lo);
      if (over > 0) {
        if (total < over && list.length > 1) {
          const last = list.pop()!;
          moved.add(last);
          out.unshift(last);
          continue;
        }
        const keep = total > 0 ? Math.max(0, 1 - over / total) : 0;
        for (const i of list) {
          const sts = slack(i);
          if (!sts.length) continue;
          for (const st of sts) st.distance = st.minDistance + (st.distance - st.minDistance) * keep;
          refresh(i);
        }
        list.forEach((i, k) => {
          ls[k] = k === 0
            ? floorOf(i, lo) + gapExcess[0]! * keep
            : ls[k - 1]! + systemGap(items[list[k - 1]!]!.system, items[i]!.system) + gapExcess[k]! * keep;
        });
      }
      list.forEach((i, k) => {
        const it = items[i]!;
        result[i]!.ypos = ls[k]! - it.topY - it.musicYOffset;
        result[i]!.newPage = k === 0;
      });
      return out;
    }
  };
  // 挪下去的行先并进下一页；并进去会把那一页原有的行再挤出去（级联）时，挪下去的行单独成页，后面各页照原谱
  let carry: number[] = [];
  for (let p = 0; p < pages.length || carry.length; p++) {
    ph = phOf(p);
    const own = pages[p] ?? [];
    if (carry.length && own.length) {
      const both = [...carry, ...own];
      const t = trial(both, loOf(both));
      if (t.over > t.total) {
        let rest = carry;
        while (rest.length) rest = place(rest);
        carry = [];
      }
    }
    carry = place([...carry, ...own]);
  }
  return result;
}

interface HeadLine { tf: TextFrame; x: number; y: number; inkTop: number; inkBottom: number }

/** 一页的页眉（credit）逐行排好：落笔点与墨迹上下沿（SVG 自上而下，tenths） */
function headerLines(
  score: StaffLayout,
  credits: ScoreCredit[],
  topMargin: number,
  pageHeight: number,
  pageWidthTenths: number,
  /** 页脚那几条（`footerCredits`）单独排：不做下面 Sibelius 整块重排的检测（它们本来就在页底） */
  footer = false,
): HeadLine[] {
  // Credits (title block text) for this frame. credit-words 可含换行 → 逐行排版。
  // Sibelius MusicXML 导出 bug：credit-words 的 default-y 被整体压到页面底部
  //（绝对原点错误，但各 credit 间的相对间距仍然正确）。
  // 检测：最高的 credit（default-y 最大者）按 spec 解释（pageHeight - y）后仍落在
  // 页面下半 → 判定为该 bug，以页首为锚重排整个标题块，保留相对间距与水平对齐。
  // 正常文件标题 default-y≈页高（落在上半），不触发，绝对定位照旧。
  const creditMaxY = credits.length
    ? Math.max(...credits.map((c) => c.y))
    : 0;
  const reanchorTop = !footer && credits.length > 0 && pageHeight - creditMaxY > pageHeight / 2;
  // 重排时把最高 credit（标题）的基线放在上边距下方一个标题字高处。
  const titleCredit = credits.find((c) => c.y === creditMaxY);
  const titleFontSz = titleCredit && titleCredit.fontSize > 0
    ? titleCredit.fontSize / score.scaling
    : 20;

  const maxCreditSize = Math.max(0, ...credits.map((c) => c.fontSize));
  /** 本页画出的页眉各行：落笔点与墨迹顶（排完整块不得高过上边距） */
  const headLines: HeadLine[] = [];
  for (const cr of credits) {
    // 页眉字体（设置面板「页眉」一组 / 谱里 credit 自带的，`style/header.ts`）：给了的盖过 credit 自己的
    const justify = cr.justify === LCR.Right ? "right" : cr.justify === LCR.Center ? "center" : "left";
    const role = headerRoleOfCredit(cr.type ?? undefined, justify, maxCreditSize > 0 && cr.fontSize === maxCreditSize);
    const hf = role ? score.options.headerFonts[role] : undefined;
    // 源谱版面档：页眉的字号是照原图量的（识别结果），以它为准
    const fntSz = score.keepBreaks && cr.fontSize > 0 ? cr.fontSize / score.scaling : hf?.size ? hf.size / score.scaling : cr.fontSize > 0 ? cr.fontSize / score.scaling : 20;
    const base = new Font(cr.family ?? (cr.fontSize > 0 ? score.defaults.lyricFont.family : "PingFang SC"), fntSz, cr.bold ?? false);
    const font = headerRoleFont(hf, fntSz, base);
    const anchorX = cr.x > 0 ? cr.x : pageWidthTenths / 2;
    // MusicXML y from page bottom → SVG top-down；Sibelius bug 时改以页首为锚。
    const lineH = fntSz * 1.2;
    const lines = cr.text.split(/\r?\n/);
    // `valign`：`default-y` 是字顶 / 中线 / 底时换成首行基线（缺省就是基线）。陶我成器的标题是 top，当基线用就伸出上边距
    const first = font.charBound(lines[0] ?? "");
    const last = font.charBound(lines[lines.length - 1] ?? "");
    const vshift = cr.valign === "top" ? -first.top
      : cr.valign === "middle" ? -(first.top + last.bottom + (lines.length - 1) * lineH) / 2
      : cr.valign === "bottom" ? -last.bottom - (lines.length - 1) * lineH
      : 0;
    const baseY = (reanchorTop
      ? topMargin + titleFontSz + (creditMaxY - cr.y)
      : pageHeight - cr.y) + vshift;
    // 右对齐的多行 credit：Sibelius 把整块按最宽行右对齐，块内各行左缘对齐
    //（参考 PDF 里"词曲…/翻译…"两行 xMin 相同、右缘不同），而非逐行各自右对齐。
    const blockW = cr.justify === LCR.Right
      ? Math.max(...lines.map((l) => font.measureText(l)))
      : 0;
    lines.forEach((line, li) => {
      const tf = new TextFrame();
      tf.text = line;
      tf.font = font;
      tf.ident = { kind: "header" }; // 可视化编辑按所画的字认页眉
      let x = anchorX;
      const w = font.measureText(line);
      if (cr.justify === LCR.Center) x -= w / 2;
      else if (cr.justify === LCR.Right) x -= blockW;
      const m = new Matrix33();
      m.setAffine([1, 0, 0, 1, x, baseY + li * lineH]);
      tf.matrix = m;
      const cb = font.charBound(line);
      headLines.push({ tf, x, y: baseY + li * lineH, inkTop: cb.top, inkBottom: cb.bottom });
    });
  }
  // 页眉整块不得高过上边距：有一行伸出去就整块往下挪
  const over = topMargin - Math.min(Infinity, ...headLines.map((h) => h.y + h.inkTop));
  if (over > 0) {
    for (const h of headLines) {
      const m = new Matrix33();
      m.setAffine([1, 0, 0, 1, h.x, h.y + over]);
      h.tf.matrix = m;
      h.y += over;
    }
  }
  return headLines;
}

function drawFrames(
  score: StaffLayout,
  items: FrameItem[],
  lf: LayoutFrame[],
  leftMargin: number,
  topMargin: number,
  pageHeight: number,
  pageWidthTenths: number,
  footers: readonly ScoreCredit[] = [],
): Group[] {
  const pages: Group[] = [];
  let page: Group | null = null;

  for (let i = 0; i < items.length; i++) {
    const data = items[i];
    const it = lf[i];
    const sys = data.system;

    if (it.newPage || !page) {
      page = new Group();
      pages.push(page);
    }

    for (const h of headerLines(score, data.credits, topMargin, pageHeight, pageWidthTenths)) page.add(h.tf);

    // System group positioned at (leftMargin+sys.leftMargin, topMargin+ypos+topY+musicYOffset)
    const sysGrp = drawSystem(page, sys);
    const m = new Matrix33();
    m.setAffine([1, 0, 0, 1,
      leftMargin + sys.leftMargin,
      topMargin + it.ypos + data.topY + data.musicYOffset,
    ]);
    sysGrp.matrix = m;
  }
  // 页脚（「《八段锦》（民乐合奏）2」这类逐页的 `rights`）：照原坐标画在各自那一页，不占版面
  pages.forEach((pg, p) => {
    const own = footers.filter((c) => c.page === p);
    for (const h of headerLines(score, own, topMargin, pageHeight, pageWidthTenths, true)) pg.add(h.tf);
  });

  return pages;
}

/**
 * 每页内容（从上边距量）最多能排多深：页高减上下边距；这一页有页脚、页脚又伸进了下边距以上的，到页脚墨迹顶再留 `HEADER_GAP`。
 * 页脚照原坐标画、不占版面，以前装页不看它：Sibelius 的页脚常在下边距线以上，末行底下的力度就压在页脚上（八段锦扬琴第 1 页 m30 的 *mf*）。
 */
function contentLimit(score: StaffLayout, footers: readonly ScoreCredit[], pageHeight: number): (page: number) => number {
  const d = score.defaults;
  const full = pageHeight - d.topMargin - d.bottomMargin;
  const pageWidthTenths = d.pageWidth ?? 1200;
  const cache = new Map<number, number>();
  return (page) => {
    let v = cache.get(page);
    if (v === undefined) {
      const own = footers.filter((c) => c.page === page);
      const lines = own.length ? headerLines(score, own, d.topMargin, pageHeight, pageWidthTenths, true) : [];
      const top = Math.min(...lines.map((h) => h.y + h.inkTop));
      v = Number.isFinite(top) ? Math.min(full, top - d.topMargin - HEADER_GAP) : full;
      cache.set(page, v);
    }
    return v;
  };
}

/**
 * 页脚 credit：落在页面下四分之一的（MusicXML 的 y 从页底量）。整页 credit **全都**落在那里的不算——那是
 * Sibelius 把整个标题块压到页底的导出 bug（`headerLines` 的 `reanchorTop` 会把它们挪回页首）。
 * 以前页脚也当页眉：首行让开页眉墨迹时让到了页脚底下，第一页的谱全出了纸（《八段锦》19 份分谱都是）。
 */
function footerCredits(credits: readonly ScoreCredit[], pageHeight: number): Set<ScoreCredit> {
  const out = new Set<ScoreCredit>();
  const low = (c: ScoreCredit): boolean => c.y < pageHeight / 4;
  const pages = new Set(credits.map((c) => c.page));
  for (const p of pages) {
    const own = credits.filter((c) => c.page === p);
    if (own.every(low) && p === 0) continue;
    for (const c of own) if (low(c)) out.add(c);
  }
  return out;
}

/** 排好的五线谱页：各页页面树，连同各系统落在第几页（0 基）、首谱表顶线离页顶多远（tenths）。 */
export interface StaffPages {
  pages: Group[];
  placed: { sys: Sys; page: number; top: number }[];
}

/** 一份已读入的 `StaffLayout` 排成页（`showJianpuLayer` = 混排叠简谱层）。长图会改写 `score.defaults.pageHeight`。 */
export function layoutStaffPages(score: StaffLayout, showJianpuLayer: boolean, jianpuPart = 0): StaffPages {
  if (showJianpuLayer) formatMixedScore(score, jianpuPart);
  else placeAboveStaff(score, false);

  // M5: flow layout
  const items = getFrames(score);
  const footers = score.longImage ? new Set<ScoreCredit>() : footerCredits(score.credits, score.defaults.pageHeight ?? PAGE_HEIGHT_FALLBACK);
  if (items.length > 0) {
    // Add title block (credits) to first frame；页脚另画（`footerCredits`），不进页眉块、不让位
    items[0].credits = score.credits.filter(c => c.page === 0 && !footers.has(c));
    // 自动铺排的标题块由 autoLayoutHeader 从上往下堆，词曲行多了会高过缺省的 TITLE_OFFSET：按最低那行让开
    const d = score.defaults;
    const lowest = Math.min(...items[0].credits.map((c) => c.y));
    // 源谱版面档：首行照原位（`sourceFlow`），这里只管让开页眉墨迹（下面 `HEADER_GAP` 那一条），不留固定的标题高
    let offset = score.keepBreaks
      ? 0
      : score.autoLayout && items[0].credits.length
        ? Math.max(TITLE_OFFSET, d.pageHeight - lowest - d.topMargin + TITLE_GAP)
        : TITLE_OFFSET;
    // 带坐标的页眉也不得压到首行（和弦、高音）：页眉墨迹底下留一道空（005 的作曲行压在首行和弦上）
    const heads = headerLines(score, items[0].credits, d.topMargin, d.pageHeight ?? PAGE_HEIGHT_FALLBACK, d.pageWidth ?? 1200);
    if (heads.length) offset = Math.max(offset, Math.max(...heads.map((h) => h.y + h.inkBottom)) - d.topMargin + HEADER_GAP);
    items[0].musicYOffset = offset;
    items[0].height += offset;
  }
  const d = score.defaults;
  let pageHeight = d.pageHeight ?? PAGE_HEIGHT_FALLBACK;
  const phOf = contentLimit(score, [...footers], pageHeight);
  const layout = score.keepBreaks
    ? sourceFlow(score, items, phOf)
    : flowLayout(
      items,
      score.longImage ? Infinity : Math.min(...[...new Set([...footers].map((c) => c.page))].map(phOf), phOf(-1)),
      score.hardBreaks && !score.longImage ? new Set(score.pages.slice(1).map((pg) => pg.systems[0]!)) : undefined,
    );
  if (score.longImage) {
    // 长图：整首一页，页高 = 内容底 + 上下边距。credit 的 y 从页底量，页高变了整体跟着挪，离页顶的距离不变
    const last = layout[layout.length - 1];
    const contentH = last ? last.ypos + last.height : 0;
    const h = Math.max(contentH + d.topMargin + d.bottomMargin, d.topMargin + d.bottomMargin + TITLE_OFFSET);
    for (const c of score.credits) c.y += h - pageHeight;
    d.pageHeight = pageHeight = h;
  }
  let pageNo = -1;
  const placed = items.map((it, i) => {
    if (layout[i]!.newPage) pageNo++;
    return { sys: it.system, page: pageNo, top: d.topMargin + layout[i]!.ypos + it.topY + it.musicYOffset };
  });
  const pages = drawFrames(
    score, items, layout, d.leftMargin, d.topMargin, pageHeight, d.pageWidth ?? 1200, [...footers],
  );
  return { pages, placed };
}
