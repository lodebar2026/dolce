// 英文词拆音节：中英对照谱的英文歌词，一个词跨两三个音时多半不印连字符（青年诗歌 22《将一生奉献》
// `myself` `sparing` `thoroughly` `manner` 都是整词印在两个音底下），rec 读出来是一个单元、只占一个音。
// 歌词装配时知道这个词底下罩着几个空着的音（见 lyrics.ts::splitSpanningWords），这里只管按英文拼写规则切成那么多段。
//
// 切点按优先级取：① 词里小写接大写（`gaveYourself`，词距太窄 rec 连读了）；② 常见后缀（-self -ing -ly …）；
// ③ 元音组之间：中间一个辅音切在它前面（co|no），两个以上切在第一个后面（man|ner、ter|ni），th/sh/ch/ph/wh/ck/ng/gh 不拆开；
// 撇号连着的「's」跟前面（it's|worth）。每段都要有元音组；词尾辅音后的 e 不发音、不算元音组（sume、love 不拆）。
// 凑不够段数就返回 null，原样不动。

const SUFFIXES = ["selves", "self", "ness", "ment", "less", "ful", "ing", "ly"];
const DIGRAPHS = new Set(["th", "sh", "ch", "ph", "wh", "ck", "ng", "gh"]);

const isVowelAt = (w: string, i: number): boolean => {
  const c = w[i]!.toLowerCase();
  if ("aeiou".includes(c)) return true;
  // y：词首不算（you、your），前面是辅音时算（my、ry）
  return c === "y" && i > 0 && /[a-z]/i.test(w[i - 1]!) && !"aeiou".includes(w[i - 1]!.toLowerCase());
};

/** 元音组的 [起, 止) 下标；词尾「辅音 + e」的 e 不算（前面还有元音组时）。 */
function vowelGroups(w: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < w.length; i++) {
    if (!isVowelAt(w, i)) continue;
    let j = i + 1;
    while (j < w.length && isVowelAt(w, j)) j++;
    out.push([i, j]);
    i = j - 1;
  }
  const last = out[out.length - 1];
  if (out.length >= 2 && last && last[0] === w.length - 1 && w[last[0]]!.toLowerCase() === "e" && last[1] - last[0] === 1) out.pop();
  return out;
}

const hasVowel = (s: string): boolean => vowelGroups(s).length > 0;

/** 把一个词切成 `k` 段；切不出（段数不够、某段没元音）返回 null。首尾的标点挂在首段/末段上。 */
export function splitEnglishWord(token: string, k: number): string[] | null {
  if (k < 2) return null;
  const m = /^([^A-Za-z]*)([A-Za-z][A-Za-z'’]*[A-Za-z]|[A-Za-z])([^A-Za-z]*)$/.exec(token);
  if (!m) return null;
  const [, lead, w, tail] = m as unknown as [string, string, string, string];
  const cands: Array<{ at: number; pri: number }> = [];
  for (let i = 1; i < w.length; i++) if (/[a-z]/.test(w[i - 1]!) && /[A-Z]/.test(w[i]!)) cands.push({ at: i, pri: 0 });
  const lower = w.toLowerCase();
  for (const suf of SUFFIXES) {
    if (lower.length - suf.length >= 2 && lower.endsWith(suf)) { cands.push({ at: w.length - suf.length, pri: 1 }); break; }
  }
  const groups = vowelGroups(w);
  for (let g = 0; g + 1 < groups.length; g++) {
    const c0 = groups[g]![1], c1 = groups[g + 1]![0];
    const cl = w.slice(c0, c1);
    if (!cl.length) continue;
    const apo = cl.search(/['’]/);
    let at: number;
    if (apo >= 0) at = c0 + Math.min(cl.length, apo + 2);               // it's|worth
    else if (cl.length === 1) at = c0;                                   // co|no
    else at = c0 + (DIGRAPHS.has(cl.slice(0, 2).toLowerCase()) && cl.length > 2 ? 2 : DIGRAPHS.has(cl.toLowerCase()) ? 0 : 1); // man|ner、tho|rough
    cands.push({ at, pri: 2 });
  }
  cands.sort((a, b) => a.pri - b.pri || a.at - b.at);
  const cuts: number[] = [];
  for (const c of cands) {
    if (cuts.length === k - 1) break;
    if (c.at <= 0 || c.at >= w.length || cuts.includes(c.at)) continue;
    const trial = [...cuts, c.at].sort((a, b) => a - b);
    const parts = trial.map((at, i) => w.slice(i ? trial[i - 1] : 0, at)).concat(w.slice(trial[trial.length - 1]));
    if (parts.every(hasVowel)) cuts.splice(0, cuts.length, ...trial);
  }
  if (cuts.length !== k - 1) return null;
  const parts = cuts.map((at, i) => w.slice(i ? cuts[i - 1] : 0, at)).concat(w.slice(cuts[cuts.length - 1]));
  parts[0] = lead + parts[0];
  parts[parts.length - 1] += tail;
  return parts;
}
