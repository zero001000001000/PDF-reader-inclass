/**
 * SavePrompt — 退出/关闭时保存确认弹窗
 * @returns {Promise<'save'|'discard'|'cancel'>}
 */
const SavePrompt = (function() {
  'use strict';

  let overlay = null;
  let titleEl = null;
  let btnSave = null;
  let btnDiscard = null;
  let btnCancel = null;
  let resolveFn = null;

  function hide() {
    if (overlay) overlay.classList.add('hidden');
  }

  function finish(result) {
    hide();
    const fn = resolveFn;
    resolveFn = null;
    if (fn) fn(result);
  }

  function init() {
    overlay = document.getElementById('save-dialog');
    titleEl = document.getElementById('save-dialog-title');
    btnSave = document.getElementById('save-confirm');
    btnDiscard = document.getElementById('save-discard');
    btnCancel = document.getElementById('save-cancel');
    if (!overlay || !btnSave || !btnDiscard || !btnCancel) return;

    btnSave.addEventListener('click', () => finish('save'));
    btnDiscard.addEventListener('click', () => finish('discard'));
    btnCancel.addEventListener('click', () => finish('cancel'));
    overlay.addEventListener('click', e => {
      if (e.target === overlay) finish('cancel');
    });

    hide();
  }

  function show(opts) {
    if (!overlay) init();
    if (!overlay) return Promise.resolve('discard');

    if (titleEl && opts && opts.message) {
      titleEl.textContent = opts.message;
    }

    overlay.classList.remove('hidden');
    return new Promise(resolve => { resolveFn = resolve; });
  }

  return { init, show };
})();
