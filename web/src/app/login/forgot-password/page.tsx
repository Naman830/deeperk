import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { ForgotPasswordForm } from "./forgot-password-form";

// Same server-page + client-form shape as /login and /signup, which also means the
// session guard those two have now applies here — a signed-in user has no business
// in a password-reset flow and is sent back to the app.
export default async function ForgotPasswordPage() {
  const session = await getSession();
  if (session) {
    redirect("/");
  }
  return <ForgotPasswordForm />;
}
