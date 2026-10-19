// qpdf-runner: starts qpdf jobs from a process that holds libqpdf already loaded.
//
//   qpdf-runner [--lib <soname or path>]     serve jobs on standard input and output (see the frame format below)
//   qpdf-runner --check [--lib <name>]       load the library, print its version and exit 0
//   qpdf-runner --self-test [--lib <name>]   run one job (qpdf --version) in a child of its own, in the namespaces and under the limits
//                                            a real job gets, and print `self-test ok`; exit 1 when the job cannot be run isolated
//
// Starting the qpdf program costs more than a small page operation: 1.26 ms of the 2.14 ms of an extraction go to the dynamic
// linker and the initialisers of its 18 libraries. This program loads libqpdf once (dlopen; the library is never linked in, so its
// licence, Apache-2.0, binds nothing here) and runs every job in a forked child that calls the library entry point of the command
// line, qpdfjob_run_from_argv, with the same arguments, so the output, the messages on standard error and the exit status are those
// of the qpdf program.
//
// Each job gets what a program started through the worker's sandbox gets, and nothing from any other job:
//   - a user namespace and a network namespace of its own, made in the child after the fork and before the library sees a byte of
//     the document (the equivalent of `unshare -r -n`); a child that cannot make them runs nothing and says so (kind SETUP), and
//     the caller falls back to starting the program the way it always has;
//   - the seccomp filter, the capabilities and the limits of this process, which the child inherits, plus no_new_privs, no core
//     dump, and the address-space, file-size and CPU limits of the request;
//   - its own session and process group, the environment of the request only, standard input from the request, standard output
//     and error into pipes read here with a cap, a time limit that covers everything the job started (its group is killed when the job
//     ends, at its limit and on a cancel, while its first process is still unreaped), and death with this process (PR_SET_PDEATHSIG);
//   - no memory of other jobs: the buffers that hold requests, outputs and the data in flight are mapped MADV_DONTFORK, the argument
//     block of a job is wiped as soon as the child exists, and this process and every child are not dumpable, so a process of the
//     same user cannot read them through /proc/<pid>/mem.
//
// Frame format (all integers big-endian): u32 length of the rest | u8 type | u32 id | body.
//   host -> runner
//     RUN    (1): u32 timeout_ms | u64 max_output | u64 limit_as | u64 limit_fsize | u32 limit_cpu | str cwd
//                 | u32 argc | str argv[argc] | u32 envc | str env[envc] | u32 stdin_len | stdin bytes
//                 (a limit of 0 is no limit, except max_output, which is 1 byte to 1 GiB and caps standard output and error together;
//                 a request holds at most 4096 arguments and 4096 environment entries, no string past 64 KB, a frame of at most 4 MiB
//                 and a standard input of at most 32 KB, which goes into the pipe before the fork without the runner waiting for room)
//     CANCEL (2): the id of the job to kill
//   runner -> host
//     READY  (10): str library version | u32 pid of this process        (id 0)
//     RESULT (11): u32 kind | i32 exit status (-1 if signalled) | i32 signal (0 if exited) | u32 stdout_len | u32 stderr_len
//                  | stdout bytes | stderr bytes
//   str is u32 length and the bytes. kind: 0 exited, 1 timeout, 2 output limit, 3 setup failed, 4 cancelled, 5 rejected.
// A request it cannot take, a frame of a type it does not know and a frame past 4 MiB (dropped as it arrives) are answered `rejected` and the
// frames after them are served; only a length that cannot hold the type and the id ends the runner (status 2), as it leaves nothing to find
// the next frame by. The runner ends when standard input closes, taking the jobs with it.
// A job ends when its first process has exited and the streams are closed; it is cut short by its time limit, a cancel or the output cap,
// and one whose streams something it started keeps open is ended EXIT_GRACE_MS after the first process, with that process's result.
// Whatever else the job started is killed with its group when the job ends.

#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/signalfd.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

enum { FRAME_RUN = 1, FRAME_CANCEL = 2, FRAME_READY = 10, FRAME_RESULT = 11 };
enum { KIND_EXITED = 0, KIND_TIMEOUT = 1, KIND_OUTPUT_LIMIT = 2, KIND_SETUP = 3, KIND_CANCELLED = 4, KIND_REJECTED = 5 };
/* Setup failures the child reports through its status pipe, one byte each. */
enum { SETUP_NAMESPACE = 1, SETUP_CHDIR = 2, SETUP_LIMITS = 3, SETUP_STREAMS = 4 };

#define MAX_JOBS 64
#define MAX_FRAME_BYTES (4u * 1024 * 1024)
#define MAX_STDIN_BYTES (32u * 1024)
#define MAX_STRING_BYTES (64u * 1024)
/* A reply carries the output behind a 32-bit length; a request may ask for no more than this much. */
#define MAX_OUTPUT_BYTES (1ull << 30)
#define MAX_ARGS 4096
#define READ_CHUNK_BYTES (64u * 1024)
/* After the first process of a job has exited, the job gets this long to close its standard streams before they are closed for it. */
#define EXIT_GRACE_MS 1000
#define SETUP_EXIT_STATUS 125
#define STATUS_FD 3
#define LIBRARY_SONAMES_FIRST 34
#define LIBRARY_SONAMES_LAST 27
#define VERSION_TEXT_BYTES 64

typedef int (*run_from_argv_fn)(const char *const argv[]);
typedef const char *(*version_fn)(void);

/* ---------------------------------------------------------------------------------------------------------------------------
 * Buffers that no child inherits.
 * ------------------------------------------------------------------------------------------------------------------------ */

typedef struct {
  uint8_t *data;
  size_t len;
  size_t cap; /* a multiple of the page size, or 0 while nothing is mapped */
} Bytes;

static size_t page_size(void) {
  static size_t size;
  if (size == 0) size = (size_t)sysconf(_SC_PAGESIZE);
  return size;
}

static size_t round_up_to_page(size_t n) { return (n + page_size() - 1) / page_size() * page_size(); }

static void die(const char *what) {
  /* Written with write(2): nothing here may use stdio on a descriptor a child shares. */
  static const char prefix[] = "qpdf-runner: ";
  (void)!write(STDERR_FILENO, prefix, sizeof prefix - 1);
  (void)!write(STDERR_FILENO, what, strlen(what));
  (void)!write(STDERR_FILENO, "\n", 1);
  _exit(2);
}

static void *map_private(size_t bytes) {
  void *p = mmap(NULL, bytes, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (p == MAP_FAILED) die("out of memory");
  /* A forked child gets no copy of this mapping. */
  if (madvise(p, bytes, MADV_DONTFORK) != 0) die("madvise(MADV_DONTFORK) failed");
  return p;
}

static void bytes_reserve(Bytes *b, size_t want) {
  if (want <= b->cap) return;
  size_t cap = b->cap * 2 > want ? b->cap * 2 : want;
  cap = round_up_to_page(cap < page_size() ? page_size() : cap);
  if (b->data == NULL) {
    b->data = map_private(cap);
  } else {
    void *moved = mremap(b->data, b->cap, cap, MREMAP_MAYMOVE);
    if (moved == MAP_FAILED) die("out of memory");
    b->data = moved;
  }
  b->cap = cap;
}

static void bytes_append(Bytes *b, const void *src, size_t n) {
  bytes_reserve(b, b->len + n);
  memcpy(b->data + b->len, src, n);
  b->len += n;
}

/* Wipes and unmaps. What a buffer held (a password, a document) does not outlive it. */
static void bytes_release(Bytes *b) {
  if (b->data != NULL) {
    explicit_bzero(b->data, b->cap);
    munmap(b->data, b->cap);
  }
  b->data = NULL;
  b->len = b->cap = 0;
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * Time
 * ------------------------------------------------------------------------------------------------------------------------ */

static int64_t now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * Big-endian fields
 * ------------------------------------------------------------------------------------------------------------------------ */

static void put_u32(Bytes *b, uint32_t v) {
  uint8_t t[4] = {(uint8_t)(v >> 24), (uint8_t)(v >> 16), (uint8_t)(v >> 8), (uint8_t)v};
  bytes_append(b, t, 4);
}

static void put_u32_at(uint8_t *at, uint32_t v) {
  at[0] = (uint8_t)(v >> 24);
  at[1] = (uint8_t)(v >> 16);
  at[2] = (uint8_t)(v >> 8);
  at[3] = (uint8_t)v;
}

static void put_u64(Bytes *b, uint64_t v) {
  put_u32(b, (uint32_t)(v >> 32));
  put_u32(b, (uint32_t)v);
}

static void put_string(Bytes *b, const char *text) {
  put_u32(b, (uint32_t)strlen(text));
  bytes_append(b, text, strlen(text));
}

typedef struct {
  const uint8_t *p;
  size_t left;
  bool bad;
} Cursor;

static const uint8_t *take(Cursor *c, size_t n) {
  if (c->bad || n > c->left) {
    c->bad = true;
    return NULL;
  }
  const uint8_t *at = c->p;
  c->p += n;
  c->left -= n;
  return at;
}

static uint32_t take_u32(Cursor *c) {
  const uint8_t *t = take(c, 4);
  return t == NULL ? 0 : ((uint32_t)t[0] << 24) | ((uint32_t)t[1] << 16) | ((uint32_t)t[2] << 8) | t[3];
}

static uint64_t take_u64(Cursor *c) {
  uint64_t hi = take_u32(c);
  uint64_t lo = take_u32(c);
  return (hi << 32) | lo;
}

/* The bytes of the next string of the frame (u32 length, bytes), or NULL when it is too long or the frame ends. */
static const uint8_t *take_string_bytes(Cursor *c, uint32_t *length) {
  *length = take_u32(c);
  if (*length > MAX_STRING_BYTES) {
    c->bad = true;
    return NULL;
  }
  return take(c, *length);
}

/* The next string as a NUL-terminated copy at *arena, which is sized by the caller to hold every string and its NUL. */
static char *take_string(Cursor *c, char **arena) {
  uint32_t n;
  const uint8_t *s = take_string_bytes(c, &n);
  if (c->bad) return NULL;
  char *out = *arena;
  memcpy(out, s, n);
  out[n] = '\0';
  *arena += n + 1;
  return out;
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * Jobs
 * ------------------------------------------------------------------------------------------------------------------------ */

typedef struct {
  bool used;
  uint32_t id;
  pid_t pid;
  int out_fd, err_fd, status_fd; /* -1 once closed */
  bool exited;        /* the first process has exited; it stays a zombie until the job is finished, so its id and group are not reused */
  bool signalled;     /* it was ended by a signal */
  int exit_status;    /* its exit status, or the signal that ended it */
  int64_t exit_deadline_ms;
  Bytes out, err;
  uint64_t max_output;
  int64_t deadline_ms; /* 0 for none */
  int kill_reason;     /* 0, or the KIND_* that made this process kill the job */
  int setup_failure;   /* 0, or SETUP_* */
} Job;

static Job jobs[MAX_JOBS];
static Bytes control_in;    /* bytes read from the host and not yet parsed */
static Bytes reply_queue;   /* frames waiting to be written */
static size_t reply_offset; /* how much of reply_queue went out */
static Bytes read_scratch;  /* one chunk of a job's output on its way to a job buffer */
static run_from_argv_fn run_from_argv;
static int stdin_pipe_bytes; /* --stdin-pipe-bytes: the capacity given to the pipe of a job's standard input; the tests use it to be a host whose pipes are small */

static void close_fd(int *fd) {
  if (*fd >= 0) close(*fd);
  *fd = -1;
}

static void kill_job(Job *j, int reason) {
  if (j->kill_reason == 0) j->kill_reason = reason;
  /* The first process stays unreaped until the job is finished, so its id is its own and the group it leads can be signalled, whether or not
     the process is still there: the descendants of a job that outlive it are reached by the same call. The group exists once the child has
     called setsid; until then only the process itself can be reached. */
  kill(-j->pid, SIGKILL);
  kill(j->pid, SIGKILL);
}

static void kill_all_jobs(void) {
  for (int i = 0; i < MAX_JOBS; i++) {
    if (jobs[i].used) kill_job(&jobs[i], KIND_CANCELLED);
  }
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * Replies
 * ------------------------------------------------------------------------------------------------------------------------ */

static void queue_frame(uint8_t type, uint32_t id, const uint8_t *body_a, size_t len_a, const uint8_t *body_b, size_t len_b, const uint8_t *body_c, size_t len_c) {
  uint8_t head[9];
  put_u32_at(head, (uint32_t)(5 + len_a + len_b + len_c));
  head[4] = type;
  put_u32_at(head + 5, id);
  bytes_append(&reply_queue, head, sizeof head);
  if (len_a > 0) bytes_append(&reply_queue, body_a, len_a);
  if (len_b > 0) bytes_append(&reply_queue, body_b, len_b);
  if (len_c > 0) bytes_append(&reply_queue, body_c, len_c);
}

static void queue_result(uint32_t id, int kind, int exit_status, int term_signal, const Bytes *out, const Bytes *err) {
  uint8_t fixed[20];
  put_u32_at(fixed, (uint32_t)kind);
  put_u32_at(fixed + 4, (uint32_t)exit_status);
  put_u32_at(fixed + 8, (uint32_t)term_signal);
  put_u32_at(fixed + 12, (uint32_t)(out ? out->len : 0));
  put_u32_at(fixed + 16, (uint32_t)(err ? err->len : 0));
  queue_frame(FRAME_RESULT, id, fixed, sizeof fixed, out ? out->data : NULL, out ? out->len : 0, err ? err->data : NULL, err ? err->len : 0);
}

/* Writes what it can; false once the host is gone. */
static bool flush_replies(void) {
  while (reply_offset < reply_queue.len) {
    ssize_t n = write(STDOUT_FILENO, reply_queue.data + reply_offset, reply_queue.len - reply_offset);
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN) return true;
      return false;
    }
    reply_offset += (size_t)n;
  }
  if (reply_queue.len > 0) {
    bytes_release(&reply_queue);
    reply_offset = 0;
  }
  return true;
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * The child
 * ------------------------------------------------------------------------------------------------------------------------ */

typedef struct {
  uint32_t timeout_ms;
  uint64_t max_output, limit_as, limit_fsize;
  uint32_t limit_cpu;
  const char *cwd;
  char **argv; /* NULL-terminated */
  char **envp; /* NULL-terminated */
  uint32_t stdin_len;
  const uint8_t *stdin_bytes;
  char *arena; /* what argv, envp and cwd point into */
  size_t arena_bytes;
  void *tables;
  size_t table_bytes;
} Request;

static bool write_text_file(const char *path, const char *text) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) return false;
  size_t n = strlen(text);
  ssize_t w = write(fd, text, n);
  close(fd);
  return w == (ssize_t)n;
}

/* The equivalent of `unshare -r -n`: a user namespace that maps the user to root inside it, and an empty network namespace. */
static bool enter_namespaces(void) {
  uid_t uid = geteuid();
  gid_t gid = getegid();
  if (unshare(CLONE_NEWUSER | CLONE_NEWNET) != 0) return false;
  char map[64];
  /* The process must be dumpable for its own uid_map, gid_map and setgroups files to belong to it. */
  prctl(PR_SET_DUMPABLE, 1, 0, 0, 0);
  if (!write_text_file("/proc/self/setgroups", "deny")) return false;
  snprintf(map, sizeof map, "0 %u 1", (unsigned)uid);
  if (!write_text_file("/proc/self/uid_map", map)) return false;
  snprintf(map, sizeof map, "0 %u 1", (unsigned)gid);
  if (!write_text_file("/proc/self/gid_map", map)) return false;
  return geteuid() == 0;
}

static bool apply_limits(const Request *r) {
  struct rlimit zero = {0, 0};
  if (setrlimit(RLIMIT_CORE, &zero) != 0) return false;
  if (r->limit_as > 0) {
    struct rlimit l = {r->limit_as, r->limit_as};
    if (setrlimit(RLIMIT_AS, &l) != 0) return false;
  }
  if (r->limit_fsize > 0) {
    struct rlimit l = {r->limit_fsize, r->limit_fsize};
    if (setrlimit(RLIMIT_FSIZE, &l) != 0) return false;
  }
  if (r->limit_cpu > 0) {
    struct rlimit l = {r->limit_cpu, r->limit_cpu};
    if (setrlimit(RLIMIT_CPU, &l) != 0) return false;
  }
  return true;
}

static void close_descriptors_from(int first) {
  if (syscall(SYS_close_range, (unsigned)first, ~0u, 0) == 0) return;
  long max = sysconf(_SC_OPEN_MAX);
  for (int fd = first; fd < (max > 65536 ? 65536 : max); fd++) close(fd);
}

/* Where the child reports a setup failure: the descriptor it was given until it has moved it to STATUS_FD. */
static int child_status_fd = -1;

static void child_fail(int code) {
  uint8_t b = (uint8_t)code;
  (void)!write(child_status_fd, &b, 1);
  _exit(SETUP_EXIT_STATUS);
}

/* Runs in the forked child; never returns. `in_fd`, `out_fd`, `err_fd` and `status_fd` are the child's ends of the pipes. */
static void run_child(const Request *r, int in_fd, int out_fd, int err_fd, int status_fd) {
  child_status_fd = status_fd;
  sigset_t none;
  sigemptyset(&none);
  sigprocmask(SIG_SETMASK, &none, NULL);
  signal(SIGPIPE, SIG_DFL);
  /* A session of its own: the group this process leads is the one a kill reaches the job and everything it started by. */
  if (setsid() < 0) child_fail(SETUP_STREAMS);
  /* Move the four descriptors to 0, 1, 2 and 3 without trampling each other. */
  int keep[4] = {in_fd, out_fd, err_fd, status_fd};
  for (int i = 0; i < 4; i++) {
    int moved = fcntl(keep[i], F_DUPFD, 10);
    if (moved < 0) child_fail(SETUP_STREAMS);
    keep[i] = moved;
  }
  if (dup2(keep[0], STDIN_FILENO) < 0 || dup2(keep[1], STDOUT_FILENO) < 0 || dup2(keep[2], STDERR_FILENO) < 0 || dup2(keep[3], STATUS_FD) < 0) child_fail(SETUP_STREAMS);
  child_status_fd = STATUS_FD;
  close_descriptors_from(STATUS_FD + 1);
  if (!enter_namespaces()) child_fail(SETUP_NAMESPACE);
  prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
  prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0);
  /* The parent may have died between the fork and here. */
  if (getppid() == 1) _exit(SETUP_EXIT_STATUS);
  if (!apply_limits(r)) child_fail(SETUP_LIMITS);
  if (chdir(r->cwd) != 0) child_fail(SETUP_CHDIR);
  clearenv();
  for (char **e = r->envp; *e != NULL; e++) putenv(*e);
  /* From here the process is not dumpable: a process of the same user cannot read its memory through /proc/<pid>/mem. */
  prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
  close(STATUS_FD);
  int status = run_from_argv((const char *const *)r->argv);
  fflush(NULL);
  _exit(status & 0xff);
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * Requests
 * ------------------------------------------------------------------------------------------------------------------------ */

/* Parses a RUN body. The strings are copied into one arena so that the frame buffer can be wiped at once. */
static bool parse_run(const uint8_t *body, size_t len, Request *r) {
  memset(r, 0, sizeof *r);
  Cursor c = {body, len, false};
  r->timeout_ms = take_u32(&c);
  r->max_output = take_u64(&c);
  r->limit_as = take_u64(&c);
  r->limit_fsize = take_u64(&c);
  r->limit_cpu = take_u32(&c);
  /* A first pass over the strings sizes the arena they are copied into: each needs its bytes and a NUL. */
  Cursor probe = c;
  uint32_t length;
  take_string_bytes(&probe, &length); /* cwd */
  uint32_t argc = take_u32(&probe);
  if (argc == 0 || argc > MAX_ARGS) return false;
  for (uint32_t i = 0; i < argc; i++) take_string_bytes(&probe, &length);
  uint32_t envc = take_u32(&probe);
  if (envc > MAX_ARGS) return false;
  for (uint32_t i = 0; i < envc; i++) take_string_bytes(&probe, &length);
  if (probe.bad) return false;
  size_t strings = 1 + (size_t)argc + envc;
  r->arena_bytes = round_up_to_page(len + strings + 1);
  r->table_bytes = round_up_to_page(((size_t)argc + envc + 2) * sizeof(char *));
  r->arena = mmap(NULL, r->arena_bytes, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  r->tables = mmap(NULL, r->table_bytes, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (r->arena == MAP_FAILED || r->tables == MAP_FAILED) die("out of memory");
  char *arena = r->arena;
  r->cwd = take_string(&c, &arena);
  uint32_t argc2 = take_u32(&c);
  char **table = r->tables;
  r->argv = table;
  for (uint32_t i = 0; i < argc2; i++) table[i] = take_string(&c, &arena);
  table[argc2] = NULL;
  uint32_t envc2 = take_u32(&c);
  r->envp = table + argc2 + 1;
  for (uint32_t i = 0; i < envc2; i++) r->envp[i] = take_string(&c, &arena);
  r->envp[envc2] = NULL;
  r->stdin_len = take_u32(&c);
  /* A claim past the limit is refused, whether or not the bytes it claims follow. */
  if (r->stdin_len > MAX_STDIN_BYTES) return false;
  r->stdin_bytes = take(&c, r->stdin_len);
  return !c.bad && c.left == 0 && r->cwd != NULL && r->cwd[0] == '/';
}

static void release_request(Request *r) {
  if (r->arena != NULL && r->arena != MAP_FAILED) {
    explicit_bzero(r->arena, r->arena_bytes);
    munmap(r->arena, r->arena_bytes);
  }
  if (r->tables != NULL && r->tables != MAP_FAILED) munmap(r->tables, r->table_bytes);
  memset(r, 0, sizeof *r);
}

/* The pipes of a job are the size the system gives them: 256 KiB of pipe memory per job at most, 16 MiB at 64 jobs of the 64 MiB a user may hold
   before new pipes shrink to one page. A larger size measured the same (50 MB of output in 49.7 to 51.4 ms with 64 or 256 KiB). */
static int make_pipe(int fds[2]) { return pipe2(fds, O_CLOEXEC); }

static void set_nonblocking(int fd) { fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK); }

static void reject(uint32_t id, const char *reason) {
  Bytes why = {0};
  bytes_append(&why, reason, strlen(reason));
  queue_result(id, KIND_REJECTED, -1, 0, NULL, &why);
  bytes_release(&why);
}

static void start_job(uint32_t id, const uint8_t *body, size_t len) {
  Job *slot = NULL;
  for (int i = 0; i < MAX_JOBS; i++) {
    if (jobs[i].used && jobs[i].id == id) {
      reject(id, "duplicate id");
      return;
    }
    if (!jobs[i].used && slot == NULL) slot = &jobs[i];
  }
  if (slot == NULL) {
    reject(id, "too many jobs");
    return;
  }
  Request r;
  if (!parse_run(body, len, &r) || r.max_output == 0 || r.max_output > MAX_OUTPUT_BYTES) {
    release_request(&r);
    reject(id, "malformed request");
    return;
  }
  int in_p[2] = {-1, -1}, out_p[2] = {-1, -1}, err_p[2] = {-1, -1}, st_p[2] = {-1, -1};
  if (make_pipe(in_p) != 0 || make_pipe(out_p) != 0 || make_pipe(err_p) != 0 || make_pipe(st_p) != 0) {
    int fds[8] = {in_p[0], in_p[1], out_p[0], out_p[1], err_p[0], err_p[1], st_p[0], st_p[1]};
    for (int i = 0; i < 8; i++) if (fds[i] >= 0) close(fds[i]);
    release_request(&r);
    reject(id, "no descriptors");
    return;
  }
  if (stdin_pipe_bytes > 0) (void)fcntl(in_p[0], F_SETPIPE_SZ, stdin_pipe_bytes);
  /* The standard input goes into the pipe before the fork, and this process never waits for room in it: a pipe the system made small (a
     user over the budget for pipe memory gets one page) is asked for its capacity, the write does not block, and anything but the whole
     input written is a refusal that makes the caller start the job another way. */
  set_nonblocking(in_p[1]);
  if (r.stdin_len > 0) {
    int capacity = fcntl(in_p[1], F_GETPIPE_SZ);
    ssize_t written = capacity >= (int)r.stdin_len ? write(in_p[1], r.stdin_bytes, r.stdin_len) : -1;
    if (written != (ssize_t)r.stdin_len) {
      int fds[8] = {in_p[0], in_p[1], out_p[0], out_p[1], err_p[0], err_p[1], st_p[0], st_p[1]};
      for (int i = 0; i < 8; i++) close(fds[i]);
      release_request(&r);
      reject(id, "standard input does not fit its pipe");
      return;
    }
  }
  close(in_p[1]);
  pid_t pid = fork();
  if (pid == 0) {
    close(out_p[0]);
    close(err_p[0]);
    close(st_p[0]);
    run_child(&r, in_p[0], out_p[1], err_p[1], st_p[1]);
  }
  close(in_p[0]);
  close(out_p[1]);
  close(err_p[1]);
  close(st_p[1]);
  const uint64_t max_output = r.max_output;
  const uint32_t timeout_ms = r.timeout_ms;
  release_request(&r);
  if (pid < 0) {
    close(out_p[0]);
    close(err_p[0]);
    close(st_p[0]);
    reject(id, "fork failed");
    return;
  }
  set_nonblocking(out_p[0]);
  set_nonblocking(err_p[0]);
  set_nonblocking(st_p[0]);
  memset(slot, 0, sizeof *slot);
  slot->used = true;
  slot->id = id;
  slot->pid = pid;
  slot->out_fd = out_p[0];
  slot->err_fd = err_p[0];
  slot->status_fd = st_p[0];
  slot->max_output = max_output;
  slot->deadline_ms = timeout_ms > 0 ? now_ms() + timeout_ms : 0;
}

static void handle_frame(uint8_t type, uint32_t id, const uint8_t *body, size_t len) {
  if (type == FRAME_RUN) {
    start_job(id, body, len);
  } else if (type == FRAME_CANCEL) {
    for (int i = 0; i < MAX_JOBS; i++) {
      if (jobs[i].used && jobs[i].id == id) kill_job(&jobs[i], KIND_CANCELLED);
    }
  } else {
    reject(id, "unknown frame type");
  }
}

static uint32_t be32(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }

/* Bytes of a frame past the limit that are still to come and are dropped as they arrive. */
static uint64_t skip_remaining;

/* Parses every whole frame in control_in; the bytes of a frame are wiped as soon as it is handled. A frame past the limit is answered
   (its id is in the first nine bytes) and its bytes are dropped without being held, so the frames after it are read; only a length that
   cannot hold the type and the id leaves nothing to find the next frame by. */
static void parse_control(void) {
  size_t at = 0;
  while (control_in.len - at >= 4) {
    const uint8_t *h = control_in.data + at;
    uint32_t length = be32(h);
    if (length < 5) die("frame length out of range");
    size_t have = control_in.len - at;
    if (length > MAX_FRAME_BYTES) {
      if (have < 9) break;
      reject(be32(h + 5), "frame past the limit");
      uint64_t total = 4 + (uint64_t)length;
      size_t dropped = have < total ? have : (size_t)total;
      explicit_bzero(control_in.data + at, dropped);
      at += dropped;
      skip_remaining = total - dropped;
      continue;
    }
    if (have < 4 + (size_t)length) break;
    handle_frame(h[4], be32(h + 5), h + 9, length - 5);
    explicit_bzero(control_in.data + at, 4 + (size_t)length);
    at += 4 + (size_t)length;
  }
  if (at > 0) {
    memmove(control_in.data, control_in.data + at, control_in.len - at);
    control_in.len -= at;
  }
}

/* Takes bytes the host wrote: the end of an oversized frame is dropped, the rest is parsed. */
static void control_feed(const uint8_t *data, size_t n) {
  if (skip_remaining > 0) {
    size_t drop = n < skip_remaining ? n : (size_t)skip_remaining;
    skip_remaining -= drop;
    data += drop;
    n -= drop;
  }
  if (n == 0) return;
  bytes_append(&control_in, data, n);
  parse_control();
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * Job output and completion
 * ------------------------------------------------------------------------------------------------------------------------ */

static void drain(Job *j, int *fd, Bytes *into) {
  while (*fd >= 0) {
    ssize_t n = read(*fd, read_scratch.data, READ_CHUNK_BYTES);
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN) return;
      close_fd(fd);
      return;
    }
    if (n == 0) {
      close_fd(fd);
      return;
    }
    if (j->kill_reason == 0 && (uint64_t)(j->out.len + j->err.len) + (uint64_t)n > j->max_output && j->max_output > 0) {
      kill_job(j, KIND_OUTPUT_LIMIT);
    }
    if (j->kill_reason != 0) continue; /* a killed job's output is read and dropped so that its pipes close */
    bytes_append(into, read_scratch.data, (size_t)n);
  }
}

/* Ends a job: whatever its first process left running is killed (a process that closed the streams and stayed would be an orphan of nobody),
   the process is reaped, and the reply is queued. */
static void finish_job(Job *j) {
  kill(-j->pid, SIGKILL);
  waitpid(j->pid, NULL, 0);
  uint8_t setup = 0;
  if (j->status_fd >= 0) {
    (void)!read(j->status_fd, &setup, 1);
    close_fd(&j->status_fd);
  }
  if (j->kill_reason != 0) {
    queue_result(j->id, j->kill_reason, -1, 0, &j->out, &j->err);
  } else if (setup != 0) {
    Bytes code = {0};
    bytes_append(&code, &setup, 1);
    queue_result(j->id, KIND_SETUP, -1, 0, NULL, &code);
    bytes_release(&code);
  } else if (!j->signalled) {
    queue_result(j->id, KIND_EXITED, j->exit_status, 0, &j->out, &j->err);
  } else {
    queue_result(j->id, KIND_EXITED, -1, j->exit_status, &j->out, &j->err);
  }
  bytes_release(&j->out);
  bytes_release(&j->err);
  memset(j, 0, sizeof *j);
}

/* Notes the jobs whose first process has exited, and leaves the process unreaped (WNOWAIT): its id stays its own, so the group it leads can
   be signalled until the job is finished. */
static void poll_exits(void) {
  for (int i = 0; i < MAX_JOBS; i++) {
    Job *j = &jobs[i];
    if (!j->used || j->exited) continue;
    siginfo_t info;
    memset(&info, 0, sizeof info);
    if (waitid(P_PID, (id_t)j->pid, &info, WEXITED | WNOHANG | WNOWAIT) == 0 && info.si_pid == j->pid) {
      j->exited = true;
      j->signalled = info.si_code != CLD_EXITED;
      j->exit_status = info.si_status;
      j->exit_deadline_ms = now_ms() + EXIT_GRACE_MS;
    }
  }
}

/* The time limit, the grace after the first process, and the end of a job apply to every job that is not finished, whether or not its first
   process is still there. */
static void check_jobs(void) {
  int64_t now = now_ms();
  for (int i = 0; i < MAX_JOBS; i++) {
    Job *j = &jobs[i];
    if (!j->used) continue;
    if (j->kill_reason == 0 && j->deadline_ms != 0 && now >= j->deadline_ms) kill_job(j, KIND_TIMEOUT);
    if (!j->exited) continue;
    bool streams_closed = j->out_fd < 0 && j->err_fd < 0;
    bool grace_over = j->kill_reason == 0 && now >= j->exit_deadline_ms;
    if (streams_closed || j->kill_reason != 0 || grace_over) {
      /* The streams of a killed job, or of one that left a process holding them, are not waited for. */
      close_fd(&j->out_fd);
      close_fd(&j->err_fd);
      finish_job(j);
    }
  }
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * The loop
 * ------------------------------------------------------------------------------------------------------------------------ */

static void shutdown_runner(int status) {
  kill_all_jobs();
  _exit(status);
}

static int next_timeout_ms(void) {
  int64_t soonest = 0;
  for (int i = 0; i < MAX_JOBS; i++) {
    const Job *j = &jobs[i];
    if (!j->used || j->kill_reason != 0) continue;
    int64_t due = j->deadline_ms;
    if (j->exited && (due == 0 || j->exit_deadline_ms < due)) due = j->exit_deadline_ms;
    if (due != 0 && (soonest == 0 || due < soonest)) soonest = due;
  }
  if (soonest == 0) return -1;
  int64_t wait = soonest - now_ms();
  return wait < 0 ? 0 : (wait > INT_MAX ? INT_MAX : (int)wait);
}

static void serve(int signal_fd) {
  set_nonblocking(STDIN_FILENO);
  set_nonblocking(STDOUT_FILENO);
  struct pollfd fds[2 + 3 * MAX_JOBS];
  Job *owner[2 + 3 * MAX_JOBS];
  int *which[2 + 3 * MAX_JOBS];
  bool exits_to_note = false;
  for (;;) {
    int n = 0;
    fds[n] = (struct pollfd){STDIN_FILENO, POLLIN, 0};
    owner[n] = NULL;
    n++;
    fds[n] = (struct pollfd){signal_fd, POLLIN, 0};
    owner[n] = NULL;
    n++;
    for (int i = 0; i < MAX_JOBS; i++) {
      Job *j = &jobs[i];
      if (!j->used) continue;
      int *list[2] = {&j->out_fd, &j->err_fd};
      for (int k = 0; k < 2; k++) {
        if (*list[k] < 0) continue;
        fds[n] = (struct pollfd){*list[k], POLLIN, 0};
        owner[n] = j;
        which[n] = list[k];
        n++;
      }
    }
    /* Standard output is polled for room only while replies wait. */
    fds[n] = (struct pollfd){STDOUT_FILENO, reply_offset < reply_queue.len ? POLLOUT : 0, 0};
    owner[n] = NULL;
    int out_index = n++;
    int ready = poll(fds, (nfds_t)n, next_timeout_ms());
    if (ready < 0 && errno != EINTR) die("poll failed");
    if (ready > 0) {
      if (fds[1].revents & POLLIN) {
        struct signalfd_siginfo info;
        while (read(signal_fd, &info, sizeof info) == (ssize_t)sizeof info) {
          if (info.ssi_signo != SIGCHLD) shutdown_runner(0);
          exits_to_note = true;
        }
      }
      if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
        ssize_t got = read(STDIN_FILENO, read_scratch.data, READ_CHUNK_BYTES);
        if (got == 0) shutdown_runner(0);
        if (got > 0) {
          control_feed(read_scratch.data, (size_t)got);
          explicit_bzero(read_scratch.data, (size_t)got);
        } else if (errno != EAGAIN && errno != EINTR) {
          shutdown_runner(0);
        }
      }
      for (int i = 2; i < out_index; i++) {
        if (fds[i].revents & (POLLIN | POLLHUP | POLLERR)) {
          Job *j = owner[i];
          drain(j, which[i], which[i] == &j->out_fd ? &j->out : &j->err);
          explicit_bzero(read_scratch.data, READ_CHUNK_BYTES);
        }
      }
    }
    if (exits_to_note) {
      poll_exits();
      exits_to_note = false;
    }
    check_jobs();
    if (!flush_replies()) shutdown_runner(0);
  }
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * Start
 * ------------------------------------------------------------------------------------------------------------------------ */

/* One real job through the same child code a request gets, read back here: proves that this host lets a job make its namespaces. */
static int self_test(void) {
  Bytes body = {0};
  put_u32(&body, 10000);
  put_u64(&body, 1 << 20);
  put_u64(&body, 0);
  put_u64(&body, 0);
  put_u32(&body, 0);
  put_string(&body, "/");
  put_u32(&body, 2);
  put_string(&body, "qpdf");
  put_string(&body, "--version");
  put_u32(&body, 0);
  put_u32(&body, 0);
  Request r;
  if (!parse_run(body.data, body.len, &r)) return 1;
  int in_p[2], out_p[2], err_p[2], st_p[2];
  if (make_pipe(in_p) != 0 || make_pipe(out_p) != 0 || make_pipe(err_p) != 0 || make_pipe(st_p) != 0) return 1;
  close(in_p[1]);
  pid_t pid = fork();
  if (pid == 0) run_child(&r, in_p[0], out_p[1], err_p[1], st_p[1]);
  close(in_p[0]);
  close(out_p[1]);
  close(err_p[1]);
  close(st_p[1]);
  if (pid < 0) return 1;
  char out[256] = {0}, err[256] = {0};
  uint8_t setup = 0;
  ssize_t n_out = read(out_p[0], out, sizeof out - 1);
  ssize_t n_err = read(err_p[0], err, sizeof err - 1);
  ssize_t n_setup = read(st_p[0], &setup, 1);
  int wstatus = 0;
  waitpid(pid, &wstatus, 0);
  if (n_setup > 0) {
    fprintf(stderr, "self-test: the job could not be isolated (step %d): is unshare allowed for this user?\n", setup);
    return 1;
  }
  if (!WIFEXITED(wstatus) || WEXITSTATUS(wstatus) != 0 || n_out < 12 || strncmp(out, "qpdf version", 12) != 0) {
    fprintf(stderr, "self-test: the job failed (status %d): %.*s\n", wstatus, (int)(n_err > 0 ? n_err : 0), err);
    return 1;
  }
  puts("self-test ok");
  return 0;
}

static void *open_library(const char *requested) {
  if (requested != NULL) return dlopen(requested, RTLD_NOW | RTLD_LOCAL);
  char name[VERSION_TEXT_BYTES];
  for (int soname = LIBRARY_SONAMES_FIRST; soname >= LIBRARY_SONAMES_LAST; soname--) {
    snprintf(name, sizeof name, "libqpdf.so.%d", soname);
    void *handle = dlopen(name, RTLD_NOW | RTLD_LOCAL);
    if (handle != NULL) return handle;
  }
  return NULL;
}

int main(int argc, char **argv) {
  const char *library = NULL;
  bool check_only = false;
  bool self_testing = false;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--lib") == 0 && i + 1 < argc) library = argv[++i];
    else if (strcmp(argv[i], "--check") == 0) check_only = true;
    else if (strcmp(argv[i], "--self-test") == 0) self_testing = true;
    else if (strcmp(argv[i], "--stdin-pipe-bytes") == 0 && i + 1 < argc) stdin_pipe_bytes = atoi(argv[++i]);
    else {
      fputs("usage: qpdf-runner [--check | --self-test] [--lib <soname or path>] [--stdin-pipe-bytes <n>]\n", stderr);
      return 2;
    }
  }
  void *handle = open_library(library);
  if (handle == NULL) {
    fprintf(stderr, "qpdf-runner: cannot load libqpdf: %s\n", dlerror());
    return 3;
  }
  version_fn version = NULL;
  /* dlsym returns an object pointer; this is the form POSIX gives for a function. */
  *(void **)(&run_from_argv) = dlsym(handle, "qpdfjob_run_from_argv");
  *(void **)(&version) = dlsym(handle, "qpdf_get_qpdf_version");
  if (run_from_argv == NULL) {
    fputs("qpdf-runner: libqpdf has no qpdfjob_run_from_argv\n", stderr);
    return 3;
  }
  const char *version_text = version != NULL ? version() : "unknown";
  if (check_only) {
    printf("%s\n", version_text);
    return 0;
  }

  if (self_testing) return self_test();

  /* A process of the same user must not read this one's memory, which holds requests and outputs in flight. */
  prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
  sigset_t blocked;
  sigemptyset(&blocked);
  sigaddset(&blocked, SIGCHLD);
  sigaddset(&blocked, SIGTERM);
  sigaddset(&blocked, SIGINT);
  sigaddset(&blocked, SIGHUP);
  sigaddset(&blocked, SIGPIPE);
  sigprocmask(SIG_BLOCK, &blocked, NULL);
  sigset_t watched = blocked;
  sigdelset(&watched, SIGPIPE);
  int signal_fd = signalfd(-1, &watched, SFD_CLOEXEC | SFD_NONBLOCK);
  if (signal_fd < 0) die("signalfd failed");
  bytes_reserve(&read_scratch, READ_CHUNK_BYTES);
  bytes_reserve(&control_in, READ_CHUNK_BYTES);

  Bytes hello = {0};
  put_u32(&hello, (uint32_t)strlen(version_text));
  bytes_append(&hello, version_text, strlen(version_text));
  put_u32(&hello, (uint32_t)getpid());
  queue_frame(FRAME_READY, 0, hello.data, hello.len, NULL, 0, NULL, 0);
  bytes_release(&hello);
  serve(signal_fd);
  return 0;
}
