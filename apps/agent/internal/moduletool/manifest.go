package moduletool

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"github.com/pc-manager/agent/internal/client"
)

var (
	moduleIDPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])?$`)
	integerPattern  = regexp.MustCompile(`^-?(?:0|[1-9][0-9]*)$`)
)

func canonicalManifest(meta *client.ModuleMeta) ([]byte, error) {
	if meta == nil {
		return nil, errors.New("module metadata required")
	}
	if !moduleIDPattern.MatchString(meta.ID) {
		return nil, errors.New("invalid module id")
	}
	if meta.Kind != "exe" && meta.Kind != "dll-plugin" {
		return nil, errors.New("unsupported module kind")
	}
	if meta.Platform != "windows" {
		return nil, errors.New("unsupported module platform")
	}
	if meta.Arch != "amd64" && meta.Arch != "arm64" {
		return nil, errors.New("unsupported module architecture")
	}
	if len(meta.SHA256) != 64 {
		return nil, errors.New("invalid module sha256")
	}
	if _, err := hex.DecodeString(meta.SHA256); err != nil {
		return nil, errors.New("invalid module sha256")
	}
	if meta.Size <= 0 || meta.Size > client.MaxUpdateBytes {
		return nil, errors.New("invalid module size")
	}
	if meta.TimeoutSec < 1 || meta.TimeoutSec > 900 {
		return nil, errors.New("invalid module timeout")
	}
	if meta.MaxOutputBytes < 1024 || meta.MaxOutputBytes > 1_048_576 {
		return nil, errors.New("invalid module output limit")
	}
	if meta.NetworkAllowed {
		return nil, errors.New("networked modules are not supported")
	}
	if meta.DisplayName == "" || strings.ContainsAny(meta.DisplayName, "\r\n\x00") {
		return nil, errors.New("invalid module display name")
	}
	if meta.Action == "" || strings.ContainsAny(meta.Action, "\r\n\x00") {
		return nil, errors.New("invalid module action")
	}
	if filepath.Base(meta.Entrypoint) != meta.Entrypoint || strings.ContainsAny(meta.Entrypoint, "\r\n\x00") {
		return nil, errors.New("invalid module entrypoint")
	}
	expectedExt := ".exe"
	if meta.Kind == "dll-plugin" {
		expectedExt = ".dll"
	}
	if strings.ToLower(filepath.Ext(meta.Entrypoint)) != expectedExt {
		return nil, errors.New("module entrypoint extension mismatch")
	}
	if len(meta.ArgumentsSchema) > 32 {
		return nil, errors.New("too many module arguments")
	}
	optionalSeen := false
	names := make(map[string]struct{}, len(meta.ArgumentsSchema))
	for _, spec := range meta.ArgumentsSchema {
		key := strings.ToLower(spec.Name)
		if key == "" {
			return nil, errors.New("module argument name required")
		}
		if _, exists := names[key]; exists {
			return nil, errors.New("duplicate module argument name")
		}
		names[key] = struct{}{}
		if spec.Type != "string" && spec.Type != "integer" && spec.Type != "boolean" {
			return nil, fmt.Errorf("invalid argument type for %s", spec.Name)
		}
		if spec.MaxLength < 1 || spec.MaxLength > 1024 {
			return nil, fmt.Errorf("invalid argument max length for %s", spec.Name)
		}
		if !spec.Required {
			optionalSeen = true
		} else if optionalSeen {
			return nil, errors.New("required arguments must precede optional arguments")
		}
		for _, choice := range spec.Choices {
			if len(choice) > spec.MaxLength {
				return nil, fmt.Errorf("argument choice too long for %s", spec.Name)
			}
		}
	}
	argsJSON, err := json.Marshal(meta.ArgumentsSchema)
	if err != nil {
		return nil, fmt.Errorf("marshal argument schema: %w", err)
	}
	lines := []string{
		"pc-manager-module-v1",
		meta.ID,
		meta.DisplayName,
		meta.Version,
		meta.Kind,
		meta.Platform,
		meta.Arch,
		strings.ToLower(meta.SHA256),
		strconv.FormatInt(meta.Size, 10),
		meta.Entrypoint,
		meta.Action,
		string(argsJSON),
		strconv.Itoa(meta.TimeoutSec),
		strconv.Itoa(meta.MaxOutputBytes),
		"0",
	}
	return []byte(strings.Join(lines, "\n")), nil
}

func verifyManifest(meta *client.ModuleMeta, expectedSignature string) error {
	if !meta.Enabled || meta.Revoked {
		return errors.New("module disabled or revoked")
	}
	if expectedSignature == "" || meta.Signature != expectedSignature {
		return errors.New("module signature does not match command")
	}
	publicKey, err := base64.StdEncoding.DecodeString(meta.PublicKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return errors.New("invalid module public key")
	}
	sum := sha256.Sum256(publicKey)
	if meta.Signer != "ed25519:"+hex.EncodeToString(sum[:]) {
		return errors.New("module signer fingerprint mismatch")
	}
	signature, err := base64.StdEncoding.DecodeString(meta.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return errors.New("invalid module signature")
	}
	message, err := canonicalManifest(meta)
	if err != nil {
		return err
	}
	if !ed25519.Verify(ed25519.PublicKey(publicKey), message, signature) {
		return errors.New("module signature verification failed")
	}
	if meta.Platform != runtime.GOOS || meta.Arch != runtime.GOARCH {
		return fmt.Errorf("module target %s/%s does not match host %s/%s", meta.Platform, meta.Arch, runtime.GOOS, runtime.GOARCH)
	}
	return nil
}

func validateArgs(schema []client.ModuleArgumentSpec, args []string) error {
	if len(args) > len(schema) {
		return errors.New("too many module arguments")
	}
	for i, spec := range schema {
		if i >= len(args) {
			if spec.Required {
				return fmt.Errorf("missing argument: %s", spec.Name)
			}
			continue
		}
		value := args[i]
		if len(value) > spec.MaxLength {
			return fmt.Errorf("argument too long: %s", spec.Name)
		}
		if len(spec.Choices) > 0 {
			allowed := false
			for _, choice := range spec.Choices {
				if value == choice {
					allowed = true
					break
				}
			}
			if !allowed {
				return fmt.Errorf("argument not allowed: %s", spec.Name)
			}
		}
		if spec.Type == "integer" && !integerPattern.MatchString(value) {
			return fmt.Errorf("argument is not an integer: %s", spec.Name)
		}
		if spec.Type == "boolean" && value != "true" && value != "false" {
			return fmt.Errorf("argument is not a boolean: %s", spec.Name)
		}
	}
	return nil
}
