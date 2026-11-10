/** Who is calling the team server. */
export interface Identity {
  /** Stable subject: the IdP `sub`, or `token:<id>` for admin-issued tokens. */
  sub: string;
  email: string;
  name?: string;
  groups: string[];
  admin: boolean;
}

/**
 * ACL check for a team source. Entries: `*` (everyone signed in),
 * `group:<name>`, `user:<email>` or `domain:<acme.com>`. Empty = admins only.
 */
export function canAccess(identity: Identity, allow: string[]): boolean {
  if (identity.admin) return true;
  const email = identity.email.toLowerCase();
  return allow.some((entry) => {
    const e = entry.trim();
    if (e === "*") return true;
    if (e.startsWith("group:")) return identity.groups.includes(e.slice(6));
    if (e.startsWith("user:")) return e.slice(5).toLowerCase() === email;
    if (e.startsWith("domain:")) return email.endsWith(`@${e.slice(7).toLowerCase()}`);
    return false;
  });
}
