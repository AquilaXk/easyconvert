// tmpfile-redirect: a preload library that makes tmpfile() use $TMPDIR.
//
//   LD_PRELOAD=/usr/local/lib/libeasyconvert-tmpfile.so program ...
//
// The C library's tmpfile() always makes its file in /tmp (P_tmpdir), whatever TMPDIR says. A program that runs under the file confinement of
// pid-init (--confine) may write only in the directory of its job, so its tmpfile() fails, and a program that does not check for that (FontForge
// reads a Type 1 font through one) ends with a segmentation fault. This library makes the file in the directory named by TMPDIR, which the sandbox
// sets to the directory of the job, and removes its name at once, as tmpfile() does. It changes nothing else.

#define _GNU_SOURCE
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

FILE *tmpfile(void) {
  const char *directory = getenv("TMPDIR");
  if (directory == NULL || directory[0] == '\0') directory = "/tmp";
  int descriptor = open(directory, O_TMPFILE | O_RDWR | O_EXCL, 0600);
  if (descriptor < 0) {
    char path[PATH_MAX];
    if (snprintf(path, sizeof path, "%s/tmpf-XXXXXX", directory) >= (int)sizeof path) return NULL;
    descriptor = mkstemp(path);
    if (descriptor < 0) return NULL;
    unlink(path);
  }
  FILE *stream = fdopen(descriptor, "w+");
  if (stream == NULL) close(descriptor);
  return stream;
}

FILE *tmpfile64(void) __attribute__((alias("tmpfile")));
