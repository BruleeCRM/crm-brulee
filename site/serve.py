"""Serve this export locally. Python 3, no third-party dependencies.

    python serve.py [port]            this computer only (http://127.0.0.1:port)
    python serve.py [port] 0.0.0.0    also reachable from a phone on the same Wi-Fi
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import socket
import sys


def lan_address():
    """The address other devices on the network use to reach this computer."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(('192.0.2.1', 9))   # no packet is sent: this only picks the outgoing interface
        return probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    host = sys.argv[2] if len(sys.argv) > 2 else '127.0.0.1'
    handler = partial(SimpleHTTPRequestHandler, directory=str(Path(__file__).resolve().parent))
    server = ThreadingHTTPServer((host, port), handler)
    print(f'Site disponible sur http://127.0.0.1:{port} — Ctrl+C pour arrêter.', flush=True)
    if host == '0.0.0.0' and lan_address():
        print(f'Depuis un téléphone sur le même Wi-Fi : http://{lan_address()}:{port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
