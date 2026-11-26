'use strict';

/**
 * Арена Терминал — минималистичный shell-сервер без внешних зависимостей.
 *
 *  GET  /              — мобильный интерфейс терминала
 *  GET  /api/info      — сведения о пользователе, хосте и домашней папке
 *  POST /api/exec      — выполнение команды, поток вывода (text/event-stream)
 *  POST /api/complete  — автодополнение команд и файлов (кнопка Tab)
 *
 * Каждая сессия помнит свою рабочую директорию (cd работает между запросами).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { StringDecoder } = require('node:string_decoder');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS) || 120_000;
const MAX_COMMAND_LENGTH = 8_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const CWD_MARKER = '__ARENA_CWD__';

const HOME = process.env.HOME && process.env.HOME.startsWith('/') ? process.env.HOME : os.homedir();

const sessions = new Map();

function getSession(id) {
  let session = sessions.get(id);
  if (!session) {
    session = { cwd: HOME, updatedAt: Date.now() };
    sessions.set(id, session);
  }
  session.updatedAt = Date.now();
  return session;
}

// Периодически чистим неактивные сессии.
setInterval(() => {
  const ttl = 30 * 60 * 1000;
  for (const [id, session] of sessions) {
    if (Date.now() - session.updatedAt > ttl) sessions.delete(id);
  }
}, 5 * 60 * 1000).unref();

/* ------------------------------------------------------------------ utils */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    sendJson(res, 403, { error: 'Запрещено' });
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — файл не найден');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ------------------------------------------------------------- /api/info */

function handleInfo(req, res) {
  let user = 'user';
  try {
    user = os.userInfo().username;
  } catch {
    /* ignore */
  }
  sendJson(res, 200, {
    user,
    host: os.hostname(),
    home: HOME,
    shell: 'bash',
    platform: `${os.type()} ${os.release()}`,
    cwd: HOME,
  });
}

/* ------------------------------------------------------------- /api/exec */

function handleExec(req, res) {
  readJsonBody(req)
    .then((body) => {
      const command = typeof body.command === 'string' ? body.command.trim() : '';
      if (!command) return sendJson(res, 400, { error: 'Пустая команда' });
      if (command.length > MAX_COMMAND_LENGTH) {
        return sendJson(res, 413, { error: 'Слишком длинная команда' });
      }

      const sessionId = String(body.sessionId || 'anonymous').slice(0, 64);
      const session = getSession(sessionId);

      streamCommand(req, res, session, command);
    })
    .catch((error) => sendJson(res, 400, { error: error.message }));
}

function streamCommand(req, res, session, command) {
  const startedAt = Date.now();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (payload) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({ type: 'start', cwd: session.cwd, command });

  const script = [
    command,
    '__arena_status=$?',
    `printf '\\n${CWD_MARKER}%s|%s\\n' "$PWD" "$__arena_status"`,
  ].join('\n');

  const child = spawn('bash', ['-c', script], {
    cwd: session.cwd,
    env: {
      ...process.env,
      TERM: 'dumb',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      SYSTEMD_PAGER: 'cat',
      NO_COLOR: '1',
      CLICOLOR: '0',
      DEBIAN_FRONTEND: 'noninteractive',
      PS1: '',
      ARENA_TERM: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let full = '';
  let emitted = 0;
  let finished = false;
  let timedOut = false;
  let truncated = false;
  let exitCode = null;

  const HOLDBACK = 1024; // держим хвост, чтобы не отправить служебную метку

  const flushSafe = () => {
    const safeEnd = Math.max(emitted, full.length - HOLDBACK);
    if (safeEnd > emitted) {
      send({ type: 'out', data: full.slice(emitted, safeEnd) });
      emitted = safeEnd;
    }
  };

  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');

  const appendText = (text) => {
    if (finished || truncated || !text) return;
    full += text;

    if (full.length > MAX_OUTPUT_BYTES) {
      truncated = true;
      child.kill('SIGKILL');
      return;
    }
    flushSafe();
  };

  child.stdout.on('data', (chunk) => appendText(stdoutDecoder.write(chunk)));
  child.stderr.on('data', (chunk) => appendText(stderrDecoder.write(chunk)));

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, COMMAND_TIMEOUT_MS);

  const killChild = () => {
    if (!child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  };

  res.on('close', () => {
    clearTimeout(timer);
    if (!finished) killChild();
  });
  req.on('aborted', killChild);

  const finish = (signalCode) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);

    const markerIndex = full.lastIndexOf(CWD_MARKER);
    let clean = full;
    let exit = typeof signalCode === 'number' ? signalCode : exitCode;

    if (markerIndex !== -1) {
      const tailStart = markerIndex + CWD_MARKER.length;
      const newlineIndex = full.indexOf('\n', tailStart);
      const tail = newlineIndex === -1 ? full.slice(tailStart) : full.slice(tailStart, newlineIndex);
      const separator = tail.lastIndexOf('|');

      if (separator !== -1) {
        const nextCwd = tail.slice(0, separator);
        const status = Number(tail.slice(separator + 1));
        if (nextCwd.startsWith('/')) session.cwd = nextCwd;
        if (Number.isFinite(status)) exit = status;
        clean = full.slice(0, markerIndex);
      }
    }

    clean = clean.replace(/\n$/, '');

    const rest = clean.slice(Math.max(0, Math.min(emitted, clean.length)));
    if (rest) send({ type: 'out', data: rest });

    if (timedOut) {
      send({
        type: 'out',
        data: `\n⏱ Превышен лимит ${Math.round(COMMAND_TIMEOUT_MS / 1000)} с — процесс остановлен.\n`,
      });
    }

    if (truncated) {
      send({
        type: 'out',
        data: `\n⚠ Вывод обрезан: больше ${Math.round(MAX_OUTPUT_BYTES / 1024 / 1024)} МБ.\n`,
      });
    }

    send({
      type: 'end',
      code: timedOut ? 124 : exit,
      cwd: session.cwd,
      durationMs: Date.now() - startedAt,
      timedOut,
    });
    res.end();
  };

  child.on('error', (error) => {
    full += `\n${error.message}\n`;
    finish(127);
  });
  child.on('close', finish);
}

/* --------------------------------------------------------- /api/complete */

function handleComplete(req, res) {
  readJsonBody(req)
    .then((body) => {
      const prefix = typeof body.prefix === 'string' ? body.prefix.slice(-200) : '';
      const sessionId = String(body.sessionId || 'anonymous').slice(0, 64);
      const session = getSession(sessionId);

      const script = [
        'pre=$ARENA_PREFIX',
        'if [ -z "$pre" ]; then',
        '  compgen -c | sort -u | head -40',
        'else',
        '  { compgen -c -- "$pre"; compgen -f -- "$pre"; compgen -d -- "$pre"; } 2>/dev/null | sort -u | head -40',
        'fi',
      ].join('\n');

      const child = spawn('bash', ['-c', script], {
        cwd: session.cwd,
        env: { ...process.env, ARENA_PREFIX: prefix, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let out = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 4000);

      child.stdout.on('data', (chunk) => {
        if (out.length < 20_000) out += chunk.toString('utf8');
      });
      child.on('close', () => {
        clearTimeout(timer);
        const items = out
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && line !== '.' && line !== '..')
          .slice(0, 12);
        sendJson(res, 200, { items, prefix, cwd: session.cwd });
      });
    })
    .catch((error) => sendJson(res, 400, { error: error.message }));
}

/* --------------------------------------------------------------- routing */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (pathname === '/api/info' && (req.method === 'GET' || req.method === 'HEAD')) {
    return handleInfo(req, res);
  }
  if (pathname === '/api/exec' && req.method === 'POST') {
    return handleExec(req, res);
  }
  if (pathname === '/api/complete' && req.method === 'POST') {
    return handleComplete(req, res);
  }
  if (pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, uptime: process.uptime() });
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, pathname);
  }

  sendJson(res, 405, { error: 'Метод не поддерживается' });
});

server.listen(PORT, HOST, () => {
  console.log(`Арена Терминал слушает http://${HOST}:${PORT}`);
});
