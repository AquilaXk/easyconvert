import fs from 'fs';

async function testHeroFormatClick() {
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

  // Find the hero format cards
  const heroClick = await send('Runtime.evaluate', {
    expression: `
      (() => {
        // Let's find button or element in the right card of hero
        const buttons = Array.from(document.querySelectorAll('button'));
        const targetBtn = buttons.find(b => b.getAttribute('aria-label')?.includes('Output format') || b.getAttribute('aria-label')?.includes('Input format') || b.querySelector('svg.fa-chevron-down'));
        // Or find card with chevron
        const heroCard = document.querySelector('[data-slot=\"card\"], .group') || buttons[4];
        if (targetBtn) {
          targetBtn.click();
          return { clicked: true, text: targetBtn.textContent, label: targetBtn.getAttribute('aria-label') };
        }
        return { clicked: false, btns: buttons.map(b => b.textContent.trim()) };
      })()
    `,
    returnByValue: true
  });
  console.log('Hero format click:', heroClick.result.value);
  await new Promise(r => setTimeout(r, 800));

  let ss = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('public/screenshots/live_cc_hero_format_popover.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved live_cc_hero_format_popover.png');

  ws.close();
}

testHeroFormatClick().catch(console.error);
