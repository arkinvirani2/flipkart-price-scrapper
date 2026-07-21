'use client';

import { LayoutDashboard, Upload } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/', label: 'Batches', icon: LayoutDashboard },
  { href: '/upload', label: 'New batch', icon: Upload },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-card/40">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
          FK
        </div>
        <span className="text-sm font-semibold">Scraper</span>
      </div>

      <nav className="flex flex-col gap-1 p-2">
        {LINKS.map(({ href, label, icon: Icon }) => {
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-secondary font-medium text-secondary-foreground'
                  : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto border-t p-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Runs locally. Keep this machine awake for the duration of a batch.
        </p>
      </div>
    </aside>
  );
}
