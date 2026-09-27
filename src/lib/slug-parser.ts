export interface ParsedSlug {
  isInfoPage: boolean;
  infoType?: 'terms' | 'privacy' | 'contact' | 'about' | 'security' | 'forgot-password' | 'status' | 'unit';
  sourceFormat: string;
  targetFormat: string;
  pageTitle: string;
  pageDescription: string;
}

const CANONICAL_FORMAT_MAP: Record<string, string> = {
  // Category fallbacks to universal formats
  video: 'mp4',
  audio: 'mp3',
  image: 'jpg',
  document: 'docx',
  ebook: 'epub',
  archive: 'zip',
  vector: 'svg',
  font: 'ttf',
  cad: 'dxf',
  spreadsheet: 'xlsx',
  presentation: 'pptx',
  data: 'csv',
  // Common format aliases
  word: 'docx',
  excel: 'xlsx',
  powerpoint: 'pptx',
  photo: 'jpg',
  picture: 'jpg',
  music: 'mp3',
};

export function parseConverterSlug(slug: string): ParsedSlug {
  const cleanSlug = slug.toLowerCase().replace(/^\/+/, '').trim();

  // OCR utilities
  if (cleanSlug === 'pdf-ocr' || cleanSlug === 'ocr-pdf' || cleanSlug === 'ocr') {
    return { isInfoPage: false, sourceFormat: 'pdf', targetFormat: 'pdf', pageTitle: 'PDF OCR Converter', pageDescription: 'Optical character recognition utility producing searchable, selectable documents with zero data retention.' };
  }

  // Informational pages
  if (cleanSlug === 'terms') {
    return {
      isInfoPage: true,
      infoType: 'terms',
      sourceFormat: 'pdf',
      targetFormat: 'docx',
      pageTitle: 'Terms of Service',
      pageDescription: 'Review the terms and conditions governing your use of EasyConvert.',
    };
  }
  if (cleanSlug === 'privacy') {
    return {
      isInfoPage: true,
      infoType: 'privacy',
      sourceFormat: 'pdf',
      targetFormat: 'docx',
      pageTitle: 'Privacy Policy',
      pageDescription: 'Learn about our strict zero data retention policy and transient in-memory processing.',
    };
  }
  if (cleanSlug === 'contact') {
    return {
      isInfoPage: true,
      infoType: 'contact',
      sourceFormat: 'pdf',
      targetFormat: 'docx',
      pageTitle: 'Contact Us',
      pageDescription: 'Get in touch with our team for enterprise inquiries, sales, or technical support.',
    };
  }
  if (cleanSlug === 'about') {
    return {
      isInfoPage: true,
      infoType: 'about',
      sourceFormat: 'pdf',
      targetFormat: 'docx',
      pageTitle: 'About Us',
      pageDescription: 'EasyConvert empowers millions of users worldwide with instant, secure file conversions.',
    };
  }
  if (cleanSlug === 'security') {
    return {
      isInfoPage: true,
      infoType: 'security',
      sourceFormat: 'pdf',
      targetFormat: 'docx',
      pageTitle: 'Security Overview',
      pageDescription: 'Explore our volatile memory pipeline, TLS encryption, and zero-storage architecture.',
    };
  }
  if (cleanSlug === 'status') {
    return {
      isInfoPage: true,
      infoType: 'status',
      sourceFormat: 'pdf',
      targetFormat: 'docx',
      pageTitle: 'System Status',
      pageDescription: 'Real-time operational status of EasyConvert browser-edge conversion pipelines.',
    };
  }
  if (cleanSlug === 'forgot-password') {
    return {
      isInfoPage: true,
      infoType: 'forgot-password',
      sourceFormat: 'pdf',
      targetFormat: 'docx',
      pageTitle: 'Reset Password',
      pageDescription: 'Enter your email address to receive password reset instructions.',
    };
  }

  // Format pair converters: [src]-to-[tgt]
  if (cleanSlug.includes('-to-')) {
    const parts = cleanSlug.split('-to-');
    const rawSrc = parts[0]?.trim() || 'pdf';
    const rawTgt = parts[1]?.trim() || 'docx';

    // Unit conversions (e.g. lbs-to-kg, kg-to-lbs, feet-to-meters, meters-to-feet)
    if (
      (rawSrc === 'lbs' && rawTgt === 'kg') ||
      (rawSrc === 'kg' && rawTgt === 'lbs') ||
      (rawSrc === 'feet' && rawTgt === 'meters') ||
      (rawSrc === 'meters' && rawTgt === 'feet')
    ) {
      const srcLabel = rawSrc === 'lbs' ? 'Pounds (lbs)' : rawSrc === 'kg' ? 'Kilograms (kg)' : rawSrc === 'feet' ? 'Feet (ft)' : 'Meters (m)';
      const tgtLabel = rawTgt === 'lbs' ? 'Pounds (lbs)' : rawTgt === 'kg' ? 'Kilograms (kg)' : rawTgt === 'feet' ? 'Feet (ft)' : 'Meters (m)';
      return {
        isInfoPage: true,
        infoType: 'unit',
        sourceFormat: rawSrc,
        targetFormat: rawTgt,
        pageTitle: `${rawSrc.toUpperCase()} to ${rawTgt.toUpperCase()} Unit Converter`,
        pageDescription: `Convert ${srcLabel} to ${tgtLabel} instantly with client-side precision.`,
      };
    }

    const src = CANONICAL_FORMAT_MAP[rawSrc] || rawSrc;
    const tgt = CANONICAL_FORMAT_MAP[rawTgt] || rawTgt;

    const formatTitleName = (raw: string, canonical: string) => {
      if (raw === 'word') return 'Word';
      if (raw === 'excel') return 'Excel';
      if (raw === 'powerpoint') return 'PowerPoint';
      if (raw === 'video') return 'Video';
      if (raw === 'audio') return 'Audio';
      if (raw === 'image') return 'Image';
      if (raw === 'cad') return 'CAD';
      if (raw === 'vector') return 'Vector';
      return canonical.toUpperCase();
    };

    const srcDisplay = formatTitleName(rawSrc, src);
    const tgtDisplay = formatTitleName(rawTgt, tgt);

    return {
      isInfoPage: false,
      sourceFormat: src,
      targetFormat: tgt,
      pageTitle: `${srcDisplay} to ${tgtDisplay} Converter`,
      pageDescription: `EasyConvert offers advanced, high-fidelity ${srcDisplay} to ${tgtDisplay} conversions. We preserve original layouts, fonts, and data formatting straight from your browser.`,
    };
  }

  // Category & Format Converters: [format]-converter
  if (cleanSlug.endsWith('-converter')) {
    const rawFmt = cleanSlug.replace('-converter', '').trim();
    if (rawFmt === 'unit') {
      return {
        isInfoPage: true,
        infoType: 'unit',
        sourceFormat: 'lbs',
        targetFormat: 'kg',
        pageTitle: 'Unit Converter',
        pageDescription: 'Convert weight, length, volume, and data units in real time with client-side zero-latency precision.',
      };
    }

    const src = CANONICAL_FORMAT_MAP[rawFmt] || rawFmt;

    const ACRONYMS: Record<string, string> = {
      pdf: 'PDF',
      docx: 'DOCX',
      doc: 'DOC',
      mp4: 'MP4',
      mp3: 'MP3',
      wav: 'WAV',
      png: 'PNG',
      jpg: 'JPG',
      jpeg: 'JPEG',
      cad: 'CAD',
      ocr: 'OCR',
      csv: 'CSV',
      xlsx: 'XLSX',
      svg: 'SVG',
      xml: 'XML',
      json: 'JSON',
      html: 'HTML',
    };
    const prefix = ACRONYMS[rawFmt] || (rawFmt.charAt(0).toUpperCase() + rawFmt.slice(1));
    return {
      isInfoPage: false,
      sourceFormat: src,
      targetFormat: 'any',
      pageTitle: `${prefix} Converter`,
      pageDescription: `EasyConvert is an online document converter. Amongst many others, we support PDF, DOCX, PPTX, XLSX. Thanks to our advanced conversion technology the quality of the output will be as good as if the file was saved through the latest Microsoft Office suite.`,
    };
  }

  // Utilities: merge-*, compress-*, save-website-*, website-*-screenshot
  if (cleanSlug.startsWith('merge-')) {
    const fmt = cleanSlug.split('-').pop() || 'pdf';
    return {
      isInfoPage: false,
      sourceFormat: fmt,
      targetFormat: fmt,
      pageTitle: `Merge ${fmt.toUpperCase()}`,
      pageDescription: `Merge multiple ${fmt.toUpperCase()} files into a single unified document in seconds. Zero data retention guaranteed.`,
    };
  }

  if (cleanSlug.startsWith('compress-')) {
    const fmt = cleanSlug.split('-').pop() || 'pdf';
    return {
      isInfoPage: false,
      sourceFormat: fmt,
      targetFormat: fmt,
      pageTitle: `Compress ${fmt.toUpperCase()}`,
      pageDescription: `Reduce ${fmt.toUpperCase()} file size while preserving optimum visual fidelity and text sharpness.`,
    };
  }

  if (cleanSlug === 'save-website-as-pdf') {
    return {
      isInfoPage: false,
      sourceFormat: 'html',
      targetFormat: 'pdf',
      pageTitle: 'Save Website as PDF',
      pageDescription: 'Capture high-resolution PDF printouts of any public website URL with CSS and vector graphics intact.',
    };
  }

  if (cleanSlug === 'website-png-screenshot' || cleanSlug === 'website-jpg-screenshot') {
    const outFmt = cleanSlug.includes('png') ? 'png' : 'jpg';
    return {
      isInfoPage: false,
      sourceFormat: 'html',
      targetFormat: outFmt,
      pageTitle: `Website ${outFmt.toUpperCase()} Screenshot`,
      pageDescription: `Render full-page or viewport snapshots of websites in lossless ${outFmt.toUpperCase()} format.`,
    };
  }

  // Default fallback
  const title = cleanSlug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return {
    isInfoPage: false,
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: `${title} Converter`,
    pageDescription: `Convert ${title} files instantly in your browser with zero data retention.`,
  };
}
