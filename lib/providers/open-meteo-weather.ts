import { normalizedSecret } from "./env";
import type { ProviderFetchResult } from "./provider-adapter";

type OpenMeteoHourlyPayload = {
  hourly?: {
    time?: Array<number | string>;
    temperature_2m?: number[];
    precipitation_probability?: number[];
    wind_speed_10m?: number[];
    weather_code?: number[];
  };
};

export type OpenMeteoWeatherSummary = {
  source: "open-meteo";
  team: string;
  opponent: string;
  eventId: string;
  gameTime: string;
  latitude: number;
  longitude: number;
  forecastTime: string;
  temperatureF: number | null;
  precipitationProbability: number | null;
  windMph: number | null;
  weatherCode: number | null;
  condition: string;
  impact: "favorable" | "neutral" | "unfavorable";
  note: string;
  fetchedAt: string;
};

const defaultBaseUrl = "https://api.open-meteo.com/v1/forecast";

const MLB_TEAM_COORDINATES: Record<string, { latitude: number; longitude: number }> = {
  "Arizona Diamondbacks": { latitude: 33.4455, longitude: -112.0667 },
  "Atlanta Braves": { latitude: 33.8908, longitude: -84.4678 },
  "Baltimore Orioles": { latitude: 39.2837, longitude: -76.6217 },
  "Boston Red Sox": { latitude: 42.3467, longitude: -71.0972 },
  "Chicago Cubs": { latitude: 41.9484, longitude: -87.6553 },
  "Chicago White Sox": { latitude: 41.8308, longitude: -87.6337 },
  "Cincinnati Reds": { latitude: 39.0979, longitude: -84.5076 },
  "Cleveland Guardians": { latitude: 41.4962, longitude: -81.6852 },
  "Colorado Rockies": { latitude: 39.7560, longitude: -104.9942 },
  "Detroit Tigers": { latitude: 42.3390, longitude: -83.0485 },
  "Houston Astros": { latitude: 29.7573, longitude: -95.3555 },
  "Kansas City Royals": { latitude: 39.0516, longitude: -94.4803 },
  "Los Angeles Angels": { latitude: 33.8003, longitude: -117.8827 },
  "Los Angeles Dodgers": { latitude: 34.0739, longitude: -118.2400 },
  "Miami Marlins": { latitude: 25.7785, longitude: -80.2197 },
  "Milwaukee Brewers": { latitude: 43.0280, longitude: -87.9712 },
  "Minnesota Twins": { latitude: 44.9817, longitude: -93.2778 },
  "New York Mets": { latitude: 40.7571, longitude: -73.8458 },
  "New York Yankees": { latitude: 40.8296, longitude: -73.9262 },
  Athletics: { latitude: 37.7516, longitude: -122.2005 },
  "Philadelphia Phillies": { latitude: 39.9051, longitude: -75.1665 },
  "Pittsburgh Pirates": { latitude: 40.4469, longitude: -80.0057 },
  "San Diego Padres": { latitude: 32.7073, longitude: -117.1573 },
  "San Francisco Giants": { latitude: 37.7786, longitude: -122.3893 },
  "Seattle Mariners": { latitude: 47.5914, longitude: -122.3325 },
  "St. Louis Cardinals": { latitude: 38.6226, longitude: -90.1928 },
  "Tampa Bay Rays": { latitude: 27.7680, longitude: -82.6534 },
  "Texas Rangers": { latitude: 32.7473, longitude: -97.0810 },
  "Toronto Blue Jays": { latitude: 43.6414, longitude: -79.3894 },
  "Washington Nationals": { latitude: 38.8730, longitude: -77.0074 },
};

function toNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cToF(value: number | null) {
  return value === null ? null : Number((((value * 9) / 5) + 32).toFixed(1));
}

function kmhToMph(value: number | null) {
  return value === null ? null : Number((value / 1.609344).toFixed(1));
}

function weatherCondition(code: number | null) {
  if (code === null) return "Unknown";
  if (code === 0) return "Clear";
  if ([1, 2].includes(code)) return "Mostly clear";
  if (code === 3) return "Overcast";
  if ([45, 48].includes(code)) return "Fog";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "Precipitation";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snow";
  if ([95, 96, 99].includes(code)) return "Thunderstorm";
  return "Variable";
}

function weatherImpact(tempF: number | null, precip: number | null, windMph: number | null, code: number | null): "favorable" | "neutral" | "unfavorable" {
  if ((precip ?? 0) >= 50 || (windMph ?? 0) >= 20 || (code !== null && [95, 96, 99].includes(code))) return "unfavorable";
  if ((precip ?? 0) <= 25 && (windMph ?? 0) <= 12 && tempF !== null && tempF >= 68 && tempF <= 88) return "favorable";
  return "neutral";
}

function scoreNearestHour(payload: OpenMeteoHourlyPayload, gameTime: string) {
  const times = payload.hourly?.time ?? [];
  if (!times.length) return null;
  const gameEpoch = Math.floor(new Date(gameTime).getTime() / 1000);
  let bestIndex = 0;
  let bestDelta = Number.POSITIVE_INFINITY;
  times.forEach((value, index) => {
    const epoch = typeof value === "number" ? value : Math.floor(Date.parse(String(value)) / 1000);
    if (!Number.isFinite(epoch)) return;
    const delta = Math.abs(epoch - gameEpoch);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function summarizeWeather(input: {
  team: string;
  opponent: string;
  eventId: string;
  gameTime: string;
  latitude: number;
  longitude: number;
  payload: OpenMeteoHourlyPayload;
}) {
  const index = scoreNearestHour(input.payload, input.gameTime);
  if (index === null) return null;
  const tempC = toNumber(input.payload.hourly?.temperature_2m?.[index] ?? null);
  const precip = toNumber(input.payload.hourly?.precipitation_probability?.[index] ?? null);
  const windKmh = toNumber(input.payload.hourly?.wind_speed_10m?.[index] ?? null);
  const weatherCodeValue = toNumber(input.payload.hourly?.weather_code?.[index] ?? null);
  const temperatureF = cToF(tempC);
  const windMph = kmhToMph(windKmh);
  const condition = weatherCondition(weatherCodeValue);
  const impact = weatherImpact(temperatureF, precip, windMph, weatherCodeValue);
  const forecastTime = input.payload.hourly?.time?.[index];
  const forecastEpoch = typeof forecastTime === "number" ? forecastTime : forecastTime ? Math.floor(Date.parse(String(forecastTime)) / 1000) : null;

  return {
    source: "open-meteo" as const,
    team: input.team,
    opponent: input.opponent,
    eventId: input.eventId,
    gameTime: input.gameTime,
    latitude: input.latitude,
    longitude: input.longitude,
    forecastTime: forecastEpoch ? new Date(forecastEpoch * 1000).toISOString() : input.gameTime,
    temperatureF,
    precipitationProbability: precip,
    windMph,
    weatherCode: weatherCodeValue,
    condition,
    impact,
    note: `${condition}${temperatureF !== null ? ` · ${temperatureF}°F` : ""}${precip !== null ? ` · ${precip}% precip` : ""}${windMph !== null ? ` · ${windMph} mph wind` : ""}`,
    fetchedAt: new Date().toISOString(),
  };
}

export class OpenMeteoWeatherAdapter {
  readonly id = "open-meteo";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(
    baseUrl = process.env.OPEN_METEO_BASE_URL || defaultBaseUrl,
    apiKey = process.env.OPEN_METEO_API_KEY,
    timeoutMs = Number(process.env.OPEN_METEO_TIMEOUT_MS ?? 4500),
  ) {
    this.baseUrl = baseUrl;
    this.apiKey = normalizedSecret(apiKey);
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(1500, Math.floor(timeoutMs)) : 4500;
  }

  configured() {
    return true;
  }

  hasCoordinates(team: string) {
    return Boolean(MLB_TEAM_COORDINATES[team]);
  }

  async fetchMlbWeather(input: { team: string; opponent: string; eventId: string; gameTime: string }): Promise<ProviderFetchResult<NonNullable<ReturnType<typeof summarizeWeather>>>> {
    const coordinates = MLB_TEAM_COORDINATES[input.team];
    if (!coordinates) throw new Error(`No Open-Meteo coordinates configured for ${input.team}.`);
    const url = new URL(this.baseUrl);
    url.searchParams.set("latitude", String(coordinates.latitude));
    url.searchParams.set("longitude", String(coordinates.longitude));
    url.searchParams.set("hourly", "temperature_2m,precipitation_probability,wind_speed_10m,weather_code");
    url.searchParams.set("forecast_hours", "24");
    url.searchParams.set("timezone", "America/New_York");
    url.searchParams.set("timeformat", "unixtime");
    if (this.apiKey) url.searchParams.set("apikey", this.apiKey);

    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`Open-Meteo request failed with status ${response.status}.`);
    const payload = await response.json() as OpenMeteoHourlyPayload;
    const summary = summarizeWeather({
      team: input.team,
      opponent: input.opponent,
      eventId: input.eventId,
      gameTime: input.gameTime,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      payload,
    });
    if (!summary) throw new Error(`Open-Meteo returned no usable hourly weather rows for ${input.team}.`);
    return { data: summary, cost: 0, remaining: null, fetchedAt: summary.fetchedAt };
  }
}

export function summarizeOpenMeteoWeather(payload: ReturnType<typeof summarizeWeather> | null) {
  if (!payload) return { rows: 0 };
  return {
    team: payload.team,
    gameTime: payload.gameTime,
    forecastTime: payload.forecastTime,
    temperatureF: payload.temperatureF,
    precipitationProbability: payload.precipitationProbability,
    windMph: payload.windMph,
    condition: payload.condition,
    impact: payload.impact,
    note: payload.note,
  };
}
