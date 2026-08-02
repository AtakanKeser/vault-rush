package auth

import (
	"strings"
	"testing"
	"time"
)

func TestIssueAndVerify(t *testing.T) {
	iss := New("secret", time.Hour)
	tok := iss.Issue("plr_123")
	got, err := iss.Verify(tok)
	if err != nil || got != "plr_123" {
		t.Fatalf("verify: %v %q", err, got)
	}
}

func TestTamperedTokenFails(t *testing.T) {
	iss := New("secret", time.Hour)
	tok := iss.Issue("plr_123")
	parts := strings.SplitN(tok, ".", 2)
	// Flip the payload to another player but keep the signature.
	forged := b64("plr_999|9999999999") + "." + parts[1]
	if _, err := iss.Verify(forged); err == nil {
		t.Fatal("forged payload must fail")
	}
	if _, err := iss.Verify(parts[0] + ".AAAA"); err == nil {
		t.Fatal("bad signature must fail")
	}
	if _, err := iss.Verify("garbage"); err == nil {
		t.Fatal("garbage must fail")
	}
	other := New("other-secret", time.Hour)
	if _, err := other.Verify(tok); err == nil {
		t.Fatal("token from another issuer must fail")
	}
}

func TestExpiry(t *testing.T) {
	iss := New("secret", time.Minute)
	now := time.Now()
	iss.now = func() time.Time { return now }
	tok := iss.Issue("plr_1")
	iss.now = func() time.Time { return now.Add(2 * time.Minute) }
	if _, err := iss.Verify(tok); err == nil {
		t.Fatal("expired token must fail")
	}
	forever := New("secret", 0).Issue("plr_1")
	if _, err := New("secret", 0).Verify(forever); err != nil {
		t.Fatalf("non-expiring token: %v", err)
	}
}
