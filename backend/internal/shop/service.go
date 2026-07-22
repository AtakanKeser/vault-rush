// Package shop sells boosters and lives for coins. Purchases go through the
// optimistic-concurrency Mutate helper, so two concurrent purchases that
// together exceed the balance can never both succeed.
package shop

import (
	"context"
	"errors"

	"github.com/atakank/vault-rush/backend/internal/domain"
	"github.com/atakank/vault-rush/backend/internal/ids"
	"github.com/atakank/vault-rush/backend/internal/player"
	"github.com/atakank/vault-rush/backend/internal/telemetry"
)

// Item is a catalog entry.
type Item struct {
	ID          string `json:"itemId"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Price       int64  `json:"price"`
	Kind        string `json:"kind"` // booster | life
}

// Errors.
var (
	ErrUnknownItem       = errors.New("unknown item")
	ErrInsufficientCoins = errors.New("insufficient coins")
	ErrLivesFull         = errors.New("lives already full")
)

// Catalog is static for the MVP; a LiveOps-editable catalog is a natural follow-up.
var Catalog = []Item{
	{ID: "extra_moves", Name: "Extra Moves", Description: "+3 moves in every vault of your next heist", Price: 300, Kind: "booster"},
	{ID: "shield", Name: "Shield", Description: "Getting busted only costs you half the usual loot", Price: 450, Kind: "booster"},
	{ID: "life", Name: "Life", Description: "Refill one life instantly", Price: 200, Kind: "life"},
}

// Service is the shop.
type Service struct {
	players *player.Service
	bus     *telemetry.Bus
}

// New wires the shop.
func New(players *player.Service, bus *telemetry.Bus) *Service {
	return &Service{players: players, bus: bus}
}

func find(id string) (Item, bool) {
	for _, it := range Catalog {
		if it.ID == id {
			return it, true
		}
	}
	return Item{}, false
}

// Purchase debits coins and credits the item atomically (version-checked).
func (s *Service) Purchase(ctx context.Context, playerID, itemID string) (*domain.Player, error) {
	item, ok := find(itemID)
	if !ok {
		return nil, ErrUnknownItem
	}
	p, err := s.players.Mutate(ctx, playerID, func(p *domain.Player) error {
		if p.Coins < item.Price {
			return ErrInsufficientCoins
		}
		switch item.Kind {
		case "life":
			if p.Lives >= p.MaxLives {
				return ErrLivesFull
			}
			p.Lives++
		default:
			if p.Boosters == nil {
				p.Boosters = map[string]int{}
			}
			p.Boosters[item.ID]++
		}
		p.Coins -= item.Price
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.bus != nil {
		s.bus.Publish(telemetry.Event{ID: ids.New("evt"), Type: telemetry.Purchase, PlayerID: playerID, Group: p.ExperimentGroup, Item: item.ID, Coins: item.Price})
	}
	return p, nil
}
