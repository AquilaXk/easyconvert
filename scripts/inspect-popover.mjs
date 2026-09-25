import fs from 'fs';

async function testSelectFormatAndWrench() {
  const tabs = await fetch('http://localhost:9222/json/list').then(r => r.json());
  const ccTab = tabs.find(t => t.url.includes('cloudconvert.com'));
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

  // Click "Select Format" button
  const clickRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Select Format'));
        if (btn) {
          btn.click();
          return { clicked: true, text: btn.textContent };
        }
        return { clicked: false };
      })()
    `,
    returnByValue: true
  });
  console.log('Clicked Select Format:', clickRes.result.value);
  await new Promise(r => setTimeout(r, 600));

  let ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/live_cc_format_popover.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved live_cc_format_popover.png');

  // Let's inspect the format popover DOM
  const popoverInfo = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const popover = document.querySelector('[role="dialog"], [role="menu"], [data-slot="content"], [data-reka-popper-content-wrapper]');
        return {
          found: !!popover,
          html: popover?.outerHTML?.slice(0, 2000)
        };
      })()
    `,
    returnByValue: true
  });
  console.log('Popover info:', popoverInfo.result.value?.found);

  // Click DOCX in popover
  const selectDocxRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const items = Array.from(document.querySelectorAll('button, a, [role=\"menuitem\"], [role=\"option\"]'));
        const docx = items.find(el => el.textContent.trim().toLowerCase() === 'docx' || el.textContent.includes('DOCX'));
        if (docx) {
          docx.click();
          return { clickedDocx: true, text: docx.textContent };
        }
        return { clickedDocx: false, items: items.map(i => i.textContent.trim()).filter(Boolean).slice(0, 30) };
      })()
    `,
    returnByValue: true
  });
  console.log('Select DOCX:', selectDocxRes.result.value);
  await new Promise(r => setTimeout(r, 800));

  ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/live_cc_queue_with_format.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved live_cc_queue_with_format.png');

  // Now inspect wrench button
  const wrenchRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const wrench = btns.find(b => b.querySelector('svg.fa-wrench, [data-icon=\"wrench\"], svg') && (b.getAttribute('aria-label')?.includes('setting') || b.getAttribute('aria-label')?.includes('option') || b.innerHTML.includes('wrench')));
        if (wrench) {
          wrench.click();
          return { clicked: true, html: wrench.outerHTML };
        }
        return { clicked: false, btns: btns.map(b => ({ text: b.textContent.trim(), label: b.getAttribute('aria-label'), html: b.innerHTML.slice(0, 80) })) };
      })()
    `,
    returnByValue: true
  });
  console.log('Wrench button:', wrenchRes.result.value);
  await new Promise(r => setTimeout(r, 800));

  ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/live_cc_options_modal.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved live_cc_options_modal.png');

  ws.close();
}

testSelectFormatAndWrench().catch(console.error);
