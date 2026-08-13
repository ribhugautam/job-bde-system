import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, getAuthConfig, verifySessionToken } from "@/lib/auth";

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

function isPublic(pathname: string): boolean {
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
    return new NextResponse(
      isApi
        ? JSON.stringify({ error: "auth not configured" })
        : "Auth is not configured on this deployment. Set APP_PASSWORD and AUTH_SECRET.",
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
