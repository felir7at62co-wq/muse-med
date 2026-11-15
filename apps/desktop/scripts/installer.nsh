!include "LogicLib.nsh"
!include "WordFunc.nsh"
!include "StdUtils.nsh"
InstallDir "$LOCALAPPDATA\Programs\${APP_FILENAME}"

; customHeader runs after electron-builder registers the installer languages.
; Each supported locale declares its prerequisite messages once.
!macro MuseVCDefaultStrings LANGUAGE
  LangString MuseVCMissing ${LANGUAGE} "The bundled Microsoft Visual C++ x64 prerequisite is missing. Installation cannot complete. Obtain a complete muse-med installer."
  LangString MuseVCConsent ${LANGUAGE} "muse-med requires Microsoft Visual C++ x64 Runtime 14.51.36247.0 or later. Install the bundled runtime now? This changes system components and requires administrator approval. No download is performed. Declining stops muse-med installation."
  LangString MuseVCDenied ${LANGUAGE} "Microsoft Visual C++ x64 Runtime installation was not authorized. muse-med installation cannot complete."
  LangString MuseVCExitFailed ${LANGUAGE} "Microsoft Visual C++ x64 Runtime did not install successfully (exit result: $2). muse-med installation cannot complete."
  LangString MuseVCLaunchFailed ${LANGUAGE} "Microsoft Visual C++ x64 Runtime could not be started or monitored (status: $0, detail: $1). Administrator approval may have been denied. muse-med installation cannot complete."
  LangString MuseVCReboot ${LANGUAGE} "Microsoft Visual C++ x64 Runtime installed successfully but requires a Windows restart. Restart Windows before launching muse-med. Do not select Run muse-med on the finish page."
  LangString MuseVCPriorFailed ${LANGUAGE} "muse-med installation failed before the prerequisite check."
!macroend

!macro customHeader
  !ifdef LANG_ENGLISH
  !insertmacro MuseVCDefaultStrings ${LANG_ENGLISH}
  !endif
  !ifdef LANG_SIMPCHINESE
  LangString MuseVCMissing ${LANG_SIMPCHINESE} "安装包缺少 Microsoft Visual C++ x64 运行库，无法完成安装。请获取完整的 muse-med 安装包。"
  LangString MuseVCConsent ${LANG_SIMPCHINESE} "muse-med 需要 Microsoft Visual C++ x64 运行库 14.51.36247.0 或更高版本。现在安装随包提供的运行库吗？此操作会修改系统组件并请求管理员授权，不会联网下载。拒绝将停止 muse-med 安装。"
  LangString MuseVCDenied ${LANG_SIMPCHINESE} "未授权安装 Microsoft Visual C++ x64 运行库，无法完成 muse-med 安装。"
  LangString MuseVCExitFailed ${LANG_SIMPCHINESE} "Microsoft Visual C++ x64 运行库安装失败（退出结果：$2），无法完成 muse-med 安装。"
  LangString MuseVCLaunchFailed ${LANG_SIMPCHINESE} "无法启动或等待 Microsoft Visual C++ x64 运行库安装（状态：$0，详情：$1）。管理员授权可能已被拒绝，无法完成 muse-med 安装。"
  LangString MuseVCReboot ${LANG_SIMPCHINESE} "Microsoft Visual C++ x64 运行库安装成功，但需要重启 Windows。请重启后再启动 muse-med，不要勾选完成页的立即运行选项。"
  LangString MuseVCPriorFailed ${LANG_SIMPCHINESE} "muse-med 安装在运行库检查之前已失败。"
  !endif
  !ifdef LANG_GERMAN
  LangString MuseVCMissing ${LANG_GERMAN} "Das mitgelieferte Microsoft Visual C++ x64-Paket fehlt. Die Installation kann nicht abgeschlossen werden. Besorgen Sie ein vollständiges muse-med-Installationsprogramm."
  LangString MuseVCConsent ${LANG_GERMAN} "muse-med benötigt Microsoft Visual C++ x64 Runtime 14.51.36247.0 oder neuer. Die mitgelieferte Laufzeit jetzt installieren? Dies ändert Systemkomponenten und erfordert Administratorberechtigung. Es erfolgt kein Download. Bei Ablehnung wird die muse-med-Installation beendet."
  LangString MuseVCDenied ${LANG_GERMAN} "Die Installation von Microsoft Visual C++ x64 Runtime wurde nicht genehmigt. Die muse-med-Installation kann nicht abgeschlossen werden."
  LangString MuseVCExitFailed ${LANG_GERMAN} "Microsoft Visual C++ x64 Runtime wurde nicht erfolgreich installiert (Rückgabewert: $2). Die muse-med-Installation kann nicht abgeschlossen werden."
  LangString MuseVCLaunchFailed ${LANG_GERMAN} "Microsoft Visual C++ x64 Runtime konnte nicht gestartet oder überwacht werden (Status: $0, Details: $1). Die Administratorberechtigung wurde möglicherweise verweigert. Die muse-med-Installation kann nicht abgeschlossen werden."
  LangString MuseVCReboot ${LANG_GERMAN} "Microsoft Visual C++ x64 Runtime wurde installiert, erfordert aber einen Windows-Neustart. Starten Sie Windows neu, bevor Sie muse-med öffnen. Wählen Sie auf der Abschlussseite nicht die Option zum Starten von muse-med."
  LangString MuseVCPriorFailed ${LANG_GERMAN} "Die muse-med-Installation ist vor der Prüfung der Laufzeit fehlgeschlagen."
  !endif
  !ifdef LANG_SPANISHINTERNATIONAL
  LangString MuseVCMissing ${LANG_SPANISHINTERNATIONAL} "Falta el requisito incluido Microsoft Visual C++ x64. No se puede completar la instalación. Obtenga un instalador completo de muse-med."
  LangString MuseVCConsent ${LANG_SPANISHINTERNATIONAL} "muse-med requiere Microsoft Visual C++ x64 Runtime 14.51.36247.0 o posterior. ¿Instalar ahora el entorno incluido? Esto modifica componentes del sistema y requiere autorización de administrador. No se realizará ninguna descarga. Si rechaza, se detendrá la instalación de muse-med."
  LangString MuseVCDenied ${LANG_SPANISHINTERNATIONAL} "No se autorizó la instalación de Microsoft Visual C++ x64 Runtime. No se puede completar la instalación de muse-med."
  LangString MuseVCExitFailed ${LANG_SPANISHINTERNATIONAL} "Microsoft Visual C++ x64 Runtime no se instaló correctamente (resultado: $2). No se puede completar la instalación de muse-med."
  LangString MuseVCLaunchFailed ${LANG_SPANISHINTERNATIONAL} "No se pudo iniciar o supervisar Microsoft Visual C++ x64 Runtime (estado: $0, detalle: $1). Es posible que se haya denegado la autorización de administrador. No se puede completar la instalación de muse-med."
  LangString MuseVCReboot ${LANG_SPANISHINTERNATIONAL} "Microsoft Visual C++ x64 Runtime se instaló correctamente, pero requiere reiniciar Windows. Reinicie Windows antes de abrir muse-med. No seleccione Ejecutar muse-med en la página final."
  LangString MuseVCPriorFailed ${LANG_SPANISHINTERNATIONAL} "La instalación de muse-med falló antes de comprobar el entorno de ejecución."
  !endif
  !ifdef LANG_FRENCH
  LangString MuseVCMissing ${LANG_FRENCH} "Le composant requis Microsoft Visual C++ x64 fourni est manquant. L'installation ne peut pas se terminer. Procurez-vous un programme d'installation complet de muse-med."
  LangString MuseVCConsent ${LANG_FRENCH} "muse-med nécessite Microsoft Visual C++ x64 Runtime 14.51.36247.0 ou une version ultérieure. Installer maintenant le composant fourni ? Cela modifie des composants système et nécessite l'autorisation d'un administrateur. Aucun téléchargement ne sera effectué. Un refus arrête l'installation de muse-med."
  LangString MuseVCDenied ${LANG_FRENCH} "L'installation de Microsoft Visual C++ x64 Runtime n'a pas été autorisée. L'installation de muse-med ne peut pas se terminer."
  LangString MuseVCExitFailed ${LANG_FRENCH} "Microsoft Visual C++ x64 Runtime n'a pas été installé correctement (résultat : $2). L'installation de muse-med ne peut pas se terminer."
  LangString MuseVCLaunchFailed ${LANG_FRENCH} "Microsoft Visual C++ x64 Runtime n'a pas pu être démarré ou surveillé (état : $0, détail : $1). L'autorisation d'un administrateur a peut-être été refusée. L'installation de muse-med ne peut pas se terminer."
  LangString MuseVCReboot ${LANG_FRENCH} "Microsoft Visual C++ x64 Runtime a été installé, mais nécessite un redémarrage de Windows. Redémarrez Windows avant d'ouvrir muse-med. Ne sélectionnez pas Exécuter muse-med sur la page finale."
  LangString MuseVCPriorFailed ${LANG_FRENCH} "L'installation de muse-med a échoué avant la vérification du composant requis."
  !endif
  !ifdef LANG_JAPANESE
  LangString MuseVCMissing ${LANG_JAPANESE} "同梱の Microsoft Visual C++ x64 前提コンポーネントがありません。インストールを完了できません。完全な muse-med インストーラーを入手してください。"
  LangString MuseVCConsent ${LANG_JAPANESE} "muse-med には Microsoft Visual C++ x64 Runtime 14.51.36247.0 以降が必要です。同梱のランタイムを今すぐインストールしますか？システムコンポーネントが変更され、管理者の承認が必要です。ダウンロードは行いません。拒否すると muse-med のインストールを終了します。"
  LangString MuseVCDenied ${LANG_JAPANESE} "Microsoft Visual C++ x64 Runtime のインストールが承認されませんでした。muse-med のインストールを完了できません。"
  LangString MuseVCExitFailed ${LANG_JAPANESE} "Microsoft Visual C++ x64 Runtime のインストールに失敗しました（終了結果：$2）。muse-med のインストールを完了できません。"
  LangString MuseVCLaunchFailed ${LANG_JAPANESE} "Microsoft Visual C++ x64 Runtime を起動または監視できませんでした（状態：$0、詳細：$1）。管理者の承認が拒否された可能性があります。muse-med のインストールを完了できません。"
  LangString MuseVCReboot ${LANG_JAPANESE} "Microsoft Visual C++ x64 Runtime はインストールされましたが、Windows の再起動が必要です。muse-med を開く前に Windows を再起動してください。完了ページで muse-med の実行を選択しないでください。"
  LangString MuseVCPriorFailed ${LANG_JAPANESE} "ランタイムの確認前に muse-med のインストールが失敗しました。"
  !endif
  !ifdef LANG_PORTUGUESEBR
  LangString MuseVCMissing ${LANG_PORTUGUESEBR} "O pré-requisito Microsoft Visual C++ x64 incluído está ausente. Não é possível concluir a instalação. Obtenha um instalador completo do muse-med."
  LangString MuseVCConsent ${LANG_PORTUGUESEBR} "O muse-med requer Microsoft Visual C++ x64 Runtime 14.51.36247.0 ou posterior. Instalar agora o componente incluído? Isso altera componentes do sistema e requer autorização de administrador. Nenhum download será realizado. A recusa interrompe a instalação do muse-med."
  LangString MuseVCDenied ${LANG_PORTUGUESEBR} "A instalação do Microsoft Visual C++ x64 Runtime não foi autorizada. Não é possível concluir a instalação do muse-med."
  LangString MuseVCExitFailed ${LANG_PORTUGUESEBR} "O Microsoft Visual C++ x64 Runtime não foi instalado corretamente (resultado: $2). Não é possível concluir a instalação do muse-med."
  LangString MuseVCLaunchFailed ${LANG_PORTUGUESEBR} "Não foi possível iniciar ou monitorar o Microsoft Visual C++ x64 Runtime (status: $0, detalhe: $1). A autorização de administrador pode ter sido negada. Não é possível concluir a instalação do muse-med."
  LangString MuseVCReboot ${LANG_PORTUGUESEBR} "O Microsoft Visual C++ x64 Runtime foi instalado, mas requer a reinicialização do Windows. Reinicie o Windows antes de abrir o muse-med. Não selecione Executar muse-med na página final."
  LangString MuseVCPriorFailed ${LANG_PORTUGUESEBR} "A instalação do muse-med falhou antes da verificação do componente necessário."
  !endif
  !ifdef LANG_RUSSIAN
  LangString MuseVCMissing ${LANG_RUSSIAN} "Отсутствует входящий в комплект компонент Microsoft Visual C++ x64. Установку нельзя завершить. Получите полный установщик muse-med."
  LangString MuseVCConsent ${LANG_RUSSIAN} "Для muse-med требуется Microsoft Visual C++ x64 Runtime 14.51.36247.0 или новее. Установить компонент из комплекта сейчас? Это изменит системные компоненты и потребует разрешения администратора. Загрузка из сети не выполняется. Отказ остановит установку muse-med."
  LangString MuseVCDenied ${LANG_RUSSIAN} "Установка Microsoft Visual C++ x64 Runtime не разрешена. Установку muse-med нельзя завершить."
  LangString MuseVCExitFailed ${LANG_RUSSIAN} "Не удалось установить Microsoft Visual C++ x64 Runtime (код завершения: $2). Установку muse-med нельзя завершить."
  LangString MuseVCLaunchFailed ${LANG_RUSSIAN} "Не удалось запустить или отследить Microsoft Visual C++ x64 Runtime (статус: $0, сведения: $1). Возможно, в разрешении администратора было отказано. Установку muse-med нельзя завершить."
  LangString MuseVCReboot ${LANG_RUSSIAN} "Microsoft Visual C++ x64 Runtime установлен, но требуется перезагрузка Windows. Перезагрузите Windows перед запуском muse-med. Не выбирайте запуск muse-med на последней странице."
  LangString MuseVCPriorFailed ${LANG_RUSSIAN} "Установка muse-med завершилась с ошибкой до проверки необходимого компонента."
  !endif

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

  !define /ifndef INSTALLER_STRINGS_FILE "${INSTALLER_BUILD_DIR}\strings.nsh"
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

; The external qualification directory is opt-in and already created by the application.
; Native code owns UTC timestamps and fixed event names; failures never change installation behavior.
!macro InstallerRecordTiming EventCode
  Push $R8
  Push $R9
  ReadEnvStr $R8 "DSH_DESKTOP_UPDATE_JOURNAL_DIR"
  ${If} $R8 != ""
    ; System's R8 source reads $R8; its r8 source reads the unrelated $8 register.
    System::Call /NOUNLOAD '$PLUGINSDIR\window-frame.dll::InstallerRecordTiming(w R8, w "${VERSION}", i ${EventCode}) i.R9 ?c'
  ${EndIf}
  Pop $R9
  Pop $R8
!macroend

ManifestDPIAware true
!ifndef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_GUIINIT InstallerGuiInit
!endif

!macro customInit
  ${If} ${isUpdated}
  ${AndIf} ${isForceRun}
    ; Older Muse updaters pass /S; an authorized automatic update still shows its installation progress.
    SetSilent normal
  ${EndIf}
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
  !insertmacro InstallerRecordTiming 0
  !insertmacro InstallerRecordTiming 1
  Call InstallerCheckAppRunning
  !insertmacro InstallerRecordTiming 2
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
  !insertmacro InstallerRecordTiming 3
  System::Store /NOUNLOAD "S"
  System::Call /NOUNLOAD '$PLUGINSDIR\window-frame.dll::InstallerExtract(p $HWNDPARENT, w "$PLUGINSDIR\dsh-7za.exe", w "${Archive}", w "$INSTDIR", w "$PLUGINSDIR\extract.log") i.s ?c'
  System::Store "L"
  Pop $R0
  !insertmacro InstallerRecordTiming 4
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

!macro customInstallerDirectoryFailed
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  StrCpy $0 "$dshDirectoryLogDirectory\directory-failure-$2$1$0-$4$5$6.log"
  StrCpy $1 1
  ${If} ${Silent}
    StrCpy $1 0
  ${EndIf}
  StrCpy $3 "$(INSTALLER_DIRECTORY_HINT)"
  ${If} $dshRestoreError != 0
    StrCpy $3 "$(INSTALLER_DIRECTORY_RESTORE_HINT)"
  ${EndIf}
  System::Call '$PLUGINSDIR\window-frame.dll::InstallerReportDirectoryFailure(p $HWNDPARENT, i $dshDirectoryError, w "$dshDirectorySource", w "$dshDirectoryDestination", i $dshRestoreError, w "$dshOldDirectory", w "$PLUGINSDIR\directory-operations.log", w r0, i r1, w "$(^SetupCaption)", w "$(INSTALLER_DIRECTORY_FAILED)", w r3, w "$(INSTALLER_EXTRACT_COPY)", w "$(INSTALLER_EXTRACT_EXPAND)", w "$(INSTALLER_EXTRACT_COLLAPSE)", w "$(INSTALLER_EXTRACT_SAVED)", w "$(INSTALLER_EXTRACT_UNSAVED)", w "$(INSTALLER_EXTRACT_COPIED)") i.r2 ?c'
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
  !insertmacro InstallerRecordTiming 5
!macroend
