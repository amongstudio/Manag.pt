APP=pc-manager-agent
VERSION?=3.3.0
DEFAULT_SERVER_URL?=http://localhost:4000
LDFLAGS=-ldflags "-s -w -X main.Version=$(VERSION) -X github.com/pc-manager/agent/internal/config.DefaultServerURL=$(DEFAULT_SERVER_URL)"
WIN_LDFLAGS=-ldflags "-s -w -H windowsgui -X main.Version=$(VERSION) -X github.com/pc-manager/agent/internal/config.DefaultServerURL=$(DEFAULT_SERVER_URL)"
WINRES=github.com/tc-hib/go-winres@v0.3.3

.PHONY: build dist dist-lite tidy run winres

tidy:
	go mod tidy

run:
	go run ./cmd/agent run

# Embed Windows PE icon + version info next to cmd/agent (rsrc_windows_*.syso).
# go build only links those objects for GOOS=windows; other targets ignore them.
winres:
	go run $(WINRES) make --in cmd/agent/winres.json --arch amd64,arm64 --out cmd/agent/rsrc

build:
	go build $(LDFLAGS) -o bin/$(APP) ./cmd/agent

dist: winres
	mkdir -p dist
	GOOS=windows GOARCH=amd64 go build $(WIN_LDFLAGS) -o dist/$(APP)-windows-amd64.exe ./cmd/agent
	GOOS=windows GOARCH=arm64 go build $(WIN_LDFLAGS) -o dist/$(APP)-windows-arm64.exe ./cmd/agent
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o dist/$(APP)-linux-amd64 ./cmd/agent
	GOOS=linux GOARCH=arm64 go build $(LDFLAGS) -o dist/$(APP)-linux-arm64 ./cmd/agent
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o dist/$(APP)-darwin-amd64 ./cmd/agent
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o dist/$(APP)-darwin-arm64 ./cmd/agent

# Omits pion WebRTC (desktop stub). Plugin go run still happens only on run_plugin.
dist-lite: winres
	mkdir -p dist
	GOOS=windows GOARCH=amd64 go build -tags lite $(WIN_LDFLAGS) -o dist/$(APP)-windows-amd64-lite.exe ./cmd/agent
	GOOS=windows GOARCH=arm64 go build -tags lite $(WIN_LDFLAGS) -o dist/$(APP)-windows-arm64-lite.exe ./cmd/agent
	GOOS=linux GOARCH=amd64 go build -tags lite $(LDFLAGS) -o dist/$(APP)-linux-amd64-lite ./cmd/agent
	GOOS=linux GOARCH=arm64 go build -tags lite $(LDFLAGS) -o dist/$(APP)-linux-arm64-lite ./cmd/agent
	GOOS=darwin GOARCH=amd64 go build -tags lite $(LDFLAGS) -o dist/$(APP)-darwin-amd64-lite ./cmd/agent
	GOOS=darwin GOARCH=arm64 go build -tags lite $(LDFLAGS) -o dist/$(APP)-darwin-arm64-lite ./cmd/agent
