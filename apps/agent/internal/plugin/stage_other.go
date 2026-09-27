//go:build !linux && !windows

package plugin

func stageForExec(runtimeName string, data []byte) (artifact, error) {
	return stageTemp(data, extFor(runtimeName), runtimeName == "binary")
}
