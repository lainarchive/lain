/**
 * Host capability probe (M-1 Step 3).
 *
 * Records what this machine actually is, in a versioned shape, so that later
 * admission decisions rest on measurements rather than on remembered hardware.
 *
 * Rules this module follows, and why:
 *
 * - Only necessary fields are collected. No usernames, no personal file paths,
 *   no installed-software inventory. The output is a local artifact.
 * - Optional data is `null` with a reason, never guessed. A missing GPU reading
 *   must be distinguishable from a GPU that is present and idle, because one is
 *   "unknown" and the other is "free".
 * - No dependency is added to obtain any of it. GPU data comes from
 *   `nvidia-smi` when that binary already exists; if it does not, the field is
 *   null and the probe still succeeds.
 * - No performance claim is made. The probe measures capacity; it does not
 *   benchmark.
 *
 * `collect()` touches the machine. Everything else in this module is pure and
 * therefore testable with fixtures.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { cpus, freemem, platform, release, totalmem } from 'node:os';

/**
 * A probe record. Field meanings are fixed by `PROBE_SCHEMA_VERSION`.
 *
 * @typedef {object} ProbeRecord
 * @property {number} probe_schema_version
 * @property {string} probed_at
 * @property {{platform: string, release: string, arch: string}} os
 * @property {{node_version: string, modules_abi: string|null}} runtime
 * @property {{model: string, logical_count: number, source: string}} cpu
 * @property {{total_bytes: Measurement, free_bytes: Measurement}} memory
 * @property {GpuSection} gpu
 * @property {DiskSection} disk
 * @property {string[]} capabilities
 */

/**
 * The GPU section of a probe record. Optional fields are absent when the GPU was
 * not measured, so `free_mib === undefined` means "not known", never "zero".
 *
 * @typedef {object} GpuSection
 * @property {string} status
 * @property {string} source
 * @property {string} [reason]
 * @property {string|null} [name]
 * @property {number|null} [total_mib]
 * @property {number|null} [used_mib]
 * @property {number|null} [free_mib]
 * @property {number|null} [utilization_percent]
 * @property {number|null} [temperature_c]
 */

/**
 * The disk section of a probe record.
 *
 * @typedef {object} DiskSection
 * @property {string} status
 * @property {string} source
 * @property {string} [reason]
 * @property {number|null} total_bytes
 * @property {number|null} free_bytes
 */
/** Shape version of the probe record. Bump when a field's meaning changes. */
export const PROBE_SCHEMA_VERSION = 1;

/** Timeout for the optional GPU probe. A hung external tool must not hang Lain. */
const GPU_TIMEOUT_MS = 3000;

/**
 * @typedef {object} Measurement
 * @property {number|null} value
 * @property {'measured'|'unavailable'|'unsupported'} status
 * @property {string} source
 * @property {string} [reason]
 */

/**
 * A measured number, or an explicit refusal to invent one.
 *
 * @param {number} value
 * @param {string} source
 * @returns {Measurement}
 */
export function measured(value, source) {
  return { value, status: 'measured', source };
}

/**
 * @param {string} reason
 * @param {string} source
 * @returns {Measurement}
 */
export function unavailable(reason, source) {
  return { value: null, status: 'unavailable', source, reason };
}

/**
 * @param {string} reason
 * @param {string} source
 * @returns {Measurement}
 */
export function unsupported(reason, source) {
  return { value: null, status: 'unsupported', source, reason };
}

/**
 * Parse `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` output.
 *
 * Kept separate from the call so the parsing is testable without a GPU. A
 * malformed line yields `null` for that field rather than a zero, because
 * "0 MiB free" and "could not read it" lead to opposite admission decisions.
 *
 * @param {string} stdout
 * @returns {{ name: string, total_mib: number, used_mib: number, free_mib: number, utilization_percent: number, temperature_c: number }|null}
 */
export function parseNvidiaSmiCsv(stdout) {
  const line = String(stdout ?? '').split(/\r?\n/).find((candidate) => candidate.trim() !== '');
  if (line === undefined) return null;
  const parts = line.split(',').map((part) => part.trim());
  if (parts.length < 6) return null;
  const numbers = parts.slice(1, 6).map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : null;
  });
  if (numbers.some((value) => value === null)) return null;
  const [total, used, free, utilization, temperature] = /** @type {[number, number, number, number, number]} */ (numbers);
  return {
    name: parts[0] ?? 'unknown',
    total_mib: total,
    used_mib: used,
    free_mib: free,
    utilization_percent: utilization,
    temperature_c: temperature,
  };
}

/**
 * Probe the GPU without adding a dependency.
 *
 * @param {object} [options]
 * @param {(file: string) => boolean} [options.fileExists]
 * @param {(stdout: string) => unknown} [options.parse]
 * @returns {Measurement & { detail?: unknown }}
 */
export function probeGpu(options = {}) {
  const fileExists = options.fileExists ?? existsSync;
  const parse = options.parse ?? parseNvidiaSmiCsv;
  const queries = ['nvidia-smi', 'nvidia-smi.exe'];

  let binary = null;
  for (const candidate of queries) {
    try {
      if (fileExists(candidate)) {
        binary = candidate;
        break;
      }
    } catch {
      // A thrown existsSync is not a reason to fail the probe; keep looking.
    }
  }

  if (binary === null) {
    // A probe must be testable without a GPU. When the caller cannot supply a
    // `fileExists`, honour an explicit opt-out so a test (or a machine where the
    // tool must not be invoked) sees the same "not measured" path as a machine
    // without the tool. This is a probe control, not a security boundary.
    if (process.env.LAIN_DISABLE_GPU_PROBE === '1') {
      return /** @type {Measurement} */ (
        unavailable('GPU probing was disabled for this run, so GPU memory was not measured', 'nvidia-smi')
      );
    }
    // Not "no GPU": we cannot tell whether one exists without the tool.
    try {
      execFileSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits'], {
        timeout: GPU_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      binary = 'nvidia-smi';
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error).code;
      const reason = code === 'ENOENT'
        ? 'nvidia-smi is not on PATH, so GPU memory could not be measured'
        : 'nvidia-smi exists but did not answer, so GPU memory could not be measured';
      return /** @type {Measurement} */ (unavailable(reason, 'nvidia-smi'));
    }
  }

  try {
    const stdout = execFileSync(binary, [
      '--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu',
      '--format=csv,noheader,nounits',
    ], { timeout: GPU_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const detail = parse(stdout);
    if (detail === null) {
      return /** @type {Measurement} */ (unavailable('nvidia-smi returned output that could not be parsed', 'nvidia-smi'));
    }
    return { ...measured(1, 'nvidia-smi'), detail };
  } catch (error) {
    return /** @type {Measurement} */ (
      unavailable(`nvidia-smi failed: ${/** @type {Error} */ (error).message}`, 'nvidia-smi')
    );
  }
}

/**
 * Free bytes on the volume holding a path.
 *
 * `node:fs.statfsSync` may be unavailable on some builds, which is exactly the
 * case the status field exists for.
 *
 * @param {string} path
 * @returns {Measurement & { detail?: { total_bytes: number, free_bytes: number } }}
 */
export function probeDisk(path) {
  try {
    if (typeof statfsSync !== 'function') {
      return /** @type {Measurement} */ (unsupported('fs.statfsSync is not available in this Node build', 'node:fs'));
    }
    const stats = statfsSync(path);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(total) || !Number.isFinite(free)) {
      return /** @type {Measurement} */ (unavailable('statfs returned non-finite values', 'node:fs'));
    }
    return { ...measured(free, 'node:fs.statfsSync'), detail: { total_bytes: total, free_bytes: free } };
  } catch (error) {
    return /** @type {Measurement} */ (
      unavailable(`statfs failed: ${/** @type {Error} */ (error).message}`, 'node:fs')
    );
  }
}

/**
 * Build the probe record from already-collected values.
 *
 * Kept pure so tests can pass fixtures instead of touching the machine.
 *
 * @param {object} input
 * @param {string} input.platform
 * @param {string} input.release
 * @param {string} input.arch
 * @param {string} input.node_version
 * @param {string[]} input.cpu_model_parts
 * @param {number} input.logical_cpu_count
 * @param {number|null} input.total_memory_bytes
 * @param {number|null} input.free_memory_bytes
 * @param {Measurement & {detail?: unknown}} input.gpu
 * @param {Measurement & {detail?: unknown}} input.disk
 * @param {string[]} input.capabilities
 * @returns {ProbeRecord}
 */
export function buildRecord(input) {
  const gpuDetail = /** @type {{ name?: string, total_mib?: number, used_mib?: number, free_mib?: number, utilization_percent?: number, temperature_c?: number }|undefined} */ (
    input.gpu.detail
  );
  const diskDetail = /** @type {{ total_bytes?: number, free_bytes?: number }|undefined} */ (input.disk.detail);

  const totalMemory = input.total_memory_bytes === null
    ? unavailable('total memory could not be read', 'node:os.totalmem')
    : measured(input.total_memory_bytes, 'node:os.totalmem');
  const freeMemory = input.free_memory_bytes === null
    ? unavailable('free memory could not be read', 'node:os.freemem')
    : measured(input.free_memory_bytes, 'node:os.freemem');

  return {
    probe_schema_version: PROBE_SCHEMA_VERSION,
    probed_at: new Date().toISOString(),
    os: { platform: input.platform, release: input.release, arch: input.arch },
    runtime: { node_version: input.node_version, modules_abi: process.versions.modules ?? null },
    cpu: {
      model: input.cpu_model_parts.join(' ').replace(/\s+/g, ' ').trim(),
      logical_count: input.logical_cpu_count,
      source: 'node:os.cpus',
    },
    memory: { total_bytes: totalMemory, free_bytes: freeMemory },
    gpu: {
      status: input.gpu.status,
      source: input.gpu.source,
      ...(input.gpu.reason === undefined ? {} : { reason: input.gpu.reason }),
      ...(gpuDetail === undefined ? {} : {
        name: gpuDetail.name ?? null,
        total_mib: gpuDetail.total_mib ?? null,
        used_mib: gpuDetail.used_mib ?? null,
        free_mib: gpuDetail.free_mib ?? null,
        utilization_percent: gpuDetail.utilization_percent ?? null,
        temperature_c: gpuDetail.temperature_c ?? null,
      }),
    },
    disk: {
      status: input.disk.status,
      source: input.disk.source,
      ...(input.disk.reason === undefined ? {} : { reason: input.disk.reason }),
      total_bytes: diskDetail?.total_bytes ?? null,
      free_bytes: diskDetail?.free_bytes ?? null,
    },
    capabilities: input.capabilities,
  };
}

/**
 * Collect a probe record from this machine.
 *
 * @param {object} [options]
 * @param {string} [options.volume] path whose volume is measured
 * @param {() => Measurement & {detail?: unknown}} [options.gpuProbe]
 * @param {(path: string) => Measurement & {detail?: unknown}} [options.diskProbe]
 * @returns {ProbeRecord}
 */
export function collect(options = {}) {
  const volume = options.volume ?? process.cwd();
  const gpuProbe = options.gpuProbe ?? probeGpu;
  const diskProbe = options.diskProbe ?? probeDisk;

  let totalMemoryBytes = null;
  let freeMemoryBytes = null;
  try {
    totalMemoryBytes = totalmem();
  } catch {
    totalMemoryBytes = null;
  }
  try {
    freeMemoryBytes = freemem();
  } catch {
    freeMemoryBytes = null;
  }

  const cpuList = cpus();
  const capabilities = [];
  capabilities.push(`sqlite:${describeSqlite()}`);

  return buildRecord({
    platform: platform(),
    release: release(),
    arch: process.arch,
    node_version: process.versions.node,
    cpu_model_parts: cpuList.length > 0 ? [String(cpuList[0]?.model ?? 'unknown')] : ['unknown'],
    logical_cpu_count: cpuList.length,
    total_memory_bytes: totalMemoryBytes,
    free_memory_bytes: freeMemoryBytes,
    gpu: gpuProbe(),
    disk: diskProbe(volume),
    capabilities,
  });
}

/** @returns {string} */
function describeSqlite() {
  try {
    // Dynamic import is unnecessary: the module is stable, and Step 2 depends on it.
    const { DatabaseSync } = /** @type {any} */ (globalThis).process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const row = db.prepare('select sqlite_version() as v').get();
    db.close();
    return String(row.v);
  } catch {
    return 'unavailable';
  }
}
