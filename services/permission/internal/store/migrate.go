package store

import (
	"context"
	"fmt"
	"sort"

	"github.com/BimaPDev/HivemindIDE/permission/migrations"
)

// Migrate applies every .sql file in migrations/ in lexical order. The files are
// written to be idempotent (CREATE TABLE IF NOT EXISTS), so this is safe to run
// on every startup — which is what the MVP does instead of carrying a migration
// tool and a versions table.
func (p *Postgres) Migrate(ctx context.Context) error {
	entries, err := migrations.FS.ReadDir(".")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}
		if _, err := p.pool.Exec(ctx, string(body)); err != nil {
			return fmt.Errorf("apply %s: %w", name, err)
		}
	}
	return nil
}
