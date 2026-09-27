package svcctl

import (
	"encoding/json"
	"errors"
	"runtime"
	"strings"
	"testing"
)

func TestValidateName(t *testing.T) {
	if _, err := ValidateName(""); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("empty: %v", err)
	}
	if _, err := ValidateName("bad\nname"); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("newline: %v", err)
	}
	got, err := ValidateName("  Spooler  ")
	if err != nil || got != "Spooler" {
		t.Fatalf("got %q %v", got, err)
	}
	if _, err := ParseName([]byte(`{}`)); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("missing name: %v", err)
	}
	got, err = ParseName([]byte(`{"name":"PCManagerHelper"}`))
	if err != nil || got != "PCManagerHelper" {
		t.Fatalf("parse %q %v", got, err)
	}
	if !IsOfficial("pcmanageragent") || !IsOfficial("PCManagerHelper") || IsOfficial("Spooler") {
		t.Fatal("official names")
	}
}

func TestListUnsupported(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows uses SCM")
	}
	if _, err := List(); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("List: %v", err)
	}
	if _, err := Query("Spooler"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Query: %v", err)
	}
	if _, err := Start("Spooler"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Start: %v", err)
	}
}

func TestSCMErrorStrings(t *testing.T) {
	if ErrAccessDenied.Error() != "scm_access_denied" {
		t.Fatalf("access: %s", ErrAccessDenied)
	}
	if ErrEnumFailed.Error() != "scm_enum_failed" {
		t.Fatalf("enum: %s", ErrEnumFailed)
	}
}

func TestListWindowsDoesNotPanic(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip()
	}
	res, err := List()
	if err != nil {
		if errors.Is(err, ErrAccessDenied) {
			t.Skip("scm_access_denied")
		}
		t.Fatalf("List: %v", err)
	}
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < 2 {
		t.Fatalf("empty result %s", raw)
	}
	if len(res.Services) == 0 {
		t.Fatal("expected at least one Win32 service")
	}
	seen := map[string]bool{}
	for _, s := range res.Services {
		if s.Name == "" {
			t.Fatal("empty service name")
		}
		if seen[strings.ToLower(s.Name)] {
			t.Fatalf("duplicate service %q (resume handle bug)", s.Name)
		}
		seen[strings.ToLower(s.Name)] = true
		if s.Official {
			if s.StartType == "" {
				t.Fatalf("official service %q missing startType", s.Name)
			}
		} else if s.StartType != "" {
			t.Fatalf("unofficial service %q should not OpenService for startType, got %q", s.Name, s.StartType)
		}
	}
}
