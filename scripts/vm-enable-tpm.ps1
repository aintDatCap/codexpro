# Run from an elevated PowerShell. Never stops/restarts the VM or replaces an existing protector.
param([Parameter(Mandatory = $true)][string]$RuntimePath)
$ErrorActionPreference = 'Stop'
Import-Module Hyper-V
$record = Get-Content -LiteralPath $RuntimePath -Raw | ConvertFrom-Json
if ($record.backend -ne 'hyperv' -or $record.hyperv.ownershipId -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Not a valid CodexPro Hyper-V runtime record.'
}
$vm = Get-VM -Id ([Guid]$record.hyperv.vmId)
if ($vm.Notes -cne ('CodexPro:' + $record.hyperv.ownershipId)) {
    throw 'VM ownership mismatch; no settings changed.'
}
if ((Get-VMSecurity -VM $vm).TpmEnabled) {
    Write-Output 'Virtual TPM is already enabled.'
    exit 0
}
if ($vm.Generation -ne 2 -or $vm.State -ne 'Off') {
    throw 'The VM must be Generation 2 and powered off. Do not shut down an unfinished CodexPro installer while setup is supervising it: that would import the unfinished disk. Cancel setup first and rerun it using the updated build instead.'
}
if (@(Get-VMKeyProtector -VM $vm).Count -eq 0) {
    Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
}
Enable-VMTPM -VM $vm
if (!(Get-VMSecurity -VM $vm).TpmEnabled) { throw 'Virtual TPM could not be enabled.' }
Write-Output "Virtual TPM enabled for VM $($vm.Id)."
