import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { skipUnless } from './helpers/strict-skip';

/**
 * The browser driver needs Qt WebEngine, which CI does not have (the worker image carries it, and the image build draws a page with
 * it). What CI can hold the driver to is the shape of the browser it starts: the one route to the network, and the limits the page
 * runs under. A change that drops one of these takes the gate out of the path of the page, so each is pinned here by its text.
 */

const DRIVER = path.resolve(__dirname, '..', 'native', 'capture-website', 'capture.py');
const source = readFileSync(DRIVER, 'utf8');
const PYTHON = ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'].find((candidate) => existsSync(candidate));

/** Every command-line switch of the browser the driver names, in the order it names them. */
const switches = [...source.matchAll(/'(--[^']*)'/g)].map((match) => match[1]);
const numberOf = (name: string): string | undefined => new RegExp(`${name} = (\\d+)`).exec(source)?.[1];

describe('the capture driver', () => {
  it('sends every request to the gate: the proxy is the only route, loopback and link-local addresses are not exempt, and no name is resolved by the browser', () => {
    expect(switches.filter((flag) => /^--(proxy|host-resolver)/.test(flag))).toEqual([
      '--proxy-server=http://127.0.0.1:%d',
      '--proxy-bypass-list=<-loopback>',
      '--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"',
    ]);
  });

  it('keeps WebRTC off a direct route and DNS prefetch off, and starts no background network traffic', () => {
    expect(switches.filter((flag) => /webrtc|dns-prefetch|background-networking|component-update|sync/.test(flag))).toEqual([
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--dns-prefetch-disable',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--force-webrtc-ip-handling-policy',
    ]);
  });

  it('loads only web pages and data URLs: no file, ftp or other scheme is allowed, and the browser refuses the rest itself', () => {
    expect(source).toContain("ALLOWED_SCHEMES = ('http', 'https', 'data', 'about', 'blob')");
    expect(source).toContain('info.block(True)');
    expect(source).not.toMatch(/ALLOWED_SCHEMES[^\n]*'(file|ftp|ws|wss|chrome|view-source|filesystem)'/);
  });

  it('runs the page without windows, downloads, plug-ins, file access, device permissions or stored state', () => {
    for (const setting of ["('JavascriptCanOpenWindows', False)", "('PluginsEnabled', False)", "('LocalContentCanAccessFileUrls', False)", "('LocalContentCanAccessRemoteUrls', False)", "('ScreenCaptureEnabled', False)", "('JavascriptCanAccessClipboard', False)", "('WebRTCPublicInterfacesOnly', True)"]) {
      expect(source).toContain(setting);
    }
    expect(source).toContain('profile.downloadRequested.connect(lambda item: item.cancel())');
    expect(source).toContain('PermissionDeniedByUser');
    expect(source).toContain('NoPersistentCookies');
  });

  it('keeps the size of a picture and the wait of a page within fixed bounds', () => {
    expect([numberOf('MAX_FULL_PAGE_HEIGHT'), numberOf('MAX_DELAY_MS')]).toEqual(['16384', '30000']);
    expect(/max\(200, min\(parse_guarded_int\(viewport\.get\('width'\), 1280\), (\d+)\)\)/.exec(source)?.[1]).toBe('3840');
    expect(/max\(200, min\(parse_guarded_int\(viewport\.get\('height'\), 800\), ([A-Z_]+)\)\)/.exec(source)?.[1]).toBe('MAX_FULL_PAGE_HEIGHT');
  });

  it('runs page height probes in an isolated JS world with guarded null-safe script', () => {
    expect(source).toContain('QWebEngineScript');
    expect(source).toMatch(/page\.runJavaScript\(\s*PAGE_HEIGHT_SCRIPT,\s*QWebEngineScript\.ScriptWorldId\.ApplicationWorld,\s*grab\s*\)/);
    expect(source).toContain('document.documentElement ? Number(document.documentElement.scrollHeight) || 0 : 0');
    expect(source).toContain('document.body ? Number(document.body.scrollHeight) || 0 : 0');
  });

  it.skipIf(skipUnless('a Python 3 interpreter', PYTHON !== undefined))('is valid Python 3 and guards page-height and integer parsing against hostile or non-finite inputs', () => {
    const script = `
import importlib.util, json, math, sys
spec = importlib.util.spec_from_file_location('capture_driver', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert mod.parse_guarded_int(None, 42) == 42
assert mod.parse_guarded_int(True, 42) == 42
assert mod.parse_guarded_int(False, 42) == 42
assert mod.parse_guarded_int(float('nan'), 42) == 42
assert mod.parse_guarded_int(float('inf'), 42) == 42
assert mod.parse_guarded_int(float('-inf'), 42) == 42
assert mod.parse_guarded_int('1_000', 42) == 42
assert mod.parse_guarded_int('1e309', 42) == 42
assert mod.parse_guarded_int('  -15  ', 42) == -15
assert mod.parse_guarded_int(' 250 ', 42) == 250

assert mod.parse_page_height(2400, 800) == 2400
assert mod.parse_page_height(2400.9, 800) == 2400
assert mod.parse_page_height(50000, 800) == mod.MAX_FULL_PAGE_HEIGHT
assert mod.parse_page_height(10**500, 800) == mod.MAX_FULL_PAGE_HEIGHT
assert mod.parse_page_height(0, 800) == 800
assert mod.parse_page_height(-50, 800) == 800
assert mod.parse_page_height(None, 800) == 800
assert mod.parse_page_height(True, 800) == 800
assert mod.parse_page_height(False, 800) == 800
assert mod.parse_page_height(float('nan'), 800) == 800
assert mod.parse_page_height(float('inf'), 800) == 800
assert mod.parse_page_height(float('-inf'), 800) == 800
assert mod.parse_page_height('not-a-number', 800) == 800
assert mod.parse_page_height('NaN', 800) == 800
assert mod.parse_page_height('Infinity', 800) == 800
assert mod.parse_page_height('9' * 5000, 800) == 800
assert mod.parse_page_height('1_000', 800) == 800
assert mod.parse_page_height('2500.7', 800) == 2500
assert mod.parse_page_height({'scrollHeight': 1000}, 800) == 800
assert mod.parse_page_height([1000], 800) == 800
assert mod.parse_guarded_float(float('nan'), 1.0) == 1.0
assert mod.parse_guarded_float(float('inf'), 1.0) == 1.0
assert mod.parse_guarded_float(float('-inf'), 1.0) == 1.0
assert mod.parse_guarded_float('1_000', 1.0) == 1.0
assert mod.parse_guarded_float('9' * 5000, 1.0) == 1.0
assert mod.parse_guarded_float(True, 1.0) == 1.0
assert mod.parse_guarded_float('2.5', 1.0) == 2.5

flags = mod.chromium_flags({'proxyPort': 9})
assert '--proxy-server=http://127.0.0.1:9' in flags
for bad_port in (None, True, False, float('nan'), float('inf'), 0, -1, 65536, 'bad'):
    try:
        mod.chromium_flags({'proxyPort': bad_port})
    except ValueError:
        pass
    else:
        raise AssertionError('expected ValueError for proxyPort=' + repr(bad_port))
for bad_sock in (None, '', '   ', 'relative.sock', '/tmp/with\\x00nul.sock', '/' + 'x' * mod.MAX_UNIX_SOCKET_PATH_BYTES + '.sock', 123):
    try:
        mod.validate_proxy_socket(bad_sock)
    except ValueError:
        pass
    else:
        raise AssertionError('expected ValueError for proxySocket=' + repr(bad_sock))
max_ok = '/' + 'x' * (mod.MAX_UNIX_SOCKET_PATH_BYTES - 1)
assert mod.validate_proxy_socket(max_ok) == max_ok
print('ok')
`;
    const checked = execFileSync(PYTHON as string, ['-I', '-c', script, DRIVER], { encoding: 'utf8' });
    expect(checked.trim()).toBe('ok');
  });

  it.skipIf(skipUnless('a Python 3 interpreter', PYTHON !== undefined))('bridges loopback TCP connections to an AF_UNIX gate socket with half-close, backpressure, concurrency, and teardown', () => {
    const relayScript = `
import importlib.util, os, socket, struct, sys, tempfile, threading, time

spec = importlib.util.spec_from_file_location('capture_driver', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

with tempfile.TemporaryDirectory(prefix='ecg-drv-') as td:
    sock_path = os.path.join(td, 'g.sock')
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(sock_path)
    srv.listen(32)
    stop_srv = threading.Event()
    client_saw_early_resp = threading.Event()
    early_403_resp = b'HTTP/1.1 403 Refused\\r\\nx-capture-gate: blocked\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n'

    def serve_conn(conn):
        try:
            chunks = []
            read_total = 0
            while True:
                data = conn.recv(256 if read_total < 1024 else 65536)
                if not data:
                    break
                chunks.append(data)
                read_total += len(data)
                head = b''.join(chunks[:4])
                if b'\\r\\n\\r\\n' in head and b'EARLY403_PHASED' in head:
                    conn.sendall(early_403_resp)
                    try:
                        conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
                    except OSError:
                        pass
                    client_saw_early_resp.wait(timeout=3)
                    return
                if b'\\r\\n\\r\\n' in head and b'EARLY403_LINGER' in head:
                    conn.sendall(early_403_resp)
                    try:
                        conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
                    except OSError:
                        pass
                    return
                if b'\\r\\n\\r\\n' in head and b'EARLY403' in head:
                    conn.sendall(early_403_resp)
                    return
            payload = b''.join(chunks)
            conn.sendall(b'ECHO:' + payload)
            conn.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def accept_loop():
        srv.settimeout(0.2)
        while not stop_srv.is_set():
            try:
                c, _ = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=serve_conn, args=(c,), daemon=True).start()

    srv_thread = threading.Thread(target=accept_loop, daemon=True)
    srv_thread.start()

    relay = mod.GateRelay(sock_path).start()
    try:
        assert 1 <= relay.port <= 65535
        # Large (>300 KiB) bidirectional half-close stream exercising backpressure watermark
        big = b'A' * (320 * 1024)
        c = socket.create_connection(('127.0.0.1', relay.port), timeout=5)
        c.sendall(big)
        c.shutdown(socket.SHUT_WR)
        got = bytearray()
        while True:
            chunk = c.recv(65536)
            if not chunk:
                break
            got.extend(chunk)
        c.close()
        assert bytes(got) == b'ECHO:' + big, f'got {len(got)} bytes'

        # Concurrent short requests
        results = []
        errs = []
        def worker(i):
            try:
                s = socket.create_connection(('127.0.0.1', relay.port), timeout=5)
                msg = ('req-%d' % i).encode()
                s.sendall(msg)
                s.shutdown(socket.SHUT_WR)
                buf = bytearray()
                while True:
                    d = s.recv(4096)
                    if not d:
                        break
                    buf.extend(d)
                s.close()
                results.append(bytes(buf) == b'ECHO:' + msg)
            except Exception as e:
                errs.append(repr(e))
        ts = [threading.Thread(target=worker, args=(i,)) for i in range(16)]
        for t in ts: t.start()
        for t in ts: t.join(timeout=5)
        assert not errs and len(results) == 16 and all(results)

        # Early 403 response before reading a 512 KiB POST body must reach the client intact (not ECONNRESET / empty)
        early = socket.create_connection(('127.0.0.1', relay.port), timeout=5)
        early_resp = bytearray()
        early_errs = []
        def early_reader():
            while True:
                try:
                    d = early.recv(4096)
                    if not d:
                        break
                    early_resp.extend(d)
                except OSError as e:
                    early_errs.append(repr(e))
                    break
        rt = threading.Thread(target=early_reader, daemon=True)
        rt.start()
        early_body = b'Y' * (512 * 1024)
        try:
            early.sendall(b'POST http://169.254.169.254/EARLY403 HTTP/1.1\\r\\nHost: 169.254.169.254\\r\\nContent-Length: ' + str(len(early_body)).encode() + b'\\r\\n\\r\\n' + early_body)
        except OSError:
            pass
        rt.join(timeout=5)
        early.close()
        assert bytes(early_resp).startswith(b'HTTP/1.1 403 Refused\\r\\nx-capture-gate: blocked'), f'early403={early_resp!r} errs={early_errs!r}'

        # Small early-403 POST with unread body + SO_LINGER on AF_UNIX server (triggers ECONNRESET on Linux while pair.unix_wr_closed is False)
        small_early = socket.create_connection(('127.0.0.1', relay.port), timeout=5)
        small_body = b'S' * 8192
        small_early.sendall(b'POST http://169.254.169.254/EARLY403_LINGER HTTP/1.1\\r\\nHost: 169.254.169.254\\r\\nContent-Length: ' + str(len(small_body)).encode() + b'\\r\\n\\r\\n' + small_body)
        small_resp = bytearray()
        small_errs = []
        while True:
            try:
                d = small_early.recv(4096)
                if not d:
                    break
                small_resp.extend(d)
            except OSError as e:
                small_errs.append(repr(e))
                break
        small_early.close()
        assert bytes(small_resp) == early_403_resp and not small_errs, f'small_early={small_resp!r} errs={small_errs!r}'

        # Live AF_UNIX early-403 + SO_LINGER with unread POST body: relay must propagate SHUT_WR and drain trailing POST bytes instead of resetting client
        stream_early = socket.create_connection(('127.0.0.1', relay.port), timeout=5)
        init_body = b'I' * 16384
        tail_chunk = b'T' * 32768
        tail_chunks = 8
        stream_early.sendall(
            b'POST http://169.254.169.254/EARLY403_LINGER HTTP/1.1\\r\\nHost: 169.254.169.254\\r\\nContent-Length: '
            + str(len(init_body) + len(tail_chunk) * tail_chunks).encode()
            + b'\\r\\n\\r\\n'
            + init_body
        )
        stream_resp = bytearray()
        stream_errs = []
        while True:
            try:
                d = stream_early.recv(4096)
                if not d:
                    break
                stream_resp.extend(d)
            except OSError as e:
                stream_errs.append(repr(e))
                break
        assert bytes(stream_resp) == early_403_resp and not stream_errs, f'stream_early={stream_resp!r} errs={stream_errs!r}'
        for _ in range(tail_chunks):
            stream_early.sendall(tail_chunk)
            time.sleep(0.005)
        stream_early.shutdown(socket.SHUT_WR)
        stream_early.close()

        # Phased Case B live probe: wait until client reads 403 (to_client empty) before AF_UNIX closes with unread POST bytes
        phased_early = socket.create_connection(('127.0.0.1', relay.port), timeout=5)
        phased_early.sendall(
            b'POST http://169.254.169.254/EARLY403_PHASED HTTP/1.1\\r\\nHost: 169.254.169.254\\r\\nContent-Length: '
            + str(len(init_body) + len(tail_chunk) * tail_chunks).encode()
            + b'\\r\\n\\r\\n'
            + init_body
        )
        phased_resp = bytearray()
        phased_errs = []
        try:
            while len(phased_resp) < len(early_403_resp):
                d = phased_early.recv(4096)
                if not d:
                    break
                phased_resp.extend(d)
        except OSError as e:
            phased_errs.append(repr(e))
        finally:
            client_saw_early_resp.set()
        while True:
            try:
                d = phased_early.recv(4096)
                if not d:
                    break
                phased_resp.extend(d)
            except OSError as e:
                phased_errs.append(repr(e))
                break
        assert bytes(phased_resp) == early_403_resp and not phased_errs, f'phased_early={phased_resp!r} errs={phased_errs!r}'
        for _ in range(tail_chunks):
            phased_early.sendall(tail_chunk)
            time.sleep(0.005)
        phased_early.shutdown(socket.SHUT_WR)
        phased_early.close()

        # Client SO_LINGER(1, 0) abortive close triggers client.recv OSError and tears down cleanly without breaking subsequent relays
        abortive = socket.create_connection(('127.0.0.1', relay.port), timeout=5)
        abortive.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
        abortive.sendall(b'POST http://allowed.example/partial HTTP/1.1\\r\\nHost: allowed.example\\r\\nContent-Length: 1024\\r\\n\\r\\nabc')
        abortive.close()

        followup = socket.create_connection(('127.0.0.1', relay.port), timeout=5)
        followup.sendall(b'after-client-linger-reset')
        followup.shutdown(socket.SHUT_WR)
        fbuf = bytearray()
        while True:
            d = followup.recv(4096)
            if not d:
                break
            fbuf.extend(d)
        followup.close()
        assert bytes(fbuf) == b'ECHO:after-client-linger-reset'

        for _ in range(50):
            if not relay._conns:
                break
            time.sleep(0.01)
        assert len(relay._conns) == 0, f'leaked relay conns: {len(relay._conns)}'

        # Fail-closed when AF_UNIX target disappears
        stop_srv.set()
        srv.close()
        missing = mod.GateRelay(os.path.join(td, 'missing.sock')).start()
        try:
            d = socket.create_connection(('127.0.0.1', missing.port), timeout=2)
            try:
                d.sendall(b'CONNECT example.com:443 HTTP/1.1\\r\\n\\r\\n')
                assert d.recv(1024) == b''
            except (ConnectionResetError, BrokenPipeError):
                pass
            finally:
                d.close()
        finally:
            missing.close()
    finally:
        client_saw_early_resp.set()
        stop_srv.set()
        relay.close()
        relay.close()  # idempotent
        try:
            srv.close()
        except OSError:
            pass
print('relay-ok')
`;
    const checked = execFileSync(PYTHON as string, ['-I', '-c', relayScript, DRIVER], { encoding: 'utf8' });
    expect(checked.trim()).toBe('relay-ok');
  });

  it.skipIf(skipUnless('a Python 3 interpreter', PYTHON !== undefined))('preserves buffered 403, propagates SHUT_WR, and drains trailing client bytes on upstream ECONNRESET while closing on client OSError in GateRelay._handle_pair', () => {
    const handlePairScript = `
import errno, importlib.util, os, selectors, socket, sys, tempfile, time

spec = importlib.util.spec_from_file_location('capture_driver', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class ResetOnRecvSocket:
    def __init__(self, inner, err=None):
        self._inner = inner
        self._err = err if err is not None else ConnectionResetError(errno.ECONNRESET, 'Connection reset by peer')
    def recv(self, _size):
        raise self._err
    def __getattr__(self, name):
        return getattr(self._inner, name)

def tcp_pair():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(('127.0.0.1', 0))
    srv.listen(1)
    peer = socket.create_connection(('127.0.0.1', srv.getsockname()[1]), timeout=3)
    accepted, _ = srv.accept()
    srv.close()
    accepted.setblocking(False)
    peer.settimeout(3)
    return peer, accepted

def wait_until(step, tries=50):
    for _ in range(tries):
        if step():
            return
        time.sleep(0.01)
    raise AssertionError('timed out waiting for _handle_pair state')

with tempfile.TemporaryDirectory(prefix='ecg-hp-') as td:
    sock_path = os.path.join(td, 'g.sock')
    relay = mod.GateRelay(sock_path)
    try:
        resp_403 = b'HTTP/1.1 403 Refused\\r\\nx-capture-gate: blocked\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n'

        # (a) Case A: unix_wr_closed is False and to_client holds an early 403 when pair.unix.recv() raises ECONNRESET
        peer_a, client_a = tcp_pair()
        u_a1, u_a2 = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        u_a1.setblocking(False)
        u_a2.close()
        pair_a = mod._RelayPair(client_a, ResetOnRecvSocket(u_a1), True)
        pair_a.unix_wr_closed = False
        pair_a.to_client.extend(resp_403)
        pair_a.to_unix.extend(b'unsent-post-body')
        relay._conns.add(pair_a)
        relay._sync_events(pair_a)

        relay._handle_pair(pair_a, False, selectors.EVENT_READ | selectors.EVENT_WRITE)
        assert pair_a.closed is False, 'Case A: dropped buffered 403 by closing pair'
        assert pair_a.unix_eof is True
        assert pair_a.unix_wr_closed is True
        assert len(pair_a.to_unix) == 0
        assert bytes(pair_a.to_client) == resp_403
        assert u_a1.fileno() not in relay._registered
        assert (relay._registered.get(client_a.fileno(), 0) & selectors.EVENT_WRITE) != 0

        for _ in range(10):
            if not pair_a.to_client:
                break
            relay._handle_pair(pair_a, True, selectors.EVENT_WRITE)
        assert len(pair_a.to_client) == 0
        assert pair_a.client_wr_closed is True
        assert pair_a.closed is False

        peer_a.sendall(b'trailing-body-after-403')
        peer_a.shutdown(socket.SHUT_WR)
        got_a = bytearray()
        while True:
            chunk = peer_a.recv(4096)
            if not chunk:
                break
            got_a.extend(chunk)
        peer_a.close()
        assert bytes(got_a) == resp_403

        wait_until(lambda: (relay._handle_pair(pair_a, True, selectors.EVENT_READ), pair_a.closed)[1])
        assert pair_a.client_eof is True
        assert pair_a.discarded_client_bytes == len(b'trailing-body-after-403')
        assert pair_a not in relay._conns

        # (b) Case B: to_client is empty when ECONNRESET occurs (both unix_wr_closed=True and False) while client holds unread POST bytes
        for initial_wr_closed in (True, False):
            peer_b, client_b = tcp_pair()
            u_b1, u_b2 = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            u_b1.setblocking(False)
            u_b2.close()
            pair_b = mod._RelayPair(client_b, ResetOnRecvSocket(u_b1), True)
            pair_b.unix_wr_closed = initial_wr_closed
            pair_b.to_client.extend(resp_403)
            relay._conns.add(pair_b)
            relay._sync_events(pair_b)

            unread_1 = b'P' * 16384
            peer_b.sendall(unread_1)
            for _ in range(10):
                if not pair_b.to_client:
                    break
                relay._handle_pair(pair_b, True, selectors.EVENT_WRITE)
            assert len(pair_b.to_client) == 0
            assert pair_b.client_wr_closed is False

            relay._handle_pair(pair_b, False, selectors.EVENT_READ)
            assert pair_b.closed is False, f'Case B: closed prematurely (wr_closed={initial_wr_closed})'
            assert pair_b.unix_eof is True
            assert pair_b.unix_wr_closed is True
            assert pair_b.client_wr_closed is True
            assert u_b1.fileno() not in relay._registered
            assert relay._registered.get(client_b.fileno()) == selectors.EVENT_READ

            got_b = bytearray()
            while True:
                chunk = peer_b.recv(4096)
                if not chunk:
                    break
                got_b.extend(chunk)
            assert bytes(got_b) == resp_403

            unread_2 = b'Q' * 16384
            peer_b.sendall(unread_2)
            wait_until(lambda: (relay._handle_pair(pair_b, True, selectors.EVENT_READ), pair_b.discarded_client_bytes >= len(unread_1) + len(unread_2))[1])
            peer_b.shutdown(socket.SHUT_WR)
            peer_b.close()
            wait_until(lambda: (relay._handle_pair(pair_b, True, selectors.EVENT_READ), pair_b.closed)[1])
            assert pair_b.client_eof is True
            assert pair_b.discarded_client_bytes == len(unread_1) + len(unread_2)
            assert pair_b not in relay._conns

        # (b2) Discarding trailing client bytes stops at RELAY_DISCARD_LIMIT_BYTES while flushing buffered 403 + SHUT_WR
        peer_lim, client_lim = tcp_pair()
        u_l1, u_l2 = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        u_l1.setblocking(False)
        u_l2.close()
        pair_lim = mod._RelayPair(client_lim, ResetOnRecvSocket(u_l1), True)
        pair_lim.to_client.extend(resp_403)
        pair_lim.discarded_client_bytes = mod.RELAY_DISCARD_LIMIT_BYTES - 1024
        relay._conns.add(pair_lim)
        relay._sync_events(pair_lim)
        relay._handle_pair(pair_lim, False, selectors.EVENT_READ)
        assert pair_lim.closed is False and pair_lim.client_wr_closed is False
        peer_lim.sendall(b'Z' * 2048)
        wait_until(lambda: (relay._handle_pair(pair_lim, True, selectors.EVENT_READ), pair_lim.client_eof)[1])
        assert pair_lim.client_eof is True
        assert pair_lim.discarded_client_bytes >= mod.RELAY_DISCARD_LIMIT_BYTES
        assert pair_lim.closed is False and bytes(pair_lim.to_client) == resp_403
        for _ in range(10):
            if pair_lim.closed:
                break
            relay._handle_pair(pair_lim, True, selectors.EVENT_WRITE)
        assert pair_lim.client_wr_closed is True and pair_lim.closed is True
        got_lim = bytearray()
        while True:
            chunk = peer_lim.recv(4096)
            if not chunk:
                break
            got_lim.extend(chunk)
        assert bytes(got_lim) == resp_403
        peer_lim.close()

        # (c) Client recv() OSError (is_client=True) closes the pair cleanly without preserving upstream state
        peer_c, client_c = tcp_pair()
        u_c1, u_c2 = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        u_c1.setblocking(False)
        pair_c = mod._RelayPair(ResetOnRecvSocket(client_c), u_c1, True)
        pair_c.to_client.extend(resp_403)
        relay._conns.add(pair_c)
        relay._sync_events(pair_c)
        c_fd = client_c.fileno()
        u_fd = u_c1.fileno()
        relay._handle_pair(pair_c, True, selectors.EVENT_READ)
        assert pair_c.closed is True
        assert pair_c not in relay._conns
        assert c_fd not in relay._registered
        assert u_fd not in relay._registered
        assert client_c.fileno() == -1
        assert u_c1.fileno() == -1
        peer_c.close()
        u_c2.close()
    finally:
        relay.close()
print('handle-pair-ok')
`;
    const checked = execFileSync(PYTHON as string, ['-I', '-c', handlePairScript, DRIVER], { encoding: 'utf8' });
    expect(checked.trim()).toBe('handle-pair-ok');
  });
});
