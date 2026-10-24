// 「123 格式」帮助页的英文说明，与 help123.ts 一一对应（示例顺序相同；示例源码共用，只译说明）。
// 改 help123.ts 的说明时同步改这里。

export const INTRO_123_EN =
  "**123** is this project's **main jianpu format**: it keeps ABC notation's header fields (`X:` `T:` `K:` `M:` `w:` …) and structure, " +
  "with jianpu digits in the music body. It's plain UTF-8 text, easy to write by hand, and can carry scores converted from MusicXML, ABC, " +
  "text jianpu or image recognition without loss. The file extension is `.123`. Common notation comes first below, each with a live-rendered example.";

export const GLOSSARY_123_EN: [string, string][] = [
  ["Field", "A line such as `K:1=G`; the part before the colon is the field name. Chinese names and full-width colons work too: `调：1=G`, `标题：奇异恩典`."],
  ["Music body", "Lines that aren't fields: notes, barlines, slurs and marks. Spaces are only for readability and don't affect the score."],
  ["Lyric slot", "When lyrics are aligned syllable by syllable, each note takes one slot; visible rests `0` and grace notes don't."],
  ["`$` and `$$`", "`$` is a line break on the score and `$$` a page break; a music line is followed by its lyric lines."],
  ["`%` comments", "From `%` at the start of a line to its end is a comment and doesn't appear on the score."],
];

export const EXAMPLES_123_TEXT_EN: { title: string; body: string[] }[] = [
  {
    title: "File header",
    body: [
      "A file starts with fields: `X:` number, `T:` title (a second `T:` is the subtitle), `C:` credits (may repeat), `K:` key, `M:` time signature, `Q:` tempo.",
      "Write the key as movable do, `K:1=G` (ABC's `K:G` also works); `Q:1/4=76` means 76 beats per minute, used by playback and MIDI export.",
      "Footers are `I:bottomleft` `I:bottomcenter` `I:bottomright`.",
      "The example below renders the header layout of a title page.",
    ],
  },
  {
    title: "Notes and rests",
    body: [
      "**1–7** are the scale degrees (do re mi fa so la ti) and **0** is a rest.",
      "`x` is an **invisible rest**: it takes time but isn't drawn — use it when an empty beat needs a lyric.",
    ],
  },
  {
    title: "Octaves",
    body: ["Write `'` after a digit to raise it an octave and `,` to lower it; they stack: `1''` is two octaves up."],
  },
  {
    title: "Sharps, flats and naturals",
    body: ["Write `#` **before** a digit to raise it a semitone, `b` to lower it and `n` for a natural: `#4` is fa sharp, `b7` ti flat."],
  },
  {
    title: "Duration: underlines",
    body: [
      "`_` after a digit halves it: one is an eighth note, two (`__`) a sixteenth.",
      "**Beams are grouped by beat automatically**; spaces are only for readability — `1_2_` and `1_ 2_` look the same.",
    ],
  },
  {
    title: "Duration: dots and dashes",
    body: [
      "`.` is a dot, adding half the value — often paired with an underline as `5. 6_`.",
      "`-` is an extension dash adding one beat each: `5 -` is a half note and `1 - - -` a whole note.",
    ],
  },
  {
    title: "Barlines and repeats",
    body: [
      "`|` barline, `||` double barline, `|]` final barline; `|:` and `:|` enclose the measures to repeat.",
      "To change the time signature mid-piece, write an inline field such as `[M:3/4]`.",
    ],
  },
  {
    title: "First and second endings",
    body: [
      "`[1` marks the first-time ending and `[2` the second (as in ABC). Multiple passes are written `[1,3` or `[1-3`. The As-printed view draws volta brackets; the Expanded view unrolls each pass instead.",
      "Note that `|1` is also a first ending in ABC, so leave a space when a digit follows a barline: `| 1`.",
    ],
  },
  {
    title: "Slurs and ties",
    body: [
      "Notes inside parentheses `( … )` are joined by an arc: a **slur** across different pitches, a **tie** across the same pitch. They can nest.",
      "`~` after a note means one arc **between it and the next note**, without brackets: `2~ 3` equals `(2 3)` and can reach out of a triplet.",
    ],
  },
  {
    title: "Triplets and tuplets",
    body: [
      "`(3: … )` is a triplet; write the notes with their printed durations, and **the `)` is required**: `(3: 1_ 2_ 3_ )` is an eighth-note triplet filling one beat.",
      "Write other tuplets as `(N:`; for a non-default ratio write `(n:p:`, read as “n notes in the time of p”.",
    ],
  },
  {
    title: "Lyrics",
    body: [
      "**One lyric line per music line**: lyrics go in a `w:` line and align from the first note of the music line right above; Chinese characters can be written together, one per note.",
      "`$` ends a music line (and breaks the line on the score); a second `w:` under the same music line is the second verse.",
      "`_` extends the previous syllable to this note (a melisma) and `/` leaves the note without a syllable; punctuation joins the previous syllable and takes no slot.",
    ],
  },
  {
    title: "More lyrics: verse numbers, continuation, several characters per note",
    body: [
      "`<1.>` at the start of a verse marks the printed verse number; it takes no note slot (printed at the line start for multiple verses).",
      "A long verse can be split: continue the previous line with `+:`.",
      "To fit several characters under one note, wrap them in `{}`: `{主耶}稣`. If a verse has no words on a line, write an empty `w:` to keep its place.",
    ],
  },
  {
    title: "Chords, annotations and marks",
    body: [
      "Write a chord name **before** its note, separated by a space: `F 1 3`. Quote non-standard names: `\"N.C.\"`.",
      "Annotations go in quotes with a position prefix: `\"^rit.\"` above, `\"_…\"` below. Several in a row before one note (`\"^欢快\"\"^pizz\"1`) print on separate lines, the first on top.",
      "Note marks go in `!…!` before the note, in several spellings: `!fermata!`, `!延长!` and `!yc!` are all fermatas; `!>!` and `!accent!` are accents. Dynamics: `!p!` `!mf!` `!f!`.",
    ],
  },
  {
    title: "Grace notes",
    body: ["Grace notes go in braces before the main note and take no time: `{2_}` is a sixteenth grace note, `{2}` an eighth."],
  },
  {
    title: "Line and page breaks",
    body: [
      "`$` is a line break on the score and `$$` a page break; ordinary line breaks in the code don't affect the score. If the original line ends without a barline, put `$` right after that note.",
      "`I:linebreak <none>` ignores `$` and leaves line breaking to “By phrase”.",
    ],
  },
  {
    title: "Multiple voices",
    body: [
      "`V:1` `V:2` … separate voices; writing `V:n` again continues that voice, so you can interleave them line by line, each voice followed by its own lyrics.",
      "In four-part music, men's parts written an octave up get `V:3 clef=treble-8` where the voice first appears; playback and staff notation then sound and show the actual octave.",
      "Piano grand staff: one `V:` per staff; the left hand is `V:2 clef=bass part=1` (`part=` names the voice it belongs to), plus `I:score {1 2}` for the brace. Staff, mixed view and playback treat them as one part with two staves.",
    ],
  },
  {
    title: "Chords of notes",
    body: [
      "Notes sounding together with the same duration go in square brackets, **with no space after** `[`: `[13]` (like ABC's `[CEG]`). Jianpu stacks them vertically; staff notation draws a chord.",
      "The duration follows `]` and is shared: `[13]_`, `[5,1]__`, `[13] -`; each note carries its own accidental and octave marks: `[#46']`.",
      "Arcs over the whole chord work as for single notes: `[13]~ [13]`, `([13] [24])`. To tie just one note, put `~` right after it: `[1~5] [15]` ties only the 1 (a tie on the lowest note is drawn below). `!arpeggio!` is an arpeggio.",
      "`[1 …` (followed by a space) is still a first ending; brackets hold no rest `0` and no per-note durations — `[03]` or `[13_]` is reported as an error.",
    ],
  },
  {
    title: "Second voice in a measure: &",
    body: [
      "Two independent rhythms on one staff (flute 1 and 2, two percussion instruments) use ABC's `&`: it rewinds to the start of the measure, and what follows is the second voice. Jianpu prints the two side by side, one above the other, aligned by beat; staff notation draws two voices.",
      "`&` lasts until the barline — write it again in each measure that needs it; both parts must have equal length, so fill gaps with invisible rests `x`.",
      "Slurs and `~` stay with their own part and can continue across the barline into the same part of the next measure; lyrics follow the first voice.",
    ],
  },
  {
    title: "Marks for instrumental parts",
    body: [
      "Bowing `!downbow!` `!upbow!`; single-note tremolo `!/!` `!//!` `!///!` (one slash per stroke); rehearsal mark `!rehearsal=A!`, or `!rehearsal=【A】!` when the score prints lenticular brackets. All go before the note.",
      "`Z4` is a four-measure multi-rest (as in ABC), written as a measure of its own; jianpu prints it as ├─4─┤, staff notation as an H-bar.",
      "Change clef mid-piece with the inline field `[K:clef=bass]` — clef only, the key stays; staff notation follows it.",
    ],
  },
  {
    title: "Rhythm notes (percussion)",
    body: [
      "Capital `X` is a **rhythm note**: sounded but unpitched, with durations written as for digits (lowercase `x` is an invisible rest).",
      "`X@E5` sets where it sits on the staff; several struck together are `[X@E5X@F5]`, stacked in jianpu. Without a position, staff notation draws a slash notehead.",
      "To give a pitched note an x or circle-x notehead write `!head-x!` `!head-circle-x!`; jianpu prints it as `X`.",
    ],
  },
  {
    title: "Singing order",
    body: [
      "Printed `|: :|` and endings are just marks, and the default singing order follows them; for precise control use ABC's `P:` (e.g. `P:A2B`) or the extension `I:playorder`.",
      "Each `I:playorder` entry is a measure range plus a verse number; `page` turns the page after that pass. Endpoints can point at notes (`11.2` = the 2nd note of measure 11).",
    ],
  },
];
