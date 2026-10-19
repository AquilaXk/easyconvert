#!/usr/bin/env python3
"""Feeds mutated and random frames to qpdf-runner and reports any run that ends by a signal, hangs, or makes a sanitizer speak.

  fuzz-frames.py <runs> <seed>

It builds the runner from native/qpdf-runner/qpdf-runner.c with AddressSanitizer and UBSan, and the stand-in library of the tests
(tests/helpers/qpdf-runner-probe.c) so that no real PDF is needed, in a private directory of its own, and runs those two builds. Nothing
that is run comes from the command line: the arguments are two numbers.

Run it as an unprivileged user (the jobs then stop at their namespaces) and as root (they run). A frame the runner cannot read ends it with status 2;
anything but status 0 or 2 is reported.
"""
import os, random, shutil, struct, subprocess, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__))
COMPILER = "/usr/bin/cc"
# The jobs, the builds and the files of this run live in a private directory, not in a shared one.
WORK_DIR = tempfile.mkdtemp(prefix="qpdf-runner-fuzz-")
BIN = os.path.join(WORK_DIR, "qpdf-runner-asan")
LIB = os.path.join(WORK_DIR, "probe.so")
WORK = WORK_DIR.encode()
def build():
    """The sanitizer build of the runner and the stand-in library; exits when a compile fails."""
    sanitize = ["-std=gnu11", "-O1", "-g", "-fno-omit-frame-pointer", "-fsanitize=address,undefined", "-fno-sanitize-recover=undefined"]
    runner = [COMPILER, *sanitize, "-o", BIN, os.path.join(HERE, "qpdf-runner.c"), "-ldl"]
    probe = [COMPILER, "-shared", "-fPIC", "-o", LIB, os.path.join(HERE, "..", "..", "tests", "helpers", "qpdf-runner-probe.c")]
    for command in (runner, probe):
        if subprocess.run(command, check=False).returncode != 0:
            shutil.rmtree(WORK_DIR)
            sys.exit("the build failed")
N = int(sys.argv[1]); seed = int(sys.argv[2])
# A seeded, reproducible generator is what a fuzzer needs to replay a failing run; it makes no secret.
rng = random.Random(seed)  # NOSONAR
build()
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
shutil.rmtree(WORK_DIR)
print("runs", N, "seed", seed, "statuses", statuses, "problems", bad, "seconds", round(time.time() - t0))
