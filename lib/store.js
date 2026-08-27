'use strict';

/**
 * 작업 정의 / 실행 상태 / 실행 이력을 파일로 보관한다.
 * 외부 DB 없이 data/ 아래 JSON 파일만 사용하므로 폴더째 복사하면 다른 PC로 그대로 옮겨진다.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.SCHEDULER_DATA_DIR
  ? path.resolve(process.env.SCHEDULER_DATA_DIR)
  : path.join(ROOT, 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
const RUNS_DIR = path.join(DATA_DIR, 'runs');

/** job 하나당 보관할 실행 이력 개수. 초과분은 오래된 것부터 지운다. */
const MAX_RUNS_PER_JOB = 50;

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[store] ' + file + ' 을 읽지 못했습니다:', err.message);
    }
    return fallback;
  }
}

/** 임시 파일에 쓰고 rename 해서 중간에 죽어도 파일이 깨지지 않게 한다. */
function writeJsonAtomic(file, value) {
  ensureDirs();
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

// ---------------------------------------------------------------- 작업(job)

function loadJobs() {
  const raw = readJson(JOBS_FILE, null);
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : raw.jobs;
  return Array.isArray(list) ? list : [];
}

function saveJobs(jobs) {
  writeJsonAtomic(JOBS_FILE, { version: 1, jobs });
}

function getJob(id) {
  return loadJobs().find(function (j) { return j.id === id; }) || null;
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 30 * 60 * 1000; // 기본 30분
  return Math.min(Math.max(Math.round(n), 5000), 12 * 60 * 60 * 1000);
}

/** 폼에서 넘어온 값을 저장 가능한 job 형태로 정규화한다. 잘못되면 Error. */
function normalizeJob(input, existing) {
  const base = existing || {};
  const type = input.type === 'shell' ? 'shell' : 'claude';
  const name = String(input.name == null ? base.name || '' : input.name).trim();
  if (!name) throw new Error('작업 이름을 입력하세요');

  const schedule = String(input.schedule == null ? base.schedule || '' : input.schedule).trim();
  if (!schedule) throw new Error('스케줄을 입력하세요');
  const cron = require('./cron');
  cron.parse(schedule); // 잘못된 표현식이면 여기서 Error
  // 문법은 맞지만 실제로는 절대 오지 않는 날짜(2월 30일, 4월 31일 등)를 걸러낸다.
  // 그냥 두면 영영 실행되지 않으면서 아무 경고도 나오지 않는다.
  if (!cron.nextRuns(schedule, 1).length) {
    throw new Error('실제로 오지 않는 날짜입니다 (예: 2월 30일). 스케줄을 다시 확인하세요');
  }

  const job = {
    id: base.id || newId(),
    name: name,
    type: type,
    enabled: input.enabled == null ? (base.enabled !== false) : Boolean(input.enabled),
    schedule: schedule,
    cwd: String(input.cwd == null ? base.cwd || '' : input.cwd).trim(),
    // macOS 에서만 다른 경로를 써야 할 때 (비우면 cwd 를 그대로 쓴다)
    cwdMac: String(input.cwdMac == null ? base.cwdMac || '' : input.cwdMac).trim(),
    timeoutMs: clampTimeout(input.timeoutMs == null ? base.timeoutMs : input.timeoutMs),
    catchUp: input.catchUp == null ? Boolean(base.catchUp) : Boolean(input.catchUp),
    notes: String(input.notes == null ? base.notes || '' : input.notes).trim(),
    createdAt: base.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (type === 'claude') {
    job.prompt = String(input.prompt == null ? base.prompt || '' : input.prompt).trim();
    if (!job.prompt) throw new Error('Claude에 보낼 프롬프트를 입력하세요');
    job.model = String(input.model == null ? base.model || '' : input.model).trim();
    const mode = String(input.permissionMode == null ? base.permissionMode || '' : input.permissionMode).trim();
    job.permissionMode = PERMISSION_MODES.indexOf(mode) !== -1 ? mode : 'acceptEdits';
    job.allowedTools = String(input.allowedTools == null ? base.allowedTools || '' : input.allowedTools).trim();
    job.extraArgs = String(input.extraArgs == null ? base.extraArgs || '' : input.extraArgs).trim();
    job.command = '';
  } else {
    job.command = String(input.command == null ? base.command || '' : input.command).trim();
    if (!job.command) throw new Error('실행할 명령을 입력하세요');
    job.prompt = '';
  }

  // 경로가 이 PC 에 없어도 저장은 막지 않는다 — 다른 PC 에서 동기화된 작업을
  // 이쪽에서 편집할 수 없게 되기 때문이다. 대신 목록에 경고로 드러내고,
  // 실행 시에는 홈 디렉토리로 폴백하면서 로그에 사유를 남긴다.
  return job;
}

function createJob(input) {
  const job = normalizeJob(input, null);
  const jobs = loadJobs();
  jobs.push(job);
  saveJobs(jobs);
  return job;
}

function updateJob(id, input) {
  const jobs = loadJobs();
  const idx = jobs.findIndex(function (j) { return j.id === id; });
  if (idx === -1) throw new Error('작업을 찾을 수 없습니다: ' + id);
  const job = normalizeJob(input, jobs[idx]);
  jobs[idx] = job;
  saveJobs(jobs);
  return job;
}

/** 실행 결과 등 부분 필드만 조용히 갱신한다 (검증을 다시 돌리지 않는다). */
function patchJob(id, patch) {
  const jobs = loadJobs();
  const idx = jobs.findIndex(function (j) { return j.id === id; });
  if (idx === -1) return null;
  jobs[idx] = Object.assign({}, jobs[idx], patch);
  saveJobs(jobs);
  return jobs[idx];
}

function deleteJob(id) {
  const jobs = loadJobs();
  const next = jobs.filter(function (j) { return j.id !== id; });
  if (next.length === jobs.length) return false;
  saveJobs(next);
  fs.rmSync(path.join(RUNS_DIR, id), { recursive: true, force: true });
  forgetRuntime(id);
  return true;
}

// ------------------------------------------------------- 스케줄 상태(state)

function loadState() {
  return readJson(STATE_FILE, {});
}

function saveState(state) {
  writeJsonAtomic(STATE_FILE, state);
}

// ------------------------------------------------- 실행 결과(runtime, PC 로컬)

/**
 * 마지막 실행 결과는 jobs.json 이 아니라 runtime.json 에 둔다.
 * 작업 정의 파일이 실행할 때마다 바뀌면 두 PC 간 git 동기화에서 매번 충돌하기 때문이다.
 * runtime.json 은 PC 마다 다른 값이므로 동기화 대상이 아니다.
 */
function loadRuntime() {
  const raw = readJson(RUNTIME_FILE, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function getLastRun(jobId) {
  const entry = loadRuntime()[jobId];
  return entry && entry.lastRun ? entry.lastRun : null;
}

function setLastRun(jobId, lastRun) {
  const runtime = loadRuntime();
  runtime[jobId] = Object.assign({}, runtime[jobId], { lastRun: lastRun });
  writeJsonAtomic(RUNTIME_FILE, runtime);
}

function forgetRuntime(jobId) {
  const runtime = loadRuntime();
  if (!(jobId in runtime)) return;
  delete runtime[jobId];
  writeJsonAtomic(RUNTIME_FILE, runtime);
}

// ------------------------------------------------------------- 실행 이력(run)

function jobRunsDir(jobId) {
  return path.join(RUNS_DIR, jobId);
}

function runIndexFile(jobId) {
  return path.join(jobRunsDir(jobId), 'index.json');
}

function logFile(jobId, runId) {
  return path.join(jobRunsDir(jobId), runId + '.log');
}

function loadRuns(jobId) {
  const list = readJson(runIndexFile(jobId), []);
  return Array.isArray(list) ? list : [];
}

function saveRuns(jobId, runs) {
  fs.mkdirSync(jobRunsDir(jobId), { recursive: true });
  writeJsonAtomic(runIndexFile(jobId), runs);
}

/** 실행 시작을 기록하고 run 메타를 돌려준다. */
function startRun(jobId, meta) {
  const run = Object.assign({
    id: new Date().toISOString().replace(/[:.]/g, '-') + '-' + newId().slice(0, 4),
    jobId: jobId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    exitCode: null,
    trigger: 'schedule',
    error: null,
  }, meta || {});

  const runs = loadRuns(jobId);
  runs.unshift(run);
  // 보관 개수를 넘으면 오래된 이력과 로그 파일을 함께 지운다.
  const dropped = runs.splice(MAX_RUNS_PER_JOB);
  saveRuns(jobId, runs);
  for (const old of dropped) {
    fs.rmSync(logFile(jobId, old.id), { force: true });
  }
  return run;
}

function finishRun(jobId, runId, patch) {
  const runs = loadRuns(jobId);
  const idx = runs.findIndex(function (r) { return r.id === runId; });
  if (idx === -1) return null;
  runs[idx] = Object.assign({}, runs[idx], patch, { finishedAt: new Date().toISOString() });
  saveRuns(jobId, runs);
  return runs[idx];
}

/**
 * 예전 형식(jobs.json 안에 lastRun 이 들어 있던 구조)을 runtime.json 으로 옮긴다.
 * 그대로 두면 실행할 때마다 작업 정의 파일이 바뀌어 두 PC 동기화에서 계속 충돌한다.
 */
function migrateLegacyLastRun() {
  const jobs = loadJobs();
  const runtime = loadRuntime();
  let changed = false;

  for (const job of jobs) {
    if (!('lastRun' in job)) continue;
    if (job.lastRun) {
      runtime[job.id] = Object.assign({}, runtime[job.id], { lastRun: job.lastRun });
    }
    delete job.lastRun;
    changed = true;
  }

  if (changed) {
    writeJsonAtomic(RUNTIME_FILE, runtime);
    saveJobs(jobs);
    console.log('[store] 실행 결과를 runtime.json 으로 분리했습니다 (동기화 충돌 방지)');
  }
}

/** 서버가 비정상 종료된 뒤 남아 있는 'running' 이력을 정리한다. */
function reconcileOrphanRuns() {
  for (const job of loadJobs()) {
    const runs = loadRuns(job.id);
    let changed = false;
    for (const run of runs) {
      if (run.status === 'running') {
        run.status = 'interrupted';
        run.error = '스케줄러가 종료되어 결과를 알 수 없습니다';
        run.finishedAt = run.finishedAt || new Date().toISOString();
        changed = true;
      }
    }
    if (changed) saveRuns(job.id, runs);
  }
}

function readLog(jobId, runId, maxBytes) {
  const file = logFile(jobId, runId);
  try {
    const stat = fs.statSync(file);
    const limit = maxBytes || 512 * 1024;
    if (stat.size <= limit) {
      return { text: fs.readFileSync(file, 'utf8'), truncated: false, size: stat.size };
    }
    // 큰 로그는 뒷부분만 읽는다.
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(limit);
    fs.readSync(fd, buf, 0, limit, stat.size - limit);
    fs.closeSync(fd);
    // 잘린 지점이 한글 같은 멀티바이트 문자 중간일 수 있다.
    // UTF-8 선두 바이트가 나올 때까지 앞을 버려서 깨진 글자로 시작하지 않게 한다.
    let start = 0;
    while (start < buf.length && start < 4 && (buf[start] & 0xc0) === 0x80) start += 1;
    return { text: buf.slice(start).toString('utf8'), truncated: true, size: stat.size };
  } catch (err) {
    if (err.code === 'ENOENT') return { text: '', truncated: false, size: 0 };
    throw err;
  }
}

module.exports = {
  DATA_DIR,
  RUNS_DIR,
  PERMISSION_MODES,
  ensureDirs,
  loadJobs,
  getJob,
  createJob,
  updateJob,
  patchJob,
  deleteJob,
  loadState,
  saveState,
  loadRuntime,
  getLastRun,
  setLastRun,
  loadRuns,
  startRun,
  finishRun,
  reconcileOrphanRuns,
  migrateLegacyLastRun,
  readLog,
  logFile,
  jobRunsDir,
};
