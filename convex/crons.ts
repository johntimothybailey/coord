import { cronJobs, makeFunctionReference } from "convex/server";
const crons = cronJobs();
crons.interval("bounded expiry sweep", { seconds: 60 }, makeFunctionReference<"mutation", Record<string, never>>("lifecycle:sweep"), {});
crons.interval("bounded dependency sweep", { seconds: 60 }, makeFunctionReference<"mutation", { cursor?: string }>("lifecycle:sweepDependencies"), {});
export default crons;
