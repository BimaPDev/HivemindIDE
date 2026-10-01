// Package team is who may use a repo's coordination hub, and who may share it.
//
// A repo without a team is open, as the hub always was. Once someone creates a
// team they become its owner, and from then on every call about that repo needs
// a member's token: identity comes from the token, never from what a caller
// claims. Only owners and admins share: they invite people (as members or
// admins) with one-time codes, and manage roles. The rules are in Can*, as
// plain functions, so they are the single place policy lives.
//
// Tokens and invite codes are random, shown once, and stored only as SHA-256
// hashes: a copy of Redis does not let anyone sign in.
package team

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/redis/go-redis/v9"
)

type Role string

const (
	RoleOwner  Role = "owner"
	RoleAdmin  Role = "admin"
	RoleMember Role = "member"
)

func (r Role) Valid() bool {
	return r == RoleOwner || r == RoleAdmin || r == RoleMember
}

type Member struct {
	UserID      string    `json:"user_id"`
	DisplayName string    `json:"display_name"`
	Role        Role      `json:"role"`
	JoinedAt    time.Time `json:"joined_at"`
	InvitedBy   string    `json:"invited_by,omitempty"`
}

type Invite struct {
	ID        string    `json:"id"`
	Role      Role      `json:"role"`
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	MaxUses   int       `json:"max_uses"`
	Uses      int       `json:"uses"`
}

var (
	ErrNoTeam        = errors.New("this repo has no team")
	ErrTeamExists    = errors.New("this repo already has a team")
	ErrUnauthorized  = errors.New("not signed in to this repo's team")
	ErrForbidden     = errors.New("your role does not allow that")
	ErrInvalidInvite = errors.New("the invite code is invalid, used up or expired")
	ErrAlreadyMember = errors.New("that user is already a member")
	ErrNotMember     = errors.New("no such member")
	ErrOwnerMustStay = errors.New("the owner cannot leave or be removed; transfer ownership first")
)

// ---- Policy ---------------------------------------------------------------------------

// CanInvite: owners and admins share, as members or admins. Nobody is invited as owner.
func CanInvite(actor Role, as Role) bool {
	return (actor == RoleOwner || actor == RoleAdmin) && (as == RoleMember || as == RoleAdmin)
}

// CanSetRole: the owner sets anyone but themselves to member or admin; an admin can
// only promote a member to admin. Ownership moves only by transfer.
func CanSetRole(actor Role, target Role, to Role) bool {
	if target == RoleOwner || to == RoleOwner || !to.Valid() {
		return false
	}
	switch actor {
	case RoleOwner:
		return true
	case RoleAdmin:
		return target == RoleMember && to == RoleAdmin
	default:
		return false
	}
}

// CanRemove: the owner removes anyone else; an admin removes members only.
func CanRemove(actor Role, target Role) bool {
	switch {
	case target == RoleOwner:
		return false
	case actor == RoleOwner:
		return true
	case actor == RoleAdmin:
		return target == RoleMember
	default:
		return false
	}
}

// CanSeeInvites: pending invites are sharing, so only those who share see them.
func CanSeeInvites(actor Role) bool {
	return actor == RoleOwner || actor == RoleAdmin
}

// ---- Identity -------------------------------------------------------------------------

var userIDPattern = regexp.MustCompile(`^[\p{L}\p{N}._@-]{1,64}$`)

// ValidUserID: 1 to 64 letters, digits, '.', '_', '@' or '-'. User ids end up in
// Redis keys and in every teammate's panel, so no spaces, colons or controls.
func ValidUserID(id string) bool {
	return userIDPattern.MatchString(id)
}

// MaxDisplayName is how long a name may be, in characters.
const MaxDisplayName = 80

// CleanDisplayName trims a name and says whether it is fit to show teammates:
// not blank, not too long, and no control characters.
func CleanDisplayName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > MaxDisplayName || !utf8.ValidString(name) {
		return name, false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return name, false
		}
	}
	return name, true
}

// ---- Store ----------------------------------------------------------------------------

type Store struct {
	rdb *redis.Client
	now func() time.Time
}

func NewStore(rdb *redis.Client) *Store {
	return &Store{rdb: rdb, now: time.Now}
}

// Keys share the repo's hash tag, like the presence and lease keys.
func key(repoID, what string) string {
	return fmt.Sprintf("hivemindide:{%s}:team:%s", repoID, what)
}

func hash(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func newSecret(prefix string) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(b), nil
}

// Exists: whether the repo has a team, so calls about it need a member's token.
func (s *Store) Exists(ctx context.Context, repoID string) (bool, error) {
	n, err := s.rdb.Exists(ctx, key(repoID, "created")).Result()
	return n > 0, err
}

// Create makes a team with `userID` as its owner and returns their token.
func (s *Store) Create(ctx context.Context, repoID, userID, displayName string) (Member, string, error) {
	// One atomic marker decides who created the team: two people creating at
	// once cannot both become owners.
	created, err := s.rdb.SetNX(ctx, key(repoID, "created"), userID, 0).Result()
	if err != nil {
		return Member{}, "", err
	}
	if !created {
		return Member{}, "", ErrTeamExists
	}
	owner := Member{UserID: userID, DisplayName: displayName, Role: RoleOwner, JoinedAt: s.now().UTC()}
	if err := s.putMember(ctx, repoID, owner); err != nil {
		return Member{}, "", err
	}
	token, err := s.issueToken(ctx, repoID, userID)
	if err != nil {
		return Member{}, "", err
	}
	return owner, token, s.announce(ctx, repoID, EventTeamCreated, map[string]string{"owner": userID})
}

func (s *Store) issueToken(ctx context.Context, repoID, userID string) (string, error) {
	token, err := newSecret("hvt_")
	if err != nil {
		return "", err
	}
	h := hash(token)
	pipe := s.rdb.TxPipeline()
	pipe.HSet(ctx, key(repoID, "tokens"), h, userID)
	pipe.SAdd(ctx, key(repoID, "usertokens:"+userID), h)
	_, err = pipe.Exec(ctx)
	return token, err
}

// Authenticate: the member a token belongs to.
func (s *Store) Authenticate(ctx context.Context, repoID, token string) (Member, error) {
	if token == "" {
		return Member{}, ErrUnauthorized
	}
	userID, err := s.rdb.HGet(ctx, key(repoID, "tokens"), hash(token)).Result()
	if errors.Is(err, redis.Nil) {
		return Member{}, ErrUnauthorized
	}
	if err != nil {
		return Member{}, err
	}
	m, err := s.member(ctx, repoID, userID)
	if errors.Is(err, ErrNotMember) {
		return Member{}, ErrUnauthorized // removed since the token was issued
	}
	return m, err
}

func (s *Store) member(ctx context.Context, repoID, userID string) (Member, error) {
	raw, err := s.rdb.HGet(ctx, key(repoID, "members"), userID).Result()
	if errors.Is(err, redis.Nil) {
		return Member{}, ErrNotMember
	}
	if err != nil {
		return Member{}, err
	}
	var m Member
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return Member{}, err
	}
	return m, nil
}

func (s *Store) putMember(ctx context.Context, repoID string, m Member) error {
	data, _ := json.Marshal(m)
	return s.rdb.HSet(ctx, key(repoID, "members"), m.UserID, data).Err()
}

// Members, owner first, then admins, then members, each by name.
func (s *Store) Members(ctx context.Context, repoID string) ([]Member, error) {
	all, err := s.rdb.HGetAll(ctx, key(repoID, "members")).Result()
	if err != nil {
		return nil, err
	}
	out := make([]Member, 0, len(all))
	for _, raw := range all {
		var m Member
		if json.Unmarshal([]byte(raw), &m) == nil {
			out = append(out, m)
		}
	}
	rank := map[Role]int{RoleOwner: 0, RoleAdmin: 1, RoleMember: 2}
	sort.Slice(out, func(i, j int) bool {
		if rank[out[i].Role] != rank[out[j].Role] {
			return rank[out[i].Role] < rank[out[j].Role]
		}
		return strings.ToLower(out[i].DisplayName) < strings.ToLower(out[j].DisplayName)
	})
	return out, nil
}

// CreateInvite returns a one-time code (shown once) for joining as `role`.
func (s *Store) CreateInvite(ctx context.Context, repoID string, actor Member, role Role, ttl time.Duration, maxUses int) (Invite, string, error) {
	if !CanInvite(actor.Role, role) {
		return Invite{}, "", ErrForbidden
	}
	if maxUses < 1 {
		maxUses = 1
	}
	code, err := newSecret("hvi_")
	if err != nil {
		return Invite{}, "", err
	}
	idBytes := make([]byte, 6)
	_, _ = rand.Read(idBytes)
	now := s.now().UTC()
	inv := Invite{ID: hex.EncodeToString(idBytes), Role: role, CreatedBy: actor.UserID, CreatedAt: now, ExpiresAt: now.Add(ttl), MaxUses: maxUses}
	data, _ := json.Marshal(inv)
	pipe := s.rdb.TxPipeline()
	pipe.HSet(ctx, key(repoID, "invites"), inv.ID, data)
	pipe.HSet(ctx, key(repoID, "invitecodes"), hash(code), inv.ID)
	_, err = pipe.Exec(ctx)
	return inv, code, err
}

// Invites still usable, newest first. Expired and used-up ones are dropped on the way.
func (s *Store) Invites(ctx context.Context, repoID string) ([]Invite, error) {
	all, err := s.rdb.HGetAll(ctx, key(repoID, "invites")).Result()
	if err != nil {
		return nil, err
	}
	now := s.now()
	out := []Invite{}
	for id, raw := range all {
		var inv Invite
		if json.Unmarshal([]byte(raw), &inv) != nil {
			continue
		}
		uses, _ := s.rdb.HGet(ctx, key(repoID, "inviteuses"), id).Int()
		inv.Uses = uses
		if now.After(inv.ExpiresAt) || inv.Uses >= inv.MaxUses {
			s.rdb.HDel(ctx, key(repoID, "invites"), id)
			continue
		}
		out = append(out, inv)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (s *Store) RevokeInvite(ctx context.Context, repoID string, actor Member, inviteID string) error {
	if !CanSeeInvites(actor.Role) {
		return ErrForbidden
	}
	return s.rdb.HDel(ctx, key(repoID, "invites"), inviteID).Err()
}

// Join spends one use of an invite and makes `userID` a member with the invite's role.
func (s *Store) Join(ctx context.Context, repoID, code, userID, displayName string) (Member, string, error) {
	inviteID, err := s.rdb.HGet(ctx, key(repoID, "invitecodes"), hash(code)).Result()
	if errors.Is(err, redis.Nil) {
		return Member{}, "", ErrInvalidInvite
	}
	if err != nil {
		return Member{}, "", err
	}
	raw, err := s.rdb.HGet(ctx, key(repoID, "invites"), inviteID).Result()
	if errors.Is(err, redis.Nil) {
		return Member{}, "", ErrInvalidInvite // revoked
	}
	if err != nil {
		return Member{}, "", err
	}
	var inv Invite
	if err := json.Unmarshal([]byte(raw), &inv); err != nil || s.now().After(inv.ExpiresAt) {
		return Member{}, "", ErrInvalidInvite
	}
	if _, err := s.member(ctx, repoID, userID); err == nil {
		return Member{}, "", ErrAlreadyMember
	}
	// Spend a use atomically; two people racing for the last use cannot both get in.
	uses, err := s.rdb.HIncrBy(ctx, key(repoID, "inviteuses"), inviteID, 1).Result()
	if err != nil {
		return Member{}, "", err
	}
	if int(uses) > inv.MaxUses {
		s.rdb.HIncrBy(ctx, key(repoID, "inviteuses"), inviteID, -1)
		return Member{}, "", ErrInvalidInvite
	}
	m := Member{UserID: userID, DisplayName: displayName, Role: inv.Role, JoinedAt: s.now().UTC(), InvitedBy: inv.CreatedBy}
	data, _ := json.Marshal(m)
	added, err := s.rdb.HSetNX(ctx, key(repoID, "members"), userID, data).Result()
	if err != nil {
		return Member{}, "", err
	}
	if !added {
		s.rdb.HIncrBy(ctx, key(repoID, "inviteuses"), inviteID, -1)
		return Member{}, "", ErrAlreadyMember
	}
	token, err := s.issueToken(ctx, repoID, userID)
	if err != nil {
		return Member{}, "", err
	}
	return m, token, s.announce(ctx, repoID, EventMemberJoined, map[string]string{"user_id": userID, "role": string(m.Role)})
}

// atomically runs `change` against the members hash as it is right now, and
// retries if anyone else changed the team meanwhile. Role changes, removals and
// transfers all go through it, so a check is never made on a stale view: an
// admin demoted a moment ago cannot promote anyone, a member removed a moment
// ago cannot be brought back by a concurrent role change, and two transfers
// cannot leave two owners.
func (s *Store) atomically(ctx context.Context, repoID string, change func(tx *redis.Tx, members func(userID string) (Member, error)) ([]func(redis.Pipeliner), error)) error {
	membersKey := key(repoID, "members")
	for attempt := 0; attempt < 50; attempt++ {
		err := s.rdb.Watch(ctx, func(tx *redis.Tx) error {
			read := func(userID string) (Member, error) {
				raw, err := tx.HGet(ctx, membersKey, userID).Result()
				if errors.Is(err, redis.Nil) {
					return Member{}, ErrNotMember
				}
				if err != nil {
					return Member{}, err
				}
				var m Member
				return m, json.Unmarshal([]byte(raw), &m)
			}
			writes, err := change(tx, read)
			if err != nil {
				return err
			}
			_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
				for _, w := range writes {
					w(pipe)
				}
				return nil
			})
			return err
		}, membersKey)
		if !errors.Is(err, redis.TxFailedErr) {
			return err
		}
	}
	return errors.New("the team is changing too fast; try again")
}

// current is the actor as the team has them now: their role may have changed,
// or they may have been removed, since their token was checked.
func current(members func(string) (Member, error), actor Member) (Member, error) {
	m, err := members(actor.UserID)
	if errors.Is(err, ErrNotMember) {
		return Member{}, ErrUnauthorized
	}
	return m, err
}

func (s *Store) putMemberIn(pipe redis.Pipeliner, ctx context.Context, repoID string, m Member) {
	data, _ := json.Marshal(m)
	pipe.HSet(ctx, key(repoID, "members"), m.UserID, data)
}

func (s *Store) SetRole(ctx context.Context, repoID string, actor Member, userID string, to Role) (Member, error) {
	var out Member
	err := s.atomically(ctx, repoID, func(_ *redis.Tx, members func(string) (Member, error)) ([]func(redis.Pipeliner), error) {
		me, err := current(members, actor)
		if err != nil {
			return nil, err
		}
		target, err := members(userID)
		if err != nil {
			return nil, err
		}
		if !CanSetRole(me.Role, target.Role, to) {
			return nil, ErrForbidden
		}
		target.Role = to
		out = target
		return []func(redis.Pipeliner){func(p redis.Pipeliner) { s.putMemberIn(p, ctx, repoID, target) }}, nil
	})
	if err != nil {
		return Member{}, err
	}
	return out, s.announce(ctx, repoID, EventRoleChanged, map[string]string{"user_id": out.UserID, "role": string(out.Role)})
}

// Remove takes a member out of the team and signs out every token they had.
// Removing yourself is leaving, which anyone but the owner may do. Everyone
// watching the repo's stream hears about it, and the removed member's own
// streams close.
func (s *Store) Remove(ctx context.Context, repoID string, actor Member, userID string) error {
	err := s.atomically(ctx, repoID, func(tx *redis.Tx, members func(string) (Member, error)) ([]func(redis.Pipeliner), error) {
		me, err := current(members, actor)
		if err != nil {
			return nil, err
		}
		target, err := members(userID)
		if err != nil {
			return nil, err
		}
		if target.Role == RoleOwner {
			return nil, ErrOwnerMustStay
		}
		if userID != me.UserID && !CanRemove(me.Role, target.Role) {
			return nil, ErrForbidden
		}
		tokens, err := tx.SMembers(ctx, key(repoID, "usertokens:"+userID)).Result()
		if err != nil {
			return nil, err
		}
		return []func(redis.Pipeliner){func(pipe redis.Pipeliner) {
			pipe.HDel(ctx, key(repoID, "members"), userID)
			if len(tokens) > 0 {
				pipe.HDel(ctx, key(repoID, "tokens"), tokens...)
			}
			pipe.Del(ctx, key(repoID, "usertokens:"+userID))
		}}, nil
	})
	if err != nil {
		return err
	}
	return s.announce(ctx, repoID, EventMemberRemoved, map[string]string{"user_id": userID})
}

// Transfer makes `userID` the owner; the previous owner stays on as an admin.
func (s *Store) Transfer(ctx context.Context, repoID string, actor Member, userID string) (Member, error) {
	var out Member
	err := s.atomically(ctx, repoID, func(_ *redis.Tx, members func(string) (Member, error)) ([]func(redis.Pipeliner), error) {
		me, err := current(members, actor)
		if err != nil {
			return nil, err
		}
		if me.Role != RoleOwner {
			return nil, ErrForbidden
		}
		target, err := members(userID)
		if err != nil {
			return nil, err
		}
		out = target
		if target.UserID == me.UserID {
			return nil, nil
		}
		target.Role, me.Role = RoleOwner, RoleAdmin
		out = target
		return []func(redis.Pipeliner){func(p redis.Pipeliner) {
			s.putMemberIn(p, ctx, repoID, me)
			s.putMemberIn(p, ctx, repoID, target)
		}}, nil
	})
	if err != nil || out.UserID == actor.UserID {
		return out, err
	}
	for _, m := range []Member{{UserID: actor.UserID, Role: RoleAdmin}, out} {
		if err := s.announce(ctx, repoID, EventRoleChanged, map[string]string{"user_id": m.UserID, "role": string(m.Role)}); err != nil {
			return out, err
		}
	}
	return out, nil
}

// ---- Sessions -------------------------------------------------------------------------

// SessionClaimTTL is how long a session stays bound to its user after they last
// used it. Editor windows heartbeat every 15 s, so this only lapses for sessions
// that are long gone.
const SessionClaimTTL = 24 * time.Hour

var claimScript = redis.NewScript(`
local cur = redis.call('GET', KEYS[1])
if cur and cur ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`)

// ClaimSession binds a session id to the member who first uses it, so on a
// team repo nobody else can heartbeat as that session or touch its leases.
// It returns false when the session belongs to someone else.
func (s *Store) ClaimSession(ctx context.Context, repoID, sessionID, userID string) (bool, error) {
	n, err := claimScript.Run(ctx, s.rdb, []string{key(repoID, "session:"+sessionID)}, userID, int(SessionClaimTTL.Seconds())).Int()
	return n == 1, err
}

// ---- Events ---------------------------------------------------------------------------

// Team events go out on the repo's event stream (the same channel presence uses),
// so every open stream hears them in order with everything else.
const (
	// EventTeamCreated: the repo just became members-only; open streams without a token close.
	EventTeamCreated = "team.created"
	// EventMemberRemoved: {user_id}; that member's streams close.
	EventMemberRemoved = "team.member_removed"
	// EventMemberJoined: {user_id, role}.
	EventMemberJoined = "team.member_joined"
	// EventRoleChanged: {user_id, role}, also sent for both sides of a transfer.
	EventRoleChanged = "team.role_changed"
)

func eventChannel(repoID string) string {
	return fmt.Sprintf("hivemindide:{%s}:events", repoID)
}

func (s *Store) announce(ctx context.Context, repoID, eventType string, data any) error {
	body, err := json.Marshal(map[string]any{"type": eventType, "at": s.now().UTC(), "data": data})
	if err != nil {
		return err
	}
	return s.rdb.Publish(ctx, eventChannel(repoID), body).Err()
}
