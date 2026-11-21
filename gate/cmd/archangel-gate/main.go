package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/dayangraham/archangel/gate/internal/gate"
)

func main() {
	policy := gate.DefaultPolicy()

	repoDir := flag.String("repo", ".", "Path to git repository")
	baseRef := flag.String("base", "origin/main", "Base git ref (typically main tip)")
	headRef := flag.String("head", "HEAD", "Head git ref (PR head or merge ref)")
	revertOf := flag.String("revert-of", "", "Optional recorded factory squash-merge SHA for exact-inverse revert exemption")
	maxNonTest := flag.Int("max-non-test-lines", policy.MaxNonTestLines, "Maximum changed lines outside tests/testdata")
	maxTotal := flag.Int("max-total-lines", policy.MaxTotalLines, "Maximum total changed lines")
	maxFiles := flag.Int("max-files", policy.MaxFiles, "Maximum changed files")
	baseRuns := flag.Int("base-runs", policy.BaseRuns, "Uncached repro runs on base")
	headNewRuns := flag.Int("head-new-runs", policy.HeadNewRuns, "Race-enabled runs of new tests on head")
	headFullRuns := flag.Int("head-full-runs", policy.HeadFullRuns, "Uncached race-enabled full suite runs on head")
	skipFull := flag.Bool("skip-full-suite", false, "Skip full suite runs (for fast broker pre-push validation)")
	flag.Parse()

	policy.MaxNonTestLines = *maxNonTest
	policy.MaxTotalLines = *maxTotal
	policy.MaxFiles = *maxFiles
	policy.BaseRuns = *baseRuns
	policy.HeadNewRuns = *headNewRuns
	policy.HeadFullRuns = *headFullRuns
	policy.SkipFullSuite = *skipFull

	report, err := gate.Run(gate.Options{
		RepoDir:  *repoDir,
		BaseRef:  *baseRef,
		HeadRef:  *headRef,
		RevertOf: *revertOf,
		Policy:   policy,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "archangel-gate error: %v\n", err)
		os.Exit(2)
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(report)

	if !report.Passed {
		os.Exit(1)
	}
}
