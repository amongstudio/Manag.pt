package main

import (
	"testing"
	"time"
)

func TestWaitStopReturnsWhenDone(t *testing.T) {
	done := make(chan struct{})
	close(done)
	if err := waitStop(done, time.Second); err != nil {
		t.Fatal(err)
	}
}

func TestWaitStopTimesOut(t *testing.T) {
	done := make(chan struct{})
	if err := waitStop(done, 20*time.Millisecond); err == nil {
		t.Fatal("expected timeout")
	}
}
