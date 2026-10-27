// 小节时值自检：逐小节把时值加起来，与拍号对不上的报出来。**不需要 GT**。
//
// 两个消费者共用这一份：
// - 编辑器：谱面上把拍数不对的小节标红（录入时最容易犯的就是这一类，`editor/visual/`）；
// - 简谱识别：识别完在核对视图上标出（增时线、减时线读错，小节就凑不满，`editor/omrctl.ts`），
//   私有仓库的 `beat-check.mjs` 也经 CLI 调它，不再自己另算一份。
//
// 口径（与 `beat-check.mjs` 在迦南诗选上验过的一致）：
// - MusicXML 形状按起点算声部终点：`<forward>` 空过的前几拍也算这个声部的（钢琴一只手前两拍不出声）。
// - 一律折成「四分音符 = 1 拍」；附点、增时线已并在 `Chord.duration` 里，多连音按比例折实际时值；倚音、`y` 不占时值。
// - 拍号按小节生效（曲中转拍号）；混合拍（头部并排几个拍号 `Song.extraTimes`，或识别给的 `opts.meters`）对上任意一个就算过。
// - **合法的例外**只放过这几种，其余报出来的都该是真错：
//   - 弱起：首小节不满（末小节满不满都行——诗歌谱里弱起而末小节照样写满的很多）；
//     首尾相加凑满一小节时末小节一并放过。**只在调用方认它是弱起时放过**（`opts.pickup`）：
//     识别不知道原谱，一律认；编辑器只认打开时首小节就不满的（改谱删掉首小节的音得报出来）；
//   - 相邻两个都不满的小节相加恰好一小节（小节中间的反复记号把一小节劈成两半，诗歌谱里很常见）；
//   - MusicXML 标了 `implicit` 的小节（连同它前面那个与它凑满一小节的不满小节）；
//   - 没有拍号（散板）的整首不查。

import type { ElementId, Measure, ScoreDoc, SourceSpan, Time } from "./doc";
import { SIMPLE_DIVISIONS } from "./doc";
import { isXmlShaped } from "./xmlproject";
import { msg, msgText } from "./msg";

export interface BeatIssue {
  songIndex: number;
  partIndex: number;
  measureIndex: number;
  /** 该有几拍、实际几拍（四分音符为 1） */
  want: number;
  got: number;
  /** 这一小节里的元素 id（按顺序；高亮用） */
  ids: ElementId[];
  /** 第一个元素在原文里的位置（没有原文的来源为 undefined） */
  source?: SourceSpan;
}

export interface BeatCheckOptions {
  /** 混合拍：这些拍号对上任意一个就算过（识别结果的 `RecognizedScore.meters`）。缺省按模型里的拍号 */
  meters?: readonly { beats: number; beatType: number }[];
  /** 这个声部的首小节不满算不算弱起（放过）。缺省一律算 */
  pickup?: (songIndex: number, partIndex: number) => boolean;
}

const EPS = 1e-6;
const beatsOf = (t: { beats: number; beatType: number }): number => t.beats * (4 / t.beatType);

/** 一小节里**各声部**的实际时值（四分音符为 1），按出现先后。
 *  同一小节有多个声部只有一种来源：ABC `&` 的临时多声部（§7.4），各分支都该占满一小节——
 *  所以要逐分支算，主分支对了不代表其它分支对。
 *  按 `divisions` 算（`<type>` 不含增时线）：MusicXML 形状的 divisions 已是实际时值，
 *  简谱形状的多连音记名义值（`omr/todoc.ts`、123 解析端同口径），要按比例折回。
 *  MusicXML 形状按**起点**算声部的终点（`onset`，缺省接前一个元素的终点）：`<forward>` 空过的前几拍也是这个声部的——
 *  钢琴右手前两拍不出声、第三拍起一个二分（宁静的伯利恒 m10，左手琶音这时升到右手谱表上），时值和只有两拍，终点正好一小节。 */
function measureQuarters(m: Measure, divisions: number, xml: boolean): Map<number, number> {
  const out = new Map<number, number>();
  let end = 0;
  for (const el of m.elements) {
    const grace = el.kind === "chord" && el.grace;
    const d = grace ? undefined : el.duration;
    const start = xml ? (el.onset ?? end) : 0;
    end = start + (d?.divisions ?? 0);
    if (!d) continue;
    const raw = d.divisions / divisions;
    const q = !xml && d.timeMod ? (raw * d.timeMod.normal) / d.timeMod.actual : raw;
    out.set(el.voice, xml ? Math.max(out.get(el.voice) ?? 0, end / divisions) : (out.get(el.voice) ?? 0) + q);
  }
  return out;
}

/** 逐小节查时值，返回对不上的那些。 */
export function checkMeasureDurations(doc: ScoreDoc, opts: BeatCheckOptions = {}): BeatIssue[] {
  const out: BeatIssue[] = [];
  doc.songs.forEach((song, songIndex) => {
    const xml = isXmlShaped(song);
    song.parts.forEach((part, partIndex) => {
      let time: Time | undefined = song.time;
      let divisions = SIMPLE_DIVISIONS;
      // 文本谱的临时拍号记在小节线上（`Barline.time`，`"p:4/4"`）：右线上的自下一小节起生效、左线上的管本小节
      //（选本 376 换 4/4 写在上一行行末线后面，原先只看 `attrs.time`，诗歌本格式下副歌七个小节全报多 1 拍）
      let pending: Time | undefined;
      const rows = part.measures.map((m) => {
        if (pending) { time = pending; pending = undefined; }
        const leftTime = m.barlines?.find((b) => b.location === "left" && b.time)?.time;
        if (leftTime) time = leftTime;
        if (m.attrs?.time) time = m.attrs.time;
        pending = m.barlines?.find((b) => b.location === "right" && b.time)?.time;
        if (m.attrs?.divisions) divisions = m.attrs.divisions;
        // 混合拍：头部并排写的几个拍号（`Song.extraTimes`）对上任意一个都算。
        // 识别给的页眉拍号压不过曲中转拍号：转过拍的小节按当前拍号也算（选本 376 副歌转 4/4，原先仍按页眉 3/4 报不满拍）
        const wants = opts.meters?.length
          ? [...opts.meters, ...(time && time !== song.time ? [time] : [])].map(beatsOf)
          : time ? [time, ...(song.extraTimes?.length && song.time ? [song.time, ...song.extraTimes] : [])].map(beatsOf) : [];
        const byVoice = measureQuarters(m, divisions, xml);
        return { m, wants, byVoice, got: byVoice.values().next().value ?? 0 };
      });
      const n = rows.length;
      const ok = rows.map((r) => r.wants.length === 0 || r.m.elements.length === 0 || !!r.m.implicit
        || r.wants.some((w) => Math.abs(r.got - w) < EPS));
      const short = (i: number): boolean => rows[i]!.wants.some((w) => rows[i]!.got < w - EPS);
      // 两头拍号不同时对上哪一头都算（选本 376：3/4 的弱起 1 拍 + 转 4/4 后的末小节 3 拍）
      const fills = (a: number, b: number): boolean =>
        [...rows[a]!.wants, ...rows[b]!.wants].some((w) => Math.abs(rows[a]!.got + rows[b]!.got - w) < EPS);
      const pickup = opts.pickup?.(songIndex, partIndex) ?? true;
      // 弱起：首尾相加一小节（只有一小节时首尾是同一个，不算）
      if (pickup && n >= 2 && !ok[0] && short(0) && short(n - 1) && fills(0, n - 1)) ok[0] = ok[n - 1] = true;
      // 首小节单独弱起、末小节是满的：诗歌谱里也常见，首小节不满一律放过
      if (pickup && n >= 2 && !ok[0] && short(0)) ok[0] = true;
      // 相邻两个不满的相加一小节（反复记号劈开的小节）。后一个标了 `implicit` 的已经放过了，照样能替前一个凑满
      // （赞美诗乐句中间劈开的小节：前半 4 拍收句、后半 2 拍 implicit 起下一句）
      for (let i = 0; i + 1 < n; i++) {
        if (!ok[i] && (!ok[i + 1] || !!rows[i + 1]!.m.implicit) && short(i) && short(i + 1) && fills(i, i + 1)) ok[i] = ok[i + 1] = true;
      }
      // 临时多声部：各分支与主分支等长才算过（这一小节本身满不满由下面那套规则裁决）
      rows.forEach((r, measureIndex) => {
        if (r.byVoice.size < 2) return;
        for (const [, q] of [...r.byVoice].slice(1)) {
          if (Math.abs(q - r.got) < EPS) continue;
          // MusicXML 的副声部可以提前收尾（合唱谱女低、男低唱半小节就并回主声部的和弦、共用符干），
          // 末尾的 `<forward>` 读进来不留元素，短了不算错；只查比主声部长的
          if (xml && q < r.got) continue;
          const issue: BeatIssue = { songIndex, partIndex, measureIndex, want: r.got, got: q, ids: r.m.elements.map((e) => e.id) };
          const src = r.m.elements.find((e) => e.source)?.source;
          if (src) issue.source = src;
          out.push(issue);
        }
      });
      rows.forEach((r, measureIndex) => {
        if (ok[measureIndex]) return;
        const want = r.wants.reduce((best, w) => (Math.abs(w - r.got) < Math.abs(best - r.got) ? w : best), r.wants[0]!);
        const issue: BeatIssue = { songIndex, partIndex, measureIndex, want, got: r.got, ids: r.m.elements.map((e) => e.id) };
        const src = r.m.elements.find((e) => e.source)?.source;
        if (src) issue.source = src;
        out.push(issue);
      });
    });
  });
  return out;
}

/** 分数拍数的写法：`1/2`、`1 1/2`、`3`。 */
function beatText(q: number): string {
  for (const d of [1, 2, 4, 8, 16, 3, 6, 12]) {
    const n = Math.round(q * d);
    if (Math.abs(n / d - q) > EPS) continue;
    if (d === 1) return String(n);
    const whole = Math.floor(n / d);
    const rest = n - whole * d;
    return whole ? `${whole} ${rest}/${d}` : `${rest}/${d}`;
  }
  return q.toFixed(2);
}

/** 一条问题的说法：「差 1/2 拍」「多 1 拍」。 */
export function describeBeatIssue(i: BeatIssue): string {
  const diff = i.got - i.want;
  return msgText(msg(diff < 0 ? "beat.short" : "beat.over", { d: beatText(Math.abs(diff)), want: beatText(i.want), got: beatText(i.got) }));
}

/** 红框角上标的差额（识谱软件那样一眼看出差多少：`−♩`、`+♪`、`+𝅗𝅥.`）；凑不成一个音符的写拍数（`−1 1/3`）。 */
export function beatTag(i: BeatIssue): string {
  const diff = i.got - i.want;
  const sign = diff < 0 ? "−" : "+";
  const q = Math.abs(diff);
  const NOTES: [number, string][] = [
    [4, "\u{1D15D}"], [3, "\u{1D15E}."], [2, "\u{1D15E}"], [1.5, "♩."], [1, "♩"], [0.75, "♪."], [0.5, "♪"], [0.25, "\u{1D161}"],
  ];
  const hit = NOTES.find(([v]) => Math.abs(v - q) < EPS);
  return sign + (hit ? hit[1] : beatText(q));
}
