# shellcheck shell=bash
# The checks of scripts/install-djvulibre.sh that decide on the outputs of other programs: the download of the pinned source, the pixels of two
# PDFs, and the status of ddjvu on a chain whose threads cannot all start. They are sourced by the script and by tests/djvulibre-gates.test.ts,
# which runs them against stand-ins for curl, pdftoppm and ddjvu. This file has no effect when sourced but to define its names.

# How long a chain of shared files may take to draw, and the limits of the chain whose threads cannot all start: an address space that holds
# the stacks of about 64 threads of 8 MiB.
CHAIN_DRAW_SECONDS=10
THREAD_CHAIN_ADDRESS_SPACE=$((512 * 1024 * 1024))
THREAD_STACK_KIB=8192
# The exit status of ddjvu when it cannot decode a page (tools/ddjvu.cpp `die`), and of `timeout` when it stops a command.
DDJVU_FAILED=10
TIMED_OUT=124
# The status of a ddjvu that crashed (SIGSEGV) after it printed the error, when the threads of a chain fail together and still look up
# their messages while `exit` destroys the catalog (entry 135 of docs/policy-decisions.md), and of one that `timeout --signal=KILL` stopped.
DDJVU_CRASHED_AT_EXIT=139
KILLED=137
# What ddjvu prints when the decoding of an included file failed (DjVuFile.decode_fail of share/djvu/osi/en/libdjvu++.xml). The program
# prints it in the language of LANGUAGE and LC_MESSAGES (libdjvu/DjVuMessage.cpp) and the package ships de, fr, ja and zh catalogues, so the
# gate pins the language of the English text it looks for.
DECODE_FAILED_TEXT="Decode of an included file failed"
GATE_LANGUAGE=C
GATE_LOCALE=C.UTF-8

# fetch_checked <dir> <archive> <sha256> <source>...: downloads <archive> into <dir> from the first source that serves it with that SHA-256,
# and prints that source.
fetch_checked() {
  local dir="$1" archive="$2" sha256="$3" source
  shift 3
  for source in "$@"; do
    rm -f "$dir/$archive"
    if curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 -o "$dir/$archive" "$source/$archive" \
      && echo "${sha256}  $dir/$archive" | sha256sum --check --strict - >&2; then
      echo "$source"
      return 0
    fi
    echo "$source/$archive did not give the file of SHA-256 $sha256" >&2
  done
  rm -f "$dir/$archive"
  return 1
}

# same_pixels <a.pdf> <b.pdf> <pages>: whether pdftoppm renders each of the two PDFs to <pages> pages, and both to the same pixels.
same_pixels() {
  local pdf page rendered
  for pdf in "$1" "$2"; do
    mkdir "$pdf.pages"
    pdftoppm -r 50 "$pdf" "$pdf.pages/page"
    rendered=$(($(find "$pdf.pages" -name '*.ppm' | wc -l)))
    [ "$rendered" -eq "$3" ] || { echo "$pdf rendered to $rendered pages, not $3" >&2; return 1; }
  done
  for page in "$1.pages"/*.ppm; do
    cmp -s "$page" "$2.pages/$(basename "$page")" || { echo "$(basename "$page") differs" >&2; return 1; }
  done
}

# classify_thread_gate <status> <stderr-file>: whether the status of ddjvu on the chain whose threads cannot all start is the one only the
# thread patch gives: the decode failure (status 10), or the crash at exit after it printed the decode failure (139). A hang (124, 137) means
# the patch is not in the build. The stderr of the run is shown for every status that fails.
classify_thread_gate() {
  case "$1" in
    "$DDJVU_FAILED" | "$DDJVU_CRASHED_AT_EXIT")
      grep -q "$DECODE_FAILED_TEXT" "$2" \
        || { echo "ddjvu ended with status $1 on a chain whose threads cannot all start, without the decode failure:" >&2; cat "$2" >&2; return 1; } ;;
    "$TIMED_OUT" | "$KILLED")
      echo "ddjvu was stopped with status $1 on a chain whose threads cannot all start: the thread patch is not in the build" >&2; cat "$2" >&2; return 1 ;;
    *)
      echo "ddjvu ended with status $1 on a chain whose threads cannot all start:" >&2; cat "$2" >&2; return 1 ;;
  esac
}

# thread_gate <ddjvu> <chain.djvu> <out.pdf> <stderr-file>: draws the chain under THREAD_CHAIN_ADDRESS_SPACE and a stack of THREAD_STACK_KIB,
# stopped after CHAIN_DRAW_SECONDS, in the language the decode failure is looked for in, and classifies how the run ended.
thread_gate() {
  local status=0
  (ulimit -s "$THREAD_STACK_KIB" && exec timeout --signal=KILL "$CHAIN_DRAW_SECONDS" prlimit --as="$THREAD_CHAIN_ADDRESS_SPACE" -- \
    env LANGUAGE="$GATE_LANGUAGE" LC_ALL="$GATE_LOCALE" MALLOC_ARENA_MAX=1 "$1" -format=pdf "$2" "$3") > /dev/null 2> "$4" || status=$?
  classify_thread_gate "$status" "$4"
}
