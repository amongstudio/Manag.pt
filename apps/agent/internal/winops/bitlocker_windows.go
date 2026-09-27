//go:build windows

package winops

import (
	"encoding/json"
	"strings"
	"time"

	ole "github.com/go-ole/go-ole"
)

const maxBitLocker = 64

func BitLocker() (*BitLockerResult, error) {
	out, wmiErr := bitLockerWMI()
	bde := bitLockerManageBde()
	if out != nil && len(out.Volumes) > 0 {
		mergeBitLocker(out.Volumes, bde)
		out.Available = true
		return out, nil
	}
	if len(bde) > 0 {
		return &BitLockerResult{Volumes: bde, Available: true}, nil
	}
	if vols := bitLockerPowerShell(); len(vols) > 0 {
		return &BitLockerResult{Volumes: vols, Available: true}, nil
	}
	reason := "unavailable"
	if wmiErr != nil {
		if isAccessDenied(wmiErr) {
			return nil, ErrBitLockerAccess
		}
		if isWMIMissing(wmiErr) {
			reason = "home_sku_or_no_wmi"
		} else {
			reason = "bitlocker_query_failed"
		}
	}
	return &BitLockerResult{
		Volumes:   []BitLockerVolume{},
		Available: false,
		Reason:    reason,
	}, nil
}

func bitLockerWMI() (*BitLockerResult, error) {
	out := &BitLockerResult{Volumes: []BitLockerVolume{}, Available: true}
	err := withWMI(`root\cimv2\Security\MicrosoftVolumeEncryption`, func(svc *ole.IDispatch) error {
		return wmiQuery(svc, "SELECT * FROM Win32_EncryptableVolume", func(item *ole.IDispatch) error {
			if len(out.Volumes) >= maxBitLocker {
				out.Truncated = true
				return nil
			}
			row := BitLockerVolume{
				MountPoint:         propString(item, "DriveLetter"),
				DeviceID:           propString(item, "DeviceID"),
				PersistentVolumeID: propString(item, "PersistentVolumeID"),
				ProtectionStatus:   "unknown",
			}
			if row.MountPoint == "" {
				row.MountPoint = wmiMethodString(item, "GetDriveLetter", "DriveLetter")
			}
			if row.MountPoint == "" {
				row.MountPoint = row.DeviceID
			}
			if n, ok := wmiMethodInt(item, "GetProtectionStatus", "ProtectionStatus"); ok {
				row.ProtectionStatus = protectionName(n)
			} else {
				row.ProtectionStatus = protectionName(propInt(item, "ProtectionStatus"))
			}
			if conv := wmiExec(item, "GetConversionStatus"); conv != nil {
				row.ConversionStatus = conversionName(propInt(conv, "ConversionStatus"))
				if n := propInt(conv, "EncryptionPercentage"); n >= 0 && n <= 100 {
					pct := n
					row.EncryptionPercent = &pct
				}
				if flags := propInt(conv, "EncryptionFlags"); flags == 1 {
					row.EncryptionFlags = "used_space"
				} else if flags == 0 && row.ConversionStatus != "fully_decrypted" && row.ConversionStatus != "" {
					row.EncryptionFlags = "full"
				}
				conv.Release()
			}
			if n, ok := wmiMethodInt(item, "GetEncryptionMethod", "EncryptionMethod"); ok {
				row.EncryptionMethod = encryptionMethodName(n)
			}
			if n, ok := wmiMethodInt(item, "GetLockStatus", "LockStatus"); ok {
				if n == 1 {
					row.LockStatus = "locked"
				} else {
					row.LockStatus = "unlocked"
				}
			}
			if auto := wmiExec(item, "IsAutoUnlockEnabled"); auto != nil {
				on := propBool(auto, "IsAutoUnlockEnabled")
				row.AutoUnlock = &on
				auto.Release()
			}
			out.Volumes = append(out.Volumes, row)
			return nil
		})
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func bitLockerManageBde() []BitLockerVolume {
	raw, err := runCmdEnglish(45*time.Second, system32("manage-bde.exe"), "-status")
	if err != nil && raw == "" {
		return nil
	}
	return parseManageBde(raw)
}

func bitLockerPowerShell() []BitLockerVolume {
	script := strings.Join([]string{
		"$ProgressPreference='SilentlyContinue'",
		"$ErrorActionPreference='SilentlyContinue'",
		"if (Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue) { Get-BitLockerVolume | Select-Object MountPoint,ProtectionStatus,VolumeStatus,EncryptionPercentage,EncryptionMethod,VolumeType,CapacityGB,LockStatus,AutoUnlockEnabled,EncryptionMethod,KeyProtector | ConvertTo-Json -Compress -Depth 5 } else { Get-CimInstance -Namespace 'root/cimv2/Security/MicrosoftVolumeEncryption' -ClassName Win32_EncryptableVolume | ForEach-Object { $p = Invoke-CimMethod -InputObject $_ -MethodName GetProtectionStatus; $c = Invoke-CimMethod -InputObject $_ -MethodName GetConversionStatus; $d = Invoke-CimMethod -InputObject $_ -MethodName GetDriveLetter; $l = Invoke-CimMethod -InputObject $_ -MethodName GetLockStatus; [pscustomobject]@{ MountPoint=$d.DriveLetter; DeviceID=$_.DeviceID; ProtectionStatus=$p.ProtectionStatus; ConversionStatus=$c.ConversionStatus; EncryptionPercentage=$c.EncryptionPercentage; LockStatus=$l.LockStatus } } | ConvertTo-Json -Compress }",
	}, ";")
	raw, err := runHidden(45*time.Second, powershellExe(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	if err != nil && raw == "" {
		return nil
	}
	return parseBitLockerJSON(raw)
}

func protectionName(v int) string {
	switch v {
	case 0:
		return "off"
	case 1:
		return "on"
	default:
		return "unknown"
	}
}

func conversionName(v int) string {
	switch v {
	case 0:
		return "fully_decrypted"
	case 1:
		return "fully_encrypted"
	case 2:
		return "encryption_in_progress"
	case 3:
		return "decryption_in_progress"
	case 4:
		return "encryption_paused"
	case 5:
		return "decryption_paused"
	default:
		return "unknown"
	}
}

func encryptionMethodName(v int) string {
	switch v {
	case 0:
		return "none"
	case 1:
		return "aes128_diffuser"
	case 2:
		return "aes256_diffuser"
	case 3:
		return "aes128"
	case 4:
		return "aes256"
	case 5:
		return "hardware"
	case 6:
		return "xts_aes128"
	case 7:
		return "xts_aes256"
	default:
		return "unknown"
	}
}

func parseBitLockerJSON(raw string) []BitLockerVolume {
	raw = strings.TrimSpace(raw)
	if i := strings.IndexAny(raw, "[{"); i > 0 {
		raw = strings.TrimSpace(raw[i:])
	}
	if raw == "" {
		return nil
	}
	if strings.HasPrefix(raw, "{") {
		raw = "[" + raw + "]"
	}
	var rows []map[string]any
	if err := json.Unmarshal([]byte(raw), &rows); err != nil {
		return nil
	}
	out := make([]BitLockerVolume, 0, len(rows))
	for _, row := range rows {
		vol := BitLockerVolume{
			MountPoint:         jsonString(row, "MountPoint", "mountPoint"),
			DeviceID:           jsonString(row, "DeviceID", "deviceId"),
			ProtectionStatus:   "unknown",
			ConversionStatus:   jsonString(row, "VolumeStatus", "conversionStatus", "ConversionStatus"),
			EncryptionMethod:   jsonString(row, "EncryptionMethod", "encryptionMethod"),
			VolumeType:         jsonString(row, "VolumeType", "volumeType"),
			PersistentVolumeID: jsonString(row, "PersistentVolumeID", "persistentVolumeId"),
		}
		vol.ProtectionStatus = jsonProtection(row, "ProtectionStatus", "protectionStatus")
		if vol.ConversionStatus != "" {
			vol.ConversionStatus = manageBdeConversion(vol.ConversionStatus)
		} else {
			vol.ConversionStatus = conversionName(jsonInt(row, "ConversionStatus", "conversionStatus"))
		}
		if vol.EncryptionMethod != "" {
			vol.EncryptionMethod = strings.ToLower(strings.ReplaceAll(vol.EncryptionMethod, " ", "_"))
		}
		if _, ok := row["EncryptionPercentage"]; ok || row["encryptionPercent"] != nil {
			if pct := jsonInt(row, "EncryptionPercentage", "encryptionPercent"); pct >= 0 && pct <= 100 {
				p := pct
				vol.EncryptionPercent = &p
			}
		}
		if lock := jsonString(row, "LockStatus", "lockStatus"); lock != "" {
			vol.LockStatus = manageBdeLock(lock)
		} else if n := jsonInt(row, "LockStatus", "lockStatus"); n == 1 {
			vol.LockStatus = "locked"
		} else if _, ok := row["LockStatus"]; ok {
			vol.LockStatus = "unlocked"
		}
		if v, ok := row["AutoUnlockEnabled"]; ok {
			on := jsonBool(map[string]any{"AutoUnlockEnabled": v}, "AutoUnlockEnabled")
			vol.AutoUnlock = &on
		}
		if kp := jsonKeyProtectors(row["KeyProtector"], row["KeyProtectors"]); len(kp) > 0 {
			vol.KeyProtectors = kp
		}
		if vol.MountPoint == "" && vol.DeviceID == "" {
			continue
		}
		out = append(out, vol)
		if len(out) >= maxBitLocker {
			break
		}
	}
	return out
}

func jsonProtection(row map[string]any, keys ...string) string {
	for _, k := range keys {
		switch v := row[k].(type) {
		case float64:
			return protectionName(int(v))
		case int:
			return protectionName(v)
		case string:
			return manageBdeProtection(v)
		case map[string]any:
			if n, ok := v["value"].(float64); ok {
				return protectionName(int(n))
			}
			if s, ok := v["DisplayName"].(string); ok {
				return manageBdeProtection(s)
			}
		case bool:
			if v {
				return "on"
			}
			return "off"
		}
	}
	return "unknown"
}

func jsonKeyProtectors(values ...any) []BitLockerKeyProtector {
	var out []BitLockerKeyProtector
	for _, v := range values {
		switch t := v.(type) {
		case []any:
			for _, item := range t {
				if m, ok := item.(map[string]any); ok {
					typ := protectorTypeName(jsonString(m, "KeyProtectorType", "Type", "type"))
					if typ == "" {
						continue
					}
					out = append(out, BitLockerKeyProtector{
						ID:   jsonString(m, "KeyProtectorId", "ID", "id"),
						Type: typ,
					})
				} else if s, ok := item.(string); ok {
					out = append(out, parseProtectorLine(s)...)
				}
			}
		case map[string]any:
			typ := protectorTypeName(jsonString(t, "KeyProtectorType", "Type", "type"))
			if typ != "" {
				out = append(out, BitLockerKeyProtector{
					ID:   jsonString(t, "KeyProtectorId", "ID", "id"),
					Type: typ,
				})
			}
		}
	}
	return out
}

func mergeBitLocker(dest []BitLockerVolume, src []BitLockerVolume) {
	byMount := map[string]BitLockerVolume{}
	for _, v := range src {
		key := strings.ToUpper(strings.TrimRight(v.MountPoint, `\`))
		if key != "" {
			byMount[key] = v
		}
	}
	for i := range dest {
		key := strings.ToUpper(strings.TrimRight(dest[i].MountPoint, `\`))
		extra, ok := byMount[key]
		if !ok {
			continue
		}
		if dest[i].LockStatus == "" {
			dest[i].LockStatus = extra.LockStatus
		}
		if dest[i].VolumeType == "" {
			dest[i].VolumeType = extra.VolumeType
		}
		if dest[i].EncryptionFlags == "" {
			dest[i].EncryptionFlags = extra.EncryptionFlags
		}
		if dest[i].AutoUnlock == nil {
			dest[i].AutoUnlock = extra.AutoUnlock
		}
		if len(dest[i].KeyProtectors) == 0 {
			dest[i].KeyProtectors = extra.KeyProtectors
		}
		if dest[i].ConversionStatus == "" {
			dest[i].ConversionStatus = extra.ConversionStatus
		}
		if dest[i].EncryptionMethod == "" {
			dest[i].EncryptionMethod = extra.EncryptionMethod
		}
		if dest[i].EncryptionPercent == nil {
			dest[i].EncryptionPercent = extra.EncryptionPercent
		}
	}
}
