// Command seed loads the demo repo, users and roles.
//
// The IDs are fixed so the demo page, the README's curl commands and the fork's
// dev config can all refer to them without a lookup step.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/BimaPDev/HivemindIDE/permission/internal/policy"
	"github.com/BimaPDev/HivemindIDE/permission/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	RepoID         = "11111111-1111-4111-8111-111111111111"
	UserSeniorID   = "22222222-2222-4222-8222-222222222222"
	UserContractID = "33333333-3333-4333-8333-333333333333"
)

func main() {
	dsn := os.Getenv("PERMISSION_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://hivemindide:hivemindide@localhost:5432/hivemindide?sslmode=disable"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	db, err := store.NewPostgres(ctx, dsn)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	exec := func(sql string, args ...any) {
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			log.Fatalf("%s: %v", sql, err)
		}
	}

	exec(`INSERT INTO repos (id, name, remote_url) VALUES ($1, $2, $3)
	      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
		RepoID, "acme-payments", "git@github.com:acme/payments.git")

	exec(`INSERT INTO users (id, name, auth_identity) VALUES ($1, $2, $3)
	      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
		UserSeniorID, "Bima (senior-eng)", "bimapdev@gmail.com")

	exec(`INSERT INTO users (id, name, auth_identity) VALUES ($1, $2, $3)
	      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
		UserContractID, "Dani (contractor)", "dani@contractor.example")

	// senior-eng: the whole repo, read and write.
	senior, err := db.UpsertRole(ctx, RepoID, "senior-eng", []policy.Rule{
		{Pattern: "**", AccessLevel: policy.AccessWrite},
	})
	if err != nil {
		log.Fatalf("senior role: %v", err)
	}

	// contractor: the billing feature they were hired for, and nothing else.
	// The staging carve-out exists to show specificity beating rule order.
	contractor, err := db.UpsertRole(ctx, RepoID, "contractor", []policy.Rule{
		{Pattern: "**", AccessLevel: policy.AccessRead},
		{Pattern: "src/billing/**", AccessLevel: policy.AccessWrite},
		{Pattern: "infra/**", AccessLevel: policy.AccessNone},
		{Pattern: "infra/staging/**", AccessLevel: policy.AccessRead},
		{Pattern: "**/*.env", AccessLevel: policy.AccessNone},
	})
	if err != nil {
		log.Fatalf("contractor role: %v", err)
	}

	if err := db.UpsertMembership(ctx, UserSeniorID, RepoID, senior.ID); err != nil {
		log.Fatalf("senior membership: %v", err)
	}
	if err := db.UpsertMembership(ctx, UserContractID, RepoID, contractor.ID); err != nil {
		log.Fatalf("contractor membership: %v", err)
	}

	fmt.Println("seeded:")
	fmt.Printf("  repo        %s  (acme-payments)\n", RepoID)
	fmt.Printf("  senior-eng  %s  role %s\n", UserSeniorID, senior.ID)
	fmt.Printf("  contractor  %s  role %s\n", UserContractID, contractor.ID)
}
