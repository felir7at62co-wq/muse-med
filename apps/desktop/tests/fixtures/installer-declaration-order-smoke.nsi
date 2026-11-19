; Compile-only: production declares the directory functions before expanding
; customHeader, which is where the path validator itself is defined.
Unicode true
; This compile-only probe does not execute the complete installer lifecycle.
!pragma warning disable 6001
!pragma warning disable 6010
RequestExecutionLevel user
SilentInstall silent
Name "Installer declaration ordering smoke"
OutFile "${OUTPUT_FILE}"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\English.nlf"
LangString MuseUpgradeReceiptFailed ${LANG_ENGLISH} "Keep both directories"
LangString INSTALLER_PATH_INVALID ${LANG_ENGLISH} "Invalid"
LangString INSTALLER_PATH_OWNERSHIP ${LANG_ENGLISH} "Ownership"
LangString INSTALLER_PATH_WRITABLE ${LANG_ENGLISH} "Not writable"
LangString INSTALLER_DISK_SPACE ${LANG_ENGLISH} "No space"
!define APP_64_UNPACKED_SIZE 1
!define APP_EXECUTABLE_FILENAME "fixture.exe"
!define INSTALL_REGISTRY_KEY "Software\PrivatePathGuardFixture"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "..\..\installer\path-vars.nsh"
!include "..\..\scripts\installer-directories.nsh"
!include "..\..\installer\path.nsh"
Section
  Call dshRecordBlockedDirectory
SectionEnd
