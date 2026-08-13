import { LoginForm } from "./LoginForm";
import { safeNextPath } from "@/lib/infra/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-6">
      <LoginForm next={safeNextPath(next)} />
    </div>
  );
}
