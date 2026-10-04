import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function extractPdf(buffer: Buffer): Promise<string> {
  const task = getDocument({ data: new Uint8Array(buffer), verbosity: VerbosityLevel.ERRORS, useSystemFonts: true });
  try {
    const document = await task.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim());
      page.cleanup();
    }
    return pages.join('\n\n');
  } finally { await task.destroy(); }
}
