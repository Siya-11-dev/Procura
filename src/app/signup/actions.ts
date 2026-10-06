"use server";

import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { signupUser } from "@/lib/auth/signup";

export interface SignupState {
  error: string | null;
  fieldErrors: Record<string, string>;
}

export async function signupAction(
  _prev: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const result = signupUser({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    department: formData.get("department"),
    // Read only to be discarded. `signupUser` forces requester regardless, but
    // naming the field here makes it obvious that a hidden `role` input in the
    // browser would have no effect.
    role: formData.get("role"),
  });

  if (!result.ok) {
    return {
      error: result.error,
      fieldErrors: result.fieldErrors ?? {},
    };
  }

  // Sign the new account straight in, so signup is one step rather than two.
  await signIn("credentials", {
    email: result.user.email,
    password: formData.get("password"),
    redirectTo: "/",
  });

  // Unreachable: signIn redirects on success. Redirecting rather than returning
  // success means there is no path that renders "account created" while leaving
  // the browser signed out.
  redirect("/");
}