import { NextRequest, NextResponse } from 'next/server';
import { getAllFormats, getFormatByExtension, CATEGORIES } from '@/lib/registry';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { ENGINE_NAMES, isEngineId } from '@/lib/conversions/engine-ids';
import { describeEngines, enginesForPair, installedEngineVersion, isEngineInstalled } from '@/worker/engine-registry';

export const dynamic = 'force-dynamic';

const HTTP_BAD_REQUEST = 400;

/** The engines of one pair, each with its installed version and whether its program is installed here. */
async function pairEntry(source: string, target: string) {
  const engines = await Promise.all(
    enginesForPair(source, target).map(async ({ id, default: isDefault }) => {
      const version = await installedEngineVersion(id);
      return { id, name: ENGINE_NAMES[id], ...(version === undefined ? {} : { version }), default: isDefault, available: isEngineInstalled(id) };
    })
  );
  return { source, target, engines };
}

/**
 * The format catalogue, with the engines of the deployment. `source` and `target` (formats by extension) list the engines of each pair
 * they select, and `engine` keeps the pairs that list it: `?source=docx&target=pdf` is one pair, `?source=pdf` every target of PDF.
 */
export async function GET(req: NextRequest) {
  const formats = getAllFormats();
  const engines = await describeEngines();
  const params = req.nextUrl.searchParams;
  const sourceParam = params.get('source');
  const targetParam = params.get('target');
  const engineParam = params.get('engine');
  const body = { success: true, count: formats.length, categories: CATEGORIES, formats, engines };
  if (sourceParam === null && targetParam === null && engineParam === null) return NextResponse.json(body);

  const instance = req.nextUrl.pathname;
  const source = sourceParam === null ? undefined : getFormatByExtension(sourceParam);
  if (sourceParam !== null && !source) return createProblemDetailsResponse(HTTP_BAD_REQUEST, `Unknown source format "${sourceParam}".`, instance);
  const target = targetParam === null ? undefined : getFormatByExtension(targetParam);
  if (targetParam !== null && !target) return createProblemDetailsResponse(HTTP_BAD_REQUEST, `Unknown target format "${targetParam}".`, instance);
  if (engineParam !== null && !isEngineId(engineParam)) {
    return createProblemDetailsResponse(HTTP_BAD_REQUEST, `Unknown engine "${engineParam}".`, instance, undefined, undefined, undefined, undefined, { engines: engines.map((e) => e.id) });
  }

  const pairs = [];
  for (const def of source ? [source] : formats) {
    for (const targetId of def.targetFormats) {
      if (target && targetId !== target.id) continue;
      const entry = await pairEntry(def.id, targetId);
      if (engineParam === null || entry.engines.some((e) => e.id === engineParam)) pairs.push(entry);
    }
  }
  return NextResponse.json({ ...body, pairs });
}
