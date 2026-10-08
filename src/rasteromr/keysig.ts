// 位图五线谱的**调号与临时记号**：行首调号的笔画判据（升号竖笔、降号台阶）、跨行跨页沿用、系统内互证、行中换调、还原号与临时记号按音高挂。
// `recognize.ts` 在符头之前后各调一批。
import type { Binary } from "../omrkit/types";
import type { Box } from "../staffomr/model";
import type { Rect } from "../omrkit/types";
import { systemGroups } from "../staffomr/page";
import { accidentalAlter, isAccidental, type SmuflName } from "../staffomr/glyphs";
import { calcAlters, fifthsAt, headKey, keyChanges, keyFifths, type StaffContext, type StaffNote } from "../staffomr/notedata";
import type { SPage, Staff, Sym } from "../staffomr/model";
import { makeSymObj } from "./adapt";
import { verticalStrokes } from "./prims";
import { type HarmonyToken } from "./harmony";
import { type CarryKey } from "./recognize";
import { tallStrokes } from "./restshape";
import { doubleBarRight } from "./barvote";
import { HEAD_TIME_SP, endsWithFinal } from "./clefmeter";

/** 按竖笔数升号（`sharpsByStrokes`）的起点：谱号左缘往右多少格。 */
const KEY_FROM = 2.4;

/** 谱线算「粗」的线宽/线距比（数降号竖笔时抬高度闸，见 `flatsByStrokes`）。 */
const KEY_THICK_LINE = 0.22;

/** 粗线页那套降号判据只用于线距小于这么多像素的低分辨率页。 */
const KEY_COARSE_SPACE = 13;

/** 降号竖笔顶端到肚子中心的距离（格）。新编赞美诗 11 各行量得 1.5~1.6。 */
const FLAT_STEM = 1.55;

/**
 * **调号串往右接**：`analyzeAccidental` 串调号要求相邻两个升降号**上下交叠**，
 * 而位图这边降号的盒收到了肚子上（见 `FLAT_BOWL_TOP`）——三个降号时 E♭ 的肚子在上间、
 * A♭ 的肚子在下面第二间，一点不交叠，离谱号又超过三格，第三个降号就接不上
 *（《圣哉三一歌伴奏》整首少一个降号，A 全读成还原）。升号上下对称、盒不收，不受影响。
 * 这里只补位图这一路：已有调号的谱行，右边**横向紧挨着**（间隙在 0 到自身宽之间，
 * 与 `analyzeAccidental` 同一条）、谁都没认领的升降号接到串尾。不动 `staffomr`。
 */
export function extendKeyChains(pg: SPage, ctx: Map<Staff, StaffContext>): void {
  for (const c of ctx.values()) {
    if (!c.key.length) continue;
    const onStaff = (b: Box) => b.top < c.staff.box.bottom && b.bottom > c.staff.box.top;
    for (;;) {
      const last = c.key[c.key.length - 1];
      const nx = pg.symbols.find((s0) => {
        if (!isAccidental(s0.code) || s0.hasAnyTag() || !onStaff(s0.box)) return false;
        const dx = s0.box.left - last.box.right;
        return dx >= 0 && dx <= s0.box.right - s0.box.left;
      });
      if (!nx) break;
      nx.addTag("Key");
      c.key = [...c.key, nx];
    }
  }
}

/**
 * **调号区里不出头**：头心落在谱号左缘到本行最后一个调号记号右缘之间的，是调号记号的碎块被当成了头
 *（所信有根基低音谱表四个降号，E♭ 的肚子连着 A♭ 的竖笔，收成 E♭3 空心头）。只认这一行谱自己认出的调号
 *（`ctx.key` 可能是从别行借来的）。
 */
export function dropHeadsInKey(pg: SPage, ctx: Map<Staff, StaffContext>, settled = false): void {
  const sp = pg.normalStaffSpace || pg.space;
  const drop = new Set<(typeof pg.symbols)[number]>();
  for (const c of ctx.values()) {
    if (!c.clef) continue;
    const clef = c.clef.box;
    const onStaff = (b: Box) => b.top < c.staff.box.bottom && b.bottom > c.staff.box.top;
    // `settled`：调号定下来之后再剔一遍，按 `ctx.key` 行首那一串的盒——按竖笔补出的记号不进页面符号表
    //（倚靠主永远膀臂低音谱表四个降号只按块认出两个，第四个 D♭ 的肚子连竖笔收成 D♭3 二分头）
    // 这一串的盒常是从别行照抄来的（`shareKeySignature`），纵向落在别的行上：按出处那行与本行谱左端的差平移回来
    //（耶和华是我的牧者首行缩进，抄到别的行就盖住了调号后头一个音）
    const shift = (k: Sym) => {
      if (!settled || onStaff(k.box)) return 0;
      const ky = (k.box.top + k.box.bottom) / 2;
      const src = [...ctx.values()].find((o) => ky > o.staff.box.top - sp && ky < o.staff.box.bottom + sp);
      return src ? c.staff.box.left - src.staff.box.left : 0;
    };
    const pool = settled ? headKey(c) : pg.symbols;
    const keys = pool.filter((s0) => s0.hasTag("Key") && (settled || onStaff(s0.box)) && s0.box.left + shift(s0) >= clef.left && s0.box.left + shift(s0) < clef.right + sp * 10);
    if (!keys.length) continue;
    const right = Math.max(...keys.map((k) => k.box.right + shift(k)));
    for (const s0 of pg.symbols) {
      if (!s0.hasTag("Note") || !onStaff(s0.box)) continue;
      const cx = (s0.box.left + s0.box.right) / 2;
      if (cx > clef.left && cx < right) drop.add(s0);
    }
  }
  if (drop.size) pg.symbols = pg.symbols.filter((s0) => !drop.has(s0));
}

/**
 * **曲中「转调」其实是临时记号**：`analyzeAccidental` 把紧跟小节线两格内、没挂上符头的升降号
 * 当成曲中转调的调号。可这本谱的临时记号离符头有 0.6~1.1 格，挂不上（见 `attachAccidentalsByPitch`），
 * 小节线后第一个音的升号就被当成了调号（齐来称颂 m5 的 D♯4：第一行高音谱表成了四个升号，
 * 整首音高掉到两成）。这里把**不接在谱号那一串后面**、右边 1.5 格内又有同高符头的调号升降号
 * 从 `ctx.key` 里摘出来，交给临时记号那一步。标记摘不掉（`staffomr` 不动），挂靠那一步按 `ctx.key` 认。
 */
/**
 * **行末预告下一行转调的调号不算本行的**。曲中转调落在换行处时，上一行行末（复纵线之后）先印一遍新调号。
 * `ctx.key` 收的是这一行所有挂了 `Key` 的记号、按个数算调，行末那几个一并数进去，这一行就多出几个升降号
 *（爱是从神而来 p4 第二系统：行首一个降号、行末预告三个降号，认出其中一个，四行都读成两个降号）。
 * 落在谱行右端 `COURTESY_KEY` 格以内、右边再没有音符的调号记号从 `ctx.key` 里摘掉。
 */
export function dropCourtesyKeys(pg: SPage, ctx: Map<Staff, StaffContext>, sp: number): void {
  const notes = pg.symbols.filter((q) => q.hasTag("Note"));
  for (const [st, c] of ctx) {
    if (!c.key.length) continue;
    const tail = (k: Sym) => k.box.left > st.box.right - sp * COURTESY_KEY && k.box.left > st.box.left + sp * 12 && !notes.some((n) => n.ownerStaff === st && n.px > k.px);
    if (c.key.some(tail)) c.key = c.key.filter((k) => !tail(k));
  }
}

/**
 * **落在行首「谱号 + 调号」那一段里的小节线不是小节线**。六个降号挤在一起，末两个的竖笔粗、孤立，
 * 被抽成竖段当了小节线（烛光颂曲 p4、p6 有三四行行首多切出一个小节）。同系统表决拦不住——七行里三行都有。
 * 调号的个数定了之后，这一段有多宽就知道了：谱号右缘（封顶在离谱行左端 3.6 格）起每个记号一格、再让三成格。
 * 这一段里的 `BarLine` 标记摘掉。只管调号三个以上的行：一两个记号的那一段短，小节线抽错落不到里面。
 */
export function dropBarsInKey(pg: SPage, ctx: Map<Staff, StaffContext>, sp: number): void {
  const endOf = (st: Staff) => {
    const c = ctx.get(st);
    const n = c ? headKey(c).length : 0;
    if (!c?.clef || n < 3) return -1;
    return Math.min(c.clef.box.right, st.box.left + sp * 3.6) + sp * (n + 0.3);
  };
  for (const g of systemGroups(pg)) {
    // 同一系统各行的这一段一样宽：取最靠右的那个（个别行左端量进了括号里，自己算出来的偏左）
    const end = Math.max(...g.map(endOf));
    if (end < 0) continue;
    for (const st of g)
      for (const sg of pg.segs) {
        if (!sg.isV || !sg.hasTag("BarLine")) continue;
        if (sg.bottom <= st.box.top || sg.top >= st.box.bottom) continue;
        if (sg.cx > st.box.left + sp && sg.cx < end) sg.removeTag("BarLine");
      }
  }
}

export function demoteMidKeys(pg: SPage, ctx: Map<Staff, StaffContext>): void {
  const sp = pg.normalStaffSpace || pg.space;
  const heads = pg.symbols.filter((s0) => s0.hasTag("Note"));
  for (const c of ctx.values()) {
    if (!c.clef || !c.key.length) continue;
    let edge = c.clef.box.right;
    const keep: Sym[] = [];
    for (const [i, k] of c.key.entries()) {
      const chained = k.box.left - edge <= sp * (i === 0 ? KEY_GAP_FIRST : KEY_GAP);
      const right = k.box.right;
      const owned = heads.some((n) => Math.abs(n.py - k.py) <= sp / 4 && n.box.left >= right - 2 && n.box.left - right <= sp * LOOSE_ACC_GAP);
      if (!chained && owned) continue;
      keep.push(k);
      if (chained) edge = k.box.right;
    }
    c.key = keep;
  }
}

/**
 * **调号里只有一根通高竖笔的「还原号」是降号**。还原号是左上、右下两根错开的竖笔，各占记号高的六七成；
 * 降号只有一根竖笔、右下是肚子。这份扫描件上降号的肚子与竖笔连得细，字典常认成还原号
 *（望十架 p7 行中转一个降号五行读成三个还原号、两个没认；下一系统行首一个降号有两行读成还原号），
 * 行中转调整行升降跟着错。只改 `ctx.key` 里的（谱中的临时还原号不碰），数竖笔在去线前的图上、左右各放宽 0.3 格。
 */
export function fixKeyNaturals(ctx: Map<Staff, StaffContext>, bin: Binary, sp: number): void {
  const pad = Math.round(sp * 0.3);
  for (const c of ctx.values())
    for (const k of c.key) {
      if (k.code !== "accidentalNatural") continue;
      const b = k.box;
      if (tallStrokes(bin, { x: b.left - pad, y: b.top, w: b.right - b.left + pad * 2, h: b.bottom - b.top }) === 1) k.code = "accidentalFlat";
    }
}

/**
 * **行中的调号簇要紧跟双小节线才算转调**：`findClefKeyTime` 把「紧跟在小节线之后」的升降还原号都收成调号，
 * 小节头一个音的临时记号也在里面（宁静的伯利恒低音谱表四处 B♮ 收成调号）。以前整行一个 `keyFifths`、还原号不计，
 * 混进来也只是悄悄多算一两个升降；分出行中转调（`keyChanges`）之后，它们会从那里起把整段改调。
 * 转调一律印在双小节线后面，左边三格以内没有双线的行中那簇摘出调号（交回去当临时记号，`attachAccidentalsByPitch` 认）。
 */
export function pruneMidKeys(pg: SPage, ctx: Map<Staff, StaffContext>, bin: Binary, sp: number): void {
  for (const [st, c] of ctx) {
    if (st.lineYs.length !== 5) continue;
    const head = new Set(headKey(c));
    const mids = keyChanges(c).filter((q) => q.x > -Infinity);
    if (!mids.length) continue;
    const bars = pg.segs.filter((l) => l.isV && l.hasTag("BarLine") && l.bottom > st.box.top && l.top < st.box.bottom).map((l) => l.cx);
    const drop = new Set<Sym>();
    mids.forEach((m, i) => {
      const ok = bars.some((x) => x < m.x && m.x - x <= sp * 3 && doubleBarRight(bin, st.lineYs, x, sp) !== null);
      if (ok) return;
      const next = mids[i + 1]?.x ?? Infinity;
      for (const k of c.key) if (!head.has(k) && k.box.left >= m.x && k.box.left < next) drop.add(k);
    });
    if (drop.size) c.key = c.key.filter((k) => !drop.has(k));
  }
}

/** 行中调号与模板比墨：模板的墨要有这么多落在目标上（一像素以内），目标那一段的墨也要有这么多落在模板上。 */
const MID_KEY_RECALL = 0.7;

const MID_KEY_PRECISION = 0.45;

/**
 * **行中转调按下一系统行首的调号认**：转调的调号印在双小节线后面，可调号的那几路（字典、按块、按竖笔）都只在谱号右边找，
 * 行中的升降号要么没认成记号、要么被当成头一个音的临时记号、要么读成全音符（望十架 p6 转两个升号、p8 转一个升号，
 * 五行一行都没认出，整段升降全错；按竖笔数也只量得出半截）。
 * 转调之后，**下一个系统的行首必然印着新调号**，而行首那几路是认得好的。于是拿它当模板：
 * 双小节线右边一格半以内滑动，与下一系统同种谱号那几行的行首调号逐像素比墨（谱线那几行不算，一像素以内算对上）。
 * 同一系统、同一处至少两行对上同一个读数才收；没对上的行交给 `shareMidKeys` 补。已有行中调号的那处不动。
 * 一页最后一个系统里的转调没有模板，不管。
 */
export function findMidKeysByTemplate(pg: SPage, ctx: Map<Staff, StaffContext>, bin: Binary, unit: { space: number; height: number; lineThick?: number }): void {
  const sp = unit.space;
  const thick = Math.max(1, Math.round(unit.lineThick ?? sp * 0.1));
  const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < bin.w && y < bin.h && bin.data[y * bin.w + x] === 1;
  const near1 = (x: number, y: number) => ink(x, y) || ink(x - 1, y) || ink(x + 1, y) || ink(x, y - 1) || ink(x, y + 1);
  const onLine = (st: Staff, y: number) => st.lineYs.some((l) => Math.abs(y - l) <= thick);
  const groups = systemGroups(pg).sort((a, b) => a[0].box.top - b[0].box.top);
  const found: { c: StaffContext; x: number; fifths: number; syms: Sym[]; gi: number }[] = [];
  for (const [gi, g] of groups.entries()) {
    const next = groups[gi + 1];
    if (!next) continue;
    const cands = next.map((st) => ctx.get(st)).filter((c): c is StaffContext => !!c?.clef && c.staff.lineYs.length === 5 && headKey(c).length > 0);
    for (const st of g) {
      const c = ctx.get(st);
      if (!c?.clef || st.lineYs.length !== 5) continue;
      const xs = pg.segs
        .filter((l) => l.isV && l.hasTag("BarLine") && l.bottom > st.box.top && l.top < st.box.bottom && l.cx > st.box.left + sp * 6 && l.cx < st.box.right - sp * 3)
        .map((l) => l.cx)
        .sort((a, b) => a - b);
      let prev = -Infinity;
      for (const x of xs) {
        if (x - prev < sp * 1.5) continue;
        prev = x;
        const right = doubleBarRight(bin, st.lineYs, x, sp);
        if (right === null) continue;
        prev = right;
        if (c.key.some((k) => k.box.left > right && k.box.left < right + sp * 3)) continue;
        const clefHere = (c.clefs ?? []).filter((q) => q.box.left < right).pop() ?? c.clef;
        let best: { score: number; cand: StaffContext; dx: number; dy: number } | null = null;
        for (const cand of cands) {
          if (cand.clef!.code !== clefHere.code) continue;
          const csp = cand.staff.stepDistance() * 2;
          if (Math.abs(csp - st.stepDistance() * 2) > sp * 0.12) continue;
          const head = headKey(cand);
          if (keyFifths(head) === fifthsAt(c, right)) continue;
          const tx0 = Math.round(Math.min(...head.map((k) => k.box.left)));
          const tx1 = Math.round(Math.max(...head.map((k) => k.box.right)));
          const ty0 = Math.round(cand.staff.lineYs[0] - sp * 2);
          const ty1 = Math.round(cand.staff.lineYs[4] + sp * 2);
          const tpl: [number, number][] = [];
          for (let y = ty0; y <= ty1; y++) if (!onLine(cand.staff, y)) for (let x = tx0; x <= tx1; x++) if (ink(x, y)) tpl.push([x - tx0, y - cand.staff.lineYs[0]]);
          if (tpl.length < sp * 2) continue;
          for (let dx = Math.round(sp * 0.2); dx <= Math.round(sp * 1.5); dx++)
            for (let dy = -Math.round(sp * 0.3); dy <= Math.round(sp * 0.3); dy++) {
              const ox = right + dx;
              const oy = st.lineYs[0] + dy;
              let hit = 0;
              for (const [px, py] of tpl) if (near1(ox + px, Math.round(oy + py))) hit++;
              const recall = hit / tpl.length;
              if (recall < MID_KEY_RECALL || (best && recall <= best.score)) continue;
              // 反过来：目标那一段（模板宽）的墨也要多半落在模板上，满是墨的一片（符头、粗线）对得上模板但对不过来
              const tset = new Set(tpl.map(([px, py]) => `${px},${Math.round(py)}`));
              let tot = 0;
              let back = 0;
              for (let y = Math.round(oy - sp * 2); y <= Math.round(oy + sp * 6); y++) {
                if (onLine(st, y)) continue;
                for (let x = ox; x <= ox + tx1 - tx0; x++) {
                  if (!ink(x, y)) continue;
                  tot++;
                  const px = x - ox;
                  const py = Math.round(y - oy);
                  if (tset.has(`${px},${py}`) || tset.has(`${px - 1},${py}`) || tset.has(`${px + 1},${py}`) || tset.has(`${px},${py - 1}`) || tset.has(`${px},${py + 1}`)) back++;
                }
              }
              if (!tot || back / tot < MID_KEY_PRECISION) continue;
              best = { score: recall, cand, dx, dy };
            }
        }
              if (!best) continue;
        const head = headKey(best.cand);
        const tx0 = Math.min(...head.map((k) => k.box.left));
        const ddy = st.lineYs[0] + best.dy - best.cand.staff.lineYs[0];
        const syms = head.map((k, i) => {
          const b = k.box;
          const sym = makeSymObj(pg.objs.length + pg.segs.length + 1 + i, { box: { x: Math.round(right + best!.dx + b.left - tx0), y: Math.round(b.top + ddy), w: Math.round(b.right - b.left), h: Math.round(b.bottom - b.top) }, code: k.code }, unit.height).sym;
          sym.addTag("Key");
          return sym;
        });
        found.push({ c, x: right, fifths: keyFifths(head), syms, gi });
      }
    }
  }
  for (const f of found) {
    const peers = found.filter((o) => o.gi === f.gi && Math.abs(o.x - f.x) <= sp * MID_KEY_DX && o.fifths === f.fifths);
    if (new Set(peers.map((o) => o.c)).size < 2) continue;
    f.c.key.push(...f.syms);
    f.c.key.sort((a, b) => a.box.left - b.box.left);
  }
}

/** 换掉行首那段调号（`headKey`），行中转调的记号留着。 */
function setHeadKey(c: StaffContext, head: Sym[]): void {
  const old = new Set(headKey(c));
  c.key = [...head, ...c.key.filter((k) => !old.has(k))];
}

/** 行中转调：同系统各行的那处调号在这么多格以内算同一处。 */
const MID_KEY_DX = 2.5;

/**
 * **行中转调同系统互证**：一个系统里各行在同一条小节线后转调，记号各认各的，有的行没认出、有的认岔
 *（望十架 p7：五行里三行认出、两行一个都没有）。各行行中那几簇调号（`keyChanges`）按 x 归到一处，
 * 至少两行认出、读数取多数的；没认出或读数不同的行照它补（借那一行的记号对象，下游只看种类、个数与 x）。
 */
export function shareMidKeys(pg: SPage, ctx: Map<Staff, StaffContext>, sp: number): void {
  for (const g of systemGroups(pg)) {
    const cs = g.map((st) => ctx.get(st)).filter((c): c is StaffContext => !!c);
    if (cs.length < 2) continue;
    const mids = cs.flatMap((c) => {
      const ch = keyChanges(c).filter((q) => q.x > -Infinity);
      return ch.map((q, i) => ({ c, x: q.x, fifths: q.fifths, syms: c.key.filter((k) => k.box.left >= q.x && (i + 1 >= ch.length || k.box.left < ch[i + 1].x)) }));
    });
    const used = new Set<(typeof mids)[number]>();
    for (const m of mids) {
      if (used.has(m)) continue;
      const near = mids.filter((o) => !used.has(o) && Math.abs(o.x - m.x) <= sp * MID_KEY_DX);
      for (const o of near) used.add(o);
      if (new Set(near.map((o) => o.c)).size < 2) continue;
      const votes = new Map<number, number>();
      for (const o of near) votes.set(o.fifths, (votes.get(o.fifths) ?? 0) + 1);
      const [best, n] = [...votes].sort((a, b) => b[1] - a[1])[0];
      if ([...votes.values()].filter((v) => v === n).length > 1) continue;
      const ref = near.find((o) => o.fifths === best)!;
      for (const c of cs) {
        const mine = near.filter((o) => o.c === c);
        if (mine.length && mine.every((o) => o.fifths === best)) continue;
        const drop = new Set(mine.flatMap((o) => o.syms));
        c.key = [...c.key.filter((k) => !drop.has(k)), ...ref.syms].sort((a, b) => a.box.left - b.box.left);
      }
    }
  }
}

/**
 * **一像素细笔的还原号按两根错开的竖笔补认**（望十架 p7 m55：五行谱十来个 F♮、C♮，去线后横笔断成碎点，
 * 字典一个也没认出，整小节按调号读成 F♯、C♯）。只补「按调号或本小节前文会变音」、又没挂临时记号的音：
 * 符头左边 1.6 格内找两根细竖笔——宽不过 0.3 格、高 1.5~3.3 格，左高右低各错开 0.3 格以上、相距 0.3~0.9 格，
 * 左笔上端在符头中心上方 0.8~2.2 格、右笔下端在下方 0.8~2.2 格（还原号上半左笔、下半右笔，符头在中间那格）。
 * 两笔都不能是别的音的符干（符干上端或下端挨着符头）。
 */
export function naturalsByStrokes(pg: SPage, ctx: Map<Staff, StaffContext>, notes: StaffNote[], bin: Binary, sp: number): void {
  let hit = false;
  const heads = notes.filter((n) => !n.rest).map((n) => n.sym.box);
  // 竖笔一端挨着某个符头就是符干
  const isStem = (s: { x0: number; x1: number; top: number; bottom: number }) =>
    heads.some((b) => s.x1 >= b.left - 2 && s.x0 <= b.right + 2 && ((s.top >= b.top - 3 && s.top <= b.bottom + 3) || (s.bottom >= b.top - 3 && s.bottom <= b.bottom + 3)));
  for (const n of notes) {
    if (n.rest || n.accidental !== null || n.alter === 0) continue;
    const b = n.sym.box;
    const py = n.sym.py;
    const x0 = Math.max(0, Math.round(b.left - sp * 1.6));
    const y0 = Math.max(0, Math.round(py - sp * 2.4));
    const zone = { x: x0, y: y0, w: Math.max(0, Math.round(b.left) - 1 - x0), h: Math.min(bin.h - y0, Math.round(sp * 4.8)) };
    const ss = verticalStrokes(bin, zone, sp * 1.5).filter((s) => s.x1 - s.x0 + 1 <= sp * 0.3 && s.h <= sp * 3.3 && !isStem(s));
    const ok = ss.some((l) =>
      ss.some((r) => {
        const dx = r.x0 - l.x1;
        return (
          dx >= sp * 0.3 && dx <= sp * 0.9 &&
          r.top - l.top >= sp * 0.3 && r.bottom - l.bottom >= sp * 0.3 &&
          py - l.top >= sp * 0.8 && py - l.top <= sp * 2.2 &&
          r.bottom - py >= sp * 0.8 && r.bottom - py <= sp * 2.2
        );
      }),
    );
    if (!ok) continue;
    n.accidental = 0;
    hit = true;
  }
  if (hit) calcAlters(pg, ctx, notes);
}

/**
 * **临时记号按音高找主人**（位图路整个重分一遍，不动 `staffomr`）。两处不合用：
 *   - `analyzeAccidental` 要记号右缘到符头左缘不到半格、`buildNotes` 套用时又卡一格之内——
 *     齐来称颂这本谱实测 0.62~1.13 格（m3 E♯3、m7 D♯4、m13 的 C♮4 与 D♯3），认出来了也挂不上，全按调号读；
 *   - `buildNotes` 套用只看**盒子上下交叠**，升号盒有三格高，和弦里下面那个音也被盖进去
 *    （赞美三一真神 m8 F♯3 的升号给了 B2、m9 F♯3 的给了 D3）。
 * 这里按**同高**（中心差 ≤ 四分之一格；降号盒已收到肚子上）找右边第一个音，间隙放到 1.5 格：
 * 和弦里错开排的记号（还原号在上、升号在左下）各找各的。调号（`ctx.key`）不参与，重分完重算变音。
 */
export function attachAccidentalsByPitch(pg: SPage, ctx: Map<Staff, StaffContext>, notes: StaffNote[]): void {
  const sp = pg.normalStaffSpace || pg.space;
  const keys = new Set([...ctx.values()].flatMap((c) => c.key));
  for (const n of notes) n.accidental = null;
  const taken = new Set<Sym>();
  const between = pg.symbols.filter((a) => isAccidental(a.code) && !keys.has(a));
  for (const a of pg.symbols) {
    if (!isAccidental(a.code) || keys.has(a)) continue;
    let best: StaffNote | null = null;
    let bd = Infinity;
    for (const n of notes) {
      if (n.rest || taken.has(n.sym)) continue;
      if (Math.abs(n.sym.py - a.py) > sp / 4) continue;
      let gap = n.sym.box.left - a.box.right;
      // 和弦里错开排的记号：中间隔着的别的临时记号宽度不算（望十架 p7 m55 还原号在降号左边，离 F 头 1.9 格）
      for (const o of between) if (o !== a && o.box.left >= a.box.right - 2 && o.box.right <= n.sym.box.left + 2 && Math.abs(o.py - a.py) <= sp * 3) gap -= o.box.right - o.box.left;
      if (gap < -2 || gap > sp * LOOSE_ACC_GAP || gap >= bd) continue;
      best = n;
      bd = gap;
    }
    if (!best) continue;
    // 同一个头拆出来的同音两声部一起填
    for (const n of notes) if (n.sym === best.sym) n.accidental = accidentalAlter(a.code);
    taken.add(best.sym);
    a.addTag("Accidental");
  }
  calcAlters(pg, ctx, notes);
}

/**
 * **调号不全的谱行照抄同页的**：整首不转调是常态，同页各行调号本该一样。
 * 取**至少两行认得一模一样**的调号里最长的那个，一个都没认出、或只认出同类（全升/全降，
 * 可夹着认岔的还原号）前几个的谱行照它补齐。
 *
 *   - 颂赞与尊贵第一行的降号贴着高音谱号，去谱线后残留的一行墨把两者连成一块，
 *     被谱号盒整个吞掉；导出取第一行的调号，整首按 C 大调读、再按调号差移调，字母全错。
 *   - 齐来称颂的低音谱表三个升号，后两个在调号那一步已被别的路认领（当成符头），
 *     两行低音谱表只认出一个，G# 全读成 G。
 */
/**
 * **全页一个调号都没认出、和弦却指向别的调**：按和弦拼写补调号。
 *
 * 病例《主我敬拜你》（粗体铅字本）：F 大调的那一个降号印得极小、压在高音谱号右侧的弯钩上，
 * 与谱号连成一块，按块分不出来；六行全按 C 大调读，B♭ 全成了 B。可谱面上的和弦是
 * F、C/E、Dm、B♭、Gm7、C7……——**和弦的根音与低音是按调拼写的**，B♭ 这种拼写本身就说明了调。
 *
 * 做法：数根音与斜线后的低音，挑能容纳最多个的调（同分取升降号少的）。
 * 只在三件事都成立时才补：全页没有任何调号、和弦记号至少六个、那个调比 C 大调多容纳至少两个、
 * 带升降号拼写的根音至少两次、且容纳了八成以上——临时变化的和弦（副属和弦的根音）只是零星几个，推不动。
 */
export function keyFromChords(pg: SPage, ctx: Map<Staff, StaffContext>, texts: string[], unit: { space: number; height: number }): void {
  const all = [...ctx.values()];
  if (!all.length || all.some((c) => c.key.length)) return;
  const notes: string[] = [];
  for (const t of texts)
    for (const m of t.matchAll(/(^|\/)([A-G])([#b♯♭]?)/g)) notes.push(m[2] + (m[3] === "#" || m[3] === "♯" ? "#" : m[3] ? "b" : ""));
  if (notes.length < 6) return;
  const scale = (f: number) =>
    new Set(
      "CDEFGAB".split("").map((l) =>
        f > 0 && "FCGDAEB".slice(0, f).includes(l) ? l + "#" : f < 0 && "BEADGCF".slice(0, -f).includes(l) ? l + "b" : l,
      ),
    );
  const score = (f: number) => {
    const sc = scale(f);
    return notes.filter((n) => sc.has(n)).length;
  };
  let best = 0;
  for (let f = -6; f <= 6; f++) if (score(f) > score(best) || (score(f) === score(best) && Math.abs(f) < Math.abs(best))) best = f;
  // 带升降号拼写的根音（B♭、F♯……）至少出现两次，才算和弦「说出了」调号；
  // 差额只要两个：OCR 常把 B♭ 读岔成 B6 之类，抵掉一个（《主我敬拜你》39 比 37）
  const spelled = notes.filter((n) => n.length === 2 && scale(best).has(n)).length;
  if (best === 0 || spelled < 2 || score(best) < score(0) + 2 || score(best) < notes.length * 0.8) return;
  const code: SmuflName = best > 0 ? "accidentalSharp" : "accidentalFlat";
  for (const c of all) {
    if (!c.clef) continue;
    const cb = c.clef.box;
    c.key = Array.from({ length: Math.abs(best) }, (_, i) => {
      const box = { x: cb.right + 1 + i * unit.space * 0.8, y: cb.top, w: unit.space * 0.7, h: unit.space * 2.5 };
      return makeSymObj(pg.objs.length + pg.segs.length + 1 + i, { box, code }, unit.height).sym;
    });
  }
}

/**
 * **和弦根音的降号读成了 6**：OCR 把「B♭」读成「B6」（《主我敬拜你》F 大调，B♭ 和弦两处都是）。
 * 调号定了之后按调纠：根音字母的**本音不在调内、降音在调内**，后面紧跟的 6 就是那个降号。
 * 调内有这个本音的（C 大调的 B6、G 大调的 E6）不动——那可能真是六和弦。
 */
export function fixFlatReadAsSix(harmonies: HarmonyToken[], ctx: Map<Staff, StaffContext>): void {
  const c0 = [...ctx.values()].find((c) => c.key.length);
  const f = c0 ? keyFifths(c0.key) : 0;
  if (f >= 0) return;
  const flats = "BEADGCF".slice(0, -f);
  for (const h of harmonies) {
    const m = /^([A-G])6(.*)$/.exec(h.text);
    if (m && flats.includes(m[1])) h.text = `${m[1]}b${m[2]}`;
  }
}

/**
 * **调号跨页沿用**：续页的调号常印得淡、被去线切碎，只认出头一个（倚靠主永远膀臂第二页 4♭ 两行都只认出 1 个）。
 * 本页认出的调号与上一页同种、个数更少的，按上一页补足个数（拿本页已认出的最后一个记号重复补——
 * 下游只按个数算变音，记号位置取的是最右那个的右缘，重复不改它）。
 * 本页整页没认出调号的不管（`calcAlters` 本就沿用上一行；跨页那一截另说）。
 *
 * **补之前先看后面有没有墨**：记号少了也可能是真转调（望十架第 10 小节起五个降号转一个，
 * 一路补成五个补到第 6 页）。漏认的记号墨还在纸上；转调后的调号右边是空的。
 * 认出的最后一个记号右边 `CARRY_GAP` 到 `CARRY_REACH` 格里（传自别的行的调号到记号自己那一行去看），有一列在谱线之外的墨够 `CARRY_INK` 格
 *（升降号的竖笔）才补；漏的是中间一个时后面没有墨，认出的几个从头到尾已有上一页那个个数那么宽
 *（每个记号 `CARRY_PITCH` 格）的也补（烛光颂曲 p6 六个降号十行都读成五个）。
 */
const CARRY_GAP = 0.1;

const CARRY_REACH = 1.6;

const CARRY_INK = 1;

const CARRY_PITCH = 0.85;

export function extendKeyByCarry(ctx: Map<Staff, StaffContext>, carry: CarryKey | undefined, bin: Binary, sp: number): void {
  if (!carry) return;
  for (const c of ctx.values()) {
    // 只看行首那段（行中转调的记号另算，见 `keyChanges`）
    const head = headKey(c);
    if (!head.length || head.length >= carry.n) continue;
    if (!head.every((k) => k.code === carry.code)) continue;
    const last = head[head.length - 1];
    // 漏在中间的（认出的几个已经占满上一页那个个数的宽度）后面没墨也补
    const span = last.box.right - Math.min(...head.map((k) => k.box.left));
    // 调号可能是别的行传过来的（`carrySystemKeys`），墨要到记号自己那一行去看
    const cy = (last.box.top + last.box.bottom) / 2;
    const home = [...ctx.values()].reduce((a, q) => (Math.abs(staffMid(q) - cy) < Math.abs(staffMid(a) - cy) ? q : a), c);
    if (span < sp * CARRY_PITCH * (carry.n - 0.5) && !inkPastKey(bin, home.staff.lineYs, last.box.right, sp)) continue;
    c.key = [...head, ...Array.from({ length: carry.n - head.length }, () => last), ...c.key.filter((k) => !head.includes(k))];
  }
}

const staffMid = (c: StaffContext) => (c.staff.lineYs[0] + c.staff.lineYs[c.staff.lineYs.length - 1]) / 2;

/** 调号最后一个记号右边还有没有像升降号竖笔的墨（见 `extendKeyByCarry`）。 */
function inkPastKey(bin: Binary, lineYs: number[], right: number, sp: number): boolean {
  if (lineYs.length < 2) return true;
  const y0 = Math.max(0, Math.round(lineYs[0] - sp * 1.5));
  const y1 = Math.min(bin.h - 1, Math.round(lineYs[lineYs.length - 1] + sp * 1.5));
  const onLine = (y: number) => lineYs.some((ly) => Math.abs(y - ly) <= sp * 0.2);
  for (let x = Math.round(right + sp * CARRY_GAP); x <= Math.min(bin.w - 1, Math.round(right + sp * CARRY_REACH)); x++) {
    let n = 0;
    // 扫描件的竖笔歪歪扭扭，一列看不全：相邻三列有一列是墨就算
    for (let y = y0; y <= y1; y++) if (!onLine(y) && (bin.data[y * bin.w + x - 1] || bin.data[y * bin.w + x] || bin.data[y * bin.w + x + 1])) n++;
    if (n >= sp * CARRY_INK) return true;
  }
  return false;
}

/** 这一页最后一行认出的调号（同种记号才算），没有就沿用上一页的。 */
export function lastKey(pg: SPage, ctx: Map<Staff, StaffContext>, carry: CarryKey | undefined): CarryKey | undefined {
  for (let i = pg.staves.length - 1; i >= 0; i--) {
    const k = ctx.get(pg.staves[i])?.key ?? [];
    if (k.length && k.every((q) => q.code === k[0].code) && (k[0].code === "accidentalFlat" || k[0].code === "accidentalSharp")) return { code: k[0].code, n: k.length };
  }
  return carry;
}

/**
 * **调号共享的分段**：按竖笔定调、全页共享、按系统传，都立在「整页一个调」上。一页印好几首短曲（新编赞美诗 400 阿们颂：
 * 四首各自 1♯、4♭、1♭、4♭），全页过半的四个降号把另两首也改了。一首歌只在结尾印终止线、只在头一个系统印拍号，所以
 * **上一个系统以终止线收尾**、或**整个系统每行都在行首重印拍号**的，从它起另开一段，各段分头共享。
 * 拍号这一条单靠不住（400 四首只有一首的拍号认成了拍号符号），终止线回原图量（`endsWithFinal`，这时小节线样式还没定）。
 * 只有一段的页原样返回整个 `ctx`（判据一个像素不变）。
 */
export function keySections(pg: SPage, ctx: Map<Staff, StaffContext>, bin: Binary): Map<Staff, StaffContext>[] {
  const groups = systemGroups(pg).sort((a, b) => a[0].box.top - b[0].box.top);
  // 行首的拍号：认出了拍号数字、且落在谱表左端往右 `HEAD_TIME_SP` 格以内（行中换拍不算新段）
  const headTime = (st: Staff) => {
    const c = ctx.get(st);
    if (!c?.time.length || st.lineYs.length !== 5) return false;
    const sp = (st.lineYs[4] - st.lineYs[0]) / 4;
    return Math.min(...c.time.map((t) => t.box.left)) < st.box.left + sp * HEAD_TIME_SP;
  };
  const secs: Staff[][] = [];
  groups.forEach((g, i) => {
    const prev = groups[i - 1];
    const fin = !!prev && prev.filter((st) => endsWithFinal(st, bin)).length * 2 > prev.length;
    if (!secs.length || fin || (i > 0 && g.every(headTime))) secs.push([]);
    secs[secs.length - 1].push(...g);
  });
  if (secs.length < 2) return [ctx];
  return secs.map((sts) => new Map(sts.filter((st) => ctx.has(st)).map((st) => [st, ctx.get(st)!] as [Staff, StaffContext])));
}

/**
 * **同一系统各行的调号相同**：三行以上的系统里，认得一模一样的调号行数最多（至少两行、且比别的读法都多）的那个，
 * 就是这个系统的调号，其余行照它改。返回这样定下来的谱行——它们不再参加全页那一道共享。
 *
 * 全页共享立在「整首不转调」上；合唱谱曲中转调时，同页前后两段调号不同，按全页最长的那个补，
 * 转调前的几个系统全被改成新调（爱是从神而来 p4：前两个系统一个降号、末系统三个降号，十二行全读成三个降号）。
 * 而一个系统里四行各自认出同一个调号，是四份独立的证据，比别的系统的读数可靠。
 * 顺带把系统里个别读岔的行拉回来（同页第二系统女声行，行首 C♯ 的临时升号被并进调号读成一个升号）。
 * 只管三行以上的系统：两行的大谱表上下两行常一起漏认同一个记号，仍交给全页那一道。
 */
export function shareSystemKeys(pg: SPage, ctx: Map<Staff, StaffContext>): Set<StaffContext> {
  const settled = new Set<StaffContext>();
  const sigOf = (c: StaffContext) => headKey(c).map((k) => k.code).join(",");
  for (const g of systemGroups(pg)) {
    if (g.length < 3) continue;
    const cs = g.map((st) => ctx.get(st)).filter((c): c is StaffContext => !!c);
    const count = new Map<string, number>();
    for (const c of cs) if (headKey(c).length) count.set(sigOf(c), (count.get(sigOf(c)) ?? 0) + 1);
    const ranked = [...count].sort((a, b) => b[1] - a[1]);
    if (!ranked.length || ranked[0][1] < 2 || (ranked[1] && ranked[1][1] === ranked[0][1])) continue;
    const best = headKey(cs.find((c) => headKey(c).length && sigOf(c) === ranked[0][0])!);
    if (best.some((k) => k.code !== best[0].code)) continue;
    for (const c of cs) {
      if (sigOf(c) !== ranked[0][0]) setHeadKey(c, best);
      settled.add(c);
    }
  }
  return settled;
}

/**
 * **按系统定下来的调号往没定的行传**：`shareSystemKeys` 定了调号的系统不参加全页共享，页上别的行
 * （一行没认出的系统、认岔的两行大谱表）就没处借了。调号管到下一次改之前，所以没定的行照**上一个**定了的系统补
 * （页首没有上一个的照下一个）：
 *   - 一个记号都没认出的行、认出的是它的前几个的行，补足；
 *   - 读法不同的行，同一系统里有别的行与它一致才改（同一系统各行调号相同，两行互证；
 *     烛光颂曲低音谱表把头一个降号的肚子读成一个升号）。
 * 曲中转成 C 大调的系统本来就没有调号，会被补上前一个调——这样的谱还没遇到，遇到了要另看还原号。
 */
export function carrySystemKeys(pg: SPage, ctx: Map<Staff, StaffContext>, settled: Set<StaffContext>): void {
  const groups = systemGroups(pg).map((g) => g.map((st) => ctx.get(st)).filter((c): c is StaffContext => !!c));
  const keyOf = groups.map((cs) => { const c = cs.find((c) => settled.has(c) && headKey(c).length); return c ? headKey(c) : undefined; });
  const sigOf = (k: Sym[]) => k.map((q) => q.code).join(",");
  // 没有哪个系统定下来的页（全是两行的大谱表）：过半的行读成同一个调号的，拿它当参照
  let pageRef: Sym[] | undefined;
  if (!settled.size) {
    const all = groups.flat();
    const count = new Map<string, number>();
    for (const c of all) if (headKey(c).length) count.set(sigOf(headKey(c)), (count.get(sigOf(headKey(c))) ?? 0) + 1);
    const top = [...count].sort((a, b) => b[1] - a[1])[0];
    const k = top && top[1] * 2 > all.length ? headKey(all.find((c) => sigOf(headKey(c)) === top[0])!) : undefined;
    if (k && k.every((q) => q.code === k[0].code)) pageRef = k;
    if (!pageRef) return;
  }
  for (const [i, cs] of groups.entries()) {
    if (keyOf[i]) continue;
    const ref = pageRef ?? keyOf.slice(0, i).reverse().find((k) => k) ?? keyOf.slice(i + 1).find((k) => k);
    if (!ref) continue;
    const want = sigOf(ref);
    const isPrefix = (c: StaffContext) => headKey(c).length < ref.length && headKey(c).every((k, j) => k.code === ref[j].code);
    // 作证的行：读得与它一样，或认出了它的前几个
    const agree = cs.some((c) => sigOf(headKey(c)) === want || (headKey(c).length > 0 && isPrefix(c)));
    for (const c of cs) if (isPrefix(c)) setHeadKey(c, ref);
    // 读法不同的行：有作证的行、或补过之后过半的行都是它，才改
    const same = cs.filter((c) => sigOf(headKey(c)) === want).length;
    // 比它多认出几个同种记号的行不收回来——按块、按笔数出来的个数只会少不会多
    const longer = (c: StaffContext) => headKey(c).length > ref.length && headKey(c).every((k) => k.code === ref[0].code);
    if (agree || same * 2 > cs.length) for (const c of cs) if (!longer(c)) setHeadKey(c, ref);
  }
}

export function shareKeySignature(ctx: Map<Staff, StaffContext>, settled = new Set<StaffContext>()): void {
  const all = [...ctx.values()].filter((c) => !settled.has(c));
  const sigOf = (c: StaffContext) => headKey(c).map((k) => k.code).join(",");
  const count = new Map<string, number>();
  for (const c of all) if (headKey(c).length) count.set(sigOf(c), (count.get(sigOf(c)) ?? 0) + 1);
  let best: StaffContext | null = null;
  for (const c of all) if (headKey(c).length && count.get(sigOf(c))! >= 2 && (!best || headKey(c).length > headKey(best).length)) best = c;
  // 最长的那个只出现一次也行——只要别的行（至少两行）认出的都是它的**前几个**：
  // 敬拜万世之王五行里一行认出两个降号、四行只认出头一个（第二个降号被去谱线切碎）
  const longest = all.filter((c) => headKey(c).length).sort((a, b) => headKey(b).length - headKey(a).length)[0];
  const others = all.filter((c) => headKey(c).length && c !== longest);
  // 混着两种记号的不当「最长」：行首调号不会升降混排，那是多认了一个（我灵镇静第三行低音谱表「♭♯」，
  // 选中它后整条共享因混排作罢，另两行低音谱表的 1♭ 都没补上）
  const pure = (c: StaffContext) => headKey(c).every((k) => k.code === headKey(c)[0].code);
  if (longest && pure(longest) && others.length >= 2 && (!best || headKey(longest).length > headKey(best).length) && others.every((c) => headKey(c).every((k, i) => k.code === headKey(longest)[i]?.code)))
    best = longest;
  if (!best) return;
  const bk = headKey(best);
  const kind = bk[0].code;
  if (bk.some((k) => k.code !== kind)) return;
  // 串里混着**还原号**的也照补：行首谱号后面的调号不会有还原号（取消记号印在转调前的小节线处），
  // 那是粘连的升降号认岔了——万福泉源歌第一行三个降号挤在一起，前两个连成一块读成还原号，
  // 这一行（也就是整首高音声部）只剩一个降号
  for (const c of all) {
    const h = headKey(c);
    if (h.length <= bk.length && h.every((k) => k.code === kind || k.code === "accidentalNatural") && h.filter((k) => k.code === kind).length < bk.length)
      setHeadKey(c, bk);
    // 前面几个与共享的那串一致、后面跟着异种记号的：后面那几个是多认的
    else if (h.length > bk.length && bk.every((_, i) => h[i]?.code === kind) && h.slice(bk.length).every((k) => k.code !== kind))
      setHeadKey(c, bk);
  }
}

/** 两个盒的交叠占 `a` 的比例。 */
/**
 * **按竖笔数调号升号**（Audiveris 的路子：不看连通块，看竖笔）。粗体升号两两粘连、又贴着谱号时，
 * 按块认不出来（《耶和华是我的牧者》：一对升号连成 2.3×4.8 格一块，被读成一串降号、假符头）。
 *
 * 在带谱线的原图上，从谱号左缘起 `KEY_FROM` 格（谱号盒吞了升号时按正常谱号宽度起算）往右，逐列找
 * 2 格以上的竖直连续墨；两根相距 0.15~0.8 格、中列在竖笔中点上下各有一道厚 0.25 格以上横杠的是一个升号。
 * 串从头起、相邻不隔 1.6 格；碰到别的竖笔（降号、符干、拍号）就停。返回各升号的盒（两根竖笔围的那一段）。
 */
export function sharpsByStrokes(bin: Binary, lineYs: number[], clef: Rect, sp: number): Rect[] {
  const top = lineYs[0];
  const bottom = lineYs[lineYs.length - 1];
  const x0 = Math.round(clef.x + Math.min(clef.w, sp * KEY_FROM));
  const box: Rect = { x: x0, y: Math.max(0, Math.round(top - sp * 1.5)), w: Math.round(sp * 9), h: Math.round(bottom - top + sp * 3) };
  if (box.x + box.w > bin.w || box.y + box.h > bin.h) return [];
  const strokes = verticalStrokes(bin, box, sp * 2);
  // 中列上厚 0.25 格以上的横杠，要**一道在竖笔中点以上、一道在以下**：相邻两个降号的竖笔也相距半格多，
  // 中列穿过前一个降号的肚子也是两道墨，可那两道都在竖笔下半截（《所信有根基》四个降号被数成两个升号）
  const barsAcross = (xm: number, t: number, b: number): boolean => {
    const mid = (t + b) / 2;
    let up = false;
    let dn = false;
    let run = 0;
    for (let y = box.y; y <= box.y + box.h; y++) {
      if (y < box.y + box.h && bin.data[y * bin.w + xm]) run++;
      else {
        if (run >= sp * 0.25) {
          const c = y - run / 2;
          if (c < mid) up = true;
          else dn = true;
        }
        run = 0;
      }
    }
    return up && dn;
  };
  const out: Rect[] = [];
  let lastX = x0;
  for (let i = 0; i + 1 < strokes.length; i += 2) {
    const a = strokes[i];
    const b = strokes[i + 1];
    if (a.h > sp * 3.6 || b.h > sp * 3.6) break;
    const d = (b.x0 - a.x1) / sp;
    if (d < 0.15 || d > 0.8) break;
    if ((a.x0 - lastX) / sp > (out.length ? 1.6 : 2.5)) break;
    if (!barsAcross(Math.round((a.x1 + b.x0) / 2), Math.min(a.top, b.top), Math.max(a.bottom, b.bottom))) break;
    const t = Math.min(a.top, b.top);
    // 横杠左右各探出竖笔约 0.2 格：盒按竖笔量会窄一截，调号串按盒缝判连续，窄了就在第三个上断开（齐来称颂 3 → 2 个）
    const pad = Math.round(sp * 0.2);
    out.push({ x: a.x0 - pad, y: t, w: b.x1 - a.x0 + 1 + pad * 2, h: Math.max(a.bottom, b.bottom) - t + 1 });
    lastX = b.x1;
  }
  return out;
}

/**
 * **调号按竖笔补足个数**（`flatsByStrokes` / `sharpsByStrokesLoose`）：三四个升降号挤在一起、笔画又淡时，
 * 按块只认出一两个，各行认出的个数还不一样，整首被当成移调（新编赞美诗 11 荣归天父歌四个降号各行读成
 * -1/-2/0；35 大哉圣名歌一个升号一行都没认出）。
 * 竖笔数的毛病是**数少**（淡笔断开就少一根），所以**只增不减**：取「至少两行数到这么多」的最大个数 k，
 * 数到 k 以上、而按块认出的同种记号不足 k 的行补到 k；别的行由 `shareKeySignature` 接着补。
 * 升降两种都数出来时取作证行数多的那种；已认出另一种记号的行不动。
 */
export function extendKeyByStrokes(pg: SPage, ctx: Map<Staff, StaffContext>, bin: Binary, unit: { space: number; height: number; lineThick?: number }): void {
  const rows: { c: StaffContext; flats: Rect[]; sharps: Rect[] }[] = [];
  for (const c of ctx.values()) {
    if (!c.clef || c.staff.lineYs.length !== 5) continue;
    const cb = c.clef.box;
    const clef = { x: cb.left, y: cb.top, w: cb.right - cb.left, h: cb.bottom - cb.top };
    const bass = c.clef.code === "fClef";
    let flats = flatsByStrokes(bin, c.staff.lineYs, clef, bass, unit.space, unit.lineThick ?? 0);
    // 粗线低分辨率页：高音谱号的行另按探出谱表的竖笔数一遍，取多的（见 `flatsByStairs`）
    if (!bass && isCoarseKey(unit.space, unit.lineThick ?? 0)) {
      const st = flatsByStairs(bin, c.staff.lineYs, clef, unit.space, unit.lineThick ?? 0);
      if (st.length > flats.length) flats = st;
    }
    rows.push({
      c,
      flats,
      sharps: sharpsByStrokesLoose(bin, c.staff.lineYs, clef, bass, unit.space),
    });
  }
  const pick = (of: (r: (typeof rows)[number]) => Rect[]) => {
    for (let n = 7; n >= 1; n--) {
      const m = rows.filter((r) => of(r).length >= n).length;
      if (m >= 2) return { k: n, m };
    }
    return { k: 0, m: 0 };
  };
  let f = pick((r) => r.flats);
  const sh = pick((r) => r.sharps);
  // **只有一行数全的降号也认**：短歌只有两三个系统，各行淡得不一样，常常只有一行数得全（我要向山举目歌 4,1,0）。
  // 降号的对位够严（肚子要逐个落在 B E A D… 的位置上；漏一根的容许也要后面跟着两个真的），三个以上一行就算数；
  // 这种页行数少（六行以内），全页照它定。
  let lone = false;
  {
    const best = rows.reduce((a, r) => Math.max(a, r.flats.length), 0);
    // 已有两行数到三个以上的不让单行的盖过去，只比两行作证的多一个的也不算：多出来的那一个是头一行拍号数字的竖笔
    //（新年欢喜歌 4,3,3,3；夜晚觐主歌 3,2,2,2,2,2）
    if (best >= 3 && best >= f.k + 2 && f.k < 3 && rows.length <= 6 && !sh.k) (f = { k: best, m: 1 }), (lone = true);
  }
  if (!f.k && !sh.k) return;
  // 升降两种都数出来时，取各行数出的总数多的那种
  const total = (of: (r: (typeof rows)[number]) => Rect[]) => rows.reduce((a, r) => a + of(r).length, 0);
  const useSharp = sh.k > 0 && (!f.k || total((r) => r.sharps) > total((r) => r.flats));
  const { k, m } = useSharp ? sh : f;
  const code: SmuflName = useSharp ? "accidentalSharp" : "accidentalFlat";
  const strokesOf = (r: (typeof rows)[number]) => (useSharp ? r.sharps : r.flats);
  // 只看**行首**那段调号：行中转调的记号（`keyChanges`）不算「混着别种」，改行首时也原样留着
  const headOf = headKey;
  const midOf = (c: StaffContext) => {
    const head = new Set(headOf(c));
    return c.key.filter((q) => !head.has(q));
  };
  const countOf = (c: StaffContext) => headOf(c).filter((q) => q.code === code).length;
  const setKey = (c: StaffContext, boxes: Rect[]) => {
    const mid = midOf(c);
    c.key = boxes.map((box, i) => {
      const sym = makeSymObj(pg.objs.length + pg.segs.length + 1 + i, { box, code }, unit.height).sym;
      sym.addTag("Key");
      return sym;
    });
    c.key.push(...mid);
  };
  // **同一系统里至少两行按块认出一模一样的另一种调号的，这个系统另有自己的调**，不拿全页数出来的盖：
  // 竖笔数的是全页，可一页上会转调（望十架 p7 上一个系统两个升号、下一个系统转一个降号，
  // 五行认得齐齐的两个升号被全页过半的一个降号整个盖掉）
  const own = new Set<StaffContext>();
  for (const g of systemGroups(pg)) {
    const cs = g.map((st) => ctx.get(st)).filter((c): c is StaffContext => !!c);
    const count = new Map<string, number>();
    for (const c of cs) {
      const h = headOf(c);
      if (!h.length || h.some((q) => q.code !== h[0].code) || h[0].code === code || (h[0].code !== "accidentalFlat" && h[0].code !== "accidentalSharp")) continue;
      const sig = `${h[0].code}${h.length}`;
      count.set(sig, (count.get(sig) ?? 0) + 1);
    }
    if ([...count.values()].some((v) => v >= 2)) for (const c of cs) own.add(c);
  }
  // **按块多认的收回来**：比 k 多的行只是少数（不到三分之一）、而竖笔没有哪一行数过 k——多出来的是调号后面
  // 头一个音的临时记号（三博士歌一个升号，有一行按块读成三个，`shareKeySignature` 见别的行都是它的前缀就全页照它补）
  const maxStroke = Math.max(...rows.map((r) => strokesOf(r).length));
  const longer = rows.filter((r) => countOf(r.c) > k);
  if (maxStroke <= k && longer.length && longer.length * 3 <= rows.length) for (const r of longer) r.c.key = [...headOf(r.c).filter((q) => q.code === code).slice(0, k), ...midOf(r.c)];
  // **过半的行都数到 k**：全页照它定——混着别种记号的行（主恩更多歌头一行「♯♭」）、一个都没认出的行也补上
  const strong = (m >= 2 && m * 2 >= rows.length) || lone;
  for (const r of rows) {
    const c = r.c;
    if (own.has(c)) continue;
    const got = strokesOf(r);
    const mixed = headOf(c).some((q) => q.code !== code);
    if (!mixed && countOf(c) >= k) continue;
    // 混着别种记号的行：自己数到了 k（有福确据歌头一行按块读成一个降号、竖笔数出两个升号）或全页已定，才改
    if (mixed && !strong && got.length < k) continue;
    if (got.length >= k) setKey(c, got.slice(0, k));
    else if (strong) {
      // 自己没数全：从谱号右边起按固定间距摆 k 个（下游只按个数算变音、取最右那个的右缘）
      const cb = c.clef!.box;
      const x = got[0]?.x ?? cb.right + unit.space * 0.4;
      setKey(c, Array.from({ length: k }, (_, i) => ({ x: x + i * unit.space * 0.85, y: c.staff.box.top, w: unit.space * 0.8, h: unit.space * 2.5 })));
    }
  }
}

/**
 * 调号区（谱号后 9 格）的竖笔。升降号的竖笔细、常略斜、印得淡，逐列量最长竖墨会在换列处、淡处断成两截不够高：
 * 左右各抹宽一像素、容 0.25 格断口再量。代价是**两端不可靠**（会顺着谱线、肚子的弧接下去），
 * 所以对位一律不靠端点（降号看肚子、升号看整组中心）。
 * 试过在这一块里另按松阈值二值一遍（纸色往墨色走 35%）：谱线跟着变粗，竖笔与肚子、谱线粘成一片，
 * 数出来的反而更少（荣归天父歌各行 4 → 0~3），已撤；整页并回纵向长笔画也试过（前 60 首 25 升 25 降）。
 * 返回的坐标是整页的。
 */
function keyZoneStrokes(bin: Binary, lineYs: number[], clef: Rect, sp: number, minH: number, maxW = 0.5): { x0: number; strokes: ReturnType<typeof verticalStrokes>; ink: (x: number, y: number) => boolean } | null {
  const top = lineYs[0];
  const bottom = lineYs[lineYs.length - 1];
  const x0 = Math.round(clef.x + Math.min(clef.w, sp * KEY_FROM));
  const box: Rect = { x: x0, y: Math.max(0, Math.round(top - sp * 2)), w: Math.round(sp * 9), h: Math.round(bottom - top + sp * 3.5) };
  if (box.x + box.w > bin.w || box.y + box.h > bin.h) return null;
  const zone = new Uint8Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) zone[y * box.w + x] = bin.data[(box.y + y) * bin.w + box.x + x];
  const smear: Binary = { w: box.w, h: box.h, data: new Uint8Array(box.w * box.h) };
  for (let y = 0; y < box.h; y++)
    for (let x = 0; x < box.w; x++) {
      const i = y * box.w + x;
      if (zone[i] || (x > 0 && zone[i - 1]) || (x + 1 < box.w && zone[i + 1])) smear.data[i] = 1;
    }
  const strokes = verticalStrokes(smear, { x: 0, y: 0, w: box.w, h: box.h }, minH, Math.max(2, Math.round(sp * 0.25)))
    .map((k) => ({ ...k, x0: k.x0 + box.x, x1: k.x1 + box.x, top: k.top + box.y, bottom: k.bottom + box.y }))
    .filter((k) => k.x1 - k.x0 + 1 <= sp * maxW);
  const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < bin.w && y < bin.h && bin.data[y * bin.w + x] === 1;
  return { x0, strokes, ink };
}

/**
 * **按竖笔数调号升号（宽松版）**：`sharpsByStrokes` 逐列量竖墨、还要中列上下各一道横杠，淡印的细升号过不了
 *（新编赞美诗 35/43/44 一个升号、46 两个、48 三个，一行都数不出）。这里竖笔按 `keyZoneStrokes` 量，
 * 挨着的两根（够 1.6 格高）并成一组算一个升号；抹宽后并成一根的，左右两侧都要有横杠探出来的厚墨。再看**位置**：
 * 升号中心的高低照调号的固定次序走（F C G D A E B），头一个落在 F 的位置上。不合的那一组起就停。
 * 只给 `extendKeyByStrokes` 用（至少两行作证、只增不减）。
 */
function sharpsByStrokesLoose(bin: Binary, lineYs: number[], clef: Rect, bass: boolean, sp: number): Rect[] {
  const z = keyZoneStrokes(bin, lineYs, clef, sp, sp * 1.6);
  if (!z) return [];
  const { x0, strokes, ink } = z;
  // 各升号中心相对头一个（F）的高低（格，向下为正）
  const STEP = [0, 1.5, -0.5, 1, 2.5, 0.5, 2];
  // F 的位置：高音谱表第五线（最上一条），低音谱表第四线
  const fY = lineYs[bass ? 1 : 0];
  /** x 这一列在 cy 上下 0.9 格内有没有厚 0.22 格以上的一道墨——升号的横杠（谱线只有 0.1 格厚） */
  const thickRun = (x: number, cy: number) => {
    let run = 0;
    for (let y = Math.round(cy - sp * 0.9); y <= Math.round(cy + sp * 0.9) + 1; y++) {
      if (y <= Math.round(cy + sp * 0.9) && ink(x, y)) run++;
      else {
        if (run >= sp * 0.22) return true;
        run = 0;
      }
    }
    return false;
  };
  // 挨着的竖笔并成一组：一个升号两根竖笔相距 0.2~0.4 格，抹宽之后常只隔一两像素、甚至并成一根粗的
  const groups: { x0: number; x1: number; top: number; bottom: number; n: number }[] = [];
  for (const k of strokes) {
    const g = groups[groups.length - 1];
    if (g && k.x0 - g.x1 <= sp * 0.5 && g.n < 2) (g.x1 = k.x1), (g.top = Math.min(g.top, k.top)), (g.bottom = Math.max(g.bottom, k.bottom)), g.n++;
    else groups.push({ x0: k.x0, x1: k.x1, top: k.top, bottom: k.bottom, n: 1 });
  }
  const out: Rect[] = [];
  let lastX = x0;
  for (const g of groups) {
    // 低音谱号的两个点上下叠着、隔着 F 线，抹宽容断之后是一根正落在 F 位置上的竖笔（C 大调的页每行数出一个升号）
    if (bass && g.x0 < x0 + sp * 0.9) continue;
    if (out.length >= 7 || g.bottom - g.top > sp * 3.6) break;
    if ((g.x0 - lastX) / sp > (out.length ? 1.6 : 3.2)) break;
    const cy = (g.top + g.bottom) / 2;
    const w = g.x1 - g.x0 + 1;
    // 只量出一根的（另一根淡得不够高，或两根并成一根粗的），**左侧**要有横杠探出来的那道厚墨：
    // 降号的肚子只在右侧、符干两侧都没有（只看右侧或任一侧，降号页上每行都数出两个「升号」）
    const fits =
      w <= sp * 1.0 &&
      // 头一个卡 0.5 格；后面的放到 1 格——伸出谱表的那半截（G、A 的上端）没有谱线托着、印得淡，
      // 量出来的中心往谱表里偏（道路真理生命歌第三个升号偏下 0.9 格）
      Math.abs((cy - fY) / sp - STEP[out.length]) <= (out.length ? 1 : 0.5) &&
      (g.n === 2 || thickRun(g.x0 - Math.round(sp * 0.15), cy));
    if (!fits) {
      // 头一个之前的杂笔（谱号的边角）跳过；串起来之后不合就停
      if (!out.length) continue;
      break;
    }
    const pad = Math.round(sp * 0.2);
    out.push({ x: g.x0 - pad, y: g.top, w: w + pad * 2, h: g.bottom - g.top + 1 });
    lastX = g.x1;
  }
  return out;
}

/** `flatsByStairs` 的起点：谱号左缘往右最多这么多格（谱号盒吞了调号时按它封顶；高音谱号自己的头在 1.7 格处）。 */
const STAIR_FROM = 3.4;

/**
 * **粗线低分辨率页的降号按「探出谱表的竖笔」数**（只管高音谱号的行）。线距十来个像素时，降号的竖笔与肚子、
 * 相邻两个降号都糊在一起，`flatsByStrokes` 逐根对肚子的位置对不上（烛光颂曲六个降号各行数出 0~4 个）。
 * 谱表**上方**是白的：第 2、4 个降号（E、D）的竖笔顶端探出最上一条线，后一根比前一根矮半格、相隔两个身位，
 * 是一道下行的台阶；别的记号没有这个形状（升号 F、G 探出的高度是先低后高，符干、谱号的头比这宽或高）。
 * 有这两级就至少四个降号，身位也定了；后面的 G、C、F 按身位逐个验竖笔：那一列有 1.5 格以上的竖墨、
 * 顶端落在该降号竖笔顶端的位置上（照 E 的顶端按调号次序推）。不合的那一个起就停。
 * 返回摆好的盒。
 */
function flatsByStairs(bin: Binary, lineYs: number[], clef: Rect, sp: number, thick: number): Rect[] {
  const x0 = Math.round(clef.x + Math.min(clef.w, sp * STAIR_FROM));
  const x1 = Math.min(bin.w - 1, Math.round(x0 + sp * 9));
  const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < bin.w && y < bin.h && bin.data[y * bin.w + x] === 1;
  // 最上一条线在这一段的实际位置：斜着的谱行行首与平线模型能差半格，取这一段里横向最满的那一行（几行一样满取最上）
  let top = Math.round(lineYs[0]);
  {
    let bestN = 0;
    for (let y = Math.round(lineYs[0] - sp * 0.7); y <= Math.round(lineYs[0] + sp * 0.7); y++) {
      let n = 0;
      for (let x = x0; x <= x1; x++) if (ink(x, y)) n++;
      if (n > bestN) (bestN = n), (top = y);
    }
    if (bestN < (x1 - x0) * 0.8) return [];
  }
  // 逐列量：紧贴线上缘起往上连续的墨（线上缘一两像素的毛边不算断）
  const base = top - 1;
  const hs: number[] = [];
  for (let x = x0; x <= x1; x++) {
    let ya = base;
    while (ya > base - Math.max(1, Math.round(thick)) && !ink(x, ya)) ya--;
    let h = 0;
    while (ink(x, ya - h)) h++;
    hs.push(h ? base - ya + h : 0);
  }
  // 连着的几列并成一根：取最高处
  const peaks: { x: number; w: number; h: number }[] = [];
  for (let i = 0; i < hs.length; i++) {
    // 不到 0.3 格的是线上缘的毛边、肚子的顶，不算（算进来会把相邻两根并成一根宽的）
    if (hs[i] < sp * 0.3) continue;
    let j = i;
    let hi = i;
    while (j + 1 < hs.length && hs[j + 1] >= sp * 0.3) if (hs[++j] > hs[hi]) hi = j;
    peaks.push({ x: x0 + hi, w: j - i + 1, h: hs[hi] / sp });
    i = j;
  }
  // 台阶：E 探出 0.7~1.7 格，D 在它右边两个身位、矮四分之一格以上
  let e: (typeof peaks)[number] | undefined;
  let d: (typeof peaks)[number] | undefined;
  for (const [i, p] of peaks.entries()) {
    if (p.w > sp * 0.7 || p.h < 0.7 || p.h > 1.7 || (p.x - x0) / sp > 4.5) continue;
    const q = peaks.slice(i + 1).find((q) => q.h >= 0.3 && q.w <= sp * 0.7 && (q.x - p.x) / sp >= 1.5);
    if (q && (q.x - p.x) / sp <= 2.6 && q.h <= p.h - 0.25) (e = p), (d = q);
    if (e) break;
  }
  if (!e || !d) return [];
  const pitch = (d.x - e.x) / 2;
  // 各降号竖笔顶端相对 E 的那一根的高低（格）：照肚子的次序 B E A D G C F
  const STEP = [0, -1.5, 0.5, -1, 1, -0.5, 1.5];
  const topOf = (n: number) => top - e!.h * sp + (STEP[n] + 1.5) * sp;
  /** 第 n 个降号的位置上有没有它的竖笔 */
  const stemAt = (n: number) => {
    const cx = e!.x + (n - 1) * pitch;
    const want = topOf(n);
    for (let x = Math.round(cx - sp * 0.35); x <= Math.round(cx + sp * 0.35); x++) {
      let run = 0;
      for (let y = Math.round(want - sp * 0.5); y <= Math.round(want + sp * 3.4); y++) {
        if (ink(x, y)) run++;
        else {
          if (run >= sp * 1.5 && run <= sp * 3.2 && Math.abs(y - run - want) <= sp * 0.5) return true;
          run = 0;
        }
      }
    }
    return false;
  };
  let n = 4;
  while (n < 7 && stemAt(n)) n++;
  // **按最后一个降号的位置定个数**：调号那一串墨到哪一列断开（半格以上没有谱线以外的墨），
  // 横向按身位折成个数；再看纵向——末一个身位里墨的顶端要落在五度圈次序里第 n 个降号竖笔顶端的位置上。
  // 两样都合才采信（头一行后面紧跟拍号的，横向会多折出一两个，纵向对不上，仍用逐个验的那个数）。
  {
    const isLine = (y: number) => [0, 1, 2, 3, 4].some((i) => Math.abs(y - (top + thick / 2 + i * (lineYs[4] - lineYs[0]) / 4)) <= thick / 2 + 1);
    const colTop = (x: number) => {
      for (let y = Math.round(top - sp * 1.8); y <= Math.round(top + sp * 5.2); y++) if (!isLine(y) && ink(x, y)) return y;
      return -1;
    };
    let end = d.x;
    for (let x = d.x, blank = 0; x <= Math.min(bin.w - 1, Math.round(e.x + pitch * 7)); x++) {
      if (colTop(x) >= 0) (end = x), (blank = 0);
      else if (++blank >= sp * 0.5) break;
    }
    // 第 i 个降号（从 0 数）的竖笔在 e.x + (i - 1) 个身位，肚子右缘再往右约 0.8 个身位
    const m = Math.round((end - e.x) / pitch - 0.8) + 2;
    if (m > n && m <= 7) {
      let t = Infinity;
      for (let x = Math.round(e.x + (m - 2) * pitch - sp * 0.35); x <= end; x++) {
        const y = colTop(x);
        if (y >= 0 && y < t) t = y;
      }
      if (Math.abs(t - topOf(m - 1)) <= sp * 0.5) n = m;
    }
  }
  const bY = lineYs[2];
  return Array.from({ length: n }, (_, i) => ({
    x: Math.round(e!.x + (i - 1) * pitch) - 1,
    y: Math.round(bY + STEP[i] * sp - sp * FLAT_STEM),
    w: Math.round(sp * 0.8),
    h: Math.round(sp * (FLAT_STEM + 0.5)),
  }));
}

/** 粗线低分辨率的页（线宽过线距的两成、线距不到 `KEY_COARSE_SPACE`）：调号的降号另有一套量法。 */
function isCoarseKey(sp: number, thick: number): boolean {
  return thick / sp > KEY_THICK_LINE && sp < KEY_COARSE_SPACE;
}

/**
 * **按竖笔数调号降号**（与 `sharpsByStrokes` 同一路）。降号是一根 1.5~3 格的竖笔、肚子在右下：
 * 从谱号后起逐根取竖笔，要求
 *   - 肚子中心的高低照调号的固定次序走（B E A D G C F：升 1.5 格、降 2 格交替），头一个落在 B 的位置上；
 *   - 相邻两根隔 0.5~1.6 格（升号的两根竖笔隔不到 0.5 格、顶端齐平，过不了）；
 *   - 肚子那一格右侧的墨比左侧多（符头在朝上干的左下、朝下干的右上，拍号 4 的竖笔左边有墨）。
 * 不合的那一根起就停。返回各降号的盒。
 */
function flatsByStrokes(bin: Binary, lineYs: number[], clef: Rect, bass: boolean, sp: number, thick = 0): Rect[] {
  // **谱线粗的页竖笔要更高才算**：低分辨率的粗线扫描（线宽过线距的两成），降号的肚子连上下两条谱线就有
  // 「一格 + 两个线宽」高，过了 1.2 格那道闸，肚子那几列与竖笔并成一片宽笔、整串被宽度那道闸滤光
  //（烛光颂曲线距 10px、线宽 3px，六个降号一根都数不出）。闸抬到肚子连两条线之上。
  const r = thick / sp;
  // 只管低分辨率的页：线距够大的粗体铅字本（主使我喜乐，线距 14.5px）升号的两根竖笔抹宽后并成一根粗的，
  // 放宽了宽度闸就被数成降号（四个升号读成两个降号）
  const coarse = isCoarseKey(sp, thick);
  // 竖笔本身也粗（三像素的笔抹宽后五像素，连着肚子的弧有八九像素），宽度那道闸跟着放到一格
  const z = keyZoneStrokes(bin, lineYs, clef, sp, sp * (coarse ? 1 + 2 * r + 0.25 : 1.2), coarse ? 1.0 : 0.5);
  if (!z) return [];
  const { x0, strokes, ink } = z;
  // 各降号**肚子中心**相对头一个（B）的高低（格，向上为负）
  const STEP = [0, -1.5, 0.5, -1, 1, -0.5, 1.5];
  // B 的肚子中心：高音谱表第三线，低音谱表第二线（自上而下第四条）
  const bY = lineYs[bass ? 3 : 2];
  const isLine = (y: number) => lineYs.some((l) => Math.abs(y - l) <= Math.max(1, sp * 0.12));
  /** [x0, x1] × [y0, y1] 里的墨占比，不算谱线那几行 */
  const density = (xa: number, xb: number, ya: number, yb: number) => {
    let n = 0;
    let tot = 0;
    for (let y = Math.round(ya); y <= Math.round(yb); y++) {
      if (y < 0 || y >= bin.h || isLine(y)) continue;
      for (let x = Math.round(xa); x <= Math.round(xb); x++) {
        if (x < 0 || x >= bin.w) continue;
        tot++;
        if (ink(x, y)) n++;
      }
    }
    return tot ? n / tot : 0;
  };
  const out: Rect[] = [];
  let lastX = x0;
  // 中间漏一根（淡得连 1 格的竖墨都凑不出）只许一次：后一根落在再下一个位置上、横向也正好隔着两个身位，就当中间那个在
  //（是否劳倦歌四个降号，高音谱表缺头一个、低音谱表缺第二个）
  let skipped = false;
  let skipAt = -1;
  const boxAt = (x: number, cy: number): Rect => ({ x: Math.round(x) - 1, y: Math.round(cy - sp * FLAT_STEM), w: Math.round(sp * 0.8), h: Math.round(sp * (FLAT_STEM + 0.5)) });
  for (const [i, k] of strokes.entries()) {
    // 粗线页竖笔两端顺着粗谱线各多接一截（量得 3.3~3.6 格），高度上限跟着放
    if (out.length >= 7 || k.h > sp * (coarse ? 4.2 : 3.2)) break;
    // 紧跟着一根差不多高的竖笔：那是升号的两根竖笔（赞美三一歌两个升号的头一根落在 B 的位置上，被数成一个降号）
    const nx = strokes[i + 1];
    // 粗线页的竖笔宽（一根占大半格），相邻两个降号的笔缘只隔两三像素：间距改按**笔心**量（升号的两根笔心隔不到半格，降号隔一格）
    const mid = (q: { x0: number; x1: number }) => (q.x0 + q.x1) / 2;
    if (nx && (coarse ? (mid(nx) - mid(k)) / sp < 0.6 : (nx.x0 - k.x1) / sp < 0.5) && nx.h >= sp * 1.8 && k.h >= sp * 1.8) break;
    const gap = coarse ? (mid(k) - lastX) / sp - (out.length ? 0.5 : 0) : (k.x0 - lastX) / sp;
    if (gap > (out.length ? 2.6 : 4.2)) break;
    // 紧挨着上一根的短笔是它肚子的右缘，跳过
    if (out.length && gap < 0.5) continue;
    // 按**肚子**对位：沿竖笔自上而下找「右侧一格见方的墨比左侧多得最多」的那一行，就是肚子中心。
    // 竖笔两端都不可靠——容了断口之后，顶端会接到上面那条谱线、底端顺着肚子的弧与谱线接下去
    //（主爱辉煌歌低音谱表头一个降号顶端被抬高半格，四个只数出两个）。
    let cy = 0;
    let bowl = 0;
    for (let y = k.top + Math.round(sp * 0.5); y <= k.bottom + Math.round(sp * 0.3); y++) {
      const d = density(k.x1 + 1, k.x1 + sp * 0.6, y - sp * 0.45, y + sp * 0.45) - density(k.x0 - sp * 0.6, k.x0 - 1, y - sp * 0.45, y + sp * 0.45);
      if (d > bowl) (bowl = d), (cy = y);
    }
    // 粗线页一格只有十来个像素、谱线那几行又不算，肚子中心量出来差半格是常事：容差放到 0.7 格（次序里相邻两个差 1.5 格以上，仍分得开）
    const at = (n: number) => n < 7 && bowl >= 0.15 && Math.abs((cy - bY) / sp - STEP[n]) <= (coarse ? 0.7 : 0.45);
    const n = out.length;
    if (at(n) && gap <= (n ? 1.6 : 3.2)) out.push(boxAt(k.x0, cy));
    else if (!skipped && at(n + 1) && gap >= 1.2) {
      skipped = true;
      skipAt = n;
      out.push(boxAt(k.x0 - sp * 0.85, bY + STEP[n] * sp), boxAt(k.x0, cy));
    } else if (!n) continue; // 头一个之前的杂笔（谱号的边角）跳过
    else break; // 串起来之后不合就停
    lastX = coarse ? mid(k) : k.x1;
  }
  // 漏的那一个后面要有**两个**真的接着（漏在最前头的，后面至少还有两个）：只跟着一个的多半是拍号的竖笔
  //（万古磐石歌两个降号，头一行跳过「A」接上拍号 4 的竖笔，数成四个）
  if (skipAt >= 0 && out.length - skipAt - 1 < 2) out.length = skipAt;
  return out;
}

/** 行末预告调号：离谱行右端几格以内（七个记号约占七格）。 */
const COURTESY_KEY = 8;

/** 调号兜底：相邻两个升降号（或谱号与第一个升降号）之间最多隔几个线距。 */
export const KEY_GAP = 1.5;

/** 调号**第一个**记号离谱号右缘的上限（线距）：低音谱号的两点在谱号盒外（齐来称颂 1.77 格）。 */
export const KEY_GAP_FIRST = 2.0;

/** 临时记号离符头最远多少格还算它的（见 `attachAccidentalsByPitch`）。 */
export const LOOSE_ACC_GAP = 1.5;
