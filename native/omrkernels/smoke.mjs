// 像素内核原生模块的冒烟测试（CI 在 macOS / Windows 上跑，见 .github/workflows/native.yml）：
// 合成小图上查已知答案；与 TS 逐项比对在私有仓库的 dev/tests/omrkit/kernels.test.ts（真实页面）。
// 用法：node native/omrkernels/smoke.mjs
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const k = createRequire(import.meta.url)(join(here, "omrkernels.node"));
let failed = 0;
const check = (what, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${what}${detail === undefined ? "" : `：${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};
const img = (w, h, f) => {
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (f(x, y)) d[y * w + x] = 1;
  return d;
};

// 连通域：棋盘按 8 邻接是一整块；两个分开的方块是两块，块号按光栅序
{
  const w = 9, h = 7;
  const lab = new Int32Array(w * h);
  const f = k.connectedComponents(img(w, h, (x, y) => (x + y) % 2 === 0), w, h, 1, lab);
  check("棋盘 8 邻接一块", f.length === 8 && f[5] === 32, Array.from(f));
  const g = k.connectedComponents(img(10, 6, (x, y) => (x < 3 && y < 2) || (x >= 6 && y >= 3)), 10, 6, 1, new Int32Array(60));
  check("两块方块", g.length === 16 && g[0] === 1 && g[1] === 0 && g[8] === 2 && g[9] === 6 && g[13] === 12, Array.from(g));
}
// 开运算：细线抹掉、实心块留下
{
  const w = 40, h = 30;
  const o = k.ellipseOpen(img(w, h, (x, y) => y === 5 || (x >= 15 && x < 27 && y >= 12 && y < 22)), w, h, 3, 2);
  const at = (x, y) => o[y * w + x];
  check("开运算抹细线", at(20, 5) === 0 && at(2, 5) === 0);
  check("开运算留块心", at(21, 17) === 1);
}
// 游程长度：一行 5 个墨点
{
  const r = k.runLengths(img(8, 1, (x) => x >= 2 && x < 7), 8, 1, false);
  check("横游程", r[2] === 5 && r[6] === 5 && r[0] === 0, Array.from(r));
}
// 找孔：方框中间一个 3×3 的孔
{
  const holes = k.findHoles(img(7, 7, (x, y) => x === 1 || x === 5 || y === 1 || y === 5), 7, 7, 1);
  check("方框里一个孔", holes.length === 4 && holes[0] === 2 && holes[2] === 3, Array.from(holes));
}
if (failed) {
  console.error(`${failed} 项不过`);
  process.exit(1);
}
console.log("像素内核冒烟测试通过");
