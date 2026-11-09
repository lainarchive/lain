/**
 * Does the AppContainer confine the network?
 *
 * Drives the real supervisor with a real spec twice - once plain, once inside
 * the container - and reports the difference between the two outputs. The tool
 * is handed over `-e` so no file has to be readable for the run to start, and
 * every case prints a marker first: an empty output is the failure mode that has
 * already produced two meaningless results on this project, and it is reported
 * as an absence rather than as a denial.
 *
 *   node tools/experiments/appcontainer-network-probe.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildHelperSpec } from '../../src/exec/job.mjs';
import { DEFAULT_HELPER, DEFAULT_PYTHON } from '../../src/exec/job.mjs';

const TOOL = `
const net = require('node:net');
const dns = require('node:dns');
const PORT = Number(process.argv[1]);
const results = [];
function tcp(host, port, label) {
  return new Promise((done) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const finish = (verdict) => {
      results.push(label + '=' + verdict + ' in ' + (Date.now() - started) + 'ms');
      socket.destroy();
      done();
    };
    socket.setTimeout(4000);
    socket.on('connect', () => finish('CONNECTED'));
    socket.on('timeout', () => finish('TIMEOUT'));
    socket.on('error', (e) => finish('ERROR:' + e.code));
  });
}
function lookup(host, label) {
  return new Promise((done) => {
    dns.lookup(host, (e, addr) => {
      results.push(label + '=' + (e ? 'ERROR:' + e.code : 'RESOLVED:' + addr));
      done();
    });
  });
}
(async () => {
  console.log('NET-MARKER');
  await tcp('127.0.0.1', PORT, 'loopback');
  await tcp('93.184.216.34', 80, 'internet-ip');
  await lookup('example.com', 'dns');
  console.log(results.join(' | '));
})();
`;

/** @param {number} port @returns {Promise<import('node:net').Server>} */
function listen(port) {
  return new Promise((done) => {
    const server = createServer((socket) => socket.end());
    server.listen(port, '127.0.0.1', () => done(server));
  });
}

/** @param {import('node:net').Server} server */
function portOf(server) {
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

/** @param {number} port @param {string|undefined} container */
function runCase(port, container) {
  const scratch = mkdtempSync(join(tmpdir(), 'lain-net-'));
  /** @type {Parameters<typeof buildHelperSpec>[0]} */
  const spec = {
    command: process.execPath,
    args: ['-e', TOOL, String(port)],
    cwd: scratch,
    outputBytes: 65_536,
    supervisorMs: 30_000,
    expect_marker: 'NET-MARKER',
    limits: { job_ms: 30_000 },
  };
  if (container) {
    spec.container = container;
    spec.env = {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
      COMSPEC: process.env.COMSPEC ?? '',
      PATHEXT: process.env.PATHEXT ?? '',
      TEMP: scratch,
      TMP: scratch,
      LAIN_WORKSPACE: scratch,
      LOCALAPPDATA: join(scratch, '.localappdata'),
    };
    spawnSync('icacls', [scratch, '/grant', `*${SID()}:(OI)(CI)M`], { windowsHide: true });
  }
  const specPath = join(scratch, 'spec.json');
  const resultPath = join(scratch, 'result.json');
  writeFileSync(specPath, JSON.stringify(buildHelperSpec(spec, 30_000), null, 2));
  spawnSync(DEFAULT_PYTHON, [DEFAULT_HELPER, '--spec', specPath, '--result', resultPath],
    { encoding: 'utf8', windowsHide: true });
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  return { result, scratch };
}

function SID() {
  return spawnSync(DEFAULT_PYTHON, [DEFAULT_HELPER, '--print-container-sid'],
    { encoding: 'utf8', windowsHide: true }).stdout.trim();
}

const server = await listen(0);
const port = portOf(server);
console.log(`listener on 127.0.0.1:${port}`);
console.log(`container sid ${SID()}`);

const plain = runCase(port, undefined);
const boxed = runCase(port, 'lain.tool.runner');
server.close();

for (const [label, run] of /** @type {[string, ReturnType<typeof runCase>][]} */ ([
  ['plain', plain], ['container', boxed],
])) {
  const { result } = run;
  const verdict = result.ok ? 'ok' : `not ok (${result.fatal ?? result.kill_reason})`;
  console.log(`\n--- ${label}: ${verdict} exit=${result.exit_code} ---`);
  console.log(`stdout: ${JSON.stringify((result.stdout ?? '').trim())}`);
  console.log(`stderr: ${JSON.stringify((result.stderr ?? '').slice(0, 200))}`);
  const notes = /** @type {{name: string}[]} */ (result.notifications ?? []);
  console.log(`notifications: ${JSON.stringify(notes.map((note) => note.name))}`);
  if (!(result.stdout ?? '').includes('NET-MARKER')) {
    console.log(`${label.toUpperCase()}_MARKER_MISSING: this result says nothing about the network`);
  }
}
