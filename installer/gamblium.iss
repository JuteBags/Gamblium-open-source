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
// Owner, Nov 14 2026:
// - A new install (Gamblium not installed now, or uninstalled before) shows the welcome page
//   again: `install --new`. An update over an installed Gamblium does not.
// - If Gamblium's data is already on this computer (an earlier install, or one that was
//   uninstalled and kept its profile), the person chooses: keep it (default) or start fresh. A
//   friend's old profile broke the new New Tab; starting fresh fixes that.
var
  DataPage: TInputOptionWizardPage;
  WasInstalled: Boolean;

function DataDir(): String;
begin
  Result := ExpandConstant('{localappdata}\Gamblium');
end;

function HasOldData(): Boolean;
begin
  Result := DirExists(DataDir() + '\User Data') or DirExists(DataDir() + '\sessions') or DirExists(DataDir() + '\browser');
end;

procedure InitializeWizard();
begin
  WasInstalled := RegKeyExists(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{8C3F2B6A-4E1D-4B7A-9F0C-6A2D5E9B1C47}_is1');
  // Always shown (owner): the choice is visible on every install. With nothing old here, both
  // options end the same and the page says so.
  if HasOldData() then
    DataPage := CreateInputOptionPage(wpWelcome,
      'Your Gamblium data', 'Gamblium has been on this computer before.',
      'Your profile (tabs, history, logins, settings) and sessions from that install are still here. Keep them, or start fresh if the earlier version gave you trouble.',
      True, False)
  else
    DataPage := CreateInputOptionPage(wpWelcome,
      'Your Gamblium data', 'No earlier Gamblium data was found on this computer.',
      'Gamblium starts with a fresh profile either way. If you install it again later, this page lets you keep your data or start fresh.',
      True, False);
  DataPage.Add('Keep my old Gamblium data');
  DataPage.Add('Start fresh: remove my old Gamblium data first (tabs, history, logins, sessions, settings)');
  // Old data here: keep it. Nothing here: start fresh.
  if HasOldData() then
    DataPage.SelectedValueIndex := 0
  else
    DataPage.SelectedValueIndex := 1;
end;

function StartFresh(): Boolean;
begin
  Result := HasOldData() and (DataPage.SelectedValueIndex = 1);
end;

// Everything in the Gamblium folder except the installer's own folder.
procedure RemoveOldData();
var
  Find: TFindRec;
  Path: String;
begin
  if FindFirst(DataDir() + '\*', Find) then
  try
    repeat
      if (Find.Name <> '.') and (Find.Name <> '..') and (CompareText(Find.Name, 'installer') <> 0) then
      begin
        Path := DataDir() + '\' + Find.Name;
        if Find.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0 then
          DelTree(Path, True, True, True)
        else
          DeleteFile(Path);
      end;
    until not FindNext(Find);
  finally
    FindClose(Find);
  end;
end;

// The real setup step: `gamblium.exe install` from the unpacked package.
// It fails when Gamblium is running (its programs are in use), so the person
// is told to close it.
procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  Params: String;
begin
  if (CurStep = ssInstall) and StartFresh() then
  begin
    WizardForm.StatusLabel.Caption := 'Removing your old Gamblium data...';
    RemoveOldData();
    if DirExists(DataDir() + '\User Data') then
    begin
      MsgBox('Your old Gamblium data could not be removed: Gamblium may still be open. Close every Gamblium window and run this installer again.', mbError, MB_OK);
      Abort;
    end;
  end;
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := 'Setting up Gamblium and its browser...';
    Params := 'install';
    if (not WasInstalled) or StartFresh() then
      Params := 'install --new';
    if not Exec(ExpandConstant('{tmp}\package\gamblium.exe'), Params, ExpandConstant('{tmp}\package'), SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
    begin
      MsgBox('Gamblium could not be set up (code ' + IntToStr(Code) + '). If Gamblium is open, close every Gamblium window and run this installer again.', mbError, MB_OK);
      Abort;
    end;
  end;
end;
