import { outputSize, placement } from './geometry.js';

const CHUNK = 1024 * 1024;
const canvasBlob = canvas => canvas.convertToBlob({ type: 'image/png' });

// The same compositor runs directly in modern Chrome's worker. Only older
// browsers need offscreen.html and the serialized clipboard fallback.
export class Compositor {
  constructor() { this.job = null; }

  async handle(message) {
    const { action, id } = message;
    if (action === 'begin') {
      if (this.job?.canvas) { this.job.canvas.width = 1; this.job.canvas.height = 1; }
      this.job = { id, canvas: null, width: 0, height: 0, scale: 1, reduced: false, blob: null, png: null };
      return {};
    }
    const job = this.job;
    if (!job || job.id !== id) throw new Error('截图任务已结束。');
    if (action === 'dispose') {
      if (job.canvas) { job.canvas.width = 1; job.canvas.height = 1; }
      this.job = null; return {};
    }
    if (action === 'png') {
      job.blob = await (await fetch(message.dataUrl)).blob();
      Object.assign(job, { width: message.width, height: message.height, reduced: message.reduced });
      return {};
    }
    if (action === 'tile') {
      const { tile, totalWidth, totalHeight, dataUrl } = message;
      const source = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(source);
      try {
        const sx = bitmap.width / tile.viewportWidth;
        const sy = bitmap.height / tile.viewportHeight;
        if (Math.abs(sx - sy) > 0.05) throw new Error('窗口尺寸发生了变化，请重新截图。');
        const size = outputSize(totalWidth, totalHeight, sx * tile.screenScale);
        // A single uncropped screen is already a PNG. Avoid another full pixel
        // buffer and PNG encoding pass when it can be copied unchanged.
        if (!job.canvas && !job.blob && tile.x === 0 && tile.y === 0 &&
            tile.left === 0 && tile.top === 0 && totalWidth === tile.width && totalHeight === tile.height &&
            size.width === bitmap.width && size.height === bitmap.height) {
          Object.assign(job, { blob: source, width: size.width, height: size.height, scale: size.scale, reduced: size.reduced });
          return { width: job.width, height: job.height };
        }
        if (!job.canvas || job.width !== size.width || job.height !== size.height) {
          const old = job.canvas;
          const canvas = new OffscreenCanvas(size.width, size.height);
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw new Error('无法创建长图，请缩短截图内容后重试。');
          context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
          if (old) {
            context.drawImage(old, 0, 0, old.width * size.scale / job.scale, old.height * size.scale / job.scale);
            old.width = 1; old.height = 1;
          } else if (job.blob) {
            const previous = await createImageBitmap(job.blob);
            try { context.drawImage(previous, 0, 0, job.width * size.scale / job.scale, job.height * size.scale / job.scale); }
            finally { previous.close(); }
          }
          job.blob = null;
          Object.assign(job, { canvas, width: size.width, height: size.height, scale: size.scale,
            reduced: job.reduced || size.reduced });
        }
        const p = placement(tile, job.scale);
        job.canvas.getContext('2d').drawImage(bitmap,
          tile.left * sx, tile.top * sy, tile.width * tile.screenScale * sx, tile.height * tile.screenScale * sy,
          p.x, p.y, p.width, p.height);
        return { width: job.width, height: job.height };
      } finally { bitmap.close(); }
    }
    if (action === 'encode') {
      if (!job.canvas && !job.blob) throw new Error('没有可复制的截图。');
      job.blob ||= await canvasBlob(job.canvas);
      if (job.canvas) { job.canvas.width = 1; job.canvas.height = 1; job.canvas = null; }
      return { blob: job.blob, width: job.width, height: job.height, reduced: job.reduced };
    }
    if (action === 'transfer') {
      job.png ||= await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('读取图片失败。'));
        reader.readAsDataURL(job.blob);
      });
      return { chunks: Math.ceil(job.png.length / CHUNK) };
    }
    if (action === 'chunk') return { data: job.png.slice(message.index * CHUNK, (message.index + 1) * CHUNK) };
    if (action === 'copy') {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': job.blob })]);
      return {};
    }
    throw new Error('未知图片操作。');
  }
}

function progressPanel() {
  document.head.insertAdjacentHTML('beforeend', `<style>
    :root{color-scheme:light dark;--bg:#fff;--ink:#24292f;--muted:#667085;--line:#e6e8eb;--accent:#168377;--error:#b42318;background:var(--bg)}
    *{box-sizing:border-box}body{margin:0;width:260px;background:var(--bg);color:var(--ink);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:1;transition:opacity 180ms ease-out}
    body.leaving{opacity:0}main{padding:12px}.row{display:flex;align-items:center;gap:8px;min-height:24px}
    h1{flex:1;margin:0;font-size:13px;line-height:24px;font-weight:500}#elapsed{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
    .track{height:3px;overflow:hidden;border-radius:2px;background:var(--line);margin-top:8px}#fill{height:100%;background:var(--accent);transform-origin:left;transform:scaleX(0);transition:transform 100ms ease-out}
    button{display:grid;place-items:center;flex:none;width:24px;height:24px;border:0;border-radius:4px;background:transparent;color:var(--muted);padding:0;cursor:pointer}
    button svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round}button:hover{background:var(--line)}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}button:disabled{opacity:.5;cursor:default}
    #detail{margin:8px 0 0;color:var(--muted);font-size:12px;overflow-wrap:anywhere}body[data-phase=done] h1{color:var(--accent)}body[data-phase=error] h1{color:var(--error)}body[data-phase=error] #fill{background:var(--error)}
    @media(prefers-color-scheme:dark){:root{--bg:#202124;--ink:#e8eaed;--muted:#aab0b6;--line:#3c4043;--accent:#71c9b0;--error:#ffb4a9}}
    @media(prefers-reduced-motion:reduce){body,#fill{transition:none!important}}
  </style>`);
  document.body.innerHTML = `<main>
    <div class="row"><h1 id="heading" role="status" aria-live="polite" aria-atomic="true">准备中…</h1><span id="elapsed"></span>
      <button id="control" type="button" aria-label="取消截图" title="取消截图"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6m0-6-6 6"/></svg></button>
    </div>
    <div class="track" role="progressbar" aria-label="截图流程" aria-valuemin="0" aria-valuemax="100"><div id="fill"></div></div>
    <p id="detail" role="alert" hidden></p>
  </main>`;
  const port = chrome.runtime.connect({ name: 'longshot-progress' });
  const heading = document.querySelector('#heading'), detail = document.querySelector('#detail');
  const track = document.querySelector('.track'), fill = document.querySelector('#fill');
  const elapsed = document.querySelector('#elapsed'), button = document.querySelector('#control');
  let current = { phase: 'preparing' }, closeTimer, fadeTimer, cancelPending = false;
  const terminal = () => ['done', 'error', 'cancelled'].includes(current.phase);
  function render(status) {
    current = status;
    clearTimeout(fadeTimer); clearTimeout(closeTimer);
    document.body.classList.remove('leaving');
    document.body.dataset.phase = status.phase;
    const titles = { preparing: '准备中…', capturing: '截图中…', copying: '复制中…', done: '已复制', cancelling: '取消中…', cancelled: '已取消', error: '截图未完成' };
    heading.textContent = titles[status.phase] || '处理中…';
    elapsed.textContent = status.phase === 'done' && Number.isFinite(status.elapsed) ? `${(status.elapsed / 1000).toFixed(2)} 秒` : '';
    detail.hidden = status.phase !== 'error';
    detail.textContent = status.phase === 'error' ? status.text || '请关闭后重试。' : '';
    // Three real stages: preparation, capture, clipboard write. Native capture
    // has no byte-level progress, so don't invent percentages or timed advances.
    let progress = { preparing: 0, capturing: 1 / 3, copying: 2 / 3, done: 1 }[status.phase] ?? 0;
    if (status.phase === 'capturing' && Number.isFinite(status.progress)) progress += Math.max(0, Math.min(100, status.progress)) / 300;
    track.setAttribute('aria-valuetext', heading.textContent);
    if (!['error', 'cancelled', 'cancelling'].includes(status.phase)) track.setAttribute('aria-valuenow', Math.round(progress * 100));
    else track.removeAttribute('aria-valuenow');
    fill.style.transform = `scaleX(${progress})`;
    const label = terminal() ? '关闭' : '取消截图';
    button.setAttribute('aria-label', label); button.title = label;
    button.disabled = status.phase === 'cancelling' || status.phase === 'done';
    button.style.visibility = status.phase === 'done' ? 'hidden' : 'visible';
    if (status.phase === 'done') {
      fadeTimer = setTimeout(() => document.body.classList.add('leaving'), 500);
      closeTimer = setTimeout(() => window.close(), 800);
    }
  }
  function cancel() {
    if (terminal()) { window.close(); return; }
    if (!current.id) { cancelPending = true; button.disabled = true; return; }
    port.postMessage({ action: 'cancel', id: current.id });
    render({ ...current, phase: 'cancelling' });
  }
  button.addEventListener('click', cancel);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
  });
  port.onMessage.addListener(status => {
    if (status.type === 'focus-check') {
      port.postMessage({ action: 'focus', requestId: status.requestId,
        focused: document.hasFocus() && document.visibilityState === 'visible' });
      return;
    }
    render(status);
    if (cancelPending && status.id && !terminal()) { cancelPending = false; cancel(); }
  });
  port.onDisconnect.addListener(() => {
    if (!terminal()) render({ phase: 'error', text: '与插件的连接已断开，请关闭后重试。' });
  });
  render(current);
  port.postMessage({ action: 'start' });
}

if (typeof document !== 'undefined' && new URLSearchParams(location.search).get('view') === 'progress') {
  progressPanel();
} else if (typeof document !== 'undefined') {
  const compositor = new Compositor();
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.channel !== 'longshot-offscreen' || sender.id !== chrome.runtime.id || sender.tab) return;
    compositor.handle(message).then(({ blob, ...data }) => reply({ ok: true, ...data }),
      error => reply({ ok: false, error: error.message }));
    return true;
  });
}
