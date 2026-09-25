package policy

import "strings"

// matchPattern reports whether a repo-relative path matches a glob pattern.
//
// Segment semantics, matching contract/README.md:
//
//	"**" matches zero or more whole path segments
//	"*"  matches any run of characters inside one segment
//	"?"  matches exactly one character inside one segment
//
// Implemented as the classic two-pointer glob walk, lifted from characters to
// path segments: on a mismatch we backtrack to the most recent "**" and let it
// swallow one more segment.
func matchPattern(pattern, target string) bool {
	pat := strings.Split(pattern, "/")
	seg := strings.Split(target, "/")

	p, s := 0, 0
	starP, starS := -1, -1

	for s < len(seg) {
		switch {
		case p < len(pat) && pat[p] == "**":
			// Record the backtrack point and first try matching zero segments.
			starP, starS = p, s
			p++
		case p < len(pat) && matchSegment(pat[p], seg[s]):
			p++
			s++
		case starP >= 0:
			// Let the remembered "**" absorb one more segment and retry.
			starS++
			s = starS
			p = starP + 1
		default:
			return false
		}
	}

	// Trailing "**" segments can each match zero segments.
	for p < len(pat) && pat[p] == "**" {
		p++
	}
	return p == len(pat)
}

// matchSegment matches a single path segment against a pattern segment
// containing "*" and "?" but no "/".
func matchSegment(pattern, seg string) bool {
	p, s := 0, 0
	starP, starS := -1, -1

	for s < len(seg) {
		switch {
		case p < len(pattern) && pattern[p] == '*':
			starP, starS = p, s
			p++
		case p < len(pattern) && (pattern[p] == '?' || pattern[p] == seg[s]):
			p++
			s++
		case starP >= 0:
			starS++
			s = starS
			p = starP + 1
		default:
			return false
		}
	}

	for p < len(pattern) && pattern[p] == '*' {
		p++
	}
	return p == len(pattern)
}
