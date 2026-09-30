package commands

import (
	"encoding/json"
	"errors"
	"runtime"
	"testing"

	"github.com/pc-manager/agent/internal/credwin"
	"github.com/pc-manager/agent/internal/netwin"
	"github.com/pc-manager/agent/internal/smbwin"
	"github.com/pc-manager/agent/internal/svcctl"
	"github.com/pc-manager/agent/internal/winops"
	"github.com/pc-manager/agent/internal/winreg"
)

func TestHandlePayloadValidation(t *testing.T) {
	_, err := Handle("start_service", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, svcctl.ErrInvalidName) {
		t.Fatalf("empty service: %v", err)
	}
	_, err = Handle("stop_service", json.RawMessage(`{"name":"bad\nname"}`), Deps{})
	if !errors.Is(err, svcctl.ErrInvalidName) {
		t.Fatalf("newline service: %v", err)
	}
	_, err = Handle("get_registry", json.RawMessage(`{"hive":"HKU"}`), Deps{})
	if !errors.Is(err, winreg.ErrInvalidHive) {
		t.Fatalf("hive: %v", err)
	}
	_, err = Handle("set_registry", json.RawMessage(`{"hive":"HKLM","path":"SOFTWARE","name":"x"}`), Deps{})
	if !errors.Is(err, winreg.ErrInvalidType) {
		t.Fatalf("missing type: %v", err)
	}
	_, err = Handle("delete_firewall_rule", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, netwin.ErrInvalidName) {
		t.Fatalf("empty firewall name: %v", err)
	}
	_, err = Handle("set_firewall_rule", json.RawMessage(`{"name":"x","protocol":"esp"}`), Deps{})
	if !errors.Is(err, netwin.ErrInvalidProtocol) {
		t.Fatalf("protocol: %v", err)
	}
	if Classify("get_services") != ClassLong {
		t.Fatal("get_services should be long")
	}
	if Classify("get_adapters") != ClassLong || Classify("get_ports") != ClassLong || Classify("get_firewall") != ClassLong {
		t.Fatal("network reads should be long")
	}
	if Classify("get_event_log") != ClassLong || Classify("get_windows_update") != ClassLong || Classify("start_quick_assist") != ClassLong {
		t.Fatal("windows native tools should be long")
	}
	if Classify("get_admin_center") != ClassFast {
		t.Fatal("get_admin_center should be fast")
	}
	if Classify("get_tasks") != ClassLong || Classify("get_defender") != ClassLong || Classify("get_bitlocker") != ClassLong || Classify("get_capabilities") != ClassLong || Classify("set_task_enabled") != ClassLong {
		t.Fatal("n2 windows tools should be long")
	}
	if Classify("get_smb") != ClassLong || Classify("smb_list") != ClassLong || Classify("smb_connect") != ClassLong || Classify("smb_disconnect") != ClassLong {
		t.Fatal("smb tools should be long")
	}
	_, err = Handle("smb_list", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, smbwin.ErrInvalidPayload) {
		t.Fatalf("empty smb_list: %v", err)
	}
	_, err = Handle("smb_connect", json.RawMessage(`{"unc":"C:\\\\Windows"}`), Deps{})
	if !errors.Is(err, smbwin.ErrInvalidPayload) {
		t.Fatalf("smb_connect drive: %v", err)
	}
	_, err = Handle("smb_disconnect", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, smbwin.ErrInvalidPayload) {
		t.Fatalf("empty smb_disconnect: %v", err)
	}
	_, err = Handle("set_task_enabled", json.RawMessage(`{"path":"..\\evil","enabled":true}`), Deps{})
	if !errors.Is(err, winops.ErrInvalidPayload) {
		t.Fatalf("task path: %v", err)
	}
	_, err = Handle("get_event_log", json.RawMessage(`{"newest":999}`), Deps{})
	if !errors.Is(err, winops.ErrInvalidPayload) {
		t.Fatalf("event log newest: %v", err)
	}
	_, err = Handle("start_quick_assist", json.RawMessage(`{"app":"compmgmt.msc"}`), Deps{})
	if !errors.Is(err, winops.ErrInvalidPayload) {
		t.Fatalf("mmc: %v", err)
	}
	if Classify("set_firewall_rule") != ClassLong || Classify("delete_firewall_rule") != ClassLong {
		t.Fatal("firewall writes should be long")
	}
	if Classify("get_registry") != ClassFast {
		t.Fatal("get_registry should be fast")
	}
	if Classify("peer_offer") != ClassLong || Classify("peer_listen") != ClassLong {
		t.Fatal("peer copy should be long")
	}
	_, err = Handle("restore_credentials", json.RawMessage(`{"credentials":[]}`), Deps{})
	if err == nil {
		t.Fatal("empty restore")
	}
	if Classify("restore_credentials") != ClassLong || Classify("backup_credentials") != ClassLong {
		t.Fatal("credential commands should be long")
	}
	if Classify("run_module") != ClassLong {
		t.Fatal("run_module should be long")
	}
	if _, err = Handle("run_plugin", json.RawMessage(`{"pluginId":"legacy"}`), Deps{EnablePlugins: true}); err == nil {
		t.Fatal("legacy plugins must remain disabled")
	}
	if _, err = Handle("run_module", json.RawMessage(`{"moduleId":"tool","expectedSignature":"x"}`), Deps{}); err == nil {
		t.Fatal("run_module without an authenticated client must fail")
	}
	if Classify("set_bitlocker") != ClassLong || Classify("cancel_defender_scan") != ClassLong {
		t.Fatal("bitlocker/defender writes should be long")
	}
	_, err = Handle("set_bitlocker", json.RawMessage(`{"action":"unlock","mountPoint":"D:"}`), Deps{})
	if err == nil {
		t.Fatal("unlock without secret")
	}
	wrapped := ErrorResult(&struct {
		Volumes []string `json:"volumes"`
	}{Volumes: []string{"C:"}}, errors.New("bitlocker_access_denied"))
	m, ok := wrapped.(map[string]any)
	if !ok || m["error"] != "bitlocker_access_denied" {
		t.Fatalf("ErrorResult: %+v", wrapped)
	}
}

func TestHandlePeerMeshPayload(t *testing.T) {
	_, err := Handle("peer_offer", json.RawMessage(`{"mesh":true}`), Deps{})
	if err == nil {
		t.Fatal("expected invalid mesh payload")
	}
}

func TestHandleUnsupportedPlatform(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows implements SCM and registry")
	}
	_, err := Handle("get_services", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, svcctl.ErrUnsupported) {
		t.Fatalf("get_services: %v", err)
	}
	_, err = Handle("get_registry", json.RawMessage(`{"hive":"HKLM","path":"SOFTWARE\\PC Manager\\Agent"}`), Deps{})
	if !errors.Is(err, winreg.ErrUnsupported) {
		t.Fatalf("get_registry: %v", err)
	}
	_, err = Handle("start_service", json.RawMessage(`{"name":"Spooler"}`), Deps{})
	if !errors.Is(err, svcctl.ErrUnsupported) {
		t.Fatalf("start_service: %v", err)
	}
	_, err = Handle("get_adapters", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, netwin.ErrUnsupported) {
		t.Fatalf("get_adapters: %v", err)
	}
	_, err = Handle("get_ports", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, netwin.ErrUnsupported) {
		t.Fatalf("get_ports: %v", err)
	}
	_, err = Handle("get_firewall", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, netwin.ErrUnsupported) {
		t.Fatalf("get_firewall: %v", err)
	}
	_, err = Handle("get_event_log", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, winops.ErrUnsupported) {
		t.Fatalf("get_event_log: %v", err)
	}
	_, err = Handle("get_windows_update", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, winops.ErrUnsupported) {
		t.Fatalf("get_windows_update: %v", err)
	}
	_, err = Handle("start_quick_assist", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, winops.ErrUnsupported) {
		t.Fatalf("start_quick_assist: %v", err)
	}
	_, err = Handle("get_admin_center", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, winops.ErrUnsupported) {
		t.Fatalf("get_admin_center: %v", err)
	}
	_, err = Handle("get_tasks", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, winops.ErrUnsupported) {
		t.Fatalf("get_tasks: %v", err)
	}
	_, err = Handle("get_defender", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, winops.ErrUnsupported) {
		t.Fatalf("get_defender: %v", err)
	}
	_, err = Handle("get_credentials", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, credwin.ErrUnsupported) {
		t.Fatalf("get_credentials: %v", err)
	}
	_, err = Handle("restore_credentials", json.RawMessage(`{"credentials":[{"target":"x","secret":"s"}]}`), Deps{})
	if !errors.Is(err, credwin.ErrUnsupported) {
		t.Fatalf("restore_credentials: %v", err)
	}
	_, err = Handle("get_bitlocker", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, winops.ErrUnsupported) {
		t.Fatalf("get_bitlocker: %v", err)
	}
	_, err = Handle("set_bitlocker", json.RawMessage(`{"action":"suspend","mountPoint":"C:"}`), Deps{})
	if !errors.Is(err, winops.ErrUnsupported) {
		t.Fatalf("set_bitlocker: %v", err)
	}
	_, err = Handle("cancel_defender_scan", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, winops.ErrUnsupported) {
		t.Fatalf("cancel_defender_scan: %v", err)
	}
	_, err = Handle("get_capabilities", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, winops.ErrUnsupported) {
		t.Fatalf("get_capabilities: %v", err)
	}
	_, err = Handle("set_task_enabled", json.RawMessage(`{"path":"\\Foo","enabled":false}`), Deps{})
	if !errors.Is(err, winops.ErrUnsupported) {
		t.Fatalf("set_task_enabled: %v", err)
	}
	_, err = Handle("get_smb", json.RawMessage(`{}`), Deps{})
	if !errors.Is(err, smbwin.ErrUnsupported) {
		t.Fatalf("get_smb: %v", err)
	}
	_, err = Handle("smb_list", json.RawMessage(`{"path":"\\\\srv\\share"}`), Deps{})
	if !errors.Is(err, smbwin.ErrUnsupported) {
		t.Fatalf("smb_list: %v", err)
	}
}
