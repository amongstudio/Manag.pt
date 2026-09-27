//go:build windows

package winops

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

func SetBitLocker(req BitLockerWriteRequest) (*BitLockerWriteResult, error) {
	out := &BitLockerWriteResult{Action: req.Action, MountPoint: req.MountPoint}
	ps, psErr := bitLockerPSAction(req)
	if psErr == nil && ps != nil {
		return ps, nil
	}
	bde, bdeErr := bitLockerManageBdeAction(req)
	if bdeErr == nil && bde != nil {
		return bde, nil
	}
	err := bdeErr
	if err == nil {
		err = psErr
	}
	if err == nil {
		err = ErrBitLockerFailed
	}
	if isAccessDenied(err) || strings.Contains(strings.ToLower(err.Error()), "access") {
		return nil, ErrBitLockerAccess
	}
	out.Notes = []string{err.Error()}
	return nil, fmt.Errorf("%w: %v", ErrBitLockerFailed, err)
}

func bitLockerPSAction(req BitLockerWriteRequest) (*BitLockerWriteResult, error) {
	script, env := bitLockerPSScript(req)
	if script == "" {
		return nil, ErrInvalidPayload
	}
	raw, err := runHiddenEnv(2*time.Minute, env, powershellExe(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	low := strings.ToLower(raw + " " + errString(err))
	if strings.Contains(low, "tamper") {
		return nil, fmt.Errorf("bitlocker_blocked")
	}
	if err != nil && !strings.Contains(low, `"ok"`) && !strings.Contains(low, "ok") && !looksRecoveryPassword(raw) {
		if strings.Contains(low, "access") {
			return nil, ErrBitLockerAccess
		}
		if strings.Contains(low, "not found") || strings.Contains(low, "invalid class") || strings.Contains(low, "not supported") {
			return nil, err
		}
		return nil, fmt.Errorf("bitlocker_ps: %s", clipMessage(raw))
	}
	return parseBitLockerActionOutput(req, raw), nil
}

func bitLockerPSScript(req BitLockerWriteRequest) (string, []string) {
	mp := powershellQuote(req.MountPoint)
	var env []string
	if req.Password != "" {
		env = append(env, "PCMGR_BL_PASS="+req.Password)
	}
	if req.RecoveryPassword != "" {
		env = append(env, "PCMGR_BL_RP="+req.RecoveryPassword)
	}
	header := "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $mp=" + mp + "; "
	switch req.Action {
	case "protect":
		method := psEncryptionMethod(req.EncryptionMethod)
		used := ""
		if req.UsedSpaceOnly {
			used = " -UsedSpaceOnly"
		}
		return header + "$v=Enable-BitLocker -MountPoint $mp -RecoveryPasswordProtector -EncryptionMethod " + method + used + "; $rp=($v.KeyProtector | Where-Object { $_.KeyProtectorType -eq 'RecoveryPassword' } | Select-Object -First 1); [pscustomobject]@{ ok=$true; recoveryPassword=$rp.RecoveryPassword; protectorId=$rp.KeyProtectorId } | ConvertTo-Json -Compress", env
	case "unprotect":
		return header + "Disable-BitLocker -MountPoint $mp | Out-Null; 'ok'", env
	case "lock":
		return header + "Lock-BitLocker -MountPoint $mp -ForceDismount | Out-Null; 'ok'", env
	case "unlock":
		if req.RecoveryPassword != "" {
			return header + "Unlock-BitLocker -MountPoint $mp -RecoveryPassword $env:PCMGR_BL_RP | Out-Null; 'ok'", env
		}
		return header + "$sec=ConvertTo-SecureString $env:PCMGR_BL_PASS -AsPlainText -Force; Unlock-BitLocker -MountPoint $mp -Password $sec | Out-Null; 'ok'", env
	case "suspend":
		return header + "Suspend-BitLocker -MountPoint $mp | Out-Null; 'ok'", env
	case "resume":
		return header + "Resume-BitLocker -MountPoint $mp | Out-Null; 'ok'", env
	case "add_protector":
		switch req.ProtectorType {
		case "tpm":
			return header + "Add-BitLockerKeyProtector -MountPoint $mp -TpmProtector | Out-Null; 'ok'", env
		case "password":
			return header + "$sec=ConvertTo-SecureString $env:PCMGR_BL_PASS -AsPlainText -Force; Add-BitLockerKeyProtector -MountPoint $mp -PasswordProtector -Password $sec | Out-Null; 'ok'", env
		default:
			return header + "$v=Add-BitLockerKeyProtector -MountPoint $mp -RecoveryPasswordProtector; $rp=($v.KeyProtector | Where-Object { $_.KeyProtectorType -eq 'RecoveryPassword' } | Select-Object -Last 1); [pscustomobject]@{ ok=$true; recoveryPassword=$rp.RecoveryPassword; protectorId=$rp.KeyProtectorId } | ConvertTo-Json -Compress", env
		}
	case "remove_protector":
		return header + "Remove-BitLockerKeyProtector -MountPoint $mp -KeyProtectorId " + powershellQuote(req.ProtectorID) + " | Out-Null; 'ok'", env
	case "backup_key":
		return header + "$v=Get-BitLockerVolume -MountPoint $mp; $rp=($v.KeyProtector | Where-Object { $_.KeyProtectorType -eq 'RecoveryPassword' -and $_.RecoveryPassword } | Select-Object -First 1); if (-not $rp) { throw 'no_recovery_password' }; [pscustomobject]@{ ok=$true; recoveryPassword=$rp.RecoveryPassword; protectorId=$rp.KeyProtectorId } | ConvertTo-Json -Compress", env
	}
	return "", nil
}

func psEncryptionMethod(v string) string {
	switch v {
	case "xts_aes256":
		return "XtsAes256"
	case "aes128":
		return "Aes128"
	case "aes256":
		return "Aes256"
	default:
		return "XtsAes128"
	}
}

func bitLockerManageBdeAction(req BitLockerWriteRequest) (*BitLockerWriteResult, error) {
	exe := system32("manage-bde.exe")
	var raw string
	var err error
	switch req.Action {
	case "protect":
		args := []string{"-on", req.MountPoint, "-RecoveryPassword"}
		if req.UsedSpaceOnly {
			args = append(args, "-UsedSpaceOnly")
		}
		raw, err = runCmdEnglish(2*time.Minute, exe, args...)
	case "unprotect":
		raw, err = runCmdEnglish(2*time.Minute, exe, "-off", req.MountPoint)
	case "lock":
		raw, err = runCmdEnglish(45*time.Second, exe, "-lock", req.MountPoint, "-ForceDismount")
	case "unlock":
		if req.RecoveryPassword != "" {
			raw, err = runCmdEnglish(45*time.Second, exe, "-unlock", req.MountPoint, "-RecoveryPassword", req.RecoveryPassword)
		} else {
			return nil, fmt.Errorf("manage-bde password unlock needs PowerShell")
		}
	case "suspend":
		raw, err = runCmdEnglish(45*time.Second, exe, "-protectors", "-disable", req.MountPoint)
	case "resume":
		raw, err = runCmdEnglish(45*time.Second, exe, "-protectors", "-enable", req.MountPoint)
	case "add_protector":
		switch req.ProtectorType {
		case "tpm":
			raw, err = runCmdEnglish(45*time.Second, exe, "-protectors", "-add", req.MountPoint, "-tpm")
		case "recovery":
			raw, err = runCmdEnglish(45*time.Second, exe, "-protectors", "-add", req.MountPoint, "-rp")
		default:
			return nil, fmt.Errorf("manage-bde password protector needs PowerShell")
		}
	case "remove_protector":
		raw, err = runCmdEnglish(45*time.Second, exe, "-protectors", "-delete", req.MountPoint, "-id", req.ProtectorID)
	case "backup_key":
		raw, err = runCmdEnglish(45*time.Second, exe, "-protectors", "-get", req.MountPoint)
		if err == nil || looksRecoveryPassword(raw) {
			return parseBitLockerActionOutput(req, raw), nil
		}
	default:
		return nil, ErrInvalidPayload
	}
	if err != nil && !looksRecoveryPassword(raw) && !strings.Contains(strings.ToLower(raw), "successfully") {
		if strings.Contains(strings.ToLower(raw+" "+errString(err)), "access") {
			return nil, ErrBitLockerAccess
		}
		return nil, fmt.Errorf("manage-bde: %s", clipMessage(raw))
	}
	return parseBitLockerActionOutput(req, raw), nil
}

func parseBitLockerActionOutput(req BitLockerWriteRequest, raw string) *BitLockerWriteResult {
	out := &BitLockerWriteResult{Action: req.Action, MountPoint: req.MountPoint, Applied: true}
	if rp, id := extractJSONRecovery(raw); rp != "" {
		out.RecoveryPassword = rp
		out.ProtectorID = id
	}
	if out.RecoveryPassword == "" {
		for _, hit := range parseRecoveryProtectors(raw) {
			if hit.Pass != "" {
				out.RecoveryPassword = hit.Pass
				out.ProtectorID = hit.ID
				break
			}
		}
	}
	if out.RecoveryPassword != "" {
		out.Credentials = []map[string]any{{
			"source":  "bitlocker",
			"kind":    "recovery_key",
			"target":  req.MountPoint,
			"secret":  out.RecoveryPassword,
			"comment": "BitLocker recovery password",
			"key":     "bitlocker|" + strings.ToLower(req.MountPoint) + "|",
		}}
		if out.ProtectorID != "" {
			out.Credentials[0]["comment"] = "BitLocker recovery password " + out.ProtectorID
		}
	}
	return out
}

func extractJSONRecovery(raw string) (string, string) {
	raw = strings.TrimSpace(raw)
	if i := strings.Index(raw, "{"); i >= 0 {
		raw = raw[i:]
	}
	if !strings.HasPrefix(raw, "{") {
		return "", ""
	}
	var row map[string]any
	if json.Unmarshal([]byte(raw), &row) != nil {
		return "", ""
	}
	return jsonString(row, "recoveryPassword", "RecoveryPassword"), jsonString(row, "protectorId", "KeyProtectorId")
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
