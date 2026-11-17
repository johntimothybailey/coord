import { setupConvexAuth } from "@convex-dev/auth/server";
import { components } from "./_generated/api.js";

// Browser sessions identify application users; they do not confer Coord roles.
export const authCore = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = authCore;
