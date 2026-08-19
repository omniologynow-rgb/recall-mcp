// Recall product site — shared behavior. External file (CSP: script-src 'self').
(function () {
  'use strict';

  // 1. Fill every .js-origin with the real origin, so guides stay correct
  //    even if the service moves to a custom domain. Static fallback text is
  //    already present for no-JS readers.
  var origin = window.location.origin;
  document.querySelectorAll('.js-origin').forEach(function (el) {
    el.textContent = origin;
  });

  // 2. Copy buttons: <button class="copy" data-copy-target="#id">
  document.querySelectorAll('[data-copy-target]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = document.querySelector(btn.getAttribute('data-copy-target'));
      if (!target) return;
      var text = target.innerText;
      navigator.clipboard.writeText(text).then(function () {
        var old = btn.textContent;
        btn.textContent = 'Copied ✓';
        setTimeout(function () { btn.textContent = old; }, 1600);
      });
    });
  });

  // 3. Signup form (only present on /signup)
  var form = document.getElementById('signup-form');
  if (form) {
    var errorEl = document.getElementById('signup-error');
    var reveal = document.getElementById('key-reveal');
    var keyBox = document.getElementById('key-box');
    var submitBtn = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      errorEl.textContent = '';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating…';

      var email = document.getElementById('signup-email').value;
      fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email }),
      })
        .then(function (res) {
          return res.json().then(function (body) { return { status: res.status, body: body }; });
        })
        .then(function (r) {
          if (r.status === 200 && r.body.api_key) {
            keyBox.textContent = r.body.api_key;
            reveal.classList.add('visible');
            form.style.display = 'none';
          } else {
            errorEl.textContent = r.body.error || 'Something went wrong. Please try again.';
            if (r.body.hint) errorEl.textContent += ' — ' + r.body.hint;
            submitBtn.disabled = false;
            submitBtn.textContent = 'Get my key';
          }
        })
        .catch(function () {
          errorEl.textContent = 'Network error. Please try again.';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Get my key';
        });
    });
  }
})();
