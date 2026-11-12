#!/usr/bin/env python3
"""Website capture driver: loads one page in Qt WebEngine (Chromium) and writes it as a PDF, a PNG or a JPEG.

The worker runs this program as a separate sandboxed process (src/lib/capture/website-capture.ts). It reads one JSON request
file (argv[1]) and prints one JSON line on standard output. Everything the page asks the network for goes to the gate proxy of
the worker (`proxyPort` on 127.0.0.1), which applies the SSRF checks of the project to every connection; this program adds the
browser-side limits: only http and https (and data) URLs load, no file access, no popups, no downloads, no device or
notification permission, no WebRTC on a direct route, no plug-ins and no persistent state.

Request fields: url, format (pdf|png|jpg), proxyPort, timeoutMs, waitUntil (load|idle), delayMs, viewport {width, height, scale},
fullPage, quality, userAgent, pdf {paper|width+height (mm), landscape, margin (mm), printBackground, scale}, output (file name).
Result fields: ok, output, finalUrl, title, blocked (URLs the browser refused), or ok=false with code and detail.
"""
import json
import os
import sys

MAX_FULL_PAGE_HEIGHT = 16384
MAX_DELAY_MS = 30000
IDLE_QUIET_MS = 500
SETTLE_MS = 300
DEFAULT_TIMEOUT_MS = 30000
MM_PER_INCH = 25.4
PAPERS = {'A3': 'A3', 'A4': 'A4', 'A5': 'A5', 'Letter': 'Letter', 'Legal': 'Legal', 'Tabloid': 'Tabloid'}
ALLOWED_SCHEMES = ('http', 'https', 'data', 'about', 'blob')

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


def chromium_flags(request):
    port = int(request['proxyPort'])
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
    os.environ['QT_QPA_PLATFORM'] = 'offscreen'
    os.environ['QTWEBENGINE_CHROMIUM_FLAGS'] = chromium_flags(request)
    os.environ.setdefault('QTWEBENGINE_DISABLE_SANDBOX', '1')

    from PyQt6.QtCore import QMarginsF, QSizeF, QTimer, QUrl
    from PyQt6.QtGui import QPageLayout, QPageSize
    from PyQt6.QtWebEngineCore import (
        QWebEnginePage,
        QWebEngineProfile,
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
        ('PrintElementBackgrounds', bool(request.get('pdf', {}).get('printBackground', True))),
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

    timeout_ms = max(1000, min(int(request.get('timeoutMs', DEFAULT_TIMEOUT_MS)), 120000))
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
    output_path = os.path.join(out_dir, os.path.basename(str(request.get('output', 'capture.' + request['format']))))
    fmt = request['format']

    def report(extra):
        info = {'ok': True, 'output': os.path.basename(output_path), 'finalUrl': page.url().toString()[:2000], 'title': page.title()[:300], 'blocked': blocked}
        info.update(extra)
        finish(info)

    def write_pdf():
        spec = request.get('pdf', {})
        if spec.get('width') and spec.get('height'):
            size = QPageSize(QSizeF(float(spec['width']), float(spec['height'])), QPageSize.Unit.Millimeter)
        else:
            size = QPageSize(getattr(QPageSize.PageSizeId, PAPERS.get(spec.get('paper', 'A4'), 'A4')))
        margin = float(spec.get('margin', 10))
        orientation = QPageLayout.Orientation.Landscape if spec.get('landscape') else QPageLayout.Orientation.Portrait
        layout = QPageLayout(size, orientation, QMarginsF(margin, margin, margin, margin), QPageLayout.Unit.Millimeter)
        page.setZoomFactor(max(0.1, min(float(spec.get('scale', 1.0)), 2.0)))

        def done(data):
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

        viewport = request.get('viewport', {})
        width = max(200, min(int(viewport.get('width', 1280)), 3840))
        height = max(200, min(int(viewport.get('height', 800)), MAX_FULL_PAGE_HEIGHT))
        view = QWebEngineView()
        view.setPage(page)
        view.resize(width, height)
        view.show()

        def grab(total_height):
            view.resize(width, max(height, min(int(total_height or height), MAX_FULL_PAGE_HEIGHT)))

            def snap():
                pixmap = view.grab()
                quality = max(1, min(int(request.get('quality', 85)), 100))
                if pixmap.isNull() or not pixmap.save(output_path, 'PNG' if fmt == 'png' else 'JPG', quality):
                    finish({'ok': False, 'code': 'capture_failed', 'detail': 'The browser drew no picture.'})
                    return
                report({'width': pixmap.width(), 'height': pixmap.height()})

            QTimer.singleShot(SETTLE_MS, snap)

        if request.get('fullPage'):
            page.runJavaScript('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)', grab)
        else:
            grab(height)

    def capture():
        (write_pdf if fmt == 'pdf' else write_picture)()

    def after_load(ok):
        if not ok:
            finish({'ok': False, 'code': 'load_failed', 'detail': 'The page could not be loaded.'})
            return
        delay = max(0, min(int(request.get('delayMs', 0)), MAX_DELAY_MS))
        if request.get('waitUntil') == 'idle':
            wait_idle(delay)
        else:
            QTimer.singleShot(delay, capture)

    def wait_idle(delay):
        quiet = QTimer()
        quiet.setInterval(100)

        def check():
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
    os._exit(0)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:  # noqa: BLE001 - the worker needs one JSON line whatever happened
        fail('capture_failed', '%s: %s' % (type(error).__name__, error))
        sys.stdout.flush()
        os._exit(0)
