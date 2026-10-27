// 歌词：音节、标点挤压、歌词联合括号与注记。
import { Font } from "../../../pagetree/font";
import { Group } from "../../../pagetree/pageitem";
import { Lyric, syllableRun } from "../../../engrave/syllable";
import type { PlacedItem, PlacedVoice } from "../place/model";
import { type OriginalCtx, text } from "./ctx";
import { braceItem } from "./brace";

// 歌词联合括号：尺寸对照印刷原版量得（单位 = 歌词字号）
const BRACE_GAP = 0.09;        // 末字右缘（含右边距）到括号左缘
const BRACE_TOP = 0.78;        // 首行基线往上
const BRACE_BOTTOM_UP = 0.16;  // 末行基线往上（括号底不到基线）

/**
 * 歌词的联合括号：行末写 `}` 的那几段用一个右向花括号括起来（`(阿们)` 之类的
 * 共用结尾）。紧贴最长那段的末字右缘，纵向跨这几段。
 */
/**
 * 歌词联合括号的取尺（对照印刷原版量的，单位 = 歌词字号）：
 * 括号墨迹宽 0.37、与末字右缘留 0.16 的缝；纵向从首行基线上方 0.78 到末行基线**上方** 0.16。
 * Bravura 的 brace（E000）在字号 40 时墨迹为 3.375 × 160、纵向以基线为中心。
 */
export function paintJoinBrace(c: OriginalCtx, root: Group, voice: PlacedVoice, lyricRight: number[]): void {
  // `}` 只写在**领起**的那几行上：印刷原版里 `落}` 一行带号、下一行 `说` 不带，
  // 括号却把两行都括进去——所以一段连续的带号行 + 其后紧跟的一行才是一个括号的跨度。
  const lyrics = voice.voice.lyrics;
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < lyrics.length; i++) {
    if (!lyrics[i]!.joinBrace) continue;
    let j = i;
    while (j + 1 < lyrics.length && lyrics[j + 1]!.joinBrace) j += 1;
    const last = Math.min(j + 1, lyrics.length - 1);
    if (last > i) spans.push([i, last]);
    i = j;
  }
  for (const [first, last] of spans) paintOneJoinBrace(c, root, voice, lyricRight, first, last);
}

function paintOneJoinBrace(c: OriginalCtx,
  root: Group,
  voice: PlacedVoice,
  lyricRight: number[],
  first: number,
  last: number,
): void {
  const m = c.metrics;
  let right = 0;
  for (let i = first; i <= last; i++) right = Math.max(right, lyricRight[i] ?? 0);
  if (!Number.isFinite(right) || right <= 0) return;
  // 紧贴最长那行的末字右缘（原版留约 0.2 个歌词墨迹高的缝）
  const x = right + m.style.size.lyric * BRACE_GAP;
  const y0 = voice.lyricY[first]! - m.style.size.lyric * BRACE_TOP;
  const y1 = voice.lyricY[last]! - m.style.size.lyric * BRACE_BOTTOM_UP;
  if (y1 - y0 <= 0) return;
  // 右向 `}`：上下两端贴着歌词，尖端朝右
  root.add(braceItem(c.ink, x, y0, y1, 1, "lyric"));
}

/** 歌词行的前置说明（段号 `1.`、角色名「狼:」等）。 */
export function paintLyricAnnotations(c: OriginalCtx, root: Group, voice: PlacedVoice, left: number): void {
  const m = c.metrics;
  const font = new Font(m.style.font.text.family, m.style.size.verseNum);
  voice.voice.lyrics.forEach((line, verse) => {
    if (!line.annotation) return;
    // 右对齐到本行歌词首字**实际画出来**的左缘（含挂出去的前置标点 `“主`，同 paintSyllables 的落笔）：
    // 按「首字居中于版心左缘」估的话，行首音符一往右排，段号就隔着一大截（原样分页四声部）。
    // `%NN` 可以调这个间隙，默认 20% 字宽。
    const gapPx = Math.max(line.annotationGap / 100, 0.1) * m.style.size.lyric;
    const w = font.measureText(line.annotation);
    const lyricFont = new Font(m.style.font.lyric.family, m.style.size.lyric);
    const first = voice.items.find((it) => it.syllables[verse]);
    let x0: number;
    if (first) {
      const syl = first.syllables[verse]!;
      const run = syllableRun(syl.text + (syl.trailingPunctuation ?? ""), lyricFont, m.style.look.punctCompress);
      x0 = left + first.x - run.lead - run.body / 2;
    } else {
      const syl = line.syllables.find((x) => x?.text);
      const lead = syl ? syllableRun(syl.text, lyricFont, m.style.look.punctCompress).lead : 0;
      x0 = left - m.style.size.lyric * 0.5 - lead;
    }
    root.add(text(line.annotation, x0 - gapPx - w, voice.lyricY[verse]!, font, c.lyricInk));
  });
}

export function paintSyllables(c: OriginalCtx,
  root: Group,
  it: PlacedItem,
  x: number,
  voice: PlacedVoice,
  rightEdge?: number[],
): void {
  const m = c.metrics;
  const font = new Font(m.style.font.lyric.family, m.style.size.lyric);
  it.syllables.forEach((syl, verse) => {
    if (!syl) return;
    const str = syl.text + (syl.trailingPunctuation ?? "");
    const g = new Group();
    g.data = syl;
    // 音节按其**主体**居中于音符锚点，前后标点挂出去；量宽与笔位同一串挤压后的坐标（engrave/syllable.ts，`Lyric.update` 同一份）
    const run = syllableRun(str, font, m.style.look.punctCompress);
    const x0 = x - run.lead - run.body / 2;
    const t = new Lyric();
    t.text = str;
    t.font = font;
    t.color = c.lyricInk;
    t.compress = m.style.look.punctCompress;
    t.verse = verse + 1;
    t.x = x0;
    t.y = voice.lyricY[verse]!;
    t.charXs = run.xs;
    g.add(t);
    if (rightEdge) rightEdge[verse] = Math.max(rightEdge[verse] ?? 0, x0 + run.width);
    root.add(g);
    const owner = c.doc?.syllableOwner.get(syl);
    if (owner !== undefined) g.ident = { kind: "syllable", id: owner, verse };
  });
}
