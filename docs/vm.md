# VM runtimes

CodexPro creates disposable guest operating systems for isolated software testing. Backend selection is automatic: **Windows: Hyper-V; Linux: QEMU/KVM; macOS: QEMU/HVF**. `VmManager` delegates lifecycle and normalized guest-control operations to separate backends; QMP, QGA, QEMU processes and qcow2 conversion stay in the QEMU implementation. Hyper-V lifecycle uses bounded calls to the standard PowerShell module, while Windows guest control uses PowerShell Direct. Agents use backend-neutral `vm_exec`, `vm_upload`, `vm_download`, and `vm_guest_status` tools rather than choosing a Hyper-V/QEMU transport.

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

It asks for an image name, source image path, architecture, default CPU count, default memory, VM storage location, desktop metadata, and whether to perform a validation boot. Boolean questions display their choices explicitly as `yes/no`. If the source is an installer `.iso`, the wizard also asks for the target virtual disk size. On Windows/Hyper-V, CodexPro mounts installer media read-only to detect Microsoft Windows setup media. When Windows is detected, the wizard reports that fact, defaults Secure Boot to the Microsoft Windows template, and asks whether to automate the disposable VM installation.

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

For a Windows installer ISO, setup creates a blank dynamic VHDX (64 GiB by default, `--disk-size` accepts 4–2048 GiB), creates a uniquely owned Generation 2 VM, attaches the ISO as DVD, puts DVD first in firmware boot order and opens VMConnect. Complete the installation, then shut down **inside the guest**. CodexPro waits for the VM's `Off` state, removes the temporary VM and imports the installed disk as an immutable base. Closing VMConnect alone does not finish installation. After installing the OS and shutting down the guest, you can type `finish` and press Enter in the CodexPro terminal to conclude setup immediately, including when a short VM boot/shutdown was missed by polling. If the guest is still running, CodexPro waits until it is powered off before importing the disk. Only type `finish` when installation is actually complete: it explicitly confirms that the powered-off disk is ready for import. Installation is bounded to four hours if not completed; Ctrl+C requests cleanup. The default virtual NIC is disconnected. Hyper-V Secure Boot is an image policy selected during setup: `--secure-boot off` preserves generic-UEFI behavior, `--secure-boot windows` enables the Microsoft Windows template, and `--secure-boot uefi-ca` enables the Microsoft UEFI Certificate Authority template used by supported Linux guests. Detected Windows installer media defaults to `windows`. The selected policy is persisted in the image manifest and reused for disposable instances. Windows 11 images should use `--secure-boot windows`; Microsoft requires Generation 2, Secure Boot and TPM for supported Hyper-V Windows 11 VMs. Each new Hyper-V VM, including ISO installers and disposable instances, receives a TPM 2.0 virtual device with its own local key protector before boot. Hyper-V emulates the guest TPM 2.0 independently of the host TPM's presence/version. If TPM provisioning fails, creation fails with the existing ownership-verified cleanup. No credentials or PowerShell Direct are required for lifecycle management.

For detected Windows media, `--windows-unattend` enables an opt-in Rufus-style unattended path; `--windows-user <name>` selects the local Administrator name and implies unattended setup, while `--no-windows-unattend` forces the normal interactive path. CodexPro never rewrites the Microsoft installer ISO. Instead it creates a tiny second read-only ISO containing `Autounattend.xml` at its root and attaches it as another virtual DVD, which is a location Windows Setup searches for answer files. The answer file accepts the EULA, disables encrypted-disk provisioning, wipes and partitions only the newly created VM Disk 0 (EFI + MSR + Windows), installs to the Windows partition, hides the online-account/wireless/OEM-registration/EULA screens, selects `ProtectYourPC=3` to avoid Express privacy settings, and creates the chosen local Administrator account. The account initially has a blank password and is marked to require a password change at first sign-in. CodexPro intentionally does not use the unsupported/deprecated `SkipMachineOOBE` shortcut and does not guess a Windows edition; a multi-edition ISO can therefore still show the edition chooser.

The vTPM belongs to the disposable VM, not the VHDX base. Its identity and TPM-sealed secrets do not survive replacement of the VM. Prepare base images with BitLocker/device encryption disabled and fully decrypted before import or installer shutdown: a fresh instance cannot unlock a base sealed to the installer's TPM. CodexPro does not clone TPM state or export host protector keys. See [Microsoft's key protector documentation](https://learn.microsoft.com/en-us/powershell/module/hyper-v/set-vmkeyprotector).

For an existing **powered-off** CodexPro VM, an administrator can run `scripts/vm-enable-tpm.ps1 -RuntimePath <instance-directory>/runtime.json`. The helper verifies the persisted GUID and Notes ownership token, preserves an existing key protector and does nothing if TPM is already enabled. It never stops a running VM. For an installation still supervised by `vm setup`, cancel setup and rerun with the updated build rather than shutting down an unfinished installer (shutdown signals image promotion).

VMConnect opens with the Windows installer VM **off**. Click **Start / Avvia**, click inside the guest display and immediately press **Space** at the CD/DVD boot prompt. Starting only after the console is open avoids missing this short prompt. If Hyper-V displays “SCSI DVD — The boot loader failed”, click **Restart now** and press Space immediately. Do not shut down an uninstalled guest just to dismiss that screen. Without an explicit terminal `finish` confirmation, setup must first observe the VM running before treating a later shutdown as completion; the initial off state cannot automatically promote a blank disk. If boot still fails after accepting the prompt, verify that the ISO is intact and supports x86_64 UEFI.

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

## Guest control

CodexPro exposes four backend-neutral agent tools: `vm_guest_status`, `vm_exec`, `vm_upload`, and `vm_download`. The caller supplies a CodexPro instance ID; the manager resolves the recorded backend and native VM identity. Agents never choose `Invoke-Command`, QGA RPC names, a Hyper-V display name, or an arbitrary host VM.

### Hyper-V / Windows guests

Windows guest control uses **PowerShell Direct**. Microsoft documents PowerShell Direct for local Hyper-V hosts and Windows 10 / Windows Server 2016 or later guests; the VM must be running with a user profile configured, the host caller must be a Hyper-V administrator, and valid guest credentials are required. PowerShell Direct works independently of guest network configuration and remote-management/WinRM settings. CodexPro uses `New-PSSession -VMId` with the already verified Hyper-V GUID, not a caller-supplied VM name, and always removes the PSSession. File transfer uses `Copy-Item -ToSession` / `-FromSession`. See [Microsoft: PowerShell Direct](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct) and [Copy-Item](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/copy-item).

Guest credentials are **operation-scoped only**. CodexPro does not store them in image manifests, runtime records, VM Notes, Git, tool results, or logs. The host PowerShell child receives the credential through its environment and converts it to a `PSCredential`; the password is not inserted into generated PowerShell source or the encoded structured command payload. The unattended Windows path still creates the local Administrator account with a blank initial password and requires a password change at first sign-in. Automation does not weaken that policy: set a usable password in the guest before PowerShell Direct can authenticate.

### QEMU guests

QEMU guest control uses the existing private **QEMU Guest Agent (QGA)** channel. Install/start the guest agent in the image (commonly the `qemu-guest-agent` package on Linux) and ensure the required RPCs are enabled. `vm_guest_status` uses `guest-info`; execution maps to `guest-exec` plus bounded `guest-exec-status` polling; stdout/stderr are decoded from QGA's base64 fields. File transfer uses `guest-file-open`, chunked `guest-file-read` / `guest-file-write`, `guest-file-flush`, and `guest-file-close` with handles closed in failure paths. See the official [QEMU Guest Agent](https://www.qemu.org/docs/master/interop/qemu-ga.html) and [QGA protocol reference](https://www.qemu.org/docs/master/interop/qemu-ga-ref.html).

The QGA client sends `guest-sync-delimited` on initial connection and again after a client-side timeout, as required by QEMU to discard stale/partial protocol data. A QGA command timeout is a transport error; a guest process returning exit code 1 (or any other nonzero code) is a normal `vm_exec` result, not an MCP transport failure.

### Execution semantics and limits

`vm_exec` has one canonical internal representation: executable + argv + environment. The agent must provide exactly one of:

- `argv`: a non-empty array executed directly; no host shell concatenation is performed.
- `command` plus an explicit `shell`: `powershell`, `cmd`, `sh`, or `bash`. `sh` uses `/bin/sh -c`; `bash` uses `/bin/bash -lc`; PowerShell uses noninteractive `powershell.exe -Command`; `cmd` uses `cmd.exe /d /s /c`.

A working directory is supported for shell-command mode through fixed guest-side wrappers. Direct `argv` + `cwd` is rejected because QGA has no portable working-directory field. `cmd` + `cwd` is also rejected; use PowerShell for a Windows working directory. Environment variable names and aggregate environment size are validated.

The default execution timeout is **30 seconds** and the maximum is **300 seconds**. Stdout and stderr are retained separately and capped at **48 KiB each**, with truncation flags. Hyper-V attempts to kill the guest process when its execution deadline expires. QGA has no generic guest-process kill RPC, so a process reported as timed out may continue running in the guest; destroy/reset the disposable VM if that matters for the workflow.

`vm_upload` and `vm_download` are limited to **1 MiB per file** in the current MCP surface. QGA transfers in **48 KiB chunks**. Hyper-V transfer stages data only through a random temporary file inside the CodexPro-owned instance directory and a PowerShell Direct session; MCP callers cannot provide arbitrary host source/destination paths. A download's canonical base64 payload is retained in the existing in-memory output store and `vm_download` returns its `output_resource_id`, `workspace_id`, encoding, and total character count. Use `read_output` on the returned resource, following `next_offset` until null, then concatenate the pages before base64-decoding. These primitives are intended for source snippets, build outputs, logs, dumps, and similar bounded artifacts, not bulk disk transfer.

## Management channels and desktop metadata

QEMU lifecycle management uses private QMP and guest control uses a distinct private QGA channel. Linux/macOS use managed local sockets/pipes/endpoints recorded in the instance runtime. Hyper-V lifecycle uses native PowerShell cmdlets, while guest control uses PowerShell Direct after the same GUID/Notes ownership verification.

`--desktop` records that the image provides a graphical desktop. Full desktop automation and human VNC/noVNC viewing are not implemented here. Persistent interactive shells/PTYs are also intentionally not implemented: agents should use sequences of bounded `vm_exec` calls.

## Security boundary

The VM subsystem is separate from CodexPro's host tools. Guest execution is intentionally powerful **inside the selected guest**, but it is not arbitrary host command execution. Host PowerShell bodies are fixed; user commands, argv, environment values, guest paths, IDs, and other values travel as structured data. CodexPro does not use `Invoke-Expression` or interpolate guest command text into host PowerShell.

Every guest operation first resolves a CodexPro-managed instance. QEMU requires the stored private QGA endpoint and a live managed QEMU process. Hyper-V requires the persisted VM GUID and exact random ownership token in VM Notes before establishing PowerShell Direct; display names do not authorize access. Guest operations share the Hyper-V instance operation lock with lifecycle/destruction, so a destroy cannot race an active guest operation.

CodexPro does not automatically mount the host workspace or inject `.env` files, SSH keys, cloud credentials, browser data, or credential stores into guests. QEMU uses user-mode networking, so guests may reach external networks. Hyper-V starts with its NIC disconnected unless a human changes networking. The lifecycle `vm` tool still only lists approved images and creates/statuses/destroys instances; guest operations are the separate normalized tools above.

## Current limitations

- Hyper-V and QEMU installation/configuration are external to CodexPro.
- Hardware acceleration is required; Windows has no automatic QEMU or VirtualBox fallback.
- Cross-architecture hardware-accelerated guests are rejected.
- Hyper-V PowerShell Direct guest control supports compatible Windows guests; Linux guests on Hyper-V are not given a separate SSH/WinRM fallback.
- QEMU guest control requires QGA and the relevant RPCs to be enabled in the guest.
- A QGA-timed-out guest process may continue because QGA does not expose a generic process-kill command.
- File transfer is intentionally bounded to 1 MiB per call/file; bulk transfer and streaming resources are not implemented.
- Persistent interactive PTY/shell sessions and GUI automation remain deferred.
- Some aarch64 guest images may require firmware or machine-specific boot configuration that is not automatically provisioned.

## Verification

`npm run vm:guest:smoke` runs normalized API validation plus a mocked QGA server covering synchronization/recovery, `guest-exec` polling, nonzero exits, timeouts, output truncation, agent-unavailable errors, file chunking, handle cleanup, backend/state guards, and secret-key redaction. `npm run vm:hyperv:smoke` covers PowerShell Direct fixed-script structure, VM GUID/Notes ownership, transient credentials, nonzero exits, timeouts, file transfer and cleanup in addition to lifecycle tests; on Windows it parses generated scripts with the native Windows PowerShell parser without executing them. `npm run vm:hyperv:integration` remains the opt-in native Hyper-V lifecycle test. `npm test` runs both guest-control smoke paths with the complete project smoke suite.
