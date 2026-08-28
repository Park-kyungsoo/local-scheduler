'use strict';

/**
 * 부팅(로그인) 시 자동 시작 등록/해제.
 *   node scripts/install-service.js install | uninstall | status
 *
 * Windows : 시작프로그램 폴더에 VBS 런처를 넣는다. 관리자 권한이 필요 없고 콘솔 창도 뜨지 않는다.
 * macOS   : ~/Library/LaunchAgents 에 launchd plist 를 넣고 load 한다.
 * Linux   : systemd --user 서비스로 등록한다.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const NODE = process.execPath;
const LABEL = 'com.local.scheduler';
const APP_NAME = 'LocalScheduler';
const PORT = Number(process.env.SCHEDULER_PORT || 4321);

function log(msg) { console.log(msg); }
function ok(msg) { console.log('✔ ' + msg); }
function fail(msg) { console.error('✘ ' + msg); }

// ------------------------------------------------------------------ Windows

function winStartupDir() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
function winVbsPath() {
  return path.join(winStartupDir(), APP_NAME + '.vbs');
}

/** 포트를 잡고 있는 프로세스 ID. 없으면 null. */
function runningPid() {
  const res = spawnSync('powershell', ['-NoProfile', '-Command',
    '(Get-NetTCPConnection -LocalPort ' + PORT + " -State Listen -ErrorAction SilentlyContinue).OwningProcess"],
    { encoding: 'utf8' });
  const pid = (res.stdout || '').trim().split(/\s+/)[0];
  return pid || null;
}

function winInstall() {
  const dir = winStartupDir();
  if (!fs.existsSync(dir)) {
    fail('시작프로그램 폴더를 찾을 수 없습니다: ' + dir);
    process.exit(1);
  }
  // WScript.Shell 의 Run 세 번째 인자 0 = 창 숨김
  const vbs = [
    '\' 로컬 스케줄러 자동 시작 런처 (local-scheduler 가 생성)',
    'Set sh = CreateObject("WScript.Shell")',
    'sh.CurrentDirectory = "' + ROOT + '"',
    'sh.Run """' + NODE + '"" ""' + SERVER + '""", 0, False',
  ].join('\r\n');

  fs.writeFileSync(winVbsPath(), vbs, 'utf8');
  ok('시작프로그램에 등록했습니다: ' + winVbsPath());
  log('  다음 로그인부터 창 없이 자동 실행됩니다.');

  // 등록만 하고 끝내면 "지금 당장" 은 여전히 안 돌아간다. 바로 띄워준다.
  const already = runningPid();
  if (already) {
    log('');
    log('· 이미 실행 중입니다 (PID ' + already + '). 새로 띄우지 않았습니다.');
    log('  옮긴 폴더로 바꾸려면: npm run restart');
    return;
  }

  const res = spawnSync('wscript', ['//Nologo', winVbsPath()], { encoding: 'utf8', timeout: 15000 });
  if (res.error) {
    log('');
    log('· 지금 바로 시작하지는 못했습니다: ' + res.error.message);
    log('  다음 로그인 때 자동으로 시작됩니다.');
    return;
  }

  // 비동기로 띄우므로 포트가 열릴 때까지 잠깐 기다린다.
  const deadline = Date.now() + 10000;
  let pid = null;
  while (Date.now() < deadline) {
    pid = runningPid();
    if (pid) break;
    spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500'], { stdio: 'ignore' });
  }

  log('');
  if (pid) {
    ok('지금 백그라운드에서 실행 중입니다 (PID ' + pid + ')');
    log('  대시보드: http://127.0.0.1:' + PORT);
  } else {
    log('· 시작 신호는 보냈지만 포트가 아직 열리지 않았습니다.');
    log('  잠시 후 npm run service-status 로 확인하세요.');
  }
}

function winUninstall() {
  const file = winVbsPath();
  if (fs.existsSync(file)) {
    fs.rmSync(file);
    ok('시작프로그램 등록을 해제했습니다.');
  } else {
    log('· 등록된 항목이 없습니다.');
  }

  // 돌고 있던 것도 함께 내린다 (폴더를 옮길 때 옛 경로가 계속 도는 것을 막는다).
  const pid = runningPid();
  if (pid) {
    spawnSync('powershell', ['-NoProfile', '-Command', 'Stop-Process -Id ' + pid + ' -Force'], { stdio: 'ignore' });
    ok('실행 중이던 스케줄러를 종료했습니다 (PID ' + pid + ')');
  }
}

function winStatus() {
  const file = winVbsPath();
  log(fs.existsSync(file) ? '● 자동 시작 등록됨 — ' + file : '○ 자동 시작이 등록되어 있지 않습니다.');
  // 이름이 node.exe 인 다른 프로그램과 헷갈리지 않도록 리스닝 포트로 확인한다.
  const pid = runningPid();
  log(pid ? '● 실행 중 — 포트 ' + PORT + ' (PID ' + pid + ')' : '○ 현재 실행 중이 아닙니다.');
  if (pid) log('  대시보드: http://127.0.0.1:' + PORT);
}

/** 자동 시작 등록과 무관하게, 지금 이 폴더의 스케줄러를 창 없이 띄운다. */
function winStart() {
  const already = runningPid();
  if (already) {
    log('· 이미 실행 중입니다 (PID ' + already + ')');
    log('  이 폴더로 바꾸려면: npm run restart');
    return;
  }
  const res = spawnSync('powershell', ['-NoProfile', '-Command',
    "Start-Process -FilePath '" + NODE + "' -ArgumentList '" + SERVER + "' " +
    "-WorkingDirectory '" + ROOT + "' -WindowStyle Hidden"], { encoding: 'utf8' });
  if (res.status !== 0) {
    fail('시작하지 못했습니다.', (res.stderr || '').trim());
  }

  const deadline = Date.now() + 10000;
  let pid = null;
  while (Date.now() < deadline) {
    pid = runningPid();
    if (pid) break;
    spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500'], { stdio: 'ignore' });
  }
  if (pid) {
    ok('백그라운드에서 실행 중입니다 (PID ' + pid + ')');
    log('  대시보드: http://127.0.0.1:' + PORT);
  } else {
    fail('시작 신호는 보냈지만 포트가 열리지 않았습니다.',
      'npm start 로 직접 실행해 오류 메시지를 확인하세요.');
  }
}

function winStop() {
  const pid = runningPid();
  if (!pid) {
    log('· 실행 중이 아닙니다.');
    return;
  }
  spawnSync('powershell', ['-NoProfile', '-Command', 'Stop-Process -Id ' + pid + ' -Force'], { stdio: 'ignore' });
  ok('종료했습니다 (PID ' + pid + ')');
}

function winRestart() {
  winStop();
  spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 800'], { stdio: 'ignore' });
  winStart();
}

// -------------------------------------------------------------------- macOS

function macPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
}

function macInstall() {
  const dir = path.dirname(macPlistPath());
  fs.mkdirSync(dir, { recursive: true });
  const logDir = path.join(ROOT, 'data');
  fs.mkdirSync(logDir, { recursive: true });

  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>' + LABEL + '</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>' + NODE + '</string>',
    '    <string>' + SERVER + '</string>',
    '  </array>',
    '  <key>WorkingDirectory</key>',
    '  <string>' + ROOT + '</string>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    '  <string>' + path.join(logDir, 'scheduler.out.log') + '</string>',
    '  <key>StandardErrorPath</key>',
    '  <string>' + path.join(logDir, 'scheduler.err.log') + '</string>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    '    <string>' + (process.env.PATH || '/usr/local/bin:/usr/bin:/bin') + '</string>',
    '  </dict>',
    '</dict>',
    '</plist>',
  ].join('\n');

  fs.writeFileSync(macPlistPath(), plist, 'utf8');

  // 이미 로드되어 있으면 먼저 내린다.
  spawnSync('launchctl', ['bootout', 'gui/' + process.getuid() + '/' + LABEL], { stdio: 'ignore' });
  const res = spawnSync('launchctl', ['bootstrap', 'gui/' + process.getuid(), macPlistPath()], { encoding: 'utf8' });
  if (res.status !== 0) {
    // 구버전 macOS 폴백
    spawnSync('launchctl', ['load', '-w', macPlistPath()], { stdio: 'inherit' });
  }
  ok('launchd 에 등록했습니다: ' + macPlistPath());
  log('  로그인 시 자동 실행되고, 죽으면 자동으로 다시 뜹니다 (KeepAlive).');
}

function macUninstall() {
  spawnSync('launchctl', ['bootout', 'gui/' + process.getuid() + '/' + LABEL], { stdio: 'ignore' });
  spawnSync('launchctl', ['unload', '-w', macPlistPath()], { stdio: 'ignore' });
  if (fs.existsSync(macPlistPath())) {
    fs.rmSync(macPlistPath());
    ok('launchd 등록을 해제했습니다.');
  } else {
    log('· 등록된 항목이 없습니다.');
  }
}

function macStatus() {
  log(fs.existsSync(macPlistPath()) ? '● 자동 시작 등록됨 — ' + macPlistPath() : '○ 자동 시작이 등록되어 있지 않습니다.');
  const res = spawnSync('launchctl', ['list', LABEL], { encoding: 'utf8' });
  log(res.status === 0 ? '● launchd 에 로드되어 있습니다.\n' + res.stdout.trim() : '○ launchd 에 로드되어 있지 않습니다.');
}

// -------------------------------------------------------------------- Linux

function linuxUnitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'local-scheduler.service');
}

function linuxInstall() {
  fs.mkdirSync(path.dirname(linuxUnitPath()), { recursive: true });
  const unit = [
    '[Unit]',
    'Description=Local Scheduler',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=' + NODE + ' ' + SERVER,
    'WorkingDirectory=' + ROOT,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
  ].join('\n');
  fs.writeFileSync(linuxUnitPath(), unit, 'utf8');
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  spawnSync('systemctl', ['--user', 'enable', '--now', 'local-scheduler.service'], { stdio: 'inherit' });
  ok('systemd 사용자 서비스로 등록했습니다: ' + linuxUnitPath());
  log('  로그인 없이도 켜두려면: sudo loginctl enable-linger ' + os.userInfo().username);
}

function linuxUninstall() {
  spawnSync('systemctl', ['--user', 'disable', '--now', 'local-scheduler.service'], { stdio: 'ignore' });
  if (fs.existsSync(linuxUnitPath())) {
    fs.rmSync(linuxUnitPath());
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    ok('systemd 등록을 해제했습니다.');
  } else {
    log('· 등록된 항목이 없습니다.');
  }
}

function linuxStatus() {
  log(fs.existsSync(linuxUnitPath()) ? '● 유닛 파일 있음 — ' + linuxUnitPath() : '○ 유닛 파일이 없습니다.');
  spawnSync('systemctl', ['--user', 'status', 'local-scheduler.service', '--no-pager'], { stdio: 'inherit' });
}

// -------------------------------------------------------------------- 진입점

// macOS·Linux 는 launchd / systemd 가 시작·정지를 이미 담당한다.
function macStart() { spawnSync('launchctl', ['kickstart', 'gui/' + process.getuid() + '/' + LABEL], { stdio: 'inherit' }); ok('시작 요청을 보냈습니다.'); }
function macStop() { spawnSync('launchctl', ['kill', 'SIGTERM', 'gui/' + process.getuid() + '/' + LABEL], { stdio: 'inherit' }); ok('종료 요청을 보냈습니다.'); }
function macRestart() { spawnSync('launchctl', ['kickstart', '-k', 'gui/' + process.getuid() + '/' + LABEL], { stdio: 'inherit' }); ok('재시작 요청을 보냈습니다.'); }

function linuxStart() { spawnSync('systemctl', ['--user', 'start', 'local-scheduler.service'], { stdio: 'inherit' }); }
function linuxStop() { spawnSync('systemctl', ['--user', 'stop', 'local-scheduler.service'], { stdio: 'inherit' }); }
function linuxRestart() { spawnSync('systemctl', ['--user', 'restart', 'local-scheduler.service'], { stdio: 'inherit' }); }

const HANDLERS = {
  win32: {
    install: winInstall, uninstall: winUninstall, status: winStatus,
    start: winStart, stop: winStop, restart: winRestart,
  },
  darwin: {
    install: macInstall, uninstall: macUninstall, status: macStatus,
    start: macStart, stop: macStop, restart: macRestart,
  },
  linux: {
    install: linuxInstall, uninstall: linuxUninstall, status: linuxStatus,
    start: linuxStart, stop: linuxStop, restart: linuxRestart,
  },
};

const action = (process.argv[2] || 'install').toLowerCase();
const handler = HANDLERS[process.platform];

if (!handler) {
  fail('지원하지 않는 플랫폼입니다: ' + process.platform);
  process.exit(1);
}
if (!handler[action]) {
  fail('알 수 없는 명령입니다: ' + action);
  log('사용법: node scripts/install-service.js [install|uninstall|status|start|stop|restart]');
  process.exit(1);
}

log('플랫폼: ' + process.platform + ' · Node: ' + NODE);
log('스케줄러 경로: ' + SERVER);
log('');
handler[action]();
