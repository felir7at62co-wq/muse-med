#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

/* Diagnostic ELF entry only: observe inherited descriptors, then exec the real tool. */
static int json_string(FILE *file, const char *value) {
  if (fputc('"', file) == EOF) return -1;
  for (const unsigned char *p = (const unsigned char *)value; *p != '\0'; p++) {
    if (*p == '"' || *p == '\\') {
      if (fputc('\\', file) == EOF || fputc(*p, file) == EOF) return -1;
    } else if (*p < 0x20) {
      if (fprintf(file, "\\u%04x", (unsigned int)*p) < 0) return -1;
    } else if (fputc(*p, file) == EOF) return -1;
  }
  return fputc('"', file) == EOF ? -1 : 0;
}

#ifndef WITNESS_DIR
#error WITNESS_DIR must name the private diagnostic directory
#endif

int main(int argc, char **argv) {
  const char *directory = WITNESS_DIR;
  if (directory == NULL || directory[0] != '/') return 125;
  int statuses[3], status_errors[3], descriptor_flags[3], descriptor_errors[3];
  for (int fd = 0; fd < 3; fd++) {
    statuses[fd] = fcntl(fd, F_GETFL);
    status_errors[fd] = statuses[fd] == -1 ? errno : 0;
    descriptor_flags[fd] = fcntl(fd, F_GETFD);
    descriptor_errors[fd] = descriptor_flags[fd] == -1 ? errno : 0;
  }
  char path[4096];
  int count = snprintf(path, sizeof(path), "%s/%ld.json", directory, (long)getpid());
  if (count < 0 || (size_t)count >= sizeof(path)) return 125;
  int artifact_fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (artifact_fd == -1) return 125;
  FILE *artifact = fdopen(artifact_fd, "w");
  if (artifact == NULL) { close(artifact_fd); return 125; }
  int failed = fprintf(artifact, "{\"pid\":%ld,\"ppid\":%ld,\"nativeNonblock\":%d,\"target\":\"/usr/bin/ffprobe\",\"observedArgv\":[",
                       (long)getpid(), (long)getppid(), O_NONBLOCK) < 0;
  for (int i = 0; i < argc; i++) {
    if (i > 0 && fputc(',', artifact) == EOF) failed = 1;
    if (json_string(artifact, argv[i]) == -1) failed = 1;
  }
  if (fputs("],\"descriptors\":[", artifact) == EOF) failed = 1;
  for (int fd = 0; fd < 3; fd++) {
    if (fd > 0 && fputc(',', artifact) == EOF) failed = 1;
    if (fprintf(artifact,
                "{\"fd\":%d,\"statusFlags\":%d,\"statusErrno\":%d,\"descriptorFlags\":%d,\"descriptorErrno\":%d,\"nonblocking\":%s}",
                fd, statuses[fd], status_errors[fd], descriptor_flags[fd], descriptor_errors[fd],
                statuses[fd] == -1 ? "null" : (statuses[fd] & O_NONBLOCK) != 0 ? "true" : "false") < 0) failed = 1;
  }
  if (fputs("]}\n", artifact) == EOF || ferror(artifact)) failed = 1;
  if (fclose(artifact) != 0) failed = 1;
  if (failed) return 125;
  argv[0] = "/usr/bin/ffprobe";
  execv(argv[0], argv);
  return errno == ENOENT ? 127 : 126;
}
