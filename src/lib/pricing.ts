export interface TierData {
  credits: number;
  packagePrice: number;
  subPrice: number;
}

export const TIERS: TierData[] = [
  { credits: 500, packagePrice: 9.0, subPrice: 8.0 },
  { credits: 1000, packagePrice: 18.0, subPrice: 10.0 },
  { credits: 2500, packagePrice: 42.0, subPrice: 24.0 },
  { credits: 5000, packagePrice: 79.0, subPrice: 45.0 },
  { credits: 10000, packagePrice: 149.0, subPrice: 85.0 },
  { credits: 25000, packagePrice: 349.0, subPrice: 195.0 },
  { credits: 50000, packagePrice: 649.0, subPrice: 360.0 },
  { credits: 100000, packagePrice: 1199.0, subPrice: 650.0 },
  { credits: 250000, packagePrice: 2799.0, subPrice: 1500.0 },
  { credits: 500000, packagePrice: 5199.0, subPrice: 2800.0 },
  { credits: 1000000, packagePrice: 9499.0, subPrice: 5200.0 },
];

export function calculateBaseCredits(operation: string, inputFmt?: string, outputFmt?: string): number {
  if (operation !== 'convert') {
    return 1; // Compress, thumbnail, capture website, merge all have base cost 1
  }
  const inExt = inputFmt?.toLowerCase().trim();
  const outExt = outputFmt?.toLowerCase().trim();

  const isOffice = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(inExt || '');
  const isiWork = ['pages', 'numbers', 'key'].includes(inExt || '');

  if (isOffice && outExt === 'pdf') return 2;
  if (isiWork && outExt === 'pdf') return 2;
  if (inExt === 'pdf' && ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'].includes(outExt || '')) return 4;

  return 1;
}
