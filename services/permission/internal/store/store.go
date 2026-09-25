// Package store is the Postgres persistence layer for the permission service.
package store

import (
	"context"
	"errors"

	"github.com/BimaPDev/HivemindIDE/permission/internal/policy"
)

var (
	// ErrNoMembership means the user is not a member of the repo. The filter
	// treats this as "deny everything", not as a server error.
	ErrNoMembership = errors.New("user has no role in this repo")
	ErrRepoNotFound = errors.New("repo not found")
	ErrRoleNotFound = errors.New("role not found")
)

type Role struct {
	ID    string        `json:"id"`
	Name  string        `json:"name"`
	Rules []policy.Rule `json:"rules"`
}

// Store is the interface the API depends on. Handlers are tested against a fake
// implementation so the test suite runs without Postgres.
type Store interface {
	// RoleForUser returns the single role a user holds in a repo.
	RoleForUser(ctx context.Context, userID, repoID string) (Role, error)
	ListRoles(ctx context.Context, repoID string) ([]Role, error)
	UpsertRole(ctx context.Context, repoID, name string, rules []policy.Rule) (Role, error)
	UpsertMembership(ctx context.Context, userID, repoID, roleID string) error
	Ping(ctx context.Context) error
}
