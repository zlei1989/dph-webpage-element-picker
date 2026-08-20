$ErrorActionPreference = 'SilentlyContinue'
# Only count browser processes started by this plugin (command line contains dsh-webpage-element-picker).
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe' OR Name='brave.exe' OR Name='opera.exe' OR Name='chromium.exe'" | Where-Object { $_.CommandLine -match 'dsh-webpage-element-picker' }
$ids = @($procs | Select-Object -ExpandProperty ProcessId)
if ($ids.Count -eq 0) { Write-Output 'NO-PICKER-BROWSER-PROCESS'; exit }
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum3 {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public static string List(string pids) {
    var set = new System.Collections.Generic.HashSet<uint>();
    foreach (var s in pids.Split(',')) set.Add(uint.Parse(s));
    var sb = new StringBuilder();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (set.Contains(pid)) {
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        if (t.Length > 0) sb.AppendLine(pid + " visible=" + IsWindowVisible(h) + " title=" + t.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@
$result = [WinEnum3]::List(($ids -join ','))
if ([string]::IsNullOrWhiteSpace($result)) { Write-Output 'NO-TITLED-WINDOWS' } else { Write-Output $result }
