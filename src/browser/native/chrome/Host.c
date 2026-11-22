#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

static int forward_bytes(int from, int to) {
    unsigned char buffer[16384];
    ssize_t count;
    do {
        count = read(from, buffer, sizeof(buffer));
    } while (count < 0 && errno == EINTR);
    if (count <= 0) return 0;
    for (ssize_t sent = 0; sent < count;) {
        ssize_t written = write(to, buffer + sent, (size_t)(count - sent));
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return 0;
        sent += written;
    }
    return 1;
}

// Chrome launches this executable via its user native-messaging manifest. The
// framing remains unchanged on the private Unix socket alongside the executable.
int main(int argc, char *argv[]) {
    if (argc < 2 || strncmp(argv[1], "chrome-extension://", 19) != 0) return 2;
    const char *separator = strrchr(argv[0], '/');
    if (!separator || *argv[0] != '/') return 2;
    struct sockaddr_un address = {0};
    address.sun_family = AF_UNIX;
    int length = snprintf(address.sun_path, sizeof(address.sun_path), "%.*s/channel",
                          (int)(separator - argv[0]), argv[0]);
    if (length < 0 || (size_t)length >= sizeof(address.sun_path)) return 2;
    int channel = socket(AF_UNIX, SOCK_STREAM, 0);
    if (channel < 0) return 1;
    uid_t uid;
    gid_t gid;
    if (connect(channel, (struct sockaddr *)&address, sizeof(address)) != 0 ||
        getpeereid(channel, &uid, &gid) != 0 || uid != geteuid()) {
        close(channel);
        return 1;
    }
    signal(SIGPIPE, SIG_IGN);
    struct pollfd input[] = {{STDIN_FILENO, POLLIN, 0}, {channel, POLLIN, 0}};
    for (;;) {
        int ready = poll(input, 2, -1);
        if (ready < 0 && errno == EINTR) continue;
        if (ready < 0) break;
        if (input[0].revents && !forward_bytes(STDIN_FILENO, channel)) break;
        if (input[1].revents && !forward_bytes(channel, STDOUT_FILENO)) break;
    }
    close(channel);
    return 0;
}
