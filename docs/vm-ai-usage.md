# VM usage for AI agents

CodexPro's VM runtime provides disposable QEMU guests for testing software. Treat it as a separate execution environment from the host repository.

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
11. If QEMU Guest Agent is unavailable, do not claim commands or file operations were executed in the guest.
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

It does not accept image-import paths, arbitrary host filesystem deletion targets, or raw QMP commands. Guest `exec` is not exposed in this version.

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
    separate local QMP/QGA management channels
```

A VM instance can be useful even before guest command execution is exposed for manual validation and lifecycle testing, but its mere existence is not evidence that software was executed successfully inside the guest.
