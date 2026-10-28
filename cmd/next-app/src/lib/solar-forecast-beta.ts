/** User role that gates the automatic solar forecast (location, detection, mobile routes). */
export const SOLAR_FORECAST_BETA_ROLE = 'solar-forecast-beta';

/** Admins do not get the beta implicitly; the role must be granted. */
export function hasSolarForecastBeta(roles: readonly string[]): boolean {
    return roles.includes(SOLAR_FORECAST_BETA_ROLE);
}
