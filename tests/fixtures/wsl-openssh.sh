#!/bin/sh
# Starts a disposable, unprivileged real OpenSSH server inside WSL for tests/real/*.
# Nothing is installed system-wide and no root is needed: the packages are unpacked below $ROOT.
# Usage: wsl-openssh.sh <port> <authorized-public-key>
# Prints "READY <fingerprint-of-host-key>" and keeps running until killed.
set -eu

PORT="$1"
PUBLIC_KEY="$2"
ROOT="${RYFT_OPENSSH_ROOT:-/tmp/ryft-openssh}"
PKG="$ROOT/pkg"
RUN="$ROOT/run-$PORT"

mkdir -p "$PKG"
if [ ! -e "$PKG/.complete" ]; then
  cd "$ROOT"
  # The system's package lists may be stale and refreshing them needs root, so a private copy is used.
  mkdir -p "$ROOT/apt/lists/partial" "$ROOT/apt/cache/archives/partial"
  APT_OPTIONS="-o Dir::State::lists=$ROOT/apt/lists -o Dir::Cache=$ROOT/apt/cache -o APT::Sandbox::User=$(id -un)"
  # shellcheck disable=SC2086
  apt-get $APT_OPTIONS update >"$ROOT/apt.log" 2>&1
  # shellcheck disable=SC2086
  apt-get $APT_OPTIONS download openssh-server openssh-sftp-server libwrap0 >>"$ROOT/apt.log" 2>&1
  for deb in ./*.deb; do dpkg-deb -x "$deb" "$PKG"; done
  rm -f ./*.deb
  touch "$PKG/.complete"
fi
# Libraries of the private packages, which the dynamic loader would not find by itself.
LD_LIBRARY_PATH="$PKG/usr/lib/$(uname -m)-linux-gnu:$PKG/lib/$(uname -m)-linux-gnu"
export LD_LIBRARY_PATH

rm -rf "$RUN"
mkdir -p "$RUN/home"
chmod 700 "$RUN" "$RUN/home"
ssh-keygen -q -t ed25519 -N '' -f "$RUN/host_ed25519" >/dev/null
printf '%s\n' "$PUBLIC_KEY" >"$RUN/authorized_keys"
chmod 600 "$RUN/authorized_keys"

cat >"$RUN/sshd_config" <<EOF
Port $PORT
ListenAddress 0.0.0.0
HostKey $RUN/host_ed25519
PidFile $RUN/sshd.pid
AuthorizedKeysFile $RUN/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
StrictModes no
AllowTcpForwarding yes
GatewayPorts no
AcceptEnv RYFT_*
Subsystem sftp $PKG/usr/lib/openssh/sftp-server
SshdSessionPath $PKG/usr/lib/openssh/sshd-session
SshdAuthPath $PKG/usr/lib/openssh/sshd-auth
EOF

echo "READY $(ssh-keygen -lf "$RUN/host_ed25519.pub" | awk '{print $2}') $RUN"
exec "$PKG/usr/sbin/sshd" -D -e -f "$RUN/sshd_config"
