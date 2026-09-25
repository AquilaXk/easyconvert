import { NextResponse } from 'next/server';
import { getAllFormats, CATEGORIES } from '@/lib/registry';

export async function GET() {
  const formats = getAllFormats();
  return NextResponse.json({
    success: true,
    count: formats.length,
    categories: CATEGORIES,
    formats,
  });
}
