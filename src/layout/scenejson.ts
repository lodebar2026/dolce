// 页面树 → 场景 JSON（`crates/dolce-scene` 的 `Node` / `Page` 形状）。编辑器「导出 PDF」把它交 Rust 写出端
//（桌面 `export_scene_pdf`），排版迁 Rust 的对拍（`cli/layoutref.ts`）也拿它当参照。不碰 DOM。
import { GraphicLine, GraphicPath, Group, PageItem, SmuflText, TextFrame } from "../pagetree/pageitem";
import { JpNumber, JpOctaveDot, BeamLine } from "../engrave/jpnumber";
import { Lyric } from "../engrave/syllable";
import { Slur, Tie, SlurTieBase } from "../engrave/arc";
import type { ScorePainter } from "./painter";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const mat6 = (it: PageItem): number[] => it.matrix.mat.slice(0, 6);

/** 数字所在音符组在减时线父节点里的下标（数字须是那组的头一个子节点，同 Rust `paint_note` 的返回）。 */
function numGroupIndex(line: BeamLine, num: JpNumber): number {
  const g = num.parent;
  if (!g || g.children[0] !== num || g.parent !== line.parent) throw new Error("减时线两端的数字不在同级音符组的头一个");
  return line.parent!.children.indexOf(g);
}

function roleOf(it: PageItem): Json | undefined {
  if (it instanceof JpNumber) return { k: "JpNumber", augDotAdvance: it.augDotAdvance, cx: it.cx };
  if (it instanceof JpOctaveDot) {
    if (!it.aug) return { k: "JpOctaveDot", radius: it.radius };
    if (it.parent?.children[0] !== it.aug.num) throw new Error("附点挂的数字不是父组的头一个");
    return { k: "JpOctaveDot", radius: it.radius, aug: it.aug.index };
  }
  if (it instanceof BeamLine) {
    if (!it.leftNum || !it.rightNum) return { k: "BeamLine", level: it.level };
    return { k: "BeamLine", level: it.level, ends: [numGroupIndex(it, it.leftNum), numGroupIndex(it, it.rightNum)] };
  }
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

