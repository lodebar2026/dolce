// 文本谱的两种方言与自动嗅探：方言表与嗅探判据在 Rust（crates/model/src/formats/fanqie/dialect.rs），这里是门面。
//
// - tomato：番茄简谱脚本 v1.0
// - shige ：诗歌本文本谱，番茄的变种
//
// 两家在**同一个字符上给了不同含义**（高低音、升降还原、数字 9、节奏音符），所以解析器必须先定方言再动手；
// 靠扩展名分不开（两家都可能是 .txt），但头部字段互不兼容，够判。

import type { Accidental } from "../jianpu/ast";
import type { ModelMsg } from "../model/msg";
import { dolce } from "../common/dolce";

export type Dialect = "tomato" | "shige";

/** 方言表里编辑器要用的那几样（写出端要的头部、曲行写法只在 Rust 那边） */
export interface DialectSpec {
  id: Dialect;
  /** 完整显示名（诊断信息里用） */
  name: string;
  /** 短显示名（工具栏/状态栏的「文本谱·X」里用） */
  shortName: string;
  /** 升高一个八度的字符 */
  octaveUp: string;
  /** 降低一个八度的字符 */
  octaveDown: string;
  /** 变音记号字符 → 语义（均写在数字**后方**） */
  accidentals: Readonly<Record<string, Accidental>>;
  /** 节奏音符的写法 */
  rhythmToken: string;
  /** 数字 9 是不是节奏音符（番茄）——否则是隐藏休止（有谱） */
  nineIsRhythm: boolean;
  /** 歌词里表示「跳过一个音符」的字符；**第一个是写出去时用的那个**，其余只认不写 */
  lyricSkip: readonly string[];
  /** 歌词里分隔两个音节的字符（番茄用 `/`，诗歌本用空格） */
  wordSeparator: string;
  /** 并字连接号：把本字并到前一个音节。没有这种写法为 null */
  joinToken: string | null;
}

const specs = new Map<Dialect, DialectSpec>();

export function dialectSpec(d: Dialect): DialectSpec {
  let s = specs.get(d);
  if (!s) {
    s = JSON.parse(dolce().fanqieDialectSpec(d)) as DialectSpec;
    specs.set(d, s);
  }
  return s;
}

export interface SniffResult {
  dialect: Dialect | null;
  /** 判据说明，认不出时用于报错 */
  reason: ModelMsg;
}

/**
 * 按头部字段判方言。看不出（既没有任一方独有字段、也没有 Q:/C: 行）就返回 null，
 * 由调用方报错——`.txt` 扩展名太泛，宁可不认也别硬解成一首乱谱。
 */
export function sniffDialect(text: string): SniffResult {
  return JSON.parse(dolce().fanqieSniff(text)) as SniffResult;
}
