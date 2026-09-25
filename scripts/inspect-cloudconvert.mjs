import fs from 'fs';

async function main() {
  const tabs = await fetch('http://localhost:9222/json/list').then(r => r.json());
  const ccTab = tabs.find(t => t.url.includes('cloudconvert.com'));
  if (!ccTab) {
    console.error('CloudConvert tab not found');
    return;
  }
  console.log('Found tab:', ccTab.id, ccTab.url);

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
  console.log('Connected to tab WebSocket');

  await send('Page.enable');
  await send('DOM.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  });

  // Wait a bit for page to load completely
  await new Promise(r => setTimeout(r, 3000));

  // Screenshot 1: live homepage
  let ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/live_cc_home.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved live_cc_home.png');

  // Let's inspect tools button
  const toolsRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Tools'));
        if (btn) {
          btn.click();
          return { found: true, text: btn.textContent };
        }
        return { found: false };
      })()
    `,
    returnByValue: true
  });
  console.log('Tools button click:', toolsRes.result.value);
  await new Promise(r => setTimeout(r, 600));
  ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/live_cc_tools_dropdown.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved live_cc_tools_dropdown.png');

  // Click tools again to close
  await send('Runtime.evaluate', {
    expression: `(() => { const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Tools')); if (btn) btn.click(); })()`
  });
  await new Promise(r => setTimeout(r, 400));

  // Click API dropdown
  const apiRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('API'));
        if (btn) {
          btn.click();
          return { found: true, text: btn.textContent };
        }
        return { found: false };
      })()
    `,
    returnByValue: true
  });
  console.log('API button click:', apiRes.result.value);
  await new Promise(r => setTimeout(r, 600));
  ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/live_cc_api_dropdown.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved live_cc_api_dropdown.png');

  // Click API again to close
  await send('Runtime.evaluate', {
    expression: `(() => { const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('API')); if (btn) btn.click(); })()`
  });
  await new Promise(r => setTimeout(r, 400));

  // Inspect split button: Select File dropdown
  const selectFileRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        // find chevron or split button next to Select File
        const buttons = Array.from(document.querySelectorAll('button'));
        const chevron = buttons.find(b => b.querySelector('svg.fa-chevron-down') && b.closest('[data-slot=\"root\"], .inline-flex, .group'));
        // Or find button with chevron in dropzone
        const dropzone = document.querySelector('section, [class*=\"dropzone\"], div');
        const chevronBtn = Array.from(document.querySelectorAll('button')).find(b => {
          return b.innerHTML.includes('chevron-down') && (b.previousElementSibling?.textContent?.includes('Select File') || b.parentElement?.textContent?.includes('Select File'));
        });
        if (chevronBtn) {
          chevronBtn.click();
          return { found: true };
        }
        return { found: false, allBtns: buttons.map(b => b.textContent.trim()).filter(Boolean) };
      })()
    `,
    returnByValue: true
  });
  console.log('Select file chevron click:', selectFileRes.result.value);
  await new Promise(r => setTimeout(r, 600));
  ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/live_cc_select_dropdown.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved live_cc_select_dropdown.png');

  // Click format selector (PDF or DOCX or format card buttons)
  const formatRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        // click outside first
        document.body.click();
        const btns = Array.from(document.querySelectorAll('button, a'));
        const docxBtn = btns.find(b => b.textContent.includes('DOCX') || b.textContent.includes('PDF'));
        if (docxBtn) {
          docxBtn.click();
          return { found: true, text: docxBtn.textContent };
        }
        return { found: false, btns: btns.map(b => b.textContent.trim()).slice(0, 20) };
      })()
    `,
    returnByValue: true
  });
  console.log('Format button click:', formatRes.result.value);
  await new Promise(r => setTimeout(r, 800));
  ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/live_cc_format_modal.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved live_cc_format_modal.png');

  ws.close();
}

main().catch(console.error);
