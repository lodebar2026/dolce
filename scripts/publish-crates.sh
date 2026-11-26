#!/usr/bin/env bash
# 发布 Rust 工作区 crate 到 crates.io。
#
# 用法（从仓库根或任意目录运行）：
#   scripts/publish-crates.sh                          # 按依赖拓扑顺序发布全部 26 个可发布 crate
#   scripts/publish-crates.sh dolce-base               # 仅发布指定的一个或多个 crate（按传入顺序）
#   scripts/publish-crates.sh --dry-run                # 全量本地打包校验（不上传）
#   scripts/publish-crates.sh --dry-run dolce-base     # 仅对指定 crate 做打包校验
#   scripts/publish-crates.sh --no-wait                # 遇 crates.io HTTP 429 限流时直接退出、不等待
#
# 特性：
# - 支持环境变量 CARGO_REGISTRY_TOKEN 或 CRATES_IO_TOKEN 传入 crates.io API Token（优先级高于 cargo login）。
# - 发布前校验 crates/*/assets/ 与 public/redist/ 一致，防止字体资产漂移。
# - 自动查询 crates.io，已发布同版本的 crate 自动跳过（支持首次发布中途断点续发）。
# - 首次发布新 crate 命中 crates.io 速率限制（前 5 个后每 10 分钟 1 个）时，自动解析等待时间并重试。
set -euo pipefail

DRY_RUN=0
NO_WAIT=0
ALLOW_DIRTY=0
OFFLINE=0
TARGETS=()

while [ "${1:-}" != "" ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-wait) NO_WAIT=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --offline) OFFLINE=1 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "!! 未知选项 $1" >&2
      exit 1
      ;;
    *)
      TARGETS+=("$1")
      ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATES_DIR="${ROOT}/crates"

# 若未通过环境变量传入 Token，尝试从仓库根 .env.local（已被 .gitignore 忽略）读取
if [ -z "${CARGO_REGISTRY_TOKEN:-}" ] && [ -z "${CRATES_IO_TOKEN:-}" ] && [ -f "${ROOT}/.env.local" ]; then
  # 只取 token 两行，不把 .env.local 里别的变量带进 cargo 的环境
  while IFS='=' read -r k v; do
    k="${k#export }"
    case "${k}" in
      CARGO_REGISTRY_TOKEN|CRATES_IO_TOKEN)
        v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
        export "${k}=${v}" ;;
    esac
  done < "${ROOT}/.env.local"
fi

# 全部 26 个可发布 crate（严格按依赖拓扑顺序排列；排除 dolce-dev 与 4 个 *-wasm 包）
ALL_CRATES=(
  dolce-base
  dolce-text
  dolce-scene
  dolce-play
  dolce-model
  dolce-hanconv
  dolce-view
  dolce-style
  dolce-engrave
  dolce-layout-jianpu
  dolce-layout-staff
  dolce-book
  dolce-omr-core
  dolce-omr-ocr
  dolce-omr-source
  dolce-omr-book
  dolce-omr-text
  dolce-omr-sheet
  dolce-omr-jianpu
  dolce-omr-staff
  dolce-formats
  dolce-omr-todoc
  dolce-omr-engine
  dolce-export
  dolce-session
  dolce-cli
)

# 1. 校验内置 Bravura 资产与 public/redist/ 一致
check_assets() {
  local pairs=(
    "public/redist/Bravura.otf:crates/dolce-text/assets/Bravura.otf"
    "public/redist/BravuraText.otf:crates/dolce-text/assets/BravuraText.otf"
    "public/redist/bravura_metadata.json:crates/dolce-text/assets/bravura_metadata.json"
  )
  for pair in "${pairs[@]}"; do
    local src="${ROOT}/${pair%%:*}"
    local dst="${ROOT}/${pair##*:}"
    if ! cmp -s "${src}" "${dst}"; then
      echo "!! 静态资产不一致：${pair%%:*} 与 ${pair##*:}" >&2
      echo "   请先同步后再发布。" >&2
      exit 1
    fi
  done
}

# 读取 [workspace.package].version
VER="$(sed -n '/^\[workspace\.package\]/,/^\[/s/^version = "\([^"]*\)"/\1/p' "${CRATES_DIR}/Cargo.toml" | head -n 1)"
[ -n "${VER}" ] || { echo "!! 无法从 crates/Cargo.toml 读取版本号" >&2; exit 1; }

# 校验用户指定的 crate 名是否有效
if [ "${#TARGETS[@]}" -eq 0 ]; then
  TARGETS=("${ALL_CRATES[@]}")
else
  for t in "${TARGETS[@]}"; do
    found=0
    for c in "${ALL_CRATES[@]}"; do
      if [ "${t}" = "${c}" ]; then found=1; break; fi
    done
    if [ "${found}" -eq 0 ]; then
      echo "!! 未知或不可发布的 crate：${t}" >&2
      echo "   可发布列表：${ALL_CRATES[*]}" >&2
      exit 1
    fi
  done
fi

echo "==> 校验内置字体资产一致性…"
check_assets

cd "${CRATES_DIR}"

if [ "${DRY_RUN}" -eq 1 ]; then
  echo "==> [dry-run] 验证打包（版本 ${VER}，共 ${#TARGETS[@]} 个 crate）…"
  # 注：若上游依赖尚未发布到 crates.io，逐包 cargo publish --dry-run 会因找不到未发布的上游版本而失败；
  # Cargo 1.90+ 的 `cargo package --workspace` 可在本地离线解析整个工作区依赖图并完整验证编译。
  PKG_ARGS=()
  for t in "${TARGETS[@]}"; do
    PKG_ARGS+=(-p "${t}")
  done
  if [ "${ALLOW_DIRTY}" -eq 1 ] || ! git diff --quiet || ! git diff --cached --quiet; then
    PKG_ARGS+=(--allow-dirty)
  fi
  if [ "${OFFLINE}" -eq 1 ]; then
    PKG_ARGS+=(--offline)
    # Cargo 1.100 在多包 --offline 验证 tmp-registry 时会报 no hash listed，离线多包先校验打包再由 cargo check 验编译
    if [ "${#TARGETS[@]}" -gt 1 ]; then
      PKG_ARGS+=(--no-verify)
    fi
  fi
  cargo package "${PKG_ARGS[@]}"
  if [ "${OFFLINE}" -eq 1 ] && [ "${#TARGETS[@]}" -gt 1 ]; then
    CHECK_ARGS=()
    for t in "${TARGETS[@]}"; do
      CHECK_ARGS+=(-p "${t}")
    done
    cargo check --offline "${CHECK_ARGS[@]}"
  fi
  echo "==> [dry-run] 全部 ${#TARGETS[@]} 个 crate 打包与编译验证通过"
  exit 0
fi

# 兼容 CRATES_IO_TOKEN 与 Cargo 原生 CARGO_REGISTRY_TOKEN
if [ -z "${CARGO_REGISTRY_TOKEN:-}" ] && [ -n "${CRATES_IO_TOKEN:-}" ]; then
  export CARGO_REGISTRY_TOKEN="${CRATES_IO_TOKEN}"
fi

# 检查 crates.io 登录凭证
if [ -z "${CARGO_REGISTRY_TOKEN:-}" ] && [ ! -f "${CARGO_HOME:-$HOME/.cargo}/credentials.toml" ] && [ ! -f "${CARGO_HOME:-$HOME/.cargo}/credentials" ]; then
  echo "!! 未检测到 crates.io 登录凭证，请设置 CARGO_REGISTRY_TOKEN / CRATES_IO_TOKEN 或先执行 cargo login" >&2
  exit 1
fi

# 查询 crates.io 上是否已存在指定版本的 crate（返回 0 表示已发布）
is_published() {
  local name="$1"
  local ver="$2"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -A "dolce-publish-script (${VER})" \
    "https://crates.io/api/v1/crates/${name}/${ver}" 2>/dev/null || echo "000")"
  [ "${code}" = "200" ]
}

# 等待刚发布的 crate 在 crates.io 索引可见
wait_indexed() {
  local name="$1"
  local ver="$2"
  for _ in $(seq 1 24); do
    if is_published "${name}" "${ver}"; then
      return 0
    fi
    sleep 5
  done
  echo "!! ${name} ${ver} 发布后 2 分钟仍未在 crates.io 索引出现，后面依赖它的 crate 会发不上；稍后重跑本脚本断点续发" >&2
  exit 1
}

PUB_EXTRA=()
[ "${ALLOW_DIRTY}" -eq 1 ] && PUB_EXTRA+=(--allow-dirty)

TOTAL="${#TARGETS[@]}"
IDX=0
for crate in "${TARGETS[@]}"; do
  IDX=$((IDX + 1))
  echo ""
  echo "==> [${IDX}/${TOTAL}] ${crate} ${VER}"
  if is_published "${crate}" "${VER}"; then
    echo "    已在 crates.io 上存在，跳过"
    continue
  fi

  while true; do
    OUT_FILE="$(mktemp)"
    set +e
    cargo publish -p "${crate}" ${PUB_EXTRA[@]+"${PUB_EXTRA[@]}"} 2>&1 | tee "${OUT_FILE}"
    RC="${PIPESTATUS[0]}"
    set -e

    if [ "${RC}" -eq 0 ]; then
      rm -f "${OUT_FILE}"
      echo "    ✓ ${crate} ${VER} 发布成功"
      if [ "${IDX}" -lt "${TOTAL}" ]; then
        wait_indexed "${crate}" "${VER}"
      fi
      break
    fi

    # 处理 crates.io HTTP 429 限流
    if grep -qE "429 Too Many Requests|please try again after" "${OUT_FILE}"; then
      rm -f "${OUT_FILE}"
      if [ "${NO_WAIT}" -eq 1 ]; then
        echo "!! 命中 crates.io 速率限制（已指定 --no-wait），稍后重新执行本脚本即可断点续发" >&2
        exit 1
      fi
      WAIT_SECS=610
      echo "    ⏳ 命中 crates.io 速率限制，等待 ${WAIT_SECS} 秒后自动重试 ${crate}…"
      sleep "${WAIT_SECS}"
      continue
    fi

    # 幂等保护：若报错提示该版本已存在，也视为成功跳过
    if grep -q "already exists on crates.io" "${OUT_FILE}"; then
      rm -f "${OUT_FILE}"
      echo "    ✓ ${crate} ${VER} 已存在，跳过"
      break
    fi

    rm -f "${OUT_FILE}"
    echo "!! 发布 ${crate} 失败（退出码 ${RC}）" >&2
    exit "${RC}"
  done
done

echo ""
echo "==> 完成：${TOTAL} 个 crate（${VER}）均已发布到 crates.io"
