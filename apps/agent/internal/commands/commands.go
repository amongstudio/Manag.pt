package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/pc-manager/agent/internal/client"
	"github.com/pc-manager/agent/internal/credwin"
	"github.com/pc-manager/agent/internal/filemanager"
	"github.com/pc-manager/agent/internal/monitor"
	"github.com/pc-manager/agent/internal/netwin"
	"github.com/pc-manager/agent/internal/peerfile"
	"github.com/pc-manager/agent/internal/plugin"
	"github.com/pc-manager/agent/internal/procutil"
	"github.com/pc-manager/agent/internal/screenshot"
	"github.com/pc-manager/agent/internal/smbwin"
	"github.com/pc-manager/agent/internal/svcctl"
	"github.com/pc-manager/agent/internal/updater"
	"github.com/pc-manager/agent/internal/winops"
	"github.com/pc-manager/agent/internal/winreg"
	"github.com/pc-manager/agent/internal/winsession"
	"github.com/shirou/gopsutil/v4/process"
)

const Version = "3.3.0"

type Class int

const (
	ClassFast Class = iota
	ClassLong
	ClassExclusive
)

type Deps struct {
	Client        *client.Client
	Sandbox       *filemanager.Sandbox
	Version       string
	DataDir       string
	EnablePlugins bool
	Progress      func(int)
	Transfer      interface {
		Upload(localPath, remotePath string, progress func(int)) error
		UploadID(localPath, remotePath string, progress func(int)) (string, error)
		Download(fileID, dest string, progress func(int)) error
	}
	DeviceID string
	Mesh     interface {
		Enabled() bool
		WaitFile(copyID, destPath string, progress func(int)) (peerfile.Result, error)
		OfferFile(destID, srcPath, destPath string, addrs []string, port int, copyID string, progress func(int)) (peerfile.Result, error)
	}
}

func Classify(typ string) Class {
	switch typ {
	case "restart", "shutdown", "kill_switch", "update_agent":
		return ClassExclusive
	case "install_app", "uninstall_app", "run_script", "run_plugin", "upload_file", "download_file", "search_files", "copy_file", "get_services", "start_service", "stop_service", "restart_service", "get_adapters", "get_ports", "get_firewall", "set_firewall_rule", "delete_firewall_rule", "peer_listen", "peer_offer", "get_event_log", "get_windows_update", "start_quick_assist", "get_tasks", "set_task_enabled", "get_defender", "set_defender", "start_defender_scan", "update_defender", "defender_action", "cancel_defender_scan", "get_bitlocker", "set_bitlocker", "get_capabilities", "install_capability", "get_smb", "smb_list", "smb_connect", "smb_disconnect", "get_credentials", "set_credential", "delete_credential", "generate_credential", "backup_credentials", "restore_credentials":
		return ClassLong
	default:
		return ClassFast
	}
}

func IsPowerCommand(typ string) bool {
	return typ == "restart" || typ == "shutdown" || typ == "kill_switch"
}

func PowerAction(typ string) error {
	switch typ {
	case "restart":
		return restartOS()
	case "shutdown", "kill_switch":
		return shutdownOS()
	default:
		return nil
	}
}

func RestartHost() error {
	return restartOS()
}

var (
	deferredMu sync.Mutex
	deferredFn func() error
)

func setDeferred(fn func() error) {
	deferredMu.Lock()
	deferredFn = fn
	deferredMu.Unlock()
}

// ApplyDeferred runs a stop of this agent service after the command result is posted.
func ApplyDeferred() error {
	deferredMu.Lock()
	fn := deferredFn
	deferredFn = nil
	deferredMu.Unlock()
	if fn == nil {
		return nil
	}
	time.Sleep(500 * time.Millisecond)
	return fn()
}

func handleService(action string, payload json.RawMessage) (any, error) {
	name, err := svcctl.ParseName(payload)
	if err != nil {
		return nil, err
	}
	if action != "start" && svcctl.IsAgentService(name) {
		setDeferred(func() error {
			_, err := svcctl.Stop(name)
			return err
		})
		return map[string]any{"name": name, "action": action, "scheduled": true}, nil
	}
	switch action {
	case "start":
		return svcctl.Start(name)
	case "stop":
		return svcctl.Stop(name)
	case "restart":
		return svcctl.Restart(name)
	default:
		return nil, fmt.Errorf("unknown service action %s", action)
	}
}

func Handle(typ string, payload json.RawMessage, deps Deps) (any, error) {
	var body map[string]any
	_ = json.Unmarshal(payload, &body)
	switch typ {
	case "restart":
		return map[string]any{"scheduled": true, "action": "restart"}, nil
	case "shutdown", "kill_switch":
		return map[string]any{"scheduled": true, "action": "shutdown"}, nil
	case "install_app":
		reportProgress(deps, 0)
		name, _ := body["name"].(string)
		id, _ := body["id"].(string)
		if id == "" {
			id = name
		}
		return runInstall(id)
	case "uninstall_app":
		reportProgress(deps, 0)
		name, _ := body["name"].(string)
		return runUninstall(name)
	case "run_script":
		reportProgress(deps, 0)
		script, _ := body["script"].(string)
		return runScript(script)
	case "run_plugin":
		if !deps.EnablePlugins {
			return nil, errors.New("plugins disabled")
		}
		reportProgress(deps, 0)
		pluginID, _ := body["pluginId"].(string)
		return plugin.Run(plugin.Request{
			PluginID: pluginID,
			Args:     plugin.ArgsFrom(body["args"]),
			Client:   deps.Client,
			DataDir:  deps.DataDir,
			Progress: deps.Progress,
		})
	case "get_processes":
		return monitor.TopProcesses(), nil
	case "kill_process":
		return handleKill(body)
	case "capture_screenshot":
		jpeg, err := screenshot.Capture()
		if err != nil {
			return map[string]string{"error": screenshot.ErrorCode(err)}, err
		}
		if err := deps.Client.UploadScreenshot(jpeg); err != nil {
			return nil, err
		}
		return map[string]int{"bytes": len(jpeg)}, nil
	case "get_files":
		p, _ := body["path"].(string)
		list, err := deps.Sandbox.List(p)
		return list, err
	case "mkdir":
		p, _ := body["path"].(string)
		return map[string]string{"path": p}, deps.Sandbox.Mkdir(p)
	case "rename_file":
		from, _ := body["from"].(string)
		to, _ := body["to"].(string)
		return map[string]string{"from": from, "to": to}, renameManaged(deps.Sandbox, from, to)
	case "move_file":
		from, _ := body["from"].(string)
		to, _ := body["to"].(string)
		return map[string]string{"from": from, "to": to}, moveManaged(deps.Sandbox, from, to)
	case "copy_file":
		from, _ := body["from"].(string)
		to, _ := body["to"].(string)
		return map[string]string{"from": from, "to": to}, copyManaged(deps.Sandbox, from, to)
	case "preview_file":
		p, _ := body["path"].(string)
		resolved, err := resolveManagedPath(deps.Sandbox, p)
		if err != nil {
			return nil, err
		}
		var preview *filemanager.Preview
		err = runManagedIO(resolved, func() error {
			out, e := filemanager.PreviewFile(resolved)
			preview = out
			return e
		})
		return preview, err
	case "search_files":
		reportProgress(deps, 0)
		p, _ := body["path"].(string)
		name, _ := body["name"].(string)
		ext, _ := body["ext"].(string)
		content, _ := body["content"].(string)
		hits, err := deps.Sandbox.Search(p, name, ext, content)
		return map[string]any{"path": p, "hits": hits, "truncated": len(hits) >= 500}, err
	case "start_watch", "stop_watch":
		return map[string]string{"status": typ}, nil
	case "upload_file":
		reportProgress(deps, 0)
		p, _ := body["path"].(string)
		resolved, err := resolveManagedPath(deps.Sandbox, p)
		if err != nil {
			return nil, err
		}
		if deps.Transfer != nil {
			if err := runManagedIO(resolved, func() error {
				return deps.Transfer.Upload(resolved, resolved, deps.Progress)
			}); err != nil {
				return nil, err
			}
		} else if err := runManagedIO(resolved, func() error {
			return deps.Client.UploadFile(resolved, resolved)
		}); err != nil {
			return nil, err
		}
		return map[string]string{"uploaded": resolved}, nil
	case "download_file":
		reportProgress(deps, 0)
		id, _ := body["fileId"].(string)
		dest, _ := body["dest"].(string)
		resolved, err := resolveManagedPath(deps.Sandbox, dest)
		if err != nil {
			return nil, err
		}
		if deps.Transfer != nil {
			if err := runManagedIO(resolved, func() error {
				return deps.Transfer.Download(id, resolved, deps.Progress)
			}); err != nil {
				return nil, err
			}
		} else if err := runManagedIO(resolved, func() error {
			return deps.Client.DownloadFile(id, resolved, 0)
		}); err != nil {
			return nil, err
		}
		return map[string]string{"dest": resolved}, nil
	case "delete_file":
		p, _ := body["path"].(string)
		return map[string]string{"deleted": p}, deps.Sandbox.Delete(p)
	case "update_agent":
		info, err := deps.Client.LatestUpdate()
		if err != nil {
			return nil, err
		}
		if info == nil {
			return map[string]string{"status": "no_update"}, nil
		}
		current := deps.Version
		if current == "" {
			current = Version
		}
		if !updater.Compare(current, info.Version) {
			return map[string]string{"status": "already_current", "version": info.Version}, nil
		}
		dir := deps.DataDir
		if dir == "" {
			dir = os.TempDir()
		}
		tmpFile, err := os.CreateTemp(dir, "pc-manager-agent-*.new")
		if err != nil {
			return nil, err
		}
		tmp := tmpFile.Name()
		_ = tmpFile.Close()
		_ = os.Remove(tmp)
		if err := deps.Client.DownloadURL(info.URL, tmp, int64(info.Size)); err != nil {
			_ = os.Remove(tmp)
			return nil, err
		}
		if err := updater.Apply(tmp, info.Checksum); err != nil {
			return nil, err
		}
		return map[string]string{"version": info.Version, "status": "applied"}, nil
	case "get_services":
		return svcctl.List()
	case "start_service":
		return handleService("start", payload)
	case "stop_service":
		return handleService("stop", payload)
	case "restart_service":
		return handleService("restart", payload)
	case "get_registry":
		return winreg.Get(payload)
	case "set_registry":
		return winreg.Set(payload)
	case "delete_registry":
		return winreg.Delete(payload)
	case "get_adapters":
		return netwin.Adapters()
	case "get_ports":
		req, err := netwin.ParsePorts(payload)
		if err != nil {
			return nil, err
		}
		return netwin.Ports(req)
	case "get_firewall":
		return netwin.Firewall()
	case "set_firewall_rule":
		req, err := netwin.ParseRule(payload)
		if err != nil {
			return nil, err
		}
		return netwin.SetRule(req)
	case "delete_firewall_rule":
		name, err := netwin.ParseDelete(payload)
		if err != nil {
			return nil, err
		}
		return netwin.DeleteRule(name)
	case "get_event_log":
		req, err := winops.ParseEventLog(payload)
		if err != nil {
			return nil, err
		}
		return winops.EventLog(req)
	case "get_windows_update":
		req, err := winops.ParseUpdate(payload)
		if err != nil {
			return nil, err
		}
		return winops.WindowsUpdate(req)
	case "start_quick_assist":
		req, err := winops.ParseAssist(payload)
		if err != nil {
			return nil, err
		}
		return winops.StartQuickAssist(req)
	case "get_admin_center":
		return winops.AdminCenter()
	case "get_tasks":
		req, err := winops.ParseTasks(payload)
		if err != nil {
			return nil, err
		}
		return winops.Tasks(req)
	case "set_task_enabled":
		req, err := winops.ParseTaskEnabled(payload)
		if err != nil {
			return nil, err
		}
		return winops.SetTaskEnabled(req)
	case "get_defender":
		return winops.Defender()
	case "set_defender":
		req, err := winops.ParseDefenderWrite(payload)
		if err != nil {
			return nil, err
		}
		return winops.SetDefender(req)
	case "start_defender_scan":
		req, err := winops.ParseDefenderScan(payload)
		if err != nil {
			return nil, err
		}
		return winops.StartDefenderScan(req)
	case "update_defender":
		return winops.UpdateDefender()
	case "defender_action":
		req, err := winops.ParseDefenderAction(payload)
		if err != nil {
			return nil, err
		}
		return winops.DefenderThreatAction(req)
	case "cancel_defender_scan":
		return winops.CancelDefenderScan()
	case "get_bitlocker":
		return winops.BitLocker()
	case "set_bitlocker":
		req, err := winops.ParseBitLockerWrite(payload)
		if err != nil {
			return nil, err
		}
		return winops.SetBitLocker(req)
	case "get_capabilities":
		req, err := winops.ParseCapabilities(payload)
		if err != nil {
			return nil, err
		}
		return winops.Capabilities(req)
	case "install_capability":
		req, err := winops.ParseInstallCapability(payload)
		if err != nil {
			return nil, err
		}
		return winops.InstallCapability(req)
	case "get_smb":
		return smbwin.Shares()
	case "smb_list":
		req, err := smbwin.ParseList(payload)
		if err != nil {
			return nil, err
		}
		shares, _ := smbwin.Shares()
		var known []smbwin.Share
		if shares != nil {
			known = shares.Shares
		}
		return smbwin.List(req, known)
	case "smb_connect":
		req, err := smbwin.ParseConnect(payload)
		if err != nil {
			return nil, err
		}
		return smbwin.Connect(req)
	case "smb_disconnect":
		target, err := smbwin.ParseDisconnect(payload)
		if err != nil {
			return nil, err
		}
		return smbwin.Disconnect(target)
	case "get_credentials", "backup_credentials":
		req, err := credwin.ParseList(payload)
		if err != nil {
			return nil, err
		}
		if typ == "backup_credentials" {
			req.Reveal = true
		}
		return credwin.List(req)
	case "set_credential":
		req, err := credwin.ParseWrite(payload)
		if err != nil {
			return nil, err
		}
		return credwin.Write(req)
	case "delete_credential":
		req, err := credwin.ParseDelete(payload)
		if err != nil {
			return nil, err
		}
		return credwin.Delete(req)
	case "generate_credential":
		req, err := credwin.ParseGenerate(payload)
		if err != nil {
			return nil, err
		}
		return credwin.Generate(req)
	case "restore_credentials":
		req, err := credwin.ParseRestore(payload)
		if err != nil {
			return nil, err
		}
		return credwin.Restore(req)
	case "peer_listen":
		return handlePeerListen(payload, deps)
	case "peer_offer":
		return handlePeerOffer(payload, deps)
	default:
		return nil, fmt.Errorf("unknown command %s", typ)
	}
}

func handlePeerListen(payload json.RawMessage, deps Deps) (any, error) {
	p, err := peerfile.ParsePayload(payload)
	if err != nil {
		return nil, err
	}
	if p.Mesh {
		if deps.Mesh == nil || !deps.Mesh.Enabled() {
			return peerfile.Result{Via: "listen_timeout"}, nil
		}
		if deps.Sandbox == nil {
			return nil, errors.New("sandbox required")
		}
		reportProgress(deps, 0)
		return deps.Mesh.WaitFile(p.CopyID, p.DestPath, deps.Progress)
	}
	if deps.Sandbox == nil && !(runtime.GOOS == "windows" && smbwin.IsRemotePath(p.Ticket.DestPath)) {
		return nil, errors.New("sandbox required")
	}
	resolved, err := resolveManagedPath(deps.Sandbox, p.Ticket.DestPath)
	if err != nil {
		return nil, err
	}
	reportProgress(deps, 0)
	return peerfile.Listen(deps.DeviceID, resolved, p.Ticket, deps.Progress)
}

func handlePeerOffer(payload json.RawMessage, deps Deps) (any, error) {
	p, err := peerfile.ParsePayload(payload)
	if err != nil {
		return nil, err
	}
	srcPath := p.Ticket.SrcPath
	if p.Mesh {
		srcPath = p.SrcPath
	}
	if deps.Sandbox == nil && !(runtime.GOOS == "windows" && smbwin.IsRemotePath(srcPath)) {
		return nil, errors.New("sandbox required")
	}
	resolved, err := resolveManagedPath(deps.Sandbox, srcPath)
	if err != nil {
		return nil, err
	}
	reportProgress(deps, 0)
	var res peerfile.Result
	if p.Mesh && deps.Mesh != nil && deps.Mesh.Enabled() {
		res, err = deps.Mesh.OfferFile(p.DestDeviceID, resolved, p.DestPath, p.Addrs, p.Port, p.CopyID, deps.Progress)
	} else if !p.Mesh {
		res, err = peerfile.Offer(deps.DeviceID, resolved, p.Ticket, deps.Progress)
	} else {
		err = peerfile.ErrDial
	}
	if err == nil {
		return res, nil
	}
	if !errors.Is(err, peerfile.ErrDial) {
		return nil, err
	}
	st, statErr := os.Stat(resolved)
	if statErr != nil {
		return nil, statErr
	}
	sum, hashErr := peerfile.FileSHA256(resolved)
	if hashErr != nil {
		return nil, hashErr
	}
	var fileID string
	if deps.Transfer != nil {
		fileID, err = deps.Transfer.UploadID(resolved, resolved, deps.Progress)
	} else if deps.Client != nil {
		fileID, err = deps.Client.UploadFileID(resolved, resolved)
	} else {
		return nil, fmt.Errorf("lan_dial_failed")
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"via": "relay", "fileId": fileID, "sha256": sum, "size": st.Size()}, nil
}

func reportProgress(deps Deps, n int) {
	if deps.Progress != nil {
		deps.Progress(n)
	}
}

func smbKnownShares() []smbwin.Share {
	list, err := smbwin.Shares()
	if err != nil || list == nil {
		return nil
	}
	return list.Shares
}

func isSharePath(p string) bool {
	return runtime.GOOS == "windows" && (smbwin.IsRemotePath(p) || smbwin.IsDrivePath(p))
}

func runManagedIO(path string, fn func() error) error {
	if fn == nil {
		return nil
	}
	if !isSharePath(path) {
		return fn()
	}
	err := winsession.RunInteractiveUser(fn)
	if err != nil {
		return smbwin.MapError(err)
	}
	return nil
}

func copyManaged(sandbox *filemanager.Sandbox, from, to string) error {
	src, err := resolveManagedPath(sandbox, from)
	if err != nil {
		return err
	}
	dst, err := resolveManagedPath(sandbox, to)
	if err != nil {
		return err
	}
	return runManagedIO(src, func() error {
		return runManagedIO(dst, func() error {
			return filemanager.CopyFile(src, dst)
		})
	})
}

func renameManaged(sandbox *filemanager.Sandbox, from, to string) error {
	src, err := resolveManagedPath(sandbox, from)
	if err != nil {
		return err
	}
	dst, err := resolveManagedPath(sandbox, to)
	if err != nil {
		return err
	}
	return runManagedIO(src, func() error {
		return runManagedIO(dst, func() error {
			return os.Rename(src, dst)
		})
	})
}

func moveManaged(sandbox *filemanager.Sandbox, from, to string) error {
	src, err := resolveManagedPath(sandbox, from)
	if err != nil {
		return err
	}
	dst, err := resolveManagedPath(sandbox, to)
	if err != nil {
		return err
	}
	return runManagedIO(src, func() error {
		return runManagedIO(dst, func() error {
			if err := os.Rename(src, dst); err == nil {
				return nil
			}
			if err := filemanager.CopyFile(src, dst); err != nil {
				return err
			}
			return os.Remove(src)
		})
	})
}

func resolveManagedPath(sandbox *filemanager.Sandbox, p string) (string, error) {
	if runtime.GOOS == "windows" && smbwin.IsRemotePath(p) {
		return smbwin.ResolveFilePath(p, smbKnownShares())
	}
	if runtime.GOOS == "windows" && smbwin.IsDrivePath(p) {
		known := smbKnownShares()
		if smbwin.PathAllowed(p, known) {
			return smbwin.ResolveFilePath(p, known)
		}
	}
	if sandbox == nil {
		return "", errors.New("sandbox required")
	}
	return sandbox.Resolve(p)
}

func handleKill(body map[string]any) (any, error) {
	pid, pidErr := asInt(body["pid"])
	name, _ := body["name"].(string)
	if pidErr != nil || pid <= 0 {
		if strings.TrimSpace(name) == "" {
			return nil, errors.New("invalid pid")
		}
		found, err := findPIDByName(name)
		if err != nil {
			return nil, err
		}
		pid = found
	}
	ok, err := process.PidExists(int32(pid))
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("process_not_found")
	}
	if err := killPID(pid); err != nil {
		return nil, err
	}
	time.Sleep(80 * time.Millisecond)
	still, err := process.PidExists(int32(pid))
	if err != nil {
		return nil, err
	}
	if still {
		return nil, errors.New("process_still_running")
	}
	return map[string]int{"pid": pid}, nil
}

func findPIDByName(name string) (int, error) {
	want := strings.ToLower(strings.TrimSpace(name))
	want = strings.TrimSuffix(want, ".exe")
	if want == "" {
		return 0, errors.New("process_not_found")
	}
	procs, err := process.Processes()
	if err != nil {
		return 0, err
	}
	for _, p := range procs {
		n, err := p.Name()
		if err != nil {
			continue
		}
		got := strings.ToLower(strings.TrimSuffix(n, ".exe"))
		if got == want {
			return int(p.Pid), nil
		}
	}
	return 0, errors.New("process_not_found")
}

func asInt(v any) (int, error) {
	switch n := v.(type) {
	case float64:
		return int(n), nil
	case int:
		return n, nil
	default:
		return 0, errors.New("invalid pid")
	}
}

func runScript(script string) (any, error) {
	if script == "" {
		return nil, errors.New("empty script")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", script)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	procutil.Harden(cmd, 10*time.Second)
	err := cmd.Run()
	out := stdout.String()
	if len(out) > 65536 {
		out = out[:65536]
	}
	return map[string]any{"stdout": out, "stderr": stderr.String()}, err
}

// validatePackageName rejects empty names and names that would be parsed as an
// option (a leading '-'), preventing argument injection into the package
// manager (e.g. apt-get install -o=Dir::Bin::dpkg=/tmp/evil).
func validatePackageName(name string) (string, error) {
	n := strings.TrimSpace(name)
	if n == "" {
		return "", errors.New("empty package name")
	}
	if strings.HasPrefix(n, "-") {
		return "", errors.New("invalid package name")
	}
	return n, nil
}

func runInstall(name string) (any, error) {
	pkg, err := validatePackageName(name)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "winget", "install", "--accept-package-agreements", "--accept-source-agreements", pkg)
	} else if _, err := exec.LookPath("apt-get"); err == nil {
		cmd = exec.CommandContext(ctx, "apt-get", "install", "-y", "--", pkg)
	} else if _, err := exec.LookPath("dnf"); err == nil {
		cmd = exec.CommandContext(ctx, "dnf", "install", "-y", "--", pkg)
	} else {
		return nil, errors.New("no package manager")
	}
	procutil.Harden(cmd, 10*time.Second)
	out, err := cmd.CombinedOutput()
	s := string(out)
	if len(s) > 65536 {
		s = s[:65536]
	}
	return map[string]string{"output": s}, err
}

func runUninstall(name string) (any, error) {
	pkg, err := validatePackageName(name)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "winget", "uninstall", pkg)
	} else if _, err := exec.LookPath("apt-get"); err == nil {
		cmd = exec.CommandContext(ctx, "apt-get", "remove", "-y", "--", pkg)
	} else if _, err := exec.LookPath("dnf"); err == nil {
		cmd = exec.CommandContext(ctx, "dnf", "remove", "-y", "--", pkg)
	} else {
		return nil, errors.New("no package manager")
	}
	procutil.Harden(cmd, 10*time.Second)
	out, err := cmd.CombinedOutput()
	return map[string]string{"output": string(out)}, err
}

// ErrorResult always attaches err to a failed command payload so the UI never
// shows a generic "type failed" with a null result.
func ErrorResult(result any, err error) any {
	if err == nil {
		return result
	}
	msg := err.Error()
	if result == nil {
		return map[string]string{"error": msg}
	}
	raw, mErr := json.Marshal(result)
	if mErr != nil {
		return map[string]string{"error": msg}
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return map[string]string{"error": msg}
	}
	if _, exists := m["error"]; !exists {
		m["error"] = msg
	}
	return m
}
