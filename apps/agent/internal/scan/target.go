package scan

import (
	"net/url"
	"strings"
)

// TargetHost returns the IP or CIDR that must pass AuthorizeTarget.
// URLs use the host only, so a userinfo or path cannot point at a second address.
func TargetHost(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errRefused
	}
	if !strings.Contains(trimmed, "://") {
		return trimmed, nil
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return "", errRefused
	}
	return parsed.Hostname(), nil
}

// NucleiURL is the single URL passed to nuclei. Its host is the authorized address.
func NucleiURL(raw, authorizedHost string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if !strings.Contains(trimmed, "://") {
		return "http://" + authorizedHost, nil
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Hostname() != authorizedHost {
		return "", errRefused
	}
	parsed.User = nil
	return parsed.String(), nil
}
