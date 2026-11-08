'use client';

import { useEffect, useRef, useState } from 'react';
import { conversionFailureOf, type ConversionFailure } from '@/lib/conversion-failure';
import { releaseToolResult, runToolRequest, type ToolResult } from '@/lib/tools/tool-client';
import { defaultToolOptions, type WebTool, type WebToolOptions } from '@/lib/tools/tool-names';

export interface ToolFileItem {
  id: string;
  file: File;
}

export type ToolPhase = 'idle' | 'running' | 'done' | 'failed';

const PDF_NAME = /\.pdf$/i;
const ARCHIVE_NAME = /\.(zip|7z|rar|tar|tar\.gz|tgz)$/i;
/** The tools that take one file: a new file replaces the one before. */
const SINGLE_FILE_TOOLS: ReadonlySet<WebTool> = new Set<WebTool>(['archive-extract', 'split', 'rotate']);

/** Whether `tool` takes a file of this name: PDFs for the PDF tools, archives for extract, anything for create. */
export function toolAccepts(tool: WebTool, name: string): boolean {
  if (tool === 'archive-create') return true;
  return (tool === 'archive-extract' ? ARCHIVE_NAME : PDF_NAME).test(name);
}

export function isSingleFileTool(tool: WebTool): boolean {
  return SINGLE_FILE_TOOLS.has(tool);
}

function newItem(file: File): ToolFileItem {
  return { id: typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${file.name}`, file };
}

/** The state of one tool page: the files in order, the tool's options, and the one run on them. */
export function useToolRun(tool: WebTool) {
  const [items, setItems] = useState<ToolFileItem[]>([]);
  const [options, setOptions] = useState<WebToolOptions>(() => defaultToolOptions(tool));
  const [phase, setPhase] = useState<ToolPhase>('idle');
  const [result, setResult] = useState<ToolResult | null>(null);
  const [failure, setFailure] = useState<ConversionFailure | null>(null);
  const [skipped, setSkipped] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const shown = useRef<ToolResult | null>(null);

  const forget = () => {
    if (shown.current) releaseToolResult(shown.current);
    shown.current = null;
    setResult(null);
    setFailure(null);
    setPhase('idle');
  };

  useEffect(() => () => {
    controller.current?.abort();
    if (shown.current) releaseToolResult(shown.current);
  }, []);

  const add = (files: File[]) => {
    const accepted = files.filter((file) => toolAccepts(tool, file.name));
    setSkipped(files.length - accepted.length);
    if (accepted.length === 0) return;
    forget();
    setItems((current) => (isSingleFileTool(tool) ? [newItem(accepted[0])] : [...current, ...accepted.map(newItem)]));
  };

  const remove = (id: string) => {
    forget();
    setItems((current) => current.filter((item) => item.id !== id));
  };

  const move = (id: string, delta: -1 | 1) => {
    forget();
    setItems((current) => {
      const from = current.findIndex((item) => item.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  };

  const clear = () => {
    controller.current?.abort();
    forget();
    setItems([]);
    setSkipped(0);
  };

  const changeOptions = (next: WebToolOptions) => {
    forget();
    setOptions(next);
  };

  const run = async () => {
    const abort = new AbortController();
    controller.current = abort;
    forget();
    setPhase('running');
    try {
      const answer = await runToolRequest(tool, items.map((item) => item.file), options, abort.signal);
      if (abort.signal.aborted) {
        releaseToolResult(answer);
        return;
      }
      shown.current = answer;
      setResult(answer);
      setPhase('done');
    } catch (error: unknown) {
      if (abort.signal.aborted) return;
      setFailure(conversionFailureOf(error));
      setPhase('failed');
    }
  };

  return { items, options, phase, result, failure, skipped, add, remove, move, clear, setOptions: changeOptions, run };
}
