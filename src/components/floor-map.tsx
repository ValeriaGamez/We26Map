"use client";

import { useMemo, useRef, useState } from "react";
import FloorPlan from "./FloorPlan";
import type { FloorplanData } from "@/lib/floorplan-types";
import styles from "./floor-map.module.css";
import Link from "next/link";
import type { FloorplanArea } from "@/lib/floorplan-area";

export default function FloorMap({ area = "main" }: { area?: FloorplanArea }) {
  const [data, setData] = useState<FloorplanData | null>(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ boothId: string; revision: number } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const booths = useMemo(() => new Map(data?.booths.map((booth) => [booth.id, booth]) ?? []), [data]);
  const selected = selectedId ? booths.get(selectedId) : undefined;
  const company = data?.companies.find((item) => item.id === selected?.companyId);
  const query = search.trim().toLocaleLowerCase();
  const results = useMemo(() => data?.companies.filter((item) => !query || [item.name, ...item.aliases].some((name) => name.toLocaleLowerCase().includes(query)) || item.boothIds.some((id) => booths.get(id)?.number.includes(query))) ?? [], [data, query, booths]);
  const matchingBooths = useMemo(() => query ? new Set(results.flatMap((item) => item.boothIds)) : undefined, [query, results]);
  function locate(boothId: string) {
    setSelectedId(boothId);
    setFocusRequest((previous) => ({ boothId, revision: (previous?.revision ?? 0) + 1 }));
  }
  function closeDetails() {
    setSelectedId(null);
    searchInput.current?.focus({ preventScroll: true });
  }
  return <main className={styles.app}>
    <header className={styles.header}><div><span className={styles.brandIcon} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6ZM9 3v15m6-12v15" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg></span><strong>WE26 <span>Boston</span></strong><span className={styles.brandSub}>Floor explorer</span></div><nav className={styles.mapTabs} aria-label="Floor map views"><Link href="/" aria-current={area === "main" ? "page" : undefined}>Main Booths</Link><Link href="/interview-booths" aria-current={area === "interview" ? "page" : undefined}>Interview Booths</Link></nav></header>
    <div className={styles.workspace}>
      <aside className={styles.sidebar} aria-label="Company search and booth details">
        <div className={styles.intro}><p className={styles.eyebrow}>{area === "interview" ? "WE26 INTERVIEW BOOTHS" : "WE26 CAREER FAIR"}</p><h1>{area === "interview" ? <>Find your<br />interview booth.</> : <>Your next<br />connection.</>}</h1><p>{area === "interview" ? "Explore company interview locations." : "Find the companies you want to meet."}</p></div>
        <label className={styles.searchLabel} htmlFor="company-search">Company or booth number</label>
        <div className={styles.searchField}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" /><path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg><input ref={searchInput} id="company-search" className={styles.search} type="search" placeholder="Search companies or booths" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        <p className={styles.resultCount} role="status">{data ? `${results.length} companies${results.length > 60 ? " · Search to see more" : ""}` : "Loading companies…"}</p>
        <div className={styles.results}>{results.slice(0, 60).map((item) => <button aria-pressed={company?.id === item.id} className={company?.id === item.id ? styles.activeResult : styles.result} key={item.id} onClick={() => locate(item.boothIds.find((id) => booths.get(id)?.number.includes(query)) ?? item.boothIds[0])}><strong>{item.name}</strong><span>Booth {item.boothIds.map((id) => booths.get(id)?.number).join(" · ")}</span></button>)}{data && !results.length && <div className={styles.empty}><strong>No companies found</strong><p>Try a different name or booth number.</p></div>}</div>
        {selected && <section className={styles.details} aria-label="Selected booth details" aria-live="polite" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeDetails(); } }}><button className={styles.close} aria-label="Close booth details" onClick={closeDetails}>&times;</button><p className={styles.eyebrow}>BOOTH {selected.number}</p><h2>{company?.name ?? "Unassigned space"}</h2><p className={styles.status}>{selected.spaceType === "queue" ? "Queue space" : selected.status === "available" ? "Available space" : selected.status === "held" ? "On hold" : "Exhibitor space"}</p>{selected.spaceLabel && <p>{selected.spaceLabel}</p>}{company && <><p className={styles.otherLabel}>{company.boothIds.length > 1 ? `All ${company.boothIds.length} spaces for this company` : "Company booth"}</p><div className={styles.boothLinks}>{company.boothIds.map((id) => <button key={id} aria-pressed={id === selectedId} onClick={() => locate(id)}>{booths.get(id)?.number}</button>)}</div></>}</section>}
        {data && <p className={styles.sourceNote}><a href="https://swe.expocad.com/Events/we26/index.html" target="_blank" rel="noreferrer">Official EXPOCAD map ↗</a><span>Updated {data.source.lastSaved}</span><span>{data.booths.length} {area === "interview" ? "interview" : "main"} spaces</span></p>}
      </aside>
      <section className={styles.mapSection} aria-label={area === "interview" ? "WE26 interview booth map" : "WE26 main booth map"}><FloorPlan key={area} area={area} onDataLoad={setData} onSelectBooth={setSelectedId} selectedBoothId={selectedId} focusRequest={focusRequest} matchingBoothIds={matchingBooths} /></section>
    </div>
  </main>;
}
