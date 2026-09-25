import fs from 'fs';

async function captureAllSubpages() {
  const tabs = await fetch('http://localhost:9222/json/list').then((r) => r.json());
  let targetTab = tabs.find((t) => t.url && (t.url.includes('localhost:3000') || t.url.includes('easyconvert') || t.type === 'page'));

  if (!targetTab) {
    throw new Error('No suitable Chrome page tab found on port 9222');
  }
  console.log(`Connecting to tab ${targetTab.id}: ${targetTab.url}`);

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

  await new Promise((r) => (ws.onopen = r));

  await send('Page.enable');
  await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });

  const subpages = [
    { name: 'pricing', path: '/pricing', out: 'public/screenshots/fidelity_pricing.png' },
    { name: 'login', path: '/login', out: 'public/screenshots/fidelity_login.png' },
    { name: 'register', path: '/register', out: 'public/screenshots/fidelity_register.png' },
    { name: 'pdf-converter', path: '/pdf-converter', out: 'public/screenshots/fidelity_pdf_converter.png' },
    { name: 'api-v2', path: '/api/v2', out: 'public/screenshots/fidelity_api_v2.png' },
  ];

  for (const page of subpages) {
    console.log(`Navigating to http://localhost:3000${page.path}...`);
    await send('Page.navigate', { url: `http://localhost:3000${page.path}` });
    await new Promise((r) => setTimeout(r, 1800));

    const ss = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(page.out, Buffer.from(ss.data, 'base64'));
    console.log(`Captured ${page.name} -> ${page.out}`);
  }

  // Also navigate back to home
  await send('Page.navigate', { url: 'http://localhost:3000/' });
  await new Promise((r) => setTimeout(r, 500));

  console.log('All subpages captured successfully!');
  process.exit(0);
}

captureAllSubpages().catch((err) => {
  console.error('Failed to capture subpages:', err);
  process.exit(1);
});
