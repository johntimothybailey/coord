import { defineApp } from "convex/server";
import auth from "@convex-dev/auth/convex.config.js";
import authPasskey from "@convex-dev/auth/components/passkey/convex.config.js";
import authUsername from "@convex-dev/auth/components/username/convex.config.js";
import mcp from "@convex-dev/mcp/convex.config.js";

const app = defineApp();
app.use(auth);
app.use(authPasskey);
app.use(authUsername);
app.use(mcp);
export default app;
