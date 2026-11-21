package gate

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Options configures a Gate evaluation run.
type Options struct {
	RepoDir        string
	BaseRef        string
	HeadRef        string
	RevertOf       string // Optional recorded factory squash-merge SHA for exact-inverse exemption
	PolicyFromBase bool   // Read optional .agents/landing.json strictly from baseSHA (tightening only)
	Policy         Policy
}

type baseLandingJSON struct {
	MaxNonTestLines     *int     `json:"maxNonTestLines"`
	MaxTotalLines       *int     `json:"maxTotalLines"`
	MaxFiles            *int     `json:"maxFiles"`
	ExtraProtectedPaths []string `json:"extraProtectedPaths"`
}

// Report is the structured JSON verdict produced by archangel-gate.
type Report struct {
	Passed        bool       `json:"passed"`
	BaseSHA       string     `json:"base_sha"`
	HeadSHA       string     `json:"head_sha"`
	RevertExempt  bool       `json:"revert_exempt"`
	AlreadyFixed  bool       `json:"already_fixed"`
	ReproTests    []string   `json:"repro_tests"`
	Violations    []string   `json:"violations"`
	FileStats     []FileStat `json:"file_stats"`
}

// GoTestEvent matches `go test -json` output lines.
type GoTestEvent struct {
	Action  string `json:"Action"`
	Package string `json:"Package"`
	Test    string `json:"Test"`
	Output  string `json:"Output"`
}

// TestRunSummary captures parsed results from one `go test -json` invocation.
type TestRunSummary struct {
	BuildFailed bool
	Passed      map[string]int // "pkg::TestName" -> pass count
	Failed      map[string]int // "pkg::TestName" -> fail count
	Skipped     map[string]int // "pkg::TestName" -> skip count
	PkgFailed   map[string]bool
	RawOutput   string
}

// ParseGoTestJSON parses newline-delimited `go test -json` output, attributing panics/timeouts
// to the active test if the package crashes mid-test.
func ParseGoTestJSON(data []byte) TestRunSummary {
	summary := TestRunSummary{
		Passed:    map[string]int{},
		Failed:    map[string]int{},
		Skipped:   map[string]int{},
		PkgFailed: map[string]bool{},
		RawOutput: string(data),
	}

	running := map[string]map[string]bool{} // pkg -> set of active top-level tests
	scanner := bufio.NewScanner(bytes.NewReader(data))
	buf := make([]byte, 0, 1024*1024)
	scanner.Buffer(buf, 16*1024*1024)

	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var ev GoTestEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			continue
		}
		if ev.Action == "build-fail" || (ev.Action == "build-output" && strings.Contains(ev.Output, "build failed")) {
			summary.BuildFailed = true
		}
		if ev.Test == "" && ev.Action == "output" {
			if strings.Contains(ev.Output, "[build failed]") || strings.Contains(ev.Output, "[setup failed]") {
				summary.BuildFailed = true
			}
		}
		if ev.Test != "" {
			// Track top-level test name (strip subtest suffix for attribution).
			topTest := strings.SplitN(ev.Test, "/", 2)[0]
			key := ev.Package + "::" + topTest
			switch ev.Action {
			case "run":
				if !strings.Contains(ev.Test, "/") {
					if running[ev.Package] == nil {
						running[ev.Package] = map[string]bool{}
					}
					running[ev.Package][topTest] = true
				}
			case "pass":
				if !strings.Contains(ev.Test, "/") {
					summary.Passed[key]++
					delete(running[ev.Package], topTest)
				}
			case "fail":
				if !strings.Contains(ev.Test, "/") {
					summary.Failed[key]++
					delete(running[ev.Package], topTest)
				}
			case "skip":
				if !strings.Contains(ev.Test, "/") {
					summary.Skipped[key]++
					delete(running[ev.Package], topTest)
				}
			}
		} else if ev.Action == "fail" && ev.Package != "" {
			summary.PkgFailed[ev.Package] = true
			// Attribute crash/panic/timeout to any top-level test still running in that package.
			for tName := range running[ev.Package] {
				summary.Failed[ev.Package+"::"+tName]++
			}
		}
	}
	return summary
}

// Run executes the full mechanical Gate against a git repository.
func Run(opts Options) (*Report, error) {
	if opts.Policy.MaxFiles == 0 {
		opts.Policy = DefaultPolicy()
	}
	baseSHA, err := gitOutput(opts.RepoDir, "rev-parse", opts.BaseRef)
	if err != nil {
		return nil, fmt.Errorf("resolve base %q: %w", opts.BaseRef, err)
	}
	headSHA, err := gitOutput(opts.RepoDir, "rev-parse", opts.HeadRef)
	if err != nil {
		return nil, fmt.Errorf("resolve head %q: %w", opts.HeadRef, err)
	}

	report := &Report{
		BaseSHA: baseSHA,
		HeadSHA: headSHA,
	}

	// Optionally merge .agents/landing.json strictly from baseSHA (may ONLY tighten bounds / add protected paths).
	if opts.PolicyFromBase {
		if raw, err := gitShowBytes(opts.RepoDir, baseSHA, ".agents/landing.json"); err == nil && len(bytes.TrimSpace(raw)) > 0 {
			var lj baseLandingJSON
			if err := json.Unmarshal(raw, &lj); err != nil {
				report.Violations = append(report.Violations, fmt.Sprintf("invalid .agents/landing.json on base: %v", err))
				return report, nil
			}
			if lj.MaxNonTestLines != nil && *lj.MaxNonTestLines > 0 && *lj.MaxNonTestLines < opts.Policy.MaxNonTestLines {
				opts.Policy.MaxNonTestLines = *lj.MaxNonTestLines
			}
			if lj.MaxTotalLines != nil && *lj.MaxTotalLines > 0 && *lj.MaxTotalLines < opts.Policy.MaxTotalLines {
				opts.Policy.MaxTotalLines = *lj.MaxTotalLines
			}
			if lj.MaxFiles != nil && *lj.MaxFiles > 0 && *lj.MaxFiles < opts.Policy.MaxFiles {
				opts.Policy.MaxFiles = *lj.MaxFiles
			}
			opts.Policy.ExtraProtectedPaths = append(opts.Policy.ExtraProtectedPaths, lj.ExtraProtectedPaths...)
		}
	}

	stats, err := gitDiffStats(opts.RepoDir, baseSHA, headSHA)
	if err != nil {
		return nil, err
	}
	report.FileStats = stats

	// Check protected paths always (even for reverts).
	for _, st := range stats {
		if IsProtectedPathWithExtras(st.Path, opts.Policy.ExtraProtectedPaths) {
			report.Violations = append(report.Violations, fmt.Sprintf("protected path modified: %s", st.Path))
		}
	}

	// Exact-inverse revert exemption (B8) — require RevertOf to be an ancestor of BaseSHA.
	if opts.RevertOf != "" {
		if !isAncestor(opts.RepoDir, opts.RevertOf, baseSHA) {
			report.Violations = append(report.Violations, fmt.Sprintf("revert target %s is not an ancestor of base %s", opts.RevertOf, baseSHA))
			report.Violations = dedupeSorted(report.Violations)
			return report, nil
		}
		ok, err := isExactInverseDiff(opts.RepoDir, baseSHA, headSHA, opts.RevertOf)
		if err != nil {
			report.Violations = append(report.Violations, fmt.Sprintf("revert check failed: %v", err))
		} else if !ok {
			report.Violations = append(report.Violations, fmt.Sprintf("PR diff is not the exact inverse of recorded factory commit %s", opts.RevertOf))
		} else {
			report.RevertExempt = true
			if len(report.Violations) == 0 {
				if err := runHeadFullSuiteOnly(opts, headSHA, nil, report); err != nil {
					return report, err
				}
			}
			report.Passed = len(report.Violations) == 0
			return report, nil
		}
	}

	// Standard diff policy & //go:generate ban.
	report.Violations = append(report.Violations, CheckDiffPolicy(stats, opts.Policy)...)
	unifiedDiff, err := gitOutputRaw(opts.RepoDir, "diff", "--no-color", "-U0", baseSHA, headSHA)
	if err != nil {
		return nil, err
	}
	report.Violations = append(report.Violations, CheckGoGenerateAdditions(unifiedDiff)...)

	// Load all *_test.go files from base and head plus base package directories.
	baseTestFiles, basePkgs, err := loadGoTree(opts.RepoDir, baseSHA)
	if err != nil {
		return nil, err
	}
	headTestFiles, _, err := loadGoTree(opts.RepoDir, headSHA)
	if err != nil {
		return nil, err
	}

	delta := VerifyTestDelta(baseTestFiles, headTestFiles, basePkgs)
	report.Violations = append(report.Violations, delta.Violations...)
	if len(report.Violations) > 0 {
		report.Violations = dedupeSorted(report.Violations)
		return report, nil
	}

	// Determine affected packages (packages with new tests).
	affectedPkgs := make([]string, 0, len(delta.NewTests))
	for pkg := range delta.NewTests {
		affectedPkgs = append(affectedPkgs, pkg)
	}
	sort.Strings(affectedPkgs)

	// 1) Red-on-base: export base, overlay all new/changed *_test.go & testdata/** from head.
	baseDir, err := os.MkdirTemp("", "archangel-gate-base-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(baseDir)

	if err := exportTree(opts.RepoDir, baseSHA, baseDir); err != nil {
		return nil, fmt.Errorf("export base: %w", err)
	}
	for _, st := range stats {
		if !IsTestOrFixturePath(st.Path) {
			continue
		}
		target := filepath.Join(baseDir, filepath.FromSlash(st.Path))
		if st.Status == "D" {
			_ = os.Remove(target)
			continue
		}
		blob, err := gitShowBytes(opts.RepoDir, headSHA, st.Path)
		if err != nil {
			return nil, fmt.Errorf("overlay %s: %w", st.Path, err)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(target, blob, 0o644); err != nil {
			return nil, err
		}
	}

	modPath, err := readModulePath(baseDir)
	if err != nil {
		return nil, err
	}

	baseFailCounts := map[string]int{} // "pkgDir::TestName" -> runs failed
	basePassCounts := map[string]int{}
	for runIdx := 0; runIdx < opts.Policy.BaseRuns; runIdx++ {
		for _, pkgDir := range affectedPkgs {
			testNames := delta.NewTests[pkgDir]
			pattern := exactTestRegex(testNames)
			pkgArg := toGoPkgArg(pkgDir)
			out, _ := runGoTest(baseDir, "-json", "-vet=off", "-count=1", "-timeout=60s", "-run", pattern, pkgArg)
			summary := ParseGoTestJSON(out)
			if summary.BuildFailed {
				report.Violations = append(report.Violations, fmt.Sprintf("base build failed for package %s when overlaying new tests (repro must use existing base API)", pkgDir))
				report.Violations = dedupeSorted(report.Violations)
				return report, nil
			}
			fullPkg := joinModulePkg(modPath, pkgDir)
			for _, tName := range testNames {
				k := fullPkg + "::" + tName
				if summary.Failed[k] > 0 {
					baseFailCounts[pkgDir+"::"+tName]++
				} else if summary.Passed[k] > 0 {
					basePassCounts[pkgDir+"::"+tName]++
				}
			}
		}
	}

	for _, pkgDir := range affectedPkgs {
		for _, tName := range delta.NewTests[pkgDir] {
			key := pkgDir + "::" + tName
			if baseFailCounts[key] == opts.Policy.BaseRuns {
				report.ReproTests = append(report.ReproTests, key)
			}
		}
	}
	sort.Strings(report.ReproTests)

	if len(report.ReproTests) == 0 {
		allPassed := true
		for _, pkgDir := range affectedPkgs {
			for _, tName := range delta.NewTests[pkgDir] {
				if basePassCounts[pkgDir+"::"+tName] != opts.Policy.BaseRuns {
					allPassed = false
				}
			}
		}
		if allPassed {
			report.AlreadyFixed = true
			report.Violations = append(report.Violations, "already-fixed: all new tests already pass on base")
		} else {
			report.Violations = append(report.Violations, fmt.Sprintf("no new test failed %d/%d runs on base", opts.Policy.BaseRuns, opts.Policy.BaseRuns))
		}
		report.Violations = dedupeSorted(report.Violations)
		return report, nil
	}

	// 2) Green-on-head: new tests pass 3/3 with -race, plus full suite 2x with every base test passing.
	headDir, err := os.MkdirTemp("", "archangel-gate-head-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(headDir)
	if err := exportTree(opts.RepoDir, headSHA, headDir); err != nil {
		return nil, fmt.Errorf("export head: %w", err)
	}

	for _, pkgDir := range affectedPkgs {
		testNames := delta.NewTests[pkgDir]
		pattern := exactTestRegex(testNames)
		pkgArg := toGoPkgArg(pkgDir)
		out, err := runGoTest(headDir, "-race", "-json", fmt.Sprintf("-count=%d", opts.Policy.HeadNewRuns), "-timeout=120s", "-run", pattern, pkgArg)
		summary := ParseGoTestJSON(out)
		if err != nil || summary.BuildFailed {
			report.Violations = append(report.Violations, fmt.Sprintf("new tests failed on head in package %s", pkgDir))
		}
		fullPkg := joinModulePkg(modPath, pkgDir)
		for _, tName := range testNames {
			k := fullPkg + "::" + tName
			if summary.Passed[k] != opts.Policy.HeadNewRuns || summary.Failed[k] > 0 || summary.Skipped[k] > 0 {
				report.Violations = append(report.Violations, fmt.Sprintf("new test %s did not pass %d/%d on head (passed=%d failed=%d skipped=%d)", tName, opts.Policy.HeadNewRuns, opts.Policy.HeadNewRuns, summary.Passed[k], summary.Failed[k], summary.Skipped[k]))
			}
		}
	}

	if !opts.Policy.SkipFullSuite && len(report.Violations) == 0 {
		if err := runHeadFullSuiteOnly(opts, headSHA, delta.BaseTests, report); err != nil {
			return report, err
		}
	}

	report.Violations = dedupeSorted(report.Violations)
	report.Passed = len(report.Violations) == 0
	return report, nil
}

func runHeadFullSuiteOnly(opts Options, headSHA string, baseTests map[string][]string, report *Report) error {
	headDir, err := os.MkdirTemp("", "archangel-gate-full-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(headDir)
	if err := exportTree(opts.RepoDir, headSHA, headDir); err != nil {
		return err
	}
	modPath, err := readModulePath(headDir)
	if err != nil {
		return err
	}
	for i := 0; i < opts.Policy.HeadFullRuns; i++ {
		out, err := runGoTest(headDir, "-race", "-json", "-count=1", "-timeout=180s", "./...")
		summary := ParseGoTestJSON(out)
		if err != nil || summary.BuildFailed {
			report.Violations = append(report.Violations, fmt.Sprintf("full suite run %d/%d failed on head", i+1, opts.Policy.HeadFullRuns))
			return nil
		}
		for pkgDir, names := range baseTests {
			fullPkg := joinModulePkg(modPath, pkgDir)
			for _, name := range names {
				k := fullPkg + "::" + name
				if summary.Passed[k] < 1 {
					report.Violations = append(report.Violations, fmt.Sprintf("base test %s (%s) did not report pass in full suite run %d", name, pkgDir, i+1))
				}
			}
		}
	}
	return nil
}

func isAncestor(repoDir, maybeAncestor, descendant string) bool {
	cmd := exec.Command("git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "merge-base", "--is-ancestor", maybeAncestor, descendant)
	cmd.Dir = repoDir
	return cmd.Run() == nil
}

func isExactInverseDiff(repoDir, baseSHA, headSHA, squashSHA string) (bool, error) {
	prDiff, err := gitOutputRaw(repoDir, "diff", "--no-color", "--binary", baseSHA, headSHA)
	if err != nil {
		return false, err
	}
	inverseDiff, err := gitOutputRaw(repoDir, "diff", "--no-color", "--binary", squashSHA, squashSHA+"^1")
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(prDiff) == "" {
		return false, errors.New("empty PR diff")
	}
	return prDiff == inverseDiff, nil
}

func gitDiffStats(repoDir, baseSHA, headSHA string) ([]FileStat, error) {
	// Use -z (NUL-delimited) so paths with spaces, quotes, or newlines never break parsing.
	nameStatusOut, err := gitOutputRaw(repoDir, "diff", "--name-status", "--no-renames", "-z", baseSHA, headSHA)
	if err != nil {
		return nil, err
	}
	statusByPath := map[string]string{}
	nsTokens := strings.Split(nameStatusOut, "\x00")
	for i := 0; i+1 < len(nsTokens); i += 2 {
		stCode := nsTokens[i]
		p := nsTokens[i+1]
		if stCode != "" && p != "" {
			statusByPath[p] = stCode
		}
	}

	numstatOut, err := gitOutputRaw(repoDir, "diff", "--numstat", "--no-renames", "-z", baseSHA, headSHA)
	if err != nil {
		return nil, err
	}
	var stats []FileStat
	for _, entry := range strings.Split(numstatOut, "\x00") {
		if entry == "" {
			continue
		}
		parts := strings.SplitN(entry, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		st := FileStat{
			Path:   parts[2],
			Status: statusByPath[parts[2]],
		}
		if parts[0] == "-" || parts[1] == "-" {
			st.Binary = true
		} else {
			st.Added, _ = strconv.Atoi(parts[0])
			st.Deleted, _ = strconv.Atoi(parts[1])
		}
		stats = append(stats, st)
	}
	return stats, nil
}

func loadGoTree(repoDir, sha string) (map[string][]byte, map[string]bool, error) {
	out, err := gitOutputRaw(repoDir, "ls-tree", "-r", "--name-only", sha)
	if err != nil {
		return nil, nil, err
	}
	testFiles := map[string][]byte{}
	pkgs := map[string]bool{}
	for _, rel := range strings.Split(strings.TrimSpace(out), "\n") {
		if rel == "" || !strings.HasSuffix(rel, ".go") {
			continue
		}
		pkgDir := filepath.ToSlash(filepath.Dir(rel))
		pkgs[pkgDir] = true
		if strings.HasSuffix(rel, "_test.go") {
			blob, err := gitShowBytes(repoDir, sha, rel)
			if err != nil {
				return nil, nil, err
			}
			testFiles[rel] = blob
		}
	}
	return testFiles, pkgs, nil
}

func exportTree(repoDir, sha, destDir string) error {
	archive := exec.Command("git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "archive", sha)
	archive.Dir = repoDir
	tar := exec.Command("tar", "-x", "-C", destDir)
	pipe, err := archive.StdoutPipe()
	if err != nil {
		return err
	}
	tar.Stdin = pipe
	var tarErr bytes.Buffer
	tar.Stderr = &tarErr
	if err := archive.Start(); err != nil {
		return err
	}
	if err := tar.Start(); err != nil {
		return err
	}
	if err := archive.Wait(); err != nil {
		return fmt.Errorf("git archive: %w", err)
	}
	if err := tar.Wait(); err != nil {
		return fmt.Errorf("tar extract: %w (%s)", err, tarErr.String())
	}
	return nil
}

func runGoTest(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("go", append([]string{"test"}, args...)...)
	cmd.Dir = dir
	cmd.Env = append(scrubbedGoEnv(), "GOFLAGS=-count=1", "GOTOOLCHAIN=local")
	return cmd.CombinedOutput()
}

func scrubbedGoEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "GH_TOKEN=") || strings.HasPrefix(kv, "GITHUB_TOKEN=") || strings.HasPrefix(kv, "SSH_AUTH_SOCK=") {
			continue
		}
		env = append(env, kv)
	}
	return env
}

func readModulePath(dir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(dir, "go.mod"))
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(b), "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "module ") {
			return strings.TrimSpace(strings.TrimPrefix(t, "module ")), nil
		}
	}
	return "", errors.New("module directive not found in go.mod")
}

func joinModulePkg(modPath, pkgDir string) string {
	if pkgDir == "." || pkgDir == "" {
		return modPath
	}
	return modPath + "/" + strings.TrimPrefix(pkgDir, "./")
}

func toGoPkgArg(pkgDir string) string {
	if pkgDir == "." || pkgDir == "" {
		return "."
	}
	return "./" + strings.TrimPrefix(pkgDir, "./")
}

func exactTestRegex(names []string) string {
	escaped := make([]string, len(names))
	for i, n := range names {
		escaped[i] = regexp.QuoteMeta(n)
	}
	return "^(" + strings.Join(escaped, "|") + ")$"
}

func gitOutput(repoDir string, args ...string) (string, error) {
	raw, err := gitOutputRaw(repoDir, args...)
	return strings.TrimSpace(raw), err
}

func gitOutputRaw(repoDir string, args ...string) (string, error) {
	fullArgs := append([]string{"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"}, args...)
	cmd := exec.Command("git", fullArgs...)
	cmd.Dir = repoDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w (%s)", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func gitShowBytes(repoDir, sha, relPath string) ([]byte, error) {
	cmd := exec.Command("git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "show", sha+":"+relPath)
	cmd.Dir = repoDir
	return cmd.Output()
}

func dedupeSorted(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}
