package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/pc-manager/agent/internal/capture"
	"github.com/pc-manager/agent/internal/client"
	"github.com/pc-manager/agent/internal/cliphist"
	"github.com/pc-manager/agent/internal/credwin"
	"github.com/pc-manager/agent/internal/filemanager"
	"github.com/pc-manager/agent/internal/helpercfg"
	"github.com/pc-manager/agent/internal/inventory"
	"github.com/pc-manager/agent/internal/localusers"
	"github.com/pc-manager/agent/internal/moduletool"
	"github.com/pc-manager/agent/internal/monitor"
	"github.com/pc-manager/agent/internal/netconn"
	"github.com/pc-manager/agent/internal/netwin"
	"github.com/pc-manager/agent/internal/peerfile"
	"github.com/pc-manager/agent/internal/procutil"
	"github.com/pc-manager/agent/internal/scan"
	"github.com/pc-manager/agent/internal/screenshot"
	"github.com/pc-manager/agent/internal/smbwin"
	"github.com/pc-manager/agent/internal/software"
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
	CommandID     string
	Progress      func(int)
	Transfer      interface {
		Upload(localPath, remotePath string, progress func(int)) error
		UploadID(localPath, remotePath string, progress func(int)) (string, error)
		Download(fileID, dest string, progress func(int)) error
	}
	DeviceID     string
	ApplyWatched func([]string)
	Mesh         interface {
		Enabled() bool
		WaitFile(copyID, destPath string, progress func(int)) (peerfile.Result, error)
		OfferFile(destID, srcPath, destPath string, addrs []string, port int, copyID string, progress func(int)) (peerfile.Result, error)
	}
}

func Classify(typ string) Class {
	switch typ {
	case "restart", "shutdown", "kill_switch", "update_agent":
		return ClassExclusive
	case "install_app", "uninstall_app", "run_script", "run_plugin", "run_module", "upload_file", "download_file", "search_files", "copy_file", "get_services", "start_service", "stop_service", "restart_service", "get_adapters", "get_ports", "get_firewall", "set_firewall_rule", "delete_firewall_rule", "peer_listen", "peer_offer", "get_event_log", "get_windows_update", "install_windows_update", "start_quick_assist", "get_tasks", "set_task_enabled", "get_defender", "set_defender", "start_defender_scan", "update_defender", "defender_action", "cancel_defender_scan", "get_bitlocker", "set_bitlocker", "get_capabilities", "install_capability", "get_smb", "smb_list", "smb_connect", "smb_disconnect", "get_credentials", "set_credential", "delete_credential", "generate_credential", "backup_credentials", "restore_credentials", "collect_inventory", "network_scan", "nuclei_scan", "host_posture",
		"get_local_users", "local_user_action", "get_connections", "get_scan_tools", "install_scan_tool":
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

func Cancel(commandID string) {
	moduletool.Cancel(commandID)
}

func IsCancelled(err error) bool {
	return errors.Is(err, moduletool.ErrCancelled)
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

func stringArgs(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			return nil
		}
		out = append(out, text)
	}
	return out
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
		req, err := software.ParseInstall(payload)
		if err != nil {
			return nil, err
		}
		return software.Install(context.Background(), req)
	case "uninstall_app":
		reportProgress(deps, 0)
		req, err := software.ParseUninstall(payload)
		if err != nil {
			return nil, err
		}
		return software.Uninstall(context.Background(), req)
	case "get_clipboard":
		return clipboardSnapshot(), nil
	case "get_local_users":
		return localusers.List()
	case "local_user_action":
		req, err := localusers.ParseAction(payload)
		if err != nil {
			return nil, err
		}
		return localusers.Apply(req)
	case "get_connections":
		req, err := netconn.Parse(payload)
		if err != nil {
			return nil, err
		}
		return netconn.Collect(context.Background(), req)
	case "get_scan_tools":
		scan.SetToolsDir(toolsDir(deps))
		return map[string]any{"tools": scan.Status(context.Background()), "rawScan": scan.RawScanCapable()}, nil
	case "install_scan_tool":
		scan.SetToolsDir(toolsDir(deps))
		tool, _ := body["tool"].(string)
		if !slices.Contains(scan.Tools, tool) {
			return nil, errors.New("invalid_tool")
		}
		reportProgress(deps, 0)
		return scan.InstallTool(context.Background(), tool)
	case "run_script":
		reportProgress(deps, 0)
		return runScriptBody(body)
	case "run_plugin":
		return nil, errors.New("legacy plugins disabled; use run_module")
	case "run_module":
		if !deps.EnablePlugins {
			return nil, errors.New("modules disabled by agent policy")
		}
		reportProgress(deps, 0)
		moduleID, _ := body["moduleId"].(string)
		expectedSignature, _ := body["expectedSignature"].(string)
		return moduletool.Run(moduletool.Request{
			CommandID:         deps.CommandID,
			ModuleID:          moduleID,
			ExpectedSignature: expectedSignature,
			Args:              stringArgs(body["args"]),
			Client:            deps.Client,
			DataDir:           deps.DataDir,
			Progress:          deps.Progress,
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
	case "install_windows_update":
		kbs, reboot, err := winops.ParseInstallUpdate(payload)
		if err != nil {
			return nil, err
		}
		return winops.InstallKBs(kbs, reboot)
	case "collect_inventory":
		reportProgress(deps, 0)
		return inventory.Collect(), nil
	case "network_scan":
		scan.SetToolsDir(toolsDir(deps))
		return runNetworkScan(body)
	case "nuclei_scan":
		scan.SetToolsDir(toolsDir(deps))
		return runNucleiScan(body)
	case "host_posture":
		scan.SetToolsDir(toolsDir(deps))
		return scan.HostPosture(context.Background(), scan.LoadScope(scanScopePath())), nil
	case "apply_config":
		return applyLocalConfig(body, deps)
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

func runScriptBody(body map[string]any) (any, error) {
	script, _ := body["script"].(string)
	if script == "" {
		return nil, errors.New("empty script")
	}
	language, _ := body["language"].(string)
	if params, ok := body["parameters"].(map[string]any); ok {
		script = applyScriptParams(script, params)
	}
	timeout := 60 * time.Second
	switch n := body["timeoutSeconds"].(type) {
	case float64:
		if n >= 1 && n <= 3600 {
			timeout = time.Duration(n) * time.Second
		}
	case int:
		if n >= 1 && n <= 3600 {
			timeout = time.Duration(n) * time.Second
		}
	}
	bin, args, err := scriptArgs(language, script)
	if err != nil {
		return map[string]any{"stdout": "", "stderr": err.Error(), "exitCode": 127}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	procutil.Harden(cmd, 10*time.Second)
	err = cmd.Run()
	out := capStream(stdout.String())
	errOut := capStream(stderr.String())
	code := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		} else if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			code = -1
			err = errors.New("timeout")
		} else {
			code = 1
		}
	}
	result := map[string]any{"stdout": out, "stderr": errOut, "exitCode": code, "truncated": len(stdout.String()) > 65536 || len(stderr.String()) > 65536}
	return result, err
}

func capStream(s string) string {
	if len(s) > 65536 {
		return s[:65536]
	}
	return s
}

func applyScriptParams(script string, params map[string]any) string {
	for key, value := range params {
		text, _ := value.(string)
		if len(text) > 1024 {
			text = text[:1024]
		}
		script = strings.ReplaceAll(script, "{{"+key+"}}", text)
	}
	return script
}

func scriptArgs(language, script string) (string, []string, error) {
	switch strings.ToLower(strings.TrimSpace(language)) {
	case "", "powershell":
		if language == "" && runtime.GOOS != "windows" {
			return "sh", []string{"-c", script}, nil
		}
		bin := "powershell"
		if runtime.GOOS != "windows" {
			if _, err := exec.LookPath("pwsh"); err != nil {
				return "", nil, errors.New("powershell_not_found")
			}
			bin = "pwsh"
		}
		return bin, []string{"-NoProfile", "-NonInteractive", "-Command", script}, nil
	case "batch":
		if runtime.GOOS == "windows" {
			return "cmd", []string{"/C", script}, nil
		}
		return "sh", []string{"-c", script}, nil
	case "shell":
		if runtime.GOOS == "windows" {
			return "cmd", []string{"/C", script}, nil
		}
		return "sh", []string{"-c", script}, nil
	case "python":
		bin, err := lookPython()
		if err != nil {
			return "", nil, err
		}
		return bin, []string{"-c", script}, nil
	default:
		return "", nil, errors.New("unsupported_language")
	}
}

func applyLocalConfig(body map[string]any, deps Deps) (any, error) {
	raw, _ := body["helper"].(map[string]any)
	if raw == nil {
		return map[string]string{"error": "invalid_config"}, errors.New("invalid_config")
	}
	opt := helpercfg.Options{
		AgentServiceName: str(raw["agentServiceName"]),
		StatusPort:       num(raw["statusPort"]),
		BackoffSec:       num(raw["backoffSec"]),
		ProbeIntervalSec: num(raw["probeIntervalSec"]),
		FailThreshold:    num(raw["failThreshold"]),
		MaxBackoffSec:    num(raw["maxBackoffSec"]),
		StartupGraceSec:  num(raw["startupGraceSec"]),
	}
	if opt.AgentServiceName == "" || opt.StatusPort <= 0 {
		return map[string]string{"error": "invalid_config"}, errors.New("invalid_config")
	}
	path, err := helpercfg.Write(deps.DataDir, opt)
	if err != nil {
		return map[string]string{"error": err.Error()}, err
	}
	if names, ok := body["watchedServices"].([]any); ok && deps.ApplyWatched != nil {
		out := make([]string, 0, len(names))
		for _, name := range names {
			if text, ok := name.(string); ok && text != "" {
				out = append(out, text)
			}
		}
		deps.ApplyWatched(out)
	}
	return map[string]string{"helperYaml": path, "note": "helper reads helper.yaml on its next start"}, nil
}

func str(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func num(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	default:
		return 0
	}
}

func runNetworkScan(body map[string]any) (any, error) {
	target, _ := body["target"].(string)
	scope := scan.LoadScope(scanScopePath())
	decision := scan.AuthorizeTarget(target, scope)
	if !decision.OK {
		return map[string]string{"error": decision.Error}, errors.New(decision.Error)
	}
	if !scan.NmapAvailable() {
		return map[string]string{"error": "nmap_unavailable"}, errors.New("nmap_unavailable")
	}
	rate := scope.ScanRateLimit
	if n, ok := body["maxRate"].(float64); ok && int(n) > 0 && int(n) < rate {
		rate = int(n)
	}
	minutes := scope.ScanTimeoutMinutes
	if n, ok := body["timeoutMinutes"].(float64); ok && int(n) > 0 && int(n) < minutes {
		minutes = int(n)
	}
	vulners := false
	if body["enableVulners"] == true && scope.EnableVulners {
		vulners = true
	}
	return scan.RunNmap(context.Background(), decision.Target, rate, time.Duration(minutes)*time.Minute, vulners)
}

func runNucleiScan(body map[string]any) (any, error) {
	target, _ := body["target"].(string)
	scope := scan.LoadScope(scanScopePath())
	host, err := scan.TargetHost(target)
	if err != nil {
		return map[string]string{"error": "target_refused"}, errors.New("target_refused")
	}
	decision := scan.AuthorizeTarget(host, scope)
	if !decision.OK {
		return map[string]string{"error": decision.Error}, errors.New(decision.Error)
	}
	scanURL, err := scan.NucleiURL(target, decision.Target)
	if err != nil {
		return map[string]string{"error": "target_refused"}, errors.New("target_refused")
	}
	if !scan.NucleiAvailable() {
		return map[string]string{"error": "nuclei_unavailable"}, errors.New("nuclei_unavailable")
	}
	minutes := scope.ScanTimeoutMinutes
	findings, err := scan.RunNuclei(context.Background(), scanURL, time.Duration(minutes)*time.Minute)
	if err != nil {
		return map[string]string{"error": err.Error()}, err
	}
	return map[string]any{"findings": findings}, nil
}

func scanScopePath() string {
	for _, candidate := range []string{"config/scan-scope.yaml", "../../config/scan-scope.yaml"} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "config/scan-scope.yaml"
}

func lookPython() (string, error) {
	for _, name := range []string{"python3", "python"} {
		if path, err := exec.LookPath(name); err == nil {
			return path, nil
		}
	}
	return "", errors.New("python_not_found")
}

func toolsDir(deps Deps) string {
	if deps.DataDir == "" {
		return ""
	}
	return filepath.Join(deps.DataDir, "tools")
}

// clipboardSnapshot reads the clipboard once on operator request and returns
// it with the shared bounded history. No background collection happens.
func clipboardSnapshot() map[string]any {
	out := map[string]any{"at": time.Now().UnixMilli()}
	snap, err := capture.SnapshotClip()
	if err != nil {
		out["error"] = capture.ErrorCode(err)
	} else if snap.Text != "" || snap.HTML != "" || len(snap.Files) > 0 || len(snap.Image) > 0 {
		kind := snap.Kind
		if kind == "" {
			kind = "text"
		}
		item := cliphist.Default.PushClip(cliphist.Item{Kind: kind, Text: snap.Text, HTML: snap.HTML, Files: snap.Files, Mime: snap.Mime, Image: snap.Image})
		out["current"] = cliphist.Wire(item)
	}
	items := cliphist.Default.List()
	history := make([]map[string]any, 0, len(items))
	for i := len(items) - 1; i >= 0; i-- {
		history = append(history, cliphist.Wire(items[i]))
	}
	out["history"] = history
	return out
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
