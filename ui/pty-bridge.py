#!/usr/bin/env python3
"""Run a command in a pseudo-terminal for the doctor UI's terminals.

Usage: pty-bridge.py ROWS COLS -- COMMAND [ARGS...]

stdin goes to the terminal, the terminal's output goes to stdout, and lines of
"ROWS COLS" on file descriptor 3 resize it. When stdin closes (the browser tab or
the server went away) the command gets SIGHUP, like a closed terminal window.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

CONTROL_FD = 3


def resize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd, data):
    while data:
        n = os.write(fd, data)
        data = data[n:]


def main():
    if len(sys.argv) < 5 or sys.argv[3] != "--":
        sys.exit("usage: pty-bridge.py ROWS COLS -- COMMAND [ARGS...]")
    rows, cols, command = int(sys.argv[1]), int(sys.argv[2]), sys.argv[4:]

    pid, master = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.execvp(command[0], command)

    resize(master, rows, cols)
    watched = [master, 0, CONTROL_FD]
    control = b""
    while True:
        try:
            ready, _, _ = select.select(watched, [], [])
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:  # the command exited
                data = b""
            if not data:
                break
            write_all(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                os.kill(pid, signal.SIGHUP)
                break
            write_all(master, data)
        if CONTROL_FD in ready:
            chunk = os.read(CONTROL_FD, 1024)
            if not chunk:
                watched.remove(CONTROL_FD)
                continue
            control += chunk
            while b"\n" in control:
                line, control = control.split(b"\n", 1)
                parts = line.split()
                if len(parts) == 2 and all(p.isdigit() for p in parts):
                    resize(master, int(parts[0]), int(parts[1]))

    sys.exit(finish(pid, master))


def finish(pid, master):
    """Hang up the terminal, give the command two seconds to exit, then kill it."""
    try:
        os.close(master)
    except OSError:
        pass
    for _ in range(20):
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            return os.waitstatus_to_exitcode(status)
        select.select([], [], [], 0.1)
    os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    main()
