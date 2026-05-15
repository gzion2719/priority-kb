import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public: unauthenticated by design. Used by container healthchecks and
// uptime probes; Entra ID gating (M5) does not apply here.
export async function GET() {
  try {
    const pool = getPool();
    await pool.query("SELECT 1");
    const ext = await pool.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    const pgvector = ext.rowCount === 1;
    if (!pgvector) {
      return NextResponse.json(
        { ok: false, pgvector: false, error: "vector extension not installed" },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: true, pgvector: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, pgvector: false, error: message }, { status: 503 });
  }
}
