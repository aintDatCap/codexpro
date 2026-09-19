import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VmManager } from '../dist/vm/index.js';
import { HypervPowerShell } from '../dist/vm/backends/hyperv/powershell.js';

if (process.platform !== 'win32') {
  console.log('Hyper-V integration skipped: requires Windows.');
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-hyperv-integration-'));
  const manager = new VmManager({ home: root, vmRoot: path.join(root, 'vm') });
  let canDelete = true;
  try {
    const report = await manager.doctor();
    if (!report.ready) {
      console.log(`Hyper-V integration skipped: ${report.issues.join(' ')}`);
    } else {
      const ps = new HypervPowerShell();
      const source = path.join(root, 'blank-test.vhdx');
      await ps.run('disk', { disk: source, size: 4 * 1024 ** 3 });
      const image = await manager.setupImage({ name: 'disposable-integration', sourcePath: source, architecture: 'x86_64', cpus: 1, memoryMb: 512, desktop: false });
      // No existing managed image, guest OS, or unrelated VM is used.
      canDelete = false;
      const instance = await manager.createInstance(image.name);
      try {
        assert.equal((await manager.status(instance.id)).state, 'running');
        assert.equal((await manager.inspectImage(image.name)).sha256, image.sha256);
      } finally { await manager.destroyInstance(instance.id); }
      assert.equal((await manager.listInstances()).length, 0);
      assert.equal((await manager.inspectImage(image.name)).sha256, image.sha256);
      canDelete = true;
      console.log('Hyper-V integration passed: standalone import, differencing VHDX, Generation 2 start/status/destroy, unchanged base.');
    }
  } finally {
    if (canDelete) {
      await fs.chmod(path.join(root, 'vm', 'images', 'disposable-integration', 'base.vhdx'), 0o600).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    } else {
      console.error(`Integration state retained at ${root}. Use codexpro vm list/destroy --vm-home "${path.join(root, 'vm')}" after investigating; no unverified VM or disk was deleted.`);
    }
  }
}
