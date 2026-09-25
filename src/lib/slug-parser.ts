export interface ParsedSlug {
  isInfoPage: boolean;
  infoType?: 'terms' | 'privacy' | 'contact' | 'about' | 'security' | 'forgot-password';
  sourceFormat: string;
  targetFormat: string;
  pageTitle: string;
  pageDescription: string;
}

export function parseConverterSlug(slug: string): ParsedSlug {
  const cleanSlug = slug.toLowerCase().trim();

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
    const src = parts[0]?.trim() || 'pdf';
    const tgt = parts[1]?.trim() || 'docx';
    return {
      isInfoPage: false,
      sourceFormat: src,
      targetFormat: tgt,
      pageTitle: `${src.toUpperCase()} to ${tgt.toUpperCase()} Converter`,
      pageDescription: `EasyConvert offers advanced, high-fidelity ${src.toUpperCase()} to ${tgt.toUpperCase()} conversions. We preserve original layouts, fonts, and data formatting straight from your browser.`,
    };
  }

  // Category & Format Converters: [format]-converter
  if (cleanSlug.endsWith('-converter')) {
    const rawFmt = cleanSlug.replace('-converter', '').trim();
    let src = rawFmt;
    if (rawFmt === 'video') src = 'mp4';
    else if (rawFmt === 'audio') src = 'mp3';
    else if (rawFmt === 'image') src = 'png';
    else if (rawFmt === 'document') src = 'docx';
    else if (rawFmt === 'ebook') src = 'epub';
    else if (rawFmt === 'archive') src = 'zip';

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
