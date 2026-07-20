package main

import "testing"

func TestFilterFindingsKeepsOnlyChangedLinesAndCapsResults(t *testing.T) {
	changed := map[string]map[int]struct{}{"api.go": {7: {}, 9: {}}}
	items := []finding{
		{File: "api.go", Line: 3, Severity: "HIGH", Title: "Old", Why: "impact", Association: "path", Suggestion: "verify fix"},
		{File: "./api.go", Line: 7, Severity: "LOW", Title: "Valid", Why: "impact", Association: "path", Suggestion: "verify fix"},
		{File: "api.go", Line: 9, Severity: "HIGH", Title: "Higher", Why: "impact", Association: "path", Suggestion: "verify fix"},
		{File: "api.go", Line: 9, Severity: "HIGH", Title: "Duplicate", Why: "impact", Association: "path", Suggestion: "verify fix"},
	}

	got := filterFindings(items, changed)
	if len(got) != 2 {
		t.Fatalf("len(filterFindings()) = %d, want 2", len(got))
	}
	if got[0].Title != "Higher" || got[1].Title != "Valid" {
		t.Fatalf("findings not filtered and sorted: %#v", got)
	}
}

func TestRetryableCodexFailure(t *testing.T) {
	if !retryableCodexFailure("session limit exceeded") {
		t.Fatal("session limit should be retryable")
	}
	if retryableCodexFailure("invalid output schema") {
		t.Fatal("invalid schema should not be retryable")
	}
}
