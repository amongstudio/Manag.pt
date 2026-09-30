package mesh

import (
	"sync/atomic"
	"testing"
)

func TestAcquireCountCapsPeers(t *testing.T) {
	var n atomic.Int32
	for i := 0; i < 32; i++ {
		if !acquireCount(&n, 32) {
			t.Fatalf("acquire %d", i)
		}
	}
	if acquireCount(&n, 32) {
		t.Fatal("cap exceeded")
	}
	releaseCount(&n)
	if !acquireCount(&n, 32) {
		t.Fatal("release did not free a slot")
	}
}
