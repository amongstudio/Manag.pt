; Mnag.pt Agent installer (Inno Setup 6, Unicode).
; Matches apps/agent/install.ps1 and the Go service commands:
;   pc-manager-agent.exe install|start|stop|uninstall
;   pc-manager-helper.exe install|start|stop|uninstall
; Services: PCManagerAgent and PCManagerHelper (LocalSystem), helper first.
;
; Build (Windows, after make dist in apps/agent and apps/helper):
;   ISCC.exe installer\pc-manager.iss
; Silent:
;   pc-manager-setup.exe /VERYSILENT /SERVER=https://pc.example.com /SECRET=your-secret
; /VERYSILENT is an Inno Setup switch. /SERVER and /SECRET are {param:} values.
;
; Optional signing (no certificate is stored in this repo):
;   signtool sign /sha1 %CERT_THUMBPRINT% /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 dist\pc-manager-agent-windows-amd64.exe
;   ISCC.exe /S"mysign=signtool sign /sha1 %CERT_THUMBPRINT% /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $f" /DSignSetup installer\pc-manager.iss

#ifndef ServerDefault
  #define ServerDefault "http://localhost:4000"
#endif

#define MyAppName "PC Manager Agent"
#define MyAppVersion "3.3.0"
#define MyAppPublisher "Masria Code"
#define MyAppURL "https://Mnag.pt"

[Setup]
AppId={{A7B1C2E4-5F60-4C1A-9D2E-0B1C2D3E4F50}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\PC Manager Agent
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=pc-manager-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64
UninstallDisplayName={#MyAppName}
CloseApplications=no
RestartApplications=no
#ifdef SignSetup
SignTool=mysign
SignedUninstaller=yes
#endif

[Files]
Source: "..\dist\pc-manager-agent-windows-amd64.exe"; DestDir: "{app}"; DestName: "pc-manager-agent.exe"; Flags: ignoreversion
Source: "..\..\helper\dist\pc-manager-helper-windows-amd64.exe"; DestDir: "{app}"; DestName: "pc-manager-helper.exe"; Flags: ignoreversion skipifsourcedoesntexist

[UninstallRun]
; Helper first so the watchdog cannot start the agent again. Ignore missing binaries.
Filename: "{app}\pc-manager-helper.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated skipifdoesntexist
Filename: "{app}\pc-manager-helper.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated skipifdoesntexist
Filename: "{app}\pc-manager-agent.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated skipifdoesntexist
Filename: "{app}\pc-manager-agent.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated skipifdoesntexist

[Code]
function ServerParam(): String;
begin
  Result := ExpandConstant('{param:SERVER|{#ServerDefault}}');
end;

function SecretParam(): String;
begin
  Result := ExpandConstant('{param:SECRET|change-me-enrollment-secret}');
end;

function YamlEscape(const Value: String): String;
var
  I: Integer;
  C: String;
begin
  Result := '';
  for I := 1 to Length(Value) do
  begin
    C := Copy(Value, I, 1);
    if (C = '\') or (C = '"') then
      Result := Result + '\' + C
    else if C = #13 then
      Result := Result + '\r'
    else if C = #10 then
      Result := Result + '\n'
    else
      Result := Result + C;
  end;
end;

procedure WriteUtf8File(const Path, Body: String);
begin
  { Inno Setup 6 Unicode SaveStringToFile writes UTF-8 without a BOM. }
  if not SaveStringToFile(Path, Body, False) then
    RaiseException('Could not write ' + Path);
end;

procedure WriteDefaultConfig();
var
  Path, Body: String;
begin
  Path := ExpandConstant('{app}\config.yaml');
  if FileExists(Path) then
    Exit;
  Body :=
    'server_url: "' + YamlEscape(ServerParam()) + '"' + #13#10 +
    'fallback_urls: []' + #13#10 +
    'enrollment_secret: "' + YamlEscape(SecretParam()) + '"' + #13#10 +
    'heartbeat_interval_sec: 30' + #13#10 +
    'poll_interval_sec: 15' + #13#10 +
    'status_port: 17890' + #13#10;
  WriteUtf8File(Path, Body);
end;

procedure WriteHelperConfig();
var
  Path, Body: String;
begin
  if not FileExists(ExpandConstant('{app}\pc-manager-helper.exe')) then
    Exit;
  Path := ExpandConstant('{app}\helper.yaml');
  if FileExists(Path) then
    Exit;
  Body :=
    'agent_service_name: PCManagerAgent' + #13#10 +
    'status_port: 17890' + #13#10 +
    'backoff_sec: 30' + #13#10;
  WriteUtf8File(Path, Body);
end;

procedure TryExe(const FileName, Params: String);
var
  Code: Integer;
begin
  if not FileExists(FileName) then
    Exit;
  { stop/uninstall may exit non-zero when the service was never registered. }
  Exec(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure RunExe(const FileName, Params: String);
var
  Code: Integer;
begin
  if not FileExists(FileName) then
    Exit;
  if not Exec(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, Code) then
    RaiseException('Could not run ' + FileName + ' ' + Params);
  if Code <> 0 then
    RaiseException(FileName + ' ' + Params + ' exited ' + IntToStr(Code));
end;

procedure AllowPeerPort();
var
  Code: Integer;
begin
  { Private-profile inbound TCP and UDP 17891, same names as install.ps1. }
  Exec(ExpandConstant('{sys}\netsh.exe'),
    'advfirewall firewall show rule name="PCManagerAgent-LANPeer"',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
  if Code <> 0 then
    Exec(ExpandConstant('{sys}\netsh.exe'),
      'advfirewall firewall add rule name="PCManagerAgent-LANPeer" dir=in action=allow protocol=TCP localport=17891 profile=private',
      '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\netsh.exe'),
    'advfirewall firewall show rule name="PCManagerAgent-LANPeerUDP"',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
  if Code <> 0 then
    Exec(ExpandConstant('{sys}\netsh.exe'),
      'advfirewall firewall add rule name="PCManagerAgent-LANPeerUDP" dir=in action=allow protocol=UDP localport=17891 profile=private',
      '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  AppDir: String;
begin
  if CurStep <> ssPostInstall then
    Exit;
  AppDir := ExpandConstant('{app}');
  WriteDefaultConfig();
  WriteHelperConfig();
  { Stop anything already registered so the copy is not locked. }
  TryExe(AppDir + '\pc-manager-helper.exe', 'stop');
  TryExe(AppDir + '\pc-manager-agent.exe', 'stop');
  RunExe(AppDir + '\pc-manager-helper.exe', 'install');
  RunExe(AppDir + '\pc-manager-agent.exe', 'install');
  RunExe(AppDir + '\pc-manager-helper.exe', 'start');
  RunExe(AppDir + '\pc-manager-agent.exe', 'start');
  AllowPeerPort();
end;
