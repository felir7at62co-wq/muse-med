Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Private installation path guard smoke"
OutFile "${OUTPUT_FILE}"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\English.nlf"
LangString INSTALLER_PATH_INVALID ${LANG_ENGLISH} "Invalid"
LangString INSTALLER_PATH_OWNERSHIP ${LANG_ENGLISH} "Ownership"
LangString INSTALLER_PATH_WRITABLE ${LANG_ENGLISH} "Not writable"
LangString INSTALLER_DISK_SPACE ${LANG_ENGLISH} "No space"
!define APP_64_UNPACKED_SIZE 1
!define APP_EXECUTABLE_FILENAME "fixture.exe"
!define INSTALL_REGISTRY_KEY "Software\PrivatePathGuardFixture"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "..\..\installer\path.nsh"
Section
  StrCpy $InstallerPath "${TARGET_DIR}"
  Call InstallerValidatePath
  ${If} $InstallerError != ""
    SetErrorLevel 2
  ${Else}
    SetErrorLevel 0
  ${EndIf}
SectionEnd
