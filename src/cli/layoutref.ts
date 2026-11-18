// 排版迁 Rust 的 TS 参考导出（L0 起，计划见 dev/docs/模型排版迁移Rust计划.md）：把 TS 排出来的东西写成 Rust 读得进的 JSON。
//   - 页面树 → 场景节点（`crates/dolce-scene` 的 `Node`/`Page` 形状）：Rust 读进来再出 SVG，与 TS `outerHTML` 逐字节比；
//   - 量字录制：装在 `setMeasureBackend` 那一层（缓存之下），录下每次后端调用与结果（`dolce-text` 的 `MeasureRecord`），
//     Rust 的回放后端（`ReplayMeasurer`）照它答，原生后端拿它逐键对；
//   - 简谱定位结构（PlacedScore）与栅格（JianpuGrid）、样式表：给后面几期的中间对拍当参照（元素换成 `{"@el": id}`）。
// 只给 dev `layout-ref.mjs` 用；排版迁完（H 期）随 TS 排版一起删。
import { PageItem } from "../pagetree/pageitem";
import type { ScorePainter } from "../layout/painter";
import { pageScenes, sceneNode, type Json } from "../layout/scenejson";

export { pageScenes, sceneNode };

/** 任意排版中间结构 → JSON：模型元素换成 `{"@el": id}`，视图里的行 / 组等共享对象第二次出现起换成 `{"@ref": n}`，
 *  Map 写成 `{"@map": [[k, v]…]}`、Set 写成数组。 */
export function plainOf(root: unknown, idOf?: ReadonlyMap<unknown, number>): Json {
  const seen = new Map<object, number>();
  const go = (v: unknown): Json => {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v !== "object") return null;
    const id = idOf?.get(v);
    if (id !== undefined) return { "@el": id };
    const prev = seen.get(v);
    if (prev !== undefined) return { "@ref": prev };
    seen.set(v, seen.size);
    if (v instanceof Map) return { "@map": [...v].map(([k, x]) => [go(k), go(x)]) };
    if (v instanceof Set) return [...v].map(go);
    if (Array.isArray(v)) return v.map(go);
    if (v instanceof PageItem) return { "@item": v.constructor.name };
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) if (typeof x !== "function") out[k] = go(x);
    return out;
  };
  return go(root);
}

/** 简谱档的定位结构与栅格（TS 引擎按 `req` 现排一遍；编辑器已改走 Rust）。 */
export function jianpuRefs(_painter: ScorePainter, req: JianpuPaintRequest): { placed: Json; grid: Json } | null {
  const r = layoutJianpu(structuredClone(req.doc), jianpuCfgOf(req));
  const idOf = r.view.idOf as ReadonlyMap<unknown, number>;
  return { placed: plainOf(r.placed.pages, idOf), grid: plainOf(r.metrics, idOf) };
}

export { recordMeasure, type MeasureRecord } from "../common/measure";

// ---- L3/L4 简谱引擎对拍（dev `jianpu-rs-diff.mjs`）：定位结构规范化成两边同一口径（Rust 那份在 `dolce-layout-jianpu::placedjson`） ----
import type { JianpuPaintRequest } from "../layout/painter";
import { jianpuCfgOf, measureRequestOf } from "../layout/legacy";
import { layoutJianpu } from "../layout/jianpu/compose";
import { bookCfgOf } from "../pdflayout/browser";
import { defaultBookStyle } from "../style/bookstyle";
import { computeStyleForPaper, THEMES, themeOfMode } from "../style/themes";
import type { ScoreDoc } from "../model/doc";
import type { PlacedItem, PlacedMark, PlacedText, PlacedUnderline, PlacedScore } from "../layout/jianpu/place/model";
import type { MusicElement, LyricSyllable } from "../jianpu/ast";

/** 数：非有限数写成 `"NaN"` / `"Inf"` / `"-Inf"`（同 engrave-rs-diff 的口径） */
const jn = (x: number | undefined | null): Json =>
  x === undefined || x === null ? null : Number.isFinite(x) ? x : Number.isNaN(x) ? "NaN" : x > 0 ? "Inf" : "-Inf";
const clone = (v: unknown): Json => (v === undefined ? null : (JSON.parse(JSON.stringify(v)) as Json));

/** `PlacedScore` → 规范化 JSON（键与形见 `dolce-layout-jianpu/src/placedjson.rs` 文件头） */
export function placedJson(
  placed: PlacedScore, idOf: ReadonlyMap<unknown, unknown>, owners: ReadonlyMap<unknown, unknown>,
): Json {
  const idJ = (el: unknown): Json => {
    const id = el === undefined ? undefined : idOf.get(el);
    return id === undefined ? null : (id as number);
  };
  const item = (it: PlacedItem): Json => ({
    i: it.index, s: it.srcIndex, x: jn(it.x), a: jn(it.advance), b: jn(it.beat), n: jn(it.beats),
    e: clone(it.element), id: idJ(it.element), dy: jn(it.dy), nb: !!it.noBarline,
    syl: it.syllables.map((s: LyricSyllable | null) => (s ? [s.text, s.trailingPunctuation ?? null, (owners.get(s) as number | undefined) ?? null] : null)),
  });
  const ul = (u: PlacedUnderline): Json => [jn(u.level), jn(u.x0), jn(u.x1), jn(u.dy)];
  const mark = (m: PlacedMark): Json => ({
    mark: clone(m.mark), x0: jn(m.x0), x1: jn(m.x1), y: jn(m.y), flat: !!m.flat, below: !!m.below, level: jn(m.level),
    ol: m.openLeft, or: m.openRight, dy: jn(m.dy), ends: m.startEl !== undefined || m.endEl !== undefined,
    sid: idJ(m.startEl), eid: idJ(m.endEl),
  });
  const text = (t: PlacedText, items: readonly PlacedItem[]): Json => ({
    k: t.kind, at: items.findIndex((it) => it.element === t.el), text: t.text, face: t.face, size: jn(t.size),
    x: jn(t.x), y: jn(t.y), ink: [jn(t.ink.left), jn(t.ink.top), jn(t.ink.right), jn(t.ink.bottom)],
    xs: t.xs ? t.xs.map(jn) : null, boxed: !!t.boxed, bold: !!t.bold,
  });
  return {
    pages: placed.pages.map((p) => ({
      song: p.song, firstOfSong: p.firstOfSong, titlePage: !!p.titlePage, natural: jn(p.natural),
      headers: p.headers ? p.headers.map((h) => [h.song, jn(h.dy)]) : null,
      groups: p.groups.map((g) => ({
        system: jn((g.group as { system?: number }).system), textY: jn(g.textY), braceTop: jn(g.braceTop), braceBottom: jn(g.braceBottom),
        hasBrace: g.hasBrace, braceFromX: jn(g.braceFromX), song: g.song,
        voices: g.voices.map((v) => ({
          y: jn(v.y), top: jn(v.top), textTop: jn(v.textTop), bottom: jn(v.bottom), lyricY: v.lyricY.map(jn),
          items: v.items.map(item), underlines: v.underlines.map(ul), marks: v.marks.map(mark),
          layers: v.layers.map((l) => ({
            at: v.voice.elements.indexOf(l.layer as MusicElement), items: l.items.map(item), underlines: l.underlines.map(ul), y: jn(l.y),
            split: l.split
              ? {
                dy: jn(l.split.dy), braceLeftX: jn(l.split.braceLeftX), braceRightX: jn(l.split.braceRightX),
                braceTop: jn(l.split.braceTop), braceBottom: jn(l.split.braceBottom), marks: l.split.marks.map(mark),
                band: l.split.band ? l.split.band.map((t) => text(t, l.items)) : null,
              }
              : null,
          })),
          band: v.band.map((t) => text(t, v.items)),
        })),
      })),
    })),
    contentBottom: jn(placed.contentBottom),
    contentRight: jn(placed.contentRight),
  };
}

type JianpuCfg = ReturnType<typeof jianpuCfgOf>;
type JianpuResult = ReturnType<typeof layoutJianpu>;

/** 一档用例：交给引擎的文档、外部配置与 TS 排出的期望（栅格、规范化定位结构、页宽高、行首、量宽时的自然跨度） */
function caseOf(doc: unknown, c: JianpuCfg, r: JianpuResult): { doc: Json; config: Json; expect: Record<string, Json> } {
  return {
    doc: clone(doc),
    config: {
      style: clone(c.style), page: { width: c.page.width, height: c.page.height, continuous: c.page.continuous },
      userMargins: c.userMargins, foot: clone(c.foot), noReflow: !!c.noReflow, expanded: !!c.expanded, breakDesc: c.breakDesc ?? null,
      book: !!c.book, measure: !!c.measure, snippet: !!c.snippet, ink: c.ink ?? null,
    },
    expect: {
      grid: plainOf(r.metrics),
      placed: placedJson(r.placed, r.view.idOf as ReadonlyMap<unknown, unknown>, r.view.syllableOwner as ReadonlyMap<unknown, unknown>),
      width: jn(r.width), height: jn(r.height), lineStarts: r.lineStarts as unknown as Json,
      // 按插入序：[id, {x0, x1, x1b|null}]
      spans: r.spans
        ? { width: jn(r.spans.width), spans: [...r.spans.spans].map(([id, s]) => [id, { x0: jn(s.x0), x1: jn(s.x1), x1b: jn(s.x1b) }]) }
        : null,
    },
  };
}

/** 简谱这一路最近一次的输入（文档与外部配置）与 TS 排出的期望；别的路为 null。场景另取 `pageScenes`。 */
export function jianpuCase(_painter: ScorePainter, req: JianpuPaintRequest): { doc: Json; config: Json; expect: Record<string, Json> } | null {
  const doc = structuredClone(req.doc);
  const c = jianpuCfgOf(req);
  return caseOf(doc, c, layoutJianpu(doc, c));
}

/** 编辑器预览之外几种调法（以 `req` 那份文档为料，配置照各调用处现拼，自己排一遍，场景随期望一起给）：
 *  - `snippet`：帮助页谱例（`editor/help.ts::renderExampleScore`：出厂简谱档样式、760×540 纸、压暗墨色、只排谱行）；
 *  - `measure`：量自然宽（`painter.ts::measureDocument`，纸宽取 `req` 那档；投影档按成书量）；
 *  - `book`：成书（`pdflayout/browser.ts::layoutBookDoc`，出厂 BookStyle）。 */
export function jianpuModeCase(mode: "snippet" | "measure" | "book", req: JianpuPaintRequest): { doc: Json; config: Json; expect: Record<string, Json> } | null {
  // 新克隆一份：简谱的文档视图按对象缓存（jianpu/slots.ts），排版会就地改视图（自动段号、段尾词挪位），
  // 同一对象先排过别的档会把那次的改动带进来；Rust 端每例都从 JSON 新读，这里也得从干净的文档起排
  let doc: ScoreDoc = structuredClone(req.doc);
  let c: JianpuCfg;
  if (mode === "snippet") {
    // 同 help.ts::exampleStyleSheet（那个文件带 DOM，Node 里不能引）
    const style = computeStyleForPaper([THEMES[themeOfMode("original")]], { mode: "original", engine: "jianpu" });
    c = jianpuCfgOf({ view: "original", doc, breakDesc: null, style, ink: 0xff1a1a1a, page: { w: 760, h: 540 }, snippet: true });
  } else if (mode === "measure") {
    const sheet = req.style ?? computeStyleForPaper([THEMES.print], { mode: "original", engine: "jianpu" });
    const q = measureRequestOf(doc, sheet, jianpuCfgOf(req).page.width, req.view === "expanded");
    if (!q) return null;
    doc = q.doc;
    c = q.cfg;
  } else {
    const bs = defaultBookStyle();
    c = bookCfgOf(bs, bs.page.h);
  }
  const r = layoutJianpu(doc, c);
  const out = caseOf(doc, c, r);
  out.expect.pages = r.pages.map((root) => ({ dialect: "jianpu", cls: "score-page", w: r.width, h: r.height, root: sceneNode(root) }));
  return out;
}
