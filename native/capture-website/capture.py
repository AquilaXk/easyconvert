#!/usr/bin/env python3
"""Website capture driver: loads one page in Qt WebEngine (Chromium) and writes it as a PDF, a PNG or a JPEG.

The worker runs this program as a separate sandboxed process inside an isolated network namespace (src/lib/capture/website-capture.ts).
It reads one JSON request file (argv[1]) and prints one JSON line on standard output. When given `proxySocket` (an AF_UNIX gate
socket across the network namespace boundary), this program brings loopback up inside the isolated namespace and relays an ephemeral
local 127.0.0.1 TCP listener to `proxySocket`, so the browser has no host network access and every request goes to the SSRF-checking
gate (`capture-gate.ts`). `proxyPort` remains supported for standalone local checks; browser-side restrictions additionally limit URLs to
http/https/data/about/blob, block file access, popups, downloads, device permissions, plug-ins, direct WebRTC UDP, and persistent state.

Request fields: url, format (pdf|png|jpg), proxySocket|proxyPort, timeoutMs, waitUntil (load|idle), delayMs, viewport {width, height, scale},
fullPage, quality, userAgent, pdf {paper|width+height (mm), landscape, margin (mm), printBackground, scale}, output (file name).
Result fields: ok, output, finalUrl, title, blocked (URLs the browser refused), or ok=false with code and detail.
"""
import errno
import fcntl
import json
import math
import os
import selectors
import socket
import struct
import sys
import threading

MAX_FULL_PAGE_HEIGHT = 16384
MAX_DELAY_MS = 30000
IDLE_QUIET_MS = 500
SETTLE_MS = 300
DEFAULT_TIMEOUT_MS = 30000
MAX_UNIX_SOCKET_PATH_BYTES = 107 if sys.platform.startswith('linux') else 103
MAX_RELAY_CONNECTIONS = 128
RELAY_BUFFER_BYTES = 65536
RELAY_HIGH_WATER_BYTES = 262144
RELAY_DISCARD_LIMIT_BYTES = 2 * 1024 * 1024
IFF_UP = 0x1
SIOCGIFFLAGS = 0x8913
SIOCSIFFLAGS = 0x8914
MM_PER_INCH = 25.4
PAPERS = {'A3': 'A3', 'A4': 'A4', 'A5': 'A5', 'Letter': 'Letter', 'Legal': 'Legal', 'Tabloid': 'Tabloid'}
ALLOWED_SCHEMES = ('http', 'https', 'data', 'about', 'blob')
PAGE_HEIGHT_SCRIPT = (
    'Math.max('
    'document.documentElement ? Number(document.documentElement.scrollHeight) || 0 : 0, '
    'document.body ? Number(document.body.scrollHeight) || 0 : 0'
    ')'
)

CHROMIUM_FLAGS = [
    '--no-sandbox',  # the process runs inside the worker's own sandbox; Chromium's needs namespaces that sandbox does not give it
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-domain-reliability',
    '--dns-prefetch-disable',
    '--mute-audio',
    '--no-first-run',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--force-webrtc-ip-handling-policy',
]


def emit(result):
    sys.stdout.write(json.dumps(result) + '\n')
    sys.stdout.flush()


def fail(code, detail):
    emit({'ok': False, 'code': code, 'detail': str(detail)[:300]})
    return 0


def parse_guarded_int(value, fallback):
    if value is None or isinstance(value, bool):
        return fallback
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if math.isfinite(value) else fallback
    if isinstance(value, str):
        text = value.strip()
        if not text or '_' in text:
            return fallback
        try:
            numeric = float(text)
        except (TypeError, ValueError, OverflowError):
            return fallback
        return int(numeric) if math.isfinite(numeric) else fallback
    return fallback


def parse_guarded_float(value, fallback):
    if value is None or isinstance(value, bool):
        return fallback
    if isinstance(value, (int, float)):
        numeric = float(value)
        return numeric if math.isfinite(numeric) else fallback
    if isinstance(value, str):
        text = value.strip()
        if not text or '_' in text:
            return fallback
        try:
            numeric = float(text)
        except (TypeError, ValueError, OverflowError):
            return fallback
        return numeric if math.isfinite(numeric) else fallback
    return fallback


def parse_page_height(value, fallback, maximum=MAX_FULL_PAGE_HEIGHT):
    parsed = parse_guarded_int(value, fallback)
    if parsed <= 0:
        return fallback
    return min(parsed, maximum)


def validate_proxy_socket(value):
    if not isinstance(value, str) or not value.strip() or '\x00' in value or not os.path.isabs(value):
        raise ValueError('proxySocket must be a non-empty absolute path without NUL bytes')
    if len(value.encode('utf-8')) > MAX_UNIX_SOCKET_PATH_BYTES:
        raise ValueError('proxySocket exceeds POSIX AF_UNIX path limit')
    return value


def ensure_loopback_up():
    if not sys.platform.startswith('linux'):
        return
    ctl = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        ifreq = fcntl.ioctl(ctl.fileno(), SIOCGIFFLAGS, struct.pack('16sH22x', b'lo', 0))
        flags = struct.unpack('16sH22x', ifreq)[1]
        if not (flags & IFF_UP):
            fcntl.ioctl(ctl.fileno(), SIOCSIFFLAGS, struct.pack('16sH22x', b'lo', flags | IFF_UP))
    finally:
        ctl.close()


class _RelayPair:
    def __init__(self, client, unix_sock, unix_connected):
        self.client = client
        self.unix = unix_sock
        self.unix_connected = unix_connected
        self.to_unix = bytearray()
        self.to_client = bytearray()
        self.client_eof = False
        self.unix_eof = False
        self.client_wr_closed = False
        self.unix_wr_closed = False
        self.discarded_client_bytes = 0
        self.closed = False


class GateRelay:
    """Single-threaded non-blocking loopback-to-AF_UNIX relay for an isolated network namespace."""

    def __init__(self, socket_path):
        self._socket_path = validate_proxy_socket(socket_path)
        self._selector = None
        self._server = None
        self._wake_r = None
        self._wake_w = None
        self._registered = {}
        self._conns = set()
        self._stop = False
        self._thread = None
        try:
            self._selector = selectors.DefaultSelector()
            self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self._server.bind(('127.0.0.1', 0))
            self._server.listen(MAX_RELAY_CONNECTIONS)
            self._server.setblocking(False)
            self.port = self._server.getsockname()[1]
            self._wake_r, self._wake_w = socket.socketpair()
            self._wake_r.setblocking(False)
            self._wake_w.setblocking(False)
        except Exception:
            for sock in (self._server, self._wake_r, self._wake_w):
                if sock is not None:
                    try:
                        sock.close()
                    except OSError:
                        pass
            if self._selector is not None:
                try:
                    self._selector.close()
                except OSError:
                    pass
            raise

    def start(self):
        self._set_events(self._server, selectors.EVENT_READ, ('accept', None))
        self._set_events(self._wake_r, selectors.EVENT_READ, ('wake', None))
        self._thread = threading.Thread(target=self._run, name='capture-gate-relay', daemon=True)
        self._thread.start()
        return self

    def _set_events(self, sock, events, data):
        try:
            fd = sock.fileno()
        except OSError:
            return
        if fd < 0:
            return
        if events == 0:
            if fd in self._registered:
                try:
                    self._selector.unregister(sock)
                except (KeyError, ValueError, OSError):
                    pass
                self._registered.pop(fd, None)
            return
        if fd in self._registered:
            if self._registered[fd] != events:
                self._selector.modify(sock, events, data)
                self._registered[fd] = events
        else:
            self._selector.register(sock, events, data)
            self._registered[fd] = events

    def _close_pair(self, pair):
        if pair.closed:
            return
        pair.closed = True
        self._conns.discard(pair)
        for sock in (pair.client, pair.unix):
            try:
                fd = sock.fileno()
            except OSError:
                fd = -1
            if fd >= 0 and fd in self._registered:
                try:
                    self._selector.unregister(sock)
                except (KeyError, ValueError, OSError):
                    pass
                self._registered.pop(fd, None)
            try:
                sock.close()
            except OSError:
                pass

    def _sync_events(self, pair):
        if pair.closed:
            return
        if pair.client_eof and not pair.to_unix and not pair.unix_wr_closed and pair.unix_connected:
            try:
                pair.unix.shutdown(socket.SHUT_WR)
            except OSError:
                pass
            pair.unix_wr_closed = True
        if pair.unix_eof and not pair.to_client and not pair.client_wr_closed:
            try:
                pair.client.shutdown(socket.SHUT_WR)
            except OSError:
                pass
            pair.client_wr_closed = True
        if pair.client_eof and pair.unix_eof and not pair.to_unix and not pair.to_client:
            self._close_pair(pair)
            return
        client_events = 0
        if not pair.client_eof and (pair.unix_wr_closed or len(pair.to_unix) < RELAY_HIGH_WATER_BYTES):
            client_events |= selectors.EVENT_READ
        if pair.to_client:
            client_events |= selectors.EVENT_WRITE
        unix_events = 0
        if not pair.unix_connected:
            unix_events |= selectors.EVENT_WRITE
        else:
            if not pair.unix_eof and len(pair.to_client) < RELAY_HIGH_WATER_BYTES:
                unix_events |= selectors.EVENT_READ
            if not pair.unix_wr_closed and pair.to_unix:
                unix_events |= selectors.EVENT_WRITE
        if client_events == 0 and unix_events == 0:
            self._close_pair(pair)
            return
        self._set_events(pair.client, client_events, ('pair', (pair, True)))
        self._set_events(pair.unix, unix_events, ('pair', (pair, False)))

    def _accept(self):
        while True:
            try:
                client, _ = self._server.accept()
            except BlockingIOError:
                break
            except OSError:
                break
            if len(self._conns) >= MAX_RELAY_CONNECTIONS:
                try:
                    client.close()
                except OSError:
                    pass
                continue
            unix_sock = None
            try:
                client.setblocking(False)
                try:
                    client.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                except OSError:
                    pass
                unix_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                unix_sock.setblocking(False)
                rc = unix_sock.connect_ex(self._socket_path)
            except OSError:
                for sock in (client, unix_sock):
                    if sock is not None:
                        try:
                            sock.close()
                        except OSError:
                            pass
                continue
            if rc != 0 and rc not in (errno.EINPROGRESS, errno.EAGAIN, errno.EWOULDBLOCK):
                for sock in (client, unix_sock):
                    try:
                        sock.close()
                    except OSError:
                        pass
                continue
            pair = _RelayPair(client, unix_sock, rc == 0)
            self._conns.add(pair)
            self._sync_events(pair)

    def _handle_pair(self, pair, is_client, mask):
        if pair.closed:
            return
        if not is_client and (mask & selectors.EVENT_WRITE) and not pair.unix_connected:
            try:
                err = pair.unix.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            except OSError:
                self._close_pair(pair)
                return
            if err != 0:
                self._close_pair(pair)
                return
            pair.unix_connected = True
        if mask & selectors.EVENT_READ:
            sock = pair.client if is_client else pair.unix
            outbuf = pair.to_unix if is_client else pair.to_client
            try:
                chunk = sock.recv(RELAY_BUFFER_BYTES)
            except BlockingIOError:
                chunk = None
            except OSError:
                if not is_client:
                    # Peer closed with unread request bytes (e.g. ECONNRESET on Linux): flush any buffered
                    # response, propagate SHUT_WR, and drain trailing client bytes cleanly instead of resetting.
                    pair.unix_eof = True
                    pair.unix_wr_closed = True
                    pair.to_unix.clear()
                    chunk = None
                else:
                    self._close_pair(pair)
                    return
            if chunk == b'':
                if is_client:
                    pair.client_eof = True
                else:
                    pair.unix_eof = True
            elif chunk:
                if is_client and pair.unix_wr_closed:
                    pair.discarded_client_bytes += len(chunk)
                    if pair.discarded_client_bytes >= RELAY_DISCARD_LIMIT_BYTES:
                        pair.client_eof = True
                else:
                    outbuf.extend(chunk)
        if mask & selectors.EVENT_WRITE:
            if is_client and pair.to_client:
                try:
                    sent = pair.client.send(memoryview(pair.to_client))
                    if sent > 0:
                        del pair.to_client[:sent]
                except BlockingIOError:
                    pass
                except OSError:
                    self._close_pair(pair)
                    return
            elif not is_client and pair.unix_connected and not pair.unix_wr_closed and pair.to_unix:
                try:
                    sent = pair.unix.send(memoryview(pair.to_unix))
                    if sent > 0:
                        del pair.to_unix[:sent]
                except BlockingIOError:
                    pass
                except OSError:
                    # Keep reading and flushing any early response (e.g. 403 Refused) before tearing down the client socket.
                    pair.unix_wr_closed = True
                    pair.to_unix.clear()
        self._sync_events(pair)

    def _run(self):
        while not self._stop:
            try:
                ready = self._selector.select()
            except OSError:
                break
            for key, mask in ready:
                kind, payload = key.data
                if kind == 'wake':
                    try:
                        self._wake_r.recv(64)
                    except OSError:
                        pass
                    break
                if kind == 'accept':
                    self._accept()
                else:
                    pair, is_client = payload
                    self._handle_pair(pair, is_client, mask)

    def close(self):
        if self._stop:
            return
        self._stop = True
        try:
            self._wake_w.send(b'x')
        except OSError:
            pass
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        for pair in list(self._conns):
            self._close_pair(pair)
        for sock in (self._server, self._wake_r, self._wake_w):
            try:
                fd = sock.fileno()
                if fd >= 0 and fd in self._registered:
                    self._selector.unregister(sock)
                    self._registered.pop(fd, None)
            except (KeyError, ValueError, OSError):
                pass
            try:
                sock.close()
            except OSError:
                pass
        try:
            self._selector.close()
        except OSError:
            pass


def chromium_flags(request):
    port = parse_guarded_int(request.get('proxyPort'), 0)
    if port < 1 or port > 65535:
        raise ValueError('proxyPort must be between 1 and 65535')
    flags = list(CHROMIUM_FLAGS)
    flags.append('--proxy-server=http://127.0.0.1:%d' % port)
    # Chromium does not send loopback and link-local destinations to a proxy unless this rule says so; the gate must see them too.
    flags.append('--proxy-bypass-list=<-loopback>')
    # Every name goes to the proxy, which resolves it; the browser resolves nothing of its own.
    flags.append('--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"')
    return ' '.join(flags)


def main():
    with open(sys.argv[1], 'r', encoding='utf-8') as handle:
        request = json.load(handle)
    if not isinstance(request, dict):
        raise ValueError('capture request must be a JSON object')
    relay = None
    try:
        flag_request = request
        if 'proxySocket' in request and request['proxySocket'] is not None:
            sock_path = validate_proxy_socket(request['proxySocket'])
            ensure_loopback_up()
            relay = GateRelay(sock_path).start()
            flag_request = {'proxyPort': relay.port}
        return _run_browser(request, flag_request)
    finally:
        if relay is not None:
            relay.close()


def _run_browser(request, flag_request):
    os.environ['QT_QPA_PLATFORM'] = 'offscreen'
    os.environ['QTWEBENGINE_CHROMIUM_FLAGS'] = chromium_flags(flag_request)
    os.environ.setdefault('QTWEBENGINE_DISABLE_SANDBOX', '1')

    from PyQt6.QtCore import QMarginsF, QSizeF, QTimer, QUrl
    from PyQt6.QtGui import QPageLayout, QPageSize
    from PyQt6.QtWebEngineCore import (
        QWebEnginePage,
        QWebEngineProfile,
        QWebEngineScript,
        QWebEngineSettings,
        QWebEngineUrlRequestInterceptor,
    )
    from PyQt6.QtWidgets import QApplication

    app = QApplication([sys.argv[0]])
    blocked = []
    state = {'requests': 0, 'last_request_ms': 0, 'done': False}
    clock = {'t': 0}

    class Interceptor(QWebEngineUrlRequestInterceptor):
        def interceptRequest(self, info):
            url = info.requestUrl()
            state['requests'] += 1
            state['last_request_ms'] = clock['t']
            if url.scheme().lower() not in ALLOWED_SCHEMES:
                info.block(True)
                if len(blocked) < 50:
                    blocked.append(url.toString()[:200])

    profile = QWebEngineProfile()  # off the record: no cookies, cache or storage on disk
    profile.setPersistentCookiesPolicy(QWebEngineProfile.PersistentCookiesPolicy.NoPersistentCookies)
    profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.MemoryHttpCache)
    if request.get('userAgent'):
        profile.setHttpUserAgent(str(request['userAgent'])[:300])
    interceptor = Interceptor()
    profile.setUrlRequestInterceptor(interceptor)
    profile.downloadRequested.connect(lambda item: item.cancel())

    page = QWebEnginePage(profile)
    attribute = QWebEngineSettings.WebAttribute
    settings = page.settings()
    raw_pdf = request.get('pdf')
    pdf_spec = raw_pdf if isinstance(raw_pdf, dict) else {}
    for name, value in (
        ('JavascriptCanOpenWindows', False),
        ('JavascriptCanAccessClipboard', False),
        ('PluginsEnabled', False),
        ('LocalContentCanAccessFileUrls', False),
        ('LocalContentCanAccessRemoteUrls', False),
        ('WebRTCPublicInterfacesOnly', True),
        ('ScreenCaptureEnabled', False),
        ('DnsPrefetchEnabled', False),
        ('ErrorPageEnabled', False),
        ('PdfViewerEnabled', False),
        ('PrintElementBackgrounds', bool(pdf_spec.get('printBackground', True))),
    ):
        member = getattr(attribute, name, None)
        if member is not None:
            settings.setAttribute(member, value)
    denied = getattr(QWebEnginePage, 'PermissionPolicy', None)
    if hasattr(page, 'featurePermissionRequested') and denied is not None:
        page.featurePermissionRequested.connect(
            lambda url, feature: page.setFeaturePermission(url, feature, denied.PermissionDeniedByUser)
        )
    if hasattr(page, 'authenticationRequired'):
        page.authenticationRequired.connect(lambda url, auth: None)

    timeout_ms = max(1000, min(parse_guarded_int(request.get('timeoutMs'), DEFAULT_TIMEOUT_MS), 120000))
    result = {}

    def finish(value):
        if state['done']:
            return
        state['done'] = True
        result.update(value)
        app.quit()

    ticker = QTimer()
    ticker.setInterval(50)
    ticker.timeout.connect(lambda: clock.__setitem__('t', clock['t'] + 50))
    ticker.start()

    deadline = QTimer()
    deadline.setSingleShot(True)
    deadline.timeout.connect(lambda: finish({'ok': False, 'code': 'timeout', 'detail': 'The page did not finish loading in time.'}))
    deadline.start(timeout_ms)

    out_dir = os.path.dirname(os.path.abspath(sys.argv[1]))
    fmt = request.get('format')
    if fmt not in ('pdf', 'png', 'jpg'):
        raise ValueError('Unsupported capture format')
    raw_output = request.get('output')
    output_name = os.path.basename(raw_output) if isinstance(raw_output, str) and raw_output else ''
    if not output_name or output_name in ('.', '..'):
        output_name = 'capture.' + fmt
    output_path = os.path.join(out_dir, output_name)

    def report(extra):
        info = {'ok': True, 'output': os.path.basename(output_path), 'finalUrl': page.url().toString()[:2000], 'title': page.title()[:300], 'blocked': blocked}
        info.update(extra)
        finish(info)

    def write_pdf():
        pdf_width = parse_guarded_float(pdf_spec.get('width'), 0.0)
        pdf_height = parse_guarded_float(pdf_spec.get('height'), 0.0)
        if pdf_width > 0.0 and pdf_height > 0.0:
            size = QPageSize(QSizeF(pdf_width, pdf_height), QPageSize.Unit.Millimeter)
        else:
            paper_name = pdf_spec.get('paper') if isinstance(pdf_spec.get('paper'), str) else 'A4'
            size = QPageSize(getattr(QPageSize.PageSizeId, PAPERS.get(paper_name, 'A4')))
        margin = max(0.0, parse_guarded_float(pdf_spec.get('margin'), 10.0))
        orientation = QPageLayout.Orientation.Landscape if pdf_spec.get('landscape') else QPageLayout.Orientation.Portrait
        layout = QPageLayout(size, orientation, QMarginsF(margin, margin, margin, margin), QPageLayout.Unit.Millimeter)
        page.setZoomFactor(max(0.1, min(parse_guarded_float(pdf_spec.get('scale'), 1.0), 2.0)))

        def done(data):
            if state['done']:
                return
            payload = bytes(data)
            if not payload.startswith(b'%PDF-'):
                finish({'ok': False, 'code': 'capture_failed', 'detail': 'The browser wrote no PDF.'})
                return
            with open(output_path, 'wb') as handle:
                handle.write(payload)
            report({})

        page.printToPdf(done, layout)

    def write_picture():
        from PyQt6.QtWebEngineWidgets import QWebEngineView

        raw_viewport = request.get('viewport')
        viewport = raw_viewport if isinstance(raw_viewport, dict) else {}
        width = max(200, min(parse_guarded_int(viewport.get('width'), 1280), 3840))
        height = max(200, min(parse_guarded_int(viewport.get('height'), 800), MAX_FULL_PAGE_HEIGHT))
        view = QWebEngineView()
        view.setPage(page)
        view.resize(width, height)
        view.show()

        def grab(total_height):
            if state['done']:
                return
            target_height = max(height, parse_page_height(total_height, height))
            view.resize(width, target_height)

            def snap():
                if state['done']:
                    return
                pixmap = view.grab()
                quality = max(1, min(parse_guarded_int(request.get('quality'), 85), 100))
                if pixmap.isNull() or not pixmap.save(output_path, 'PNG' if fmt == 'png' else 'JPG', quality):
                    finish({'ok': False, 'code': 'capture_failed', 'detail': 'The browser drew no picture.'})
                    return
                report({'width': pixmap.width(), 'height': pixmap.height()})

            QTimer.singleShot(SETTLE_MS, snap)

        if request.get('fullPage'):
            page.runJavaScript(PAGE_HEIGHT_SCRIPT, QWebEngineScript.ScriptWorldId.ApplicationWorld, grab)
        else:
            grab(height)

    def capture():
        if state['done']:
            return
        (write_pdf if fmt == 'pdf' else write_picture)()

    def after_load(ok):
        if state['done']:
            return
        if not ok:
            finish({'ok': False, 'code': 'load_failed', 'detail': 'The page could not be loaded.'})
            return
        delay = max(0, min(parse_guarded_int(request.get('delayMs'), 0), MAX_DELAY_MS))
        if request.get('waitUntil') == 'idle':
            wait_idle(delay)
        else:
            QTimer.singleShot(delay, capture)

    def wait_idle(delay):
        quiet = QTimer()
        quiet.setInterval(100)

        def check():
            if state['done']:
                quiet.stop()
                return
            if clock['t'] - state['last_request_ms'] >= IDLE_QUIET_MS:
                quiet.stop()
                QTimer.singleShot(delay, capture)

        quiet.timeout.connect(check)
        quiet.start()
        state['idle_timer'] = quiet

    page.loadFinished.connect(after_load)
    page.setUrl(QUrl(str(request['url'])))
    app.exec()
    emit(result if result else {'ok': False, 'code': 'capture_failed', 'detail': 'The browser ended without a result.'})
    sys.stdout.flush()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:  # noqa: BLE001 - the worker needs one JSON line whatever happened
        fail('capture_failed', '%s: %s' % (type(error).__name__, error))
        sys.stdout.flush()
    os._exit(0)
