// jianpu-ly 的 `chords=` 行：LilyPond 和弦语法 ↔ 谱上印的文字。
// 两个方向都用同一张表（读写对称），表外的后缀**保留原文**但写出时会报出来。
//
// 上游怎么用这行：它原样塞进 `\new ChordNames { \chordmode { … } }`，所以 token 就是 LilyPond 和弦语法：
//   `<音名><时值?><:修饰?>?`（时值按 LilyPond 的"没写就沿用上一个"，第一个默认四分）。
// 它自己从 MusicXML 生成这行时写的是 `root+xmlDuration(...)+suffix`，也就是 `c2.` `g:7` 这种形态 —— 写出端照它来。

/** 谱上印的修饰 → LilyPond 和弦修饰。左边是没有前导 `:` 的常见写法（大小写敏感：`M7` 是大七）。 */
const SUFFIX_TO_LY: ReadonlyArray<readonly [RegExp, string]> = [
  [/^maj7$/i, "maj7"], [/^M7$/, "maj7"], [/^m7$/i, "m7"], [/^min7$/i, "m7"], [/^m7b5$/i, "m7.5-"],
  [/^dim7$/i, "dim7"], [/^dim$/i, "dim"], [/^aug$/i, "aug"], [/^sus4$/i, "sus4"], [/^sus2$/i, "sus2"],
  [/^maj9$/i, "maj9"], [/^m9$/i, "m9"], [/^m6$/i, "m6"], [/^6$/i, "6"], [/^9$/i, "9"],
  [/^m$/i, "m"], [/^min$/i, "m"], [/^7$/i, "7"], [/^5$/i, "5"], [/^add9$/i, "9"],
  [/^(\d+)$/, "$1"],
];

/** LilyPond 和弦修饰 → 谱上印的写法。 */
const LY_TO_SUFFIX: ReadonlyArray<readonly [RegExp, string]> = [
  [/^maj7$/, "maj7"], [/^m7\.5-$/, "m7b5"], [/^m7$/, "m7"], [/^m6$/, "m6"], [/^m9$/, "m9"],
  [/^dim7$/, "dim7"], [/^dim$/, "dim"], [/^aug$/, "aug"], [/^sus4$/, "sus4"], [/^sus2$/, "sus2"],
  [/^maj9$/, "maj9"], [/^m$/, "m"], [/^7$/, "7"], [/^6$/, "6"], [/^9$/, "9"], [/^5$/, "5"],
];

/** LilyPond 音名（`c` `bes` `fis` `ceses`…）→ 谱上写法（`C` `B♭` `F♯`…，用 `#`/`b` 更通用）。
 *  ⚠ 变音后缀两套语言都要认，且**实测**过（真 LilyPond 逐个编译）：
 *    nederlands：`as` `aes` `ases` `s` `es` ✓；english：`bf` `bff` `af` `aff` ✓。
 *  所以 `s`/`f`/`es` 都是**降**（旧代码把 `s`/`f` 归进升号那一支 → 英文 `bf` 读成 B♯、荷兰语缩写也错；
 *  上游 review 指出的正是这里）。 */
export function lyPitchToText(ly: string): string | null {
  const m = /^([a-g])(isis|eses|ses|is|es|ff|ss|s|f)?$/i.exec(ly.trim());
  if (!m) return null;
  const step = m[1]!.toUpperCase();
  const mod = (m[2] ?? "").toLowerCase();
  const alter =
    mod === "isis" ? "##"
      : mod === "eses" || mod === "ses" || mod === "ff" ? "bb"
        : mod === "is" ? "#"
          : mod === "es" || mod === "s" || mod === "f" ? "b"
            : "";
  return step + alter;
}

/** 谱上写法（`C` `B♭` `F#`）→ LilyPond 音名（`c` `bes` `fis`）。认不出来返回 null。 */
export function textPitchToLy(text: string): string | null {
  const m = /^([A-Ga-g])([#♯b♭]|##|bb)?$/.exec(text.trim());
  if (!m) return null;
  const step = m[1]!.toLowerCase();
  const acc = m[2] ?? "";
  const alter = acc === "#" || acc === "♯" ? "is" : acc === "##" ? "isis" : acc === "b" || acc === "♭" ? "es" : acc === "bb" ? "eses" : "";
  return step + alter;
}

/** LilyPond 和弦后缀（`:m7` 这类，含前导冒号与否）→ 谱上印的写法。 */
export function lySuffixToText(suffix: string): string {
  const s = suffix.replace(/^:/, "");
  if (!s) return "";
  for (const [re, out] of LY_TO_SUFFIX) if (re.test(s)) return out;
  return s;                                     // 表外：原样印（如 `13`、`7.9+`）
}

/** 谱上印的后缀 → LilyPond 后缀（带前导冒号）。认不出来返回 null（写出端据此报警）。 */
export function textSuffixToLy(suffix: string): string | null {
  const s = suffix.trim();
  if (!s) return "";
  for (const [re, out] of SUFFIX_TO_LY) if (re.test(s)) return ":" + out;
  return null;
}

/** 把 `chords=` 行里的一个 token（`c2.:m7/bes`、`c4*31:m7`）拆成音名 / 时值 / 后缀 / 低音。
 *  ⚠ 时值单位是**全音符**（不是拍）：`c2.` = 1/2 + 1/4 = **0.75 全音符 = 3 拍**。
 *    2026-10-03 我自己一度把它读成"1.5 拍"、据此以为和弦落点算错了 —— 其实落点与那句
 *    "和弦行比曲子长"的损失都是对的（曲子 5 拍 = 1.25 全音符，和弦行 0.75×3 = 2.25 全音符，确实超）。
 *    量口径时先看这一行，别再按"拍"想。 */
export function parseChordToken(tok: string): { pitch: string; whole: number | null; suffix: string; bass: string | null } | null {
  const m = /^([a-g](?:isis|eses|is|es|s|f)?)(\d+(?:\.*)|)((?:\*\d+(?:\/\d+)?)?)((?::[^/]*)?)(?:\/([a-g](?:isis|eses|is|es|s|f)?))?$/i.exec(tok.trim());
  if (!m) return null;
  const dur = m[2] ?? "";
  let whole: number | null = null;
  if (dur) {
    const denom = Number(/(\d+)/.exec(dur)?.[1] ?? "0");
    if (denom) {
      const dots = (dur.match(/\./g) ?? []).length;
      whole = 1 / denom;
      let add = whole / 2;
      for (let i = 0; i < dots; i++) { whole += add; add /= 2; }
    }
  }
  const mult = m[3] ?? "";
  if (whole !== null && mult) {
    const mm = /^\*(\d+)(?:\/(\d+))?$/.exec(mult);
    if (mm) whole *= Number(mm[1]) / Number(mm[2] ?? "1");
  }
  return { pitch: m[1]!, whole, suffix: m[4] ?? "", bass: m[5] ?? null };
}

/** `chords=` 行里一个 token 的**谱上写法**（读入端与编辑端共用一套转换）。 */
export function chordTokenToText(tok: string): string | null {
  const p = parseChordToken(tok);
  if (!p) return null;
  const root = lyPitchToText(p.pitch);
  if (root === null) return null;
  const bass = p.bass ? lyPitchToText(p.bass) : null;
  return root + lySuffixToText(p.suffix) + (bass ? "/" + bass : "");
}

/** 整音符分数 → `{ LilyPond 时值串, 是否精确 }`。与上游 `xmlDuration` 同一套：分母 + 附点取最接近的，
 *  对不齐的时值上游也只是"近似 + 警告"，这里把"不精确"交给调用方去报。 */
export function wholeToDuration(whole: number): { text: string; exact: boolean } {
  let best: { err: number; text: string } | null = null;
  for (const denom of [1, 2, 4, 8, 16, 32, 64]) {
    let v = 1 / denom;
    let add = v;
    for (let dots = 0; dots < 4; dots++) {
      const text = String(denom) + ".".repeat(dots);
      const err = Math.abs(v - whole);
      if (err < 1e-9) return { text, exact: true };
      if (!best || err < best.err) best = { err, text };
      add /= 2;
      v += add;
    }
  }
  return { text: best ? best.text : "4", exact: false };
}

/** 谱上印的和弦文字 → `chords=` 的 token（`Am7/G` + 时值）。后缀认不出来时返回 null（调用方报警）。
 *
 *  时值：先用分母 + 附点写；写不精确时**试着配一个乘数**（LilyPond 的 `c4*31` —— 一个和弦压过好几个
 *  小节时只有这样才写得准）。⚠ 不配乘数就只能"近似"（上游 `xmlDuration` 的做法），而近似的时值会让
 *  这条时间线**越走越偏**：第二个和弦的落点就不再是它真正的拍位（实测：跨 2 小节的 `c1...` 只有 1.875，
 *  比 2 少 1/8 拍）。乘数配不上才退回近似。 */
export function harmonyToChordToken(text: string, whole: number): string | null {
  const m = /^([A-Ga-g](?:[#♯b♭]|##|bb)?)(.*?)(?:\/([A-Ga-g](?:[#♯b♭]|##|bb)?))?$/.exec(text.trim());
  if (!m) return null;
  const pitch = textPitchToLy(m[1]!);
  if (!pitch) return null;
  const suffix = textSuffixToLy(m[2] ?? "");
  if (suffix === null) return null;
  const bass = m[3] ? textPitchToLy(m[3]) : null;
  return pitch + durationText(whole) + suffix + (bass ? "/" + bass : "");
}

/** 时值串：精确写法；不精确就配乘数；再不行退回最接近的写法（与上游一样"近似"）。 */
export function durationText(whole: number): string {
  const exact = wholeToDuration(whole);
  if (exact.exact) return exact.text;
  for (const base of [1, 2, 4, 8, 16, 32, 64]) {
    for (let dots = 0; dots < 4; dots++) {
      const v = 1 / base + (1 / base) * (1 - 2 ** -dots);
      const k = whole / v;
      if (Math.abs(k - Math.round(k)) < 1e-6 && Math.round(k) >= 2 && Math.round(k) <= 64) {
        return String(base) + ".".repeat(dots) + "*" + Math.round(k);
      }
    }
  }
  return exact.text;
}

/** 一条 `chords=` 行的 **token 序列 + 各自的时间线**（整音符为单位）：读入端、写出端、编辑端共用。
 *  口径与上游一致：时值没写就沿用上一个，第一个默认四分；`base` 是本次没法解析的 token 数。 */
export function chordTimeline(
  tokens: readonly string[],
  fallbackWhole = 0.25,
): { text: string; whole: number | null; at: number }[] {
  const out: { text: string; whole: number | null; at: number }[] = [];
  let at = 0;
  let carried = fallbackWhole;
  for (const tok of tokens) {
    const p = parseChordToken(tok);
    const text = p ? chordTokenToText(tok) : null;
    const whole = p?.whole ?? null;
    if (text === null) continue;
    out.push({ text, whole, at });
    carried = whole ?? carried;
    at += carried;
  }
  return out;
}
