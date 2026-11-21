package gate

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"path/filepath"
	"sort"
	"strings"
)

func formatf(f string, args ...any) string {
	return fmt.Sprintf(f, args...)
}

// TestFuncInfo describes a parsed top-level Go test function.
type TestFuncInfo struct {
	Name       string
	File       string
	PkgDir     string
	Normalized string
}

// TestDelta summarizes AST-verified test changes between base and head.
type TestDelta struct {
	BaseTests  map[string][]string // pkgDir -> sorted Test* names on base
	NewTests   map[string][]string // pkgDir -> sorted new Test* names on head
	Violations []string
}

// ParseTestFile extracts top-level Test* functions and checks for banned constructs.
func ParseTestFile(relPath string, src []byte) ([]TestFuncInfo, []string) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, relPath, src, parser.ParseComments)
	if err != nil {
		return nil, []string{fmt.Sprintf("parse error in %s: %v", relPath, err)}
	}

	var funcs []TestFuncInfo
	pkgDir := filepath.ToSlash(filepath.Dir(relPath))
	if pkgDir == "." {
		pkgDir = "."
	}

	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Recv != nil {
			continue
		}
		name := fn.Name.Name
		if strings.HasPrefix(name, "Test") && name != "TestMain" {
			var buf bytes.Buffer
			_ = format.Node(&buf, fset, fn)
			funcs = append(funcs, TestFuncInfo{
				Name:       name,
				File:       relPath,
				PkgDir:     pkgDir,
				Normalized: buf.String(),
			})
		}
	}
	return funcs, nil
}

// InspectAddedTestSource enforces AST bans on newly added test files or test functions.
func InspectAddedTestSource(relPath string, src []byte, onlyFuncNames map[string]bool) []string {
	var violations []string

	// Check file-level build tags and //go:generate on brand-new files.
	if onlyFuncNames == nil {
		for _, line := range strings.Split(string(src), "\n") {
			t := strings.TrimSpace(line)
			if strings.HasPrefix(t, "//go:build") || strings.HasPrefix(t, "// +build") {
				violations = append(violations, fmt.Sprintf("banned build constraint in new test file %s", relPath))
			}
			if strings.HasPrefix(t, "//go:generate") {
				violations = append(violations, fmt.Sprintf("banned //go:generate in new test file %s", relPath))
			}
		}
	}

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, relPath, src, parser.ParseComments)
	if err != nil {
		return append(violations, fmt.Sprintf("parse error in %s: %v", relPath, err))
	}

	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Recv != nil {
			continue
		}
		name := fn.Name.Name
		if onlyFuncNames == nil {
			if name == "TestMain" {
				violations = append(violations, fmt.Sprintf("banned TestMain in new test file %s", relPath))
			}
			if name == "init" {
				violations = append(violations, fmt.Sprintf("banned init() in new test file %s", relPath))
			}
		} else if !onlyFuncNames[name] {
			continue
		}

		// Inspect body for banned t.Skip / t.Skipf / t.SkipNow calls.
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			switch sel.Sel.Name {
			case "Skip", "Skipf", "SkipNow":
				violations = append(violations, fmt.Sprintf("banned %s() call in %s (%s)", sel.Sel.Name, name, relPath))
			}
			return true
		})
	}
	return violations
}

// VerifyTestDelta checks immutability of base tests and validates all newly added tests.
// basePkgs is the set of package directories (relative slash paths, "." for root) existing on base.
func VerifyTestDelta(
	baseFiles map[string][]byte,
	headFiles map[string][]byte,
	basePkgs map[string]bool,
) TestDelta {
	delta := TestDelta{
		BaseTests: map[string][]string{},
		NewTests:  map[string][]string{},
	}

	baseByKey := map[string]TestFuncInfo{} // "pkgDir::TestName" -> info
	for path, src := range baseFiles {
		funcs, errs := ParseTestFile(path, src)
		delta.Violations = append(delta.Violations, errs...)
		for _, fn := range funcs {
			key := fn.PkgDir + "::" + fn.Name
			baseByKey[key] = fn
			delta.BaseTests[fn.PkgDir] = append(delta.BaseTests[fn.PkgDir], fn.Name)
		}
	}

	headByKey := map[string]TestFuncInfo{}
	newFuncsByFile := map[string]map[string]bool{}
	for path, src := range headFiles {
		pkgDir := filepath.ToSlash(filepath.Dir(path))
		_, existedOnBase := baseFiles[path]
		if !existedOnBase && !basePkgs[pkgDir] {
			delta.Violations = append(delta.Violations, fmt.Sprintf("new test file %s is in package %q which does not exist on base", path, pkgDir))
		}

		funcs, errs := ParseTestFile(path, src)
		delta.Violations = append(delta.Violations, errs...)

		// Also check if an existing test file added TestMain, init(), or build tags.
		if existedOnBase {
			baseHad := extractSpecialDecls(baseFiles[path])
			headHas := extractSpecialDecls(src)
			if headHas.hasTestMain && !baseHad.hasTestMain {
				delta.Violations = append(delta.Violations, fmt.Sprintf("banned TestMain added to existing file %s", path))
			}
			if headHas.initCount > baseHad.initCount {
				delta.Violations = append(delta.Violations, fmt.Sprintf("banned init() added to existing file %s", path))
			}
			if headHas.hasBuildTag && !baseHad.hasBuildTag {
				delta.Violations = append(delta.Violations, fmt.Sprintf("banned build constraint added to existing file %s", path))
			}
		} else {
			delta.Violations = append(delta.Violations, InspectAddedTestSource(path, src, nil)...)
		}

		for _, fn := range funcs {
			key := fn.PkgDir + "::" + fn.Name
			headByKey[key] = fn
			if _, ok := baseByKey[key]; !ok {
				delta.NewTests[fn.PkgDir] = append(delta.NewTests[fn.PkgDir], fn.Name)
				if existedOnBase {
					if newFuncsByFile[path] == nil {
						newFuncsByFile[path] = map[string]bool{}
					}
					newFuncsByFile[path][fn.Name] = true
				}
			}
		}
	}

	// Inspect newly added Test* functions inside pre-existing test files.
	for path, fnNames := range newFuncsByFile {
		delta.Violations = append(delta.Violations, InspectAddedTestSource(path, headFiles[path], fnNames)...)
	}

	// Enforce existing-test immutability: every base Test* must remain identical on head.
	for key, baseFn := range baseByKey {
		headFn, ok := headByKey[key]
		if !ok {
			delta.Violations = append(delta.Violations, fmt.Sprintf("existing test deleted or renamed: %s (%s)", baseFn.Name, baseFn.File))
			continue
		}
		if headFn.Normalized != baseFn.Normalized {
			delta.Violations = append(delta.Violations, fmt.Sprintf("existing test modified: %s (%s)", baseFn.Name, baseFn.File))
		}
	}

	for pkg := range delta.BaseTests {
		sort.Strings(delta.BaseTests[pkg])
	}
	totalNew := 0
	for pkg := range delta.NewTests {
		sort.Strings(delta.NewTests[pkg])
		totalNew += len(delta.NewTests[pkg])
	}
	if totalNew == 0 {
		delta.Violations = append(delta.Violations, "PR adds no new Test* function")
	}

	sort.Strings(delta.Violations)
	return delta
}

type specialDecls struct {
	hasTestMain bool
	initCount   int
	hasBuildTag bool
}

func extractSpecialDecls(src []byte) specialDecls {
	var out specialDecls
	for _, line := range strings.Split(string(src), "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "//go:build") || strings.HasPrefix(t, "// +build") {
			out.hasBuildTag = true
		}
	}
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "", src, 0)
	if err != nil {
		return out
	}
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Recv != nil {
			continue
		}
		if fn.Name.Name == "TestMain" {
			out.hasTestMain = true
		}
		if fn.Name.Name == "init" {
			out.initCount++
		}
	}
	return out
}
