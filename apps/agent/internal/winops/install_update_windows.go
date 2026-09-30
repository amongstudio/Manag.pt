//go:build windows

package winops

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// InstallKBs installs only the supplied KB articles through the same
// Microsoft.Update.Session COM API the inventory search uses. It does not
// install every pending update.
func InstallKBs(kbs []string, reboot string) (any, error) {
	for _, kb := range kbs {
		if !kbArticle.MatchString(kb) {
			return nil, ErrInvalidPayload
		}
	}
	list := "'" + strings.Join(kbs, "','") + "'"
	rebootLine := ""
	if reboot == "if_required" {
		rebootLine = `if ($result.RebootRequired) { shutdown.exe /r /t 120 /c "Mnag.pt approved updates" }`
	}
	script := `
$ErrorActionPreference = 'Stop'
$want = @(` + list + `)
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$found = $searcher.Search("IsInstalled=0 and IsHidden=0")
$coll = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($update in $found.Updates) {
  foreach ($kb in $update.KBArticleIDs) {
    if ($want -contains ("KB" + $kb) -or $want -contains $kb) { [void]$coll.Add($update) }
  }
}
if ($coll.Count -eq 0) { throw 'no_matching_updates' }
$downloader = $session.CreateUpdateDownloader()
$downloader.Updates = $coll
[void]$downloader.Download()
$installer = $session.CreateUpdateInstaller()
$installer.Updates = $coll
$result = $installer.Install()
` + rebootLine + `
Write-Output ("installed=" + $result.ResultCode + " reboot=" + $result.RebootRequired)
`
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	out, err := cmd.CombinedOutput()
	text := string(out)
	if len(text) > 65536 {
		text = text[:65536]
	}
	return map[string]any{"stdout": text, "kbs": kbs, "reboot": reboot, "labeled": "wuapi_install"}, err
}
