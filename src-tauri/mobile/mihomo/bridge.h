#include <stdlib.h>
int pw_protect(int fd, int allow_probe_network);
char *pw_package(int protocol, const char *src, int sport, const char *dst, int dport);
