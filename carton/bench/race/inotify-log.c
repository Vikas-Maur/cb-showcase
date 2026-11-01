// Linux-only oracle for race.ts: logs, in kernel order, every name event in the watched directories.
// inotify queues the events of one instance in a single FIFO, and the kernel emits a rename's or link's
// event while it still holds the directory lock, so the order of events on the view's directory is the
// order in which inodes arrived at and left the view path. race.ts replays this log to say, for every
// foreign write, whether a later foreign write, the engine, or nobody removed it from the path.
// usage: inotify-log <out-file> <stop-name> <dir>...   prints READY once all watches exist; exits after
// it sees IN_CREATE of <stop-name> in the first dir. Line: <dirIndex> <F|T|C|D|O> <cookie> <name>
#include <sys/inotify.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 4) { fprintf(stderr, "usage: inotify-log out stop dir...\n"); return 2; }
  FILE *out = fopen(argv[1], "w");
  if (!out) { perror("open out"); return 1; }
  setvbuf(out, NULL, _IOFBF, 1 << 22);
  int fd = inotify_init1(0);
  if (fd < 0) { perror("inotify_init1"); return 1; }
  int ndirs = argc - 3, wds[64];
  for (int i = 0; i < ndirs && i < 64; i++) {
    wds[i] = inotify_add_watch(fd, argv[3 + i], IN_CREATE | IN_MOVED_FROM | IN_MOVED_TO | IN_DELETE);
    if (wds[i] < 0) { perror(argv[3 + i]); return 1; }
  }
  printf("READY\n"); fflush(stdout);
  static char buf[1 << 20] __attribute__((aligned(8)));
  for (;;) {
    ssize_t n = read(fd, buf, sizeof buf);
    if (n <= 0) { perror("read"); return 1; }
    for (char *p = buf; p < buf + n;) {
      struct inotify_event *e = (struct inotify_event *)p;
      p += sizeof *e + e->len;
      if (e->mask & IN_Q_OVERFLOW) { fprintf(out, "-1 O 0 overflow\n"); continue; }
      int di = -1;
      for (int i = 0; i < ndirs; i++) if (wds[i] == e->wd) di = i;
      char k = e->mask & IN_MOVED_FROM ? 'F' : e->mask & IN_MOVED_TO ? 'T' : e->mask & IN_CREATE ? 'C' : e->mask & IN_DELETE ? 'D' : '?';
      const char *name = e->len ? e->name : "";
      fprintf(out, "%d %c %u %s\n", di, k, e->cookie, name);
      if (di == 0 && k == 'C' && strcmp(name, argv[2]) == 0) { fclose(out); return 0; }
    }
  }
}
