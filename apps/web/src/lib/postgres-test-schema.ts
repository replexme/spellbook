import postgres from "postgres";

// Set the schema on every connection, before the application pool opens.
// A one-session SET does not isolate concurrent integration tests.
export async function isolatedPostgresTestUrl(schema: string): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  if (!/^[a-z_][a-z0-9_]*$/.test(schema))
    throw new Error("Invalid integration test schema name.");
  const administrator = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await administrator.unsafe(`create schema "${schema}"`);
  } finally {
    await administrator.end();
  }
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.searchParams.set("options", `-csearch_path=${schema}`);
  return isolatedUrl.toString();
}
