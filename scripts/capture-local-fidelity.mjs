import fs from 'fs';

async function captureLocalFidelity() {
  const tabs = await fetch('http://localhost:9222/json/list').then(r => r.json());
  let localTab = tabs.find(t => t.url && t.url.includes('localhost:3000'));
  if (!localTab) {
    throw new Error('Local tab not found');
  }
  console.log('Using local tab:', localTab.id);
  const ws = new WebSocket(localTab.webSocketDebuggerUrl);

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
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  });

  // Reload page to start fresh
  await send('Page.reload');
  await new Promise(r => setTimeout(r, 2000));

  // 1. Capture Home Dark
  let ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/fidelity_home_dark.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved fidelity_home_dark.png');

  // 2. Open Tools Dropdown
  await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Tools'));
        if (btn) btn.click();
      })()
    `
  });
  await new Promise(r => setTimeout(r, 500));
  ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/fidelity_tools_dropdown.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved fidelity_tools_dropdown.png');

  // Close Tools, Open API Dropdown
  await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('API'));
        if (btn) btn.click();
      })()
    `
  });
  await new Promise(r => setTimeout(r, 500));
  ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/fidelity_api_dropdown.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved fidelity_api_dropdown.png');

  // Close dropdowns
  await send('Runtime.evaluate', {
    expression: `
      (() => {
        const bd = document.querySelector('.fixed.inset-0');
        if (bd) bd.click();
        else document.body.click();
      })()
    `
  });
  await new Promise(r => setTimeout(r, 300));

  // 3. Open Select File dropdown
  await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Select File'));
        if (btn) {
          const nextBtn = btn.parentElement.querySelector('button:last-child');
          if (nextBtn) nextBtn.click();
        }
      })()
    `
  });
  await new Promise(r => setTimeout(r, 500));
  ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/fidelity_cta_dropdown.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved fidelity_cta_dropdown.png');

  // Close CTA dropdown
  await send('Runtime.evaluate', {
    expression: `
      (() => {
        const bd = document.querySelector('.fixed.inset-0');
        if (bd) bd.click();
        else document.body.click();
      })()
    `
  });
  await new Promise(r => setTimeout(r, 300));

  // 4. Upload file to populate queue
  const fileInputRes = await send('DOM.querySelector', {
    nodeId: (await send('DOM.getDocument')).root.nodeId,
    selector: 'input[type="file"]'
  });
  console.log('File input nodeId:', fileInputRes.nodeId);

  const samplePath = process.cwd() + '/public/sample.pdf';
  if (!fs.existsSync(samplePath)) {
    fs.writeFileSync(samplePath, '%PDF-1.4 sample pdf content for easyconvert queue testing');
  }

  await send('DOM.setFileInputFiles', {
    nodeId: fileInputRes.nodeId,
    files: [samplePath]
  });
  await new Promise(r => setTimeout(r, 1000));

  // Capture Queue Dark
  ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/fidelity_queue_dark.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved fidelity_queue_dark.png');

  // 5. Click format button in the queue to open popover
  const selectFormatRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btn = document.querySelector('[data-testid="queue-target-format-btn"]');
        if (btn) {
          btn.click();
          return { clicked: true, text: btn.textContent };
        }
        return { clicked: false };
      })()
    `,
    returnByValue: true
  });
  console.log('Select format click:', selectFormatRes.result.value);
  await new Promise(r => setTimeout(r, 600));
  ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/fidelity_format_modal.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved fidelity_format_modal.png');

  // Select format 'DOCX' inside popover to close it
  await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const docxBtn = btns.find(b => b.textContent.trim() === 'DOCX' && b.className.includes('font-mono'));
        if (docxBtn) {
          docxBtn.click();
          return { clicked: true };
        }
        return { clicked: false };
      })()
    `
  });
  await new Promise(r => setTimeout(r, 600));

  // 6. Click Options (wrench icon / Options button)
  const optionsClickRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btn = document.querySelector('[data-testid="queue-options-btn"]');
        if (btn) {
          btn.click();
          return { clicked: true, text: btn.textContent };
        }
        return { clicked: false };
      })()
    `,
    returnByValue: true
  });
  console.log('Options button click:', optionsClickRes.result.value);
  await new Promise(r => setTimeout(r, 600));
  ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/fidelity_options_modal.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved fidelity_options_modal.png');

  console.log('Finished captures!');
  process.exit(0);
}

captureLocalFidelity().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
