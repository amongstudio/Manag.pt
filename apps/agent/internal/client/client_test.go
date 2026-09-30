package client

import (
	"net/http"
	"testing"
)

func TestDeviceExistsParses409(t *testing.T) {
	err := &HTTPStatusError{
		Status: http.StatusConflict,
		Body:   `{"error":"device_exists","deviceId":"abc","hostname":"box"}`,
	}
	id, host, ok := DeviceExists(err)
	if !ok || id != "abc" || host != "box" {
		t.Fatalf("got ok=%v id=%q host=%q", ok, id, host)
	}
}

func TestIsClientError(t *testing.T) {
	if !IsClientError(&HTTPStatusError{Status: 400, Body: "nope"}) {
		t.Fatal("400 should be a client error")
	}
	if IsClientError(&HTTPStatusError{Status: 500, Body: "x"}) {
		t.Fatal("500 should not be a client error")
	}
}

func TestApplyMaxUploadBytes(t *testing.T) {
	prev := MaxUploadBytes()
	t.Cleanup(func() { ApplyMaxUploadBytes(prev) })

	ApplyMaxUploadBytes(0)
	if MaxUploadBytes() != prev {
		t.Fatalf("zero cap overwrote default: got %d", MaxUploadBytes())
	}
	ApplyMaxUploadBytes(1024)
	if MaxUploadBytes() != 1024 {
		t.Fatalf("got %d want 1024", MaxUploadBytes())
	}
}

func TestSecureModuleURL(t *testing.T) {
	for _, raw := range []string{
		"https://fleet.example/api/v1/agent/download-module",
		"http://localhost:4000/api/v1/agent/download-module",
		"http://127.0.0.1:4000/api/v1/agent/download-module",
		"http://[::1]:4000/api/v1/agent/download-module",
	} {
		if !secureModuleURL(raw) {
			t.Fatalf("expected secure module URL: %s", raw)
		}
	}
	for _, raw := range []string{
		"http://10.0.0.5:4000/api/v1/agent/download-module",
		"file:///tmp/tool.exe",
		"not-a-url",
	} {
		if secureModuleURL(raw) {
			t.Fatalf("expected rejected module URL: %s", raw)
		}
	}
}
