package winsession

const (
	wtsActive       uint32 = 0
	wtsConnected    uint32 = 1
	wtsDisconnected uint32 = 4
)

// sessionStatePriority ranks interactive session states. Lower is preferred.
// Active console/RDP desktop beats disconnected-but-logged-in RDP sessions.
func sessionStatePriority(state uint32) int {
	switch state {
	case wtsActive:
		return 0
	case wtsDisconnected:
		return 1
	case wtsConnected:
		return 2
	default:
		return -1
	}
}

func sessionStateName(state uint32) string {
	switch state {
	case wtsActive:
		return "active"
	case wtsConnected:
		return "connected"
	case wtsDisconnected:
		return "disconnected"
	case 2:
		return "connect_query"
	case 3:
		return "shadow"
	case 5:
		return "idle"
	case 6:
		return "listen"
	case 7:
		return "reset"
	case 8:
		return "down"
	case 9:
		return "init"
	default:
		return "unknown"
	}
}

type sessionCandidate struct {
	id       uint32
	state    uint32
	username string
}

func pickBestSession(cands []sessionCandidate) (sessionCandidate, bool) {
	bestPri := -1
	var best sessionCandidate
	found := false
	for _, c := range cands {
		pri := sessionStatePriority(c.state)
		if pri < 0 || c.username == "" {
			continue
		}
		if !found || pri < bestPri || (pri == bestPri && c.id < best.id) {
			best = c
			bestPri = pri
			found = true
		}
	}
	return best, found
}
