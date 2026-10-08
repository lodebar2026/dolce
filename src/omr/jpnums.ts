// 简谱识别的**逐行建音**（`buildJpNums`）：数字核 + 附点 / 八度点 / 减时线 / 增时线 → `JpNum`，以及减时线复数、扁块归属、成对八度点。
import type { Binary, Component, JpNum, Rect, StaffRow } from "../omrkit/types";
import { rright, rbottom, rcx, rcy } from "../omrkit/types";
import { median, overlapX } from "../omrkit/geom";
import { probe } from "./probe";
import { type Classified, type DigitCore } from "./jianpu";
import { columnInk, stackedHline, inkFill, inkCount } from "./inkprobe";

// 为一行的每个数字格归并修饰（八度点/增时线/附点），div 已随数字格带入。
/** 小块正下方半个字号内的前景占比。八度点是**孤立**的圆点、下方留白；歌词字的顶部笔画
 *  （如「主」字上方那一竖）下方紧接着字的其余笔画，占比高。与字号无关，故比宽高比/间隙阈值稳。 */
/** 与 inkBelow 对称：点**正上方**紧挨着的那一小条墨占比。四声部谱第 3 声部头顶就是歌词（歌词夹在第 2、3
 *  声部之间），字底的撇点落在音符正上方，与高音点同位（《三一来临歌》末系统 Q3 `5` 头上「亲」字的点，
 *  读成了 `5̇`）；字底笔画上面紧接着字身，真高音点上方留白。 */
/** `skip`：这些框里的墨不算（压在点上的圆滑线） */
function inkAbove(bin: Binary, r: Rect, numH: number, skip: readonly Rect[] = []): number {
  const y1 = Math.round(r.y) - 1, y0 = Math.max(0, Math.round(r.y - numH * 0.18));
  const x0 = Math.max(0, Math.round(r.x - numH * 0.2)), x1 = Math.min(bin.w - 1, Math.round(rright(r) + numH * 0.2));
  if (y1 <= y0 || x1 <= x0) return 0;
  const inSkip = (x: number, y: number) => skip.some((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h);
  let ink = 0, tot = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { tot++; if (bin.data[y * bin.w + x] && !inSkip(x, y)) ink++; }
  return tot ? ink / tot : 0;
}

function inkBelow(bin: Binary, r: Rect, numH: number): number {
  // 窗口只探**紧挨着**点下方的那一小条（0.18 字号）：字顶笔画与字身其余笔画之间几乎不留空
  // （1~3px），而真低音点到下一行歌词字顶还有半个点径。窗口开到 0.3 字号就够到歌词了——
  // 17《不失足》第 2 行 `7̣ 5̣` 的低音点即因此被当成字顶笔画剔掉（同一首第 4 行的却留住了，
  // 只因那行歌词排得略低，一条判据两种结果，正说明窗口过宽）。
  const y0 = Math.round(rbottom(r)) + 1, y1 = Math.min(bin.h - 1, Math.round(rbottom(r) + numH * 0.18));
  const x0 = Math.max(0, Math.round(r.x - numH * 0.2)), x1 = Math.min(bin.w - 1, Math.round(rright(r) + numH * 0.2));
  if (y1 <= y0 || x1 <= x0) return 0;
  let ink = 0, tot = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { tot++; if (bin.data[y * bin.w + x]) ink++; }
  return tot ? ink / tot : 0;
}

/** 厚短横候选（`Classified.dashLike`）按位置裁决：落在本行某个数字**右侧**、与数字纵向重叠且中线对齐
 * （|Δcy| ≤ 0.25 字号，同增时线判据）的挪进 hlines 当增时线；其余留在 dots（八度点在数字上下方、波音在头顶）。 */
function resolveDashLike(cls: Classified, rowCores: DigitCore[], numH: number): void {
  if (!cls.dashLike.length) return;
  for (const k of [...cls.dashLike]) {
    const kb = k.bbox;
    // 比的是它**左边最近**的那个数字（同一行、纵向相交）：`5 - -` 的第二根离 5 有两个多字宽
    const d = rowCores.map((c) => c.bbox)
      .filter((b) => kb.x >= rright(b) - 1 && kb.y < rbottom(b) + numH * 0.5 && rbottom(kb) > b.y - numH * 0.5)
      .sort((a, b) => rright(b) - rright(a))[0];
    const onMid = !!d && kb.y < rbottom(d) && rbottom(kb) > d.y && Math.abs(rcy(kb) - rcy(d)) <= numH * 0.25;
    if (!onMid) continue;
    probe("hline.shortDashThick");
    cls.dots.splice(cls.dots.indexOf(k), 1);
    cls.dashLike.splice(cls.dashLike.indexOf(k), 1);
    cls.hlines.push(k);
  }
}

/** 各音在 buildJpNums 里收下的八度点（上/下），供 resolvePairOctaveDots 按声部组复核 */
const octDotsOf = new WeakMap<JpNum, { up: Rect[]; down: Rect[]; nearDown: Rect[] }>();

/** 四声部谱两声部一组（S/A、T/B）上下挨着，夹在两组数字之间的一颗点，要么是上声部的低音点、要么是下声部的高音点，
 *  逐音按窗口收常被两边各收一次（上声部「数字 → 减时线 → 点」离得反而远，按「归更近的」也抢不回去）：
 *  新编赞美诗·四声部 223 第 2 声部 `5̣̲ 5̣̲ 5̣̲ 5̣̲` 被上声部的低音点抵消成 `5̲`；275 第 1 声部 `3̲̇` 把下声部 `1̇` 的高音点也收成
 *  自己的低音点，抵消成 `3̲`。这里在声部定下来之后按组裁决：
 *  · **一个音不会同时有高音点和低音点**：上声部头上已有点的，这颗归下声部；下声部脚下已有点的，归上声部；
 *  · 两种都行就比**音高**：同一列上方声部的音不低于下方声部；
 *  · 仍定不下来（两种都合或都不合）照原样。 */
export function resolvePairOctaveDots(rows: StaffRow[], numH: number): void {
  const bySys = new Map<number, StaffRow[]>();
  for (const r of rows) if (r.system !== undefined) (bySys.get(r.system) ?? bySys.set(r.system, []).get(r.system)!).push(r);
  const pitch = (n: JpNum, oct: number) => oct * 7 + n.digit;
  for (const g of bySys.values()) {
    if (g.length % 2) continue;
    g.sort((a, b) => a.voice! - b.voice!);
    for (let v = 0; v + 1 < g.length; v += 2) {
      const upper = g[v]!, lower = g[v + 1]!;
      const aligned = (ns: JpNum[], kb: Rect) => ns.find((n) => n.digit >= 1 && n.digit <= 7 && Math.abs(rcx(n.bbox) - rcx(kb)) <= numH * 0.4);
      const seen = new Set<Rect>();
      for (const n of [...upper.nums, ...lower.nums]) {
        const od = octDotsOf.get(n);
        if (!od) continue;
        for (const kb of [...od.up, ...od.down, ...od.nearDown]) {
          if (seen.has(kb)) continue;
          seen.add(kb);
          const u = aligned(upper.nums, kb), l = aligned(lower.nums, kb);
          if (!u || !l || rbottom(u.bbox) > kb.y + 1 || rbottom(kb) > l.bbox.y + 1) continue;   // 不夹在这两个音之间
          const uo = octDotsOf.get(u), lo = octDotsOf.get(l);
          if (!uo || !lo) continue;
          const uClaim = uo.down.includes(kb), lClaim = lo.up.includes(kb);
          // 上声部只因「离下声部数字更近」没收、下声部也没收的点（下声部头上有上声部的减时线，按「上方有墨」挡掉了）：
          // 两边都不要，原先直接跳过——四声部上声部 `5̣̲`、`7̣̲` 一排丢点多是这样（355 第 1 声部，点夹在本声部减时线与下声部数字之间）
          if (!uClaim && !lClaim && !uo.nearDown.includes(kb)) continue;
          const uBase = u.octave + (uClaim ? 1 : 0), lBase = l.octave - (lClaim ? 1 : 0);
          // A：归上声部当低音点；B：归下声部当高音点
          let a = !uo.up.some((o) => o !== kb), b = !lo.down.some((o) => o !== kb);
          if (a && b) {
            const pa = pitch(u, uBase - 1) >= pitch(l, lBase), pb = pitch(u, uBase) >= pitch(l, lBase + 1);
            if (pa !== pb) { a = pa; b = pb; }
          }
          if (a === b) continue;
          if (!uClaim && !lClaim && !a) continue;                          // 两边都没收的只可能归上声部（下声部本有理由拒它）
          const nu = Math.max(-3, uBase - (a ? 1 : 0)), nl = Math.min(3, lBase + (b ? 1 : 0));
          if (nu !== u.octave || nl !== l.octave) probe("octave.pairResolve");
          u.octave = nu; l.octave = nl;
          if (a) { if (lClaim) lo.up.splice(lo.up.indexOf(kb), 1); if (!uClaim) uo.down.push(kb); }
          else { if (uClaim) uo.down.splice(uo.down.indexOf(kb), 1); if (!lClaim) lo.up.push(kb); }
        }
      }
    }
  }
}

/** 每页单道增时线的统计宽度（见 buildJpNums 里的 dashUnit），按 Classified 记一次 */
const dashUnitOf = new WeakMap<Classified, number>();

export function buildJpNums(
  bin: Binary, rowCores: DigitCore[], numH: number, cls: Classified, ocrDigit: (b: Rect) => number,
  arcs: Component[], barlineXs: number[], dotSizes: number[],
  /** 同一系统里别的声部行的数字核（多声部谱才有）：点归离它更近的数字，见 nearerOther */
  voiceMates: readonly Rect[] = [],
  /** 上下相邻**别的系统**挨着的那一行的数字核：只给 nearerOther 用（点归更近的数字不分系统） */
  otherMates: readonly Rect[] = [],
): JpNum[] {
  const out: JpNum[] = [];
  // 本行歌词字顶线：数字底下整字高的块（汉字也归在数字块里）顶的中位数；不足三块不算
  const rowBots = rowCores.map((c) => rbottom(c.bbox)).sort((a, b) => a - b);
  const rowBot = rowBots[rowBots.length >> 1] ?? 0;
  const rowX0 = Math.min(...rowCores.map((c) => c.bbox.x)), rowX1 = Math.max(...rowCores.map((c) => rright(c.bbox)));
  // 先在 0.9 字号内找，不足三块再放到 1.4 字号（1218 230 歌词字顶在数字底下 1.2 字号，减时线、低音点都夹在中间）；
  // 一上来就放宽，歌词挨得近的页会把更低处的块也收进来、把字顶线拉低（主祢真伟大 多出一个假低音点）
  const topsWithin = (reach: number) => cls.blocks.filter((k) => k.bbox.h >= numH * 0.7 && k.bbox.y > rowBot && k.bbox.y < rowBot + numH * reach &&
    rright(k.bbox) > rowX0 && k.bbox.x < rowX1).map((k) => k.bbox.y).sort((a, b) => a - b);
  let lyTops = topsWithin(0.9);
  if (lyTops.length < 3) lyTops = topsWithin(1.4);
  const lyricTop = lyTops.length >= 3 ? lyTops[lyTops.length >> 1]! : -Infinity;
  // 八度点是**实心**圆点，包围盒里的墨迹填充率高；房号「2.」这类小字即便糊成一团（二值化把笔画泡粗、
  // 「2」和「.」连成一块），包围盒里也大半是空的。1697 二房的「2.」正摞在 `1̇` 的点上方，被数成第二个点（`1̈`）。
  // **不按大小判**：试过「比本页八度点统计值小得多就剔」，翻拍件上高音点常印得比别的点小一号，
  // 抽检时「赞美歌声三《感谢》」一页剔掉了 7 个真八度点。
  // **只在干净谱面上判**：翻拍件的点边缘发毛、形状不规整，填充率常不到六成（抽检十来页掉了真点，
  // 其中 1600《南非之行》、17《不失足》都有 GT）。
  const dotSized = (kb: Rect) => !cls.clean || inkFill(bin, kb) >= 0.6;
  resolveDashLike(cls, rowCores, numH);
  // 各音符正下方有没有「疑似低音点」（见 aboveLyrics 的成片放宽）：正下方 0.8 字号内的小点，点顶在字顶线之上、点底不过字顶线 4px
  const looseLow = (dot: Rect): boolean => dot.y < lyricTop && rbottom(dot) <= lyricTop + 4;
  const lowSuspect = rowCores.map((c) => cls.dots.some((k) => {
    const kb = k.bbox, gap = kb.y - rbottom(c.bbox);
    return Math.abs(rcx(kb) - rcx(c.bbox)) <= numH * 0.35 && gap >= -1 && gap < numH * 0.8 &&
      kb.w <= numH * 0.45 && kb.h <= numH * 0.45 && (rbottom(kb) <= lyricTop - 2 || looseLow(kb));
  }));
  for (let i = 0; i < rowCores.length; i++) {
    const d = rowCores[i].bbox;
    const next = rowCores[i + 1]?.bbox;
    // 右侧修饰（附点/增时线）必与本音符同属一小节：不得越过本音符后的第一根小节线。
    // 否则末音符会跨过小节线把下一小节的点/横线吞进来（实测「2_ |1-」把 1 的附点与增时线
    // 误并到 2_ → 2. 且漏掉 1 的增时）。无后续小节线则不限。
    const nextBar = barlineXs.find((x) => x > rright(d) - 1);
    const rightLimit = nextBar ?? Number.POSITIVE_INFINITY;
    // 增时线右界：行末音符(如 6--- 整小节长音)无下一音符，须放宽到无穷，否则只数到第一根 '-'；
    // 同 y 高度约束已能防越界到别行。再以本小节右界封顶。
    const augR = Math.min(next ? next.x : Number.POSITIVE_INFINITY, rightLimit);
    let octave = 0, dot = 0, augment = 0;
    const upDots: Rect[] = [], downDots: Rect[] = []; // 八度点候选（上/下），循环后按叠放规则裁决
    const nearDown: Rect[] = [];
    // 复核用（`JpNum.doubt`）：八度点判得「差一点」的情形——不改判定，只记下来给核对视图标黄
    const doubts: string[] = [];
    // 数字先识别（附点判定要用到：休止 0 不接附点 —— 见下）。
    // "1" 是简谱唯一单竖笔，明显比其它数字窄：极窄块若被 OCR 误判成别的数字（淡印/碎裂的 "1"
    // 常被读成 4/7），按宽度纠回 1；不动休止 0（圆形、不窄）。
    // 只纠 4/7 这两个「1」的实测误读方向：3/5 等弯笔数字在瘦高字体里本就可能窄（宽 ≈0.5字号），
    // 却是 rec 读对的正字，若一并按宽clobber 会把清晰的 3/5 错改成 1（「从前所珍爱」实测 4 处）。
    // 门限 0.45 字号（原 0.55）：瘦体版面里连 2/3/5/6/7 都只有 0.5 字号宽（迦南诗选实测 "1" 16~18px、
    // 其余 23~26px，numH 47），0.55 会把**清清楚楚的 4 和 7** 一并改成 1（《祷告》3 个 `4.`、
    // 7 个 7，《主是》《天不蓝了》各若干）。0.45 卡在两簇之间，两本都分得开；现有语料指标不变。
    let digit = ocrDigit(d);
    if ((digit === 4 || digit === 7) && d.w <= numH * 0.45) digit = 1;

    const dcx = rcx(d), dcy = rcy(d);
    // 右侧附点窗口：附点紧跟其修饰的音符，但实测它常落在到下一音符空隙的中段（约 50%，
    // 即 ~1.3×字号外），远超固定的 0.8×字号窗。改用空隙相对界——取本音符右缘到下一音符左缘
    // 间隙的前 60%（无下一音符则放宽到 1.6×字号）；垂直居中(|Δcy|<0.5)已排除上/下八度点，
    // 60% 上界确保把点归给本音符而非下一音符（下一音符的八度点居中于其自身，落在 60% 之外）。
    // 后一个音是窄「1」（<0.45 字号宽）时放到 70%：字身窄、空隙量出来偏宽，点就落在「正中偏右」（新编赞美诗·四声部
    // 《圣哉三一歌》Q4 `5̣ · 1̲`，点心恰在 60% 处）。一律放宽的话 1773 多出一个假附点。
    const dotMaxX = Math.min(
      next ? rright(d) + (next.x - rright(d)) * (next.w < numH * 0.45 ? 0.7 : 0.6) : rright(d) + numH * 1.6,
      rightLimit,
    );
    for (const k of cls.dots) {
      const kb = k.bbox;
      // 反复号冒号：同一 x 上下成对、紧邻复纵线。其中一点常落进末音符的附点窗口，
      // 不剔就把 `:||` 读成末音符的附点。判据只要「点对 + 竖线」：**不再要求两点分居数字中心
      // 两侧**——小图上冒号相对数字中线整体偏上，「爱是不保留」两处 `:|` 的点对实测 Δcy 是
      // -0.47/-0.06 字号（同在上方），异侧条件一卡就漏，两个 `2._`/`5,._` 假附点由此而来。
      // 能走到这一步的点本就在数字**右侧空隙**里（附点窗口的前提），不会是居中于数字的双八度点。
      const repeatColon = barlineXs.some((x) => Math.abs(x - rcx(kb)) <= numH * 1.2) &&
        cls.dots.some((o) => {
          if (o === k) return false;
          const ob = o.bbox;
          const dy = Math.abs(rcy(ob) - rcy(kb));
          return Math.abs(rcx(ob) - rcx(kb)) <= numH * 0.35 &&
            dy >= numH * 0.35 && dy <= numH * 1.4;
        });
      if (repeatColon && rcx(kb) > rright(d)) continue;
      // 右侧附点：在数字右侧空隙前段、垂直大致居中、尺寸够大（非噪点）、且**不居中于任何数字**。
      // 尺寸下限 0.15×numH 剔噪点。垂直窗口 0.35×numH：旧的 0.25 在扫描抖动面前太窄——「因有主同在」
      // 第 2 谱行四个附点实测 Δcy=0.28（同一版面第 1 谱行的同一批附点只有 0.18），整行附点全漏。
      // 放宽后要把「邻音符的八度点」挡住，就不能再靠 Δcy（它们 0.3~0.43，与真附点重叠），改用
      // **水平位置**：八度点永远印在某个数字的正上/正下方，附点在两数字之间的空隙里，两者按
      // 「点心与任一数字中心的水平距」一分即开（这也正是下面八度点分支的判据，口径一致）。
      // 「休止 0 不接附点」这条**不在这里**做（挪到 digit=0 复原之后，见下文 rankDigits 那段）：
      // 此处的 digit 还是 CTC 原始结果，糊死的 "3" 常被读成 0，一刀切会连它的真附点一起丢
      // （沧海一声笑行 1 的 `3._` 即此）。
      // 有的本子把附点印在**数字底线**上（新编赞美诗·四声部《圣哉三一歌》末系统 `2 . 1`：点 5×7 贴着数字
      // 底沿，Δcy 0.44 字号），过不了居中门；点整个落在本音符的纵向范围内、偏下半的也算。
      // 下方的低八度点在数字底沿**之外**，够不着这一条。
      const overDigit = rowCores.some((c) => Math.abs(rcx(c.bbox) - rcx(kb)) < numH * 0.3);
      const onBaseline = rcy(kb) > dcy && kb.y >= d.y && rbottom(kb) <= rbottom(d) + numH * 0.1;
      // 尺寸门按宽高之和量：淡印的附点常一边削掉一两像素（同首实测 5×7，字号 36，宽差 0.4px 够不着 0.15）。
      // 外延窗口：点心落在空隙 60%~85% 的也收，但得压在数字中线附近（|Δcy| < 0.3 字号，下一个音的八度点离中线至少半个字号；选本 86 `3·5·` 的点偏下 0.22、点心恰在 60% 线上）——附点不会印在音符前面，
      // 中线上的点只能是左边这个音的；下一个音的八度点在它上下方，过不了中线这道门。选本 490 小图（字号 18）`4̲.7̳`
      // 的点 3×4、点心在空隙 68% 处，窗口一卡就丢（雅歌、选本「识别只差附点」三百多处多是这类）
      // 外延的要是**实心**点（墨占包围盒六成以上）：迦南诗选 1717 倚音 `{3}` 底下那道连音小弧的弧钩 7×5 也落在这里，一笔细弧、墨不到一半
      const farDotX = next ? Math.min(rright(d) + (next.x - rright(d)) * 0.85, rightLimit) : dotMaxX;
      const inWin = rcx(kb) < dotMaxX || (rcx(kb) < farDotX && Math.abs(rcy(kb) - dcy) < numH * 0.3 && k.area >= kb.w * kb.h * 0.6);
      if (rcx(kb) > rright(d) && inWin && !overDigit &&
          kb.w >= numH * 0.12 && kb.h >= numH * 0.12 && kb.w + kb.h >= numH * 0.3 &&
          (Math.abs(rcy(kb) - dcy) < numH * 0.35 || onBaseline)) { if (rcx(kb) >= dotMaxX) probe("dot.farWindow"); dot++; dotSizes.push((kb.w + kb.h) / 2); continue; }
      // 八度点：须足够大(排除噪点小斑)、水平居中于数字、且紧贴上/下方（间隙 < 0.8×字号）。
      // 阈值据实测分布定（真八度点 w/h≈0.21~0.30×numH、|dx|≤0.14；噪点误判那个是 0.09×0.11、dx=0.45）：
      // 尺寸下限 0.15、居中收到 0.4，两道独立门都能剔除噪点，且对真点留足余量。
      // 尺寸门同附点按宽高之和量（淡印的点一边常削掉一两像素：新编赞美诗·四声部《圣哉三一歌》低音点 5×9，字号 36）。
      // 声部行**靠歌词一侧**的低音点宽高和松到 0.27 字号：四声部靠歌词那一声部的低音点印得比上声部小一号（11《荣归天父歌》女低 5×5，字号 35，
      // 上声部 8×9）。只收紧贴数字的（间隙 <0.45 字号）；两声部之间的不松——那里 5×5 的墨渣会被上下两个音抢着认（47、199 各多出一个假点）。
      // 「外侧」按距离量：这本是「女高、女低、歌词、男高、男低」，女低底下隔着歌词才是男高——那一侧 1.8 字号内没有别的声部的数字就算。
      // 只松**低音点**：男高那一行头顶是歌词，段号「4.」的句点 5×5 正落在行首音的头上（47）。
      const outer = voiceMates.length > 0 && rcy(kb) > dcy && kb.y - rbottom(d) < numH * 0.45 &&
        ![...voiceMates, ...otherMates].some((ob) => ob.y >= rbottom(d) && ob.y - rbottom(d) < numH * 1.8);
      const minSide = numH * 0.12, minSum = numH * (outer ? 0.27 : 0.3);
      if (kb.w < minSide || kb.h < minSide || kb.w + kb.h < minSum) continue;
      // 居中阈值 0.25（原 0.4 过松）：真八度点是**印在数字正上/正下方**的圆点，实测 |dx| ≤0.07~0.14；
      // 而歌词字的顶部小笔画（歌词带紧接在数字下方 ~15px，与「减时线下方的低音点」几乎同高）
      // 偏在两字之间、|dx| 0.3~0.39，旧阈值放它进来 → 凭空多出低八度点，若该音本就有高八度点还会
      // 被一加一减抵消（实测「主祢真伟大」Coda 的 `i`(为) 丢点、`7`(我) 平白多点）。
      // 声部行放到 0.35：新编赞美诗·四声部的低音点常印得偏左（78《马槽歌》Q2 `5̲̣` 点心偏 9px，字号 30）
      const centerLimit = numH * (voiceMates.length ? 0.35 : 0.25);
      if (Math.abs(rcx(kb) - dcx) > centerLimit) {
        // 紧贴数字上下、只是水平偏了一点（不到门限的 1.3 倍）被剔掉的点
        const g = Math.max(d.y - rbottom(kb), kb.y - rbottom(d));
        if (Math.abs(rcx(kb) - dcx) <= centerLimit * 1.3 && g >= -1 && g < numH * 0.8) doubts.push("oct.offCenter");
        continue;
      }
      // 音符上方那一带偶尔印着别的字（段落名、上一行歌词的尾字），它的碎笔散成几个点大小的小块，
      // 尺寸与居中判据都拦不住（17《不失足》首音头顶那个「羔」字，`3.` 成了 `3̈.`）。
      // 分野在**左右**：八度点在数字正上/正下方孤零零一个，同高度上左右一个字距内不会再有小块
      // （相邻音符的八度点隔着一整个音符间距，≥1 字号）；字的碎笔则是一排挨着的。
      // 邻块**必须不居中于任何音符**才算碎笔：密排音符（十六分）的八度点彼此也可能挨到
      // 0.7 字号以内（基督更美实测），但那些邻块各自正对着一个音符——把这条漏掉会连真点一起剔，
      // 那首音符 100→94.2。
      const hasSideMate = (k: Rect): boolean => cls.dots.some((o) => {
        const ob = o.bbox;
        if (ob === k) return false;
        const dx = Math.abs(rcx(ob) - rcx(k));
        if (dx <= (k.w + ob.w) / 2 || dx > numH * 0.7) return false;
        if (Math.abs(rcy(ob) - rcy(k)) > Math.max(2, k.h * 0.8)) return false;
        // 碎笔与点大小相当；几像素的墨渣不算（1218 144 剥线剥出的低音点 9×14，右下 4×2 的渣把它判成了碎笔）
        if (ob.w * ob.h < k.w * k.h * 0.3) return false;
        // 声部行行首音左边的小块是连谱号的钩擦线剩下的，不算碎笔（四声部 f16 第 4 声部行首 `1̲̣` 的低音点被它连累）
        if (voiceMates.length && rowCores.length && rcx(ob) < rowCores[0]!.bbox.x) return false;
        return !rowCores.some((c2) => Math.abs(rcx(c2.bbox) - rcx(ob)) < numH * 0.3);
      });
      const gapAbove = d.y - rbottom(kb);  // 点在数字上方的间隙
      const gapBelow = kb.y - rbottom(d);  // 点在数字下方的间隙
      // 点归**离它更近**的那个数字：四声部谱上下两声部挨得近，上声部的低音点同时落在下声部数字的
      // 「上方窗口」里，两边各算一次——下声部多出一个高八度，与它自己的低音点一加一减抵消
      //（新编赞美诗·四声部《三一来临歌》Q2 `5̣ − −`、《圣哉三一歌》Q4 `6̣ 6̣` 都读成了不带点）。
      // 另一侧正对着点、且明显更近（不到本侧间隙的 0.8）的别声部数字在，这个点就是它的。只比同系统别的
      // 声部行：单声部谱数字下面紧跟着歌词，汉字也是「数字块」，拿它们比会把真低音点抢走（17、1773 等十来首）。
      // 声部行上，点与数字之间隔着一条横过本音符的横线（减时线）：次序是数字 → 减时线 → 低音点，这就是低音点，
      // 不再看它下方有没有墨——四声部第 2 声部底下紧挨着歌词，点下 2px 就是字（78《马槽歌》Q2 `4̲̣5̲̣`）。
      // 点整个在**歌词字顶线之上**：同一行歌词字顶是对齐的，真低音点在这条线之上；「主」字顶那一点是字的一部分，
      // 顶与别的字平齐或更低。四声部第 2 声部底下紧挨着歌词，真低音点下 4px 就是字，按「下方有墨」会被剔掉
      //（84《主为救人》Q2 `5̣ − 5̣ 5̣` 整行丢点，点底 528、字顶 532）。
      // 声部行上点常直接压在字顶上（新编赞美诗·四声部 11 第 2 声部：点底 540~543、字顶线 539）。点顶在字顶线之上、点底不过字顶线 4px 的
      // 只在**成片**时收：前后相邻的音符下面也有疑似低音点（一排低音声部）；前后都没有、只这一个的照旧从严——字顶的点画单个出现
      const aboveLyrics = (dot: Rect): boolean => rbottom(dot) <= lyricTop - 2 ||
        (voiceMates.length > 0 && looseLow(dot) && (lowSuspect[i - 1] || lowSuspect[i + 1]));
      // 点与**歌词字同高**：左右 2.5 字号内有整字高的汉字块、点心落在它的上下沿之间——是歌词的标点（逗号、顿号），
      // 归歌词行，不是八度点。1218 61 上一行歌词「苦，」的逗号正落在 `6̣` 正上方，收成高音点，与真低音点一加一减抵消成 `6`。
      // 汉字块：高 ≥0.85 字号、近方（宽 ≥0.7 倍高），且同一高度上至少两块成一行——和弦字母、小号数字（1801、714 的 15×22）不算
      const hanzi = (k: Component) => k.bbox.h >= numH * 0.85 && k.bbox.h <= numH * 1.6 && k.bbox.w >= k.bbox.h * 0.7 &&
        !rowCores.some((c) => c.bbox === k.bbox);
      // 只管离数字远（>0.35 字号）的：真八度点紧贴数字，行距挤时贴着上一行歌词底也照收（1218 329 `1̇ 1̇` 点距数字 5px、
      // 点心落在上一行歌词字的上下沿之间）；61 那个逗号离数字 23px（0.7 字号）
      const inTextLine = (dot: Rect): boolean => {
        if (Math.max(d.y - rbottom(dot), dot.y - rbottom(d)) <= numH * 0.35) return false;
        const near = cls.blocks.filter((k) => hanzi(k) && Math.abs(rcx(k.bbox) - rcx(dot)) <= numH * 4 && rcy(dot) >= k.bbox.y && rcy(dot) <= rbottom(k.bbox));
        return near.length >= 2 && near.some((k) => overlapX(k.bbox, d) === 0 && Math.abs(rcx(k.bbox) - rcx(dot)) <= numH * 2.5);
      };
      const underOwnLine = (dot: Rect): boolean => voiceMates.length > 0 && cls.hlines.some((l) =>
        l.bbox.y >= rbottom(d) - 2 && rbottom(l.bbox) <= dot.y + 1 && overlapX(l.bbox, d) >= d.w * 0.5 &&
        rcx(dot) >= l.bbox.x && rcx(dot) <= rright(l.bbox));
      // 声部行上，点正下方那团墨是下一声部的弧（扁而宽的弧候选）而不是字：78 末系统 Q1 `6̣` 的点下 7px 就是 Q2 `(6 4 6)` 的弧。
      const overArc = (dot: Rect): boolean => voiceMates.length > 0 && arcs.some((a) => a.bbox.w >= numH &&
        a.bbox.h <= numH * 0.5 && a.bbox.y >= rbottom(dot) - 1 && a.bbox.y <= rbottom(dot) + numH * 0.3 &&
        rcx(dot) >= a.bbox.x && rcx(dot) <= rright(a.bbox));
      const nearerOther = (up: boolean): boolean => [...voiceMates, ...otherMates].some((ob) => {
        if (Math.abs(rcx(ob) - rcx(kb)) > numH * 0.3) return false;
        if (up) return rbottom(ob) <= d.y && kb.y - rbottom(ob) >= -1 && kb.y - rbottom(ob) < gapAbove * 0.8;
        return ob.y >= rbottom(d) && ob.y - rbottom(kb) >= -1 && ob.y - rbottom(kb) < gapBelow * 0.8;
      });
      // 数字与点之间隔着横过本音的减时线（`6̣̳`：数字 → 两道线 → 点），间隙从最下一道线量起：选本 499《哦你大能的圣灵》
      // 字号 18，双线下的点离数字底 15px（0.83 字号），原先靠 numH 估大（21）才够着
      const lineBot = Math.max(-Infinity, ...cls.hlines.filter((l) => l.bbox.y >= rbottom(d) - 2 && rbottom(l.bbox) <= kb.y + 1 &&
        overlapX(l.bbox, d) >= d.w * 0.5 && rcx(kb) >= l.bbox.x && rcx(kb) <= rright(l.bbox)).map((l) => rbottom(l.bbox)));
      const belowReach = gapBelow < numH * 0.8 || (kb.y - lineBot < numH * 0.4 && gapBelow < numH * 1.3);
      if (gapAbove >= -1 && gapAbove < numH * 0.8) {
        // 圆滑线弧帽的左/右"落脚"碎片常断成一个小斑、正落在弧端正下方、贴着数字顶——会被误当高八度点。
        // 判据：有一条弧线(宽薄连通块)横跨此斑、且其**底缘正落在斑的纵向区间内** (dotTop, dotBot+0.15字号]
        // ——即弧脚下垂到与小斑重叠，小斑就是断开的弧脚。**关键**：真高八度点(如日光行3 弧下的 2'/3')
        // 的弧线整体在点**上方**(弧底缘高于点顶 → 不重叠)，或弧实为下方下划线(弧底缘远在点底之下)，
        // 两者都落在窗口外，不会误剔。(实测：基督弧底-点顶=+9/弧底-点底=-3 命中；日光 -5/-16 不命中。)
        // **只在翻拍件上开**：干净谱面的弧线不会断脚，这条只会误伤——1697《温州的水 温州的山》二房
        // `2̇⌒1̇` 右端的点被弧的右脚（垂到点的高度）判成弧脚，第一个 `1̇` 的点被房号括线（宽扁、
        // 左端竖钩垂到点旁，也算进了弧候选）判成弧脚，两个高八度都丢了。
        // 声部行上弧端外侧的余量收到 0.25 字号：四声部谱弧起在音符右上角，高音点就在弧端左边一点
        //（《圣哉三一歌》Q3 `1̇⌒5`：点心距弧左端 14px，字号 36，按 0.4 字号被当成了弧脚）。
        const footReach = numH * (voiceMates.length ? 0.25 : 0.4);
        // 碎片在**弧端或弧端外侧**：点心从近侧弧端往弧里伸进去不过 max(半个点宽, 0.15 字号)。
        // 基督更美 那几个碎片在弧左端外 2px；1218 35 `1̇⌒…` 的高音点在弧左端往里 12px（弧底下，属于这个音），原先被当弧脚剔了。
        const inward = (ab: Rect): number => (rcx(kb) - ab.x <= rright(ab) - rcx(kb) ? rcx(kb) - ab.x : rright(ab) - rcx(kb));
        // **实心的点不是弧脚**：弧端断下的一截是弯笔画，墨只占包围盒一半上下（基督更美 12×12 0.50、马槽歌 78 弧右端下垂的钩 0.54）；
        // 真八度点实心（0.69~0.84）。新编赞美诗·四声部 73 的 `1̇ 2̇`、`3̇ — 2̇`、`1̇⌒1` 弧紧挨着点起笔、点就在弧端里外 2px，
        // 全被当弧脚剔掉（这本漏高音点二百来处）
        // 实心、正对数字（横偏 ≤0.2 字号）、**比弧的笔画粗**（短边 ≥1.3 倍弧的逐列墨高中位数）才豁免：粗黑翻印件（1218）弧笔画
        // 5~6px，断下的弧端也实心，但只有弧那么粗（1088 `6⌒5` 右端 6×7 对笔画 5，1.2 倍；403 弧左端外 7×5 对 6、还偏在数字左边 7.5px）；
        // 真点 1.33~2.33 倍（四声部 73、172、177）
        // 只在**声部行**上豁免：四声部排得紧，弧贴着音起笔、点就在弧端里外；单声部的粗黑翻印件（1218）弧端断块实心近方、
        // 与弧笔画之比 1.4（750 `5⌒6` 右端 7×7），跟真点分不开，照旧按弧脚剔。另要近方（宽高比 ≤1.4）：弧端下垂的钩横着拉长（435 13×8）
        const solidDot = voiceMates.length > 0 && inkFill(bin, kb) >= 0.65 && Math.abs(rcx(kb) - rcx(d)) <= numH * 0.2 &&
          Math.max(kb.w, kb.h) <= Math.min(kb.w, kb.h) * 1.4;
        const isArcFoot = !cls.clean && arcs.some((arc) => {
          const ab = arc.bbox;
          if (solidDot && Math.min(kb.w, kb.h) >= (median(columnInk(bin, ab, 0, ab.h).filter((v) => v > 0)) || 1) * 1.3) return false;
          return rbottom(ab) > kb.y && rbottom(ab) <= rbottom(kb) + numH * 0.15 &&
            rcx(kb) >= ab.x - footReach && rcx(kb) <= rright(ab) + footReach &&
            inward(ab) <= Math.max(kb.w / 2, numH * 0.15);
        });
        // 声部行才看上方有没有墨（单声部谱高音点头上常压着圆滑线，这条会误伤）。
        // 压在点上的**圆滑线**不算字：四声部 73 `1̇⌒7`、`1̇ 2̇` 弧紧挨着点起笔、正从点上方掠过（上方墨 0.14~0.43），
        // 这本漏高音点二百来处。弧框里的墨不计（弧是扁宽的一条，字的笔画不会落在弧框里）
        const underText = voiceMates.length > 0 && inkAbove(bin, kb, numH,
          // 只扣**拱起来**的（框高是平均线厚的 2.2 倍以上）：上声部的减时线也在弧候选里，扣了它，线下的低音点就被下声部
          // 收成高音点（249 `2̇·` 成了双高音点）
          // 点还得在**弧端**（弧宽两头三成内）：弧正中下方一颗点是延长记号 ⌒·（四声部 10 行末 `1` 头上那个），照旧算墨挡掉
          arcs.filter((a) => a.bbox.w >= numH * 0.7 && a.bbox.h <= numH * 0.8 && a.bbox.h >= numH * 0.2 &&
            a.bbox.h > (a.area / a.bbox.w) * 2.2 && Math.abs(rcx(kb) - rcx(a.bbox)) >= a.bbox.w * 0.2).map((a) => a.bbox)) >= 0.12;
        // 点头顶压着一行小字（四声部 37 末系统男高音行上印着小号分部歌词「自古以来」，字底 2241、点顶 2240、数字顶 2251）：
        // 点整个在那行字的**底线以下**、实心、正对数字、紧贴数字（≤0.35 字号）的照收。字自己底下的点画（灬）在底线以上，
        // 行里的逗号头顶没有字。
        const belowTextLine = (): boolean => {
          if (!voiceMates.length || !solidDot || gapAbove > numH * 0.35) return false;
          const chars = cls.blocks.filter((k) => !rowCores.some((c) => c.bbox === k.bbox) && k.bbox.h >= numH * 0.45 &&
            rbottom(k.bbox) <= d.y && rbottom(k.bbox) >= kb.y - numH * 0.3 && Math.abs(rcx(k.bbox) - rcx(kb)) <= numH * 3);
          if (chars.length < 2 || !chars.some((k) => rcx(kb) >= k.bbox.x && rcx(kb) <= rright(k.bbox))) return false;
          return kb.y >= median(chars.map((k) => rbottom(k.bbox))) - 1;
        };
        if (underText && belowTextLine()) probe("octave.belowTextLine");
        if (!isArcFoot && dotSized(kb) && !hasSideMate(kb) && !nearerOther(true) && (!underText || belowTextLine()) && !inTextLine(kb)) {
          upDots.push(kb); // 上点 → 高八度（几点算几个八度见下面的裁决）
        }
      // 下点 → 低八度。额外一道门专防**歌词字的顶部笔画**：歌词带紧接在数字下方，字顶的短竖/点
      // （如「主」字上方那一笔）正落在数字正下方、dx≈0、间隙也与「减时线下方的低音点」几乎同高
      // （14~15px vs 真点 3~13px），靠位置分不开。改看**它下方还有没有墨**：八度点孤立、下方留白，
      // 字顶笔画下方紧接着字的其余笔画。（先试过宽高比，但小字号图上真点只有 2×3 像素、比值不可靠，
      // 世上所有的民族的真低音点被误剔、音符 100→99.3。）
      } else if (gapBelow >= -1 && belowReach && (inkBelow(bin, kb, numH) < 0.12 || underOwnLine(kb) || overArc(kb) || aboveLyrics(kb)) &&
          dotSized(kb) && !hasSideMate(kb) && !inTextLine(kb)) {
        // 只因「离别声部的数字更近」被拒的另记一笔，留给 resolvePairOctaveDots 按声部组裁决
        if (!nearerOther(false)) downDots.push(kb); else nearDown.push(kb);
      }
    }
    // 八度点是**竖排叠放**的：第二、三个点各自摞在前一个点的正上/正下方——同一条竖线上、
    // 彼此紧挨着（间距不过一个点径）。只按「落在窗口内」计数，音符上方**并排**的两个墨块就被
    // 数成双高八度（17《不失足》首音上方那个「羔」字的碎笔，`3.` 成了 `3̈.`，高了两个八度）。
    // 故由近及远逐个验位，第一个不合就断，后面的一概不数。
    const stackCount = (dots: Rect[], up: boolean): number => {
      const sorted = [...dots].sort((a, b) => (up ? rbottom(b) - rbottom(a) : a.y - b.y));
      let n = 0, prev: Rect | null = null;
      for (const kb of sorted) {
        const diam = (kb.w + kb.h) / 2;
        if (prev) {
          if (Math.abs(rcx(kb) - rcx(prev)) > Math.max(2, diam * 0.9)) break;   // 不在同一条竖线上
          // 同一个音的两个八度点是同一个字模印的，大小差不多：包围盒面积、实心面积都不能差出一倍。
          // 摞在点上方的别的小块（房号小字、碎渣）大多在这里断掉。实心面积只在点够大时才比
          //（小图上的点只有 2×3 像素，腐蚀完都是 0，比不出东西）。
          const areaA = kb.w * kb.h, areaB = prev.w * prev.h;
          if (Math.min(areaA, areaB) < Math.max(areaA, areaB) * 0.5) break;
          const coreA = inkCount(bin, kb), coreB = inkCount(bin, prev);
          if (Math.max(coreA, coreB) >= 6 && Math.min(coreA, coreB) < Math.max(coreA, coreB) * 0.5) break;
          const gap = up ? prev.y - rbottom(kb) : kb.y - rbottom(prev);
          if (gap < -1 || gap > diam * 1.6) break;                              // 与前一个点不相邻
        }
        n++; prev = kb; dotSizes.push(diam);
      }
      return n;
    };
    octave = stackCount(upDots, true) - stackCount(downDots, false);
    octave = Math.max(-3, Math.min(3, octave)); // 简谱八度极少超过 ±2~3
    let div = 0;
    const augmentRects: Rect[] = [];
    const belowLines: Rect[] = [];
    // 单道增时线的宽度按**本页**统计（不设按书的常数，换一本谱照样适用）：压在某个数字块中线附近、紧挨在它右边的横线，取中位数。
    // 按行统计不稳：64 有一行混着一批 15~16px 的短线，行内中位数被拉到 16，30px 的正常单线成了「两道」；整页中位数是 30。
    const dashUnit = (): number => {
      let u = dashUnitOf.get(cls);
      if (u === undefined) {
        const ws = cls.hlines.map((h) => h.bbox).filter((hb) => hb.w <= numH * 1.2 && cls.blocks.some((k) =>
          Math.abs(rcy(hb) - rcy(k.bbox)) <= k.bbox.h * 0.35 && hb.x >= rright(k.bbox) - 1 && hb.x - rright(k.bbox) <= numH * 3)).map((hb) => hb.w);
        u = ws.length >= 5 ? median(ws) : 0;
        dashUnitOf.set(cls, u);
      }
      return u;
    };
    for (const k of cls.hlines) {
      const kb = k.bbox;
      // 增时线 '-'：横线在数字**右侧**（x 不重叠）、与数字**纵向重叠**、且**大致居中**。
      // 前两条与减时线对偶（那条是「在下方 + 横向重叠」），第三条把三种横线按与数字中线的
      // 相对位置分开——三者实测（22 页语料）：
      //   · 真增时线画在数字中线上：|Δcy| ≤ 0.21 字号（283 根里只此一根到 0.21，其余 ≤0.14）；
      //   · 倚音底下的减时线偏在中线**上方**：−0.27~−0.42（它印在主音符左上角，恰好落在前一个
      //     音符右侧的空隙里，纵向也与数字带重叠，只靠「右侧+重叠」拦不住）；
      //   · 下一组音符的减时线偏在中线**下方**：+0.58（音符排得密时从本音符右缘伸出来）。
      // 门开在 0.25：两侧各留 0.04 与 0.02 字号的余量，是实测撑得住的最宽位置。
      // 「中心距 < 0.6 字号」那条老判据两头都不严，正是上面后两种混进来的原因，已由这两条取代。
      const yOverlap = kb.y < rbottom(d) && rbottom(kb) > d.y;
      // 声部行往**下**放到 0.35：新编赞美诗·四声部 f13 的增时线印得偏低（线心比数字中线低 9px、字号 36，正卡在 0.25 上，一首漏二三十道）；
      // 往下离「下一组音符的减时线」（+0.58）还有余量，往上（倚音减时线 −0.27）不动。
      const dcy0 = rcy(kb) - rcy(d);
      const centered = dcy0 >= -numH * 0.25 && dcy0 <= numH * (voiceMates.length ? 0.35 : 0.25);
      if (kb.x >= rright(d) - 1 && kb.x < augR && yOverlap && centered &&
          !stackedHline(cls.hlines, kb, numH) &&
          overlapX(kb, d) < kb.w * 0.4) {
        // 两三道线首尾相接印成一条长线（f13 `4––`：密排时线与线之间不留空）：声部行上比本页单道线的统计宽度（中位数）长出七成、且接近整数倍（差 ≤0.3）的，按宽度折成几道
        const unit = voiceMates.length ? dashUnit() : 0;
        const fit = unit ? kb.w / unit : 1;
        // 只在**挤着排**的地方折：线头贴着前一样东西（数字或上一道线，间隙 ≤ 四分之一道线宽）。线与线之间留得出空的地方不会印成一条——
        // 297 末系统字号大一号，单道线就有 61px（本页统计 31），前后各空着七八十像素。
        const prevR = Math.max(rright(d), ...augmentRects.map(rright));
        const n = fit >= 1.7 && Math.abs(fit - Math.round(fit)) <= 0.3 && kb.x - prevR <= unit * 0.25 ? Math.min(3, Math.round(fit)) : 1;
        if (n > 1) probe("augment.longDash");
        augment += n; augmentRects.push(kb); continue;
      }
      // 减时线(下划线)：横线在数字**正下方**、与数字**横向重叠**（与上面的增时线对偶）；
      // 多条上下堆叠 → div 多层。
      // **弯的不算**：四声部谱两声部挨得近，下一声部头上的圆滑线弧（扁而宽，归进了横线）正好落在上一声部
      // 数字的正下方（新编赞美诗·四声部《圣哉三一歌》Q2 `7⌒2` 的弧，Q1 那个 5 读成了 `5_`）。减时线是直的，
      // 包围盒高≈平均线厚；弧拱起来，包围盒高是线厚的好几倍。
      const below = kb.y - rbottom(d);
      const curved = kb.h >= numH * 0.2 && kb.h > (k.area / kb.w) * 2.2;
      // 减时线**不跨小节线**，也**不会在低音点下方**（次序是数字 → 减时线 → 低音点）。78《马槽歌》下一声部跨小节线的
      // 连音线又扁又直，正落在上一声部 `5̣` 的点下面，被数成了减时线。
      const crossesBar = barlineXs.some((x) => x > kb.x + 2 && x < rright(kb) - 2);
      const underDot = cls.dots.some((o) => Math.abs(rcx(o.bbox) - rcx(d)) <= numH * 0.3 &&
        o.bbox.y >= rbottom(d) - 1 && rbottom(o.bbox) <= kb.y + 1);
      if (!curved && !crossesBar && !underDot && below > -numH * 0.2 && below < numH * 0.75 && overlapX(kb, d) >= Math.min(kb.w, d.w) * 0.4) {
        belowLines.push(kb);
      }
    }
    // 多条减时线是**紧挨着堆叠**的（层距≈线厚的两三倍）。只按「落在窗口内」计数会把窗口下沿
    // 的别的东西也算进来——歌词字的横笔、下一行的记号，于是 `6_ 5_` 被读成 `6__ 5__`，
    // 小节凭空少半拍（《主祢真伟大》第 25/33 小节即此，连 GT 都跟着错了）。
    // 改为：自上而下逐层验距，第一条要紧贴数字底，后面每条与上一条的间距不得超过 0.28 字高，
    // 断档就停止计数——真减时线不会稀稀拉拉地散在半个字高的范围里。
    belowLines.sort((a, b) => a.y - b.y);
    let prev: Rect | null = null;
    for (const kb of belowLines) {
      if (prev === null) {
        if (kb.y - rbottom(d) > numH * 0.45) break; // 第一条离得太远：不是本音符的减时线
      } else {
        // 两条判据取交集，单用哪一条都分不开（实测：小图《沧海一声笑》numH=11 的真双减时线
        // 层距 0.27~0.36 字高、比值 2~4 倍线厚；大图《主祢真伟大》numH=22 的真双减时线
        // 层距 0.18 字高、1.3 倍线厚，而误判进来的歌词横笔是 0.45~0.55 字高、5 倍线厚）。
        const gap = kb.y - prev.y;
        if (gap > numH * 0.40 || gap > Math.max(prev.h, kb.h) * 4.5) break;
      }
      div++;
      prev = kb;
    }
    // 收下的八度点形状不像点（不实、或一边长出一截）：小尖角、重音记号、字的笔画也会过尺寸与居中两道门
    if ([...upDots, ...downDots].some((kb) => inkFill(bin, kb) < 0.55 || Math.max(kb.w, kb.h) > Math.min(kb.w, kb.h) * 1.7)) doubts.push("oct.oddShape");
    // 高音点跟圆滑线的端头粘成了一块（剥弧时点被一起带走、没进点候选）：数字正上方紧挨着的那段墨像一个点
    if (!upDots.length && dotInkAbove(bin, d, numH)) doubts.push("oct.inkAbove");
    const jn: JpNum = { digit, bbox: d, dot, octave, div, augment, augmentRects, ...(doubts.length ? { doubt: doubts } : {}) };
    octDotsOf.set(jn, { up: upDots, down: downDots, nearDown });
    out.push(jn);
  }
  recountUnderlines(bin, out, numH, cls, barlineXs, voiceMates);
  // 复核：纵向偏离本行的「音」（印在音符上方的小字替换音、段落附注里的数字也会被收成音）
  if (out.length >= 4) {
    const cys = out.map((n) => rcy(n.bbox)).sort((a, b) => a - b);
    const mid = cys[cys.length >> 1]!;
    for (const n of out) if (Math.abs(rcy(n.bbox) - mid) > numH * 0.45) n.doubt = [...(n.doubt ?? []), "note.offRow"];
  }
  return out;
}

/** 数字 `d` 正上方（中间几列）离它最近的那段墨像不像一个点（离数字顶不到 0.8 字号）。只量像素、不看连通块——
 *  点跟弧粘成一块时，块的分类认不出它。两种情形：
 *  · 两旁有墨（点粘在弧上）：中间那段墨的高度至少是两旁弧身粗细的 1.8 倍、且不小于 0.2 字号——点就是弧上局部鼓起的一块；
 *    最下面三成那几行横向宽 0.18~0.5 字号（陡的弧尾竖着量也长，但每行横着只有一笔粗）。
 *  · 两旁没墨（孤立的块）：高 0.12~0.45 字号、宽不过 0.45 字号、最短边不小于 0.17 字号、实心（墨占六成以上）。 */
function dotInkAbove(bin: Binary, d: Rect, numH: number): boolean {
  const cx = Math.round(rcx(d));
  const half = Math.max(1, Math.round(numH * 0.12));
  const ink = (x: number, y: number): boolean => x >= 0 && x < bin.w && y >= 0 && y < bin.h && bin.data[y * bin.w + x] === 1;
  const rowHas = (y: number): boolean => {
    for (let x = cx - half; x <= cx + half; x++) if (ink(x, y)) return true;
    return false;
  };
  const top = Math.max(0, Math.round(d.y - numH * 0.8));
  let y = Math.round(d.y) - 1;
  while (y >= top && !rowHas(y)) y--;
  if (y < top) return false;
  const bottom = y;
  while (y >= 0 && rowHas(y)) y--;
  const h = bottom - y;
  if (h > numH * 0.6) return false;
  // 两旁（中间窗口外、0.8 字号内）各列在这一带的墨厚：中位数当弧身粗细
  const side: number[] = [];
  for (let x = cx - Math.round(numH * 0.8); x <= cx + Math.round(numH * 0.8); x++) {
    if (Math.abs(x - cx) <= half + 1) continue;
    let n = 0;
    for (let yy = y + 1 - Math.round(numH * 0.3); yy <= bottom + 2; yy++) if (ink(x, yy)) n++;
    if (n > 0) side.push(n);
  }
  if (side.length >= numH * 0.3) {
    side.sort((a, b) => a - b);
    const stroke = side[side.length >> 1]!;
    if (h < Math.max(numH * 0.2, stroke * 1.8)) return false;
    // 较陡的弧尾竖着量也长，但每一行横着只有一笔粗；点在最下面几行横向有一定宽度
    let widest = 0;
    for (let yy = bottom - Math.max(1, Math.round(h * 0.3)); yy <= bottom; yy++) {
      for (let x0 = cx - half; x0 <= cx + half; x0++) {
        if (!ink(x0, yy)) continue;
        let l = x0, r = x0;
        while (ink(l - 1, yy) && x0 - l < numH) l--;
        while (ink(r + 1, yy) && r - x0 < numH) r++;
        widest = Math.max(widest, r - l + 1);
      }
    }
    return widest >= numH * 0.18 && widest <= numH * 0.5;
  }
  if (h < numH * 0.12 || h > numH * 0.45) return false;
  let l = cx, r = cx;
  const colHas = (x: number): boolean => {
    for (let yy = y + 1; yy <= bottom; yy++) if (ink(x, yy)) return true;
    return false;
  };
  while (colHas(l - 1) && cx - l < numH) l--;
  while (colHas(r + 1) && r - cx < numH) r++;
  const w = r - l + 1;
  return w <= numH * 0.45 && Math.min(w, h) >= Math.max(2, numH * 0.17) && inkFill(bin, { x: l, y: y + 1, w, h }) >= 0.6;
}

/** **补判减时线**：按横线块数出 0 条的音符，直接到像素里量。块分类那条路靠连通域，线跟数字、低音点、连接墨粘成一块时
 *  （赞美诗歌1218 粗黑翻印件大片如此，1188 整页数字都压在线上），块认不出、线就跟着丢了。这里不认块，只量：
 *  · **逐音取样**：数字正下方等距取 5 列，从本行数字中位高处往下（框被粘上来的线撑高了也不受影响）数墨段——厚度像本页线粗
 *    （0.5~1.6 倍 lineH）、该行墨横贯数字宽八成的才是一道线；第一道紧贴数字（≤0.45 字号），层距 ≤0.4 字号，碰到别的
 *    （低音点、歌词笔画这些不横贯或太厚的）就停。5 列取中位数，连接墨、毛刺只占一两列，压不过多数。
 *  · **两数之间有横线**：相邻两音的空隙在数字下部（中位高的七成五以下）有一行墨横贯整个空隙、并伸进两边数字底下，
 *    厚度像线，就两个音都至少一道。线跟数字粘死、数字底下量不清时，空隙里那一段线是干净的。
 *    增时线在数字中线上、够不着这个高度；隔着小节线的不连（减时线不跨小节线）。
 *  只补不减：已数出线的音不动。 */
function recountUnderlines(bin: Binary, nums: JpNum[], numH: number, cls: Classified, barlineXs: number[], voiceMates: readonly Rect[]): void {
  const lineH = cls.lineH;
  if (lineH <= 0 || !nums.length) return;
  const hs = nums.map((n) => n.bbox.h).sort((a, b) => a - b);
  const medH = hs[hs.length >> 1]!;
  const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < bin.w && y < bin.h && bin.data[y * bin.w + x] === 1;
  const rowFull = (y: number, x0: number, x1: number) => { for (let x = x0; x <= x1; x++) if (!ink(x, y)) return false; return true; };
  const thickOk = (t: number) => t >= Math.max(1, lineH * 0.5) && t <= lineH * 1.6 + 1;
  // 这一行从 x 起向左右连着的墨跨过小节线就不是减时线（减时线不跨小节线）：四声部 36 下一声部一道又长又平的连音弧
  // 从上一声部 `1 1 0` 底下横穿过去、跨过小节线，逐列量全像一道线
  const crossesBar = (x: number, y: number) => {
    let l = x, r = x;
    while (ink(l - 1, y)) l--;
    while (ink(r + 1, y)) r++;
    return barlineXs.some((bx) => bx > l + 2 && bx < r - 2);
  };
  // 框比别的数字高、底却与左右邻音齐平的，多出来的是头顶粘着的弧（四声部 8 `3⌒2`：2 连着弧尾，框高 37 对 31），底就是框底；
  // 照「顶 + 字高」量，2 自己的底横被数成一条减时线（全本 `2→2̲` 四十多处）。底比邻音低的才是粘着线，照旧。
  const baseOf = (d: Rect) => {
    if (d.h <= medH * 1.1) return Math.min(rbottom(d), d.y + medH);
    const near = nums.map((n) => n.bbox).filter((o) => o !== d && o.h <= medH * 1.1)
      .sort((p, q) => Math.abs(rcx(p) - rcx(d)) - Math.abs(rcx(q) - rcx(d))).slice(0, 4);
    if (near.length >= 2 && rbottom(d) <= median(near.map(rbottom)) + numH * 0.1) return rbottom(d);
    return Math.min(rbottom(d), d.y + medH);
  };
  // 下界：下一声部行的数字顶（四声部两行挨得近，`5`、`7` 的顶横笔又平又横贯字宽，四声部 333 上一声部 `1̇` 下量出两道线）
  const floorOf = (x0: number, x1: number, yb: number) => {
    let f = bin.h;
    for (const m of voiceMates) if (m.y > yb - numH * 0.3 && m.x < x1 + numH * 0.5 && rright(m) > x0 - numH * 0.5) f = Math.min(f, m.y - 1);
    for (const m of cls.fermataCaps ?? []) if (m.y > yb - 2 && m.x < x1 && rright(m) > x0) f = Math.min(f, m.y - 1);
    return f;
  };
  // 一列里从数字底往下数线
  const colCount = (d: Rect, x: number): number => {
    const yb = baseOf(d), limit = Math.min(bin.h, yb + Math.round(numH * 1.2), floorOf(d.x, rright(d), yb));
    const cx0 = Math.round(d.x + d.w * 0.1), cx1 = Math.round(d.x + d.w * 0.9);
    let n = 0, lastEnd = yb, y = yb;
    while (y < limit) {
      if (!ink(x, y)) { y++; continue; }
      const start = y;
      while (y < limit && ink(x, y)) y++;
      if (start === yb) continue;                                  // 紧贴基线那段是数字自己的底笔（或粘着的线，交给下一条规则）
      if (start - lastEnd > numH * (n ? 0.4 : 0.45)) break;
      const ym = start + ((y - start) >> 1);
      if (!thickOk(y - start) || !rowFull(ym, cx0, cx1) || crossesBar(x, ym) || !usable(x, ym)) break;
      n++; lastEnd = y;
    }
    return n;
  };
  // **一块墨只作一种用**：量到的线所在的连通块已经归给了别的（小节线、点、增时线、别的声部的数字），就不再当减时线；
  // 不粘数字的游离块若是拱起来的（上沿中间比两头高出一个线粗以上）就是弧。
  // 四声部 36 下一声部那道长弧从上一声部 `1 1 0` 底下穿过去，逐列量全像一道线。粘着本行数字的块（1218 1188）照用。
  const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  const owned: Rect[] = [...cls.barlines, ...cls.dots].map((k) => k.bbox).concat(nums.flatMap((n) => n.augmentRects ?? []));
  const compCache = new Map<number, boolean>();
  const usable = (x0: number, y0: number): boolean => {
    const key = y0 * bin.w + x0;
    const hit = compCache.get(key);
    if (hit !== undefined) return hit;
    const seen = new Set<number>([key]), stack = [key];
    let minX = x0, maxX = x0, minY = y0, maxY = y0;
    while (stack.length && seen.size < 60000) {
      const cur = stack.pop()!, cy = (cur / bin.w) | 0, cx = cur - cy * bin.w;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx; if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy, k = ny * bin.w + nx;
        if ((dx || dy) && ink(nx, ny) && !seen.has(k)) { seen.add(k); stack.push(k); }
      }
    }
    const box: Rect = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    const fused = nums.some((n) => overlapX(n.bbox, box) > 0 && n.bbox.y < rbottom(box) && rbottom(n.bbox) > box.y && box.y <= n.bbox.y + n.bbox.h * 0.5);
    let ok = !owned.some((r) => same(r, box)) &&
      !voiceMates.some((m) => m.x >= box.x && rright(m) <= rright(box) && m.y >= box.y && rbottom(m) <= rbottom(box));
    if (ok && !fused && box.h >= numH * 0.2 && box.w >= numH * 0.6) {
      // 弯不弯看**上沿**：左、中、右三处上沿高度，弧中间比两头高出一截；线下挂着低音点的块包围盒也高，但上沿是平的
      const top = new Map<number, number>();
      const cols = [0.1, 0.5, 0.9].map((f) => Math.round(box.x + (box.w - 1) * f));
      for (const k of seen) { const cy = (k / bin.w) | 0, cx = k - cy * bin.w; if (cols.includes(cx) && cy < (top.get(cx) ?? Infinity)) top.set(cx, cy); }
      const [l, m, r] = cols.map((c) => top.get(c) ?? box.y);
      if ((l! + r!) / 2 - m! >= Math.max(2, lineH)) ok = false;
    }
    for (const k of seen) compCache.set(k, ok);
    return ok;
  };
  const found = nums.map((n) => {
    if (n.div || n.augment) return 0;
    const d = n.bbox;
    const cs = [0.2, 0.35, 0.5, 0.65, 0.8].map((f) => colCount(d, Math.round(d.x + d.w * f))).sort((a, b) => a - b);
    return cs[2]!;
  });
  for (let i = 0; i + 1 < nums.length; i++) {
    const a = nums[i]!, b = nums[i + 1]!;
    if ((a.div || found[i]) && (b.div || found[i + 1])) continue;
    if (a.augment) continue;
    const x0 = rright(a.bbox), x1 = b.bbox.x - 1;
    if (x1 - x0 < 1 || x1 - x0 > numH * 1.2) continue;
    if (barlineXs.some((x) => x >= x0 - 2 && x <= x1 + 2)) continue;
    const ext0 = Math.round(x0 - a.bbox.w * 0.3), ext1 = Math.round(x1 + b.bbox.w * 0.3);
    const yb = Math.max(baseOf(a.bbox), baseOf(b.bbox));
    const floor = floorOf(a.bbox.x, rright(b.bbox), yb);
    const yTop = Math.round(Math.max(a.bbox.y, b.bbox.y) + medH * 0.75), yEnd = Math.min(Math.round(yb + numH * 0.45), floor - lineH * 2 - 1);
    // 线带上下两行在空隙里得基本是空的：升号 ♯ 的横笔也横贯空隙，但有两根竖笔穿过它（四声部 333 下一声部 `#5`
    // 的升号正落在上一声部 `1̇ 1̇` 之间的空隙下方，被读成两个音的减时线）
    const rowInk = (y: number) => { let n = 0; for (let x = x0; x <= x1; x++) if (ink(x, y)) n++; return n / (x1 - x0 + 1); };
    let bands = 0, run = 0;
    for (let y = yTop; y <= yEnd + lineH * 2; y++) {
      if (rowFull(y, ext0, ext1)) { run++; continue; }
      if (run) { if (thickOk(run) && y - run <= yEnd && rowInk(y - run - 2) < 0.3 && rowInk(y + 1) < 0.3 && !crossesBar(x0, y - 1 - (run >> 1)) && usable(x0, y - 1 - (run >> 1))) bands++; run = 0; }
    }
    if (!bands) continue;
    if (!a.div && !found[i]) found[i] = Math.min(bands, 2);
    if (!b.div && !found[i + 1]) found[i + 1] = Math.min(bands, 2);
  }
  nums.forEach((n, i) => { if (!n.div && found[i]) { n.div = found[i]!; probe("recountUnderlines"); } });
}
