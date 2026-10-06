/* SPDX-License-Identifier: MPL-2.0 */
// Same phone contract as the product's PhoneSlides: native slide previews,
// previous/next navigation and AI editing; direct editing stays on desktop.
export function installLocalPhoneView({ call, isReady, generation, reportError }) {
  const region = document.getElementById('phone-preview');
  const image = document.getElementById('phone-slide');
  const count = document.getElementById('phone-count');
  const previous = document.getElementById('phone-previous');
  const next = document.getElementById('phone-next');
  const media = matchMedia('(max-width: 700px)');
  let index = 0, total = 0, busy = false, again = false, timer;
  const sizePanel = () => document.body.style.setProperty('--local-preview-height', region.getBoundingClientRect().height + 'px');
  new ResizeObserver(sizePanel).observe(region);
  async function render() {
    if (!media.matches || !isReady()) return;
    if (busy) { again = true; return; }
    busy = true;
    const owner = generation();
    try {
      const state = await call({ operation: 'observe', captureSlideIndexes: [] });
      if (owner !== generation()) return;
      total = state.slides.length;
      index = Math.max(0, Math.min(index, total - 1));
      if (!total) throw Error('슬라이드 미리보기를 표시할 수 없습니다');
      const captured = await call({ operation: 'observe', captureSlideIndexes: [index] });
      if (owner !== generation() || !media.matches) return;
      const slide = captured.images.find(value => value.slideIndex === index);
      if (!slide?.pngBase64) throw Error('슬라이드 미리보기를 표시할 수 없습니다');
      image.src = 'data:image/png;base64,' + slide.pngBase64;
      image.alt = `${index + 1}번 슬라이드 미리보기`;
      image.parentElement.style.aspectRatio = state.width / state.height;
      count.textContent = `${index + 1} / ${total}`;
      previous.disabled = index === 0;
      next.disabled = index >= total - 1;
      region.hidden = false;
      sizePanel();
    } catch (error) {
      if (owner === generation()) reportError(error);
    } finally {
      busy = false;
      if (again) { again = false; refresh(); }
    }
  }
  function refresh() { clearTimeout(timer); timer = setTimeout(render, 120); }
  function sync() {
    const phone = media.matches && isReady();
    const entering = phone && !document.body.classList.contains('is-phone');
    document.body.classList.toggle('is-phone', phone);
    document.querySelector('.local-editor').inert = phone;
    region.hidden = !phone;
    if (phone) {
      if (entering) document.getElementById('ai').open = true;
      refresh();
    } else sizePanel();
  }
  async function go(value) {
    if (value < 0 || value >= total || busy) return;
    try {
      // Keep the AI's current-slide permission aligned with the visible page.
      await call({ operation: 'reveal', slideIndex: value });
      index = value;
      await render();
    } catch (error) { reportError(error); }
  }
  previous.onclick = () => go(index - 1);
  next.onclick = () => go(index + 1);
  let start;
  region.addEventListener('touchstart', event => { start = event.touches[0]?.clientX; }, { passive: true });
  region.addEventListener('touchend', event => {
    const end = event.changedTouches[0]?.clientX;
    if (start != null && end != null && Math.abs(end - start) >= 40) void go(index + (end < start ? 1 : -1));
    start = undefined;
  });
  media.addEventListener('change', sync);
  window.addEventListener('spellbook-local-document-changing', () => {
    index = 0; total = 0; image.removeAttribute('src'); region.hidden = true;
    document.body.classList.remove('is-phone');
    document.querySelector('.local-editor').inert = false;
  });
  return { refresh, opened: () => { index = 0; sync(); } };
}
