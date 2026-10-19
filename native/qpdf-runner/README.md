# qpdf-runner

Runs the qpdf jobs of the PDF operations from a process that holds `libqpdf` already loaded, instead of starting the `qpdf` program for each
job. The start of `qpdf` (the dynamic linker and the initialisers of its libraries) is 1.26 ms of the 2.14 ms of an extraction; a job in a forked
child of the runner takes 0.8 ms of work and about 0.4 ms around it. Policy entry 60 has the measurements and the decision.

- `qpdf-runner.c`: the program (C, no dependency beyond libc and `libdl`). The header comment holds the frame format and the list of what each job
  gets and what it does not share with any other job.
- `build.sh <output>`: builds it with a C compiler only. `libqpdf` is opened with `dlopen` at run time and is never linked in.
- `qpdf-runner --check`: loads the library, prints its version. `qpdf-runner --self-test`: runs one job in a child of its own in the namespaces
  and under the limits a real job gets (`scripts/verify-worker-container.sh` runs it inside the worker container).
- `qpdf-runner --stdin-pipe-bytes <n>`: gives the pipe of a job's standard input `n` bytes of capacity, which the tests use to be a host whose pipes are small.
- `fuzz-frames.py`: feeds mutated frames to a sanitizer build.
- The host side is `src/lib/conversions/pdf-postprocess/qpdf-runner.ts`; `QPDF_RUNNER=off` turns the runner off, and any job it declines or
  cannot isolate runs with the `qpdf` program as before. Tests: `tests/qpdf-runner.test.ts` (a stand-in library reports what the job's process is
  like) and `tests/qpdf-runner-qpdf.test.ts` (the real library against the program, byte for byte).
