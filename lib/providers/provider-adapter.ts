export type ProviderEvent = {
  id: string;
  sportKey: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
};

export type ProviderFetchResult<T> = {
  data: T;
  cost: number;
  remaining: number | null;
  fetchedAt: string;
};

export interface OddsProviderAdapter {
  readonly id: string;
  configured(): boolean;
  listEvents(sportKey: string): Promise<ProviderFetchResult<ProviderEvent[]>>;
  fetchEventPlayerProps(input: { sportKey: string; eventId: string; markets: string[]; regions?: string[] }): Promise<ProviderFetchResult<unknown>>;
}
