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
