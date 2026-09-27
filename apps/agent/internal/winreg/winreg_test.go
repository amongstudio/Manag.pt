package winreg

import (
	"encoding/json"
	"errors"
	"runtime"
	"testing"
)

func TestNormalizeHiveAndPath(t *testing.T) {
	h, err := NormalizeHive("hklm")
	if err != nil || h != "HKLM" {
		t.Fatalf("hive %q %v", h, err)
	}
	if _, err := NormalizeHive("HKU"); !errors.Is(err, ErrInvalidHive) {
		t.Fatalf("hku: %v", err)
	}
	p, err := NormalizePath(`SOFTWARE/PC Manager/Agent`)
	if err != nil || p != `SOFTWARE\PC Manager\Agent` {
		t.Fatalf("path %q %v", p, err)
	}
	if _, err := NormalizePath(`SOFTWARE\..\Windows`); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("dotdot: %v", err)
	}
}

func TestParseGetAndWrite(t *testing.T) {
	got, err := ParseGet([]byte(`{"hive":"HKLM","path":"SOFTWARE\\PC Manager\\Agent"}`))
	if err != nil || got.Path != `SOFTWARE\PC Manager\Agent` {
		t.Fatalf("%+v %v", got, err)
	}
	if _, err := ParseGet([]byte(`{"hive":"HKCR"}`)); !errors.Is(err, ErrInvalidHive) {
		t.Fatalf("hkcr: %v", err)
	}
	w, err := ParseWrite([]byte(`{"hive":"HKCU","path":"SOFTWARE\\PC Manager\\Agent","name":"notes","type":"REG_SZ","data":"ok"}`))
	if err != nil || w.Type != "REG_SZ" || w.Name != "notes" {
		t.Fatalf("write %+v %v", w, err)
	}
	if _, err := ParseWrite([]byte(`{"hive":"HKLM","path":"SOFTWARE","name":"x"}`)); !errors.Is(err, ErrInvalidType) {
		t.Fatalf("missing type: %v", err)
	}
	key, err := ParseWrite([]byte(`{"hive":"HKLM","path":"SOFTWARE\\PC Manager","target":"key"}`))
	if err != nil || key.Target != "key" {
		t.Fatalf("create key %+v %v", key, err)
	}
	del, err := ParseDelete([]byte(`{"hive":"HKLM","path":"SOFTWARE\\PC Manager\\Agent","name":"notes"}`))
	if err != nil || del.Name != "notes" {
		t.Fatalf("delete %+v %v", del, err)
	}
}

func TestGetUnsupported(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows uses the real registry")
	}
	if _, err := Get([]byte(`{"hive":"HKLM","path":"SOFTWARE"}`)); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Get: %v", err)
	}
	if _, err := Set([]byte(`{"hive":"HKCU","path":"SOFTWARE","target":"key"}`)); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Set: %v", err)
	}
}

func TestHKCURoundTrip(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip()
	}
	path := `SOFTWARE\PC Manager\_agent_reg_test`
	_, err := Set([]byte(`{"hive":"HKCU","path":` + jsonString(path) + `,"target":"key"}`))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = Delete([]byte(`{"hive":"HKCU","path":` + jsonString(path) + `,"target":"key"}`))
	})
	_, err = Set([]byte(`{"hive":"HKCU","path":` + jsonString(path) + `,"name":"hello","type":"REG_SZ","data":"world"}`))
	if err != nil {
		t.Fatal(err)
	}
	got, err := Get([]byte(`{"hive":"HKCU","path":` + jsonString(path) + `}`))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, v := range got.Values {
		if v.Name == "hello" && v.Data == "world" {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing value: %+v", got.Values)
	}
	_, err = Delete([]byte(`{"hive":"HKCU","path":` + jsonString(path) + `,"name":"hello"}`))
	if err != nil {
		t.Fatal(err)
	}
}

func TestMissingAgentKeyEmpty(t *testing.T) {
	if ErrAccessDenied.Error() != "registry_access_denied" {
		t.Fatalf("access: %s", ErrAccessDenied)
	}
	if ErrNotFound.Error() != "registry_not_found" {
		t.Fatalf("not found: %s", ErrNotFound)
	}
	got := missingAgentKeyResult("HKLM", AgentKeyPath, ErrNotFound)
	if got == nil || got.Path != AgentKeyPath || got.Keys == nil || got.Values == nil {
		t.Fatalf("expected empty KeyResult, got %+v", got)
	}
	if len(got.Keys) != 0 || len(got.Values) != 0 {
		t.Fatalf("expected empty slices: %+v", got)
	}
	if missingAgentKeyResult("HKLM", `SOFTWARE\Other`, ErrNotFound) != nil {
		t.Fatal("non-agent missing key must stay an error")
	}
	if missingAgentKeyResult("HKLM", AgentKeyPath, ErrAccessDenied) != nil {
		t.Fatal("access denied must not look like a missing agent key")
	}
	if !tolerateHiveRootValueEnum("", errors.New("access")) {
		t.Fatal("hive root value enum should be tolerated")
	}
	if tolerateHiveRootValueEnum(`SOFTWARE`, errors.New("access")) {
		t.Fatal("nested value enum must not be swallowed")
	}
}

func TestGetMissingAgentKeyEmpty(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip()
	}
	got, err := Get([]byte(`{"hive":"HKLM","path":` + jsonString(AgentKeyPath) + `}`))
	if err != nil {
		if errors.Is(err, ErrAccessDenied) {
			t.Skip("registry_access_denied")
		}
		t.Fatalf("missing agent key must be empty, not %v", err)
	}
	if got == nil || got.Path != AgentKeyPath || got.Keys == nil || got.Values == nil {
		t.Fatalf("expected KeyResult, got %+v", got)
	}
}

func TestGetMissingKeyNotFound(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip()
	}
	path := `SOFTWARE\PC Manager\_missing_phase0_reg_test`
	_, err := Get([]byte(`{"hive":"HKLM","path":` + jsonString(path) + `}`))
	if errors.Is(err, ErrAccessDenied) {
		t.Skip("registry_access_denied")
	}
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("want registry_not_found, got %v", err)
	}
}

func TestGetHiveRootToleratesValueEnum(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip()
	}
	got, err := Get([]byte(`{"hive":"HKLM","path":""}`))
	if err != nil {
		if errors.Is(err, ErrAccessDenied) {
			t.Skip("registry_access_denied")
		}
		t.Fatalf("hive root: %v", err)
	}
	if got.Keys == nil || got.Values == nil {
		t.Fatalf("nil slices: %+v", got)
	}
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
