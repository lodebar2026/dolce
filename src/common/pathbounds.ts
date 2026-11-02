// SVG path `d` 的紧包围盒（曲线按极值点算，不含控制点），与浏览器 `SVGPathElement.getBBox()` 同口径。
// 字体文件测量后端（measure.font.ts）用它；无 DOM 依赖。
// 支持 M L H V C S Q T Z（含相对写法）；A 只计端点（页面树不产生弧）。

import { Rect } from "./geom";

const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/** 三次/二次贝塞尔一个坐标分量在 (0,1) 内的极值参数。 */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      ts.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

export function pathBounds(d: string): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  const cubic = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) => {
    add(dx, dy);
    for (const t of cubicExtrema(ax, bx, cx, dx)) add(cubicAt(ax, bx, cx, dx, t), cubicAt(ay, by, cy, dy, t));
    for (const t of cubicExtrema(ay, by, cy, dy)) add(cubicAt(ax, bx, cx, dx, t), cubicAt(ay, by, cy, dy, t));
  };
  let cx = 0, cy = 0, sx = 0, sy = 0;
  // 上一段的第二控制点（S/T 的反射用）
  let qx = 0, qy = 0, prev = "";
  for (const m of d.matchAll(/([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)/g)) {
    const op = m[1]!;
    const args = (m[2]!.match(NUM) ?? []).map(Number);
    const rel = op === op.toLowerCase();
    const OP = op.toUpperCase();
    if (OP === "Z") {
      cx = sx;
      cy = sy;
      prev = "Z";
      continue;
    }
    const arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 }[OP]!;
    for (let i = 0; i + arity <= args.length; i += arity) {
      const a = args.slice(i, i + arity);
      const ox = rel ? cx : 0, oy = rel ? cy : 0;
      let cmd = OP;
      if (cmd === "M" && i > 0) cmd = "L"; // M 之后的成对坐标按 L 读
      switch (cmd) {
        case "M":
          cx = sx = a[0]! + ox;
          cy = sy = a[1]! + oy;
          add(cx, cy); // moveTo 点也算（同 Skia computeTightBounds）
          break;
        case "L":
          cx = a[0]! + ox;
          cy = a[1]! + oy;
          add(cx, cy);
          break;
        case "H":
          cx = a[0]! + ox;
          add(cx, cy);
          break;
        case "V":
          cy = a[0]! + oy;
          add(cx, cy);
          break;
        case "C": {
          const [x1, y1, x2, y2, x, y] = [a[0]! + ox, a[1]! + oy, a[2]! + ox, a[3]! + oy, a[4]! + ox, a[5]! + oy];
          cubic(cx, cy, x1, y1, x2, y2, x, y);
          qx = x2; qy = y2; cx = x; cy = y;
          break;
        }
        case "S": {
          const rx = prev === "C" || prev === "S" ? 2 * cx - qx : cx;
          const ry = prev === "C" || prev === "S" ? 2 * cy - qy : cy;
          const [x2, y2, x, y] = [a[0]! + ox, a[1]! + oy, a[2]! + ox, a[3]! + oy];
          cubic(cx, cy, rx, ry, x2, y2, x, y);
          qx = x2; qy = y2; cx = x; cy = y;
          break;
        }
        case "Q":
        case "T": {
          let px: number, py: number, x: number, y: number;
          if (cmd === "Q") [px, py, x, y] = [a[0]! + ox, a[1]! + oy, a[2]! + ox, a[3]! + oy];
          else {
            px = prev === "Q" || prev === "T" ? 2 * cx - qx : cx;
            py = prev === "Q" || prev === "T" ? 2 * cy - qy : cy;
            [x, y] = [a[0]! + ox, a[1]! + oy];
          }
          // 二次升三次
          cubic(cx, cy, cx + (2 / 3) * (px - cx), cy + (2 / 3) * (py - cy), x + (2 / 3) * (px - x), y + (2 / 3) * (py - y), x, y);
          qx = px; qy = py; cx = x; cy = y;
          break;
        }
        case "A":
          cx = a[5]! + ox;
          cy = a[6]! + oy;
          add(cx, cy);
          break;
      }
      prev = cmd;
    }
  }
  if (x1 < x0) return new Rect();
  return new Rect(x0, y0, x1, y1);
}
