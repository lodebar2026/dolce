// 原生量字的冒烟测试（CI 在 macOS / Windows 上跑，见 .github/workflows/native.yml）：
// 只查「系统文字引擎接上了、量出来的数合乎常理」，不比具体数值（各平台字体不同）。
// 有 out/cli/engrave.js 时再用无头排版会话排一首小谱，查排得出页。
// 用法：node native/textmeasure/smoke.mjs
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..");
const tm = createRequire(import.meta.url)(join(here, "textmeasure.node"));
let failed = 0;
const check = (what, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${what}${detail === undefined ? "" : `：${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const CJK = process.platform === "win32" ? ["Microsoft YaHei"] : ["PingFang SC"];
const LATIN = process.platform === "win32" ? ["Times New Roman"] : ["Times New Roman"];
check("系统里有中文字体", tm.hasFamily(CJK[0]), CJK[0]);
check("没有的族报没有", !tm.hasFamily("Dolce No Such Font"));

const han = tm.measure("圣", CJK, 20, false, false, []);
check("汉字一个字身宽", Math.abs(han.width - 20) < 0.5, han.width);
check("汉字有墨、墨在基线上方", han.ink && han.top < -10 && han.bottom > -5, [han.left, han.top, han.right, han.bottom]);

const one = tm.measure("1", CJK, 20, false, false, []);
check("数字比字身窄", one.width > 5 && one.width < 15, one.width);
const dash = tm.measure("-", CJK, 20, false, false, []);
check("「-」的墨在基线以上、扁", dash.ink && dash.bottom < 0 && dash.bottom - dash.top < 4, [dash.top, dash.bottom]);
const space = tm.measure(" ", CJK, 20, false, false, []);
check("空格有宽没有墨", space.width > 2 && !space.ink, space);

const fb = tm.measure("圣a", LATIN, 20, false, false, []);
check("西文字体里的汉字回退得出来", fb.width > 25 && fb.ink, fb.width);

const run = tm.measure("十架 归", CJK, 20, false, false, []);
check("逐码点笔位个数", run.xs.length === 4, run.xs);
check("笔位递增", run.xs.every((x, i) => i === 0 || x > run.xs[i - 1]), run.xs);

const halt = tm.measure("（", CJK, 20, false, false, ["halt"]);
check("halt 能开（字体有就变窄，没有不变）", halt.width <= 20.01, halt.width);

const m = tm.fontMetrics(CJK, 20, false, false);
check("字体度量", m.ascent > 10 && m.descent > 0 && m.family === CJK[0], m);

const bravura = join(web, "public", "redist", "Bravura.otf");
check("注册 Bravura", tm.registerFont(bravura));
const clef = tm.measure("", ["Bravura"], 40, false, false, []);
check("Bravura 高音谱号", clef.ink && clef.width > 10 && clef.bottom > 10, [clef.width, clef.top, clef.bottom]);

const engrave = join(web, "out", "cli", "engrave.js");
if (existsSync(engrave)) {
  const E = await import(pathToFileURL(engrave).href);
  check("CLI 用的是原生量字", E.measure() === "native", E.measure());
  const s = new E.HeadlessSession(E.meta);
  const text = "X:1\nT:冒烟\nM:4/4\nL:1/4\nK:C\nC D E F | G A B c |]\nw: 一 二 三 四 五 六 七 八\n";
  s.load(new TextEncoder().encode(text), "smoke.abc");
  for (const view of ["expanded", "original", "staff", "mixed"]) {
    await s.setViewMode(view);
    const pages = s.pages();
    check(`无头排版 ${view}`, pages.length > 0 && pages[0].startsWith("<svg") && pages[0].includes("<text"), pages.map((p) => p.length));
  }
} else {
  console.log("（没有 out/cli/engrave.js，跳过无头排版）");
}

if (failed) {
  console.error(`${failed} 项不过`);
  process.exit(1);
}
console.log("全部通过");
