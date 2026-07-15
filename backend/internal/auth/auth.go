// Package auth issues and verifies compact HMAC-signed player tokens.
//
// Format: base64url(payload) "." base64url(hmac-sha256(payload)). The payload
// is "<playerId>|<expiryUnix>". No external dependency, constant-time compare,
// and cheap enough to verify on every request without a cache.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"
)

// ErrInvalidToken is returned for any malformed, forged or expired token.
var ErrInvalidToken = errors.New("invalid token")

// Issuer signs tokens.
type Issuer struct {
	secret []byte
	ttl    time.Duration
	now    func() time.Time
}

// New creates an issuer. ttl <= 0 means tokens never expire (dev only).
func New(secret string, ttl time.Duration) *Issuer {
	return &Issuer{secret: []byte(secret), ttl: ttl, now: time.Now}
}

// Issue creates a token for playerID.
func (i *Issuer) Issue(playerID string) string {
	exp := int64(0)
	if i.ttl > 0 {
		exp = i.now().Add(i.ttl).Unix()
	}
	payload := playerID + "|" + strconv.FormatInt(exp, 10)
	return b64(payload) + "." + b64s(i.sign(payload))
}

// Verify returns the player id embedded in a valid token.
func (i *Issuer) Verify(token string) (string, error) {
	dot := strings.IndexByte(token, '.')
	if dot <= 0 || dot == len(token)-1 {
		return "", ErrInvalidToken
	}
	payloadB, err := base64.RawURLEncoding.DecodeString(token[:dot])
	if err != nil {
		return "", ErrInvalidToken
	}
	sig, err := base64.RawURLEncoding.DecodeString(token[dot+1:])
	if err != nil {
		return "", ErrInvalidToken
	}
	payload := string(payloadB)
	if !hmac.Equal(sig, i.sign(payload)) {
		return "", ErrInvalidToken
	}
	sep := strings.LastIndexByte(payload, '|')
	if sep <= 0 {
		return "", ErrInvalidToken
	}
	exp, err := strconv.ParseInt(payload[sep+1:], 10, 64)
	if err != nil {
		return "", ErrInvalidToken
	}
	if exp != 0 && i.now().Unix() > exp {
		return "", ErrInvalidToken
	}
	return payload[:sep], nil
}

func (i *Issuer) sign(payload string) []byte {
	m := hmac.New(sha256.New, i.secret)
	m.Write([]byte(payload))
	return m.Sum(nil)
}

func b64(s string) string  { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
func b64s(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
