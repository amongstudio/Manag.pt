//go:build windows

package software

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/pc-manager/agent/internal/procutil"
)

// ResolveWinget finds winget.exe. The agent runs as LocalSystem, which has no
// App Execution Alias, so fall back to the newest DesktopAppInstaller package
// under Program Files\WindowsApps (admin-only directory).
func ResolveWinget() (string, error) {
	if p, err := exec.LookPath("winget.exe"); err == nil {
		return p, nil
	}
	base := filepath.Join(os.Getenv("ProgramFiles"), "WindowsApps")
	matches, _ := filepath.Glob(filepath.Join(base, "Microsoft.DesktopAppInstaller_*", "winget.exe"))
	if len(matches) == 0 {
		return "", errors.New("winget_not_found")
	}
	sort.Strings(matches)
	return matches[len(matches)-1], nil
}

func msiexecPath() string {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	return filepath.Join(root, "System32", "msiexec.exe")
}

func run(ctx context.Context, bin string, args []string) (map[string]any, error) {
	runCtx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(runCtx, bin, args...)
	procutil.Harden(cmd, 10*time.Second)
	out, err := cmd.CombinedOutput()
	res := map[string]any{"program": filepath.Base(bin), "args": args, "output": capOutput(out)}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		res["exitCode"] = exit.ExitCode()
		// 3010 / 1641: success, reboot required (msiexec).
		if exit.ExitCode() == 3010 || exit.ExitCode() == 1641 {
			res["rebootRequired"] = true
			return res, nil
		}
	}
	return res, err
}

func Install(ctx context.Context, req InstallRequest) (map[string]any, error) {
	winget, err := ResolveWinget()
	if err != nil {
		return nil, err
	}
	res, err := run(ctx, winget, WingetInstallArgs(req))
	res["method"] = "winget"
	return res, err
}

type uninstallEntry struct {
	key         string
	displayName string
	version     string
	quiet       string
	uninstall   string
	msi         bool
}

func findUninstallEntry(name, version string) (uninstallEntry, bool) {
	roots := []string{
		`SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
		`SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
	}
	for _, root := range roots {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE, root, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		names, _ := k.ReadSubKeyNames(-1)
		k.Close()
		for _, sub := range names {
			sk, err := registry.OpenKey(registry.LOCAL_MACHINE, root+`\`+sub, registry.QUERY_VALUE)
			if err != nil {
				continue
			}
			display, _, _ := sk.GetStringValue("DisplayName")
			if !strings.EqualFold(strings.TrimSpace(display), name) {
				sk.Close()
				continue
			}
			dv, _, _ := sk.GetStringValue("DisplayVersion")
			if version != "" && !strings.EqualFold(strings.TrimSpace(dv), strings.TrimSpace(version)) {
				sk.Close()
				continue
			}
			e := uninstallEntry{key: sub, displayName: display, version: dv}
			e.quiet, _, _ = sk.GetStringValue("QuietUninstallString")
			e.uninstall, _, _ = sk.GetStringValue("UninstallString")
			if wi, _, err := sk.GetIntegerValue("WindowsInstaller"); err == nil && wi == 1 {
				e.msi = true
			}
			sk.Close()
			return e, true
		}
	}
	return uninstallEntry{}, false
}

// Uninstall prefers an exact MSI product code, then the registry entry for
// the exact DisplayName (MSI or a validated QuietUninstallString), then
// winget. Interactive-only uninstallers are refused rather than left hanging
// on a hidden desktop.
func Uninstall(ctx context.Context, req UninstallRequest) (map[string]any, error) {
	if req.ProductCode != "" {
		res, err := run(ctx, msiexecPath(), MsiUninstallArgs(strings.ToUpper(req.ProductCode)))
		res["method"] = "msi"
		return res, err
	}
	entry, found := findUninstallEntry(req.Name, req.Version)
	if found {
		code := ""
		if entry.msi && productCodeRe.MatchString(entry.key) {
			code = strings.ToUpper(entry.key)
		} else if c, ok := MsiProductCodeFromUninstallString(entry.uninstall); ok {
			code = c
		}
		if code != "" {
			res, err := run(ctx, msiexecPath(), MsiUninstallArgs(code))
			res["method"] = "msi"
			return res, err
		}
		if strings.TrimSpace(entry.quiet) != "" {
			argv, err := windows.DecomposeCommandLine(entry.quiet)
			if err != nil {
				return nil, errors.New("uninstall_string_refused")
			}
			if err := ValidateQuietUninstall(argv); err != nil {
				return nil, err
			}
			res, err := run(ctx, argv[0], argv[1:])
			res["method"] = "quiet_uninstall_string"
			return res, err
		}
	}
	winget, err := ResolveWinget()
	if err != nil {
		if found {
			return nil, errors.New("interactive_uninstaller_only")
		}
		return nil, err
	}
	res, err := run(ctx, winget, WingetUninstallArgs(req))
	res["method"] = "winget"
	return res, err
}
