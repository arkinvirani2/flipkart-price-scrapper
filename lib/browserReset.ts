/**
 * The browser half of the factory reset.
 *
 * The server can delete every file it wrote and still leave the dashboard
 * looking exactly as it did, because the tab in front of the user is holding
 * its own copies: React Query's cache, the sidebar's collapsed flag in
 * localStorage, whatever a service worker decided to keep. Those are what make
 * a reset feel like it did not work.
 *
 * Every step is individually guarded. These APIs throw rather than return false
 * when a browser is in private mode or the user has blocked site data, and a
 * reset that already cleared the server must not report failure because
 * `caches` was unavailable.
 */

export interface BrowserResetReport {
  /** Storage areas actually cleared, for the confirmation message. */
  cleared: string[];
  /** Named rather than swallowed, so a stubborn browser is visible. */
  warnings: string[];
}

export async function clearBrowserState(): Promise<BrowserResetReport> {
  const cleared: string[] = [];
  const warnings: string[] = [];

  const step = async (label: string, action: () => void | Promise<void>): Promise<void> => {
    try {
      await action();
      cleared.push(label);
    } catch (error) {
      warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await step('local storage', () => window.localStorage.clear());
  await step('session storage', () => window.sessionStorage.clear());
  await step('cookies', clearCookies);
  await step('cached responses', clearCacheStorage);
  await step('IndexedDB', clearIndexedDb);
  await step('service workers', unregisterServiceWorkers);

  return { cleared, warnings };
}

/**
 * Expire every cookie readable from script, at every path prefix of this page.
 *
 * A cookie can only be deleted by setting it again with the same path, and the
 * path it was written at is not readable — so the walk up the path segments is
 * how a cookie set at `/jobs` gets cleared from `/`. HttpOnly cookies are
 * invisible here by design; this app sets none.
 */
function clearCookies(): void {
  const paths = ['/'];
  let prefix = '';
  for (const segment of window.location.pathname.split('/').filter(Boolean)) {
    prefix += `/${segment}`;
    paths.push(prefix);
  }

  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0]?.trim();
    if (!name) continue;
    for (const path of paths) {
      document.cookie = `${name}=; path=${path}; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    }
  }
}

async function clearCacheStorage(): Promise<void> {
  if (!('caches' in window)) return;
  const keys = await caches.keys();
  await Promise.all(keys.map((key) => caches.delete(key)));
}

/**
 * Drop every IndexedDB database this origin owns.
 *
 * `databases()` is unavailable on Firefox, where there is no way to enumerate
 * them; nothing in this app writes to IndexedDB, so the sweep is here to catch
 * what a library might have left rather than anything we put there ourselves,
 * and skipping it on those browsers is the right trade.
 *
 * A delete blocked by another open tab is not awaited forever — it resolves on
 * `blocked` too, because the reload that follows closes this tab's handles and
 * the delete completes on its own.
 */
async function clearIndexedDb(): Promise<void> {
  if (!('indexedDB' in window) || typeof indexedDB.databases !== 'function') return;

  const databases = await indexedDB.databases();
  await Promise.all(
    databases.map(
      ({ name }) =>
        new Promise<void>((resolve) => {
          if (!name) return resolve();
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
          request.onblocked = () => resolve();
        }),
    ),
  );
}

async function unregisterServiceWorkers(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
}
