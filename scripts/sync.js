'use strict';

/**
 * 두 PC 간 작업 설정 동기화.
 *   node scripts/sync.js          내려받고 → 내 변경을 올린다
 *   node scripts/sync.js pull     내려받기만
 *   node scripts/sync.js status   무엇이 다른지만 확인
 *
 * 공유되는 것은 작업 정의(data/jobs.json)와 코드뿐이다.
 * 실행 이력·다음 실행 시각·로그는 PC 마다 다른 값이라 .gitignore 로 제외한다.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const JOBS_FILE = path.join(ROOT, 'data', 'jobs.json');

function git(args, options) {
  return spawnSync('git', args, Object.assign({
    cwd: ROOT,
    encoding: 'utf8',
  }, options || {}));
}

function gitOut(args) {
  const res = git(args);
  return res.status === 0 ? (res.stdout || '').trim() : null;
}

function fail(message, hint) {
  console.error('✘ ' + message);
  if (hint) console.error('  ' + hint);
  process.exit(1);
}

function ok(message) { console.log('✔ ' + message); }
function info(message) { console.log('· ' + message); }

// ------------------------------------------------------------- 사전 점검

if (gitOut(['rev-parse', '--is-inside-work-tree']) !== 'true') {
  fail('아직 git 저장소가 아닙니다.',
    '먼저 아래를 실행하세요:\n' +
    '    cd ' + ROOT + '\n' +
    '    git init\n' +
    '    git add -A && git commit -m "로컬 스케줄러 최초 커밋"\n' +
    '    git remote add origin <두 PC가 함께 쓸 저장소 URL>\n' +
    '    git push -u origin main');
}

const remote = gitOut(['remote']);
if (!remote) {
  fail('원격 저장소(remote)가 없습니다.',
    'git remote add origin <저장소 URL> 로 등록한 뒤 다시 실행하세요.\n' +
    '  개인 저장소(private)를 권장합니다 — 프롬프트에 업무 내용이 들어갑니다.');
}

const branch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
const action = (process.argv[2] || 'sync').toLowerCase();

// jobs.json 이 .gitignore 로 빠지지 않았는지 확인 (data/* 예외 규칙이 깨진 경우)
if (fs.existsSync(JOBS_FILE)) {
  const ignored = git(['check-ignore', '-q', 'data/jobs.json']).status === 0;
  if (ignored) {
    fail('data/jobs.json 이 .gitignore 로 제외되어 있어 동기화되지 않습니다.',
      '.gitignore 에 "!data/jobs.json" 줄이 있는지 확인하세요.');
  }
}

// ------------------------------------------------------------- status

function showStatus() {
  console.log('브랜치 : ' + branch);
  const dirty = gitOut(['status', '--porcelain']);
  if (dirty) {
    console.log('');
    console.log('이 PC에서 바뀐 것:');
    dirty.split('\n').forEach(function (line) { console.log('  ' + line); });
  } else {
    console.log('이 PC에서 바뀐 것: 없음');
  }

  git(['fetch', '--quiet']);
  const counts = gitOut(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
  if (counts) {
    const parts = counts.split(/\s+/);
    console.log('');
    console.log('올릴 커밋 ' + parts[0] + '개 · 받을 커밋 ' + parts[1] + '개');
  }

  if (fs.existsSync(JOBS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
      const jobs = Array.isArray(data) ? data : data.jobs || [];
      console.log('');
      console.log('등록된 작업 ' + jobs.length + '개:');
      jobs.forEach(function (j) {
        console.log('  · ' + j.name + '  [' + j.schedule + ']' + (j.enabled ? '' : ' (비활성)'));
      });
    } catch (err) {
      console.log('(jobs.json 을 읽지 못했습니다: ' + err.message + ')');
    }
  }
}

if (action === 'status') {
  showStatus();
  process.exit(0);
}

// ------------------------------------------------------------- pull

info('원격에서 내려받는 중…');
const stashed = gitOut(['status', '--porcelain']) ? git(['stash', 'push', '-u', '-m', 'sync-temp']).status === 0 : false;

const pull = git(['pull', '--rebase', 'origin', branch], { stdio: 'pipe' });
if (pull.status !== 0) {
  const message = (pull.stderr || pull.stdout || '').trim();
  if (stashed) git(['stash', 'pop']);
  fail('내려받기에 실패했습니다.', message);
}
ok('내려받기 완료');

if (stashed) {
  const pop = git(['stash', 'pop']);
  if (pop.status !== 0) {
    fail('내 변경을 되돌리는 중 충돌이 났습니다.',
      '같은 작업을 두 PC에서 동시에 고친 경우입니다.\n' +
      '  git status 로 확인하고 data/jobs.json 을 직접 정리한 뒤\n' +
      '  git add data/jobs.json && git rebase --continue 를 실행하세요.');
  }
}

if (action === 'pull') {
  info('내려받기만 수행했습니다. 스케줄러가 1분 안에 새 작업 목록을 반영합니다.');
  process.exit(0);
}

// ------------------------------------------------------------- push

const dirty = gitOut(['status', '--porcelain']);
if (!dirty) {
  ok('올릴 변경이 없습니다. 두 PC가 같은 상태입니다.');
  process.exit(0);
}

console.log('');
console.log('올릴 변경:');
dirty.split('\n').forEach(function (line) { console.log('  ' + line); });

git(['add', '-A']);
const stamp = new Date().toLocaleString('ko-KR');
const commit = git(['commit', '-m', '스케줄러 설정 동기화 — ' + stamp]);
if (commit.status !== 0 && !/nothing to commit/i.test(commit.stdout || '')) {
  fail('커밋에 실패했습니다.', (commit.stderr || commit.stdout || '').trim());
}

const push = git(['push', 'origin', branch]);
if (push.status !== 0) {
  fail('올리기에 실패했습니다.', (push.stderr || push.stdout || '').trim());
}
ok('올리기 완료 — 다른 PC에서 npm run sync 를 실행하면 반영됩니다.');
