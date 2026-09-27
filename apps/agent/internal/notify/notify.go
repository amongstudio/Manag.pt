package notify

type Options struct {
	StatusPort int
	DataDir    string
}

var (
	cfg  Options
	Logf func(string, ...any)
)

func Configure(o Options) {
	cfg = o
}

func logf(format string, args ...any) {
	if Logf != nil {
		Logf(format, args...)
	}
}

// Post shows a toast asynchronously. Safe to call from any goroutine.
func Post(msg Message) {
	go func() { _ = Show(msg) }()
}

func PostKind(kind string) {
	Post(Message{Kind: kind})
}

func Show(msg Message) error {
	msg = msg.Normalized()
	if err := msg.Validate(); err != nil {
		return err
	}
	err := show(msg)
	if err != nil {
		logf("notify %s: %v", msg.Kind, err)
	}
	return err
}

func ShowKind(kind string) error {
	return Show(Message{Kind: kind})
}

// EnsureTray starts the user-session tray if a console user is present and
// the notify pipe is not already listening. No-op on Linux/mac and when
// nobody is logged on.
func EnsureTray() {
	ensureTray()
}
