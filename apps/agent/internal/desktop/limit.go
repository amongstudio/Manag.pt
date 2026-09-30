package desktop

import (
	"sync"
	"time"
)

const (
	// Pointer moves arrive at display refresh rate; anything past this is a
	// flood, not a human.
	inputRatePerSec = 240
	inputBurst      = 480
	clipRatePerSec  = 4
	clipBurst       = 8
	inputTextMax    = 1024
	// Matches REMOTE_SESSION_TTL_MS on the API; the agent ends the peer
	// connection itself even if the dashboard never sends hangup.
	maxSessionDuration = 8 * time.Hour
)

type tokenBucket struct {
	mu     sync.Mutex
	rate   float64
	burst  float64
	tokens float64
	last   time.Time
	now    func() time.Time
}

func newTokenBucket(ratePerSec, burst int) *tokenBucket {
	return &tokenBucket{rate: float64(ratePerSec), burst: float64(burst), tokens: float64(burst), now: time.Now}
}

func (b *tokenBucket) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	if !b.last.IsZero() {
		b.tokens += now.Sub(b.last).Seconds() * b.rate
		if b.tokens > b.burst {
			b.tokens = b.burst
		}
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (b *tokenBucket) Reset() {
	b.mu.Lock()
	b.tokens = b.burst
	b.last = time.Time{}
	b.mu.Unlock()
}
