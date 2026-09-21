// ==========================================================================
// VISUAL MASTER CORE JAVASCRIPT ENGINE (MULTI-INSTANCE & ROBUST INTERACTION)
// ==========================================================================

// 1. Toast Notification Helper
function showToast(message, type = 'success', duration = 2000) {
  let toast = document.getElementById('mock-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'mock-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `visual-toast ${type} show`;
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

// 2. Tab Switching (Scoped Hierarchy, Nested Tabs & Multi-Group Sync)
function switchTab(tabId, activeBtn) {
  const targetId = tabId.startsWith('tab-') ? tabId : `tab-${tabId}`;
  const shortId = tabId.replace(/^tab-/, '');

  // 1. Locate target pane by ID or data-tab-pane
  const targetPane =
    document.getElementById(targetId) ||
    document.getElementById(shortId) ||
    document.querySelector(`[data-tab-pane="${shortId}"], [data-tab-pane="${targetId}"]`);

  if (!targetPane) return;

  // 2. Determine pane scope (support nested tabs without colliding with top-level container)
  const parentScope = targetPane.parentElement;
  let scopedPanes = [];
  if (parentScope) {
    scopedPanes = Array.from(parentScope.children).filter(child =>
      child.classList.contains('tab-pane') ||
      child.hasAttribute('data-tab-pane') ||
      child.id.startsWith('tab-')
    );
  }

  // Fallback if no parent scope or no scoped panes: check direct children of .container
  if (!parentScope || scopedPanes.length === 0) {
    scopedPanes = Array.from(
      document.querySelectorAll(
        '.container > [id^="tab-"], .container > [data-tab-pane], .container > .tab-pane'
      )
    );
  }

  let activePane = null;
  scopedPanes.forEach(pane => {
    const paneDataTab = pane.dataset.tabPane || pane.getAttribute('data-tab-pane') || '';
    const isMatch =
      (pane === targetPane) ||
      pane.id === targetId ||
      pane.id === shortId ||
      paneDataTab === shortId ||
      paneDataTab === targetId;
    pane.style.display = isMatch ? '' : 'none';
    pane.classList.toggle('active', isMatch);
    if (isMatch) activePane = pane;
  });

  // 3. Toggle buttons within the same tab-group scope (prevent deselecting parent tabs)
  let btnGroup = activeBtn
    ? (activeBtn.closest('.tab-group, [role="tablist"]') || activeBtn.parentElement)
    : null;

  if (!btnGroup && targetPane) {
    // If activeBtn not passed, find button pointing to this tabId (supports single & double quotes)
    const candidateBtn = document.querySelector(
      `button[onclick*="'${tabId}'"], button[onclick*='"${tabId}"'], button[onclick*="'${targetId}'"], button[onclick*='"${targetId}"'], button[onclick*="'${shortId}'"], button[onclick*='"${shortId}"'], [data-tab="${shortId}"], [data-tab="${targetId}"]`
    );
    if (candidateBtn) {
      btnGroup = candidateBtn.closest('.tab-group, [role="tablist"]') || candidateBtn.parentElement;
      activeBtn = candidateBtn;
    }
  }

  if (btnGroup) {
    btnGroup.querySelectorAll('.tab-btn, button[role="tab"]').forEach(btn => {
      const onclickAttr = btn.getAttribute('onclick') || '';
      const tabData = btn.dataset.tab || '';
      const isBtnMatch =
        btn === activeBtn ||
        tabData === shortId ||
        tabData === targetId ||
        onclickAttr.includes(`'${tabId}'`) ||
        onclickAttr.includes(`"${tabId}"`) ||
        onclickAttr.includes(`'${targetId}'`) ||
        onclickAttr.includes(`"${targetId}"`) ||
        onclickAttr.includes(`'${shortId}'`) ||
        onclickAttr.includes(`"${shortId}"`);
      btn.classList.toggle('active', !!isBtnMatch);
      if (btn.getAttribute('role') === 'tab') {
        btn.setAttribute('aria-selected', isBtnMatch ? 'true' : 'false');
      }
    });
  } else {
    // Global fallback if no group exists
    const buttons = document.querySelectorAll('.tab-group .tab-btn, .tab-btn');
    buttons.forEach(btn => {
      const onclickAttr = btn.getAttribute('onclick') || '';
      const tabData = btn.dataset.tab || '';
      const isBtnMatch =
        btn === activeBtn ||
        tabData === shortId ||
        tabData === targetId ||
        onclickAttr.includes(`'${tabId}'`) ||
        onclickAttr.includes(`"${tabId}"`) ||
        onclickAttr.includes(`'${targetId}'`) ||
        onclickAttr.includes(`"${targetId}"`) ||
        onclickAttr.includes(`'${shortId}'`) ||
        onclickAttr.includes(`"${shortId}"`);
      btn.classList.toggle('active', !!isBtnMatch);
      if (btn.getAttribute('role') === 'tab') {
        btn.setAttribute('aria-selected', isBtnMatch ? 'true' : 'false');
      }
    });
  }

  // 4. Update Inspector Toggle visibility based on visible active pane content
  const inspectorBtn = document.getElementById('inspector-toggle');
  if (inspectorBtn) {
    const topActivePane =
      document.querySelector(
        '.container > .tab-pane.active, .container > [id^="tab-"]:not([style*="display: none"])'
      ) || activePane;
    const diffSelector =
      '.slider-viewport, .diff-tag, .diff-highlight, .mock-annotation, [data-diff="annotation"]';
    const hasDiff =
      topActivePane &&
      ((topActivePane.matches && topActivePane.matches(diffSelector)) ||
        Boolean(topActivePane.querySelector(diffSelector)));
    inspectorBtn.style.display = hasDiff ? 'flex' : 'none';
  }
}

// 3. Comparison Slider Engine (Pointer Events, RAF Throttling, ARIA & Touch Support)
function updateSliderPosition(viewport, percentage) {
  const clamped = Math.max(0, Math.min(100, percentage));
  const rounded = Math.round(clamped);
  viewport.style.setProperty('--slider-pos', `${clamped}%`);

  const rangeInput = viewport.querySelector('.slider-input-range');
  if (rangeInput && rangeInput.value != rounded) {
    rangeInput.value = rounded;
  }

  const ariaTarget = viewport.querySelector('.slider-knob') || viewport.querySelector('.slider-divider');
  if (ariaTarget) {
    ariaTarget.setAttribute('aria-valuenow', rounded);
  }
}

function initSliderInstance(viewport) {
  if (viewport._sliderInitialized) return;
  viewport._sliderInitialized = true;

  const divider = viewport.querySelector('.slider-divider');
  const knob = viewport.querySelector('.slider-knob');
  const rangeInput = viewport.querySelector('.slider-input-range');

  let cachedRect = null;
  function moveSliderFromClientX(clientX) {
    const rect = cachedRect || viewport.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const offsetX = clientX - rect.left;
    const pct = (offsetX / rect.width) * 100;
    updateSliderPosition(viewport, pct);
  }

  let isDragging = false;
  let rafId = null;
  let latestClientX = null;

  function onPointerDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    // Don't hijack clicks on interactive elements inside mockups
    if (e.target && e.target.closest('button, a, input, textarea, select, [role="button"]')) {
      return;
    }
    isDragging = true;
    try {
      viewport.setPointerCapture(e.pointerId);
    } catch (_) {}
    cachedRect = viewport.getBoundingClientRect();
    latestClientX = e.clientX;
    moveSliderFromClientX(latestClientX);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!isDragging) return;
    latestClientX = e.clientX;
    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        if (isDragging && latestClientX !== null) {
          moveSliderFromClientX(latestClientX);
        }
        rafId = null;
      });
    }
  }

  function onPointerUp(e) {
    if (!isDragging) return;
    isDragging = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (e.type !== 'pointercancel') {
      if (typeof e.clientX === 'number') {
        moveSliderFromClientX(e.clientX);
      } else if (latestClientX !== null) {
        moveSliderFromClientX(latestClientX);
      }
    }
    try {
      viewport.releasePointerCapture(e.pointerId);
    } catch (_) {}
    cachedRect = null;
    latestClientX = null;
  }

  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', onPointerUp);
  viewport.addEventListener('pointercancel', onPointerUp);
  viewport.addEventListener('lostpointercapture', () => {
    isDragging = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    cachedRect = null;
    latestClientX = null;
  });

  if (rangeInput) {
    rangeInput.setAttribute('tabindex', '-1');
    rangeInput.setAttribute('aria-hidden', 'true');
    rangeInput.addEventListener('input', (e) => {
      updateSliderPosition(viewport, parseFloat(e.target.value) || 50);
    });
  }

  // Keyboard navigation on knob or divider for accessibility
  const keyboardTarget = knob || divider;
  if (keyboardTarget) {
    if (!keyboardTarget.hasAttribute('tabindex')) keyboardTarget.setAttribute('tabindex', '0');
    if (!keyboardTarget.hasAttribute('role')) keyboardTarget.setAttribute('role', 'slider');
    keyboardTarget.setAttribute('aria-label', 'Code comparison slider');
    keyboardTarget.setAttribute('aria-orientation', 'horizontal');
    keyboardTarget.setAttribute('aria-valuemin', '0');
    keyboardTarget.setAttribute('aria-valuemax', '100');

    // Read initial position from rangeInput or CSS variable
    const initialPos = rangeInput
      ? parseFloat(rangeInput.value)
      : parseFloat(getComputedStyle(viewport).getPropertyValue('--slider-pos')) || 50;
    keyboardTarget.setAttribute('aria-valuenow', Math.round(initialPos).toString());

    keyboardTarget.addEventListener('keydown', (e) => {
      const currentPos = parseFloat(keyboardTarget.getAttribute('aria-valuenow') || '50');

      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        updateSliderPosition(viewport, currentPos - 5);
        e.preventDefault();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        updateSliderPosition(viewport, currentPos + 5);
        e.preventDefault();
      } else if (e.key === 'PageDown') {
        updateSliderPosition(viewport, currentPos - 10);
        e.preventDefault();
      } else if (e.key === 'PageUp') {
        updateSliderPosition(viewport, currentPos + 10);
        e.preventDefault();
      } else if (e.key === 'Home') {
        updateSliderPosition(viewport, 0);
        e.preventDefault();
      } else if (e.key === 'End') {
        updateSliderPosition(viewport, 100);
        e.preventDefault();
      }
    });
  }
}

function initAllSliders() {
  document.querySelectorAll('.slider-viewport').forEach(initSliderInstance);
}

// 4. Inspector Diff Toggle (CSS Class Toggle & Lifecycle Sync)
function toggleDiff() {
  const isDiffOff = document.body.classList.toggle('diff-off');
  const tag = document.getElementById('diffStatusTag');
  const inspectorBtn = document.getElementById('inspector-toggle');
  if (inspectorBtn) {
    inspectorBtn.setAttribute('aria-pressed', (!isDiffOff).toString());
  }

  if (!isDiffOff) {
    if (tag) tag.textContent = '[BẬT]';
    showToast('Chế độ xem Diff: BẬT', 'success');
  } else {
    if (tag) tag.textContent = '[TẮT]';
    showToast('Chế độ xem Diff: TẮT (Ẩn highlight đỏ/xanh)', 'info');
  }
}

function initInspectorToggle() {
  const inspectorBtn = document.getElementById('inspector-toggle');
  if (!inspectorBtn) return;
  const isDiffOff = document.body.classList.contains('diff-off');
  inspectorBtn.setAttribute('aria-pressed', (!isDiffOff).toString());

  const tag = document.getElementById('diffStatusTag');
  if (tag) tag.textContent = isDiffOff ? '[TẮT]' : '[BẬT]';

  const panes = document.querySelectorAll(
    '.container > [id^="tab-"], .container > [data-tab-pane], .container > .tab-pane'
  );
  let activePane = null;
  for (const pane of panes) {
    if (pane.style.display !== 'none' && getComputedStyle(pane).display !== 'none') {
      activePane = pane;
      break;
    }
  }
  if (!activePane) activePane = document.body;

  const diffSelector =
    '.slider-viewport, .diff-tag, .diff-highlight, .mock-annotation, [data-diff="annotation"]';
  const hasDiff =
    activePane &&
    activePane !== document.body &&
    ((activePane.matches && activePane.matches(diffSelector)) ||
      Boolean(activePane.querySelector(diffSelector)));
  inspectorBtn.style.display = hasDiff ? 'flex' : 'none';
}

// 5. Clipboard Helper with Fallback
function execCommandFallback(text) {
  return new Promise((resolve, reject) => {
    let textarea = null;
    try {
      textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      textarea.style.left = '-9999px';
      textarea.style.opacity = '0';
      textarea.setAttribute('readonly', '');
      textarea.setAttribute('aria-hidden', 'true');
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const success = document.execCommand('copy');
      if (success) {
        resolve();
      } else {
        reject(new Error('execCommand copy failed'));
      }
    } catch (err) {
      reject(err);
    } finally {
      if (textarea && textarea.parentNode) {
        textarea.parentNode.removeChild(textarea);
      }
    }
  });
}

function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(() => execCommandFallback(text));
  }
  return execCommandFallback(text);
}

// 6. Copy Code Block (With Race Condition Guard, Clean Extraction & Fallback)
function copyCodeBlock(btn) {
  if (!btn || btn.dataset.copying === 'true') return;

  const container = btn.closest('.code-container');
  if (!container) return;
  const codeBody = container.querySelector('.code-body');
  if (!codeBody) return;

  const lines = codeBody.querySelectorAll('.c-line');
  let fullText = '';
  if (lines.length > 0) {
    const getLineText = (line) => {
      const textSpan = line.querySelector('.c-text');
      if (textSpan) return textSpan.textContent.replace(/\r?\n$/, '');
      const clone = line.cloneNode(true);
      clone.querySelectorAll('.c-sign, .c-comment').forEach(el => el.remove());
      return clone.textContent.replace(/\r?\n$/, '');
    };

    const keptLines = Array.from(lines).filter(l => !l.classList.contains('del'));
    const targetLines = keptLines.length > 0 ? keptLines : Array.from(lines);
    fullText = targetLines.map(getLineText).join('\n');
  } else {
    fullText = codeBody.innerText || codeBody.textContent || '';
  }

  btn.dataset.copying = 'true';
  const originalHTML = btn.innerHTML;

  copyToClipboard(fullText)
    .then(() => {
      btn.innerHTML = '<span>✅ Đã chép!</span>';
      btn.style.color = '#4ade80';
      btn.style.borderColor = '#22c55e';
      setTimeout(() => {
        btn.innerHTML = originalHTML;
        btn.style.color = '';
        btn.style.borderColor = '';
        delete btn.dataset.copying;
      }, 1500);
    })
    .catch(err => {
      console.error('Không thể copy code:', err);
      showToast('❌ Không thể copy nội dung', 'error');
      delete btn.dataset.copying;
    });
}

// 7. Mini Dropdown Toggle & Accessibility
function toggleFileDropdown(btn) {
  const wrapper = btn.closest('.file-dropdown-wrapper');
  if (!wrapper) return;
  const isOpen = wrapper.classList.contains('open');

  closeAllDropdowns();

  if (!isOpen) {
    wrapper.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-haspopup', 'menu');
    const menu = wrapper.querySelector('.file-dropdown-menu');
    if (menu) {
      const firstItem = menu.querySelector('button, a');
      if (firstItem) firstItem.focus();
    }
  } else {
    btn.setAttribute('aria-expanded', 'false');
  }
}

function closeAllDropdowns() {
  document.querySelectorAll('.file-dropdown-wrapper.open').forEach(w => {
    w.classList.remove('open');
    const trigger = w.querySelector('.file-dropdown-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
}

function copyFilePath(path) {
  copyToClipboard(path)
    .then(() => {
      showToast(`✅ Đã chép đường dẫn: ${path}`, 'success');
      closeAllDropdowns();
    })
    .catch(err => {
      console.error('Lỗi sao chép đường dẫn:', err);
      showToast(`❌ Không thể chép đường dẫn`, 'error');
    });
}

// Global Event Listeners
document.addEventListener('click', (e) => {
  const item = e.target.closest('.file-dropdown-item');
  if (item) {
    closeAllDropdowns();
    return;
  }
  if (!e.target.closest('.file-dropdown-wrapper')) {
    closeAllDropdowns();
  }
});

// Require e.relatedTarget to avoid canceling button clicks in Safari / WebKit
document.addEventListener('focusout', (e) => {
  const openWrapper = document.querySelector('.file-dropdown-wrapper.open');
  if (openWrapper && e.relatedTarget && !openWrapper.contains(e.relatedTarget)) {
    closeAllDropdowns();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const activeDropdown = document.querySelector('.file-dropdown-wrapper.open');
    closeAllDropdowns();
    if (activeDropdown) {
      const trigger = activeDropdown.querySelector('.file-dropdown-trigger');
      if (trigger) trigger.focus();
    }
  }
});

// Complete Visual Core Initialization Lifecycle
function initVisualCore() {
  initAllSliders();
  initInspectorToggle();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVisualCore);
} else {
  initVisualCore();
}
