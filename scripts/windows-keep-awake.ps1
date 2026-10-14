# Keep only the system awake while the CodexPro launcher owns this process.
# The display may power down. Closing stdin (including a parent crash) releases it.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class CodexProExecutionState {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint flags);
}
'@
$continuous = [uint32]2147483648
$systemRequired = [uint32]1
if ([CodexProExecutionState]::SetThreadExecutionState($continuous -bor $systemRequired) -eq 0) {
    throw 'SetThreadExecutionState failed.'
}
try {
    [Console]::Out.WriteLine('CODEXPRO_AWAKE_READY')
    [Console]::Out.Flush()
    while ($null -ne [Console]::In.ReadLine()) {
        # The input pipe exists only for the lifetime of the parent launcher.
    }
} finally {
    [void][CodexProExecutionState]::SetThreadExecutionState($continuous)
}
