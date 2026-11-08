/**
 * The host probe as a command.
 *
 * `npm run probe` prints the same record `collect()` returns, so a measurement
 * can be recorded as evidence instead of described from memory. It writes to
 * stdout only and touches nothing else.
 */

import { collect, PROBE_SCHEMA_VERSION } from '../src/host/probe.mjs';
import { isEntryPoint } from './check/lib/report.mjs';

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2)) {
  const asText = argv.includes('--text');
  const volumeIndex = argv.indexOf('--volume');
  const volume = volumeIndex >= 0 ? argv[volumeIndex + 1] : undefined;

  const record = collect(volume === undefined ? {} : { volume });

  if (asText) {
    const lines = [
      `probe schema ${PROBE_SCHEMA_VERSION}  probed_at ${record.probed_at}`,
      `os          ${record.os.platform} ${record.os.release} ${record.os.arch}`,
      `runtime     node ${record.runtime.node_version} (modules ${record.runtime.modules_abi})`,
      `cpu         ${record.cpu.model} x${record.cpu.logical_count}`,
      `memory      total ${record.memory.total_bytes.value} bytes, free ${record.memory.free_bytes.value} bytes`,
      `gpu         ${record.gpu.status}${record.gpu.free_mib === undefined ? '' : ` — ${record.gpu.name}, ${record.gpu.free_mib} MiB free of ${record.gpu.total_mib}`}`,
      `disk        ${record.disk.status} — ${record.disk.free_bytes} bytes free of ${record.disk.total_bytes}`,
      `capabilities ${record.capabilities.join(' ')}`,
    ];
    for (const line of lines) process.stdout.write(`${line}\n`);
    return 0;
  }

  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  process.exit(main());
}
