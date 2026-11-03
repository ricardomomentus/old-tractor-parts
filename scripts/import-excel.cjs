/**
 * Import parts from Ricardo's Excel inventory into the app.
 * Usage: node scripts/import-excel.cjs <excel-path> <app-url>
 * Example: node scripts/import-excel.cjs "C:/z BackUp/000 Baja/Inventory/HD Engine Parts/HD Engine Parts.xls" https://tractor.momentuscrm.com
 */
const xlrd = (() => { try { return require('xlrd'); } catch { return null; } })();

// Since xlrd may not be on the server, we'll hardcode the parsed data
// from Ricardo's Excel (read 2026-11-03)
const PARTS = [
  {
    quantity: 6,
    clevite_old: 'G-479',
    clevite_new: '226-1361',
    sealed_power: 'SL-2274',
    trw: 'SA-296',
    oem_number: '4516867, 4516646',
    part_type_en: 'Sleeve Assembly',
    part_type_es: 'Camisa de cilindro',
    oe_brand: 'Allis-Chalmers',
    application: '4 Cyl. - DA175 to S/N 119462, D175 S/N 119462-Up Diesel Engine',
    tractor_brand: 'Allis-Chalmers',
    part_brand: 'Clevite',
    condition: 'New Old Stock',
  },
  {
    quantity: 2,
    clevite_old: 'G-507',
    clevite_new: '226-1484',
    sealed_power: 'SL-2216',
    trw: 'SA-269',
    oem_number: '4516639, 4514599',
    part_type_en: 'Sleeve Assembly',
    part_type_es: 'Camisa de cilindro',
    oe_brand: 'Allis-Chalmers',
    application: '6 Cyl. - 6B230 Gasoline Engine; Combines-A, A11, AH, B, R; Harvesters',
    tractor_brand: 'Allis-Chalmers',
    part_brand: 'Clevite',
    condition: 'New Old Stock',
  },
  {
    quantity: 4,
    clevite_old: 'A-1638P',
    clevite_new: '224-2255',
    oem_number: 'A-51911',
    part_type_en: 'Piston',
    part_type_es: 'Pistón',
    oe_brand: 'Case',
    application: '4 Cyl. - G-207D Diesel Engine Early Style',
    tractor_brand: 'Case',
    part_brand: 'Clevite',
    condition: 'New Old Stock',
  },
  {
    quantity: 6,
    clevite_old: 'A-1524NP',
    clevite_new: '224-2124',
    sealed_power: '2423-PN',
    oem_number: '200800, AR60740',
    part_type_en: 'Piston',
    part_type_es: 'Pistón',
    oe_brand: 'Cummins',
    application: '6 Cyl. - V6-155, V-378 Diesel; 8 Cyl. - V8-210, V-504',
    tractor_brand: 'Cummins',
    part_brand: 'Clevite',
    condition: 'New Old Stock',
  },
  {
    quantity: 4,
    clevite_old: 'A-1157P',
    clevite_new: '224-1020',
    sealed_power: '1853PX',
    trw: 'L2098F',
    oem_number: 'EAF6108F, EAF6110L',
    part_type_en: 'Piston',
    part_type_es: 'Pistón',
    oe_brand: 'Ford',
    application: '4 Cyl. - 172 Gasoline Engine; 800, 800D, 800K, 801, 801D, 811',
    tractor_brand: 'Ford',
    part_brand: 'Clevite',
    condition: 'New Old Stock',
  },
  {
    quantity: 1,
    clevite_old: 'A-1553NP',
    clevite_new: '224-2171',
    sealed_power: '2540-PN',
    zollner: '19019B',
    oem_number: 'A-146697, A-64110, A-76165',
    part_type_en: 'Piston',
    part_type_es: 'Pistón',
    oe_brand: 'Case',
    application: '4 Cyl. - A-336BDT Turbo Diesel; Wheel Tractor-870',
    tractor_brand: 'Case',
    part_brand: 'Clevite',
    condition: 'New Old Stock',
  },
  {
    quantity: 1,
    clevite_old: '04673608',
    clevite_new: 'FIAT ALLIS 04673608, 4673608, 4618867',
    sealed_power: 'LONG TX10128',
    part_type_en: 'Exhaust Valve',
    part_type_es: 'Válvula de escape',
    oe_brand: 'White/Oliver/Allis-Chalmers',
    application: 'Exhaust Valve fits White 2-50 2-60, Oliver, Allis Chalmers',
    tractor_brand: 'White/Oliver',
    part_brand: 'Fiat Allis',
    condition: 'New Old Stock',
  },
  {
    quantity: 2,
    part_number: 'AEC 308',
    part_type_en: 'Universal Joint',
    part_type_es: 'Cruceta',
    notes: 'Cross-ref: ACDelco 45U4250, Borg Warner 114642, Freightliner FL5308X, Mack 21045308X, MOOG 388, NAPA P388, Neapco 60308, Precision 388, Spicer 5308X, Terex 4023541/9051148, TRW 20180',
    part_brand: 'AEC',
    condition: 'New Old Stock',
  },
];

async function importParts(baseUrl) {
  const url = `${baseUrl}/api/parts/import`;
  console.log(`Importing ${PARTS.length} parts to ${url}...`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: PARTS }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Error ${res.status}: ${text}`);
    process.exit(1);
  }

  const data = await res.json();
  console.log(`Done! Imported ${data.imported} parts. IDs: ${data.ids.join(', ')}`);
}

const baseUrl = process.argv[2] || 'http://localhost:3333';
importParts(baseUrl).catch(err => { console.error(err); process.exit(1); });
