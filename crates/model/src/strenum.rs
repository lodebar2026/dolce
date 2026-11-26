//! 字符串枚举：取值同 MusicXML token（`doc.ts` 的字符串字面量联合）。
//!
//! TS 读 XML 时多处直接 `as` 断言、不校验（`sign as Clef["sign"]`、`syl as Lyric["syllabic"]`），
//! 文件里写了什么就存什么。为了逐字忠实，这里每个枚举都带 `Other(String)` 兜底：认得的进具名变体，
//! 认不得的原样留着、原样写出。TS 类型（ts-rs）只出认得的那几个，与手写的联合互赋值。

/// `str_enum! { /// 文档  pub enum 名 { 变体 = "token", … } }`
#[macro_export]
macro_rules! str_enum {
    ($(#[$m:meta])* pub enum $name:ident { $($(#[$vm:meta])* $v:ident = $s:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash)]
        pub enum $name {
            $($(#[$vm])* $v,)+
            /// 认不得的 token，原样保留
            Other(String),
        }

        impl $name {
            pub fn as_str(&self) -> &str {
                match self {
                    $($name::$v => $s,)+
                    $name::Other(s) => s.as_str(),
                }
            }
            /// 任意字符串 → 枚举（认不得的进 `Other`）
            pub fn parse(s: &str) -> $name {
                match s {
                    $($s => $name::$v,)+
                    _ => $name::Other(s.to_owned()),
                }
            }
            /// 是认得的 token（TS 侧做了取值校验的地方用）
            pub fn known(s: &str) -> Option<$name> {
                match s {
                    $($s => Some($name::$v),)+
                    _ => None,
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = <std::borrow::Cow<'de, str> as serde::Deserialize>::deserialize(d)?;
                Ok($name::parse(&s))
            }
        }

        $crate::__str_enum_ts!($name { $($v = $s),+ });
    };
}

#[cfg(feature = "ts")]
#[doc(hidden)]
#[macro_export]
macro_rules! __str_enum_ts {
    ($name:ident { $($v:ident = $s:literal),+ }) => {
        const _: () = {
            /// ts-rs 的镜像：只列认得的 token（不单独导出，随引用它的类型一并写进 doc.gen.ts）
            #[derive(ts_rs::TS)]
            #[ts(export_to = "doc.gen.ts", rename = stringify!($name))]
            #[allow(dead_code)]
            enum Mirror { $(#[ts(rename = $s)] $v,)+ }

            impl ts_rs::TS for $name {
                type WithoutGenerics = $name;
                type OptionInnerType = $name;
                const IS_ENUM: bool = true;
                fn ident(cfg: &ts_rs::Config) -> String { <Mirror as ts_rs::TS>::ident(cfg) }
                fn name(cfg: &ts_rs::Config) -> String { <Mirror as ts_rs::TS>::name(cfg) }
                fn inline(cfg: &ts_rs::Config) -> String { <Mirror as ts_rs::TS>::inline(cfg) }
                fn decl(cfg: &ts_rs::Config) -> String { <Mirror as ts_rs::TS>::decl(cfg) }
                fn decl_concrete(cfg: &ts_rs::Config) -> String { <Mirror as ts_rs::TS>::decl_concrete(cfg) }
                fn output_path() -> Option<std::path::PathBuf> { <Mirror as ts_rs::TS>::output_path() }
            }
        };
    };
}

#[cfg(not(feature = "ts"))]
#[doc(hidden)]
#[macro_export]
macro_rules! __str_enum_ts {
    ($($t:tt)*) => {};
}
