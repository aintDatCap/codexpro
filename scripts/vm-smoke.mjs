import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  ImageStore,
  InstanceStore,
  VmManager,
  acceleratorForPlatform,
  buildQemuLaunchArgs,
  discoverExecutable,
  hostArchitecture,
  normalizeArchitecture,
  overlayCreateArgs,
  parseImageManifest,
  qgaArguments,
  qmpArgument,
  runVmToolAction,
  systemBinaryName,
  validateImageName,
  validateInstanceId,
  validateResources,
  vmHomeLayout
} from '../dist/vm/index.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-vm-smoke-'));
const home = path.join(root, 'home');

try {
  assert.equal(acceleratorForPlatform('win32'), 'whpx');
  assert.equal(acceleratorForPlatform('linux'), 'kvm');
  assert.equal(acceleratorForPlatform('darwin'), 'hvf');
  assert.equal(acceleratorForPlatform('freebsd'), undefined);

  assert.equal(normalizeArchitecture('amd64'), 'x86_64');
  assert.equal(normalizeArchitecture('arm64'), 'aarch64');
  assert.ok(['x86_64', 'aarch64'].includes(hostArchitecture()));
  assert.equal(systemBinaryName('x86_64'), 'qemu-system-x86_64');
  assert.equal(systemBinaryName('aarch64'), 'qemu-system-aarch64');

  assert.equal(validateImageName('ubuntu-dev_24.04'), 'ubuntu-dev_24.04');
  assert.throws(() => validateImageName('../escape'), /Invalid VM image name/);
  assert.throws(() => validateImageName('a/b'), /Invalid VM image name/);
  assert.throws(() => validateInstanceId('../vm-deadbeefdeadbeef'), /Invalid VM instance id/);
  assert.deepEqual(validateResources(4, 8192), { cpus: 4, memoryMb: 8192 });
  assert.throws(() => validateResources(0, 8192), /CPU count/);
  assert.throws(() => validateResources(4, 128), /memory/);

  const manifest = parseImageManifest({
    schemaVersion: 1,
    name: 'ubuntu-dev',
    architecture: 'x86_64',
    format: 'qcow2',
    sha256: 'a'.repeat(64),
    virtualSize: 40 * 1024 * 1024 * 1024,
    fileSize: 1024,
    defaultCpus: 4,
    defaultMemoryMb: 8192,
    desktop: true,
    createdAt: new Date().toISOString(),
    source: { originalFileName: 'ubuntu.qcow2' },
    validation: { bootTested: false, guestAgentAvailable: false }
  });
  assert.equal(manifest.source.originalFileName, 'ubuntu.qcow2');
  assert.throws(
    () => parseImageManifest({ ...manifest, source: { originalFileName: '../ubuntu.qcow2' } }),
    /must not contain a path/
  );

  const layout = vmHomeLayout(home);
  assert.equal(layout.root, path.join(home, 'vm'));
  assert.equal(layout.images, path.join(home, 'vm', 'images'));
  assert.equal(layout.instances, path.join(home, 'vm', 'instances'));

  const sourceImage = path.join(root, 'source.qcow2');
  const backedSource = path.join(root, 'source-with-backing.qcow2');
  await fs.writeFile(sourceImage, 'source image bytes');
  await fs.writeFile(backedSource, 'backed source bytes');
  const fakeCommands = [];
  const importExecutor = {
    async run(command, args) {
      fakeCommands.push([command, ...args]);
      if (args[0] === 'info') {
        const target = args.at(-1);
        if (target === backedSource) {
          return {
            stdout: JSON.stringify({
              format: 'qcow2',
              'virtual-size': 8 * 1024 * 1024 * 1024,
              'backing-filename': 'external-base.qcow2'
            }),
            stderr: '',
            exitCode: 0
          };
        }
        return {
          stdout: JSON.stringify({
            format: 'qcow2',
            'virtual-size': 8 * 1024 * 1024 * 1024
          }),
          stderr: '',
          exitCode: 0
        };
      }
      if (args[0] === 'convert') {
        await fs.writeFile(args.at(-1), 'flattened managed qcow2 bytes');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'check') {
        return { stdout: '{}', stderr: '', exitCode: 0 };
      }
      throw new Error('unexpected fake qemu-img command: ' + args.join(' '));
    }
  };
  const imageStore = new ImageStore({ home: path.join(root, 'import-home'), executor: importExecutor });
  const imported = await imageStore.importImage({
    name: 'flattened',
    sourcePath: sourceImage,
    architecture: 'x86_64',
    defaultCpus: 2,
    defaultMemoryMb: 2048,
    desktop: false,
    qemuImg: 'qemu-img'
  });
  assert.equal(imported.format, 'qcow2');
  assert.equal(imported.source.originalFileName, path.basename(sourceImage));
  assert.equal(imported.validation.bootTested, false);
  assert.equal(await fs.readFile(sourceImage, 'utf8'), 'source image bytes');
  assert.ok(fakeCommands.some((entry) => entry[1] === 'convert' && entry.includes('-O') && entry.includes('qcow2')));
  assert.ok(fakeCommands.some((entry) => entry[1] === 'check'));
  assert.equal((await imageStore.readManifest('flattened', true)).sha256, imported.sha256);
  await assert.rejects(
    () => imageStore.importImage({
      name: 'backed',
      sourcePath: backedSource,
      architecture: 'x86_64',
      defaultCpus: 1,
      defaultMemoryMb: 512,
      desktop: false,
      qemuImg: 'qemu-img'
    }),
    /external backing file/
  );
  assert.equal(await fs.readFile(backedSource, 'utf8'), 'backed source bytes');
  await fs.chmod(imageStore.basePath('flattened'), 0o600).catch(() => {});

  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fakeName = process.platform === 'win32' ? 'fake-qemu.EXE' : 'fake-qemu';
  const fakePath = path.join(binDir, fakeName);
  await fs.writeFile(fakePath, '');
  if (process.platform !== 'win32') await fs.chmod(fakePath, 0o755);
  assert.equal(discoverExecutable(undefined, 'fake-qemu', binDir), fakePath);

  assert.deepEqual(
    overlayCreateArgs('C:/managed/base.qcow2', 'C:/managed/instance/overlay.qcow2'),
    ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', 'C:/managed/base.qcow2', 'C:/managed/instance/overlay.qcow2']
  );

  const launchArgs = buildQemuLaunchArgs({
    id: 'vm-0123456789abcdef',
    architecture: 'x86_64',
    accelerator: 'kvm',
    cpus: 2,
    memoryMb: 2048,
    overlayPath: '/managed/instances/vm-0123456789abcdef/overlay.qcow2',
    pidFilePath: '/managed/instances/vm-0123456789abcdef/qemu.pid',
    qmp: { transport: 'unix', path: '/managed/qmp.sock' },
    qga: { transport: 'unix', path: '/managed/qga.sock' }
  });
  assert.ok(launchArgs.includes('kvm'));
  assert.ok(launchArgs.join(' ').includes('overlay.qcow2'));
  assert.ok(!launchArgs.join(' ').includes('base.qcow2'));
  assert.ok(launchArgs.join(' ').includes('org.qemu.guest_agent.0'));
  assert.ok(launchArgs.includes('-pidfile'));
  assert.ok(launchArgs.includes('/managed/instances/vm-0123456789abcdef/qemu.pid'));
  const armLaunchArgs = buildQemuLaunchArgs({
    id: 'vm-fedcba9876543210',
    architecture: 'aarch64',
    accelerator: 'kvm',
    cpus: 2,
    memoryMb: 2048,
    overlayPath: '/managed/instances/vm-fedcba9876543210/overlay.qcow2',
    pidFilePath: '/managed/instances/vm-fedcba9876543210/qemu.pid',
    qmp: { transport: 'unix', path: '/managed/arm-qmp.sock' },
    qga: { transport: 'unix', path: '/managed/arm-qga.sock' }
  });
  assert.equal(armLaunchArgs[armLaunchArgs.indexOf('-cpu') + 1], 'host');
  const pipeName = 'codexpro-vm-0123456789abcdef-qmp';
  assert.equal(qmpArgument({ transport: 'pipe', name: pipeName }), `pipe:${pipeName}`);
  assert.ok(qgaArguments({ transport: 'pipe', name: 'codexpro-vm-0123456789abcdef-qga' })[1].startsWith('pipe,'));

  const store = new InstanceStore({ home });
  const allocation = await store.allocate('ubuntu-dev', 2, 2048, 'kvm', false);
  assert.match(allocation.record.id, /^vm-[a-f0-9]{16}$/);
  assert.equal(allocation.pidPath, path.join(allocation.instanceDir, 'qemu.pid'));
  assert.equal((await store.read(allocation.record.id)).image, 'ubuntu-dev');
  const recovering = await store.allocate('ubuntu-dev', 1, 512, 'kvm', false);
  await store.update(recovering.record.id, { state: 'starting' });
  await fs.writeFile(recovering.pidPath, String(process.pid));
  const recovered = await store.read(recovering.record.id);
  assert.equal(recovered.processId, process.pid);
  assert.equal(recovered.state, 'starting');
  await store.update(recovering.record.id, { state: 'stopped', processId: undefined });
  await store.remove(recovering.record.id);
  const sentinel = path.join(root, 'sentinel.txt');
  await fs.writeFile(sentinel, 'keep');
  await assert.rejects(() => store.remove('../escape'), /Invalid VM instance id/);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
  await store.remove(allocation.record.id);
  await assert.rejects(() => fs.access(allocation.instanceDir));

  const vmAction = await runVmToolAction({ action: 'images' }, new VmManager({ home }));
  assert.deepEqual(vmAction, { action: 'images', images: [], imageCount: 0 });
  await assert.rejects(
    () => runVmToolAction({ action: 'create' }, new VmManager({ home })),
    /image is required/
  );

  const cli = path.resolve('scripts/codexpro.mjs');
  const env = { ...process.env, CODEXPRO_HOME: path.join(root, 'cli-home'), NO_COLOR: '1', CI: '1' };
  const help = spawnSync(process.execPath, [cli, 'vm', '--help'], { cwd: path.resolve('.'), env, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /codexpro vm setup/);
  assert.match(help.stdout, /never downloads or installs QEMU automatically/);

  const missingImage = spawnSync(
    process.execPath,
    [cli, 'vm', 'setup', '--headless', '--name', 'ubuntu-dev'],
    { cwd: path.resolve('.'), env, encoding: 'utf8' }
  );
  assert.notEqual(missingImage.status, 0);
  assert.match(missingImage.stderr, /--image is required/);

  console.log('✓ VM smoke test passed');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
