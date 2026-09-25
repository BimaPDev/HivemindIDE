-- Permission filter service schema.
-- Applied automatically on startup; see internal/store/migrate.go.

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY,
    name          TEXT NOT NULL,
    auth_identity TEXT NOT NULL UNIQUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repos (
    id         UUID PRIMARY KEY,
    name       TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
    id      UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    UNIQUE (repo_id, name)
);

-- Rules are replaced wholesale when a role is upserted, so there is no natural
-- key beyond (role_id, pattern) and no need for a stable rule id.
CREATE TABLE IF NOT EXISTS permissions (
    role_id      UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    path_pattern TEXT NOT NULL,
    access_level TEXT NOT NULL CHECK (access_level IN ('read', 'write', 'none')),
    PRIMARY KEY (role_id, path_pattern)
);

-- One role per user per repo: the filter has to resolve to a single rule set,
-- and "union of two roles" is a policy question the MVP does not answer.
CREATE TABLE IF NOT EXISTS memberships (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_id UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, repo_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    id                 UUID PRIMARY KEY,
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_id            UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    editor_instance_id TEXT NOT NULL,
    started_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permissions_role ON permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_memberships_repo ON memberships(repo_id);
CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo_id);
