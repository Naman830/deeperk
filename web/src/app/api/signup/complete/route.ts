import { cookies } from "next/headers";
import { getIp } from "better-auth/api";
import { auth } from "@/lib/auth/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyRegistrationToken, REGISTRATION_TOKEN_COOKIE } from "@/lib/auth/registration-token";
import { signupCompleteSchema, toCanonicalUsername } from "@/lib/validation/signup";

const ACCOUNT_CREATION_RATE_LIMIT = { windowSeconds: 60 * 60, max: 3 }; // 3/hr per IP

// Final step of signup (Docs/user/auth.md §2): the `user` row is only ever
// written here, in the one call to Better Auth's own signUpEmail — nothing
// upstream of this route touches Better Auth at all (decision #1).
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const email = await verifyRegistrationToken(cookieStore.get(REGISTRATION_TOKEN_COOKIE)?.value);
  if (!email) {
    return Response.json(
      { error: "Your signup session expired. Please start over." },
      { status: 401 },
    );
  }

  const ip = getIp(request, auth.options) ?? "unknown";
  const ok = await checkRateLimit(`signup-create:${ip}`, ACCOUNT_CREATION_RATE_LIMIT.windowSeconds, ACCOUNT_CREATION_RATE_LIMIT.max);
  if (!ok) {
    return Response.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const parsed = signupCompleteSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Please check the form and try again." }, { status: 400 });
  }
  const { firstName, lastName, username: displayUsername, birthDate, password } = parsed.data;
  const username = toCanonicalUsername(displayUsername);
  const name = lastName ? `${firstName} ${lastName}` : firstName;

  try {
    const response = await auth.api.signUpEmail({
      body: {
        name,
        email,
        password,
        firstName,
        lastName: lastName || undefined,
        username,
        displayUsername,
        birthDate: new Date(birthDate),
      },
      asResponse: true,
    });

    if (!response.ok) {
      // Race condition (duplicate email/username slipped past the earlier
      // checks) or another Better Auth-side rejection — doc-mandated
      // generic message, never Better Auth's raw error internals.
      return Response.json({ error: "Something went wrong. Please try again." }, { status: 400 });
    }

    // Forward Better Auth's Set-Cookie (new session) through by returning its
    // Response directly, and clear the now-consumed registration token via
    // cookies() — Next.js Route Handlers merge cookies()-queued mutations
    // into whatever Response the handler returns, even a raw one built
    // outside NextResponse, so both cookies should land in one reply.
    // Pinned by tests/specs/10-auth.spec.ts's full-OTP signup test (runs when
    // TEST_EMAIL is set): both cookies land in the one forwarded Response.
    cookieStore.delete(REGISTRATION_TOKEN_COOKIE);
    return response;
  } catch {
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
