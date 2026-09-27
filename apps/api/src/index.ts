import "./env.js"

import { applyPendingMigrations } from "./migrate.js"

applyPendingMigrations()
await import("./app.js")
