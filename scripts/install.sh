#!/bin/sh
# Codify Buddy installer: downloads the standalone binary for this machine.
#   curl -fsSL https://raw.githubusercontent.com/RohanMAshlesh/codify-buddy/main/scripts/install.sh | sh
# Environment:
#   CODIFY_VERSION      release tag to install (default: latest)
#   CODIFY_INSTALL_DIR  install directory (default: ~/.codify/bin)
set -eu

REPO="RohanMAshlesh/codify-buddy"
VERSION="${CODIFY_VERSION:-latest}"
INSTALL_DIR="${CODIFY_INSTALL_DIR:-$HOME/.codify/bin}"

err() { printf 'codify-install: %s\n' "$1" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW*|MSYS*|CYGWIN*) err "on Windows, download codify-windows-x64.exe from https://github.com/$REPO/releases or use: npm i -g codify-buddy" ;;
  *) err "unsupported OS: $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) err "unsupported architecture: $(uname -m)" ;;
esac

asset="codify-$os-$arch"
if [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

command -v curl >/dev/null 2>&1 || err "curl is required"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf 'Downloading %s (%s)…\n' "$asset" "$VERSION"
curl -fsSL "$base/$asset" -o "$tmp/codify" || err "download failed: $base/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || err "could not download checksums"

expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
[ -n "$expected" ] || err "no checksum listed for $asset"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/codify" | cut -d' ' -f1)"
else actual="$(shasum -a 256 "$tmp/codify" | cut -d' ' -f1)"; fi
[ "$expected" = "$actual" ] || err "checksum mismatch for $asset"

mkdir -p "$INSTALL_DIR"
mv "$tmp/codify" "$INSTALL_DIR/codify"
chmod +x "$INSTALL_DIR/codify"
printf '✔ Installed codify to %s/codify\n' "$INSTALL_DIR"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf '\nAdd it to your PATH:\n  echo '\''export PATH="%s:$PATH"'\'' >> ~/.profile\n' "$INSTALL_DIR" ;;
esac
printf '\nGet started:\n  cd your-project && codify\n'
