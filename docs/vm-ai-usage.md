# VM usage for AI agents

CodexPro provides disposable guests for testing software: **Windows: Hyper-V; Linux: QEMU/KVM; macOS: QEMU/HVF**. Treat a VM as a separate execution environment from the host repository. Images and instances expose their backend; Windows requires VHDX bases and uses disposable differencing disks. Legacy QEMU images remain readable but need human re-import into a native Windows format before Windows execution.

## Rules

1. Never install or import VM images yourself. Image approval and import are human operations through `codexpro vm setup`.
2. Only use images already returned by the `vm` tool's `images` action.
3. Prefer disposable VMs for potentially destructive, untrusted, or OS-sensitive software tests when a suitable approved image exists.
4. Treat the VM filesystem as disposable.
5. Do not expect changes made in a VM to appear automatically in the host repository.
6. Collect any needed logs, test output, screenshots, or other artifacts before destroying the instance once those transfer capabilities exist.
7. Never assume host secrets, credentials, SSH keys, browser state, or environment variables exist inside a VM.
8. Never attempt to modify the immutable base image or commit an overlay into it.
9. Destroy disposable instances when they are no longer needed.
10. State clearly whether evidence came from host tools or from a VM.
11. Guest commands and file operations are not exposed on either backend. QGA readiness is QEMU-specific and does not itself prove guest execution. Hyper-V lifecycle needs neither QGA nor PowerShell Direct.
12. If hardware acceleration is unavailable, report that condition instead of pretending the VM ran or silently requesting software emulation.

VMs improve isolation, but they do not make every unsafe action safe. Continue to minimize privileges, network exposure, and destructive behavior.

## Bounded VM tool

The AI-facing tool is intentionally one bounded `vm` tool:

```json
{ "action": "images" }
```

```json
{ "action": "create", "image": "ubuntu-dev" }
```

```json
{ "action": "status", "id": "vm-0123456789abcdef" }
```

```json
{ "action": "destroy", "id": "vm-0123456789abcdef" }
```

It does not accept image-import paths, arbitrary host deletion targets, raw QMP commands or arbitrary PowerShell. Guest `exec` is not exposed. Hyper-V verifies the persisted VM GUID and ownership token before destruction; if verification fails, report the error and preserve state instead of guessing from a VM display name.

Hyper-V networking is disconnected by default. Never assume internet/LAN access or automatically connect an external switch. QEMU retains user-mode networking. Neither backend automatically mounts the workspace or injects secrets. Failed Hyper-V setup/start can retain diagnostic disks and runtime metadata; cleanup errors explicitly say if a VM may remain running. Report this to the human.

## Recommended workflow

```text
inspect host repo
→ choose a human-approved image
→ create disposable VM
→ transfer/copy test source when that capability exists
→ run build/tests when guest execution is supported
→ collect output/screenshots
→ destroy VM
```

Do not fabricate the unavailable transfer or guest-execution steps. If the current tool surface cannot perform a step, say so and keep host and guest evidence separate.

## Host versus VM

```text
Host bash:
    protected local developer execution
    existing CodexPro host safety rules still apply
    not an OS sandbox

VM execution:
    disposable OS-level guest environment
    immutable base + per-instance overlay
    backend-specific management (Hyper-V PowerShell or local QMP/QGA)
```

A VM instance can be useful even before guest command execution is exposed for manual validation and lifecycle testing, but its mere existence is not evidence that software was executed successfully inside the guest.
