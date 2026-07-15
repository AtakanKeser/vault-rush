// Package ids generates prefixed, time-sortable identifiers (ULID-style:
// 48-bit millisecond timestamp + 80 random bits, Crockford base32).
package ids

import (
	"crypto/rand"
	"time"
)

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// New returns e.g. "run_01J7A2K3M4N5P6Q7R8S9T0V1W2".
func New(prefix string) string {
	var b [16]byte
	ms := uint64(time.Now().UnixMilli())
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	if _, err := rand.Read(b[6:]); err != nil {
		panic("ids: crypto/rand unavailable: " + err.Error())
	}
	return prefix + "_" + encode(b)
}

// encode produces the canonical 26-character ULID string.
func encode(b [16]byte) string {
	var out [26]byte
	out[0] = alphabet[(b[0]&224)>>5]
	out[1] = alphabet[b[0]&31]
	out[2] = alphabet[(b[1]&248)>>3]
	out[3] = alphabet[((b[1]&7)<<2)|((b[2]&192)>>6)]
	out[4] = alphabet[(b[2]&62)>>1]
	out[5] = alphabet[((b[2]&1)<<4)|((b[3]&240)>>4)]
	out[6] = alphabet[((b[3]&15)<<1)|((b[4]&128)>>7)]
	out[7] = alphabet[(b[4]&124)>>2]
	out[8] = alphabet[((b[4]&3)<<3)|((b[5]&224)>>5)]
	out[9] = alphabet[b[5]&31]
	out[10] = alphabet[(b[6]&248)>>3]
	out[11] = alphabet[((b[6]&7)<<2)|((b[7]&192)>>6)]
	out[12] = alphabet[(b[7]&62)>>1]
	out[13] = alphabet[((b[7]&1)<<4)|((b[8]&240)>>4)]
	out[14] = alphabet[((b[8]&15)<<1)|((b[9]&128)>>7)]
	out[15] = alphabet[(b[9]&124)>>2]
	out[16] = alphabet[((b[9]&3)<<3)|((b[10]&224)>>5)]
	out[17] = alphabet[b[10]&31]
	out[18] = alphabet[(b[11]&248)>>3]
	out[19] = alphabet[((b[11]&7)<<2)|((b[12]&192)>>6)]
	out[20] = alphabet[(b[12]&62)>>1]
	out[21] = alphabet[((b[12]&1)<<4)|((b[13]&240)>>4)]
	out[22] = alphabet[((b[13]&15)<<1)|((b[14]&128)>>7)]
	out[23] = alphabet[(b[14]&124)>>2]
	out[24] = alphabet[((b[14]&3)<<3)|((b[15]&224)>>5)]
	out[25] = alphabet[b[15]&31]
	return string(out[:])
}
