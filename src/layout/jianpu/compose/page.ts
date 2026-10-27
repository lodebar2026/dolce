// 一页：谱组、声部、连谱号的绘制。
import { Font } from "../../../pagetree/font";
import { Group } from "../../../pagetree/pageitem";
import { BeamLine, type JpNumber } from "../../../engrave/jpnumber";
import { sustainDash } from "../../../engrave/dash";
import { beamY, highDotY, lowDotY } from "../../../engrave/stack";
import { syllableRun } from "../../../engrave/syllable";
import type { ElementId } from "../../../model/doc";
import { addBarlineOwner } from "../../../pagetree/identity";
import type { PlacedGroup, PlacedLayer, PlacedPage, PlacedVoice } from "../place/model";
import { noteBeams, wordsLead } from "../place/vertical";
import { type OriginalCtx, digitItem, digitOrigin, dot, rect, text } from "./ctx";
import { paintHeader } from "./header";
import { braceItem, paintBrace } from "./brace";
import { paintMark } from "./marks";
import { paintBand, paintNote } from "./note";
import { bandOf } from "../place/band";
import { paintBarline } from "./barline";
import { paintJoinBrace, paintLyricAnnotations, paintSyllables } from "./lyric";
import { passesOfRow } from "../place/expand";

/**
 * 把一组声部切成若干「小节线贯穿块」：歌词行会把竖线截断，所以带歌词的声部就是
 * 一个块的末尾。四声部谱（S/A + 歌词 + T/B）因此得到 [1,2] 与 [3,4] 两块。
 */
function barlineBlocks(voices: readonly PlacedVoice[], sungVoices: ReadonlySet<number>): PlacedVoice[][] {
  const blocks: PlacedVoice[][] = [];
  let current: PlacedVoice[] = [];
  for (const [vi, voice] of voices.entries()) {
    current.push(voice);
    // 本行没词、但这个声部在曲中别处有词的（太阳出来喜洋洋末页女高那一行全是休止）也照样断开：
    // 贯穿是四声部诗歌「上两声部共用下面那行词」的排法，不是「这一行碰巧没词」
    if (voice.voice.lyrics.length > 0 || sungVoices.has(vi)) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks.filter((b) => b.length > 0);
}

/** 一首里在任一行带过词的声部（按组内序号）：这些声部的小节线不往下贯穿（`barlineBlocks`） */
function sungVoices(c: OriginalCtx, song: number): Set<number> {
  const out = new Set<number>();
  for (const pg of c.doc?.songs[song]?.pages ?? []) {
    for (const g of pg.groups) g.voices.forEach((v, vi) => { if (v.lyrics.length > 0) out.add(vi); });
  }
  return out;
}

/**
 * 一组（system）的左缘布局：段号占位 → 细竖线 → 连谱号。
 * 页眉的 `TL:`/`XL:` 要对齐到 system 左缘，所以这段得能单独取用。
 * 段号占位按**整页最宽**的那组留：段号常只印在第一个 system，按各组自己留的话只有那一组的
 * 细竖线、连谱号往左凸出去，同页各 system 左缘对不齐（原谱一律对齐）。段号文字仍贴着本组歌词首字。
 */
function systemMetrics(c: OriginalCtx, group: PlacedGroup, page?: PlacedPage): {
  notesLeft: number;
  thinX: number;
  braceX: number;
  /** 段号文字的左缘（没有段号时等于 notesLeft） */
  labelLeft: number;
  labelFont: Font;
} {
  const m = c.metrics;
  const labelFont = new Font(m.style.font.text.family, m.style.size.verseNum);
  const widthOf = (g: PlacedGroup) => {
    let w = 0;
    for (const v of g.voices) {
      for (const line of v.voice.lyrics) {
        if (line.annotation) w = Math.max(w, labelFont.measureText(line.annotation));
      }
    }
    return w;
  };
  const labelWidth = widthOf(group);
  const slotWidth = Math.max(labelWidth, ...(page?.groups ?? []).map(widthOf));
  const notesLeft = m.page.margin.left;
  // 段号排在 [细竖线] ← 间隙 → [段号] ← 间隙 → [歌词首字] 之间
  const labelToLyric = m.style.size.verseNum * 0.2;
  const lineToLabel = m.style.size.verseNum * 0.55;
  // 首字前面挂出去的前置标点（`“高`，音节按主体居中、引号伸到左边，engrave/syllable.ts）也得让：
  // 只按半个字宽留，段号就压在引号上、连谱号压到引号
  const lyricFont = new Font(m.style.font.lyric.family, m.style.size.lyric);
  let lead = 0;
  for (const v of group.voices) {
    for (const line of v.voice.lyrics) {
      const syl = line.syllables.find((x) => x?.text);
      if (syl) lead = Math.max(lead, syllableRun(syl.text, lyricFont, m.style.look.punctCompress).lead);
    }
  }
  const firstCharHalf = m.style.size.lyric * 0.5 + lead;
  const labelSlot =
    slotWidth > 0 ? firstCharHalf + labelToLyric + slotWidth + lineToLabel : 0;
  const thinX = notesLeft - Math.max(labelSlot, m.note.barlineSpace * 0.55, lead > 0 ? firstCharHalf + labelToLyric : 0);
  const braceX = thinX - m.ink.noteHeight * 0.55;
  // 段号实际落在哪：同 `lyric.ts::paintLyricAnnotations`，右对齐到本行歌词首字**实际画出来**的左缘、隔 `annotationGap`。
  // 按「首字居中于版心左缘」估会多让出行首音符离左缘那一截（整份版心左缘跟着多让，成书 355 因此少放一小节）
  let labelLeft = notesLeft;
  for (const v of group.voices) {
    v.voice.lyrics.forEach((line, verse) => {
      if (!line.annotation) return;
      const w = labelFont.measureText(line.annotation);
      const gap = Math.max(line.annotationGap / 100, 0.1) * m.style.size.lyric;
      const first = v.items.find((it) => it.syllables[verse]);
      let x0 = notesLeft - firstCharHalf;
      if (first) {
        const syl = first.syllables[verse]!;
        const run = syllableRun(syl.text + (syl.trailingPunctuation ?? ""), lyricFont, m.style.look.punctCompress);
        x0 = notesLeft + first.x - run.lead - run.body / 2;
      }
      labelLeft = Math.min(labelLeft, x0 - gap - w);
    });
  }
  return { notesLeft, thinX, braceX, labelLeft, labelFont };
}

/** 整页的 system 左缘（多声部时是连谱号，单声部时是细线/音符起点）。 */
export function systemLeft(c: OriginalCtx, page: PlacedPage): number {
  const m = c.metrics;
  let left = m.page.margin.left;
  for (const group of page.groups) {
    // 单声部没有连谱号也没有起始细线，左缘取音符起点；但歌词说明（`<狼:1.>`）
    // 会伸到音符左边，也得算进去，否则会贴到页面边缘上。
    const g = systemMetrics(c, group, page);
    left = Math.min(left, group.hasBrace ? g.braceX : Math.min(g.notesLeft, g.labelLeft));
  }
  return left;
}

export function paintPage(c: OriginalCtx, page: PlacedPage, pageIndex: number): Group {
  const m = c.metrics;
  const root = new Group();
  if (page.firstOfSong) {
    paintHeader(c, root, page.song, systemLeft(c, page));
  }
  // 连续长图接在后面的各首：页眉照首页的位置画，整块下移
  for (const h of page.headers ?? []) {
    const hg = new Group();
    paintHeader(c, hg, h.song, systemLeft(c, page));
    hg.y += h.dy;
    root.add(hg);
  }
  for (const group of page.groups) {
    // 每个谱组单独成一个 Group（`system`）：页面检查按它量相邻谱行的墨迹盒，绝对坐标不受影响
    const sys = new Group();
    sys.classes.add("system");
    sys.ident = { kind: "system" };
    const texts = group.group.texts;
    if (texts.length > 0) {
      const font = new Font(m.style.font.text.family, m.style.size.words);
      // 每条 `W:` 一行（行距见 place/vertical.ts::wordsLead）；拼成一行时第二条会压到第一条上
      texts.forEach((t, i) => sys.add(text(t.text, m.page.margin.left, group.textY + i * wordsLead(m), font, c.ink)));
    }
    const { braceX, notesLeft } = systemMetrics(c, group, page);
    // `&sbf` 标了分声部位置就从那里起（前半段仍是单声部），否则从 system 左缘
    const braceAt =
      group.braceFromX !== undefined
        ? notesLeft + group.braceFromX - m.ink.noteHeight * 1.41
        : braceX;
    if (group.hasBrace) {
      paintBrace(c, sys, braceAt, group.braceTop, group.braceBottom);
      // 声部名（`Q1"女高"` / `Q1<女高>`）排在连谱号**左侧**，与各自的声部行对齐
      const nameFont = new Font(m.style.font.text.family, m.style.size.chord);
      for (const v of group.voices) {
        const caption = v.voice.caption;
        if (!caption) continue;
        const w = nameFont.measureText(caption);
        sys.add(text(caption, braceAt - 6 - w, v.y + m.ink.noteHeight * 0.35, nameFont, c.ink));
      }
    }
    // 多声部：小节线贯穿相邻的声部，但**在歌词块处断开**——四声部谱因此分成
    // 「声部1+2」与「声部3+4」两段（对照印刷原版）。连谱号才是整组一根到底。
    const spanBarlines = group.voices.length > 1;
    for (const voice of group.voices) {
      paintVoice(c, sys, voice, pageIndex, spanBarlines);
    }
    if (spanBarlines) {
      for (const block of barlineBlocks(group.voices, sungVoices(c, group.song))) {
        const first = block[0]!;
        const last = block[block.length - 1]!;
        // 贯穿多声部的小节线画在这里（`paintVoice` 那边被 skipBarlines 跳过了），索引同样要建，
        // 否则多声部谱上点不中小节线。**各声部在这一处的小节线共用这一条线**，所以按横坐标
        // 把同一处的都指到它上面（模型里每个声部各有一条小节线，画出来只有一根）
        const drawn = new Map<number, Group>();
        for (const it of first.items) {
          // 并排块下行里的线（`dy`）由 paintVoice 按下移后的位置画，这里不再贯穿画一遍
          if (it.element.kind !== "barline" || it.dy !== undefined) continue;
          const g = paintBarline(c,
            sys,
            m.page.margin.left + it.x,
            first.y,
            it,
            last.y - first.y,
          );
          if (g) drawn.set(it.x, g);
        }
        for (const voice of block) {
          let prevNoteId: ElementId | undefined;
          for (const it of voice.items) {
            if (it.element.kind === "barline") {
              const g = drawn.get(it.x);
              if (g && prevNoteId !== undefined) addBarlineOwner(g, prevNoteId, "after");
            } else if (it.element.kind !== "sustain") {
              prevNoteId = c.doc?.idOf.get(it.element) ?? prevNoteId;
            }
          }
        }
      }
    }
    root.add(sys);
  }
  return root;
}

export function paintVoice(c: OriginalCtx,
  root: Group,
  voice: PlacedVoice,
  pageIndex: number,
  skipBarlines = false,
): void {
  const m = c.metrics;
  const left = m.page.margin.left;
  const baseline = voice.y;
  c.band = bandOf(voice.band);
  c.bandOrigin = { x: left, y: baseline };
  /** 各段歌词墨迹的最右缘，联合括号据此定位 */
  const lyricRight: number[] = [];
  /** 前面那个音符的元素 id：小节线没有自己的 id，借它认（口径同 `editor/sync.ts::addPartExtras`）。
   *  增时线不改它——模型里「小节线前面那个元素」指的是和弦，不是挂在它上面的增时线。 */
  let prevNoteId: ElementId | undefined;
  const passes = passesOfRow.get(voice.voice);
  /** 各音符的数字（行内 x）：减时线认两端的数字，PPTX 按目标字体的数字宽把线头接回去（`pptx.ts` 读 `BeamLine.leftNum/rightNum`） */
  const nums: Array<{ x: number; num: JpNumber }> = [];

  for (const it of voice.items) {
    c.pass = passes?.[it.srcIndex];
    const x = left + it.x;
    // `{dsb}` 并排块里，主旋律这一段整体下移（it.dy）
    const base = baseline + (it.dy ?? 0);
    if (it.element.kind === "barline") {
      if (!skipBarlines || it.dy !== undefined) {
        const g = paintBarline(c, root, x, base, it);
        // 行视图只出「右线」（`jianpu/slots.ts`），所以一律是画在前一个音符之后的那一侧
        if (g && prevNoteId !== undefined) addBarlineOwner(g, prevNoteId, "after");
      }
      continue;
    }
    if (it.element.kind === "sustain") {
      // 增时线：数字字体的「-」（engrave/dash.ts，与混排、旧简谱引擎同一个字形）。
      // 数字是按墨迹居中于 baseline 画的，增时线的墨心也落在同一条中线上
      // 展开档画成数字字体的「-」字（同旧简谱引擎 `JpNumber("-")`；PPTX 里换目标字体的「-」）
      const line = c.slide ? dashDigit(c, x, base) : sustainDash(x, base, { font: c.digitFont, color: c.ink });
      root.add(line);
      // 增时线有自己的 id（`Chord.sustains[]` 各带一个），可视化编辑按它点选这一条
      const sid = c.doc?.idOf.get(it.element);
      if (sid !== undefined) line.ident = { kind: "sustain", id: sid, ...(c.pass !== undefined ? { pass: c.pass } : {}) };
      // 长音里换的和弦印在增时线上方（`- "hx:C/G"`），画法与音符上方那个一样
      paintBand(c, root, it.element, undefined, sid);
      paintSyllables(c, root, it, x, voice, lyricRight);
      continue;
    }
    const num = paintNote(c, root, it, x, base);
    if (num) nums.push({ x: it.x, num });
    prevNoteId = c.doc?.idOf.get(it.element) ?? prevNoteId;
    paintSyllables(c, root, it, x, voice, lyricRight);
  }
  c.pass = undefined;

  // 减时线
  for (const u of voice.underlines) {
    const y = baseline + (u.dy ?? 0) + beamY(m.ink.noteHeight / 2, u.level, m.ink.stack);
    const under = nums.filter((n) => n.x >= u.x0 - 0.5 && n.x <= u.x1 + 0.5);
    root.add(new BeamLine(u.level, left + u.x0, left + u.x1, y, m.style.stroke.beam, c.ink, under[0]?.num ?? null, under[under.length - 1]?.num ?? null));
  }

  paintLyricAnnotations(c, root, voice, left);
  paintJoinBrace(c, root, voice, lyricRight);

  // 跨若干符号的记号（弧线 / 多连音 / 跳房子 / 渐强渐弱）
  for (const mk of voice.marks) paintMark(c, root, mk, left, baseline + (mk.dy ?? 0));
  // 临时伴奏 / 临时多声部：主旋律上方的小字号行
  for (const layer of voice.layers) paintLayer(c, root, layer, left, baseline, pageIndex);
}

/** 展开档的增时线：数字字体的「-」，按墨迹横向居中、与数字同一条基线（`digitOrigin`）。 */
function dashDigit(c: OriginalCtx, x: number, base: number): JpNumber {
  const { dx, dy } = digitOrigin(c, "-");
  return digitItem("-", x + dx, base + dy, c.digitFont, c.ink);
}

/** 内联层（小字层、`{dsb}` 并排块）。并排块的上行借 `paintVoice` 画，`paintVoice` 又回头画各层，所以两者同在本文件。 */
export function paintLayer(c: OriginalCtx,
  root: Group,
  layer: PlacedLayer,
  left: number,
  baseline: number,
  pageIndex = 0,
): void {
  const m = c.metrics;
  const split = layer.split;
  if (split) {
    // `{dsb}` 并排块：上行与主旋律**同字号同画法**，所以直接借主行那套绘制
    paintVoice(c,
      root,
      {
        voice: split.line,
        y: baseline + split.dy,
        items: layer.items,
        underlines: layer.underlines.map((u) => ({ ...u, dy: 0 })),
        marks: split.marks,
        band: split.band ?? [],
        top: 0,
        textTop: null,
        layers: [],
        lyricY: [],
      },
      pageIndex,
      false,
    );
    // 花括号：细线描边的自绘路径，尖端朝并排的两行
    const y0 = baseline + split.braceTop;
    const y1 = baseline + split.braceBottom;
    if (split.braceLeftX !== undefined) {
      root.add(braceItem(c.ink, left + split.braceLeftX, y0, y1, -1, "split"));
    }
    if (split.braceRightX !== undefined) {
      root.add(braceItem(c.ink, left + split.braceRightX, y0, y1, 1, "split"));
    }
    return;
  }
  const y = baseline + (layer.y ?? -m.ink.noteHeight);
  const cs = m.style.size.cue;
  const font = new Font(m.style.font.text.family, c.digitFont.size * cs);
  const st = m.ink.stack;
  const cue = { gap: st.gap * cs, dotRadius: st.dotRadius * cs, beamWidth: st.beamWidth * cs };
  for (const it of layer.items) {
    const x = left + it.x;
    if (it.element.kind === "barline") {
      root.add(rect(c.ink, x - 0.6, y - 10, 1.2, 20));
      continue;
    }
    if (it.element.kind === "sustain") {
      root.add(sustainDash(x, y, { font, color: c.ink }));
      continue;
    }
    if (it.element.kind !== "note" || it.element.hidden) continue;
    const ch = String(it.element.pitch);
    const b = font.charBound(ch);
    root.add(
      text(ch, x - (b.left + b.right) / 2, y - (b.top + b.bottom) / 2, font, c.ink),
    );
    // 小字层的叠层与主旋律同一套（engrave/stack.ts），整体按 cueScale 缩；低音点同样让开减时线
    const oct = it.element.octave;
    const h = m.ink.noteHeight * cs;
    for (let i = 0; i < oct; i++) root.add(dot(c.ink, x, y + highDotY(-h / 2, i, cue), cue.dotRadius));
    for (let i = 0; i < -oct; i++) root.add(dot(c.ink, x, y + lowDotY(h / 2, noteBeams(it.element), i, cue), cue.dotRadius));
  }
  for (const u of layer.underlines) {
    root.add(new BeamLine(u.level, left + u.x0, left + u.x1, y + beamY((m.ink.noteHeight * cs) / 2, u.level, cue), cue.beamWidth, c.ink));
  }
}
