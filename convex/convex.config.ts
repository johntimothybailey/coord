import { defineApp } from "convex/server";
import auth from "@convex-dev/auth/convex.config.js";
import mcp from "@convex-dev/mcp/convex.config.js";

const app = defineApp();
app.use(auth);
app.use(mcp);
export default app;
