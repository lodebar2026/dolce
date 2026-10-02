// 贴着符头的演奏法记号（位图路）：保持音、断奏、顿音、重音、延长记号。
//
// 这几样都很小（一个点、一道短横），单看形状与谱线残段、加线、歌词里的连字符、附点分不开；
// 认得出靠的是**与符头的关系**：记号印在符头的正上方或正下方、离头一格上下、在符干的另一头。
// 所以不走 `findNotations` → `attachNotations`（那边只按 x 找最近的音符，形状字典里叫
// `articTenuto*` 的那一类九成是谱线残段，照挂会平白多出几百个保持音），在这里按关系一并判了、直接落到音符上。
//
// 候选只取两路：形状字典认成演奏法的符号，与账本上**无主**的 contour——已经有主的墨不抢。
import type { Rect } from "../omr/types";
import type { SPage, Staff, Sym } from "../staffomr/model";
import { beamY, type StaffNote } from "../staffomr/notedata";
import type { Contour, ContourMap } from "./contour";
import type { RasterUnit } from "./staffline";

/** 记号中心与符头中心横向差的上限（格）。 */
const ALIGN_X = 0.4;
/** 记号中心离符头中心的纵向距离（格）：贴着头的一格上下。重音、延长记号离得远些，另有一档。 */
const NEAR_Y: [number, number] = [0.6, 1.75];
const FAR_Y: [number, number] = [0.9, 3.2];
/** 保持音：短横的宽、高（格）。加线比它宽，谱线残段长短不一，靠位置另判。 */
const TENUTO_W: [number, number] = [0.6, 1.5];
const TENUTO_H = 0.45;
/** 断奏点的边长（格）与填充率下限。 */
const DOT_SIZE: [number, number] = [0.25, 0.6];
const DOT_FILL = 0.6;
/** 顿音（楔形）：窄而高、上宽下尖。 */
const WEDGE_W: [number, number] = [0.2, 0.6];
const WEDGE_H: [number, number] = [0.5, 1.0];
/** 重音 `>`：宽、高（格），开口处两臂的跨度下限与尖端的跨度上限（格），两段墨的列占比下限。 */
const ACCENT_W: [number, number] = [0.9, 1.75];
const ACCENT_H: [number, number] = [0.45, 1.1];
const ACCENT_OPEN = 0.4;
const ACCENT_TIP = 0.3;
const ACCENT_TWO_RUN = 0.4;
/** 延长记号的弧：宽、高（格）；弧心那一点离弧的横向中点（格）。 */
const FERMATA_W: [number, number] = [1.5, 3.4];
const FERMATA_H: [number, number] = [0.6, 1.7];
const FERMATA_DOT_X = 0.35;
/** 弧心那一点的边长上限（格）：比断奏点大一号。 */
const FERMATA_DOT = 0.8;
/** 延长记号离它那行谱的距离上限（格），与它挂的音的横向差上限（格）。 */
const FERMATA_GAP = 5;
const FERMATA_NOTE_X = 1.3;
/** 干这一侧：记号离干尖（或符杠外缘）的距离（格），重音另放宽；横向可以出到头、干之外这么多格。 */
const STEM_GAP: [number, number] = [0.15, 1.5];
const STEM_GAP_ACCENT = 2.4;
const STEM_SIDE_X = 0.45;
/** 断奏点、顿音离别的墨（音符自己的头、干、杠、谱线除外）至少这么多格。 */
const CROWD = 0.45;
const NOTE_INK = /^(head|stack|cluster|hollowmask|beam|seg:|bar|artic)/;
/** 歌词带里的圆点：四周这么多格（从别的墨的盒边量）内另有歌词墨的是字的点画。 */
const LYRIC_ALONE = 0.9;
/** 断奏点四周这么多格内另有无主小墨团的是噪点。 */
const SPECKLE = 1.0;
/** 谱表里的记号要落在**间**里：离最近一条谱线不到这么多格的是谱线残段。 */
const OFF_LINE = 0.27;

/** 认出来的一个记号：SMuFL 名（`toxml.ts::ARTIC_XML` 认的那一组）与它的墨盒。 */
export interface RasterArtic {
  code: string;
  box: Rect;
  note: StaffNote;
}

interface Cand {
  box: Rect;
  /** 无主 contour 才有（重音、延长记号要量轮廓）。 */
  contour?: Contour;
  /** 形状字典给的名字。 */
  dictCode?: string;
}

/**
 * 认贴着符头的演奏法记号，落到音符的 `marks` 上（和弦落到主音上）。
 *
 * @param dictSyms 形状字典认成 `artic*` 的符号（还没挂到任何音符上）。
 * @param unclaimed 账本上无主的 contour。
 * @param claimsOf 一团墨在账本上的认领者（`ContourLedger.claimsOf` 的 `by`）。
 * @param taken 已经另有身份的盒（附点、反复点、加线）：候选与它们相交的不认。
 */
export function findRasterArticulations(
  pg: SPage,
  map: ContourMap,
  unit: RasterUnit,
  notes: StaffNote[],
  dictSyms: Sym[],
  unclaimed: Contour[],
  taken: Rect[],
  claimsOf: (id: number) => string[],
): RasterArtic[] {
  const sp = unit.space;
  const heads = notes.filter((n) => !n.rest && !n.grace && !n.slash);
  const cands: Cand[] = [];
  for (const s of dictSyms) cands.push({ box: { x: s.box.left, y: s.box.top, w: s.box.right - s.box.left, h: s.box.bottom - s.box.top }, dictCode: s.code });
  for (const c of unclaimed) {
    if (c.w > FERMATA_W[1] || c.h > FERMATA_H[1]) continue;
    cands.push({ box: c.bbox, contour: c });
  }
  // 另收两路**有主**的小记号：歌词带罩住的（钢琴谱表上方的断奏点、人声行下方的保持音正落在歌词带里）、
  // 字典认成附点却没挂到任何头上的。歌词字自己的点画旁边一格内必有同一个字的别的笔画，孤零零的才收
  const lyricInk = map.contours.filter((c) => claimsOf(c.id).includes("lyric"));
  for (const c of map.contours) {
    const by = claimsOf(c.id);
    if (!by.length || !by.every((q) => q === "lyric" || q === "dict:augmentationDot")) continue;
    const small = isDot({ box: c.bbox, contour: c }, sp) ||
      (c.w >= TENUTO_W[0] && c.w <= TENUTO_W[1] && c.h <= TENUTO_H) ||
      (c.w >= WEDGE_W[0] && c.w <= WEDGE_W[1] && c.h >= WEDGE_H[0] && c.h <= WEDGE_H[1]);
    if (!small) continue;
    if (by.includes("lyric") && lyricInk.some((o) => o !== c && Math.abs(o.cx - c.cx) <= sp * LYRIC_ALONE + o.bbox.w / 2 && Math.abs(o.cy - c.cy) <= sp * LYRIC_ALONE + o.bbox.h / 2)) continue;
    cands.push({ box: c.bbox, contour: c });
  }
  const hits = (b: Rect, q: Rect) => b.x < q.x + q.w && b.x + b.w > q.x && b.y < q.y + q.h && b.y + b.h > q.y;
  const out: RasterArtic[] = [];
  const used = new Set<Cand>();
  const mainOf = (n: StaffNote) => n.group?.notes.find((m) => !m.chordExtra) ?? n;
  const push = (code: string, c: Cand, n: StaffNote) => {
    const tgt = mainOf(n);
    if ((tgt.marks ?? []).includes(code)) return;
    (tgt.marks ??= []).push(code);
    used.add(c);
    out.push({ code, box: c.box, note: tgt });
  };

  // ── 延长记号：一道拱弧 + 弧心一点 ───────────────────────────────────────
  //
  // 先认：弧在松叶、弧线之前就要摘走（不然它是一条够宽够拱的「圆滑线」），点也免得被当成断奏。
  // 「月牙 + 正中一点」这个组合够特别，不限无主：粗月牙常被符杠那一路、歌词带认领过（爱是从神而来末页三个全是）
  const loose = (c: Contour) => claimsOf(c.id).every((q) => q === "beam" || q === "lyric");
  const arcs: Cand[] = map.contours.filter(loose).map((c) => ({ box: c.bbox, contour: c }));
  const dots: Cand[] = map.contours.filter((c) => loose(c) && c.w >= DOT_SIZE[0] && c.w <= FERMATA_DOT && c.h >= DOT_SIZE[0] && c.h <= FERMATA_DOT && c.fill >= DOT_FILL).map((c) => ({ box: c.bbox, contour: c }));
  for (const arc of arcs) {
    const c = arc.contour;
    if (!c || c.w < FERMATA_W[0] || c.w > FERMATA_W[1] || c.h < FERMATA_H[0] || c.h > FERMATA_H[1]) continue;
    const shape = archShape(map, c);
    if (!shape) continue;
    const mx = arc.box.x + arc.box.w / 2;
    // 弧心的点：在弧的盒里、贴着开口那一边
    const dot = dots.find((d) => {
      if (d.contour === c) return false;
      const dx = d.box.x + d.box.w / 2;
      const dy = d.box.y + d.box.h / 2;
      if (Math.abs(dx - mx) > sp * FERMATA_DOT_X) return false;
      return shape.up ? dy > arc.box.y + arc.box.h * 0.45 && dy < arc.box.y + arc.box.h + sp * 0.3 : dy < arc.box.y + arc.box.h * 0.55 && dy > arc.box.y - sp * 0.3;
    });
    if (!dot) continue;
    // 挂到哪行谱：弧朝上的印在谱表上方、朝下的印在下方，取这一侧最近的那行
    const cy = arc.box.y + arc.box.h / 2;
    let stf: Staff | undefined;
    let bd = sp * FERMATA_GAP;
    for (const st of pg.staves) {
      const d = shape.up ? st.box.top - cy : cy - st.box.bottom;
      if (d > -sp * 1.5 && d < bd) {
        bd = d;
        stf = st;
      }
    }
    if (!stf) continue;
    let best: StaffNote | undefined;
    let bx = sp * FERMATA_NOTE_X;
    for (const n of notes) {
      if (n.staff !== stf || n.grace) continue;
      const d = Math.abs((n.sym.box.left + n.sym.box.right) / 2 - mx);
      if (d < bx) {
        bx = d;
        best = n;
      }
    }
    if (!best) continue;
    for (const q of cands) if (q.contour === dot.contour || q.contour === c) used.add(q);
    push(shape.up ? "fermataAbove" : "fermataBelow", arc, best);
  }

  // ── 贴着头的小记号 ──────────────────────────────────────────────────────
  for (const c of cands) {
    if (used.has(c)) continue;
    const b = c.box;
    const w = b.w / sp;
    const h = b.h / sp;
    let kind: "tenuto" | "staccato" | "staccatissimo" | "accent" | null = null;
    if (w >= TENUTO_W[0] && w <= TENUTO_W[1] && h <= TENUTO_H && (c.dictCode ? /^articTenuto/.test(c.dictCode) : (c.contour?.fill ?? 0) >= 0.7)) kind = "tenuto";
    else if (c.contour && isDot(c, sp)) kind = "staccato";
    else if (c.contour && w >= WEDGE_W[0] && w <= WEDGE_W[1] && h >= WEDGE_H[0] && h <= WEDGE_H[1] && c.contour.fill >= 0.45 && taper(map, c.contour)) kind = "staccatissimo";
    else if (c.contour && w >= ACCENT_W[0] && w <= ACCENT_W[1] && h >= ACCENT_H[0] && h <= ACCENT_H[1] && isAccent(map, c.contour, sp)) kind = "accent";
    if (!kind) continue;
    if (taken.some((q) => hits(b, q))) continue;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    // 扫描件的噪点成片：真记号四周是干净的，一格内另有无主的小墨团就不认（同附点那条 `speckles`）
    if (kind === "staccato" && unclaimed.some((o) => o !== c.contour && o.w <= DOT_SIZE[1] && o.h <= DOT_SIZE[1] && Math.abs(o.cx - cx) <= sp * SPECKLE && Math.abs(o.cy - cy) <= sp * SPECKLE)) continue;
    const [lo, hi] = kind === "accent" ? FAR_Y : NEAR_Y;
    let best: StaffNote | undefined;
    let bd = Infinity;
    let headSide = true;
    for (const n of heads) {
      const hb = n.sym.box;
      const hx = (hb.left + hb.right) / 2;
      const dy = cy - (hb.top + hb.bottom) / 2;
      const stem = n.group?.stem ?? null;
      const up = stem ? stem.up : n.stemUp;
      // ① 头这一侧（符干的另一头）：记号对着头心，离头一格上下。没有干（全音符）两边都行
      if (Math.abs(hx - cx) <= sp * ALIGN_X && !(up === true && dy < 0) && !(up === false && dy > 0)) {
        const d = Math.abs(dy);
        if (d >= sp * lo && d <= sp * hi && d < bd) {
          best = n;
          bd = d;
          headSide = true;
        }
      }
      // ② 干这一侧：记号在干尖（或符杠）外面。人声谱的记号一律印在谱表上方，干朝上的音就落在这一侧；
      // 断奏点对着干，保持音、重音对着头，横向按「头的外缘到干外半格」放
      if (stem) {
        const sx = stem.seg.cx;
        if (cx < Math.min(hb.left, sx) - sp * STEM_SIDE_X || cx > Math.max(hb.right, sx) + sp * STEM_SIDE_X) continue;
        const ends = [stem.up ? stem.seg.top : stem.seg.bottom, ...stem.beams.map((bm) => beamY(bm, sx) + (stem.up ? -1 : 1) * (bm.box.bottom - bm.box.top) * 0.25)];
        const tip = stem.up ? Math.min(...ends) : Math.max(...ends);
        const gap = stem.up ? tip - cy : cy - tip;
        if (gap < sp * STEM_GAP[0] || gap > sp * (kind === "accent" ? STEM_GAP_ACCENT : STEM_GAP[1])) continue;
        // 同一根干上只挂最外面那个头（和弦的记号归主音，由 `mainOf` 落）
        const d = gap + sp * 0.5;
        if (d < bd) {
          best = n;
          bd = d;
          headSide = false;
        }
      }
    }
    if (!best) continue;
    const hb = best.sym.box;
    const hy = (hb.top + hb.bottom) / 2;
    // 记号与头之间不能再夹着同一列的别的头（那它是那个头的，或者根本是加线）
    if (headSide && heads.some((m) => m !== best && m.group !== best!.group && Math.abs((m.sym.box.left + m.sym.box.right) / 2 - cx) <= sp * 0.8 && between((m.sym.box.top + m.sym.box.bottom) / 2, hy, cy))) continue;
    // 落在谱表的纵向范围里的要在**间**里（线上的是谱线残段）。谱表外正落在加线位置上的短横，
    // 同一列更外面（或就在这一级上）还有头，它就是那个头的加线
    const ys = best.staff.lineYsAt?.(cx) ?? best.staff.lineYs;
    if (ys.length === 5 && kind !== "accent") {
      const gap = (ys[4] - ys[0]) / 4;
      const inside = cy > ys[0] - gap * 0.3 && cy < ys[4] + gap * 0.3;
      const off = Math.abs(((cy - ys[0]) / gap) - Math.round((cy - ys[0]) / gap));
      if (inside && off < OFF_LINE) continue;
      if (!inside && kind === "tenuto" && off < OFF_LINE) {
        const below = cy > ys[4];
        const outer = heads.some((m) => {
          const my = (m.sym.box.top + m.sym.box.bottom) / 2;
          return m.staff === best!.staff && Math.abs((m.sym.box.left + m.sym.box.right) / 2 - cx) <= sp && (below ? my >= cy - gap * 0.3 : my <= cy + gap * 0.3);
        });
        if (outer) continue;
      }
    }
    // 点贴着别的墨（手写简谱数字底下的低音点、弧线的尖、力度字母的收笔）不是断奏；音符自己的头、干、杠不算
    if ((kind === "staccato" || kind === "staccatissimo") && map.contours.some((o) => {
      if (o === c.contour) return false;
      const dx = Math.max(o.bbox.x - (b.x + b.w), b.x - (o.bbox.x + o.bbox.w), 0);
      const dy = Math.max(o.bbox.y - (b.y + b.h), b.y - (o.bbox.y + o.bbox.h), 0);
      if (dx > sp * CROWD || dy > sp * CROWD) return false;
      return !claimsOf(o.id).some((q) => NOTE_INK.test(q));
    })) continue;
    const above = cy < hy;
    push(
      kind === "tenuto" ? (above ? "articTenutoAbove" : "articTenutoBelow")
        : kind === "staccato" ? (above ? "articStaccatoAbove" : "articStaccatoBelow")
        : kind === "staccatissimo" ? (above ? "articStaccatissimoAbove" : "articStaccatissimoBelow")
        : (above ? "articAccentAbove" : "articAccentBelow"),
      c,
      best,
    );
  }
  return out;
}

const between = (v: number, a: number, b: number) => (v - a) * (v - b) < 0;

/** 圆点：两边差不多长、够实。 */
function isDot(c: Cand, sp: number): boolean {
  const w = c.box.w / sp;
  const h = c.box.h / sp;
  if (!c.contour) return false;
  return w >= DOT_SIZE[0] && w <= DOT_SIZE[1] && h >= DOT_SIZE[0] && h <= DOT_SIZE[1] && Math.max(w, h) <= Math.min(w, h) * 1.6 && c.contour.fill >= DOT_FILL;
}

/** 逐行的墨宽（只数这一团自己的像素）。 */
function rowWidths(map: ContourMap, c: Contour): number[] {
  const b = c.bbox;
  const out: number[] = [];
  for (let y = b.y; y < b.y + b.h; y++) {
    let n = 0;
    for (let x = b.x; x < b.x + b.w; x++) if (map.labels[y * map.w + x] === c.id) n++;
    out.push(n);
  }
  return out;
}

/** 楔形：一头宽一头尖（宽的那一头至少是尖的那一头的两倍）。 */
function taper(map: ContourMap, c: Contour): boolean {
  const r = rowWidths(map, c);
  if (r.length < 4) return false;
  const k = Math.max(1, Math.round(r.length / 4));
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const top = avg(r.slice(0, k));
  const bot = avg(r.slice(-k));
  return Math.max(top, bot) >= Math.min(top, bot) * 2;
}

/** 逐列的墨：段数与上下缘（只数这一团自己的像素）。 */
function colProfile(map: ContourMap, c: Contour): { top: number; bot: number; runs: number }[] {
  const b = c.bbox;
  const out: { top: number; bot: number; runs: number }[] = [];
  for (let x = b.x; x < b.x + b.w; x++) {
    let top = -1;
    let bot = -1;
    let runs = 0;
    let prev = false;
    for (let y = b.y; y < b.y + b.h; y++) {
      const on = map.labels[y * map.w + x] === c.id;
      if (on) {
        if (top < 0) top = y;
        bot = y;
        if (!prev) runs++;
      }
      prev = on;
    }
    out.push({ top, bot, runs });
  }
  return out;
}

/** 重音 `>`：左边开口（两臂上下张开）、右边收成一个尖，过半的列是上下两段墨。 */
function isAccent(map: ContourMap, c: Contour, sp: number): boolean {
  const cols = colProfile(map, c).filter((q) => q.top >= 0);
  if (cols.length < 6) return false;
  const k = Math.max(1, Math.round(cols.length / 6));
  const span = (a: typeof cols) => a.reduce((s, q) => s + (q.bot - q.top + 1), 0) / a.length;
  const open = span(cols.slice(0, k));
  const tip = span(cols.slice(-k));
  if (open < sp * ACCENT_OPEN || tip > sp * ACCENT_TIP || open < tip * 2) return false;
  return cols.filter((q) => q.runs === 2).length >= cols.length * ACCENT_TWO_RUN;
}

/**
 * 延长记号的弧：逐列只有一段墨（两端粗一点也只算一段）、中间拱起、两端落到同一侧。
 * `up` = 拱朝上（开口向下，印在谱表上方的那种）。
 */
function archShape(map: ContourMap, c: Contour): { up: boolean } | null {
  const cols = colProfile(map, c).filter((q) => q.top >= 0);
  if (cols.length < 8) return null;
  if (cols.filter((q) => q.runs > 1).length > cols.length * 0.15) return null;
  const b = c.bbox;
  const k = Math.max(1, Math.round(cols.length / 8));
  // 延长记号是一弯**月牙**（中间厚、两头尖），量外缘：拱朝上的上缘中间比两端高出大半个盒高，朝下的看下缘
  const avg = (a: typeof cols, f: (q: (typeof cols)[number]) => number) => a.reduce((s, q) => s + f(q), 0) / a.length;
  const ends = [...cols.slice(0, k), ...cols.slice(-k)];
  const center = cols.slice(Math.floor(cols.length / 2) - k, Math.floor(cols.length / 2) + k);
  if (Math.abs(avg(cols.slice(0, k), (q) => q.top + q.bot) - avg(cols.slice(-k), (q) => q.top + q.bot)) / 2 > b.h * 0.35) return null;
  const riseTop = avg(ends, (q) => q.top) - avg(center, (q) => q.top);
  const riseBot = avg(center, (q) => q.bot) - avg(ends, (q) => q.bot);
  const rise = riseTop >= riseBot ? riseTop : -riseBot;
  if (Math.abs(rise) < b.h * 0.5) return null;
  return { up: rise > 0 };
}
