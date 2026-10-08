import { type StaffNote } from "../staffomr/notedata";
import type { PObj, SPage, Staff } from "../staffomr/model";
import { type LyricLine, type LyricRowInfo } from "../staffomr/textanalyze";
import { median, quantile } from "../omrkit/geom";

/** 不管「下方那行谱下面已有词」那道互斥的证据：只对得上下方的至少这么多个（上方一个没有）。 */
const LYRIC_ONLY_DECISIVE = 6;

/**
 * **中英对照的闭合谱：下一行谱底下的拉丁歌词并到上一行谱**（段号由 `numberVersesByScript` 接着排）。
 *
 * 齐来称颂伟大之神那种排法：中文四段印在女声谱表下（两谱表之间），英文四段印在男声谱表下。
 * `buildLyricLines` 按「上方最近的谱行」收，两边各编 1~4 段，中文第 1 段与英文第 1 段
 * 就成了同一段，混成一串。照独唱谱的约定（坚固保障：中文 1~4、英文 5~8，都挂在旋律上）
 * 把英文挂回上一行谱。
 *
 * 只在同一系统里**上一行谱全是汉字段、下一行谱全是拉丁段**时并——合唱谱四个声部
 * 各印各的中文词，那是各声部自己的第 1 段，不能动。
 */
export function foldBilingualLyrics(pg: SPage, lines: LyricLine[]): void {
  const latin = isLatinLine;
  for (const sys of pg.systems) {
    for (let i = 0; i + 1 < sys.staves.length; i++) {
      const up = lines.filter((l) => l.staff === sys.staves[i]);
      const lo = lines.filter((l) => l.staff === sys.staves[i + 1]);
      if (!up.length || !lo.length || up.some(latin) || !lo.every(latin)) continue;
      // 段号由 `numberVersesByScript` 按文种重编，这里只管挪谱行
      for (const l of lo) l.staff = sys.staves[i];
    }
  }
}

/** 闭合谱的门槛：和弦附音与主音之比。 */
const LIFT_CHORDY = 0.3;

/**
 * **字挂到同一拍最上面的音**（旋律）：`attachLyrics` 只按 x 找最近的音，同一 x 上的几个和弦成员、
 * 上下两个声部谁排在前面就给谁，常落在女低或和弦的下方音上（万福泉源歌第 1 段每个字都挂在 E4、GT 在 G4）。
 * 测评按拍位展开后同一拍的音从高到低排，挂错一个成员就错开一位。同一行谱、x 相差不到半个线距、
 * 更高又没挂这一段字的音，把字挪上去。
 */
export function liftLyrics(pg: SPage, notes: StaffNote[], sp: number): void {
  // 只在**闭合谱**的谱行上挪（和弦附音占这行音的 `LIFT_CHORDY` 以上：女高女低同印一行，几乎每个音都是和弦）。
  // **三行谱以上的系统不挪**（合唱谱：一个声部一行谱，外加钢琴）。那种声部行上同 x 更高的「和弦成员」多是多认出来的
  // 假头（破碎女高那行 C5 上叠出 F5），挪上去女高、女低歌词 98 → 96、97 → 94%。按「三行以上挂着歌词」判不够：
  // 扫描件（望十架）只在最上面一行认出了歌词。独唱谱语料的系统都是高低音两行
  const choral = new Set<Staff>();
  for (const sys of pg.systems) if (sys.staves.length >= 3) for (const st of sys.staves) choral.add(st);
  const chordy = new Set<Staff>();
  for (const st of new Set(notes.map((n) => n.staff))) {
    if (choral.has(st)) continue;
    const ns = notes.filter((n) => n.staff === st && !n.rest && !n.grace);
    if (ns.filter((n) => n.chordExtra).length >= ns.filter((n) => !n.chordExtra).length * LIFT_CHORDY) chordy.add(st);
  }
  for (const n of notes) {
    if (!n.lyrics?.length || n.rest || !chordy.has(n.staff)) continue;
    let top = n;
    for (const m of notes)
      if (m.staff === n.staff && !m.rest && !m.grace && Math.abs(m.x - n.x) < sp * 0.5 && m.diatonic > top.diatonic &&
        (m.chordExtra || n.chordExtra) && m.duration === n.duration)
        top = m;
    if (top === n) continue;
    const move = n.lyrics.filter((l) => !top.lyrics?.some((q) => q.verse === l.verse));
    if (!move.length) continue;
    (top.lyrics ??= []).push(...move);
    n.lyrics = n.lyrics.filter((l) => !move.includes(l));
    if (!n.lyrics.length) n.lyrics = undefined;
  }
}

/** 拉丁段在页内先编成 `LATIN_VERSE + k`，整首的中文段数定了再挪到中文段后面（`settleLyricVerses`）。 */
const LATIN_VERSE = 100;

/** 一行里伸出上方各行范围的音节，至少连着这么多个才拆成单独一段（见 `numberVersesByScript`）。 */
const SPLIT_RUN = 3;

const isLatinLine = (l: LyricLine) => {
  const t = l.syllables.map((s) => s.text).join("");
  const cjk = [...t].filter((c) => /[\u3400-\u9fff]/.test(c)).length;
  const lat = [...t].filter((c) => /[A-Za-z]/.test(c)).length;
  return lat > cjk * 3;
};

/**
 * **段号按文种分开编**：每行谱下的歌词行按上下次序，汉字行编 1、2、3…，拉丁行编 `LATIN_VERSE + 1`…。
 *
 * 副歌只印一次的中英对照谱（倚靠主永远膀臂、大地风光、当我们回到天家、更亲近恩主、数算主恩、信心使我得胜），
 * 副歌那几行谱下只有一行中文一行英文。原来按上下次序连着编，英文副歌成了第 2 段，
 * 落进中文第 2 段（GT 记在英文第 1 段，中文第 2 段整段归零）。
 * 英文从第几段起要看**整首**的中文段数（倚靠主第二页只有副歌），这里先占位，见 `settleLyricVerses`。
 */
/**
 * **一行谱两个声部、上下各印一行词：各归哪个声部**（望十架独唱 / 女低共用一行谱，独唱的词印在谱表上方、女低的印在下方）。
 * 不分的话两行词按 x 挂到同一串音上，下方那行成了上声部的第 2 段，下声部一个字也没有（GT 是各声部各一段中文）。
 *
 * 同 `lyricsBelongBelow`，照简谱两声部一组裁决八度点的判法：**不按上下位置定，按排除性证据定**。
 * 逐音节数「只对得上第一声部的音」与「只对得上其余声部的音」（两个声部同一拍都有音的不表态），
 * 比「上方那行归第一声部、下方归其余」与「反过来」两种分法哪种的证据多；**一个声部同一处不会挂两行同文种的词**，
 * 所以一行定了另一行就是另一个声部。证据至少 `LYRIC_ONLY_MIN` 个、且是另一种分法的 `LYRIC_ONLY_RATIO` 倍才分，
 * 否则照原样（两行当同一串音的两段词）。只拿汉字行算证据，同一侧的拉丁行跟着同侧的汉字行走。
 */
export function splitVoiceLyrics(pg: SPage, lines: LyricLine[], notes: StaffNote[], sp: number): void {
  for (const st of pg.staves) {
    const ls = lines.filter((l) => l.staff === st);
    const above = ls.filter((l) => l.top < st.box.top);
    const below = ls.filter((l) => l.top > st.box.bottom);
    if (!above.length || !below.length) continue;
    const ns = notes.filter((n) => n.staff === st && !n.rest);
    const v1 = ns.filter((n) => n.voice === 1).map((n) => n.x);
    const v2 = ns.filter((n) => n.voice !== 1).map((n) => n.x);
    if (!v1.length || !v2.length) continue;
    const cxs = (side: LyricLine[]) => side.filter((l) => !isLatinLine(l)).flatMap((l) => l.syllables.map((q) => q.cx));
    const [a1, a2] = onlyFits(cxs(above), v1, v2, sp);
    const [b1, b2] = onlyFits(cxs(below), v1, v2, sp);
    const straight = a1 + b2; // 上方归第一声部、下方归其余
    const swapped = a2 + b1;
    const [upper, lower] =
      straight >= LYRIC_ONLY_MIN && straight >= swapped * LYRIC_ONLY_RATIO ? [1, 2] as const
      : swapped >= LYRIC_ONLY_MIN && swapped >= straight * LYRIC_ONLY_RATIO ? [2, 1] as const
      : [null, null];
    if (!upper || !lower) continue;
    for (const l of above) l.voice = upper;
    for (const l of below) l.voice = lower;
  }
}

export function numberVersesByScript(pg: SPage, lines: LyricLine[]): void {
  const span = (l: LyricLine) => [Math.min(...l.syllables.map((s) => s.left)), Math.max(...l.syllables.map((s) => s.right))] as const;
  const extra: LyricLine[] = [];
  // 分了声部的（`splitVoiceLyrics`）各声部各编各的段号
  for (const st of pg.staves) for (const v of [undefined, 1, 2] as const) {
    const ls = lines.filter((l) => l.staff === st && l.voice === v).sort((a, b) => a.top - b.top);
    // 第几段 = 上方同文种、**横向盖得住**它的行数 + 1。各段全宽排的，彼此都盖得住，照旧按上下次序；
    // 副歌只印在右半边的（信心使我得胜「Faith is the vic-to-ry!」印在中文第 3 段那一行的右边），
    // 左边主歌那几段盖不着它，就是本文种的第 1 段。
    // **按音节数**：一行的后半截伸进上方各行都没印的地方（倚靠主低音谱表下第 2 行英文「…arms. Lean-ing on Je-sus,」，
    // 后半是副歌的呼应句，上面那行英文到「arms.」就停了），那一截是本文种的第 1 段，拆出去单独成行。
    // 伸出去不到一个音节宽、或不到 `SPLIT_RUN` 个音节的不拆：各段结尾差一两个音（melisma）是常事。
    // 汉字行也拆：GT 约定统一成「副歌只印一次的，副歌记第 1 段」（原先是谁、以马内利来临歌、你的信实广大
    // 三份照印记在第 2 段，已改成第 1 段；数算主恩、更亲近恩主本来就记第 1 段）。
    const done: LyricLine[] = [];
    for (const l of ls) {
      const lat = isLatinLine(l);
      const above = done.filter((o) => isLatinLine(o) === lat).map(span);
      const sw = median(l.syllables.map((s) => s.right - s.left));
      const ks = l.syllables.map((s) => above.filter(([a, b]) => s.cx > a - sw && s.cx < b + sw).length + 1);
      const k0 = above.filter(([a, b]) => a < span(l)[1] && b > span(l)[0]).length + 1;
      // 连续同号的段，太短的并回整行的号
      const runs: { k: number; from: number; to: number }[] = [];
      ks.forEach((k, i) => {
        const r = runs[runs.length - 1];
        if (r && r.k === k) r.to = i + 1;
        else runs.push({ k, from: i, to: i + 1 });
      });
      // 汉字行的副歌起句（数算主恩第 3 段行尾「…見天父．主的恩典，樣樣」、是谁第 2 段「捨命，是你，主耶穌…」）。
      // 两道闸：末段后的「阿们」不算（GT 记在末段：唱完末段才唱，不是副歌；万古磐石歌、救主降生等七首）；
      // 行首那一截（上一行接下来的副歌，是谁「你。是你，主耶穌，唯有你。」）要以句末标点收尾——
      // 各段字数不同的曲子行首本来就参差（耶和华是我的牧者「我擺設筵」「隨着」，96.2 → 90.9%）
      const refrain = (r: { from: number; to: number }) =>
        !/^[（(]?阿$/.test(l.syllables[r.from].text) && (r.from > 0 || /[。！？!?]$/.test(l.syllables[r.to - 1].text));
      const cut = runs.filter((r) => r.k !== k0 && r.to - r.from >= (lat ? SPLIT_RUN : 2) && (lat || refrain(r)));
      l.verse = lat ? LATIN_VERSE + k0 : k0;
      for (const r of cut) {
        extra.push({ ...l, verse: lat ? LATIN_VERSE + r.k : r.k, syllables: l.syllables.slice(r.from, r.to) });
      }
      if (cut.length) l.syllables = l.syllables.filter((_, i) => !cut.some((r) => i >= r.from && i < r.to));
      done.push(l);
    }
  }
  lines.push(...extra);
}

/** 呼应句改挂下一行谱：音节「明显离下一行谱的音更近」至少占这么多（明显 = 近半个线距以上）。 */
const ECHO_LOWER = 0.5;

/** 同时「明显离上一行谱更近」的不超过这么多；上方要有一行跟上一行谱走的（明显离下一行谱更近的不超过 `ECHO_UPPER_ROW`）。 */
const ECHO_UPPER = 0.1;

const ECHO_UPPER_ROW = 0.15;

/**
 * **印在两行谱之间、其实是下一行谱声部的词**，改挂下一行谱（`buildLyricLines` 一律挂上方最近的谱行）。
 *
 * 副歌一呼一应的谱（倚靠主永远膀臂）：高音唱长音「倚——靠」，低音接「倚靠主耶穌」，
 * 低音的词印在两谱表之间、主歌各行下面，被当成高音谱表的第 2 段（GT 记在低音的第 1 段）。
 * 判据是**音节离哪一行谱的音近**：四部和声两行谱节奏大多一样，两边一样近，照旧挂上面；
 * 应答句落在高音没有音的地方，明显离低音近（倚靠主三处 0.57~0.75，主歌各行 0~0.1）。
 * **要有对比**：同一行谱下，上面先有一行跟着上一行谱走，它下面才出现跟低音走的行，从那一行起往下都挂下一行谱。
 * 耶和华是我的牧者一行谱下三段词全都偏向低音（0.40~0.69，高音谱表的音认漏了），不能挪——只看单行挪了，中文 96 → 45%。
 */
export function moveEchoLines(pg: SPage, lines: LyricLine[], notes: StaffNote[], sp: number): void {
  const xsOf = (st: Staff) => notes.filter((n) => n.staff === st && !n.rest && !n.grace).map((n) => n.x);
  const near = (x: number, xs: number[]) => Math.min(Infinity, ...xs.map((y) => Math.abs(y - x)));
  for (const sys of pg.systems) {
    for (let i = 0; i + 1 < sys.staves.length; i++) {
      const up = sys.staves[i];
      const lo = sys.staves[i + 1];
      const upX = xsOf(up);
      const loX = xsOf(lo);
      const frac = (l: LyricLine, a: number[], b: number[]) => l.syllables.filter((q) => near(q.cx, a) + sp * 0.5 < near(q.cx, b)).length / l.syllables.length;
      const gap = lines.filter((l) => l.staff === up && l.top < lo.box.top && l.syllables.length >= 3).sort((p, q) => p.top - q.top);
      let seenUpper = false;
      let from = -1;
      gap.forEach((l, k) => {
        const lb = frac(l, loX, upX);
        if (from < 0 && seenUpper && lb >= ECHO_LOWER && frac(l, upX, loX) <= ECHO_UPPER) from = k;
        if (lb <= ECHO_UPPER_ROW) seenUpper = true;
      });
      if (from >= 0) for (const l of gap.slice(from)) l.staff = lo;
    }
  }
}

/**
 * 整首的音符（各页 `recognizeRasterPage` 的 `notes` 连起来）：拉丁段挪到中文段后面
 *（中文三段就从第 4 段起），段号与独唱谱的约定一致（坚固保障：中文 1~4、英文 5~8）。
 * 全曲没有中文段的，英文从第 1 段起。
 * **零星几个字的段不算数**（字数不到最多那段的两成）：我灵镇静第三系统一条只认出「夏：」的假行
 * 成了中文第 4 段，英文整体后移一段，拉丁 81.6% → 19.4%。
 */
export function settleLyricVerses(notes: { lyrics?: { verse: number }[] }[]): void {
  const count = new Map<number, number>();
  for (const n of notes) for (const l of n.lyrics ?? []) if (l.verse < LATIN_VERSE) count.set(l.verse, (count.get(l.verse) ?? 0) + 1);
  const most = Math.max(0, ...count.values());
  let zh = 0;
  for (const [v, c] of count) if (c >= most * 0.2) zh = Math.max(zh, v);
  for (const n of notes) for (const l of n.lyrics ?? []) if (l.verse > LATIN_VERSE) l.verse = zh + l.verse - LATIN_VERSE;
}

/**
 * **和弦挂到同一拍的上声部**。`attachHarmonies` 只按 x 远近挑音，同一拍上下两个声部的头
 * 横向只差几个像素，谁近谁得；挂到下声部，写出来就排在 `<backup>` 后面，与 GT 的次序对不上
 *（圣哉三一歌伴奏 m5、m15：头的干一补上、时值一改，和弦就跳到了下声部，和弦档 100% → 86.7%）。
 * 和弦记号印在谱表上方，归上面那个音：同一谱行、x 差不到半格、位置更高又没挂和弦的音，挪过去。
 * 只补位图这一路，不动 `staffomr`。
 */
export function liftHarmonies(notes: StaffNote[], sp: number): void {
  for (const n of notes) {
    if (!n.chord || n.rest) continue;
    let top: StaffNote | null = null;
    for (const m of notes) {
      if (m === n || m.rest || m.chord || m.staff !== n.staff || Math.abs(m.x - n.x) >= sp * 0.5) continue;
      if (m.sym.box.top >= (top ?? n).sym.box.top) continue;
      top = m;
    }
    if (!top) continue;
    top.chord = n.chord;
    n.chord = undefined;
  }
}

/** 音节离符头多远（格）算对得上。 */
const LYRIC_NOTE_DX = 0.9;

/** 改挂到下方那行谱：下方那行**一音一字**对得上的音节占比下限。 */
const LYRIC_BELOW_FIT = 0.6;

/**
 * 上方没有谱（页顶那条带）的行要一音一字对上这么多才挂：那里还有标题。大字号标题的整字比歌词字号上限高，进不了歌词带，
 * 只剩几个零碎偏旁当字格，字距也就量不准（你的信实广大页顶标题 5/7 = 0.71 对得上下方的音；望十架 p3 页顶那行歌词 0.93）。
 */
const LYRIC_HEAD_FIT = 0.8;

/** 「只对得上一边」的音节至少几个、且是另一边的几倍，才算这一边的证据压过另一边。 */
const LYRIC_ONLY_MIN = 3;

const LYRIC_ONLY_RATIO = 2;

/** 至少这么多个音节才判。 */
const LYRIC_BELOW_MIN = 4;

/** 歌词的字距：相邻音节中心距的中位数至少是字高的这么多倍。标题、署名字挨着字排（1.0 上下），歌词跟着音符排开。 */
const LYRIC_PITCH_MIN = 1.5;

/** 一串音节 x 里，「只对得上 a 那串音、对不上 b 那串」的个数与「反过来」的个数（x 差在 `LYRIC_NOTE_DX` 格以内算对上）。 */
function onlyFits(cxs: number[], a: number[], b: number[], sp: number): [number, number] {
  const hit = (xs: number[], cx: number) => xs.some((x) => Math.abs(x - cx) <= sp * LYRIC_NOTE_DX);
  let oa = 0, ob = 0;
  for (const cx of cxs) {
    const ha = hit(a, cx), hb = hit(b, cx);
    if (ha && !hb) oa++;
    else if (hb && !ha) ob++;
  }
  return [oa, ob];
}

/**
 * **一音一字**对得上的音节占比：按 x 从左到右，每个音节配离它最近、还没配过的那一拍（同一列的和弦成员算一拍），
 * x 差在 `LYRIC_NOTE_DX` 格以内才算。只看「附近有没有音」的话，一个音能被前后几个字都算上，挤在一起的标题也凑得出高比例。
 */
function oneToOneFit(cxs: number[], noteXs: number[], sp: number): number {
  const cols: number[] = [];
  for (const x of [...noteXs].sort((p, q) => p - q)) if (!cols.length || x - cols[cols.length - 1] > sp * 0.3) cols.push(x);
  const used = new Set<number>();
  let hit = 0;
  for (const cx of [...cxs].sort((p, q) => p - q)) {
    let bi = -1;
    for (let i = 0; i < cols.length; i++) if (!used.has(i) && Math.abs(cols[i] - cx) <= sp * LYRIC_NOTE_DX && (bi < 0 || Math.abs(cols[i] - cx) < Math.abs(cols[bi] - cx))) bi = i;
    if (bi >= 0) used.add(bi), hit++;
  }
  return cxs.length ? hit / cxs.length : 0;
}

/**
 * **夹在两行谱之间的歌词归哪一行**（`buildLyricLines` 的 `pickBelow`）。默认一行歌词归它上方最近的那行谱；
 * 可有的声部把词印在谱表上方（望十架 p3 独唱声部；页底那行词其实是下一系统顶行的，挂到了上一系统的钢琴左手上）。
 *
 * 照简谱夹在两行数字之间的八度点那套判法（`omr/jpnums.ts::resolvePairOctaveDots`，见实现篇「两声部一组裁决」）：
 * **不按远近、也不比总的对位率**，先看互斥、再看排除性的证据——
 *   - 上方没有谱（页顶那条带）：没有别的主，可那里也有标题、署名、速度语。**行首有段号（一位数）的是歌词**（强判据，
 *     免掉字距、一音一字对上六成就挂）；
 *     否则要字距像歌词（相邻音节中心距的中位数 ≥ 1.5 个字高：标题、署名字挨着字排）、且一音一字对得上下方那行八成；
 *   - **互斥**：下方那行谱是单声部、自己下面已经有词（简谱「下声部脚下已有点，夹在中间的这颗归上声部」），归上方；
 *     两声部一行的谱上下可以各挂一行（各归一个声部），不互斥；上方那行谱与这一行之间已有它自己的汉字行的，这一行是
 *     它往下接的一段，也归上方；
 *   - 两边都有谱：逐音节看对不对得上两边的音，**两边都对得上的不表态**（SATB 上下两行节奏一样，各音节两边都对得上，
 *     证据为零，照默认挂上方）；只对得上下方的至少 `LYRIC_ONLY_MIN` 个、且是只对得上上方的 `LYRIC_ONLY_RATIO` 倍，
 *     下方那行又一音一字对得上六成，才挂下方。
 */
/** 下方那行谱算「两声部一行」的第二声部音数下限。 */
const LYRIC_TWO_VOICE_MIN = 3;

export function lyricsBelongBelow(row: LyricRowInfo, verseObjs: Set<PObj>, notes: StaffNote[], sp: number): Staff | undefined {
  const { syllables, above, below } = row;
  const cxs = syllables.map((q) => q.cx);
  const xsOf = (st: Staff) => notes.filter((n) => n.staff === st && !n.rest).map((n) => n.x);
  const xb = xsOf(below);
  if (!above) {
    const fit = oneToOneFit(cxs, xb, sp);
    // 段号是强判据：免掉字距，一音一字照两行之间那一档（六成）
    if (row.objs.some((o) => verseObjs.has(o))) return fit >= LYRIC_BELOW_FIT ? below : undefined;
    if (cxs.length < LYRIC_BELOW_MIN) return undefined;
    // 字距：相邻音节中心距的中位数 / 字号。字号取各音节字格**长边**（宽、高取大）的 85 分位（汉字是方的；同 `lyric.ts` 量字宽）：
    // 大字号的标题整字进不了歌词带，只剩碎笔当字格，高只有两三像素（我一生要赞美你页顶标题「一」只剩一横，
    // 按字格高量字距 3.3 倍，六个字又碰巧一音一字全对上；碎笔长短不一，中位数也只有 44、真字 83）；整行的行盒也不行，
    // 一行里常并着别处小字号的字。真歌词的字号很齐，85 分位就是字号
    const sorted = [...syllables].sort((p, q) => p.cx - q.cx);
    const gaps = sorted.slice(1).map((q, i) => q.cx - sorted[i].cx).sort((p, q) => p - q);
    const charH = quantile(sorted.map((q) => Math.max(0, ...q.glyphs.map((g) => Math.max(g.bbox.w, g.bbox.h)))), 0.85);
    if (!(charH > 0) || gaps[gaps.length >> 1] < charH * LYRIC_PITCH_MIN) return undefined;
    return fit >= LYRIC_HEAD_FIT ? below : undefined;
  }
  if (cxs.length < LYRIC_BELOW_MIN) return undefined;
  if (oneToOneFit(cxs, xb, sp) < LYRIC_BELOW_FIT) return undefined;
  // 互斥：下方那行谱是单声部、自己下面已有词，这一行就是上方那行的（破碎 p8 女低那行词有几处女低休止、男高有音，按证据挪去了男高）。
  // 两声部一行的不算：上方的词归上声部、下方的归下声部，两边各挂一行（望十架独唱 / 女低，见 `splitVoiceLyrics`）
  // 证据压倒的不管这道互斥：只对得上下方的够多、上方一个都对不上、下方一音一字几乎全对上
  //（望十架 p3 独唱 / 女低共用一行谱，词上下各一行；这时声部还没分，`voice` 全是 1，上方那行被挡在上一系统的钢琴左手上）
  const fit = oneToOneFit(cxs, xb, sp);
  const [onlyA, onlyB] = onlyFits(cxs, xsOf(above), xb, sp);
  const decisive = onlyA === 0 && onlyB >= LYRIC_ONLY_DECISIVE && fit >= 0.9;
  // 两声部要真有一批第二声部的音：一个落单的（多认的假头被分到声部 2）不算，破碎扫描版 p8 男高 m87 的假 A4 让女低那行词又挪去了男高
  const belowNotes = notes.filter((n) => n.staff === below && !n.rest);
  const v2 = belowNotes.filter((n) => n.voice !== 1).length;
  if (row.belowHasOwn && !decisive && !(v2 >= LYRIC_TWO_VOICE_MIN && v2 >= belowNotes.length * 0.1)) return undefined;
  // 另一面的互斥：上方那行谱与这一行之间已有它自己的汉字行，这一行是那串多段歌词往下接的一段
  //（万古磐石歌第 4 段离下一系统近、下一系统两声部，按证据挪了过去，中文 100 → 75%）
  if (row.aboveHasOwn) return undefined;
  return onlyB >= LYRIC_ONLY_MIN && onlyB >= onlyA * LYRIC_ONLY_RATIO ? below : undefined;
}
