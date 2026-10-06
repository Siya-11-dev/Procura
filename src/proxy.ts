import { NextResponse } from "next/server";
import { auth } from "@/auth";
import type { NextAuthRequest } from "next-auth";

const PUBLIC = [
  "/login",
  "/signup",
  "/portal",
  "/api/auth",
  "/_next",
  "/favicon.ico",
];

function isPublic(pathname: string): boolean {
  return PUBLIC.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Optimistic gate only. It decides who may enter the app by reading the JWT in
 * the session cookie; it performs no database lookups. Every sensitive mutation
 * is re-authorised inside its own server action or route handler, because proxy
 * coverage silently disappears for server functions on excluded paths.
 */
export const proxy = auth((request: NextAuthRequest) => {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const session = request.auth;
  if (!session?.user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};