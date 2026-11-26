!include "LogicLib.nsh"

!ifndef DSH_UPGRADE_REPORT_ROOT
!define DSH_UPGRADE_REPORT_ROOT "$LOCALAPPDATA\Muse-Upgrade-Reports"
!endif

Var dshFinalDirectory
Var dshNewDirectory
Var dshOldDirectory
Var dshOldMoved
Var dshNewMoved
Var dshDirectoryError
Var dshDirectorySource
Var dshDirectoryDestination
Var dshRestoreError
Var dshDirectoryLogDirectory
Var dshRecoveryStopped
Var dshBackupReportFile
Var dshReceiptTarget
Var dshReceiptContents
Var dshOriginalDirectoryExists

; MoveFileEx preserves the destination and exposes the Windows error before rollback changes it.
; Open files inside a directory can make its rename return access denied (5).
!macro dshDirectoryOperation SOURCE DESTINATION RESULT PHASE
  Push $0
  Push $1
  Push $2
  StrCpy $0 0
  ${Do}
    ${If} "${DESTINATION}" == ""
      System::Call 'kernel32::RemoveDirectoryW(w "${SOURCE}") i.r1 ?e'
    ${Else}
      System::Call 'kernel32::MoveFileExW(w "${SOURCE}", w "${DESTINATION}", i 0) i.r1 ?e'
    ${EndIf}
    Pop ${RESULT}
    ${If} "${DESTINATION}" == ""
      ${If} ${RESULT} == 2
      ${OrIf} ${RESULT} == 3
        StrCpy $1 1
      ${EndIf}
    ${EndIf}
    ${If} $1 != 0
      StrCpy ${RESULT} 0
      ${ExitDo}
    ${EndIf}
    ClearErrors
    FileOpen $2 "$PLUGINSDIR\directory-operations.log" a
    ${IfNot} ${Errors}
      FileSeek $2 0 END
      FileWrite $2 "${PHASE}: Windows error: ${RESULT}$\r$\n"
      FileClose $2
    ${EndIf}
    ${If} ${RESULT} != 5
    ${AndIf} ${RESULT} != 32
    ${AndIf} ${RESULT} != 33
      ${ExitDo}
    ${EndIf}
    IntOp $0 $0 + 1
    ${If} $0 >= 10
      ${ExitDo}
    ${EndIf}
    IntOp $1 $0 * 250
    Sleep $1
  ${Loop}
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro dshReportDirectoryFailure
  ${If} $dshRestoreError != 0
    StrCpy $dshRecoveryStopped "1"
  ${EndIf}
  !ifmacrodef customInstallerDirectoryFailed
    !insertmacro customInstallerDirectoryFailed
  !else
    DetailPrint "Directory operation failed ($dshDirectoryError): $dshDirectorySource -> $dshDirectoryDestination; restore error: $dshRestoreError"
  !endif
!macroend

!macro dshExtractPayload FILE
  !ifmacrodef customInstallerExtract
    !insertmacro customInstallerExtract "${FILE}"
  !else
    nsExec::ExecToStack '"$PLUGINSDIR\dsh-7za.exe" x -y -bd -bb0 "-o$INSTDIR" "${FILE}"'
    Pop $R0
    Pop $R1
  !endif
  ${If} $R0 != 0
    DetailPrint $R1
    Call dshRollbackDirectories
    !ifmacrodef customInstallerExtractFailed
      !insertmacro customInstallerExtractFailed "${FILE}"
    !else
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)" /SD IDOK
    !endif
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro dshStageApplication
  !ifdef DSH_INSTALLER_LOG_DIR
    ; electron-builder defines the cache name after including our function bodies, before this section expands.
    StrCpy $dshDirectoryLogDirectory "${DSH_INSTALLER_LOG_DIR}"
  !endif
  StrCpy $dshFinalDirectory $INSTDIR
  ; Preserve pre-existing empty directories and their metadata too.
  System::Call 'kernel32::GetFileAttributesW(w "$dshFinalDirectory") i.r0 ?e'
  Pop $1
  StrCpy $dshOriginalDirectoryExists "1"
  ${If} $0 == -1
    ${If} $1 != 2
    ${AndIf} $1 != 3
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $dshOriginalDirectoryExists ""
  ${EndIf}
  System::Call 'ole32::CoCreateGuid(g .r0) i .r1'
  ${If} $1 != 0
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $dshNewDirectory "$INSTDIR.new-$0"
  StrCpy $dshOldDirectory "$INSTDIR.old-$0"
  StrCpy $dshBackupReportFile "${DSH_UPGRADE_REPORT_ROOT}\retained-upgrade-$0.txt"
  StrCpy $dshOldMoved ""
  StrCpy $dshNewMoved ""
  StrCpy $dshDirectoryError 0
  StrCpy $dshRestoreError 0
  StrCpy $dshRecoveryStopped ""
  ClearErrors
  CreateDirectory $dshNewDirectory
  ${If} ${Errors}
    SetErrorLevel 2
    Quit
  ${EndIf}
  File /oname=$PLUGINSDIR\dsh-7za.exe "${DSH_SEVENZIP_PATH}"
  StrCpy $INSTDIR $dshNewDirectory
  SetOutPath $INSTDIR
  !insertmacro installApplicationFiles
  !ifdef DSH_SEVENZIP_LICENSE_DIR
    File /oname=7zip-installer-LICENSE.txt "${DSH_SEVENZIP_LICENSE_DIR}\LICENSE.txt"
    File /oname=7zip-installer-COPYING.txt "${DSH_SEVENZIP_LICENSE_DIR}\COPYING"
  !endif
  !ifdef UNINSTALLER_ICON
    File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"
  !endif
  StrCpy $INSTDIR $dshFinalDirectory
  SetOutPath $PLUGINSDIR
!macroend

Function .onGUIEnd
  Call dshCleanupDirectories
FunctionEnd

Function dshCleanupDirectories
  ${If} $dshRecoveryStopped == "1"
    Return
  ${EndIf}
  ${If} $dshFinalDirectory != ""
    Call dshRollbackDirectories
  ${EndIf}
FunctionEnd

; Only directories created or renamed by this installer are removed during rollback.
Function dshRollbackDirectories
  SetOutPath $PLUGINSDIR
  ${If} $dshNewMoved == "1"
    ; Another process may have written into the promoted tree. Preserve both trees.
    StrCpy $dshRecoveryStopped "1"
    DetailPrint "$(MuseUpgradeReceiptFailed)"
    Return
  ${EndIf}
  ${If} $dshOldMoved == "1"
    !insertmacro dshDirectoryOperation "$dshOldDirectory" "$dshFinalDirectory" $dshRestoreError "restore"
    ${If} $dshRestoreError != 0
      ; Leave the complete backup in place if another process prevents restoration.
      DetailPrint $dshOldDirectory
      RMDir /r "\\?\$dshNewDirectory"
      Return
    ${EndIf}
    StrCpy $dshOldMoved ""
  ${EndIf}
  ${If} $dshNewDirectory != ""
    RMDir /r "\\?\$dshNewDirectory"
  ${EndIf}
  StrCpy $INSTDIR $dshFinalDirectory
FunctionEnd

Function dshPromoteDirectories
  !ifmacrodef InstallerPublishStage
    !insertmacro InstallerPublishStage 2
  !endif
  ; SetOutPath opens a directory handle; release it before either rename.
  SetOutPath $PLUGINSDIR
  ClearErrors
  ; Recheck the target guard after extraction, including reparse points.
  Push $InstallerPath
  StrCpy $InstallerPath $dshFinalDirectory
  Call InstallerValidatePath
  Pop $InstallerPath
  ${If} $InstallerError != ""
    Call dshRollbackDirectories
    SetErrors
    Return
  ${EndIf}
  ; FindFirstFile wildcards include '.' for empty directories. A pre-existing
  ; directory is retained; only a newly created empty destination may be removed.
  StrCpy $dshDirectorySource $dshFinalDirectory
  StrCpy $dshDirectoryDestination ""
  StrCpy $dshDirectoryError 145
  ${If} $dshOriginalDirectoryExists != "1"
    !insertmacro dshDirectoryOperation "$dshDirectorySource" "" $dshDirectoryError "remove-empty"
  ${EndIf}
  ${If} $dshDirectoryError == 145
    ; Record both planned paths before renaming the old directory.
    Call dshRecordRetainedDirectory
    ${If} ${Errors}
      Call dshRollbackDirectories
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(MuseUpgradeReceiptFailed)$\r$\n$dshFinalDirectory$\r$\n$dshOldDirectory" /SD IDOK
      SetErrors
      Return
    ${EndIf}
    StrCpy $dshDirectorySource $dshFinalDirectory
    StrCpy $dshDirectoryDestination $dshOldDirectory
    !insertmacro dshDirectoryOperation "$dshDirectorySource" "$dshDirectoryDestination" $dshDirectoryError "backup"
    ${If} $dshDirectoryError != 0
      Call dshRollbackDirectories
      !insertmacro dshReportDirectoryFailure
      SetErrors
      Return
    ${EndIf}
    StrCpy $dshOldMoved "1"
  ${ElseIf} $dshDirectoryError != 0
    Call dshRollbackDirectories
    !insertmacro dshReportDirectoryFailure
    SetErrors
    Return
  ${EndIf}
  ClearErrors
  StrCpy $dshDirectorySource $dshNewDirectory
  StrCpy $dshDirectoryDestination $dshFinalDirectory
  !insertmacro dshDirectoryOperation "$dshDirectorySource" "$dshDirectoryDestination" $dshDirectoryError "promote"
  ${If} $dshDirectoryError != 0
    Call dshRollbackDirectories
    !insertmacro dshReportDirectoryFailure
    SetErrors
    Return
  ${EndIf}
  StrCpy $dshNewMoved "1"
  SetOutPath $dshFinalDirectory
  !ifmacrodef InstallerPublishStage
    !insertmacro InstallerPublishStage 3
  !endif
  ClearErrors
FunctionEnd

!macro dshFinishDirectories
  StrCpy $dshNewMoved ""
  ${If} $dshOldMoved == "1"
    ; The previous tree can contain user files. Keep it intact, including links.
    StrCpy $dshOldMoved ""
  ${EndIf}
!macroend

Function dshRecordRetainedDirectory
  StrCpy $dshReceiptTarget "$dshBackupReportFile"
  StrCpy $dshReceiptContents "Prepared upgrade. Original directory: $dshFinalDirectory$\r$\nPlanned backup directory: $dshOldDirectory$\r$\nThe presence of this report does not mean the rename or installation completed.$\r$\n"
  Call dshWriteUpgradeReceipt
FunctionEnd

Function dshRecordRetainedCompletion
  ${If} $dshOldMoved != "1"
    ClearErrors
    Return
  ${EndIf}
  StrCpy $dshReceiptTarget "$dshBackupReportFile.completed"
  StrCpy $dshReceiptContents "Upgrade completed. Retained backup: $dshOldDirectory$\r$\nCurrent directory: $dshFinalDirectory$\r$\n"
  Call dshWriteUpgradeReceipt
FunctionEnd

Function dshRecordBlockedDirectory
  ; An old registered path can itself contain the report root or be an alias.
  ; Never write a diagnostic there until the same ownership guard accepts it.
  Push $InstallerPath
  StrCpy $InstallerPath $R4
  Call InstallerValidatePath
  Pop $InstallerPath
  ${If} $InstallerError != ""
    SetErrors
    Return
  ${EndIf}
  StrCpy $dshReceiptTarget "$dshBackupReportFile.blocked"
  StrCpy $dshReceiptContents "Upgrade blocked. Existing directory: $R4$\r$\nRequested directory: $dshFinalDirectory$\r$\n"
  Call dshWriteUpgradeReceipt
FunctionEnd

Function dshWriteUpgradeReceipt
  CreateDirectory "${DSH_UPGRADE_REPORT_ROOT}"
  ; CREATE_NEW never truncates an existing report, even if another process races us.
  System::Call 'kernel32::CreateFileW(w "$dshReceiptTarget", i 0x40000000, i 0, p 0, i 1, i 0x80, p 0) p.r0'
  ${If} $0 == -1
    SetErrors
    Return
  ${EndIf}
  StrCpy $1 $dshReceiptContents
  StrLen $2 $1
  IntOp $2 $2 * 2
  System::Call 'kernel32::WriteFile(p r0, w r1, i r2, *i .r3, p 0) i.r4'
  ${If} $4 != 0
  ${AndIf} $3 == $2
    System::Call 'kernel32::FlushFileBuffers(p r0) i.r4'
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
  ${If} $4 == 0
  ${OrIf} $3 != $2
    SetErrors
    Return
  ${EndIf}
  ClearErrors
FunctionEnd
