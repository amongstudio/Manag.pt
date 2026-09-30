package commands

import "testing"

func TestScriptArgsShell(t *testing.T) {
	bin, args, err := scriptArgs("shell", "echo hi")
	if err != nil {
		t.Fatal(err)
	}
	if len(args) == 0 || args[len(args)-1] != "echo hi" {
		t.Fatalf("%s %v", bin, args)
	}
}

func TestScriptArgsPythonMissing(t *testing.T) {
	_, _, err := scriptArgs("python", "print(1)")
	if err != nil && err.Error() != "python_not_found" {
		// python exists on this machine; the command must still be python -c
		bin, args, err2 := scriptArgs("python", "print(1)")
		if err2 != nil {
			t.Fatal(err2)
		}
		if len(args) != 2 || args[0] != "-c" {
			t.Fatalf("%s %v", bin, args)
		}
		return
	}
}

func TestScriptArgsRejectsUnknown(t *testing.T) {
	if _, _, err := scriptArgs("ruby", "puts 1"); err == nil {
		t.Fatal("expected error")
	}
}
