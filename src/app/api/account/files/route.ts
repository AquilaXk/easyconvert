import { NextRequest, NextResponse } from 'next/server';
import { resolveDashboardCaller } from '@/lib/api/dashboard-refusal';
import { listAccountFiles } from '@/lib/dashboard/account-files';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const caller = await resolveDashboardCaller(req, { action: 'list converted files', scope: 'storage:download' });
  if ('refused' in caller) return caller.refused;

  return NextResponse.json({
    success: true,
    files: await listAccountFiles(caller.user.id),
  });
}
