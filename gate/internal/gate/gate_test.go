package gate

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestEndToEndGateScenarios(t *testing.T) {
	fastPolicy := Policy{
		MaxNonTestLines: 150,
		MaxTotalLines:   300,
		MaxFiles:        5,
		BaseRuns:        3,
		HeadNewRuns:     3,
		HeadFullRuns:    2,
	}

	t.Run("valid bug fix passes", func(t *testing.T) {
		repo := initBuggyGoRepo(t)
		base := gitHead(t, repo)

		// Fix Add(a, b) and add a new test function without editing existing test.
		writeRepoFile(t, repo, "calc/calc.go", `package calc

func Add(a, b int) int { return a + b }
`)
		writeRepoFile(t, repo, "calc/issue1_test.go", `package calc

import "testing"

func TestIssue1NegativeAdd(t *testing.T) {
	if got := Add(2, -5); got != -3 {
		t.Fatalf("got %d, want -3", got)
	}
}
`)
		head := gitCommitAll(t, repo, "fix Add bug with repro test")

		rep, err := Run(Options{RepoDir: repo, BaseRef: base, HeadRef: head, Policy: fastPolicy})
		if err != nil {
			t.Fatalf("Run error: %v", err)
		}
		if !rep.Passed {
			t.Fatalf("expected Gate PASS, got violations: %v", rep.Violations)
		}
		if len(rep.ReproTests) != 1 || rep.ReproTests[0] != "calc::TestIssue1NegativeAdd" {
			t.Fatalf("unexpected repro tests: %v", rep.ReproTests)
		}
	})

	t.Run("compile failure on base does NOT count as red repro", func(t *testing.T) {
		repo := initBuggyGoRepo(t)
		base := gitHead(t, repo)

		writeRepoFile(t, repo, "calc/calc.go", `package calc

func Add(a, b int) int { return a + b }
func BrandNewHelper(x int) int { return x * 2 }
`)
		writeRepoFile(t, repo, "calc/fake_test.go", `package calc

import "testing"

func TestIssue2NewSymbol(t *testing.T) {
	if BrandNewHelper(3) != 6 {
		t.Fatal("bad")
	}
}
`)
		head := gitCommitAll(t, repo, "test calls new symbol")

		rep, err := Run(Options{RepoDir: repo, BaseRef: base, HeadRef: head, Policy: fastPolicy})
		if err != nil {
			t.Fatalf("Run error: %v", err)
		}
		if rep.Passed {
			t.Fatalf("expected Gate FAIL on compile failure on base")
		}
		assertContainsViolation(t, rep.Violations, "base build failed")
	})

	t.Run("TestMain bypass is rejected by AST check", func(t *testing.T) {
		repo := initBuggyGoRepo(t)
		base := gitHead(t, repo)

		writeRepoFile(t, repo, "calc/bypass_test.go", `package calc

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) { os.Exit(0) }
func TestIssue3Dummy(t *testing.T) { t.Fatal("never runs") }
`)
		head := gitCommitAll(t, repo, "attempt TestMain bypass")

		rep, err := Run(Options{RepoDir: repo, BaseRef: base, HeadRef: head, Policy: fastPolicy})
		if err != nil {
			t.Fatalf("Run error: %v", err)
		}
		if rep.Passed {
			t.Fatalf("expected Gate FAIL on TestMain")
		}
		assertContainsViolation(t, rep.Violations, "banned TestMain")
	})

	t.Run("t.Skip and init() and build tags are rejected", func(t *testing.T) {
		repo := initBuggyGoRepo(t)
		base := gitHead(t, repo)

		writeRepoFile(t, repo, "calc/sneaky_test.go", `//go:build linux

package calc

import "testing"

func init() {}

func TestIssue4Skip(t *testing.T) {
	t.Skip("skipping")
}
`)
		head := gitCommitAll(t, repo, "sneaky test file")

		rep, err := Run(Options{RepoDir: repo, BaseRef: base, HeadRef: head, Policy: fastPolicy})
		if err != nil {
			t.Fatalf("Run error: %v", err)
		}
		if rep.Passed {
			t.Fatalf("expected Gate FAIL on banned constructs")
		}
		assertContainsViolation(t, rep.Violations, "banned build constraint")
		assertContainsViolation(t, rep.Violations, "banned init()")
		assertContainsViolation(t, rep.Violations, "banned Skip()")
	})

	t.Run("modifying existing test is rejected", func(t *testing.T) {
		repo := initBuggyGoRepo(t)
		base := gitHead(t, repo)

		writeRepoFile(t, repo, "calc/calc.go", `package calc

func Add(a, b int) int { return a + b }
`)
		writeRepoFile(t, repo, "calc/calc_test.go", `package calc

import "testing"

func TestAddPositive(t *testing.T) {
	// modified existing test!
	if Add(1, 2) != 3 {
		t.Fatal("bad")
	}
}

func TestIssue5New(t *testing.T) {
	if Add(2, -5) != -3 {
		t.Fatal("bad")
	}
}
`)
		head := gitCommitAll(t, repo, "modify existing test")

		rep, err := Run(Options{RepoDir: repo, BaseRef: base, HeadRef: head, Policy: fastPolicy})
		if err != nil {
			t.Fatalf("Run error: %v", err)
		}
		if rep.Passed {
			t.Fatalf("expected Gate FAIL on modified existing test")
		}
		assertContainsViolation(t, rep.Violations, "existing test modified")
	})

	t.Run("go:generate addition is rejected", func(t *testing.T) {
		repo := initBuggyGoRepo(t)
		base := gitHead(t, repo)

		writeRepoFile(t, repo, "calc/calc.go", `package calc

//go:generate echo pwned
func Add(a, b int) int { return a + b }
`)
		writeRepoFile(t, repo, "calc/issue6_test.go", `package calc

import "testing"

func TestIssue6(t *testing.T) {
	if Add(2, -5) != -3 {
		t.Fatal("bad")
	}
}
`)
		head := gitCommitAll(t, repo, "add go:generate")

		rep, err := Run(Options{RepoDir: repo, BaseRef: base, HeadRef: head, Policy: fastPolicy})
		if err != nil {
			t.Fatalf("Run error: %v", err)
		}
		if rep.Passed {
			t.Fatalf("expected Gate FAIL on //go:generate")
		}
		assertContainsViolation(t, rep.Violations, "banned //go:generate")
	})

	t.Run("already fixed bug flags AlreadyFixed", func(t *testing.T) {
		repo := initBuggyGoRepo(t)
		base := gitHead(t, repo)

		writeRepoFile(t, repo, "calc/issue7_test.go", `package calc

import "testing"

func TestAlreadyPassing(t *testing.T) {
	if Add(1, 2) != 3 {
		t.Fatal("bad")
	}
}
`)
		head := gitCommitAll(t, repo, "test already passes on base")

		rep, err := Run(Options{RepoDir: repo, BaseRef: base, HeadRef: head, Policy: fastPolicy})
		if err != nil {
			t.Fatalf("Run error: %v", err)
		}
		if rep.Passed || !rep.AlreadyFixed {
			t.Fatalf("expected Passed=false AlreadyFixed=true, got %+v", rep)
		}
	})

	t.Run("exact-inverse revert exemption passes", func(t *testing.T) {
		repo := initBuggyGoRepo(t)
		// Simulate a factory squash commit on main.
		writeRepoFile(t, repo, "calc/calc.go", `package calc

func Add(a, b int) int { return a + b }
`)
		factorySquash := gitCommitAll(t, repo, "factory squash commit")

		// Now revert that exact commit on a branch.
		runCmd(t, repo, "git", "revert", "--no-edit", factorySquash)
		revertHead := gitHead(t, repo)

		rep, err := Run(Options{
			RepoDir:  repo,
			BaseRef:  factorySquash,
			HeadRef:  revertHead,
			RevertOf: factorySquash,
			Policy:   fastPolicy,
		})
		if err != nil {
			t.Fatalf("Run error: %v", err)
		}
		if !rep.Passed || !rep.RevertExempt {
			t.Fatalf("expected exact-inverse revert to pass, got %+v", rep)
		}
	})

	t.Run("modifying shared test helper inside existing test file is rejected", func(t *testing.T) {
		repo := initBuggyGoRepo(t)
		// Add a base test file with a shared helper function.
		writeRepoFile(t, repo, "calc/helper_test.go", `package calc

import "testing"

func assertEqual(t *testing.T, got, want int) {
	t.Helper()
	if got != want {
		t.Fatalf("got %d, want %d", got, want)
	}
}

func TestViaHelper(t *testing.T) {
	assertEqual(t, Add(1, 2), 3)
}
`)
		base := gitCommitAll(t, repo, "add shared helper test")

		// Weaken assertEqual without touching TestViaHelper!
		writeRepoFile(t, repo, "calc/calc.go", `package calc

func Add(a, b int) int { return a + b }
`)
		writeRepoFile(t, repo, "calc/helper_test.go", `package calc

import "testing"

func assertEqual(t *testing.T, got, want int) {
	t.Helper()
	// weakened helper: never fails!
}

func TestViaHelper(t *testing.T) {
	assertEqual(t, Add(1, 2), 3)
}
`)
		writeRepoFile(t, repo, "calc/issue99_test.go", `package calc

import "testing"

func TestIssue99(t *testing.T) {
	if Add(2, -5) != -3 {
		t.Fatal("bad")
	}
}
`)
		head := gitCommitAll(t, repo, "weaken shared helper")

		rep, err := Run(Options{RepoDir: repo, BaseRef: base, HeadRef: head, Policy: fastPolicy})
		if err != nil {
			t.Fatalf("Run error: %v", err)
		}
		if rep.Passed {
			t.Fatalf("expected Gate FAIL when shared test helper is modified")
		}
		assertContainsViolation(t, rep.Violations, "existing test helper/declaration modified")
	})

	t.Run("policy-from-base tightens bounds and ignores loosening", func(t *testing.T) {
		repo := initBuggyGoRepo(t)
		writeRepoFile(t, repo, ".agents/landing.json", `{"maxNonTestLines": 2, "maxTotalLines": 9999, "extraProtectedPaths": ["secret/**"]}`)
		base := gitCommitAll(t, repo, "add base landing.json")

		// Touch 4 non-test lines -> exceeds tightened maxNonTestLines=2 from base!
		writeRepoFile(t, repo, "calc/calc.go", `package calc

// line 1
// line 2
// line 3
func Add(a, b int) int { return a + b }
`)
		writeRepoFile(t, repo, "calc/issue100_test.go", `package calc

import "testing"

func TestIssue100(t *testing.T) {
	if Add(2, -5) != -3 {
		t.Fatal("bad")
	}
}
`)
		head := gitCommitAll(t, repo, "exceed tightened non-test lines")

		rep, err := Run(Options{RepoDir: repo, BaseRef: base, HeadRef: head, PolicyFromBase: true, Policy: fastPolicy})
		if err != nil {
			t.Fatalf("Run error: %v", err)
		}
		if rep.Passed {
			t.Fatalf("expected Gate FAIL on tightened base policy")
		}
		assertContainsViolation(t, rep.Violations, "exceeds limit 2")
	})

	t.Run("revert-of non-ancestor commit is rejected", func(t *testing.T) {
		repo := initBuggyGoRepo(t)
		base := gitHead(t, repo)

		// Create an unrelated commit on a side branch (not an ancestor of base).
		runCmd(t, repo, "git", "checkout", "-b", "side")
		writeRepoFile(t, repo, "calc/calc.go", `package calc

func Add(a, b int) int { return a + b }
`)
		unrelated := gitCommitAll(t, repo, "unrelated commit")

		rep, err := Run(Options{RepoDir: repo, BaseRef: base, HeadRef: unrelated, RevertOf: unrelated, Policy: fastPolicy})
		if err != nil {
			t.Fatalf("Run error: %v", err)
		}
		if rep.Passed {
			t.Fatalf("expected Gate FAIL when revert-of is not ancestor of base")
		}
		assertContainsViolation(t, rep.Violations, "not an ancestor")
	})
}

func initBuggyGoRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	runCmd(t, dir, "git", "init", "-b", "main")
	runCmd(t, dir, "git", "config", "user.email", "test@example.com")
	runCmd(t, dir, "git", "config", "user.name", "Test")

	writeRepoFile(t, dir, "go.mod", "module example.com/sample\n\ngo 1.26.0\n")
	// Bug: returns a - b when b < 0 (abs bug).
	writeRepoFile(t, dir, "calc/calc.go", `package calc

func Add(a, b int) int {
	if b < 0 {
		return a - b
	}
	return a + b
}
`)
	writeRepoFile(t, dir, "calc/calc_test.go", `package calc

import "testing"

func TestAddPositive(t *testing.T) {
	if Add(1, 2) != 3 {
		t.Fatal("bad")
	}
}
`)
	gitCommitAll(t, dir, "initial")
	return dir
}

func writeRepoFile(t *testing.T, repo, rel, content string) {
	t.Helper()
	full := filepath.Join(repo, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func gitCommitAll(t *testing.T, repo, msg string) string {
	t.Helper()
	runCmd(t, repo, "git", "add", "-A")
	runCmd(t, repo, "git", "commit", "-m", msg)
	return gitHead(t, repo)
}

func gitHead(t *testing.T, repo string) string {
	t.Helper()
	out := runCmd(t, repo, "git", "rev-parse", "HEAD")
	return strings.TrimSpace(out)
}

func runCmd(t *testing.T, dir, name string, args ...string) string {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v failed: %v\n%s", name, args, err, string(out))
	}
	return string(out)
}

func assertContainsViolation(t *testing.T, violations []string, needle string) {
	t.Helper()
	for _, v := range violations {
		if strings.Contains(v, needle) {
			return
		}
	}
	t.Fatalf("expected violation containing %q, got: %v", needle, violations)
}
