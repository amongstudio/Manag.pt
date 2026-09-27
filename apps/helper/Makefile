APP=pc-manager-helper
VERSION?=3.3.0
LDFLAGS=-ldflags "-s -w -X main.Version=$(VERSION)"
WIN_LDFLAGS=-ldflags "-s -w -H windowsgui -X main.Version=$(VERSION)"
WINRES=github.com/tc-hib/go-winres@v0.3.3

.PHONY: build dist tidy test winres

tidy:
	go mod tidy

test:
	go test ./...

# Embed Windows PE icon + version info next to cmd/helper (rsrc_windows_*.syso).
# go build only links those objects for GOOS=windows; other targets ignore them.
winres:
	go run $(WINRES) make --in cmd/helper/winres.json --arch amd64,arm64 --out cmd/helper/rsrc

build:
	go build $(LDFLAGS) -o bin/$(APP) ./cmd/helper

dist: winres
	mkdir -p dist
	GOOS=windows GOARCH=amd64 go build $(WIN_LDFLAGS) -o dist/$(APP)-windows-amd64.exe ./cmd/helper
	GOOS=windows GOARCH=arm64 go build $(WIN_LDFLAGS) -o dist/$(APP)-windows-arm64.exe ./cmd/helper
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o dist/$(APP)-linux-amd64 ./cmd/helper
	GOOS=linux GOARCH=arm64 go build $(LDFLAGS) -o dist/$(APP)-linux-arm64 ./cmd/helper

