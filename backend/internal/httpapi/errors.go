package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/aws/smithy-go"

	"github.com/atakank/vault-rush/backend/internal/domain"
	"github.com/atakank/vault-rush/backend/internal/gameplay"
	"github.com/atakank/vault-rush/backend/internal/liveops"
	"github.com/atakank/vault-rush/backend/internal/player"
	"github.com/atakank/vault-rush/backend/internal/reward"
	"github.com/atakank/vault-rush/backend/internal/shop"
	"github.com/atakank/vault-rush/backend/pkg/engine"
)

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, errorBody{Error: errorDetail{Code: code, Message: msg}})
}

// fail maps a service error to an HTTP response. notFoundCode lets each
// handler name what was missing (RUN_NOT_FOUND vs REWARD_NOT_FOUND).
func fail(w http.ResponseWriter, err error, notFoundCode string) {
	status, code := classify(err, notFoundCode)
	msg := err.Error()
	if status == http.StatusInternalServerError {
		msg = "internal error"
	}
	writeError(w, status, code, msg)
}

func classify(err error, notFoundCode string) (int, string) {
	switch {
	case errors.Is(err, domain.ErrNotFound):
		if notFoundCode == "" {
			notFoundCode = "NOT_FOUND"
		}
		return http.StatusNotFound, notFoundCode
	case errors.Is(err, gameplay.ErrForbidden):
		return http.StatusForbidden, "FORBIDDEN"
	case errors.Is(err, gameplay.ErrRunFinished):
		return http.StatusConflict, "RUN_ALREADY_FINISHED"
	case errors.Is(err, gameplay.ErrRunExpired):
		return http.StatusGone, "RUN_EXPIRED"
	case errors.Is(err, gameplay.ErrEventClosed):
		return http.StatusGone, "EVENT_CLOSED"
	case errors.Is(err, gameplay.ErrInsufficientLives):
		return http.StatusPaymentRequired, "INSUFFICIENT_LIVES"
	case errors.Is(err, gameplay.ErrInsufficientBoosters):
		return http.StatusPaymentRequired, "INSUFFICIENT_BOOSTERS"
	case errors.Is(err, gameplay.ErrUnknownBooster):
		return http.StatusBadRequest, "BAD_REQUEST"
	case errors.Is(err, engine.ErrInvalidReplay), errors.Is(err, engine.ErrInvalidMove):
		return http.StatusUnprocessableEntity, "INVALID_REPLAY"
	case errors.Is(err, gameplay.ErrScoreMismatch):
		return http.StatusUnprocessableEntity, "SCORE_MISMATCH"
	case errors.Is(err, gameplay.ErrImplausible):
		return http.StatusUnprocessableEntity, "IMPLAUSIBLE_RESULT"
	case errors.Is(err, reward.ErrAlreadyClaimed):
		return http.StatusConflict, "REWARD_ALREADY_CLAIMED"
	case errors.Is(err, shop.ErrInsufficientCoins):
		return http.StatusPaymentRequired, "INSUFFICIENT_COINS"
	case errors.Is(err, shop.ErrUnknownItem):
		return http.StatusBadRequest, "BAD_REQUEST"
	case errors.Is(err, shop.ErrLivesFull):
		return http.StatusConflict, "LIVES_FULL"
	case errors.Is(err, domain.ErrVersionConflict), errors.Is(err, player.ErrRetriesExhausted):
		return http.StatusConflict, "VERSION_CONFLICT"
	case errors.Is(err, domain.ErrAlreadyExists):
		return http.StatusConflict, "ALREADY_EXISTS"
	case errors.Is(err, domain.ErrConflict):
		return http.StatusConflict, "CONFLICT"
	case errors.Is(err, liveops.ErrValidation):
		return http.StatusBadRequest, "INVALID_CONFIG"
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout, "TIMEOUT"
	case isDependencyError(err):
		return http.StatusServiceUnavailable, "DEPENDENCY_UNAVAILABLE"
	default:
		return http.StatusInternalServerError, "INTERNAL"
	}
}

// isDependencyError recognises AWS SDK (DynamoDB/SQS) and Redis transport
// failures so clients get a retryable 503 instead of an opaque 500.
func isDependencyError(err error) bool {
	var op *smithy.OperationError
	if errors.As(err, &op) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "connection refused") || strings.Contains(msg, "i/o timeout") || strings.Contains(msg, "redis:")
}
