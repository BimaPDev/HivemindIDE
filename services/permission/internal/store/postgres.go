package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/BimaPDev/HivemindIDE/permission/internal/policy"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Postgres struct {
	pool *pgxpool.Pool
}

func NewPostgres(ctx context.Context, dsn string) (*Postgres, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Postgres{pool: pool}, nil
}

func (p *Postgres) Close() { p.pool.Close() }

func (p *Postgres) Ping(ctx context.Context) error { return p.pool.Ping(ctx) }

func (p *Postgres) RoleForUser(ctx context.Context, userID, repoID string) (Role, error) {
	var r Role
	err := p.pool.QueryRow(ctx, `
		SELECT roles.id, roles.name
		  FROM memberships
		  JOIN roles ON roles.id = memberships.role_id
		 WHERE memberships.user_id = $1 AND memberships.repo_id = $2`,
		userID, repoID).Scan(&r.ID, &r.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, ErrNoMembership
	}
	if err != nil {
		return Role{}, fmt.Errorf("query membership: %w", err)
	}

	r.Rules, err = p.rulesFor(ctx, r.ID)
	if err != nil {
		return Role{}, err
	}
	return r, nil
}

func (p *Postgres) rulesFor(ctx context.Context, roleID string) ([]policy.Rule, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT path_pattern, access_level
		  FROM permissions
		 WHERE role_id = $1
		 ORDER BY path_pattern`, roleID)
	if err != nil {
		return nil, fmt.Errorf("query rules: %w", err)
	}
	defer rows.Close()

	rules := []policy.Rule{}
	for rows.Next() {
		var r policy.Rule
		if err := rows.Scan(&r.Pattern, &r.AccessLevel); err != nil {
			return nil, fmt.Errorf("scan rule: %w", err)
		}
		rules = append(rules, r)
	}
	return rules, rows.Err()
}

func (p *Postgres) ListRoles(ctx context.Context, repoID string) ([]Role, error) {
	var exists bool
	if err := p.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM repos WHERE id = $1)`, repoID).Scan(&exists); err != nil {
		return nil, fmt.Errorf("check repo: %w", err)
	}
	if !exists {
		return nil, ErrRepoNotFound
	}

	rows, err := p.pool.Query(ctx,
		`SELECT id, name FROM roles WHERE repo_id = $1 ORDER BY name`, repoID)
	if err != nil {
		return nil, fmt.Errorf("query roles: %w", err)
	}
	defer rows.Close()

	roles := []Role{}
	for rows.Next() {
		var r Role
		if err := rows.Scan(&r.ID, &r.Name); err != nil {
			return nil, fmt.Errorf("scan role: %w", err)
		}
		roles = append(roles, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i := range roles {
		if roles[i].Rules, err = p.rulesFor(ctx, roles[i].ID); err != nil {
			return nil, err
		}
	}
	return roles, nil
}

// UpsertRole creates or updates a role and replaces its rule set wholesale.
func (p *Postgres) UpsertRole(ctx context.Context, repoID, name string, rules []policy.Rule) (Role, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Role{}, fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)

	var roleID string
	err = tx.QueryRow(ctx, `
		INSERT INTO roles (id, repo_id, name) VALUES ($1, $2, $3)
		ON CONFLICT (repo_id, name) DO UPDATE SET name = EXCLUDED.name
		RETURNING id`, uuid.NewString(), repoID, name).Scan(&roleID)
	if err != nil {
		return Role{}, fmt.Errorf("upsert role: %w", err)
	}

	if _, err := tx.Exec(ctx, `DELETE FROM permissions WHERE role_id = $1`, roleID); err != nil {
		return Role{}, fmt.Errorf("clear rules: %w", err)
	}
	for _, r := range rules {
		if _, err := tx.Exec(ctx, `
			INSERT INTO permissions (role_id, path_pattern, access_level)
			VALUES ($1, $2, $3)
			ON CONFLICT (role_id, path_pattern) DO UPDATE SET access_level = EXCLUDED.access_level`,
			roleID, r.Pattern, r.AccessLevel); err != nil {
			return Role{}, fmt.Errorf("insert rule %q: %w", r.Pattern, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return Role{}, fmt.Errorf("commit: %w", err)
	}
	return Role{ID: roleID, Name: name, Rules: rules}, nil
}

func (p *Postgres) UpsertMembership(ctx context.Context, userID, repoID, roleID string) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO memberships (user_id, repo_id, role_id) VALUES ($1, $2, $3)
		ON CONFLICT (user_id, repo_id) DO UPDATE SET role_id = EXCLUDED.role_id`,
		userID, repoID, roleID)
	if err != nil {
		return fmt.Errorf("upsert membership: %w", err)
	}
	return nil
}
