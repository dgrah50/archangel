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

// DeclInfo describes any top-level Go declaration (func, type, var, const) in a test file.
type DeclInfo struct {
	Kind       string // func | type | var | const
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

// ParseTestFile extracts top-level Test* functions and all top-level declarations
// (so shared helpers, vars, consts, and types in existing *_test.go files cannot be mutated).
func ParseTestFile(relPath string, src []byte) ([]TestFuncInfo, []DeclInfo, []string) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, relPath, src, parser.ParseComments)
	if err != nil {
		return nil, nil, []string{fmt.Sprintf("parse error in %s: %v", relPath, err)}
	}

	var funcs []TestFuncInfo
	var decls []DeclInfo
	pkgDir := filepath.ToSlash(filepath.Dir(relPath))

	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			var buf bytes.Buffer
			_ = format.Node(&buf, fset, d)
			norm := buf.String()
			name := d.Name.Name
			if d.Recv != nil {
				var recvBuf bytes.Buffer
				_ = format.Node(&recvBuf, fset, d.Recv)
				name = recvBuf.String() + "." + name
			}
			decls = append(decls, DeclInfo{
				Kind:       "func",
				Name:       name,
				File:       relPath,
				PkgDir:     pkgDir,
				Normalized: norm,
			})
			if d.Recv == nil && strings.HasPrefix(d.Name.Name, "Test") && d.Name.Name != "TestMain" {
				funcs = append(funcs, TestFuncInfo{
					Name:       d.Name.Name,
					File:       relPath,
					PkgDir:     pkgDir,
					Normalized: norm,
				})
			}
		case *ast.GenDecl:
			if d.Tok == token.IMPORT {
				continue
			}
			for _, spec := range d.Specs {
				var buf bytes.Buffer
				_ = format.Node(&buf, fset, spec)
				norm := buf.String()
				switch sp := spec.(type) {
				case *ast.TypeSpec:
					decls = append(decls, DeclInfo{
						Kind:       "type",
						Name:       sp.Name.Name,
						File:       relPath,
						PkgDir:     pkgDir,
						Normalized: norm,
					})
				case *ast.ValueSpec:
					kind := "var"
					if d.Tok == token.CONST {
						kind = "const"
					}
					for _, id := range sp.Names {
						decls = append(decls, DeclInfo{
							Kind:       kind,
							Name:       id.Name,
							File:       relPath,
							PkgDir:     pkgDir,
							Normalized: norm,
						})
					}
				}
			}
		}
	}
	return funcs, decls, nil
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

// VerifyTestDelta enforces full immutability of base test declarations (Test* functions AND
// shared helpers/types/vars/consts in base *_test.go files) and validates all newly added tests.
func VerifyTestDelta(
	baseFiles map[string][]byte,
	headFiles map[string][]byte,
	basePkgs map[string]bool,
) TestDelta {
	delta := TestDelta{
		BaseTests: map[string][]string{},
		NewTests:  map[string][]string{},
	}

	baseTestByKey := map[string]TestFuncInfo{} // "pkgDir::TestName" -> info
	baseDeclByKey := map[string]DeclInfo{}     // "file::kind::name" -> info

	for path, src := range baseFiles {
		funcs, decls, errs := ParseTestFile(path, src)
		delta.Violations = append(delta.Violations, errs...)
		for _, fn := range funcs {
			key := fn.PkgDir + "::" + fn.Name
			baseTestByKey[key] = fn
			delta.BaseTests[fn.PkgDir] = append(delta.BaseTests[fn.PkgDir], fn.Name)
		}
		for _, d := range decls {
			key := d.File + "::" + d.Kind + "::" + d.Name
			baseDeclByKey[key] = d
		}
	}

	headTestByKey := map[string]TestFuncInfo{}
	headDeclByKey := map[string]DeclInfo{}
	newFuncsByFile := map[string]map[string]bool{}

	for path, src := range headFiles {
		pkgDir := filepath.ToSlash(filepath.Dir(path))
		_, existedOnBase := baseFiles[path]
		if !existedOnBase && !basePkgs[pkgDir] {
			delta.Violations = append(delta.Violations, fmt.Sprintf("new test file %s is in package %q which does not exist on base", path, pkgDir))
		}

		funcs, decls, errs := ParseTestFile(path, src)
		delta.Violations = append(delta.Violations, errs...)

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

		for _, d := range decls {
			key := d.File + "::" + d.Kind + "::" + d.Name
			headDeclByKey[key] = d
			if existedOnBase && d.Kind == "func" {
				if _, existed := baseDeclByKey[key]; !existed {
					if newFuncsByFile[path] == nil {
						newFuncsByFile[path] = map[string]bool{}
					}
					newFuncsByFile[path][d.Name] = true
				}
			}
		}

		for _, fn := range funcs {
			key := fn.PkgDir + "::" + fn.Name
			headTestByKey[key] = fn
			if _, ok := baseTestByKey[key]; !ok {
				delta.NewTests[fn.PkgDir] = append(delta.NewTests[fn.PkgDir], fn.Name)
			}
		}
	}

	// Inspect newly added functions inside pre-existing test files.
	for path, fnNames := range newFuncsByFile {
		delta.Violations = append(delta.Violations, InspectAddedTestSource(path, headFiles[path], fnNames)...)
	}

	// Enforce existing-test immutability (Test* functions).
	for key, baseFn := range baseTestByKey {
		headFn, ok := headTestByKey[key]
		if !ok {
			delta.Violations = append(delta.Violations, fmt.Sprintf("existing test deleted or renamed: %s (%s)", baseFn.Name, baseFn.File))
			continue
		}
		if headFn.Normalized != baseFn.Normalized {
			delta.Violations = append(delta.Violations, fmt.Sprintf("existing test modified: %s (%s)", baseFn.Name, baseFn.File))
		}
	}

	// Enforce immutability of ALL shared helpers, types, vars, and consts in existing *_test.go files
	// (prevents bypassing test immutability by weakening shared test helper functions — Codex #9).
	for key, baseDecl := range baseDeclByKey {
		if baseDecl.Kind == "func" && strings.HasPrefix(baseDecl.Name, "Test") && baseDecl.Name != "TestMain" {
			continue // Already checked with specific message above.
		}
		headDecl, ok := headDeclByKey[key]
		if !ok {
			delta.Violations = append(delta.Violations, fmt.Sprintf("existing test helper/declaration deleted: %s %s (%s)", baseDecl.Kind, baseDecl.Name, baseDecl.File))
			continue
		}
		if headDecl.Normalized != baseDecl.Normalized {
			delta.Violations = append(delta.Violations, fmt.Sprintf("existing test helper/declaration modified: %s %s (%s)", baseDecl.Kind, baseDecl.Name, baseDecl.File))
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
