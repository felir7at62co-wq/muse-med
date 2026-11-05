# Select an existing export directory in the shell picker owned by the exact Jianying export modal.
if (-not ('MuseJianyingFolderWindow' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MuseJianyingFolderWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder buffer, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(
    IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(
    IntPtr window, uint message, UIntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool PostMessage(
    IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindowVisible(IntPtr window);
}
'@
}

function Find-MuseJianyingFolderControl([IntPtr]$Picker, [int]$Id, [string]$ClassName) {
  $control = [MuseJianyingFolderWindow]::GetDlgItem($Picker, $Id)
  $class = New-Object Text.StringBuilder 32
  if ($control -eq [IntPtr]::Zero -or [MuseJianyingFolderWindow]::GetParent($control) -ne $Picker -or
      [MuseJianyingFolderWindow]::GetClassName($control, $class, $class.Capacity) -eq 0 -or
      $class.ToString() -cne $ClassName -or -not [MuseJianyingFolderWindow]::IsWindowVisible($control) -or
      -not [MuseJianyingFolderWindow]::IsWindowEnabled($control)) {
    throw "Jianying folder picker control is unavailable (ID $Id)"
  }
  return $control
}

function Read-MuseJianyingFolderText([IntPtr]$Control, [uint32]$TimeoutMs) {
  $buffer = New-Object Text.StringBuilder 32768
  $result = [UIntPtr]::Zero
  $capacity = [UIntPtr]::new([uint32]$buffer.Capacity)
  # WM_GETTEXT with SMTO_ABORTIFHUNG and SMTO_ERRORONEXIT.
  if ([MuseJianyingFolderWindow]::SendMessageTimeout($Control, 0x000D, $capacity, $buffer, 0x22, $TimeoutMs, [ref]$result) -eq [IntPtr]::Zero) {
    throw 'Could not read a native Jianying folder picker control'
  }
  return $buffer.ToString()
}

function Resolve-MuseJianyingExportDirectory(
  [IntPtr]$ModalHandle, [uint32]$EditorPid, [string]$Directory, [int]$TimeoutMs
) {
  if ($ModalHandle -eq [IntPtr]::Zero -or $EditorPid -eq 0 -or $TimeoutMs -le 0 -or
      $Directory -notmatch '^[A-Za-z]:[\\/]') { throw 'Jianying export folder selection received invalid inputs' }
  $folder = Get-Item -LiteralPath $Directory -ErrorAction Stop
  if (-not $folder.PSIsContainer -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Jianying export folder must be an existing local directory'
  }
  return $folder.FullName
}

function Wait-MuseJianyingFolderPicker([IntPtr]$ModalHandle, [uint32]$EditorPid, $Time, [int]$TimeoutMs) {
  while ($Time.ElapsedMilliseconds -lt $TimeoutMs) {
    $candidate = [MuseJianyingFolderWindow]::GetForegroundWindow()
    if ($candidate -ne [IntPtr]::Zero -and [MuseJianyingFolderWindow]::GetWindow($candidate, 4) -eq $ModalHandle) {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($candidate)
      if ($root.Current.ProcessId -eq $EditorPid -and $root.Current.ClassName -ceq '#32770' -and
          $root.Current.Name -ceq '请选择导出路径') {
        return $candidate
      }
    }
    Start-Sleep -Milliseconds 100
  }
  throw 'Jianying did not open its owned native export-folder picker'
}

function Wait-MuseJianyingExportModal([IntPtr]$PickerHandle, [IntPtr]$ModalHandle, $Time, [int]$TimeoutMs) {
  while ($Time.ElapsedMilliseconds -lt $TimeoutMs) {
    if (-not [MuseJianyingFolderWindow]::IsWindow($PickerHandle) -or
        -not [MuseJianyingFolderWindow]::IsWindowVisible($PickerHandle)) {
      if ([MuseJianyingFolderWindow]::GetForegroundWindow() -eq $ModalHandle) { return }
    }
    Start-Sleep -Milliseconds 100
  }
  throw 'Jianying export-folder picker did not return to its export modal'
}

function Read-MuseJianyingFolderAddress(
  [IntPtr]$PickerHandle, [IntPtr]$ModalHandle, [uint32]$EditorPid, $Time, [int]$TimeoutMs
) {
  $idCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1001')
  $deadline = [Math]::Min($TimeoutMs, $Time.ElapsedMilliseconds + 3000)
  $previous = $null
  while ($Time.ElapsedMilliseconds -lt $deadline) {
    if ([MuseJianyingFolderWindow]::GetForegroundWindow() -ne $PickerHandle -or
        [MuseJianyingFolderWindow]::GetWindow($PickerHandle, 4) -ne $ModalHandle) {
      throw 'Jianying folder picker focus or ownership changed during address readback'
    }
    $picker = [System.Windows.Automation.AutomationElement]::FromHandle($PickerHandle)
    if ($picker.Current.ProcessId -ne $EditorPid -or $picker.Current.ClassName -cne '#32770' -or
        $picker.Current.Name -cne '请选择导出路径') {
      throw 'Jianying folder picker identity changed during address readback'
    }
    $candidates = $picker.FindAll([System.Windows.Automation.TreeScope]::Descendants, $idCondition)
    $addresses = @($candidates | Where-Object {
      $_.Current.ProcessId -eq $EditorPid -and $_.Current.ClassName -ceq 'ToolbarWindow32' -and
        -not $_.Current.IsOffscreen -and $_.Current.Name.StartsWith('地址: ', [StringComparison]::Ordinal) -and
        [MuseJianyingFolderWindow]::IsChild($PickerHandle, [IntPtr]$_.Current.NativeWindowHandle)
    })
    if ($addresses.Count -eq 1) {
      $address = $addresses[0].Current.Name.Substring(4)
      if ($address -ceq $previous) { return $address }
      $previous = $address
    } else {
      $previous = $null
    }
    Start-Sleep -Milliseconds 100
  }
  throw 'Jianying folder picker address did not become uniquely readable'
}

function Cancel-MuseJianyingFolderPicker([IntPtr]$PickerHandle, [IntPtr]$ModalHandle, $Time, [int]$TimeoutMs) {
  $cancel = Find-MuseJianyingFolderControl $PickerHandle 2 'Button'
  $messageTimeout = [uint32][Math]::Max(1, [Math]::Min(1000, $TimeoutMs - $Time.ElapsedMilliseconds))
  if ((Read-MuseJianyingFolderText $cancel $messageTimeout) -cne '取消' -or
      [MuseJianyingFolderWindow]::GetForegroundWindow() -ne $PickerHandle -or
      -not [MuseJianyingFolderWindow]::PostMessage($cancel, 0x00F5, [UIntPtr]::Zero, [IntPtr]::Zero)) {
    throw 'Could not close the verified Jianying folder picker'
  }
  Wait-MuseJianyingExportModal $PickerHandle $ModalHandle $Time $TimeoutMs
}

function Select-MuseJianyingExportFolder(
  [IntPtr]$ModalHandle, [uint32]$EditorPid, [string]$Directory, [int]$TimeoutMs
) {
  $canonical = Resolve-MuseJianyingExportDirectory $ModalHandle $EditorPid $Directory $TimeoutMs
  $time = [Diagnostics.Stopwatch]::StartNew()
  $pickerHandle = Wait-MuseJianyingFolderPicker $ModalHandle $EditorPid $time $TimeoutMs
  $address = Read-MuseJianyingFolderAddress $pickerHandle $ModalHandle $EditorPid $time $TimeoutMs
  if ([string]::Equals($address, $canonical, [StringComparison]::OrdinalIgnoreCase)) {
    Cancel-MuseJianyingFolderPicker $pickerHandle $ModalHandle $time $TimeoutMs
    return $canonical
  }

  # The common dialog exposes these Win32 children as generic UIA panes.
  $edit = Find-MuseJianyingFolderControl $pickerHandle 1152 'Edit'
  $select = Find-MuseJianyingFolderControl $pickerHandle 1 'Button'
  $messageTimeout = [uint32][Math]::Max(1, [Math]::Min(1000, $TimeoutMs - $time.ElapsedMilliseconds))
  if ((Read-MuseJianyingFolderText $select $messageTimeout) -cne '选择文件夹' -or
      [MuseJianyingFolderWindow]::GetForegroundWindow() -ne $pickerHandle) {
    throw 'Jianying export-folder picker selection button is unavailable'
  }
  $result = [UIntPtr]::Zero
  # WM_SETTEXT writes only to the validated child edit control.
  if ([MuseJianyingFolderWindow]::SendMessageTimeout($edit, 0x000C, [UIntPtr]::Zero, $canonical, 0x22, $messageTimeout, [ref]$result) -eq [IntPtr]::Zero -or
      $result -eq [UIntPtr]::Zero -or
      -not [string]::Equals((Read-MuseJianyingFolderText $edit $messageTimeout), $canonical, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Jianying export-folder picker did not retain the requested directory'
  }
  # BM_CLICK targets only the verified native selection button.
  if ([MuseJianyingFolderWindow]::GetForegroundWindow() -ne $pickerHandle -or
      -not [MuseJianyingFolderWindow]::PostMessage($select, 0x00F5, [UIntPtr]::Zero, [IntPtr]::Zero)) {
    throw 'Could not confirm the Jianying export folder'
  }
  Wait-MuseJianyingExportModal $pickerHandle $ModalHandle $time $TimeoutMs
  return $canonical
}

function Confirm-MuseJianyingExportFolder(
  [IntPtr]$ModalHandle, [uint32]$EditorPid, [string]$Directory, [int]$TimeoutMs
) {
  $canonical = Resolve-MuseJianyingExportDirectory $ModalHandle $EditorPid $Directory $TimeoutMs
  $time = [Diagnostics.Stopwatch]::StartNew()
  $pickerHandle = Wait-MuseJianyingFolderPicker $ModalHandle $EditorPid $time $TimeoutMs
  $address = Read-MuseJianyingFolderAddress $pickerHandle $ModalHandle $EditorPid $time $TimeoutMs
  $matches = [string]::Equals($address, $canonical, [StringComparison]::OrdinalIgnoreCase)
  Cancel-MuseJianyingFolderPicker $pickerHandle $ModalHandle $time $TimeoutMs
  if (-not $matches) { throw 'Jianying did not retain the requested export directory' }
  return $canonical
}
