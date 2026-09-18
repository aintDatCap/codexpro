import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

const BOOLEAN_OPTIONS = new Set(['desktop', 'no-desktop', 'validate', 'no-validate', 'headless', 'help']);
const VALUE_OPTIONS = new Set(['name', 'image', 'architecture', 'arch', 'cpus', 'memory', 'vm-home', 'qemu', 'qemu-img']);

function parseVmArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) {
      out.positional.push(raw);
      continue;
    }
    const option = raw.slice(2);
    const eq = option.indexOf('=');
    const key = eq >= 0 ? option.slice(0, eq) : option;
    const inline = eq >= 0 ? option.slice(eq + 1) : undefined;
    if (BOOLEAN_OPTIONS.has(key)) {
      if (inline !== undefined) throw new Error(`--${key} does not take a value.`);
      if (key === 'no-desktop') out.desktop = false;
      else if (key === 'no-validate') out.validate = false;
      else out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(key)) throw new Error(`Unknown VM option: --${key}`);
    const next = inline ?? argv[i + 1];
    if (next === undefined || (inline === undefined && next.startsWith('--'))) {
      throw new Error(`Missing value for --${key}`);
    }
    if (inline === undefined) i += 1;
    out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = next;
  }
  return out;
}

function expandUserPath(value) {
  const text = String(value);
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2));
  return text;
}

function defaultCpuCount() {
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, available || 1));
}

function positiveInteger(value, label, fallback) {
  const raw = value === undefined || value === '' ? String(fallback) : String(value);
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`);
  return number;
}

function humanBytes(value) {
  if (!Number.isFinite(value) || value < 0) return String(value);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let number = value;
  let unit = 0;
  while (number >= 1024 && unit < units.length - 1) {
    number /= 1024;
    unit += 1;
  }
  return `${number >= 10 || unit === 0 ? number.toFixed(0) : number.toFixed(1)} ${units[unit]}`;
}

function yesNo(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['y', 'yes', 'true', '1'].includes(normalized)) return true;
  if (['n', 'no', 'false', '0'].includes(normalized)) return false;
  throw new Error('Please answer yes or no.');
}

async function ask(rl, question, fallback = '') {
  const suffix = fallback === '' ? '' : ` [${fallback}]`;
  const answer = await rl.question(`? ${question}${suffix}\n> `);
  return answer.trim() || String(fallback);
}

async function askBoolean(rl, question, fallback) {
  for (;;) {
    try {
      return yesNo(await ask(rl, `${question} (yes/no)`, fallback ? 'yes' : 'no'), fallback);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
    }
  }
}

async function loadVmRuntime(projectRoot) {
  const modulePath = path.join(projectRoot, 'dist', 'vm', 'index.js');
  try {
    return await import(pathToFileURL(modulePath).href);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'ENOENT') {
      throw new Error('CodexPro VM runtime build artifacts are missing. Run "npm run build" in a source checkout, or reinstall the CodexPro package.');
    }
    throw error;
  }
}

export function vmUsage() {
  console.log(`CodexPro QEMU VM runtime

Usage:
  codexpro vm setup
  codexpro vm setup --headless --name <name> --image <file> [options]
  codexpro vm doctor [--architecture <x86_64|aarch64>]
  codexpro vm images
  codexpro vm inspect <image>
  codexpro vm list
  codexpro vm create <image> [--cpus <n>] [--memory <MiB>]
  codexpro vm destroy <instance-id>

Setup options:
  --name <name>              Approved image name.
  --image <file>             Source disk image. It is imported; the source is never used directly.
  --architecture <arch>      x86_64 or aarch64. Default: host architecture.
  --cpus <n>                 Default virtual CPUs.
  --memory <MiB>             Default memory in MiB.
  --vm-home <dir>            VM storage root. Setup remembers the selected location.
  --desktop                  Mark the image as providing a desktop environment.
  --validate                 Perform a bounded validation boot and QEMU Guest Agent probe.
  --headless                 Never prompt; required values must be supplied.
  --qemu <path>              Override qemu-system executable.
  --qemu-img <path>          Override qemu-img executable.
                              CODEXPRO_VM_HOME, CODEXPRO_QEMU, and CODEXPRO_QEMU_IMG are also supported.

CodexPro never downloads or installs QEMU automatically.`);
}

async function setupCommand(runtime, args) {
  const hostArch = runtime.hostArchitecture();
  const defaultCpus = defaultCpuCount();
  const defaultMemory = 4096;
  let name = args.name;
  let image = args.image;
  let architecture = args.architecture ?? args.arch ?? hostArch;
  let cpus = args.cpus;
  let memory = args.memory;
  let vmHome = args.vmHome ?? runtime.configuredVmRoot() ?? runtime.vmHomeLayout().root;
  let desktop = args.desktop ?? false;
  let validate = args.validate ?? false;

  const needsRequired = !name || !image;
  if (needsRequired && (args.headless || !process.stdin.isTTY)) {
    if (!name) throw new Error('--name is required for non-interactive codexpro vm setup.');
    if (!image) throw new Error('--image is required for non-interactive codexpro vm setup.');
  }

  if (needsRequired) {
    console.log('CodexPro VM setup');
    console.log('This wizard imports a private immutable qcow2 base image into the VM storage directory.');
    console.log('Press Enter to accept defaults. QEMU must already be installed.\n');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      name = await ask(rl, 'Image name', name ?? '');
      image = await ask(rl, 'Source image path', image ?? '');
      architecture = await ask(rl, 'Guest architecture', architecture);
      cpus = await ask(rl, 'Default CPU count', cpus ?? defaultCpus);
      memory = await ask(rl, 'Default memory (MiB)', memory ?? defaultMemory);
      vmHome = await ask(rl, 'VM storage location', vmHome);
      desktop = await askBoolean(rl, 'Does this image provide a desktop environment?', desktop);
      validate = await askBoolean(rl, 'Perform a validation boot now?', validate);
    } finally {
      rl.close();
    }
  }

  if (!name) throw new Error('--name is required.');
  if (!image) throw new Error('--image is required.');

  const resolvedVmHome = path.resolve(expandUserPath(vmHome));
  const manager = new runtime.VmManager({
    vmRoot: resolvedVmHome,
    qemu: args.qemu,
    qemuImg: args.qemuImg
  });

  await runtime.saveConfiguredVmRoot(resolvedVmHome);
  const manifest = await manager.setupImage({
    name,
    sourcePath: path.resolve(expandUserPath(image)),
    architecture: runtime.normalizeArchitecture(String(architecture)),
    cpus: positiveInteger(cpus, '--cpus', defaultCpus),
    memoryMb: positiveInteger(memory, '--memory', defaultMemory),
    desktop: Boolean(desktop),
    validate: Boolean(validate)
  });

  console.log(`VM image installed: ${manifest.name}`);
  console.log(`VM storage            ${resolvedVmHome}`);
  console.log(`Architecture          ${manifest.architecture}`);
  console.log(`Virtual size          ${humanBytes(manifest.virtualSize)}`);
  console.log(`Default resources     ${manifest.defaultCpus} CPU / ${manifest.defaultMemoryMb} MiB`);
  console.log(`Desktop               ${manifest.desktop ? 'yes' : 'no'}`);
  if (validate) {
    console.log(`Boot validation        ${manifest.validation.bootTested ? '✓' : '✗'}`);
    console.log(`QEMU Guest Agent       ${manifest.validation.guestAgentAvailable ? '✓' : '✗'}`);
    if (!manifest.validation.guestAgentAvailable) console.log('AI command execution   unavailable');
  } else {
    console.log('Boot validation        not requested');
  }
}

function printImages(runtime, manifests) {
  if (!manifests.length) {
    console.log('No approved VM images are installed.');
    return;
  }
  for (const manifest of manifests) {
    const image = runtime.publicVmImage(manifest);
    const compatibility = image.validation.guestAgentAvailable ? 'CodexPro-compatible' : image.validation.bootTested ? 'boot-tested; QGA unavailable' : 'not validated';
    console.log(
      `${image.name}\t${image.architecture}\t${image.defaultCpus} CPU\t${image.defaultMemoryMb} MiB\t${compatibility}`
    );
  }
}

function printInstances(runtime, records) {
  if (!records.length) {
    console.log('No disposable VM instances exist.');
    return;
  }
  for (const record of records) {
    const instance = runtime.publicVmInstance(record);
    console.log(
      `${instance.id}\t${instance.state}\t${instance.image}\t${instance.cpus} CPU\t${instance.memoryMb} MiB\t${instance.accelerator}`
    );
  }
}

async function doctorCommand(runtime, manager, args) {
  const architecture = runtime.normalizeArchitecture(String(args.architecture ?? args.arch ?? runtime.hostArchitecture()));
  const report = await manager.doctor(architecture);
  console.log('CodexPro VM doctor');
  console.log(`QEMU system binary    ${report.qemuSystem ? '✓ ' + report.qemuSystem : '✗ not found'}`);
  if (report.qemuSystemVersion) console.log(`QEMU system version   ${report.qemuSystemVersion}`);
  console.log(`qemu-img              ${report.qemuImg ? '✓ ' + report.qemuImg : '✗ not found'}`);
  if (report.qemuImgVersion) console.log(`qemu-img version      ${report.qemuImgVersion}`);
  console.log(`Host architecture     ${report.hostArchitecture}`);
  console.log(`Accelerator           ${report.accelerator ?? 'unsupported'}`);
  console.log(`Accelerator usable    ${report.acceleratorUsable ? '✓ yes' : '✗ no'}`);
  if (report.acceleratorReason) console.log(`Accelerator detail    ${report.acceleratorReason}`);
  console.log(`VM home               ${report.vmHome}`);
  console.log(`Installed images      ${report.imageCount}`);
  console.log(`Active instances      ${report.activeInstanceCount}`);
  if (!report.qemuSystem || !report.qemuImg) {
    console.log('\nInstall QEMU separately and ensure its binaries are on PATH, or use --qemu/--qemu-img overrides.');
  }
}

export async function runVmCli(argv, projectRoot) {
  const command = argv[0] ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    vmUsage();
    return;
  }
  const args = parseVmArgs(argv.slice(1));
  if (args.help) {
    vmUsage();
    return;
  }

  const runtime = await loadVmRuntime(projectRoot);
  if (command === 'setup') {
    await setupCommand(runtime, args);
    return;
  }

  const manager = new runtime.VmManager({
    vmRoot: args.vmHome ? path.resolve(expandUserPath(args.vmHome)) : undefined,
    qemu: args.qemu,
    qemuImg: args.qemuImg
  });
  if (command === 'doctor') {
    await doctorCommand(runtime, manager, args);
    return;
  }
  if (command === 'images') {
    if (args.positional.length) throw new Error('codexpro vm images does not take positional arguments.');
    printImages(runtime, await manager.listImages());
    return;
  }
  if (command === 'inspect') {
    const image = args.positional[0];
    if (!image || args.positional.length !== 1) throw new Error('Usage: codexpro vm inspect <image>');
    console.log(JSON.stringify(await manager.inspectImage(image), null, 2));
    return;
  }
  if (command === 'list') {
    if (args.positional.length) throw new Error('codexpro vm list does not take positional arguments.');
    printInstances(runtime, await manager.listInstances());
    return;
  }
  if (command === 'create') {
    const image = args.positional[0];
    if (!image || args.positional.length !== 1) throw new Error('Usage: codexpro vm create <image>');
    const record = await manager.createInstance(image, {
      cpus: args.cpus === undefined ? undefined : positiveInteger(args.cpus, '--cpus', defaultCpuCount()),
      memoryMb: args.memory === undefined ? undefined : positiveInteger(args.memory, '--memory', 4096)
    });
    const instance = runtime.publicVmInstance(record);
    console.log(`VM instance created: ${instance.id}`);
    console.log(`Image                 ${instance.image}`);
    console.log(`State                 ${instance.state}`);
    console.log(`Resources             ${instance.cpus} CPU / ${instance.memoryMb} MiB`);
    console.log(`Accelerator           ${instance.accelerator}`);
    return;
  }
  if (command === 'destroy') {
    const id = args.positional[0];
    if (!id || args.positional.length !== 1) throw new Error('Usage: codexpro vm destroy <instance-id>');
    await manager.destroyInstance(id);
    console.log(`VM instance destroyed: ${id}`);
    return;
  }

  throw new Error(`Unknown VM command: ${command}. Run "codexpro vm --help".`);
}
