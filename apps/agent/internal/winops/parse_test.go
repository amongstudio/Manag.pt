package winops

import "testing"

func TestParseManageBde(t *testing.T) {
	raw := `
Volume C: [OS]
    Size:                 475.00 GB
    Conversion Status:    Fully Encrypted
    Percentage Encrypted: 100.0%
    Encryption Method:    XTS-AES 128
    Protection Status:    Protection On

Volume D: [Data]
    Conversion Status:    Fully Decrypted
    Percentage Encrypted: 0.0%
    Protection Status:    Protection Off
`
	vols := parseManageBde(raw)
	if len(vols) != 2 {
		t.Fatalf("vols %d", len(vols))
	}
	if vols[0].MountPoint != "C:" || vols[0].ProtectionStatus != "on" || vols[0].ConversionStatus != "fully_encrypted" {
		t.Fatalf("c %+v", vols[0])
	}
	if vols[0].EncryptionPercent == nil || *vols[0].EncryptionPercent != 100 {
		t.Fatalf("pct %+v", vols[0].EncryptionPercent)
	}
	if vols[1].ProtectionStatus != "off" {
		t.Fatalf("d %+v", vols[1])
	}
}

func TestParseManageBdeProtectorsAndLock(t *testing.T) {
	raw := `
Volume C: [OS]
    Conversion Status:    Fully Encrypted
    Percentage Encrypted: 100.0%
    Encryption Method:    XTS-AES 128
    Protection Status:    Protection On
    Lock Status:          Unlocked
    Automatic Unlock:     Disabled
    Key Protectors:
        TPM
        Numerical Password

Volume D: [Data]
    Conversion Status:    Fully Decrypted
    Percentage Encrypted: 0.0%
    Protection Status:    Protection Off
    Lock Status:          Locked
`
	vols := parseManageBde(raw)
	if len(vols) != 2 {
		t.Fatalf("vols %d", len(vols))
	}
	if vols[0].ProtectionStatus != "on" || vols[0].LockStatus != "unlocked" {
		t.Fatalf("c %+v", vols[0])
	}
	if vols[0].AutoUnlock == nil || *vols[0].AutoUnlock {
		t.Fatalf("auto %+v", vols[0].AutoUnlock)
	}
	if len(vols[0].KeyProtectors) < 2 || vols[0].KeyProtectors[0].Type != "tpm" || vols[0].KeyProtectors[1].Type != "recovery" {
		t.Fatalf("protectors %+v", vols[0].KeyProtectors)
	}
	if vols[1].ProtectionStatus != "off" || vols[1].LockStatus != "locked" {
		t.Fatalf("d %+v", vols[1])
	}
}

func TestManageBdeProtectionOffContainsOn(t *testing.T) {
	if manageBdeProtection("Protection Off") != "off" {
		t.Fatal("off")
	}
	if manageBdeProtection("Protection On") != "on" {
		t.Fatal("on")
	}
}

func TestParseDismCapabilities(t *testing.T) {
	raw := `
Capability Identity : Media.MediaFeaturePack~~~~0.0.1.0
State : Not Present

Capability Identity : Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0
State : Installed
`
	rows := parseDismCapabilities(raw, "Rsat")
	if len(rows) != 1 || rows[0].Kind != "rsat" || rows[0].State != "installed" {
		t.Fatalf("%+v", rows)
	}
	all := parseDismCapabilities(raw, "")
	if len(all) != 2 {
		t.Fatalf("all %d", len(all))
	}
}

func TestParseInstallCapability(t *testing.T) {
	req, err := ParseInstallCapability([]byte(`{}`))
	if err != nil || req.Name != MediaFeaturePack {
		t.Fatalf("%+v %v", req, err)
	}
	if _, err := ParseInstallCapability([]byte(`{"name":"Rsat.Foo~~~~0.0.1.0"}`)); err != ErrInvalidPayload {
		t.Fatalf("rsat: %v", err)
	}
}
