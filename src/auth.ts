import Credentials from "next-auth/providers/credentials";
import NextAuth from "next-auth";
import { CredentialsSignin } from "next-auth";
import { z } from "zod";
import { findUserByEmail, verifyPassword, getUser } from "@/lib/auth/users";

export const AUTH_TAG = "Procura session";
export const AUTH_COOKIE = "procura.session";

class InvalidCredentialsError extends CredentialsSignin {
  code = "invalid_credentials";
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

interface ProcuraUser {
  id: string;
  name: string;
  email: string;
  role: string;
  department: string | null;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Work email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) throw new InvalidCredentialsError();
        const { email, password } = parsed.data;

        const row = findUserByEmail(email);
        if (!row || !verifyPassword(row.password_hash, password)) {
          throw new InvalidCredentialsError();
        }

        const user = getUser(row.id);
        if (!user || !user.active) throw new InvalidCredentialsError();

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          department: user.department,
        } as ProcuraUser;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const procura = user as unknown as ProcuraUser;
        token.role = procura.role;
        token.department = procura.department ?? null;
        token.userId = procura.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token) {
        session.user.id = (token.userId as string) ?? "";
        session.user.role = (token.role as string) ?? "requester";
        session.user.department = (token.department as string | null) ?? null;
      }
      return session;
    },
  },
});

export function actorFromSession(session: { user?: { id?: string; name?: string; role?: string } } | null) {
  if (!session?.user) return null;
  return {
    id: session.user.id ?? "anonymous",
    name: session.user.name ?? "Unknown user",
    role: session.user.role ?? "requester",
  };
}