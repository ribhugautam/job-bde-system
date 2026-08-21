import { lookupInvite } from "@/lib/infra/db/invites";
import DbErrorNotice from "@/components/DbErrorNotice";
import { AcceptForm } from "./AcceptForm";

export const dynamic = "force-dynamic";

export default async function InvitePage({
  params,
}: PageProps<"/invite/[token]">) {
  const { token } = await params;

  // Same pattern as every dashboard page: only the data fetch goes in the try.
  // React defers rendering, so a try/catch around a returned JSX tree would not
  // catch render errors anyway.
  let lookup;
  try {
    lookup = await lookupInvite(token);
  } catch (err) {
    return <DbErrorNotice error={err} />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-6">
      {lookup.ok ? (
        <AcceptForm token={token} email={lookup.email} />
      ) : (
        <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <h1 className="text-lg font-semibold text-neutral-100">
            This invite can&apos;t be used
          </h1>
          {/*
            The specific reason is shown deliberately. All three states
            (expired / already used / withdrawn) are things the holder needs to
            act on differently, and none of them reveals anything they did not
            already have — they are holding the token.
          */}
          <p className="mt-2 text-sm text-neutral-400">{lookup.error}</p>
          <a
            href="/login"
            className="mt-4 inline-block text-xs text-neutral-500 underline hover:text-neutral-300"
          >
            Go to sign in
          </a>
        </div>
      )}
    </div>
  );
}
