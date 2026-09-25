// Package policy decides whether a role may read or write a path.
//
// The rules are documented in contract/README.md; this file is the implementation
// of that document. If the two disagree, the document is right and this is a bug.
package policy

import (
	"fmt"
	"path"
	"sort"
	"strings"
)

type AccessLevel string

const (
	AccessNone  AccessLevel = "none"
	AccessRead  AccessLevel = "read"
	AccessWrite AccessLevel = "write"
)

func (a AccessLevel) Valid() bool {
	switch a {
	case AccessNone, AccessRead, AccessWrite:
		return true
	}
	return false
}

// restrictiveness orders levels for tie-breaking: higher wins a tie, so an
// ambiguous rule set fails closed.
func (a AccessLevel) restrictiveness() int {
	switch a {
	case AccessNone:
		return 2
	case AccessRead:
		return 1
	case AccessWrite:
		return 0
	}
	return 2
}

type Intent string

const (
	IntentRead  Intent = "read"
	IntentWrite Intent = "write"
)

func (i Intent) Valid() bool { return i == IntentRead || i == IntentWrite }

// satisfiedBy reports whether a granted level is enough for this intent.
func (i Intent) satisfiedBy(a AccessLevel) bool {
	switch i {
	case IntentRead:
		return a == AccessRead || a == AccessWrite
	case IntentWrite:
		return a == AccessWrite
	}
	return false
}

type Rule struct {
	Pattern     string      `json:"pattern"`
	AccessLevel AccessLevel `json:"access_level"`
}

type Decision struct {
	Path    string
	Allowed bool
	// Rule is the rule that decided this path, or nil when nothing matched and
	// the default-deny applied.
	Rule   *Rule
	Reason string
}

// NormalizePath puts a caller-supplied path into the canonical repo-relative form
// the rest of the package assumes. It rejects anything that escapes the repo.
func NormalizePath(p string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("empty path")
	}
	if strings.ContainsRune(p, '\\') {
		return "", fmt.Errorf("path %q: use forward slashes", p)
	}
	if strings.HasPrefix(p, "/") {
		return "", fmt.Errorf("path %q: must be repo-relative, not absolute", p)
	}
	clean := path.Clean(p)
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("path %q: escapes the repository", p)
	}
	if clean == "." {
		return "", fmt.Errorf("path %q: resolves to the repository root", p)
	}
	return clean, nil
}

// Evaluate resolves one path against a role's rules.
//
// Every matching rule is scored for specificity; the highest score wins. Ties break
// on literal character count, then on restrictiveness. No match means denied.
func Evaluate(roleName string, rules []Rule, target string, intent Intent) Decision {
	type scored struct {
		rule     Rule
		segScore int
		literals int
	}

	var matches []scored
	for _, r := range rules {
		if !matchPattern(r.Pattern, target) {
			continue
		}
		matches = append(matches, scored{
			rule:     r,
			segScore: specificity(r.Pattern),
			literals: literalCount(r.Pattern),
		})
	}

	if len(matches) == 0 {
		return Decision{
			Path:    target,
			Allowed: false,
			Rule:    nil,
			Reason: fmt.Sprintf(
				"no rule in role %q covers this path, and unmatched paths are denied by default",
				roleName),
		}
	}

	sort.SliceStable(matches, func(i, j int) bool {
		a, b := matches[i], matches[j]
		if a.segScore != b.segScore {
			return a.segScore > b.segScore
		}
		if a.literals != b.literals {
			return a.literals > b.literals
		}
		return a.rule.AccessLevel.restrictiveness() > b.rule.AccessLevel.restrictiveness()
	})

	win := matches[0].rule
	if intent.satisfiedBy(win.AccessLevel) {
		return Decision{Path: target, Allowed: true, Rule: &win}
	}

	reason := fmt.Sprintf("role %q has access_level %q on this path",
		roleName, win.AccessLevel)
	if intent == IntentWrite && win.AccessLevel == AccessRead {
		reason = fmt.Sprintf("role %q has read-only access to this path", roleName)
	}
	return Decision{Path: target, Allowed: false, Rule: &win, Reason: reason}
}

// specificity scores a pattern by how narrowly it names a location.
// Literal segment = 4, wildcard-containing segment = 2, "**" = 0.
func specificity(pattern string) int {
	score := 0
	for _, seg := range strings.Split(pattern, "/") {
		switch {
		case seg == "**":
			// contributes nothing: it names no location
		case strings.ContainsAny(seg, "*?"):
			score += 2
		default:
			score += 4
		}
	}
	return score
}

func literalCount(pattern string) int {
	n := 0
	for _, c := range pattern {
		if c != '*' && c != '?' && c != '/' {
			n++
		}
	}
	return n
}
