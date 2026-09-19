import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VmManager, backendForPlatform, parseImageManifest, parseInstanceRecord } from '../dist/vm/index.js';
import { HypervBackend, hypervName, hypervState } from '../dist/vm/backends/hyperv/hypervBackend.js';
import { HypervPowerShell, hypervScripts } from '../dist/vm/backends/hyperv/powershell.js';

assert.equal(backendForPlatform('win32'), 'hyperv');
assert.equal(backendForPlatform('linux'), 'qemu');
assert.equal(backendForPlatform('darwin'), 'qemu');
assert.throws(() => backendForPlatform('freebsd'), /Unsupported/);
assert.throws(() => new VmManager({ platform: 'win32', qemu: 'unused' }), /Linux\/macOS/);
assert.equal(new VmManager({ platform: 'linux' }).backend, 'qemu');
assert.equal(new VmManager({ platform: 'darwin' }).backend, 'qemu');
assert.equal(hypervState('Running'), 'running');
for (const state of ['Off', 'Saved', 'Paused']) assert.equal(hypervState(state), 'stopped');
for (const state of ['Starting', 'Stopping', 'Saving']) assert.equal(hypervState(state), 'starting');
assert.equal(hypervState('Critical'), 'failed');
assert.throws(() => hypervName('../unsafe', 'a'.repeat(64)), /identity/);
assert.match(hypervName('vm-0123456789abcdef', 'a'.repeat(64)), /^CodexPro-vm-[a-f0-9]{16}-[a-f0-9]{16}$/);
assert.match(hypervScripts.create, /New-VM .* -Generation 2 /);
assert.match(hypervScripts.create, /Set-VMKeyProtector -VM \$vm -NewLocalKeyProtector/);
assert.match(hypervScripts.create, /Enable-VMTPM -VM \$vm/);
assert.match(hypervScripts.create, /Get-VMSecurity -VM \$vm\)\.TpmEnabled/);
assert.ok(hypervScripts.create.indexOf('Set-VMKeyProtector') < hypervScripts.create.indexOf('Enable-VMTPM'));
assert.ok(hypervScripts.create.indexOf('Enable-VMTPM') < hypervScripts.create.indexOf('Add-VMDvdDrive'));
for (const cmdlet of ['Set-VMKeyProtector', 'Get-VMKeyProtector', 'Enable-VMTPM', 'Get-VMSecurity']) assert.ok(hypervScripts.doctor.includes(cmdlet));
assert.match(hypervScripts.create, /Add-VMDvdDrive -VM \$vm -Path \$p.iso -Passthru/);
assert.match(hypervScripts.create, /Set-VMFirmware -VM \$vm -FirstBootDevice \$dvd/);
assert.match(hypervScripts.create, /Disconnect-VMNetworkAdapter/);
assert.doesNotMatch(hypervScripts.create, /-SwitchName/);
assert.match(hypervScripts.disk, /-ParentPath \$p.parent -Differencing/);
assert.match(hypervScripts.disk, /-SizeBytes .* -Dynamic/);
assert.match(hypervScripts.destroy, /ownership could not be verified/);
assert.ok(hypervScripts.destroy.indexOf('ownership could not be verified') < hypervScripts.destroy.indexOf('Stop-VM'));
assert.ok(hypervScripts.destroy.indexOf('Stop-VM') < hypervScripts.destroy.indexOf('Remove-VM'));
assert.doesNotMatch(hypervScripts.destroy, /-Name|Merge-VHD|Remove-Item/);

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-hyperv-smoke-'));
const calls = [];
const vms = new Map();
let counter = 0;
let failStart = false;
let failTpm = false;
let lostCreateResponse = false;
let failDestroy = false;
let stopInstaller = false;
const executor = {
  async run(binary, args, options) {
    assert.match(binary, /powershell\.exe$/i);
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 600_000);
    assert.ok(args.includes('-NoProfile') && args.includes('-NonInteractive'));
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    const payload = JSON.parse(Buffer.from(script.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString('utf8'));
    const operation = Object.keys(hypervScripts).find(key => script.includes(hypervScripts[key]));
    assert.ok(operation, script);
    calls.push({ operation, payload, script });
    const result = value => ({ stdout: JSON.stringify(value), stderr: '', exitCode: 0 });
    const error = message => ({ stdout: '', stderr: message, exitCode: 1 });
    if (operation === 'doctor') return result({ module: true, commands: true, service: true, hypervisor: true, permission: true, console: true });
    if (operation === 'import') {
      if (payload.source.includes('backed')) return error('Import requires a detached standalone VHD/VHDX without a parent.');
      await fs.writeFile(payload.destination, 'standalone VHDX test bytes');
      return result({ size: 1024 ** 3 });
    }
    if (operation === 'disk') { await fs.writeFile(payload.disk, 'disposable VHDX bytes'); return result({ ok: true }); }
    if (operation === 'create') {
      const vmId = `00000000-0000-0000-0000-${String(++counter).padStart(12, '0')}`;
      vms.set(vmId, { ownershipId: payload.ownershipId, state: 'Off', iso: payload.iso });
      await fs.writeFile(payload.journal, '\uFEFF' + JSON.stringify({ vmId, ownershipId: payload.ownershipId }));
      if (failTpm) return error('Virtual TPM could not be enabled.');
      if (lostCreateResponse) return error('Lost creation response');
      return result({ vmId });
    }
    const vm = vms.get(payload.vmId);
    if (operation === 'destroy' && !vm) return result({ removed: true });
    if (!vm || vm.ownershipId !== payload.ownershipId) return error('Hyper-V ownership could not be verified; refusing operation.');
    if (operation === 'start') {
      if (failStart) return error('Simulated failed start');
      vm.state = 'Running'; return result({ state: 'Running' });
    }
    if (operation === 'status') {
      if (stopInstaller && vm.iso) {
        // The user leaves the console open before starting, then installs/shuts down.
        vm.polls = (vm.polls ?? 0) + 1;
        return result({ state: ['Off', 'Off', 'Running', 'Off'][Math.min(vm.polls - 1, 3)] });
      }
      return result({ state: vm.state });
    }
    if (operation === 'console') {
      assert.equal(vm.state, 'Off', 'Installer must not boot before the human can use VMConnect');
      return result({ ok: true });
    }
    if (operation === 'destroy') {
      if (failDestroy) return error('Simulated stop timeout');
      vms.delete(payload.vmId); return result({ removed: true });
    }
    throw new Error('Unexpected operation');
  }
};

try {
  const manager = new VmManager({ home: root, vmRoot: path.join(root, 'store'), platform: 'win32', executor });
  const report = await manager.doctor();
  assert.equal(report.backend, 'hyperv'); assert.equal(report.ready, true);
  assert.equal(report.qemuImg, undefined); assert.equal(report.qemuSystem, undefined);
  await assert.rejects(fs.access(manager.vmHome()));
  const source = path.join(root, "installer'; $(throw 'bad') ü.vhdx");
  await fs.writeFile(source, 'source remains unchanged');
  const options = { name: 'native', sourcePath: source, architecture: 'x86_64', cpus: 2, memoryMb: 1024, desktop: true };
  const manifest = await manager.setupImage(options);
  assert.equal(manifest.schemaVersion, 2); assert.equal(manifest.backend, 'hyperv'); assert.equal(manifest.format, 'vhdx');
  assert.equal(parseImageManifest(manifest).backend, 'hyperv');
  assert.equal(manifest.preferredAccelerator, undefined);
  assert.throws(() => parseImageManifest({ ...manifest, format: 'qcow2' }), /format/);
  assert.throws(() => parseImageManifest({ ...manifest, backend: undefined }), /explicit backend/);
  assert.throws(() => parseImageManifest({ ...manifest, schemaVersion: 1 }), /Schema 1/);
  const legacy = { ...manifest, schemaVersion: 1, backend: undefined, format: 'qcow2' };
  assert.equal(parseImageManifest(legacy).backend, 'qemu');
  assert.equal(parseImageManifest({ ...legacy, schemaVersion: 2, backend: 'qemu' }).format, 'qcow2');
  assert.equal((await manager.inspectImage('native')).sha256, manifest.sha256);
  const legacyDir = manager.images.imageDir('legacy');
  await fs.mkdir(legacyDir);
  await fs.copyFile(manager.images.basePath('native', 'vhdx'), path.join(legacyDir, 'base.qcow2'));
  const legacyJson = JSON.stringify({ ...legacy, name: 'legacy' });
  await fs.writeFile(path.join(legacyDir, 'manifest.json'), legacyJson);
  assert.equal((await manager.inspectImage('legacy')).backend, 'qemu');
  const linux = new VmManager({ home: root, vmRoot: manager.vmHome(), platform: 'linux' });
  assert.equal((await linux.inspectImage('legacy')).sha256, manifest.sha256);
  await assert.rejects(manager.createInstance('legacy'), /QEMU image/);
  assert.equal(await fs.readFile(path.join(legacyDir, 'manifest.json'), 'utf8'), legacyJson);
  assert.equal(await fs.readFile(source, 'utf8'), 'source remains unchanged');
  const importCall = calls.find(c => c.operation === 'import');
  assert.equal(importCall.payload.source, source); assert.ok(!importCall.script.includes(source));
  const before = await fs.readFile(manager.images.basePath('native', 'vhdx'));
  const instance = await manager.createInstance('native');
  assert.equal(instance.backend, 'hyperv'); assert.equal(instance.accelerator, undefined);
  assert.equal(instance.qmp, undefined); assert.equal(instance.processId, undefined);
  assert.equal(parseInstanceRecord(instance).hyperv.vmId, instance.hyperv.vmId);
  assert.throws(() => parseInstanceRecord({ ...instance, processId: 10 }), /QEMU runtime/);
  assert.throws(() => parseInstanceRecord({ ...instance, hyperv: { ownershipId: 'bad' } }), /ownership/);
  assert.throws(() => parseInstanceRecord({ ...instance, hyperv: { ...instance.hyperv, vmId: 'bad' } }), /GUID/);
  assert.equal((await manager.status(instance.id)).state, 'running');
  assert.equal((await manager.listInstances())[0].state, 'running');
  assert.equal((await manager.doctor()).activeInstanceCount, 1);
  const diff = calls.find(c => c.operation === 'disk' && c.payload.parent);
  assert.equal(diff.payload.parent, manager.images.basePath('native', 'vhdx'));
  assert.equal(diff.payload.disk, path.join(instance.instanceDir, 'overlay.vhdx'));
  const vm = vms.get(instance.hyperv.vmId);
  vm.ownershipId = 'b'.repeat(64);
  await assert.rejects(manager.destroyInstance(instance.id), /ownership/);
  assert.ok(vms.has(instance.hyperv.vmId)); assert.ok((await fs.stat(instance.instanceDir)).isDirectory());
  vm.ownershipId = instance.hyperv.ownershipId;
  failDestroy = true;
  await assert.rejects(manager.destroyInstance(instance.id), /timeout/);
  assert.ok((await fs.stat(instance.instanceDir)).isDirectory());
  failDestroy = false;
  await fs.writeFile(path.join(instance.instanceDir, 'operation.lock'), 'busy');
  await assert.rejects(manager.destroyInstance(instance.id), /busy/);
  await fs.unlink(path.join(instance.instanceDir, 'operation.lock'));
  await manager.destroyInstance(instance.id);
  assert.equal(vms.size, 0); await assert.rejects(fs.access(instance.instanceDir));
  assert.deepEqual(await fs.readFile(manager.images.basePath('native', 'vhdx')), before);
  failStart = true;
  await assert.rejects(manager.createInstance('native'), /diagnostic disk\/state preserved/);
  assert.equal(vms.size, 0);
  failStart = false;
  failTpm = true;
  const beforeTpmFailure = calls.length;
  await assert.rejects(manager.createInstance('native'), /Virtual TPM could not be enabled/);
  assert.equal(vms.size, 0);
  assert.ok(!calls.slice(beforeTpmFailure).some(call => call.operation === 'start'));
  failTpm = false;
  lostCreateResponse = true;
  await assert.rejects(manager.createInstance('native'), /Lost creation response/);
  assert.equal(vms.size, 0); // recovered exact GUID from journal
  lostCreateResponse = false;
  for (const failed of await manager.instances.list()) await manager.destroyInstance(failed.id);
  const unknown = await manager.instances.allocate('native', 1, 512, undefined, false, undefined, undefined, { ownershipId: 'c'.repeat(64) });
  await assert.rejects(manager.destroyInstance(unknown.record.id), /ownership cannot be verified/);
  assert.ok((await fs.stat(unknown.instanceDir)).isDirectory());
  await manager.instances.remove(unknown.record.id); // mock test owns the directory, no VM was created
  const iso = path.join(root, 'installer.iso'); await fs.writeFile(iso, 'iso test bytes');
  await assert.rejects(manager.setupImage({ ...options, name: 'headless', sourcePath: iso, headless: true }), /interactive/);
  await assert.rejects(manager.setupImage({ ...options, name: 'bad-size', sourcePath: iso, diskSizeGb: 0 }), /disk size/);
  stopInstaller = true;
  const installerCallsStart = calls.length;
  const progress = [];
  const installed = await manager.setupImage({ ...options, name: 'installed', sourcePath: iso, onProgress: message => progress.push(message) });
  assert.equal(installed.source.originalFileName, 'installer.iso.installed.vhdx');
  assert.equal(vms.size, 0); assert.equal((await manager.instances.list()).length, 0);
  const isoCreate = calls.find(c => c.operation === 'create' && c.payload.iso);
  assert.equal(isoCreate.payload.iso, iso);
  assert.ok(calls.some(c => c.operation === 'console'));
  const installerCalls = calls.slice(installerCallsStart);
  assert.ok(!installerCalls.some(c => c.operation === 'start'), 'Interactive installer starts from VMConnect');
  assert.equal(installerCalls.filter(c => c.operation === 'status').length, 4, 'Initial Off must not promote an unbooted disk');
  assert.ok(progress.some(message => /Start/.test(message) && /Space/.test(message)));
  assert.equal(calls.find(c => c.operation === 'disk' && c.payload.size).payload.size, 64 * 1024 ** 3);
  for (const ext of ['raw', 'qcow2']) {
    const unsupported = path.join(root, `source.${ext}`); await fs.writeFile(unsupported, 'unsupported');
    await assert.rejects(manager.setupImage({ ...options, name: ext, sourcePath: unsupported }), /Convert qcow2\/raw manually/);
  }
  const backed = path.join(root, 'backed.vhd'); await fs.writeFile(backed, 'backed');
  await assert.rejects(manager.setupImage({ ...options, name: 'backed', sourcePath: backed }), /standalone/);
  const vhd = path.join(root, 'source.vhd'); await fs.writeFile(vhd, 'vhd');
  assert.equal((await manager.setupImage({ ...options, name: 'vhd', sourcePath: vhd })).format, 'vhdx');
  const ps = new HypervPowerShell({ async run() { return { stdout: 'garbage', stderr: '', exitCode: 0 }; } });
  await assert.rejects(ps.run('doctor'), /invalid JSON/);

  if (process.platform === 'win32') {
    // Parse every generated script with the actual Windows PowerShell parser without executing it.
    const scriptsFile = path.join(root, 'scripts.json');
    await fs.writeFile(scriptsFile, JSON.stringify([...calls.map(c => c.script), await fs.readFile('scripts/vm-enable-tpm.ps1', 'utf8')]));
    const encodedPath = Buffer.from(scriptsFile).toString('base64');
    const parser = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); foreach($s in (Get-Content -LiteralPath $p -Raw | ConvertFrom-Json)) { $tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count) { $errors | Out-String | Write-Error; exit 1 } }`;
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parser, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(parsed.status, 0, parsed.stderr);
  }
  console.log('Hyper-V smoke passed (selection, schemas, scripts, mocked import/ISO/lifecycle, ownership and failure recovery).');
} finally {
  assert.equal(vms.size, 0, 'Mock VMs must be cleaned up');
  for (const directory of ['native', 'installed', 'vhd']) await fs.chmod(path.join(root, 'store', 'images', directory, 'base.vhdx'), 0o600).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
