import React from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';

export function AuthErrorNotice({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="mb-5 flex items-start gap-3 p-3 rounded-xs bg-danger-soft border border-danger-edge/25 text-danger text-sm">
      <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
      <p role="alert" className="min-w-0">{children}</p>
    </div>
  );
}

export function AuthSuccessNotice({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <output
      aria-live="polite"
      className="mb-5 flex items-start gap-3 p-3 rounded-xs bg-success-soft border border-success-edge/25 text-success text-sm"
    >
      <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
      <span>{children}</span>
    </output>
  );
}
