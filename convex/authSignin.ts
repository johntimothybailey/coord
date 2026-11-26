import { setupUsernamePasskey } from "@convex-dev/auth/methods/username-passkey/server";
import { components, internal } from "./_generated/api.js";
import { authCore } from "./authCore.js";

// Login passkeys are owned by Auth's separate component; they confer no
// approval-passkey or human credential authority. No deployment is selected here.
const configured = process.env.CONVEX_SITE_URL;
if (!configured) throw new Error("Connect sign-in requires CONVEX_SITE_URL");
const origin = new URL(configured);
if (origin.protocol !== "https:" || origin.origin !== configured) throw new Error("Connect sign-in requires an exact HTTPS CONVEX_SITE_URL origin");
const method = setupUsernamePasskey(authCore, {
  component: components.authPasskey,
  usernameComponent: components.authUsername,
  rpId: origin.hostname,
  origin: origin.origin,
  rpName: "Coord sign-in",
}).attachUserCallbacks({ createUser: internal.oauthAuthority.createUser });
export const startSignInWithUsernamePasskey = method.startSignInWithUsernamePasskey;
export const finishSignUpWithUsernamePasskey = method.finishSignUpWithUsernamePasskey;
export const finishSignInWithUsernamePasskey = method.finishSignInWithUsernamePasskey;
