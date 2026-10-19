// seccomp-deny <syscall> <program> [arguments...]: installs a seccomp filter that answers <syscall> with EPERM and allows
// everything else, then runs the program. The filter is inherited by everything the program starts, which is what the tests of
// qpdf-runner need to show: its jobs run under the filter of the process that started it, and a job whose namespaces cannot be made
// runs nothing.
#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__x86_64__)
#define AUDIT_ARCH_NATIVE AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define AUDIT_ARCH_NATIVE AUDIT_ARCH_AARCH64
#else
#error "no audit architecture for this platform"
#endif

int main(int argc, char **argv) {
  if (argc < 3) {
    fputs("usage: seccomp-deny <unshare|mincore> <program> [arguments...]\n", stderr);
    return 2;
  }
  int number = strcmp(argv[1], "unshare") == 0 ? SYS_unshare : strcmp(argv[1], "mincore") == 0 ? SYS_mincore : -1;
  if (number < 0) {
    fputs("seccomp-deny: unknown syscall\n", stderr);
    return 2;
  }
  struct sock_filter filter[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_NATIVE, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (unsigned)number, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {.len = sizeof filter / sizeof filter[0], .filter = filter};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) {
    perror("seccomp-deny");
    return 2;
  }
  execv(argv[2], argv + 2);
  perror("seccomp-deny: exec");
  return 127;
}
