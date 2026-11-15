//! 与 TS 实现逐字相同要守的数值口径。移植的判据里凡是 `Math.round`、`| 0`、`Array.prototype.sort`
//! 都走这里，不直接用 Rust 的 `f64::round`（半数远离零）与 `as i32`（饱和）——两边在 x.5 的负数、越界值上不同。
//!
//! 数与字符串互转也照 ECMAScript：`String(n)`（[`num_to_string`]）、`n.toFixed(f)`（[`to_fixed`]）、
//! `Number(s)`（[`number`]）、`parseInt`（[`parse_int`]）、`parseFloat`（[`parse_float`]），
//! 正则 `\s` 的字符集（[`is_space`]）。Rust 的 `{}` / `{:.N}` / `str::parse` 在指数写法、x.5 进位、
//! `inf` / `nan` 这些字面上与 JS 不同，写出端与解析器一律走这里。
use std::cmp::Ordering;

/// `Math.round`：半数向正无穷（`-2.5 → -2`、`2.5 → 3`）。
#[inline]
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    // 不写 floor(x + 0.5)：0.49999999999999994 + 0.5 进位成 1
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// `x | 0`：ToInt32（向零截断，按 2^32 回绕；NaN、无穷为 0）。
#[inline]
pub fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let t = x.trunc();
    if t >= -2147483648.0 && t <= 2147483647.0 {
        return t as i32;
    }
    let m = t.rem_euclid(4294967296.0);
    (m as u64) as u32 as i32
}

/// `arr.sort((a, b) => cmp(a, b))`：稳定排序，比较函数回数值（负 / 零 / 正；NaN 当零）。
///
/// 自写归并而不用 `slice::sort_by`：比较函数不成全序时（判据里有按容差比的）标准库可能 panic。
/// 全序比较函数下结果与 V8 相同（都是稳定排序）；不成全序时结果依赖算法细节，移植到那种调用点要单独核对。
pub fn sort_by<T: Clone>(v: &mut [T], mut cmp: impl FnMut(&T, &T) -> f64) {
    let n = v.len();
    if n < 2 {
        return;
    }
    let mut buf: Vec<T> = v.to_vec();
    let mut width = 1;
    let mut src_is_v = true;
    while width < n {
        {
            let (src, dst): (&[T], &mut [T]) = if src_is_v { (&*v, &mut buf[..]) } else { (&buf[..], &mut *v) };
            let mut lo = 0;
            while lo < n {
                let mid = (lo + width).min(n);
                let hi = (lo + 2 * width).min(n);
                let (mut i, mut j, mut k) = (lo, mid, lo);
                while i < mid && j < hi {
                    // 右边严格小才先出，相等保左边在前
                    if cmp(&src[j], &src[i]) < 0.0 {
                        dst[k] = src[j].clone();
                        j += 1;
                    } else {
                        dst[k] = src[i].clone();
                        i += 1;
                    }
                    k += 1;
                }
                while i < mid {
                    dst[k] = src[i].clone();
                    i += 1;
                    k += 1;
                }
                while j < hi {
                    dst[k] = src[j].clone();
                    j += 1;
                    k += 1;
                }
                lo = hi;
            }
        }
        src_is_v = !src_is_v;
        width *= 2;
    }
    if !src_is_v {
        v.clone_from_slice(&buf);
    }
}

/// 数值升序（`(a, b) => a - b`）。
pub fn sort_num(v: &mut [f64]) {
    sort_by(v, |a, b| a - b);
}

/// 比较函数回值 → `Ordering`（给确知是全序的地方配 `sort_by` 用）。
#[inline]
pub fn ordering(d: f64) -> Ordering {
    if d < 0.0 {
        Ordering::Less
    } else if d > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// 正则 `\s` 与 `String.prototype.trim` 认的空白（WhiteSpace + LineTerminator）。
#[inline]
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `s.trim()`。
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// 有限正数的最短往返十进制：数字串（不含前导零）与 ECMAScript 的 `n`（值 = 0.digits × 10^n）。
fn shortest_digits(x: f64) -> (String, i32) {
    // Rust 的 `{:e}` 给最短往返的有效数字（与 JS 的 Number::toString 取同一组数字）
    let e = format!("{:e}", x);
    let (mant, exp) = e.split_once('e').expect("{:e} 必有 e");
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    (digits, exp.parse::<i32>().expect("指数") + 1)
}

/// `String(x)`：ECMAScript Number::toString（基数 10）。
pub fn num_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into(); // -0 也写 "0"
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x < 0.0 {
        return format!("-{}", num_to_string(-x));
    }
    let (d, n) = shortest_digits(x);
    let k = d.len() as i32;
    if k <= n && n <= 21 {
        let mut s = d;
        s.push_str(&"0".repeat((n - k) as usize));
        s
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &d[..n as usize], &d[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{}", "0".repeat((-n) as usize), d)
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{}e{}{}", d, sign, e.abs())
        } else {
            format!("{}.{}e{}{}", &d[..1], &d[1..], sign, e.abs())
        }
    }
}

/// 有限正数在二进制下的小数位数（`x · 2^k` 是整数的最小 k）；它的十进制精确展开正好 k 位小数。
fn frac_bits(x: f64) -> i32 {
    let bits = x.to_bits();
    let exp = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1u64 << 52) - 1);
    let (m, e) = if exp == 0 { (frac, -1074) } else { (frac | (1u64 << 52), exp - 1075) };
    if m == 0 {
        return 0;
    }
    let k = -(e + m.trailing_zeros() as i32);
    k.max(0)
}

/// 十进制数字串（可带一个 `.`）末位加一，进位照常（`"9.99"` → `"10.00"`）。
fn bump_last(s: &str) -> String {
    let mut b: Vec<u8> = s.bytes().collect();
    let mut i = b.len();
    loop {
        if i == 0 {
            b.insert(0, b'1');
            break;
        }
        i -= 1;
        match b[i] {
            b'.' => continue,
            b'9' => b[i] = b'0',
            c => {
                b[i] = c + 1;
                break;
            }
        }
    }
    String::from_utf8(b).expect("ASCII")
}

/// `x.toFixed(f)`（`f` 取 0..=100）：按精确值取整、恰在中间时取大的那个（量值上半数进位），
/// 不是 Rust `{:.f}` 的半数取偶；`|x| ≥ 1e21` 时同 `String(x)`。
pub fn to_fixed(x: f64, f: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.abs() >= 1e21 || x.is_infinite() {
        return num_to_string(x);
    }
    if x < 0.0 {
        return format!("-{}", to_fixed(-x, f));
    }
    let x = x.abs(); // -0 → 0（JS 的 (-0).toFixed(2) 是 "0.00"）
    // 恰在两个 f 位小数正中间：精确展开正好 f+1 位小数（末位必是 5）
    if frac_bits(x) == f as i32 + 1 {
        let exact = format!("{:.*}", f + 1, x);
        return bump_last(&exact[..exact.len() - 1]).trim_end_matches('.').to_string();
    }
    format!("{:.*}", f, x)
}

/// 十进制字面（可带正负号；`Infinity`；`1.`、`.5`、`1e5`）在 `s` 开头的最长前缀的字节长度。
fn decimal_prefix(s: &str) -> usize {
    let b = s.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    if s[i..].starts_with("Infinity") {
        return i + 8;
    }
    let digits = |i: &mut usize| {
        let st = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - st
    };
    let int = digits(&mut i);
    let mut frac = 0;
    if i < b.len() && b[i] == b'.' {
        let mut j = i + 1;
        frac = digits(&mut j);
        if int > 0 || frac > 0 {
            i = j;
        }
    }
    if int == 0 && frac == 0 {
        return 0;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        if digits(&mut j) > 0 {
            i = j;
        }
    }
    i
}

/// 已知合乎十进制字面的串 → 值（正确舍入）。
fn parse_decimal(s: &str) -> f64 {
    let (neg, body) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let v = if body == "Infinity" { f64::INFINITY } else { body.parse::<f64>().unwrap_or(f64::NAN) };
    if neg {
        -v
    } else {
        v
    }
}

/// 某进制的数字串 → 值（逐位累乘；十进制走正确舍入的解析）。
fn radix_value(digits: &str, radix: u32) -> f64 {
    if radix == 10 {
        return digits.parse::<f64>().unwrap_or(f64::NAN);
    }
    let mut v = 0.0f64;
    for c in digits.chars() {
        v = v * radix as f64 + c.to_digit(radix).expect("已筛过") as f64;
    }
    v
}

/// `Number(s)`：两头去空白；空串为 0；`0x` / `0o` / `0b`；十进制字面要占满整串，否则 NaN。
pub fn number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let lower2 = t.get(..2).map(|p| p.to_ascii_lowercase());
    for (pre, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if lower2.as_deref() == Some(pre) {
            let rest = &t[2..];
            return if !rest.is_empty() && rest.chars().all(|c| c.is_digit(radix)) { radix_value(rest, radix) } else { f64::NAN };
        }
    }
    if decimal_prefix(t) == t.len() {
        parse_decimal(t)
    } else {
        f64::NAN
    }
}

/// `parseInt(s, radix)`（`radix` 为 0 即不给）：去前导空白、正负号、`0x` 前缀，取最长的一段数字。
pub fn parse_int(s: &str, radix: i32) -> f64 {
    let mut t = s.trim_start_matches(is_space);
    let mut neg = false;
    if let Some(r) = t.strip_prefix('-') {
        neg = true;
        t = r;
    } else if let Some(r) = t.strip_prefix('+') {
        t = r;
    }
    let mut r = radix;
    let mut strip = true;
    if r != 0 {
        if !(2..=36).contains(&r) {
            return f64::NAN;
        }
        if r != 16 {
            strip = false;
        }
    } else {
        r = 10;
    }
    if strip && (t.starts_with("0x") || t.starts_with("0X")) {
        t = &t[2..];
        r = 16;
    }
    let end = t.find(|c: char| !c.is_digit(r as u32)).unwrap_or(t.len());
    if end == 0 {
        return f64::NAN;
    }
    let v = radix_value(&t[..end], r as u32);
    if neg {
        -v
    } else {
        v
    }
}

/// `parseFloat(s)`：去前导空白，取开头最长的十进制字面（含 `Infinity`）；一个都没有为 NaN。
pub fn parse_float(s: &str) -> f64 {
    let t = s.trim_start_matches(is_space);
    let n = decimal_prefix(t);
    if n == 0 {
        f64::NAN
    } else {
        parse_decimal(&t[..n])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_like_js() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(-0.4), -0.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(1e20), 1e20);
        assert!(round(f64::NAN).is_nan());
    }

    #[test]
    fn to_int32_like_js() {
        assert_eq!(to_int32(3.9), 3);
        assert_eq!(to_int32(-3.9), -3);
        assert_eq!(to_int32(2147483648.0), -2147483648);
        assert_eq!(to_int32(4294967296.0 + 5.0), 5);
        assert_eq!(to_int32(-1.0), -1);
        assert_eq!(to_int32(f64::NAN), 0);
    }

    #[test]
    fn sort_is_stable() {
        let mut v: Vec<(i32, usize)> = [3, 1, 2, 1, 3, 2, 1, 0, 5].iter().enumerate().map(|(i, &k)| (k, i)).collect();
        sort_by(&mut v, |a, b| (a.0 - b.0) as f64);
        assert_eq!(v, vec![(0, 7), (1, 1), (1, 3), (1, 6), (2, 2), (2, 5), (3, 0), (3, 4), (5, 8)]);
        let mut e: Vec<f64> = vec![];
        sort_num(&mut e);
        let mut w = vec![2.0, f64::NAN, 1.0];
        sort_num(&mut w); // 不 panic 即可
        assert_eq!(w.len(), 3);
    }

    #[test]
    fn number_to_string_like_js() {
        for (x, s) in [
            (0.0, "0"), (-0.0, "0"), (1.0, "1"), (-1.5, "-1.5"), (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"), (1.5e21, "1.5e+21"), (123456789012345680000.0, "123456789012345680000"),
            (1e-6, "0.000001"), (1e-7, "1e-7"), (1.25e-7, "1.25e-7"), (100.0, "100"), (12.5, "12.5"),
            (f64::NAN, "NaN"), (f64::INFINITY, "Infinity"), (f64::NEG_INFINITY, "-Infinity"),
            (5e-324, "5e-324"), (1.7976931348623157e308, "1.7976931348623157e+308"),
        ] {
            assert_eq!(num_to_string(x), s, "{x}");
        }
    }

    #[test]
    fn to_fixed_like_js() {
        for (x, f, s) in [
            (2.5, 0, "3"), (0.5, 0, "1"), (1.5, 0, "2"), (-2.5, 0, "-3"), (0.125, 2, "0.13"), (1.005, 2, "1.00"),
            (1.45, 1, "1.4"), (9.995, 2, "9.99"), (9.5, 0, "10"), (99.95, 1, "100.0"), (0.0, 2, "0.00"), (-0.0, 2, "0.00"),
            (-0.0001, 2, "-0.00"), (1e21, 2, "1e+21"), (123.456, 1, "123.5"), (0.05, 1, "0.1"), (0.375, 2, "0.38"),
            (f64::NAN, 2, "NaN"), (3.0, 0, "3"),
        ] {
            assert_eq!(to_fixed(x, f), s, "{x}.toFixed({f})");
        }
    }

    #[test]
    fn number_parse_like_js() {
        let same = |a: f64, b: f64| (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits();
        for (s, v) in [
            ("", 0.0), ("  ", 0.0), (" 12 ", 12.0), ("1.", 1.0), (".5", 0.5), ("-.5e1", -5.0), ("0x1F", 31.0), ("0b11", 3.0),
            ("Infinity", f64::INFINITY), ("-Infinity", f64::NEG_INFINITY), ("inf", f64::NAN), ("nan", f64::NAN), ("1e", f64::NAN),
            ("12px", f64::NAN), (".", f64::NAN), ("-0x1", f64::NAN), ("\u{3000}7\u{feff}", 7.0), ("+3", 3.0), ("-0", -0.0),
        ] {
            assert!(same(number(s), v), "Number({s:?}) = {}", number(s));
        }
        for (s, r, v) in [
            ("12px", 0, 12.0), ("  -7.9", 10, -7.0), ("0x1F", 0, 31.0), ("0x1F", 16, 31.0), ("0x1F", 10, 0.0), ("ff", 16, 255.0),
            ("", 0, f64::NAN), ("z", 10, f64::NAN), ("10", 1, f64::NAN), ("-0", 10, -0.0), ("1e3", 10, 1.0),
        ] {
            assert!(same(parse_int(s, r), v), "parseInt({s:?}, {r}) = {}", parse_int(s, r));
        }
        for (s, v) in [("3.5px", 3.5), (" -1e3x", -1000.0), ("1e", 1.0), ("1.e2", 100.0), (".e1", f64::NAN), ("Infinityx", f64::INFINITY), ("x1", f64::NAN)] {
            assert!(same(parse_float(s), v), "parseFloat({s:?}) = {}", parse_float(s));
        }
    }
}
