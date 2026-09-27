//go:build !windows

package config

func loadFromStore(cfg *Config) bool { return false }

func persistInitialStore(cfg *Config) {}

func saveToStore(cfg *Config) error { return nil }

func restrictFileACL(path string) {}

func RestrictFileACL(path string) { restrictFileACL(path) }

func fillIdentityFromStore(_ map[string]any) {}

func restrictMachineRegistryACL() {}

// MigrateUserToMachine is a no-op off Windows.
func MigrateUserToMachine() error { return nil }

// ImportYAMLToMachine is a no-op off Windows.
func ImportYAMLToMachine(path string) error { return nil }

// PersistForService writes YAML for the service process (file already merged).
func PersistForService(yamlPaths ...string) error {
	_ = yamlPaths
	return nil
}
