'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import type { User as AuthUser } from '@/lib/auth/types';

interface UserNavProps {
  mobile?: boolean;
  onItemClick?: () => void;
}

interface AuthMeResponse {
  success?: boolean;
  user?: AuthUser;
}

export default function UserNav({ mobile = false, onItemClick }: Readonly<UserNavProps>) {
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => (res.ok ? (res.json() as Promise<AuthMeResponse>) : null))
      .then((data) => {
        if (data?.success && data.user) {
          setUser(data.user);
        }
      })
      .catch(() => {});
  }, []);

  if (mobile) {
    if (user) {
      return (
        <div className="flex items-center justify-between gap-3 py-1">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-full bg-brand-700 text-white flex items-center justify-center text-xs font-bold shrink-0">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <span className="text-sm font-semibold text-brand-950 dark:text-white truncate">{user.name}</span>
            <span className="text-[11px] uppercase font-semibold px-1.5 py-0.5 rounded bg-brand-50 dark:bg-white/10 text-brand-800 dark:text-brand-300 shrink-0">
              {user.tier}
            </span>
          </div>
          <Link
            href="/dashboard"
            onClick={onItemClick}
            className="min-h-[44px] px-3 inline-flex items-center text-sm text-brand-700 dark:text-brand-300 font-semibold rounded-md hover:bg-brand-50 dark:hover:bg-white/5"
          >
            Dashboard
          </Link>
        </div>
      );
    }

    return (
      <div className="grid grid-cols-2 gap-2.5">
        <Link
          href="/auth"
          onClick={onItemClick}
          className="min-h-[44px] inline-flex items-center justify-center px-3 text-sm font-semibold rounded-md border border-neutral-border dark:border-dark-border text-brand-950 dark:text-white hover:bg-neutral-subtle dark:hover:bg-dark-elevated transition-colors"
        >
          Log In
        </Link>
        <Link
          href="/auth?tab=register"
          onClick={onItemClick}
          className="min-h-[44px] inline-flex items-center justify-center px-3 text-sm font-semibold text-white bg-brand-700 hover:bg-brand-800 active:bg-brand-900 rounded-md transition-colors"
        >
          Sign Up
        </Link>
      </div>
    );
  }

  if (user) {
    return (
      <Link
        href="/dashboard"
        className="min-h-[44px] inline-flex items-center gap-2 px-3 rounded-md border border-white/15 bg-white/[0.06] hover:bg-white/[0.12] transition-colors text-xs font-semibold text-white"
      >
        <div className="w-5 h-5 rounded-full bg-brand-700 text-white flex items-center justify-center text-[10px] font-bold shrink-0">
          {user.name.charAt(0).toUpperCase()}
        </div>
        <span>{user.name.split(' ')[0]}</span>
        <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-white/10 text-slate-200">
          {user.tier}
        </span>
      </Link>
    );
  }

  return (
    <>
      <Link
        href="/auth"
        className="min-h-[44px] inline-flex items-center px-3 text-sm font-medium text-slate-200 hover:text-white hover:bg-white/10 rounded-md transition-colors"
      >
        Log In
      </Link>
      <Link
        href="/auth?tab=register"
        className="min-h-[44px] inline-flex items-center px-4 text-sm font-semibold text-white bg-brand-700 hover:bg-brand-800 active:bg-brand-900 rounded-md transition-colors"
      >
        Sign Up
      </Link>
    </>
  );
}
