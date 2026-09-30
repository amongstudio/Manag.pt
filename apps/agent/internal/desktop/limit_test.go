package desktop

import (
	"testing"
	"time"
)

func TestTokenBucketCapsBurstAndRefills(t *testing.T) {
	now := time.Unix(0, 0)
	b := newTokenBucket(2, 3)
	b.now = func() time.Time { return now }
	allowed := 0
	for i := 0; i < 10; i++ {
		if b.Allow() {
			allowed++
		}
	}
	if allowed != 3 {
		t.Fatalf("burst allowed=%d", allowed)
	}
	now = now.Add(time.Second)
	allowed = 0
	for i := 0; i < 10; i++ {
		if b.Allow() {
			allowed++
		}
	}
	if allowed != 2 {
		t.Fatalf("refill allowed=%d", allowed)
	}
	b.Reset()
	if !b.Allow() {
		t.Fatal("reset should restore burst")
	}
}
