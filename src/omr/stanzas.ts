// 谱后单独排版的附段歌词：谱行下只配第 1 段，第 2…N 段按诗行印在谱子后面，不跟音符对齐
// （圣徒诗歌 11《仰看穹苍浩大无穷》：「二」「三」各领一段四行诗）。
//
// 这块字进不了歌词通道——lyrics.ts S1 给末谱行的下方带按行距封了底（防谱后正文），本来也不该进：
// 它没有 x 可对。这里另走一路：DBNet 检测整块、逐行识别，按段号/空行切段，再照**第 1 段的音位骨架**
// 逐字填进去——第 1 段有字的音依次是各段的起字音位，melisma 的分布跟第 1 段一样。
//
// 判据只有一条：**这一段的音节数等于第 1 段的起字音位数**（容 OCR 多读漏读两个字）。
// 谱后的背景介绍/版权说明是散文，字数碰不上，整块照旧丢掉（1600《南非之行》那九段正文）。
import type { Binary, StaffRow, TextRegion } from "../omrkit/types";
import { rbottom } from "../omrkit/types";
import type { OcrBackend } from "../omrkit/ocr";
import { CN_NUM, LYRIC_PUNCT, LYRIC_QUOTE_CLOSE, LYRIC_QUOTE_OPEN, normPunct } from "./lyrics";
import { median } from "../omrkit/geom";
import { probe } from "./probe";

const isHanzi = (c: string) => /[一-鿿]/.test(c);
const isLatin = (c: string) => /[A-Za-z']/.test(c);

// 中文段号：一…十、十一…二十（选本 563 有十二段）
const CN_LABELS = [...CN_NUM, ...[...CN_NUM.slice(0, 9)].map((c) => "十" + c), "二十"];
const CN_LABEL_ALT = `二十|十[${CN_NUM.slice(0, 9)}]|[${CN_NUM}]`;
// 整行只有段号：「二」「十二」「2」「2.」「（二）」
const LABEL_ONLY_RE = new RegExp(`^[(（]?(${CN_LABEL_ALT}|\\d{1,2})[)）]?[.、．。:：]?$`);
// 段号领着正文：「2.夕阳…」「二、夕阳…」——必须带分隔符，裸「一面运行」的「一」是正文
const LABEL_PREFIX_RE = new RegExp(`^[(（]?(${CN_LABEL_ALT}|\\d{1,2})[)）]?[.、．](?=.)`);
/** 音节数与第 1 段音位数至多差几个还照填（OCR 多读/漏读一两个字） */
const COUNT_TOL = 2;

/** 一段诗文拆成音节：汉字一字一个，拉丁词按空白/连字符断；收尾标点、闭引号贴前字，开引号领起后字。
 *  规则与 lyrics.ts 装配谱下歌词那一路一致，两边拆出来的数才可比。 */
export function toSyllables(text: string): string[] {
  const out: string[] = [];
  let lead = "", pend = "";
  const flush = () => { if (pend) { out.push(lead + pend); lead = ""; pend = ""; } };
  for (const ch of text) {
    if (isHanzi(ch)) { flush(); out.push(lead + ch); lead = ""; }
    else if (isLatin(ch)) pend += ch;
    else if (ch === "-") { if (pend) { pend += "-"; flush(); } }
    else if (/\s/.test(ch)) flush();
    else if (LYRIC_QUOTE_OPEN.test(ch) && !pend) lead += normPunct(ch);
    else if (LYRIC_PUNCT.test(ch) || LYRIC_QUOTE_CLOSE.test(ch)) {
      if (pend) pend += normPunct(ch);
      else if (out.length) out[out.length - 1] += normPunct(ch);
    }
  }
  flush();
  return out;
}

interface Stanza { label?: string; lines: { text: string; bbox: TextRegion["bbox"]; vi: number }[] }

/** 识别谱后附段并按第 1 段的音位骨架写进各音符的 `lyrics[v]`。返回收下的诗文行（识别模式叠加用）。
 *  一页两调的（选本诗歌712「(第一调)」谱 + 附段 +「(第二调)」谱）按谱行间的大间隔（>3 倍行距，同 lyrics.ts 的段末行）
 *  切成几段，每段在它与下一段之间找附段、按本段第 1 段的音位骨架填。 */
export async function recognizeTrailingStanzas(
  bin: Binary, staff: StaffRow[], numH: number, ocr: OcrBackend, lyricRegions: TextRegion[] | undefined,
): Promise<TextRegion[]> {
  if (!ocr.recognizeRegion) return [];
  const rows = staff.filter((r) => r.nums.length);
  if (!rows.length) return [];
  const tops = rows.map((r) => r.topY);
  const pitch = tops.length >= 2 ? median(tops.slice(1).map((t, j) => t - tops[j]!)) : 0;
  const segs: StaffRow[][] = [[]];
  rows.forEach((r, i) => {
    // 多声部页不切（同 lyrics.ts 段末行）
    if (i > 0 && pitch > 0 && r.system === undefined && r.topY - rows[i - 1]!.topY > pitch * 3) segs.push([]);
    segs[segs.length - 1]!.push(r);
  });
  if (segs.length > 1) probe("stanza.segments");
  const out: TextRegion[] = [];
  for (let k = 0; k < segs.length; k++) {
    const next = segs[k + 1]?.[0];
    const y1 = next ? Math.round(next.topY - numH * 0.5) : bin.h;
    out.push(...await stanzasOfSegment(bin, segs[k]!, numH, ocr, lyricRegions, y1));
  }
  return out;
}

async function stanzasOfSegment(
  bin: Binary, rows: StaffRow[], numH: number, ocr: OcrBackend, lyricRegions: TextRegion[] | undefined, yEnd: number,
): Promise<TextRegion[]> {
  const last = rows[rows.length - 1];
  if (!last || !ocr.recognizeRegion) return [];

  // 第 1 段的起字音位：谱下有字的音，按谱面顺序。
  const slots = rows.flatMap((r) => r.nums.filter((n) => n.lyrics?.[0]));
  if (slots.length < 8) return [];

  // 区域：末谱行歌词下缘 → 下一段首行（没有就到图底）。末行下没配词（器乐尾奏）就从谱行底下一个字高起。
  const below = (lyricRegions ?? []).filter((r) => r.bbox.y >= last.bottomY - numH * 0.2 && r.bbox.y < yEnd);
  const y0 = Math.round((below.length ? Math.max(...below.map((r) => rbottom(r.bbox))) : last.bottomY + numH) + numH * 0.3);
  // 附段下方的通栏细线（过半页宽）以下是注释（选本 303：注释首行「(303)1.」读成「30311」，行首截断认不出，二十来行注释并进第五段）
  const rule = ruleBelow(bin, y0, yEnd);
  if (rule !== undefined) { probe("stanza.ruleCut"); yEnd = rule; }
  if (yEnd - y0 < numH * 2) return [];
  let dets = (await ocr.recognizeRegion(bin, { x: 0, y: y0, w: bin.w, h: yEnd - y0 }))
    .map((d) => ({ text: d.text.trim(), bbox: d.bbox }))
    .filter((d) => d.text);
  // 一段两行挨得很近、字距又拉得很宽的版面（选本 563「他 是 美 中 之 美」上下两行只隔三四像素），检测把上下两个字
  // 连成一个竖框，逐框读出来是单字乱码（夹着些读成碎字的小框）。三成以上的框高过投影切出的文本行高 1.6 倍、或过半的框只有一个字（262 行距 27px 的三行一段，框碎成单字夹着竖框）时，按投影行逐条重检（`stanza.bandRedet`）。
  const bands = inkBands(bin, y0, yEnd);
  const bandH = median(bands.map((b) => b[1] - b[0]));
  const tallShare = dets.filter((d) => d.bbox.h > bandH * 1.6).length / Math.max(1, dets.length);
  const singleShare = dets.filter((d) => [...d.text].length === 1).length / Math.max(1, dets.length);
  if (bands.length >= 2 && bandH > 0 && (tallShare >= 0.3 || (dets.length >= 20 && singleShare >= 0.5))) {
    probe("stanza.bandRedet");
    dets = [];
    for (const [a, b] of bands) {
      const pad = 2, ya = Math.max(y0, a - pad), yb = Math.min(yEnd, b + pad);
      dets.push(...(await ocr.recognizeRegion(bin, { x: 0, y: ya, w: bin.w, h: yb - ya }))
        .map((d) => ({ text: d.text.trim(), bbox: d.bbox })).filter((d) => d.text));
    }
  }
  if ((globalThis as { __omrDebug?: boolean }).__omrDebug) {
    console.log("[stanzas/det]", dets.map((d) => `${Math.round(d.bbox.h)}px@${Math.round(d.bbox.x)},${Math.round(d.bbox.y)}w${Math.round(d.bbox.w)}=${JSON.stringify(d.text)}`).join("  "));
  }
  // 汉字附段块里夹在句中、不含汉字的一两个字符的碎框（262 重检后夹着「K」「FO」）是笔画碎块读出来的，挤歪音位。
  // 只剔同一行左边已有汉字框的——行首的是读错的段号（262「三」读成「I」），留给下面按几何认段号
  const allChars = dets.flatMap((d) => [...d.text]).filter((c) => /[\p{L}\p{N}]/u.test(c));
  if (allChars.filter(isHanzi).length >= allChars.length * 0.8) {
    const midLine = (d: (typeof dets)[number]) => dets.some((o) => o !== d && o.bbox.x < d.bbox.x && [...o.text].some(isHanzi) &&
      Math.min(rbottom(o.bbox), rbottom(d.bbox)) - Math.max(o.bbox.y, d.bbox.y) >= Math.min(o.bbox.h, d.bbox.h) * 0.5);
    dets = dets.filter((d) => [...d.text].some(isHanzi) || [...d.text].length > 2 || !midLine(d));
  }
  if (!dets.length) return [];
  // 先按纵向重叠聚成视觉行、行内按 x 排：一行诗常分两半印（选本诗歌712「我乃天上的人，　暂居世间，」），
  // 段号「二」也单独成框——各框顶端参差几个像素，只按 y 排，右半句、段号就会插到左半句前面，切段全乱。
  dets.sort((a, b) => a.bbox.y - b.bbox.y);
  const vlines: (typeof dets)[] = [];
  for (const d of dets) {
    // 按中心距聚：按重叠比例聚时，高框（310 段号「二」38px，行距才 27px）会把下一行行首的字拉进来，两行链成一行
    const cy = (b: TextRegion["bbox"]) => b.y + b.h / 2;
    const ln = vlines.find((l) => l.some((o) => Math.abs(cy(o.bbox) - cy(d.bbox)) < Math.min(o.bbox.h, d.bbox.h) * 0.5));
    if (ln) ln.push(d); else vlines.push([d]);
  }
  vlines.sort((a, b) => Math.min(...a.map((d) => d.bbox.y)) - Math.min(...b.map((d) => d.bbox.y)));
  // 页脚注释从这里起就不是诗了：选本诗歌712 通本在附段下面印「(337)1.生命的饼：指主的话语。…」，
  // 行首是括号括着的曲号。混进末段就字数对不上、整块被拒。演唱说明「(唱至第五、六节的“和”时…)」同理（304）
  // 下一调的小标题「(第二调)」「降E调 4/4」也是截断处
  const lineText = (l: typeof dets) => [...l].sort((a, b) => a.bbox.x - b.bbox.x).map((d) => d.text).join("");
  const labelLine = (l: typeof dets) => { const t = lineText(l); return LABEL_ONLY_RE.test(t.slice(0, 2)) || LABEL_PREFIX_RE.test(t) || /^[(（]?\d{1,2}[)）]?$/.test(t); };
  const noteAt = vlines.findIndex((l, i) => {
    const t = lineText(l);
    // 整行括号括着的说明（25「(“我”可换唱“你”)」）同理——后面还有段号行的不算：那是段里一句括着的诗
    //（186 第六段「(亲爱旅伴！世人对你，是否算为已经亡？)」）
    return /^[(（](?:\d{1,4}[)）]|唱|注)/.test(t) || (/^[(（].*[)）]$/.test(t) && !vlines.slice(i + 1).some(labelLine)) ||
      /[(（]第.{1,3}调[)）]|调\s*\d{1,2}\s*[/／]\s*\d{1,2}/.test(t);
  });
  if (noteAt >= 0) { probe("stanza.footnoteCut"); vlines.length = noteAt; }
  const ordered = vlines.flatMap((l, vi) => l.sort((a, b) => a.bbox.x - b.bbox.x).map((d, i) => ({ ...d, lineStart: i === 0, lineLen: l.length, vi })));

  // 切段：段号开新段；没段号时按空行（行距明显大于常规行距）断开。
  const lineH = median(dets.map((d) => d.bbox.h)) || numH;
  const stanzas: Stanza[] = [];
  let cur: Stanza | null = null;
  let prevBottom = -Infinity;
  // 下一个段号（上一段是「二」就等「三」）：段号与正文粘成一框又不带分隔符的（选本诗歌712 246
  //「三世界虽然充满鬼魅…」）只在视觉行首、且正是顺下来的那个号时才切——裸「一面运行」这种不会碰上。
  // 还没切出任何段时等的是「二」——谱下配的就是第 1 段（选本 167「二由死而生—何等奇妙的复活！」）
  // 段号漏检的段（408「二」没检出来）按段数往下推
  const nextLabel = () => {
    if (!stanzas.length) return CN_LABELS[1];
    const k = cur?.label ? CN_LABELS.indexOf(cur.label) : stanzas.length;
    return k >= 0 && k + 1 < CN_LABELS.length ? CN_LABELS[k + 1] : undefined;
  };
  const labeled = ordered.some((d) => d.lineStart && (LABEL_ONLY_RE.test(d.text) || LABEL_PREFIX_RE.test(d.text)));
  // 正文起始列：各视觉行首个多字框左缘的中位。段号印在它左边一栏
  const textColX = median(vlines.map((l) => l.find((d) => [...d.text].length > 2)?.bbox.x).filter((x): x is number => x !== undefined));
  for (const d of ordered) {
    const nl = nextLabel();
    // 段号读错了字（684「西」= 四、「三卷」）：视觉行首单独一个 1–2 字的小框、同一行后面还跟着正文，照样是段号。
    // 须在段号栏里（框中心在正文起始列左边；单字框常被检测放宽，右缘会压到正文列，299「西」）——
    // 正文行首一个字单独成框的（310「从」+「军的教会」）不是
    const inLabelCol = !textColX || d.bbox.x + d.bbox.w / 2 < textColX;
    const only = LABEL_ONLY_RE.exec(d.text) ??
      (labeled && d.lineStart && d.lineLen > 1 && [...d.text].length <= 2 && nl && inLabelCol ? ([d.text, nl] as unknown as RegExpExecArray) : null);
    // （不认跳一个号的：圣徒诗歌 11「四围星辰…」会被当成段号「四」）
    const glued = !only && d.lineStart && nl && d.text.length > nl.length && d.text.startsWith(nl) ? ([nl, nl] as unknown as RegExpExecArray) : null;
    const pre = only ? null : LABEL_PREFIX_RE.exec(d.text) ?? glued;
    if (glued && pre === glued) probe("stanza.gluedLabel");
    // 有段号就按段号切，不再按空行断：行距宽的版面（选本诗歌712 637，行间空当超过一个框高）段内也像空行
    const gapBreak = !labeled && d.lineStart && d.bbox.y - prevBottom > lineH * 1.2;
    prevBottom = d.lineStart ? rbottom(d.bbox) : Math.max(prevBottom, rbottom(d.bbox));
    if (only) {
      // 段号重复或倒退（277 第三段的「三」读成「二」）：按顺下来的号算，后面粘连的「四你要不死…」才认得出
      const curLabel: string | undefined = (cur as Stanza | null)?.label;
      const back: boolean = !!curLabel && CN_LABELS.includes(only[1]) && CN_LABELS.indexOf(only[1]) <= CN_LABELS.indexOf(curLabel);
      stanzas.push(cur = { label: back && nl ? nl : only[1], lines: [] });
      continue;
    }
    if (pre) {
      stanzas.push(cur = { label: pre[1], lines: [{ text: d.text.slice(pre[0].length), bbox: d.bbox, vi: d.vi }] });
      continue;
    }
    // 段号行后面紧跟的第一行不算空行断开（段号与正文之间本来就隔着点距离）
    if (!cur || (gapBreak && cur.lines.length)) stanzas.push(cur = { lines: [] });
    cur.lines.push({ text: d.text, bbox: d.bbox, vi: d.vi });
  }

  // 逐段对音位数；一段对不上，整块当正文丢掉（散文碰巧有一段字数对上的概率不值得冒险）。
  // 带副歌的：附段只配主歌那几行，副歌每段照唱、不重印（选本诗歌712 529：二三四段各两行诗，只对前两谱行，
  // 后两行「和」领起的副歌不在附段里）。所以音位数不必等于整首，可以等于**到某一谱行为止**的前缀——
  // 各段须落在同一条行界上。整首对得上优先。
  const kept = stanzas.filter((s) => s.lines.length);
  const sylls = kept.map((s) => toSyllables(s.lines.map((l) => l.text).join("")));
  // 各段按视觉行拆开的音节（逐行填用）
  const lineSylls = kept.map((s) => [...new Set(s.lines.map((l) => l.vi))]
    .map((vi) => toSyllables(s.lines.filter((l) => l.vi === vi).map((l) => l.text).join(""))));
  const cum: number[] = [];
  rows.reduce((a, r) => { const v = a + r.nums.filter((n) => n.lyrics?.[0]).length; cum.push(v); return v; }, 0);
  // 每段各自选对得上的范围：整首，或某条谱行界上的第 1 段音位前缀（选本 19：一段只配主歌 54、另一段连副歌整首 68）。
  // 容差按长度放宽到一成（至少 COUNT_TOL）：OCR 多读漏读、第 1 段偶有叠字（34、45：41 对 45）。散文段落与诗行字数差得远，照样挡得住。
  const tol = (n: number) => Math.max(COUNT_TOL, Math.round(n * 0.15));   // 15%：副歌里的叠句附段不重印（113：44 对 50）
  const cands = [slots.length, ...[...cum].reverse().filter((c) => c >= 8 && c < slots.length)];
  const spans = sylls.map((sy) => cands.filter((c) => Math.abs(sy.length - c) <= tol(c))
    .sort((a, b) => Math.abs(sy.length - a) - Math.abs(sy.length - b) || b - a)[0] ?? 0);
  // 只有末尾几段对不上（末段后面还连着没截住的说明文字，195 末段 93 对 61）：丢掉那几段，前面对得上的照收
  while (spans.length > 1 && !spans[spans.length - 1] && spans.slice(0, -1).some((c) => c)) {
    probe("stanza.dropTail"); spans.pop(); sylls.pop(); lineSylls.pop();
  }
  if (!sylls.length || spans.some((c) => !c)) {
    if (sylls.length) probe("stanza.rejected");
    return [];
  }
  if (spans.some((c) => c < slots.length)) probe("stanza.versePrefix");

  const base = Math.max(1, ...rows.flatMap((r) => r.nums.map((n) => n.lyrics?.length ?? 0)));
  // 一段的诗行数正好等于谱行数、每行音节数都与该谱行第 1 段音位数差不过 2 时逐行填：一行里 OCR 漏读一个字，
  // 错位只限在这一行，不往后面各行传（选本 303 四行一段，「我们可否因贪优游」漏「贪」，后三行全错一位）。
  const rowSlots = rows.map((r) => r.nums.filter((n) => n.lyrics?.[0])).filter((x) => x.length);
  sylls.forEach((sy, k) => {
    const v = base + k, S = spans[k]!;
    const ls = lineSylls[k]!;
    if (S === slots.length && ls.length === rowSlots.length && ls.every((l, i) => Math.abs(l.length - rowSlots[i]!.length) <= COUNT_TOL)) {
      probe("stanza.perRow");
      rowSlots.forEach((rs, i) => rs.forEach((n, j) => { (n.lyrics ??= [])[v] = ls[i]![j] ?? ""; }));
      return;
    }
    if (sy.length !== S) probe("stanza.countMismatch");
    slots.slice(0, S).forEach((n, i) => { (n.lyrics ??= [])[v] = sy[i] ?? ""; });
  });
  probe("stanza");
  return stanzas.flatMap((s) => s.lines.map((l) => ({ text: l.text, bbox: l.bbox })));
}

/** [y0, y1) 里按行投影切出的有墨行带（高不足 3px 的碎点带不算） */
function inkBands(bin: Binary, y0: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let y = Math.max(0, y0); y <= Math.min(bin.h, y1); y++) {
    let ink = false;
    if (y < Math.min(bin.h, y1)) for (let x = 0, o = y * bin.w; x < bin.w; x++) if (bin.data[o + x]) { ink = true; break; }
    if (ink && start < 0) start = y;
    else if (!ink && start >= 0) { if (y - start >= 3) out.push([start, y]); start = -1; }
  }
  return out;
}

/** [y0, y1) 里第一条横向连续墨迹过半页宽的行（通栏细线）；文字行凑不出这么长的连续段 */
function ruleBelow(bin: Binary, y0: number, y1: number): number | undefined {
  for (let y = Math.max(0, y0); y < Math.min(bin.h, y1); y++) {
    let run = 0, best = 0;
    for (let x = 0, o = y * bin.w; x < bin.w; x++) {
      if (bin.data[o + x]) { if (++run > best) best = run; } else run = 0;
    }
    if (best >= bin.w * 0.5) return y;
  }
  return undefined;
}
