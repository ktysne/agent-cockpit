const PENDING_SEARCH_TERM_KEY = 'manualPendingSearchTerm';
const THEME_STORAGE_KEY = 'agent-cockpit.theme';

function normalizeSearchText(value) {
  return String(value).replace(/[！-～]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .toLowerCase();
}

function resolveManualHelpAnchor(helpAnchors, hash, baseURI, currentHref) {
  if (typeof hash !== 'string' || !hash.startsWith('#help-')) return null;
  let key;
  try {
    key = decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
  const target = helpAnchors?.[key];
  if (!target || typeof target.output !== 'string' || typeof target.fragment !== 'string') return null;
  const destination = new URL(`${target.output}#${target.fragment}`, baseURI);
  return destination.href === currentHref ? null : destination.href;
}

function resolveManualTheme(value) {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

function normalizeSearchTerm(value) {
  return normalizeSearchText(value).trim();
}

function createSearchSnippet(text, term) {
  if (!text) return '';
  const normalizedText = normalizeSearchText(text);
  const matchAt = normalizedText.indexOf(term);
  let start = matchAt < 0 ? 0 : matchAt;
  let end = matchAt < 0 ? text.length : matchAt + term.length;
  while (start > 0 && !/[。！？!?]/.test(text[start - 1])) start -= 1;
  while (end < text.length && !/[。！？!?]/.test(text[end])) end += 1;
  if (end < text.length) end += 1;
  let snippet = text.slice(start, end).trim();
  if (snippet.length > 180) {
    const center = matchAt < 0 ? 0 : matchAt - start;
    const snippetStart = Math.max(0, Math.min(snippet.length - 180, center - 80));
    snippet = `${snippetStart > 0 ? '…' : ''}${snippet.slice(snippetStart, snippetStart + 180)}${snippetStart + 180 < snippet.length ? '…' : ''}`;
  }
  return snippet;
}

function searchManualIndex(index, query) {
  const normalizedQuery = normalizeSearchTerm(query);
  if (!normalizedQuery || !Array.isArray(index)) return [];
  const terms = normalizedQuery.split(/\s+/);
  return index.filter(entry => {
    const fields = [entry.pageTitle, entry.sectionTitle, entry.text]
      .map(value => normalizeSearchText(value ?? ''));
    return terms.every(term => fields.some(value => value.includes(term)));
  }).map(entry => ({ ...entry, snippet: createSearchSnippet(entry.text, terms[0]) }));
}

function isHeadingElement(element) {
  return /^H[1-6]$/.test(element.tagName);
}

function isSectionHeadingElement(element) {
  return /^H[1-3]$/.test(element.tagName);
}

function findManualSearchTarget(heading, rawTerm) {
  const term = normalizeSearchTerm(rawTerm).split(/\s+/)[0];
  if (!term || !heading || !isHeadingElement(heading)) return null;
  const includesTerm = element => normalizeSearchText(element.textContent ?? '').includes(term);

  const descend = (element, hidingDetails) => {
    const child = [...element.children].find(includesTerm);
    if (!child) return { target: element, detailsToOpen: hidingDetails };
    const hides = element.tagName === 'DETAILS' && !element.open && child.tagName !== 'SUMMARY';
    return descend(child, hides ? [...hidingDetails, element] : hidingDetails);
  };

  for (let sibling = heading.nextElementSibling; sibling && !isSectionHeadingElement(sibling); sibling = sibling.nextElementSibling) {
    if (includesTerm(sibling)) return descend(sibling, []);
  }
  return null;
}

function savePendingSearchTerm(term) {
  try {
    sessionStorage.setItem(PENDING_SEARCH_TERM_KEY, term);
  } catch {}
}

function takePendingSearchTerm() {
  try {
    const term = sessionStorage.getItem(PENDING_SEARCH_TERM_KEY);
    sessionStorage.removeItem(PENDING_SEARCH_TERM_KEY);
    return term;
  } catch {
    return null;
  }
}

function revealPendingSearchTerm() {
  const term = takePendingSearchTerm();
  if (!term || !location.hash) return;
  let id;
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch {
    return;
  }
  const found = findManualSearchTarget(document.getElementById(id), term);
  if (!found) return;
  for (const details of found.detailsToOpen) details.open = true;
  found.target.scrollIntoView({ block: 'center' });
}

function setupSearchReveal() {
  window.addEventListener('hashchange', revealPendingSearchTerm);
  if (document.readyState === 'complete') revealPendingSearchTerm();
  else window.addEventListener('load', revealPendingSearchTerm, { once: true });
}

function resolveManualSearchHref(href, siteRoot, baseURI) {
  return new URL(href, new URL(siteRoot || '.', baseURI)).href;
}

function setupManualSearch() {
  const form = document.querySelector('.manual-search');
  if (!form) return;
  const input = form.querySelector('input');
  const results = form.querySelector('[role="listbox"]');
  const status = form.querySelector('[role="status"]');
  const siteRoot = form.dataset.siteRoot ?? '';
  let activeIndex = -1;

  const closeResults = clearStatus => {
    results.replaceChildren();
    results.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
    if (clearStatus) status.textContent = '';
  };

  const updateActiveOption = () => {
    const options = [...results.querySelectorAll('[role="option"]')];
    options.forEach((option, index) => option.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false'));
    if (activeIndex >= 0 && options[activeIndex]) {
      input.setAttribute('aria-activedescendant', options[activeIndex].id);
      options[activeIndex].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const renderResults = () => {
    const query = input.value.trim();
    if (!query) {
      closeResults(true);
      return;
    }
    const indexUnavailable = !Array.isArray(window.manualSearchIndex);
    const matches = indexUnavailable ? [] : searchManualIndex(window.manualSearchIndex, query);
    results.replaceChildren();
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant');
    input.setAttribute('aria-expanded', 'true');
    results.hidden = false;
    const emptyMessage = indexUnavailable
      ? '検索索引を読み込めませんでした。ページを再読み込みしてください。'
      : `「${query}」に一致する項目はありません。別の語で探してください。`;
    status.textContent = matches.length === 0 ? emptyMessage : `${matches.length} 件の検索結果があります。`;
    if (matches.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'manual-search-empty';
      empty.setAttribute('role', 'presentation');
      empty.textContent = emptyMessage;
      results.append(empty);
      return;
    }
    matches.forEach((match, index) => {
      const item = document.createElement('li');
      item.setAttribute('role', 'presentation');
      const link = document.createElement('a');
      link.id = `manual-search-option-${index}`;
      link.className = 'manual-search-option';
      link.href = resolveManualSearchHref(match.href, siteRoot, document.baseURI);
      link.tabIndex = -1;
      link.setAttribute('role', 'option');
      link.setAttribute('aria-selected', 'false');
      link.addEventListener('click', event => {
        const destination = new URL(link.href);
        const current = new URL(location.href);
        const samePage = destination.origin === current.origin
          && destination.pathname === current.pathname
          && destination.search === current.search;
        const opensElsewhere = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0;
        if (!opensElsewhere) {
          savePendingSearchTerm(input.value);
          if (samePage && destination.hash === location.hash) setTimeout(revealPendingSearchTerm, 0);
        }
        if (samePage) setTimeout(() => closeResults(true), 0);
      });
      const heading = document.createElement('strong');
      heading.textContent = `${match.pageTitle} › ${match.sectionTitle}`;
      const snippet = document.createElement('span');
      snippet.textContent = match.snippet;
      link.append(heading, snippet);
      item.append(link);
      results.append(item);
    });
  };

  input.addEventListener('input', renderResults);
  input.addEventListener('search', renderResults);
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    const options = [...results.querySelectorAll('[role="option"]')];
    if (event.key === 'ArrowDown' && options.length > 0) {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % options.length;
      updateActiveOption();
    } else if (event.key === 'ArrowUp' && options.length > 0) {
      event.preventDefault();
      activeIndex = activeIndex < 0 ? options.length - 1 : (activeIndex + options.length - 1) % options.length;
      updateActiveOption();
    } else if (event.key === 'Enter' && options.length > 0) {
      event.preventDefault();
      options[activeIndex < 0 ? 0 : activeIndex].click();
    } else if (event.key === 'Escape' && !results.hidden) {
      event.preventDefault();
      closeResults(true);
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    results.querySelector('[role="option"]')?.click();
  });
  document.addEventListener('click', event => {
    if (!form.contains(event.target)) closeResults(true);
  });
  if (input.value.trim()) renderResults();
}

function setupGuideMaps() {
  for (const map of document.querySelectorAll('[data-guide-map]')) {
    const setActive = number => {
      for (const element of map.querySelectorAll('[data-gm]')) {
        element.classList.toggle('is-active', element.dataset.gm === number);
      }
    };
    for (const element of map.querySelectorAll('.gm-badge, .gm-list > li')) {
      element.addEventListener('pointerenter', () => setActive(element.dataset.gm));
      element.addEventListener('pointerleave', () => setActive(null));
      element.addEventListener('focusin', () => setActive(element.dataset.gm));
      element.addEventListener('focusout', () => setActive(null));
    }
  }
}

const ZOOM_SIDE_MARGIN = 32;
const ZOOM_MIN_GAIN = 1.15;

function resolveManualZoom(zoomWidth, viewportWidth, displayWidth) {
  const width = Math.min(zoomWidth, Math.max(viewportWidth - ZOOM_SIDE_MARGIN, 600));
  return { width, canZoom: Number.isFinite(width) && width > displayWidth * ZOOM_MIN_GAIN };
}

function openManualZoom(area, width, opener) {
  const dialog = document.createElement('dialog');
  dialog.className = 'zoom-dialog';
  dialog.setAttribute('aria-label', '画像の拡大表示');
  const bar = document.createElement('div');
  bar.className = 'zoom-bar';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'zoom-close';
  closeButton.textContent = '閉じる';
  bar.append(closeButton);
  const scroll = document.createElement('div');
  scroll.className = 'zoom-scroll';
  const copy = area.cloneNode(true);
  copy.querySelector('.zoom-open')?.remove();
  copy.classList.remove('is-zoomable');
  copy.removeAttribute('data-zoom-width');
  for (const element of [copy, ...copy.querySelectorAll('[id]')]) element.removeAttribute('id');
  copy.style.setProperty('width', `${width}px`);
  copy.style.setProperty('max-width', 'none');
  copy.style.setProperty('min-width', '0');
  scroll.append(copy);
  dialog.append(bar, scroll);
  dialog.style.width = `min(${width + 2 * ZOOM_SIDE_MARGIN}px, calc(100vw - 16px))`;

  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  let targetHash = null;
  copy.addEventListener('click', event => {
    const badge = event.target.closest?.('.gm-badge');
    if (!badge) return;
    event.preventDefault();
    targetHash = badge.getAttribute('href');
    dialog.close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    opener.focus({ preventScroll: Boolean(targetHash) });
    if (targetHash) location.hash = targetHash;
  });
  document.body.append(dialog);
  dialog.showModal();
  closeButton.focus();
}

function setupManualZoom() {
  if (typeof HTMLDialogElement === 'undefined') return;
  for (const area of document.querySelectorAll('[data-zoom-width]')) {
    const zoomWidth = Number(area.dataset.zoomWidth);
    if (!Number.isFinite(zoomWidth) || zoomWidth <= 0) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'zoom-open';
    button.textContent = '拡大';
    button.setAttribute('aria-label', `${area.querySelector('img')?.alt || '画像'}を拡大`);
    area.append(button);
    let zoomWidthNow = 0;
    const update = () => {
      const result = resolveManualZoom(zoomWidth, window.innerWidth, area.getBoundingClientRect().width);
      zoomWidthNow = result.width;
      button.hidden = !result.canZoom;
      area.classList.toggle('is-zoomable', result.canZoom);
    };
    area.addEventListener('click', event => {
      if (!area.classList.contains('is-zoomable') || event.target.closest?.('.gm-badge')) return;
      openManualZoom(area, zoomWidthNow, button);
    });
    update();
    window.addEventListener('resize', update);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(update).observe(area);
  }
}

function setupManualTheme() {
  let savedTheme = null;
  try {
    savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {}
  document.documentElement.dataset.theme = resolveManualTheme(savedTheme);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    findManualSearchTarget,
    normalizeSearchText,
    resolveManualHelpAnchor,
    resolveManualSearchHref,
    resolveManualTheme,
    resolveManualZoom,
    searchManualIndex,
  };
}

if (typeof window !== 'undefined' && typeof location !== 'undefined') {
  setupManualTheme();
  const destination = resolveManualHelpAnchor(window.manualHelpAnchors, location.hash, document.baseURI, location.href);
  if (destination) location.replace(destination);
  else setupSearchReveal();
  setupManualSearch();
  setupGuideMaps();
  setupManualZoom();
}
