!include "LogicLib.nsh"
!include "WordFunc.nsh"
!include "StdUtils.nsh"
InstallDir "$LOCALAPPDATA\Programs\${APP_FILENAME}"

; customHeader runs after electron-builder registers the installer languages.
!macro customHeader
  LangString MuseVCMissing ${LANG_ENGLISH} "The bundled Microsoft Visual C++ x64 prerequisite is missing. Installation cannot complete. Obtain a complete muse-med installer."
  LangString MuseVCMissing ${LANG_SIMPCHINESE} "安装包缺少 Microsoft Visual C++ x64 运行库，无法完成安装。请获取完整的 muse-med 安装包。"
  LangString MuseVCConsent ${LANG_ENGLISH} "muse-med requires Microsoft Visual C++ x64 Runtime 14.51.36247.0 or later. Install the bundled runtime now? This changes system components and requires administrator approval. No download is performed. Declining stops muse-med installation."
  LangString MuseVCConsent ${LANG_SIMPCHINESE} "muse-med 需要 Microsoft Visual C++ x64 运行库 14.51.36247.0 或更高版本。现在安装随包提供的运行库吗？此操作会修改系统组件并请求管理员授权，不会联网下载。拒绝将停止 muse-med 安装。"
  LangString MuseVCDenied ${LANG_ENGLISH} "Microsoft Visual C++ x64 Runtime installation was not authorized. muse-med installation cannot complete."
  LangString MuseVCDenied ${LANG_SIMPCHINESE} "未授权安装 Microsoft Visual C++ x64 运行库，无法完成 muse-med 安装。"
  LangString MuseVCExitFailed ${LANG_ENGLISH} "Microsoft Visual C++ x64 Runtime did not install successfully (exit result: $2). muse-med installation cannot complete."
  LangString MuseVCExitFailed ${LANG_SIMPCHINESE} "Microsoft Visual C++ x64 运行库安装失败（退出结果：$2），无法完成 muse-med 安装。"
  LangString MuseVCLaunchFailed ${LANG_ENGLISH} "Microsoft Visual C++ x64 Runtime could not be started or monitored (status: $0, detail: $1). Administrator approval may have been denied. muse-med installation cannot complete."
  LangString MuseVCLaunchFailed ${LANG_SIMPCHINESE} "无法启动或等待 Microsoft Visual C++ x64 运行库安装（状态：$0，详情：$1）。管理员授权可能已被拒绝，无法完成 muse-med 安装。"
  LangString MuseVCReboot ${LANG_ENGLISH} "Microsoft Visual C++ x64 Runtime installed successfully but requires a Windows restart. Restart Windows before launching muse-med. Do not select Run muse-med on the finish page."
  LangString MuseVCReboot ${LANG_SIMPCHINESE} "Microsoft Visual C++ x64 运行库安装成功，但需要重启 Windows。请重启后再启动 muse-med，不要勾选完成页的立即运行选项。"
  LangString MuseVCPriorFailed ${LANG_ENGLISH} "muse-med installation failed before the prerequisite check."
  LangString MuseVCPriorFailed ${LANG_SIMPCHINESE} "muse-med 安装在运行库检查之前已失败。"

; The header hook runs after builder finishes adding its official plugin directories.
!ifndef BUILD_UNINSTALLER
; This function installs only the bundled Microsoft x64 prerequisite after user consent.
Function MuseEnsureVCRuntime
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  SetRegView 64
  ClearErrors
  ReadRegDWORD $4 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  IfErrors muse_vc_registry_missing
  StrCmp $4 "1" 0 muse_vc_registry_missing
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Major"
  IfErrors muse_vc_registry_missing
  ReadRegDWORD $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Minor"
  IfErrors muse_vc_registry_missing
  ReadRegDWORD $2 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Bld"
  IfErrors muse_vc_registry_missing
  ReadRegDWORD $3 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Rbld"
  IfErrors muse_vc_registry_missing
  ${VersionCompare} "$0.$1.$2.$3" "14.51.36247.0" $5
  SetRegView lastused
  ; VersionCompare: 0 = equal, 1 = installed is newer, 2 = installed is older.
  StrCmp $5 "2" muse_vc_install muse_vc_done

muse_vc_registry_missing:
  SetRegView lastused
muse_vc_install:
  IfFileExists "$INSTDIR\resources\runtime\media\prerequisites\vc_redist.x64.exe" muse_vc_prompt
  StrCpy $5 "$(MuseVCMissing)"
  Goto muse_vc_failed
muse_vc_prompt:
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(MuseVCConsent)" /SD IDNO IDYES muse_vc_authorized
  StrCpy $5 "$(MuseVCDenied)"
  Goto muse_vc_failed
muse_vc_authorized:
  ClearErrors
  ; Only 'ok' returns a waitable process handle; 'error' and 'no_wait' are failures here.
  ${StdUtils.ExecShellWaitEx} $0 $1 "$INSTDIR\resources\runtime\media\prerequisites\vc_redist.x64.exe" "runas" "/install /quiet /norestart"
  StrCmp $0 "ok" 0 muse_vc_launch_failed
  StrCmp $1 "0" muse_vc_launch_failed
  StrCmp $1 "" muse_vc_launch_failed
  ${StdUtils.WaitForProcEx} $2 $1
  StrCmp $2 "0" muse_vc_done
  StrCmp $2 "3010" muse_vc_reboot
  StrCpy $5 "$(MuseVCExitFailed)"
  Goto muse_vc_failed
muse_vc_launch_failed:
  StrCpy $5 "$(MuseVCLaunchFailed)"
  Goto muse_vc_failed
muse_vc_reboot:
  SetRebootFlag true
  MessageBox MB_OK|MB_ICONINFORMATION "$(MuseVCReboot)" /SD IDOK
muse_vc_done:
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  ClearErrors
  Return
muse_vc_failed:
  DetailPrint "$5"
  MessageBox MB_OK|MB_ICONSTOP "$5" /SD IDOK
  SetErrorLevel 1603
  Abort "$5"
FunctionEnd
!endif

  !define /ifndef INSTALLER_STRINGS_FILE "${INSTALLER_SOURCE_DIR}\strings.nsh"
  !include "${INSTALLER_STRINGS_FILE}"
  !ifdef BUILD_UNINSTALLER
    BrandingText " "
    SetFont "Segoe UI" 9
    !ifdef LANG_SIMPCHINESE
      SetFont /LANG=${LANG_SIMPCHINESE} "Microsoft YaHei UI" 9
    !endif
    !include "${INSTALLER_SOURCE_DIR}\uninstall.nsh"
  !endif
  !ifndef BUILD_UNINSTALLER
    !include "${INSTALLER_SOURCE_DIR}\theme.nsh"
    !include "${INSTALLER_SOURCE_DIR}\pages.nsh"
    !include "${INSTALLER_SOURCE_DIR}\lifecycle.nsh"
    Function InstallerCheckAppRunning
      !insertmacro customCheckAppRunning
    FunctionEnd
  !endif
!macroend
!include "FileFunc.nsh"
!define INSTALLER_SOURCE_DIR "${__FILEDIR__}\..\installer"
!define /ifndef INSTALLER_BUILD_DIR "${__FILEDIR__}\..\.desktop-build\targets\win-x64\installer-ui"

ManifestDPIAware true
!ifndef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_GUIINIT InstallerGuiInit
!endif

!macro customInit
  ${If} ${isForAllUsers}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(INSTALLER_PER_USER)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(INSTALLER_PER_USER)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  !insertmacro setInstallModePerUser
  StrCpy $hasPerMachineInstallation 0
  StrCpy $hasPerUserInstallation 1
  StrCpy $InstallerPath $INSTDIR
  StrCpy $InstallerTheme "auto"
  ${GetParameters} $0
  ${GetOptions} $0 "/THEME=" $1
  ${IfNot} ${Errors}
    ${If} $1 == "light"
    ${OrIf} $1 == "dark"
    ${OrIf} $1 == "auto"
      StrCpy $InstallerTheme $1
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(INSTALLER_THEME_ERROR)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
  Call InstallerResolveTheme
  InitPluginsDir
  File "/oname=$PLUGINSDIR\brand.bmp" "${INSTALLER_BUILD_DIR}\brand.bmp"
  File "/oname=$PLUGINSDIR\brand-2x.bmp" "${INSTALLER_BUILD_DIR}\brand-2x.bmp"
  File "/oname=$PLUGINSDIR\brand-dark.bmp" "${INSTALLER_BUILD_DIR}\brand-dark.bmp"
  File "/oname=$PLUGINSDIR\brand-dark-2x.bmp" "${INSTALLER_BUILD_DIR}\brand-dark-2x.bmp"
  File "/oname=$PLUGINSDIR\window-frame.dll" "${INSTALLER_BUILD_DIR}\window-frame.dll"
  Call InstallerCheckAppRunning
  ${If} ${Silent}
    Call InstallerPreflight
    ${If} $InstallerError != ""
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstallMode
  ; Preserve the directory selected on the custom welcome page.
  StrCpy $installMode CurrentUser
  SetShellVarContext current
  Abort
!macroend

!macro customWelcomePage
  Page custom InstallerWelcome InstallerWelcomeLeave
!macroend

!macro customUnInstall
  Call un.CleanData
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_PRE InstallerBeforeInstall
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW InstallerProgressShow
!macroend

!macro customFinishPage
  Page custom InstallerFinish InstallerFinishLeave
!macroend

; Installation work publishes stage changes without disturbing the NSIS caller.
!macro InstallerPublishStage Stage
  ; Extraction owns the stack and error flag across these callbacks.
  Push $0
  StrCpy $0 0
  ${If} ${Errors}
    StrCpy $0 1
  ${EndIf}
  System::Store /NOUNLOAD "S"
  System::Call /NOUNLOAD 'user32::SetPropW(p $HWNDPARENT, w "HarnessInstaller.Stage", p ${Stage})'
  System::Store "L"
  ${If} $0 == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $0
!macroend

!macro customInstallerExtract Archive
  !insertmacro InstallerPublishStage 1
  System::Store /NOUNLOAD "S"
  System::Call /NOUNLOAD '$PLUGINSDIR\window-frame.dll::InstallerExtract(p $HWNDPARENT, w "$PLUGINSDIR\dsh-7za.exe", w "${Archive}", w "$INSTDIR", w "$PLUGINSDIR\extract.log") i.s ?c'
  System::Store "L"
  Pop $R0
  ; The failure report owns 7-Zip's UTF-8 output; the details view only needs the result code.
  StrCpy $R1 "$R0"
!macroend

; The report outlives $PLUGINSDIR so a user can send it; silent installs keep only the file. The updater cache
; directory is never an installation target and leaves with the application on uninstall.
; The directory smoke fixture predefines DSH_INSTALLER_LOG_DIR to keep reports inside its scratch tree.
!ifndef DSH_INSTALLER_LOG_DIR
  !define DSH_INSTALLER_LOG_DIR "$LOCALAPPDATA\${DSH_UPDATER_CACHE_NAME}\installer-logs"
!endif

!macro customInstallerExtractFailed Archive
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  ; GetTime yields zero-padded day, month, year, weekday, hour, minute, second.
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  StrCpy $0 "${DSH_INSTALLER_LOG_DIR}\extract-failure-$2$1$0-$4$5$6.log"
  StrCpy $1 1
  ${If} ${Silent}
    StrCpy $1 0
  ${EndIf}
  System::Call '$PLUGINSDIR\window-frame.dll::InstallerReportExtractFailure(p $HWNDPARENT, i R0, w "${Archive}", w "$dshNewDirectory", w "$PLUGINSDIR\extract.log", w r0, i r1, w "$(^SetupCaption)", w "$(INSTALLER_EXTRACT_FAILED)", w "$(INSTALLER_EXTRACT_HINT)", w "$(INSTALLER_EXTRACT_COPY)", w "$(INSTALLER_EXTRACT_EXPAND)", w "$(INSTALLER_EXTRACT_COLLAPSE)", w "$(INSTALLER_EXTRACT_SAVED)", w "$(INSTALLER_EXTRACT_UNSAVED)", w "$(INSTALLER_EXTRACT_COPIED)") i.r2 ?c'
  ${If} $2 == 1
    DetailPrint $0
  ${EndIf}
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    InitPluginsDir
    File "/oname=$PLUGINSDIR\window-frame.dll" "${INSTALLER_BUILD_DIR}\window-frame.dll"
  !endif
  System::Call '$PLUGINSDIR\window-frame.dll::InstallerFindProcess(w "$INSTDIR\${APP_EXECUTABLE_FILENAME}") i.R0 ?c'
  ${If} $R0 == 0
    ${If} ${isUpdated}
      StrCpy $R1 0
      ${DoWhile} $R0 == 0
        Sleep 250
        System::Call '$PLUGINSDIR\window-frame.dll::InstallerFindProcess(w "$INSTDIR\${APP_EXECUTABLE_FILENAME}") i.R0 ?c'
        IntOp $R1 $R1 + 1
        ${If} $R1 >= 40
          ${ExitDo}
        ${EndIf}
      ${Loop}
    ${EndIf}
    ${If} $R0 == 0
      MessageBox MB_OK|MB_ICONINFORMATION "$(INSTALLER_RUNNING)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
  ${If} $R0 < 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(INSTALLER_UI_ERROR)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
  !include "${__FILEDIR__}\installer-directories.nsh"
!endif

!macro customInstall
  Push $0
  StrCpy $0 0
  ${If} ${Errors}
    StrCpy $0 1
  ${EndIf}
  !insertmacro InstallerPublishStage 4
  !insertmacro dshFinishDirectories
  ; Standard uninstall-entry metadata read by inventory tools; the upstream template records it only under its private key.
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  ${If} $0 == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $0
  ${If} ${Errors}
    SetErrorLevel 1603
    Abort "$(MuseVCPriorFailed)"
  ${EndIf}
  Call MuseEnsureVCRuntime
!macroend
