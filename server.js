'use strict';

/**
 * 로컬 스케줄러 서버.
 * 127.0.0.1 에만 바인딩한다 — 이 대시보드는 임의의 명령을 실행할 수 있으므로
 * 외부 네트워크에 절대 노출하면 안 된다.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const cron = require('./lib/cron');
const store = require('./lib/store');
const paths = require('./lib/paths');
const runner = require('./lib/runner');
const scheduler = require('./lib/scheduler');

const PORT = Number(process.env.SCHEDULER_PORT || 4321);

/**
 * 모델 입력 후보. Claude Code CLI 의 --model 은 별칭과 전체 ID 를 모두 받는다.
 * 별칭은 항상 그 계열의 최신 모델을 가리키므로 기본값으로 두기에 안전하다.
 */
const MODEL_SUGGESTIONS = [
  { value: 'opus', label: 'opus — 최신 Opus (권장)' },
  { value: 'sonnet', label: 'sonnet — 더 빠르고 저렴' },
  { value: 'haiku', label: 'haiku — 가장 빠르고 저렴' },
  { value: 'fable', label: 'fable — 가장 강력' },
  { value: 'claude-opus-5', label: 'claude-opus-5 — 버전 고정' },
  { value: 'claude-sonnet-5', label: 'claude-sonnet-5 — 버전 고정' },
  { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5 — 버전 고정' },
];
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ------------------------------------------------------------------ 유틸

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('요청 본문이 너무 큽니다 (2MB 초과)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error('JSON 형식이 잘못되었습니다'));
      }
    });
    req.on('error', reject);
  });
}

/** 브라우저가 이 서버를 직접 연 것인지 확인한다 (DNS 리바인딩 방어). */
function hostAllowed(req) {
  const host = String(req.headers.host || '');
  const name = host.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

// -------------------------------------------------------------- SSE 브로드캐스트

const sseClients = new Set();

function broadcast(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (err) {
      sseClients.delete(res);
    }
  }
}

runner.events.on('start', function (e) { broadcast('run-start', e); });
runner.events.on('finish', function (e) { broadcast('run-finish', e); });
runner.events.on('skip', function (e) { broadcast('run-skip', e); });

// ------------------------------------------------------------------ 조회 모델

function jobView(job) {
  let scheduleText;
  let scheduleError = null;
  try {
    scheduleText = cron.describe(job.schedule);
  } catch (err) {
    scheduleText = job.schedule;
    scheduleError = err.message;
  }
  // 이 PC 에 없는 작업 디렉토리는 실행 시 홈으로 폴백되므로 미리 경고로 알린다.
  const missingCwd = paths.checkExists(job);
  return Object.assign({}, job, {
    // 실행 결과는 작업 정의가 아니라 이 PC 의 runtime.json 에서 온다.
    lastRun: store.getLastRun(job.id),
    scheduleText: scheduleText,
    scheduleError: scheduleError,
    cwdWarning: missingCwd ? '이 PC에 없는 경로입니다: ' + missingCwd : null,
    running: runner.isRunning(job.id),
    nextRunAt: job.enabled ? scheduler.nextRunAt(job.id) : null,
  });
}

function listJobsView() {
  return store.loadJobs().map(jobView);
}

// ------------------------------------------------------------------ 라우팅

async function handleApi(req, res, pathname, query) {
  const method = req.method;

  // GET /api/state — 대시보드 전체 상태
  if (pathname === '/api/state' && method === 'GET') {
    return sendJson(res, 200, {
      jobs: listJobsView(),
      running: runner.runningInfo(),
      presets: cron.PRESETS,
      permissionModes: store.PERMISSION_MODES,
      models: MODEL_SUGGESTIONS,
      serverTime: new Date().toISOString(),
      platform: process.platform,
      dataDir: store.DATA_DIR,
    });
  }

  // POST /api/schedule/preview — cron 표현식 검증 + 다음 실행 미리보기
  if (pathname === '/api/schedule/preview' && method === 'POST') {
    const body = await readBody(req);
    const check = cron.validate(body.schedule);
    if (!check.ok) return sendJson(res, 200, { ok: false, error: check.error });
    return sendJson(res, 200, {
      ok: true,
      text: cron.describe(body.schedule),
      next: cron.nextRuns(body.schedule, 5).map(function (d) { return d.toISOString(); }),
    });
  }

  // POST /api/jobs — 생성
  if (pathname === '/api/jobs' && method === 'POST') {
    const body = await readBody(req);
    const job = store.createJob(body);
    scheduler.refresh();
    broadcast('jobs-changed', { id: job.id });
    return sendJson(res, 201, jobView(job));
  }

  const jobMatch = /^\/api\/jobs\/([A-Za-z0-9]+)(\/[a-z-]+)?$/.exec(pathname);
  if (jobMatch) {
    const id = jobMatch[1];
    const action = jobMatch[2];
    const job = store.getJob(id);
    if (!job) return sendJson(res, 404, { error: '작업을 찾을 수 없습니다' });

    if (!action && method === 'GET') return sendJson(res, 200, jobView(job));

    if (!action && method === 'PUT') {
      const body = await readBody(req);
      const updated = store.updateJob(id, body);
      scheduler.refresh();
      broadcast('jobs-changed', { id: id });
      return sendJson(res, 200, jobView(updated));
    }

    if (!action && method === 'DELETE') {
      runner.cancel(id);
      store.deleteJob(id);
      scheduler.refresh();
      broadcast('jobs-changed', { id: id });
      return sendJson(res, 200, { ok: true });
    }

    if (action === '/toggle' && method === 'POST') {
      const updated = store.patchJob(id, { enabled: !job.enabled, updatedAt: new Date().toISOString() });
      scheduler.refresh();
      broadcast('jobs-changed', { id: id });
      return sendJson(res, 200, jobView(updated));
    }

    if (action === '/run' && method === 'POST') {
      const result = runner.run(job, { trigger: 'manual' });
      if (result.skipped) return sendJson(res, 409, { error: result.reason });
      return sendJson(res, 202, { ok: true, runId: result.run.id });
    }

    if (action === '/cancel' && method === 'POST') {
      const ok = runner.cancel(id);
      return sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { error: '실행 중이 아닙니다' });
    }

    if (action === '/runs' && method === 'GET') {
      return sendJson(res, 200, { runs: store.loadRuns(id) });
    }
  }

  // GET /api/jobs/:id/runs/:runId/log
  const logMatch = /^\/api\/jobs\/([A-Za-z0-9]+)\/runs\/([A-Za-z0-9._-]+)\/log$/.exec(pathname);
  if (logMatch && method === 'GET') {
    const result = store.readLog(logMatch[1], logMatch[2]);
    return sendJson(res, 200, result);
  }

  return sendJson(res, 404, { error: '알 수 없는 API 경로입니다: ' + pathname });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  // 디렉토리 탈출 방지
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(target, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('찾을 수 없습니다');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(function (req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  if (!hostAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('localhost 로만 접속할 수 있습니다');
    return;
  }

  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    const keepAlive = setInterval(function () {
      try { res.write(': ping\n\n'); } catch (e) { /* 끊긴 연결 */ }
    }, 25000);
    req.on('close', function () {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, parsed.query).catch(function (err) {
      sendJson(res, 400, { error: err.message || '요청을 처리하지 못했습니다' });
    });
    return;
  }

  serveStatic(req, res, pathname);
});

function shutdown(signal) {
  console.log('\n[' + signal + '] 종료합니다…');
  scheduler.stop();
  runner.shutdown();
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 3000).unref();
}

process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });

// 무인으로 도는 프로그램이라, 예상 못 한 예외 하나로 모든 스케줄이 멈추면 안 된다.
// 기록만 남기고 계속 돌린다 (Windows에는 자동 재시작 장치가 없다).
process.on('uncaughtException', function (err) {
  console.error('[' + new Date().toLocaleString('ko-KR') + '] 처리되지 않은 예외 — 스케줄러는 계속 실행됩니다');
  console.error(err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', function (reason) {
  console.error('[' + new Date().toLocaleString('ko-KR') + '] 처리되지 않은 Promise 거부 — 스케줄러는 계속 실행됩니다');
  console.error(reason && reason.stack ? reason.stack : reason);
});

server.on('error', function (err) {
  if (err.code === 'EADDRINUSE') {
    console.error('포트 ' + PORT + ' 가 이미 사용 중입니다. 스케줄러가 이미 실행 중인지 확인하거나 SCHEDULER_PORT 로 다른 포트를 지정하세요.');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, function () {
  store.ensureDirs();
  scheduler.start();
  console.log('');
  console.log('  로컬 스케줄러가 실행 중입니다');
  console.log('  대시보드 : http://127.0.0.1:' + PORT);
  console.log('  데이터   : ' + store.DATA_DIR);
  console.log('');
});
