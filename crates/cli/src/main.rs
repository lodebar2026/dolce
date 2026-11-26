//! `dolce`：悦谱的命令行。给人用的：识谱出各格式（`omr`，[`cli`]；第一个参数是选项或已有的文件 / 目录时也按识谱，兼容旧写法）、
//! 格式转换与排版/MIDI 导出（`convert`，[`convert`]）、歌本切分（`split`）；
//! 开发用的：批量识别出 JSON（`run`，私有仓库的自检脚本用）、识别一个文件（`recognize`）、
//! 五线谱会话（`session`）、回归（`regress`）。
mod cli;
mod convert;
mod recognize;
mod regress;
mod run;
mod split;

use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "  dolce regress <jianpu|solo|chorus|vector|xinbian> [--only=子串] [--jobs=N] [--out=目录] [--ref=目录] [--web=目录] [--replay=目录] [--area=结构] [--judge-only] [--ocr-cache=文件]
      跑识别（各曲并行）→ 产物落盘到 --out → 调私有仓库判分（solo-ops / chorus-ops 的 --from）→ 与 --ref 的 TS 基线逐曲比
      缺省：--out=../dev/data/rust-omr/runs/<档>，--ref=../dev/data/rust-omr/ref-c7c02820，--web=../web（判分脚本与 out/cli 所在的检出）
      --replay：不识别，拷那个目录里同名的产物来判（拿 TS 归档自测回归流程）
      --area：只比这一档的步数（结构 / 音符 / 记号 / 歌词 / 文字 / 页眉）；--judge-only：产物不动，只重新判分对比
  dolce recognize jianpu 文件 [--render] [--out=文件]
      识别一个简谱文件，打出行数、音数、小节数与满拍率；--render：PDF 页先用 PDFium 渲染再走像素路（对照纯矢量页那条路）
  dolce recognize staff 文件 [--out=目录]
      识别一个五线谱文件，写出 <曲>.musicxml（带识别 id）与 <曲>.review.json（核对 JSON：各页谱行几何、系统、关联表、源框、可疑、候选）
  dolce session 五线谱文件 --ops=操作.jsonl [--out=目录]
      识别后开会话，逐条做操作（每行一条 JSON：rebuild / restructure / pin / unpin / choose / context，见 omr-staff::session::Op），
      每一步写出 <步>.musicxml、<步>.rec.json 与 <步>.review.json，报声部数、小节数与识别 id 比上一步留下 / 没了 / 新出的个数
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("regress") => match regress::run(&regress::Opts::parse(&args[1..])) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("✗ {e}");
                ExitCode::from(2)
            }
        },
        Some("session") => match recognize::session(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("✗ {e}");
                ExitCode::from(2)
            }
        },
        Some("recognize") => match recognize::one(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("✗ {e}");
                ExitCode::from(2)
            }
        },
        Some("run") => match run::run(&args[1..]) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("✗ {e}");
                ExitCode::from(2)
            }
        },
        Some("convert") => match convert::run(&args[1..]) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("✗ {e}");
                ExitCode::from(1)
            }
        },
        Some("split") => match split::run(&args[1..]) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("✗ {e}");
                ExitCode::from(1)
            }
        },
        None | Some("-h" | "--help" | "help") => {
            // 开发用的子命令只在仓库检出里列（分发包没有私有仓库，列了也跑不了）
            let dev = if checkout("crates/cli").is_dir() { format!("\n开发用：\n{}{USAGE}", run::USAGE) } else { String::new() };
            eprintln!("用法：\n{}{}{}{dev}", cli::usage(), convert::usage(), split::USAGE);
            ExitCode::from(if args.is_empty() { 2 } else { 0 })
        }
        Some("omr") => recognize_cli(&args[1..]),
        // 旧写法 `dolce 图片… -f 格式`：第一个参数是选项或已有的文件 / 目录就按识谱；别的词当拼错的子命令，不拿去当文件名
        Some(a) if a.starts_with('-') || std::path::Path::new(a).exists() => recognize_cli(&args),
        Some(a) => {
            eprintln!("✗ 未知子命令 {a}（dolce --help 看用法）");
            ExitCode::from(2)
        }
    }
}

fn recognize_cli(args: &[String]) -> ExitCode {
    match cli::run(args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("✗ {e}");
            ExitCode::from(1)
        }
    }
}

/// 本检出里的路径：编译时记下的本 crate 位置往上两级是 web 检出的根。
pub fn checkout(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(name)
}

/// 仓库同级目录：web 检出的父目录放着私有仓库 `dev/`。
pub fn sibling(name: &str) -> PathBuf {
    checkout("..").join(name)
}
