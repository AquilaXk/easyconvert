'use client';

import React, { useState } from 'react';
import { X, Lock, Mail, User, CheckCircle2 } from 'lucide-react';

interface AuthModalProps {
  initialMode?: 'signin' | 'signup';
  onClose: () => void;
  onSuccess: (email: string) => void;
}

export default function AuthModal({
  initialMode = 'signin',
  onClose,
  onSuccess,
}: AuthModalProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [isSubmitted, setIsSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setIsSubmitted(true);
    setTimeout(() => {
      onSuccess(email);
      onClose();
    }, 600);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-brand-950/50 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-md bg-white dark:bg-dark-surface rounded-2xl shadow-2xl border border-neutral-border dark:border-dark-border overflow-hidden">
        {/* Modal Header */}
        <div className="p-5 border-b border-neutral-border dark:border-dark-border flex items-center justify-between">
          <div className="flex gap-4">
            <button
              type="button"
              onClick={() => setMode('signin')}
              className={`text-sm font-bold pb-1 transition-colors ${
                mode === 'signin'
                  ? 'text-brand-700 dark:text-brand-400 border-b-2 border-brand-700 dark:border-brand-400'
                  : 'text-ink-muted hover:text-brand-950 dark:hover:text-dark-text'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => setMode('signup')}
              className={`text-sm font-bold pb-1 transition-colors ${
                mode === 'signup'
                  ? 'text-brand-700 dark:text-brand-400 border-b-2 border-brand-700 dark:border-brand-400'
                  : 'text-ink-muted hover:text-brand-950 dark:hover:text-dark-text'
              }`}
            >
              Create Account
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-ink-muted hover:text-brand-950 dark:hover:text-dark-text hover:bg-neutral-subtle dark:hover:bg-dark-elevated transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        {isSubmitted ? (
          <div className="p-8 text-center space-y-3">
            <CheckCircle2 className="w-10 h-10 text-status-success mx-auto animate-in zoom-in-75 duration-200" />
            <h4 className="text-base font-bold text-brand-950 dark:text-dark-text">
              {mode === 'signin' ? 'Signed in successfully' : 'Account created'}
            </h4>
            <p className="text-xs text-ink-muted">Welcome to EasyConvert.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {mode === 'signup' && (
              <div>
                <label className="block text-xs font-semibold text-brand-950 dark:text-dark-text mb-1">
                  Full Name
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Alex Morgan"
                    className="w-full pl-9 pr-3 py-2 text-xs bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border rounded-xl text-brand-950 dark:text-dark-text focus:outline-none focus:ring-2 focus:ring-brand-600"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-brand-950 dark:text-dark-text mb-1">
                Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="alex@example.com"
                  className="w-full pl-9 pr-3 py-2 text-xs bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border rounded-xl text-brand-950 dark:text-dark-text focus:outline-none focus:ring-2 focus:ring-brand-600"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-brand-950 dark:text-dark-text mb-1">
                Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full pl-9 pr-3 py-2 text-xs bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border rounded-xl text-brand-950 dark:text-dark-text focus:outline-none focus:ring-2 focus:ring-brand-600"
                />
              </div>
            </div>

            <button
              type="submit"
              className="w-full mt-2 py-2.5 text-xs font-bold text-white bg-brand-700 hover:bg-brand-800 active:bg-brand-900 rounded-xl shadow-md shadow-brand-700/20 transition-all"
            >
              {mode === 'signin' ? 'Sign In' : 'Create Free Account'}
            </button>

            <p className="text-[11px] text-center text-ink-muted pt-2">
              By proceeding, you agree to our Terms of Service & Privacy Policy.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
