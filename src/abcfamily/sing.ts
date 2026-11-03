// 逐遍演唱顺序（123 `%%sing`，格式见 docs/格式/123格式.md §6.3）：一行一遍（投影一页），`/` 换行，每项是一个段落名配第几段词。
//
//   %%sing A / B@2
//   %%sing [rows=5] C D / A@3
//
// 段落就是曲内 `[P:x]` 标记切出来的那些（同 `P:`），切点写在谱面上；`@段` 是这一段的第几条 `w:`，缺省 1。读成 `Song.singOrder`，写出端反过来。

import type { SingPass, Song } from "../model/doc";

const ITEM = /^([^@\s/[\]]+)(?:@(\d+))?$/;
const OPTS = /^\[([^\]]*)\]\s*/;

/** 一行 `%%sing` 的正文 → 一遍。写错的项、参数报给 `bad` 并跳过；一项都没有返回 null */
export function parseSing(body: string, bad: (v: string) => void): SingPass | null {
  let rest = body.trim();
  const page: SingPass = { items: [] };
  const opts = OPTS.exec(rest);
  if (opts) {
    rest = rest.slice(opts[0].length);
    for (const kv of opts[1]!.split(/[\s,]+/).filter(Boolean)) {
      const m = /^(\w+)=(\d+)$/.exec(kv);
      if (m && m[1] === "rows" && Number(m[2]) > 0) page.rows = Number(m[2]);
      else bad(kv);
    }
  }
  for (const tok of rest.split(/(\/)|\s+/).filter((t) => t)) {
    if (tok === "/") {
      const last = page.items[page.items.length - 1];
      if (last) last.lineAfter = true;
      continue;
    }
    const m = ITEM.exec(tok);
    if (!m || (m[2] !== undefined && Number(m[2]) < 1)) {
      bad(tok);
      continue;
    }
    page.items.push({ section: m[1]!, ...(m[2] && m[2] !== "1" ? { verse: Number(m[2]) } : {}) });
  }
  const last = page.items[page.items.length - 1];
  if (!last) return null;
  delete last.lineAfter;
  return page;
}

/** `Song.singOrder` → `%%sing` 行 */
export function singLines(song: Song): string[] {
  return (song.singOrder ?? []).map((pg) => {
    const toks = pg.rows ? [`[rows=${pg.rows}]`] : [];
    pg.items.forEach((it, i) => {
      toks.push(`${it.section}${(it.verse ?? 1) !== 1 ? `@${it.verse}` : ""}`);
      if (it.lineAfter && i < pg.items.length - 1) toks.push("/");
    });
    return `%%sing ${toks.join(" ")}`;
  });
}
