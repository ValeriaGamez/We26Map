export type CompanyPreference = { saved: boolean; visited: boolean; notes: string };
export type PreferenceSnapshot = { companies: Readonly<Record<string, CompanyPreference>>; persisted: boolean };
export const COMPANY_STORAGE_KEY = "we26.company-preferences.v1";
export const EMPTY_COMPANY: CompanyPreference = Object.freeze({ saved: false, visited: false, notes: "" });
const emptySnapshot: PreferenceSnapshot = { companies: {}, persisted: true };

export function parsePreferences(raw: string | null): Record<string, CompanyPreference> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !value.companies || typeof value.companies !== "object" || Array.isArray(value.companies)) return {};
    return Object.fromEntries(Object.entries(value.companies).filter(([, entry]) => entry && typeof entry === "object").map(([id, entry]) => {
      const item = entry as Partial<CompanyPreference>;
      return [id, { saved: item.saved === true, visited: item.visited === true, notes: typeof item.notes === "string" ? item.notes : "" }];
    }));
  } catch { return {}; }
}

export function readPreferences(storage: Pick<Storage, "getItem">): PreferenceSnapshot {
  try { return { companies: parsePreferences(storage.getItem(COMPANY_STORAGE_KEY)), persisted: true }; }
  catch { return { companies: {}, persisted: false }; }
}

let snapshot = emptySnapshot;
let owner: Window | null = null;
const listeners = new Set<() => void>();
export const serverPreferenceSnapshot = () => emptySnapshot;
export function preferenceSnapshot() {
  if (typeof window === "undefined") return emptySnapshot;
  if (owner !== window) {
    owner = window;
    try { snapshot = readPreferences(window.localStorage); }
    catch { snapshot = { companies: {}, persisted: false }; }
  }
  return snapshot;
}
export function subscribePreferences(listener: () => void) {
  listeners.add(listener);
  function changed(event: StorageEvent) {
    if (event.key !== null && event.key !== COMPANY_STORAGE_KEY) return;
    try { snapshot = readPreferences(window.localStorage); }
    catch { snapshot = { ...snapshot, persisted: false }; }
    listeners.forEach(notify => notify());
  }
  window.addEventListener("storage", changed);
  return () => { listeners.delete(listener); window.removeEventListener("storage", changed); };
}
export function updateCompanyPreference(id: string, patch: Partial<CompanyPreference>) {
  const previous = preferenceSnapshot();
  const current = Object.hasOwn(previous.companies, id) ? previous.companies[id] : EMPTY_COMPANY;
  const companies = { ...previous.companies, [id]: { ...current, ...patch } };
  let persisted = true;
  try { window.localStorage.setItem(COMPANY_STORAGE_KEY, JSON.stringify({ version: 1, companies })); }
  catch { persisted = false; }
  snapshot = { companies, persisted };
  listeners.forEach(notify => notify());
}
