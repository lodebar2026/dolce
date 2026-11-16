// `.jpwabc` 的分节文件：分节、各节内容（`.Voice` 词法、`.Words` 歌词段、`.Title` 字段…）的解析在 Rust
// （crates/dolce-formats/src/jpw/file.rs），这里是门面——编辑器按节取行（`.Layout` 的断行描述、`.Voice` 各行挪 `$`、
// `.Words` 各段行号重算锚点），读谱整份交 `model/fromjpw.ts`（原文 `text` 跟着）。

import type { JpwTok, JpwToken } from "./lex";
import type { SourceSpan } from "../model/doc";
import { dolce } from "../common/dolce";

export abstract class Section {
  lines: string[] = [];
  /** `lines[i]` 在原文里的 0 基行号与行首偏移（跳过的注释与空行照算） */
  lineNos: number[] = [];
  lineOffsets: number[] = [];
  constructor(public name: string) {}
}

class GenericSection extends Section {}

export class LayoutSection extends Section {
  linesPerPage: string | null = null;
  breakPoints: string | null = null;

  get desc(): string | null {
    if (this.breakPoints !== null) return `BreakPoints = ${this.breakPoints}`;
    if (this.linesPerPage !== null) return `LinesPerPage = ${this.linesPerPage}`;
    return null;
  }
}

export class RepeatSection extends Section {
  data: string[] = [];
}

export class VoiceSection extends Section {
  voiceData: JpwToken[] = [];
}

export interface WordsItem {
  text: string;
  /** `[` 标的对齐位（没有为 -1） */
  alignPos: number;
  /** 这个字在原文里的位置：谱面上点一个字要选中它。`/` 占位的空项没有 */
  source?: SourceSpan;
}

export interface WordsSegment {
  passFirst: number;
  passLast: number;
  measure: number;
  noteIndex: number;
  control: string[] | null;
  data: WordsItem[];
}

export class WordsSection extends Section {
  segments: WordsSegment[] = [];
}

export class TitleSection extends Section {
  values = new Map<string, string>();

  get title(): string | null {
    return this.getValue("title");
  }
  get keyAndMeters(): string | null {
    return this.getValue("KeyAndMeters");
  }
  get wordsMusicBy(): string | null {
    return this.getValue("WordsByAndMusicBy");
  }
  /** 速度/表情记号原文（外层 `{}` 已剥）：纯文字（`热烈欢快地`）或速度（`♩=80`） */
  get expression(): string | null {
    return this.getValue("Expression");
  }
  getValue(key: string): string | null {
    return this.values.get(key.toLowerCase()) ?? null;
  }
}

type TokRow = [JpwTok, string, number, number, number, number];

/** Rust 分节结果的一节 */
interface SectionJson {
  name: string;
  lines: string[];
  lineNos: number[];
  lineOffsets: number[];
  body: {
    voice?: TokRow[];
    words?: Array<Omit<WordsSegment, "data"> & { data: Array<[string, number, SourceSpan | null]> }>;
    title?: Array<[string, string]>;
    layout?: [string | null, string | null];
    repeat?: string[];
  };
}


function sectionOf(j: SectionJson): Section {
  const b = j.body;
  let s: Section;
  if (b.voice) {
    const v = new VoiceSection(j.name);
    // 原文按偏移从 JS 那份取（`.Voice` 正文是各行以 `\n` 拼的）
    const body = j.lines.join("\n");
    v.voiceData = b.voice.map(([type, , start, end, line, column]) => ({ type, text: body.slice(start, end), start, end, line, column }));
    s = v;
  } else if (b.words) {
    const w = new WordsSection(j.name);
    w.segments = b.words.map((g) => ({
      ...g,
      data: g.data.map(([text, alignPos, source]) => (source ? { text, alignPos, source } : { text, alignPos })),
    }));
    s = w;
  } else if (b.title) {
    const t = new TitleSection(j.name);
    t.values = new Map(b.title);
    s = t;
  } else if (b.layout) {
    const l = new LayoutSection(j.name);
    [l.linesPerPage, l.breakPoints] = b.layout;
    s = l;
  } else if (b.repeat) {
    const r = new RepeatSection(j.name);
    r.data = b.repeat;
    s = r;
  } else s = new GenericSection(j.name);
  s.lines = j.lines;
  s.lineNos = j.lineNos;
  s.lineOffsets = j.lineOffsets;
  return s;
}

export class JpwFile {
  sections: Section[] = [];

  private constructor(
    /** 原文（读谱整份交 Rust） */
    readonly text: string,
  ) {}

  /** 分节解析；解析不了（正文在任何段落头之前、未知段名、`.Voice` 落单方括号等）给 null */
  static fromString(s: string): JpwFile | null {
    const json = JSON.parse(dolce().jpwFile(s)) as SectionJson[] | null;
    if (!json) return null;
    const f = new JpwFile(s);
    f.sections = json.map(sectionOf);
    return f;
  }

  getLyric(): WordsSection | null {
    return this.getSection(WordsSection);
  }
  getVoice(): VoiceSection | null {
    return this.getSection(VoiceSection);
  }
  getTitle(): TitleSection | null {
    return this.getSection(TitleSection);
  }
  getSection<T extends Section>(cls: new (...args: never[]) => T): T | null {
    return (this.sections.find((s) => s instanceof cls) as T) ?? null;
  }
}
