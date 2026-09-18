# QEMU VM runtimes

CodexPro can use QEMU to create disposable guest operating systems for isolated software testing. QEMU is the only VM backend in this release. CodexPro does not download or install QEMU.

## Install QEMU

Install QEMU using the package or deployment method appropriate for your system, then make `qemu-img` and the relevant `qemu-system-*` executable available on `PATH`.

- Windows: install QEMU and enable Windows Hypervisor Platform so QEMU can use WHPX.
- Linux: install QEMU and configure KVM access where hardware virtualization is available.
- macOS: install QEMU; CodexPro uses HVF.

CodexPro will not silently fall back to TCG software emulation when hardware acceleration is unavailable.

Verify the host before importing images:

```bash
codexpro vm doctor
```

You can override binary discovery for a managed installation:

```bash
codexpro vm doctor --qemu /path/to/qemu-system-x86_64 --qemu-img /path/to/qemu-img
```

The same overrides can be supplied through `CODEXPRO_QEMU` and `CODEXPRO_QEMU_IMG`.

## Prepare an image

Run the interactive wizard:

```bash
codexpro vm setup
```

It asks for an image name, source image path, architecture, default CPU count, default memory, VM storage location, desktop metadata, and whether to perform a validation boot. Boolean questions display their choices explicitly as `yes/no`.

For CI or other non-interactive use, provide required values explicitly:

```bash
codexpro vm setup \
  --headless \
  --name ubuntu-dev \
  --image ./ubuntu.qcow2 \
  --cpus 4 \
  --memory 8192 \
  --vm-home /srv/codexpro-vms \
  --desktop \
  --validate
```

`--headless` never prompts. Missing `--name` or `--image` is an error. Setup remembers the selected VM storage root for later VM commands. Use `--vm-home <dir>` for a per-command override, or set `CODEXPRO_VM_HOME` for an environment override, without moving the rest of `CODEXPRO_HOME`.

The supplied source image is never registered or booted directly. CodexPro inspects it with `qemu-img`, converts it into a self-contained qcow2 file, checks it, hashes it with SHA-256, and atomically moves it into CodexPro's private image store. The original file is not modified. Source images with external backing files are rejected so image metadata cannot make CodexPro follow arbitrary host paths; flatten such chains yourself before import.

By default, managed state lives under `CODEXPRO_HOME/vm` (normally `~/.codexpro/vm`), not in the project repository. A custom `--vm-home` or `CODEXPRO_VM_HOME` points directly at the VM storage root:

```text
~/.codexpro/
  vm/
    images/
      ubuntu-dev/
        base.qcow2
        manifest.json
    instances/
      vm-.../
        overlay.qcow2
        runtime.json
        qemu.pid
        qemu.log
```

The manifest stores the original file name, not the original absolute host path.

## Immutable base images and disposable overlays

CodexPro treats every managed `base.qcow2` as immutable. It records its hash and size, marks it read-only where the filesystem supports that, verifies it before creating an instance, and never attaches it writable.

Each instance gets its own qcow2 overlay:

```text
base image
    ↓
disposable overlay
    ↓
VM
    ↓
testing
    ↓
destroy overlay
```

Destroying an instance removes only the CodexPro-owned instance directory. It does not modify or commit changes into the base image. CodexPro does not expose `qemu-img commit` to AI tools.

Manual lifecycle commands are:

```bash
codexpro vm images
codexpro vm inspect ubuntu-dev
codexpro vm create ubuntu-dev
codexpro vm list
codexpro vm destroy vm-0123456789abcdef
```

## Guest requirements

Images intended for automated AI testing should contain and start the QEMU Guest Agent at boot. They should also contain whatever compilers, runtimes, package managers, and test tools your workflow needs.

Common Linux distributions package the agent as `qemu-guest-agent`. Install the distribution package and enable its service before importing the image. Exact package/service names vary by distribution.

A validation boot checks that QEMU can start the image with the selected hardware accelerator and whether the QEMU Guest Agent answers on the private virtio-serial channel. CodexPro reports these separately:

```text
Boot                 ✓
QEMU Guest Agent     ✗
AI command execution unavailable
```

A boot-tested image is not automatically CodexPro-compatible. Guest command/file execution is intentionally not exposed in this first implementation, and CodexPro will not claim guest commands ran when the guest-agent channel is unavailable.

## Management channels and desktop metadata

QEMU lifecycle management uses QMP rather than terminal-output parsing. QMP and the QEMU Guest Agent are local/private: Unix hosts use sockets inside the instance directory; Windows uses per-instance duplex named pipes.

`--desktop` records that the image provides a graphical desktop. Full desktop automation and human VNC/noVNC viewing are not implemented here. The QMP layer is typed and already provides bounded foundations for later screenshots, input events, reset, shutdown, and guest-state queries. VNC is not the AI control protocol.

## Security boundary

The VM subsystem is separate from CodexPro's host tools. Host Bash and file tools remain a local developer bridge with their existing restrictions; they are not converted into an OS sandbox merely because VM support exists.

VM instances improve isolation for software testing, but they do not make arbitrary code universally safe. CodexPro does not automatically mount the host workspace or inject `.env` files, SSH keys, cloud credentials, browser data, or credential stores into guests. Networking is QEMU user-mode networking by default, so guest software may still reach external networks.

Image names and instance IDs are validated, resources and timeouts are bounded, management channels are private, failed starts are cleaned up, and recursive deletion is limited to CodexPro-owned instance directories. Image import remains a human operation; the AI-facing `vm` tool can only list approved images and create, inspect the status of, or destroy disposable instances.

## Current limitations

- QEMU is the only backend.
- QEMU installation is always external to CodexPro.
- Hardware acceleration is required; no automatic TCG fallback is provided.
- Cross-architecture hardware-accelerated guests are rejected.
- Full guest command/file execution is deferred even when QEMU Guest Agent is available.
- Desktop screenshot/input APIs are foundations only; full desktop automation is deferred.
- Some aarch64 guest images may require firmware or machine-specific boot configuration that is not automatically provisioned by this first version.
