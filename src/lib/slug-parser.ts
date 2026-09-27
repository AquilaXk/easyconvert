import { FORMAT_REGISTRY } from './registry';

export interface ParsedSlug {
  isInfoPage: boolean;
  infoType?: 'terms' | 'privacy' | 'contact' | 'about' | 'security' | 'status' | 'unit';
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
      pageDescription: 'Get in touch with our team for questions, feedback, or open-source issues.',
    };
  }
  if (cleanSlug === 'about') {
    return {
      isInfoPage: true,
      infoType: 'about',
      sourceFormat: 'pdf',
      targetFormat: 'docx',
      pageTitle: 'About Us',
      pageDescription: 'EasyConvert provides free, private, client-side file and data conversions directly in your browser.',
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
      pageDescription: 'Real-time operational status and diagnostics of EasyConvert browser-edge conversion pipelines.',
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
        pageDescription: `Convert ${srcLabel} to ${tgtLabel} in real time with instant calculation precision.`,
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

    const getPairDescription = (srcD: string, tgtD: string, s: string, t: string) => {
      const srcCat = FORMAT_REGISTRY[s]?.category || 'document';
      const tgtCat = FORMAT_REGISTRY[t]?.category || 'document';

      if (srcCat === 'video' && tgtCat === 'audio') {
        return `Convert ${srcD} to ${tgtD} online and free. Extract clean, high-fidelity audio from video files directly in your browser with zero server storage.`;
      }
      if (srcCat === 'audio' || tgtCat === 'audio' || srcCat === 'video' || tgtCat === 'video') {
        return `Convert ${srcD} to ${tgtD} online and free. Fast, high-fidelity media transcoding directly in your browser with zero server retention.`;
      }
      if (srcCat === 'image' || srcCat === 'vector' || tgtCat === 'image' || tgtCat === 'vector') {
        return `Convert ${srcD} to ${tgtD} online and free. High-precision rendering and lossless rasterization straight from your browser.`;
      }
      if (srcCat === 'archive' || tgtCat === 'archive') {
        return `Convert and extract ${srcD} to ${tgtD} archives safely in your browser with zero cloud storage.`;
      }
      if (srcCat === 'spreadsheet' || srcCat === 'data' || tgtCat === 'spreadsheet' || tgtCat === 'data') {
        return `Convert ${srcD} to ${tgtD} datasets and tables directly in your browser. Clean data structure preserved with zero retention.`;
      }
      return `Convert ${srcD} to ${tgtD} online and free. High-fidelity document conversion preserving layouts, formatting, and typography with zero server storage.`;
    };

    return {
      isInfoPage: false,
      sourceFormat: src,
      targetFormat: tgt,
      pageTitle: `${srcDisplay} to ${tgtDisplay} Converter`,
      pageDescription: getPairDescription(srcDisplay, tgtDisplay, src, tgt),
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
        pageDescription: 'Convert weight, length, volume, and data units in real time with instant calculation precision.',
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

    const getFormatDescription = (p: string, s: string) => {
      const cat = FORMAT_REGISTRY[s]?.category || 'document';
      switch (cat) {
        case 'audio':
          return `Convert ${p} audio files online and free to MP3, WAV, AAC, and more. High-fidelity audio encoding with zero server storage.`;
        case 'video':
          return `Convert ${p} video files online and free to MP4, WebM, AVI, and other media formats directly in your browser.`;
        case 'image':
        case 'vector':
          return `Convert ${p} files online and free to PNG, JPG, WebP, SVG, and other graphic formats with lossless visual quality.`;
        case 'archive':
          return `Convert and extract ${p} compressed archives safely in your browser with zero cloud uploads.`;
        case 'spreadsheet':
        case 'data':
          return `Convert ${p} spreadsheets and datasets to CSV, Excel, JSON, and other structured formats with high precision.`;
        case 'presentation':
          return `Convert ${p} presentation slides to PDF, PPTX, images, and other formats with preserved layouts.`;
        case 'ebook':
          return `Convert ${p} ebooks to EPUB, PDF, MOBI, and other reader formats seamlessly in your browser.`;
        default:
          return `Convert ${p} documents online and free to PDF, DOCX, and other formats. Preserves layouts, typography, and tables with zero server storage.`;
      }
    };

    return {
      isInfoPage: false,
      sourceFormat: src,
      targetFormat: 'any',
      pageTitle: `${prefix} Converter`,
      pageDescription: getFormatDescription(prefix, src),
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
