/* Мост между веб-интерфейсом и Android-обёрткой.
   Добавляет маленькую кнопку ⚙ (настройки сервера) и долгое нажатие на шапку. */
(function () {
  if (window.__arenaNativeBridge) return;
  if (typeof ArenaAndroid === 'undefined') return;
  window.__arenaNativeBridge = true;

  function openSettings() {
    try {
      ArenaAndroid.openSettings();
    } catch (e) {
      /* нет моста — ничего не делаем */
    }
  }

  function mountSettingsButton() {
    if (!document.body || document.getElementById('arena-native-settings')) return;

    var button = document.createElement('button');
    button.id = 'arena-native-settings';
    button.type = 'button';
    button.title = 'Настройки сервера';
    button.setAttribute('aria-label', 'Настройки сервера');
    button.textContent = '⚙';

    button.style.cssText = [
      'position:fixed',
      'right:14px',
      'top:64px',
      'z-index:2147483000',
      'width:32px',
      'height:32px',
      'padding:0',
      'border-radius:50%',
      'border:1px solid rgba(255,255,255,0.18)',
      'background:rgba(17,25,23,0.85)',
      'color:#8BA39C',
      'font-size:16px',
      'line-height:30px',
      'text-align:center',
      'font-family:system-ui,sans-serif',
      'opacity:0.8',
      '-webkit-backdrop-filter:blur(8px)',
      'backdrop-filter:blur(8px)'
    ].join(';');

    button.addEventListener('click', openSettings);
    document.body.appendChild(button);
  }

  function bindLongPress() {
    var brand = document.querySelector('.topbar .brand');
    if (!brand || brand.getAttribute('data-native-bound') === '1') return;
    brand.setAttribute('data-native-bound', '1');

    var timer = null;

    function cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    brand.addEventListener('touchstart', function () {
      cancel();
      timer = setTimeout(function () {
        timer = null;
        openSettings();
      }, 650);
    }, { passive: true });
    brand.addEventListener('touchend', cancel);
    brand.addEventListener('touchmove', cancel, { passive: true });
    brand.addEventListener('touchcancel', cancel);
    brand.addEventListener('dblclick', openSettings);
  }

  function boot() {
    mountSettingsButton();
    bindLongPress();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
