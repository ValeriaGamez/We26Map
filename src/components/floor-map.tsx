"use client";

import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import FloorPlan from "./FloorPlan";
import ExplorerSheet, { usePhoneLayout } from "./explorer-sheet";
import Icon from "./explorer-icons";
import { useBoothDirections } from "./use-booth-directions";
import { EMPTY_COMPANY, preferenceSnapshot, serverPreferenceSnapshot, subscribePreferences, updateCompanyPreference } from "@/lib/company-preferences";
import { walkingOrder } from "@/lib/walking-order";
import { safeCareerUrl } from "@/lib/floorplan-geometry";
import type { FloorplanData } from "@/lib/floorplan-types";
import type { FloorplanArea } from "@/lib/floorplan-area";
import styles from "./floor-map.module.css";

type Tab = "all" | "saved" | "route";

export default function FloorMap({ area = "main" }: { area?: FloorplanArea }) {
  const [data, setData] = useState<FloorplanData | null>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ boothId: string; revision: number } | null>(null);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const phone = usePhoneLayout();
  const directions = useBoothDirections(data, area);
  const preferences = useSyncExternalStore(subscribePreferences, preferenceSnapshot, serverPreferenceSnapshot);
  const search = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const previousScroll = useRef(0);
  const returnFocus = useRef(false);
  const activeTab = useRef<HTMLButtonElement>(null);
  const booths = useMemo(() => new Map(data?.booths.map(booth => [booth.id, booth]) ?? []), [data]);
  const selected = selectedId ? booths.get(selectedId) : undefined;
  const company = data?.companies.find(item => item.id === selected?.companyId);
  const careerUrl = safeCareerUrl(company?.url ?? selected?.url);
  const companyState = company && Object.hasOwn(preferences.companies, company.id) ? preferences.companies[company.id] : EMPTY_COMPANY;
  const savedIds = useMemo(() => new Set(Object.entries(preferences.companies).filter(([, item]) => item.saved).map(([id]) => id)), [preferences.companies]);
  const visitedIds = useMemo(() => new Set(Object.entries(preferences.companies).filter(([, item]) => item.visited).map(([id]) => id)), [preferences.companies]);
  const saved = useMemo(() => data?.companies.filter(item => savedIds.has(item.id)) ?? [], [data, savedIds]);
  const route = useMemo(() => walkingOrder(saved, data?.booths ?? []), [saved, data]);
  const normalized = query.trim().toLocaleLowerCase();
  const matches = (item: NonNullable<FloorplanData["companies"]>[number]) => !normalized || [item.name, ...item.aliases].some(name => name.toLocaleLowerCase().includes(normalized)) || item.boothIds.some(id => booths.get(id)?.number.includes(normalized));
  const results = (tab === "all" ? data?.companies ?? [] : tab === "saved" ? saved : route).filter(matches);
  const matchingBooths = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    if (!text || !data) return undefined;
    return new Set(data.companies.filter(item => [item.name, ...item.aliases].some(name => name.toLocaleLowerCase().includes(text)) || item.boothIds.some(id => booths.get(id)?.number.includes(text))).flatMap(item => item.boothIds));
  }, [query, data, booths]);
  const remaining = route.filter(item => !visitedIds.has(item.id)).length;

  function locate(id: string) {
    if (!selected) previousScroll.current = scroll.current?.scrollTop ?? 0;
    setSelectedId(id);
    if (directions.active) directions.begin(id);
    setFocusRequest(previous => ({ boothId: id, revision: (previous?.revision ?? 0) + 1 }));
    if (phone) { search.current?.blur(); setSheetExpanded(false); }
  }
  function deselect() { setSelectedId(null); setFocusRequest(null); }
  function returnToBrowse() { returnFocus.current = true; deselect(); }
  useLayoutEffect(() => {
    if (selected) { scroll.current?.scrollTo?.({ top: 0 }); back.current?.focus({ preventScroll: true }); }
    else {
      if (scroll.current) scroll.current.scrollTop = previousScroll.current;
      if (returnFocus.current) { activeTab.current?.focus({ preventScroll: true }); returnFocus.current = false; }
    }
  }, [selected]);

  return <main className={styles.app} data-sheet-expanded={sheetExpanded}>
    <section className={styles.mapSection} inert={phone && sheetExpanded} aria-label={area === "interview" ? "WE26 interview booth map" : "WE26 main booth map"}>
      <FloorPlan key={area} area={area} onDataLoad={setData} selectedBoothId={selectedId} focusRequest={focusRequest} onSelectBooth={locate} onDeselectBooth={deselect} matchingBoothIds={matchingBooths} savedCompanyIds={savedIds} visitedCompanyIds={visitedIds} pointSelection={directions.placing} onMapPoint={directions.place} onCancelPlacement={directions.cancelPlacement} routePoints={directions.route?.points} routeFitRevision={directions.fitRevision} />
      {directions.active && <div className={styles.directionsPanel} aria-label="Walking directions">
        <p role="status" aria-live="polite">{directions.message}</p>
        <div>
          {directions.route && !directions.placing && <><button onClick={directions.moveStart}>Move start</button><button onClick={directions.fitRoute}>Fit route</button></>}
          {directions.placing && <button onClick={directions.cancelPlacement}>Cancel placement</button>}
          <button onClick={directions.clear}>Clear route</button>
        </div>
      </div>}
    </section>
    <nav className={styles.floorSwitch} inert={phone && sheetExpanded} aria-label="Floor map views">
      <Link href="/" aria-current={area === "main" ? "page" : undefined}>Main Floor</Link>
      <Link href="/interview-booths" aria-current={area === "interview" ? "page" : undefined}>Interviews</Link>
    </nav>
    <ExplorerSheet expanded={sheetExpanded} onExpandedChange={setSheetExpanded}>
      <div id="explorer-panel-content" ref={scroll} className={styles.panelContent} onKeyDown={event => { if (event.key === "Escape") { if (selected) returnToBrowse(); else if (phone) setSheetExpanded(false); } }}>
        {selected ? <section className={styles.placeCard} aria-label="Selected booth details">
          <button ref={back} className={styles.back} onClick={returnToBrowse}><Icon name="back" /><span>{tab === "all" ? "All companies" : tab === "saved" ? "Saved" : "Route"}</span></button>
          <h1>{company && careerUrl ? <a className={styles.careerLink} href={careerUrl} target="_blank" rel="noopener noreferrer" aria-label={`${company.name} careers (opens in a new tab)`}>{company.name}<Icon name="link" /></a> : company?.name ?? "Available booth"}</h1>
          <p className={styles.subtitle}>Booth {company ? company.boothIds.map(id => booths.get(id)?.number).join(" · ") : selected.number}</p>
          <div className={styles.actions}>
            <button type="button" aria-pressed={companyState.saved} disabled={!company} onClick={() => company && updateCompanyPreference(company.id, { saved: !companyState.saved })}><Icon name="star" filled={companyState.saved} /><span>{companyState.saved ? "Saved" : "Save"}</span></button>
            <button type="button" aria-pressed={companyState.visited} disabled={!company} onClick={() => company && updateCompanyPreference(company.id, { visited: !companyState.visited })}><Icon name="check" /><span>{companyState.visited ? "Visited" : "Mark Visited"}</span></button>
          </div>
          <div className={styles.directionsAction}>
            <button type="button" disabled={!directions.supported(selected.id)} aria-describedby={!directions.supported(selected.id) ? "directions-availability" : undefined} onClick={() => { directions.begin(selected.id); if (phone) setSheetExpanded(false); }}>Directions here · Booth {selected.number}</button>
            {!directions.supported(selected.id) && <p id="directions-availability">{directions.availability || "Directions are not available for this booth."}</p>}
          </div>
          {company && <div className={styles.notes}><label htmlFor="company-notes">Notes</label><textarea id="company-notes" placeholder="Recruiter names, conversations, follow-ups…" value={companyState.notes} onFocus={() => phone && setSheetExpanded(true)} onChange={event => updateCompanyPreference(company.id, { notes: event.target.value })} /></div>}
          {company && company.boothIds.length > 1 && <div className={styles.locations}><h2>Booth locations</h2><div>{company.boothIds.map(id => <button key={id} aria-pressed={id === selectedId} onClick={() => locate(id)}>{booths.get(id)?.number}</button>)}</div></div>}
          {!preferences.persisted && <p className={styles.storageStatus} role="status">Changes saved for this session.</p>}
        </section> : <>
          <div className={styles.panelHeader}><h1>WE26</h1><p className={styles.subtitle}>Career Fair · Boston · Nov 5–7</p></div>
          <label className={styles.searchField}><Icon name="search" /><input ref={search} aria-label="Search companies or booths" type="search" placeholder="Search companies or booths" value={query} onFocus={() => phone && setSheetExpanded(true)} onChange={event => setQuery(event.target.value)} /></label>
          <div className={styles.tabs} role="tablist" aria-label="Company lists">{(["all", "saved", "route"] as const).map(value => <button key={value} ref={tab === value ? activeTab : undefined} id={`company-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls="company-list" tabIndex={tab === value ? 0 : -1} onClick={() => { setTab(value); if (scroll.current) scroll.current.scrollTop = 0; }} onKeyDown={event => { const values: Tab[] = ["all", "saved", "route"]; if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "all" : event.key === "End" ? "route" : values[(values.indexOf(value) + (event.key === "ArrowRight" ? 1 : 2)) % 3]; setTab(next); document.getElementById(`company-tab-${next}`)?.focus(); } }}>{value === "all" ? "All" : value === "saved" ? "Saved" : "Route"}</button>)}</div>
          {tab === "route" && <p className={styles.routeCaption}>{remaining} of {route.length} left · in walking order</p>}
          <div id="company-list" role="tabpanel" aria-labelledby={`company-tab-${tab}`} className={styles.results}>
            {(tab === "all" ? results.slice(0, 60) : results).map(item => <div className={styles.row} key={item.id} data-visited={visitedIds.has(item.id)}>
              {tab === "route" && <button className={styles.roundCheck} type="button" role="checkbox" aria-checked={visitedIds.has(item.id)} aria-label={`Mark ${item.name} ${visitedIds.has(item.id) ? "not visited" : "visited"}`} onClick={() => updateCompanyPreference(item.id, { visited: !visitedIds.has(item.id) })}>{visitedIds.has(item.id) && <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10 3.5 3.5L15 7" /></svg>}</button>}
              <button className={styles.result} onClick={() => locate(item.boothIds.find(id => booths.get(id)?.number.includes(normalized)) ?? item.boothIds[0])}><span><strong>{item.name}</strong><span>Booth {item.boothIds.map(id => booths.get(id)?.number).join(" · ")}</span></span>{savedIds.has(item.id) ? <span className={styles.savedStar}><Icon name="star" filled /></span> : <Icon name="arrow" />}</button>
            </div>)}
            {!data && <p className={styles.empty} role="status">Loading companies…</p>}
            {data && !results.length && <div className={styles.empty}><strong>{normalized ? "No companies found" : tab === "route" ? "Your route starts here" : "Save your first company"}</strong><p>{normalized ? "Try a company name or booth number." : "Open a company and tap Save to keep it here."}</p></div>}
          </div>
          <a className={styles.sourceLink} href="https://swe.expocad.com/Events/we26/index.html" target="_blank" rel="noreferrer">Official floor plan ↗</a>
        </>}
      </div>
    </ExplorerSheet>
    <div className={styles.colorKey} aria-label="Booth color key"><span><i className={styles.selectedDot} />Selected</span><span><i className={styles.savedDot} />Saved</span><span><i className={styles.visitedDot} />Visited</span></div>
  </main>;
}
