//! 阶段产物的落盘缓存：识别拆成一串阶段，回归时从第一个变了的阶段接着跑。
//!
//! 一个阶段的键 = 阶段名 + **代码指纹** + 各输入的**内容指纹**。产物落盘时连同它自己的内容指纹一起记下，
//! 下游的键用的是上游产物的内容指纹而不是上游的键——上游代码改了但这一页的产物没变，下游照样命中（提前截断）。
//!
//! 命中时不读产物本体：[`Artifact`] 只带着指纹，谁真要用（`get`）才从盘上解出来。下游全命中的话，上游的大块数据
//! （整页位图、连通块表）根本不进内存。
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};
use std::cell::OnceCell;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// 内容指纹（SHA-256）。
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Fingerprint([u8; 32]);

impl Fingerprint {
    pub fn of(bytes: &[u8]) -> Self {
        Fingerprint(Sha256::digest(bytes).into())
    }

    /// 几样东西合成一个指纹（各段带长度前缀，拼接处不会串）。
    pub fn combine<'a>(parts: impl IntoIterator<Item = &'a [u8]>) -> Self {
        let mut h = Sha256::new();
        for p in parts {
            h.update((p.len() as u64).to_le_bytes());
            h.update(p);
        }
        Fingerprint(h.finalize().into())
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn hex(&self) -> String {
        self.0.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn from_hex(s: &str) -> Option<Self> {
        let s = s.trim();
        if s.len() != 64 {
            return None;
        }
        let mut out = [0u8; 32];
        for (i, o) in out.iter_mut().enumerate() {
            *o = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
        }
        Some(Fingerprint(out))
    }
}

impl fmt::Debug for Fingerprint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", &self.hex()[..12])
    }
}

/// 一个阶段：名字 + 代码指纹（阶段自己与它调用到的模块的源码哈希，由各 crate 的构建脚本给）。
#[derive(Clone, Copy, Debug)]
pub struct StageId {
    pub name: &'static str,
    pub code: &'static str,
}

/// 阶段产物：内容指纹 + 值（命中缓存时值留在盘上，用到才解）。
pub struct Artifact<T> {
    fp: Fingerprint,
    value: OnceCell<T>,
    path: Option<PathBuf>,
}

impl<T: Serialize + DeserializeOwned> Artifact<T> {
    /// 不经缓存的产物（最上游的输入：底本文件字节、选项）。
    pub fn fresh(value: T) -> Self {
        let bytes = bincode::serialize(&value).expect("阶段产物序列化");
        Artifact { fp: Fingerprint::of(&bytes), value: OnceCell::from(value), path: None }
    }

    pub fn fingerprint(&self) -> Fingerprint {
        self.fp
    }

    /// 取值；命中缓存的这时才从盘上读。
    pub fn get(&self) -> &T {
        self.value.get_or_init(|| {
            let path = self.path.as_ref().expect("没有值的产物必有落盘路径");
            let bytes = fs::read(path).unwrap_or_else(|e| panic!("读阶段缓存 {}: {e}", path.display()));
            bincode::deserialize(&bytes).unwrap_or_else(|e| panic!("解阶段缓存 {}: {e}", path.display()))
        })
    }

    pub fn into_inner(self) -> T {
        self.get();
        self.value.into_inner().expect("get 之后必有值")
    }
}

/// 一次阶段执行的去向（回归报告「从哪个阶段起重跑的」用）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Hit,
    Ran,
}

/// 阶段缓存。`root` 为空就是不缓存（在线识别、现跑）。
#[derive(Clone, Debug, Default)]
pub struct StageStore {
    root: Option<PathBuf>,
}

impl StageStore {
    pub fn disabled() -> Self {
        StageStore { root: None }
    }

    pub fn at(root: impl Into<PathBuf>) -> Self {
        StageStore { root: Some(root.into()) }
    }

    fn paths(&self, stage: &StageId, key: &Fingerprint) -> Option<(PathBuf, PathBuf)> {
        let hex = key.hex();
        let dir = self.root.as_ref()?.join(stage.name).join(&hex[..2]);
        Some((dir.join(format!("{hex}.bin")), dir.join(format!("{hex}.fp"))))
    }

    /// 跑一个阶段：键命中就回盘上那份的指纹（不读本体），否则执行 `f`、落盘。
    pub fn run<T: Serialize + DeserializeOwned>(&self, stage: &StageId, inputs: &[Fingerprint], f: impl FnOnce() -> T) -> (Artifact<T>, Outcome) {
        let key = Fingerprint::combine([stage.name.as_bytes(), stage.code.as_bytes()].into_iter().chain(inputs.iter().map(|i| i.as_bytes())));
        let paths = self.paths(stage, &key);
        if let Some((bin, fpf)) = &paths {
            if bin.exists() {
                if let Some(fp) = fs::read_to_string(fpf).ok().and_then(|s| Fingerprint::from_hex(&s)) {
                    return (Artifact { fp, value: OnceCell::new(), path: Some(bin.clone()) }, Outcome::Hit);
                }
            }
        }
        let value = f();
        let bytes = bincode::serialize(&value).expect("阶段产物序列化");
        let fp = Fingerprint::of(&bytes);
        let mut path = None;
        if let Some((bin, fpf)) = paths {
            // 写不进缓存不算错（只读盘、并发清理）：这一次照常交结果
            if write_atomic(&bin, &bytes).and_then(|_| write_atomic(&fpf, fp.hex().as_bytes())).is_ok() {
                path = Some(bin);
            }
        }
        (Artifact { fp, value: OnceCell::from(value), path }, Outcome::Ran)
    }
}

/// 先写临时文件再改名：并行跑的几个进程写同一个键时，读的人不会读到半截。
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dolce-stage-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn hit_skips_run_and_loads_lazily() {
        let root = tmp("hit");
        let store = StageStore::at(&root);
        let st = StageId { name: "double", code: "v1" };
        let input = Artifact::fresh(vec![1u32, 2, 3]);
        let runs = Cell::new(0);
        let go = || {
            store.run(&st, &[input.fingerprint()], || {
                runs.set(runs.get() + 1);
                input.get().iter().map(|x| x * 2).collect::<Vec<u32>>()
            })
        };
        let (a, o1) = go();
        let (b, o2) = go();
        assert_eq!((o1, o2, runs.get()), (Outcome::Ran, Outcome::Hit, 1));
        assert_eq!(a.fingerprint(), b.fingerprint());
        assert_eq!(b.get(), &vec![2, 4, 6]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn code_change_reruns_but_same_output_keeps_downstream() {
        let root = tmp("cutoff");
        let store = StageStore::at(&root);
        let input = Artifact::fresh(5u32);
        let up = |code: &'static str| store.run(&StageId { name: "up", code }, &[input.fingerprint()], || *input.get() + 1);
        let down_runs = Cell::new(0);
        let down = |a: &Artifact<u32>| {
            store.run(&StageId { name: "down", code: "v1" }, &[a.fingerprint()], || {
                down_runs.set(down_runs.get() + 1);
                *a.get() * 10
            })
        };
        let (a1, _) = up("v1");
        let (d1, _) = down(&a1);
        // 上游代码变了：重跑；产物没变：下游命中
        let (a2, o) = up("v2");
        assert_eq!(o, Outcome::Ran);
        let (d2, o) = down(&a2);
        assert_eq!((o, down_runs.get()), (Outcome::Hit, 1));
        assert_eq!((*d1.get(), *d2.get()), (60, 60));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn disabled_store_always_runs() {
        let store = StageStore::disabled();
        let st = StageId { name: "x", code: "v1" };
        let (a, o1) = store.run(&st, &[], || 1u8);
        let (_, o2) = store.run(&st, &[], || 1u8);
        assert_eq!((o1, o2, *a.get()), (Outcome::Ran, Outcome::Ran, 1));
    }
}
