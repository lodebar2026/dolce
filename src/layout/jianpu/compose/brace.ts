// 花括号（连谱号、并排块、词括号）的轮廓路径。
import { Font } from "../../../pagetree/font";
import { Matrix33 } from "../../../common/geom";
import { GraphicPath, Group, PageItem, type PathSeg } from "../../../pagetree/pageitem";
import { BRACKET } from "../../../engrave/jpglyph";
import { type OriginalCtx, rect, text } from "./ctx";
import { BRACE_GLYPHS } from "./braceglyphs";

/** SVG path 的 `d` → 我们的 PathSeg（只需要 m/l/h/v/c/s/z，字形里没有别的命令）。 */
function parsePathD(d: string): PathSeg[] {
  const segs: PathSeg[] = [];
  const tokens = d.match(/[MmLlHhVvCcSsZz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let prevC2x = 0;
  let prevC2y = 0;
  let lastCmd = "";
  const num = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    let cmd = tokens[i]!;
    if (/[A-Za-z]/.test(cmd)) i += 1;
    else cmd = lastCmd === "M" ? "L" : lastCmd === "m" ? "l" : lastCmd; // 省略的重复命令
    lastCmd = cmd;
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    switch (cmd.toUpperCase()) {
      case "M": {
        cx = num() + ox;
        cy = num() + oy;
        startX = cx;
        startY = cy;
        segs.push({ op: "M", pts: [cx, cy] });
        break;
      }
      case "L": {
        cx = num() + ox;
        cy = num() + oy;
        segs.push({ op: "L", pts: [cx, cy] });
        break;
      }
      case "H": {
        cx = num() + ox;
        segs.push({ op: "L", pts: [cx, cy] });
        break;
      }
      case "V": {
        cy = num() + oy;
        segs.push({ op: "L", pts: [cx, cy] });
        break;
      }
      case "C": {
        const c1x = num() + ox;
        const c1y = num() + oy;
        const c2x = num() + ox;
        const c2y = num() + oy;
        cx = num() + ox;
        cy = num() + oy;
        segs.push({ op: "C", pts: [c1x, c1y, c2x, c2y, cx, cy] });
        prevC2x = c2x;
        prevC2y = c2y;
        break;
      }
      case "S": {
        // 平滑三次：第一个控制点是上一段第二控制点的映射
        const c1x = 2 * cx - prevC2x;
        const c1y = 2 * cy - prevC2y;
        const c2x = num() + ox;
        const c2y = num() + oy;
        cx = num() + ox;
        cy = num() + oy;
        segs.push({ op: "C", pts: [c1x, c1y, c2x, c2y, cx, cy] });
        prevC2x = c2x;
        prevC2y = c2y;
        break;
      }
      case "Z": {
        segs.push({ op: "Z", pts: [] });
        cx = startX;
        cy = startY;
        break;
      }
      default:
        i += 1;
    }
    if (cmd.toUpperCase() !== "C" && cmd.toUpperCase() !== "S") {
      prevC2x = cx;
      prevC2y = cy;
    }
  }
  return segs;
}

/**
 * 花括号（`{` / `}`）：直接用番茄简谱的字形轮廓（见 `braceglyphs.ts`），
 * **横向轮廓固定、纵向按跨度拉伸**——这正是原版给词括号配 `scale(1, k)` 的做法，
 * 笔画的横向粗细因此不随跨度变化。
 *
 * `xLeft` 是墨迹左缘，`kind` 选并排块用的大括号还是歌词用的词括号。
 */
export function braceItem(
  color: number,
  xLeft: number,
  y0: number,
  y1: number,
  dir: -1 | 1,
  kind: "split" | "lyric",
): PageItem {
  const g =
    kind === "split"
      ? dir < 0
        ? BRACE_GLYPHS.splitLeft
        : BRACE_GLYPHS.splitRight
      : dir < 0
        ? BRACE_GLYPHS.lyricLeft
        : BRACE_GLYPHS.lyricRight;
  const [bx, by, , bh] = g.box;
  const sy = (y1 - y0) / bh;
  const path = new GraphicPath();
  path.segs = parsePathD(g.d);
  path.offset(g.shift, g.shift); // 字形自带的 translate
  path.fill = true;
  path.fillColor = color;
  // 承载缩放的那层必须是裸 PageItem：Group.update() 会把子项归一到组包围盒原点，
  // 带非等比缩放时补偿量对不上，图形会被挪走
  const holder = new PageItem();
  const mat = new Matrix33();
  mat.setAffine([1, 0, 0, sy, xLeft - bx, y0 - by * sy]);
  holder.matrix = mat;
  holder.add(path);
  return holder;
}

/**
 * 连谱号：SMuFL 的 bracketTop / bracketBottom 两截花头，中间用一根竖线接上。
 * 竖线长度随声部数变化，花头尺寸固定，所以不能整体缩放一个字形了事。
 */
/**
 * 连谱号。番茄原版是**一粗一细两条竖线**（粗 0.22、细 0.11 个墨迹高，中心距 0.25，
 * 粗线两端各探出 0.36、细线 0.44）；诗歌本印刷版才是带花头的括号。
 */
export function paintBrace(c: OriginalCtx, root: Group, x: number, top: number, bottom: number): void {
  const m = c.metrics;
  const ink = m.ink.noteHeight;
  const size = ink * 2.2;
  const font = new Font("Bravura", size);
  const thick = size * 0.115;
  const thin = m.style.stroke.barline;
  // 粗线与细线的中心距
  const gap = ink * 0.55;
  const y0 = top - ink * 0.85;
  const y1 = bottom + ink * 0.85;
  root.add(rect(c.ink, x - thick / 2, y0, thick, y1 - y0));
  // 右侧的细竖线：整组一根到底，**不像小节线那样在歌词处断开**；
  // 比粗线短一截，两端给花头留空隙
  const inset = ink * 0.42;
  root.add(rect(c.ink, x + gap - thin / 2, top - inset, thin, bottom - top + inset * 2));
  // 上下花头：字形基线分别落在粗线两端
  root.add(text(BRACKET.top, x - thick / 2, y0, font, c.ink));
  root.add(text(BRACKET.bottom, x - thick / 2, y1, font, c.ink));
}
