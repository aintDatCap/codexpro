# VM runtimes

CodexPro creates disposable guest operating systems for isolated software testing. Backend selection is automatic: **Windows: Hyper-V; Linux: QEMU/KVM; macOS: QEMU/HVF**. `VmManager` delegates lifecycle operations to separate backends; QMP, QGA, QEMU processes and qcow2 conversion stay in the QEMU implementation. Hyper-V uses bounded calls to the standard PowerShell module with structured JSON data. Neither backend exposes guest execution yet.

## Host prerequisites

Windows requires an x86_64 host with hardware virtualization enabled in firmware, SLAT, a running Hyper-V hypervisor/service, the Hyper-V PowerShell module and VMConnect for interactive installs. Use Windows 11 Pro, Enterprise or Education, or a supported Windows Server with the Hyper-V role. Windows Home does not include the full Hyper-V role. Windows 10 Pro/Enterprise also provide Hyper-V, subject to Microsoft's OS support lifecycle. See [Microsoft's Hyper-V overview](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/overview) and [installation requirements](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v).

Enable the Hyper-V platform and management tools yourself, then restart. Use an elevated administrator token or active membership in Hyper-V Administrators (sign out/in after a membership change), with access to the chosen storage directory. **CodexPro never enables Windows features or changes host configuration automatically. Windows does not need QEMU or qemu-img.**

`vm doctor` checks module/cmdlets, hypervisor/service, management permissions, VMConnect, storage access and managed image/active instance counts. On Windows it is read-only, including when the storage directory does not exist. Permission failures may prevent hypervisor detection; resolve permissions before interpreting a failed readiness check as a missing feature.

Install QEMU using the package or deployment method appropriate for your system, then make `qemu-img` and the relevant `qemu-system-*` executable available on `PATH`.

- Windows: use native Hyper-V as described above.
- Linux: install QEMU and configure KVM access where hardware virtualization is available.
- macOS: install QEMU; CodexPro uses HVF.

CodexPro will not silently fall back to TCG software emulation when hardware acceleration is unavailable.

Verify the host before importing images:

```bash
codexpro vm doctor
```

On Linux/macOS you can override binary discovery for a managed QEMU installation:

```bash
codexpro vm doctor --qemu /path/to/qemu-system-x86_64 --qemu-img /path/to/qemu-img
```

The same QEMU overrides can be supplied through `CODEXPRO_QEMU` and `CODEXPRO_QEMU_IMG`. Windows rejects explicit `--qemu`/`--qemu-img` options and ignores these QEMU environment variables.

## Prepare an image

Run the interactive wizard:

```bash
codexpro vm setup
```

It asks for an image name, source image path, architecture, default CPU count, default memory, VM storage location, desktop metadata, and whether to perform a validation boot. Boolean questions display their choices explicitly as `yes/no`. If the source is an installer `.iso`, the wizard also asks for the target virtual disk size.

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

On Windows, setup imports detached standalone **VHD/VHDX** disks using `Get-VHD`, `Convert-VHD` and `Test-VHD`, producing `base.vhdx`. Differencing sources and attached disks are rejected. The disk must contain a Generation 2-compatible x86_64 UEFI installation: converting a BIOS/Generation 1 disk does not make it UEFI-bootable. qcow2/raw input receives an actionable error; convert it manually outside CodexPro, for example with separately installed `qemu-img convert -O vhdx source.qcow2 converted.vhdx`, then import the converted disk. CodexPro itself never invokes QEMU for Windows setup or execution.

On Linux/macOS, CodexPro inspects disks with `qemu-img`, converts them into self-contained qcow2 files and checks them. Both backends hash the resulting base with SHA-256 and atomically register it in the private image store. Source images with external backing files are rejected; flatten such chains yourself before import.

For a Windows installer ISO, setup creates a blank dynamic VHDX (64 GiB by default, `--disk-size` accepts 4–2048 GiB), creates a uniquely owned Generation 2 VM, attaches the ISO as DVD, puts DVD first in firmware boot order and opens VMConnect. Complete the installation, then shut down **inside the guest**. CodexPro waits for the VM's `Off` state, removes the temporary VM and imports the installed disk as an immutable base. Closing VMConnect alone does not finish installation. Installation is bounded to four hours; Ctrl+C requests cleanup. The default virtual NIC is disconnected and Secure Boot is disabled for generic UEFI media. Each new Hyper-V VM, including ISO installers and disposable instances, receives a TPM 2.0 virtual device with its own local key protector before boot. Hyper-V emulates the guest TPM 2.0 independently of the host TPM's presence/version. If TPM provisioning fails, creation fails with the existing ownership-verified cleanup. Secure Boot configuration remains separate. No credentials or PowerShell Direct are required for lifecycle management.

The vTPM belongs to the disposable VM, not the VHDX base. Its identity and TPM-sealed secrets do not survive replacement of the VM. Prepare base images with BitLocker/device encryption disabled and fully decrypted before import or installer shutdown: a fresh instance cannot unlock a base sealed to the installer's TPM. CodexPro does not clone TPM state or export host protector keys. See [Microsoft's key protector documentation](https://learn.microsoft.com/en-us/powershell/module/hyper-v/set-vmkeyprotector).

For an existing **powered-off** CodexPro VM, an administrator can run `scripts/vm-enable-tpm.ps1 -RuntimePath <instance-directory>/runtime.json`. The helper verifies the persisted GUID and Notes ownership token, preserves an existing key protector and does nothing if TPM is already enabled. It never stops a running VM. For an installation still supervised by `vm setup`, cancel setup and rerun with the updated build rather than shutting down an unfinished installer (shutdown signals image promotion).

VMConnect opens with the Windows installer VM **off**. Click **Start / Avvia**, click inside the guest display and immediately press **Space** at the CD/DVD boot prompt. Starting only after the console is open avoids missing this short prompt. If Hyper-V displays “SCSI DVD — The boot loader failed”, click **Restart now** and press Space immediately. Do not shut down an uninstalled guest just to dismiss that screen. Setup waits until it has observed the VM running before treating a later shutdown as installation completion; the initial off state never promotes the blank disk. If boot still fails after accepting the prompt, verify that the ISO is intact and supports x86_64 UEFI.

For a Linux/macOS installer `.iso`, CodexPro creates a blank qcow2 disk and launches `qemu-system-*` with read-only CD-ROM installation media. Complete installation in the QEMU window and shut down the guest to import the installed disk. ISO installs are interactive on both backends: `.iso` is not supported with `--headless`.

The QEMU backend supervises installers through private QMP. Resumable `paused`/`prelaunch` states receive `cont`; fatal states abort with log context. Existing QMP timeout, TCG latency and legacy WHPX failure-handling code/tests remain preserved, but the Windows default no longer uses that execution path.

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

On Windows, the corresponding files are `base.vhdx`, `overlay.vhdx`, `runtime.json` and `hyperv-identity.json`; Hyper-V configuration files live in the instance directory. ISO installations use `installed.vhdx` in a temporary registered instance. The manifest stores only a source filename/provenance label. ISO-installed disks use `.installed.vhdx` or `.installed.qcow2` labels.

New manifests and runtime records use **schemaVersion 2** with an explicit `backend` (`hyperv` or `qemu`); image `format` is `vhdx` or `qcow2` respectively. QEMU accelerators/endpoints/PIDs are optional backend-specific fields, rejected in Hyper-V runtime records. Hyper-V records contain a random 256-bit ownership ID and the VM GUID. Version 1 records remain readable as QEMU without bulk migration or disk conversion. Existing QEMU images are still listable/inspectable on Windows but cannot be booted there through the new default. Re-import a native disk under a new image name. Old Windows QEMU instances must be stopped/cleaned up with their original backend/version; Hyper-V refuses to delete them.

Rollback: existing version 1 image stores remain usable with older releases. Older releases cannot read newly created version 2 entries; retain them separately or return to this release to destroy instances. Do not run old and new writers concurrently against the same store. No automatic destructive schema contraction or base conversion occurs.

TCG installer supervision polls every two seconds with a five-second QMP command timeout. A command timeout alone does not mean the guest failed: CodexPro retries on the same connection, ignoring replies for expired request IDs, and reconnects if the channel disconnects. It aborts after 60 seconds of continuous QMP unresponsiveness. Fatal guest states and process exits still terminate supervision; WHPX/KVM/HVF retain the existing 500 ms poll interval and 1.5-second command timeout. Installer log polling for the WHPX failure signature is skipped for TCG.

## Immutable base images and disposable overlays

CodexPro treats every managed `base.qcow2` or `base.vhdx` as immutable. It records its hash and size, marks it read-only where supported, verifies it before creating an instance, and never attaches it writable.

Each instance gets its own qcow2 overlay or Hyper-V differencing VHDX whose parent is the managed base:

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

Destroying an instance stops/removes its VM and deletes only the CodexPro-owned instance directory. It never merges the child back into the base. Hyper-V destruction requires the persisted GUID and an exact match of the random ownership token in VM Notes. Display names never authorize deletion. Management failures do not imply that a VM is absent; unverified state is retained.

Failed Hyper-V starts/installations retain the disk, runtime error and identity journal for diagnosis, and attempt to stop/remove only the verified VM. Errors explicitly report when a VM may remain running. Use `vm list` and `vm destroy <id>` to clean up after resolving the failure. A killed process can leave `operation.lock`: verify that no lifecycle/setup process is still active before manually removing that lock. If the identity journal is missing/corrupt or Notes changed, automatic destruction is refused; inspect the exact GUID in Hyper-V Manager and recover manually. Never use a matching display name alone as proof of ownership.

Manual lifecycle commands are:

```bash
codexpro vm images
codexpro vm inspect ubuntu-dev
codexpro vm create ubuntu-dev
codexpro vm list
codexpro vm destroy vm-0123456789abcdef
```

## Guest requirements

QEMU images may contain and start QEMU Guest Agent at boot for readiness detection. Hyper-V does not require QGA. Prepare whatever compilers, runtimes and test tools your workflow needs inside the guest.

Common Linux distributions package the agent as `qemu-guest-agent`. Install the distribution package and enable its service before importing the image. Exact package/service names vary by distribution.

A validation boot checks that the selected backend starts the VM and remains running after a short interval; this is not proof the guest OS completed boot. QEMU additionally probes QGA; Hyper-V reports guest-agent availability as false. CodexPro reports these separately:

```text
Boot                 ✓
QEMU Guest Agent     ✗
AI command execution unavailable
```

A boot-tested image is not automatically CodexPro-compatible. Guest command/file execution is intentionally not exposed in this first implementation, and CodexPro will not claim guest commands ran when the guest-agent channel is unavailable.

## Management channels and desktop metadata

QEMU lifecycle management uses private QMP, with QGA as an optional separate guest channel. Linux/macOS use sockets in the instance directory. Hyper-V uses native PowerShell cmdlets and GUID/Notes ownership checks, without QMP or QGA.

`--desktop` records that the image provides a graphical desktop. Full desktop automation and human VNC/noVNC viewing are not implemented here. The QMP layer is typed and already provides bounded foundations for later screenshots, input events, reset, shutdown, and guest-state queries. VNC is not the AI control protocol.

## Security boundary

The VM subsystem is separate from CodexPro's host tools. Host Bash and file tools remain a local developer bridge with their existing restrictions; they are not converted into an OS sandbox merely because VM support exists.

VM instances improve isolation for software testing, but they do not make arbitrary code universally safe. CodexPro does not automatically mount the host workspace or inject `.env` files, SSH keys, cloud credentials, browser data, or credential stores into guests. QEMU uses user-mode networking, so guests may reach external networks. Hyper-V starts with its NIC disconnected: no Default Switch, external/LAN bridge, host NAT configuration or automatic port exposure. Network-dependent installers require an explicit human network decision in Hyper-V Manager; future instances again default to disconnected.

Image names and instance IDs are validated, resources and timeouts are bounded, management channels are private, failed starts are cleaned up, and recursive deletion is limited to CodexPro-owned instance directories. Image import remains a human operation; the AI-facing `vm` tool can only list approved images and create, inspect the status of, or destroy disposable instances.

## Current limitations

- Hyper-V and QEMU installation/configuration are external to CodexPro.
- Hardware acceleration is required; Windows has no automatic QEMU or VirtualBox fallback.
- Cross-architecture hardware-accelerated guests are rejected.
- Full guest command/file execution is deferred even when QEMU Guest Agent is available.
- Desktop screenshot/input APIs are foundations only; full desktop automation is deferred.
- Some aarch64 guest images may require firmware or machine-specific boot configuration that is not automatically provisioned by this first version.
- PowerShell Direct, host/guest file transfer, Hyper-V screenshots/desktop input and optional VirtualBox fallback remain follow-up work.

## Verification

`npm run vm:hyperv:smoke` runs platform/schema/argument tests and mocked PowerShell lifecycle, ownership and failure-recovery tests without requiring Hyper-V. On Windows it also parses generated scripts with the native PowerShell parser without executing them. `npm run vm:hyperv:integration` checks readiness, then uses a newly created blank disposable disk/VM only, verifies that vTPM and a key protector are present, or reports a skip. It never uses an existing image or arbitrary existing VM. Booting a blank disk validates lifecycle, not guest OS installation; a real interactive ISO install still needs human validation. `npm test` includes the existing QEMU reliability and new Hyper-V smoke tests.
