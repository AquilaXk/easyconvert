// osl-pipe-redirect: a preload library that redirects LibreOffice OSL_PIPE sockets into $TMPDIR.
//
//   LD_PRELOAD=/usr/lib/libeasyconvert-osl-pipe.so soffice ...
//
// Installed under /usr/lib rather than /usr/local/lib so Ubuntu's libreoffice-xpdfimport AppArmor profile
// (<abstractions/base>: /{usr/,}lib{,32,64}/**.so* mr) permits ld.so to map the library instead of writing
// an LD_PRELOAD open failure onto xpdfimport's stderr protocol stream.
//
// LibreOffice's sal/osl/unx/pipe.cxx (osl_psz_createPipe) probes access("/tmp", W_OK) and then access("/var/tmp", W_OK)
// before checking OSL_SOCKET_PATH. Because Linux Landlock does not restrict directory access(2) checks on writable sticky
// directories, and because desktop/unx/source/start.c (oosplash) does not consult OSL_SOCKET_PATH at all, LibreOffice
// binds its single-instance UNIX socket under /tmp/OSL_PIPE_<uid>_SingleOfficeIPC_<hash>. Furthermore, osl_psz_createPipe
// enforces the 107-byte sockaddr_un.sun_path limit, which deep per-job sandbox paths exceed.
//
// At process startup this library opens $TMPDIR with O_PATH | O_DIRECTORY | O_CLOEXEC and keeps that descriptor at a high
// fd number. Any AF_UNIX socket or pathname operation targeting /tmp/OSL_PIPE_<leaf> or /var/tmp/OSL_PIPE_<leaf> (with no
// nested slashes and length within sun_path bounds) is rewritten to /proc/self/fd/<fd>/OSL_PIPE_<leaf>, keeping the path
// safely under 108 bytes while confining socket creation and unlinking strictly inside the job's writable directory.

#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#ifndef O_PATH
#define O_PATH 010000000
#endif

#ifndef AT_FDCWD
#define AT_FDCWD -100
#endif

#define OSL_PIPE_FD_FLOOR 240
#define OSL_PIPE_LEAF_MAX 80

static char pipe_dir_path[PATH_MAX];
static int pipe_dir_fd = -1;

static int is_shared_tmp_dir(const char *dir) {
  size_t len = strlen(dir);
  while (len > 1 && dir[len - 1] == '/') len--;
  if (len == 1 && dir[0] == '/') return 1;
  if (len == 4 && memcmp(dir, "/tmp", 4) == 0) return 1;
  if (len == 8 && memcmp(dir, "/var/tmp", 8) == 0) return 1;
  return 0;
}

static int open_pipe_dir(const char *dir) {
  if (dir == NULL || dir[0] != '/' || is_shared_tmp_dir(dir)) return -1;
  int raw_fd = (int)syscall(SYS_openat, AT_FDCWD, dir, O_PATH | O_DIRECTORY | O_CLOEXEC, 0);
  if (raw_fd < 0) return -1;
  int high_fd = fcntl(raw_fd, F_DUPFD_CLOEXEC, OSL_PIPE_FD_FLOOR);
  if (high_fd >= 0) {
    syscall(SYS_close, raw_fd);
    return high_fd;
  }
  return raw_fd;
}

__attribute__((constructor)) static void init_osl_pipe_redirect(void) {
  int saved = errno;
  const char *dir = getenv("TMPDIR");
  if (dir != NULL && dir[0] == '/' && !is_shared_tmp_dir(dir)) {
    size_t len = strlen(dir);
    if (len < sizeof pipe_dir_path) {
      memcpy(pipe_dir_path, dir, len + 1);
      pipe_dir_fd = open_pipe_dir(pipe_dir_path);
    }
  }
  errno = saved;
}

static int ensure_pipe_dir_fd(void) {
  int fd = __atomic_load_n(&pipe_dir_fd, __ATOMIC_ACQUIRE);
  if (fd >= 0 && fcntl(fd, F_GETFD) >= 0) return fd;
  if (pipe_dir_path[0] == '\0') return -1;
  int reopened = open_pipe_dir(pipe_dir_path);
  if (reopened < 0) return -1;
  int prev = fd;
  if (!__atomic_compare_exchange_n(&pipe_dir_fd, &prev, reopened, 0, __ATOMIC_RELEASE, __ATOMIC_ACQUIRE)) {
    syscall(SYS_close, reopened);
    return prev >= 0 && fcntl(prev, F_GETFD) >= 0 ? prev : -1;
  }
  return reopened;
}

static const char *match_osl_pipe_leaf(const char *path) {
  if (path == NULL) return NULL;
  const char *leaf = NULL;
  if (strncmp(path, "/tmp/OSL_PIPE_", 14) == 0) {
    leaf = path + 5;
  } else if (strncmp(path, "/var/tmp/OSL_PIPE_", 18) == 0) {
    leaf = path + 9;
  } else {
    return NULL;
  }
  const char *suffix = leaf + 9; // past "OSL_PIPE_"
  if (*suffix == '\0' || strchr(suffix, '/') != NULL) return NULL;
  if (strlen(leaf) > OSL_PIPE_LEAF_MAX) return NULL;
  return leaf;
}

static int rewrite_osl_pipe_path(const char *path, char *buf, size_t buf_size) {
  int saved = errno;
  const char *leaf = match_osl_pipe_leaf(path);
  if (leaf == NULL) {
    errno = saved;
    return 0;
  }
  int dir_fd = ensure_pipe_dir_fd();
  if (dir_fd < 0) {
    errno = saved;
    return 0;
  }
  int written = snprintf(buf, buf_size, "/proc/self/fd/%d/%s", dir_fd, leaf);
  errno = saved;
  if (written < 0 || (size_t)written >= buf_size) return 0;
  return 1;
}

static void *resolve_next(const char *symbol) {
  int saved = errno;
  void *addr = dlsym(RTLD_NEXT, symbol);
  errno = saved;
  return addr;
}

typedef int (*sock_op_fn)(int, const struct sockaddr *, socklen_t);

static int rewrite_sock_op(const char *symbol, int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  sock_op_fn next_op = NULL;
  void *sym = resolve_next(symbol);
  if (sym == NULL) {
    errno = ENOSYS;
    return -1;
  }
  memcpy(&next_op, &sym, sizeof next_op);

  if (addr != NULL && addrlen > (socklen_t)offsetof(struct sockaddr_un, sun_path) && addr->sa_family == AF_UNIX) {
    size_t max_path = (size_t)addrlen - offsetof(struct sockaddr_un, sun_path);
    const struct sockaddr_un *un_in = (const struct sockaddr_un *)addr;
    if (un_in->sun_path[0] == '/') {
      char orig[sizeof un_in->sun_path];
      size_t copy_len = max_path < sizeof orig - 1 ? max_path : sizeof orig - 1;
      memcpy(orig, un_in->sun_path, copy_len);
      orig[copy_len] = '\0';

      struct sockaddr_un un_out;
      memset(&un_out, 0, sizeof un_out);
      un_out.sun_family = AF_UNIX;
      if (rewrite_osl_pipe_path(orig, un_out.sun_path, sizeof un_out.sun_path)) {
        socklen_t out_len = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + strlen(un_out.sun_path) + 1);
        return next_op(sockfd, (const struct sockaddr *)&un_out, out_len);
      }
    }
  }
  return next_op(sockfd, addr, addrlen);
}

int bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  return rewrite_sock_op("bind", sockfd, addr, addrlen);
}

int connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  return rewrite_sock_op("connect", sockfd, addr, addrlen);
}

int unlink(const char *pathname) {
  int (*next_fn)(const char *) = NULL;
  void *sym = resolve_next("unlink");
  if (sym == NULL) {
    errno = ENOSYS;
    return -1;
  }
  memcpy(&next_fn, &sym, sizeof next_fn);
  char rewritten[128];
  if (rewrite_osl_pipe_path(pathname, rewritten, sizeof rewritten)) {
    return next_fn(rewritten);
  }
  return next_fn(pathname);
}

int unlinkat(int dirfd, const char *pathname, int flags) {
  int (*next_fn)(int, const char *, int) = NULL;
  void *sym = resolve_next("unlinkat");
  if (sym == NULL) {
    errno = ENOSYS;
    return -1;
  }
  memcpy(&next_fn, &sym, sizeof next_fn);
  char rewritten[128];
  if (rewrite_osl_pipe_path(pathname, rewritten, sizeof rewritten)) {
    return next_fn(AT_FDCWD, rewritten, flags);
  }
  return next_fn(dirfd, pathname, flags);
}

int chmod(const char *pathname, mode_t mode) {
  int (*next_fn)(const char *, mode_t) = NULL;
  void *sym = resolve_next("chmod");
  if (sym == NULL) {
    errno = ENOSYS;
    return -1;
  }
  memcpy(&next_fn, &sym, sizeof next_fn);
  char rewritten[128];
  if (rewrite_osl_pipe_path(pathname, rewritten, sizeof rewritten)) {
    return next_fn(rewritten, mode);
  }
  return next_fn(pathname, mode);
}

int fchmodat(int dirfd, const char *pathname, mode_t mode, int flags) {
  int (*next_fn)(int, const char *, mode_t, int) = NULL;
  void *sym = resolve_next("fchmodat");
  if (sym == NULL) {
    errno = ENOSYS;
    return -1;
  }
  memcpy(&next_fn, &sym, sizeof next_fn);
  char rewritten[128];
  if (rewrite_osl_pipe_path(pathname, rewritten, sizeof rewritten)) {
    return next_fn(AT_FDCWD, rewritten, mode, flags);
  }
  return next_fn(dirfd, pathname, mode, flags);
}

int access(const char *pathname, int mode) {
  int (*next_fn)(const char *, int) = NULL;
  void *sym = resolve_next("access");
  if (sym == NULL) {
    errno = ENOSYS;
    return -1;
  }
  memcpy(&next_fn, &sym, sizeof next_fn);
  char rewritten[128];
  if (rewrite_osl_pipe_path(pathname, rewritten, sizeof rewritten)) {
    return next_fn(rewritten, mode);
  }
  return next_fn(pathname, mode);
}

int faccessat(int dirfd, const char *pathname, int mode, int flags) {
  int (*next_fn)(int, const char *, int, int) = NULL;
  void *sym = resolve_next("faccessat");
  if (sym == NULL) {
    errno = ENOSYS;
    return -1;
  }
  memcpy(&next_fn, &sym, sizeof next_fn);
  char rewritten[128];
  if (rewrite_osl_pipe_path(pathname, rewritten, sizeof rewritten)) {
    return next_fn(AT_FDCWD, rewritten, mode, flags);
  }
  return next_fn(dirfd, pathname, mode, flags);
}

int stat(const char *restrict pathname, struct stat *restrict statbuf) {
  int (*next_fn)(const char *, struct stat *) = NULL;
  void *sym = resolve_next("stat");
  if (sym == NULL) {
    errno = ENOSYS;
    return -1;
  }
  memcpy(&next_fn, &sym, sizeof next_fn);
  char rewritten[128];
  if (rewrite_osl_pipe_path(pathname, rewritten, sizeof rewritten)) {
    return next_fn(rewritten, statbuf);
  }
  return next_fn(pathname, statbuf);
}

int lstat(const char *restrict pathname, struct stat *restrict statbuf) {
  int (*next_fn)(const char *, struct stat *) = NULL;
  void *sym = resolve_next("lstat");
  if (sym == NULL) {
    errno = ENOSYS;
    return -1;
  }
  memcpy(&next_fn, &sym, sizeof next_fn);
  char rewritten[128];
  if (rewrite_osl_pipe_path(pathname, rewritten, sizeof rewritten)) {
    return next_fn(rewritten, statbuf);
  }
  return next_fn(pathname, statbuf);
}

int fstatat(int dirfd, const char *restrict pathname, struct stat *restrict statbuf, int flags) {
  int (*next_fn)(int, const char *, struct stat *, int) = NULL;
  void *sym = resolve_next("fstatat");
  if (sym == NULL) {
    errno = ENOSYS;
    return -1;
  }
  memcpy(&next_fn, &sym, sizeof next_fn);
  char rewritten[128];
  if (rewrite_osl_pipe_path(pathname, rewritten, sizeof rewritten)) {
    return next_fn(AT_FDCWD, rewritten, statbuf, flags);
  }
  return next_fn(dirfd, pathname, statbuf, flags);
}

int statx(int dirfd, const char *restrict pathname, int flags, unsigned int mask, struct statx *restrict statxbuf) {
  int (*next_fn)(int, const char *, int, unsigned int, struct statx *) = NULL;
  void *sym = resolve_next("statx");
  if (sym == NULL) {
    errno = ENOSYS;
    return -1;
  }
  memcpy(&next_fn, &sym, sizeof next_fn);
  char rewritten[128];
  if (rewrite_osl_pipe_path(pathname, rewritten, sizeof rewritten)) {
    return next_fn(AT_FDCWD, rewritten, flags, mask, statxbuf);
  }
  return next_fn(dirfd, pathname, flags, mask, statxbuf);
}
