// A stand-in for libqpdf that the tests hand to qpdf-runner (QPDF_RUNNER_LIB): its qpdfjob_run_from_argv reports facts about the
// process it runs in, so a test can read what the runner gave the job instead of trusting the runner. argv[1] names the probe.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static void print_file(const char *path) {
  FILE *f = fopen(path, "r");
  if (f == NULL) {
    printf("%s: unreadable (%s)\n", path, strerror(errno));
    return;
  }
  char line[4096];
  while (fgets(line, sizeof line, f) != NULL) fputs(line, stdout);
  fclose(f);
}

static void print_link(const char *path) {
  char target[256];
  ssize_t n = readlink(path, target, sizeof target - 1);
  if (n < 0) n = 0;
  target[n] = '\0';
  printf("%s -> %s\n", path, target);
}

/* Scans every readable mapping of this process for `needle`; prints the number of mappings that hold it. */
static void scan_memory(const char *needle) {
  FILE *maps = fopen("/proc/self/maps", "r");
  char line[512];
  int found = 0;
  size_t n = strlen(needle);
  while (maps != NULL && fgets(line, sizeof line, maps) != NULL) {
    unsigned long lo, hi;
    char perms[8];
    if (sscanf(line, "%lx-%lx %7s", &lo, &hi, perms) != 3 || perms[0] != 'r') continue;
    if (strstr(line, "[vvar]") != NULL || strstr(line, "[vsyscall]") != NULL) continue;
    for (const char *p = (const char *)lo; p + n <= (const char *)hi; p++) {
      /* The needle itself sits in this process (the argument); a match at the argument's own address does not count. */
      if (memcmp(p, needle, n) == 0 && p != needle) {
        found++;
        break;
      }
    }
  }
  if (maps != NULL) fclose(maps);
  printf("copies-of-needle: %d\n", found);
}

int qpdfjob_run_from_argv(const char *const argv[]) {
  const char *probe = argv[1] != NULL ? argv[1] : "";
  if (strcmp(probe, "facts") == 0) {
    print_link("/proc/self/ns/user");
    print_link("/proc/self/ns/net");
    printf("pid: %d\nppid: %d\nsid: %d\npgid: %d\nuid: %d\ngid: %d\n", getpid(), getppid(), getsid(0), getpgid(0), getuid(), getgid());
    char cwd[4096];
    printf("cwd: %s\n", getcwd(cwd, sizeof cwd) != NULL ? cwd : "?");
    print_file("/proc/self/status");
    print_file("/proc/self/limits");
    print_file("/proc/self/uid_map");
    print_file("/proc/self/gid_map");
    print_file("/proc/self/setgroups");
    print_file("/proc/net/dev");
    int pdeathsig = -1;
    prctl(PR_GET_PDEATHSIG, &pdeathsig);
    printf("pdeathsig: %d\ndumpable: %d\nno_new_privs: %d\n", pdeathsig, prctl(PR_GET_DUMPABLE), prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0));
    for (char **e = environ; *e != NULL; e++) printf("env: %s\n", *e);
    int open_fds = 0;
    for (int fd = 3; fd < 256; fd++) if (fcntl(fd, F_GETFD) >= 0) open_fds++;
    printf("open-fds-above-2: %d\n", open_fds);
    return 0;
  }
  if (strcmp(probe, "echo-stdin") == 0) {
    char buf[65536];
    ssize_t n;
    while ((n = read(0, buf, sizeof buf)) > 0) (void)!write(1, buf, (size_t)n);
    return 0;
  }
  if (strcmp(probe, "sleep") == 0) {
    printf("sleeping pid=%d\n", getpid());
    fflush(stdout);
    sleep((unsigned)atoi(argv[2]));
    return 0;
  }
  if (strcmp(probe, "spam") == 0) {
    size_t total = (size_t)atol(argv[2]);
    char chunk[4096];
    memset(chunk, 'x', sizeof chunk);
    for (size_t sent = 0; sent < total;) {
      size_t n = total - sent < sizeof chunk ? total - sent : sizeof chunk;
      if (write(argv[3] != NULL && argv[3][0] == 'e' ? 2 : 1, chunk, n) < 0) break;
      sent += n;
    }
    return 0;
  }
  if (strcmp(probe, "hold-secret") == 0) {
    /* Keeps a secret in its memory and its output for a while, so that a second job can look for it. */
    printf("secret=%s\n", argv[2]);
    fflush(stdout);
    sleep((unsigned)atoi(argv[3]));
    return 0;
  }
  if (strcmp(probe, "scan") == 0) {
    scan_memory(argv[2]);
    return 0;
  }
  if (strcmp(probe, "read-mem-of") == 0) {
    char path[64];
    snprintf(path, sizeof path, "/proc/%s/mem", argv[2]);
    int fd = open(path, O_RDONLY);
    printf("open %s: %s\n", path, fd >= 0 ? "allowed" : strerror(errno));
    return 0;
  }
  if (strcmp(probe, "unshare-again") == 0) {
    printf("unshare after setup: %s\n", syscall(SYS_unshare, 0x40000000) == 0 ? "allowed" : strerror(errno));
    return 0;
  }
  if (strcmp(probe, "fork-sleep") == 0) {
    /* fork-sleep <pidfile> <seconds> <hold|daemon>: leaves a descendant that sleeps and returns 0 at once. "hold" keeps the standard
       streams of the job open; "daemon" closes them, so the job's pipes end while the descendant lives on. */
    pid_t child = fork();
    if (child == 0) {
      if (argv[4] != NULL && strcmp(argv[4], "daemon") == 0) {
        close(0);
        close(1);
        close(2);
      }
      sleep((unsigned)atoi(argv[3]));
      _exit(0);
    }
    FILE *f = fopen(argv[2], "w");
    if (f != NULL) {
      fprintf(f, "%d\n", child);
      fclose(f);
    }
    return 0;
  }
  if (strcmp(probe, "mincore") == 0) {
    unsigned char vec[1];
    long r = syscall(SYS_mincore, (void *)0, 0UL, vec);
    printf("mincore: %s\n", r == 0 ? "allowed" : strerror(errno));
    return 0;
  }
  if (strcmp(probe, "exit") == 0) {
    fputs("probe failed on purpose\n", stderr);
    return atoi(argv[2]);
  }
  if (strcmp(probe, "crash") == 0) {
    abort();
  }
  if (strcmp(probe, "write-file") == 0) {
    FILE *f = fopen(argv[2], "w");
    if (f == NULL) {
      fprintf(stderr, "cannot open: %s\n", strerror(errno));
      return 2;
    }
    char chunk[4096];
    memset(chunk, 'y', sizeof chunk);
    for (long i = 0; i < atol(argv[3]); i++) {
      if (fwrite(chunk, 1, sizeof chunk, f) != sizeof chunk || fflush(f) != 0) {
        fprintf(stderr, "write failed: %s\n", strerror(errno));
        return 2;
      }
    }
    fclose(f);
    return 0;
  }
  fputs("unknown probe\n", stderr);
  return 2;
}

const char *qpdf_get_qpdf_version(void) { return "probe"; }
