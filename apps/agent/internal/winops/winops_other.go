//go:build !windows

package winops

func EventLog(EventLogRequest) (*EventLogResult, error) {
	return nil, ErrUnsupported
}

func WindowsUpdate(UpdateRequest) (*UpdateResult, error) {
	return nil, ErrUnsupported
}

func StartQuickAssist(AssistRequest) (*AssistResult, error) {
	return nil, ErrUnsupported
}

func AdminCenter() (*AdminCenterResult, error) {
	return nil, ErrUnsupported
}

func Tasks(TasksRequest) (*TaskList, error) {
	return nil, ErrUnsupported
}

func SetTaskEnabled(TaskWriteRequest) (*TaskWriteResult, error) {
	return nil, ErrUnsupported
}

func Defender() (*DefenderStatus, error) {
	return nil, ErrUnsupported
}

func SetDefender(DefenderWriteRequest) (*DefenderWriteResult, error) {
	return nil, ErrUnsupported
}

func StartDefenderScan(DefenderScanRequest) (*DefenderScanResult, error) {
	return nil, ErrUnsupported
}

func UpdateDefender() (map[string]any, error) {
	return nil, ErrUnsupported
}

func DefenderThreatAction(DefenderActionRequest) (*DefenderActionResult, error) {
	return nil, ErrUnsupported
}

func CancelDefenderScan() (map[string]any, error) {
	return nil, ErrUnsupported
}

func BitLocker() (*BitLockerResult, error) {
	return nil, ErrUnsupported
}

func SetBitLocker(BitLockerWriteRequest) (*BitLockerWriteResult, error) {
	return nil, ErrUnsupported
}

func Capabilities(CapabilitiesRequest) (*CapabilityList, error) {
	return nil, ErrUnsupported
}

func InstallCapability(InstallCapabilityRequest) (*InstallCapabilityResult, error) {
	return nil, ErrUnsupported
}
