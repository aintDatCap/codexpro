import path from "node:path";
import { nodeCommandExecutor, type CommandExecutor } from "../../command.js";

// Only these scripts execute. Values enter as base64-encoded JSON, never as PowerShell syntax.
const ownedVm = `
$vm = Get-VM -Id ([Guid]$p.vmId) -ErrorAction Stop
if ($vm.Notes -cne ('CodexPro:' + $p.ownershipId)) { throw 'Hyper-V ownership could not be verified; refusing operation.' }
`;

export const hypervScripts = {
  doctor: `
$module = [bool](Get-Module -ListAvailable Hyper-V)
$commands = $false; $service = $false; $hypervisor = $false; $permission = $false
if ($module) {
  Import-Module Hyper-V
  $commands = $true
  foreach ($name in @('New-VM','Get-VM','Set-VM','Set-VMProcessor','Set-VMFirmware','Add-VMDvdDrive','Get-VMHardDiskDrive','Get-VMNetworkAdapter','Disconnect-VMNetworkAdapter','Start-VM','Stop-VM','Remove-VM','New-VHD','Get-VHD','Convert-VHD','Test-VHD')) {
    if (!(Get-Command $name -ErrorAction SilentlyContinue)) { $commands = $false }
  }
}
$svc = Get-Service vmms -ErrorAction SilentlyContinue
$service = $null -ne $svc -and $svc.Status -eq 'Running'
try { $hypervisor = [bool](Get-CimInstance Win32_ComputerSystem).HypervisorPresent } catch {}
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$permission = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or $principal.IsInRole([Security.Principal.SecurityIdentifier]'S-1-5-32-578')
if ($permission -and $module) { try { Get-VMHost | Out-Null } catch { $permission = $false } }
@{ module=$module; commands=$commands; service=$service; hypervisor=$hypervisor; permission=$permission; console=[bool](Get-Command vmconnect.exe -ErrorAction SilentlyContinue) } | ConvertTo-Json -Compress
`,
  import: `
$disk = Get-VHD -Path $p.source
if ($disk.ParentPath -or $disk.VhdType -eq 'Differencing' -or $disk.Attached) { throw 'Import requires a detached standalone VHD/VHDX without a parent.' }
Convert-VHD -Path $p.source -DestinationPath $p.destination -VHDType Dynamic
$base = Get-VHD -Path $p.destination
if ($base.ParentPath -or $base.VhdFormat -ne 'VHDX' -or !(Test-VHD -Path $p.destination)) { throw 'Invalid standalone VHDX.' }
@{ size=[long]$base.Size } | ConvertTo-Json -Compress
`,
  disk: `
if ($p.parent) { New-VHD -Path $p.disk -ParentPath $p.parent -Differencing | Out-Null }
else { New-VHD -Path $p.disk -SizeBytes ([long]$p.size) -Dynamic | Out-Null }
@{ ok=$true } | ConvertTo-Json -Compress
`,
  create: `
$vm = New-VM -Name $p.name -Generation 2 -MemoryStartupBytes ([long]$p.memory) -VHDPath $p.disk -Path $p.directory
# Journal the GUID before any start. A lost Node response must not lose VM identity.
@{ vmId=$vm.Id.ToString(); ownershipId=$p.ownershipId } | ConvertTo-Json -Compress | Set-Content -LiteralPath $p.journal -Encoding UTF8
Set-VM -VM $vm -Notes ('CodexPro:' + $p.ownershipId) -AutomaticStartAction Nothing -AutomaticStopAction TurnOff -CheckpointType Disabled
Set-VMProcessor -VM $vm -Count ([int]$p.cpus)
Get-VMNetworkAdapter -VM $vm | Disconnect-VMNetworkAdapter
# Generic modern UEFI media: Secure Boot is off; no guest credential is needed.
Set-VMFirmware -VM $vm -EnableSecureBoot Off
if ($p.iso) {
  $dvd = Add-VMDvdDrive -VM $vm -Path $p.iso -Passthru
  Set-VMFirmware -VM $vm -FirstBootDevice $dvd
} else {
  $drive = Get-VMHardDiskDrive -VM $vm | Select-Object -First 1
  Set-VMFirmware -VM $vm -FirstBootDevice $drive
}
@{ vmId=$vm.Id.ToString() } | ConvertTo-Json -Compress
`,
  start: ownedVm + `Start-VM -VM $vm
@{ state=(Get-VM -Id $vm.Id).State.ToString() } | ConvertTo-Json -Compress`,
  status: ownedVm + `@{ state=$vm.State.ToString() } | ConvertTo-Json -Compress`,
  destroy: `
# Get-VM errors (including permission/service errors) are never interpreted as absence.
$vms = @(Get-VM -ErrorAction Stop | Where-Object { $_.Id -eq [Guid]$p.vmId })
if ($vms.Count -eq 0) { @{ removed=$true } | ConvertTo-Json -Compress; exit 0 }
if ($vms.Count -ne 1) { throw 'Ambiguous VM identity.' }
$vm = $vms[0]
if ($vm.Notes -cne ('CodexPro:' + $p.ownershipId)) { throw 'Hyper-V ownership could not be verified; refusing destroy.' }
if ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force -Confirm:$false }
if ((Get-VM -Id $vm.Id).State -ne 'Off') { throw 'VM has not stopped; preserving instance files.' }
Remove-VM -VM $vm -Force -Confirm:$false
@{ removed=$true } | ConvertTo-Json -Compress
`,
  console: ownedVm + `
Start-Process -FilePath "$env:SystemRoot\\System32\\vmconnect.exe" -ArgumentList @('localhost', '-G', $vm.Id.ToString()) | Out-Null
@{ ok=$true } | ConvertTo-Json -Compress
`
} as const;

export type HypervOperation = keyof typeof hypervScripts;

export class HypervPowerShell {
  constructor(private readonly executor: CommandExecutor = nodeCommandExecutor) {}

  async run<T>(operation: HypervOperation, values: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const payload = Buffer.from(JSON.stringify(values), "utf8").toString("base64");
    const script = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\ntry {\n$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json\n${operation === "doctor" ? "" : "Import-Module Hyper-V\n"}${hypervScripts[operation]}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
    const binary = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = await this.executor.run(binary, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeoutMs });
    if (result.exitCode !== 0) throw new Error(`Hyper-V ${operation} failed: ${(result.stderr || result.stdout || "command failed or timed out").trim().slice(-4000)}`);
    try { return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()) as T; }
    catch { throw new Error(`Hyper-V ${operation} returned invalid JSON.`); }
  }
}
