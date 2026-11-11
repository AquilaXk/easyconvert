#!/usr/bin/env bash
# Verifies the hardening of the built worker image from inside the running container.
#
# Run it as the image's own user with the runtime settings the worker uses, for example:
#   docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
#     --security-opt seccomp=docker/seccomp-worker.json --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1g,uid=10001,gid=10001,mode=0750 \
#     -v "$PWD/scripts/verify-worker-container.sh:/verify.sh:ro" --entrypoint /bin/bash <image> /verify.sh
#
# Checks (each prints PASS or FAIL; the exit status is 1 when any fails):
#   1. a write to the read-only root filesystem fails with EROFS
#   2. executing a file from /tmp fails with EACCES (noexec)
#   3. the process holds no cap_sys_admin (kernel view; `capsh --print` too when it is installed)
#   4. a child in the sandbox's namespaces cannot connect to the Redis port while the parent can
#   5. one real conversion completes inside the sandbox (pdftotext; cad-convert for STEP; fluidsynth for MIDI; FontForge for a Type 1 font; calibre for a MOBI book; LibreOffice with VERIFY_LIBREOFFICE=1)
#   6. libdeflate-gzip (the deflate encoder for ZIP and gzip payloads past 4 MiB) is installed and round-trips inside the sandbox
#   7. lbzip2 (the bzip2 encoder for tar.bz2 targets of up to two blocks) is installed and round-trips inside the sandbox
#   8. qpdf-runner (the qpdf jobs of the PDF operations) runs a job in a user and network namespace of its own under this container's seccomp profile
#   9. xz (the .xz encoder and decoder of the archive conversions) is installed and round-trips inside the sandbox, also under the worker's own address-space caps
#  10. pid-init runs a program as PID 2 of a PID namespace of its own, under this container's seccomp profile, and the program cannot see or signal a sibling process
#      nor read its command line and status in /proc (the Landlock ruleset of pid-init)
#  11. the ONNX OCR helper (dist/ocr-onnx-child.js) loads its models and reads one real page (detector and recogniser) in a user, network and PID
#      namespace of its own, under the address-space and CPU limits the worker gives it and this container's seccomp profile
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
XZ_COMPRESS_ADDRESS_SPACE_BYTES=$((1024 * 1024 * 1024))
XZ_DECODE_ADDRESS_SPACE_BYTES=$((512 * 1024 * 1024))
XZ_DECODE_MEMLIMIT=256MiB
CAP_SYS_ADMIN_BIT=21
CONNECT_TIMEOUT_MS=3000
LISTENER_WAIT_TRIES=50
LISTENER_WAIT_SECONDS=0.1
CONVERSION_TIMEOUT_SECONDS=120
EXEC_DENIED_STATUS=126
MARKER_TEXT="EasyConvertContainerCheck"
STL_ONE_TRIANGLE_BYTES=134
WAV_HEADER_BYTES=44

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
  sandboxed_as "$ADDRESS_SPACE_LIMIT_BYTES" "$@"
}

sandboxed_as() {
  local address_space_bytes="$1"
  shift
  unshare -r -n -- prlimit --as="$address_space_bytes" -- "$@"
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
  # Only the capability-set lines count: the IAB line lists excluded capabilities as `!cap_sys_admin`.
  if capsh --print | grep -E '^(Current:|Bounding set)' | grep -qi "cap_sys_admin"; then
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

# A STEP file with one triangular face (10 mm legs), as the kernel reads it; cad-convert meshes it to a binary STL of one triangle:
# an 80-byte header, the count, and 50 bytes for the facet. It runs without any Open CASCADE resource files or environment.
cat > "$work_dir/input.step" << 'STEP'
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('EasyConvert CAD STEP AP214 B-Rep Model'), '2;1');
FILE_NAME('cube.step', '2026-10-17T12:37:12', ('EasyConvert Core'), ('EasyConvert Engine'), 'Processor 2.0', 'EasyConvert', 'Authorization');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#1 = APPLICATION_CONTEXT('core data for automotive mechanical design processes');
#2 = APPLICATION_PROTOCOL_DEFINITION('international standard', 'automotive_design', 1994, #1);
#3 = PRODUCT_CONTEXT('', #1, 'mechanical');
#4 = PRODUCT('cube', 'cube', '', (#3));
#5 = PRODUCT_DEFINITION_FORMATION('', '', #4);
#6 = PRODUCT_DEFINITION_CONTEXT('part definition', #1, 'design');
#7 = PRODUCT_DEFINITION('design', '', #5, #6);
#8 = PRODUCT_DEFINITION_SHAPE('', '', #7);
#9 = SHAPE_DEFINITION_REPRESENTATION(#8, #10);
#11 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI., .METRE.) );
#12 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($, .RADIAN.) );
#13 = ( NAMED_UNIT(*) SI_UNIT($, .STERADIAN.) SOLID_ANGLE_UNIT() );
#14 = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07), #11, 'distance_accuracy_value', 'confusion accuracy');
#15 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#14)) GLOBAL_UNIT_ASSIGNED_CONTEXT((#11, #12, #13)) REPRESENTATION_CONTEXT('Context #1', '3D Context with UNIT and UNCERTAINTY') );
#16 = CARTESIAN_POINT('ORIGIN', (0.0, 0.0, 0.0));
#17 = DIRECTION('DIR_Z', (0.0, 0.0, 1.0));
#18 = DIRECTION('DIR_X', (1.0, 0.0, 0.0));
#19 = AXIS2_PLACEMENT_3D('AXIS', #16, #17, #18);
#20 = CARTESIAN_POINT('', (0.0, 0.0, 0.0));
#21 = CARTESIAN_POINT('', (10.0, 0.0, 0.0));
#22 = CARTESIAN_POINT('', (10.0, 10.0, 0.0));
#28 = POLY_LOOP('', (#20, #22, #21));
#29 = FACE_OUTER_BOUND('', #28, .T.);
#30 = DIRECTION('', (0.0, 0.0, -1.0));
#31 = DIRECTION('', (1.0, 0.0, 0.0));
#32 = AXIS2_PLACEMENT_3D('', #20, #30, #31);
#33 = PLANE('', #32);
#34 = FACE_SURFACE('', (#29), #33, .T.);
#112 = CLOSED_SHELL('', (#34));
#113 = FACETED_BREP('tri', #112);
#10 = FACETED_BREP_SHAPE_REPRESENTATION('tri', (#113, #19), #15);
ENDSEC;
END-ISO-10303-21;
STEP
if sandboxed timeout "$CONVERSION_TIMEOUT_SECONDS" cad-convert --from step --to stl "$work_dir/input.step" "$work_dir/output.stl" 2>"$work_dir/cad-convert.err" \
  && [ "$(wc -c < "$work_dir/output.stl")" -eq "$STL_ONE_TRIANGLE_BYTES" ]; then
  pass "cad-convert meshed a STEP face to a one-triangle STL inside the sandbox"
else
  fail "cad-convert did not convert the STEP file inside the sandbox: $(head -c 300 "$work_dir/cad-convert.err" 2>/dev/null)"
fi

# A Standard MIDI File of one note (middle C for a quarter note at 120 beats a minute): FluidSynth renders it to a WAV with the General MIDI
# SoundFont that the Debian alternatives link default-GM.sf2 names, as the worker runs it (no audio driver, no shell, file output).
printf 'MThd\0\0\0\6\0\0\0\1\1\340MTrk\0\0\0\24\0\377\121\3\7\241\40\0\220\74\144\203\140\200\74\0\0\377\57\0' > "$work_dir/input.mid"
if sandboxed timeout "$CONVERSION_TIMEOUT_SECONDS" fluidsynth -ni -q -r 44100 -T wav -F "$work_dir/output.wav" /usr/share/sounds/sf2/default-GM.sf2 "$work_dir/input.mid" 2>"$work_dir/fluidsynth.err" \
  && [ "$(head -c 4 "$work_dir/output.wav")" = "RIFF" ] \
  && [ "$(wc -c < "$work_dir/output.wav")" -gt "$WAV_HEADER_BYTES" ]; then
  pass "fluidsynth rendered a MIDI note to a WAV inside the sandbox"
else
  fail "fluidsynth did not render the MIDI file inside the sandbox: $(head -c 300 "$work_dir/fluidsynth.err" 2>/dev/null)"
fi

# FontForge reads PostScript Type 1 fonts: it writes a one-glyph Type 1 font (a PFB) itself, then reads that file and writes an OpenType font
# with CFF outlines, the way the worker converts a PFB, and the result must carry the OpenType CFF signature 'OTTO'. Its home is the scratch directory.
if HOME="$work_dir" sandboxed timeout "$CONVERSION_TIMEOUT_SECONDS" fontforge -lang=ff -c 'New(); Select(65); SetWidth(500); Generate($1)' "$work_dir/check.pfb" >/dev/null 2>"$work_dir/fontforge.err" \
  && HOME="$work_dir" sandboxed timeout "$CONVERSION_TIMEOUT_SECONDS" fontforge -lang=ff -c 'Open($1); Generate($2)' "$work_dir/check.pfb" "$work_dir/check.otf" >/dev/null 2>>"$work_dir/fontforge.err" \
  && [ "$(head -c 4 "$work_dir/check.otf")" = "OTTO" ]; then
  pass "fontforge converted a Type 1 font to an OpenType font inside the sandbox"
else
  fail "fontforge did not convert a Type 1 font inside the sandbox: $(tail -c 300 "$work_dir/fontforge.err" 2>/dev/null)"
fi

# calibre writes MOBI, AZW3, PDB, LRF and OEB books: it converts a text file to each of the five started as the worker starts it (Qt without a
# display, its configuration, cache and temporary directories in the scratch directory, the options of the worker's route), and each result must
# carry the signature of its format: the Palm database type and creator `BOOKMOBI` (MOBI) or `TEXtREAd` (PDB) at bytes 60 to 67, the MOBI header
# version 8 (AZW3, 36 bytes into record 0), the LRF magic, or an OPF package in the OEB folder.
mkdir -p "$work_dir/calibre-config" "$work_dir/calibre-cache" "$work_dir/calibre-tmp"
printf '%s\n' "$MARKER_TEXT" > "$work_dir/book.txt"

calibre_options() {
  case "$1" in
    mobi) echo "--mobi-file-type old --no-inline-toc" ;;
    azw3) echo "--no-inline-toc" ;;
    pdb) echo "--format doc --pdb-output-encoding cp1252" ;;
  esac
}

# Prints what is wrong with the book calibre wrote for the target, or nothing when its signature is the format's.
calibre_book_problem() {
  local target="$1" book="$work_dir/book.$1" record0
  case "$target" in
    mobi) [ "$(dd if="$book" bs=1 skip=60 count=8 2>/dev/null)" = "BOOKMOBI" ] || echo "no BOOKMOBI type and creator" ;;
    pdb) [ "$(dd if="$book" bs=1 skip=60 count=8 2>/dev/null)" = "TEXtREAd" ] || echo "no TEXtREAd type and creator" ;;
    azw3)
      record0="$(od -An -tu4 --endian=big -j78 -N4 "$book" | tr -d ' ')"
      [ "$(dd if="$book" bs=1 skip=60 count=8 2>/dev/null)" = "BOOKMOBI" ] \
        && [ "$(od -An -tu4 --endian=big -j$((record0 + 36)) -N4 "$book" | tr -d ' ')" = "8" ] || echo "not a MOBI version 8 book" ;;
    lrf) [ "$(od -An -tx1 -N8 "$book" | tr -d ' \n')" = "4c00520046000000" ] || echo "no LRF magic" ;;
    oeb) find "$book" -name '*.opf' 2>/dev/null | grep -q . || echo "no OPF package in the folder" ;;
  esac
}

calibre_failure=""
for calibre_target in mobi azw3 pdb lrf oeb; do
  # The options of the target are separate words on purpose.
  # shellcheck disable=SC2046
  if ! sandboxed timeout "$CONVERSION_TIMEOUT_SECONDS" env HOME="$work_dir" QT_QPA_PLATFORM=offscreen CALIBRE_CONFIG_DIRECTORY="$work_dir/calibre-config" \
      CALIBRE_CACHE_DIRECTORY="$work_dir/calibre-cache" CALIBRE_TEMP_DIR="$work_dir/calibre-tmp" PYTHONDONTWRITEBYTECODE=1 \
      ebook-convert "$work_dir/book.txt" "$work_dir/book.$calibre_target" $(calibre_options "$calibre_target") >"$work_dir/calibre.out" 2>&1; then
    calibre_failure="the .$calibre_target run failed: $(tail -c 300 "$work_dir/calibre.out" 2>/dev/null)"
    break
  fi
  calibre_problem="$(calibre_book_problem "$calibre_target")"
  if [ -n "$calibre_problem" ]; then
    calibre_failure="the .$calibre_target book fails its check ($calibre_problem)"
    break
  fi
done
if [ -z "$calibre_failure" ]; then
  pass "calibre converted a text file to MOBI, AZW3, PDB, LRF and OEB books inside the sandbox"
else
  fail "calibre did not convert a text file to the five e-book targets inside the sandbox: $calibre_failure"
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

# --- 6. libdeflate-gzip -----------------------------------------------------------------------------
# The archive conversions run it as `libdeflate-gzip -N` with the data on stdin; without it they fall back to 7-Zip, slower.
if ! command -v libdeflate-gzip >/dev/null 2>&1; then
  fail "libdeflate-gzip is not installed (package libdeflate-tools): ZIP and gzip payloads past 4 MiB fall back to the slower 7-Zip route"
else
  deflate_input="$(head -c 4096 /dev/zero | tr '\0' 'x')"
  deflate_output="$(printf '%s' "$deflate_input" | sandboxed libdeflate-gzip -6 2>"$work_dir/libdeflate.err" | sandboxed libdeflate-gzip -d 2>>"$work_dir/libdeflate.err")"
  if [ "$deflate_output" = "$deflate_input" ]; then
    pass "libdeflate-gzip compressed and decompressed 4096 bytes inside the sandbox"
  else
    fail "libdeflate-gzip did not round-trip inside the sandbox: $(head -c 300 "$work_dir/libdeflate.err" 2>/dev/null)"
  fi
fi

# --- 7. lbzip2 -----------------------------------------------------------------------------------------
# The archive conversions run it as `lbzip2 -c -N -n T` with the tar on stdin; without it they fall back to 7-Zip, slower on small tarballs.
if ! command -v lbzip2 >/dev/null 2>&1; then
  fail "lbzip2 is not installed (package lbzip2): tar.bz2 targets of up to two blocks fall back to the slower 7-Zip route"
else
  bzip2_input="$(head -c 4096 /dev/zero | tr '\0' 'x')"
  bzip2_output="$(printf '%s' "$bzip2_input" | sandboxed lbzip2 -c -9 -n 2 2>"$work_dir/lbzip2.err" | sandboxed lbzip2 -d -c 2>>"$work_dir/lbzip2.err")"
  if [ "$bzip2_output" = "$bzip2_input" ]; then
    pass "lbzip2 compressed and decompressed 4096 bytes inside the sandbox"
  else
    fail "lbzip2 did not round-trip inside the sandbox: $(head -c 300 "$work_dir/lbzip2.err" 2>/dev/null)"
  fi
fi

# --- 8. qpdf-runner ------------------------------------------------------------------------------------
# The PDF operations start qpdf jobs in children of qpdf-runner, each in the namespaces `unshare -r -n` makes; --self-test runs one real job the same
# way (fork, unshare, the maps, the limits, libqpdf). When it cannot, the worker runs every job with the qpdf program instead, slower but the same.
if ! command -v qpdf-runner >/dev/null 2>&1; then
  fail "qpdf-runner is not installed: the PDF operations start the qpdf program for every job"
else
  runner_output="$(qpdf-runner --self-test 2>&1)"
  if [ "$runner_output" = "self-test ok" ]; then
    pass "qpdf-runner ran a job in a user and network namespace of its own"
  else
    fail "qpdf-runner could not run an isolated job: $(printf '%s' "$runner_output" | head -c 300)"
  fi
fi

# --- 9. xz ---------------------------------------------------------------------------------------------
# The archive conversions run `xz -T1 -<level> -c -q` under a 1 GiB address space to write a .xz file and `xz -d -T1 -c --memlimit-decompress=256MiB` under
# 512 MiB to read one, with the data on stdin; without it every .xz file is read by the in-process decoder on the event loop and written by the pure encoder,
# and none of the sandbox limits applies. The two limited runs below use the worker's own caps (src/lib/conversions/xz-native.ts), not the 4 GiB of the others.
if ! command -v xz >/dev/null 2>&1; then
  fail "xz is not installed (package xz-utils): .xz files are decoded in the event loop and encoded by the pure encoder"
else
  xz_input="$(head -c 4096 /dev/zero | tr '\0' 'x')"
  xz_output="$(printf '%s' "$xz_input" | sandboxed xz -T1 -6 -c -q 2>"$work_dir/xz.err" | sandboxed xz -d -T1 -c 2>>"$work_dir/xz.err")"
  if [ "$xz_output" = "$xz_input" ]; then
    pass "xz compressed and decompressed 4096 bytes inside the sandbox"
  else
    fail "xz did not round-trip inside the sandbox: $(head -c 300 "$work_dir/xz.err" 2>/dev/null)"
  fi
  xz_capped_output="$(printf '%s' "$xz_input" | sandboxed_as "$XZ_COMPRESS_ADDRESS_SPACE_BYTES" xz -T1 -9 -c -q 2>"$work_dir/xz-capped.err" \
    | sandboxed_as "$XZ_DECODE_ADDRESS_SPACE_BYTES" xz -d -T1 -c "--memlimit-decompress=$XZ_DECODE_MEMLIMIT" 2>>"$work_dir/xz-capped.err")"
  if [ "$xz_capped_output" = "$xz_input" ]; then
    pass "xz -9 compressed under a 1 GiB address space and decompressed under 512 MiB with a 256 MiB decoder limit"
  else
    fail "xz did not round-trip under the worker's address-space caps: $(head -c 300 "$work_dir/xz-capped.err" 2>/dev/null)"
  fi
fi

# The application refuses every ImageMagick conversion (503) when its policy cannot be read by the user it runs as. The build checks it
# too, on the layer of that step; this checks the image as shipped, as that user.
magick_bin="$(command -v magick || command -v magick-im7.q16 || true)"
if [ ! -r /etc/easyconvert/imagemagick/policy.xml ]; then
  fail "the ImageMagick policy /etc/easyconvert/imagemagick/policy.xml is not readable by $(id -un): every ImageMagick conversion answers 503"
elif [ -z "$magick_bin" ]; then
  fail "ImageMagick is not installed"
elif TMPDIR="$work_dir" verify-imagemagick-policy "$magick_bin" /etc/easyconvert/imagemagick >"$work_dir/magick-policy.out" 2>&1; then
  pass "ImageMagick lists only the repository policy for $(id -un)"
else
  fail "the ImageMagick policy does not verify for $(id -un): $(head -c 300 "$work_dir/magick-policy.out")"
fi

# --- 10. pid-init --------------------------------------------------------------------------------------
# Every sandboxed program is started as `unshare -r -n -- pid-init -- <program>`, which puts it in a PID namespace of its own (PID 2, with pid-init's
# init as PID 1), so it can neither see nor signal the other runs of the worker. Without pid-init, or where the profile does not let `clone` make a PID
# namespace, the worker still runs programs in the user and network namespaces, and one run can signal another. The sibling here is a process of this
# script, which the program can signal from outside a PID namespace (the control) and cannot from inside one.
if ! command -v pid-init >/dev/null 2>&1; then
  fail "pid-init is not installed: sandboxed programs share the PID space of the worker"
else
  sleep 30 &
  sibling_pid=$!
  if ! kill -0 "$sibling_pid" 2>/dev/null; then
    fail "the sibling process of the pid-init check did not start"
  else
    pid_output="$(unshare -r -n -- pid-init -- sh -c "echo \"\$\$ \$PPID\"; kill -0 $sibling_pid 2>/dev/null && echo sibling-visible || echo sibling-hidden" 2>&1)"
    if [ "$pid_output" = "$(printf '2 1\nsibling-hidden')" ]; then
      pass "pid-init ran a program as PID 2 of a PID namespace that does not hold its siblings"
    else
      fail "pid-init did not give the program a PID namespace of its own: $(printf '%s' "$pid_output" | tr '\n' ' ' | head -c 300)"
    fi
    # The namespace hides nothing in /proc (it cannot be mounted again here), so the program is also started under a Landlock ruleset that refuses
    # the files of every process but its own. The program reads the command line of the sibling (the control, with --keep-proc) and then fails to.
    kept_output="$(unshare -r -n -- pid-init --keep-proc -- sh -c "( : < /proc/$sibling_pid/cmdline ) 2>/dev/null && echo cmdline-readable || echo cmdline-hidden" 2>&1)"
    hidden_output="$(unshare -r -n -- pid-init -- sh -c "( : < /proc/$sibling_pid/cmdline ) 2>/dev/null && echo cmdline-readable || echo cmdline-hidden; read -r own < /proc/self/status && echo own-readable" 2>&1)"
    if [ "$kept_output" != "cmdline-readable" ]; then
      fail "the control of the /proc check did not read the command line of the sibling: $(printf '%s' "$kept_output" | tr '\n' ' ' | head -c 300)"
    elif [ "$hidden_output" = "$(printf 'cmdline-hidden\nown-readable')" ]; then
      pass "pid-init hid the command line of the sibling in /proc from the program and left it its own entries"
      # A ruleset that did not handle moves between directories would refuse every link and rename between two directories with EXDEV.
      link_dir="$(mktemp -d)"
      if unshare -r -n -- pid-init -- sh -c "mkdir \"$link_dir/a\" \"$link_dir/b\" && : > \"$link_dir/a/f\" && ln \"$link_dir/a/f\" \"$link_dir/b/f\"" >/dev/null 2>&1; then
        pass "pid-init left the program the links between directories"
      else
        fail "the program could not link a file between directories under the pid-init ruleset (EXDEV)"
      fi
      rm -rf "$link_dir"
    else
      fail "pid-init did not hide /proc from the program (Landlock is off in the kernel, or the seccomp profile denies landlock_create_ruleset): $(printf '%s' "$hidden_output" | tr '\n' ' ' | head -c 300)"
    fi
  fi
  kill "$sibling_pid" 2>/dev/null
fi

# --- 11. ONNX OCR helper ------------------------------------------------------------------------------
# The helper (src/lib/conversions/ocr-onnx-helper.ts starts it) loads the two models of /opt/ocr-onnx, says it is ready, and reads a page of raw pixels
# from its standard input. It is started as the worker starts it (unshare -r -n, pid-init, prlimit, node), and this check sends it one real page: a blank
# 200 x 60 image, which the detector reads and the recogniser then reads whole (an image of up to 100 pixels with no box is one line). The check passes
# when a result frame comes back, so session creation AND an inference of both models ran under this container's seccomp profile; a refused system call
# of the runtime shows in the first bytes of the helper's standard error, which are printed on failure.
if [ ! -s /opt/ocr-onnx/rec.onnx ] || [ ! -f "$APP_DIR/dist/ocr-onnx-child.js" ]; then
  fail "the ONNX OCR models (/opt/ocr-onnx) or the helper ($APP_DIR/dist/ocr-onnx-child.js) are missing: Korean pages are read by Tesseract"
else
  cat > "$work_dir/onnx-probe.js" <<'PROBE'
const { spawn } = require('node:child_process');
const command = process.argv.slice(2);
const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
let out = Buffer.alloc(0);
let err = '';
let sent = false;
const finish = (line) => {
  process.stdout.write(line + '\n');
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  process.exit(0);
};
const frame = (header, payload) => {
  const json = Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(json.length, 0);
  prefix.writeUInt32BE(payload ? payload.length : 0, 4);
  return Buffer.concat(payload ? [prefix, json, payload] : [prefix, json]);
};
const timer = setTimeout(() => finish('ONNX-FAIL timeout ' + err.slice(0, 300)), 90000);
child.stderr.on('data', (c) => { if (err.length < 2048) err += c.toString('utf8'); });
child.on('exit', (code) => finish('ONNX-FAIL helper exited with ' + code + ' ' + err.replace(/\s+/g, ' ').slice(0, 300)));
child.stdout.on('data', (chunk) => {
  out = Buffer.concat([out, chunk]);
  while (out.length >= 8) {
    const headerBytes = out.readUInt32BE(0);
    const payloadBytes = out.readUInt32BE(4);
    if (out.length < 8 + headerBytes + payloadBytes) return;
    const header = JSON.parse(out.toString('utf8', 8, 8 + headerBytes));
    out = out.subarray(8 + headerBytes + payloadBytes);
    if (header.type === 'ready' && !sent) {
      sent = true;
      child.stdin.write(frame({ type: 'run', id: 1, width: 200, height: 60, detector: { width: 320, height: 96 }, language: 'kor', recoverSpaces: true }, Buffer.alloc(3 * (200 * 60 + 320 * 96), 255)));
    } else if (header.type === 'result') {
      clearTimeout(timer);
      finish(Array.isArray(header.result && header.result.lineBlocks) ? 'ONNX-OK' : 'ONNX-FAIL a result without lines');
    } else {
      finish('ONNX-FAIL ' + JSON.stringify(header).slice(0, 300));
    }
  }
});
PROBE
  onnx_output="$(timeout 120 node "$work_dir/onnx-probe.js" unshare -r -n -- pid-init -- prlimit --as=$((10 * 1024 * 1024 * 1024)) --cpu=300 -- node "$APP_DIR/dist/ocr-onnx-child.js" --models=/opt/ocr-onnx --threads=1 2>&1 | head -c 600)"
  if [ "$onnx_output" = "ONNX-OK" ]; then
    pass "the ONNX OCR helper loaded its models and read a page (detector and recogniser) in a sandbox of its own under this container's seccomp profile"
  else
    fail "the ONNX OCR helper did not read a page in a sandbox: $(printf '%s' "$onnx_output" | tr '\n' ' ' | head -c 500)"
  fi
fi

if [ "$failures" -eq 0 ]; then
  printf 'All worker container checks passed.\n'
  exit 0
fi
printf '%s worker container check(s) failed.\n' "$failures"
exit 1
