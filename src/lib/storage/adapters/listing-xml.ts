import { SaxesParser } from 'saxes';
import { StorageServiceError } from './adapter-interface';
import { declaresDtd } from './s3';

const MAX_XML_ELEMENTS = 50_000;
const MAX_XML_DEPTH = 32;
const MAX_XML_TEXT_CHARS = 16_384;

function localTagName(rawName: string): string {
  const colon = rawName.indexOf(':');
  return colon === -1 ? rawName : rawName.slice(colon + 1);
}

function rejectUnsafeXml(provider: string, message: string): never {
  throw new StorageServiceError(message, provider, { retryable: false });
}

interface XmlWalkCallbacks {
  onOpen?: (path: readonly string[]) => void;
  onTextElement?: (path: readonly string[], text: string) => void;
  onClose?: (path: readonly string[]) => void;
}

function walkBoundedXml(xml: string, provider: string, callbacks: XmlWalkCallbacks): void {
  if (declaresDtd(xml)) {
    rejectUnsafeXml(provider, 'DTD declarations are not permitted in storage listing XML.');
  }
  const parser = new SaxesParser({ xmlns: false, position: true, defaultXMLVersion: '1.0', forceXMLVersion: true });
  const stack: string[] = [];
  let elementCount = 0;
  let captureBuffer = '';

  parser.on('doctype', () => {
    rejectUnsafeXml(provider, 'DTD declarations are not permitted in storage listing XML.');
  });
  parser.on('error', (err) => {
    rejectUnsafeXml(provider, `Malformed XML in storage listing: ${err.message}`);
  });
  parser.on('opentag', (tag) => {
    elementCount++;
    if (elementCount > MAX_XML_ELEMENTS) {
      rejectUnsafeXml(provider, `Storage listing XML exceeded ${MAX_XML_ELEMENTS} elements.`);
    }
    stack.push(localTagName(tag.name));
    if (stack.length > MAX_XML_DEPTH) {
      rejectUnsafeXml(provider, `Storage listing XML exceeded depth ${MAX_XML_DEPTH}.`);
    }
    captureBuffer = '';
    callbacks.onOpen?.(stack);
  });
  parser.on('text', (text) => {
    if (captureBuffer.length + text.length > MAX_XML_TEXT_CHARS) {
      rejectUnsafeXml(provider, `Storage listing XML text node exceeded ${MAX_XML_TEXT_CHARS} characters.`);
    }
    captureBuffer += text;
  });
  parser.on('cdata', (text) => {
    if (captureBuffer.length + text.length > MAX_XML_TEXT_CHARS) {
      rejectUnsafeXml(provider, `Storage listing XML CDATA exceeded ${MAX_XML_TEXT_CHARS} characters.`);
    }
    captureBuffer += text;
  });
  parser.on('closetag', () => {
    callbacks.onTextElement?.(stack, captureBuffer);
    callbacks.onClose?.(stack);
    stack.pop();
    captureBuffer = '';
  });

  parser.write(xml).close();
}

export interface AzureListedBlob {
  name: string;
  size: number;
}

export interface AzureListBlobsPage {
  blobs: AzureListedBlob[];
  nextMarker?: string;
}

function isUnderPath(stack: readonly string[], parent: string, child: string): boolean {
  return stack.length >= 2 && stack[stack.length - 2] === parent && stack[stack.length - 1] === child;
}

export function parseAzureListBlobsXml(xml: string): AzureListBlobsPage {
  const blobs: AzureListedBlob[] = [];
  let nextMarker: string | undefined;
  let current: { name?: string; size?: number } | null = null;

  walkBoundedXml(xml, 'azure-blob', {
    onOpen(stack) {
      if (isUnderPath(stack, 'Blobs', 'Blob')) {
        current = {};
      }
    },
    onTextElement(stack, text) {
      const leaf = stack[stack.length - 1];
      if (stack.length === 2 && stack[0] === 'EnumerationResults' && leaf === 'NextMarker') {
        const trimmed = text.trim();
        if (trimmed) nextMarker = trimmed;
        return;
      }
      if (!current) return;
      if (isUnderPath(stack, 'Blob', 'Name')) {
        current.name = text;
      } else if (isUnderPath(stack, 'Properties', 'Content-Length')) {
        const parsed = Number.parseInt(text.trim(), 10);
        current.size = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      }
    },
    onClose(stack) {
      if (isUnderPath(stack, 'Blobs', 'Blob') && current) {
        if (current.name) {
          blobs.push({ name: current.name, size: current.size ?? 0 });
        }
        current = null;
      }
    },
  });

  return { blobs, nextMarker };
}

export interface WebDavListedEntry {
  href: string;
  isCollection: boolean;
  size: number;
}

export function parseWebDavPropfindXml(xml: string): WebDavListedEntry[] {
  const entries: WebDavListedEntry[] = [];
  let current: { href?: string; isCollection: boolean; size: number } | null = null;

  walkBoundedXml(xml, 'webdav', {
    onOpen(stack) {
      const leaf = stack[stack.length - 1];
      if (stack.length === 2 && stack[0] === 'multistatus' && leaf === 'response') {
        current = { isCollection: false, size: 0 };
        return;
      }
      if (current && stack.includes('resourcetype') && leaf === 'collection') {
        current.isCollection = true;
      }
    },
    onTextElement(stack, text) {
      if (!current) return;
      const leaf = stack[stack.length - 1];
      if (isUnderPath(stack, 'response', 'href')) {
        current.href = text.trim();
      } else if (isUnderPath(stack, 'prop', 'getcontentlength')) {
        const parsed = Number.parseInt(text.trim(), 10);
        if (Number.isFinite(parsed) && parsed >= 0) {
          current.size = parsed;
        }
      }
    },
    onClose(stack) {
      if (stack.length === 2 && stack[0] === 'multistatus' && stack[1] === 'response' && current) {
        if (current.href) {
          entries.push({ href: current.href, isCollection: current.isCollection, size: current.size });
        }
        current = null;
      }
    },
  });

  return entries;
}
