(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    app: document.querySelector('.app'),
    output: $('output'),
    form: $('form'),
    input: $('input'),
    sendBtn: $('sendBtn'),
    sendIcon: $('sendIcon'),
    promptLabel: $('promptLabel'),
    helpBtn: $('helpBtn'),
    statusDot: $('statusDot'),
    hostLabel: $('hostLabel'),
    suggestions: $('suggestions'),
    jumpBtn: $('jumpBtn'),
    keys: $('keys'),
    sheet: $('sheet'),
    sheetClose: $('sheetClose'),
    search: $('searchInput'),
    categories: $('categories'),
    commandList: $('commandList'),
  };

  const STORAGE = {
    session: 'arena.terminal.session',
    history: 'arena.terminal.history',
  };

  const state = {
    sessionId: readSessionId(),
    history: readHistory(),
    histIndex: -1,
    draft: '',
    cwd: '~',
    home: '',
    running: false,
    controller: null,
    activeCat: 'all',
    query: '',
    stick: true,
  };

  /* ------------------------------------------------------------- storage */

  function readSessionId() {
    let id = null;
    try {
      id = localStorage.getItem(STORAGE.session);
    } catch {
      /* приватный режим */
    }
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || 'sess-' + Math.random().toString(36).slice(2) + Date.now();
      try {
        localStorage.setItem(STORAGE.session, id);
      } catch {
        /* ignore */
      }
    }
    return id;
  }

  function readHistory() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE.history) || '[]');
      return Array.isArray(raw) ? raw.filter((item) => typeof item === 'string').slice(-200) : [];
    } catch {
      return [];
    }
  }

  function persistHistory() {
    try {
      localStorage.setItem(STORAGE.history, JSON.stringify(state.history.slice(-200)));
    } catch {
      /* ignore */
    }
  }

  /* -------------------------------------------------------------- helpers */

  const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

  function normalize(text) {
    return String(text).replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function prettyPath(p) {
    if (!p) return '~';
    if (state.home && p === state.home) return '~';
    if (state.home && p.startsWith(state.home + '/')) return '~' + p.slice(state.home.length);
    return p;
  }

  function vibrate(ms) {
    if (navigator.vibrate) {
      try {
        navigator.vibrate(ms);
      } catch {
        /* ignore */
      }
    }
  }

  function setStatus(mode) {
    els.statusDot.className = 'status-dot' + (mode ? ' ' + mode : '');
  }

  function updatePrompt() {
    const pathEl = els.promptLabel.querySelector('.prompt-path');
    if (pathEl) pathEl.textContent = state.cwd;
  }

  function scrollToBottom() {
    els.output.scrollTop = els.output.scrollHeight;
    state.stick = true;
    els.jumpBtn.hidden = true;
  }

  function trimOutput() {
    const maxLines = 1200;
    while (els.output.childElementCount > maxLines) {
      els.output.removeChild(els.output.firstElementChild);
    }
  }

  function appendLine(node) {
    const near = els.output.scrollHeight - els.output.scrollTop - els.output.clientHeight < 90;
    els.output.appendChild(node);
    trimOutput();
    if (near || state.stick) {
      els.output.scrollTop = els.output.scrollHeight;
    } else {
      els.jumpBtn.hidden = false;
    }
  }

  function printLine(text, cls = 'out') {
    const line = document.createElement('div');
    line.className = 'line ' + cls;
    line.textContent = text;
    appendLine(line);
    return line;
  }

  function echoCommand(command) {
    const line = document.createElement('div');
    line.className = 'line cmd';

    const path = document.createElement('span');
    path.className = 'prompt-path';
    path.textContent = state.cwd;

    const sign = document.createElement('span');
    sign.className = 'prompt-sign';
    sign.textContent = '$';

    const body = document.createElement('span');
    body.textContent = command;

    line.append(path, sign, body);
    appendLine(line);
  }

  function resizeInput() {
    els.input.style.height = 'auto';
    const next = Math.min(els.input.scrollHeight, 120);
    els.input.style.height = next + 'px';
  }

  function placeCaretEnd() {
    const len = els.input.value.length;
    try {
      els.input.setSelectionRange(len, len);
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------ the shell */

  async function runCommand(raw) {
    const command = raw.trim();
    if (!command || state.running) return;

    addHistory(command);
    echoCommand(command);
    els.input.value = '';
    resizeInput();
    hideSuggestions();

    if (command === 'clear') {
      els.output.replaceChildren();
      return;
    }

    if (command === 'help' || command === '?') {
      openSheet();
      return;
    }

    if (command === 'exit') {
      printLine('Сеанс закроется вместе с вкладкой. Оболочка работает на сервере.', 'sys');
      return;
    }

    const outLine = document.createElement('div');
    outLine.className = 'line out';
    appendLine(outLine);

    const controller = new AbortController();
    state.controller = controller;
    setRunning(true);
    setStatus('busy');

    let finished = false;
    const finishVisual = (meta) => {
      if (finished) return;
      finished = true;
      if (!outLine.textContent) outLine.remove();
      if (meta) printLine(meta.text, meta.cls);
      setRunning(false);
      setStatus('');
      state.controller = null;
    };

    try {
      const response = await fetch('/api/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.sessionId, command }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let message = `Сервер ответил ошибкой ${response.status}`;
        try {
          const data = await response.json();
          if (data && data.error) message = data.error;
        } catch {
          /* ignore */
        }
        outLine.classList.add('err');
        outLine.textContent = message + '\n';
        finishVisual(null);
        return;
      }

      let lastMeta = null;

      await readEventStream(response.body, (message) => {
        if (message.type === 'out' && typeof message.data === 'string') {
          outLine.textContent += normalize(message.data);
        } else if (message.type === 'end') {
          if (typeof message.cwd === 'string') {
            state.cwd = prettyPath(message.cwd);
            updatePrompt();
          }
          if (message.timedOut) {
            lastMeta = { text: '⏱ остановлено по таймауту', cls: 'meta' };
          } else if (typeof message.code === 'number' && message.code !== 0) {
            lastMeta = { text: `↳ код ${message.code}`, cls: 'meta' };
          }
        }
      });

      finishVisual(lastMeta);
    } catch (error) {
      if (error.name === 'AbortError') {
        printLine('^C — выполнение прервано', 'meta');
        setStatus('');
      } else {
        setStatus('offline');
        printLine('Нет связи с сервером: ' + error.message, 'err');
      }
      finishVisual(null);
    }
  }

  async function readEventStream(body, onMessage) {
    if (!body) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of rawEvent.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            onMessage(JSON.parse(payload));
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  function setRunning(running) {
    state.running = running;
    els.sendBtn.classList.toggle('stop', running);
    els.sendIcon.textContent = running ? '■' : '↑';
    els.sendBtn.setAttribute('aria-label', running ? 'Остановить команду' : 'Выполнить команду');
  }

  function abortCommand() {
    if (state.running && state.controller) {
      state.controller.abort();
      vibrate(20);
    }
  }

  /* ------------------------------------------------------------- history */

  function addHistory(command) {
    const last = state.history[state.history.length - 1];
    if (last !== command) {
      state.history.push(command);
      if (state.history.length > 200) state.history.shift();
      persistHistory();
    }
    state.histIndex = -1;
    state.draft = '';
  }

  function historyPrev() {
    if (!state.history.length) return;
    if (state.histIndex === -1) {
      state.draft = els.input.value;
      state.histIndex = state.history.length - 1;
    } else if (state.histIndex > 0) {
      state.histIndex -= 1;
    }
    els.input.value = state.history[state.histIndex];
    placeCaretEnd();
    resizeInput();
    hideSuggestions();
  }

  function historyNext() {
    if (state.histIndex === -1) return;
    state.histIndex += 1;
    if (state.histIndex >= state.history.length) {
      state.histIndex = -1;
      els.input.value = state.draft;
    } else {
      els.input.value = state.history[state.histIndex];
    }
    placeCaretEnd();
    resizeInput();
    hideSuggestions();
  }

  /* -------------------------------------------------------- autocomplete */

  function hideSuggestions() {
    els.suggestions.hidden = true;
    els.suggestions.replaceChildren();
  }

  function renderSuggestions(items, base, rest) {
    els.suggestions.replaceChildren();

    if (!items.length) {
      const hint = document.createElement('span');
      hint.className = 'suggestion hint';
      hint.textContent = 'нет совпадений';
      els.suggestions.appendChild(hint);
      els.suggestions.hidden = false;
      return;
    }

    for (const item of items) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'suggestion';
      chip.textContent = item;
      chip.addEventListener('click', () => {
        const needsSpace = !rest.startsWith(' ');
        els.input.value = base + item + (needsSpace ? ' ' : '') + rest.replace(/^ +/, '');
        hideSuggestions();
        els.input.focus();
        placeCaretEnd();
        resizeInput();
        vibrate(8);
      });
      els.suggestions.appendChild(chip);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'suggestion hint';
    close.textContent = 'скрыть';
    close.addEventListener('click', hideSuggestions);
    els.suggestions.appendChild(close);

    els.suggestions.hidden = false;
  }

  async function requestCompletion() {
    const value = els.input.value;
    const cursor = els.input.selectionStart ?? value.length;
    const upToCursor = value.slice(0, cursor);
    const match = upToCursor.match(/(\S*)$/);
    const prefix = match ? match[1] : '';
    const base = upToCursor.slice(0, upToCursor.length - prefix.length);
    const rest = value.slice(cursor);

    if (prefix.length > 120) return;

    try {
      const response = await fetch('/api/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.sessionId, prefix }),
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      renderSuggestions(Array.isArray(data.items) ? data.items : [], base, rest);
      vibrate(6);
    } catch {
      hideSuggestions();
    }
  }

  /* ---------------------------------------------------------------- sheet */

  function buildCategories() {
    const groups = window.COMMAND_GROUPS || [];
    const categories = [{ name: 'Все', value: 'all' }].concat(
      groups.map((group) => ({ name: group.name, value: group.name }))
    );

    els.categories.replaceChildren();
    for (const category of categories) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'category' + (state.activeCat === category.value ? ' active' : '');
      button.textContent = category.name;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(state.activeCat === category.value));
      button.addEventListener('click', () => {
        state.activeCat = category.value;
        buildCategories();
        renderCommands();
        vibrate(6);
      });
      els.categories.appendChild(button);
    }
  }

  function renderCommands() {
    const groups = window.COMMAND_GROUPS || [];
    const query = state.query.trim().toLowerCase();
    const container = els.commandList;
    container.replaceChildren();

    let count = 0;

    for (const group of groups) {
      if (state.activeCat !== 'all' && group.name !== state.activeCat) continue;

      const items = group.items.filter((item) => {
        if (!query) return true;
        return (
          item.cmd.toLowerCase().includes(query) ||
          item.desc.toLowerCase().includes(query) ||
          group.name.toLowerCase().includes(query)
        );
      });

      if (!items.length) continue;

      const title = document.createElement('div');
      title.className = 'group-title';
      title.textContent = group.name;
      container.appendChild(title);

      for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cmd-item';

        const code = document.createElement('code');
        code.textContent = item.cmd;

        const desc = document.createElement('span');
        desc.className = 'cmd-desc';
        desc.textContent = item.desc;

        button.append(code, desc);
        button.addEventListener('click', () => insertCommand(item.cmd));
        container.appendChild(button);
        count += 1;
      }
    }

    if (!count) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'Ничего не нашлось. Попробуйте «git», «файлы» или «сеть».';
      container.appendChild(empty);
    }
  }

  function insertCommand(command) {
    els.input.value = command;
    closeSheet();
    els.input.focus();
    placeCaretEnd();
    resizeInput();
    hideSuggestions();
    vibrate(10);
  }

  let lastFocused = null;

  function openSheet() {
    lastFocused = document.activeElement;
    els.sheet.classList.add('open');
    els.sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('sheet-open');
    renderCommands();
    vibrate(8);
  }

  function closeSheet() {
    if (!els.sheet.classList.contains('open')) return;
    els.sheet.classList.remove('open');
    els.sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('sheet-open');
    if (lastFocused && typeof lastFocused.focus === 'function') {
      lastFocused.focus({ preventScroll: true });
    }
  }

  /* -------------------------------------------------------------- events */

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.running) {
      abortCommand();
      return;
    }
    runCommand(els.input.value);
  });

  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (state.running) {
        abortCommand();
        return;
      }
      runCommand(els.input.value);
      return;
    }

    if (event.key === 'c' && (event.ctrlKey || event.metaKey) && state.running) {
      abortCommand();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      historyPrev();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      historyNext();
      return;
    }

    if (event.key === 'l' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      els.output.replaceChildren();
    }

    if (event.key === 'Escape') {
      hideSuggestions();
      closeSheet();
    }
  });

  els.input.addEventListener('input', () => {
    resizeInput();
    hideSuggestions();
  });

  els.keys.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;

    if (action === 'ctrl-c') {
      if (state.running) {
        abortCommand();
      } else {
        printLine('^C — нечего прерывать', 'meta');
      }
      vibrate(15);
      return;
    }

    if (action === 'tab') {
      requestCompletion();
      return;
    }

    if (action === 'prev') {
      historyPrev();
      return;
    }

    if (action === 'next') {
      historyNext();
      return;
    }

    if (action === 'clear') {
      els.output.replaceChildren();
      hideSuggestions();
      vibrate(8);
      return;
    }

    if (action === 'help') {
      openSheet();
    }
  });

  els.helpBtn.addEventListener('click', openSheet);
  els.sheetClose.addEventListener('click', closeSheet);
  els.sheet.addEventListener('click', (event) => {
    if (event.target.dataset.close === 'true') closeSheet();
  });

  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    renderCommands();
  });

  els.jumpBtn.addEventListener('click', scrollToBottom);

  els.output.addEventListener('scroll', () => {
    const distance = els.output.scrollHeight - els.output.scrollTop - els.output.clientHeight;
    state.stick = distance < 60;
    els.jumpBtn.hidden = state.stick;
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSheet();
  });

  // Держим поле ввода над экранной клавиатурой на iOS.
  if (window.visualViewport) {
    const viewport = window.visualViewport;
    const applyHeight = () => {
      document.documentElement.style.setProperty('--app-height', viewport.height + 'px');
    };
    viewport.addEventListener('resize', applyHeight);
    viewport.addEventListener('scroll', applyHeight);
    applyHeight();
    requestAnimationFrame(scrollToBottom);
  }

  /* ----------------------------------------------------------------- boot */

  async function boot() {
    buildCategories();
    updatePrompt();
    resizeInput();

    printLine('Арена Терминал · оболочка bash на сервере', 'sys');
    printLine('Нажмите ? в правом верхнем углу, чтобы увидеть список команд.', 'sys');

    try {
      const response = await fetch('/api/info');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const info = await response.json();
      state.home = info.home || '';
      state.cwd = prettyPath(info.cwd || info.home || '');
      updatePrompt();
      els.hostLabel.textContent = `${info.user}@${info.host}`;
      printLine(`Подключено: ${info.user}@${info.host} · ${info.platform}`, 'banner');
    } catch {
      setStatus('offline');
      els.hostLabel.textContent = 'нет связи с сервером';
      printLine('Не удалось подключиться к серверу. Проверьте, что процесс запущен.', 'err');
    }

    scrollToBottom();

    // Мягко подсвечиваем кнопку «?», чтобы её заметили при первом запуске.
    els.helpBtn.classList.add('attention');
    setTimeout(() => els.helpBtn.classList.remove('attention'), 6800);
  }

  boot();
})();
