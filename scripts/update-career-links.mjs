import { readFileSync, writeFileSync } from 'node:fs';

// Careers are curated separately so importing fresh booth geometry cannot
// overwrite the verified links with logos or generic exhibitor homepages.
const snapshotUrl = new URL('../public/data/booths.json', import.meta.url);
const data = JSON.parse(readFileSync(snapshotUrl, 'utf8'));
const catalog = JSON.parse(readFileSync(new URL('./company-careers.json', import.meta.url), 'utf8'));
for (const entry of Object.values(catalog)) {
  if (entry.url === null) continue;
  const url = new URL(entry.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error(`Invalid careers URL for ${entry.name}.`);
}
for (const company of data.companies) {
  if (!Object.hasOwn(catalog, company.id)) throw Error(`Missing careers entry for ${company.name}.`);
  delete company.logoUrl;
  company.url = catalog[company.id].url;
}
const companies = new Map(data.companies.map(company => [company.id, company]));
for (const booth of data.booths) {
  delete booth.logoUrl;
  booth.url = companies.get(booth.companyId)?.url ?? null;
}
writeFileSync(snapshotUrl, JSON.stringify(data) + '\n');
console.log(`Updated ${data.companies.length} companies and ${data.booths.length} booths; ${data.companies.filter(c => c.url).length} careers links.`);
