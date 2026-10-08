// 位图五线谱的**拍号与谱号互证**：同一系统各行拍号必须同值（`TimeColumn`）、八度谱号与系统内谱号的沿用。
import type { Binary } from "../omrkit/types";
import type { Rect } from "../omrkit/types";
import { systemGroups } from "../staffomr/page";
import { type SmuflName } from "../staffomr/glyphs";
import { timeSignatures, type StaffContext } from "../staffomr/notedata";
import type { SPage, Staff } from "../staffomr/model";
import { makeSymObj } from "./adapt";
import { type RasterUnit } from "./staffline";
import { type ClefTally } from "./recognize";

/** 行首拍号离谱表左端的上限（格）：谱号、七个升降号之后的那一格。 */
export const HEAD_TIME_SP = 14;

/** 终止线粗线的宽度下限（格）。 */
const FINAL_THICK = 0.3;

/** 行首一个拍号候选列：盒、中线 y、OCR 读出的上下半（读不成合法数字的是 null）。 */
export interface TimeColumn {
  box: Rect;
  mid: number;
  num: number | null;
  den: number | null;
}

/**
 * **同一系统各行的拍号互证**（参照 `TimeColumn`：一个系统里每行谱的拍号同值、同 x）。
 *
 * 各行原来各认各的：大谱表高音行没认出、低音行认出了，写出端只看领头行，整首就没有拍号（新编赞美诗 035）；
 * 两行读数不同也没人裁决（071 高音 6/4、低音 4/4，谱面是 6/8）。这里按系统合起来：
 *   - 每行行首已认出的拍号投一票，OCR 上下两半都读出的候选列再各投一票（文字识别比模板签名靠得住），取票多的；
 *   - 一行都没认全时，上下两半分头凑：同一列位置上，这一行读出分子、那一行读出分母，合起来就是一个拍号；
 *   - 定下来的值写回系统里每一行（没有或读数不同的行换掉），那一列盒里被当成符头的块一并删掉。
 * 行中换拍的不管（只看谱表左端 `HEAD_TIME_SP` 格以内的）。
 *
 * **不在一首歌开头的系统从严**（一首歌只在头一个系统印拍号，别的系统行首出现拍号只会是换拍，各行必然都印）：
 * 至少两行读数相同才算数、才往别的行补；只有一行由 OCR 读出的作废——行首的和弦、休止偶尔也读得成一对数字。
 * 歌的开头 = 页上头一个系统且前页没传下拍号，或上一个系统以终止线收尾（同 `keySections`）。
 */
export function shareTimeSignature(pg: SPage, ctx: Map<Staff, StaffContext>, cols: TimeColumn[], unit: RasterUnit, bin: Binary, carried: boolean): void {
  const sp = unit.space;
  const key = (t: { beats: number; beatType: number }) => `${t.beats}/${t.beatType}`;
  const groups = systemGroups(pg).sort((a, b) => a[0].box.top - b[0].box.top);
  for (const [gi, sys] of groups.entries()) {
    const staves = sys.filter((st) => ctx.has(st) && st.lineYs.length === 5);
    if (staves.length < 2) continue;
    const prev = groups[gi - 1];
    const songHead = prev ? prev.filter((st) => endsWithFinal(st, bin)).length * 2 > prev.length : !carried;
    const colsOf = (st: Staff) => cols.filter((c) => c.mid > st.box.top && c.mid < st.box.bottom);
    const headOf = (st: Staff) => {
      const all = timeSignatures(ctx.get(st)!.time, sp).filter((t) => t.x < st.box.left + sp * HEAD_TIME_SP);
      return all.length ? all[0] : null;
    };
    const votes = new Map<string, { beats: number; beatType: number; x: number; n: number; staves: Set<Staff> }>();
    const vote = (t: { beats: number; beatType: number }, x: number, st: Staff) => {
      const v = votes.get(key(t)) ?? { ...t, x, n: 0, staves: new Set<Staff>() };
      v.n++;
      v.staves.add(st);
      votes.set(key(t), v);
    };
    for (const st of staves) {
      const h = headOf(st);
      if (h) vote(h, h.x, st);
      for (const c of colsOf(st)) if (c.num !== null && c.den !== null) vote({ beats: c.num, beatType: c.den }, c.box.x, st);
    }
    if (!songHead) {
      // 从严：不够两行作证的读数，由 OCR 读出的那一行作废，别的原样不动，也不往别的行补
      const ok = [...votes.values()].filter((v) => v.staves.size >= 2).sort((a, b) => b.staves.size - a.staves.size || b.n - a.n)[0];
      if (!ok) {
        for (const st of staves) {
          const h = headOf(st);
          if (!h || !colsOf(st).some((c) => c.num === h.beats && c.den === h.beatType && Math.abs(c.box.x - h.x) <= sp * 1.5)) continue;
          const c = ctx.get(st)!;
          const old = new Set(c.time.filter((t) => Math.abs(t.px - h.x) <= sp * 3));
          c.time = c.time.filter((t) => !old.has(t));
          pg.symbols = pg.symbols.filter((s0) => !old.has(s0));
        }
        continue;
      }
      for (const k of [...votes.keys()]) if (votes.get(k) !== ok) votes.delete(k);
    }
    if (!votes.size && songHead) {
      // 上下两半分头凑：各行的候选列按 x 对齐，分子、分母各取读得出的那一行
      const all = staves.flatMap(colsOf).sort((a, b) => a.box.x - b.box.x);
      for (const c of all) {
        const near = all.filter((o) => Math.abs(o.box.x - c.box.x) <= sp * 1.5);
        const num = near.find((o) => o.num !== null)?.num ?? null;
        const den = near.find((o) => o.den !== null)?.den ?? null;
        if (num !== null && den !== null) {
          vote({ beats: num, beatType: den }, c.box.x, staves[0]);
          break;
        }
      }
    }
    if (!votes.size) continue;
    const win = [...votes.values()].sort((a, b) => b.staves.size - a.staves.size || b.n - a.n)[0];
    for (const st of staves) {
      const c = ctx.get(st)!;
      const h = headOf(st);
      if (h && key(h) === key(win)) continue;
      // 这一行原来行首那处拍号（读数不同）作废
      if (h) {
        const old = new Set(c.time.filter((t) => Math.abs(t.px - h.x) <= sp * 3));
        c.time = c.time.filter((t) => !old.has(t));
        pg.symbols = pg.symbols.filter((s0) => !old.has(s0));
      }
      const col = colsOf(st).find((o) => Math.abs(o.box.x - win.x) <= sp * 1.5);
      const x = col ? col.box.x : Math.round(win.x - sp * 0.6);
      const w = col ? col.box.w : Math.round(sp * 1.2);
      const top = Math.round(st.box.top), mid = Math.round((st.box.top + st.box.bottom) / 2), bottom = Math.round(st.box.bottom);
      const put = (n: number, y: number, h0: number) => {
        const ds = String(n).split("");
        ds.forEach((d, k) => {
          const b: Rect = { x: Math.round(x + (k * w) / ds.length), y, w: Math.round(w / ds.length), h: h0 };
          const { obj, sym } = makeSymObj(pg.objs.length + pg.segs.length + 1, { box: b, code: `timeSig${d}` as SmuflName }, unit.height);
          pg.objs.push(obj);
          pg.symbols.push(sym);
          c.time.push(sym);
        });
      };
      put(win.beats, top, mid - top);
      put(win.beatType, mid, bottom - mid);
      // 这一列里被当成符头的块（粗体数字整块被拆成两个黑头）一并删掉
      pg.symbols = pg.symbols.filter((s0) => {
        if (!s0.hasTag("Note")) return true;
        const cx = (s0.box.left + s0.box.right) / 2, cy = (s0.box.top + s0.box.bottom) / 2;
        return !(cx > x && cx < x + w && cy > top - sp * 0.5 && cy < bottom + sp * 0.5);
      });
    }
  }
}

/**
 * 这一行谱是不是以**终止线**收尾：右端往左两格以内，贯穿谱表（九成的行有墨）的竖线里最右那根粗（≥ `FINAL_THICK` 格）、
 * 左边一格以内还有一根细的。
 */
export function endsWithFinal(st: Staff, bin: Binary): boolean {
  if (st.lineYs.length !== 5) return false;
  const sp = (st.lineYs[4] - st.lineYs[0]) / 4;
  const y0 = Math.round(st.lineYs[0]), y1 = Math.round(st.lineYs[4]);
  const full = (x: number) => {
    let n = 0;
    for (let y = y0; y <= y1; y++) if (bin.data[y * bin.w + x]) n++;
    return n >= (y1 - y0 + 1) * 0.9;
  };
  const runs: [number, number][] = [];
  for (let x = Math.max(0, Math.round(st.box.right - sp * 2)); x <= Math.min(bin.w - 1, Math.round(st.box.right + sp * 0.5)); x++) {
    if (!full(x)) continue;
    const last = runs[runs.length - 1];
    if (last && last[1] === x - 1) last[1] = x;
    else runs.push([x, x]);
  }
  if (runs.length < 2) return false;
  const [a, b] = runs.slice(-2);
  const thick = b[1] - b[0] + 1, thin = a[1] - a[0] + 1;
  return thick >= sp * FINAL_THICK && thin < thick * 0.6 && b[0] - a[1] <= sp;
}

/**
 * **挂「8」没认出来的高音谱号，照别的系统同一位置的定**。「8」贴在谱号尾巴底下，扫描件上尾巴断开、
 * 「8」淡得连不上时量不出来（烛光颂曲 p3、p7 各一个七行系统的男高音行读成普通高音谱号，整行高八度）。
 * 分谱的合唱谱里行数相同、各行高低音谱号排法也相同的系统是同一套声部，同一位置的谱号相同：
 * 这个位置在见过的系统里（本页的连同前面各页带下来的）至少两次、且过半读成低八度谱号，没读出来的就照它改。
 * 只管四行以上的系统：三行的「独唱 + 钢琴」换一个声部唱，行数与排法都不变。只增不减——挂着的「8」只会漏认。
 * 返回更新后的见证，随 `carryKey` 带到下一页。
 */
export function shareOctaveClefs(pg: SPage, ctx: Map<Staff, StaffContext>, carry: ClefTally | undefined): ClefTally {
  const tally: ClefTally = {};
  for (const [k, v] of Object.entries(carry ?? {})) tally[k] = { seen: v.seen, g8: v.g8.slice() };
  const rows: { key: string; cs: StaffContext[] }[] = [];
  for (const g of systemGroups(pg)) {
    if (g.length < 4) continue;
    const cs = g.map((st) => ctx.get(st));
    if (!cs.every((c): c is StaffContext => !!c?.clef && (c.clef.code === "gClef" || c.clef.code === "gClef8vb" || c.clef.code === "fClef"))) continue;
    const key = `${g.length}:${cs.map((c) => (c.clef!.code === "fClef" ? "f" : "g")).join("")}`;
    const t = (tally[key] ??= { seen: 0, g8: cs.map(() => 0) });
    t.seen++;
    cs.forEach((c, i) => {
      if (c.clef!.code === "gClef8vb") t.g8[i]++;
    });
    rows.push({ key, cs });
  }
  for (const { key, cs } of rows) {
    const t = tally[key];
    cs.forEach((c, i) => {
      if (c.clef!.code === "gClef" && t.g8[i] >= 2 && t.g8[i] * 2 > t.seen) c.clef!.code = "gClef8vb";
    });
  }
  return tally;
}

/**
 * **多行系统各行的行首谱号按全页的多数定**。闭合谱每个系统都是「高音谱表 + 低音谱表」，
 * 可第一系统的低音谱号挨着拍号、常被读成高音谱号（或干脆没认出来），那一行的音全按高音谱表读，
 * 整首只剩三成（新编赞美诗 149 每日新恩歌、213 曾否就主歌、121 将见我王歌）。
 * 行数相同的系统至少两个、某个位置上过半的系统认出同一种谱号，其余系统那个位置就照它改；没认出谱号的补一个。
 * 只动行首那一个（行中换谱号的不管）。
 */
export function shareSystemClefs(pg: SPage, ctx: Map<Staff, StaffContext>, unit: { space: number; height: number }): void {
  const byLen = new Map<number, Staff[][]>();
  // 只管两行的系统（大谱表）：合唱谱三行以上的系统行数相同、声部却不同（女声加钢琴 / 男声加钢琴），
  // 同一位置的谱号本来就不一样（合唱谱干净档按谱行 98.17 → 97.94）
  for (const g of systemGroups(pg)) if (g.length === 2) (byLen.get(g.length) ?? byLen.set(g.length, []).get(g.length)!).push(g);
  for (const [len, gs] of byLen) {
    if (gs.length < 2) continue;
    for (let i = 0; i < len; i++) {
      const tally = new Map<SmuflName, number>();
      for (const g of gs) {
        const code = ctx.get(g[i])?.clef?.code;
        if (code) tally.set(code, (tally.get(code) ?? 0) + 1);
      }
      let [code, n] = [...tally].sort((a, b) => b[1] - a[1])[0] ?? [];
      // 下面那行有读成低音谱号的、且不比读成高音的少，上面那行又都是高音谱号：照低音定（上面是高音谱号的大谱表，
      // 下面那行不会也是高音）。只有两个系统、一个读成高音一个读成低音的平手（每日新恩歌），
      // 或四个系统里两行没认出谱号、剩下一高一低（尊主为大歌）都落在这里。
      const fs = tally.get("fClef") ?? 0;
      const tieBass = i === len - 1 && i > 0 && fs >= 1 && fs >= (tally.get("gClef") ?? 0) && gs.every((g) => (ctx.get(g[0])?.clef?.code ?? "gClef") === "gClef");
      if (tieBass) (code = "fClef"), (n = gs.length);
      if (!code || n === undefined || n < 2 || n * 2 <= gs.length) continue;
      for (const g of gs) {
        const c = ctx.get(g[i]);
        if (!c || c.clef?.code === code) continue;
        if (c.clef) c.clef.code = code;
        else {
          const st = g[i];
          const box = { x: st.box.left + unit.space * 0.5, y: st.box.top, w: unit.space * 2.5, h: st.box.bottom - st.box.top };
          const sym = makeSymObj(pg.objs.length + pg.segs.length + 1, { box, code }, unit.height).sym;
          sym.addTag("Clef");
          c.clef = sym;
          c.clefs = [sym, ...(c.clefs ?? [])];
        }
      }
    }
  }
}
