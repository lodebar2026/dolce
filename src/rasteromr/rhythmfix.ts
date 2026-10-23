import { checkBars, lastTimeSignature, type BeamShape, type StaffContext, type StaffNote, type StemInfo } from "../staffomr/notedata";
import { applyTuplet } from "../staffomr/notations";
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
 * **干尖碰上另一行谱的杠**：钢琴右手四分和弦的干朝下伸得长，尖正落在左手那组八分的杠上（是爱 p3 m31、m33，
 * 手写刻谱），右手读成八分，小节少两拍。干上的杠全是**只连着别的谱行的干**的、这一小节又不满的，
 * 把这些音退回四分，正好凑满才改（真的跨谱表连杠两边都是自己这一路的拍子，退了凑不满）。
 */
export function dropBorrowedBeams(pg: SPage, ctx: Map<Staff, StaffContext>, notes: StaffNote[], stems: StemInfo[], carry: { beats: number; beatType: number } | undefined, sp: number): void {
  if (!lastTimeSignature(pg, ctx, carry)) return;
  const eps = 1e-6;
  const stemOf = new Map<StaffNote["sym"], StemInfo>();
  for (const st of stems) for (const s of st.notes) if (!stemOf.has(s)) stemOf.set(s, st);
  const borrowed = (n: StaffNote): boolean => {
    const st = stemOf.get(n.sym);
    if (!st || st.flags || !st.beams.length || n.beams !== 1) return false;
    return st.beams.every((b) => {
      // 挂着这个头本身的另一根干（同一根干抽成了两段）不算别人（是爱 p1 m15 右手 C5）
      const others = stems.filter((o) => o !== st && o.beams.includes(b) && !o.notes.includes(n.sym));
      return others.length > 0 && others.every((o) => o.up !== st.up && o.notes.every((s) => s.ownerStaff && s.ownerStaff !== n.staff));
    });
  };
  for (const b of checkBars(pg, ctx, notes, carry)) {
    if (b.full) continue;
    const bar = b.staff.bars[b.index];
    const inBar = notes.filter((n) => n.staff === b.staff && n.x >= bar.left && n.x < bar.right && !n.grace).sort((p, q) => p.x - q.x);
    const dirs = [...new Set(inBar.filter((n) => !n.rest).map((n) => n.stemUp))];
    // 整小节当一个声部先试：和弦干朝上朝下交替的一路（是爱 p3 m31）按朝向拆开哪边都凑不满
    for (const d of dirs.length > 1 ? [undefined, ...dirs] : [undefined]) {
      const mine = inBar.filter((n) => n.rest || d === undefined || n.stemUp === d);
      const cols: { x: number; dur: number; ns: StaffNote[] }[] = [];
      for (const n of mine) {
        const c = cols[cols.length - 1];
        if (c && n.x - c.x <= sp * 0.6) (c.dur = Math.min(c.dur, n.duration)), c.ns.push(n);
        else cols.push({ x: n.x, dur: n.duration, ns: [n] });
      }
      const fix = cols.filter((c) => c.ns.every((n) => !n.rest && !n.dots && n.base === 1 / 8) && c.ns.some(borrowed));
        if (!fix.length) continue;
      const sum = cols.reduce((a, c) => a + c.dur, 0) + fix.length / 8;
      if (Math.abs(sum - b.expect) > eps) continue;
      for (const c of fix)
        for (const n of c.ns) {
          n.base = 1 / 4;
          n.duration = 1 / 4;
          n.beams = 0;
          n.beam = undefined;
        }
      break;
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

/**
 * **连音数字没认出、整小节超拍的，按拍数补认**。低清预览页上一杠六个十六分下面那个小「6」（三连音的「3」同理）
 * 认不出来，六连音按普通十六分算，每组多出半拍（坚固保障钢琴前奏每小节多 2 拍）。
 * 超拍的小节里，同一根杠盖住、恰好 3 列或 6 列、各列时值一样、名义上占一拍半、还没挂连音的组都是候选，一小节有两组以上才一起改成连音；
 * 改完这一小节正好满拍才留，否则退回。数字认出的那几组（`findTuplets`）不动，不超拍的小节不碰。
 */
export function tupletsByBarSum(pg: SPage, ctx: Map<Staff, StaffContext>, stems: StemInfo[], notes: StaffNote[], carry: { beats: number; beatType: number } | undefined, sp: number): void {
  if (!lastTimeSignature(pg, ctx, carry)) return;
  const eps = 1e-6;
  const bySym = new Map(notes.map((n) => [n.sym, n]));
  const groups = new Map<BeamShape, Set<StaffNote>>();
  for (const st of stems)
    for (const b of st.beams)
      for (const s of st.notes) {
        const n = bySym.get(s);
        if (n) (groups.get(b) ?? groups.set(b, new Set()).get(b)!).add(n);
      }
  // 一组的列（同 x 的几个头算一列）：恰好 3 或 6 列、时值一致才算候选
  const cands: { ns: StaffNote[]; n: number }[] = [];
  // 十六分两道杠：同一组音被几个杠形各收一次，按第一个音去重
  const seen = new Set<StaffNote>();
  for (const set of groups.values()) {
    const ns = [...set].filter((n) => !n.rest && !n.grace).sort((a, b) => a.x - b.x);
    if (!ns.length || seen.has(ns[0])) continue;
    seen.add(ns[0]);
    if (ns.some((n) => n.tuplet || n.staff !== ns[0].staff || n.duration !== ns[0].duration)) continue;
    let cols = 1;
    for (let i = 1; i < ns.length; i++) if (ns[i].x - ns[i - 1].x > sp * 0.5) cols++;
    if (cols === 3 || cols === 6) cands.push({ ns, n: cols });
  }
  if (!cands.length) return;
  for (const b of checkBars(pg, ctx, notes, carry)) {
    if (b.full || b.sum <= b.expect + eps) continue;
    const bar = b.staff.bars[b.index];
    // 名义上占**一拍半**的组才像连音（六个十六分、三个八分在 x/4 拍里都是一拍的连音）：3/4 里一杠六个八分、6/8 里三个八分是正常写法
    const mine = cands.filter((c) => c.ns[0].staff === b.staff && c.ns.every((n) => n.x >= bar.left && n.x < bar.right)
      && Math.abs(c.n * c.ns[0].duration - b.beat * 1.5) < eps);
    // 至少两组：连音段落成串出现（坚固保障每小节四组六连音）；只改一组就凑满多半是巧合——小节里另多读了一个八分，
    // 恰好被一组三个八分抵掉（破碎扫描 5 处、是爱 1 处）
    if (mine.length < 2) continue;
    const saved = mine.flatMap((c) => c.ns.map((n) => ({ n, duration: n.duration })));
    for (const c of mine) applyTuplet(c.ns, c.n);
    const again = checkBars(pg, ctx, notes, carry).find((x) => x.staff === b.staff && x.index === b.index);
    // 改完正好满拍才留。放宽到「还超也留」会把扫描件里本来就因别的错超拍的小节中、普通三个八分一杠的组收成三连音（是爱、破碎扫描）
    if (again?.full) continue;
    for (const { n, duration } of saved) {
      n.duration = duration;
      delete n.tuplet;
    }
  }
}
