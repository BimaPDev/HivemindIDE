package team

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newStore(t *testing.T) (*Store, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return NewStore(rdb), mr
}

// Every rule, as a table: who may share, and who may change whom.
func TestPolicy(t *testing.T) {
	roles := []Role{RoleOwner, RoleAdmin, RoleMember}
	type k struct{ actor, target, to Role }
	wantSetRole := map[k]bool{
		{RoleOwner, RoleAdmin, RoleMember}: true, {RoleOwner, RoleMember, RoleAdmin}: true,
		{RoleOwner, RoleAdmin, RoleAdmin}: true, {RoleOwner, RoleMember, RoleMember}: true,
		{RoleAdmin, RoleMember, RoleAdmin}: true,
	}
	for _, actor := range roles {
		for _, target := range roles {
			for _, to := range roles {
				if got := CanSetRole(actor, target, to); got != wantSetRole[k{actor, target, to}] {
					t.Errorf("CanSetRole(%s, %s -> %s) = %v", actor, target, to, got)
				}
			}
		}
	}
	for _, c := range []struct {
		actor, as Role
		want      bool
	}{
		{RoleOwner, RoleMember, true}, {RoleOwner, RoleAdmin, true}, {RoleOwner, RoleOwner, false},
		{RoleAdmin, RoleMember, true}, {RoleAdmin, RoleAdmin, true}, {RoleAdmin, RoleOwner, false},
		{RoleMember, RoleMember, false}, {RoleMember, RoleAdmin, false},
	} {
		if got := CanInvite(c.actor, c.as); got != c.want {
			t.Errorf("CanInvite(%s as %s) = %v", c.actor, c.as, got)
		}
	}
	for _, c := range []struct {
		actor, target Role
		want          bool
	}{
		{RoleOwner, RoleAdmin, true}, {RoleOwner, RoleMember, true}, {RoleOwner, RoleOwner, false},
		{RoleAdmin, RoleMember, true}, {RoleAdmin, RoleAdmin, false}, {RoleAdmin, RoleOwner, false},
		{RoleMember, RoleMember, false},
	} {
		if got := CanRemove(c.actor, c.target); got != c.want {
			t.Errorf("CanRemove(%s, %s) = %v", c.actor, c.target, got)
		}
	}
}

// The whole life of a team: create, invite, join, promote, remove, transfer.
func TestTeamLifecycle(t *testing.T) {
	ctx := context.Background()
	s, _ := newStore(t)

	if ok, _ := s.Exists(ctx, "r"); ok {
		t.Fatal("no team yet")
	}
	owner, ownerToken, err := s.Create(ctx, "r", "alice", "Alice")
	if err != nil || owner.Role != RoleOwner {
		t.Fatalf("create: %v %+v", err, owner)
	}
	if _, _, err := s.Create(ctx, "r", "mallory", "Mallory"); !errors.Is(err, ErrTeamExists) {
		t.Fatalf("second create must fail, got %v", err)
	}
	if me, err := s.Authenticate(ctx, "r", ownerToken); err != nil || me.UserID != "alice" {
		t.Fatalf("owner token: %v %+v", err, me)
	}
	if _, err := s.Authenticate(ctx, "r", "hvt_forged"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("forged token must fail, got %v", err)
	}

	// Alice invites Bob as an admin, Bob joins.
	_, code, err := s.CreateInvite(ctx, "r", owner, RoleAdmin, time.Hour, 1)
	if err != nil {
		t.Fatal(err)
	}
	bob, bobToken, err := s.Join(ctx, "r", code, "bob", "Bob")
	if err != nil || bob.Role != RoleAdmin || bob.InvitedBy != "alice" {
		t.Fatalf("join: %v %+v", err, bob)
	}
	if _, _, err := s.Join(ctx, "r", code, "eve", "Eve"); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("a one-use invite must not admit a second person, got %v", err)
	}

	// Bob (admin) shares too: invites Chen as a member, then promotes him.
	_, chenCode, err := s.CreateInvite(ctx, "r", bob, RoleMember, time.Hour, 5)
	if err != nil {
		t.Fatal(err)
	}
	chen, chenToken, _ := s.Join(ctx, "r", chenCode, "chen", "Chen")
	if chen.Role != RoleMember {
		t.Fatalf("chen: %+v", chen)
	}
	// Chen (member) cannot share.
	if _, _, err := s.CreateInvite(ctx, "r", chen, RoleMember, time.Hour, 1); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a member must not invite, got %v", err)
	}
	if chen, err = s.SetRole(ctx, "r", bob, "chen", RoleAdmin); err != nil || chen.Role != RoleAdmin {
		t.Fatalf("admin promotes member: %v %+v", err, chen)
	}
	// Bob (admin) cannot demote Chen (now an admin), nor touch Alice.
	if _, err := s.SetRole(ctx, "r", bob, "chen", RoleMember); !errors.Is(err, ErrForbidden) {
		t.Fatalf("admin must not demote an admin, got %v", err)
	}
	if err := s.Remove(ctx, "r", bob, "alice"); !errors.Is(err, ErrOwnerMustStay) {
		t.Fatalf("nobody removes the owner, got %v", err)
	}

	// Alice removes Chen: Chen's token stops working at once.
	if err := s.Remove(ctx, "r", owner, "chen"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Authenticate(ctx, "r", chenToken); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("a removed member's token must stop working, got %v", err)
	}

	// Alice hands the team to Bob and stays on as an admin.
	if _, err := s.Transfer(ctx, "r", bob, "bob"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("only the owner transfers, got %v", err)
	}
	if _, err := s.Transfer(ctx, "r", owner, "bob"); err != nil {
		t.Fatal(err)
	}
	members, _ := s.Members(ctx, "r")
	got := map[string]Role{}
	for _, m := range members {
		got[m.UserID] = m.Role
	}
	if got["bob"] != RoleOwner || got["alice"] != RoleAdmin || len(got) != 2 {
		t.Fatalf("after transfer: %v", got)
	}
	if me, _ := s.Authenticate(ctx, "r", bobToken); me.Role != RoleOwner {
		t.Fatalf("bob's existing token now carries owner: %+v", me)
	}
}

func TestInvitesExpireAndCanBeRevoked(t *testing.T) {
	ctx := context.Background()
	s, _ := newStore(t)
	owner, _, _ := s.Create(ctx, "r", "alice", "Alice")
	now := time.Now()
	s.now = func() time.Time { return now }

	_, expiring, _ := s.CreateInvite(ctx, "r", owner, RoleMember, time.Minute, 1)
	revoked, revokedCode, _ := s.CreateInvite(ctx, "r", owner, RoleMember, time.Hour, 1)
	if err := s.RevokeInvite(ctx, "r", owner, revoked.ID); err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return now.Add(2 * time.Minute) }
	if _, _, err := s.Join(ctx, "r", expiring, "bob", "Bob"); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("expired invite must fail, got %v", err)
	}
	if _, _, err := s.Join(ctx, "r", revokedCode, "bob", "Bob"); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("revoked invite must fail, got %v", err)
	}
	if list, _ := s.Invites(ctx, "r"); len(list) != 0 {
		t.Fatalf("no usable invites should be listed: %+v", list)
	}
}

func TestSecretsAreStoredHashed(t *testing.T) {
	ctx := context.Background()
	s, mr := newStore(t)
	owner, token, _ := s.Create(ctx, "r", "alice", "Alice")
	_, code, _ := s.CreateInvite(ctx, "r", owner, RoleMember, time.Hour, 1)
	for _, k := range mr.Keys() {
		fields, err := mr.HKeys(k)
		if err != nil {
			continue // not a hash
		}
		for _, field := range fields {
			if field == token || field == code || mr.HGet(k, field) == token || mr.HGet(k, field) == code {
				t.Fatalf("a secret is stored in the clear under %s", k)
			}
		}
	}
}

// Found by the stress test: twenty transfers at once used to leave nineteen owners.
func TestConcurrentTransfersLeaveOneOwner(t *testing.T) {
	ctx := context.Background()
	s, _ := newStore(t)
	owner, _, _ := s.Create(ctx, "r", "alice", "Alice")
	_, code, _ := s.CreateInvite(ctx, "r", owner, RoleMember, time.Hour, 20)
	for i := range 20 {
		if _, _, err := s.Join(ctx, "r", code, fmt.Sprintf("m%d", i), "M"); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = s.Transfer(ctx, "r", owner, fmt.Sprintf("m%d", i))
		}()
	}
	wg.Wait()
	members, _ := s.Members(ctx, "r")
	owners := 0
	for _, m := range members {
		if m.Role == RoleOwner {
			owners++
		}
	}
	if owners != 1 {
		t.Fatalf("want exactly one owner, got %d", owners)
	}
}

// A role change decided on a stale view must not land: the actor is re-read inside the change.
func TestActionsUseTheActorsCurrentRole(t *testing.T) {
	ctx := context.Background()
	s, _ := newStore(t)
	owner, _, _ := s.Create(ctx, "r", "alice", "Alice")
	_, code, _ := s.CreateInvite(ctx, "r", owner, RoleAdmin, time.Hour, 1)
	admin, _, _ := s.Join(ctx, "r", code, "bob", "Bob")
	_, code, _ = s.CreateInvite(ctx, "r", owner, RoleMember, time.Hour, 1)
	_, _, _ = s.Join(ctx, "r", code, "carol", "Carol")

	// `admin` is the Bob the hub authenticated a moment ago; since then he was demoted.
	if _, err := s.SetRole(ctx, "r", owner, "bob", RoleMember); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetRole(ctx, "r", admin, "carol", RoleAdmin); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a demoted admin must not promote, got %v", err)
	}
	// And a removed member cannot be brought back by a role change.
	if err := s.Remove(ctx, "r", owner, "carol"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetRole(ctx, "r", owner, "carol", RoleAdmin); !errors.Is(err, ErrNotMember) {
		t.Fatalf("role change on a removed member must fail, got %v", err)
	}
}

func TestSessionsBelongToWhoeverClaimsThemFirst(t *testing.T) {
	ctx := context.Background()
	s, _ := newStore(t)
	if ok, _ := s.ClaimSession(ctx, "r", "s1", "alice"); !ok {
		t.Fatal("first claim")
	}
	if ok, _ := s.ClaimSession(ctx, "r", "s1", "alice"); !ok {
		t.Fatal("the owner keeps using it")
	}
	if ok, _ := s.ClaimSession(ctx, "r", "s1", "bob"); ok {
		t.Fatal("someone else must not take it")
	}
}

func TestIdentityValidation(t *testing.T) {
	for id, want := range map[string]bool{"alice": true, "émile-ü": true, "a.b_c@d": true, "": false, "   ": false, "a b": false, "a:b": false, strings.Repeat("u", 65): false} {
		if ValidUserID(id) != want {
			t.Errorf("ValidUserID(%q) = %v", id, !want)
		}
	}
	for name, want := range map[string]bool{"Émile 🐝": true, " Alice ": true, "": false, "a\nb": false, strings.Repeat("N", 81): false} {
		if _, ok := CleanDisplayName(name); ok != want {
			t.Errorf("CleanDisplayName(%q) = %v", name, ok)
		}
	}
}
