'use client';

import React, { useState, useEffect } from 'react';
import type { User as AuthUser } from '@/lib/auth/types';

interface UserNavProps {
  mobile?: boolean;
  onItemClick?: () => void;
}

export default function UserNav({ mobile = false, onItemClick }: UserNavProps) {
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => {
        if (res.ok) return res.json();
        return null;
      })
      .then((data) => {
        if (data && data.success && data.user) {
          setUser(data.user);
        }
      })
      .catch(() => {});
  }, []);

  if (mobile) {
    if (user) {
      return (
        <div className="flex items-center justify-between px-2 py-1">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-brand-700 text-white flex items-center justify-center text-xs font-bold">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <span className="text-xs font-bold text-ink-primary dark:text-white">{user.name}</span>
            <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-brand-100 dark:bg-white/10 text-brand-700 dark:text-brand-300">
              {user.tier}
            </span>
          </div>
          <a
            href="/dashboard"
            onClick={onItemClick}
            className="text-xs text-brand-700 dark:text-brand-400 font-semibold"
          >
            Dashboard &rarr;
          </a>
        </div>
      );
    }

    return (
      <div className="grid grid-cols-2 gap-2 px-2 pt-1">
        <a
          href="/auth"
          onClick={onItemClick}
          className="py-2 text-center text-xs font-semibold rounded-lg border border-neutral-border dark:border-dark-border text-ink-primary dark:text-white"
        >
          Log In
        </a>
        <a
          href="/auth?tab=register"
          onClick={onItemClick}
          className="py-2 text-center text-xs font-semibold text-white bg-brand-700 rounded-lg shadow-sm"
        >
          Sign Up
        </a>
      </div>
    );
  }

  // Desktop render
  if (user) {
    return (
      <a
        href="/dashboard"
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-neutral-border dark:border-dark-border hover:bg-brand-100/60 dark:hover:bg-white/5 transition-all text-xs font-semibold"
      >
        <div className="w-5 h-5 rounded-full bg-brand-700 text-white flex items-center justify-center text-[10px] font-bold shrink-0">
          {user.name.charAt(0).toUpperCase()}
        </div>
        <span className="text-ink-primary dark:text-white">{user.name.split(' ')[0]}</span>
        <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-brand-100 dark:bg-white/10 text-brand-700 dark:text-brand-300">
          {user.tier}
        </span>
      </a>
    );
  }

  return (
    <>
      <a
        href="/auth"
        className="px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:text-brand-950 dark:text-neutral-300 dark:hover:text-white rounded-lg transition-colors"
      >
        Log In
      </a>
      <a
        href="/auth?tab=register"
        className="px-3.5 py-1.5 text-xs font-semibold text-white bg-brand-700 hover:bg-brand-800 rounded-lg shadow-sm shadow-brand-700/20 transition-all"
      >
        Sign Up
      </a>
    </>
  );
}
