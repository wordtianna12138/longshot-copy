import { nextOffset, outputSize } from './geometry.js';
import { Compositor } from './offscreen.js';

const TITLE = '截长图并复制';
const DEFAULT_MODE = 'native';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let running = null;
let lastCapture = 0;
let creatingOffscreen = null;
const badgeJobs = new Map();
const viewers = new Map();
const focusChecks = new Map();

function publish(job, phase, detail = {}) {
  job.status = { id: job.id, phase, elapsed: Date.now() - job.started, ...detail };
  for (const [port, tabId] of viewers) if (tabId === job.tabId) {
    try {
      port.postMessage(job.status);
      if (phase === 'done') job.completionShown = true;
    } catch { viewers.delete(port); }
  }
}

function hasViewer(job) {
  return [...viewers.values()].includes(job.tabId);
}

async function viewerHasFocus(job) {
  // On macOS the toolbar popup is a separate key window: the browser window
  // can report focused:false while this extension's popup has focus. Ask the
  // live popup instead of treating an open connection as proof of focus.
  const ports = [...viewers].filter(([, tabId]) => tabId === job.tabId).map(([port]) => port);
  const focused = await Promise.all(ports.map(port => new Promise(resolve => {
    const requestId = crypto.randomUUID();
    const finish = value => {
      clearTimeout(timer);
      focusChecks.delete(requestId);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 500);
    focusChecks.set(requestId, { port, finish });
    try { port.postMessage({ type: 'focus-check', requestId }); }
    catch { finish(false); }
  })));
  return focused.some(Boolean);
}

async function badge(tabId, text, title, color = '#155e75') {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color }),
    chrome.action.setTitle({ tabId, title })
  ]).catch(() => {});
}

async function content(job, action, data = {}) {
  const response = await chrome.tabs.sendMessage(job.tabId,
    { channel: 'longshot-content', id: job.id, action, ...data }, { frameId: 0 });
  if (!response?.ok) throw new Error(response?.error || '网页没有响应，请刷新网页后重试。');
  return response;
}

async function imageJob(job, action, data = {}) {
  if (job.compositor) return job.compositor.handle({ id: job.id, action, ...data });
  const response = await chrome.runtime.sendMessage({ channel: 'longshot-offscreen', id: job.id, action, ...data });
  if (!response?.ok) throw new Error(response?.error || '长图合成失败，请重试。');
  return response;
}

async function offscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({ url: 'offscreen.html',
      reasons: ['BLOBS', 'CLIPBOARD'], justification: '在后台合成长截图并复制图片，不打开新页面。'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function check(job) {
  if (job.cancelled) throw new Error('已取消截图。');
  if (Date.now() - job.started > 180000) throw new Error('页面过长或持续加载，未复制不完整的图片。请缩短内容后重试。');
  const [active] = await chrome.tabs.query({ active: true, windowId: job.windowId });
  if (active?.id !== job.tabId) throw new Error('你切换了标签页，截图已停止。回到原页面后可重新截图。');
  let focused = false;
  // A popup's script can run before macOS has finished making its window key.
  // Also tolerate the short handoff when the user closes it onto the webpage.
  for (let attempt = 0; attempt < 5 && !focused; attempt++) {
    if (attempt) await delay(50);
    if (job.cancelled) throw new Error('已取消截图。');
    const win = await chrome.windows.get(job.windowId);
    focused = win.focused || await viewerHasFocus(job);
  }
  if (!focused) {
    throw new Error('浏览器失去了焦点，截图已停止。请回到原页面重试。');
  }
}

function validateMetrics(m) {
  if (![m.totalWidth, m.totalHeight, m.width, m.height].every(n => Number.isFinite(n) && n > 0)) {
    throw new Error('无法识别网页的滚动范围。');
  }
  if (m.totalHeight > 200000 || m.totalWidth > 40000) {
    throw new Error('内容超过单张长图的处理范围，未复制不完整的图片。');
  }
}

async function preload(job) {
  let m = await content(job, 'scroll', { x: 0, y: 0, warmup: true });
  let bottomChecks = 0;
  for (let i = 0; i < 150; i++) {
    await check(job); validateMetrics(m);
    await badge(job.tabId, '准备', '正在加载网页内容 · 可按 Esc 取消');
    publish(job, 'preparing', { text: '正在加载页面内容…' });
    const y = nextOffset(m.y, m.height, m.totalHeight);
    if (y === null) {
      await delay(450);
      const refreshed = await content(job, 'measure');
      if (refreshed.totalHeight <= m.totalHeight + 1) bottomChecks++; else bottomChecks = 0;
      m = refreshed;
      if (bottomChecks >= 2) return m;
    } else {
      bottomChecks = 0;
      const oldY = m.y;
      m = await content(job, 'scroll', { x: 0, y, warmup: true });
      if (m.y < oldY + 0.5) throw new Error('网页阻止了滚动，无法截取完整内容。');
    }
  }
  throw new Error('页面仍在持续加载，未复制不完整的图片。请停止页面加载后重试。');
}

async function copyImage(job, result) {
  // New Chrome versions can write PNG directly from the service worker.
  // Older versions use the focused page, with the extension's clipboardWrite permission.
  if (result.blob) {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': result.blob })]);
    return;
  }
  try { await imageJob(job, 'copy'); return; } catch { /* older Chrome requires focus */ }
  const transfer = await imageJob(job, 'transfer');
  await content(job, 'copyStart');
  for (let i = 0; i < transfer.chunks; i++) {
    const chunk = await imageJob(job, 'chunk', { index: i });
    await content(job, 'copyChunk', { data: chunk.data });
  }
  await content(job, 'copyEnd');
}

async function debugCommand(job, method, params = {}) {
  let timer;
  try {
    return await Promise.race([
      chrome.debugger.sendCommand({ tabId: job.tabId }, method, params),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('截图超时，请稍后重试。')), 30000); })
    ]);
  } finally { clearTimeout(timer); }
}

async function releaseDebugger(job) {
  if (!job.attached) return;
  await debugCommand(job, 'Emulation.setScrollbarsHidden', { hidden: false }).catch(() => {});
  await chrome.debugger.detach({ tabId: job.tabId }).catch(() => {});
  job.attached = false;
}

async function nativeCapture(job, initial) {
  const metrics = await debugCommand(job, 'Page.getLayoutMetrics');
  const width = Math.ceil(metrics.cssContentSize.width);
  // The debugger banner temporarily reduces the visible height. Preserve the
  // original capture area for short pages instead of clipping that strip off.
  const height = Math.max(Math.ceil(metrics.cssContentSize.height), job.viewportHeight);
  validateMetrics({ totalWidth: width, totalHeight: height, width, height });
  const size = outputSize(width, height, initial.deviceScale);
  await badge(job.tabId, '截图', '正在直接截取整页…');
  publish(job, 'capturing');
  const shot = await debugCommand(job, 'Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: true, optimizeForSpeed: true,
    clip: { x: 0, y: 0, width, height, scale: size.scale / initial.deviceScale }
  });
  await check(job);
  const verified = await content(job, 'verify', { x: initial.x, y: initial.y });
  const after = await debugCommand(job, 'Page.getLayoutMetrics');
  if (verified.contentChanged || Math.abs(after.cssContentSize.width - metrics.cssContentSize.width) > 1 ||
      Math.abs(after.cssContentSize.height - metrics.cssContentSize.height) > 1) {
    throw new Error('网页内容还在变化，请等待加载完成后重试，或右键插件选择滚动兼容截图。');
  }
  const header = Uint8Array.from(atob(shot.data.slice(0, 44)), c => c.charCodeAt(0));
  const view = new DataView(header.buffer);
  const actualWidth = view.getUint32(16), actualHeight = view.getUint32(20);
  if (Math.abs(actualWidth - size.width) > 2 || Math.abs(actualHeight - size.height) > 2) {
    throw new Error('浏览器返回的图片尺寸不完整，未覆盖剪贴板。可右键插件选择滚动兼容截图。');
  }
  await imageJob(job, 'png', { dataUrl: `data:image/png;base64,${shot.data}`,
    width: actualWidth, height: actualHeight, reduced: size.reduced });
}

async function capture(tab, options = {}) {
  if (running) {
    if (running.tabId === tab.id) running.cancelled = true;
    else await badge(tab.id, '忙', '正在截取另一页，请等待完成。');
    return;
  }
  const job = { id: crypto.randomUUID(), tabId: tab.id, windowId: tab.windowId,
    started: Date.now(), cancelled: false, injected: false, mode: options.mode || DEFAULT_MODE, attached: false };
  running = job;
  badgeJobs.set(tab.id, job.id);
  publish(job, 'preparing');
  let message = '', ok = false;
  try {
    if (!/^https?:\/\//i.test(tab.url || '') || /^https:\/\/chrome(webstore\.google\.com|\.google\.com\/webstore)/i.test(tab.url)) {
      throw new Error('请在普通网页中使用，Chrome 内部页面、扩展商店和本地文件暂不支持。');
    }
    await badge(tab.id, '准备', '正在准备长截图 · 可按 Esc 取消');
    await check(job);
    if (job.mode === 'native') {
      const granted = await chrome.permissions.contains({ permissions: ['debugger'] });
      if (!granted) throw new Error('缺少整页截图权限，请在扩展管理页重新启用插件。');
      await check(job);
      const [viewport] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => innerHeight });
      job.viewportHeight = viewport.result;
      try { await chrome.debugger.attach({ tabId: tab.id }, '1.3'); }
      catch { throw new Error('无法使用静止截图，请先关闭此网页的开发者工具，或右键插件选择滚动兼容截图。'); }
      job.attached = true;
      await debugCommand(job, 'Emulation.setScrollbarsHidden', { hidden: true });
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture.js'] });
    job.injected = true;
    const initial = await content(job, 'start', { mode: job.mode });
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      job.compositor = new Compositor();
    } else {
      await offscreen();
      job.offscreen = true;
    }
    await imageJob(job, 'begin');
    if (job.mode === 'native') {
      await nativeCapture(job, initial);
    } else {
      if (initial.requiresWarmup) await preload(job);
      let m = await content(job, 'scroll', { x: 0, y: 0, first: true });
      const viewport = [m.viewportWidth, m.viewportHeight];
      let frames = 0, rowY = 0, totalWidth = m.totalWidth, totalHeight = m.totalHeight;
      let warmed = initial.requiresWarmup;
      async function restartAfterLoading() {
        // Structural changes can insert content ABOVE pixels already captured.
        // Discard that fast attempt and use the thorough pass once.
        warmed = true;
        await preload(job);
        await imageJob(job, 'begin');
        m = await content(job, 'scroll', { x: 0, y: 0, first: true });
        frames = 0; rowY = 0; totalWidth = m.totalWidth; totalHeight = m.totalHeight;
      }
      let finished = false;
      while (frames < 240) {
        await check(job); validateMetrics(m);
        if (m.viewportWidth !== viewport[0] || m.viewportHeight !== viewport[1]) {
          throw new Error('窗口大小发生变化，请重新截图。');
        }
        totalWidth = Math.max(totalWidth, m.totalWidth);
        totalHeight = Math.max(totalHeight, m.totalHeight);
        if (m.totalHeight < totalHeight - 2 || m.totalWidth < totalWidth - 2) {
          throw new Error('网页布局在截图中发生变化，请等待加载完成后重试。');
        }
        // Chrome allows two captures per second. Leave a small margin instead of
        // a fixed wait on top of rendering and image decoding time.
        await delay(Math.max(0, 520 - (Date.now() - lastCapture)));
        await check(job);
        m = await content(job, 'verify', { x: m.x, y: m.y });
        if (m.contentChanged && !warmed) { await restartAfterLoading(); continue; }
        validateMetrics(m);
        totalWidth = Math.max(totalWidth, m.totalWidth);
        totalHeight = Math.max(totalHeight, m.totalHeight);
        lastCapture = Date.now();
        const dataUrl = await chrome.tabs.captureVisibleTab(job.windowId, { format: 'png' });
        await check(job);
        const after = await content(job, 'verify', { x: m.x, y: m.y });
        if ((!warmed && after.contentChanged) || after.totalWidth !== m.totalWidth || after.totalHeight !== m.totalHeight) {
          m = after; continue; // Layout changed during the shot; retry this tile.
        }
        await imageJob(job, 'tile', { dataUrl, tile: m, totalWidth, totalHeight });
        frames++;
        const area = m.y * totalWidth + Math.min(m.height, totalHeight - m.y) * Math.min(totalWidth, m.x + m.width);
        const progress = Math.min(99, Math.round(100 * area / (totalWidth * totalHeight)));
        await badge(tab.id, `${progress}%`, `正在截长图 ${progress}% · 可按 Esc 取消`);
        publish(job, 'capturing', { progress });
        const x = nextOffset(m.x, m.width, totalWidth);
        if (x !== null) {
          const oldX = m.x;
          m = await content(job, 'scroll', { x, y: rowY });
          if (m.x <= oldX + 0.5) throw new Error('横向内容无法完整滚动。');
          continue;
        }
        const y = nextOffset(rowY, m.height, totalHeight);
        if (y === null) {
          if (frames > 1 || initial.requiresWarmup) await delay(400);
          const tail = await content(job, 'measure');
          if (!warmed && tail.contentChanged) { await restartAfterLoading(); continue; }
          if (tail.totalHeight > totalHeight + 1 || tail.totalWidth > totalWidth + 1) {
            totalHeight = tail.totalHeight; totalWidth = tail.totalWidth;
            const nextY = nextOffset(rowY, m.height, totalHeight);
            if (nextY === null) throw new Error('页面宽度持续变化，请等待加载完成后重试。');
            rowY = nextY;
          } else { finished = true; break; }
        } else rowY = y;
        const previousY = m.y;
        m = await content(job, 'scroll', { x: 0, y: rowY });
        if (m.y <= previousY + 0.5) throw new Error('网页阻止了继续滚动，未复制不完整的图片。');
        rowY = m.y;
      }
      if (!finished) throw new Error('页面超过本次截图范围，未复制不完整的图片。');
    }
    await badge(tab.id, '复制', '正在合成长图并复制…');
    publish(job, 'copying');
    const [result] = await Promise.all([imageJob(job, 'encode'), content(job, 'restore')]);
    await releaseDebugger(job);
    await check(job);
    await copyImage(job, result);
    ok = true;
    message = result.reduced ? '已复制完整长图（尺寸较长，已缩小）' : '长图已复制，可以直接粘贴';
    await badge(tab.id, '已复制', `${message} · ${result.width} × ${result.height}`, '#166534');
    publish(job, 'done', { width: result.width, height: result.height, reduced: result.reduced });
  } catch (error) {
    message = error.message || '截图失败，请刷新页面后重试。';
    console.warn('[长图直贴]', message);
    await badge(tab.id, job.cancelled ? '取消' : '!', message, job.cancelled ? '#475569' : '#991b1b');
    publish(job, job.cancelled ? 'cancelled' : 'error', { text: message });
  } finally {
    if (job.injected) {
      await content(job, 'restore').catch(() => {});
      if (!hasViewer(job) && !(ok && job.completionShown)) await content(job, 'notice', { text: message, ok }).catch(() => {});
    }
    await releaseDebugger(job);
    await imageJob(job, 'dispose').catch(() => {});
    // Never leave an offscreen document with screenshot data after the job ends.
    if (job.offscreen) await chrome.offscreen.closeDocument().catch(() => {});
    job.compositor = null;
    running = null;
    if (ok) setTimeout(async () => {
      if (badgeJobs.get(tab.id) === job.id && running?.tabId !== tab.id) await badge(tab.id, '', TITLE);
    }, 800);
  }
}

chrome.action.onClicked.addListener(tab => {
  void capture(tab, { mode: DEFAULT_MODE });
});
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'longshot-progress' || port.sender?.id !== chrome.runtime.id ||
      port.sender?.url !== chrome.runtime.getURL('offscreen.html?view=progress')) return;
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    viewers.delete(port);
    for (const pending of focusChecks.values()) if (pending.port === port) pending.finish(false);
  });
  port.onMessage.addListener(async message => {
    if (message.action === 'focus') {
      const pending = focusChecks.get(message.requestId);
      if (pending?.port === port) pending.finish(message.focused === true);
      return;
    }
    if (message.action === 'cancel') {
      if (running?.tabId === viewers.get(port) && running.id === message.id) {
        running.cancelled = true;
        publish(running, 'cancelling');
      }
      return;
    }
    if (message.action !== 'start' || viewers.has(port)) return;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) { port.postMessage({ phase: 'error', text: '找不到当前网页，请关闭面板后重试。' }); return; }
    if (!disconnected) viewers.set(port, tab.id);
    if (running) {
      if (!disconnected) port.postMessage(running.tabId === tab.id ? running.status :
        { phase: 'error', text: '正在截取另一页，请等待完成后重试。' });
    } else void capture(tab, { mode: DEFAULT_MODE });
  });
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({
    id: 'scroll-capture', title: '滚动兼容截图（页面会移动）', contexts: ['action']
  }));
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'scroll-capture' && tab) {
    void capture(tab, { mode: 'scroll' });
    // Older Chrome still shows the toolbar percentage and completion toast.
    chrome.action.openPopup?.({ windowId: tab.windowId }).catch(() => {});
  }
});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.channel === 'longshot-cancel' && sender.id === chrome.runtime.id &&
      sender.tab?.id === running?.tabId && message.id === running?.id) running.cancelled = true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  badgeJobs.delete(tabId);
  if (running?.tabId === tabId) running.cancelled = true;
});
