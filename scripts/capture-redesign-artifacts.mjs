import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9222;

const ARTIFACT_DIR_1 = '/Users/aquila/.gemini/antigravity/brain/1c7356b0-bbb5-4a88-b29a-6ee2ac6441cc';
const ARTIFACT_DIR_2 = '/Users/aquila/.gemini/antigravity/brain/86e17bd1-af3f-4a06-8090-3ff8a2e991e9';
const PUBLIC_DIR = path.resolve('public/screenshots');

function saveImage(filename, buffer) {
  fs.writeFileSync(path.join(PUBLIC_DIR, filename), buffer);
  if (fs.existsSync(ARTIFACT_DIR_1)) {
    fs.writeFileSync(path.join(ARTIFACT_DIR_1, filename), buffer);
  }
  if (fs.existsSync(ARTIFACT_DIR_2)) {
    fs.writeFileSync(path.join(ARTIFACT_DIR_2, filename), buffer);
  }
  console.log(`Saved: ${filename} (${buffer.length} bytes)`);
}

async function run() {
  console.log('Starting headless Chrome on port', DEBUG_PORT);
  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank'
  ]);

  // Wait for DevTools port
  let tabs = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      if (res.ok) {
        tabs = await res.json();
        if (tabs && tabs.length > 0) break;
      }
    } catch (e) {}
  }

  if (!tabs || tabs.length === 0) {
    chromeProc.kill();
    throw new Error('Failed to connect to headless Chrome');
  }

  const targetTab = tabs.find(t => t.type === 'page' && t.url.includes('localhost:3000')) || tabs.find(t => t.type === 'page') || tabs[0];
  console.log('Connecting to tab:', targetTab.id, targetTab.title, targetTab.url);
  const ws = new WebSocket(targetTab.webSocketDebuggerUrl);

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

  await new Promise(r => ws.onopen = r);

  await send('Page.enable');
  await send('DOM.enable');
  await send('Runtime.enable');

  // --- 1. Desktop Viewport (1440x900) ---
  console.log('Configuring Desktop Viewport 1440x900...');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  });

  await send('Page.navigate', { url: 'http://localhost:3000/' });
  await new Promise(r => setTimeout(r, 2000));

  // 1a. Desktop Hero
  let ss = await send('Page.captureScreenshot', { format: 'png' });
  saveImage('desktop_hero.png', Buffer.from(ss.data, 'base64'));

  // 1b. Desktop Footer (scroll to bottom)
  await send('Runtime.evaluate', {
    expression: `window.scrollTo(0, document.body.scrollHeight);`
  });
  await new Promise(r => setTimeout(r, 800));

  ss = await send('Page.captureScreenshot', { format: 'png' });
  saveImage('desktop_footer.png', Buffer.from(ss.data, 'base64'));

  // 1c. Desktop Full Page
  const layout = await send('Page.getLayoutMetrics');
  const fullHeight = Math.ceil(layout.contentSize.height);
  console.log('Full page height:', fullHeight);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: fullHeight,
    deviceScaleFactor: 2,
    mobile: false
  });
  await send('Runtime.evaluate', { expression: `window.scrollTo(0, 0);` });
  await new Promise(r => setTimeout(r, 500));
  ss = await send('Page.captureScreenshot', { format: 'png' });
  saveImage('desktop_full_page.png', Buffer.from(ss.data, 'base64'));

  // --- 2. Mobile Viewport (iPhone 14 / 390x844) ---
  console.log('Configuring Mobile Viewport 390x844...');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true
  });
  await send('Page.navigate', { url: 'http://localhost:3000/' });
  await new Promise(r => setTimeout(r, 1500));

  // 2a. Mobile Hero
  ss = await send('Page.captureScreenshot', { format: 'png' });
  saveImage('mobile_hero.png', Buffer.from(ss.data, 'base64'));

  // 2b. Mobile Footer
  await send('Runtime.evaluate', {
    expression: `window.scrollTo(0, document.body.scrollHeight);`
  });
  await new Promise(r => setTimeout(r, 800));
  ss = await send('Page.captureScreenshot', { format: 'png' });
  saveImage('mobile_footer.png', Buffer.from(ss.data, 'base64'));

  // --- 3. Dynamic Slug Route (/mp4-to-mp3) ---
  console.log('Navigating to /mp4-to-mp3...');
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

  ws.close();
  chromeProc.kill();
  console.log('Finished capturing redesign artifacts successfully!');
}

run().catch(err => {
  console.error('Error during capture:', err);
  process.exit(1);
});
