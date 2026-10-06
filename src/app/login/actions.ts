"use server";

import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";
import { redirect } from "next/navigation";

export interface LoginState {
  error: string | null;
}

/**
 * Credentials login. Errors are deliberately generic regardless of whether the
 * email, the password, or the account status was the problem, so a failed
 * attempt never reveals which half was wrong.
 */
export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = formData.get("email");
  const password = formData.get("password");
  const next = formData.get("next");

  try {
    await signIn("credentials", {
      email,
      password,
      redirectTo: typeof next === "string" && next.startsWith("/") ? next : "/",
    });
    return { error: null };
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "Sign in failed. Check your email and password." };
    }
    throw error;
  }
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
  redirect("/login");
}