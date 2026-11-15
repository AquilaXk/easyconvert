/** A Markdown file imported with `?raw`: its text, as the bundler's source asset (next.config.mjs) and Vite give it. */
declare module '*.md?raw' {
  const text: string;
  export default text;
}

declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs';
