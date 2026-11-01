/** The request body as a JSON object; null for a body that is not JSON or is JSON of another kind (`null`, an array, a number). */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await req.json().catch(() => null);
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}
