// 反复展开的公共那一半：按 `PlayItem[]`（`playData.measures`）逐遍走小节。
//
// 「这首歌该唱成什么样」由演唱顺序（crates/dolce-play，经 `score/play.ts`）从 `ScoreDoc` 推（反复与跳转 / `.Repeat` 段），
// 两种格式都拿到同一种 `PlayItem[]`；这里只负责**怎么走**——逐遍、逐小节、首尾小节的裁切、
// 遍末换页。「怎么放一个小节」由 sink 决定：排版往 Line 里装小节（layout.ts::buildLine）。
// 投影档各格式投影成同一种引擎输入，走的是同一条路（jianpu/expanded.ts）。
//
// 怎么走在 Rust（crates/dolce-play/src/walk.rs，wasm `walkPlay` / `countPasses`）：这里把演唱顺序项拍成扁平数组交过去，
// 按回来的步骤回放给 sink（`P:` 段落的小节集合 `scope` 按项下标从原对象取）。

import { PlayItem } from "../score/playtypes";
import { dolce } from "../common/dolce";

/** 演唱顺序项拍成每项 8 个数（mid, end, pass, skip, limit, endOfPass, sectionEntry, glueFrom），同 Rust `walk::WalkItem` */
function itemsIn(items: readonly PlayItem[]): Float64Array {
  const a = new Float64Array(items.length * 8);
  items.forEach((it, i) => {
    a.set([it.mid, it.end, it.pass, it.skip, it.limit, it.endOfPass ? 1 : 0, it.sectionEntry ? 1 : 0, it.glueFrom], i * 8);
  });
  return a;
}

/** 简谱档：按原谱排一遍——一小节一项、pass = 0（多段歌词叠排、不展开任何反复）。 */
export function identityPlan(measureCount: number): PlayItem[] {
  const out: PlayItem[] = [];
  for (let i = 0; i < measureCount; i++) {
    const it = new PlayItem();
    it.mid = i;
    it.end = i + 1;
    it.pass = 0;
    it.skip = 0;
    it.limit = -1;
    it.endOfPass = false;
    out.push(it);
  }
  return out;
}

/** 一个小节在这一遍里的裁切。 */
export interface MeasureCut {
  /** 首小节跳过前几个和弦（弱起式接入，`.Repeat` 写作 `11.2-20V4`） */
  skip: number;
  /** 末小节只取前几个和弦（-1 = 整节） */
  limit: number;
  /** 整首最后一小节 */
  final: boolean;
  /** 接在前一小节同一行、不在它前面换行（`PlayItem.glueFrom`） */
  glue?: boolean;
  /** 按 `P:` 排的：这一遍的词只在这些小节里算（`PlayItem.scope`） */
  scope?: ReadonlySet<number>;
}

export interface PlaySink {
  measure(mid: number, pass: number, cut: MeasureCut): void;
  /** 一遍唱完（`endOfPass`）：投影档据此换页 */
  passEnd(): void;
  /** 往回跳、但还是同一段词（反复只有一段、D.S./D.C. 回去唱到 Fine）：给了它就只另起一行、不换页 */
  jumpBack?(): void;
}

/**
 * 逐遍逐小节回调。换页（`passEnd`）有两处：`endOfPass`，以及**往回跳**（反复、D.C./D.S.）——
 * 那是新的一遍；往回跳还唱同一段词的，sink 给了 `jumpBack` 就只换行（投影档：一页一行的碎页，250《主，差遣我》）。遍号变了但往前接着唱的（二房之后 pass 归 1 的尾段、跳过一房）不换页，
 * 否则前一页常只剩一行半（同一首歌）。同一小节被 limit/skip 切成前后两截的，后一截也是接着唱。
 */
export function walkPlay(items: readonly PlayItem[], sink: PlaySink): void {
  const steps = dolce().walkPlay(itemsIn(items), !!sink.jumpBack);
  for (let k = 0; k < steps.length;) {
    const kind = steps[k]!;
    if (kind === 1) {
      sink.passEnd();
      k += 1;
    } else if (kind === 2) {
      sink.jumpBack!();
      k += 1;
    } else {
      const it = items[steps[k + 7]!]!;
      sink.measure(steps[k + 1]!, steps[k + 2]!, {
        skip: steps[k + 3]!,
        limit: steps[k + 4]!,
        final: steps[k + 5] === 1,
        ...(steps[k + 6] === 1 ? { glue: true } : {}),
        ...(it.scope ? { scope: it.scope } : {}),
      });
      k += 8;
    }
  }
}

/** 投影档应有几遍——按 walkPlay 的换页切出来、确有小节的段数。page-check 的 P5 拿它对页面结构。 */
export function countPasses(items: readonly PlayItem[]): number {
  return dolce().countPasses(itemsIn(items));
}
