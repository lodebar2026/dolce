// 音符层：谱号 / 调号 / 拍号 / 临时记号 / 附点 / 符干符尾符杠 → 音高与时值。
// 对应 musicpp `qtomr/qomr.cpp::findClefKeyTime`、`analyzeAccidental` 与
// `qtomr/NoteData.cpp` 的 `analyzeStem/analyzeBeam/analyzeDot/analyzeClefSig/analyzeKeySig`。
//
// 坐标一律设备坐标、y 向下。
import {
  type Box,
  SPage,
  Seg,
  Staff,
  Sym,
  overlapY,
  sortByLeft,
  xSpace,
} from "./model";
import { accidentalAlter, flagLevel, isAccidental, isClef, isRest, isTimeSig, restDuration, timeSigDigit } from "./glyphs";
import { subPaths } from "./vecgeom";
import { HOLLOW_IN } from "./page";

// ── 全音阶序号 ──────────────────────────────────────────────────────────────
//
// musicpp 的 `ClefSig::middleStep()`：谱表**中线**（第三线）的全音阶序号。
//   序号 = (octave + 1) × 7 + stepIdx，stepIdx: C0 D1 E2 F3 G4 A5 B6。
//   高音谱号中线 B4 → 5×7+6 = 41；低音谱号中线 D3 → 4×7+1 = 29；
//   `gClef8vb`（唱低八度）中线记 B3 → 34。**这三个数照抄原文，别自己推。**

export const STEP_LETTERS = ["C", "D", "E", "F", "G", "A", "B"] as const;

/** 谱号 → 中线的全音阶序号。认不出来的谱号返回 null。 */
export function clefMiddleStep(code: string): number | null {
  switch (code) {
    case "fClef":
      return 29;
    case "fClef8vb":
      return 22;
    case "gClef":
      return 41;
    case "gClef8vb":
      return 34;
    case "gClef8va":
      return 48;
    case "cClef":
      return 35; // C 谱号（中音）中线 C4 → 5×7+0
    case "unpitchedPercussionClef1":
    case "unpitchedPercussionClef2":
      return 41;
    default:
      return null;
  }
}

/** 全音阶序号 → 音名与八度。 */
export function stepToPitch(idx: number): { step: string; octave: number } {
  const o = Math.floor(idx / 7) - 1;
  const s = ((idx % 7) + 7) % 7;
  return { step: STEP_LETTERS[s], octave: o };
}

// ── 谱号 / 拍号 / 调号 ──────────────────────────────────────────────────────

export interface StaffContext {
  staff: Staff;
  /** 本行谱起头的谱号符号。 */
  clef: Sym | null;
  /** 本行谱上全部谱号（按 x 排；行中换谱号时不止一个）。 */
  clefs?: Sym[];
  /** 调号里的升降号（按 x 排）。 */
  key: Sym[];
  /** 拍号数字（按 x 排，上下两排各一半）。 */
  time: Sym[];
  /** 这行谱上小节线的 x（还没切小节时由识别那边先给，见 `keyChanges`；切了小节就用 `staff.bars`）。 */
  barXs?: number[];
}

/**
 * `Page::findClefKeyTime` + `Page::analyzeAccidental`。
 *
 * 顺序有讲究（照原文）：先把「贴着某个符头左边、同高度」的升降号标成临时记号，
 * **剩下的**才可能是调号——调号的判据是「紧跟在谱号之后」「紧跟在另一个调号升降号之后」
 * 或「紧跟在小节线之后」（曲中转调）。
 */
export function findClefKeyTime(pg: SPage): Map<Staff, StaffContext> {
  const accids: Sym[] = [];
  const clefs: Sym[] = [];
  const times: Sym[] = [];
  const eights: Sym[] = [];
  for (const it of pg.symbols) {
    if (isAccidental(it.code)) accids.push(it);
    else if (isClef(it.code)) clefs.push(it);
    else if (timeSigDigit(it.code) >= 0 || it.code === "timeSigCommon" || it.code === "timeSigCutCommon") times.push(it);
    else if (it.code === "clef8") eights.push(it);
  }
  // 谱号底下（或头上）另起一枚小 8 的写法（八段锦中阮：Anastasia 的高音谱号与 `clef8` 是两个字形）：
  // 横向落在谱号范围里、贴着谱号下沿（上沿）的，并进谱号成 gClef8vb / gClef8va
  for (const e of eights) {
    const cx = (e.box.left + e.box.right) / 2;
    const g = clefs.find((c) => (c.code === "gClef" || c.code === "fClef") && cx >= c.box.left && cx <= c.box.right && (e.box.top >= (c.box.top + c.box.bottom) / 2 || e.box.bottom <= (c.box.top + c.box.bottom) / 2));
    if (!g) continue;
    const below = e.box.top >= (g.box.top + g.box.bottom) / 2;
    if (g.code === "gClef") g.code = below ? "gClef8vb" : "gClef8va";
    else if (below) g.code = "fClef8vb";
    e.addTag("Clef");
  }

  const validClefs: Sym[] = [];
  for (const c of clefs) {
    // musicpp 判的是「基线落在谱表五条线之内」（`abs(middleStep) < 4`）。
    // 本书不行：Anastasia 的谱号基线落在第一线上（正好 -4，被判掉），整页一个谱号都认不出。
    // 改判**墨迹与谱表的纵向重叠**——谱号总是骑在它那行谱上，重叠最多的那行就是它的。
    let stf: Staff | null = null;
    let best = 0;
    for (const st of pg.staves) {
      const ov = Math.min(c.box.bottom, st.box.bottom) - Math.max(c.box.top, st.box.top);
      if (ov > best) {
        best = ov;
        stf = st;
      }
    }
    if (!stf) continue;
    c.ownerStaff = stf;
    c.addTag("Clef");
    validClefs.push(c);
  }
  for (const c of times) {
    for (const st of pg.staves) {
      if (Math.abs(st.middleStep(c.py)) <= 4) {
        c.ownerStaff = st;
        c.addTag("Time");
        break;
      }
    }
  }

  analyzeAccidental(pg, accids, validClefs);

  const ctx = new Map<Staff, StaffContext>();
  for (const st of pg.staves) {
    const cl = sortByLeft(validClefs.filter((c) => overlapY(c.box, st.box)).slice());
    const key = sortByLeft(pg.symbols.filter((s) => s.hasTag("Key") && overlapY(s.box, st.box)).slice());
    const tm = sortByLeft(pg.symbols.filter((s) => s.hasTag("Time") && s.ownerStaff === st).slice());
    // 行中换谱号只认离谱行左缘五格以外的：行首那一段里多出来的「谱号」是误认（齐来谢主歌第七行调号旁一个假低音谱号）
    const sp = pg.normalStaffSpace || pg.space;
    const clefs = cl.length ? [cl[0], ...cl.slice(1).filter((c) => c.box.left > st.box.left + sp * 5)] : [];
    ctx.set(st, { staff: st, clef: cl[0] ?? null, clefs, key, time: tm });
  }
  return ctx;
}

/** `Page::analyzeAccidental`。 */
function analyzeAccidental(pg: SPage, accids: Sym[], clefs: Sym[]): void {
  const notes = pg.symbols.filter((s) => s.hasTag("Note"));
  const sp = pg.normalStaffSpace || pg.space;
  for (const acc of accids) {
    for (const nt of notes) {
      if (!nt.ownerStaff) continue;
      if (Math.abs(nt.py - acc.py) > sp / 4) continue;
      if (nt.px < acc.px) continue;
      if (nt.box.left - acc.box.right < sp / 2) {
        acc.addTag("Accidental");
        break;
      }
    }
  }

  const poss = accids.filter((a) => !a.hasAnyTag()).sort((a, b) => a.px - b.px);
  const barlines: Box[] = [
    ...pg.segsWithTag("BarLine").map((s) => s.box),
    ...pg.symbols.filter((s) => s.hasTag("BarLine")).map((s) => s.box),
  ];
  const keyAccids: Sym[] = [];
  for (const acc of poss) {
    // 紧跟谱号
    let after = false;
    for (const c of clefs) {
      // 打击乐谱号（‖）又窄又只占谱表中间两格（八段锦小钗）：调号离它三格多，头一个升号印在第五线上、与它纵向不搭。
      // 横向放到四格，纵向按它那行谱的高度比
      const perc = c.code.startsWith("unpitchedPercussionClef");
      if (c.box.right > acc.box.left) continue;
      if (acc.box.left - c.box.right > sp * (perc ? 4 : 3)) continue;
      const cb = perc && c.ownerStaff ? { ...c.box, top: c.ownerStaff.box.top - sp, bottom: c.ownerStaff.box.bottom + sp } : c.box;
      if (!overlapY(cb, acc.box)) continue;
      after = true;
      break;
    }
    // 紧跟另一个调号升降号
    if (!after) {
      for (const k of keyAccids) {
        if (!overlapY(k.box, acc.box)) continue;
        const dx = acc.box.left - k.box.right;
        if (dx < 0 || dx > acc.box.right - acc.box.left) continue;
        after = true;
        break;
      }
    }
    // 紧跟小节线（曲中转调）
    if (!after) {
      for (const b of barlines) {
        if (!overlapY(b, acc.box)) continue;
        if (acc.box.left < b.left) continue;
        if (acc.box.left - b.right > sp * 2) continue;
        after = true;
        break;
      }
    }
    if (after) {
      keyAccids.push(acc);
      acc.addTag("Key");
    }
  }
}

/** `KeySig::fifth`：调号升降号数（升为正、降为负）。本位号不计。 */
export function keyFifths(key: Sym[]): number {
  let res = 0;
  for (const s of key) {
    if (s.code === "accidentalSharp") res++;
    else if (s.code === "accidentalFlat") res--;
  }
  return res;
}

/** 调号记号之间隔多远（格）算另一处调号（行中转调）。同一处调号相邻两个记号的间距不到一格。 */
const KEY_CLUSTER_GAP = 1.5;

/**
 * **行中转调**：`ctx.key` 里除了行首调号，还收着行中小节线后面的调号（`findClefKeyTime`「紧跟在小节线之后」那一条）。
 * 按 x 聚成几簇：头一簇与谱号之间没有小节线的是本行调号（`x` 为 -Infinity），其余每簇从它的 x 起改调。
 * 不按「离谱号几格」判：有的行调号离谱号三格开外（烛光颂曲 p1、p2 行首），按距离判就成了行中转调、行首没调号。
 * 不分簇、整行一个 `keyFifths` 的话，望十架 p7「两个升号 → 行中一个降号」整行按一个升号读，升降全错。
 * 只有还原号的那簇是转到 C 大调（0）。
 */
export function keyChanges(c: StaffContext): { x: number; fifths: number }[] {
  if (!c.key.length) return [];
  const sp = c.staff.stepDistance() * 2;
  const ks = [...c.key].sort((a, b) => a.box.left - b.box.left);
  const clusters: Sym[][] = [];
  for (const k of ks) {
    const cur = clusters[clusters.length - 1];
    if (cur && k.box.left - cur[cur.length - 1].box.right <= sp * KEY_CLUSTER_GAP) cur.push(k);
    else clusters.push([k]);
  }
  const from = (c.clef?.box.right ?? c.staff.box.left) + sp * 0.5;
  const bars = c.staff.bars.length ? c.staff.bars.map((b) => b.left) : (c.barXs ?? []);
  const headOk = (x: number) => !bars.some((b) => b > from && b < x);
  return clusters.map((cl, i) => ({ x: i === 0 && headOk(cl[0].box.left) ? -Infinity : cl[0].box.left, fifths: keyFifths(cl) }));
}

/** 行首那段调号的记号（不含行中转调的，见 `keyChanges`）。 */
export function headKey(c: StaffContext): Sym[] {
  const ch = keyChanges(c);
  if (!ch.length || ch[0].x > -Infinity) return [];
  const cut = ch.length > 1 ? ch[1].x : Infinity;
  return c.key.filter((q) => q.box.left < cut);
}

/** 这一行谱在 x 处生效的调号；行首没印调号的取 `inherit`（上一行的）。 */
export function fifthsAt(c: StaffContext | undefined, x: number, inherit = 0): number {
  let f = inherit;
  for (const ch of c ? keyChanges(c) : []) if (ch.x <= x) f = ch.fifths;
  return f;
}

/**
 * 一行谱上**最左**那处拍号。上下两排数字各拼一个数（分子在上、分母在下）。
 *
 * 一行里可能不止一处（曲中变拍），逐小节判用 `timeSignatures`；
 * 把所有数字一股脑拼起来会得出 `2424/4444` 这种东西（实测全书出过 32 处）。
 */
export function timeSignature(time: Sym[], sp?: number): { beats: number; beatType: number } | null {
  const all = timeSignatures(time, sp);
  return all.length ? { beats: all[0].beats, beatType: all[0].beatType } : null;
}

/** 一处拍号。`symbol`：印的是 C / ¢ 记号而不是数字（MusicXML `<time symbol>`）。 */
export interface TimeSig { x: number; beats: number; beatType: number; symbol?: "common" | "cut" }

/** 一处拍号的 MusicXML `<time>`。 */
export const timeXml = (t: TimeSig): string =>
  `<time${t.symbol ? ` symbol="${t.symbol}"` : ""}><beats>${t.beats}</beats><beat-type>${t.beatType}</beat-type></time>`;

/** 一行谱上的**全部**拍号，按 x 从左到右。曲中变拍时会有好几处。 */
export function timeSignatures(time: Sym[], sp?: number): TimeSig[] {
  if (!time.length) return [];
  const out: TimeSig[] = [];
  const marks = time.filter((s) => s.code === "timeSigCommon" || s.code === "timeSigCutCommon");
  for (const m of marks) {
    out.push(m.code === "timeSigCommon" ? { x: m.px, beats: 4, beatType: 4, symbol: "common" } : { x: m.px, beats: 2, beatType: 2, symbol: "cut" });
  }
  const digits = time.filter((s) => timeSigDigit(s.code) >= 0).sort((a, b) => a.px - b.px);
  if (digits.length) {
    const gap = (sp ?? (digits[0].box.right - digits[0].box.left) * 2) * 3;
    // 按 x 分簇：同一处拍号的上下两个数字 x 几乎相同，簇间隔取三个数字宽
    const clusters: Sym[][] = [[digits[0]]];
    for (let i = 1; i < digits.length; i++) {
      const cur = clusters[clusters.length - 1];
      if (digits[i].px - cur[cur.length - 1].px > gap) clusters.push([digits[i]]);
      else cur.push(digits[i]);
    }
    for (const cluster of clusters) {
      const midY = (Math.min(...cluster.map((d) => d.py)) + Math.max(...cluster.map((d) => d.py))) / 2;
      const top = cluster.filter((d) => d.py <= midY).sort((a, b) => a.px - b.px);
      const bot = cluster.filter((d) => d.py > midY).sort((a, b) => a.px - b.px);
      const num = (a: Sym[]) => Number(a.map((s) => timeSigDigit(s.code)).join("")) || 0;
      const beats = num(top);
      const beatType = num(bot);
      if (beats && beatType) out.push({ x: cluster[0].px, beats, beatType });
    }
  }
  return out.sort((a, b) => a.x - b.x);
}

// ── 符杠 ────────────────────────────────────────────────────────────────────

/** 一条符杠：粗的、（多半）倾斜的实心四边形。 */
export interface BeamShape {
  box: Box;
  /** 左右端点的中心 y，用来判「某个 x 处符杠在哪个高度」。 */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 第几层（1 = 离符头最远、在干尖上的那条主杠 = 八分；往符头方向叠的副杠依次 2、3）。由 `calcBeamLevels` 填。 */
  level: number;
}

/** `Beam::calcY`：符杠在某个 x 处的中心 y。 */
export const beamY = (b: BeamShape, x: number): number =>
  b.x1 === b.x0 ? b.y0 : b.y0 + ((b.y1 - b.y0) * (x - b.x0)) / (b.x1 - b.x0);

/** 一根符干及其挂件。musicpp 的 `omr::Stem`。 */
export interface StemInfo {
  seg: Seg;
  /** 符干朝上（从符头往上伸）。 */
  up: boolean;
  notes: Sym[];
  beams: BeamShape[];
  /** 符尾字形给出的层数（八分 1、十六分 2……）；没有符尾为 0。 */
  flags: number;
}

/**
 * 找符杠。两种画法都要认：
 *   1. **实心四边形**（Finale/Sibelius 原生）：四到五个点、无曲线、够粗。
 *   2. **密排细线**（本书那批经 Distiller 的 PDF）：一条 `lw` 明显大于谱线的横段
 *      ——那是几十道 0.06pt 细线堆出来的填充，`mergeRedrawn` 已经并成一条粗段。
 */
export function findBeams(pg: SPage): BeamShape[] {
  // 谱线找到之后 `normalStaffSpace`（实测的一个线距）是更准的那个；没找到就退回 H/4。
  const sp = pg.normalStaffSpace || pg.space;
  const out: BeamShape[] = [];
  for (const o of pg.objs) {
    const p = o.path;
    if (!p || !p.paint.toLowerCase().includes("fill")) continue;
    if (p.curves) continue;
    for (const spath of subPaths(p)) {
      const pts = spath.pts;
      if (pts.length < 4 || pts.length > 5) continue;
      const xs = pts.map((q) => q.x);
      const ys = pts.map((q) => q.y);
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
      if (w < sp * 0.8) continue; // 太短的不是符杠
      if (h > sp * 2) continue; // 太高的不是符杠（是方框/装饰）
      // 粗细：取左右两端的纵向厚度
      const left = pts.filter((q) => q.x < Math.min(...xs) + w * 0.25).map((q) => q.y);
      const thick = left.length >= 2 ? Math.max(...left) - Math.min(...left) : h;
      if (thick < sp * 0.25) continue;
      out.push(beamFromPts(pts));
    }
  }
  // **斜符杠是一叠平行细线**（这一批 PDF 连填充也拿密排细线画，见 `model.ts` 的 `Seg` 注释）。
  // 平的那种叠出来还能并成一条横段（下面那条路收得到）；斜的每条 y 都不同，
  // `Seg` 的 `isH`/`isV` 两头不沾，整条符杠没人认——实测 p185~p204 那一带
  // 「八分音符读成四分」，一首歌能错六成的时值。
  out.push(...slantedBeams(pg, sp));

  // 密排细线画出来的符杠
  for (const s of pg.segs) {
    if (!s.isH || s.hasAnyTag()) continue;
    if (s.lw < sp * 0.3 || s.lw > sp * 1.2) continue;
    if (s.len < sp * 0.8 || s.len > sp * 20) continue;
    out.push({ box: s.box, x0: s.left, y0: s.cy, x1: s.right, y1: s.cy, level: 0 });
  }
  return dedupeBeams(out, sp / 2);
}

/** 同一条符杠会被两条路各认一遍（实心四边形那条 + 细矩形转成的横段那条），
 *  不去重的话时值每多算一条就减半——实测 p100 因此出了一堆 1/64。
 *  合并粒度按页面单位取比例（四分之一格），不写绝对点值。 */
function dedupeBeams(list: BeamShape[], unit: number): BeamShape[] {
  const seen = new Set<string>();
  const out: BeamShape[] = [];
  const q = Math.max(unit / 4, 1e-3);
  for (const b of list) {
    const k = [b.x0, b.x1, b.y0, b.y1].map((v) => Math.round(v / q)).join(",");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

/**
 * 一叠平行斜细线 → 一条符杠。
 *
 * 判据是「同起讫 x、同斜率、y 一层层错开」——这正是填充算法吐出来的样子。
 * 只收**斜的**：平的那种由横段那条路收，两头都收会把同一条符杠算两遍，
 * 层数跟着翻倍（时值减半）。
 */
function slantedBeams(pg: SPage, sp: number): BeamShape[] {
  const out: BeamShape[] = [];
  for (const o of pg.objs) {
    const p = o.path;
    if (!p || p.curves) continue;
    const groups = new Map<string, { a: { x: number; y: number }; b: { x: number; y: number } }[]>();
    for (const spath of subPaths(p)) {
      if (spath.pts.length !== 2) continue;
      let [a, b] = spath.pts;
      if (a.x > b.x) [a, b] = [b, a];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      // 太短的不是符杠；水平的走横段那条路；比 45° 还陡的不是符杠
      if (dx < sp * 0.8) continue;
      if (Math.abs(dy) < 0.02) continue;
      if (Math.abs(dy) >= dx) continue;
      const q = Math.max(sp / 8, 1e-3);
      const k = [a.x, b.x, dy / dx].map((v) => Math.round(v / q)).join(",");
      const g = groups.get(k) ?? [];
      g.push({ a, b });
      groups.set(k, g);
    }
    for (const g of groups.values()) {
      g.sort((m, n) => m.a.y - n.a.y);
      let run: typeof g = [];
      const flush = () => {
        // 一条细线不成束（那是渐强线之类）；厚度要落在符杠的范围里
        if (run.length >= 3) {
          const th = run[run.length - 1].a.y - run[0].a.y;
          if (th >= sp * 0.2 && th <= sp * 1.2) {
            const x0 = run[0].a.x;
            const x1 = run[0].b.x;
            const y0 = (run[0].a.y + run[run.length - 1].a.y) / 2;
            const y1 = (run[0].b.y + run[run.length - 1].b.y) / 2;
            out.push({
              box: {
                left: x0,
                right: x1,
                top: Math.min(run[0].a.y, run[0].b.y),
                bottom: Math.max(run[run.length - 1].a.y, run[run.length - 1].b.y),
              },
              x0, y0, x1, y1, level: 0,
            });
          }
        }
        run = [];
      };
      for (const l of g) {
        // 一层层错开的才是同一条符杠；隔开半格的是另一条（第二、第三条符杠）
        if (run.length && l.a.y - run[run.length - 1].a.y > sp * 0.3) flush();
        run.push(l);
      }
      flush();
    }
  }
  return out;
}

function beamFromPts(pts: { x: number; y: number }[]): BeamShape {
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const at = (x: number) => {
    const near = pts.filter((q) => Math.abs(q.x - x) < (maxX - minX) * 0.25).map((q) => q.y);
    return near.length ? (Math.min(...near) + Math.max(...near)) / 2 : (Math.min(...ys) + Math.max(...ys)) / 2;
  };
  return {
    box: { left: minX, right: maxX, top: Math.min(...ys), bottom: Math.max(...ys) },
    x0: minX,
    y0: at(minX),
    x1: maxX,
    y1: at(maxX),
    level: 0,
  };
}

/** 识别的可调开关（脚本里对比两种做法用；默认全开）。 */
export const staffOmrOptions = {
  /** 时值取符杠**层级**（`BeamGroup::calcLevel`）；关掉则退回「数穿过符干的符杠条数」。
   *  两种做法的差别见 `buildNotes` 里那段注释。 */
  beamLevels: true,
  /** 应用八度移位（`8va`/`8vb`）。脚本里对比用。 */
  octaveShift: true,
};

// ── 符干与符杠分层 ──────────────────────────────────────────────────────────

/**
 * `System::analyzeStem`：把符头挂到符干上，再把符尾挂到符干上。
 *
 * 判据照原文：符头的**左缘或右缘**与符干 x 差在四分之一格以内，且纵向相交。
 * （符干贴在符头的一侧，不是穿过中心。）
 */
/** 头团里的竖笔离头盒左右缘都至少这么多像素才算藏在盒里（见 `buildStems`）。 */
const INNER_STROKE = 2;
/** 伸出头外的干长下限（格），见 `buildStems` 里「一上一下两根干」那段。 */
const SHORT_STEM_OUT = 2;

export function buildStems(pg: SPage, sp: number, vector = false): StemInfo[] {
  const heads = pg.symbols.filter((s) => s.hasTag("Note") && !isRest(s.code) && s.ownerStaff);
  const flagSyms = pg.symbols.filter((s) => s.hasTag("Tail"));
  const out: StemInfo[] = [];
  // 窗口与 `findStems` 打 Stem 标签同口径（两倍谱线粗）兜底：粗线扫描件上头盒右缘离自己的干 4.5~5 像素，
  // 1/4 格只有 4.7，干标上了 Stem、头却没挂上，落单的头被并进邻头的和弦（破碎扫描版 p6 十六分 A4）
  const win0 = (nt: Sym) => Math.max(sp / 4, (nt.ownerStaff?.lines[0]?.lw ?? 0) * 2);
  for (const seg of pg.segsWithTag("Stem")) {
    const notes: Sym[] = [];
    for (const nt of heads) {
      // 形状已确认是全音符的头不挂干（`Sym.shapeWhole`）：贴着别的声部带干的头时，会被当成同一根干上的和弦音、读成二分
      //（爱是从神而来 p5 m63 钢琴右手 F4 二分朝上的干，下面贴着 B♭3/D4 全音符）
      if (nt.shapeWhole) continue;
      // 纵向差一像素也算相交，与 `findStems` 同口径
      if (seg.bottom < nt.box.top - 1 || nt.box.bottom < seg.top - 1) continue;
      let dx0 = Math.abs(nt.box.left - seg.cx);
      let dx1 = Math.abs(nt.box.right - seg.cx);
      const win = win0(nt);
      // 空心头盒里离缘不远的干也算贴缘，与 `findStems` 同口径
      if (nt.code === "noteheadHalf" && seg.cx > nt.box.left && seg.cx < nt.box.right) {
        if (seg.cx - nt.box.left <= sp * HOLLOW_IN) dx0 = Math.min(dx0, win / 2);
        if (nt.box.right - seg.cx <= sp * HOLLOW_IN) dx1 = Math.min(dx1, win / 2);
      }
      if (dx0 > win && dx1 > win) continue;
      notes.push(nt);
    }
    if (!notes.length) continue;
    // 整根藏在所挂头团里的竖笔不是干：纵向被头盒盖满、横向落在每个头盒里面（不贴缘）。
    // 扫描件上三个实心头叠成一团，团里一道竖笔被抽成竖段（望十架 p8 m64 钢琴右手 B3/D4/F♯4，下面两个头被拆成另一声部的四分）。
    // 二度和弦夹在两个头之间的短干贴着两个盒的缘，不受这条影响。
    // 只看实心头：空心头的盒按内腔外扩，自己的干本就常落在盒里（见 `HOLLOW_IN`）
    const inside = (nt: Sym) => nt.code === "noteheadBlack" && seg.cx - nt.box.left >= INNER_STROKE && nt.box.right - seg.cx >= INNER_STROKE;
    // 头盒要把竖笔一路盖满：八度和弦两个头之间那截真干两端也不出头（破碎扫描 p4 m56 C4/C5）
    const covered = (y: number) => notes.some((n) => y >= n.box.top - 1 && y <= n.box.bottom + 1);
    let hidden = notes.every(inside);
    for (let y = Math.round(seg.top); hidden && y <= seg.bottom; y++) hidden = covered(y);
    if (hidden) continue;
    // `Stem::up`：符干伸到符头**上方**就是朝上。高出头顶不到 `STEM_UP_SLACK` 格的不算：干端齐着头顶、
    // 扫描件上高出一两个像素的朝下干会被当成朝上（是爱 p2 m30 女低 F4 二分，干上端比头顶高 1px、往下伸 2.5 格，
    // 分声部时上方 C5 全音符的「上下两声部」豁免因此不成立，三个音排成了一串）。
    // 改成「往哪头伸得多」更差：穿过两声部交叉处的干（望十架 p3 m26）方向跟着翻
    // 两头都没伸出头去的短干（破碎扫描 p9 m93，夹在二度两个头之间）照旧：上端高过头顶就算朝上
    const above = Math.min(...notes.map((n) => n.box.top)) - seg.top;
    const below = seg.bottom - Math.max(...notes.map((n) => n.box.bottom));
    const up = above > sp * STEM_UP_SLACK || (above > 0 && below <= sp * STEM_UP_SLACK);
    let flags = 0;
    for (const f of flagSyms) {
      if (Math.abs(f.box.left - seg.cx) > sp / 4) continue;
      if (!overlapY(f.box, seg.box)) continue;
      flags = Math.max(flags, flagLevel(f.code));
    }
    out.push({ seg, up, notes, beams: [], flags });
  }
  // **一个头挂上了两根干，只留贴在正经那一侧的**：朝上的干贴头的右缘、朝下的贴左缘；贴在反侧的是二度和弦错开的头。
  // 相邻两个十六分挨得近时（破碎扫描版 p7 E4、F4 隔一个头宽），后一个头的左缘也落在前一根朝上的干旁边，
  // 被前一根干当成错开的二度收走、并成一枚和弦，它自己那根干反倒空了。它另有一根干贴在正经那一侧的，从反侧那根上摘掉
  const proper = (st: StemInfo, nt: Sym) => Math.abs((st.up ? nt.box.right : nt.box.left) - st.seg.cx) <= win0(nt);
  for (const st of out)
    st.notes = st.notes.filter((nt) => proper(st, nt) || !out.some((o) => o !== st && o.notes.includes(nt) && proper(o, nt)));
  // 一个头挂在一上一下两根干上，其中一根伸出头外不到 `SHORT_STEM_OUT` 格：那是贴着头的别的竖笔（数字的弯笔还会被认成符尾，带尾的真干本来就长，不另放行）
  //（破碎扫描版 p6 男低头顶上印的简谱数字「3」，右边那一竖 1.5 格长，头被出成一上一下两个音）。从短的那根上摘掉
  const reachOut = (st: StemInfo, nt: Sym) => (st.up ? nt.box.top - st.seg.top : st.seg.bottom - nt.box.bottom);
  for (const st of out)
    st.notes = st.notes.filter((nt) => reachOut(st, nt) >= sp * SHORT_STEM_OUT || !out.some((o) => o !== st && o.up !== st.up && o.notes.includes(nt) && reachOut(o, nt) >= sp * SHORT_STEM_OUT));
  // 两声部三度叠放、上头空心下头实心（望十架 p3 m26 女高 A4 二分、女低 F4 四分）：朝下那根干从上头的左缘起笔，两个头都收进去，
  // 上头又在朝上那根干的右缘，两边都「正经」。同一根干上头型不同（空心 / 实心）不会是一个和弦：
  // 头在另一根干上独自挂着的，从这根上摘掉
  const filled = (nt: Sym) => nt.code === "noteheadBlack";
  for (const st of out) {
    if (st.notes.length < 2) continue;
    st.notes = st.notes.filter(
      (nt) => !(st.notes.some((m) => m !== nt && filled(m) !== filled(nt)) && out.some((o) => o !== st && o.up !== st.up && o.notes.length === 1 && o.notes[0] === nt && proper(o, nt))),
    );
  }
  // 一上一下两根干挂着同样两个头：两声部三度叠放、头挨着头，两根干都贴着两个头的缘、又都从一个头伸到另一个头
  // （望十架 p4 m33 男声 B♭3 附点二分朝上、G3 二分朝下，两个头各读出两遍）。照两声部的惯例，朝上的留上头、朝下的留下头
  for (const st of out) {
    if (!st.up || st.notes.length !== 2) continue;
    const o = out.find((q) => !q.up && q.notes.length === 2 && q.notes.every((n) => st.notes.includes(n)));
    if (!o) continue;
    const [hi, lo] = [...st.notes].sort((a, b) => a.py - b.py);
    // 两个头叠在一处（两声部同音、刻谱软件各画了一个头：八段锦笛子 m62 E5）：一根干分一个
    if (lo.py - hi.py < sp * 0.25) {
      if (vector && Math.abs(lo.box.left - hi.box.left) < sp * 0.25) (st.notes = [hi]), (o.notes = [lo]);
      continue;
    }
    st.notes = [hi];
    o.notes = [lo];
  }
  return out.filter((st) => st.notes.length);
}

/** `<beam>` 的取值。 */
export type BeamState = "begin" | "continue" | "end" | "forward hook" | "backward hook";

/** 只接上一根干、短于这么多格的杠是半截钩（附点八分 + 十六分的那一截）；长的是另一头的音没认出来，照普通杠算。 */
const HOOK_MAX = 1.6;
/** 两条杠横向叠着不到这么多格的不算一摞（见 `calcBeamLevels`）。 */
const BEAM_STACK_OV = 0.3;

/**
 * 一根干上逐层的符杠状态：这一层的杠伸出干的左侧 / 右侧（超过 `beamConnect` 的端点容差五分之一格）
 * 两侧都伸 → continue、只伸右 → begin、只伸左 → end；只接上这一根干的短杠是钩，伸向哪边就是哪边的钩。
 * 层号照 `calcBeamLevels` 定的，同层被拆成两段的一并看；没定层的（0）各算一层排在后面，与时值的层数口径一致。
 */
function beamStates(stem: StemInfo, stems: StemInfo[], sp: number): BeamState[] {
  const byLevel = new Map<number, BeamShape[]>();
  let extra = 1000;
  for (const b of stem.beams) {
    const k = b.level > 0 ? b.level : extra++;
    byLevel.set(k, [...(byLevel.get(k) ?? []), b]);
  }
  const x = stem.seg.cx;
  const tol = sp / 5;
  return [...byLevel.keys()]
    .sort((a, b) => a - b)
    .map((k) => {
      const bs = byLevel.get(k)!;
      const left = bs.some((b) => b.x0 < x - tol);
      const right = bs.some((b) => b.x1 > x + tol);
      const shared = bs.some((b) => stems.some((o) => o !== stem && o.beams.includes(b)));
      if (!shared && Math.max(...bs.map((b) => b.x1 - b.x0)) < sp * HOOK_MAX) {
        if (left !== right) return left ? "backward hook" : "forward hook";
        return bs.reduce((a, b) => a + (b.x0 + b.x1) / 2, 0) / bs.length < x ? "backward hook" : "forward hook";
      }
      return left && right ? "continue" : right ? "begin" : left ? "end" : "continue";
    });
}

/** `Beam::connect` 的结果。 */
type BeamHit = "none" | "begin" | "end" | "middle";

/** `Beam::connect`：这条符杠接不接得上这根符干。 */
function beamConnect(b: BeamShape, st: StemInfo, sp: number): BeamHit {
  const x = st.seg.cx;
  if (x < b.x0 - sp * 0.2) return "none";
  if (x > b.x1 + sp * 0.2) return "none";
  const y = beamY(b, x);
  // 符干的**某一端**要落在符杠附近（符杠总在符干的远端）。
  //
  // 光有这一条不够：**第二、三条符杠是往符头方向叠上去的**（每条约四分之三格），
  // 离符干末端一格开外，整条接不上符干 → 层数只剩一层 → 十六分读成八分
  // （实测这是全书时值的头号错误，一条判据吃掉 158 处）。
  // 所以再补一个窗口：从符干**离符头远的那一端**朝符头量，两格以内都算接上
  // （三条符杠正好一格半）。反方向不放宽——那一侧不该有符杠。
  const noteY = st.notes.reduce((a, n) => a + (n.box.top + n.box.bottom) / 2, 0) / st.notes.length;
  const far = Math.abs(st.seg.top - noteY) > Math.abs(st.seg.bottom - noteY) ? st.seg.top : st.seg.bottom;
  const toward = Math.sign(noteY - far) || 1;
  // **杠不会在头的外侧**：干从杠伸向头，越过最外那个头心还往外的「杠」挂在头那一端（我全心颂赞 p172 八分 D4
  // 头下贴着一截横墨，被算成第二层读成十六分）。
  const cys = st.notes.map((n) => (n.box.top + n.box.bottom) / 2);
  const headEnd = toward > 0 ? Math.max(...cys) : Math.min(...cys);
  if ((y - headEnd) * toward > 0) return "none";
  // **杠也不会夹在和弦的头之间**：杠总在离干远端最近那个头的远端一侧；落在它朝头那侧半格开外的，是压着加线的头连着加线
  // 横出去的一截（是爱 p2 m20 钢琴右手 D5/F5/A5，A5 骑的加线读成钩，四分读成八分）
  const farHead = toward > 0 ? Math.min(...cys) : Math.max(...cys);
  if ((y - farHead) * toward > sp / 2) return "none";
  const near = Math.abs(st.seg.top - y) < sp || Math.abs(st.seg.bottom - y) < sp;
  if (!near) {
    const d = (y - far) * toward;
    if (d < 0 || d > sp * 2) return "none";
  }
  if (Math.abs(x - b.x0) < sp / 5) return "begin";
  if (Math.abs(x - b.x1) < sp / 5) return "end";
  return "middle";
}

/**
 * `System::analyzeBeam` + `BeamGroup::calcLevel`：把符杠归组并定层。
 *
 * 为什么不能「数穿过符干的符杠条数」了事：十六分音符的第二条符杠常常只是**半截钩**
 * （fractional beam），它盖住的符干比第一条少；反过来，同一组里不同符干盖到的条数不同，
 * 而**时值要看这根符干上最高的那一层**。musicpp 的办法是先按「共享符干且 x 区间重叠」
 * 归组，组内按「在组左端 x 处的 y」排序，逐条隔开四分之一格就升一层。
 */
export function calcBeamLevels(beams: BeamShape[], stems: StemInfo[], sp: number, heads: { left: number; right: number; top: number; bottom: number }[] = []): void {
  const conn = new Map<BeamShape, { st: StemInfo; hit: BeamHit }[]>();
  const kept: BeamShape[] = [];
  for (const b of beams) {
    const hits: { st: StemInfo; hit: BeamHit }[] = [];
    for (const st of stems) {
      if (st.flags) continue; // 有符尾的符干不接符杠（照原文）
      const h = beamConnect(b, st, sp);
      if (h === "none") continue;
      hits.push({ st, hit: h });
      st.beams.push(b);
    }
    // 一根符干都接不上的多半不是符杠（是渐强线、下划线之类）。
    // musicpp 要求**两端**至少有一端正好落在符干上；本仓放宽成「接得上任何一根」——
    // 这一批 PDF 的符杠是密排细线堆出来的填充（见 findBeams），合并后的横段两端
    // 比真符杠宽出一截，`begin`/`end` 的五分之一格容差卡不住，整条符杠会被丢掉，
    // 于是那些页「八分音符读成四分」。
    if (!hits.length) continue;
    conn.set(b, hits);
    kept.push(b);
  }

  // 归组：x 区间重叠 + 共享符干（长的先当组头，照原文按跨度降序）
  kept.sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0));
  const done = new Set<BeamShape>();
  for (const bi of kept) {
    if (done.has(bi)) continue;
    const grp = [bi];
    done.add(bi);
    for (const bj of kept) {
      if (done.has(bj)) continue;
      if (bi.x0 > bj.x1 || bj.x0 > bi.x1) continue;
      // 只在端头碰着（共用端头那根干）的是一条杠断成先后两截，不是一摞：手写杠在中途提笔（是爱 p1 m10 右手，
      // 两截在干上错开 0.5 格，按层算就把那个音读成十六分）。真副杠与主杠横向叠着至少一个音距
      if (Math.min(bi.x1, bj.x1) - Math.max(bi.x0, bj.x0) < sp * BEAM_STACK_OV) continue;
      const si = new Set(conn.get(bi)!.map((h) => h.st));
      if (!conn.get(bj)!.some((h) => si.has(h.st))) continue;
      grp.push(bj);
      done.add(bj);
    }
    // **连杠两端都要有音**（用户：beam 要求两端都有音符）：只接上一根干的一组，离那根干远的一端 0.8 格内没有别的符头，
    // 就不是符杠——干尖碰着的歌词字横笔（欢然颂主 m3「圣」、齐来崇拜 m6）、贴着头的连音线（晨曦破晓 m6）。
    // 另一端有头、只是干没接上的真符杠照留（奇异恩典 m10、数算主恩 m9）
    const hitsOf = grp.flatMap((g) => conn.get(g)!);
    const only = new Set(hitsOf.map((h) => h.st));
    // 干落在杠端（begin / end）的也照留：另一端的音可能整个没认出来（主我敬拜你 m6 左邻是字典认的整块音符）
    if (only.size < 2 && hitsOf.every((h) => h.hit === "middle")) {
      const st = hitsOf[0].st;
      const gx0 = Math.min(...grp.map((g) => g.x0));
      const gx1 = Math.max(...grp.map((g) => g.x1));
      const gy0 = Math.min(...grp.map((g) => g.box.top));
      const gy1 = Math.max(...grp.map((g) => g.box.bottom));
      const far = Math.abs(gx0 - st.seg.cx) > Math.abs(gx1 - st.seg.cx) ? gx0 : gx1;
      const mine = new Set(st.notes.map((n) => n.box));
      // 另一端的头与这根干上的头在杠的同一侧（干朝同一个方向），别把下一行谱表的头算进来
      const above = st.notes.reduce((a, n) => a + (n.box.top + n.box.bottom) / 2, 0) / st.notes.length < (gy0 + gy1) / 2;
      const headAtFar = heads.some((h) => {
        if (mine.has(h as never) || h.right < far - sp * 0.8 || h.left > far + sp * 0.8) return false;
        const cy = (h.top + h.bottom) / 2;
        return above ? cy < gy0 && cy > gy0 - sp * 4.5 : cy > gy1 && cy < gy1 + sp * 4.5;
      });
      // 干离杠的近端不到半格的也算落在杠端（`beamConnect` 的端点容差只有五分之一格，短杠的端常宽出一截：主使我喜乐 m16）
      const nearEnd = Math.min(Math.abs(gx0 - st.seg.cx), Math.abs(gx1 - st.seg.cx)) < sp * 0.5;
      if (!headAtFar && !nearEnd) {
        for (const { st: s0 } of hitsOf) s0.beams = s0.beams.filter((q) => !grp.includes(q));
        continue;
      }
    }
    // 定层：按「离符头那一端有多远」从远到近排——主杠在干尖上（离符头最远）是第 1 层，副杠往符头方向叠上去。
    // 原来是从近到远，副杠成了第 1 层：时值只数层数不受影响，可 `<beam number>` 整组反了
    //（八段锦「八分 + 两个十六分」：第二个音第 1 层写成 begin、主杠写成第 2 层 continue）。
    // musicpp 是按符干朝向决定升序还是降序；本仓改用**到符头端的距离**——
    // 符干与符头常常有重叠，`Stem::up` 那条判据（符干是否伸到符头之上）会误判，
    // 一误判整组的层就反过来，十六分与八分互换。距离这个量与朝向无关。
    const x = grp[0].x0;
    // 组头的**最左**那根符干当基准（不苛求它正好是 `begin`，理由同上）
    const anchor = conn.get(grp[0])!.reduce((a, h) => (h.st.seg.cx < a.st.seg.cx ? h : a)).st;
    // 符头端 = 符干两端里离符头中心近的那一端（不问朝向，`Stem::up` 会误判）
    const noteY = anchor.notes.reduce((a, n) => a + (n.box.top + n.box.bottom) / 2, 0) / anchor.notes.length;
    const anchorY = Math.abs(anchor.seg.top - noteY) < Math.abs(anchor.seg.bottom - noteY) ? anchor.seg.top : anchor.seg.bottom;
    // 各条杠**在自己的中点处**与组头（最长那条）比高低，不按各自的斜率外推到组头左端：
    // 半截杠只有一格宽，斜率一点噪声外推六七十像素就排到主杠前面，两条都定成第一层
    //（当我们回到天家 m7 附点八分 + 十六分，十六分读成八分）
    const main = grp[0];
    const toward = Math.sign(anchorY - beamY(main, x)) || 1;
    const rel = new Map(grp.map((g) => {
      const xc = (g.x0 + g.x1) / 2;
      return [g, (beamY(g, xc) - beamY(main, xc)) * toward] as const;
    }));
    grp.sort((a, b) => rel.get(a)! - rel.get(b)!);
    let last = rel.get(grp[0])!;
    let level = 1;
    grp[0].level = 1;
    for (let i = 1; i < grp.length; i++) {
      const y = rel.get(grp[i])!;
      if (Math.abs(y - last) >= sp / 4) level++;
      last = y;
      grp[i].level = level;
    }
  }
}

// ── 音符 ────────────────────────────────────────────────────────────────────

/** 一个认出来的音符（或休止）。 */
export interface StaffNote {
  sym: Sym;
  staff: Staff;
  /** 休止。 */
  rest: boolean;
  /** 全音阶序号（休止为 -1）。 */
  diatonic: number;
  step: string;
  octave: number;
  /**
   * **发声的**升降（半音数）：调号 + 小节内延续 + 临时记号一起算出来的。
   * MusicXML 的 `<alter>` 要的是这个。由 `calcAlters` 填。
   */
  alter: number;
  /** 谱面上**印出来的**临时记号（半音数）；没印为 null。MusicXML 的 `<accidental>` 要的是这个。 */
  accidental: number | null;
  /** 时值（全音符 = 1），已含附点。 */
  duration: number;
  /** 不含附点的基本时值。 */
  base: number;
  dots: number;
  /** 符干朝上。没有符干为 null。 */
  stemUp: boolean | null;
  /** 符干远离符头那一端的 y（页面单位）：写出成 `<stem default-y>`，排版照原图的符干长。复合字形（符干画在字形里）的音没有 */
  stemTip?: number;
  /** 符尾/符杠条数。 */
  beams: number;
  /**
   * 逐层的符杠状态（下标 = 层 − 1），出 `<beam number>`。**只有接在符杠上的音才有**：挂符尾的八分没有这一项，
   * MusicXML 里不写 `<beam>` 的短音就画符尾——符杠与符尾靠它分开。见 `beamStates`。
   */
  beam?: BeamState[];
  x: number;
  /** 挂在这个音符上的歌词，按段（verse）。 */
  lyrics?: { verse: number; text: string; hyphen: boolean; cont: boolean; /** 这个字后面拖着延长线（一字多音，见 `markLyricExtends`）。 */ extend?: boolean; /** 字号（页面单位，见 `SPage.textEm`） */ size?: number; /** 这一行词印在谱表上方（`<lyric placement="above">`） */ above?: boolean; /** 这一行词的基线（页面单位），写源谱版面时出成 `default-y` */ baseY?: number; /** 原图上这个字的框（页面单位），识别对照用 */ box?: Box; /** 编辑器的识别对照用：写进 `<lyric id>` 的 id（同 `omrId`） */ id?: string; /** 首字前印的段号（「1.」），写出时并进字前（`toxml.ts::lyricXml`） */ label?: string }[];
  /** 这些字的歌词延长线到这个音为止（`<extend type="stop"/>`）。记的是那个字本身，段号后来被重排也跟着走。 */
  lyricExtendStop?: { verse: number }[];
  /** 挂在这个音符上的和弦符号（归一后的原文，如 `Am`、`G/B`、`Dm7`）。 */
  chord?: string;
  /** 和弦的字号（页面单位，见 `SPage.textEm`）。和弦在后处理里挪来挪去时跟着 `chord` 走 */
  chordSize?: number;
  /** 长音中途换的和弦：`frac` 是它落在这个音时值里的位置（0–1），写出成 `<harmony><offset>`。见 `attachHarmonies`。 */
  chordLater?: { text: string; frac: number; size?: number }[];
  /** 编辑器的识别对照用：写进 `<note id>` 的 id（`rasteromr/song.ts` 给）。记在音符上而不是旁表——写出前音符会被复制（`{...n}`） */
  omrId?: string;
  /**
   * 这是**和弦里的附加音**（同一根符干上、与另一个音同 x，且不是最低的那个）。
   *
   * 领唱谱的引子常常是柱状和弦（实测 p205 头一行），主旋律只取最高音；
   * MusicXML 那边这些音要带 `<chord/>`，不然会被当成先后两个音、时值全乱。
   */
  chordExtra?: boolean;
  /** 挂在这个音符上的演奏法记号（SMuFL 名，见 `notations.ts`）。 */
  marks?: string[];
  /** 没有符干的音（全音符）上震音斜线的墨迹中心：x 离符头左缘、y 在谱表顶线之上多少，格（写成 `<tremolo default-x/default-y>`） */
  tremoloAt?: { x: number; y: number };
  /**
   * 声部号（1 起）。一行谱上写两个声部时（SATB 把女高女低挤在一行），
   * **按符干方向分**：朝上的是第一声部、朝下的是第二声部。见 `assignVoices`。
   */
  voice: number;
  /**
   * **跨谱表书写的音**：符头画在这一行、符干伸进同系统相邻那一行（符杠在那边），是那一行的声部借地方写的
   *（钢琴左手的琶音升进右手谱表）。不参加这一行的凑拍与分声部，声部号另记。位图路 `markCrossStaff` 填。
   */
  crossStaff?: boolean;
  /** 借地方写的是哪一行（`crossStaff` 的音按这一行凑拍、分声部，写出时进这一行的声部，`<staff>` 仍按符头所在那行）。 */
  crossTo?: Staff;
  /** 落在八度移位段里（音高已经移过了，这里只记一笔给 `<octave-shift>` 用）。 */
  octaveShift?: "up" | "down";
  /** 力度记号（`mp`/`f`…）。MusicXML 里出成 `<direction>`，排在这个音符之前。 */
  dynamic?: string;
  /** 印在这个音符处的文字指示（rit. / a tempo / cresc. / Fine…）：原文与在谱表上方还是下方。MusicXML 里出成 `<direction><words>`。 */
  /** 挂在这个音前面的反复记号（`notations.ts::attachSigns`），出 `<direction>` 的 `<segno/>` / `<coda/>`。 */
  signs?: ("segno" | "coda")[];
  /** 印在这个音（本行末音）之后、行末小节线上的反复记号（`attachSigns`），`<direction>` 写在音之后 */
  signsAfter?: ("segno" | "coda")[];
  words?: { text: string; above: boolean; /** 字号（页面单位） */ size?: number; /** 基线（页面单位），写源谱版面时出成 `default-y` */ baseY?: number; /** 加框的排练号（`<rehearsal enclosure="square">`） */ rehearsal?: boolean; /** 排练号自带【】（`enclosure="none"`） */ bracket?: boolean; /** 原图上的框（页面单位），识别对照用 */ box?: Box; /** 写进 `<direction id>` 的 id（同 `omrId`） */ id?: string }[];
  /** 节拍器记号：拍子单位（`quarter`）、每分钟拍数、`<per-minute>` 的原文（带「约」时 `c. 76`，否则省）。MusicXML 里出成 `<direction><metronome>`。 */
  metronome?: { unit: string; bpm: number; text?: string; /** 印在圆括号里（「(♩ = 82)」）→ `<metronome parentheses="yes">` */ parentheses?: boolean };
  /** 与节拍器印在同一条的速度文字（`Andante ♩ = c. 76` 的 `Andante`）：与节拍器写进**同一个** `<direction>`，不拆成两个对象。 */
  tempoText?: string;
  tempoSize?: number;
  /** 速度 / 节拍器那一条在原图上的框与写进 `<direction id>` 的 id（识别对照用） */
  tempoBox?: Box;
  tempoId?: string;
  /** 力度记号在原图上的墨迹框（页面单位）：写出成 `default-y` / `relative-x` / `font-size`，排版照原位原大小。见 `attachDynamicTexts` */
  dynamicBox?: { left: number; right: number; top: number; bottom: number };
  /** 编辑器的识别对照用：力度那条 `<direction id>`（同 `omrId`，有 `dynamicBox` 的才给） */
  dynamicId?: string;
  /** OCR 读出、没量墨迹框的力度在原图上的大致范围（字行起头那几个字母）：只给识别对照画框，写出不用 */
  dynamicSrcBox?: { left: number; right: number; top: number; bottom: number };
  /** 松叶从这个音符**起**（`<wedge type="crescendo|diminuendo">`）。见 `attachWedges`。 */
  wedgeStart?: "crescendo" | "diminuendo";
  /** 起在这个音上的松叶在原图上的样子（页面单位）：左端 x、中线 y、开口高 */
  wedgeAt?: { x0: number; cy: number; spread?: number };
  /** 松叶画到这个音**止**（`<wedge type="stop">` 写在它之前：止点时刻 = 它的起点，画到它所在的横坐标）。 */
  wedgeStop?: boolean;
  /** 止写在这个音**之后**（= 它的终点）：右端越过了小节里最后一个音、收在小节线前的那条，挂在末音上 */
  wedgeStopAfter?: boolean;
  /** 止在这个音上的松叶在原图上的右端 x 与（渐强时）开口高（页面单位） */
  wedgeStopAt?: { x1: number; spread?: number };
  /** 连音（三连音之类）：`actual` 个音占 `normal` 个音的时值。`start` / `stop`：这一组最左、最右的那个音（和弦各音都记），
   *  MusicXML 的 `<tuplet>` 只在这两处写起止（`applyTuplet`）。 */
  tuplet?: { actual: number; normal: number; start?: boolean; stop?: boolean };
  /**
   * **斜杠符头**（`noteheadSlash*`）：不是有音高的音符，而是「照这个节奏弹和弦」的记号。
   *
   * 这本书的前奏、间奏常常整行写斜杠 + 和弦名（实测 088/094/102 三首各有 16~19 个），
   * 它们全落在谱表第三线上，按符头算就成了一串 B4 四分音符——**全书「多出来的音符」
   * 里最大的一类就是它**。有音高的那些字段（`step`/`octave`/`diatonic`）对它没有意义，
   * MusicXML 那边出成 `<notehead>slash</notehead>`。
   */
  slash?: boolean;
  /** 打击乐谱号下的音（`unpitchedPercussionClef*`）：没有音高，MusicXML 出 `<unpitched>` 记显示位置，调号、临时记号都不作用 */
  unpitched?: boolean;
  /** 打击乐的叉形符头（`noteheadXBlack` / `noteheadCircleX`），MusicXML 出 `<notehead>x</notehead>` / `circle-x`。 */
  xHead?: "x" | "circle-x";
  /** 所属和弦（`initChords` 填）。声部与小节内起点都记在和弦上，见 `StaffChord`。 */
  group?: StaffChord;
  /** 倚音：不占拍子，MusicXML 里出 `<grace/>` 且**不写 `<duration>`**。见 `checkFull` 的 `ignoreSmall`。 */
  grace?: boolean;
  /** 叠印的第二个休止（`Sym.redrawn`）：占拍子，写出 `print-object="no"` */
  hidden?: boolean;
  /** 倚音干上斜穿一道杠（短倚音），MusicXML 出 `<grace slash="yes"/>`。见 `notations.ts::findGraceSlashes`。 */
  graceSlash?: boolean;
  /** 圆滑线/连音线的起讫（见 `slur.ts`）。一个音符可以同时是上一条的收尾与下一条的起头。 */
  slurStart?: boolean;
  slurStop?: boolean;
  /** 收尾的那条圆滑线起在哪行谱（跨谱表的弧，钢琴左手起、右手收）：写出时 `<slur number>` 两端要一致，按起端那行编。 */
  slurStopFrom?: Staff;
  /** 这个音起 / 收的是**哪几条**弧（`markSlurNotes` 给的弧号）。写出时按它配对、分配 `<slur number>`（`renumberSlurs`）；
   *  光凭上面两个布尔值，同一行谱上交叠的两条弧（嵌套、上下两声部各一条）配不上对。 */
  slurStartIds?: string[];
  slurStopIds?: string[];
  /** 只认出一端的弧（`markSlurNotes` 按几何定）：`end` = 起在这个音、另一端伸到本行最后一小节或谱表右缘之外（跨行弧的前半），
   *  `begin` = 止在这个音、另一端起在本行第一小节前半（跨行弧的后半），`mid` = 系统中间缺一端。写出时 `renumberSlurs` 只把
   *  同一声部同一行谱上的 `end` 与这个声部下一个出现的系统里的 `begin` 接成一条，接不上的不写。 */
  slurOrphans?: { id: string; edge: "end" | "begin" | "mid"; above: boolean }[];
  /** 页上第一个系统行首起笔的弧（`SlurArc.edgeFirst`）可以从这个音起：上一页末系统同一行谱没有行尾半截时，整曲拼页时补成起端。 */
  slurEdgeCands?: { id: string; above: boolean }[];
  tieStart?: boolean;
  tieStop?: boolean;
  /** 起头的那条圆滑线 / 连音线画在音符上方（弧朝上，`SlurArc.above`）还是下方；没认出方向的不写。 */
  slurAbove?: boolean;
  tieAbove?: boolean;
  /** 起头的那条圆滑线 / 连音线画成虚线（`<slur line-type="dashed">`）。 */
  slurDashed?: boolean;
  tieDashed?: boolean;
  /** 起在 / 挂在这个音上的弧在原图上的外框（`markSlurNotes` 按弧号记，同一条画两份的只记头一份）：识别对照给 `<slur id>` 配框 */
  slurBoxes?: { arc: string; box: Box }[];
  /** 起在这个音上的延音线在原图上的外框与写进 `<tied id>` 的 id（识别对照用） */
  tieBox?: Box;
  tieId?: string;
}

/**
 * 把已归属谱表的符头/休止算成音符。
 *
 * 时值来源，按 musicpp 的口径：符头形状定基本时值（全/二分/四分），
 * 再由**符尾条数**或**穿过符干的符杠条数**逐条减半，最后乘附点。
 */
/**
 * 这一行谱的谱号。本行没认出来的，**沿用上一个系统同一位置那行谱的**。
 *
 * musicpp 在 `Score::analyzeBarData` 里做同一件事（`middleStep = prev->middleStep`，
 * `st->prev` 指的就是上一系统的同一行）。矢量路一直没补这一条，是因为那本书的谱号
 * 几乎都认得出；位图路认不出的有一成半（实测宁静 100 行谱里 15 行），
 * 不继承就退回 `middleStep = 41`（高音谱号的口径），低音谱行整行的音高全错。
 *
 * 只在**系统内的同一位置**之间继承：一个系统里第 k 行是同一个声部，
 * 声部中途不会换谱号（真换谱号时那一行必然印出来，也就认得出）。
 */
export function clefFor(pg: SPage, ctx: Map<Staff, StaffContext>, stf: Staff, x = Infinity): Sym | null {
  // **行中换谱号**：取音左边最近的那个谱号（望十架 p9 钢琴右手行中换低音谱号）
  const cs = ctx.get(stf)?.clefs ?? [];
  const before = cs.filter((c) => c.box.left < x);
  if (before.length) return before[before.length - 1];
  let si = -1;
  let ki = -1;
  for (let i = 0; i < pg.systems.length && si < 0; i++) {
    const k = pg.systems[i].staves.indexOf(stf);
    if (k >= 0) {
      si = i;
      ki = k;
    }
  }
  if (si < 0) return null;
  for (let i = si - 1; i >= 0; i--) {
    const prev = pg.systems[i].staves[ki];
    if (!prev) continue;
    // 上一行行中换过谱号的，接着用换后的那个
    const pc = ctx.get(prev);
    const c = pc?.clefs?.length ? pc.clefs[pc.clefs.length - 1] : pc?.clef;
    if (c) return c;
  }
  return null;
}

export function buildNotes(
  pg: SPage,
  ctx: Map<Staff, StaffContext>,
  beams: BeamShape[],
  /** 出参：这一页的符干（三连音那一步要用）。 */
  stemsOut?: StemInfo[],
  /** 可选：认成实心、其实中间是空的头（位图路按墨判）。没有杠和尾的，时值按空心头算。 */
  hollowish?: (s: Sym) => boolean,
  /** 矢量路：开只在矢量路用的判据（两声部同音共头、首尾相接的干不并和弦等，位图路干端不准，开了独唱 / 合唱谱退步） */
  vector = false,
): StaffNote[] {
  const sp = pg.normalStaffSpace || pg.space;
  const stems = buildStems(pg, sp, vector);
  stemsOut?.push(...stems);
  calcBeamLevels(beams, stems, sp, pg.symbols.filter((q) => q.code.startsWith("notehead")).map((q) => q.box));
  // 符头 → 它那根符干
  const stemOf = new Map<Sym, StemInfo>();
  for (const st of stems) for (const n of st.notes) if (!stemOf.has(n)) stemOf.set(n, st);
  /** 一个头贴着一上一下两根干、朝上的在右缘朝下的在左缘：两声部同音共用的头，返回两根干 */
  const unisonStems = (s: Sym): StemInfo[] | undefined => {
    const on = stems.filter((st) => st.notes.includes(s));
    if (!vector || on.length !== 2 || on[0].up === on[1].up) return undefined;
    const edge = (st: StemInfo) => Math.abs((st.up ? s.box.right : s.box.left) - st.seg.cx) <= sp / 4;
    return on.every(edge) ? on : undefined;
  };
  const beamOf = new Map<StemInfo, BeamState[]>();
  for (const st of stems) if (!st.flags && st.beams.length) beamOf.set(st, beamStates(st, stems, sp));

  const dots = pg.symbols.filter((s) => s.code === "augmentationDot" && !s.hasAnyTag());
  const out: StaffNote[] = [];
  // 临时记号 → 它的符头：右边一格内、纵向交叠的符头里中心离它最近的那一个
  const heads = pg.symbols.filter((q) => q.hasTag("Note") && q.ownerStaff);
  const ownerCache = new Map<Sym, Sym | null>();
  const accidentalOwner = (a: Sym): Sym | null => {
    if (ownerCache.has(a)) return ownerCache.get(a)!;
    let best: Sym | null = null;
    for (const h of heads) {
      if (!overlapY(a.box, h.box) || a.px > h.box.left || xSpace(a.box, h.box) > sp) continue;
      if (!best || Math.abs(h.py - a.py) < Math.abs(best.py - a.py)) best = h;
    }
    ownerCache.set(a, best);
    return best;
  };

  // 空心头不上符杠：干端压着一条与别的干共用的杠，这个头就是扫描件上肚里留白的实心头
  // （望十架 p5 m39–40 低音八分读成二分 / 全音符）。杠要在干端——干中段横穿的粗谱线也会被收成杠（p6 m50 二分 D4）；
  // 共用这条杠的干要与它同向——二分和弦的干顶顶到上方谱表朝下的那组杠的，是另一声部的杠（爱是从神而来 p4 m40 低音）。
  const beamedTip = (st: StemInfo): boolean => {
    const tip = st.up ? st.seg.box.top : st.seg.box.bottom;
    return st.beams.some((b) => Math.abs(beamY(b, st.seg.cx) - tip) < sp * 0.6 && stems.some((o) => o !== st && o.up === st.up && o.beams.includes(b)));
  };
  const timeBoxes = pg.symbols.filter((t) => isTimeSig(t.code)).map((t) => t.box);
  for (const s of pg.symbols) {
    if (!s.hasTag("Note") || !s.ownerStaff) continue;
    const stf = s.ownerStaff;
    const rest = isRest(s.code);
    // 中心落在拍号盒里的不是音：拍号认出之后，后面几路补头还会在数字的笔画上补出头来
    //（生之颂钢琴 m1 行首 2/2 的两个「2」，右手多出一个三音全音符和弦）
    if (timeBoxes.some((b) => s.px > b.left && s.px < b.right && s.py > b.top && s.py < b.bottom)) continue;
    // 行首谱号左缘以左的休止不是谱里的：速度记号「𝅗𝅥 = 72」的空心头落在谱号上方，按字形认成二分休止
    //（主爱的大能 m1 多出一个全休止）
    if (rest) {
      const first = (ctx.get(stf)?.clefs ?? []).reduce<Sym | null>((a, c) => (!a || c.box.left < a.box.left ? c : a), null);
      if (first && (s.box.left + s.box.right) / 2 < first.box.right) continue;
    }
    const clef = clefFor(pg, ctx, stf, s.box.left);
    const mid = clef ? clefMiddleStep(clef.code) ?? 41 : 41;

    let diatonic = -1;
    let step = "";
    let octave = 0;
    if (!rest) {
      diatonic = mid + stf.middleStep(s.py, (s.box.left + s.box.right) / 2);
      const p = stepToPitch(diatonic);
      step = p.step;
      octave = p.octave;
    }

    // **两声部同音共用一个符头**：头的右缘挂着朝上的干、左缘挂着朝下的干，两根干各出一个音（八段锦笛子 m61–62 上下声部同是 G4 / E5）
    for (const stem of rest ? [undefined] : unisonStems(s) ?? [stemOf.get(s)]) {
      const stemUp = stem ? stem.up : s.compositeStemUp ?? null;
      // **层数取符尾条数，或这根符干上最高的那一层符杠**——不是「数穿过符干几条」：
      // 十六分的第二条常常只是半截钩，盖住的符干比第一条少（见 calcBeamLevels 的注释）。
      // **层数 = 这根符干上「有几个不同的层」**，不是「最高的那一层」。
      //
      // musicpp 取最高层。实测那样更差（全书时值 71.7% → 70.3%）：`calcLevel` 把整组符杠
      // 外推到组左端的 x 处比高低，靠右那条短符杠一外推，斜率误差被放大，层就判高了；
      // 于是只压着一条符杠的符干拿到了「第 2 层」，八分读成十六分。
      // 数「不同的层」两头都占：同一条符杠被拆成两段时（同层）只算一次，
      // 而外推判错层也只影响那一层的编号、不影响个数。
      const nb = stem
        ? stem.flags ||
          (staffOmrOptions.beamLevels
            ? new Set(stem.beams.map((b, i) => (b.level > 0 ? `L${b.level}` : `u${i}`))).size
            : stem.beams.length)
        : 0;

      let base: number;
      if (s.compositeBase !== undefined) {
        // 复合音符字形（`page.ts::adoptCompositeNotes`）：没有单独的符干可数，
        // 时值由字形本身给出，符干一律朝上。
        base = s.compositeBase;
      } else if (rest) {
        base = restDuration(s.code);
        if (base < 0) base = 1; // restHBar：整小节休止，先按全音符，`toxml` 再按拍号改
        // **全休止与半休止在字体里是同一个方块**，只有落在第几线上不同：
        // 半休止**坐在中线上**（墨迹底贴中线），全休止**吊在上面一线下**（底比中线高一格）。
        // 字形字典分不开它们（轮廓逐位相同，一律标成了 `restHalf`），只能按几何判——
        // 不判的话整小节的全休止全读成半休止，小节时值自检与 GT 的时值档都跟着错。
        if (s.code === "restHalf" || s.code === "restWhole") {
          const space = (stf.stepDistance() || 0) * 2 || sp;
          const mid = (stf.box.top + stf.box.bottom) / 2;
          // 按方块的**中线**判：全休止吊在第四线下（中线在谱表中线上方 0.75 格），二分休止坐在中线上（0.25 格），门槛取半格。
          // 原先按底边比半格：八段锦的全休止底边离中线正好半格，卡在线上读成二分；改按底边比四分之一格，
          // 位图路去了谱线的二分休止底边离中线也有零点几格，又读成全休止（新编 076 m18）
          // 推广开就是**中心落在上下两条线之间的哪一半**：上半是吊着的全休止、下半是坐着的二分休止（谱表外照线距往外推）。
          // 标准位置上与「离中线半格」同一个门槛；让位到别处的（两声部时上声部的休止抬高一两格）也判得对——
          // 生之颂钢琴 m13 左手二分休止坐在第二线上，中心比中线高一格，按离中线读成全休止，这一小节多出两拍
          // 位图路弯、斜的谱线按方块所在 x 取线位（`lineYsAt`）；矢量路没有，就是整行的线位
          const ys = [...(stf.lineYsAt?.(s.px) ?? stf.lineYs)].sort((a, b) => a - b);
          const cy = (s.box.top + s.box.bottom) / 2;
          if (ys.length >= 2) {
            const k = ys.filter((y) => y <= cy).length - 1;
            const above = k >= 0 ? ys[k] : ys[0] - space;
            const below = k < 0 ? ys[0] : k < ys.length - 1 ? ys[k + 1] : ys[ys.length - 1] + space;
            base = (cy - above) / (below - above) < 0.5 ? 1 : 1 / 2;
          } else base = mid - cy > space * 0.5 ? 1 : 1 / 2;
        }
      } else if (s.code === "noteheadWhole" || s.code === "noteheadDoubleWhole") {
        base = s.code === "noteheadDoubleWhole" ? 2 : 1;
      } else if (s.code === "noteheadHalf" && !(stem && !stem.flags && beamedTip(stem))) {
        base = stem ? 1 / 2 : 1;
      } else if (nb === 0 && s.code === "noteheadBlack" && hollowish?.(s)) {
        base = stem ? 1 / 2 : 1;
      } else {
        base = 1 / 4;
        for (let i = 0; i < nb; i++) base /= 2;
      }

      // 谱面上印出来的临时记号：贴在符头左边、同高度。**一个记号只归一个符头**（`accidentalOwner`）：
      // 升号字形高约三格，三度和弦里上面那个头也跟它纵向交叠，按交叠认会一个升号给两个头
      // （宣主荣耀钢琴 m11 `♯C4 E4 G4` 读成 C♯ + E♯）
      let accidental: number | null = null;
      for (const a of pg.symbols) {
        if (!a.hasTag("Accidental")) continue;
        if (accidentalOwner(a) !== s) continue;
        accidental = accidentalAlter(a.code);
        break;
      }

      // 复合音符字形自带时值、没有杠可分
      const beam = stem && s.compositeBase === undefined ? beamOf.get(stem) : undefined;
      out.push({ sym: s, staff: stf, rest, diatonic, step, octave, alter: 0, accidental, duration: base, base, dots: 0, stemUp, ...(stem ? { stemTip: stem.up ? stem.seg.box.top : stem.seg.box.bottom } : {}), beams: nb, ...(beam ? { beam } : {}), x: s.px, voice: 1, ...(s.redrawn ? { hidden: true } : {}), slash: s.code.startsWith("noteheadSlash") || undefined, ...(s.code === "noteheadXBlack" ? { xHead: "x" as const } : s.code === "noteheadCircleX" ? { xHead: "circle-x" as const } : {}), ...(!rest && clef?.code.startsWith("unpitchedPercussionClef") ? { unpitched: true } : {}) });
    }
  }
  // **先按谱行、再按 x**。只按 x 排会把一页里几行谱的音符横向交织在一起
  // ——顺序一乱，与 GT 的逐音比对就全废（实测准确率卡在两成半）。
  out.sort((a, b) => a.staff.box.top - b.staff.box.top || a.x - b.x);
  attachDots(out, dots, sp);
  // 和弦归拢要在这里做（符干还在手里）；**声部与小节内起点留到 `checkBars`**——
  // 三连音（`findTuplets`）在 `buildNotes` 之后才改时值，早算的 offset 会是错的。
  initChords(out, stems, sp, vector);
  calcAlters(pg, ctx, out);
  return out;
}

/**
 * 附点分配：**逐个附点找主人**，而不是逐个音符找点。
 *
 * 反过来做会出两种错：同一枚点被左右两个音符各认一次（时值凭空多出来）；
 * 而线上音符的附点按惯例写在**上方那个间**里（差半格），纵向容差不够就整个漏掉
 * ——实测小节时值自检里最大的一档偏差正是 0.88（缺八分之一），那就是漏附点的特征。
 */
function attachDots(notes: StaffNote[], dots: Sym[], sp: number): void {
  // dx 从和弦里**贴着的最右那个头**量起：二度和弦错开画在干另一侧的头把附点列往右推了一个头宽
  //（《恩友歌》C5/A4/G4 附点四分，C5 离点 1.8 格）。两列之间容 0.3 格：位图上右列头的左缘离左列头右缘常差两三个像素
  //（恩友歌第七小节 G4 差 3 像素没算进去，点离它 1.8 格挂不上）。
  const rightOf = (n: StaffNote) => {
    let r = n.sym.box.right;
    for (const m of notes)
      if (m.staff === n.staff && m.sym.box.left <= n.sym.box.right + Math.max(2, sp * 0.3) && m.sym.box.right >= n.sym.box.left && Math.abs(m.sym.py - n.sym.py) <= sp * 1.5)
        r = Math.max(r, m.sym.box.right);
    return r;
  };
  const rights = new Map(notes.map((n) => [n, rightOf(n)]));
  /** 每个音已收的点（x）：同一列的点一个头只收一个（和弦两个线上音的点各在自己上方的间，离两头一样远）。 */
  const got = new Map<StaffNote, number[]>();
  const owner = new Map<Sym, StaffNote>();
  for (const d of dots) {
    let best: StaffNote | undefined;
    let bd = Infinity;
    for (const n of notes) {
      const r = rights.get(n)!;
      // 点的**中心**要在右缘之右（不用 `px`：位图路 `px` 是盒左缘，头盒带进圈外毛边时右缘罩住点的左边两列——齐来称颂 m18/m19）
      if (d.px <= r && (d.box.left + d.box.right) / 2 <= r) continue;
      const dx = d.px - r;
      if (dx > sp * 1.5) continue;
      // 线上音符的附点写在上方那个间里，差半格；再放一点余量。0.75 → 0.85，与位图路找点的窗口（头心上 0.85 格）一致：
      // 头盒偏下时点心离头心 0.79 格（主我敬拜你 m4 附点二分 G4）
      const dy = Math.abs(d.py - n.sym.py);
      if (dy > sp * 0.85) continue;
      if (got.get(n)?.some((x) => Math.abs(x - d.px) < sp * 0.3)) continue;
      // 能不能挂按和弦右缘判，**谁优先按自己的右缘**：两个声部错开画的二度（以马内利 m19 A4 在 G4 左边），
      // 点是右边那个的；同距离的，点在头上方的优先（线上音的点写在上方的间），再按高度差
      const key = (d.px - n.sym.box.right) + (d.py <= n.sym.py + sp * 0.1 ? 0 : 0.02) + dy * 0.01;
      if (key < bd) {
        bd = key;
        best = n;
      }
    }
    if (!best) continue;
    got.set(best, [...(got.get(best) ?? []), d.px]);
    owner.set(d, best);
    best.dots++;
    d.addTag("Augmentation");
  }
  // **和弦按次序重配**（附点排版规则：和弦各音的点在右边排成一列、一个间一个，上下次序同头的次序；
  // 挤着二度时点会被挤到下方的间、甚至再往下一个间）。逐个点找最近的头会错配：线上音按惯例抢上方的点，
  // 把本属于间上那个音的点拿走（恩友歌伴奏 m17 C5/A4/G4/F4：G4 拿了 A4 的点，F4 的点在头心下一格，够不着）。
  // 一列头（同一谱行、横向交叠、上下相邻不过 3 格）右边同一列的点数**正好等于头数**时，按上下次序一一配。
  const cols: StaffNote[][] = [];
  for (const n of notes) {
    if (n.rest) continue;
    const c = cols.find((q) => q[0].staff === n.staff && q.some((m) => m.sym.box.left <= rights.get(n)! + sp * 0.3 && rights.get(m)! >= n.sym.box.left - sp * 0.3 && Math.abs(m.sym.py - n.sym.py) <= sp * 3));
    if (c) c.push(n);
    else cols.push([n]);
  }
  for (const c of cols) {
    if (c.length < 2) continue;
    c.sort((a, b) => a.sym.py - b.sym.py);
    const r = Math.max(...c.map((n) => rights.get(n)!));
    const top = c[0].sym.py - sp * 0.85;
    const bot = c[c.length - 1].sym.py + sp * 1.25;
    const ds = dots.filter((d) => (owner.has(d) ? c.includes(owner.get(d)!) : true) && (d.box.left + d.box.right) / 2 > r && d.px - r <= sp * 1.5 && d.py >= top && d.py <= bot);
    if (ds.length !== c.length) continue;
    // 同一列（横向差不过 0.5 格）、上下相隔 0.7 格以上（一个间一个）
    const mx = ds.reduce((a, d) => a + d.px, 0) / ds.length;
    if (ds.some((d) => Math.abs(d.px - mx) > sp * 0.5)) continue;
    ds.sort((a, b) => a.py - b.py);
    if (ds.some((d, i) => i > 0 && d.py - ds[i - 1].py < sp * 0.7)) continue;
    for (const d of ds) {
      const o = owner.get(d);
      if (o) o.dots--;
    }
    ds.forEach((d, i) => {
      owner.set(d, c[i]);
      c[i].dots++;
      d.addTag("Augmentation");
    });
  }
  // 附点定了才能算时值
  for (const n of notes) {
    let dur = n.base;
    let add = n.base;
    for (let i = 0; i < n.dots; i++) {
      add /= 2;
      dur += add;
    }
    n.duration = dur;
  }
}

// ── 和弦层：`Chord` / `initChords` / `checkFull` / `splitVoice` ──────────────
//
// 逐条对应 musicpp `qtomr/NoteData.cpp` 的 `Bar::initChords` :1376、
// `Bar::checkFull` :1117、`Bar::splitVoice` :1014、`Chord::guessDur` :1292。
//
// 为什么要这一层：**时值与声部是同一件事**。一个小节里写两个声部时，
// 光看「音符时值加起来是不是拍号」永远对不上（两个声部各自凑满，合起来是两倍）；
// 而要分声部，先得知道每个音**从第几拍起**——那正是 `checkFull` 算出来的 `offset`。
// 原来那版按符干方向分声部（`assignVoices`）绕开了 offset，代价是 SATB 那一路
// （Opus 68 页）小节自检只有 60%，全书最低。
//
// `guessDur` 在本仓不用另写：`buildNotes` 早就把符头形状、符尾/符杠层数、附点、
// 三连音一并算进了 `StaffNote.duration`，那就是原文 `Chord::guessDur(true,true)`
// 的结果。**别再照原文抄一份**——那些判据（半休止 vs 全休止按第几线判、
// 层数数「不同的层」而不是「最高的层」）都是拿具体页换来的，抄第二份必然走样。

/** 同一根符干断成两段的判据：两条符干的 x 差（线距的倍数）。 */
const STEM_JOIN_X = 0.3;
/** 同上，两段之间允许的断口（线距的倍数）。 */
const STEM_JOIN_GAP = 1.0;
/** 干上端高出头顶不到这么多格（线距的倍数）不算朝上（见 `findStems` 那一段 `Stem::up`）。 */
const STEM_UP_SLACK = 0.15;

/** 断成两段的干，断口不过这个数（线距的倍数）才统一两段的时值（见 `inheritDur`）。 */
const STEM_SPLIT_DUR_GAP = 0.4;

/** 落单的符头并回和弦时，与和弦里最近那个头的**音级差**上限（见 `initChords`）。 */
const ORPHAN_STEP = 5;
/** 同上，纵向距离上限（线距的倍数）。 */
const ORPHAN_DY = 3.0;

/** 一个和弦 = 共用一根符干的一撮符头（或一个无符干符头 / 一个休止）。musicpp 的 `omr::Chord`。 */
export interface StaffChord {
  staff: Staff;
  /** `[0]` 是主音（**最低的那个**，见 `initChords`），其余在 MusicXML 里带 `<chord/>`。 */
  notes: StaffNote[];
  stem: StemInfo | null;
  left: number;
  right: number;
  top: number;
  /** 小节内的起点（全音符 = 1）。`checkFull` 成功才有意义。 */
  offset: number;
  /** 时值（全音符 = 1）。`checkFull` 成功后写回。 */
  dur: number;
  /** 倚音（`checkFull` 的 `ignoreSmall` 那一趟剔出来的小字号音）。 */
  grace: boolean;
  /** `checkFull` 凑满了这一小节，`offset`/`dur` 可信。没凑满时两者都是 0，
   *  `toxml` 要退回按顺序累加时值（见那边的 `emitVoices`）。 */
  timed: boolean;
  voice: number;
  /** 矢量路的和弦：`checkFull` / `checkBars` 里只矢量路开的判据看它（见 `buildNotes` 的 `vector`） */
  vector?: boolean;
}

/** `Chord::guessDur(true, true)`：本仓的时值早在 `buildNotes` 里算好了，取主音的即可。 */
const guessDur = (ch: StaffChord): number => ch.notes[0].duration;

/** 这个音的符头有多大（相对线距）。`ignoreSmall` 判倚音用，代替原文的 `Note::fontSize()`。 */
/** 符头大小：宽高的几何平均。只量高的话倚音头比正常头只矮三成上下，卡在门槛上（八段锦二胡 m48 全音符前的小 D5，高比 0.71）。
 *  休止仍只量高：扁的二分 / 全休止按高量总算「小」、凑拍子时先剔掉，位图路靠这个把「四个四分 + 另一声部的二分休止」凑成一个声部
 *（按几何平均它不算小，凑不满，跨谱表对齐把四分全改成八分：新编 076 m18） */
const headSize = (n: StaffNote): number => {
  const h = Math.max(0, n.sym.box.bottom - n.sym.box.top);
  return n.rest ? h : Math.sqrt(h * Math.max(0, n.sym.box.right - n.sym.box.left));
};

/**
 * `Bar::initChords`：把符头归拢成和弦。
 *
 * 原文只按符干归（无符干的符头各自成和弦，靠 `checkFull` 的时间列再并到一起）。
 * 本仓多一步：**无符干的符头按盒相交再归一次**，因为本仓要出 `<chord/>`
 * ——领唱谱的前奏常是柱状全音符和弦，不归的话导出成先后几个音、时值全乱。
 *
 * 按符干归顺带修掉老 `markChords` 的两处漏：
 *   - **二度和弦**的两个符头错开画在符干两侧，x 差整整一个符头宽，
 *     「x 差不到半个符头宽」判不出来；按符干归没这问题。
 *   - 一根符干上的符头无论差几度都是一个和弦，不必再猜。
 */
/**
 * **同一枚和弦里没带杠的头随带杠的那个**（同一种符头才抄：实心随实心、空心随空心；附点取多的）。
 * 两种来路：落单没挂干的头按缺省给了四分；一根干被中间那个头切成两段，下段没挂上杠。
 * 它们常是最低音、成了主音（`guessDur` 取 `notes[0]`），整枚和弦于是按四分走——
 * 《耶和华是我的牧者》三度叠着的八分和弦一百多处都这么读成了四分。
 */
function inheritDur(ch: StaffChord, ns: StaffNote[], orphan: boolean): void {
  for (const n of ns) {
    if (n.beams !== 0 || (orphan && n.stemUp !== null)) continue;
    // 落单的头照抄任一挂干的同种头（附点也跟着来：附点四分、附点二分和弦常只有一个头认出附点）；
    // 断干下段只抄带杠的那段
    const ref = ch.notes.find((m) => m !== n && m.sym.code === n.sym.code && (orphan ? m.stemUp !== null : m.beams > 0));
    if (!ref) continue;
    n.base = ref.base;
    n.beams = ref.beams;
    if (ref.beam) n.beam = ref.beam;
    n.dots = Math.max(n.dots, ref.dots);
    n.duration = n.base * (2 - 1 / 2 ** n.dots);
  }
}

function initChords(notes: StaffNote[], stems: StemInfo[], sp: number, vector = false): StaffChord[] {
  const byNote = new Map<StaffNote, StaffChord>();
  const out: StaffChord[] = [];
  // 共用符头的两声部同音（`buildNotes` 的 `unisonStems`）一个头出两个音，按干的朝向各归各的干
  const bySym = new Map<Sym, StaffNote[]>();
  for (const n of notes) bySym.set(n.sym, [...(bySym.get(n.sym) ?? []), n]);

  const make = (ns: StaffNote[], stem: StemInfo | null): StaffChord => {
    // **主音取最低的那个**，其余带 `<chord/>`。
    //
    // MusicXML 里一个和弦的第一个 `<note>` 不带 `<chord/>`，后面的带；
    // 刻谱软件写和弦是**自下而上**的，所以不带 `<chord/>` 的那个是**最低音**。
    // 一度取最高音（想着「主旋律在上面」），与 GT 的口径正好反着——
    // 实测改成最低音之后矢量路音符 97.3% → 97.8%、音高 97.25% → 97.7%、
    // 「同一版」全对的曲子 29 → 30 首；位图路音符 60.6% → 61.1%。
    ns.sort((a, b) => a.diatonic - b.diatonic);
    const ch: StaffChord = {
      staff: ns[0].staff,
      notes: ns,
      stem,
      left: Math.min(...ns.map((n) => n.sym.box.left)),
      right: Math.max(...ns.map((n) => n.sym.box.right)),
      top: Math.min(...ns.map((n) => n.sym.box.top)),
      offset: 0,
      dur: 0,
      grace: false,
      timed: false,
      voice: 1,
      ...(vector ? { vector } : {}),
    };
    for (let i = 0; i < ns.length; i++) {
      ns[i].group = ch;
      ns[i].chordExtra = i > 0 || undefined;
      byNote.set(ns[i], ch);
    }
    out.push(ch);
    return ch;
  };

  for (const st of stems) {
    const ns: StaffNote[] = [];
    for (const sym of st.notes) {
      const cands = bySym.get(sym) ?? [];
      const n = cands.length > 1 ? cands.find((m) => m.stemUp === st.up && !byNote.has(m)) : cands[0];
      if (n && !byNote.has(n)) ns.push(n);
    }
    if (ns.length) make(ns, st);
  }

  // ── 同一根符干被切成两段的，两枚和弦要并回一枚 ──────────────────────────
  //
  // 位图路上一根长符干常常断成两段（去谱线、抹加线各啃一道），`findStems` 于是
  // 给出两条符干，`initChords` 按符干归就归成**两枚和弦**——起点相同，
  // `splitVoice` 只能把它们分到两层，下面那个成了第二声部，而逐声部对拍
  // 只取声部号最小的那一路。钢琴左手的**八度**几乎全栽在这上面：
  // 实测破碎 p3 m22 那个 C3/C2 八度，两个头各自「和弦 1 有干」，
  // 逐音比下来就是「识别比 GT 高七级」。
  //
  // 判据：同一行谱、两条符干的 x 差不到半个线距（谱面上就是一根）、
  // 纵向搭得上或只差一点点（断口不会超过一格）。
  for (let a = 0; a < out.length; a++) {
    const ca = out[a];
    if (!ca.stem) continue;
    for (let b = out.length - 1; b > a; b--) {
      const cb = out[b];
      if (!cb.stem || cb.staff !== ca.staff) continue;
      const xa = (ca.stem.seg.box.left + ca.stem.seg.box.right) / 2;
      const xb = (cb.stem.seg.box.left + cb.stem.seg.box.right) / 2;
      if (Math.abs(xa - xb) > sp * STEM_JOIN_X) continue;
      const gap = Math.max(ca.stem.seg.box.top, cb.stem.seg.box.top) - Math.min(ca.stem.seg.box.bottom, cb.stem.seg.box.bottom);
      if (gap > sp * STEM_JOIN_GAP) continue;
      // 朝向相反、头一边实一边空的是两个声部（上声部实心头干朝上、下声部空心头干朝下，两干连成一线）：一根干上只挂一种头。
      // 并成一枚的话时值按最低那个头算，整小节凑不满拍（晨曦破晓 m10 女高 D4 四分与女低 C4 附点二分）
      const kind = (c: StaffChord) => new Set(c.notes.map((n) => n.base === 1 / 4 && n.beams === 0 ? "q" : n.base === 1 / 2 ? "h" : "o"));
      const ka = kind(ca), kb = kind(cb);
      if (ca.stem.up !== cb.stem.up && ka.size === 1 && kb.size === 1 && [...ka][0] !== [...kb][0] && !ka.has("o") && !kb.has("o")) continue;
      // 朝向相反、两截各自挂着符杠的是两组的干碰巧首尾相接：一根干断成两截，只有远端那截够得着符杠
      //（八段锦新笛 m32 十六分 A4 干朝上、紧挨着下一组八分 B4 干朝下，B4 被并成 A4 的和弦音）
      if (vector && ca.stem.up !== cb.stem.up && ca.stem.beams.length && cb.stem.beams.length) continue;
      // 矢量谱上朝向相反、两个声部撞二度的（朝上那个头比朝下那个高一级、错开画在干两侧，两干正好同 x）：
      // 在这圣善夜钢琴 m54 右手上声部八分 C5 与下声部四分 B♭4/F4，并成一枚就成了四分和弦、八分丢了，整小节多半拍
      if (vector && ca.stem.up !== cb.stem.up && !endToEnd(ca, cb)) continue;
      for (const n of cb.notes) {
        ca.notes.push(n);
        n.group = ca;
        byNote.set(n, ca);
      }
      ca.left = Math.min(ca.left, cb.left);
      ca.right = Math.max(ca.right, cb.right);
      ca.top = Math.min(ca.top, cb.top);
      ca.notes.sort((m, n) => m.diatonic - n.diatonic);
      ca.notes.forEach((n, i) => (n.chordExtra = i > 0 || undefined));
      // 时值只在断口极小时统一：真被中间那个头切断的干只断几个像素（耶和华 3px）；断口大的
      // 多是两个声部各一根干（上声部朝上、下声部朝下）碰巧同 x，时值本来就不同（万口欢唱、父恩广大、称谢歌）
      if (gap <= sp * STEM_SPLIT_DUR_GAP) inheritDur(ca, ca.notes, false);
      out.splice(b, 1);
    }
  }

  // ── 没挂上符干的符头，先试着**并回同一根符干的那枚和弦** ────────────────
  //
  // 和弦里的符头本该都挂在同一根符干上，可位图路里符干常常够不着最外那个头
  //（符干段的两端被去墨啃掉、`extendVSegs` 那 0.35 格续不到；二度的头还错开
  // 画在符干另一侧）。落单的头于是自成一枚**没有符干**的和弦，与真和弦
  // **起点相同**——`splitVoice` 按 (offset, dur) 贪心分层，同起点的两枚只能分到
  // 两层，落单那个就成了第二声部。而逐声部对拍**只取声部号最小的那一路**，
  // 它整个落在分母外，谱面上的最低音也就没了：实测破碎钢琴右手的读错
  // **一面倒地偏高**（识别比 GT 高 2~7 级，正好是和弦音程），
  // p4 m33 那三枚二度和弦全是这么错的。
  //
  // 判据只认「本来就该是一枚」的那种：同一行谱、x 上与和弦的头**贴着**
  // （错开画的二度也只差一个符头宽），纵向与和弦里最近的那个头不超过一格半
  //（再远就是另一路旋律了，那才该分声部）。
  const orphan = notes.filter((n) => !byNote.has(n) && !n.rest);
  // **真字体的全音符头不并**：矢量路的符头直接来自字形，`noteheadWhole` 就是全音符，不会是「干没挂上的二分」。
  // 并进去的话下面「带干的和弦里没有全音符」那条还会把它改成二分——宣主荣耀钢琴右手 m16 上声部 D4 全音符
  // 并进了下声部的二分，成了「D4+F3 二分」一个和弦。位图路的符号挂在合成字体（`#raster`）上，照旧并——
  // 除非形状已按本页样本确认是全音符（`shapeWhole`，爱是从神而来 p2 m23 钢琴右手 D4 全音符被并成 A4/D4 二分）
  const glyphWhole = (n: StaffNote) => n.sym.code === "noteheadWhole" && (n.sym.shapeWhole || !(n.sym.parent.run?.font ?? "#").startsWith("#"));
  for (const n of orphan) {
    if (glyphWhole(n)) continue;
    let best: StaffChord | null = null;
    let bd = Infinity;
    for (const ch of out) {
      if (ch.staff !== n.staff || !ch.stem) continue;
      // 全音符不并进全是实心头的和弦：位图路并它是当「干没挂上的二分」，二分只会与空心头同干。
      // 另一声部的全音符贴着这根干的（我灵镇静 m4 男高 C4 全音符，男低 G3 四分的干从它左缘下去）并进去就成了二分
      if (n.sym.code === "noteheadWhole" && ch.notes.every((m) => m.sym.code === "noteheadBlack")) continue;
      if (n.sym.box.left > ch.right + sp * 0.6 || n.sym.box.right < ch.left - sp * 0.6) continue;
      const d = Math.min(...ch.notes.map((m) => Math.abs(m.diatonic - n.diatonic)));
      if (d > ORPHAN_STEP || d === 0) continue; // 三级以内才算同一枚；同高的是重复检出，别并
      const dy = Math.min(...ch.notes.map((m) => Math.abs(m.sym.py - n.sym.py)));
      if (dy > sp * ORPHAN_DY) continue;
      if (dy < bd) {
        bd = dy;
        best = ch;
      }
    }
    if (!best) continue;
    best.notes.push(n);
    inheritDur(best, [n], true);
    best.notes.sort((a, b) => a.diatonic - b.diatonic);
    best.notes.forEach((m, i) => (m.chordExtra = i > 0 || undefined));
    best.left = Math.min(best.left, n.sym.box.left);
    best.right = Math.max(best.right, n.sym.box.right);
    best.top = Math.min(best.top, n.sym.box.top);
    n.group = best;
    byNote.set(n, best);
  }

  // 剩下的：无符干的符头按**盒相交**归（全音符符头宽约两个线距，
  // 先后两个音之间的间隙远大于这个容差），休止各自成和弦。
  const rest = notes.filter((n) => !byNote.has(n));
  rest.sort((a, b) => a.staff.box.top - b.staff.box.top || a.sym.box.left - b.sym.box.left);
  let i = 0;
  while (i < rest.length) {
    const head = rest[i];
    let j = i + 1;
    const grp = [head];
    if (!head.rest) {
      while (j < rest.length && rest[j].staff === head.staff && !rest[j].rest) {
        const gap = rest[j].sym.box.left - Math.max(...grp.map((g) => g.sym.box.right));
        if (gap > sp * 0.3) break;
        grp.push(rest[j]);
        j++;
      }
    }
    make(grp, null);
    i = j;
  }
  // **带干的和弦里没有全音符**：空心头自己没挂上干（或头判成了全音符宽），按缺省给了全音符，
  // 可它所在的和弦有干——那是二分（高举主大能低音谱表四处、晨曦破晓、赞美三一真神、齐来崇拜）
  // 独唱谱时值 92.06 → 92.21%，无一首掉；合唱谱扫描档小节自检 +0.13，矢量路不动。
  for (const ch of out) {
    if (!ch.stem) continue;
    for (const n of ch.notes)
      if (!n.rest && n.base === 1 && n.beams === 0 && n.sym.code !== "noteheadDoubleWhole") {
        n.base = 1 / 2;
        n.duration = n.base * (2 - 1 / 2 ** n.dots);
      }
  }
  out.sort((a, b) => a.staff.box.top - b.staff.box.top || a.left - b.left);
  return out;
}

/** 两个和弦的符头盒横向是否相交（`checkFull` 分时间列用）。 */
const chordOverlapX = (a: StaffChord, b: StaffChord): boolean => !(a.left > b.right || b.left > a.right);
/**
 * 两根干同 x、一朝上一朝下，却不是两声部撞二度（朝上那个头比朝下那个高一级、错开画在干两侧）：是先后两个音的干首尾相接，
 * 不同时刻（八段锦小钗 m74 上声部第三个十六分 E5 干朝上、紧挨着下声部第四个八分 F4 干朝下，被归成一列）。
 */
const endToEnd = (a: StaffChord, b: StaffChord): boolean => {
  if (!a.stem || !b.stem || a.stem.up === b.stem.up) return false;
  const [up, dn] = a.stem.up ? [a, b] : [b, a];
  return Math.min(...up.notes.map((n) => n.diatonic)) - Math.max(...dn.notes.map((n) => n.diatonic)) !== 1;
};

/**
 * `Bar::checkFull`：一个小节里的和弦能不能凑满拍号；能就把 `offset`/`dur` 写回去。
 *
 * 做法（照原文 :1117）：
 *   1. 整小节休止（`restHBar`）与「本身就够一小节」的和弦单独收着，不进时间列；
 *   2. 其余按 x 从左到右分**时间列**——与上一列的首和弦横向不相交就开新列，
 *      但两根符干的间隙不到半个线距时仍算同一列（两个声部的符干挨在一起）；
 *   3. 每一列的时值取**列内最小**的那个（长音跨过后面几列），累加成 offset；凑不满再按「还在响的音里最早结束」推进一次；
 *   4. 总和正好等于拍号才提交，否则整小节判失败。
 *
 * `ignoreSmall`：先不带它试一遍，失败再带它试一遍（原文 :1477-1480）。
 * 它把「单音、且符头明显比别人小」的和弦当**倚音**剔出去——倚音不占拍子，
 * 算进去这一小节永远凑不满。
 *
 * `anchorOf`：同系统已凑满的谱行给的拍位（`checkBars` 在前几趟都失败后才传），见下面 `byAnchor`；`lead` 容第一列前面空着。
 */
export function checkFull(chords: StaffChord[], expect: number, sp: number, ignoreSmall: boolean, anchorOf?: (ch: StaffChord) => number | undefined, lead = false): boolean {
  if (!chords.length) return false;
  const EPS = 1e-6;
  let chs = chords;
  const small: StaffChord[] = [];
  if (ignoreSmall) {
    // 与**中位数**比，不与最大值比：个别头盒偏高（粘了别的笔画）就把门槛抬上去，
    // 正常大小的单音整批被当成倚音剔掉（《向主唱新歌》第一小节四个音连同歌词没了）
    const sizes = chords.flatMap((c) => c.notes.map(headSize)).sort((a, b) => a - b);
    const mid = sizes[sizes.length >> 1];
    chs = [];
    for (const c of chords) {
      if (c.notes.length === 1 && headSize(c.notes[0]) < mid * 0.7) {
        small.push(c);
        continue;
      }
      chs.push(c);
    }
    if (!chs.length) return false;
  }
  chs = [...chs].sort((a, b) => a.left - b.left);

  const grps: { chords: StaffChord[]; offset: number }[] = [];
  const measureRest: StaffChord[] = [];
  const full: StaffChord[] = [];
  for (const it of chs) {
    if (it.notes[0].sym.code === "restHBar") {
      it.dur = expect;
      it.offset = 0;
      measureRest.push(it);
      continue;
    }
    if (Math.abs(guessDur(it) - expect) < EPS) {
      it.dur = expect;
      it.offset = 0;
      full.push(it);
      continue;
    }
    let newGrp = !grps.length;
    if (!newGrp) {
      const cha = grps[grps.length - 1].chords[0];
      if (!chordOverlapX(cha, it)) {
        newGrp = true;
        const sa = cha.stem?.seg;
        const sb = it.stem?.seg;
        if (sa && sb && Math.abs(sa.cx - sb.cx) < sp / 2 && !(cha.vector && endToEnd(cha, it))) newGrp = false;
      }
    }
    if (newGrp) grps.push({ chords: [it], offset: 0 });
    else grps[grps.length - 1].chords.push(it);
  }
  const markSmall = () => {
    for (const ch of small) {
      ch.grace = true;
      for (const n of ch.notes) n.grace = true;
    }
  };
  if (!grps.length) {
    if (!measureRest.length && !full.length) return false;
    for (const ch of measureRest) ch.timed = true;
    for (const ch of full) ch.timed = true;
    // 剔掉小头后只剩一个占满整小节的音（八段锦二胡 m48 全音符前的倚音）：小头照样标倚音，原来这一支提前返回漏标了
    markSmall();
    return true;
  }

  // 列起点：先按原文——每列取**列内最短**的时值累加；凑不满再按「所有还在响的音里最早结束的那个」
  // 推进一次：两个声部节奏错开时（男高附点四分 + 八分、男低两个四分，欢然颂主 m4），前一列的长音
  // 跨过本列，只取本列最短会把八分那列推晚半拍、整小节凑不满。单声部时两种算法一样；
  // 一律改用后者，合唱谱几档小降（原先凑得满的小节有的被改了起点）
  const byMin = (): boolean => {
    let res = 0;
    for (const g of grps) {
      g.offset = res;
      let d = Infinity;
      for (const ch of g.chords) d = Math.min(d, guessDur(ch));
      if (!isFinite(d) || d <= 0) return false;
      res += d;
    }
    return Math.abs(res - expect) < EPS;
  };
  const byEnds = (): boolean => {
    let res = 0;
    const ends: number[] = [];
    for (const g of grps) {
      g.offset = res;
      for (const ch of g.chords) {
        const d = guessDur(ch);
        if (!isFinite(d) || d <= 0) return false;
        ends.push(res + d);
      }
      const next = Math.min(...ends.filter((e) => e > res + EPS));
      if (!isFinite(next)) return false;
      res = next;
    }
    return Math.abs(Math.max(...ends) - expect) < EPS && Math.abs(res - expect) < EPS;
  };
  // **按同系统别的谱行对拍位**（`anchorOf`，只在前两种都凑不满时由 `checkBars` 传进来）：一列落在前面的长音还在响的时候，
  // 前两种都只能接在最早结束之后，排不进去——破碎钢琴左手 m39/m80/m99「四分 两个八分 二分」，二分下面第四拍还有个干朝上的 A3 四分
  // 另一声部，按次序接成五拍。那一列与右手第四拍的和弦对齐，起点就取右手那一拍
  const byAnchor = (): boolean => {
    if (!anchorOf) return false;
    // 插进去的那列与还在响的音要分得出是两个声部：都有干、朝向相反（扫描件漏了符杠的八分读成四分，
    // 后一个八分对着上一行的拍位插进去当第二声部，凑满了却是错的：破碎扫描 m69 女低）
    const twoVoices = (g: { chords: StaffChord[] }, sounding: StaffChord[]) =>
      sounding.length > 0 && g.chords.every((c) => c.stem) && sounding.every((c) => c.stem && c.notes[0].stemUp !== g.chords[0].notes[0].stemUp)
      && g.chords.every((c) => c.notes[0].stemUp === g.chords[0].notes[0].stemUp);
    let res = 0;
    let prev = -1;
    const ends: number[] = [];
    const placed: { ch: StaffChord; end: number }[] = [];
    for (const g of grps) {
      let a: number | undefined;
      for (const ch of g.chords) a ??= anchorOf(ch);
      const insert = a !== undefined && a > prev + EPS && a < res - EPS && twoVoices(g, placed.filter((p) => p.end > a! + EPS).map((p) => p.ch));
      // 小节头空着（这一行前几拍不出声，别的行在走）：只容第一列往后挪
      const gap = lead && a !== undefined && prev < 0 && a > EPS && a < expect - EPS;
      g.offset = insert || gap ? a! : res;
      prev = g.offset;
      for (const ch of g.chords) {
        const d = guessDur(ch);
        if (!isFinite(d) || d <= 0) return false;
        ends.push(g.offset + d);
        placed.push({ ch, end: g.offset + d });
      }
      const next = Math.min(...ends.filter((e) => e > g.offset + EPS));
      if (!isFinite(next)) return false;
      res = next;
    }
    return Math.abs(Math.max(...ends) - expect) < EPS && Math.abs(res - expect) < EPS;
  };
  if (!byMin() && !byEnds() && !byAnchor()) return false;
  for (const g of grps)
    for (const ch of g.chords) {
      ch.offset = g.offset;
      ch.dur = guessDur(ch);
      ch.timed = true;
    }
  for (const ch of measureRest) ch.timed = true;
  for (const ch of full) ch.timed = true;
  markSmall();
  return true;
}

/**
 * `Bar::splitVoice`：按 (offset, dur) **贪心分层**，层号即声部号。
 *
 * 只在 `checkFull` 成功之后调（原文 :1481）——没有 offset 就无从分层。
 *
 * 两个前置动作照原文：
 *   - 无符干、且时值正好一小节的和弦**先并成一个**（SATB 的柱状全音符，
 *     四个声部各一个全音符，谱面上是一撮同 x 的符头，本该是一个和弦）；
 *   - 之后按 (offset, 盒顶) 排序。原文比的是 y 向上的 `top`（大的在前），
 *     本仓 y 向下，**翻过来**：`top` 小的（视觉上方）在前。
 */
function splitVoice(chords: StaffChord[], expect: number): void {
  const EPS = 1e-6;
  const res: StaffChord[] = [];
  const full: StaffChord[] = [];
  for (const ch of chords) {
    const first = ch.notes[0];
    if (ch.stem || first.rest) {
      res.push(ch);
      continue;
    }
    if (Math.abs(ch.dur - expect) < EPS) full.push(ch);
    else res.push(ch);
  }
  if (full.length) {
    const first = full[0];
    for (let i = 1; i < full.length; i++) {
      for (const n of full[i].notes) {
        n.group = first;
        first.notes.push(n);
      }
    }
    first.notes.sort((a, b) => a.diatonic - b.diatonic);
    first.notes.forEach((n, i) => (n.chordExtra = i > 0 || undefined));
    res.push(first);
  }
  res.sort((a, b) => a.offset - b.offset || a.top - b.top);

  const done = new Set<StaffChord>();
  const layers: StaffChord[][] = [];
  let guard = res.length + 1;
  while (done.size < res.length && guard-- > 0) {
    for (let i = 0; i < res.length; i++) {
      const ch = res[i];
      if (ch.grace) {
        done.add(ch);
        continue;
      }
      if (done.has(ch)) continue;
      const grp = [ch];
      done.add(ch);
      let now = ch.offset + ch.dur;
      for (let j = i + 1; j < res.length; j++) {
        const c1 = res[j];
        if (done.has(c1) || c1.grace) continue;
        if (c1.offset < now - EPS) continue;
        grp.push(c1);
        done.add(c1);
        now = c1.offset + c1.dur;
      }
      layers.push(grp);
    }
  }
  // **孤零零一个「填满整小节」的和弦，不算一个声部。**
  //
  // 位图路上误检出来的全音符与全休止恰好占满一小节（假全音符来自谱表上方的文字、
  // 假全休止来自符杠断头那类小实心块），`checkFull` 于是把整小节读成
  // 「一个长音 + 另一路旋律」，贪心分层把那个假符号排成**第一声部**（它在最上面），
  // 真旋律整条被推到第二声部去——逐声部对拍只取声部号最小的那一路，
  // 那一行的音就全落在分母外了（实测宁静一首因此掉 1.8 个百分点）。
  //
  // 真正的「一个声部整小节长音」当然存在，但那时另一层也不会是孤例；
  // 这里只剔**层里只有一个和弦、且它自己就占满一小节**的那种，并回第一声部。
  // 而且只剔排在真声部**前面**的：排在后面的挤不掉真旋律，倒常是真的——合唱谱男低一个全音符、
  // 男高两个二分（Holy, Holy, Holy m8），并回第一声部就接在男高后面，这小节成了八拍。
  //
  // **豁免：标准的上下两声部写法**——下面那一层真声部有符干的**全朝下**、这个长音又在它们**上方**
  // （宣主荣耀钢琴右手 m2：上声部 A4 全音符，下声部「休止 F E D」符干朝下）。那是真的上声部，
  // 并回第一声部就成了「全音符 + 四拍」八拍的一个声部。位图路误检的假全音符很少恰好碰上这个组合。
  const upperOfTwo = (grp: StaffChord[]): boolean => {
    const ch = grp[0];
    const others = layers.filter((g) => g !== grp).flat().filter((c) => c.stem && !c.notes[0].rest);
    return others.length > 0 && others.every((c) => !c.notes[0].stemUp && c.top > ch.top);
  };
  const solo = (grp: StaffChord[]) => grp.length === 1 && Math.abs(grp[0].dur - expect) < EPS && !upperOfTwo(grp);
  const firstReal = layers.findIndex((grp) => !solo(grp));
  const real = firstReal < 0 ? [] : layers.filter((grp, i) => i >= firstReal || !solo(grp));
  const merged = real.length && real.length < layers.length ? real : layers;
  const extra = merged === layers ? [] : layers.filter((grp) => !real.includes(grp));
  merged.forEach((grp, i) => {
    for (const ch of grp) {
      ch.voice = i + 1;
      for (const n of ch.notes) n.voice = i + 1;
    }
  });
  // 剔出来的孤层排到真声部**后面**，不并回第一声部：并回去它就接在真旋律前头，这小节成了两倍长
  //（爱是从神而来 p3 m37 钢琴右手：G4 全音符比下声部第一个八分靠左半格、排在了前面，并回去成了「全音符 + 八个八分」）。
  // 假全音符照样挤不掉真旋律，只多出一个声部。
  // 全音符在小节开头起音：头不在真声部第一个音左右一个头宽以内的（落在小节中段，多是符尾、弧认成的假全音符，新编 009 m1 F4），
  // 照旧并回第一声部——排到后面歌词就跟着错挂一串
  const start = Math.min(...merged.flat().map((c) => c.left));
  const atStart = (ch: StaffChord) => ch.left <= start + (ch.right - ch.left) * 1.2;
  let last = merged.length;
  for (const grp of extra) {
    const v = grp.every(atStart) ? ++last : 1;
    for (const ch of grp) {
      ch.voice = v;
      for (const n of ch.notes) n.voice = v;
    }
  }
}

/**
 * `splitVoice` 的**兜底版**：`checkFull` 两趟都没凑满时，按**符干方向**分声部。
 *
 * `checkFull` 凑不满就没有 offset，贪心分层无从谈起；但 SATB 把女高女低挤在一行时，
 * 刻谱的通行约定是**上声部符干朝上、下声部朝下**，据此还能救回一部分。
 *
 * 拆完要验一遍——**两个声部都要正好凑满拍号**才认这次拆分。
 * 只要求一个凑满的话，另一个多半是被硬切出来的，与 GT 逐音比对反而变差
 * （实测音符准确率 93.42% → 93.21%）；无条件按符干方向拆更糟，
 * 普通旋律一小节里本来就上下都有符干，实测全书小节自检从 80.1% 掉到 73.4%。
 */
function assignVoicesInBar(inBar: StaffNote[], expect: number, borrowed = false): void {
  const arr = inBar.filter((n) => !n.chordExtra && !n.grace);
  if (arr.length < 4) return;
  const sumOf = (a: StaffNote[]) => a.reduce((x, n) => x + (n.sym.code === "restHBar" ? expect : n.duration), 0);
  if (sumOf(arr) <= expect + 1e-6) return; // 单声部凑得下，不拆
  const up = arr.filter((n) => n.stemUp === true);
  const down = arr.filter((n) => n.stemUp === false);
  // **让位到谱表外的休止是「这一行有两个声部」的明证**：休止抬到第五线上方的，上声部 = 干朝上的 + 抬高的休止，
  // 正好凑满拍号就拆；这小节有跨谱表的音（`crossStaff`）时下声部不必凑满——它前半截写在相邻谱行上（跨谱表的分解和弦，是爱 p4 右手：
  // 上声部「附点二分 + 抬高的四分休止」，下声部四个八分，前面两拍在低音谱表）。压到第一线下方的对称处理。
  {
    const lys = arr[0].staff.lineYs;
    const mid = (n: StaffNote) => (n.sym.box.top + n.sym.box.bottom) / 2;
    const rests = arr.filter((n) => n.rest && n.sym.code !== "restHBar");
    for (const side of lys.length >= 2 ? (["up", "down"] as const) : []) {
      const off = rests.filter((n) => (side === "up" ? mid(n) < lys[0] : mid(n) > lys[lys.length - 1]));
      if (!off.length || off.length !== rests.length) continue;
      const own = side === "up" ? up : down;
      const other = side === "up" ? down : up;
      if (!own.length || other.length < 2) continue;
      if (Math.abs(sumOf(own) + sumOf(off) - expect) >= 1e-6 || sumOf(other) > expect + 1e-6) continue;
      // 另一个声部不满，只在这小节确有借相邻谱行写的音时才认（闭合谱里缺的是漏认的音，硬拆反而更差：贺他为王歌 95.69 → 94.12）
      if (!borrowed && Math.abs(sumOf(other) - expect) >= 1e-6) continue;
      // 无干的全音符之类归属不明，有就不拆
      if (arr.length !== own.length + other.length + off.length) continue;
      for (const n of side === "up" ? other : [...own, ...off]) {
        n.voice = 2;
        if (n.group) n.group.voice = 2;
      }
      return;
    }
  }
  // **两个声部共用一个休止**（君王将临 m26 女高女低：上「附点二分」、下「二分 + 四分」，第四拍一个四分休止写在谱表中间两声部共用）：
  // 两边各加上休止正好一小节、且有上下干的头落在同一列（两个声部同时起音；二度相邻的两个头左右错开一个头宽）才拆，
  // 休止归上声部；下声部提前收尾，MusicXML 里不算错
  {
    const rests = arr.filter((n) => n.rest && n.sym.code !== "restHBar");
    const sp = arr[0].staff.stepDistance() * 2;
    if (rests.length && up.length && down.length && arr.length === up.length + down.length + rests.length
      && Math.abs(sumOf(up) + sumOf(rests) - expect) < 1e-6 && Math.abs(sumOf(down) + sumOf(rests) - expect) < 1e-6
      && up.some((u) => down.some((d) => Math.abs(u.x - d.x) < sp * 2))) {
      for (const n of down) {
        n.voice = 2;
        if (n.group) n.group.voice = 2;
      }
      return;
    }
  }
  if (up.length < 2 || down.length < 2) return;
  // 休止没让位到谱表外、贴着外线写的（望十架 p5 m39 低音：上声部「八分休止 + 三个八分」两遍，下声部两个二分，休止心离第五线 2px）：
  // 休止全归一侧、两个声部正好都凑满才拆
  {
    const rests = arr.filter((n) => n.rest && n.sym.code !== "restHBar");
    if (rests.length && arr.length === up.length + down.length + rests.length && Math.abs(sumOf(up) + sumOf(down) + sumOf(rests) - 2 * expect) < 1e-6) {
      const side = Math.abs(sumOf(up) + sumOf(rests) - expect) < 1e-6 && Math.abs(sumOf(down) - expect) < 1e-6 ? "up" : Math.abs(sumOf(down) + sumOf(rests) - expect) < 1e-6 && Math.abs(sumOf(up) - expect) < 1e-6 ? "down" : null;
      if (side) {
        for (const n of side === "up" ? down : [...down, ...rests]) {
          n.voice = 2;
          if (n.group) n.group.voice = 2;
        }
        return;
      }
    }
  }
  if (Math.abs(sumOf(up) - expect) >= 1e-6 || Math.abs(sumOf(down) - expect) >= 1e-6) return;
  for (const n of down) {
    n.voice = 2;
    if (n.group) n.group.voice = 2;
  }
}

/** 五度圈上升降号出现的次序（全音阶序号，C=0 D=1 E=2 F=3 G=4 A=5 B=6）：
 *  升号 F♯ C♯ G♯ D♯ A♯ E♯ B♯、降号 B♭ E♭ A♭ D♭ G♭ C♭。照 musicpp 的 `circle[]`。 */
const CIRCLE = [3, 0, 4, 1, 5, 2, 6];

/**
 * `Bar::calcAlter`：算出每个音**发声**的升降。
 *
 * 三层叠加，缺一不可：
 *   1. **调号**——升降号作用于所有八度的那个音名，整首有效；
 *   2. **小节内延续**——印在某个音左边的临时记号，对**同一小节、同一八度**的后续同名音继续有效；
 *   3. 本位号把前两层都抹掉（记 0）。
 *
 * 不算这一层的话，凡是带升降号的调，导出的 `<pitch>` 就是错的
 * （`<alter>` 缺了调号那一份）。
 */
export function calcAlters(pg: SPage, ctx: Map<Staff, StaffContext>, notes: StaffNote[]): void {
  // 谱行的调号：本行没印的沿用上一行（`analyzeBarData` 的 prev 逻辑）
  // 行中转调的，按位置取（`fifthsAt`）；下一行没印调号的，接着用这一行最后那个
  let fifths = 0;
  const fifthsOf = new Map<Staff, number>();
  for (const st of pg.staves) {
    fifthsOf.set(st, fifths);
    fifths = fifthsAt(ctx.get(st), Infinity, fifths);
  }
  // 按 (谱行, 小节) 分组，组内按 x
  const byBar = new Map<string, StaffNote[]>();
  for (const n of notes) {
    if (n.rest || n.unpitched) continue;
    const st = n.staff;
    const bi = st.bars.findIndex((b) => n.x >= b.left && n.x < b.right);
    const key = `${st.index}#${bi}`;
    const a = byBar.get(key) ?? [];
    a.push(n);
    byBar.set(key, a);
  }
  for (const [key, arr] of byBar) {
    const st = arr[0].staff;
    const kf = fifthsAt(ctx.get(st), Math.min(...arr.map((n) => n.x)), fifthsOf.get(st) ?? 0);
    const stat = new Map<number, number>();
    // 调号：作用于所有八度
    for (let i = 0; i < kf; i++) for (let oct = 0; oct < 12; oct++) stat.set(oct * 7 + CIRCLE[i], 1);
    for (let i = kf; i < 0; i++) for (let oct = 0; oct < 12; oct++) stat.set(oct * 7 + CIRCLE[7 + i], -1);
    arr.sort((a, b) => a.x - b.x);
    for (const n of arr) {
      if (n.accidental !== null) stat.set(n.diatonic, n.accidental);
      n.alter = stat.get(n.diatonic) ?? 0;
    }
    void key;
  }
}


// ── 小节自检 ────────────────────────────────────────────────────────────────

/** 一个小节的时值核对结果。 */
export interface BarCheck {
  staff: Staff;
  /** 小节在本行谱里的序号。 */
  index: number;
  /** 小节里音符时值之和（全音符为 1）。和弦附音不重复计。 */
  sum: number;
  /** 拍号要求的时值。 */
  expect: number;
  /** 音符数（含休止）。 */
  count: number;
  full: boolean;
  /** 一拍的时值（`1 / beatType`）。 */
  beat: number;
  /** 结构上的半截小节（弱起、乐句中间被小节线劈开的两半），见 `markSplitBars`。 */
  split?: boolean;
}

/**
 * **结构上的半截小节**：诗歌本在乐句末用小节线把一个小节劈成两半（前半句收尾、后半句弱起；
 * 万口欢唱 3/2 拍 m5 一拍半 + m6 半拍，GT 记 `implicit="yes"`），曲首还有弱起小节。
 * 它们谱面上就不满拍，识别没错，自检却一律记成「不满」——独唱谱没满拍的小节里七成是这一类。
 * 按「系统行数 + 第几行」把各页的小节接成序列，不满、整拍数的小节满足任一条就标 `split`：
 * 在曲首；与前或后一个同样的半截小节合起来正好一整小节；在曲末、与曲首的弱起合起来正好一小节；
 * 挨着段落界（右端双纵线/反复线，或紧跟在它后面）。
 * 上一行行末、这一行行首两个小节都不满的，是被系统换行劈开的一个小节，后半截记 `Bar.splitTail`。
 * 首页首系统的第一小节不满（整拍）的是曲首弱起，记 `Bar.pickup`（只认首系统：序列按系统行数分，别的行数的序列头在曲中）。
 */
export function markSplitBars(pages: { page: SPage; bars: BarCheck[] }[]): void {
  const seqs = new Map<string, BarCheck[]>();
  for (const { page, bars } of pages)
    for (const sys of page.systems)
      sys.staves.forEach((stf, k) => {
        const key = `${sys.staves.length}:${k}`;
        const own = bars.filter((b) => b.staff === stf).sort((a, b) => a.index - b.index);
        seqs.set(key, [...(seqs.get(key) ?? []), ...own]);
      });
  const eps = 1e-6;
  const part = (b: BarCheck | undefined) =>
    !!b && !b.full && b.sum > eps && b.sum < b.expect - eps && Math.abs(b.sum / b.beat - Math.round(b.sum / b.beat)) < eps;
  const pair = (a: BarCheck, b: BarCheck) => Math.abs(a.expect - b.expect) < eps && Math.abs(a.sum + b.sum - a.expect) < eps;
  // 被系统换行劈开的小节：上一行行末、这一行行首两个小节都不满。后半截记下来，写出端标 `implicit`（与 GT 一样算一个小节）。
  // 不要求整拍、不要求正好凑满一小节：行首常是半拍的弱起（232 主也爱我歌），认漏、认错一个音两半也就凑不上了（243 惟独耶稣歌）
  const short = (x: BarCheck) => x.sum > eps && x.sum < x.expect - eps && !x.full;
  for (const seq of seqs.values())
    seq.forEach((b, i) => {
      const prev = seq[i - 1];
      const next = seq[i + 1];
      // 段落界：右端是双纵线/反复线（段尾不满，万口欢唱 m9 一拍、副歌从下一小节强拍起），或紧跟在它后面（段首弱起）
      const bar = b.staff.bars[b.index];
      const before = b.staff.bars[b.index - 1];
      const sectionEnd = (x: typeof bar | undefined) => !!x && (x.rightRepeat || (!!x.rightStyle && x.rightStyle !== "regular"));
      const edge = sectionEnd(bar) || sectionEnd(before) || !!bar?.leftRepeat;
      // 行末那条线的样式不作数：行末的普通小节线常被读成终止线（378 近乎上帝之心歌），GT 真在那里有线的照样配得上
      if (bar && b.index === 0 && !edge && prev && prev.staff !== b.staff && prev.index === prev.staff.bars.length - 1 && short(prev) && short(b))
        bar.splitTail = true;
      if (!part(b)) return;
      if (bar && b.index === 0 && pages[0]?.page.systems[0]?.staves.includes(b.staff)) bar.pickup = true;
      if (i === 0 || edge || (part(prev) && pair(prev, b)) || (part(next) && pair(b, next)) || (i === seq.length - 1 && part(seq[0]) && pair(seq[0], b))) b.split = true;
    });
}

/**
 * `Bar::checkFull` + `Bar::splitVoice`：逐小节把和弦凑成拍子、分出声部，顺带出自检。
 *
 * 调用顺序照原文 `Score::analyzeBarData` :1474-1483：
 * `initChords`（已在 `buildNotes` 里做）→ `checkFull(false)` → 失败再 `checkFull(true)`
 * → 成功才 `splitVoice`。两趟都失败的小节退回按**符干方向**分声部那一版（`assignVoices`）。
 *
 * 放在这一步而不是 `buildNotes` 里，是因为三连音（`findTuplets`）在 `buildNotes`
 * **之后**才按比例改时值——早算的 offset 会是错的。这里也才拿得到跨页继承的拍号。
 *
 * 自检本身是**不靠 GT 的**：对不上就说明这一小节里有音符读错了（时值、漏音、多音）。
 * 全书都能用，不限于对上 GT 的那 98 首。
 *
 * 三处天然对不上、不算错：整小节休止（`restHBar` 按拍号算满）、
 * **弱起**（第一小节不足拍）、跨行断开的小节。
 */
export function checkBars(
  pg: SPage,
  ctx: Map<Staff, StaffContext>,
  notes: StaffNote[],
  /** 上一页最后的拍号（跨页继承；续页上不再印拍号）。 */
  carry?: { beats: number; beatType: number },
): BarCheck[] {
  const out: BarCheck[] = [];
  const pending: { o: BarCheck; chords: StaffChord[]; inBar: StaffNote[]; overfull: (len: number) => boolean }[] = [];
  const sp = pg.normalStaffSpace || pg.space;
  let cur = { beats: carry?.beats ?? 4, beatType: carry?.beatType ?? 4 };
  /** 凑满了的小节里定了拍位的和弦（`谱行#小节`），给同系统凑不满的谱行对拍位 */
  const timedChords = new Map<string, StaffChord[]>();
  /** 同系统别的谱行第 `i` 小节定了拍位的和弦 → 一个和弦的起点：与哪个横向对齐（中心差 < 0.6 线距）就取它的起点；
   *  `loose` 时都不对齐的取左边最近那个的终点（宁静的伯利恒钢琴 m10 右手的二分和弦接在左手升上来的那个八分后面） */
  const anchorsFor = (stf: Staff, i: number, loose = false): ((c: StaffChord) => number | undefined) | undefined => {
    const sys = pg.systems.find((sy) => sy.staves.includes(stf));
    const ref = (sys?.staves ?? []).filter((s0) => s0 !== stf).flatMap((s0) => timedChords.get(`${s0.index}#${i}`) ?? []);
    if (!ref.length) return undefined;
    const cx = (c: StaffChord) => (c.left + c.right) / 2;
    return (c) => {
      let best: StaffChord | undefined;
      let left: StaffChord | undefined;
      for (const r of ref) {
        if (Math.abs(cx(r) - cx(c)) < sp * 0.6 && (!best || Math.abs(cx(r) - cx(c)) < Math.abs(cx(best) - cx(c)))) best = r;
        if (r.right < c.left && (!left || r.right > left.right)) left = r;
      }
      return best ? best.offset : loose && left ? left.offset + left.dur : undefined;
    };
  };
  /** 这一小节有跨谱表借写的音（借出去或借进来）：是大谱表的一手，另一手的拍位才可信。 */
  const crossLinked = (stf: Staff, i: number): boolean => {
    const bar = stf.bars[i];
    return !!bar && notes.some((n) => (n.crossTo === stf || (n.staff === stf && n.crossTo)) && n.x >= bar.left && n.x < bar.right);
  };
  for (const stf of pg.staves) {
    // **逐小节**取当时生效的拍号：一行谱上可能变拍好几次
    // （实测 Opus 那本 p663 的第三行里 4/4 → 2/4 → 4/4，按整行取最左那处会全错）
    const changes = timeSignatures(ctx.get(stf)?.time ?? [], sp);
    let ci = 0;
    stf.bars.forEach((bar, i) => {
      while (ci < changes.length && changes[ci].x < bar.right) {
        cur = { beats: changes[ci].beats, beatType: changes[ci].beatType };
        ci++;
      }
      const expect = cur.beats / cur.beatType;
      // 别的行借这一行写的音（`crossTo`）算进来：宁静的伯利恒钢琴左手琶音后半截升进右手谱表，只剔出右手、不进左手的话左手只剩半小节
      const inBar = notes.filter((n) => (n.crossTo ? n.crossTo === stf : n.staff === stf && !n.crossStaff) && n.x >= bar.left && n.x < bar.right);
      if (!inBar.length) return;
      // 这一小节里的和弦（`initChords` 已归好，去重即可）
      const chords: StaffChord[] = [];
      const seen = new Set<StaffChord>();
      for (const n of inBar) {
        const g = n.group;
        if (!g || seen.has(g)) continue;
        seen.add(g);
        chords.push(g);
      }
      let full = checkFull(chords, expect, sp, false);
      if (!full) full = checkFull(chords, expect, sp, true);
      if (!full) full = blackenMixed(chords, expect, sp);
      if (!full) full = unHollowish(chords, expect, sp);
      if (!full) full = widenCrossHeads(chords, expect, sp);
      if (!full && chords[0]?.vector) full = extendHalfHook(chords, expect, sp);
      // 同系统已凑满的谱行（钢琴右手之于左手）给拍位，再凑一次（见 `checkFull` 的 `byAnchor`）
      if (!full) {
        const anchorOf = anchorsFor(stf, i);
        if (anchorOf) full = checkFull(chords, expect, sp, false, anchorOf);
      }
      // **短小节按同系统上面那行的长度再凑一次**：与弱起配套的末小节只有三拍，
      // 两个声部挤在一行、节奏各走各的（《赞美一神》男高「四分 + 两个八分」、
      // 男低「两个八分 + 四分」），拿拍号的四拍去凑，两趟都凑不满、也拆不开声部，
      // 八个音排成一串。上面那行（女高女低共干、单声部）的和正好是这一小节的真长度。
      const sib = pg.systems.find((sy) => sy.staves.includes(stf))?.staves.filter((s0) => s0 !== stf) ?? [];
      // 那个长度还得像个小节：至少半小节、整拍（上面那行认漏了音时和只剩一两个八分）
      const beat = 1 / cur.beatType;
      const short = out.find(
        (o) => sib.includes(o.staff) && o.index === i && o.sum >= expect * 0.5 && o.sum < expect - 1e-6 && Math.abs(o.sum / beat - Math.round(o.sum / beat)) < 1e-6,
      )?.sum;
      // 只救**真挤着两个声部**的：本小节时值和超过那个长度三成以上。单声部的短小节不用拆，
      // 拿它去凑只会把原来按次序写的小节改成按拍位写（宁静一首十来处，音符反掉）
      const overfull = (len: number) => inBar.filter((n) => !n.chordExtra && !n.grace).reduce((a, n) => a + n.duration, 0) > len * 1.3;
      let split = false;
      if (full) unifyMixed(chords);
      if (full) splitVoice(chords, expect);
      else if (short !== undefined && overfull(short) && (checkFull(chords, short, sp, false) || checkFull(chords, short, sp, true))) (split = true), splitVoice(chords, short);
      else assignVoicesInBar(inBar, expect, notes.some((n) => n.staff === stf && n.crossStaff && n.x >= bar.left && n.x < bar.right));
      const sum = voiceSum(inBar, expect);
      // 分完声部第一声部正好一整小节的也算满（`checkFull` 两趟没凑上、按次序分出来却是满的：我一生要赞美你 m1-4）
      const o: BarCheck = { staff: stf, index: i, sum, expect, count: inBar.length, full: full || Math.abs(sum - expect) < 1e-6, beat };
      if (full) timedChords.set(`${stf.index}#${i}`, chords.filter((c) => c.timed && !c.grace));
      out.push(o);
      if (!full && !split) pending.push({ o, chords, inBar, overfull });
    });
  }
  // **借写的两行合起来凑**：左手琶音升进右手谱表的小节，两行常常各自都凑不满——左手四个八分（后两个写在上面）只到两拍、
  // 右手一个二分从第三拍起（宁静的伯利恒 m11）。两行的和弦合在一起按 x 分时间列正好一小节，拍位就有了，再各自分声部
  for (const a of [...pending]) {
    if (!pending.includes(a)) continue;
    const partner = a.inBar.find((n) => n.crossTo === a.o.staff)?.staff;
    const b = partner && pending.find((q) => q.o.staff === partner && q.o.index === a.o.index);
    if (!b || Math.abs(b.o.expect - a.o.expect) > 1e-6) continue;
    const joint = [...a.chords, ...b.chords.filter((c) => !a.chords.includes(c))];
    if (!checkFull(joint, a.o.expect, sp, false)) continue;
    for (const q of [a, b]) {
      splitVoice(q.chords, q.o.expect);
      q.o.sum = voiceSum(q.inBar, q.o.expect);
      q.o.full = true;
      timedChords.set(`${q.o.staff.index}#${q.o.index}`, q.chords.filter((c) => c.timed && !c.grace));
    }
    pending.splice(pending.indexOf(a), 1);
    pending.splice(pending.indexOf(b), 1);
  }
  // **按同系统别的谱行的拍位补凑**：上面逐行走的时候，下面的谱行还没定拍位（钢琴右手在左手之上，
  // 宁静的伯利恒右手的和弦要等左手连同升上来的琶音凑满了才知道从第几拍起）。凑满的从 `pending` 里摘掉
  for (let k = pending.length - 1; k >= 0; k--) {
    const { o, chords, inBar } = pending[k];
    // 只给有跨谱表借写的小节：合唱谱单行声部在扫描件上认错了音，拿别的行的拍位能把错的读法「凑满」（破碎扫描 m61、m80）
    if (!crossLinked(o.staff, o.index)) continue;
    const anchorOf = anchorsFor(o.staff, o.index, true);
    if (!anchorOf || !checkFull(chords, o.expect, sp, false, anchorOf, true)) continue;
    splitVoice(chords, o.expect);
    o.sum = voiceSum(inBar, o.expect);
    o.full = true;
    timedChords.set(`${o.staff.index}#${o.index}`, chords.filter((c) => c.timed && !c.grace));
    pending.splice(k, 1);
  }
  // **被系统换行劈开的两半合起来正好一小节**：上面凑不满、也没按同系统那行的长度拆开的行末（行首）小节，下一系统同一行的第一小节
  //（上一系统同一行的最后一小节）也不满、整拍，这一半的长度就是拍号减去那一半——按它再凑一次（齐来谢主歌 m4 三拍挤着两个声部、行末劈开，
  // 下一行行首是一拍）。只对这一对试：按比拍号短的整拍数挨个试凑，别的不满小节也被按短长度拆了声部（独唱谱音符 −0.54）；
  // 同一行里的前后小节也算邻的话，曲首弱起与认错了的下一小节配上，按错的长度拆（晨曦破晓 87.2 → 68.8）
  for (const { o, chords, inBar, overfull } of pending) {
    const eps = 1e-6;
    const part = (b?: BarCheck) => !!b && !b.full && b.sum > eps && b.sum < b.expect - eps && Math.abs(b.sum / b.beat - Math.round(b.sum / b.beat)) < eps;
    // 被系统换行劈开的：行末这一小节与下一系统同一行的第一小节、行首这一小节与上一系统同一行的最后一小节也算邻
    const si = pg.systems.findIndex((sy) => sy.staves.includes(o.staff));
    const k = si >= 0 ? pg.systems[si].staves.indexOf(o.staff) : -1;
    const across = (d: 1 | -1) => {
      const sy = pg.systems[si + d];
      if (k < 0 || !sy || sy.staves.length !== pg.systems[si].staves.length) return undefined;
      const st = sy.staves[k];
      return d > 0 ? out.find((q) => q.staff === st && q.index === 0) : out.filter((q) => q.staff === st).sort((a, b) => b.index - a.index)[0];
    };
    const prev = o.index === 0 ? across(-1) : undefined;
    const next = o.index === o.staff.bars.length - 1 ? across(1) : undefined;
    for (const nb of [prev, next]) {
      if (!part(nb) || Math.abs(nb!.expect - o.expect) > eps) continue;
      const len = o.expect - nb!.sum;
      // 挤着两个声部：小节里的音首尾相接要超过一整小节（拍号认错时整页小节都「不满」，晨曦破晓认成 9/4，按错的长度拆，87.2 → 68.8）
      if (len < o.beat - eps || !overfull(len) || !overfull(o.expect / 1.3) || !(checkFull(chords, len, sp, false) || checkFull(chords, len, sp, true))) continue;
      splitVoice(chords, len);
      o.sum = voiceSum(inBar, o.expect);
      break;
    }
  }
  return out;
}

/** 第一声部的时值和（整小节休止按拍号算满）。 */
function voiceSum(inBar: StaffNote[], expect: number): number {
  const heads = inBar.filter((n) => !n.chordExtra && !n.grace);
  return heads.filter((n) => n.voice === (heads[0]?.voice ?? 1)).reduce((a, n) => a + (n.sym.code === "restHBar" ? expect : n.duration), 0);
}

/**
 * **凑不满的小节里，一半空心一半实心的和弦整枚改成实心**：一根干上的头只能同一种，扫描件的实心头印出白斑被认成空心
 *（望十架 p3 m31-32 四分和弦有的半枚读成二分）。改完再凑一次拍子。
 * 只改「半空半实」的那几枚：试过把小节里全部有干的二分和弦都改，别处漏了音的小节碰巧凑满、真二分被改坏（望十架 p4 m38、p5 m39）；
 * 也试过改完凑不满就退回，反倒少救了几处（凑不满的小节多半还漏着别的音，和弦本身改对了照样省步数：合唱谱扫描档 79.28 → 79.33%）。
 */
function blackenMixed(chords: StaffChord[], expect: number, sp: number): boolean {
  let hit = false;
  for (const c of chords) {
    if (!c.stem || c.grace || !c.notes.every((n) => !n.rest && n.beams === 0)) continue;
    if (!c.notes.some((n) => n.base === 1 / 4) || !c.notes.some((n) => n.base === 1 / 2)) continue;
    // 干朝向不一的是两个声部碰巧干连成一条线（上声部实心头干朝上在右缘、下声部空心头干朝下在左缘），不是一根干上的和弦
    //（以马内利来临歌 m3/m14/m19 女低 G4 附点二分被改成附点四分）
    if (new Set(c.notes.map((n) => n.stemUp)).size > 1) continue;
    for (const n of c.notes)
      if (n.base === 1 / 2) {
        n.base = 1 / 4;
        n.duration = n.base * (2 - 1 / 2 ** n.dots);
      }
    hit = true;
  }
  return hit && (checkFull(chords, expect, sp, false) || checkFull(chords, expect, sp, true));
}

/**
 * **凑满了的小节里，一半空心一半实心的和弦按凑拍用的时值统一成四分**：和弦按首个音的时值凑拍（`guessDur`），
 * 首个音是四分、凑满了，就说明四分对，同一根干上读成二分的头跟着它（望十架 p3 m29 女高女低 C5/D4 四分，白斑打花的 C5 读成二分）。
 * 只往实心统一，与 `blackenMixed` 同向：首个音是二分时反过来把四分拉成二分，是爱 p4 m58、p5 m66 两处真四分被拉长。
 * 带附点的不动：两声部挤在一根干上（向主唱新歌 m2 上声部 D4 附点二分、下声部 B3 八分）。
 * 与 `blackenMixed` 同一批和弦：有干、无杠无尾、干朝向一致。
 */
function unifyMixed(chords: StaffChord[]): void {
  for (const c of chords) {
    if (!c.stem || c.grace || c.notes.length < 2 || !c.notes.every((n) => !n.rest && n.beams === 0 && !n.dots)) continue;
    if (c.notes[0].base !== 1 / 4 || !c.notes.some((n) => n.base === 1 / 2)) continue;
    if (new Set(c.notes.map((n) => n.stemUp)).size > 1) continue;
    for (const n of c.notes) if (n.base === 1 / 2) (n.base = 1 / 4), (n.duration = 1 / 4);
  }
}

/**
 * **凑不满的小节里，实心字形只因头心有白才按二分算的和弦逐枚改回四分**：位图路的 `hollowish` 是个弱判据，
 * 白斑打花的扫描页上真实心头的头心也有三四成白（望十架 p3 m31 女高女低 F5/F4 两枚都读成二分，这一小节多出一拍）。
 * 一枚一枚试，改完凑得满才留，凑不满就退回。
 */
function unHollowish(chords: StaffChord[], expect: number, sp: number): boolean {
  for (const c of chords) {
    if (!c.stem || c.grace) continue;
    const heads = c.notes.filter((n) => !n.rest);
    if (!heads.length || !heads.every((n) => n.sym.code === "noteheadBlack" && n.base === 1 / 2 && n.beams === 0)) continue;
    const set = (b: number) => heads.forEach((n) => ((n.base = b), (n.duration = b * (2 - 1 / 2 ** n.dots))));
    set(1 / 4);
    if (checkFull(chords, expect, sp, false) || checkFull(chords, expect, sp, true)) return true;
    set(1 / 2);
  }
  return false;
}

/**
 * **叉形符头不分空心实心**：Anastasia 的圈 X（吊镲）四分、二分是同一个字形，一律按四分读。
 * 凑不满时把没杠没尾的叉头逐枚改成二分再凑，凑不上就退回（八段锦钢片琴 m78「⊗ + 二分休止」）。
 */
function widenCrossHeads(chords: StaffChord[], expect: number, sp: number): boolean {
  for (const c of chords) {
    // 不要求认出干：圈 X 的干接在圈顶正中，挂干那一步按头缘找干接不上
    if (c.grace || !c.notes.every((n) => n.xHead && n.base === 1 / 4 && n.beams === 0)) continue;
    for (const n of c.notes) (n.base = 1 / 2), (n.duration = n.base * (2 - 1 / 2 ** n.dots));
    if (checkFull(chords, expect, sp, false)) return true;
    for (const n of c.notes) (n.base = 1 / 4), (n.duration = n.base * (2 - 1 / 2 ** n.dots));
  }
  return false;
}

/**
 * **副杠只印半截**：连杠组末尾两个十六分，第二道杠只从倒数第二根干朝右伸出一截钩、没盖到最后那根干
 *（八段锦二胡 / 笛子 / 高胡 m1、高胡 m76 末组 E F♯），最后那个音读成八分、整小节多出一个十六分。
 * 凑不满时把这种组尾的音补到钩那一层再凑，凑不上（按次序加也不是一整小节）就退回；留下的钩改成一道到组尾的杠（`begin` / `end`）。
 */
function extendHalfHook(chords: StaffChord[], expect: number, sp: number): boolean {
  const seq = chords.filter((c) => !c.grace && c.notes[0].beam).sort((a, b) => a.left - b.left);
  for (let i = 0; i + 1 < seq.length; i++) {
    const [a, b] = [seq[i], seq[i + 1]];
    const ba = a.notes[0].beam!;
    const bb = b.notes[0].beam!;
    const lv = ba.lastIndexOf("forward hook");
    if (lv < 1 || bb.length > lv || bb[0] !== "end" || (ba[0] !== "begin" && ba[0] !== "continue")) continue;
    const k = lv + 1 - bb.length;
    const saved = b.notes.map((n) => ({ n, base: n.base, beams: n.beams, beam: n.beam }));
    for (const n of b.notes) {
      n.base /= 2 ** k;
      n.duration = n.base * (2 - 1 / 2 ** n.dots);
      n.beams += k;
      n.beam = [...bb, ...Array<BeamState>(k).fill("end")];
    }
    // 凑不满拍位、但按次序加起来正好一小节的也留下（写出端按次序写）：二胡 m1 前面一个十六分与下一个八分横向挨着、被并成一列，拍位凑不上
    const full = checkFull(chords, expect, sp, false);
    if (full || Math.abs(chords.reduce((t, c) => t + (c.grace ? 0 : guessDur(c)), 0) - expect) < 1e-6) {
      for (const n of a.notes) if (n.beam) n.beam = n.beam.map((st, j) => (j === lv ? "begin" : st));
      return full;
    }
    for (const { n, base, beams, beam } of saved) Object.assign(n, { base, duration: base * (2 - 1 / 2 ** n.dots), beams, beam });
  }
  return false;
}

/** 这一页最后生效的拍号（给下一页当 `carry`）。 */
export function lastTimeSignature(
  pg: SPage,
  ctx: Map<Staff, StaffContext>,
  carry?: { beats: number; beatType: number },
): { beats: number; beatType: number } | undefined {
  let out = carry;
  for (const stf of pg.staves) {
    const all = timeSignatures(ctx.get(stf)?.time ?? [], pg.normalStaffSpace || pg.space);
    if (all.length) out = { beats: all[all.length - 1].beats, beatType: all[all.length - 1].beatType };
  }
  return out;
}

