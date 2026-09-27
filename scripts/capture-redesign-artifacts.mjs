import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9222;

const ARTIFACT_DIR_1 = '/Users/aquila/.gemini/antigravity/brain/1c7356b0-bbb5-4a88-b29a-6ee2ac6441cc';
const ARTIFACT_DIR_2 = '/Users/aquila/.gemini/antigravity/brain/86e17bd1-af3f-4a06-8090-3ff8a2e991e9';
const ARTIFACT_DIR_CURRENT = '/Users/aquila/.gemini/antigravity/brain/c241f35c-d78b-4c1d-a16c-3c0a577756dd';
const ARTIFACT_DIR_SESSION = '/Users/aquila/.gemini/antigravity/brain/0f3d257b-4440-460b-8716-bdf70c4b31f8';
const ARTIFACT_DIR_TASK = '/Users/aquila/.gemini/antigravity/brain/3639b263-bfed-4bec-9e4e-dd185925448b';
const ARTIFACT_DIR_PARENT = '/Users/aquila/.gemini/antigravity/brain/ec08c42b-66f9-4300-ba1b-01d435f91b8e';
const ARTIFACT_DIR_SUBAGENT = '/Users/aquila/.gemini/antigravity/brain/985da93f-f969-49c1-92e0-7ac1d29eaf99';
const ARTIFACT_DIR_CALLER = '/Users/aquila/.gemini/antigravity/brain/540f9cdd-6f90-4bc5-976b-3a27dfa3cbcf';
const ARTIFACT_DIR_CONVERSATION = '/Users/aquila/.gemini/antigravity/brain/f959c1c8-ae0d-401f-881f-8e51a8733aa6';
const ARTIFACT_DIR_ACTIVE = '/Users/aquila/.gemini/antigravity/brain/e1204587-6eb4-445e-a857-442399a17170';
const ARTIFACT_DIR_CONVERSATION_2 = '/Users/aquila/.gemini/antigravity/brain/82af80c2-ce22-48c1-954d-037137d07256';
const PUBLIC_DIR = path.resolve('public/screenshots');

function saveImage(filename, buffer) {
  fs.writeFileSync(path.join(PUBLIC_DIR, filename), buffer);
  const dirs = [
    ARTIFACT_DIR_1,
    ARTIFACT_DIR_2,
    ARTIFACT_DIR_CURRENT,
    ARTIFACT_DIR_SESSION,
    ARTIFACT_DIR_TASK,
    ARTIFACT_DIR_PARENT,
    ARTIFACT_DIR_SUBAGENT,
    ARTIFACT_DIR_CALLER,
    ARTIFACT_DIR_CONVERSATION,
    ARTIFACT_DIR_ACTIVE,
    ARTIFACT_DIR_CONVERSATION_2,
  ];
  for (const d of dirs) {
    if (fs.existsSync(d)) {
      fs.writeFileSync(path.join(d, filename), buffer);
    }
  }
}

console.log('Starting headless Chrome on port', DEBUG_PORT);
const chromeProc = spawn(CHROME_PATH, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--headless=new',
  '--disable-gpu',
  'about:blank'
]);

// Wait for DevTools port to become ready
let tabs = null;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 300));
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    if (res.ok) {
      tabs = await res.json();
      if (Array.isArray(tabs) && tabs.length > 0) break;
    }
  } catch {
    // Retry polling DevTools endpoint
  }
}

if (!tabs || tabs.length === 0) {
  chromeProc.kill();
  throw new Error('Failed to connect to headless Chrome');
}

const targetTab = tabs.find(t => t.type === 'page' && typeof t.url === 'string' && t.url.includes('localhost:3000'))
  || tabs.find(t => t.type === 'page')
  || tabs[0];

if (!targetTab || !targetTab.id || !/^[0-9A-Fa-f]+$/.test(String(targetTab.id))) {
  chromeProc.kill();
  throw new Error('Security check failed: invalid tab id format');
}

const safeTabId = String(targetTab.id).match(/^[0-9A-Fa-f]+$/)?.[0];
if (!safeTabId) {
  chromeProc.kill();
  throw new Error('Security check failed: sanitized tab id missing');
}

const ws = new WebSocket(`ws://127.0.0.1:${DEBUG_PORT}/devtools/page/${safeTabId}`);

let id = 1;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = id++;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(msg.error);
    else resolve(msg.result);
  }
};

await new Promise(r => { ws.onopen = r; });

await send('Page.enable');
await send('DOM.enable');
await send('Runtime.enable');
await send('Emulation.setEmulatedMedia', {
  media: 'screen',
  features: [{ name: 'prefers-color-scheme', value: 'light' }]
});

// 1. Desktop Light Viewport (1440x900)
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false
});

await send('Page.navigate', { url: 'http://localhost:3000/' });
await new Promise(r => setTimeout(r, 2000));

// Ensure light mode is active
await send('Runtime.evaluate', {
  expression: `
    document.documentElement.classList.remove('dark');
    localStorage.theme = 'light';
    window.dispatchEvent(new CustomEvent('easyconvert-theme-change', { detail: { theme: 'light' } }));
  `
});
await new Promise(r => setTimeout(r, 500));

let ss = await send('Page.captureScreenshot', { format: 'png' });
saveImage('desktop_hero.png', Buffer.from(ss.data, 'base64'));
saveImage('hero_light.png', Buffer.from(ss.data, 'base64'));
saveImage('full_page_zero_slop_light.png', Buffer.from(ss.data, 'base64'));

// Desktop Footer (scroll to bottom)
await send('Runtime.evaluate', {
  expression: `window.scrollTo(0, document.body.scrollHeight);`
});
await new Promise(r => setTimeout(r, 800));

ss = await send('Page.captureScreenshot', { format: 'png' });
saveImage('desktop_footer.png', Buffer.from(ss.data, 'base64'));

// Desktop Full Page Light
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1.5,
  mobile: false
});
await send('Runtime.evaluate', { expression: `window.scrollTo(0, 0);` });
await new Promise(r => setTimeout(r, 500));
ss = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true
});
saveImage('desktop_full_page.png', Buffer.from(ss.data, 'base64'));
saveImage('full_page_light.png', Buffer.from(ss.data, 'base64'));

// Reset height for normal interactions
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false
});

// Upload a test file to inspect Queue in Light Mode
await send('Runtime.evaluate', {
  expression: `
    if (typeof window.__addTestFile === 'function') {
      window.__addTestFile('sample_document.pdf', 'docx');
    }
  `
});
await new Promise(r => setTimeout(r, 800));

ss = await send('Page.captureScreenshot', { format: 'png' });
saveImage('queue_light.png', Buffer.from(ss.data, 'base64'));

// Toggle Dark Mode with Queue Active
await send('Runtime.evaluate', {
  expression: `document.documentElement.classList.add('dark'); localStorage.theme = 'dark';`
});
await new Promise(r => setTimeout(r, 500));

ss = await send('Page.captureScreenshot', { format: 'png' });
saveImage('queue_dark.png', Buffer.from(ss.data, 'base64'));
saveImage('fidelity_queue_dark.png', Buffer.from(ss.data, 'base64'));

// Reload page in Dark Mode (Idle Hero)
await send('Page.navigate', { url: 'http://localhost:3000/' });
await new Promise(r => setTimeout(r, 1500));
await send('Runtime.evaluate', {
  expression: `document.documentElement.classList.add('dark'); localStorage.theme = 'dark';`
});
await new Promise(r => setTimeout(r, 500));

ss = await send('Page.captureScreenshot', { format: 'png' });
saveImage('hero_dark.png', Buffer.from(ss.data, 'base64'));
saveImage('fidelity_home_dark.png', Buffer.from(ss.data, 'base64'));

// Dark Full Page
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1.5,
  mobile: false
});
await send('Runtime.evaluate', { expression: `window.scrollTo(0, 0);` });
await new Promise(r => setTimeout(r, 500));
ss = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true
});
saveImage('full_page_dark.png', Buffer.from(ss.data, 'base64'));

// Reset to light mode for remaining captures
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false
});
await send('Runtime.evaluate', {
  expression: `document.documentElement.classList.remove('dark'); localStorage.theme = 'light';`
});

// 2. Mobile Viewport (390x844)
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true
});
await send('Page.navigate', { url: 'http://localhost:3000/' });
await new Promise(r => setTimeout(r, 1500));

ss = await send('Page.captureScreenshot', { format: 'png' });
saveImage('mobile_hero.png', Buffer.from(ss.data, 'base64'));

await send('Runtime.evaluate', {
  expression: `window.scrollTo(0, document.body.scrollHeight);`
});
await new Promise(r => setTimeout(r, 800));
ss = await send('Page.captureScreenshot', { format: 'png' });
saveImage('mobile_footer.png', Buffer.from(ss.data, 'base64'));

// 3. Dynamic Slug Route (/mp4-to-mp3)
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false
});
await send('Page.navigate', { url: 'http://localhost:3000/mp4-to-mp3' });
await new Promise(r => setTimeout(r, 1500));
ss = await send('Page.captureScreenshot', { format: 'png' });
saveImage('slug_converter_page.png', Buffer.from(ss.data, 'base64'));

// 4. Status Page (/status)
await send('Page.navigate', { url: 'http://localhost:3000/status' });
await new Promise(r => setTimeout(r, 1200));
ss = await send('Page.captureScreenshot', { format: 'png' });
saveImage('status_page.png', Buffer.from(ss.data, 'base64'));

// 5. Unit Converter Page (/unit-converter)
await send('Page.navigate', { url: 'http://localhost:3000/unit-converter' });
await new Promise(r => setTimeout(r, 1200));
ss = await send('Page.captureScreenshot', { format: 'png' });
saveImage('unit_converter_page.png', Buffer.from(ss.data, 'base64'));

ws.close();
chromeProc.kill();
console.log('Artifacts captured successfully');
