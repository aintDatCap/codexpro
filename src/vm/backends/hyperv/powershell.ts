import path from "node:path";
import { nodeCommandExecutor, type CommandExecutor } from "../../command.js";
import type { VmGuestCredential } from "../../guestControl.js";

// Only these scripts execute. Values enter as base64-encoded JSON, never as PowerShell syntax.
const ownedVm = `
$vm = Get-VM -Id ([Guid]$p.vmId) -ErrorAction Stop
if ($vm.Notes -cne ('CodexPro:' + $p.ownershipId)) { throw 'Hyper-V ownership could not be verified; refusing operation.' }
`;

const guestCredential = `
if ([string]::IsNullOrEmpty($env:CODEXPRO_HYPERV_GUEST_CREDENTIAL)) { throw 'Guest credentials are required for PowerShell Direct.' }
$secretData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEXPRO_HYPERV_GUEST_CREDENTIAL)) | ConvertFrom-Json
$secure = ConvertTo-SecureString ([string]$secretData.password) -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential ([string]$secretData.username), $secure
`;

export const hypervScripts = {
  doctor: `
$module = [bool](Get-Module -ListAvailable Hyper-V)
$commands = $false; $service = $false; $hypervisor = $false; $permission = $false
if ($module) {
  Import-Module Hyper-V
  $commands = $true
  foreach ($name in @('New-VM','Get-VM','Set-VM','Set-VMProcessor','Set-VMFirmware','Set-VMKeyProtector','Get-VMKeyProtector','Enable-VMTPM','Get-VMSecurity','Add-VMDvdDrive','Get-VMHardDiskDrive','Get-VMNetworkAdapter','Disconnect-VMNetworkAdapter','Start-VM','Stop-VM','Remove-VM','New-VHD','Get-VHD','Convert-VHD','Test-VHD','Get-DiskImage','Mount-DiskImage','Dismount-DiskImage','Get-Volume')) {
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
  inspectIso: `
$image = Get-DiskImage -ImagePath $p.iso -ErrorAction Stop
$wasAttached = [bool]$image.Attached
try {
  if (!$wasAttached) { $image = Mount-DiskImage -ImagePath $p.iso -PassThru -ErrorAction Stop }
  $volume = @($image | Get-Volume -ErrorAction Stop | Where-Object { $_.DriveLetter }) | Select-Object -First 1
  if ($null -eq $volume) { throw 'Mounted ISO has no readable volume.' }
  $root = $volume.DriveLetter + ':\\'
  $hasSetup = Test-Path -LiteralPath (Join-Path $root 'setup.exe') -PathType Leaf
  $hasInstallImage = (Test-Path -LiteralPath (Join-Path $root 'sources\\install.wim') -PathType Leaf) -or (Test-Path -LiteralPath (Join-Path $root 'sources\\install.esd') -PathType Leaf) -or (Test-Path -Path (Join-Path $root 'sources\\install*.swm') -PathType Leaf)
  @{ windows=[bool]($hasSetup -and $hasInstallImage); label=[string]$volume.FileSystemLabel } | ConvertTo-Json -Compress
} finally {
  if (!$wasAttached) { Dismount-DiskImage -ImagePath $p.iso -ErrorAction SilentlyContinue | Out-Null }
}
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
Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
Enable-VMTPM -VM $vm
if (!(Get-VMSecurity -VM $vm).TpmEnabled) { throw 'Virtual TPM could not be enabled.' }
Set-VMProcessor -VM $vm -Count ([int]$p.cpus)
Get-VMNetworkAdapter -VM $vm | Disconnect-VMNetworkAdapter
if ($p.secureBoot -eq 'windows') {
  Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate 'MicrosoftWindows'
} elseif ($p.secureBoot -eq 'uefi-ca') {
  Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate 'MicrosoftUEFICertificateAuthority'
} elseif ($p.secureBoot -eq 'off') {
  Set-VMFirmware -VM $vm -EnableSecureBoot Off
} else {
  throw 'Invalid Hyper-V secure boot mode.'
}
if ($p.iso) {
  $dvd = Add-VMDvdDrive -VM $vm -Path $p.iso -Passthru
  if ($p.unattendIso) { Add-VMDvdDrive -VM $vm -Path $p.unattendIso | Out-Null }
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
  guestStatus: ownedVm + guestCredential + `
if ($vm.State -ne 'Running') { throw 'VM is not running.' }
$s = $null
try {
  $s = New-PSSession -VMId $vm.Id -Credential $credential -ErrorAction Stop
  @{ available=$true } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $s) { Remove-PSSession -Session $s -ErrorAction SilentlyContinue }
}
`,
  guestExec: ownedVm + guestCredential + `
if ($vm.State -ne 'Running') { throw 'VM is not running.' }
$s = $null
try {
  $s = New-PSSession -VMId $vm.Id -Credential $credential -ErrorAction Stop
  $result = Invoke-Command -Session $s -ScriptBlock {
    param($spec)
    function Quote-CodexProArg([string]$value) {
      if ($value.Length -gt 0 -and $value -notmatch '[\\s"]') { return $value }
      $builder = New-Object Text.StringBuilder
      [void]$builder.Append('"')
      $slashes = 0
      foreach ($ch in $value.ToCharArray()) {
        if ($ch -eq '\\') { $slashes++; continue }
        if ($ch -eq '"') {
          if ($slashes -gt 0) { [void]$builder.Append(('\\' * ($slashes * 2))) }
          [void]$builder.Append('\\')
          [void]$builder.Append('"')
          $slashes = 0
          continue
        }
        if ($slashes -gt 0) { [void]$builder.Append(('\\' * $slashes)); $slashes = 0 }
        [void]$builder.Append($ch)
      }
      if ($slashes -gt 0) { [void]$builder.Append(('\\' * ($slashes * 2))) }
      [void]$builder.Append('"')
      return $builder.ToString()
    }
    function Read-CodexProPrefix([string]$filename, [int]$limit) {
      $stream = [IO.File]::Open($filename, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      try {
        $count = [int][Math]::Min([long]$limit, $stream.Length)
        $bytes = New-Object byte[] $count
        $read = $stream.Read($bytes, 0, $count)
        if ($read -le 0) { $bytes = [byte[]]::new(0) }
        elseif ($read -lt $count) { $bytes = $bytes[0..($read - 1)] }
        return @{ data=[Convert]::ToBase64String($bytes); truncated=($stream.Length -gt $limit) }
      } finally { $stream.Dispose() }
    }

    $outPath = [IO.Path]::GetTempFileName()
    $errPath = [IO.Path]::GetTempFileName()
    $outFile = $null; $errFile = $null; $process = $null
    try {
      $psi = New-Object Diagnostics.ProcessStartInfo
      $psi.FileName = [string]$spec.executable
      $psi.UseShellExecute = $false
      $psi.CreateNoWindow = $true
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError = $true
      $psi.Arguments = [string]::Join(' ', @($spec.args | ForEach-Object { Quote-CodexProArg ([string]$_) }))
      foreach ($entry in $spec.env.PSObject.Properties) { $psi.EnvironmentVariables[$entry.Name] = [string]$entry.Value }
      $process = New-Object Diagnostics.Process
      $process.StartInfo = $psi
      if (!$process.Start()) { throw 'Guest process did not start.' }
      $outFile = [IO.File]::Open($outPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
      $errFile = [IO.File]::Open($errPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
      $outTask = $process.StandardOutput.BaseStream.CopyToAsync($outFile)
      $errTask = $process.StandardError.BaseStream.CopyToAsync($errFile)
      $timedOut = !$process.WaitForExit([int]$spec.timeoutMs)
      if ($timedOut) {
        try { $process.Kill() } catch {}
        [void]$process.WaitForExit(2000)
      }
      [void]$outTask.Wait(5000); [void]$errTask.Wait(5000)
      $outFile.Dispose(); $outFile = $null
      $errFile.Dispose(); $errFile = $null
      $stdout = Read-CodexProPrefix $outPath ([int]$spec.maxOutputBytes)
      $stderr = Read-CodexProPrefix $errPath ([int]$spec.maxOutputBytes)
      @{ exitCode=$(if ($timedOut) { $null } else { $process.ExitCode }); timedOut=$timedOut; stdoutB64=$stdout.data; stderrB64=$stderr.data; stdoutTruncated=$stdout.truncated; stderrTruncated=$stderr.truncated }
    } finally {
      if ($null -ne $outFile) { $outFile.Dispose() }
      if ($null -ne $errFile) { $errFile.Dispose() }
      if ($null -ne $process) { $process.Dispose() }
      Remove-Item -LiteralPath $outPath,$errPath -Force -ErrorAction SilentlyContinue
    }
  } -ArgumentList $p.spec
  $result | ConvertTo-Json -Compress
} finally {
  if ($null -ne $s) { Remove-PSSession -Session $s -ErrorAction SilentlyContinue }
}
`,
  guestUpload: ownedVm + guestCredential + `
if ($vm.State -ne 'Running') { throw 'VM is not running.' }
$s = $null
try {
  $s = New-PSSession -VMId $vm.Id -Credential $credential -ErrorAction Stop
  Copy-Item -LiteralPath $p.hostPath -Destination $p.guestPath -ToSession $s -Force -ErrorAction Stop
  @{ bytes=[long](Get-Item -LiteralPath $p.hostPath).Length } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $s) { Remove-PSSession -Session $s -ErrorAction SilentlyContinue }
}
`,
  guestDownload: ownedVm + guestCredential + `
if ($vm.State -ne 'Running') { throw 'VM is not running.' }
$s = $null
try {
  $s = New-PSSession -VMId $vm.Id -Credential $credential -ErrorAction Stop
  $length = Invoke-Command -Session $s -ScriptBlock { param($guestPath) [long](Get-Item -LiteralPath $guestPath -ErrorAction Stop).Length } -ArgumentList $p.guestPath
  if ([long]$length -gt [long]$p.maxBytes) { throw 'Guest file exceeds the transfer size limit.' }
  Copy-Item -FromSession $s -LiteralPath $p.guestPath -Destination $p.hostPath -Force -ErrorAction Stop
  @{ bytes=[long](Get-Item -LiteralPath $p.hostPath).Length } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $s) { Remove-PSSession -Session $s -ErrorAction SilentlyContinue }
}
`,
  console: ownedVm + `
$consoleProcess = Start-Process -FilePath "$env:SystemRoot\\System32\\vmconnect.exe" -ArgumentList @('localhost', '-G', $vm.Id.ToString()) -PassThru
# Give the console a chance to display before starting the VM: installer DVDs can ask for a boot key immediately.
try { [void]$consoleProcess.WaitForInputIdle(10000) } catch { }
Start-Sleep -Seconds 1
@{ ok=$true } | ConvertTo-Json -Compress
`
} as const;

export type HypervOperation = keyof typeof hypervScripts;

export class HypervPowerShell {
  constructor(private readonly executor: CommandExecutor = nodeCommandExecutor) {}

  async run<T>(operation: HypervOperation, values: Record<string, unknown> = {}, timeoutMs = 30_000, credential?: VmGuestCredential): Promise<T> {
    const payload = Buffer.from(JSON.stringify(values), "utf8").toString("base64");
    const script = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\ntry {\n$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json\n${operation === "doctor" ? "" : "Import-Module Hyper-V\n"}${hypervScripts[operation]}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
    const binary = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const env = credential ? { ...process.env, CODEXPRO_HYPERV_GUEST_CREDENTIAL: Buffer.from(JSON.stringify(credential), "utf8").toString("base64") } : undefined;
    const result = await this.executor.run(binary, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeoutMs, env });
    if (result.exitCode !== 0) throw new Error(`Hyper-V ${operation} failed: ${(result.stderr || result.stdout || "command failed or timed out").trim().slice(-4000)}`);
    try { return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()) as T; }
    catch { throw new Error(`Hyper-V ${operation} returned invalid JSON.`); }
  }
}
