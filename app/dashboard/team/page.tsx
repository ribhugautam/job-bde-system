import { requireAdmin } from "@/lib/infra/session";
import { listUsers } from "@/lib/infra/db/users";
import { listInvites } from "@/lib/infra/db/invites";
import DbErrorNotice from "@/components/DbErrorNotice";
import {
  InviteForm,
  RevokeInviteButton,
  UserControls,
} from "@/components/team/TeamControls";

export const dynamic = "force-dynamic";

function formatDate(date: Date | null): string {
  if (!date) return "never";
  return date.toISOString().slice(0, 10);
}

export default async function TeamPage() {
  // Admin-only, enforced server-side. The nav link is also hidden from members,
  // but a hidden link is decoration — this redirect is the actual control.
  const me = await requireAdmin();

  let data;
  try {
    const [users, invites] = await Promise.all([listUsers(), listInvites()]);
    data = { users, invites };
  } catch (err) {
    return <DbErrorNotice error={err} />;
  }

  const { users, invites } = data;
  const pending = invites.filter((i) => i.state === "valid");

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h2 className="mb-2 text-sm font-semibold text-(--text-muted)">
          Invite someone
        </h2>
        <InviteForm />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-(--text-muted)">
          People ({users.length})
        </h2>
        <div className="rounded border border-(--border)">
          {users.map((user) => (
            <div
              key={user.id}
              className="flex items-center justify-between gap-3 border-b border-(--border) px-3 py-2 last:border-b-0"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-(--text)">
                  {user.name}
                  {user.id === me.id && (
                    <span className="ml-2 text-[11px] text-(--text-faint)">you</span>
                  )}
                  {!user.isActive && (
                    <span className="ml-2 rounded bg-(--neutral-bg) px-1.5 py-0.5 text-[11px] text-(--neutral-fg)">
                      deactivated
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-(--text-dim)">
                  {user.email}
                </div>
                <div className="text-[11px] text-(--text-faint)">
                  last seen {formatDate(user.lastSeenAt)}
                </div>
              </div>
              <UserControls
                userId={user.id}
                role={user.role}
                isActive={user.isActive}
                isSelf={user.id === me.id}
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-(--text-muted)">
          Pending invites ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <p className="text-sm text-(--text-dim)">No outstanding invites.</p>
        ) : (
          <div className="rounded border border-(--border)">
            {pending.map((invite) => (
              <div
                key={invite.id}
                className="flex items-center justify-between gap-3 border-b border-(--border) px-3 py-2 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-(--text)">
                    {invite.email}
                  </div>
                  <div className="text-[11px] text-(--text-faint)">
                    {invite.role} · expires {formatDate(invite.expiresAt)}
                  </div>
                </div>
                <RevokeInviteButton id={invite.id} />
              </div>
            ))}
          </div>
        )}
        {/*
          Only outstanding invites are listed. Accepted ones are represented by
          the account they created, and revoked/expired ones are noise -- their
          rows are kept in the database for the audit trail, not for this page.
        */}
      </div>
    </div>
  );
}
