// 段落词（「（副歌）」）的量宽与落点：旧简谱引擎（`layout.ts::Line.addSectionWords` / `spreadForSectionWords` / `nudgeForSectionWords`）
// 与原样文档（`layout/jianpu/place/band.ts`、`spacing.ts`）共用这一份判据。
import type { CompressMode } from "../common/cjkpunct";
import type { Font } from "../pagetree/font";

/** 段落词落点的几何输入（一行之内，坐标以该行的 group 为原点）。 */
export interface SectionWordGeom {
  /** 锚点音符的墨迹左缘 */
  anchorX: number;
  /** 段落词的文字宽 */
  width: number;
  /** 段落词字号：让位间隙与抬升量都按它算 */
  size: number;
  /** 与和弦之间留的净空；不给就是 0.6 个字号（旧简谱引擎：按字面盒量，收口括号墨迹顶到字面右缘，见 `placeSectionWord`）。
   *  原样文档按墨迹量，给的是和弦与和弦之间那道空（用户定：段落词在保持间距的前提下尽早出现，不离左边的和弦老远） */
  gap?: number;
  /** 和弦那条基线 */
  baseY: number;
  chords: { x0: number; x1: number; y: number }[];
  /** 本小节的左右界（上一条 / 下一条小节线） */
  barLeft: number;
  barRight: number;
  /** 段落词最左能到哪儿：一般就是 `barLeft`，行首那一条是版心左缘（见下） */
  hangLeft: number;
  /** 行的右缘（版心右缘）。**段落词一个字都不许挂到版心外面**，越过小节线也不行。 */
  rightLimit: number;
  /** 行首那一条：落点只有「就地」和「跨在锚点上」两种，不许往右让、更不许抬起来。 */
  atLineStart?: boolean;
  /** 谱面为它缩进过（`Line.sectionWordIndent`），于是**跨在锚点上方**——左括号落到
   *  音符左边、词身压着音符。没缩进过就老老实实从锚点起排。 */
  straddle?: boolean;
  /** 锚点音符**自己头上那个和弦**的右缘（没有就不给）。它跟着音符走，撑开、匀空档
   *  都够不着，所以词只能落到它右边去（原书的 `G（副歌）`）。 */
  ownChordRight?: number;
}

/** 段落词的落点。 */
export interface SectionWordSlot {
  x: number;
  /** 让不开，只能抬到和弦上方一层 */
  lifted: boolean;
  /** 要不抬起来，本小节右界还差多少（lifted 时 > 0） */
  shortfall: number;
}

/**
 * 段落词能往左挂多远。锚点左边还有小节线（`barLeft` 找得到）就不许越过它——越过去
 * 就成了上一小节的标记；**行首**那一条左边没有小节线，最多到**版心左缘**。
 *
 * 原来准它伸进左边距九成（原书在行尾也让段落词伸出版心），但那等于挂到离纸边 6pt 的地方
 * ——024/371/381 三首实测就挂在那儿。口径改成「一个字都不许出版心」。
 */
export function sectionWordHangLeft(barLeft: number | undefined): number {
  return barLeft ?? 0;
}

/**
 * 段落词摆哪儿——**纯几何，不碰页面树**。
 *
 * 先按锚点音符摆在和弦基线上，撞上和弦就**沿 x 让**：右移到那个和弦右边（一路跳过挨着的
 * 和弦找空档，和弦密的行上第一个空档往往在两三个和弦之后），右边出了小节就左移。
 * 小节首本来只许右移，但**行首**那一条例外：可以整个挂到锚点音符**左边**、伸进左边距
 * （`hangLeft`）——原书在行尾也是这么让它伸出版心的。这一步比撑开整个小节省地方，
 * 381《进深进深入主仁爱深渊》的弱起「（副歌）」原来要把弱起小节撑宽一个词。
 * 都让不开才退到和弦**上方**一行，那样虽然多占一层，至少不叠字。
 *
 * 这个判据被两处共用，**必须是同一份代码**：`Line.spreadForSectionWords`（排版前预演，
 * 据此算要撑开多少）与 `Line.addSectionWords`（justify 之后真正摆）。各写一套就会错配——
 * 129 首《荣耀的一天》的「（副歌）」曾因此被抬到和弦上方（spread 那边只按「锚点到小节线
 * 够不够放下这几个字」算，没算跳过和弦这一段）。
 */
/**
 * 段落词的字宽——**要按标点挤压量**（全书半身式，见 common/cjkpunct.ts）。
 *
 * 「（副歌）」四个字里有两个全角括号，半身档下各压掉半格，整词窄一个字身。照全宽量的话，
 * 一是**摆的时候两侧各空半格**（与「（第一调）」那个老毛病同源），二是**冲突检测偏胖**，
 * 明明躲得开和弦却判成让不开，于是去撑小节——撑开量全堆在一两个空档上，音符右边就
 * 空出一大块（173/175/189/193 四首的「（副歌）」）。量和画共用这一份笔位，两边不会错开。
 */
export function sectionWordRun(font: Font, text: string, mode: CompressMode): { width: number; xs: number[] | null } {
  if (mode === "none") return { width: font.measureText(text), xs: null };
  const { xs, width } = font.run(text, mode);
  // 首字是开括号时它的**笔位是负的**（半身档下「（」左挪半格，墨才落在半角格里）。
  // 落点是拿 `x` 当左界算的，不把这半格挪回来，段落词就整体左偏、挂出版心
  //（line-check 的 V1：106/170/189… 六首起点量到 60.x，版心左缘 62.8）。
  const lead = xs[0] ?? 0;
  return { width: width - lead, xs: xs.length > 1 ? xs.map((v) => v - lead) : null };
}

export function placeSectionWord(g: SectionWordGeom): SectionWordSlot {
  // 与和弦之间要留的净空。**半身档下末字是收口括号**，它的墨迹一直顶到 advance 的右边缘，
  // 原来那 0.3 个字身量到纸上只剩一线（173 的「（副歌）」右括号与后面的 G 描边挨着）。
  const gap = g.gap ?? g.size * 0.6;
  // 压不压字看**全行的和弦**（段落词本来就可以伸出小节线，撞的往往是下一小节的第一个和弦）；
  // 但**让位只能在本小节内**——这两件事口径不同，别混。撞上小节外的和弦时右移左移都没用，
  // 只能靠 spreadForSectionWords 撑开本小节：小节线右边的东西整体右移，段落词留在原处，空档就出来了。
  // 「撞不撞」按**留了净空的**区间算：光看有没有重叠，落点会紧贴着和弦停下
  //（173 的「（副歌）」右括号与 G 之间只剩 0.4pt）。
  // 纵向那一档取 1.5 个字身：和弦记的是**框顶**、段落词记的是**基线**，两者同带时差
  // 恰好一个字身上下——照 `< size` 判会**整整差一线**地判成「不同带、不算撞」，
  // 于是词就直接印在和弦上（020 行首的 B）。
  const hit = (x: number): { x0: number; x1: number } | undefined =>
    g.chords.find((c) => Math.abs(c.y - g.baseY) < g.size * 1.5 && x - gap < c.x1 && c.x0 < x + g.width + gap);
  // 行首那一条先试「跨在锚点上」：谱面已经为它缩进过半个词（`sectionWordIndent`），
  // 左边那点地方就是给左括号留的。整个躲到音符左边没必要，就地从锚点起排又会把
  // 音符与小节线之间豁开一道口子——摆中间，两头都只让半个词。
  if (g.atLineStart) {
    // 行首这一条只在两个落点里挑：**就地**（从锚点起排）或**跨在锚点上**（谱面为它
    // 缩进过时）。跨在音符上是首选，但**锚点音符自己头上有和弦**时（020 行首的 B）
    // 那个和弦挪不动——它跟着锚点走，撑开、匀空档都够不着它，于是整个词让到最左边。
    // 撞上了也**摆在这儿不动**，只报「后面那个和弦还得让开多少」——不许再往右让、
    // 更不许抬到和弦上方（刻意否掉的），差的量由 `Line.nudgeForSectionWords`
    // 在 justify 之后从行内其它空档里匀出来。
    // **锚点音符自己头上压着和弦**时（020/103/131 行首的那个）它是挪不开的——它跟着
    // 音符走，撑开、匀空档都够不着。那就只有一个落点：它的右边（原书的 `G（副歌）`）。
    const cands = g.ownChordRight !== undefined
      ? [g.ownChordRight + gap]
      : g.straddle
        ? [Math.max(g.hangLeft, g.anchorX - g.width / 2), g.anchorX]
        : [g.anchorX];
    for (const x of cands) if (!hit(x)) return { x, lifted: false, shortfall: 0 };
    // 都撞就退回**首选**那个落点报差额（不是最后一个候选）：差额是拿来匀空档的，
    // 照更靠右的候选算会多推一截，词摆回首选落点后与和弦之间就空出小半个词
    // （173/189/193 空出 15pt）。
    const x = cands[0];
    const block = hit(x)!;
    return { x, lifted: true, shortfall: x + g.width + gap - block.x0 };
  }
  const first = hit(g.anchorX);
  if (!first) return { x: g.anchorX, lifted: false, shortfall: 0 };
  // 右移找空档：**只跳过本小节内的和弦**。挡路的和弦已经在小节线右边（属下一小节）时就别再跳了，
  // 再跳落点就落到下一小节里去了——那个标记看着就成了下一小节的（405《信靠顺服》的「（副歌）」
  // 曾这样越过小节线、挤到 D7 边上）。那种情形交给 `spreadForSectionWords` 撑：撑开会把小节线
  // 右边的东西整体右移，段落词留在原处，空档就出来了，而且要撑的只是「差的那一点」。
  let cand = first.x1 + gap;
  let block = hit(cand);
  while (block && block.x0 < g.barRight) {
    // **落点必须真的往前走**，否则原地打转停不下来：`hit` 现在按「留了净空的区间」判，
    // 而候选落点正是 `挡路者.x1 + gap`，浮点上 `x1 + gap - gap` 可能比 `x1` 小那么一丁点，
    // 于是又命中同一个和弦（160《我需要祢》就这样把排版卡死）。
    const next = block.x1 + gap;
    if (next <= cand) break;
    cand = next;
    block = hit(cand);
  }
  // 落点**起点必须留在本小节内**；尾巴可以伸过小节线（原书就有印到线右边的），只要不压字、不出版心。
  if (!block && cand < g.barRight && cand + g.width <= g.rightLimit)
    return { x: cand, lifted: false, shortfall: 0 };
  // 只差一点点就能摆下（挡路的是小节线右边那个和弦）——报「还差多少」，让撑开去补
  if (block && cand < g.barRight && cand + g.width <= g.rightLimit)
    return { x: cand, lifted: true, shortfall: cand + g.width - block.x0 };
  const left = first.x0 - g.width - gap;
  if (left >= g.hangLeft && !hit(left) && g.anchorX > g.hangLeft) return { x: left, lifted: false, shortfall: 0 };
  // 让不开就挂到锚点音符左边——行首那一条 `hangLeft` 在左边距里，够挂；
  // 行中的 `hangLeft` 就是 `barLeft`，挂不出去，照旧往下走抬升。
  const hang = g.anchorX - g.width - gap;
  if (hang >= g.hangLeft && !hit(hang)) return { x: hang, lifted: false, shortfall: 0 };
  // 抬起来那一层同样**一个字都不许出版心**（行末那一条锚点靠右时会伸出去）。
  // 先按右缘钳，再按 hangLeft 钳，**冲突时以不出版心为准**——原来外面套的那个
  // `Math.max(hangLeft, …)` 会在「词比 hangLeft 到版心右缘还宽」时把落点顶回去，
  // 于是仍旧挂出版心（120 首的「（副歌）」）。
  // 左界这里取的是**版心左缘（0）而不是 hangLeft**：hangLeft 是「不许越过上一条小节线」，
  // 那是就地摆放时的口径；抬起来这一层已经离开了和弦带，越过小节线也不会被读成
  // 上一小节的标记，而「出版心」是硬伤。
  const lifted = Math.max(0, Math.min(g.anchorX, g.rightLimit - g.width));
  return { x: lifted, lifted: true, shortfall: Math.max(0, cand + g.width - g.barRight) };
}
