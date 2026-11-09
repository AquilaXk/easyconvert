// pid-init: runs a program in a PID namespace of its own, with the program as PID 2 and this code as PID 1.
//
//   pid-init [--keep-proc] -- <program> [argument...]
//   pid-init --no-pid-namespace [--keep-proc] -- <program> [argument...]
//   pid-init --check
//
// It is started inside a user namespace (`unshare -r -n -- pid-init -- ...`), where it holds the capability to make a PID namespace.
//
// Why not `unshare -p --fork -- <program>`: the program would be PID 1 of the namespace, and the kernel does not deliver to PID 1 a
// signal it has no handler for unless the sender is outside the namespace. The signals a run is judged by are lost that way: SIGXFSZ
// (the file size limit) is ignored and the write fails with EFBIG instead, abort() ends in a fault instead of SIGABRT, and a program
// that signals itself keeps running. Here the program is PID 2, so it dies of its signals as it does anywhere else, and this process
// reports how it ended to the process outside the namespace, which ends in the same way: the caller sees the exit status or the
// signal of the program, not of a wrapper.
//
// Three processes take part:
//   - this one, outside the namespace, which forks PID 1 and waits for the report;
//   - PID 1, which forks the program, reaps every process that is left without a parent in the namespace, and writes the wait status of
//     the program into a pipe when the program has ended (the namespace, with whatever the program left running, ends with it);
//   - the program.
// PID 1 dies with this process (PR_SET_PDEATHSIG), so killing this process, or its process group, ends the program too. The signal is
// asked for after the fork, so a process killed in between would leave PID 1 and the program running unwatched: this process holds the
// write end of a pipe for as long as it lives, and PID 1 looks at the other end once the signal is set (a closed end means this process is
// already gone). A report that never arrives means PID 1 was killed, and this process kills itself the same way.
//
// The program also cannot read what the other runs of the worker have in /proc. A PID namespace hides nothing there: /proc is the container's
// own mount, it shows every process of the container by its number in the outer namespace, and it cannot be mounted again inside the
// namespace (the worker's seccomp profile has no mount call and its AppArmor profile denies mount, and a container's /proc has masked paths
// that make a new mount fail). So the program is started under a Landlock ruleset (no mount, no privilege) that handles reading and writing
// files and allows both below every entry of / except /proc, and below every entry of /proc except the numbered directories of processes.
// /proc/self (and so /proc/thread-self) is among the entries it allows, and it names the directory of the program itself. What is left
// outside the rules is /proc/<number> of every other process: the command line, the status, the OOM score and the rest of another run are
// refused with EACCES, and so are those of a process the program forks, which has a directory of its own that no rule can name beforehand.
// `--no-pid-namespace` does only this and runs the program in place (no fork, no PID 1), for the programs that cannot live in a PID
// namespace; `--keep-proc` leaves /proc as it is; `--check` exits 0 when the ruleset can be made on this host and 3 when it cannot.
// A host that cannot make the ruleset (Landlock off in the kernel, or a profile that denies the calls) runs the program without it, and says
// so on the standard error of the program with one line that starts `pid-init: /proc not hidden:` (the worker takes it off again and logs it).
// The inodes of /proc are made again whenever a directory entry has been dropped from the cache (memory pressure, drop_caches), and a rule
// belongs to the inode it was made for: a rule on /proc/meminfo, /proc/sys or the directory of the program itself would stop matching, and the
// program would lose that file. So every /proc entry a rule names is kept open for as long as the program runs: PID 1 holds the descriptors
// in the PID namespace (the program sends them over a socket before it executes), and with --no-pid-namespace, where nothing stays behind
// the program, they are descriptors of the program itself, numbered 200 and up.
// The ruleset also handles LANDLOCK_ACCESS_FS_REFER where the kernel knows it (Linux 5.19): a ruleset that does not handle it refuses every
// rename and link between directories with EXDEV. On the first Landlock version (Linux 5.13 to 5.18) that cannot be avoided, so the
// ruleset is not made there.
//
// Exit status: that of the program; 127 when it is not found and 126 when it cannot be run (as a shell and `unshare` say); 125 when the
// namespace cannot be made.

#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#define EXIT_NAMESPACE 125
#define EXIT_CANNOT_RUN 126
#define EXIT_NOT_FOUND 127
#define EXIT_NO_LANDLOCK 3

/* The Landlock interface (Linux 5.13), declared here so that the build does not depend on the version of the kernel headers. */
#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#define LANDLOCK_ACCESS_FS_WRITE_FILE (1ULL << 1)
#define LANDLOCK_ACCESS_FS_READ_FILE (1ULL << 2)
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#define LANDLOCK_RULE_PATH_BENEATH 1
/* The first descriptor number the kept /proc entries take when they stay in the program (--no-pid-namespace). */
#define PIN_FD_FLOOR 200
/* How many /proc entries may be kept open, and how many descriptors go in one message to PID 1 (the kernel takes 253). */
#define PIN_MAX 1024
#define PIN_BATCH 128
/* What is said on the standard error of the program when /proc is not hidden; the worker looks for it at the start of the output. */
#define NOT_HIDDEN_NOTICE "pid-init: /proc not hidden: "

/* Why the last attempt to hide /proc failed, for the notice. */
static const char *hide_failure = "";
static int refer_handled = 0;
/* The /proc entries the ruleset names, open: a rule belongs to an inode that /proc makes again once the entry is dropped from the cache. */
static int pinned[PIN_MAX];
static int pinned_count = 0;

struct landlock_ruleset_attr_v1 {
  uint64_t handled_access_fs;
};
struct landlock_path_beneath_attr_v1 {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

/* Allows reading and writing files below `path` (and moving them between directories where the kernel has that right). An entry that is not
   there (a dangling link, a process that ended) or that this process may not look at adds nothing; any other failure (out of descriptors, a
   refused rule) returns -1, because a rule that is missing takes a whole directory away from the program and the ruleset must not be put in
   force then. With `keep` the entry stays open (see pinned). */
static int allow_below(int ruleset, const char *path, int keep) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT || errno == EACCES || errno == ELOOP || errno == ENOTDIR || errno == ENXIO ? 0 : -1;
  struct landlock_path_beneath_attr_v1 rule = {.allowed_access = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE, .parent_fd = fd};
  struct stat st;
  /* The right to move is one of directories; a rule on a file that names it is refused. */
  if (refer_handled && fstat(fd, &st) == 0 && S_ISDIR(st.st_mode)) rule.allowed_access |= LANDLOCK_ACCESS_FS_REFER;
  int added = (int)syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
  if (added == 0 && keep && pinned_count < PIN_MAX) {
    pinned[pinned_count++] = fd;
    return 0;
  }
  close(fd);
  return added == 0 && keep ? -1 : added;
}

static int is_number(const char *name) {
  if (*name == '\0') return 0;
  for (; *name; name++) {
    if (*name < '0' || *name > '9') return 0;
  }
  return 1;
}

/* Allows every entry of `parent`: all but "proc" for the root directory, and all but the process numbers (kept open) for /proc. */
static int allow_entries(int ruleset, const char *parent, int proc_entries) {
  DIR *directory = opendir(parent);
  if (directory == NULL) return -1;
  int result = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    const char *name = entry->d_name;
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) continue;
    if (proc_entries ? is_number(name) : strcmp(name, "proc") == 0) continue;
    char path[512];
    if (snprintf(path, sizeof path, "%s/%s", strcmp(parent, "/") == 0 ? "" : parent, name) >= (int)sizeof path) continue;
    if (allow_below(ruleset, path, proc_entries) != 0) {
      result = -1;
      break;
    }
  }
  closedir(directory);
  return result;
}

static void release_pinned(void) {
  while (pinned_count > 0) close(pinned[--pinned_count]);
}

/* Makes the ruleset: reading and writing files below every entry of / but /proc, and below every entry of /proc but the process numbers.
   "self" is a link to the directory of this process, so the entries of /proc that are not numbers include its own. Returns its descriptor, or
   -1 (with hide_failure set) when it cannot be made: no Landlock, or the first version, which refuses every move between directories. */
static int make_ruleset(void) {
  hide_failure = "";
  long abi = syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) {
    hide_failure = "the kernel has no Landlock";
    return -1;
  }
  if (abi < 2) {
    hide_failure = "Landlock version 1 refuses every move between directories";
    return -1;
  }
  refer_handled = 1;
  struct landlock_ruleset_attr_v1 handled = {.handled_access_fs = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REFER};
  int ruleset = (int)syscall(__NR_landlock_create_ruleset, &handled, sizeof handled, 0);
  if (ruleset < 0) {
    hide_failure = "landlock_create_ruleset was refused";
    return -1;
  }
  if (allow_entries(ruleset, "/", 0) != 0 || allow_entries(ruleset, "/proc", 1) != 0) {
    hide_failure = "a rule could not be added";
    close(ruleset);
    release_pinned();
    return -1;
  }
  return ruleset;
}

/* Puts the ruleset in force on this process and closes it. Returns 0 when it is. */
static int enforce_ruleset(int ruleset) {
  int result = (int)syscall(__NR_landlock_restrict_self, ruleset, 0);
  if (result != 0 && errno == EPERM && prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) == 0) {
    /* Without the capability to administer its user namespace a process must give up the ability to gain privileges first. */
    prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
    result = (int)syscall(__NR_landlock_restrict_self, ruleset, 0);
  }
  if (result != 0) hide_failure = "landlock_restrict_self was refused";
  close(ruleset);
  return result;
}

/* Ends this process the way the program ended: by the same signal when it died of one, with the same status when it exited. */
static void end_like(int wstatus) {
  if (WIFSIGNALED(wstatus)) {
    int sig = WTERMSIG(wstatus);
    /* No core file of this process, and the default action of the signal, unblocked. */
    struct rlimit no_core = {0, 0};
    setrlimit(RLIMIT_CORE, &no_core);
    prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
    signal(sig, SIG_DFL);
    sigset_t only;
    sigemptyset(&only);
    sigaddset(&only, sig);
    sigprocmask(SIG_UNBLOCK, &only, NULL);
    kill(getpid(), sig);
    _exit(128 + sig);
  }
  _exit(WEXITSTATUS(wstatus));
}

/* Sends the open /proc entries to PID 1 on `channel`, which keeps them. Returns 0 when every message went. */
static int send_pinned(int channel) {
  for (int first = 0; first < pinned_count; first += PIN_BATCH) {
    int count = pinned_count - first < PIN_BATCH ? pinned_count - first : PIN_BATCH;
    char data = 'p';
    struct iovec item = {.iov_base = &data, .iov_len = 1};
    union {
      struct cmsghdr header;
      char bytes[CMSG_SPACE(sizeof(int) * PIN_BATCH)];
    } control;
    memset(&control, 0, sizeof control);
    struct msghdr message = {.msg_iov = &item, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = CMSG_SPACE(sizeof(int) * (size_t)count)};
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET;
    header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int) * (size_t)count);
    memcpy(CMSG_DATA(header), pinned + first, sizeof(int) * (size_t)count);
    ssize_t sent;
    do {
      sent = sendmsg(channel, &message, MSG_NOSIGNAL);
    } while (sent < 0 && errno == EINTR);
    if (sent != 1) return -1;
  }
  return 0;
}

/* Receives what the program sends, until it closes its end (it does when it executes). The descriptors stay open in this process. */
static void receive_pinned(int channel) {
  for (;;) {
    char data;
    struct iovec item = {.iov_base = &data, .iov_len = 1};
    union {
      struct cmsghdr header;
      char bytes[CMSG_SPACE(sizeof(int) * PIN_BATCH)];
    } control;
    memset(&control, 0, sizeof control);
    struct msghdr message = {.msg_iov = &item, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof control.bytes};
    ssize_t got = recvmsg(channel, &message, MSG_CMSG_CLOEXEC);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) return;
  }
}

/* Moves the open /proc entries to numbers of PIN_FD_FLOOR and up, where they stay open in the program (no CLOEXEC). Returns 0 when all moved. */
static int move_pinned_up(void) {
  for (int i = 0; i < pinned_count; i++) {
    int moved = fcntl(pinned[i], F_DUPFD, PIN_FD_FLOOR);
    if (moved < 0) return -1;
    close(pinned[i]);
    pinned[i] = moved;
  }
  return 0;
}

/* Hides the other processes from this one (unless told to keep /proc), then becomes the program. Never returns. `keeper` is the end of the
   socket to PID 1 that takes the open /proc entries of the ruleset, or -1 when the program stays alone (--no-pid-namespace): they then stay
   open in the program itself, at numbers of 200 and up. Nothing is put in force unless the entries are kept first. */
static void exec_program(char *const *argv, int keep_proc, int keeper) {
  if (!keep_proc) {
    int ruleset = make_ruleset();
    if (ruleset >= 0) {
      int kept = keeper >= 0 ? send_pinned(keeper) : move_pinned_up();
      if (kept != 0) {
        hide_failure = "the open /proc entries could not be kept";
        close(ruleset);
        release_pinned();
      } else if (enforce_ruleset(ruleset) != 0) {
        release_pinned();
      }
    }
    if (*hide_failure != '\0') fprintf(stderr, NOT_HIDDEN_NOTICE "%s\n", hide_failure);
    /* What PID 1 holds is closed here; the program does not carry it. */
    if (keeper >= 0) release_pinned();
  }
  if (keeper >= 0) close(keeper);
  execvp(argv[0], argv);
  /* Said the way `unshare` says it, because the callers read the message of a program that cannot be started. */
  fprintf(stderr, "pid-init: failed to execute %s: %s\n", argv[0], strerror(errno));
  _exit(errno == ENOENT ? EXIT_NOT_FOUND : EXIT_CANNOT_RUN);
}

/* PID 1 of the namespace. Never returns. */
static void run_init(char *const *argv, int keep_proc, int report_fd, int unused_fd, int watch_fd, int parent_end_fd) {
  close(unused_fd);
  close(parent_end_fd);
  prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0);
  /* The parent held its end of the pipe open when it forked us; a hang-up here means it died before the signal above was asked for. */
  struct pollfd parent_alive = {.fd = watch_fd, .events = 0};
  if (poll(&parent_alive, 1, 0) > 0 && (parent_alive.revents & POLLHUP)) _exit(EXIT_NAMESPACE);
  close(watch_fd);
  int keeper[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, keeper) != 0) _exit(EXIT_NAMESPACE);
  pid_t program = fork();
  if (program < 0) _exit(EXIT_NAMESPACE);
  if (program == 0) {
    close(report_fd);
    close(keeper[0]);
    exec_program(argv, keep_proc, keeper[1]);
  }
  close(keeper[1]);
  /* The program sends the /proc entries the ruleset names before it executes, or closes its end (exec does) when there are none; this process
     keeps them open until it ends, which is when the program has. */
  receive_pinned(keeper[0]);
  close(keeper[0]);
  int wstatus = 0;
  for (;;) {
    pid_t ended = waitpid(-1, &wstatus, 0);
    if (ended == program) break;
    if (ended < 0 && errno != EINTR) _exit(EXIT_NAMESPACE);
  }
  ssize_t written;
  do {
    written = write(report_fd, &wstatus, sizeof wstatus);
  } while (written < 0 && errno == EINTR);
  _exit(0);
}

int main(int argc, char **argv) {
  int keep_proc = 0;
  int own_namespace = 1;
  int first = 1;
  for (; first < argc; first++) {
    if (strcmp(argv[first], "--keep-proc") == 0) keep_proc = 1;
    else if (strcmp(argv[first], "--no-pid-namespace") == 0) own_namespace = 0;
    else if (strcmp(argv[first], "--check") == 0 && argc == 2) {
      int ruleset = make_ruleset();
      if (ruleset >= 0 && enforce_ruleset(ruleset) == 0) return 0;
      fprintf(stderr, NOT_HIDDEN_NOTICE "%s\n", hide_failure);
      return EXIT_NO_LANDLOCK;
    }
    else break;
  }
  if (first + 1 >= argc || strcmp(argv[first], "--") != 0) {
    fprintf(stderr, "usage: pid-init [--keep-proc] -- program [argument...]\n");
    return 2;
  }
  char *const *program_argv = argv + first + 1;
  if (!own_namespace) exec_program(program_argv, keep_proc, -1);
  if (unshare(CLONE_NEWPID) != 0) {
    fprintf(stderr, "pid-init: cannot make a PID namespace: %s\n", strerror(errno));
    return EXIT_NAMESPACE;
  }
  int report[2];
  if (pipe2(report, O_CLOEXEC) != 0) return EXIT_NAMESPACE;
  int alive[2];
  if (pipe2(alive, O_CLOEXEC) != 0) return EXIT_NAMESPACE;
  pid_t init = fork();
  if (init < 0) return EXIT_NAMESPACE;
  if (init == 0) run_init(program_argv, keep_proc, report[1], report[0], alive[0], alive[1]);
  close(report[1]);
  close(alive[0]);
  int wstatus = 0;
  ssize_t got;
  do {
    got = read(report[0], &wstatus, sizeof wstatus);
  } while (got < 0 && errno == EINTR);
  int init_status = 0;
  while (waitpid(init, &init_status, 0) < 0 && errno == EINTR) {
  }
  if (got == (ssize_t)sizeof wstatus) end_like(wstatus);
  /* PID 1 ended without a report: it was killed, or the namespace could not run the program. */
  if (WIFSIGNALED(init_status)) end_like(init_status);
  return WIFEXITED(init_status) && WEXITSTATUS(init_status) != 0 ? WEXITSTATUS(init_status) : EXIT_NAMESPACE;
}
