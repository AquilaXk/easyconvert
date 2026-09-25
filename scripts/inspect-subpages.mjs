import fs from 'fs';

async function inspectSubpages() {
  const tabs = await fetch('http://localhost:9222/json/list').then(r => r.json());
  const ccTab = tabs.find(t => t.url.includes('cloudconvert.com'));
  if (!ccTab) {
    console.error('No cloudconvert tab');
    return;
  }
  const ws = new WebSocket(ccTab.webSocketDebuggerUrl);
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
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  });

  const urlsToInspect = [
    { name: 'pricing', url: 'https://cloudconvert.com/pricing' },
    { name: 'login', url: 'https://cloudconvert.com/login' },
    { name: 'register', url: 'https://cloudconvert.com/register' },
    { name: 'pdf_converter', url: 'https://cloudconvert.com/pdf-converter' },
    { name: 'api_v2', url: 'https://cloudconvert.com/api/v2' },
  ];

  const results = {};

  for (const item of urlsToInspect) {
    console.log(`Navigating to ${item.url}...`);
    await send('Page.navigate', { url: item.url });
    await new Promise(r => setTimeout(r, 3000));

    // Capture screenshot
    const ss = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`public/screenshots/live_cc_${item.name}.png`, Buffer.from(ss.data, 'base64'));
    console.log(`Saved live_cc_${item.name}.png`);

    // Inspect page structure
    const pageData = await send('Runtime.evaluate', {
      expression: `
        (() => {
          return {
            title: document.title,
            h1: document.querySelector('h1')?.textContent?.trim(),
            h2s: Array.from(document.querySelectorAll('h2')).map(h => h.textContent.trim()),
            navLinks: Array.from(document.querySelectorAll('nav a, header a')).map(a => ({ text: a.textContent.trim(), href: a.href })),
            mainClasses: document.querySelector('main, #app, body')?.className,
            contentStructure: document.querySelector('main, .container, #app')?.innerHTML?.slice(0, 1500)
          };
        })()
      `,
      returnByValue: true
    });
    results[item.name] = pageData.result.value;
  }

  // Also navigate back to home and test URL import modal / other modals if present
  console.log('Navigating back to home...');
  await send('Page.navigate', { url: 'https://cloudconvert.com/' });
  await new Promise(r => setTimeout(r, 2000));

  fs.writeFileSync('scripts/subpages-inspection-result.json', JSON.stringify(results, null, 2));
  console.log('Done inspecting subpages!');
  ws.close();
}

inspectSubpages().catch(console.error);
