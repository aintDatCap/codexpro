import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { QmpClient, QmpCommandTimeoutError, QmpConnectionError } from '../dist/vm/qmp.js';
import {
  ImageStore,
  InstanceStore,
  VmManager,
  acceleratorForPlatform,
  allocateLoopbackPort,
  buildQemuInstallerArgs,
  buildQemuLaunchArgs,
  configuredVmRoot,
  discoverExecutable,
  hostArchitecture,
  normalizeArchitecture,
  overlayCreateArgs,
  parseImageManifest,
  qgaArguments,
  qmpArgument,
  runQemuInstaller,
  runVmToolAction,
  saveConfiguredVmRoot,
  systemBinaryName,
  validateImageName,
  validateInstanceId,
  validateResources,
  vmHomeLayout
} from '../dist/vm/index.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-vm-smoke-'));
const home = path.join(root, 'home');

try {
  // A late response to an expired ID must not settle the next request.
  let requests = 0;
  const delayedServer = net.createServer((socket) => {
    socket.write(JSON.stringify({ QMP: {} }) + '\n');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n');
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const reply = value => socket.write(JSON.stringify({ id: message.id, return: value }) + '\n');
        if (message.execute === 'qmp_capabilities') reply({});
        else {
          requests++;
          if (requests === 3) { socket.end(); continue; }
          const first = requests === 1;
          setTimeout(() => reply({ status: first ? 'io-error' : 'running', requestId: message.id }), first ? 100 : 200);
        }
      }
    });
  });
  await new Promise(resolve => delayedServer.listen(0, '127.0.0.1', resolve));
  const delayedClient = await QmpClient.connect({ transport: 'tcp', host: '127.0.0.1', port: delayedServer.address().port });
  try {
    await assert.rejects(delayedClient.queryStatus(20), QmpCommandTimeoutError);
    const recovered = await delayedClient.queryStatus(1000);
    assert.equal(recovered.requestId, 3);
    assert.equal(recovered.status, 'running');
    await assert.rejects(delayedClient.queryStatus(1000), QmpConnectionError);
    await assert.rejects(delayedClient.queryStatus(1000), QmpConnectionError);
  } finally {
    delayedClient.close();
    await new Promise(resolve => delayedServer.close(resolve));
  }

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
  assert.equal(manifest.preferredAccelerator, undefined);
  const tcgManifest = parseImageManifest({ ...manifest, preferredAccelerator: 'tcg' });
  assert.equal(tcgManifest.preferredAccelerator, 'tcg');
  assert.throws(() => parseImageManifest({ ...manifest, preferredAccelerator: 'invalid' }), /preferred accelerator/);
  assert.throws(
    () => parseImageManifest({ ...manifest, source: { originalFileName: '../ubuntu.qcow2' } }),
    /must not contain a path/
  );

  const layout = vmHomeLayout(home);
  assert.equal(layout.root, path.join(home, 'vm'));
  assert.equal(layout.images, path.join(home, 'vm', 'images'));
  assert.equal(layout.instances, path.join(home, 'vm', 'instances'));
  const customVmRoot = path.join(root, 'custom-vm-root');
  const customLayout = vmHomeLayout(home, customVmRoot);
  assert.equal(customLayout.root, customVmRoot);
  assert.equal(customLayout.images, path.join(customVmRoot, 'images'));
  assert.equal(customLayout.instances, path.join(customVmRoot, 'instances'));

  const previousVmHome = process.env.CODEXPRO_VM_HOME;
  delete process.env.CODEXPRO_VM_HOME;
  try {
    const persistedHome = path.join(root, 'persisted-home');
    const persistedVmRoot = path.join(root, 'persisted-vm-root');
    await saveConfiguredVmRoot(persistedVmRoot, persistedHome);
    assert.equal(configuredVmRoot(persistedHome), persistedVmRoot);
    assert.deepEqual(await new VmManager({ home: persistedHome }).listImages(), []);
    assert.ok((await fs.stat(path.join(persistedVmRoot, 'images'))).isDirectory());
    assert.ok((await fs.stat(path.join(persistedVmRoot, 'instances'))).isDirectory());
  } finally {
    if (previousVmHome === undefined) delete process.env.CODEXPRO_VM_HOME;
    else process.env.CODEXPRO_VM_HOME = previousVmHome;
  }

  const sourceImage = path.join(root, 'source.qcow2');
  const backedSource = path.join(root, 'source-with-backing.qcow2');
  const installerIso = path.join(root, 'installer.iso');
  await fs.writeFile(sourceImage, 'source image bytes');
  await fs.writeFile(backedSource, 'backed source bytes');
  await fs.writeFile(installerIso, 'installer media bytes');
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
  const commandCountBeforeIso = fakeCommands.length;
  await assert.rejects(
    () => imageStore.importImage({
      name: 'installer-media',
      sourcePath: installerIso,
      architecture: 'x86_64',
      defaultCpus: 2,
      defaultMemoryMb: 2048,
      desktop: true,
      qemuImg: 'qemu-img'
    }),
    /Installer ISO files must be handled through the CodexPro VM setup flow/
  );
  assert.equal(fakeCommands.length, commandCountBeforeIso);

  const imported = await imageStore.importImage({
    name: 'flattened',
    sourcePath: sourceImage,
    architecture: 'x86_64',
    defaultCpus: 2,
    defaultMemoryMb: 2048,
    desktop: false,
    preferredAccelerator: 'tcg',
    qemuImg: 'qemu-img'
  });
  assert.equal(imported.format, 'qcow2');
  assert.equal(imported.preferredAccelerator, 'tcg');
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
  assert.ok(launchArgs.join(' ').includes('ich9-ahci,id=codexpro-ahci'));
  assert.ok(launchArgs.join(' ').includes('ide-hd,drive=codexpro-disk,bus=codexpro-ahci.0'));
  assert.ok(launchArgs.includes('user,model=e1000e'));
  assert.ok(launchArgs.includes('-pidfile'));
  assert.ok(launchArgs.includes('/managed/instances/vm-0123456789abcdef/qemu.pid'));
  const whpxLaunchArgs = buildQemuLaunchArgs({
    id: 'vm-1111111111111111',
    architecture: 'x86_64',
    accelerator: 'whpx',
    cpus: 4,
    memoryMb: 4096,
    overlayPath: 'E:/codexprovm/instances/vm-1111111111111111/overlay.qcow2',
    pidFilePath: 'E:/codexprovm/instances/vm-1111111111111111/qemu.pid',
    qmp: { transport: 'pipe', name: 'codexpro-vm-1111111111111111-qmp' },
    qga: { transport: 'tcp', host: '127.0.0.1', port: 45999 }
  });
  assert.equal(whpxLaunchArgs[whpxLaunchArgs.indexOf('-machine') + 1], 'q35,kernel-irqchip=off');
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
  assert.ok(armLaunchArgs.join(' ').includes('virtio-blk-pci,drive=codexpro-disk'));

  const installerArgs = buildQemuInstallerArgs({
    name: 'win-dev',
    architecture: 'x86_64',
    accelerator: 'whpx',
    cpus: 4,
    memoryMb: 8192,
    diskPath: 'E:/codexprovm/install-disk.qcow2',
    isoPath: 'E:/isos/windows.iso',
    qmp: { transport: 'pipe', name: 'codexpro-vm-0123456789abcdef-qmp' },
    display: 'sdl'
  });
  assert.equal(installerArgs[installerArgs.indexOf('-machine') + 1], 'q35,kernel-irqchip=off');
  assert.ok(installerArgs.join(' ').includes('ich9-ahci,id=codexpro-ahci'));
  assert.ok(installerArgs.join(' ').includes('ide-hd,drive=install-disk,bus=codexpro-ahci.0'));
  assert.ok(installerArgs.join(' ').includes('ide-cd,drive=install-cd,bus=codexpro-ahci.1'));
  assert.ok(installerArgs.join(' ').includes('windows.iso'));
  assert.ok(installerArgs.includes('once=d'));
  assert.ok(installerArgs.includes('user,model=e1000e'));
  assert.equal(installerArgs[installerArgs.indexOf('-display') + 1], 'sdl');
  assert.ok(installerArgs.includes('-qmp'));
  assert.ok(installerArgs.includes('pipe:codexpro-vm-0123456789abcdef-qmp'));

  const fakeQmpServer = path.join(root, 'fake-qmp-server.mjs');
  await fs.writeFile(fakeQmpServer, String.raw`
import net from 'node:net';
const endpoint = JSON.parse(process.argv[2]);
const mode = process.argv[3];
const address = endpoint.transport === 'pipe' ? '\\\\.\\pipe\\' + endpoint.name : endpoint.path;
if (mode === 'whpx') console.error('qemu-system-x86_64.EXE: WHPX: Unexpected VP exit code 4');
let running = false;
let queries = 0;
const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.write(JSON.stringify({ QMP: { version: { qemu: { major: 11, minor: 1, micro: 0 }, package: '' }, capabilities: [] } }) + '\r\n');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.execute === 'qmp_capabilities') {
        socket.write(JSON.stringify({ return: {}, id: message.id }) + '\r\n');
      } else if (message.execute === 'query-status') {
        queries++;
        if (mode === 'stuck') continue;
        if (mode === 'exit') process.exit(7);
        if (mode === 'clean-exit') process.exit(0);
        if (mode === 'disconnect' && queries === 1) { socket.destroy(); continue; }
        if (mode === 'command-error') {
          socket.write(JSON.stringify({ error: { class: 'GenericError', desc: 'deliberate failure' }, id: message.id }) + '\r\n');
          continue;
        }
        if (mode === 'transient' && queries === 1) {
          setTimeout(() => socket.write(JSON.stringify({ return: { status: 'running' }, id: message.id }) + '\r\n'), 6500);
          continue;
        }
        const status = mode === 'fatal' ? 'io-error' : mode.startsWith('fatal:') ? mode.slice(6) : running ? 'running' : 'prelaunch';
        socket.write(JSON.stringify({ return: { running, status }, id: message.id }) + '\r\n');
      } else if (message.execute === 'cont') {
        running = true;
        socket.write(JSON.stringify({ return: {}, id: message.id }) + '\r\n');
        setTimeout(() => {
          socket.end();
          server.close(() => process.exit(0));
        }, 150);
      } else if (message.execute === 'quit') {
        socket.write(JSON.stringify({ return: {}, id: message.id }) + '\r\n');
        socket.end();
        server.close(() => process.exit(0));
      }
    }
  });
});
server.listen(address);
`);

  const resumableEndpoint = process.platform === 'win32'
    ? { transport: 'pipe', name: 'codexpro-vm-1111111111111111-qmp' }
    : { transport: 'unix', path: path.join(root, 'installer-resume.sock') };
  await runQemuInstaller(
    process.execPath,
    [fakeQmpServer, JSON.stringify(resumableEndpoint), 'resume'],
    path.join(root, 'installer-resume.log'),
    resumableEndpoint
  );

  const transientEndpoint = process.platform === 'win32'
    ? { transport: 'pipe', name: `codexpro-transient-${process.pid}` }
    : { transport: 'unix', path: path.join(root, 'transient.sock') };
  await runQemuInstaller(
    process.execPath,
    [fakeQmpServer, JSON.stringify(transientEndpoint), 'transient'],
    path.join(root, 'installer-transient.log'),
    transientEndpoint,
    'tcg'
  );
  for (const mode of ['disconnect', 'clean-exit', 'exit', 'command-error', 'fatal:internal-error', 'fatal:guest-panicked', 'fatal:watchdog', 'stuck']) {
    const endpoint = process.platform === 'win32'
      ? { transport: 'pipe', name: `codexpro-${process.pid}-${mode.replace(':', '-')}` }
      : { transport: 'unix', path: path.join(root, `${mode.replace(':', '-')}.sock`) };
    const began = Date.now();
    const run = () => runQemuInstaller(process.execPath, [fakeQmpServer, JSON.stringify(endpoint), mode], path.join(root, `${mode.replace(':', '-')}.log`), endpoint, 'tcg');
    if (mode === 'exit') await assert.rejects(run, /exited with code 7/);
    else if (mode === 'command-error') await assert.rejects(run, /deliberate failure/);
    else if (mode.startsWith('fatal:')) await assert.rejects(run, /non-resumable state/);
    else if (mode === 'stuck') {
      await assert.rejects(run, /QMP remained unresponsive for 60000 ms/);
      assert.ok(Date.now() - began < 70000, 'Unresponsive supervision must have a bounded deadline');
    } else await run();
    if (mode === 'exit' || mode === 'clean-exit') assert.ok(Date.now() - began < 5000, 'Exit should interrupt an outstanding QMP query');
  }
  // Hardware accelerators keep the existing fast command timeout.
  const hardwareBegan = Date.now();
  await assert.rejects(() => runQemuInstaller(process.execPath,
    [fakeQmpServer, JSON.stringify(transientEndpoint), 'transient'],
    path.join(root, 'hardware-transient.log'), transientEndpoint, 'whpx'), QmpCommandTimeoutError);
  assert.ok(Date.now() - hardwareBegan < 5000);

  const fatalEndpoint = process.platform === 'win32'
    ? { transport: 'pipe', name: 'codexpro-vm-2222222222222222-qmp' }
    : { transport: 'unix', path: path.join(root, 'installer-fatal.sock') };
  await assert.rejects(
    () => runQemuInstaller(
      process.execPath,
      [fakeQmpServer, JSON.stringify(fatalEndpoint), 'fatal'],
      path.join(root, 'installer-fatal.log'),
      fatalEndpoint
    ),
    /non-resumable state: io-error/
  );

  const whpxFailureEndpoint = process.platform === 'win32'
    ? { transport: 'pipe', name: 'codexpro-vm-3333333333333333-qmp' }
    : { transport: 'unix', path: path.join(root, 'installer-whpx.sock') };
  await assert.rejects(
    () => runQemuInstaller(
      process.execPath,
      [fakeQmpServer, JSON.stringify(whpxFailureEndpoint), 'whpx'],
      path.join(root, 'installer-whpx.log'),
      whpxFailureEndpoint
    ),
    /WHPX virtual-processor failure/
  );

  const pipeName = 'codexpro-vm-0123456789abcdef-qmp';
  assert.equal(qmpArgument({ transport: 'pipe', name: pipeName }), `pipe:${pipeName}`);
  assert.ok(qgaArguments({ transport: 'pipe', name: 'codexpro-vm-0123456789abcdef-qga' })[1].startsWith('pipe,'));
  const loopbackPort = await allocateLoopbackPort();
  assert.ok(loopbackPort > 0 && loopbackPort <= 65535);
  assert.equal(
    qgaArguments({ transport: 'tcp', host: '127.0.0.1', port: loopbackPort })[1],
    `socket,id=qga0,host=127.0.0.1,port=${loopbackPort},server=on,wait=off,nodelay=on,ipv4=on`
  );

  const store = new InstanceStore({ home });
  const allocation = await store.allocate(
    'ubuntu-dev',
    2,
    2048,
    'kvm',
    false,
    undefined,
    { transport: 'tcp', host: '127.0.0.1', port: loopbackPort }
  );
  assert.match(allocation.record.id, /^vm-[a-f0-9]{16}$/);
  assert.equal(allocation.pidPath, path.join(allocation.instanceDir, 'qemu.pid'));
  const storedAllocation = await store.read(allocation.record.id);
  assert.equal(storedAllocation.image, 'ubuntu-dev');
  assert.deepEqual(storedAllocation.qga, { transport: 'tcp', host: '127.0.0.1', port: loopbackPort });
  const tcgAllocation = await store.allocate('windows-dev', 4, 4096, 'tcg', true);
  assert.equal((await store.read(tcgAllocation.record.id)).accelerator, 'tcg');
  await store.remove(tcgAllocation.record.id);
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
  assert.match(help.stdout, /--disk-size <GiB>/);
  assert.match(help.stdout, /--vm-home <dir>/);
  assert.match(help.stdout, /never downloads or installs QEMU automatically/);

  const doctorVmHome = path.join(root, 'cli-custom-vm-home');
  const doctor = spawnSync(
    process.execPath,
    [cli, 'vm', 'doctor', '--vm-home', doctorVmHome],
    { cwd: path.resolve('.'), env, encoding: 'utf8' }
  );
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.ok(doctor.stdout.includes(`VM home               ${doctorVmHome}`));
  assert.ok((await fs.stat(path.join(doctorVmHome, 'images'))).isDirectory());
  assert.ok((await fs.stat(path.join(doctorVmHome, 'instances'))).isDirectory());

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
