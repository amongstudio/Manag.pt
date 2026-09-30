package scan

import (
	"encoding/json"
	"strings"

	"github.com/pc-manager/agent/internal/winreg"
)

type Posture struct {
	Autologon *bool  `json:"autologon,omitempty"`
	SMBv1     *bool  `json:"smbv1,omitempty"`
	Trivy     string `json:"trivy"`
}

func HostPosture() Posture {
	out := Posture{Trivy: "unavailable"}
	if TrivyAvailable() {
		out.Trivy = "present"
	}
	if value, ok := readReg(`SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`, "AutoAdminLogon"); ok {
		enabled := value == "1" || strings.EqualFold(value, "true")
		out.Autologon = &enabled
	}
	if value, ok := readReg(`SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters`, "SMB1"); ok {
		enabled := value == "1" || strings.EqualFold(value, "true")
		out.SMBv1 = &enabled
	}
	return out
}

func readReg(path, name string) (string, bool) {
	raw, _ := json.Marshal(map[string]string{"hive": "HKLM", "path": path})
	result, err := winreg.Get(raw)
	if err != nil || result == nil {
		return "", false
	}
	for _, value := range result.Values {
		if strings.EqualFold(value.Name, name) {
			text, _ := value.Data.(string)
			if text == "" {
				text = strings.TrimSpace(strings.Trim(strings.ReplaceAll(toString(value.Data), "\n", ""), `"`))
			}
			return text, text != ""
		}
	}
	return "", false
}

func toString(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(raw)
}
