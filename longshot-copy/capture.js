(() => {
  if (globalThis.__longshotCopyInstalled === '1.0.0') return;
  globalThis.__longshotCopyInstalled = '1.0.0';
  let state = null, notice = null, noticeTimer = null, watchdog = null, chunks = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  function elements(root = document) {
    const result = [];
    for (const element of root.querySelectorAll('*')) {
      result.push(element);
      if (element.shadowRoot) result.push(...elements(element.shadowRoot));
    }
    return result;
  }

  function toast(text, ok) {
    notice?.remove(); clearTimeout(noticeTimer);
    const host = document.createElement('div');
    host.style.cssText = 'all:initial!important;position:fixed!important;bottom:24px!important;right:24px!important;z-index:2147483647!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const panel = document.createElement('div');
    panel.setAttribute('role', ok ? 'status' : 'alert'); panel.setAttribute('aria-atomic', 'true');
    panel.style.cssText = `font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-sizing:border-box;max-width:min(420px,calc(100vw - 48px));padding:14px 18px;color:#fff;background:${ok ? '#14532d' : '#334155'};border-radius:12px;box-shadow:0 8px 32px #0003;`;
    if (ok) {
      panel.style.cssText = 'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-sizing:border-box;padding:10px 12px;color:#24292f;background:#fff;border:1px solid #e6e8eb;border-radius:6px;box-shadow:0 2px 8px #0001;';
      panel.textContent = text.includes('已缩小') ? '已复制（长图已缩小）' : '已复制，可直接粘贴';
      const bar = document.createElement('div');
      bar.style.cssText = 'height:3px;background:#168377;border-radius:2px;margin-top:8px;';
      panel.append(bar);
      host.style.setProperty('transition', matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : 'opacity 180ms ease-out', 'important');
    } else panel.textContent = text;
    shadow.append(panel); document.documentElement.append(host); notice = host;
    const remove = () => { host.remove(); if (notice === host) notice = null; };
    noticeTimer = setTimeout(() => {
      if (!ok) { remove(); return; }
      host.style.setProperty('opacity', '0', 'important');
      noticeTimer = setTimeout(remove, 300);
    }, ok ? 500 : 12000);
  }

  function target(all) {
    const root = document.scrollingElement || document.documentElement;
    const rootLong = root.scrollHeight > innerHeight * 1.3;
    const area = innerWidth * innerHeight;
    let best = null, score = 0;
    for (const el of all) {
      if (el === root || el === document.body || /^(TEXTAREA|SELECT|INPUT|PRE|CODE)$/.test(el.tagName)) continue;
      if (el.scrollHeight <= el.clientHeight + 4 || el.clientHeight < 160 || el.clientWidth < innerWidth * 0.28) continue;
      const css = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(css.overflowY) || css.visibility === 'hidden' || css.display === 'none') continue;
      const r = el.getBoundingClientRect();
      const visibleW = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const visibleH = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      const fraction = visibleW * visibleH / area;
      const central = r.left < innerWidth * 0.65 && r.right > innerWidth * 0.45;
      if (fraction < 0.22 || !central || (rootLong && fraction < 0.62)) continue;
      const main = el.matches('main,[role="main"],[role="log"]') || el.querySelector('main,[role="main"],[role="log"]');
      const rank = fraction * (main ? 1.3 : 1) * Math.min(2, Math.log2(1 + el.scrollHeight / el.clientHeight));
      if (rank > score) { best = el; score = rank; }
    }
    return best || root;
  }

  function saveStyle(el, key, value) {
    const map = state.styles;
    let values = map.get(el);
    if (!values) { values = new Map(); map.set(el, values); }
    if (!values.has(key)) values.set(key, [el.style.getPropertyValue(key), el.style.getPropertyPriority(key)]);
    el.style.setProperty(key, value, 'important');
  }

  function rememberScroll(el) {
    if (!state.scrolls.has(el)) state.scrolls.set(el, [el.scrollLeft, el.scrollTop]);
  }

  function resetWatchdog() {
    clearTimeout(watchdog);
    if (state?.active) watchdog = setTimeout(() => {
      restore(); toast('截图已中断，页面已恢复。请重新点击插件。', false);
    }, state.native ? 40000 : 25000);
  }

  async function start(id, mode) {
    restore(); notice?.remove(); clearTimeout(noticeTimer); notice = null; chunks = [];
    if (mode === 'native') {
      // Chrome's debugger banner animates the viewport height. Let that settle
      // before measuring; otherwise a correct shot is rejected as a resize.
      let previous = `${innerWidth},${innerHeight}`, stable = 0;
      for (let i = 0; i < 40 && stable < 5; i++) {
        await delay(20);
        const current = `${innerWidth},${innerHeight}`;
        stable = current === previous ? stable + 1 : 0;
        previous = current;
      }
    }
    const all = elements();
    const el = target(all);
    const root = document.scrollingElement || document.documentElement;
    state = { id, native: mode === 'native', active: true, el, root: el === root, styles: new Map(), scrolls: new Map(), attributes: [],
      fixed: [], sheets: [], windowX: scrollX, windowY: scrollY,
      focus: document.activeElement, viewport: [innerWidth, innerHeight], requiresWarmup: false,
      images: all.filter(e => e.tagName === 'IMG'), contentChanged: false, observer: null };
    if (state.native && !state.root) {
      throw new Error('此页的主体在独立滚动区，静止模式暂不能截全。可右键插件选择“滚动兼容截图”。');
    }
    rememberScroll(root); rememberScroll(el);
    for (let p = el.parentElement; p; p = p.parentElement) rememberScroll(p);
    const roots = new Set([document]);
    for (const e of all) if (e.shadowRoot) roots.add(e.shadowRoot);
    const changes = [];
    // Read styles in one pass before applying changes. Interleaving each read
    // with a style write forces costly repeated layout on large documents.
    for (const e of all) {
      const css = getComputedStyle(e);
      if (css.contentVisibility === 'auto') {
        changes.push([e, 'content-visibility', 'visible']); state.requiresWarmup = true;
      }
      if (css.position === 'sticky') changes.push([e, 'position', 'relative']);
      if (e.getAttribute('aria-busy') === 'true') state.requiresWarmup = true;
      if (css.position === 'fixed' && css.visibility !== 'hidden' && e !== el && !e.contains(el)) {
        const r = e.getBoundingClientRect();
        if (r.height > 0 && r.width > 0 && r.width * r.height < innerWidth * innerHeight * 0.5) {
          const atTop = r.top < 4 && r.height < innerHeight * 0.25;
          if (state.native && atTop) {
            // Keep the header once at its document position, instead of at the
            // user's current scroll offset in the full-page bitmap.
            changes.push([e, 'position', 'absolute']);
          } else {
            state.fixed.push({ el: e, top: atTop });
            if (!atTop) changes.push([e, 'visibility', 'hidden']);
          }
        }
      }
    }
    state.requiresWarmup ||= state.images.some(img => !img.complete ||
      img.hasAttribute('data-src') || img.hasAttribute('data-lazy-src'));
    for (const r of roots) {
      const style = document.createElement('style');
      style.textContent = '*{scroll-behavior:auto!important;scroll-snap-type:none!important;overflow-anchor:none!important;animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}';
      if (!state.native) style.textContent += '*{scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important}';
      (r.head || r).append(style); state.sheets.push(style);
    }
    // Inline styles also override page rules that already use !important.
    for (const e of state.scrolls.keys()) {
      saveStyle(e, 'scroll-behavior', 'auto'); saveStyle(e, 'scroll-snap-type', 'none');
      saveStyle(e, 'overflow-anchor', 'none');
    }
    for (const [e, key, value] of changes) saveStyle(e, key, value);
    if (!state.native && !state.root) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const current = state;
    state.observer = new MutationObserver(() => { current.contentChanged = true; });
    state.observer.observe(el, { childList: true, characterData: true, subtree: true });
    document.addEventListener('keydown', escape, true);
    if (!state.native) {
      document.addEventListener('wheel', prevent, { capture: true, passive: false });
      document.addEventListener('touchmove', prevent, { capture: true, passive: false });
    }
    if (state.native) {
      for (const img of state.images) if (img.loading === 'lazy') {
        state.attributes.push([img, 'loading', img.getAttribute('loading')]); img.loading = 'eager';
      }
      await paint();
      await Promise.race([Promise.all(state.images.filter(img => !img.complete).map(img => img.decode().catch(() => {}))), delay(2000)]);
      if (state.images.some(img => !img.complete && img.getAttribute('src'))) {
        throw new Error('网页图片还在加载，请加载完成后重试，或使用滚动兼容截图。');
      }
      if (state.images.some(img => !img.getAttribute('src') && (img.hasAttribute('data-src') || img.hasAttribute('data-lazy-src')))) {
        throw new Error('此页需要滚动才能加载图片，请右键插件选择“滚动兼容截图”。');
      }
      if (document.fonts.status === 'loading') await Promise.race([document.fonts.ready, delay(1500)]);
    }
    resetWatchdog(); await paint();
    return { ...measure(), requiresWarmup: state.requiresWarmup };
  }

  function escape(event) {
    if (event.key === 'Escape' && state?.active) {
      event.preventDefault();
      chrome.runtime.sendMessage({ channel: 'longshot-cancel', id: state.id }).catch(() => {});
    } else if (state?.active && !state.native && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) {
      event.preventDefault();
    }
  }
  function prevent(e) { if (state?.active) e.preventDefault(); }

  function measure() {
    if (!state?.el?.isConnected) throw new Error('页面内容发生了变化，请重新截图。');
    const { el, root } = state;
    if (innerWidth !== state.viewport[0] || innerHeight !== state.viewport[1]) throw new Error('窗口尺寸变化，请重新截图。');
    let left = 0, top = 0, width, height, screenScale = 1;
    if (root) {
      width = document.documentElement.clientWidth; height = document.documentElement.clientHeight;
    } else {
      const r = el.getBoundingClientRect();
      screenScale = r.width / el.offsetWidth;
      if (!(screenScale > 0) || Math.abs(r.height / el.offsetHeight - screenScale) > 0.02) {
        throw new Error('当前滚动区域有特殊变形，暂时无法准确截取。');
      }
      left = r.left + el.clientLeft * screenScale; top = r.top + el.clientTop * screenScale;
      width = el.clientWidth; height = el.clientHeight;
      if (left < -1 || top < -1 || left + width * screenScale > innerWidth + 1 || top + height * screenScale > innerHeight + 1) {
        throw new Error('主要滚动区域没有完整显示，请将它移到窗口内或缩小网页后重试。');
      }
    }
    return { kind: root ? 'page' : 'container', x: Math.max(0, el.scrollLeft), y: Math.max(0, el.scrollTop),
      left: Math.max(0, left), top: Math.max(0, top), width, height, screenScale,
      totalWidth: Math.max(width, el.scrollWidth), totalHeight: Math.max(height, el.scrollHeight),
      viewportWidth: innerWidth, viewportHeight: innerHeight, contentChanged: state.contentChanged,
      deviceScale: devicePixelRatio || 1 };
  }

  async function waitForImages() {
    const visible = [...new Set([...document.images, ...state.images])].filter(img => {
      if (img.complete || !img.isConnected) return false;
      const r = img.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    });
    if (visible.length) await Promise.race([Promise.all(visible.map(img => img.decode().catch(() => {}))), delay(900)]);
    if (document.fonts.status === 'loading') await Promise.race([document.fonts.ready, delay(900)]);
  }

  async function scrollToTile(message) {
    if (!state?.active) throw new Error('截图已中断，请重新点击插件。');
    for (const item of state.fixed) {
      if (item.top) saveStyle(item.el, 'visibility', message.first ? 'visible' : 'hidden');
    }
    state.el.scrollTo({ left: message.x, top: message.y, behavior: 'instant' });
    await paint();
    // A short settling window is only needed for inner app/virtualized views.
    if (!state.root || state.requiresWarmup) await delay(message.warmup ? 40 : 80);
    await waitForImages();
    // Some apps clamp or auto-scroll while their virtual list renders.
    if (Math.abs(state.el.scrollLeft - message.x) > 1 || Math.abs(state.el.scrollTop - message.y) > 1) {
      state.el.scrollTo({ left: message.x, top: message.y, behavior: 'instant' });
      await paint();
    }
    return measure();
  }

  function restore() {
    clearTimeout(watchdog);
    chunks = [];
    document.removeEventListener('keydown', escape, true);
    document.removeEventListener('wheel', prevent, true);
    document.removeEventListener('touchmove', prevent, true);
    if (!state?.active) return;
    state.active = false;
    state.observer?.disconnect(); state.observer = null;
    // Restore while smooth scrolling and snap are still disabled.
    if (!state.native) {
      for (const [el, [x, y]] of state.scrolls) if (el.isConnected) el.scrollTo({ left: x, top: y, behavior: 'instant' });
      window.scrollTo({ left: state.windowX, top: state.windowY, behavior: 'instant' });
    }
    for (const [el, entries] of state.styles) for (const [key, [value, priority]] of entries) {
      if (value) el.style.setProperty(key, value, priority); else el.style.removeProperty(key);
    }
    for (const sheet of state.sheets) sheet.remove();
    for (const [el, attr, value] of state.attributes) {
      if (value === null) el.removeAttribute(attr); else el.setAttribute(attr, value);
    }
    state.attributes = [];
    if (state.focus?.isConnected && document.activeElement !== state.focus) state.focus.focus({ preventScroll: true });
    state.styles.clear(); state.scrolls.clear(); state.sheets = []; state.fixed = []; state.images = [];
  }

  async function handle(message) {
    if (message.action === 'start') return start(message.id, message.mode);
    if (!state || message.id !== state.id) throw new Error('截图任务已结束。');
    resetWatchdog();
    switch (message.action) {
      case 'scroll': return scrollToTile(message);
      case 'measure': return measure();
      case 'verify': {
        const m = measure();
        if (Math.abs(m.x - message.x) > 1 || Math.abs(m.y - message.y) > 1) throw new Error('页面滚动位置发生变化，请重试。');
        return m;
      }
      case 'restore': restore(); return {};
      case 'notice': toast(message.text, message.ok); chunks = []; return {};
      case 'copyStart': chunks = []; return {};
      case 'copyChunk': chunks.push(message.data); return {};
      case 'copyEnd': {
        if (!navigator.clipboard?.write) throw new Error('当前 Chrome 无法在此网页直接复制图片，请更新 Chrome 后重试。');
        const data = chunks.join(''); chunks = [];
        const blob = await (await fetch(data)).blob();
        try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); }
        catch { throw new Error('图片已截取，但复制被浏览器阻止。请保持网页在前台，并更新 Chrome 后重试。'); }
        return {};
      }
      default: throw new Error('未知截图操作。');
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.channel !== 'longshot-content' || sender.id !== chrome.runtime.id) return;
    handle(message).then(data => reply({ ok: true, ...data }), error => reply({ ok: false, error: error.message }));
    return true;
  });
})();
