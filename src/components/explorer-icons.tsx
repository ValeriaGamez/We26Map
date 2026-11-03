type IconName = "search" | "star" | "check" | "back" | "arrow";
export default function ExplorerIcon({ name, filled = false }: { name: IconName; filled?: boolean }) {
  return <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill={filled && name === "star" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {name === "search" && <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>}
    {name === "star" && <path d="m12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9L12 3Z" />}
    {name === "check" && <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5 5-5" /></>}
    {name === "back" && <path d="m14 5-7 7 7 7" />}
    {name === "arrow" && <path d="m9 6 6 6-6 6" />}
  </svg>;
}
