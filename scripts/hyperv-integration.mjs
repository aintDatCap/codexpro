import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
        assert.ok(instance.hyperv?.vmId && instance.hyperv?.ownershipId, 'Hyper-V identity must be persisted');
        const vmId = instance.hyperv.vmId;
        const ownershipId = instance.hyperv.ownershipId;
        const securityScript = `
$ErrorActionPreference = 'Stop'
Import-Module Hyper-V
$vm = Get-VM -Id ([Guid]'${vmId}')
if ($vm.Notes -cne 'CodexPro:${ownershipId}') { throw 'Integration VM ownership mismatch.' }
$protector = [byte[]](Get-VMKeyProtector -VM $vm)
$security = Get-VMSecurity -VM $vm
@{ tpmEnabled=[bool]$security.TpmEnabled; keyProtectorBytes=[int]$protector.Length } | ConvertTo-Json -Compress
`;
        const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const securityResult = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(securityScript, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
        assert.equal(securityResult.status, 0, securityResult.stderr || securityResult.stdout);
        const security = JSON.parse(securityResult.stdout.replace(/^\\uFEFF/, '').trim());
        assert.equal(security.tpmEnabled, true, 'Disposable Hyper-V VM must have virtual TPM enabled');
        assert.ok(security.keyProtectorBytes > 0, 'Disposable Hyper-V VM must have a key protector');
        assert.equal((await manager.inspectImage(image.name)).sha256, image.sha256);
      } finally { await manager.destroyInstance(instance.id); }
      assert.equal((await manager.listInstances()).length, 0);
      assert.equal((await manager.inspectImage(image.name)).sha256, image.sha256);
      canDelete = true;
      console.log('Hyper-V integration passed: standalone import, differencing VHDX, Generation 2 start/status/destroy, vTPM 2.0/key protector, unchanged base.');
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
