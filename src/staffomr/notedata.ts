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
import { accidentalAlter, flagLevel, isAccidental, isClef, isRest, restDuration, timeSigDigit } from "./glyphs";
import { subPaths } from "./vecgeom";

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
  for (const it of pg.symbols) {
    if (isAccidental(it.code)) accids.push(it);
    else if (isClef(it.code)) clefs.push(it);
    else if (timeSigDigit(it.code) >= 0 || it.code === "timeSigCommon" || it.code === "timeSigCutCommon") times.push(it);
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
      if (c.box.right > acc.box.left) continue;
      if (acc.box.left - c.box.right > sp * 3) continue;
      if (!overlapY(c.box, acc.box)) continue;
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

/** 一行谱上的**全部**拍号，按 x 从左到右。曲中变拍时会有好几处。 */
export function timeSignatures(time: Sym[], sp?: number): { x: number; beats: number; beatType: number }[] {
  if (!time.length) return [];
  const out: { x: number; beats: number; beatType: number }[] = [];
  const marks = time.filter((s) => s.code === "timeSigCommon" || s.code === "timeSigCutCommon");
  for (const m of marks) {
    out.push(m.code === "timeSigCommon" ? { x: m.px, beats: 4, beatType: 4 } : { x: m.px, beats: 2, beatType: 2 });
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
  /** 第几层（1 = 离符头最近的那条 = 八分）。由 `calcBeamLevels` 填。 */
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
/** 伸出头外的干长下限（格），见 `buildStems` 里「一上一下两根干」那段。 */
const SHORT_STEM_OUT = 2;

export function buildStems(pg: SPage, sp: number): StemInfo[] {
  const heads = pg.symbols.filter((s) => s.hasTag("Note") && !isRest(s.code) && s.ownerStaff);
  const flagSyms = pg.symbols.filter((s) => s.hasTag("Tail"));
  const out: StemInfo[] = [];
  // 窗口与 `findStems` 打 Stem 标签同口径（两倍谱线粗）兜底：粗线扫描件上头盒右缘离自己的干 4.5~5 像素，
  // 1/4 格只有 4.7，干标上了 Stem、头却没挂上，落单的头被并进邻头的和弦（破碎扫描版 p6 十六分 A4）
  const win0 = (nt: Sym) => Math.max(sp / 4, (nt.ownerStaff?.lines[0]?.lw ?? 0) * 2);
  for (const seg of pg.segsWithTag("Stem")) {
    const notes: Sym[] = [];
    for (const nt of heads) {
      if (!overlapY(seg.box, nt.box)) continue;
      const dx0 = Math.abs(nt.box.left - seg.cx);
      const dx1 = Math.abs(nt.box.right - seg.cx);
      const win = win0(nt);
      if (dx0 > win && dx1 > win) continue;
      notes.push(nt);
    }
    if (!notes.length) continue;
    // `Stem::up`：符干伸到符头**上方**就是朝上
    const top = Math.min(...notes.map((n) => n.box.top));
    const bottom = Math.max(...notes.map((n) => n.box.bottom));
    const up = seg.top < top ? true : seg.bottom > bottom ? false : false;
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
  return out.filter((st) => st.notes.length);
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
    // 定层：按「离符头那一端有多远」从近到远排。
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
    grp.sort((a, b) => rel.get(b)! - rel.get(a)!);
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
  /** 符尾/符杠条数。 */
  beams: number;
  x: number;
  /** 挂在这个音符上的歌词，按段（verse）。 */
  lyrics?: { verse: number; text: string; hyphen: boolean; cont: boolean; /** 这个字后面拖着延长线（一字多音，见 `markLyricExtends`）。 */ extend?: boolean }[];
  /** 这些字的歌词延长线到这个音为止（`<extend type="stop"/>`）。记的是那个字本身，段号后来被重排也跟着走。 */
  lyricExtendStop?: { verse: number }[];
  /** 挂在这个音符上的和弦符号（归一后的原文，如 `Am`、`G/B`、`Dm7`）。 */
  chord?: string;
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
  /** 落在八度移位段里（音高已经移过了，这里只记一笔给 `<octave-shift>` 用）。 */
  octaveShift?: "up" | "down";
  /** 力度记号（`mp`/`f`…）。MusicXML 里出成 `<direction>`，排在这个音符之前。 */
  dynamic?: string;
  /** 印在这个音符处的文字指示（rit. / a tempo / cresc. / Fine…）：原文与在谱表上方还是下方。MusicXML 里出成 `<direction><words>`。 */
  words?: { text: string; above: boolean }[];
  /** 节拍器记号（`quarter=86`）。MusicXML 里出成 `<direction><metronome>`。 */
  metronome?: string;
  /** 松叶从这个音符**起**（`<wedge type="crescendo|diminuendo">`）。见 `attachWedges`。 */
  wedgeStart?: "crescendo" | "diminuendo";
  /** 松叶到这个音符**止**（`<wedge type="stop">`）。 */
  wedgeStop?: boolean;
  /** 连音（三连音之类）：`actual` 个音占 `normal` 个音的时值。 */
  tuplet?: { actual: number; normal: number };
  /**
   * **斜杠符头**（`noteheadSlash*`）：不是有音高的音符，而是「照这个节奏弹和弦」的记号。
   *
   * 这本书的前奏、间奏常常整行写斜杠 + 和弦名（实测 088/094/102 三首各有 16~19 个），
   * 它们全落在谱表第三线上，按符头算就成了一串 B4 四分音符——**全书「多出来的音符」
   * 里最大的一类就是它**。有音高的那些字段（`step`/`octave`/`diatonic`）对它没有意义，
   * MusicXML 那边出成 `<notehead>slash</notehead>`。
   */
  slash?: boolean;
  /** 所属和弦（`initChords` 填）。声部与小节内起点都记在和弦上，见 `StaffChord`。 */
  group?: StaffChord;
  /** 倚音：不占拍子，MusicXML 里出 `<grace/>` 且**不写 `<duration>`**。见 `checkFull` 的 `ignoreSmall`。 */
  grace?: boolean;
  /** 圆滑线/连音线的起讫（见 `slur.ts`）。一个音符可以同时是上一条的收尾与下一条的起头。 */
  slurStart?: boolean;
  slurStop?: boolean;
  /** 收尾的那条圆滑线起在哪行谱（跨谱表的弧，钢琴左手起、右手收）：写出时 `<slur number>` 两端要一致，按起端那行编。 */
  slurStopFrom?: Staff;
  tieStart?: boolean;
  tieStop?: boolean;
  /** 起头的那条圆滑线 / 连音线画成虚线（`<slur line-type="dashed">`）。 */
  slurDashed?: boolean;
  tieDashed?: boolean;
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
): StaffNote[] {
  const sp = pg.normalStaffSpace || pg.space;
  const stems = buildStems(pg, sp);
  stemsOut?.push(...stems);
  calcBeamLevels(beams, stems, sp, pg.symbols.filter((q) => q.code.startsWith("notehead")).map((q) => q.box));
  // 符头 → 它那根符干
  const stemOf = new Map<Sym, StemInfo>();
  for (const st of stems) for (const n of st.notes) if (!stemOf.has(n)) stemOf.set(n, st);

  const dots = pg.symbols.filter((s) => s.code === "augmentationDot" && !s.hasAnyTag());
  const out: StaffNote[] = [];

  for (const s of pg.symbols) {
    if (!s.hasTag("Note") || !s.ownerStaff) continue;
    const stf = s.ownerStaff;
    const rest = isRest(s.code);
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

    const stem = rest ? undefined : stemOf.get(s);
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
        base = mid - s.box.bottom > space * 0.5 ? 1 : 1 / 2;
      }
    } else if (s.code === "noteheadWhole" || s.code === "noteheadDoubleWhole") {
      base = s.code === "noteheadDoubleWhole" ? 2 : 1;
    } else if (s.code === "noteheadHalf") {
      base = stem ? 1 / 2 : 1;
    } else if (nb === 0 && s.code === "noteheadBlack" && hollowish?.(s)) {
      base = stem ? 1 / 2 : 1;
    } else {
      base = 1 / 4;
      for (let i = 0; i < nb; i++) base /= 2;
    }

    // 谱面上印出来的临时记号：贴在符头左边、同高度
    let accidental: number | null = null;
    for (const a of pg.symbols) {
      if (!a.hasTag("Accidental")) continue;
      if (!overlapY(a.box, s.box)) continue;
      if (a.px > s.box.left) continue;
      if (xSpace(a.box, s.box) > sp) continue;
      accidental = accidentalAlter(a.code);
      break;
    }

    out.push({ sym: s, staff: stf, rest, diatonic, step, octave, alter: 0, accidental, duration: base, base, dots: 0, stemUp, beams: nb, x: s.px, voice: 1, slash: s.code.startsWith("noteheadSlash") || undefined });
  }
  // **先按谱行、再按 x**。只按 x 排会把一页里几行谱的音符横向交织在一起
  // ——顺序一乱，与 GT 的逐音比对就全废（实测准确率卡在两成半）。
  out.sort((a, b) => a.staff.box.top - b.staff.box.top || a.x - b.x);
  attachDots(out, dots, sp);
  // 和弦归拢要在这里做（符干还在手里）；**声部与小节内起点留到 `checkBars`**——
  // 三连音（`findTuplets`）在 `buildNotes` 之后才改时值，早算的 offset 会是错的。
  initChords(out, stems, sp);
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
}

/** `Chord::guessDur(true, true)`：本仓的时值早在 `buildNotes` 里算好了，取主音的即可。 */
const guessDur = (ch: StaffChord): number => ch.notes[0].duration;

/** 这个音的符头有多大（相对线距）。`ignoreSmall` 判倚音用，代替原文的 `Note::fontSize()`。 */
const headSize = (n: StaffNote): number => n.sym.box.bottom - n.sym.box.top;

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
    n.dots = Math.max(n.dots, ref.dots);
    n.duration = n.base * (2 - 1 / 2 ** n.dots);
  }
}

function initChords(notes: StaffNote[], stems: StemInfo[], sp: number): StaffChord[] {
  const byNote = new Map<StaffNote, StaffChord>();
  const out: StaffChord[] = [];
  const bySym = new Map<Sym, StaffNote>();
  for (const n of notes) if (!bySym.has(n.sym)) bySym.set(n.sym, n);

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
      const n = bySym.get(sym);
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
  for (const n of orphan) {
    let best: StaffChord | null = null;
    let bd = Infinity;
    for (const ch of out) {
      if (ch.staff !== n.staff || !ch.stem) continue;
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
 */
function checkFull(chords: StaffChord[], expect: number, sp: number, ignoreSmall: boolean): boolean {
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
        if (sa && sb && Math.abs(sa.cx - sb.cx) < sp / 2) newGrp = false;
      }
    }
    if (newGrp) grps.push({ chords: [it], offset: 0 });
    else grps[grps.length - 1].chords.push(it);
  }
  if (!grps.length) {
    if (!measureRest.length && !full.length) return false;
    for (const ch of measureRest) ch.timed = true;
    for (const ch of full) ch.timed = true;
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
  if (!byMin() && !byEnds()) return false;
  for (const g of grps)
    for (const ch of g.chords) {
      ch.offset = g.offset;
      ch.dur = guessDur(ch);
      ch.timed = true;
    }
  for (const ch of measureRest) ch.timed = true;
  for (const ch of full) ch.timed = true;
  for (const ch of small) {
    ch.grace = true;
    for (const n of ch.notes) n.grace = true;
  }
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
  const solo = (grp: StaffChord[]) => grp.length === 1 && Math.abs(grp[0].dur - expect) < EPS;
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
  for (const grp of extra)
    for (const ch of grp) {
      ch.voice = 1;
      for (const n of ch.notes) n.voice = 1;
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
  if (up.length < 2 || down.length < 2) return;
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
    if (n.rest) continue;
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
  for (const seq of seqs.values())
    seq.forEach((b, i) => {
      if (!part(b)) return;
      const prev = seq[i - 1];
      const next = seq[i + 1];
      // 段落界：右端是双纵线/反复线（段尾不满，万口欢唱 m9 一拍、副歌从下一小节强拍起），或紧跟在它后面（段首弱起）
      const bar = b.staff.bars[b.index];
      const before = b.staff.bars[b.index - 1];
      const sectionEnd = (x: typeof bar | undefined) => !!x && (x.rightRepeat || (!!x.rightStyle && x.rightStyle !== "regular"));
      const edge = sectionEnd(bar) || sectionEnd(before) || !!bar?.leftRepeat;
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
  const sp = pg.normalStaffSpace || pg.space;
  let cur = { beats: carry?.beats ?? 4, beatType: carry?.beatType ?? 4 };
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
      const inBar = notes.filter((n) => n.staff === stf && !n.crossStaff && n.x >= bar.left && n.x < bar.right);
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
      if (full) splitVoice(chords, expect);
      else if (short !== undefined && overfull(short) && (checkFull(chords, short, sp, false) || checkFull(chords, short, sp, true))) splitVoice(chords, short);
      else assignVoicesInBar(inBar, expect, notes.some((n) => n.staff === stf && n.crossStaff && n.x >= bar.left && n.x < bar.right));
      const heads = inBar.filter((n) => !n.chordExtra && !n.grace);
      const sum = heads
        .filter((n) => n.voice === (heads[0]?.voice ?? 1))
        .reduce((a, n) => a + (n.sym.code === "restHBar" ? expect : n.duration), 0);
      // 分完声部第一声部正好一整小节的也算满（`checkFull` 两趟没凑上、按次序分出来却是满的：我一生要赞美你 m1-4）
      out.push({ staff: stf, index: i, sum, expect, count: inBar.length, full: full || Math.abs(sum - expect) < 1e-6, beat });
    });
  }
  return out;
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
    for (const n of c.notes)
      if (n.base === 1 / 2) {
        n.base = 1 / 4;
        n.duration = n.base * (2 - 1 / 2 ** n.dots);
      }
    hit = true;
  }
  return hit && (checkFull(chords, expect, sp, false) || checkFull(chords, expect, sp, true));
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
