import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  describeAuthConfig,
  getAuthConfig,
  verifySessionToken,
} from "@/lib/infra/auth";

/**
 * Deny by default.
 *
 * The matcher below covers EVERY route except Next's own static assets, so any
 * page or API route added later is gated automatically. Public paths are an
 * explicit allow-list in `isPublic` - adding to it is the one place where you
 * can accidentally expose the dashboard, so keep it short.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

/**
 * Exported solely so tests can assert what is and is not reachable without a
 * session. This list is the single place a route can be exposed by accident,
 * and it had no coverage until a dashboard-triggered pipeline run made the
 * distinction load-bearing: /api/cron/daily is public and guarded by
 * CRON_SECRET, while /api/actions/run-pipeline does the same work guarded only
 * by the session. Getting those two confused would put an unauthenticated
 * "send real email" button on the internet.
 */
export function isPublic(pathname: string): boolean {
  // The login screen and the endpoints that issue/clear the cookie.
  if (pathname === "/login") return true;
  if (pathname === "/api/auth/login") return true;
  if (pathname === "/api/auth/logout") return true;
  // Vercel Cron cannot carry a browser cookie. This route does its own
  // fail-closed CRON_SECRET bearer check - see app/api/cron/daily/route.ts.
  if (pathname.startsWith("/api/cron/")) return true;
  return false;
}

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  const auth = getAuthConfig();
  if (!auth) {
    // APP_PASSWORD / AUTH_SECRET missing or too weak. Serve nothing rather than
    // falling open - including the login page, which could not work anyway.
    if (pathname.startsWith("/api/cron/")) return NextResponse.next();

    // Say WHICH variable is wrong and why. The previous message named both
    // variables unconditionally, so a deployment whose password was merely too
    // short read as "you forgot to set these" - advice the operator had already
    // followed. See the disclosure note on describeAuthConfig().
    const report = describeAuthConfig();
    const detail = report.ok
      ? "Auth configuration could not be validated."
      : report.message;

    return new NextResponse(
      isApi
        ? JSON.stringify({ error: "auth not configured", detail })
        : `Auth is not configured on this deployment.\n\n${detail}\n\n` +
            `Set these in your .env for local development, or in Vercel's ` +
            `Project Settings -> Environment Variables and redeploy.`,
      {
        status: 503,
        headers: { "content-type": isApi ? "application/json" : "text/plain" },
      }
    );
  }

  if (isPublic(pathname)) return NextResponse.next();

  const ok = await verifySessionToken(
    req.cookies.get(SESSION_COOKIE)?.value,
    auth.secret
  );
  if (ok) return NextResponse.next();

  // API callers get JSON: the dashboard's fetch() calls parse res.json(), and a
  // 307 to an HTML login page would blow up there with a confusing parse error.
  if (isApi) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}
