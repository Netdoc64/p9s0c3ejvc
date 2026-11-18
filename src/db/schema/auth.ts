import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const auth_authenticators = sqliteTable(
  "auth_authenticators",
  {
    id: text("id").primaryKey(),
    customer_id: text("customer_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    type: text("type").notNull(),
    identifier: text("identifier").notNull(),
    secret_hash: text("secret_hash"),
    created_at: text("created_at").notNull(),
    last_used_at: text("last_used_at"),
    revoked_at: text("revoked_at"),
  },
  (t) => ({
    by_customer: index("idx_auth_authenticators_customer").on(t.customer_id),
    uniq_identifier: uniqueIndex("uniq_auth_identifier_per_tenant").on(t.tenant_id, t.type, t.identifier).where(sql`${t.revoked_at} IS NULL`),
  }),
);

export const auth_magic_link_tokens = sqliteTable(
  "auth_magic_link_tokens",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    customer_id: text("customer_id").notNull(),
    email: text("email").notNull(),
    code_hash: text("code_hash").notNull(),
    expires_at: text("expires_at").notNull(),
    consumed_at: text("consumed_at"),
    attempts: integer("attempts").notNull().default(0),
    created_at: text("created_at").notNull(),
  },
  (t) => ({ by_customer_active: index("idx_magic_link_customer_active").on(t.customer_id, t.consumed_at, t.expires_at) }),
);

export const auth_authorization_codes = sqliteTable("auth_authorization_codes", {
  code_hash: text("code_hash").primaryKey(),
  tenant_id: text("tenant_id").notNull(),
  customer_id: text("customer_id").notNull(),
  client_id: text("client_id").notNull(),
  redirect_uri: text("redirect_uri"),
  code_challenge: text("code_challenge").notNull(),
  code_challenge_method: text("code_challenge_method").notNull(),
  scope: text("scope").notNull(),
  expires_at: text("expires_at").notNull(),
  consumed_at: text("consumed_at"),
  created_at: text("created_at").notNull(),
});

export const auth_refresh_tokens = sqliteTable(
  "auth_refresh_tokens",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    customer_id: text("customer_id").notNull(),
    token_hash: text("token_hash").notNull().unique(),
    client_id: text("client_id"),
    scope: text("scope").notNull(),
    parent_id: text("parent_id"),
    family_id: text("family_id").notNull(),
    issued_at: text("issued_at").notNull(),
    expires_at: text("expires_at").notNull(),
    rotated_at: text("rotated_at"),
    revoked_at: text("revoked_at"),
    revoke_reason: text("revoke_reason"),
  },
  (t) => ({
    by_customer: index("idx_refresh_customer").on(t.customer_id),
    by_family: index("idx_refresh_family").on(t.family_id),
  }),
);

export type Authenticator = typeof auth_authenticators.$inferSelect;
export type MagicLinkToken = typeof auth_magic_link_tokens.$inferSelect;
export type AuthorizationCode = typeof auth_authorization_codes.$inferSelect;
export type RefreshToken = typeof auth_refresh_tokens.$inferSelect;
