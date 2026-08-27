'use strict';

/**
 * 작업 실행기.
 * - claude 타입: Claude Code CLI를 -p(비대화형)로 돌리고, 프롬프트는 stdin으로 넘긴다.
 *   프롬프트를 명령행 인자로 넘기지 않으므로 따옴표·줄바꿈·한글이 섞여도 깨지지 않는다.
 * - shell 타입: 플랫폼 기본 셸로 명령을 실행한다.
 */

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const store = require('./store');
const paths = require('./paths');
const { createDecoder } = require('./encoding');

const IS_WIN = process.platform === 'win32';

/** 현재 실행 중인 작업: jobId -> { child, run, startedAt, timer } */
const running = new Map();

const events = new EventEmitter();
events.setMaxListeners(50);

/**
 * "--foo bar --baz" 형태의 추가 인자 문자열을 배열로 쪼갠다.
 * 따옴표로 감싼 값은 하나의 인자로 유지한다.
 */
function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m = re.exec(text);
  while (m) {
    out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
    m = re.exec(text);
  }
  return out;
}

/** Windows에서 shell:true로 spawn할 때 공백이 든 인자를 안전하게 감싼다. */
function quoteForWinShell(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (!/[\s&|<>^"()]/.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function claudeArgs(job) {
  const args = ['-p'];
  if (job.model) args.push('--model', job.model);
  if (job.permissionMode) args.push('--permission-mode', job.permissionMode);
  if (job.allowedTools) args.push('--allowedTools', job.allowedTools);
  if (job.extraArgs) args.push.apply(args, splitArgs(job.extraArgs));
  return args;
}

/** 실행할 커맨드/인자/옵션을 플랫폼에 맞게 결정한다. */
function buildInvocation(job) {
  if (job.type === 'shell') {
    if (IS_WIN) {
      return { command: job.command, args: [], useShell: true, stdin: null };
    }
    return { command: '/bin/sh', args: ['-c', job.command], useShell: false, stdin: null };
  }

  const bin = process.env.CLAUDE_BIN || 'claude';
  const args = claudeArgs(job);
  if (IS_WIN) {
    // npm 전역 설치본은 claude.cmd 셰임이라 셸을 거쳐야 실행된다.
    const exe = /\.(cmd|bat|exe)$/i.test(bin) ? bin : bin + '.cmd';
    const line = [quoteForWinShell(exe)].concat(args.map(quoteForWinShell)).join(' ');
    return { command: line, args: [], useShell: true, stdin: job.prompt };
  }
  return { command: bin, args: args, useShell: false, stdin: job.prompt };
}

/** 자식 프로세스와 그 하위 프로세스까지 강제 종료한다. */
function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (IS_WIN) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      .on('error', function () { try { child.kill('SIGKILL'); } catch (e) { /* 이미 종료됨 */ } });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL'); // detached로 띄웠으므로 프로세스 그룹째 종료
  } catch (err) {
    try { child.kill('SIGKILL'); } catch (e) { /* 이미 종료됨 */ }
  }
}

function isRunning(jobId) {
  return running.has(jobId);
}

function runningInfo() {
  const out = {};
  running.forEach(function (entry, jobId) {
    out[jobId] = { runId: entry.run.id, startedAt: entry.run.startedAt, pid: entry.child.pid };
  });
  return out;
}

/**
 * 실행할 작업 디렉토리를 정한다.
 * 지정된 경로가 없으면 홈으로 폴백하되, 조용히 넘어가지 않고 사유를 함께 돌려준다.
 * (다른 PC에서 동기화된 작업은 그 PC에 없는 경로를 가리킬 수 있다)
 */
function resolveCwd(job) {
  const wanted = paths.resolve(job);
  if (!wanted) return { cwd: os.homedir(), warning: null };
  if (fs.existsSync(wanted)) return { cwd: wanted, warning: null };
  return {
    cwd: os.homedir(),
    warning: '지정한 작업 디렉토리가 없어 홈 디렉토리에서 실행합니다: ' + wanted,
  };
}

/**
 * 작업을 실행한다. 이미 실행 중이면 건너뛴다(중복 실행 방지).
 * @returns {{skipped:boolean, run?:object, reason?:string}}
 */
function run(job, options) {
  const opts = options || {};
  const trigger = opts.trigger || 'schedule';

  if (running.has(job.id)) {
    events.emit('skip', { jobId: job.id, reason: 'overlap' });
    return { skipped: true, reason: '이전 실행이 아직 끝나지 않았습니다' };
  }

  const invocation = buildInvocation(job);
  const resolved = resolveCwd(job);
  const cwd = resolved.cwd;
  const current = store.startRun(job.id, {
    trigger: trigger,
    scheduledFor: opts.scheduledFor || null,
    command: job.type === 'claude' ? 'claude ' + claudeArgs(job).join(' ') : job.command,
    cwd: cwd,
  });

  fs.mkdirSync(store.jobRunsDir(job.id), { recursive: true });
  const logPath = store.logFile(job.id, current.id);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  // 로그를 못 쓰는 상황(디스크 가득참·권한·경로 충돌)에서 스트림이 error 이벤트를 던진다.
  // 핸들러가 없으면 스케줄러 프로세스 전체가 죽으므로 반드시 받아준다.
  let logBroken = false;
  logStream.on('error', function (err) {
    if (logBroken) return;
    logBroken = true;
    console.error('[runner] 로그를 기록하지 못했습니다 — "' + job.name + '": ' + err.message);
  });

  const header = [
    '=== ' + job.name + ' ===',
    '실행 시각 : ' + new Date().toLocaleString('ko-KR'),
    '트리거    : ' + (trigger === 'manual' ? '수동 실행' : trigger === 'catchup' ? '놓친 일정 보정' : '스케줄'),
    '작업 폴더 : ' + cwd,
    '명령      : ' + current.command,
    '-'.repeat(60),
    '',
  ].join('\n');
  logStream.write(header);
  if (resolved.warning) {
    logStream.write('[경고] ' + resolved.warning + '\n\n');
    console.warn('[runner] "' + job.name + '" — ' + resolved.warning);
  }

  let child;
  try {
    child = spawn(invocation.command, invocation.args, {
      cwd: cwd,
      shell: invocation.useShell,
      detached: !IS_WIN, // posix: 프로세스 그룹을 만들어 타임아웃 시 통째로 종료
      windowsHide: true,
      env: Object.assign({}, process.env, {
        // 비대화형 실행임을 자식 프로세스가 알 수 있게 한다.
        LOCAL_SCHEDULER: '1',
        LOCAL_SCHEDULER_JOB: job.name,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    logStream.write('\n[실행 실패] ' + err.message + '\n');
    logStream.end();
    const finished = store.finishRun(job.id, current.id, { status: 'error', error: err.message, exitCode: null });
    store.setLastRun(job.id, summarize(finished));
    events.emit('finish', { jobId: job.id, run: finished });
    return { skipped: false, run: finished };
  }

  const entry = { child: child, run: current, startedAt: Date.now(), timedOut: false };
  running.set(job.id, entry);
  events.emit('start', { jobId: job.id, run: current });

  if (invocation.stdin != null) {
    child.stdin.on('error', function () { /* 자식이 stdin을 먼저 닫는 경우 무시 */ });
    child.stdin.end(invocation.stdin, 'utf8');
  } else {
    child.stdin.end();
  }

  // Claude Code는 Node 프로세스라 UTF-8이 확실하고, 셸 명령은 출력 코드페이지를 판정한다.
  const decodeOut = createDecoder(job.type === 'claude' ? 'utf8' : 'auto');
  const decodeErr = createDecoder(job.type === 'claude' ? 'utf8' : 'auto');
  child.stdout.on('data', function (chunk) { logStream.write(decodeOut(chunk)); });
  child.stderr.on('data', function (chunk) { logStream.write(decodeErr(chunk)); });

  const timeoutMs = job.timeoutMs || 30 * 60 * 1000;
  const timer = setTimeout(function () {
    entry.timedOut = true;
    logStream.write('\n\n[타임아웃] ' + Math.round(timeoutMs / 1000) + '초를 초과하여 강제 종료합니다.\n');
    killTree(child);
  }, timeoutMs);
  entry.timer = timer;

  let settled = false;
  const settle = function (status, exitCode, errorText) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    running.delete(job.id);

    const durationMs = Date.now() - entry.startedAt;
    logStream.write('\n' + '-'.repeat(60) + '\n');
    logStream.write('종료 상태 : ' + status + (exitCode == null ? '' : ' (exit ' + exitCode + ')') + '\n');
    logStream.write('소요 시간 : ' + formatDuration(durationMs) + '\n');
    logStream.end();

    const finished = store.finishRun(job.id, current.id, {
      status: status,
      exitCode: exitCode,
      durationMs: durationMs,
      error: errorText || null,
    });
    store.setLastRun(job.id, summarize(finished));
    events.emit('finish', { jobId: job.id, run: finished });
  };

  child.on('error', function (err) {
    logStream.write('\n[프로세스 오류] ' + err.message + '\n');
    settle('error', null, err.message);
  });

  child.on('close', function (code, signal) {
    if (entry.timedOut) {
      settle('timeout', code, '타임아웃으로 강제 종료되었습니다');
    } else if (entry.cancelled) {
      settle('cancelled', code, '사용자가 중지했습니다');
    } else if (code === 0) {
      settle('success', 0, null);
    } else {
      settle('failed', code, signal ? '시그널 ' + signal + ' 로 종료' : null);
    }
  });

  return { skipped: false, run: current };
}

/** 실행 중인 작업을 중지한다. */
function cancel(jobId) {
  const entry = running.get(jobId);
  if (!entry) return false;
  entry.cancelled = true;
  killTree(entry.child);
  return true;
}

function summarize(run) {
  if (!run) return null;
  return {
    runId: run.id,
    status: run.status,
    exitCode: run.exitCode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs || null,
  };
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + '초';
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  if (min < 60) return min + '분 ' + rest + '초';
  return Math.floor(min / 60) + '시간 ' + (min % 60) + '분';
}

/** 종료 시 실행 중인 자식 프로세스를 정리한다. */
function shutdown() {
  running.forEach(function (entry) {
    clearTimeout(entry.timer);
    killTree(entry.child);
  });
  running.clear();
}

module.exports = { run, cancel, isRunning, runningInfo, events, shutdown, splitArgs, formatDuration };
