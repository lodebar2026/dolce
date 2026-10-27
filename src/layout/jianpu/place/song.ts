// 一首（及一份文档）的定位：逐组排声部、组间让位、分页，长图把各页接成一张。
import type { Meter, MusicElement, NoteElement, FanqieSong } from "../../../jianpu/ast";
import { contentWidth, type JianpuGrid } from "../metrics";
import { paginate, type SystemBlock } from "../../../jianpu/vertical";
import type { InkMeasurer, PlacedGroup, PlacedPage, PlacedScore, PlacedVoice } from "./model";
import { placeColumns } from "./spacing";
import { type BeatCtx, assignLyrics, computeUnderlines, layoutVoiceLine, lineEndMeter, lineEndsWithForwardRepeat } from "./voice";
import { GROUP_CLEAR, braceReach, splitRise, wordsLead, groupHeadroom, lineInkBottom, voiceHeadroom } from "./vertical";
import { belowArcsBottom, placeMarks } from "./marks";
import { belowLayerLines, placeLayers } from "./layers";
import { placeBand } from "./band";

/**
 * `&sbf`（声部符）标出的分声部位置：取标着它的那条小节线**之后**第一个符号的 x。
 * 组内任一声部标了都算，取最早的一处。
 */
function braceStartX(voices: readonly PlacedVoice[]): number | null {
  let best: number | null = null;
  for (const v of voices) {
    const items = v.items;
    for (let i = 0; i < items.length; i++) {
      const el = items[i]!.element;
      if (el.kind !== "barline") continue;
      if (!el.ornaments.some((o) => o.name === "sbf")) continue;
      const next = items[i + 1];
      const x = next ? next.x : items[i]!.x;
      if (best === null || x < best) best = x;
    }
  }
  return best;
}

/** 组内相邻声部、上面那个没有歌词时，在声部间距之外再空的一道（÷ 音符字号）：只按 `voice-gap` 排两行数字之间
 *  不到一个字高（太阳出来喜洋洋 A4 `0 0 | 0 0` 两行，用户定加一道空；原谱这里约 2 个字号） */
const NO_LYRIC_VOICE_GAP_EM = 0.6;

/**
 * 分声部（`&sbf`）之前那几个小节，没分出来的声部只是占位（`8`）：谱面上那一截是空的，小节线也不画
 * （`PlacedItem.noBarline`）。只管连谱号起点及以前、前面一整个小节都是隐藏音符的线。
 */
function hideEmptyBarlines(voices: readonly PlacedVoice[], braceFromX: number): void {
  for (const v of voices) {
    let empty = true;
    let any = false;
    for (const it of v.items) {
      if (it.x > braceFromX + 1e-6) break;
      const el = it.element;
      if (el.kind === "barline") {
        if (any && empty) it.noBarline = true;
        empty = true;
        any = false;
      } else {
        any = true;
        if (!(el.kind === "note" && el.hidden)) empty = false;
      }
    }
  }
}

/**
 * 把一首曲子排成若干页。文本谱自己管分页（`[fenye]`），我们只在一页塞不下时再补断。
 */
export function layoutSong(
  song: FanqieSong,
  m: JianpuGrid,
  songIndex = 0,
  headerBottom = 0,
  ink: InkMeasurer,
  /** 展开档（`place/expand.ts` 展开过的行视图）与成书：谱行按旧简谱引擎展开档的口径码页，见下面的 `slideBlock` */
  expanded = false,
): PlacedPage[] {
  // 行占满版心：行首最左的内容（数字落笔原点、升降号、歌词左缘）贴左缘，两端对齐后行末的占位右缘
  //（末个音符的字面右缘、或末条小节线）贴右缘，同旧简谱引擎
  const width = contentWidth(m);
  moveTrailingSectionWords(song);
  autoVerseNumbers(song, m);

  const bottomLimit = m.page.height - m.page.margin.bottom;
  // 整首没有一句歌词的按器乐谱排：力度记号、渐强渐弱记在谱行下方（GB/T 46845 7.3.8 a、7.3.6.3；`band.ts::placeBelow`）
  const instrumental = !song.pages.some((pg) => pg.groups.some((g) => g.voices.some((v) => v.lyrics.length > 0)));
  // 拍号一路带过来：头部 `1=D4/4 3/4 5/4` 这类混合拍只有首个是起头拍号，其余由曲中
  // 的 `"p:3/4"` 逐小节改写（`BarlineElement.temporaryMeter`），故要跨行延续。
  // 只有减时线分组用得着（见 beatGroups）。
  let meterCursor: Meter | undefined = song.metadata.meters[0];
  // 跨行小节：上一行行末那个开口小节已用掉的拍数（见 openTailBeats）
  let carryCursor = 0;
  let atSongStart = true; // 整首的头一组——首小节不满就是弱起
  // 末组（整首的最后一个 system）单独判断：太短就不拉伸，留它短着
  const lastPage = song.pages[song.pages.length - 1];
  const lastGroup = lastPage?.groups[lastPage.groups.length - 1];
  // 每组先按**自己的原点**排（光标从 0 起），占位 = 光标推进的那一段（头顶让位 + 声部 + 歌词
  // + 组间距都在里面）；排完交给公共分页器定页与 y（`jianpu/vertical.ts::paginate`，`.jpwabc` 也走它）。
  // 从前这里自己分页：整组挪下页时先把光标重置到页顶、再减位移，下一组被排到页顶之上
  //（日光之下展开档第 2 页第二组 y = −515），挪过去的那组也丢了头顶的让位。
  const blocks: Array<SystemBlock & { group: PlacedGroup }> = [];
  // 各声部上一行是否以反复起点收尾：本行行首补 `|:`（见 voice.ts::layoutVoiceLine）
  let leadRepeat: boolean[] = [];
  // 各声部上一行行末转的拍号：本行行首再印一遍（见 voice.ts::layoutVoiceLine）
  let leadMeter: Array<Meter | undefined> = [];
  for (const [pageIdx, srcPage] of song.pages.entries()) {
    for (const [groupIdx, group] of srcPage.groups.entries()) {
      let y = 0;
      const beatCtx: BeatCtx = {
        meter: meterCursor,
        carryIn: carryCursor,
        songStart: atSongStart,
        songEnd: group === lastGroup,
      };
      atSongStart = false;
      // 本组之后生效的拍号：以主声部为准（各声部拍号相同）
      for (const el of group.voices[0]?.elements ?? []) {
        if (el.kind === "barline" && el.temporaryMeter) meterCursor = el.temporaryMeter;
      }
      const laidOut = group.voices.map((voice, vi) => layoutVoiceLine(voice, m, {
        ...beatCtx, leadRepeat: leadRepeat[vi] === true, ...(leadMeter[vi] ? { leadMeter: leadMeter[vi] } : {}),
      }));
      leadRepeat = group.voices.map(lineEndsWithForwardRepeat);
      leadMeter = group.voices.map(lineEndMeter);
      carryCursor = laidOut[0]?.tail ?? 0;
      // 音节先挂上（只按序号对到跟词的符号上），列宽要看字宽
      laidOut.forEach((l, vi) => {
        const voice = group.voices[vi]!;
        for (const it of l.items) it.syllables = new Array(voice.lyrics.length).fill(null);
        assignLyrics(l.items, voice.lyrics);
      });
      // 同一谱表第二声部的并排下行也参加归列（它的拍位可能比主行细）
      const below = laidOut.map((l, vi) => belowLayerLines(group.voices[vi]!, l.items, m, beatCtx));
      // 横向：各声部同一拍位归一列、列宽按内容、歌词避让、两端对齐（spacing.ts）
      placeColumns([...laidOut, ...below.flatMap((b) => [...b.values()])], m, ink, width);

      // 纵向先按各声部**自己的基线**排（上方带、记号、内联层都相对基线），头顶多高排完才知道，再定各声部的 y
      const pre = laidOut.map((l, vi) => {
        const voice = group.voices[vi]!;
        const underlines = computeUnderlines(voice, l.items, m, l.groups);
        // 内联层要先排：`{dsb}` 会给主旋律那一段打上 dy，减时线与记号都得跟着走
        const layers = placeLayers(voice, l.items, m, ink, beatCtx, below[vi]);
        // 并排块的下行（主旋律下移，或第二声部排在下行）比基线低一个 splitRise，歌词要跟着让开，否则会和下行音符叠在一起
        let splitDrop = 0;
        for (const lay of layers) {
          if (lay.split) splitDrop = Math.max(splitDrop, Math.abs(lay.split.dy));
        }
        for (const u of underlines) {
          const at = l.items.find((it) => it.x >= u.x0 - 0.01 && it.x <= u.x1 + 0.01);
          if (at?.dy !== undefined) u.dy = at.dy;
        }
        const marks = placeMarks(voice, l.items, m, ink);
        // 第一行歌词的位置：样式给了 `lyric-baseline` 就不低于它；自动值与旧简谱引擎同一口径
        //（`layout.ts::Line.updateLyricY`）：数字墨迹底往下一个音符字号，再让开 max(0.4 字号, 数字底之下的叠层深度)
        //——一行里有「减时线 + 低音点」叠下来的音，歌词整行跟着下移，免得字顶贴到低音点上。
        // 叠印下方的延音线（和音最下面那个音单连的）也算进墨迹底
        const inkBottom = Math.max(lineInkBottom(l.items, m), belowArcsBottom(marks, m));
        const digitBottom = m.ink.noteHeight / 2;
        const lyricY0 = Math.max(
          m.style.vertical.lyricBaseline,
          digitBottom + m.style.size.note + Math.max(m.style.size.note * 0.4, inkBottom - digitBottom),
        );
        // 上方带：弧、连音、奏法记号、和弦、松叶、转调标签、力度/跳转字、临时伴奏行、房号按墨迹一次堆清（band.ts）
        const band = placeBand(l.items, marks, layers, m, ink, width, instrumental);
        const pv: PlacedVoice = {
          voice, y: 0, items: l.items, underlines, layers, marks, lyricY: [], band: band.texts, top: band.top, textTop: band.textTop,
          ...(band.bottom !== null ? { bottom: band.bottom } : {}),
        };
        return { pv, inkBottom: Math.max(inkBottom, band.bottom ?? -Infinity), digitBottom, lyricY0, splitDrop };
      });
      const voices = pre.map((p) => p.pv);

      // `W:` 说明行：末行墨迹底贴首声部带顶之上一道空，多条往上摞（行距 wordsLead）
      const texts = group.texts;
      let textRel = 0;
      let textInkTop: number | null = null;
      if (texts.length > 0) {
        const lastInk = ink.text(texts[texts.length - 1]!.text, "words").ink;
        // 与下面那行谱留 0.8 个说明字号（只留叠层那道空，字就贴在音符、和弦顶上；旧固定槽位约 0.9）
        textRel = (voices[0]?.top ?? -m.ink.noteHeight / 2) - Math.max(m.style.vertical.slurGap, m.style.size.words * 0.8) - lastInk.bottom - (texts.length - 1) * wordsLead(m);
        textInkTop = textRel + ink.text(texts[0]!.text, "words").ink.top;
      }
      // 记号往上画，先给这一组留够头顶空间：上一组末行（歌词基线或音符基线）到本组基线是 `system-gap`，
      // 本组头顶（弧、房号、记号、和弦、`W:` 行）与上一组末行之间至少留 `GROUP_CLEAR` 个歌词字号
      //（歌词下伸约 0.25 字号，再空半行），不够就整组下移
      const head = groupHeadroom(voices, texts.length, textInkTop, m);
      y += Math.max(0, head + GROUP_CLEAR * m.style.size.lyric - m.style.vertical.systemGap);
      const textY = y + textRel;

      pre.forEach(({ pv, inkBottom, digitBottom, lyricY0, splitDrop }, vi) => {
        const voice = pv.voice;
        pv.y = y;
        pv.lyricY = voice.lyrics.map((_, li) => y + lyricY0 + splitDrop + li * m.style.vertical.lyricStack);
        // 下一声部：先让过本声部的歌词块，再按「有没有歌词」取不同的间距
        //（歌词字块的下缘比数字低，所以它之后要多让一点）
        const isLast = vi === pre.length - 1;
        const hasLyrics = voice.lyrics.length > 0;
        // 并排块把主旋律压低了半个行距，下一声部要连这一段一起让开
        // 没有歌词的声部按墨迹底让：低音点、减时线叠下来的那截照算；组末声部再加数字下半截，
        // 组间那道空（下一组头顶的 GROUP_CLEAR）才是从墨迹底量起——只按基线让，两组谱几乎贴着（太阳出来喜洋洋 A4）
        const consumed = hasLyrics
          ? lyricY0 + splitDrop + (voice.lyrics.length - 1) * m.style.vertical.lyricStack
          : splitDrop + Math.max(0, inkBottom - digitBottom) + (isLast ? digitBottom : NO_LYRIC_VOICE_GAP_EM * m.style.size.note);
        let after = isLast ? m.style.vertical.systemGap : m.style.vertical.voiceGap;
        // 下一声部头顶的弧线/记号也要让开，否则会画进上面的歌词或音符里
        const next = pre[vi + 1]?.pv;
        if (next) {
          after = Math.max(after, voiceHeadroom(next) + m.ink.noteHeight * 0.6);
          // 下一声部有并排块：上行整个抬高 splitRise，与本声部（歌词）之间照常留一个声部间距
          if (next.voice.elements.some((el) => el.kind === "inline-layer" && el.role === "voice")) {
            after = Math.max(after, m.style.vertical.voiceGap + splitRise(m));
          }
        }
        y += consumed + after;
      });

      const hasBrace = voices.length > 1;
      const placedGroup: PlacedGroup = {
        group,
        voices,
        textY,
        braceTop: voices[0]!.y,
        braceBottom: voices[voices.length - 1]!.y,
        hasBrace,
        song: songIndex,
      };
      // `&sbf`（声部符）标在哪条小节线上，连谱号就从那里起——前半段还是单声部，
      // 不该被括进来（原版《同一首歌》第 3 个 system 就是这样：前 4 小节 `8` 占位）。
      const sbf = braceStartX(voices);
      if (sbf !== null) {
        placedGroup.braceFromX = sbf;
        hideEmptyBarlines(voices, sbf);
      }
      // 源里的 `[fenye]`：新的一页从这组起（长图里也分开，由 layoutDocument 接成一张时多留一段白）
      // 只有 `W:` 没有曲行的组（纯文字页）：占位要算到末行文字的墨迹底，再加组间距——否则下一组的谱直接压在文字上
      if (voices.length === 0 && texts.length > 0) {
        const lastInk = ink.text(texts[texts.length - 1]!.text, "words").ink;
        y = Math.max(y, textY + (texts.length - 1) * wordsLead(m) + lastInk.bottom + m.style.vertical.systemGap);
      }
      const box = expanded ? slideBlock(pre.map((p) => ({ pv: p.pv, inkBottom: p.inkBottom })), ink) : { top: 0, bottom: y };
      blocks.push({ group: placedGroup, ...box, breakBefore: groupIdx === 0 && pageIdx > 0 });
    }
  }
  // 连谱号的上下花头各伸出首/末声部 ≈1.5 个墨迹高（粗线探出 0.85，花头字形高 1.18 线距 =
  // 1.18/4 em × 字号 2.2 墨迹高，见 compose/brace.ts::paintBrace）。末声部底下有歌词时歌词块早把它盖住；
  // 展开档里末声部这一遍没词（同一首歌的 Q2）时，上一组的下花头会压到下一组的上花头。
  // 只在真会相压时把上一块往下撑——不压的一点不动，原样档的行距是对过原书的。
  const reach = braceReach(m);
  for (let i = 0; i + 1 < blocks.length; i++) {
    const a = blocks[i]!;
    const b = blocks[i + 1]!.group;
    if (!a.group.hasBrace || !b.hasBrace) continue;
    const need = a.group.braceBottom + 2 * reach - b.braceTop + m.ink.noteHeight * 0.3;
    if (a.bottom < need) a.bottom = need;
  }
  // 首页要让过标题/词曲/调号那一整块——头部行数因谱而异，写死会压到正文
  // headerBottom 是页首的**墨迹底**（compose/header.ts::headerBottom）。页首 → 首组**真正的墨迹顶**只空一行
  // （歌词字高，与 system 间距同口径）：墨迹顶取首声部数字/高八度点、和弦等头顶记号、`W:` 文字行里
  // 最高的那个——只按数字顶算，首组头顶有「引子」这类文字行时一行空隙就被吃掉了。
  // 不再拿 bodyTop 兜底（兜底会把「只空一行」重新撑大）；没传页首（0）时才用 bodyTop。
  let firstTop = m.page.margin.top + m.page.firstSystemTop;
  const g0 = blocks[0]?.group;
  if (headerBottom > 0 && g0) {
    const v0 = g0.voices[0];
    let inkTop = (v0?.y ?? 0) + (v0?.top ?? -m.ink.noteHeight / 2);
    const t0 = g0.group.texts[0];
    if (t0) inkTop = Math.min(inkTop, g0.textY + ink.text(t0.text, "words").ink.top);
    firstTop = headerBottom + m.style.size.lyric - inkTop;
  }
  const otherTop = m.page.margin.top + m.page.firstSystemTop * 0.35;
  // 展开档、成书：同旧简谱引擎 `Layout.layoutVertically`——块按占位盒紧挨着码（块间 `staffDist`），放不满的页把行距摊开到 `systemSpread`，
  // 剩下的空白留在页底（从页顶排下来，不竖向居中，issue 22）
  const laid = expanded ? paginate(blocks, {
    pageTop: () => m.page.margin.top,
    bottom: bottomLimit,
    gap: m.style.vertical.staffDist,
    spread: { maxGap: m.style.vertical.systemSpread },
  }) : paginate(blocks, {
    pageTop: (i) => (i === 0 ? firstTop : otherTop),
    // 连续长图不按高度分页，页高随内容长
    bottom: m.page.longImage ? Infinity : bottomLimit,
    gap: 0,
  });
  if (laid.length === 0) return [{ groups: [], song: songIndex, firstOfSong: true }];
  return laid.map((pg, i) => ({
    song: songIndex,
    firstOfSong: i === 0,
    // 成书量「这一页自然叠起来多高」（半页起排、两首同页紧排用，同旧简谱引擎各行盒高之和 + 行距下限）
    ...(expanded ? { natural: pg.reduce((h, { block }) => h + block.bottom - block.top, 0) + Math.max(0, pg.length - 1) * m.style.vertical.staffDist } : {}),
    groups: pg.map(({ block, y }) => {
      shiftGroup(block.group, y);
      return block.group;
    }),
  }));
}

/**
 * 展开档的谱行占位盒（相对组原点）：照旧简谱引擎谱行 Group 的包围盒——数字、歌词按**字体盒**（ascent / descent）算，
 * 弧、高八度点、低音点等按墨迹，取并集。页数、每页行数要与旧简谱引擎展开档一致（用户定）。
 */
function slideBlock(voices: ReadonlyArray<{ pv: PlacedVoice; inkBottom: number }>, ink: InkMeasurer): { top: number; bottom: number } {
  const d = ink.digit("1").ink;
  const baseRel = -(d.top + d.bottom) / 2; // 数字按墨迹居中于声部 y，落笔基线在这里（compose/ctx.ts::digitOrigin）
  const note = ink.fontBox("note");
  const lyric = ink.fontBox("lyric");
  let top = Infinity;
  let bottom = -Infinity;
  for (const { pv, inkBottom } of voices) {
    top = Math.min(top, pv.y + pv.top, pv.y + baseRel + note.top);
    bottom = Math.max(bottom, pv.y + inkBottom, pv.y + baseRel + note.bottom);
    for (const ly of pv.lyricY) bottom = Math.max(bottom, ly + lyric.bottom);
  }
  return Number.isFinite(top) ? { top, bottom } : { top: 0, bottom: 0 };
}

/** 排一整份文档（可含多首「一首多唱」）。 */
export function layoutDocument(
  songs: readonly FanqieSong[],
  m: JianpuGrid,
  headerBottoms: readonly number[] = [],
  ink: InkMeasurer,
  /** 各首页脚（BL/BC/BR）从本曲最低一行往下占多高（compose/footer.ts::footerSpan）；连续长图接下一首时要让开 */
  footerSpans: readonly number[] = [],
  /** 展开档（见 `layoutSong`） */
  expanded = false,
): PlacedScore {
  let pages: PlacedPage[] = [];
  songs.forEach((song, i) => pages.push(...layoutSong(song, m, i, headerBottoms[i] ?? 0, ink, expanded)));

  // 连续长图：所有页面首尾相接成一张，源里的 `[fenye]` 只当作一段额外留白。
  // 换曲时连页眉一起接：页眉整块下移（`PlacedPage.headers`），本曲的谱跟着同一个量走——layoutSong 已按页眉高排好首组
  if (m.page.longImage && pages.length > 1) {
    const merged: PlacedPage = { groups: [], song: pages[0]!.song, firstOfSong: pages[0]!.firstOfSong, headers: [] };
    for (const [i, pg] of pages.entries()) {
      if (i > 0) {
        const prev = pages[i - 1]!;
        const low = lowestOf(merged) + (pg.song !== prev.song ? footerSpans[prev.song] ?? 0 : 0);
        let offset: number;
        if (pg.firstOfSong) {
          // 页眉墨迹顶约在标题基线上一个标题字号
          const headTop = m.head.titleBaseline - m.style.header.title.size;
          offset = low + m.style.vertical.systemGap * 2 - headTop;
          merged.headers!.push({ song: pg.song, dy: offset });
        } else {
          const g0 = pg.groups[0];
          let top = g0?.voices[0]?.y ?? 0;
          if (g0 && g0.group.texts.length > 0) top = Math.min(top, g0.textY - m.style.size.words);
          offset = low + m.style.vertical.systemGap * 1.4 - top;
          // 首组头顶（房号、和弦、弧）也得让开上一页末行：至少留组间那道空（GROUP_CLEAR，同 layoutSong 组间），
          // 只按基线留会压上去（123 的 `$$` 换页后首行带房号，064《啊！圣善夜》）
          if (g0) offset = Math.max(offset, low + GROUP_CLEAR * m.style.size.lyric - Math.min(...g0.voices.map((v) => v.y + v.top)));
        }
        for (const g of pg.groups) shiftGroup(g, offset);
      }
      merged.groups.push(...pg.groups);
    }
    pages = [merged];
  }

  return {
    pages,
    metrics: m,
    contentBottom: pages.reduce((b, p) => Math.max(b, lowestOf(p)), 0),
    contentRight: pages.reduce((r, p) => Math.max(r, rightmostOf(p)), 0),
  };
}

/** 一页里最右沿的 x（行内坐标）。 */
function rightmostOf(page: PlacedPage): number {
  let right = 0;
  for (const g of page.groups) {
    for (const v of g.voices) {
      const last = v.items[v.items.length - 1];
      if (last) right = Math.max(right, last.x);
      for (const layer of v.layers) {
        const lastLayer = layer.items[layer.items.length - 1];
        if (lastLayer) right = Math.max(right, lastLayer.x);
      }
    }
  }
  return right;
}

/** 一页里最下沿的 y（末行歌词或末个声部）。 */
function lowestOf(page: PlacedPage): number {
  let bottom = 0;
  for (const g of page.groups) {
    for (const v of g.voices) {
      bottom = Math.max(bottom, v.y, ...v.lyricY, v.bottom !== undefined ? v.y + v.bottom : 0);
      // 并排块的下行（`{dsb}` 压下去的主旋律、同谱表第二声部）比基线低一个 splitRise
      for (const l of v.layers) if (l.split) bottom = Math.max(bottom, v.y + Math.abs(l.split.dy));
    }
  }
  return bottom;
}

function shiftGroup(g: PlacedGroup, dy: number): void {
  g.textY += dy;
  g.braceTop += dy;
  g.braceBottom += dy;
  for (const v of g.voices) {
    v.y += dy;
    for (let i = 0; i < v.lyricY.length; i++) v.lyricY[i]! += dy;
  }
}

/**
 * 段落词挂在**行末那个音符**上时，它标的其实是下一行的起句（「（副歌）」印在主歌最后一行的行尾没有意义，
 * 副歌是从下一行开始唱的）——挪到下一行（同一声部）行首那个音符上，那里已有段落词就不挪（同旧简谱引擎 `Line.layout` 那一段）。
 * 只改行视图（`docView` 每次排版现做的那份），不改 ScoreDoc。
 */
/**
 * **自动段号**（搬 `Line.addVerseNumbers`，样式键 `verse-numbers`）：叠排的几段歌词在每一行行首标「1.」「2.」…，
 * 只给源里没写说明的行补（源里有 `<1.>`、`<狼:1.>` 的那一行照源印，首字自带「1.」的也算，一行里只要有一段写了就整行不补）。
 * `never` 不标；`auto` 全曲段数多于 `verse-number-auto-min` 才标；这一行有字的段不到两段不标。
 * 补出来的就是一条普通的说明（`LyricLine.annotation`），画法、版心左缘让出（`compose/index.ts` 量伸出量）都同源里写的。
 * 只改行视图，不改 ScoreDoc。
 */
function autoVerseNumbers(song: FanqieSong, m: JianpuGrid): void {
  const mode = m.style.look.verseNumbers;
  if (mode === "never") return;
  const voices = song.pages.flatMap((p) => p.groups).flatMap((g) => g.voices);
  const sung = (l: { syllables: ReadonlyArray<{ text: string } | null> }): boolean => l.syllables.some((x) => !!x?.text);
  if (mode === "auto") {
    const verses = Math.max(0, ...voices.map((v) => v.lyrics.filter(sung).length));
    if (verses <= m.style.look.verseNumberAutoMin) return;
  }
  // 首字自带印刷段号（MusicXML 常把 `1.` 与字并成一个音节「1.圣」）的行也算写了，不再补
  const printed = (l: { syllables: ReadonlyArray<{ text: string } | null> }): boolean => /^\d+\./.test(l.syllables.find((x) => !!x?.text)?.text ?? "");
  for (const v of voices) {
    if (v.lyrics.filter(sung).length < 2 || v.lyrics.some((l) => l.annotation || printed(l))) continue;
    v.lyrics.forEach((l, k) => {
      if (sung(l)) l.annotation = `${k + 1}.`;
    });
  }
}

function moveTrailingSectionWords(song: FanqieSong): void {
  const groups = song.pages.flatMap((p) => p.groups);
  const notes = (els: readonly MusicElement[]) => els.filter((e): e is NoteElement => e.kind === "note" && !e.placeholder);
  for (let gi = 0; gi + 1 < groups.length; gi++) {
    groups[gi]!.voices.forEach((voice, vi) => {
      const next = groups[gi + 1]!.voices[vi];
      if (!next) return;
      const ns = notes(voice.elements);
      const last = ns[ns.length - 1];
      const first = notes(next.elements)[0];
      if (!last?.annotation || !first || first.annotation !== undefined) return;
      // 原文位置跟着走：可视化编辑点这个字改的仍是源里那一处
      first.annotation = last.annotation;
      if (last.annotationSource) first.annotationSource = last.annotationSource;
      delete last.annotation;
      delete last.annotationSource;
    });
  }
}
