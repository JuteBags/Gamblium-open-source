; Gamblium's installer: one file, double-click, done.
; Built by .github/workflows/release.yml with Inno Setup:
;   iscc /DAppVersion=0.7.0 /DPackage=<folder with the packaged programs and browser> /O<out dir> installer\gamblium.iss
; It installs for the current Windows user only (no admin rights): it unpacks
; the package to a temporary folder and runs `gamblium.exe install` from there,
; which puts the programs, the rebranded browser, the shortcuts and the helper
; in place (the same code a developer runs). Nothing else needs to be installed.
; Uninstalling (Settings > Apps) runs `gamblium.exe install --remove`, which
; keeps the user's own profile.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Package
  #define Package "..\dist\package"
#endif

[Setup]
AppId={{8C3F2B6A-4E1D-4B7A-9F0C-6A2D5E9B1C47}
AppName=Gamblium
AppVersion={#AppVersion}
AppVerName=Gamblium {#AppVersion}
AppPublisher=Gamblium
DefaultDirName={localappdata}\Gamblium\installer
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
PrivilegesRequired=lowest
WizardStyle=modern
SetupIconFile=..\branding\gamblium.ico
UninstallDisplayIcon={localappdata}\Gamblium\app\gamblium.ico
UninstallDisplayName=Gamblium
OutputBaseFilename=Gamblium-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
LZMANumBlockThreads=2
; ISCC is a 32-bit program: ultra64 in its own process, or it runs out of memory.
LZMAUseSeparateProcess=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=no

[Files]
; Unpacked only for the setup step, removed afterwards.
Source: "{#Package}\*"; DestDir: "{tmp}\package"; Flags: recursesubdirs createallsubdirs ignoreversion deleteafterinstall

[Run]
Filename: "{localappdata}\Gamblium\app\gamblium-app.exe"; Description: "Start Gamblium"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{localappdata}\Gamblium\app\gamblium.exe"; Parameters: "install --remove"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveGamblium"

[Code]
// The real setup step: `gamblium.exe install` from the unpacked package.
// It fails when Gamblium is running (its programs are in use), so the person
// is told to close it.
procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := 'Setting up Gamblium and its browser...';
    if not Exec(ExpandConstant('{tmp}\package\gamblium.exe'), 'install', ExpandConstant('{tmp}\package'), SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
    begin
      MsgBox('Gamblium could not be set up (code ' + IntToStr(Code) + '). If Gamblium is open, close every Gamblium window and run this installer again.', mbError, MB_OK);
      Abort;
    end;
  end;
end;
