package gate

import (
	"path/filepath"
	"strings"
)

// Policy defines the mechanical bounds enforced by the Gate.
type Policy struct {
	MaxNonTestLines     int
	MaxTotalLines       int
	MaxFiles            int
	BaseRuns            int
	HeadNewRuns         int
	HeadFullRuns        int
	SkipFullSuite       bool
	ExtraProtectedPaths []string
}

// DefaultPolicy returns the agreed Archangel v0 policy for gijq.
func DefaultPolicy() Policy {
	return Policy{
		MaxNonTestLines: 150,
		MaxTotalLines:   300,
		MaxFiles:        5,
		BaseRuns:        3,
		HeadNewRuns:     3,
		HeadFullRuns:    2,
	}
}

// FileStat holds per-file diff statistics between base and head.
type FileStat struct {
	Path      string `json:"path"`
	Added     int    `json:"added"`
	Deleted   int    `json:"deleted"`
	Binary    bool   `json:"binary"`
	Status    string `json:"status"` // A, M, D, R
}

var protectedPrefixes = []string{
	".github/",
	"scripts/",
	"vendor/",
	".agents/",
}

var protectedExact = map[string]bool{
	"go.mod":          true,
	"go.sum":          true,
	"go.work":         true,
	"go.work.sum":     true,
	"claude.md":       true,
	"agents.md":       true,
	"makefile":        true,
	"gnumakefile":     true,
	".gitattributes":  true,
	".gitmodules":     true,
	".editorconfig":   true,
	".golangci.yml":   true,
	".golangci.yaml":  true,
	".golangci.toml":  true,
	".golangci.json":  true,
	".pre-commit-config.yaml": true,
}

// IsProtectedPath returns true if a repo-relative path may never be modified by a factory PR.
func IsProtectedPath(relPath string) bool {
	return IsProtectedPathWithExtras(relPath, nil)
}

// IsProtectedPathWithExtras checks global protected paths plus per-project extra patterns.
func IsProtectedPathWithExtras(relPath string, extras []string) bool {
	p := filepath.ToSlash(strings.TrimPrefix(relPath, "./"))
	lower := strings.ToLower(p)
	base := strings.ToLower(filepath.Base(p))

	for _, prefix := range protectedPrefixes {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	if protectedExact[lower] || protectedExact[base] {
		return true
	}
	if strings.HasPrefix(base, "license") || strings.HasPrefix(base, "copying") {
		return true
	}
	if strings.HasPrefix(base, ".goreleaser") || strings.HasPrefix(base, ".golangci") {
		return true
	}
	if strings.Contains(lower, "/.git/") || lower == ".git" {
		return true
	}
	for _, raw := range extras {
		pat := strings.ToLower(filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(raw), "./")))
		if pat == "" {
			continue
		}
		if strings.HasSuffix(pat, "/**") {
			if strings.HasPrefix(lower, strings.TrimSuffix(pat, "**")) {
				return true
			}
		} else if strings.HasSuffix(pat, "/") {
			if strings.HasPrefix(lower, pat) {
				return true
			}
		} else if lower == pat {
			return true
		}
	}
	return false
}

// IsTestOrFixturePath returns true for *_test.go or testdata/** paths.
func IsTestOrFixturePath(relPath string) bool {
	p := filepath.ToSlash(strings.TrimPrefix(relPath, "./"))
	if strings.HasSuffix(p, "_test.go") {
		return true
	}
	if strings.HasPrefix(p, "testdata/") || strings.Contains(p, "/testdata/") {
		return true
	}
	return false
}

// CheckDiffPolicy validates protected paths, file count, line bounds, and binary changes.
func CheckDiffPolicy(stats []FileStat, policy Policy) []string {
	var violations []string
	if len(stats) == 0 {
		return []string{"diff is empty"}
	}
	if len(stats) > policy.MaxFiles {
		violations = append(violations, formatf("changed files %d exceeds limit %d", len(stats), policy.MaxFiles))
	}

	nonTestLines := 0
	totalLines := 0
	for _, st := range stats {
		if IsProtectedPathWithExtras(st.Path, policy.ExtraProtectedPaths) {
			violations = append(violations, formatf("protected path modified: %s", st.Path))
		}
		if st.Binary {
			violations = append(violations, formatf("binary file modified: %s", st.Path))
		}
		lines := st.Added + st.Deleted
		totalLines += lines
		if !IsTestOrFixturePath(st.Path) {
			nonTestLines += lines
		}
	}

	if nonTestLines > policy.MaxNonTestLines {
		violations = append(violations, formatf("non-test changed lines %d exceeds limit %d", nonTestLines, policy.MaxNonTestLines))
	}
	if totalLines > policy.MaxTotalLines {
		violations = append(violations, formatf("total changed lines %d exceeds limit %d", totalLines, policy.MaxTotalLines))
	}
	return violations
}

// CheckGoGenerateAdditions inspects unified diff output and rejects added //go:generate directives.
func CheckGoGenerateAdditions(unifiedDiff string) []string {
	var violations []string
	currentFile := ""
	for _, line := range strings.Split(unifiedDiff, "\n") {
		if strings.HasPrefix(line, "+++ b/") {
			currentFile = strings.TrimPrefix(line, "+++ b/")
			continue
		}
		if strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "+++") {
			trimmed := strings.TrimSpace(strings.TrimPrefix(line, "+"))
			if strings.HasPrefix(trimmed, "//go:generate") {
				violations = append(violations, formatf("banned //go:generate directive added in %s", currentFile))
			}
		}
	}
	return violations
}
