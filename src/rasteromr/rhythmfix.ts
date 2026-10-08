import { checkBars, lastTimeSignature, type StaffContext, type StaffNote } from "../staffomr/notedata";
import type { SPage, Staff } from "../staffomr/model";

/**
 * **小节多出几个八分的拍数，就有几个四分其实是八分**。密排的单符尾八分（一个音一根尾，不连杠），尾巴贴着下一个音的头，
 * 零星有一个认不出尾、读成四分（新编赞美诗 265 愿跟随主歌，几乎每小节一个），这一小节就多出八分之一拍。
 * 拍号认出来了才做。按干朝向分声部，某个声部的时值和比拍号多 k 个八分（不过半小节）时，
 * 把这个声部里**到下一个音最近**的 k 个四分改成八分——八分的间距本来就比四分小；
 * k 正好等于四分的个数就全改，否则第 k 近的要明显比第 k+1 近的小（八成以内），分不开的不动。
 */
export function fixQuartersByBarSum(pg: SPage, ctx: Map<Staff, StaffContext>, notes: StaffNote[], carry: { beats: number; beatType: number } | undefined, sp: number): void {
  if (!lastTimeSignature(pg, ctx, carry)) return;
  const eps = 1e-6;
  for (const b of checkBars(pg, ctx, notes, carry)) {
    const bar = b.staff.bars[b.index];
    const inBar = notes.filter((n) => n.staff === b.staff && n.x >= bar.left && n.x < bar.right && !n.grace).sort((p, q) => p.x - q.x);
    // **不满四拍的拍号里没有全音符**：3/4、2/4、6/8 的小节装不下一个全音符，读成全音符的是干没挂上的二分音符
    //（两声部叠着的空心头，干被另一个头的圈截断；整本「二分读成全音符」五百处）。附点照留（3/4 里的附点二分）。
    if (b.expect < 1 - eps)
      for (const n of inBar)
        if (!n.rest && n.base === 1 && n.sym.code === "noteheadWhole") {
          n.base = 1 / 2;
          n.duration = (1 / 2) * (2 - 1 / 2 ** n.dots);
        }
    // 四拍的小节里**先后两处全音符**也一样：一个小节装不下两个，都是没挂上干的二分音符
    else {
      const wholes = inBar.filter((n) => !n.rest && n.base === 1 && n.sym.code === "noteheadWhole");
      if (wholes.some((n) => Math.abs(n.x - wholes[0].x) > sp * 2) && b.expect < 2 - eps)
        for (const n of wholes) {
          n.base = 1 / 2;
          n.duration = (1 / 2) * (2 - 1 / 2 ** n.dots);
        }
    }
    if (b.full) continue;
    const dirs = [...new Set(inBar.filter((n) => !n.rest).map((n) => n.stemUp))];
    for (const d of dirs.length > 1 ? dirs : [undefined]) {
      // 这个声部的各列（同 x 的几个头算一列，时值取最短的那个）；休止两个声部都算
      const mine = inBar.filter((n) => n.rest || d === undefined || n.stemUp === d);
      const cols: { x: number; dur: number; ns: StaffNote[] }[] = [];
      for (const n of mine) {
        const c = cols[cols.length - 1];
        if (c && n.x - c.x <= sp * 0.6) (c.dur = Math.min(c.dur, n.duration)), c.ns.push(n);
        else cols.push({ x: n.x, dur: n.duration, ns: [n] });
      }
      const over = cols.reduce((a, c) => a + c.dur, 0) - b.expect;
      const k = Math.round(over * 8);
      if (k < 1 || Math.abs(over * 8 - k) > eps || over > b.expect / 2 + eps) continue;
      const quarter = (c: (typeof cols)[number]) => c.ns.every((n) => !n.rest && n.base === 1 / 4 && !n.dots && n.sym.code === "noteheadBlack");
      const cand = cols
        .map((c, i) => ({ c, gap: (cols[i + 1]?.x ?? bar.right) - c.x }))
        .filter((q) => quarter(q.c))
        .sort((p, q) => p.gap - q.gap);
      if (cand.length < k) continue;
      if (cand.length > k && cand[k - 1].gap > cand[k].gap * 0.8) continue;
      for (const { c } of cand.slice(0, k))
        for (const n of c.ns) {
          n.base = 1 / 8;
          n.duration = 1 / 8;
          n.beams = Math.max(n.beams, 1);
        }
    }
  }
}

/**
 * **附点八分后面跟的那个八分，其实是十六分**。「附点八分 + 十六分」凑一拍是最常见的附点节奏，
 * 低分辨率底本上十六分的两条符尾糊成一条，读成八分（新编赞美诗 373 仰望天家歌整首都是这个节奏，
 * 每个小节多出八分之一拍，后面的音拍位全错开）。「附点八分 + 八分」在这类谱里几乎不出现，
 * 所以附点八分右边**同一声部**（干朝向相同、同一小节）紧跟的那一个八分改成十六分；和弦里的几个头一起改。
 * 干朝向不明的不动。
 */
export function fixDottedPairs(notes: StaffNote[], sp: number): void {
  const barOf = (n: StaffNote) => n.staff.bars.find((b) => n.x >= b.left && n.x < b.right);
  const by = new Map<Staff, StaffNote[]>();
  for (const n of notes) if (!n.rest) (by.get(n.staff) ?? by.set(n.staff, []).get(n.staff)!).push(n);
  for (const ns of by.values()) {
    ns.sort((a, b) => a.x - b.x);
    for (const a of ns) {
      if (a.dots !== 1 || a.base !== 1 / 8 || a.stemUp === null) continue;
      const bar = barOf(a);
      const next = ns.find((b) => b.x > a.x + sp * 0.8 && b.stemUp === a.stemUp && barOf(b) === bar);
      if (!next || next.x - a.x > sp * 6) continue;
      for (const b of ns) {
        if (Math.abs(b.x - next.x) > sp * 0.6 || b.stemUp !== a.stemUp || b.base !== 1 / 8 || b.dots) continue;
        b.base = 1 / 16;
        b.duration = 1 / 16;
        b.beams = Math.max(b.beams, 2);
      }
    }
  }
}
