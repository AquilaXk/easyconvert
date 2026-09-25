import fs from 'fs';

async function testUpload() {
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
  await send('Page.navigate', { url: 'https://cloudconvert.com/' });
  await new Promise(r => setTimeout(r, 2000));

  // Find the file input
  const inputInfo = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const input = document.querySelector('input[type="file"]');
        return input ? { id: input.id, name: input.name, exists: true } : { exists: false };
      })()
    `,
    returnByValue: true
  });
  console.log('File input:', inputInfo.result.value);

  // Set file using DOM.setFileInputFiles
  // First get doc
  const doc = await send('DOM.getDocument');
  const node = await send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: 'input[type="file"]'
  });
  console.log('File input node:', node.nodeId);

  // Let's create a temporary test sample file
  const testFile = '/Volumes/MACSSD/Projects/GitProjects/easyconvert/public/sample.pdf';
  if (!fs.existsSync(testFile)) {
    fs.writeFileSync(testFile, '%PDF-1.4 sample content');
  }

  await send('DOM.setFileInputFiles', {
    files: [testFile],
    nodeId: node.nodeId
  });

  console.log('Set file input, waiting for queue to appear...');
  await new Promise(r => setTimeout(r, 1500));

  let ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/live_cc_queue.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved live_cc_queue.png');

  // Let's inspect the queue elements and see if format dropdown or wrench button exists
  const queueInfo = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return {
          buttons: buttons.map(b => ({
            text: b.textContent.trim(),
            ariaLabel: b.getAttribute('aria-label'),
            title: b.getAttribute('title'),
            html: b.innerHTML.slice(0, 100)
          }))
        };
      })()
    `,
    returnByValue: true
  });
  console.log('Buttons after file added:', JSON.stringify(queueInfo.result.value, null, 2));

  // Try clicking format dropdown in the queue row
  const clickFormatRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        // Find format selector button in queue row (e.g. "...' or format name)
        const formatBtn = Array.from(document.querySelectorAll('button')).find(b => {
          return b.textContent.includes('...') || b.getAttribute('aria-haspopup') || b.closest('[data-reka-collection-item]');
        });
        // Or find any button in the queue table
        const row = document.querySelector('tr, [data-slot="row"], table');
        const rowBtns = row ? Array.from(row.querySelectorAll('button')) : [];
        if (rowBtns.length > 0) {
          // let's click the format button (usually second or has chevron)
          const target = rowBtns.find(b => b.textContent.trim().length > 0 && !b.querySelector('.fa-times, .fa-trash, .fa-wrench')) || rowBtns[0];
          target.click();
          return { clicked: true, text: target.textContent };
        }
        return { clicked: false, rowBtns: rowBtns.map(b => b.textContent) };
      })()
    `,
    returnByValue: true
  });
  console.log('Format button click in queue:', clickFormatRes.result.value);
  await new Promise(r => setTimeout(r, 800));

  ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/live_cc_format_popover.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved live_cc_format_popover.png');

  // Try clicking wrench / options button
  const clickWrenchRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        document.body.click(); // close popover
        const wrenchBtn = Array.from(document.querySelectorAll('button')).find(b => {
          return b.querySelector('svg.fa-wrench, [data-icon="wrench"]') || b.getAttribute('aria-label')?.includes('options') || b.getAttribute('aria-label')?.includes('setting');
        });
        if (wrenchBtn) {
          wrenchBtn.click();
          return { clicked: true };
        }
        return { clicked: false };
      })()
    `,
    returnByValue: true
  });
  console.log('Wrench button click:', clickWrenchRes.result.value);
  await new Promise(r => setTimeout(r, 800));

  ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/live_cc_options_modal.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved live_cc_options_modal.png');

  ws.close();
}

testUpload().catch(console.error);
