#!/usr/bin/env python3
"""Feeds mutated and random frames to qpdf-runner and reports any run that ends by a signal, hangs, or makes a sanitizer speak.

  fuzz-frames.py <runner> <library> <runs> <seed>

Build the runner with the sanitizers first, and give it the stand-in library of the tests (tests/helpers/qpdf-runner-probe.c, built with
`cc -shared -fPIC`) so that no real PDF is needed:

  cc -std=gnu11 -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=undefined -o /tmp/qpdf-runner-asan native/qpdf-runner/qpdf-runner.c -ldl

Run it as an unprivileged user (the jobs then stop at their namespaces) and as root (they run). A frame the runner cannot read ends it with status 2;
anything but status 0 or 2 is reported.
"""
import os, random, struct, subprocess, sys, tempfile, time
def executable(path):
    """The absolute path of an existing file given on the command line, or exit: no shell runs it, and nothing else is accepted."""
    full = os.path.realpath(path)
    if not os.path.isfile(full):
        sys.exit(f"not a file: {path}")
    return full
BIN, LIB = executable(sys.argv[1]), executable(sys.argv[2])
N = int(sys.argv[3]); seed = int(sys.argv[4])
# A seeded, reproducible generator is what a fuzzer needs to replay a failing run; it makes no secret.
rng = random.Random(seed)  # NOSONAR
# The jobs work in a private directory of this run, not in a shared one.
WORK = tempfile.mkdtemp(prefix="qpdf-runner-fuzz-").encode()
def s(b): return struct.pack(">I", len(b)) + b
def run_frame(i, cwd=WORK, argv=(b"qpdf", b"echo-stdin"), env=(b"A=1",), stdin=b"hello", t=2000, mx=100000, a=0, f=0, c=0):
    body = struct.pack(">IQQQI", t, mx, a, f, c) + s(cwd) + struct.pack(">I", len(argv)) + b"".join(s(x) for x in argv) + struct.pack(">I", len(env)) + b"".join(s(x) for x in env) + struct.pack(">I", len(stdin)) + stdin
    return struct.pack(">IBI", 5 + len(body), 1, i) + body
def mutate(b):
    b = bytearray(b)
    for _ in range(rng.randint(1, 6)):
        k = rng.random()
        if k < 0.5 and b: b[rng.randrange(len(b))] ^= 1 << rng.randrange(8)
        elif k < 0.7 and b: b[rng.randrange(len(b))] = rng.choice([0, 0xff, 0x7f, 0x80])
        elif k < 0.85: del b[rng.randrange(len(b)+1):]
        else: b += rng.randbytes(rng.randint(1, 40))
    return bytes(b)
bad = 0; statuses = {}
t0 = time.time()
for n in range(N):
    base = run_frame(n + 1) + run_frame(n + 2, argv=(b"qpdf", b"exit", b"3")) + (struct.pack(">IBI", 5, 2, 1))
    data = mutate(base) if rng.random() < 0.8 else rng.randbytes(rng.randint(1, 300))
    p = subprocess.Popen([BIN, "--lib", LIB], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        out, err = p.communicate(data, timeout=8)
    except subprocess.TimeoutExpired:
        p.kill(); out, err = p.communicate(); print("HANG", data.hex()[:200]); bad += 1; continue
    statuses[p.returncode] = statuses.get(p.returncode, 0) + 1
    if p.returncode not in (0, 2) or b"Sanitizer" in err or b"runtime error" in err:
        bad += 1; print("BAD", p.returncode, err[:300], data.hex()[:200])
os.rmdir(WORK)
print("runs", N, "seed", seed, "statuses", statuses, "problems", bad, "seconds", round(time.time() - t0))
