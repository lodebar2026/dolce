// 排版迁 Rust 的 TS 参考导出（L0 起，计划见 dev/docs/模型排版迁移Rust计划.md）：把 TS 排出来的东西写成 Rust 读得进的 JSON。
//   - 页面树 → 场景节点（`crates/dolce-scene` 的 `Node`/`Page` 形状）：Rust 读进来再出 SVG，与 TS `outerHTML` 逐字节比；
//   - 量字录制：装在 `setMeasureBackend` 那一层（缓存之下），录下每次后端调用与结果（`dolce-text` 的 `MeasureRecord`），
//     Rust 的回放后端（`ReplayMeasurer`）照它答，原生后端拿它逐键对；
//   - 简谱定位结构（PlacedScore）与栅格（JianpuGrid）、样式表：给后面几期的中间对拍当参照（元素换成 `{"@el": id}`）。
// 只给 dev `layout-ref.mjs` 用；排版迁完（H 期）随 TS 排版一起删。
import { GraphicLine, GraphicPath, Group, PageItem, SmuflText, TextFrame } from "../pagetree/pageitem";
import { JpNumber, JpOctaveDot, BeamLine } from "../engrave/jpnumber";
import { Lyric } from "../engrave/syllable";
import { Slur, Tie, SlurTieBase } from "../engrave/arc";
import { setMeasureBackend, type MeasureBackend } from "../common/measure";
import type { ScorePainter } from "../layout/painter";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const mat6 = (it: PageItem): number[] => it.matrix.mat.slice(0, 6);

function roleOf(it: PageItem): Json | undefined {
  if (it instanceof JpNumber) return { k: "JpNumber", augDotAdvance: it.augDotAdvance };
  if (it instanceof JpOctaveDot) return { k: "JpOctaveDot", radius: it.radius };
  if (it instanceof BeamLine) return { k: "BeamLine", level: it.level };
  if (it instanceof Lyric) return { k: "Lyric", widths: [...it._widths], compress: it.compress, verse: it.verse };
  if (it instanceof Tie) return { k: "Tie", flatHx: it.flatHx, startId: it.startId, endId: it.endId };
  if (it instanceof Slur) return { k: "Slur", flatHx: it.flatHx };
  if (it instanceof SlurTieBase) throw new Error("未知的弧类");
  return undefined;
}

/** `data` 只收全是数的平铺对象（五线谱系统的谱表带、和弦组的 cx）；挂的模型对象不收（身份标签已经说了是谁）。 */
function plainData(d: unknown): Json | undefined {
  if (!d || typeof d !== "object" || Array.isArray(d)) return undefined;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(d)) {
    if (typeof v !== "number") return undefined;
    out[k] = v;
  }
  return out;
}

function textOf(it: TextFrame): Record<string, Json> {
  const f = it.font;
  return {
    text: it.text,
    font: { family: f.family, size: f.size, bold: f.bold, italic: f.italic },
    color: it.color,
    charXs: it.charXs ? [...it.charXs] : null,
    inkBound: it.inkBound,
  };
}

/** 页面树 → 场景节点。 */
export function sceneNode(it: PageItem): Json {
  const n: Record<string, Json> = {};
  if (it instanceof Group) n.t = "g";
  else if (it instanceof GraphicPath) {
    n.t = "p";
    n.segs = it.segs.map((s) => [s.op, ...s.pts]);
    n.strokeWidth = it.strokeWidth;
    n.strokeColor = it.strokeColor;
    n.fillColor = it.fillColor;
    n.stroke = it.stroke;
    n.fill = it.fill;
  } else if (it instanceof GraphicLine) {
    n.t = "l";
    n.p0 = [it.p0.x, it.p0.y];
    n.p1 = [it.p1.x, it.p1.y];
    n.strokeWidth = it.strokeWidth;
    n.strokeColor = it.strokeColor;
  } else if (it instanceof SmuflText) {
    n.t = "s";
    Object.assign(n, textOf(it));
    n.asPath = it.asPath;
  } else if (it instanceof TextFrame) {
    n.t = "x";
    Object.assign(n, textOf(it));
  } else n.t = "i";
  const role = roleOf(it);
  if (role) n.role = role;
  n.m = mat6(it);
  n.w = it.width;
  n.h = it.height;
  try {
    const b = it.bound;
    n.b = [b.left, b.top, b.right, b.bottom];
  } catch {
    // SMuFL 字的码位不在元数据里：TS 取盒就抛（排版没用到它的盒），记成没有
  }
  if (it.classes.size) n.cls = [...it.classes];
  if (it.ident) n.id = JSON.parse(JSON.stringify(it.ident)) as Json;
  if (it.selectable) n.sel = true;
  const data = plainData(it.data);
  if (data) n.data = data;
  if (it.children.length) n.k = it.children.map(sceneNode);
  return n;
}

/** 当前结果的各页场景（同 `ScorePainter.renderPage` 的外壳：方言、class、viewBox）。 */
export function pageScenes(painter: ScorePainter): Json[] {
  const staff = painter.renderer === "staff";
  return (painter.result?.pages ?? []).map((p) => ({
    dialect: staff ? "mixed" : "jianpu",
    cls: staff ? "score-page mixed-page" : "score-page",
    w: p.geometry.viewBox.w,
    h: p.geometry.viewBox.h,
    root: p.root ? sceneNode(p.root) : null,
  }));
}

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

/** 简谱档的定位结构与栅格；别的路为 null。 */
export function jianpuRefs(painter: ScorePainter): { placed: Json; grid: Json } | null {
  const r = painter.jianpuLayout;
  if (!r) return null;
  const idOf = r.view.idOf as ReadonlyMap<unknown, number>;
  return { placed: plainOf(r.placed.pages, idOf), grid: plainOf(r.metrics, idOf) };
}

/** 录下的一次后端调用（`dolce-text::MeasureRecord`）。 */
export type MeasureRecord = Record<string, Json>;

/**
 * 给测量后端套一层录制：每次调用写一条（去重靠上面 `measure.ts` 的缓存，同一进程里同一调用只到后端一次）。
 * 装上即 `setMeasureBackend`（会清缓存）；返回取走已录条目的函数。
 */
export function recordMeasure(inner: MeasureBackend): () => MeasureRecord[] {
  let log: MeasureRecord[] = [];
  const rect = (r: { left: number; top: number; right: number; bottom: number }) => [r.left, r.top, r.right, r.bottom];
  setMeasureBackend({
    glyph(text, family, size, weight, features, style) {
      const m = inner.glyph(text, family, size, weight, features, style);
      log.push({ op: "glyph", text, family, size, weight, features: [...(features ?? [])], style, width: m.width, bbox: rect(m.bbox) });
      return m;
    },
    positions(text, family, size, weight, features) {
      const p = inner.positions(text, family, size, weight, features);
      log.push({ op: "positions", text, family, size, weight, features: [...features], xs: [...p.xs], width: p.width });
      return p;
    },
    fontMetrics(family, size, weight, style) {
      const m = inner.fontMetrics(family, size, weight, style);
      log.push({ op: "fontMetrics", family, size, weight, style, ascent: m.ascent, descent: m.descent });
      return m;
    },
    pathBounds(d) {
      const r = inner.pathBounds(d);
      log.push({ op: "pathBounds", d, bbox: rect(r) });
      return r;
    },
  });
  return () => {
    const out = log;
    log = [];
    return out;
  };
}
