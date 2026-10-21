import { calcAlters, checkBars, checkFull, clefFor, clefMiddleStep, lastTimeSignature, stepToPitch, type BarCheck, type StaffChord, type StaffContext, type StaffNote } from "../staffomr/notedata";
import type { SPage, Staff, Sym } from "../staffomr/model";

/**
 * 补漏音的探针：在本行 `x` 附近的原图上找一个漏认的休止（形状字典），没有就找实心（`hollow` 为假）或空心头；
 * 找到就交回一个打好 `Note` 标记、归了本行的符号（还没进页），休止的 `code` 按 `dur` 给。
 * `near` 是本行左右相邻那几个音的头心 y：补的头离它们最近的那个不出一个八度。
 * `yLim` 给了的话，头心只在这个开区间里找（同列已有另一声部的头时，补的头要在它上方或下方）。
 */
export type HeadSearch = (stf: Staff, x: number, hollow: boolean, dur: number, near: number[], yLim?: [number, number]) => Sym | null;

/** 回原图看这个音符头右边有没有一个点（补附点要有它，见 `alternatives`）。 */
export type DotProbe = (n: StaffNote) => boolean;

/**
 * **合唱谱按同系统各谱行的拍位互证改时值**。一个系统里各行同一拍落在同一个 x 上：自己凑满了、拍位又与别的行对得上的行是锚，
 * 它们给出的拍位排成**拍位槽**；凑不满的行（或凑满了却与锚对不上的——两处错互相抵掉）逐列配到槽上，
 * 每个和弦该响多久就由槽定了。只在易混的读法之间改（实心↔空心、符尾/符杠差一层、二分↔全音符、附点有无），
 * 改完要**两头都过**：自己凑满、而且各列的起点正好落在槽上，否则退回。
 *
 * 槽怎么聚：x 取和弦正常一侧符头的中心、减掉本行本小节左线；先按窄容差（`SLOT_NARROW`）全连接聚类——一个和弦列要与槽里
 * **每一个**成员都够近、同一行在一个槽里只能有一列；再把相邻两个行集不相交、两两都在宽容差（`SLOT_WIDE`）内的槽合起来
 *（二度和弦错开的头、带临时记号的头会把一列推开小半格）。
 *
 * 倚音不进槽、不当拍位，也不算满拍：`grace` 的、单音而头高不到本页中位数七成的（`checkFull` 的 `ignoreSmall` 同一尺子）先剔掉。
 *
 * 放在 `findTuplets` 之后：三连音按比例改完时值，凑拍才对得上。只改时值，起点与声部留给后面的 `checkBars` 重算。
 */
export function fixByCrossStaff(pg: SPage, ctx: Map<Staff, StaffContext>, notes: StaffNote[], carry: { beats: number; beatType: number } | undefined, sp: number, search?: HeadSearch, dotProbe?: DotProbe): void {
  if (!lastTimeSignature(pg, ctx, carry) || (globalThis as any).process?.env?.XAOFF) return;
  const dbg = !!(globalThis as any).process?.env?.XADBG;
  const checks = checkBars(pg, ctx, notes, carry);
  const heads = notes.filter((n) => !n.rest).map((n) => n.sym.box.bottom - n.sym.box.top).sort((a, b) => a - b);
  const midHead = heads[heads.length >> 1] ?? sp;
  // 补一个音：按槽的 x 回原图找头，造成音符与单音和弦（不进 `notes`，验过再收）
  const add = search
    ? (r: Row, s0: Slot, dur: number, up: boolean | null): StaffChord | null => {
        const kind = STD_DURS.find((q) => Math.abs(q.dur - dur) < 1e-6);
        if (!kind) return null;
        // 左右相邻的音（按 x 离槽最近的各一列）
        const ax = r.stf.bars[r.chk.index].left + s0.x;
        const heads = r.chords.flatMap((c) => c.notes).filter((n) => !n.rest);
        const left = heads.filter((n) => n.x < ax).sort((a, b) => b.x - a.x)[0];
        const right = heads.filter((n) => n.x > ax).sort((a, b) => a.x - b.x)[0];
        const near = [left, right].filter((n): n is StaffNote => !!n).map((n) => n.sym.py);
        // 同列已有另一声部的头：上声部漏了就在它们上方找、下声部漏了就在下方找（隔开小半格，不把已有的头再认一遍）
        const col = r.cols.find((c) => c.slot === s0);
        const ys = col ? col.chords.flatMap((c) => c.notes).filter((n) => !n.rest).map((n) => n.sym.py) : [];
        const yLim: [number, number] | undefined = !ys.length || up === null ? undefined : up ? [-Infinity, Math.min(...ys) - sp * 0.4] : [Math.max(...ys) + sp * 0.4, Infinity];
        if (ys.length && up === null) return null;
        const sym = search(r.stf, ax, kind.base >= 1 / 2, kind.base, near, yLim);
        if (!sym) return null;
        const rest = sym.code.startsWith("rest");
        if (kind.base === 1 && !rest) sym.code = "noteheadWhole";
        const cx = (sym.box.left + sym.box.right) / 2;
        const clef = clefFor(pg, ctx, r.stf, sym.box.left);
        const diatonic = rest ? -1 : (clef ? clefMiddleStep(clef.code) ?? 41 : 41) + r.stf.middleStep(sym.py, cx);
        const { step, octave } = rest ? { step: "", octave: 0 } : stepToPitch(diatonic);
        const n: StaffNote = { sym, staff: r.stf, rest, diatonic, step, octave, alter: 0, accidental: null, duration: dur, base: kind.base, dots: kind.dots, stemUp: rest ? null : up, beams: kind.base >= 1 / 4 ? 0 : Math.round(Math.log2(1 / (kind.base * 4))), x: sym.px, voice: 1 };
        const c: StaffChord = { staff: r.stf, notes: [n], stem: null, left: sym.box.left, right: sym.box.right, top: sym.box.top, offset: 0, dur, grace: false, timed: false, voice: 1 };
        n.group = c;
        return c;
      }
    : undefined;
  let added = false;
  const graceLike = (c: StaffChord) => c.grace || (c.notes.length === 1 && !c.notes[0].rest && c.notes[0].sym.box.bottom - c.notes[0].sym.box.top < midHead * 0.7);
  for (const sys of pg.systems) {
    const staves = sys.staves;
    if (staves.length < 2 || staves.some((s0) => s0.bars.length !== staves[0].bars.length)) continue;
    for (let i = 0; i < staves[0].bars.length; i++) {
      const rows = staves.map((stf) => rowOf(stf, i, checks, notes, sp, graceLike)).filter((r): r is Row => !!r);
      if (rows.length < 2) continue;
      const slots = buildSlots(rows, sp);
      const trusted = trustRows(rows, slots);
      if (dbg) debugBar(sys.staves[0].box.top, i, rows, slots, trusted, pg.index);
      for (const r of rows) {
        if (trusted.has(r) || r.skip) continue;
        let res = fixDurations(r, slots, trusted, sp, notes, add, pg, false, dotProbe);
        // 按两声部共用解不出时，有干的单个头只归它那个声部再试（同列另一声部漏了的才补得出来）
        if (!r.single && !/^(改|删|补 1 个)/.test(res)) res = fixDurations(r, slots, trusted, sp, notes, add, pg, true, dotProbe);
        if (res.startsWith("补")) added = true;
        if (dbg) console.error(`XA   行${staves.indexOf(r.stf)} ${res}`);
      }
    }
  }
  // 补进来的音按调号、小节内临时记号重算发声的升降
  if (added) calcAlters(pg, ctx, notes);
}

/** 补漏音补得出的时值（含附点）。 */
const STD_DURS = [1, 1 / 2, 1 / 4, 1 / 8, 1 / 16].flatMap((b) => [{ dur: b, base: b, dots: 0 }, { dur: b * 1.5, base: b, dots: 1 }]);

/** 窄槽容差（线距的倍数）：同一拍各行的和弦列横向差多少以内一定是同一拍。 */
const SLOT_NARROW = 0.6;
/** 宽槽容差：两个行集不相交的相邻窄槽，两两都在这么近以内的合成一个槽。 */
const SLOT_WIDE = 1.1;

interface Col {
  row: Row;
  chords: StaffChord[];
  /** 相对本行本小节左线的 x。 */
  x: number;
  /** 锚行的列起点（自己凑满了才有）。 */
  off?: number;
  slot?: Slot;
}
interface Row {
  stf: Staff;
  chk: BarCheck;
  chords: StaffChord[];
  cols: Col[];
  /** 自己凑满了、和弦都定了拍位（锚的候选）。 */
  full: boolean;
  /** 一列只一个和弦、有干的干朝向全一样：一个声部，每个和弦都响到下一列。 */
  single: boolean;
  /** 整小节休止、半截小节、借写的小节：不动。 */
  skip: boolean;
}
interface Slot {
  cols: Col[];
  x: number;
  off?: number;
}

function rowOf(stf: Staff, i: number, checks: BarCheck[], notes: StaffNote[], sp: number, graceLike: (c: StaffChord) => boolean): Row | undefined {
  const bar = stf.bars[i];
  const chk = checks.find((c) => c.staff === stf && c.index === i);
  if (!bar || !chk) return undefined;
  const inBar = notes.filter((n) => (n.crossTo ? n.crossTo === stf : n.staff === stf && !n.crossStaff) && n.x >= bar.left && n.x < bar.right);
  const crossed = notes.some((n) => (n.crossTo === stf || (n.staff === stf && n.crossTo)) && n.x >= bar.left && n.x < bar.right);
  const chords: StaffChord[] = [];
  for (const n of inBar) if (n.group && !chords.includes(n.group) && !graceLike(n.group)) chords.push(n.group);
  if (!chords.length) return undefined;
  chords.sort((a, b) => a.left - b.left);
  const whole = chords.some((c) => c.notes[0].sym.code === "restHBar");
  const row: Row = { stf, chk, chords, cols: [], full: chk.full && !chk.split && chords.every((c) => c.timed), single: false, skip: whole || !!chk.split || crossed };
  // 时间列：同 `checkFull`——与上一列首和弦横向不相交就开新列，两根干挨得不到半格仍算一列
  for (const c of chords) {
    const last = row.cols[row.cols.length - 1];
    const a = last?.chords[0];
    const sa = a?.stem?.seg;
    const sb = c.stem?.seg;
    if (a && (!(a.left > c.right || c.left > a.right) || (sa && sb && Math.abs(sa.cx - sb.cx) < sp / 2))) last.chords.push(c);
    else row.cols.push({ row, chords: [c], x: 0 });
  }
  for (const col of row.cols) {
    col.x = col.chords.reduce((s0, c) => s0 + headX(c), 0) / col.chords.length - bar.left;
    if (row.full) col.off = Math.min(...col.chords.map((c) => c.offset));
  }
  const dirs = new Set(chords.filter((c) => c.stem && !c.notes[0].rest).map((c) => c.notes[0].stemUp));
  row.single = row.cols.every((c) => c.chords.length === 1) && dirs.size <= 1;
  return row;
}

/** 和弦正常一侧那列符头的中心：干朝上的头在干左、朝下的在干右，二度错开到另一侧的那个不算。 */
function headX(c: StaffChord): number {
  const xs = c.notes.map((n) => (n.sym.box.left + n.sym.box.right) / 2);
  if (!c.stem) return xs.reduce((a, b) => a + b, 0) / xs.length;
  return c.stem.up ? Math.min(...xs) : Math.max(...xs);
}

function buildSlots(rows: Row[], sp: number): Slot[] {
  const cols = rows.flatMap((r) => r.cols).sort((a, b) => a.x - b.x);
  const slots: Slot[] = [];
  const near = (s0: Slot, c: Col, tol: number) => s0.cols.every((m) => m.row !== c.row && Math.abs(m.x - c.x) <= tol);
  for (const c of cols) {
    let best: Slot | undefined;
    let bd = Infinity;
    for (const s0 of slots) {
      if (!near(s0, c, sp * SLOT_NARROW)) continue;
      const d = Math.max(...s0.cols.map((m) => Math.abs(m.x - c.x)));
      if (d < bd) (bd = d), (best = s0);
    }
    if (best) best.cols.push(c);
    else slots.push({ cols: [c], x: c.x });
  }
  const meanX = (s0: Slot) => s0.cols.reduce((a, c) => a + c.x, 0) / s0.cols.length;
  slots.sort((a, b) => meanX(a) - meanX(b));
  for (let k = 0; k + 1 < slots.length; ) {
    const a = slots[k];
    const b = slots[k + 1];
    const disjoint = b.cols.every((c) => !a.cols.some((m) => m.row === c.row));
    const close = a.cols.every((m) => b.cols.every((c) => Math.abs(m.x - c.x) <= sp * SLOT_WIDE));
    const offA = a.cols.find((c) => c.off !== undefined)?.off;
    const offB = b.cols.find((c) => c.off !== undefined)?.off;
    const agree = offA === undefined || offB === undefined || Math.abs(offA - offB) < 1e-6;
    if (disjoint && close && agree) {
      a.cols.push(...b.cols);
      slots.splice(k + 1, 1);
    } else k++;
  }
  for (const s0 of slots) {
    s0.x = meanX(s0);
    for (const c of s0.cols) c.slot = s0;
  }
  return slots;
}

/**
 * **满拍互证**：自己凑满了的行之间在槽上比起点。三行以上按多数，与多数不一的行不可信；只有两行凑满、哪里对不上就两行都不可信。
 * 可信的行给槽定起点。
 */
function trustRows(rows: Row[], slots: Slot[]): Set<Row> {
  const full = rows.filter((r) => r.full && !r.skip);
  const bad = new Set<Row>();
  for (const s0 of slots) {
    const votes = s0.cols.filter((c) => full.includes(c.row) && c.off !== undefined);
    if (votes.length < 2) continue;
    const tally = new Map<number, Col[]>();
    for (const c of votes) {
      const key = Math.round(c.off! * 1e6);
      tally.set(key, [...(tally.get(key) ?? []), c]);
    }
    if (tally.size < 2) continue;
    const ranked = [...tally.values()].sort((a, b) => b.length - a.length);
    const win = ranked[0].length * 2 > votes.length ? ranked[0] : [];
    for (const c of votes) if (!win.includes(c)) bad.add(c.row);
  }
  // 槽的起点要随 x 单调：凑满了的行里列序与别的行颠倒的（配错槽），也不可信
  const trusted = new Set(full.filter((r) => !bad.has(r)));
  for (const s0 of slots) s0.off = s0.cols.find((c) => trusted.has(c.row))?.off;
  let last = -1;
  for (const s0 of slots) {
    if (s0.off === undefined) continue;
    if (s0.off <= last + 1e-6) {
      for (const s1 of slots) s1.off = undefined;
      trusted.clear();
      break;
    }
    last = s0.off;
  }
  return trusted;
}

/**
 * 易混的读法：`[base, dots]`。符杠上的音不改层数（杠的逐层状态跟着要改，留给符杠那一路）。
 * 附点只补不删、而且要原图上头右边真有个点（`dotProbe`）：不验点时补错的比补对的多（望十架 p7 m59、p9 m68 把八分读成附点八分去凑段长）。
 */
function alternatives(n: StaffNote, dotProbe?: DotProbe): [number, number][] {
  const b = n.base;
  const d = n.dots;
  const out: [number, number][] = [];
  if (n.rest || n.tuplet) return out;
  const beamed = !!n.beam?.length;
  // 实心改空心不做：凑不满的段落常是漏了音，把前一个四分拉成二分正好补上那段空拍（破碎扫描 p4 m49、p7 m81）
  if (b === 1 / 4 && n.sym.code === "noteheadBlack" && !beamed) out.push([1 / 8, d]);
  if (b === 1 / 8 && !beamed) out.push([1 / 4, d], [1 / 16, d]);
  if (b === 1 / 16 && !beamed) out.push([1 / 8, d]);
  // 有干的不会是全音符
  if (b === 1 / 2) out.push([1 / 4, d], ...(n.stemUp === null ? [[1, d] as [number, number]] : []));
  if (b === 1) out.push([1 / 2, d]);
  // 补附点：原图上头右边真有个点（认附点那一步嫌它不够圆、不够孤立没收）
  if (!d && b < 1 && dotProbe?.(n)) out.push([b, 1]);
  return out;
}

const durOf = (base: number, dots: number) => base * (2 - 1 / 2 ** dots);

function setDur(n: StaffNote, base: number, dots: number): void {
  n.base = base;
  n.dots = dots;
  n.duration = durOf(base, dots);
  if (!n.beam?.length) n.beams = base >= 1 / 4 ? 0 : Math.round(Math.log2(1 / (base * 4)));
}

/**
 * 按槽改一行的时值。一行拆成声部链（一个声部的行就一条；两个声部挤一行的，同一列两个和弦按干朝上/朝下分给上/下声部，
 * 一列只一个和弦的是两声部共用一根干，两条链都有它）。链上配上了定起点的槽的和弦是**同步点**（链头没配上按 0 算、小节末按拍号长度算），
 * 相邻两个同步点之间那一段时值和必须正好等于两点起点之差；配不上槽的和弦落在哪两个定了起点的槽之间，它的起点就得夹在那两个起点之间。
 * 一段对不上时在易混读法里找改一处（不行再两处）能对上、而且只有一种改法的。
 * 改完 `checkFull` 要凑满、配上槽的列起点正好是槽的起点，否则退回。返回一句给调试看的结论。
 */
function fixDurations(r: Row, slots: Slot[], trusted: Set<Row>, sp: number, notes: StaffNote[], add: ((r: Row, s0: Slot, dur: number, up: boolean | null) => StaffChord | null) | undefined, pg: SPage, soloHeads: boolean, dotProbe?: DotProbe): string {
  const EPS = 1e-6;
  const expect = r.chk.expect;
  const known = r.cols.map((c) => c.slot?.off);
  if (known[0] !== undefined && Math.abs(known[0]) > EPS) return `第一列不在 0（${known[0]}）`;
  for (let k = 1, last = -1; k < known.length; k++) {
    if (known[k] === undefined) continue;
    if (known[k]! <= last + EPS) return "两列落在同一槽起点";
    last = known[k]!;
  }
  if (!trusted.size) return "没有锚";
  const chains = voiceChains(r, soloHeads);
  if (typeof chains === "string") return chains;
  // 配不上槽的和弦：起点夹在左右最近两个定了起点的槽之间
  const anchored = slots.filter((s0) => s0.off !== undefined);
  const bound = (col: Col): [number, number] => {
    const lo = anchored.filter((s0) => s0.x < col.x).reduce((a, s0) => Math.max(a, s0.off!), -EPS);
    const hi = anchored.filter((s0) => s0.x > col.x).reduce((a, s0) => Math.min(a, s0.off!), expect + EPS);
    return [lo, hi];
  };
  const changes = new Map<StaffChord, [number, number]>();
  const drops = new Set<StaffChord>();
  /** 要补音的槽 → 补的时值与声部（两声部的行：上声部 `true`、下声部 `false`；两条链都缺、或一个声部的行为 `null`） */
  const inserts = new Map<Slot, { dur: number; up: boolean | null }>();
  // 删得的假头：没有干的实心/空心头（不是休止）、所在那列在别的行没有同拍的列（槽里只有它自己）
  const weak = (it: { c: StaffChord; k: number }) => !it.c.stem && !it.c.notes[0].rest && (r.cols[it.k].slot?.cols.length ?? 1) === 1 && r.cols[it.k].chords.length === 1;
  for (const [v, all] of chains.entries()) {
    // 上一条链删掉的假头（两声部共用的那一列）这条链也不要
    const chain = all.filter((it) => !drops.has(it.c));
    const offOf = (j: number) => (j === chain.length ? expect : known[chain[j].k] ?? (chain[j].k === 0 ? 0 : undefined));
    if (offOf(0) === undefined) return `声部${v + 1}链头不在第一列、也没配上槽`;
    const sync = [0, ...chain.map((_, j) => (j > 0 && known[chain[j].k] !== undefined ? j : -1)).filter((j) => j > 0), chain.length];
    for (let s0 = 0; s0 + 1 < sync.length; s0++) {
      const p = sync[s0];
      const q = sync[s0 + 1];
      const start = offOf(p)!;
      const span = offOf(q)! - start;
      const seg = chain.slice(p, q);
      const durs = seg.map((it) => it.c.notes[0].duration);
      // 一种读法行不行：段内时值和对上、中间那些和弦的起点夹在各自的界里
      const fits = (ds: number[]) => {
        if (Math.abs(ds.reduce((a, b) => a + b, 0) - span) > EPS) return false;
        let at = start;
        for (let j = 1; j < ds.length; j++) {
          at += ds[j - 1];
          const [lo, hi] = bound(r.cols[seg[j].k]);
          if (at <= lo + EPS || at >= hi - EPS) return false;
        }
        return true;
      };
      if (fits(durs)) continue;
      // 段长正好是读出时值和的三分之二：一组三连音（带方括号的三连音要到挂完歌词才认，见 `findRasterTuplets`），整行不动
      const sum = durs.reduce((a, b) => a + b, 0);
      if (Math.abs(sum * 2 - span * 3) < EPS) return `声部${v + 1}段 ${p}-${q} 疑三连音`;
      const opts = seg.map((it) => alternatives(it.c.notes[0], dotProbe));
      const sols: { j: number; alt: [number, number] }[][] = [];
      for (let j = 0; j < seg.length; j++)
        for (const alt of opts[j]) {
          const ds = [...durs];
          ds[j] = durOf(...alt);
          if (fits(ds)) sols.push([{ j, alt }]);
        }
      if (!sols.length)
        for (let j = 0; j < seg.length; j++)
          for (let j2 = j + 1; j2 < seg.length; j2++)
            for (const alt of opts[j])
              for (const alt2 of opts[j2]) {
                const ds = [...durs];
                ds[j] = durOf(...alt);
                ds[j2] = durOf(...alt2);
                if (fits(ds)) sols.push([{ j, alt }, { j: j2, alt: alt2 }]);
              }
      // **删假头**：段内多出来的正好是一个没配上槽、又没干的头的时值，删掉它中间各列也都夹得进界里
      if (!sols.length && sum > span + EPS) {
        // 删掉后各和弦的界要跟着挪一位：按删后的和弦重验（链头没配上槽按 0 算，删了照样从 `start` 推）
        const fitsWithout = (j: number) => {
          const rest = seg.filter((_, i) => i !== j);
          const ds = durs.filter((_, i) => i !== j);
          if (Math.abs(ds.reduce((a, b) => a + b, 0) - span) > EPS) return false;
          let at = start;
          for (let i = 1; i < ds.length; i++) {
            at += ds[i - 1];
            const [lo, hi] = bound(r.cols[rest[i].k]);
            if (at <= lo + EPS || at >= hi - EPS) return false;
          }
          return true;
        };
        const cut = seg.map((_, j) => j).filter((j) => (j > 0 || known[seg[j].k] === undefined) && weak(seg[j]) && fitsWithout(j));
        if (cut.length === 1) {
          drops.add(seg[cut[0]].c);
          continue;
        }
      }
      // **补漏音**：段内缺的正好是一个音的时值，缺口处别的行有个定了起点的槽、本行在那里没有列——前面的音正好响到那个槽，
      // 补进去以后后面各和弦的起点也夹得进界里；只有一处补得才补
      if (!sols.length && add && sum < span - EPS) {
        const gap = span - sum;
        const cands: { j: number; s0: Slot }[] = [];
        let at = start;
        for (let j = 1; j <= seg.length; j++) {
          at += durs[j - 1];
          const xl = r.cols[seg[j - 1].k].x;
          const xr = j < seg.length ? r.cols[seg[j].k].x : q < chain.length ? r.cols[chain[q].k].x : Infinity;
          // 本声部在那个槽上没有和弦（整列空着，或那一列只有另一声部的头）
          for (const s1 of anchored) if (Math.abs(s1.off! - at) < EPS && s1.x > xl && s1.x < xr && !chain.some((it) => r.cols[it.k].slot === s1)) cands.push({ j, s0: s1 });
        }
        const ok = cands.filter(({ j }) => {
          let a = start;
          for (let i = 1; i < seg.length; i++) {
            a += durs[i - 1];
            const o = i >= j ? a + gap : a;
            const [lo, hi] = bound(r.cols[seg[i].k]);
            if (o <= lo + EPS || o >= hi - EPS) return false;
          }
          return true;
        });
        if (ok.length === 1 && STD_DURS.some((d) => Math.abs(d.dur - gap) < EPS)) {
          const prev = inserts.get(ok[0].s0);
          if (prev && Math.abs(prev.dur - gap) > EPS) return "两声部补音时值不一";
          // 两条链在同一槽都缺同样长的音：两声部共用的那一个整个漏了，补一个
          inserts.set(ok[0].s0, { dur: gap, up: prev || chains.length < 2 ? null : v === 0 });
          continue;
        }
      }
      // 补附点只在别的读法凑不上时用：不补点也有一种改法的，就用那一种（新编 f37 信心加上德行歌：十六分→八分与旁边的头补点并列）
      if (sols.length > 1) {
        const plain = sols.filter((sol) => sol.every(({ j, alt }) => alt[1] <= seg[j].c.notes[0].dots));
        if (plain.length === 1) sols.splice(0, sols.length, plain[0]);
      }
      if (sols.length !== 1) return `声部${v + 1}段 ${p}-${q} 差 ${span - sum}（${sols.length ? `改法 ${sols.length} 种` : "易混读法凑不上"}）`;
      for (const { j, alt } of sols[0]) {
        const prev = changes.get(seg[j].c);
        // 两声部共用的和弦两条链要改得一样
        if (prev && (prev[0] !== alt[0] || prev[1] !== alt[1])) return "两声部对共用和弦的改法不一";
        changes.set(seg[j].c, alt);
      }
    }
  }
  if (inserts.size) {
    if (inserts.size > 1 || changes.size || drops.size) return `补 ${inserts.size} 删 ${drops.size} 改 ${changes.size}，不做`;
    const [[s0, { dur, up }]] = [...inserts];
    const c = add!(r, s0, dur, up);
    if (!c) return `缺 ${dur} @${s0.off}，原图没找到头`;
    const savedC = r.chords.map((x) => ({ c: x, offset: x.offset, dur: x.dur, timed: x.timed }));
    const ok = checkFull([...r.chords, c], expect, sp, false) && Math.abs(c.offset - s0.off!) < EPS && r.cols.every((col, k) => known[k] === undefined || col.chords.every((x) => Math.abs(x.offset - known[k]!) < EPS));
    if (!ok) {
      for (const q of savedC) Object.assign(q.c, { offset: q.offset, dur: q.dur, timed: q.timed });
      return `补 ${dur} 凑不上`;
    }
    const n = c.notes[0];
    // 按谱行、再按 x 的次序插进去（同 `buildNotes`）
    const at = notes.findIndex((m) => m.staff.box.top > n.staff.box.top || (m.staff === n.staff && m.x > n.x));
    notes.splice(at < 0 ? notes.length : at, 0, n);
    pg.symbols.push(n.sym);
    pg.objs.push(n.sym.parent);
    return `补 1 个${n.rest ? "休止" : `音 ${n.step}${n.octave}`} ${dur} @${s0.off}${up === null ? "" : up ? "（上声部）" : "（下声部）"}`;
  }
  if (!changes.size && !drops.size) return r.full ? "满而不齐、时值都对（次序问题）" : "时值都对、仍不满";
  if (drops.size > 1 || (drops.size && changes.size)) return `删 ${drops.size} 改 ${changes.size}，不做`;
  // 只有一个锚行时只改一处：锚自己也可能是错读凑满的，配错槽、漏了音的行会被硬凑满（破碎扫描 p4 m49、p7 m81 单锚改了两处都错）
  if (trusted.size < 2 && changes.size > 1) return `单锚改动过多 ${changes.size}`;
  const saved = r.chords.flatMap((c) => c.notes.map((n) => ({ n, base: n.base, dots: n.dots, duration: n.duration, beams: n.beams })));
  const savedC = r.chords.map((c) => ({ c, offset: c.offset, dur: c.dur, timed: c.timed }));
  const before = [...changes.keys()].map((c) => c.notes[0].duration);
  for (const [c, [base, dots]] of changes) for (const n of c.notes) if (!n.rest) setDur(n, base, dots);
  const kept = r.chords.filter((c) => !drops.has(c));
  const ok = checkFull(kept, expect, sp, false) && r.cols.every((col, k) => known[k] === undefined || col.chords.every((c) => drops.has(c) || Math.abs(c.offset - known[k]!) < EPS));
  if (ok && drops.size) {
    for (const c of drops) for (const n of c.notes) notes.splice(notes.indexOf(n), 1);
    return `删 1 个假头（${[...drops][0].notes.map((n) => n.step + n.octave).join("")}）`;
  }
  if (ok) return `改 ${changes.size} 处：${[...changes.values()].map(([b, d], j) => `${before[j]}→${durOf(b, d)}`).join(" ")}${chains.length > 1 ? "（两声部）" : ""}`;
  for (const s0 of saved) Object.assign(s0.n, { base: s0.base, dots: s0.dots, duration: s0.duration, beams: s0.beams });
  for (const s0 of savedC) Object.assign(s0.c, { offset: s0.offset, dur: s0.dur, timed: s0.timed });
  return `改完凑不上（${changes.size} 处）`;
}

/**
 * 一行的声部链：`k` 是和弦所在列的下标。两个声部的行：一列两个和弦要一个干朝上一个朝下（休止按高低归），一列多于两个的不拆。
 * 一列只一个和弦的算两声部共用；`soloHeads` 时有干的单个头只归它干朝向那个声部——先不这么归：扫描件上这种头多是同度共用、
 * 或同干另一个头漏认，这么归改时值那一路反倒解不出（破碎扫描十来处，+14 步），只在共用解不出时拿来补另一声部。
 */
function voiceChains(r: Row, soloHeads: boolean): { c: StaffChord; k: number }[][] | string {
  if (r.single) return [r.cols.map((col, k) => ({ c: col.chords[0], k }))];
  const up: { c: StaffChord; k: number }[] = [];
  const down: { c: StaffChord; k: number }[] = [];
  const mid = (c: StaffChord) => c.notes.reduce((a, n) => a + n.sym.box.top + n.sym.box.bottom, 0) / (2 * c.notes.length);
  for (const [k, col] of r.cols.entries()) {
    if (col.chords.length > 2) return `第${k}列 ${col.chords.length} 个和弦`;
    if (col.chords.length === 1) {
      // `soloHeads`：有干的单个头只是它干朝向那一个声部的（另一声部在这里还响着前一个音，或者漏了）
      const c = col.chords[0];
      const solo = soloHeads && c.notes.length === 1 && !c.notes[0].rest && c.stem ? c.notes[0].stemUp : null;
      if (solo !== false) up.push({ c, k });
      if (solo !== true) down.push({ c, k });
      continue;
    }
    const [a, b] = col.chords;
    const dirA = a.notes[0].rest ? null : a.notes[0].stemUp;
    const dirB = b.notes[0].rest ? null : b.notes[0].stemUp;
    let hi: StaffChord;
    if (dirA !== null && dirB !== null) {
      if (dirA === dirB) return `第${k}列两个和弦干同向`;
      hi = dirA ? a : b;
    } else hi = mid(a) < mid(b) ? a : b;
    up.push({ c: hi, k });
    down.push({ c: hi === a ? b : a, k });
  }
  return [up, down];
}


function debugBar(top: number, i: number, rows: Row[], slots: Slot[], trusted: Set<Row>, page: number): void {
  const tag = (r: Row) => (r.skip ? "跳" : trusted.has(r) ? "锚" : r.full ? "满不齐" : "不满");
  console.error(`XA p${page + 1} 系统@${Math.round(top)} m${i + 1}: ${rows.map((r) => `${tag(r)}(${r.chk.sum}/${r.chk.expect},${r.cols.length}列${r.single ? "" : ",多声"})`).join(" ")} 槽 ${slots.map((s0) => `${s0.off ?? "?"}[${s0.cols.length}]`).join(" ")}`);
}
