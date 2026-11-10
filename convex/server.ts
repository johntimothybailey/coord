import { internalMutationGeneric, internalQueryGeneric, httpActionGeneric, mutationGeneric, queryGeneric } from "convex/server";
import type { DataModelFromSchemaDefinition, GenericMutationCtx, GenericQueryCtx, MutationBuilder, QueryBuilder } from "convex/server";
import type { DocumentByName, TableNamesInDataModel } from "convex/server";
import schema from "./schema.js";
export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export type TableName = TableNamesInDataModel<DataModel>;
export type Doc<T extends TableName> = DocumentByName<DataModel, T>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type QueryCtx = GenericQueryCtx<DataModel>;
export const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
export const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
export const query = queryGeneric as QueryBuilder<DataModel, "public">;

export const internalQuery = internalQueryGeneric as QueryBuilder<DataModel, "internal">;
export const httpAction = httpActionGeneric;
