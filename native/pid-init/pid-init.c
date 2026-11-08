// pid-init: runs a program in a PID namespace of its own, with the program as PID 2 and this code as PID 1.
//
//   pid-init -- <program> [argument...]
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
// PID 1 dies with this process (PR_SET_PDEATHSIG), so killing this process, or its process group, ends the program too. A report that
// never arrives means PID 1 was killed, and this process kills itself the same way.
//
// Exit status: that of the program; 127 when it is not found and 126 when it cannot be run (as a shell and `unshare` say); 125 when the
// namespace cannot be made.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

#define EXIT_NAMESPACE 125
#define EXIT_CANNOT_RUN 126
#define EXIT_NOT_FOUND 127

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

/* PID 1 of the namespace. Never returns. */
static void run_init(char *const *argv, int report_fd, int unused_fd) {
  close(unused_fd);
  prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0);
  pid_t program = fork();
  if (program < 0) _exit(EXIT_NAMESPACE);
  if (program == 0) {
    close(report_fd);
    execvp(argv[0], argv);
    /* Said the way `unshare` says it, because the callers read the message of a program that cannot be started. */
    fprintf(stderr, "pid-init: failed to execute %s: %s\n", argv[0], strerror(errno));
    _exit(errno == ENOENT ? EXIT_NOT_FOUND : EXIT_CANNOT_RUN);
  }
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
  if (argc < 3 || strcmp(argv[1], "--") != 0) {
    fprintf(stderr, "usage: pid-init -- program [argument...]\n");
    return 2;
  }
  if (unshare(CLONE_NEWPID) != 0) {
    fprintf(stderr, "pid-init: cannot make a PID namespace: %s\n", strerror(errno));
    return EXIT_NAMESPACE;
  }
  int report[2];
  if (pipe2(report, O_CLOEXEC) != 0) return EXIT_NAMESPACE;
  pid_t init = fork();
  if (init < 0) return EXIT_NAMESPACE;
  if (init == 0) run_init(argv + 2, report[1], report[0]);
  close(report[1]);
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
