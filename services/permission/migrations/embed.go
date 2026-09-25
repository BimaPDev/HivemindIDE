// Package migrations embeds the SQL schema files so the binary can apply them
// without needing the source tree at runtime.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
