// L6 成书：书级元数据（bookmeta.ts）与书籍样式统计（stats.ts）迁 Rust 的 TS 参考导出（dev `book-meta-rs-diff.mjs`）。
// 一档用例 = 输入引用（页号、选项）+ TS 现算的期望；Rust 那份在 `crates/dolce-cli/src/bookmeta.rs`（`dolce book-meta-check`），
// 键与形两边同一口径。只导出、不改行为；只给对拍用，成书迁完随 TS 一起删。
import type { PageSpec, TextRun } from "../pdflayout/spec";
import type { BookProfile } from "../pdflayout/bookprofile";
import type { FontRef, StyleRole } from "../style/sheet";
import { noteHeightOf } from "../pdflayout/inventory";
import {
  buildBookMeta,
  clusterRuleFrames,
  edgeMask,
  extractOrnamentTiles,
  groupBoxRows,
  isIndexPage,
  isTocPage,
  parseIndexLine,
  parseKeyMeter,
  regroupBoxLines,
  runText,
  scoreAnnotationGroups,
  type CharOverride,
} from "../pdflayout/bookmeta";
import { collectMetricSamples, collectRoleSamples, inferBookStyle, inferTocRule } from "../pdflayout/stats";
import { printBookSs } from "../style/bookss";

export interface BookMetaRefInput {
  profile: BookProfile;
  pages: PageSpec[];
  classHeights?: Record<string, number[]>;
  override: CharOverride;
  fonts: Record<string, FontRef>;
  inkRatio: (role: StyleRole, sample: string) => number;
  id?: string;
  fromPage: number;
  toPage: number;
}

export interface BookMetaRefCase {
  kind: string;
  key: string;
  [k: string]: unknown;
}

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** 一页上所有的文字行（页眉、页脚、正文行、曲目各带、花边框正文），顺序与 Rust 侧同口径 */
export function pageRuns(spec: PageSpec): TextRun[] {
  const out: (TextRun | null)[] = [spec.header, spec.footer, ...spec.textLines];
  for (const s of spec.songs) {
    out.push(s.numberRun, s.titleRun, s.keyMeterRun, s.categoryRun, ...s.creditRuns);
    for (const y of s.systems) out.push(...y.chordLines, ...y.lyricLines);
  }
  for (const b of spec.storyBoxes) out.push(...b.lines);
  return out.filter((r): r is TextRun => !!r);
}

/** 逐页的中间结果：逐行文本、调号拍号、目录/索引判定、线框、注解分组、花边框正文与纹样、索引行 */
function pageCase(spec: PageSpec, ov: CharOverride, noteH: number): unknown {
  const runs = pageRuns(spec);
  const ruleFrames = clusterRuleFrames(spec.frames);
  const isIndex = isIndexPage(spec, ov);
  return {
    texts: runs.map((r) => runText(r, ov)),
    textsRaw: runs.map((r) => runText(r)),
    keyMeters: spec.songs.map((s) => parseKeyMeter(s, spec.page, ov)),
    keyMetersRaw: spec.songs.map((s) => parseKeyMeter(s, spec.page)),
    isToc: isTocPage(spec, ov),
    isIndex,
    ruleFrames,
    annGroups: scoreAnnotationGroups(spec, ruleFrames, ov).map((g) => ({
      frame: g.frame,
      lines: regroupBoxLines(g.lines, ov),
      rows: groupBoxRows(g.lines).map((r) => r.map((c) => [c.x, c.ch])),
    })),
    stories: spec.storyBoxes.map((b) => {
      const tiles = extractOrnamentTiles(spec, b.box, noteH);
      return { lines: regroupBoxLines(b.lines, ov), linesRaw: regroupBoxLines(b.lines), tiles, edges: edgeMask(tiles) };
    }),
    indexLines: isIndex ? spec.textLines.map((l) => parseIndexLine(runText(l, ov).trim())) : null,
  };
}

/** 现算全部用例（期望一律转成纯 JSON） */
export function bookMetaCases(inp: BookMetaRefInput): BookMetaRefCase[] {
  const { pages, override: ov } = inp;
  const noteH = noteHeightOf(inp.profile);
  const cases: BookMetaRefCase[] = [];
  const emit = (kind: string, key: string, input: Record<string, unknown>, fn: () => unknown) => {
    const c: BookMetaRefCase = { kind, key, ...input };
    try {
      c.expect = plain(fn());
    } catch (e) {
      c.error = e instanceof Error ? e.message : String(e);
    }
    cases.push(c);
  };
  emit("noteHeightOf", "noteHeightOf", {}, () => noteH);
  for (const spec of pages) emit("page", `p${spec.page}`, { page: spec.page, noteH }, () => pageCase(spec, ov, noteH));
  for (const t of [
    "一百只羊有九十九156丰盛慈爱已进来291",
    "5画 一百只羊有九十九156A丰盛慈爱291",
    "首数首数12 万有之主 3 D",
    "AB12 1234 C",
  ])
    emit("indexLine", t, { text: t }, () => parseIndexLine(t));
  emit("bookMeta", "buildBookMeta（带覆盖）", { ov: true, noteH }, () => buildBookMeta(pages, { override: ov, noteH }));
  emit("bookMeta", "buildBookMeta（不带覆盖、缺省音符字号）", { ov: false }, () => buildBookMeta(pages));
  const ranges: [number, number][] = [[inp.fromPage, inp.toPage], [1, 100000]];
  for (const [from, to] of ranges) {
    const opt = { fromPage: from, toPage: to };
    emit("roleSamples", `collectRoleSamples ${from}–${to}`, opt, () => collectRoleSamples(pages, opt));
    emit("metricSamples", `collectMetricSamples ${from}–${to}`, opt, () => collectMetricSamples(pages, opt));
  }
  emit("tocRule", "inferTocRule", {}, () => inferTocRule(pages));
  for (const [from, to] of ranges) {
    const opt = { fromPage: from, toPage: to };
    emit("bookStyle", `inferBookStyle ${from}–${to}`, { ...opt, id: inp.id ?? null, fonts: inp.fonts }, () => {
      const { style, report } = inferBookStyle(inp.profile, pages, inp.fonts, {
        inkRatio: inp.inkRatio,
        id: inp.id,
        classHeights: inp.classHeights,
        fromPage: from,
        toPage: to,
      });
      return { style, report, ss: printBookSs(style) };
    });
  }
  return cases;
}
