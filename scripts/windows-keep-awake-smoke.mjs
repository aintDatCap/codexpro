import assert from 'node:assert/strict';
import { startWindowsKeepAwake } from './windows-keep-awake.mjs';

if (process.platform === 'win32') {
  const guard = await startWindowsKeepAwake();
  assert.ok(guard.pid > 0, 'Power request helper must start');
  await guard.stop();
  await guard.stop();
  console.log('windows keep-awake smoke passed');
} else {
  await assert.rejects(startWindowsKeepAwake(), /Windows/);
  console.log('windows keep-awake smoke skipped on non-Windows');
}
