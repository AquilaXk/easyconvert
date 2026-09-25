import fs from 'fs';

async function inspectDetails() {
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

  // Pricing inspection
  await send('Page.navigate', { url: 'https://cloudconvert.com/pricing' });
  await new Promise(r => setTimeout(r, 2000));
  const pricingData = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const h1 = document.querySelector('h1')?.textContent?.trim();
        const tabs = Array.from(document.querySelectorAll('[role="tab"], button')).map(b => b.textContent.trim()).filter(t => t.includes('Package') || t.includes('Subscription'));
        const slider = document.querySelector('input[type="range"]');
        const cards = Array.from(document.querySelectorAll('.card, [data-slot="card"], div[class*="rounded"]')).map(c => c.textContent.trim()).filter(t => t.includes('$') || t.includes('credits') || t.includes('minute')).slice(0, 5);
        return { h1, tabs, hasSlider: !!slider, sampleCards: cards };
      })()
    `,
    returnByValue: true
  });
  console.log('Pricing data:', pricingData.result.value);

  // Login inspection
  await send('Page.navigate', { url: 'https://cloudconvert.com/login' });
  await new Promise(r => setTimeout(r, 2000));
  const loginData = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const form = document.querySelector('form');
        const inputs = Array.from(document.querySelectorAll('input')).map(i => ({ name: i.name, type: i.type, placeholder: i.placeholder }));
        const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim());
        const socialButtons = Array.from(document.querySelectorAll('a, button')).map(b => b.textContent.trim()).filter(t => t.includes('Google') || t.includes('GitHub') || t.includes('Twitter'));
        return { inputs, buttons, socialButtons };
      })()
    `,
    returnByValue: true
  });
  console.log('Login data:', loginData.result.value);

  // Register inspection
  await send('Page.navigate', { url: 'https://cloudconvert.com/register' });
  await new Promise(r => setTimeout(r, 2000));
  const registerData = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const inputs = Array.from(document.querySelectorAll('input')).map(i => ({ name: i.name, type: i.type, placeholder: i.placeholder }));
        const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim());
        return { inputs, buttons };
      })()
    `,
    returnByValue: true
  });
  console.log('Register data:', registerData.result.value);

  // PDF Converter inspection
  await send('Page.navigate', { url: 'https://cloudconvert.com/pdf-converter' });
  await new Promise(r => setTimeout(r, 2000));
  const pdfConvData = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const h1 = document.querySelector('h1')?.textContent?.trim();
        const p = document.querySelector('h1')?.nextElementSibling?.textContent?.trim();
        const heroSection = document.querySelector('h1')?.closest('section, div');
        return { h1, p };
      })()
    `,
    returnByValue: true
  });
  console.log('PDF Converter data:', pdfConvData.result.value);

  ws.close();
}

inspectDetails().catch(console.error);
