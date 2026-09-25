package policy

import "testing"

func TestMatchPattern(t *testing.T) {
	cases := []struct {
		pattern, target string
		want            bool
	}{
		// literals
		{"src/main.go", "src/main.go", true},
		{"src/main.go", "src/other.go", false},
		{"src/main.go", "src/main.go/deeper.go", false},

		// "*" stays inside one segment
		{"src/*.go", "src/main.go", true},
		{"src/*.go", "src/billing/charge.go", false},
		{"src/*", "src/main.go", true},
		{"src/*", "src/billing/charge.go", false},

		// "?" is exactly one char
		{"src/main.?o", "src/main.go", true},
		{"src/main.?", "src/main.go", false},

		// "**" spans segments
		{"**", "src/main.go", true},
		{"**", "a/b/c/d/e.go", true},
		{"infra/**", "infra/prod/db.tf", true},
		{"infra/**", "infra/db.tf", true},
		{"infra/**", "src/infra/db.tf", false},
		{"**/secrets.tf", "infra/prod/secrets.tf", true},
		{"**/secrets.tf", "secrets.tf", true},
		{"src/**/test/*.go", "src/a/b/test/x.go", true},
		{"src/**/test/*.go", "src/test/x.go", true},
		{"src/**/test/*.go", "src/a/test/x/y.go", false},

		// backtracking: the "**" must give back segments to let the tail match
		{"**/b/**", "a/b/c", true},
		{"a/**/b/**/c", "a/x/y/b/z/w/c", true},
		{"a/**/z", "a/b/c/d", false},
	}
	for _, c := range cases {
		if got := matchPattern(c.pattern, c.target); got != c.want {
			t.Errorf("matchPattern(%q, %q) = %v, want %v", c.pattern, c.target, got, c.want)
		}
	}
}

// The worked example from contract/README.md. If this test changes, the contract
// document changes with it.
func TestContractWorkedExample(t *testing.T) {
	rules := []Rule{
		{Pattern: "**", AccessLevel: AccessRead},
		{Pattern: "infra/**", AccessLevel: AccessNone},
		{Pattern: "infra/staging/**", AccessLevel: AccessRead},
	}
	cases := []struct {
		path        string
		wantAllowed bool
		wantPattern string
	}{
		{"src/main.go", true, "**"},
		{"infra/prod/db.tf", false, "infra/**"},
		{"infra/staging/db.tf", true, "infra/staging/**"},
	}
	for _, c := range cases {
		got := Evaluate("contractor", rules, c.path, IntentRead)
		if got.Allowed != c.wantAllowed {
			t.Errorf("%s: allowed = %v, want %v (reason: %s)", c.path, got.Allowed, c.wantAllowed, got.Reason)
		}
		if got.Rule == nil || got.Rule.Pattern != c.wantPattern {
			t.Errorf("%s: matched rule = %v, want pattern %q", c.path, got.Rule, c.wantPattern)
		}
	}
}

func TestDefaultDeny(t *testing.T) {
	rules := []Rule{{Pattern: "src/**", AccessLevel: AccessWrite}}
	got := Evaluate("contractor", rules, "docs/readme.md", IntentRead)
	if got.Allowed {
		t.Fatal("unmatched path was allowed; default must be deny")
	}
	if got.Rule != nil {
		t.Errorf("expected nil rule on default-deny, got %v", got.Rule)
	}
	if got.Reason == "" {
		t.Error("default-deny must carry a human-readable reason")
	}
}

func TestIntentReadVsWrite(t *testing.T) {
	rules := []Rule{{Pattern: "src/**", AccessLevel: AccessRead}}

	if d := Evaluate("contractor", rules, "src/a.go", IntentRead); !d.Allowed {
		t.Error("read intent should be satisfied by a read rule")
	}
	d := Evaluate("contractor", rules, "src/a.go", IntentWrite)
	if d.Allowed {
		t.Error("write intent must not be satisfied by a read rule")
	}
	if d.Reason != `role "contractor" has read-only access to this path` {
		t.Errorf("unhelpful reason for read-only write denial: %q", d.Reason)
	}

	write := []Rule{{Pattern: "src/**", AccessLevel: AccessWrite}}
	if d := Evaluate("contractor", write, "src/a.go", IntentRead); !d.Allowed {
		t.Error("read intent should be satisfied by a write rule")
	}
}

func TestSpecificityBeatsRuleOrder(t *testing.T) {
	// The narrow deny must win regardless of the order rules arrive in.
	narrowFirst := []Rule{
		{Pattern: "src/billing/secrets.go", AccessLevel: AccessNone},
		{Pattern: "src/**", AccessLevel: AccessWrite},
	}
	narrowLast := []Rule{
		{Pattern: "src/**", AccessLevel: AccessWrite},
		{Pattern: "src/billing/secrets.go", AccessLevel: AccessNone},
	}
	for name, rules := range map[string][]Rule{"narrowFirst": narrowFirst, "narrowLast": narrowLast} {
		d := Evaluate("eng", rules, "src/billing/secrets.go", IntentRead)
		if d.Allowed {
			t.Errorf("%s: specific deny lost to broad allow", name)
		}
	}
}

func TestTieBreaksToMostRestrictive(t *testing.T) {
	// Same segment score (4+2), same literal count: "none" must win.
	rules := []Rule{
		{Pattern: "src/*.go", AccessLevel: AccessWrite},
		{Pattern: "src/a*.go", AccessLevel: AccessNone},
	}
	if d := Evaluate("eng", rules, "src/a.go", IntentRead); d.Allowed {
		// "src/a*.go" has more literals, so it should win outright here.
		t.Errorf("more-literal deny lost; rule = %v", d.Rule)
	}

	exact := []Rule{
		{Pattern: "src/a?.go", AccessLevel: AccessWrite},
		{Pattern: "src/a*.go", AccessLevel: AccessNone},
	}
	if d := Evaluate("eng", exact, "src/ab.go", IntentRead); d.Allowed {
		t.Errorf("true tie did not fail closed; rule = %v", d.Rule)
	}
}

func TestSpecificityScores(t *testing.T) {
	cases := []struct {
		pattern string
		want    int
	}{
		{"**", 0},
		{"infra/**", 4},
		{"infra/staging/**", 8},
		{"src/*.go", 6},
		{"src/billing/charge.go", 12},
		{"**/secrets.tf", 4},
	}
	for _, c := range cases {
		if got := specificity(c.pattern); got != c.want {
			t.Errorf("specificity(%q) = %d, want %d", c.pattern, got, c.want)
		}
	}
}

func TestNormalizePath(t *testing.T) {
	ok := map[string]string{
		"src/main.go":     "src/main.go",
		"./src/main.go":   "src/main.go",
		"src//main.go":    "src/main.go",
		"src/../lib/a.go": "lib/a.go",
	}
	for in, want := range ok {
		got, err := NormalizePath(in)
		if err != nil {
			t.Errorf("NormalizePath(%q) errored: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("NormalizePath(%q) = %q, want %q", in, got, want)
		}
	}

	bad := []string{"", "/etc/passwd", "../outside.go", "src/../../outside.go", ".", `src\main.go`}
	for _, in := range bad {
		if got, err := NormalizePath(in); err == nil {
			t.Errorf("NormalizePath(%q) should have failed, got %q", in, got)
		}
	}
}

func TestEscapeAttemptCannotDodgeADeny(t *testing.T) {
	// The whole point of normalizing before evaluating: "src/../infra/db.tf"
	// must be judged as "infra/db.tf".
	rules := []Rule{
		{Pattern: "**", AccessLevel: AccessRead},
		{Pattern: "infra/**", AccessLevel: AccessNone},
	}
	norm, err := NormalizePath("src/../infra/db.tf")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if d := Evaluate("contractor", rules, norm, IntentRead); d.Allowed {
		t.Error("traversal dodged the deny rule")
	}
}
