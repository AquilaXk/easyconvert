#!/usr/bin/env bash
# Verifies the hardening of the built worker image from inside the running container.
#
# Run it as the image's own user with the runtime settings the worker uses, for example:
#   docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
#     --security-opt seccomp=docker/seccomp-worker.json --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1g \
#     -v "$PWD/scripts/verify-worker-container.sh:/verify.sh:ro" --entrypoint /bin/bash <image> /verify.sh
#
# Checks (each prints PASS or FAIL; the exit status is 1 when any fails):
#   1. a write to the read-only root filesystem fails with EROFS
#   2. executing a file from /tmp fails with EACCES (noexec)
#   3. the process holds no cap_sys_admin (kernel view; `capsh --print` too when it is installed)
#   4. a child in the sandbox's namespaces cannot connect to the Redis port while the parent can
#   5. one real conversion completes inside the sandbox
#
# The sandbox is entered with the same `unshare -r -n` and `prlimit --as` the worker uses
# (src/lib/security/process-sandbox.ts); this script does not load the worker's own code.
#
# Environment:
#   VERIFY_REDIS_HOST        host of the Redis the worker uses (default 127.0.0.1)
#   VERIFY_REDIS_PORT        its port (default 6379)
#   VERIFY_APP_DIR           read-only application directory (default /app)
#   VERIFY_LIBREOFFICE=1     also convert a text file to PDF with LibreOffice inside the sandbox
set -u

REDIS_HOST="${VERIFY_REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${VERIFY_REDIS_PORT:-6379}"
APP_DIR="${VERIFY_APP_DIR:-/app}"
ADDRESS_SPACE_LIMIT_BYTES=$((4 * 1024 * 1024 * 1024))
CAP_SYS_ADMIN_BIT=21
CONNECT_TIMEOUT_MS=3000
LISTENER_WAIT_TRIES=50
LISTENER_WAIT_SECONDS=0.1
CONVERSION_TIMEOUT_SECONDS=120
EXEC_DENIED_STATUS=126
MARKER_TEXT="EasyConvertContainerCheck"

failures=0
work_dir=""
listener_pid=""

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }
note() { printf '      %s\n' "$1"; }

cleanup() {
  if [ -n "$listener_pid" ]; then kill "$listener_pid" 2>/dev/null; fi
  if [ -n "$work_dir" ]; then rm -rf "$work_dir"; fi
}
trap cleanup EXIT

if ! work_dir="$(mktemp -d /tmp/verify-worker.XXXXXX)"; then
  fail "a scratch directory could not be created under /tmp (is /tmp a writable tmpfs?)"
  exit 1
fi

# Runs a command the way the worker runs a native child: user and network namespaces, address-space limit.
sandboxed() {
  unshare -r -n -- prlimit --as="$ADDRESS_SPACE_LIMIT_BYTES" -- "$@"
}

CONNECT_SCRIPT='
const net = require("node:net");
const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]) });
const timer = setTimeout(() => { console.log("timeout"); process.exit(0); }, Number(process.argv[3]));
socket.on("connect", () => { console.log("connected"); clearTimeout(timer); socket.destroy(); });
socket.on("error", (err) => { console.log("error:" + err.code); clearTimeout(timer); });
'

LISTEN_SCRIPT='
const net = require("node:net");
net.createServer((socket) => socket.end()).listen(Number(process.argv[2]), process.argv[1]);
'

# --- 1. Read-only root filesystem ---------------------------------------------------------------
write_output="$(touch "$APP_DIR/.verify-write" 2>&1)"
write_status=$?
if [ "$write_status" -ne 0 ] && printf '%s' "$write_output" | grep -q "Read-only file system"; then
  pass "write to $APP_DIR fails with EROFS"
else
  fail "write to $APP_DIR did not fail with EROFS (status $write_status): $write_output"
  rm -f "$APP_DIR/.verify-write" 2>/dev/null
fi

# --- 2. noexec /tmp -------------------------------------------------------------------------------
probe="$work_dir/probe-exec"
if cp /usr/bin/true "$probe" && chmod 0755 "$probe"; then
  exec_output="$("$probe" 2>&1)"
  exec_status=$?
  if [ "$exec_status" -eq "$EXEC_DENIED_STATUS" ] && printf '%s' "$exec_output" | grep -q "Permission denied"; then
    pass "executing a file from /tmp fails with EACCES"
  else
    fail "executing a file from /tmp was not denied (status $exec_status): $exec_output"
  fi
else
  fail "a file could not be staged in /tmp to test noexec"
fi

# --- 3. No cap_sys_admin ---------------------------------------------------------------------------
cap_failed=0
for field in CapEff CapPrm CapBnd; do
  value="$(awk -v key="$field:" '$1 == key { print $2 }' /proc/self/status)"
  if [ -z "$value" ]; then
    fail "$field could not be read from /proc/self/status"
    cap_failed=1
  elif [ $(( 0x$value & (1 << CAP_SYS_ADMIN_BIT) )) -ne 0 ]; then
    fail "$field holds cap_sys_admin (0x$value)"
    cap_failed=1
  fi
done
if command -v capsh >/dev/null 2>&1; then
  if capsh --print | grep -qi "cap_sys_admin"; then
    fail "capsh --print lists cap_sys_admin"
    cap_failed=1
  fi
else
  note "capsh is not installed in this image; the /proc/self/status view above is the check"
fi
if [ "$cap_failed" -eq 0 ]; then pass "no cap_sys_admin in the effective, permitted or bounding set"; fi

# --- 4. Network isolation of the sandboxed child ---------------------------------------------------
if ! sandboxed true 2>/dev/null; then
  fail "the sandbox cannot be created (unshare -r -n failed): is docker/seccomp-worker.json applied?"
else
  parent_result="$(node -e "$CONNECT_SCRIPT" "$REDIS_HOST" "$REDIS_PORT" "$CONNECT_TIMEOUT_MS")"
  if [ "$parent_result" != "connected" ] && [ "$REDIS_HOST" = "127.0.0.1" ]; then
    # No Redis in this container: a throwaway listener on the same address stands in for it.
    node -e "$LISTEN_SCRIPT" "$REDIS_HOST" "$REDIS_PORT" &
    listener_pid=$!
    for _ in $(seq "$LISTENER_WAIT_TRIES"); do
      parent_result="$(node -e "$CONNECT_SCRIPT" "$REDIS_HOST" "$REDIS_PORT" "$CONNECT_TIMEOUT_MS")"
      [ "$parent_result" = "connected" ] && break
      sleep "$LISTENER_WAIT_SECONDS"
    done
    note "nothing listened on $REDIS_HOST:$REDIS_PORT; a stand-in listener was used"
  fi
  child_result="$(sandboxed node -e "$CONNECT_SCRIPT" "$REDIS_HOST" "$REDIS_PORT" "$CONNECT_TIMEOUT_MS" 2>&1)"
  if [ "$parent_result" != "connected" ]; then
    fail "the parent cannot connect to $REDIS_HOST:$REDIS_PORT ($parent_result), so the child check proves nothing"
  elif [ "$child_result" = "connected" ] || [ "$child_result" = "timeout" ]; then
    fail "the sandboxed child reached $REDIS_HOST:$REDIS_PORT ($child_result)"
  else
    pass "parent connects to $REDIS_HOST:$REDIS_PORT; the sandboxed child does not ($child_result)"
  fi
fi

# --- 5. One real conversion inside the sandbox -----------------------------------------------------
# A one-page PDF with a correct cross-reference table, written by Node; Poppler extracts its text.
node -e '
const fs = require("node:fs");
const [target, marker] = process.argv.slice(1);
const stream = "BT /F1 18 Tf 72 720 Td (" + marker + ") Tj ET";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
let body = "%PDF-1.4\n";
const offsets = [];
objects.forEach((object, index) => { offsets.push(body.length); body += (index + 1) + " 0 obj\n" + object + "\nendobj\n"; });
const xref = body.length;
body += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
offsets.forEach((offset) => { body += String(offset).padStart(10, "0") + " 00000 n \n"; });
body += "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
fs.writeFileSync(target, body, "latin1");
' "$work_dir/input.pdf" "$MARKER_TEXT"

if sandboxed timeout "$CONVERSION_TIMEOUT_SECONDS" pdftotext "$work_dir/input.pdf" "$work_dir/output.txt" 2>"$work_dir/pdftotext.err" \
  && grep -q "$MARKER_TEXT" "$work_dir/output.txt"; then
  pass "pdftotext converted a PDF inside the sandbox (found '$MARKER_TEXT' in the output)"
else
  fail "pdftotext did not convert the PDF inside the sandbox: $(head -c 300 "$work_dir/pdftotext.err" 2>/dev/null)"
fi

if [ "${VERIFY_LIBREOFFICE:-0}" = "1" ]; then
  printf '%s\n' "$MARKER_TEXT" > "$work_dir/document.txt"
  if HOME="$work_dir" sandboxed timeout "$CONVERSION_TIMEOUT_SECONDS" soffice --headless --norestore --nofirststartwizard --nologo \
      "-env:UserInstallation=file://$work_dir/lo-profile" --convert-to pdf --outdir "$work_dir" "$work_dir/document.txt" \
      >"$work_dir/soffice.out" 2>&1 \
    && head -c 5 "$work_dir/document.pdf" | grep -q '%PDF-'; then
    pass "LibreOffice converted a text file to PDF inside the sandbox"
  else
    fail "LibreOffice did not convert inside the sandbox: $(head -c 300 "$work_dir/soffice.out" 2>/dev/null)"
  fi
fi

if [ "$failures" -eq 0 ]; then
  printf 'All worker container checks passed.\n'
  exit 0
fi
printf '%s worker container check(s) failed.\n' "$failures"
exit 1
