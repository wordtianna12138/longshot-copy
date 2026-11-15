const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const project = path.resolve(__dirname, '..');
const dpr = Number(process.env.LONGSHOT_DPR || 1);
const native = process.env.LONGSHOT_MODE !== 'scroll';
const cases = process.env.LONGSHOT_CASES ? process.env.LONGSHOT_CASES.split(',') : native ? ['normal', 'wide', 'short', 'lazy-image'] : ['normal', 'nested', 'lazy', 'wide', 'short', 'lazy-prepend', 'lazy-image'];
const rowColor = i => `rgb(${(i * 37 + 20) % 230},${(i * 59 + 40) % 230},${(i * 83 + 60) % 230})`;
function fixture(kind) {
  const count = kind === 'short' ? 2 : 21;
  const rows = Array.from({ length: count }, (_, i) => `<div class="row" style="background:${rowColor(i)}">第 ${i + 1} 行</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font:28px sans-serif}.row{height:180px;border:0;display:flex;align-items:center;justify-content:center}
    ::-webkit-scrollbar{width:12px;height:12px}::-webkit-scrollbar-thumb{background:#111}::-webkit-scrollbar-track{background:#888}
    #content{${kind === 'wide' ? 'width:1800px;' : ''}}#last{height:37px;background:rgb(17,231,83)}
    ${kind === 'nested' ? 'body{height:100vh;overflow:hidden;padding:40px 80px 60px 250px;background:#eee}aside{position:fixed;left:10px;top:10px;width:160px;height:90vh;overflow:auto}main{height:100%;overflow:auto;border:3px solid #222}' : ''}
    #fixed{position:fixed;top:0;left:0;right:0;height:45px;background:rgb(255,0,255);font-size:16px;z-index:5}#footer{position:fixed;bottom:0;right:0;width:120px;height:80px;background:purple}
  </style></head><body>${kind === 'nested' ? '<aside>侧栏<div style="height:9000px">导航</div></aside>' : '<div id="fixed">固定页头</div><div id="footer">浮动控件</div>'}
  <main id="content">${rows}${kind === 'lazy-image' ? '<img loading="lazy" src="/delayed.svg" width="1000" height="2400" style="display:block">' : ''}<div id="last"></div></main>
  ${['lazy', 'lazy-prepend'].includes(kind) ? `<script>let added=false;addEventListener('scroll',()=>{if(!added&&scrollY>1000){added=true;setTimeout(()=>{const x=document.createElement('div');x.id='loaded';x.style='height:1100px;background:rgb(32,64,192)';${kind === 'lazy-prepend' ? "document.querySelector('main').prepend(x)" : "document.querySelector('#last').before(x)"}},100)}})</script>` : ''}
  </body></html>`;
}

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/delayed.svg') {
      res.setHeader('Content-Type', 'image/svg+xml');
      setTimeout(() => res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="2400"><rect width="1000" height="2400" fill="rgb(32,64,192)"/></svg>'), 350);
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fixture(req.url.slice(1) || 'normal'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'longshot-test-'));
  let context;
  try {
    // Test the shipped manifest in a disposable profile. The compatibility run
    // changes only the toolbar route to exercise the explicit scroll mode.
    const extensionPath = path.join(profile, 'extension');
    await fs.cp(process.env.LONGSHOT_EXTENSION_DIR || path.join(project, 'longshot-copy'), extensionPath,
      { recursive: true, filter: source => !path.basename(source).startsWith('._') });
    if (!native) {
      const background = path.join(extensionPath, 'background.js');
      await fs.writeFile(background, (await fs.readFile(background, 'utf8')).replace("const DEFAULT_MODE = 'native';", "const DEFAULT_MODE = 'scroll';"));
    }
    context = await chromium.launchPersistentContext(profile, {
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
      headless: process.env.LONGSHOT_HEADED !== '1', viewport: null,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--disable-features=ExtensionDisableUnsupportedDeveloper', '--window-size=1000,807', `--force-device-scale-factor=${dpr}`],
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto('chrome://extensions');
    const devToggle = page.locator('#devMode');
    if (await devToggle.getAttribute('aria-pressed') !== 'true') await devToggle.click();
    const cdp = await context.newCDPSession(page);
    const browserCdp = await context.browser().newBrowserCDPSession();
    const panelClosedAt = new Map();
    let panelTargetId;
    browserCdp.on('Target.targetDestroyed', event => panelClosedAt.set(event.targetId, performance.now()));
    await browserCdp.send('Target.setDiscoverTargets', { discover: true });
    async function panelCommand(method, params = {}) {
      const targets = await browserCdp.send('Target.getTargets');
      const popup = targets.targetInfos.find(t => t.url.endsWith('/offscreen.html?view=progress'));
      assert.ok(popup, 'toolbar progress panel must be open');
      panelTargetId = popup.targetId;
      const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: false });
      let receive, timer;
      try {
        const response = new Promise((resolve, reject) => {
          receive = event => {
            if (event.sessionId !== sessionId) return;
            const message = JSON.parse(event.message);
            if (message.id !== 1) return;
            if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
          };
          browserCdp.on('Target.receivedMessageFromTarget', receive);
          timer = setTimeout(() => reject(new Error('Progress panel did not respond')), 5000);
        });
        await browserCdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method, params }) });
        return await response;
      } finally {
        clearTimeout(timer);
        browserCdp.off('Target.receivedMessageFromTarget', receive);
        await browserCdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
    }
    await cdp.send('ServiceWorker.enable');
    cdp.on('ServiceWorker.workerErrorReported', event => console.log('WORKER ERROR', event.errorMessage));
    context.on('console', message => console.log('BROWSER', message.text()));
    const { id } = await browserCdp.send('Extensions.loadUnpacked', { path: extensionPath });
    console.log('Extension loaded:', id);
    const extensionInfo = await page.evaluate(async id => {
      const info = await chrome.developerPrivate.getExtensionInfo(id);
      return { manifestErrors: info.manifestErrors, runtimeErrors: info.runtimeErrors, views: info.views };
    }, id);
    assert.equal(extensionInfo.manifestErrors.length, 0, JSON.stringify(extensionInfo.manifestErrors));
    assert.equal(extensionInfo.runtimeErrors.length, 0);
    let worker = context.serviceWorkers().find(w => w.url().includes(id));
    // Wait for module initialization before CDP's synthetic action. Unlike a
    // real toolbar click, triggerAction can race a freshly installed worker.
    if (!worker) {
      const ready = context.waitForEvent('serviceworker', { timeout: 15000 });
      await cdp.send('ServiceWorker.startWorker', { scopeURL: `chrome-extension://${id}/` });
      worker = await ready;
    }
    assert.ok(await worker.evaluate(() => chrome.action.onClicked.hasListeners()));
    if (process.env.LONGSHOT_LEGACY === '1') {
      await worker.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
    }
    const logs = [];
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${port}` });
    await fs.mkdir(path.join(project, 'tests/results'), { recursive: true });
    for (const kind of cases) {
      await page.goto(`http://127.0.0.1:${port}/${kind}`);
      await page.bringToFront();
      // Let the previous job's Chrome banner finish disappearing before taking
      // the next test's baseline viewport measurement.
      await page.waitForTimeout(300);
      await page.evaluate(kind => {
        const el = kind === 'nested' ? document.querySelector('main') : document.scrollingElement;
        el.scrollTo({ top: 315, behavior: 'instant' });
      }, kind);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const before = await page.evaluate(kind => ({
        scroll: (kind === 'nested' ? document.querySelector('main') : document.scrollingElement).scrollTop,
        style: document.documentElement.getAttribute('style'),
        sheets: document.querySelectorAll('style').length, viewport: [innerWidth, innerHeight]
      }), kind);
      const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
      const tabTarget = targetInfos.find(t => t.url === page.url());
      assert.ok(tabTarget, `Missing tab target: ${JSON.stringify(targetInfos)}`);
      const workerReady = worker ? Promise.resolve(worker) : context.waitForEvent('serviceworker', { timeout: 15000 });
      await page.evaluate(() => {
        window.testScrolls = 0;
        document.addEventListener('scroll', () => window.testScrolls++, true);
        window.testSizes = [[innerWidth, innerHeight]];
        window.addEventListener('resize', () => window.testSizes.push([innerWidth, innerHeight]));
      });
      const started = performance.now();
      await browserCdp.send('Extensions.triggerAction', { id, targetId: tabTarget.targetId });
      worker = await workerReady;
      worker.on('console', message => logs.push(message.text()));
      const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
      const end = Date.now() + 65000;
      let badge, lastBadge, sawProgress = false;
      while (Date.now() < end) {
        badge = await worker.evaluate(tabId => chrome.action.getBadgeText({ tabId }), tabId);
        if (badge !== lastBadge) { console.log(kind, badge); lastBadge = badge; }
        if (!native && /%$/.test(badge) && !sawProgress) {
          const ongoing = await panelCommand('Runtime.evaluate', { expression: `JSON.stringify({phase:document.body.dataset.phase,progress:document.querySelector('[role=progressbar]').getAttribute('aria-valuenow')})`, returnByValue: true });
          const progressState = JSON.parse(ongoing.result.value);
          assert.equal(progressState.phase, 'capturing');
          assert.ok(Number(progressState.progress) > 0 && Number(progressState.progress) < 100);
          sawProgress = true;
        }
        if (badge === '已复制' || badge === '!' || badge === '取消') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const title = await worker.evaluate(tabId => chrome.action.getTitle({ tabId }), tabId);
      if (badge !== '已复制') {
        console.log('VIEWPORT', before.viewport, await page.evaluate(() => ({ sizes: testSizes, size: [innerWidth, innerHeight], scrollY })));
        console.log('WINDOWS', await worker.evaluate(() => chrome.windows.getAll()));
        console.log('PANEL FOCUS', await panelCommand('Runtime.evaluate', { expression: 'JSON.stringify({focused:document.hasFocus(),visibility:document.visibilityState})', returnByValue: true }).catch(error => error.message));
      }
      assert.equal(badge, '已复制', `${kind}: ${title}; ${logs.join(';')}`);
      const completedAt = performance.now();
      const elapsed = Math.round(completedAt - started);
      const panel = await panelCommand('Runtime.evaluate', { expression: `JSON.stringify({phase:document.body.dataset.phase,title:document.querySelector('h1').textContent,progress:document.querySelector('[role=progressbar]').getAttribute('aria-valuenow'),elapsed:document.querySelector('#elapsed').textContent,width:innerWidth,height:innerHeight})`, returnByValue: true });
      const panelState = JSON.parse(panel.result.value);
      assert.equal(panelState.phase, 'done');
      assert.equal(panelState.title, '已复制');
      assert.equal(panelState.progress, '100');
      assert.match(panelState.elapsed, /^\d+\.\d{2} 秒$/);
      assert.equal(panelState.width, 260);
      assert.ok(panelState.height <= 70, 'success panel should be a compact strip');
      if (process.env.LONGSHOT_UI === '1') {
        await page.waitForTimeout(200);
        const shot = await panelCommand('Page.captureScreenshot', { format: 'png' });
        console.log('PANEL_IMAGE:' + shot.data);
      }
      await page.waitForTimeout(Math.max(0, completedAt + 580 - performance.now()));
      const fading = await panelCommand('Runtime.evaluate', { expression: `JSON.stringify({leaving:document.body.classList.contains('leaving'),opacity:getComputedStyle(document.body).opacity})`, returnByValue: true });
      const fadeState = JSON.parse(fading.result.value);
      assert.equal(fadeState.leaving, true);
      assert.ok(Number(fadeState.opacity) < 1, 'completion should visibly fade');
      const completedPanel = panelTargetId;
      while (!panelClosedAt.has(completedPanel) && performance.now() - completedAt < 1100) await page.waitForTimeout(20);
      assert.ok(panelClosedAt.has(completedPanel), 'success panel must close automatically');
      const closeTime = Math.round(panelClosedAt.get(completedPanel) - completedAt);
      assert.ok(closeTime < 1000, `success panel stayed open ${closeTime} ms`);
      console.log(`PASS compact progress: 100% after copy, fade + close in ${closeTime} ms`);
      const png = await page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        const item = items.find(item => item.types.includes('image/png'));
        if (!item) throw new Error('Clipboard has no native PNG');
        const bytes = new Uint8Array(await (await item.getType('image/png')).arrayBuffer());
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      });
      const buffer = Buffer.from(png, 'base64');
      await fs.writeFile(path.join(project, `tests/results/${kind}.png`), buffer);
      const meta = await sharp(buffer).metadata();
      const expectedHeight = kind === 'short' ? before.viewport[1] : 21 * 180 + 37 + (['lazy', 'lazy-prepend'].includes(kind) ? 1100 : kind === 'lazy-image' ? 2400 : 0);
      assert.equal(meta.height, expectedHeight * dpr, `${kind} height`);
      if (kind === 'wide') assert.equal(meta.width, 1800 * dpr);
      const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const pixel = (x, y) => {
        const offset = (Math.floor(y * dpr) * info.width + Math.floor(x * dpr)) * 3;
        return [...data.slice(offset, offset + 3)];
      };
      if (kind !== 'short') assert.deepEqual(pixel(10, expectedHeight - 3), [17, 231, 83], `${kind}: missing bottom marker`);
      if (kind === 'lazy-image') assert.deepEqual(pixel(10, 4000), [32, 64, 192], 'lazy image must be loaded');
      if (kind === 'lazy-prepend') assert.deepEqual(pixel(10, 800), [32, 64, 192], 'prepended content must not be skipped');
      if (kind === 'normal') {
        assert.deepEqual(pixel(500, 5), [255, 0, 255], 'fixed header must appear at top');
        for (let i = 0; i < 21; i++) assert.deepEqual(pixel(info.width / dpr - 2, i * 180 + 90), [(i * 37 + 20) % 230, (i * 59 + 40) % 230, (i * 83 + 60) % 230], 'right edge must not contain scrollbar');
      }
      // Check every original row, away from text and borders, for lost or duplicated sections.
      for (let i = 0; i < (kind === 'short' ? 2 : 21); i++) {
        for (let y = i === 0 ? 45 : 0; y < 180; y++) {
          assert.deepEqual(pixel(10, i * 180 + y + (kind === 'lazy-prepend' ? 1100 : 0)), [(i * 37 + 20) % 230, (i * 59 + 40) % 230, (i * 83 + 60) % 230], `${kind}: row ${i}, pixel ${y}`);
        }
      }
      const after = await page.evaluate(kind => ({
        scroll: (kind === 'nested' ? document.querySelector('main') : document.scrollingElement).scrollTop,
        sheets: document.querySelectorAll('style').length,
        topPosition: document.querySelector('#fixed')?.style.position || '',
        topVisibility: document.querySelector('#fixed')?.style.visibility || ''
      }), kind);
      assert.equal(after.scroll, before.scroll, `${kind}: original scroll`);
      assert.equal(after.sheets, before.sheets, `${kind}: cleanup`);
      assert.equal(after.topVisibility, '', `${kind}: restore header`);
      assert.equal(after.topPosition, '', `${kind}: restore header position`);
      if (native) assert.equal(await page.evaluate(() => window.testScrolls), 0, `${kind}: native mode must not scroll`);
      assert.equal(context.pages().length, 1, `${kind}: opened a new tab`);
      assert.equal(await worker.evaluate(async tabId => {
        try { await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics'); return true; }
        catch { return false; }
      }, tabId), false, 'debugger must detach');
      console.log(`PASS ${kind}: ${meta.width} × ${meta.height}, ${elapsed} ms, ${await page.evaluate(() => window.testScrolls)} scrolls, native PNG clipboard, scroll restored, no new tab`);
    }
    // Cancel in the middle of real scrolling. The previously copied image must remain intact.
    await page.goto(`http://127.0.0.1:${port}/${native ? 'lazy-image' : 'normal'}`);
    await page.bringToFront();
    await page.evaluate(() => document.scrollingElement.scrollTo({ top: 317, behavior: 'instant' }));
    const clipboardBefore = await page.evaluate(async () => {
      const blob = await (await navigator.clipboard.read())[0].getType('image/png');
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].join(',');
    });
    const targets = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
    const targetId = targets.targetInfos.find(t => t.url === page.url()).targetId;
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    await browserCdp.send('Extensions.triggerAction', { id, targetId });
    if (native) await page.waitForFunction(() => document.querySelector('img').loading === 'eager');
    else await page.waitForFunction(() => document.scrollingElement.scrollTop > 900);
    // Cancel through the real progress panel, rather than only the page shortcut.
    await panelCommand('Runtime.evaluate', { expression: `document.querySelector('#control').click()` });
    const end = Date.now() + 10000;
    let cancelBadge;
    do {
      cancelBadge = await worker.evaluate(tabId => chrome.action.getBadgeText({ tabId }), tabId);
      if (cancelBadge === '取消') break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < end);
    assert.equal(cancelBadge, '取消');
    const cancelledPanel = await panelCommand('Runtime.evaluate', { expression: `document.body.dataset.phase`, returnByValue: true });
    assert.equal(cancelledPanel.result.value, 'cancelled');
    await page.waitForFunction(() => document.scrollingElement.scrollTop === 317);
    assert.equal(await page.locator('style').count(), 1);
    const clipboardAfter = await page.evaluate(async () => {
      const blob = await (await navigator.clipboard.read())[0].getType('image/png');
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].join(',');
    });
    assert.equal(clipboardAfter, clipboardBefore);
    assert.equal(context.pages().length, 1);
    console.log('PASS cancellation: scroll/styles restored, previous clipboard preserved, no new tab');
    if (native) {
      // An inner scrolling app cannot be captured without moving or expanding
      // its contents. Default mode must refuse instead of silently scrolling.
      await page.goto(`http://127.0.0.1:${port}/nested`);
      await page.waitForTimeout(300);
      await page.evaluate(() => document.querySelector('main').scrollTo({ top: 317, behavior: 'instant' }));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(() => {
        window.testScrolls = 0;
        document.addEventListener('scroll', () => window.testScrolls++, true);
      });
      const targets = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
      await browserCdp.send('Extensions.triggerAction', { id, targetId: targets.targetInfos.find(t => t.url === page.url()).targetId });
      let failed = false;
      for (let i = 0; i < 100; i++) {
        const badge = await worker.evaluate(tabId => chrome.action.getBadgeText({ tabId }), tabId);
        if (badge === '!') { failed = true; break; }
        await page.waitForTimeout(50);
      }
      assert.ok(failed, 'inner scroller must refuse in native mode');
      assert.match(await worker.evaluate(tabId => chrome.action.getTitle({ tabId }), tabId), /独立滚动区/);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.testScrolls), 0);
      assert.equal(await page.evaluate(() => document.querySelector('main').scrollTop), 317);
      assert.equal(await page.locator('style').count(), 1);
      const hash = await page.evaluate(async () => {
        const blob = await (await navigator.clipboard.read())[0].getType('image/png');
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].join(',');
      });
      assert.equal(hash, clipboardBefore);
      console.log('PASS inner-scroller refusal: zero scrolls, previous clipboard preserved');
      // A successful screenshot is not a successful copy. The panel must only
      // show 100% / success after the real clipboard write has completed.
      await page.goto(`http://127.0.0.1:${port}/normal`);
      await page.waitForTimeout(300);
      await worker.evaluate(() => {
        globalThis.testClipboardProperty = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
        Object.defineProperty(navigator, 'clipboard', {
          value: { write: async () => { throw new Error('模拟复制失败'); } }, configurable: true
        });
      });
      const failureTargets = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
      await browserCdp.send('Extensions.triggerAction', { id, targetId: failureTargets.targetInfos.find(t => t.url === page.url()).targetId });
      let copyFailed = false;
      for (let i = 0; i < 100; i++) {
        if ((await worker.evaluate(tabId => chrome.action.getTitle({ tabId }), tabId)) === '模拟复制失败') { copyFailed = true; break; }
        await page.waitForTimeout(50);
      }
      assert.ok(copyFailed);
      const failurePanel = await panelCommand('Runtime.evaluate', { expression: `JSON.stringify({phase:document.body.dataset.phase,title:document.querySelector('h1').textContent,progress:document.querySelector('[role=progressbar]').getAttribute('aria-valuenow')})`, returnByValue: true });
      assert.deepEqual(JSON.parse(failurePanel.result.value), { phase: 'error', title: '截图未完成', progress: null });
      const unchanged = await page.evaluate(async () => {
        const blob = await (await navigator.clipboard.read())[0].getType('image/png');
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].join(',');
      });
      assert.equal(unchanged, clipboardBefore);
      console.log('PASS copy failure: no success / 100% indication, original clipboard preserved');
      await worker.evaluate(() => {
        if (globalThis.testClipboardProperty) Object.defineProperty(navigator, 'clipboard', globalThis.testClipboardProperty);
        else delete navigator.clipboard;
        delete globalThis.testClipboardProperty;
      });
      if (process.env.LONGSHOT_HEADED === '1') for (const change of ['window', 'tab']) {
        await page.goto(`http://127.0.0.1:${port}/lazy-image`);
        await page.bringToFront();
        await page.waitForTimeout(300);
        await page.evaluate(() => document.scrollingElement.scrollTo({ top: 317, behavior: 'instant' }));
        const targets = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
        await browserCdp.send('Extensions.triggerAction', { id, targetId: targets.targetInfos.find(t => t.url === page.url()).targetId });
        await page.waitForFunction(() => document.querySelector('img').loading === 'eager');
        const other = await worker.evaluate(async change => change === 'window'
          ? chrome.windows.create({ url: 'about:blank', focused: true, width: 320, height: 240, left: 1100, top: 80 })
          : chrome.tabs.create({ url: 'about:blank', active: true }), change);
        try {
          const expected = change === 'window' ? '浏览器失去了焦点' : '你切换了标签页';
          let stopped = false;
          for (let i = 0; i < 100; i++) {
            const title = await worker.evaluate(tabId => chrome.action.getTitle({ tabId }), tabId);
            if (title.includes(expected)) { stopped = true; break; }
            await page.waitForTimeout(100);
          }
          assert.ok(stopped, `${change}: must still stop when the user leaves the target`);
        } finally {
          await worker.evaluate(async ({ change, id }) => change === 'window'
            ? chrome.windows.remove(id) : chrome.tabs.remove(id), { change, id: other.id });
          await page.bringToFront();
        }
        assert.equal(await page.evaluate(() => scrollY), 317);
        assert.equal(await page.locator('style').count(), 1);
        const preserved = await page.evaluate(async () => {
          const blob = await (await navigator.clipboard.read())[0].getType('image/png');
          return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].join(',');
        });
        assert.equal(preserved, clipboardBefore);
        console.log(`PASS ${change} switch: capture stopped, clipboard and page position preserved`);
      }
    }
  } finally {
    await context?.close();
    server.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
