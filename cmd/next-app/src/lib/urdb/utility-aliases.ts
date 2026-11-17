// Keys are normalizeUtilityName() output (see utility-lookup.test.ts), values are names in OpenEI's
// utility list. Tesla reports two names per site: the rate plan's utility (Site.utility) and the grid
// utility (Site.json.utility); both are looked up here.
export const UTILITY_ALIASES: Record<string, string> = {
  'pg and e': 'Pacific Gas & Electric Co',
  'we energies': 'Wisconsin Electric Power Co',
  'xcel energy - colorado': 'Public Service Co of Colorado',
  'southern california edison': 'Southern California Edison Co',
  'eversource energy (formerly connecticut light and power co)': 'Eversource Energy Connecticut',
  'eversource energy (connecticut light and power)': 'Eversource Energy Connecticut',
  'eversource energy (formerly nstar electric company)': 'Eversource of Massachusetts',
  'eversource energy (nstar-boston edison)': 'Eversource of Massachusetts',
  'peco energy': 'PECO Energy Co',
  'tampa electric': 'Tampa Electric Co',
  'puerto rico electric pwr authority': 'Puerto Rico Electric Pwr Authority',
  'central hudson': 'Central Hudson Gas & Elec Corp',
  'central hudson gas and electric': 'Central Hudson Gas & Elec Corp',
  'nv energy south': 'Nevada Power Co',
  'nv energy north': 'Sierra Pacific Power Co',
  'denton municipal electric': 'City of Denton, Texas (Utility Company)',
  'duke energy florida a part of duke energy': 'Progress Energy Florida Inc',
  'green mountain power': 'Green Mountain Power Corp',
  'avangrid (central maine power)': 'Central Maine Power Co',
  'wisconsin public service corporation': 'Wisconsin Public Service Corp',
  'dte energy (dte energy electric company)': 'DTE Electric',
};

// Texas transmission and distribution utilities. Tesla reports one as the grid utility for homes on a
// retail electricity provider, but OpenEI only lists its delivery charges, so it is not a usable match.
export const WIRES_ONLY_UTILITIES: ReadonlySet<string> = new Set([
  'centerpoint energy',
  'centerpoint energy houston electric llc',
  'oncor',
  'oncor electric delivery',
  'oncor electric delivery company llc',
  'aep texas',
  'texas-new mexico power',
]);
