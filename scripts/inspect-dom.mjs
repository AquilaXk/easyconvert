async function inspect() {
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
  await new Promise(r => setTimeout(r, 2500));

  const res = await send('Runtime.evaluate', {
    expression: `
      (() => {
        // Find elements with format buttons or cards
        const heroSection = document.querySelector('header').nextElementSibling;
        return {
          heroHTML: heroSection?.outerHTML?.slice(0, 3000),
          allButtons: Array.from(heroSection?.querySelectorAll('button, a') || []).map(b => ({
            tag: b.tagName,
            text: b.textContent.trim(),
            href: b.getAttribute('href'),
            class: b.className
          }))
        };
      })()
    `,
    returnByValue: true
  });
  console.log(JSON.stringify(res.result.value, null, 2));
  ws.close();
}
inspect().catch(console.error);
